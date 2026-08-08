// composite.wgsl.js — post-process passes, inlined WGSL.
//
// Three fragment entry points share one fullscreen-triangle vertex stage:
//   fs_bloom_h  : prefilter bright/emissive pixels + horizontal Gaussian blur
//   fs_bloom_v  : vertical Gaussian blur
//   fs_composite: combine scene + bloom, ACES tonemap, vignette, dither, alpha
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
  _pad3        : f32,
  ramp         : array<vec4<f32>, 8>,
  // (exposure, contrast, saturation, hue turns) -- composite pass only.
  imageAdjust  : vec4<f32>,
};

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var srcTex : texture_2d<f32>;   // scene (blur src / composite scene)
@group(0) @binding(3) var bloomTex : texture_2d<f32>; // composite only

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

// 9-tap Gaussian weights (normalized).
const W0 : f32 = 0.227027;
const W1 : f32 = 0.194594;
const W2 : f32 = 0.121621;
const W3 : f32 = 0.054054;
const W4 : f32 = 0.016216;

// Prefilter: isolate bright color + emissive glow (alpha channel of scene).
fn prefilter(c : vec4<f32>) -> vec3<f32> {
  let threshold = 0.55;
  let bright = max(c.rgb - vec3<f32>(threshold), vec3<f32>(0.0));
  let glow = c.a; // emission written by the raymarch pass
  return bright + vec3<f32>(glow) * 0.6;
}

// Horizontal blur (+ prefilter on the way in).
@fragment
fn fs_bloom_h(in : VSOut) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(srcTex, 0));
  let texel = vec2<f32>(1.0 / dims.x, 0.0);
  var acc = prefilter(textureSampleLevel(srcTex, samp, in.uv, 0.0)) * W0;
  acc += prefilter(textureSampleLevel(srcTex, samp, in.uv + texel * 1.0, 0.0)) * W1;
  acc += prefilter(textureSampleLevel(srcTex, samp, in.uv - texel * 1.0, 0.0)) * W1;
  acc += prefilter(textureSampleLevel(srcTex, samp, in.uv + texel * 2.0, 0.0)) * W2;
  acc += prefilter(textureSampleLevel(srcTex, samp, in.uv - texel * 2.0, 0.0)) * W2;
  acc += prefilter(textureSampleLevel(srcTex, samp, in.uv + texel * 3.0, 0.0)) * W3;
  acc += prefilter(textureSampleLevel(srcTex, samp, in.uv - texel * 3.0, 0.0)) * W3;
  acc += prefilter(textureSampleLevel(srcTex, samp, in.uv + texel * 4.0, 0.0)) * W4;
  acc += prefilter(textureSampleLevel(srcTex, samp, in.uv - texel * 4.0, 0.0)) * W4;
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

// Hash-based dither to break up banding on dark gradients.
fn hash21(p : vec2<f32>) -> f32 {
  var q = fract(p * vec2<f32>(123.34, 345.45));
  q += dot(q, q + 34.345);
  return fract(q.x * q.y);
}

// ---- Progressive accumulation ---------------------------------------------
// Running average of subpixel-jittered frames, taken while the view is still.
// srcTex is the frame just rendered; bloomTex is bound to the previous
// accumulation half (ping-pong). Weight is 1/(n+1), so the first sample writes
// the frame through unchanged and no clear pass is needed.
@fragment
fn fs_accum(in : VSOut) -> @location(0) vec4<f32> {
  let cur = textureSample(srcTex, samp, in.uv);
  let prev = textureSample(bloomTex, samp, in.uv);
  return mix(prev, cur, clamp(u.accumWeight, 0.0, 1.0));
}

// Rotate a colour about the grey axis (1,1,1)/sqrt3 -- Rodrigues' formula.
// Rotating about grey leaves the achromatic axis fixed, so whites, greys and
// the overall brightness are untouched and only the hue travels. Exactly
// periodic in 2*pi, which is what makes the cycle close seamlessly.
fn hueRotate(c : vec3<f32>, a : f32) -> vec3<f32> {
  const K : vec3<f32> = vec3<f32>(0.57735027, 0.57735027, 0.57735027);
  let ca = cos(a);
  return c * ca + cross(K, c) * sin(a) + K * dot(K, c) * (1.0 - ca);
}

// ---- The backdrop, recomputed -----------------------------------------------
// Copies of the raymarch pass's camera and background, so this pass can work
// out what a pixel would have held with no model in front of it. They are
// copies rather than shared code because the two shaders are separate modules;
// if the background in fractal.wgsl changes, change it here too.
fn cameraRay(uv : vec2<f32>, ro : vec3<f32>, ta : vec3<f32>, fov : f32) -> vec3<f32> {
  let aspect = u.resolution.x / max(u.resolution.y, 1.0);
  var p = (uv * 2.0 - 1.0);
  p.x = p.x * aspect;
  let fwd = normalize(ta - ro);
  let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), fwd));
  let up = cross(fwd, right);
  let focal = 1.0 / tan(fov * 0.5);
  return normalize(p.x * right + p.y * up + focal * fwd);
}

fn backgroundColor(rd : vec3<f32>) -> vec3<f32> {
  let t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  let lo = u.paletteA.rgb * 0.008;
  let hi = u.paletteA.rgb * 0.022 + vec3<f32>(0.002, 0.003, 0.006);
  return mix(lo, hi, t);
}

// Scene HDR -> display: hue, exposure, tonemap, gamma, saturation. Everything
// bar the contrast curve, which needs two values that have come this far.
fn toDisplay(hdr : vec3<f32>, hueTurns : f32) -> vec3<f32> {
  var c = hdr;
  if (hueTurns != 0.0) {
    // Clamped because rotating about grey takes saturated colours OUT of the
    // positive octant -- measured, a channel goes negative at 1999 of 2000
    // angles for pure red. Negatives survive acesFilm and then reach
    // pow(col, 1/2.2), which is NaN for a negative base: black or garbage
    // pixels rather than a wrong hue. Clamping desaturates the few colours that
    // leave the gamut, which is the usual and correct answer.
    c = max(hueRotate(c, 6.28318531 * hueTurns), vec3<f32>(0.0));
  }
  // Exposure BEFORE the tonemapper, which is what makes it behave like a
  // camera: highlights roll off along the ACES curve instead of clipping flat,
  // which is what a brightness multiply after the tonemap would do. The 1.05
  // was already here as a fixed exposure; the slider scales it.
  c = acesFilm(c * 1.05 * u.imageAdjust.x);
  c = pow(c, vec3<f32>(1.0 / 2.2));
  // Saturation in DISPLAY space, after gamma.
  return mix(vec3<f32>(luma(c)), c, u.imageAdjust.z);
}

// Contrast, pivoting on the BACKDROP rather than on mid-grey.
//
// Mid-grey is what a photo editor pivots on, and it is wrong here: the backdrop
// sits around 0.06 in display space, so turning contrast down lifts it to a
// flat grey and turning it up crushes the gradient to dead black. The model is
// what the control is for; the space it sits in should hold still.
//
// So the channel is rescaled to put the backdrop at 0 and white at 1, and an
// S-curve is applied there. u^k / (u^k + (1-u)^k) fixes both ends exactly and
// is the identity at k=1, so the backdrop and white are untouched at every
// setting and nothing can be clipped or crushed at either end -- the curve
// steepens through the middle of the model's own range instead. Away from the
// model the picture already equals the backdrop, so it lands on itself and
// there is no seam anywhere for the effect to start at.
fn contrastCurve(c : vec3<f32>, bg : vec3<f32>, k : f32) -> vec3<f32> {
  let span = max(vec3<f32>(1.0) - bg, vec3<f32>(1e-4));
  let x = (c - bg) / span;
  let xc = clamp(x, vec3<f32>(0.0), vec3<f32>(1.0));
  let a = pow(xc, vec3<f32>(k));
  let b = pow(vec3<f32>(1.0) - xc, vec3<f32>(k));
  let curved = bg + span * (a / max(a + b, vec3<f32>(1e-6)));
  // A channel darker than the backdrop -- a deep crevice in shadow -- is left
  // exactly as it is. Clamping it into the curve instead would raise it to the
  // backdrop's own brightness, which is a visible change at every setting
  // including the neutral one. Continuous at the join, since the curve starts
  // at the backdrop.
  return select(c, curved, x > vec3<f32>(0.0));
}

@fragment
fn fs_composite(in : VSOut) -> @location(0) vec4<f32> {
  let scene = textureSampleLevel(srcTex, samp, in.uv, 0.0);
  let bloom = textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb;

  let hdr = scene.rgb + bloom * 1.1;

  // Colour cycling. Done here rather than in the raymarch so it costs nothing
  // on a converged frame -- this pass runs every frame either way -- and so it
  // never invalidates the accumulated image. fract() before scaling keeps the
  // angle bounded, so a session running for hours has the same precision as one
  // running for seconds rather than losing bits to a growing time value.
  let rate = select(u.colorCycle, 0.0, u.reducedMotion > 0.5);
  // The slider sets where the loop sits; the cycle carries it on from there, so
  // the two compose instead of one overriding the other. With cycling off this
  // is a plain hue control.
  let hueTurns = u.imageAdjust.w + select(0.0, fract(u.time * rate), rate > 0.0);

  // The bare backdrop for this pixel: the same gradient the raymarch pass would
  // have written with nothing in front of the camera, or black in transparent
  // mode. Taken through the identical chain so it can serve as the contrast
  // pivot -- a pixel showing only the backdrop then lands exactly on itself.
  let rd = cameraRay(vec2<f32>(in.uv.x, 1.0 - in.uv.y), u.camPos, u.camTarget, u.fov);
  let bgHdr = select(vec3<f32>(0.0), backgroundColor(rd), u.bgMode >= 0.5);

  var col = toDisplay(hdr, hueTurns);
  // Contrast last, and pivoted on the backdrop, so it works on the model and
  // leaves the space around it alone. Before the vignette, so that stays an
  // even frame effect rather than being amplified along with everything else.
  col = max(contrastCurve(col, toDisplay(bgHdr, hueTurns), u.imageAdjust.y),
            vec3<f32>(0.0));

  // Vignette — subtle, keeps edges dark for text legibility.
  let q = in.uv - vec2<f32>(0.5);
  let vig = smoothstep(0.9, 0.35, length(q));
  col = col * mix(0.72, 1.0, vig);

  // Dither (±1/255).
  let d = (hash21(in.uv * u.resolution + u.time) - 0.5) / 255.0;
  col = col + vec3<f32>(d);
  col = clamp(col, vec3<f32>(0.0), vec3<f32>(1.0));

  // Final alpha: opaque gradient background, or coverage-based transparency.
  var alpha = 1.0;
  if (u.bgMode < 0.5) {
    // Surface + glow coverage -> lets the page show through empty regions.
    let cov = clamp(luma(scene.rgb) * 1.8 + scene.a * 0.9 + luma(bloom) * 1.4, 0.0, 1.0);
    alpha = cov;
  }

  // Premultiplied output (canvas configured with alphaMode:'premultiplied').
  return vec4<f32>(col * alpha, alpha);
}
`;
