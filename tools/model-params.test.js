// Per-shape parameter registry and packed-uniform transport.
// Run: node tools/model-params.test.js

import fs from 'node:fs';
import {
  MODEL_PARAMETERS, IMAGE_RANGES, defaultValuesFor, normalizedValuesFor,
  packImageAndModel, unpackChannel,
} from '../src/model-params.js';

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

console.log('\nmodel-specific parameter registry');
check('every registered renderer shape has a parameter schema',
  expectedShapes.every((name) => Array.isArray(MODEL_PARAMETERS[name]) && MODEL_PARAMETERS[name].length > 0));
check('control counts are allowed to differ by shape',
  new Set(expectedShapes.map((name) => MODEL_PARAMETERS[name].length)).size > 1);
check('no shape exceeds the four transport slots',
  expectedShapes.every((name) => MODEL_PARAMETERS[name].length <= 4));
check('parameter keys are unique within each shape',
  expectedShapes.every((name) =>
    new Set(MODEL_PARAMETERS[name].map((param) => param.key)).size === MODEL_PARAMETERS[name].length));
check('every default lies inside its slider range',
  expectedShapes.every((name) =>
    MODEL_PARAMETERS[name].every((param) => param.default >= param.min && param.default <= param.max)));

const labels = (name) => MODEL_PARAMETERS[name].map((param) => param.label).join(' | ');
check('Julia exposes the four components of its defining c constant',
  ['Julia c · x', 'Julia c · y', 'Julia c · z', 'Julia c · w']
    .every((label) => labels('julia').includes(label)));
check('Mandelbox exposes fold and sphere-fold radii',
  labels('mandelbox').includes('Fold scale')
    && labels('mandelbox').includes('Minimum radius')
    && labels('mandelbox').includes('Fixed radius'));
check('sphere packing exposes packing-specific quantities',
  labels('spherepack').includes('Inversion scale')
    && labels('spherepack').includes('Folded sphere radius')
    && labels('spherepack').includes('Cluster radius'));
check('Barth sextic is not padded with irrelevant generic sliders',
  MODEL_PARAMETERS.barth.length === 1 && labels('barth').includes('Pencil parameter'));
check('Lorenz and Rössler no longer share generic UI labels',
  labels('lorenz') !== labels('rossler'));

console.log('\nnormalization');
{
  const bulb = normalizedValuesFor('mandelbulb', defaultValuesFor('mandelbulb'));
  check('Mandelbulb default power normalizes to 0.6', Math.abs(bulb[0] - 0.6) < 1e-12);
  const julia = normalizedValuesFor('julia', defaultValuesFor('julia'));
  check('Julia provides four independent normalized c components', julia.length === 4);
  const barth = normalizedValuesFor('barth', defaultValuesFor('barth'));
  check('single-parameter shapes normalize without padding their schema', barth.length === 1);
}

console.log('\nshader routing');
{
  const fractal = fs.readFileSync('src/shaders/fractal.wgsl.js', 'utf8');
  const material = fs.readFileSync('src/shaders/material.wgsl.js', 'utf8');
  check('universal modelSpace deformation layer is gone',
    !fractal.includes('fn modelSpace(') && !material.includes('modelSpace('));
  check('Julia c components are wired into the Julia estimator',
    fractal.includes("modelValue(0u, -0.8, 0.8)")
      && fractal.includes("modelValue(3u, -0.8, 0.8)"));
  check('sphere packing uses packing-specific live constants',
    fractal.includes('SpherePack inversion scale')
      && fractal.includes('SpherePack sphere radius')
      && fractal.includes('SpherePack cluster radius'));
  check('Gyroid parameters enter the implicit-surface equation',
    fractal.includes('Gyroid equation constants')
      && fractal.includes('Gyroid level set'));
  check('Cosmic Web parameters enter the volumetric field',
    material.includes('let baseFrequency = modelValue(0u, 0.45, 1.2);')
      && material.includes('let voidThreshold = modelValue(2u, 0.25, 0.65);'));
}

console.log('\npacked image/model transport');
{
  const image = { exposure: 1.37, contrast: 0.92, saturation: 1.61, hue: 0.235 };
  const model = [0.12, 0.34, 0.78, 0.91];
  const packed = packImageAndModel(image, model);
  const keys = Object.keys(IMAGE_RANGES);
  check('packed values remain exact f32-safe integers',
    keys.every((key) => Number.isInteger(packed[key]) && packed[key] <= 8388607));
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const decoded = unpackChannel(packed[key], key);
    const [lo, hi] = IMAGE_RANGES[key];
    check(`${key} survives 11-bit packing`,
      Math.abs(decoded.image - image[key]) <= (hi - lo) / 2047 + 1e-12);
    check(`model slot ${i} survives 11-bit packing`,
      Math.abs(decoded.model - model[i]) <= 1 / 2047 + 1e-12);
  }
  check('legacy un-packed image values remain readable',
    unpackChannel(1.25, 'exposure').image === 1.25);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
