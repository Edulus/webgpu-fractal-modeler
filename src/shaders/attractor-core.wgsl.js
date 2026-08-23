// attractor.wgsl.js — strange attractors drawn as real line geometry.
//
// Attractors have no closed-form distance function (they're trajectories, not
// surfaces), so they can't be sphere-traced like the other fractals. Rather
// than baking them into a voxel grid — which quantizes the curve and looks
// blurry/jagged when magnified — we integrate the ODE to exact float positions
// and rasterize those as a line strip. That's vector geometry: crisp at any
// zoom, limited by the framebuffer rather than a fixed grid.
//
// The line pass now stores a palette coordinate and intensity instead of final
// RGB. The post chain resolves that coordinate through the live palette, which
// lets colour cycling remain palette-faithful on a converged frame.

export const ATTRACTOR_WGSL = /* wgsl */ `
// Mirrors the shared Uniforms struct through viewProj. The backing buffer has
// more fields after this, but this shader does not need them.
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

const TAU : f32 = 6.28318530718;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) speed : f32,   // normalized |velocity| -> palette input
  @location(1) depth : f32,   // view distance, for depth cueing
};

// One vertex per integrated trajectory sample: xyz position + normalized speed.
// Speed (not position-along-the-path) drives the colour because it is a smooth
// function of where you are on the attractor.
@vertex
fn vs_line(@location(0) inPos : vec3<f32>, @location(1) inSpeed : f32) -> VSOut {
  var out : VSOut;
  out.pos = u.viewProj * vec4<f32>(inPos, 1.0);
  out.speed = inSpeed;
  out.depth = length(inPos - u.camPos);
  return out;
}

struct LineOut {
  @location(0) material : vec4<f32>,
  @location(1) aux : vec4<f32>,
};

@fragment
fn fs_line(in : VSOut) -> LineOut {
  // Gentle depth cue so the far side recedes and the structure reads 3D.
  let fade = clamp(1.4 / (1.0 + in.depth * in.depth * 0.10), 0.12, 1.0);

  // Same low per-segment intensity as the former RGB path. Dense cores add
  // many segments and build brightness without immediately clipping to white.
  let intensity = 0.032 * fade;
  let t = in.speed * 1.15;
  let a = TAU * t;

  var out : LineOut;
  // Keep both coordinate representations. Cosine presets can have different
  // per-channel frequencies and therefore are not necessarily period-1, so a
  // linear weighted mean preserves their unwrapped t. Imported stop ramps are
  // explicitly cyclic, so the auxiliary attachment carries a circular mean
  // that treats 0.99 and 0.01 as neighbours instead of averaging them to 0.5.
  // Emission is scalar and palette-independent, so it lives beside the linear
  // coordinate rather than consuming another circular channel.
  out.material = vec4<f32>(in.speed * 1.15 * intensity,
                           intensity,
                           intensity * 0.7 * u.glowStrength,
                           0.0);
  out.aux = vec4<f32>(cos(a) * intensity,
                      sin(a) * intensity,
                      intensity,
                      0.0);
  return out;
}
`;
