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
  @location(0) age   : f32,
  @location(1) depth : f32,   // view distance, for depth cueing
};

// One vertex per integrated trajectory sample: xyz position + normalized age.
@vertex
fn vs_line(@location(0) inPos : vec3<f32>, @location(1) inAge : f32) -> VSOut {
  var out : VSOut;
  out.pos = u.viewProj * vec4<f32>(inPos, 1.0);
  out.age = inAge;
  out.depth = length(inPos - u.camPos);
  return out;
}

@fragment
fn fs_line(in : VSOut) -> @location(0) vec4<f32> {
  let phase = select(u.time * 0.03, 0.0, u.reducedMotion > 0.5);
  let col = palette(in.age * 1.4 + phase);

  // Gentle depth cue so the far side of the ribbon recedes and the structure
  // reads three-dimensionally instead of as a flat tangle.
  let fade = clamp(1.4 / (1.0 + in.depth * in.depth * 0.10), 0.12, 1.0);

  // Low per-segment intensity: thousands of additively blended segments build
  // the bright cores where the trajectory concentrates.
  let intensity = 0.085 * fade;

  // RGB carries color; alpha carries emission for the bloom pass.
  return vec4<f32>(col * intensity, intensity * 0.9 * u.glowStrength);
}
`;
