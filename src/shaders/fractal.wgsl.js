// Shape-parameter layer over the original distance-estimator shader.
//
// The original estimators remain in fractal-core.wgsl.js. This wrapper exposes
// the constants and coefficients that belong to each construction. The four
// packed parameter channels are transport slots only; there is no universal
// deformation applied across models.
import { FRACTAL_WGSL as CORE_FRACTAL_WGSL } from './fractal-core.wgsl.js';

function replaceOnce(source, find, replacement, label) {
  const at = source.indexOf(find);
  if (at < 0) throw new Error(`[model-params] fractal shader patch missing: ${label}`);
  if (source.indexOf(find, at + find.length) >= 0) {
    throw new Error(`[model-params] fractal shader patch ambiguous: ${label}`);
  }
  return source.slice(0, at) + replacement + source.slice(at + find.length);
}

function replaceCount(source, find, replacement, count, label) {
  let out = source;
  let seen = 0;
  while (out.includes(find)) {
    out = out.replace(find, replacement);
    seen++;
  }
  if (seen !== count) {
    throw new Error(`[model-params] fractal shader patch count ${label}: ${seen}/${count}`);
  }
  return out;
}

const MODEL_HELPERS = /* wgsl */ `
// ---- Per-shape parameter transport ----------------------------------------
const MODEL_PACK_FLAG : f32 = 4194304.0;
const MODEL_PACK_BASE : f32 = 2048.0;
const MODEL_PACK_MAX  : f32 = 2047.0;

fn defaultModelParam(ft : f32, i : u32) -> f32 {
  // Before the UI has packed the uniforms, preserve the shipped defaults for
  // the two estimators that already consumed these legacy uniform fields.
  if (ft < 0.5) {
    if (i == 0u) { return 0.6; }                  // power 8 in [2,12]
    if (i == 1u) { return 0.155555556; }          // bailout 2.2 in [1.5,6]
  }
  if (ft >= 0.5 && ft < 1.5) {
    if (i == 0u) { return 0.575; }                // -1.85 in [-3,-1]
    if (i == 1u) { return 0.357142857; }          // .35 in [.1,.8]
    if (i == 2u) { return 0.5; }                  // 1.0 in [.5,1.5]
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

fn modelValue(i : u32, lo : f32, hi : f32) -> f32 {
  return mix(lo, hi, modelParam(i));
}
`;

let shader = replaceOnce(
  CORE_FRACTAL_WGSL,
  '// ---- Distance estimators --------------------------------------------------',
  MODEL_HELPERS + '\n// ---- Distance estimators --------------------------------------------------',
  'parameter helper insertion',
);

// Mandelbulb: native power and escape radius.
shader = replaceOnce(shader, '  let power = u.power;',
  '  let power = modelValue(0u, 2.0, 12.0);', 'Mandelbulb power');
shader = replaceOnce(shader, '    if (r > 2.2) { break; }',
  '    if (r > modelValue(1u, 1.5, 6.0)) { break; }', 'Mandelbulb escape radius');

// Mandelbox: the three native fold constants.
shader = replaceOnce(
  shader,
  '  let scale = u.mbScale;\n  let minR2 = u.mbMinRadius * u.mbMinRadius;\n  let fixedR2 = u.mbFixedRad * u.mbFixedRad;',
  '  let scale = modelValue(0u, -3.0, -1.0);\n' +
  '  let minRadius = modelValue(1u, 0.1, 0.8);\n' +
  '  let fixedRadius = modelValue(2u, 0.5, 1.5);\n' +
  '  let minR2 = minRadius * minRadius;\n' +
  '  let fixedR2 = fixedRadius * fixedRadius;',
  'Mandelbox fold constants',
);

// Menger: recursion depth and outer cube extent.
shader = replaceOnce(shader, '  var d = sdBox(p, vec3<f32>(1.0));',
  '  var d = sdBox(p, vec3<f32>(modelValue(1u, 0.6, 1.4)));', 'Menger half-size');
shader = replaceOnce(shader, '  for (var m = 0; m < 5; m = m + 1) {',
  '  for (var m = 0; m < 7; m = m + 1) {\n' +
  '    if (m >= i32(round(modelValue(0u, 1.0, 7.0)))) { break; }',
  'Menger recursion levels');

// Quaternion Julia: the four components of c.
shader = replaceOnce(
  shader,
  '  // Animated Julia constant orbiting slowly.\n' +
  '  let t = select(u.time, 0.0, u.reducedMotion > 0.5);\n' +
  '  let c = vec4<f32>(\n' +
  '    0.35 * cos(t * 0.13),\n' +
  '    0.35 * sin(t * 0.11),\n' +
  '    0.28 * cos(t * 0.09 + 1.0),\n' +
  '    0.18\n' +
  '  );',
  '  // Julia parameter c: the defining constant of this set.\n' +
  '  let c = vec4<f32>(\n' +
  '    modelValue(0u, -0.8, 0.8),\n' +
  '    modelValue(1u, -0.8, 0.8),\n' +
  '    modelValue(2u, -0.8, 0.8),\n' +
  '    modelValue(3u, -0.8, 0.8)\n' +
  '  );',
  'Julia constant',
);

// Apollonian packing.
shader = replaceOnce(
  shader,
  '  // Packing tightness \'s\' breathes slowly for a living, re-packing feel.\n' +
  '  let anim = select(sin(u.time * 0.08), 0.0, u.reducedMotion > 0.5);\n' +
  '  let s = 1.25 + 0.11 * anim;',
  '  let s = modelValue(0u, 1.05, 1.55);',
  'Apollonian inversion scale',
);
shader = replaceOnce(shader, '  const AP_ITERS : i32 = 8;',
  '  const AP_ITERS : i32 = 12;\n  let apIters = i32(round(modelValue(1u, 3.0, 12.0)));',
  'Apollonian iteration ceiling');
shader = replaceOnce(shader, '  for (var i = 0; i < AP_ITERS; i = i + 1) {',
  '  for (var i = 0; i < AP_ITERS; i = i + 1) {\n    if (i >= apIters) { break; }',
  'Apollonian live iterations');
shader = replaceOnce(shader, '  const BOUND : f32 = 1.3;',
  '  let BOUND = modelValue(2u, 0.8, 1.8);', 'Apollonian bound');

// Nested sphere packing.
shader = replaceOnce(
  shader,
  '  let anim = select(sin(u.time * 0.06), 0.0, u.reducedMotion > 0.5);\n' +
  '  let s = 1.28 + 0.05 * anim;',
  '  let s = modelValue(0u, 1.05, 1.55);',
  'SpherePack inversion scale',
);
shader = replaceOnce(shader, '  const SP_ITERS : i32 = 9;',
  '  const SP_ITERS : i32 = 12;\n  let spIters = i32(round(modelValue(1u, 3.0, 12.0)));',
  'SpherePack iteration ceiling');
shader = replaceOnce(shader, '  for (var i = 0; i < SP_ITERS; i = i + 1) {',
  '  for (var i = 0; i < SP_ITERS; i = i + 1) {\n    if (i >= spIters) { break; }',
  'SpherePack live iterations');
shader = replaceOnce(shader, '  let spheres = (length(p) - 1.1) / scale;',
  '  let spheres = (length(p) - modelValue(2u, 0.7, 1.4)) / scale;',
  'SpherePack sphere radius');
shader = replaceOnce(shader, '  let shell = length(pos) - 1.15;',
  '  let shell = length(pos) - modelValue(3u, 0.8, 1.6);',
  'SpherePack cluster radius');

// Encrusted sphere.
shader = replaceOnce(shader, '  const R : f32 = 0.95;              // host sphere radius',
  '  let R = modelValue(0u, 0.65, 1.25); // host sphere radius',
  'Encrusted host radius');
shader = replaceOnce(
  shader,
  '  let anim = select(sin(u.time * 0.05), 0.0, u.reducedMotion > 0.5);\n' +
  '  let s = 1.24 + 0.04 * anim;',
  '  let s = modelValue(3u, 1.05, 1.45);',
  'Encrusted inversion scale',
);
shader = replaceOnce(shader, '  let shell = max(r - (R + 0.38), (R - 0.03) - r);',
  '  let shell = max(r - (R + modelValue(1u, 0.12, 0.55)), (R - 0.03) - r);',
  'Encrusted crust reach');
shader = replaceOnce(shader, '  let capMask = dot(n, normalize(vec3<f32>(0.35, 1.0, 0.28))) - 0.7',
  '  let capMask = dot(n, normalize(vec3<f32>(0.35, 1.0, 0.28))) - modelValue(2u, 0.2, 0.9)',
  'Encrusted cap threshold');

// Studded surface packing. The seam lookup must use exactly the same cell and
// sphere-radius math as the estimator.
shader = replaceOnce(shader, '  const R : f32 = 1.0;\n  const SHELL : f32 = 0.09;',
  '  let R = modelValue(0u, 0.7, 1.3);\n  let SHELL = modelValue(1u, 0.03, 0.2);',
  'SurfacePack body and shell');
shader = replaceCount(shader, '  var cellSize = 0.22;',
  '  var cellSize = modelValue(2u, 0.12, 0.35);', 2, 'SurfacePack cell size');
shader = replaceCount(
  shader,
  '    let rad = cellSize * (0.18 + 0.31 * h * h * h) * pulse;',
  '    let rad = cellSize * (0.18 + 0.31 * h * h * h) * pulse * modelValue(3u, 0.55, 1.35);',
  2,
  'SurfacePack stud radius',
);

// Retired Penrose relief: its own disc/tiling quantities remain controllable for
// direct API users even though it is no longer in the selector.
shader = replaceOnce(
  shader,
  '  const R : f32 = 1.35;        // disc radius\n' +
  '  const HT : f32 = 0.060;      // half thickness\n' +
  '  const SCALE : f32 = 0.17;    // world units per rhombus edge',
  '  let R = modelValue(0u, 0.8, 1.8);        // disc radius\n' +
  '  let HT = modelValue(1u, 0.025, 0.11);    // half thickness\n' +
  '  let SCALE = modelValue(2u, 0.09, 0.28);  // world units per rhombus edge',
  'Penrose dimensions',
);
shader = replaceOnce(shader,
  '  let phason = 0.09 * vec2<f32>(cos(tm * 0.05), sin(tm * 0.043));',
  '  let phason = modelValue(3u, 0.0, 0.2) * vec2<f32>(cos(tm * 0.05), sin(tm * 0.043));',
  'Penrose phason amplitude');

// Gyroid implicit-surface equation.
shader = replaceOnce(
  shader,
  '  const R : f32 = 1.35;            // clipping ball\n' +
  '  const FREQ : f32 = 5.5;          // lattice periods per world unit\n' +
  '  const HALF : f32 = 0.34;         // wall half-thickness, in units of f',
  '  let R = modelValue(3u, 0.8, 2.2);       // clipping ball\n' +
  '  let FREQ = modelValue(0u, 2.5, 9.0);    // lattice frequency\n' +
  '  let HALF = modelValue(1u, 0.12, 0.6);   // wall half-thickness',
  'Gyroid equation constants',
);
shader = replaceOnce(
  shader,
  '  let tm = select(u.time, 0.0, u.reducedMotion > 0.5);\n' +
  '  let level = 0.3 * sin(tm * 0.08);',
  '  let level = modelValue(2u, -0.7, 0.7);',
  'Gyroid level set',
);

// Pseudo-Kleinian group.
shader = replaceOnce(shader, '  const CCONST : f32 = 0.92436;   // radius of the final cylinder primitive',
  '  let CCONST = modelValue(2u, 0.65, 1.2); // radius of the final cylinder primitive',
  'Kleinian primitive radius');
shader = replaceOnce(shader, '  const BOUND : f32 = 1.55;       // clipping ball',
  '  let BOUND = modelValue(3u, 1.1, 2.2); // clipping ball',
  'Kleinian bound');
shader = replaceOnce(
  shader,
  '  let anim = select(sin(u.time * 0.045), 0.0, u.reducedMotion > 0.5);\n' +
  '  let minRad2 = 0.92 + 0.015 * anim;',
  '  let minRad2 = modelValue(1u, 0.75, 1.08);',
  'Kleinian inversion radius',
);
shader = replaceOnce(shader, '    p = 2.0 * clamp(p, -CS, CS) - p;',
  '    let liveCS = CS * modelValue(0u, 0.85, 1.15);\n' +
  '    p = 2.0 * clamp(p, -liveCS, liveCS) - p;',
  'Kleinian fold cell');

// Barth pencil parameter.
shader = replaceOnce(
  shader,
  '  let tm = select(u.time, 0.0, u.reducedMotion > 0.5);\n' +
  '  let w2 = 1.0 + 0.10 * sin(tm * 0.07);',
  '  let w2 = modelValue(0u, 0.75, 1.25);',
  'Barth pencil parameter',
);

// Schottky sphere scale; the two entries use different mathematically meaningful
// ranges on opposite sides of the parabolic boundary.
shader = replaceOnce(
  shader,
  '  var s : f32 = 1.0;\n' +
  '  if (u.fractalType > 12.5) {\n' +
  '    let tm = select(u.time, 0.0, u.reducedMotion > 0.5);\n' +
  '    s = 0.925 - 0.045 * sin(tm * 0.06);\n' +
  '  }',
  '  var s = modelValue(0u, 0.96, 1.0);\n' +
  '  if (u.fractalType > 12.5) {\n' +
  '    s = modelValue(0u, 0.82, 0.98);\n' +
  '  }',
  'Schottky generator scale',
);

// Tetrabrot bicomplex slice.
shader = replaceOnce(
  shader,
  '  let c1 = vec2<f32>(pos.x + X_SHIFT, pos.y - pos.z);\n' +
  '  let c2 = vec2<f32>(pos.x + X_SHIFT, pos.y + pos.z);',
  '  let xShift = modelValue(0u, -0.9, -0.1);\n' +
  '  let coupling = modelValue(1u, 0.45, 1.55);\n' +
  '  let c1 = vec2<f32>(pos.x + xShift, pos.y - coupling * pos.z);\n' +
  '  let c2 = vec2<f32>(pos.x + xShift, pos.y + coupling * pos.z);',
  'Tetrabrot slice parameters',
);

// Envelope-extrusion offset for the two seeds.
shader = replaceOnce(shader, '  var c = C_OCT;',
  '  var c = modelValue(0u, 0.25, 0.65);', 'Octahedral envelope offset');
shader = replaceOnce(shader, '    c = C_DOD;',
  '    c = modelValue(0u, 0.75, 1.45);', 'Dodecahedral envelope offset');

// Hyperbolic honeycombs: the group remains exact; the live geometric quantities
// are the edge-tube radius and the finite Poincare-ball clip.
shader = replaceOnce(shader, '  const R_CLIP : f32 = 0.85;',
  '  let R_CLIP = modelValue(1u, 0.65, 0.95);', 'Honeycomb clip');
shader = replaceOnce(shader, '  var thick = 0.020;',
  '  var thick = modelValue(0u, 0.006, 0.04);', 'Honeycomb edge radius');
shader = replaceCount(shader, '    ecount = 2; thick = 0.017;',
  '    ecount = 2;', 2, 'Truncated honeycomb baked thickness');
shader = replaceCount(shader, '    ecount = 4; thick = 0.012;',
  '    ecount = 4;', 2, 'Omnitruncated honeycomb baked thickness');

// Kleinian horoball packing. Changing the seed radius also moves its centre
// along the ideal-vertex ray so it remains a horoball tangent to infinity.
shader = replaceOnce(shader, '  const R_CLIP : f32 = 0.95;      // the packing is tangent to |p| = 1',
  '  let R_CLIP = modelValue(1u, 0.75, 0.99); // packing clip',
  'KleinPack clip');
shader = replaceOnce(
  shader,
  '  const HO : vec3<f32> = vec3<f32>(-0.26298370, -0.36196601, -0.58567330);\n' +
  '  const HR : f32 = 0.26298370;',
  '  const IDEAL : vec3<f32> = vec3<f32>(-0.35682209, -0.49112348, -0.79465447);\n' +
  '  let HR = modelValue(0u, 0.12, 0.36);\n' +
  '  let HO = (1.0 - HR) * IDEAL;',
  'KleinPack horoball',
);

// Engel plesiohedral tiling: lattice scale, joint erosion, and finite clip.
shader = replaceOnce(
  shader,
  '  const GAP : f32 = 0.012;        // erosion; the cell\'s inscribed radius is 0.070\n' +
  '  const R_CLIP : f32 = 1.15;      // the tiling is infinite, so bound it',
  '  let CELL_SCALE = modelValue(0u, 0.6, 1.4);\n' +
  '  let GAP = modelValue(1u, 0.0, 0.035);\n' +
  '  let R_CLIP = modelValue(2u, 0.75, 1.8);',
  'Engel dimensions',
);
shader = replaceOnce(shader, '  let xf = pos - floor(pos);',
  '  let ep = pos / CELL_SCALE;\n  let xf = ep - floor(ep);',
  'Engel lattice scale');
shader = replaceOnce(shader, '  res.dist = max(d + GAP, length(pos) - R_CLIP);',
  '  res.dist = max((d + GAP) * CELL_SCALE, length(pos) - R_CLIP);',
  'Engel scaled distance');

// Ziggurat's own lattice equation.
shader = replaceOnce(
  shader,
  '  const CELL : f32 = 0.13;    // grid spacing\n' +
  '  const STEP : f32 = 0.055;   // height gained per ring\n' +
  '  const HALF : f32 = 0.45;    // cube half-extent as a fraction of CELL\n' +
  '  const RINGS : f32 = 11.0;   // terraces before the plateau',
  '  let CELL = modelValue(0u, 0.07, 0.22);\n' +
  '  let STEP = modelValue(1u, 0.02, 0.1);\n' +
  '  let HALF = modelValue(2u, 0.25, 0.49);\n' +
  '  let RINGS = round(modelValue(3u, 4.0, 18.0));',
  'Ziggurat equation parameters',
);

// Cube stack equation.
shader = replaceOnce(
  shader,
  '  const CELL : f32 = 0.0313; // grid spacing\n' +
  '  const HALF : f32 = 0.37;   // cube half-extent as a fraction of CELL\n' +
  '  const N : f32 = 31.0;      // cells from centre to rim, so 63 across a face\n' +
  '  const STEPC : f32 = 2.0;   // cells of ring per terrace\n' +
  '  const DEPTH : f32 = 15.0;  // terraces the funnel descends',
  '  let CELL = modelValue(0u, 0.02, 0.055);\n' +
  '  let HALF = modelValue(1u, 0.2, 0.48);\n' +
  '  const N : f32 = 31.0;\n' +
  '  let STEPC = modelValue(2u, 1.0, 5.0);\n' +
  '  let DEPTH = round(modelValue(3u, 5.0, 25.0));',
  'CubeStack equation parameters',
);

export const FRACTAL_WGSL = shader;
