// composite.wgsl.js — post-process passes, inlined WGSL.
//
// The raymarch target now stores palette-independent material data rather than
// finished RGB. Both bloom and final composite resolve that data through the
// selected palette at the live cycle phase, so cycling re-indexes the palette
// instead of hue-rotating an already shaded pixel.
//
// Fragment entry points sharing one fullscreen-triangle vertex stage:
//   fs_bloom_prefilter: resolve material, isolate bright/emissive, downsample
//   fs_bloom_down     : downsample one bloom level into the next
//   fs_bloom_up       : tent-filter a level back up (blended additively)
//   fs_composite      : resolve material + bloom, image controls, tonemap, alpha
//
// Bloom is a chain of levels (half internal res, a quarter, an eighth, ...).
// The narrow levels keep the glow tight around bright detail; the wide ones
// give it a long soft falloff. A single blur at one size can only do one.

// Bloom chain length. fractal-bg.js allocates one target per level.
export const BLOOM_LEVELS = 5;

export const COMPOSITE_WGSL = /* wgsl */ `
// Must match the layout used by the raymarch pass (same uniform buffer).
struct Uniforms {
  resolution : vec2<f32>,
  time       : f32,
  dpr        : f32,
  camPos     : vec3<f32>,
  fov        : f32,
  camTarget  : vec3<f32>,
  fractalType: f32,
  power      : f32,
  mbScale    : f32,
  mbMinRadius: f32,
  mbFixedRad : f32,
  paletteA   : vec4<f32>,
  paletteB   : vec4<f32>,
  paletteC   : vec4<f32>,
  paletteD   : vec4<f32>,
  glowStrength : f32,
  fogDensity   : f32,
  shadowSoftness: f32,
  aoStrength   : f32,
  qualityScale : f32,
  bgMode       : f32,
  reducedMotion: f32,
  _pad         : f32,
  viewProj     : mat4x4<f32>,
  jitter       : vec2<f32>,
  accumWeight  : f32,
  edgeAAGain   : f32,
  paletteMode  : f32,
  rampCount    : f32,
  colorCycle   : f32,
  colorPhase   : f32,
  ramp         : array<vec4<f32>, 8>,
  // (exposure, contrast, saturation, hue turns). Hue is deliberately a
  // separate image adjustment; palette cycling is handled before bloom.
  imageAdjust  : vec4<f32>,
  detail       : vec4<f32>,
  // Per-shape parameters. Unused by the post chain, declared only so the
  // fields after them land on the right offsets.
  shapeParams  : array<vec4<f32>, 2>,
  // Temporal reprojection of moving frames (see temporal.wgsl.js). The camera
  // of the previous frame, how much of its result to keep, and its Shape
  // Explorer yaw (the value detail.w held then).
  prevCamPos   : vec3<f32>,
  historyWeight: f32,
  prevCamTarget: vec3<f32>,
  prevYaw      : f32,
  // (hit-cone radius in render pixels or 0 for the fixed epsilon, output
  //  sharpening strength, spare, spare)
  temporal     : vec4<f32>,
};

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var srcTex : texture_2d<f32>;   // encoded material, or blur source
@group(0) @binding(3) var auxTex : texture_2d<f32>;   // encoded auxiliary material
@group(0) @binding(4) var bloomTex : texture_2d<f32>; // composite only

const PI : f32 = 3.14159265359;
const TAU : f32 = 6.28318530718;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var out : VSOut;
  let xy = p[vid];
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>(xy.x * 0.5 + 0.5, 1.0 - (xy.y * 0.5 + 0.5));
  return out;
}

fn luma(c : vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn rampColor(t : f32) -> vec3<f32> {
  let n = max(u32(u.rampCount), 2u);
  let x = fract(t) * f32(n);
  let i0 = u32(floor(x)) % n;
  let i1 = (i0 + 1u) % n;
  return mix(u.ramp[i0].rgb, u.ramp[i1].rgb, fract(x));
}

fn palette(t : f32) -> vec3<f32> {
  if (u.paletteMode > 0.5) {
    return rampColor(t);
  }
  return u.paletteA.rgb + u.paletteB.rgb *
         cos(2.0 * PI * (u.paletteC.rgb * t + u.paletteD.rgb));
}

fn cameraRay(uv : vec2<f32>, ro : vec3<f32>, ta : vec3<f32>, fov : f32) -> vec3<f32> {
  let aspect = u.resolution.x / max(u.resolution.y, 1.0);
  var p = uv * 2.0 - 1.0;
  p.x = p.x * aspect;
  let fwd = normalize(ta - ro);
  let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), fwd));
  let up = cross(fwd, right);
  let focal = 1.0 / tan(fov * 0.5);
  return normalize(p.x * right + p.y * up + focal * fwd);
}

fn backgroundColor(uv : vec2<f32>) -> vec3<f32> {
  // The accumulated material is jittered; reconstructing the background from
  // the pixel centre instead of storing a third coordinate changes only a
  // subpixel-scale gradient and saves a full channel per sample.
  let rd = cameraRay(vec2<f32>(uv.x, 1.0 - uv.y), u.camPos, u.camTarget, u.fov);
  let t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  let lo = u.paletteA.rgb * 0.008;
  let hi = u.paletteA.rgb * 0.022 + vec3<f32>(0.002, 0.003, 0.006);
  return mix(lo, hi, t);
}

// The attractor line renderer stores palette-coordinate summaries rather than
// finished RGB. Reapply the same saturation/normalization that the old line
// shader used after looking up the live palette.
fn attractorPalette(t : f32) -> vec3<f32> {
  var col = palette(t);
  let l = luma(col);
  col = max(vec3<f32>(0.0), mix(vec3<f32>(l), col, 2.6));
  col = col / max(luma(col), 0.08) * 0.55;
  return col;
}

// How much of the march glow is laid directly over the surface as light.
//
// The glow only exists on pixels where the ray landed (the material pass drops
// it on a miss), so this term is a tinted veil over the shading itself. At its
// original 0.4 it flattened the modelling: crevices that should fall dark were
// lifted towards the glow colour and the surface read as washed out. The halo
// around bright detail is the bloom's job and is unaffected; this only stops
// the same light being painted a second time on top of the surface.
const GLOW_TINT : f32 = 0.18;

// Reconstruct the old HDR scene from palette-independent material weights.
// The cycle phase is added to palette COORDINATES, not to RGB. A chosen palette
// therefore remains itself for the entire loop; only which part of it is used
// at each surface point changes.
fn resolveScene(uv : vec2<f32>) -> vec4<f32> {
  let m = textureSampleLevel(srcTex, samp, uv, 0.0);
  let a = textureSampleLevel(auxTex, samp, uv, 0.0);
  // Reduced-motion policy is enforced on the CPU. If the user explicitly
  // moves the colour-speed slider, u.colorPhase is allowed to advance even
  // under reduced motion, so the shader must consume that phase unchanged.
  let phase = u.colorPhase;
  let bg = backgroundColor(uv);
  let missBg = select(0.0, a.w, u.bgMode >= 0.5);
  var color = bg * (a.x + missBg);

  if (u.fractalType > 24.5 && u.fractalType < 27.5) {
    // Cosine presets use the unwrapped linear mean in material.xy. Imported
    // ramps are period-1 by construction, so use the circular mean in aux.xyz
    // to keep samples on either side of the 1->0 seam adjacent.
    if (m.y > 1e-7) {
      var t = m.x / m.y;
      if (u.paletteMode > 0.5 && a.z > 1e-7) {
        t = atan2(a.y, a.x) / TAU;
      }
      color = color + attractorPalette(t + phase) * m.y;
    }
    // Attractors did not have the raymarcher's pre-bloom glow tint; their alpha
    // is emission only, so preserve that behavior here.
    return vec4<f32>(color, m.z);
  }

  if (m.y > 1e-7) {
    color = color + palette(m.x / m.y + phase) * m.y;
  }
  color = color + vec3<f32>(m.z); // neutral specular

  if (a.z > 1e-7) {
    color = color + palette(a.y / a.z + phase) * a.z;
  }

  // The old raymarch tinted near-miss glow with palette(0.5). Shift that lookup
  // by the very same phase so surface, seams and emissive threads stay locked.
  color = color + palette(0.5 + phase) * m.w * GLOW_TINT;
  return vec4<f32>(color, m.w);
}

// Low-rung silhouette reconstruction. The material pass already gives us a
// binary hit/miss signal in aux.w for distance-estimated surfaces: hits write 0,
// misses write 1, and the sampler turns that into fractional coverage at an
// edge. Use that signal to estimate the local edge tangent, then average two
// short taps ALONG the edge rather than across it. This damps the visible
// stair-step turns produced by a half-resolution moving frame without widening
// the silhouette the way a generic blur would.
//
// This deliberately stays inside the existing composite pass: no extra render
// target, no new bind group, and no texture can ever be bound for reading while
// it is also the current render attachment. Strength falls to zero at native
// resolution, so high rungs keep the original resolve exactly.
// Set by comparison in a browser, which is the only instrument that can judge
// this: 0.4/0.7 beat no filter, 0.55/0.85 beat that, and 1.6x of the latter
// beat that in turn. These are those values, so a gain of 1 is the setting that
// was actually looked at and approved.
//
// The tap now sits just under its own cap. Raising the gain further therefore
// only deepens the blend -- the taps cannot move, because a tap that reaches a
// full texel would sample across into the next step of the staircase, which is
// the thing being removed.
const TAP_BASE : f32 = 0.88;
const BLEND_BASE : f32 = 1.36;

fn surfaceCoverage(uv : vec2<f32>) -> f32 {
  return 1.0 - clamp(textureSampleLevel(auxTex, samp, uv, 0.0).w, 0.0, 1.0);
}

fn resolveSceneEdgeAA(uv : vec2<f32>) -> vec4<f32> {
  let base = resolveScene(uv);
  let surfaceType = u.fractalType < 24.5 || u.fractalType > 28.5;
  let aaStrength = clamp((1.0 - u.qualityScale) * 2.0, 0.0, 1.0);
  // Once the average has more than one sample in it the silhouette is already
  // antialiased properly, by up to 96 jittered samples of the real surface.
  // Filtering that again would soften detail that is genuinely resolved, and
  // the still image is the one that was never the complaint. So this is spent
  // only on a single-sample frame, which is exactly when there is a staircase
  // to fix. Note the rung is NOT a proxy for this: the showcase pass settles
  // this machine at scale 0.70 while still, so gating on quality alone would
  // filter every converged frame at 60% strength.
  // The gain also carries the off switch and the settled state: the renderer
  // writes zero for both, so there is one question here rather than three.
  let gain = u.edgeAAGain;
  if (!surfaceType || aaStrength <= 0.001 || gain <= 0.001) {
    return base;
  }

  let centerCoverage = surfaceCoverage(uv);
  if (centerCoverage <= 0.01 || centerCoverage >= 0.99) {
    return base;
  }

  let dims = max(vec2<f32>(textureDimensions(auxTex, 0)), vec2<f32>(1.0));
  let texel = vec2<f32>(1.0 / dims.x, 1.0 / dims.y);
  let cL = surfaceCoverage(uv - vec2<f32>(texel.x, 0.0));
  let cR = surfaceCoverage(uv + vec2<f32>(texel.x, 0.0));
  let cU = surfaceCoverage(uv - vec2<f32>(0.0, texel.y));
  let cD = surfaceCoverage(uv + vec2<f32>(0.0, texel.y));
  let grad = vec2<f32>(cR - cL, cD - cU);
  let grad2 = dot(grad, grad);
  if (grad2 < 0.0025) {
    return base;
  }

  // Both halves of "strength" scale with the gain: how far along the edge the
  // taps sit, and how much of their mean is taken. Reaching further alone just
  // samples a different part of the same staircase, and blending harder alone
  // cannot reach past the step it is standing on -- the two only work together.
  //
  // TAP is bounded well under a texel so a tap never crosses into the next
  // step, and the blend stops short of 1.0 so the filtered pixel always keeps
  // some of the value actually rendered there.
  let tap = min(TAP_BASE * gain, 0.9);
  let edgeTangent = vec2<f32>(-grad.y, grad.x) / sqrt(grad2) * texel;
  let alongA = resolveScene(uv + edgeTangent * tap);
  let alongB = resolveScene(uv - edgeTangent * tap);
  let alongMean = (alongA + alongB) * 0.5;
  let edge = smoothstep(0.05, 0.5, sqrt(grad2));
  let blend = min(aaStrength * edge * BLEND_BASE * gain, 0.95);
  return mix(base, alongMean, blend);
}

// ---- Bloom ----------------------------------------------------------------

// Isolate bright colour + emissive glow from the resolved scene.
fn prefilterAt(uv : vec2<f32>) -> vec3<f32> {
  let c = resolveScene(uv);
  // Soft knee, so bloom fades in rather than switching on at a threshold.
  let threshold = 0.6;
  let knee = 0.3;
  let br = max(c.r, max(c.g, c.b));
  let soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
  let contrib = max(soft * soft / (4.0 * knee), br - threshold) / max(br, 1e-4);
  // Emission, tinted halfway towards the palette at the live cycle phase, so
  // the halo carries the shape's colour instead of bleaching towards white.
  let glowCol = mix(vec3<f32>(1.0), palette(0.5 + u.colorPhase), 0.5);
  return c.rgb * contrib + glowCol * c.a * 0.6;
}

// Level 0: resolve + prefilter at four bilinear taps, each centred on a 2x2
// block of the material -- a 4x4 box over the source.
@fragment
fn fs_bloom_prefilter(in : VSOut) -> @location(0) vec4<f32> {
  let texel = 1.0 / vec2<f32>(textureDimensions(srcTex, 0));
  let a = prefilterAt(in.uv + texel * vec2<f32>(-1.0, -1.0));
  let b = prefilterAt(in.uv + texel * vec2<f32>( 1.0, -1.0));
  let c = prefilterAt(in.uv + texel * vec2<f32>(-1.0,  1.0));
  let d = prefilterAt(in.uv + texel * vec2<f32>( 1.0,  1.0));
  // Karis average: down-weight very bright taps, so one hot pixel cannot
  // become a flickering blob once it is spread across the wide levels.
  let wa = 1.0 / (1.0 + luma(a));
  let wb = 1.0 / (1.0 + luma(b));
  let wc = 1.0 / (1.0 + luma(c));
  let wd = 1.0 / (1.0 + luma(d));
  return vec4<f32>((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd), 1.0);
}

@fragment
fn fs_bloom_down(in : VSOut) -> @location(0) vec4<f32> {
  let texel = 1.0 / vec2<f32>(textureDimensions(srcTex, 0));
  var acc = textureSampleLevel(srcTex, samp, in.uv + texel * vec2<f32>(-1.0, -1.0), 0.0).rgb;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * vec2<f32>( 1.0, -1.0), 0.0).rgb;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * vec2<f32>(-1.0,  1.0), 0.0).rgb;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * vec2<f32>( 1.0,  1.0), 0.0).rgb;
  return vec4<f32>(acc * 0.25, 1.0);
}

// 3x3 tent upsample of the smaller level. The pipeline blends the result
// additively onto the level above, so level 0 ends up holding the sum.
@fragment
fn fs_bloom_up(in : VSOut) -> @location(0) vec4<f32> {
  let texel = 1.0 / vec2<f32>(textureDimensions(srcTex, 0));
  var acc = textureSampleLevel(srcTex, samp, in.uv, 0.0).rgb * 4.0;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * vec2<f32>( 1.0,  0.0), 0.0).rgb * 2.0;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * vec2<f32>(-1.0,  0.0), 0.0).rgb * 2.0;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * vec2<f32>( 0.0,  1.0), 0.0).rgb * 2.0;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * vec2<f32>( 0.0, -1.0), 0.0).rgb * 2.0;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * vec2<f32>( 1.0,  1.0), 0.0).rgb;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * vec2<f32>(-1.0,  1.0), 0.0).rgb;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * vec2<f32>( 1.0, -1.0), 0.0).rgb;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * vec2<f32>(-1.0, -1.0), 0.0).rgb;
  return vec4<f32>(acc / 16.0, 1.0);
}

// The upsample chain sums every level into the top one; normalise by the count.
const BLOOM_NORM : f32 = ${(1 / BLOOM_LEVELS).toFixed(5)};

// ACES filmic tonemap (Narkowicz approximation).
fn acesFilm(x : vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn hash21(p : vec2<f32>) -> f32 {
  var q = fract(p * vec2<f32>(123.34, 345.45));
  q += dot(q, q + 34.345);
  return fract(q.x * q.y);
}

// Rotate a colour about the grey axis (1,1,1)/sqrt3 -- Rodrigues' formula.
// This remains ONLY for the explicit Hue image slider. Palette cycling no
// longer comes through this function.
fn hueRotate(c : vec3<f32>, a : f32) -> vec3<f32> {
  const K : vec3<f32> = vec3<f32>(0.57735027, 0.57735027, 0.57735027);
  let ca = cos(a);
  return c * ca + cross(K, c) * sin(a) + K * dot(K, c) * (1.0 - ca);
}

// Scene HDR -> display: explicit hue, exposure, tonemap, gamma, saturation.
// Palette cycling has already happened in resolveScene(), before bloom; Hue is
// intentionally independent and may rotate the finished image away from the
// selected palette when the user asks for it.
fn toDisplay(hdr : vec3<f32>, hueTurns : f32) -> vec3<f32> {
  var c = hdr;
  if (hueTurns != 0.0) {
    c = max(hueRotate(c, TAU * hueTurns), vec3<f32>(0.0));
  }
  c = acesFilm(c * 1.05 * u.imageAdjust.x);
  c = pow(c, vec3<f32>(1.0 / 2.2));
  return mix(vec3<f32>(luma(c)), c, u.imageAdjust.z);
}

// Contrast pivots on the presentation backdrop rather than on mid-grey. The
// backdrop is mapped to 0, white to 1, and an S-curve is applied in between.
// Both endpoints are exact fixed points at every setting. Values below the
// backdrop (deep crevices) pass through unchanged instead of being lifted.
fn contrastCurve(c : vec3<f32>, bg : vec3<f32>, k : f32) -> vec3<f32> {
  let span = max(vec3<f32>(1.0) - bg, vec3<f32>(1e-4));
  let x = (c - bg) / span;
  let xc = clamp(x, vec3<f32>(0.0), vec3<f32>(1.0));
  let a = pow(xc, vec3<f32>(k));
  let b = pow(vec3<f32>(1.0) - xc, vec3<f32>(k));
  let curved = bg + span * (a / max(a + b, vec3<f32>(1e-6)));
  return select(c, curved, x > vec3<f32>(0.0));
}

@fragment
fn fs_composite(in : VSOut) -> @location(0) vec4<f32> {
  var scene = resolveSceneEdgeAA(in.uv);

  // Contrast-limited sharpening, for temporally resolved frames only. The
  // temporal filter trades a little edge contrast for stability; this pushes
  // the pixel away from the mean of its four neighbours to win it back, and
  // clamps to their range so it can never ring. JS writes a strength of zero
  // for accumulated frames, which are genuinely resolved and are left exactly
  // as they were.
  let sharpen = u.temporal.y;
  if (sharpen > 0.001) {
    let dims = max(vec2<f32>(textureDimensions(srcTex, 0)), vec2<f32>(1.0));
    let texel = 1.0 / dims;
    let n = resolveScene(in.uv - vec2<f32>(0.0, texel.y)).rgb;
    let s = resolveScene(in.uv + vec2<f32>(0.0, texel.y)).rgb;
    let e = resolveScene(in.uv + vec2<f32>(texel.x, 0.0)).rgb;
    let w = resolveScene(in.uv - vec2<f32>(texel.x, 0.0)).rgb;
    let lo = min(scene.rgb, min(min(n, s), min(e, w)));
    let hi = max(scene.rgb, max(max(n, s), max(e, w)));
    let pushed = scene.rgb + (scene.rgb - (n + s + e + w) * 0.25) * sharpen;
    scene = vec4<f32>(clamp(pushed, lo, hi), scene.a);
  }

  let bloom = textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb * BLOOM_NORM;
  let hdr = scene.rgb + bloom * 1.1;

  // Colour-cycle phase is already a palette-coordinate offset inside
  // resolveScene(). The Hue slider is a distinct, explicit RGB adjustment.
  let hueTurns = u.imageAdjust.w;

  // Reconstruct exactly the bare HDR backdrop for this pixel. backgroundColor
  // is the same helper resolveScene uses for miss/fog material; black is the
  // backdrop in transparent mode. Passing this through the identical display
  // chain makes the contrast pivot follow exposure, saturation and Hue too.
  let bgHdr = select(vec3<f32>(0.0), backgroundColor(in.uv), u.bgMode >= 0.5);
  var col = toDisplay(hdr, hueTurns);
  col = max(contrastCurve(col, toDisplay(bgHdr, hueTurns), u.imageAdjust.y),
            vec3<f32>(0.0));

  let q = in.uv - vec2<f32>(0.5);
  let vig = smoothstep(0.9, 0.35, length(q));
  col = col * mix(0.72, 1.0, vig);

  let d = (hash21(in.uv * u.resolution + u.time) - 0.5) / 255.0;
  col = col + vec3<f32>(d);
  col = clamp(col, vec3<f32>(0.0), vec3<f32>(1.0));

  var alpha = 1.0;
  if (u.bgMode < 0.5) {
    // Coverage from the brightest channel rather than luminance, so a
    // saturated blue or red surface covers the page as solidly as a white one
    // (blue alone has a luminance weight of 0.07 and used to read as see-through).
    let sceneMax = max(scene.r, max(scene.g, scene.b));
    let bloomMax = max(bloom.r, max(bloom.g, bloom.b));
    let cov = clamp(sceneMax * 2.5 + scene.a * 0.9 + bloomMax * 0.9, 0.0, 1.0);
    alpha = cov;
  }

  return vec4<f32>(col * alpha, alpha);
}
`;
