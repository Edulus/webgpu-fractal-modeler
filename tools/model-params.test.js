// Per-shape parameter registry and packed-uniform transport.
// Run: node tools/model-params.test.js

import { MODEL_PARAMETERS, IMAGE_RANGES, defaultValuesFor, normalizedValuesFor, packImageAndModel, unpackChannel } from '../src/model-params.js';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const expectedShapes = [
  'mandelbulb', 'mandelbox', 'menger', 'julia', 'apollonian', 'spherepack',
  'encrusted', 'surfacepack', 'penrose', 'gyroid', 'kleinian', 'barth',
  'schottky', 'schottkyh', 'tetrabrot', 'envoct', 'envdodec', 'hyp534',
  'hyp435', 'hyp534t', 'hyp534o', 'hyp435t', 'hyp435o', 'kleinpack',
  'engel', 'attractor', 'lorenz', 'rossler', 'cosmicweb', 'ziggurat', 'cubestack',
];

console.log('\nmodel parameter registry');
check('every registered renderer shape has a parameter schema',
  expectedShapes.every((name) => Array.isArray(MODEL_PARAMETERS[name])));
check('every shape exposes four controls',
  expectedShapes.every((name) => MODEL_PARAMETERS[name].length === 4));
check('parameter keys are unique within each shape',
  expectedShapes.every((name) => new Set(MODEL_PARAMETERS[name].map((p) => p.key)).size === 4));
check('every default lies inside its slider range',
  expectedShapes.every((name) => MODEL_PARAMETERS[name].every((p) => p.default >= p.min && p.default <= p.max)));

console.log('\nnormalization');
{
  const bulb = normalizedValuesFor('mandelbulb', defaultValuesFor('mandelbulb'));
  check('Mandelbulb default power normalizes to 0.6', Math.abs(bulb[0] - 0.6) < 1e-12);
  check('Mandelbulb deformation defaults are neutral', bulb.slice(1).every((x) => Math.abs(x - 0.5) < 1e-12));
  const box = normalizedValuesFor('mandelbox', defaultValuesFor('mandelbox'));
  check('Mandelbox fold-scale default is preserved', Math.abs(box[0] - 0.575) < 1e-12);
  check('generic scale/twist/stretch/warp defaults are neutral',
    ['menger', 'gyroid', 'kleinpack', 'cosmicweb', 'cubestack'].every((name) =>
      normalizedValuesFor(name, defaultValuesFor(name)).every((x) => Math.abs(x - 0.5) < 1e-12)));
}

console.log('\npacked image/model transport');
{
  const image = { exposure: 1.37, contrast: 0.92, saturation: 1.61, hue: 0.235 };
  const model = [0.12, 0.34, 0.78, 0.91];
  const packed = packImageAndModel(image, model);
  const keys = Object.keys(IMAGE_RANGES);
  check('packed values remain exact f32-safe integers', keys.every((k) => Number.isInteger(packed[k]) && packed[k] <= 8388607));
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const decoded = unpackChannel(packed[key], key);
    const [lo, hi] = IMAGE_RANGES[key];
    check(`${key} survives 11-bit packing`, Math.abs(decoded.image - image[key]) <= (hi - lo) / 2047 + 1e-12);
    check(`model slot ${i} survives 11-bit packing`, Math.abs(decoded.model - model[i]) <= 1 / 2047 + 1e-12);
  }
  check('legacy un-packed image values remain readable', unpackChannel(1.25, 'exposure').image === 1.25);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
