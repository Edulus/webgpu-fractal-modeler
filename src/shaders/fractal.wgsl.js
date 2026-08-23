// Shape-parameter layer over the original distance-estimator shader.
// The original shader is retained verbatim in fractal-core.wgsl.js; this module
// injects a compact parameter decoder plus model-space deformation before WebGPU
// compilation. Keeping the estimator source intact makes upstream math changes
// easy to diff while every model still gains live shape controls.
import { FRACTAL_WGSL as CORE_FRACTAL_WGSL } from './fractal-core.wgsl.js';

function replaceOnce(source, find, replacement, label) {
  const at = source.indexOf(find);
  if (at < 0) throw new Error(`[model-params] fractal shader patch missing: ${label}`);
  if (source.indexOf(find, at + find.length) >= 0) {
    throw new Error(`[model-params] fractal shader patch ambiguous: ${label}`);
  }
  return source.slice(0, at) + replacement + source.slice(at + find.length);
}

const MODEL_HELPERS = /* wgsl */ `
// ---- Per-shape parameter transport ----------------------------------------
// imageAdjust carries two independent 11-bit values in each exact f32 integer:
// the original image adjustment and one normalized model parameter. Legacy
// (unpacked) values are accepted during the first boot frames.
const MODEL_PACK_FLAG : f32 = 4194304.0;
const MODEL_PACK_BASE : f32 = 2048.0;
const MODEL_PACK_MAX  : f32 = 2047.0;

fn defaultModelParam(ft : f32, i : u32) -> f32 {
  // Preserve the exact pre-feature Mandelbulb and Mandelbox defaults before the
  // JS control layer has had a chance to pack the uniforms.
  if (ft < 0.5 && i == 0u) { return 0.6; } // power 8 in [2,12]
  if (ft >= 0.5 && ft < 1.5) {
    if (i == 0u) { return 0.575; }          // scale -1.85 in [-3,-1]
    if (i == 1u) { return 0.357142857; }    // min radius .35 in [.1,.8]
  }
  return 0.5;
}

fn packedModelChannel(i : u32) -> f32 {
  if (i == 0u) { return u.imageAdjust.x; }
  if (i == 1u) { return u.imageAdjust.y; }
  if (i == 2u) { return u.imageAdjust.z; }
  return u.imageAdjust.w;
}

fn modelParam(i : u32) -> f32 {
  let v = packedModelChannel(i);
  if (v < MODEL_PACK_FLAG - 0.5) {
    return defaultModelParam(u.fractalType, i);
  }
  let q = v - MODEL_PACK_FLAG;
  let code = floor(q / MODEL_PACK_BASE);
  return clamp(code / MODEL_PACK_MAX, 0.0, 1.0);
}

fn rotateModel2(v : vec2<f32>, a : f32) -> vec2<f32> {
  let c = cos(a);
  let s = sin(a);
  return vec2<f32>(c * v.x - s * v.y, s * v.x + c * v.y);
}

struct ModelSpace {
  p : vec3<f32>,
  distanceScale : f32,
};

// Every surface receives its own live model-space calculation. The first two
// shapes expose native estimator constants below; the rest use a conservative
// coordinate deformation whose four controls are named specifically in the UI.
fn modelSpace(pos : vec3<f32>, ft : f32) -> ModelSpace {
  var p = pos;
  var ds = 1.0;
  let id = i32(round(ft));

  // Mandelbulb: slot 0 is native power; slots 1..3 deform the bulb itself.
  if (id == 0) {
    let twist = mix(-2.5, 2.5, modelParam(1u));
    let stretch = mix(0.6, 1.4, modelParam(2u));
    let warp = mix(-0.25, 0.25, modelParam(3u));
    p.y = p.y / stretch;
    let rz = rotateModel2(vec2<f32>(p.x, p.z), twist * p.y);
    p.x = rz.x; p.z = rz.y;
    p = p + warp * 0.32 * vec3<f32>(
      sin(2.1 * p.y + p.z),
      sin(1.7 * p.z + p.x),
      sin(1.9 * p.x - p.y)
    );
    ds = min(1.0, stretch) /
         (1.0 + 0.42 * abs(twist) + 1.35 * abs(warp));
  // Mandelbox: slots 0..2 are native fold constants; slot 3 is a spatial warp.
  } else if (id == 1) {
    let warp = mix(-0.3, 0.3, modelParam(3u));
    p = p + warp * 0.28 * vec3<f32>(
      sin(1.9 * p.y), sin(2.2 * p.z), sin(1.7 * p.x));
    ds = 1.0 / (1.0 + 1.4 * abs(warp));
  } else {
    let scale = mix(0.65, 1.35, modelParam(0u));
    let twist = mix(-2.0, 2.0, modelParam(1u));
    let stretch = mix(0.65, 1.35, modelParam(2u));
    let warp = mix(-0.3, 0.3, modelParam(3u));

    // q = p/scale makes scale > 1 enlarge the object. Multiply the returned DE
    // by scale to restore world units. Non-rigid terms use a conservative
    // Lipschitz safety factor so sphere tracing stays stable at slider extremes.
    p = p / scale;
    ds = scale * min(1.0, stretch) /
         (1.0 + 0.38 * abs(twist) + 1.5 * abs(warp));

    let family = id % 6;
    if (family == 0) {
      p.y = p.y / stretch;
      let r = rotateModel2(vec2<f32>(p.x, p.z), twist * p.y);
      p.x = r.x; p.z = r.y;
      p.x = p.x + warp * sin(2.1 * p.z + 0.7 * p.y);
    } else if (family == 1) {
      p.x = p.x / stretch;
      let r = rotateModel2(vec2<f32>(p.y, p.z), twist * p.x);
      p.y = r.x; p.z = r.y;
      p.y = p.y + warp * sin(2.3 * p.x - 0.8 * p.z);
    } else if (family == 2) {
      p.z = p.z / stretch;
      let r = rotateModel2(vec2<f32>(p.x, p.y), twist * p.z);
      p.x = r.x; p.y = r.y;
      p.z = p.z + warp * sin(1.8 * p.x + 1.4 * p.y);
    } else if (family == 3) {
      p.y = p.y / stretch;
      let rad = length(vec2<f32>(p.x, p.z));
      let r = rotateModel2(vec2<f32>(p.x, p.z), twist * rad);
      p.x = r.x; p.z = r.y;
      p.y = p.y + warp * sin(3.0 * rad);
    } else if (family == 4) {
      p.x = p.x / stretch;
      let r = rotateModel2(vec2<f32>(p.y, p.z), twist * (p.y + p.z) * 0.5);
      p.y = r.x; p.z = r.y;
      p.x = p.x + warp * sin(2.4 * p.y) * sin(1.7 * p.z);
    } else {
      p.z = p.z / stretch;
      let rad = length(vec2<f32>(p.x, p.y));
      let r = rotateModel2(vec2<f32>(p.x, p.y), twist * rad);
      p.x = r.x; p.y = r.y;
      p.z = p.z + warp * sin(2.2 * (p.x - p.y));
    }
  }

  var out : ModelSpace;
  out.p = p;
  out.distanceScale = max(ds, 0.12);
  return out;
}

fn scaledModelDE(r0 : DEResult, scale : f32) -> DEResult {
  var r = r0;
  r.dist = r.dist * scale;
  return r;
}
`;

let shader = replaceOnce(
  CORE_FRACTAL_WGSL,
  '// ---- Distance estimators --------------------------------------------------',
  MODEL_HELPERS + '\n// ---- Distance estimators --------------------------------------------------',
  'distance-estimator helper insertion',
);

shader = replaceOnce(
  shader,
  '  let power = u.power;',
  '  let power = mix(2.0, 12.0, modelParam(0u));',
  'Mandelbulb power',
);
shader = replaceOnce(
  shader,
  '  let scale = u.mbScale;\n  let minR2 = u.mbMinRadius * u.mbMinRadius;\n  let fixedR2 = u.mbFixedRad * u.mbFixedRad;',
  '  let scale = mix(-3.0, -1.0, modelParam(0u));\n' +
  '  let minRadius = mix(0.1, 0.8, modelParam(1u));\n' +
  '  let fixedRadius = mix(0.5, 1.5, modelParam(2u));\n' +
  '  let minR2 = minRadius * minRadius;\n' +
  '  let fixedR2 = fixedRadius * fixedRadius;',
  'Mandelbox fold constants',
);

const dispatchStart = shader.indexOf('// Dispatch to the selected estimator.');
const dispatchEnd = shader.indexOf('\nfn mapDist', dispatchStart);
if (dispatchStart < 0 || dispatchEnd < 0) {
  throw new Error('[model-params] fractal shader dispatch block not found');
}
let dispatch = shader.slice(dispatchStart, dispatchEnd);
dispatch = replaceOnce(
  dispatch,
  'fn mapDE(pos : vec3<f32>) -> DEResult {\n  let ft = u.fractalType;',
  'fn mapDE(pos : vec3<f32>) -> DEResult {\n' +
  '  let ft = u.fractalType;\n' +
  '  let ms = modelSpace(pos, ft);\n' +
  '  let p = ms.p;',
  'mapDE model-space setup',
);
dispatch = dispatch.replace(/return (de[A-Za-z0-9_]+)\(pos\);/g,
  'return scaledModelDE($1(p), ms.distanceScale);');
shader = shader.slice(0, dispatchStart) + dispatch + shader.slice(dispatchEnd);

export const FRACTAL_WGSL = shader;
