// attractor.wgsl.js — strange attractors drawn as real line geometry.
//
// Attractors have no closed-form distance function (they're trajectories, not
// surfaces), so they can't be sphere-traced like the other fractals. Rather
// than baking them into a voxel grid — which quantizes the curve and looks
// blurry/jagged when magnified — we integrate the ODE to exact float positions
// and rasterize those as a line strip. That's vector geometry: crisp at any
// zoom, limited by the framebuffer rather than a fixed grid.
//
// Drawn additively into the same HDR target as the raymarch pass, so dense
// regions accumulate brightness and the composite pass blooms them.

export const ATTRACTOR_WGSL = /* wgsl */ `
// Mirrors the shared Uniforms struct (see fractal.wgsl.js for the byte map).
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

const PI : f32 = 3.14159265359;

fn palette(t : f32) -> vec3<f32> {
  return u.paletteA.rgb + u.paletteB.rgb *
         cos(2.0 * PI * (u.paletteC.rgb * t + u.paletteD.rgb));
}

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) speed : f32,   // normalized |velocity| -> palette input
  @location(1) depth : f32,   // view distance, for depth cueing
};

// One vertex per integrated trajectory sample: xyz position + normalized speed.
//
// Speed (not position-along-the-path) drives the color because it's a smooth
// function of *where* you are on the attractor. Neighbouring strands therefore
// share a hue, so additive overlap deepens that color. Coloring by path
// position would sum many different hues per pixel and average out to white.
@vertex
fn vs_line(@location(0) inPos : vec3<f32>, @location(1) inSpeed : f32) -> VSOut {
  var out : VSOut;
  out.pos = u.viewProj * vec4<f32>(inPos, 1.0);
  out.speed = inSpeed;
  out.depth = length(inPos - u.camPos);
  return out;
}

@fragment
fn fs_line(in : VSOut) -> @location(0) vec4<f32> {
  let phase = select(u.time * 0.04, 0.0, u.reducedMotion > 0.5);
  var col = palette(in.speed * 1.15 + phase);

  // The cosine palettes sit on a bright grey DC term (a ~ 0.5). Stacking that
  // additively races to white, so push the color away from its own luminance —
  // the chromatic part survives accumulation far longer.
  let l = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
  col = max(vec3<f32>(0.0), mix(vec3<f32>(l), col, 2.6));
  // Renormalize so the saturation boost changes hue purity, not brightness.
  col = col / max(dot(col, vec3<f32>(0.2126, 0.7152, 0.0722)), 0.08) * 0.55;

  // Gentle depth cue so the far side recedes and the structure reads 3D.
  let fade = clamp(1.4 / (1.0 + in.depth * in.depth * 0.10), 0.12, 1.0);

  // Low per-segment intensity keeps dense cores inside the tonemapper's
  // color-preserving range instead of clipping to white.
  let intensity = 0.032 * fade;

  // RGB carries color; alpha carries emission for the bloom pass.
  return vec4<f32>(col * intensity, intensity * 0.7 * u.glowStrength);
}
`;
