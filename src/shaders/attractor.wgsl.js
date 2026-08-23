// Strange-attractor shader wrapper. The integrated trajectories remain exact;
// the four per-shape controls deform those trajectories in the vertex stage.
import { ATTRACTOR_WGSL as CORE_ATTRACTOR_WGSL } from './attractor-core.wgsl.js';

function replaceOnce(source, find, replacement, label) {
  const at = source.indexOf(find);
  if (at < 0) throw new Error(`[model-params] attractor shader patch missing: ${label}`);
  if (source.indexOf(find, at + find.length) >= 0) {
    throw new Error(`[model-params] attractor shader patch ambiguous: ${label}`);
  }
  return source.slice(0, at) + replacement + source.slice(at + find.length);
}

const TRAILING_UNIFORMS = `  viewProj     : mat4x4<f32>,
  jitter       : vec2<f32>,
  accumWeight  : f32,
  _pad2        : f32,
  paletteMode  : f32,
  rampCount    : f32,
  colorCycle   : f32,
  colorPhase   : f32,
  ramp         : array<vec4<f32>, 8>,
  imageAdjust  : vec4<f32>,
  detail       : vec4<f32>,
};`;

const ATTRACTOR_HELPERS = /* wgsl */ `
const MODEL_PACK_FLAG : f32 = 4194304.0;
const MODEL_PACK_BASE : f32 = 2048.0;
const MODEL_PACK_MAX  : f32 = 2047.0;

fn attractorPackedChannel(i : u32) -> f32 {
  if (i == 0u) { return u.imageAdjust.x; }
  if (i == 1u) { return u.imageAdjust.y; }
  if (i == 2u) { return u.imageAdjust.z; }
  return u.imageAdjust.w;
}

fn attractorModelParam(i : u32) -> f32 {
  let v = attractorPackedChannel(i);
  if (v < MODEL_PACK_FLAG - 0.5) { return 0.5; }
  let q = v - MODEL_PACK_FLAG;
  return clamp(floor(q / MODEL_PACK_BASE) / MODEL_PACK_MAX, 0.0, 1.0);
}

fn attractorRotate2(v : vec2<f32>, a : f32) -> vec2<f32> {
  let c = cos(a);
  let s = sin(a);
  return vec2<f32>(c * v.x - s * v.y, s * v.x + c * v.y);
}

fn modelAttractorPosition(inPos : vec3<f32>) -> vec3<f32> {
  let scale = mix(0.65, 1.35, attractorModelParam(0u));
  let twist = mix(-2.0, 2.0, attractorModelParam(1u));
  let stretch = mix(0.65, 1.35, attractorModelParam(2u));
  let warp = mix(-0.3, 0.3, attractorModelParam(3u));
  let id = i32(round(u.fractalType));
  var p = inPos * scale;

  if (id == 25) {
    // Aizawa: coil around its long axis, then bow the ring slightly.
    p.z = p.z * stretch;
    let r = attractorRotate2(vec2<f32>(p.x, p.y), twist * p.z);
    p.x = r.x; p.y = r.y;
    p.z = p.z + warp * sin(3.2 * length(vec2<f32>(p.x, p.y)));
  } else if (id == 26) {
    // Lorenz: open/close the butterfly vertically and torsion the two lobes.
    p.y = p.y * stretch;
    let r = attractorRotate2(vec2<f32>(p.x, p.z), twist * p.y);
    p.x = r.x; p.z = r.y;
    p.x = p.x + warp * sin(2.7 * p.z);
  } else {
    // Rössler: preserve the broad spiral while exaggerating or softening its fold.
    p.z = p.z * stretch;
    let rad = length(vec2<f32>(p.x, p.y));
    let r = attractorRotate2(vec2<f32>(p.x, p.y), twist * rad);
    p.x = r.x; p.y = r.y;
    p.z = p.z + warp * sin(3.0 * rad);
  }
  return p;
}
`;

let shader = replaceOnce(
  CORE_ATTRACTOR_WGSL,
  '  viewProj     : mat4x4<f32>,\n};',
  TRAILING_UNIFORMS,
  'uniform tail',
);
shader = replaceOnce(
  shader,
  'const TAU : f32 = 6.28318530718;',
  'const TAU : f32 = 6.28318530718;\n' + ATTRACTOR_HELPERS,
  'helper insertion',
);
shader = replaceOnce(
  shader,
  '  var out : VSOut;\n  out.pos = u.viewProj * vec4<f32>(inPos, 1.0);\n  out.speed = inSpeed;\n  out.depth = length(inPos - u.camPos);',
  '  var out : VSOut;\n' +
  '  let shapedPos = modelAttractorPosition(inPos);\n' +
  '  out.pos = u.viewProj * vec4<f32>(shapedPos, 1.0);\n' +
  '  out.speed = inSpeed;\n' +
  '  out.depth = length(shapedPos - u.camPos);',
  'vertex deformation',
);

export const ATTRACTOR_WGSL = shader;
