// fractal.wgsl.js — runtime shader assembled from the proven base estimator set.
//
// The base module is the shader as it existed before Gyroid shape parameters.
// Keeping it intact lets this feature replace one estimator without copying or
// risking unrelated estimator code. MATERIAL_WGSL imports this final string too,
// so the visible raymarch and the clearance probe always use identical maths.
import { FRACTAL_WGSL as BASE_FRACTAL_WGSL } from './fractal-base.wgsl.js';

const GYROID_START = '// ---- Gyroid ---------------------------------------------------------------';
const GYROID_END = '// ---- Kleinian limit set ---------------------------------------------------';

const start = BASE_FRACTAL_WGSL.indexOf(GYROID_START);
const end = BASE_FRACTAL_WGSL.indexOf(GYROID_END, start);
if (start < 0 || end < 0) {
  throw new Error('Gyroid estimator markers not found in base shader');
}

const GYROID_WGSL = /* wgsl */ `// ---- Gyroid ---------------------------------------------------------------
//
// Schoen's gyroid, represented by the standard trigonometric nodal field
//
//   f(p) = cos x sin y + cos y sin z + cos z sin x.
//
// Slots 0..2 expose three genuine parameters of that construction:
//   0  cubic unit-cell size a
//   1  level-set offset t
//   2  wall half-thickness h
//
// Cell size is presented instead of frequency because it is the familiar
// geometric quantity. The shader derives k = 2*pi/a and uses that SAME k in the
// global Lipschitz bound sqrt(3)*k, so changing the cell size cannot leave the
// sphere-tracing safety divisor stale.
fn deGyroid(pos : vec3<f32>) -> DEResult {
  const R : f32 = 1.35;            // orbit-mode presentation clip only
  const SQRT3 : f32 = 1.73205081;  // exact bound on |grad f| before scaling

  // Last-line guards protect the estimator from a non-UI writer putting an
  // invalid value directly in the uniform block. The registry's user ranges
  // are much narrower than these guards.
  let cellSize = max(shapeParam(0u), 1e-4);
  let freq = 2.0 * PI / cellSize;
  let level = shapeParam(1u);
  let half = max(shapeParam(2u), 0.0);

  var res : DEResult;

  // The mathematical gyroid is infinite and triply periodic. Orbit mode clips
  // it to a ball so it can be viewed as an object; fly-through mode removes the
  // clip and exposes the periodic structure itself.
  let clipped = u.flyMode < 0.5;
  let ball = length(pos) - R;
  if (clipped && ball > 0.25) {
    res.dist = ball;
    res.trap = 0.4;
    return res;
  }

  let q = pos * freq;
  let s = sin(q);
  let c = cos(q);
  let f = c.x * s.y + c.y * s.z + c.z * s.x;

  // |grad f| <= sqrt(3) in field coordinates. q = p*freq multiplies
  // world-space derivatives by freq, so this remains a conservative distance
  // under-estimate at every Cell size without an empirical safety factor.
  let shell = (abs(f - level) - half) / (SQRT3 * freq);
  res.dist = select(shell, max(shell, ball), clipped);

  // The two faces look into the two interpenetrating labyrinths and keep their
  // existing separate palette bands.
  let face = select(0.0, 1.0, f - level >= 0.0);
  let aux = c.x * s.y - c.z * s.x;
  res.trap = 0.2 + 0.4 * face + 0.18 * clamp(0.5 + 0.35 * aux, 0.0, 1.0);
  return res;
}

`;

export const FRACTAL_WGSL =
  BASE_FRACTAL_WGSL.slice(0, start) + GYROID_WGSL + BASE_FRACTAL_WGSL.slice(end);
