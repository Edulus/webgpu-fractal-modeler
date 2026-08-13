// composite.wgsl.js — post-process passes, inlined WGSL.
//
// The raymarch target now stores palette-independent material data rather than
// finished RGB. Both bloom and final composite resolve that data through the
// selected palette at the live cycle phase, so cycling re-indexes the palette
// instead of hue-rotating an already shaded pixel.
//
// Two fragment entry points share one fullscreen-triangle vertex stage:
//   fs_bloom_h  : resolve material, prefilter, horizontal Gaussian blur
//   fs_bloom_v  : vertical Gaussian blur
//   fs_composite: resolve material + bloom, image controls, tonemap, alpha
//
// Bloom runs at half internal resolution for softness + speed.

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
  _pad2        : f32,
  paletteMode  : f32,
  rampCount    : f32,
  colorCycle   : f32,
  colorPhase   : f32,
  ramp         : array<vec4<f32>, 8>,
  // (exposure, contrast, saturation, hue turns). Hue is deliberately a
  // separate image adjustment; palette cycling is handled before bloom.
  imageAdjust  : vec4<f32>,
  detail       : vec4<f32>,
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
  color = color + palette(0.5 + phase) * m.w * 0.4;
  return vec4<f32>(color, m.w);
}

// 9-tap Gaussian weights (normalized).
const W0 : f32 = 0.227027;
const W1 : f32 = 0.194594;
const W2 : f32 = 0.121621;
const W3 : f32 = 0.054054;
const W4 : f32 = 0.016216;

fn prefilterAt(uv : vec2<f32>) -> vec3<f32> {
  let c = resolveScene(uv);
  let threshold = 0.55;
  let bright = max(c.rgb - vec3<f32>(threshold), vec3<f32>(0.0));
  let glow = c.a;
  return bright + vec3<f32>(glow) * 0.6;
}

// Horizontal blur (+ palette resolve + prefilter on the way in).
@fragment
fn fs_bloom_h(in : VSOut) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(srcTex, 0));
  let texel = vec2<f32>(1.0 / dims.x, 0.0);
  var acc = prefilterAt(in.uv) * W0;
  acc += prefilterAt(in.uv + texel * 1.0) * W1;
  acc += prefilterAt(in.uv - texel * 1.0) * W1;
  acc += prefilterAt(in.uv + texel * 2.0) * W2;
  acc += prefilterAt(in.uv - texel * 2.0) * W2;
  acc += prefilterAt(in.uv + texel * 3.0) * W3;
  acc += prefilterAt(in.uv - texel * 3.0) * W3;
  acc += prefilterAt(in.uv + texel * 4.0) * W4;
  acc += prefilterAt(in.uv - texel * 4.0) * W4;
  return vec4<f32>(acc, 1.0);
}

// Vertical blur (source already prefiltered).
@fragment
fn fs_bloom_v(in : VSOut) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(srcTex, 0));
  let texel = vec2<f32>(0.0, 1.0 / dims.y);
  var acc = textureSampleLevel(srcTex, samp, in.uv, 0.0).rgb * W0;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * 1.0, 0.0).rgb * W1;
  acc += textureSampleLevel(srcTex, samp, in.uv - texel * 1.0, 0.0).rgb * W1;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * 2.0, 0.0).rgb * W2;
  acc += textureSampleLevel(srcTex, samp, in.uv - texel * 2.0, 0.0).rgb * W2;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * 3.0, 0.0).rgb * W3;
  acc += textureSampleLevel(srcTex, samp, in.uv - texel * 3.0, 0.0).rgb * W3;
  acc += textureSampleLevel(srcTex, samp, in.uv + texel * 4.0, 0.0).rgb * W4;
  acc += textureSampleLevel(srcTex, samp, in.uv - texel * 4.0, 0.0).rgb * W4;
  return vec4<f32>(acc, 1.0);
}

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
  let scene = resolveScene(in.uv);
  let bloom = textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb;
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
    let cov = clamp(luma(scene.rgb) * 1.8 + scene.a * 0.9 + luma(bloom) * 1.4, 0.0, 1.0);
    alpha = cov;
  }

  return vec4<f32>(col * alpha, alpha);
}
`;
