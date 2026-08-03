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

@fragment
fn fs_composite(in : VSOut) -> @location(0) vec4<f32> {
  let scene = textureSampleLevel(srcTex, samp, in.uv, 0.0);
  let bloom = textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb;

  var hdr = scene.rgb + bloom * 1.1;

  // Tonemap + gamma.
  var col = acesFilm(hdr * 1.05);
  col = pow(col, vec3<f32>(1.0 / 2.2));

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
