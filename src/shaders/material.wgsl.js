// Runtime material shader plus native Cosmic Web field parameters.
// material-core.wgsl.js contains the full volumetric implementation and imports
// the distance-estimator wrapper, so modelValue() is already available here.
import { MATERIAL_WGSL as CORE_MATERIAL_WGSL } from './material-core.wgsl.js';

function replaceOnce(source, find, replacement, label) {
  const at = source.indexOf(find);
  if (at < 0) throw new Error(`[model-params] material shader patch missing: ${label}`);
  if (source.indexOf(find, at + find.length) >= 0) {
    throw new Error(`[model-params] material shader patch ambiguous: ${label}`);
  }
  return source.slice(0, at) + replacement + source.slice(at + find.length);
}

let shader = CORE_MATERIAL_WGSL;

shader = replaceOnce(
  shader,
  'fn cosmicWebSampleAt(p : vec3<f32>, tm : f32) -> CosmicWebSample {\n',
  'fn cosmicWebSampleAt(p : vec3<f32>, tm : f32) -> CosmicWebSample {\n' +
  '  let baseFrequency = modelValue(0u, 0.45, 1.2);\n' +
  '  let sharpness = modelValue(1u, 2.5, 8.0);\n' +
  '  let voidThreshold = modelValue(2u, 0.25, 0.65);\n' +
  '  let volumeRadius = modelValue(3u, 3.5, 8.0);\n',
  'Cosmic Web parameter declarations',
);

shader = replaceOnce(
  shader,
  '  let low = webFbm3((p + drift * 0.45) * 0.22\n',
  '  let low = webFbm3((p + drift * 0.45) * (0.22 * baseFrequency / 0.78)\n',
  'Cosmic Web fBm scale',
);

shader = replaceOnce(
  shader,
  '  let wm = webWave(q, 0.78, phase);\n' +
  '  let ws = webWave(q + vec3<f32>(2.7, -1.8, 4.1), 1.56, -phase * 1.13);\n' +
  '  let wf = webWave(q + vec3<f32>(-3.4, 2.2, 1.6), 3.08, phase * 1.31);',
  '  let wm = webWave(q, baseFrequency, phase);\n' +
  '  let ws = webWave(q + vec3<f32>(2.7, -1.8, 4.1), baseFrequency * 2.0, -phase * 1.13);\n' +
  '  let wf = webWave(q + vec3<f32>(-3.4, 2.2, 1.6), baseFrequency * 3.94871795, phase * 1.31);',
  'Cosmic Web frequency hierarchy',
);

shader = replaceOnce(
  shader,
  '  let majorPair = webFilament(wm, 4.7);\n' +
  '  let secondaryPair = webFilament(ws, 5.8);\n' +
  '  let finePair = webFilament(wf, 7.1);',
  '  let majorPair = webFilament(wm, sharpness);\n' +
  '  let secondaryPair = webFilament(ws, sharpness * 1.23404255);\n' +
  '  let finePair = webFilament(wf, sharpness * 1.51063830);',
  'Cosmic Web filament sharpness',
);

shader = replaceOnce(
  shader,
  '  let voidGate = smoothstep(0.36, 0.59, low);\n' +
  '  let bound = 1.0 - smoothstep(4.8, 5.7, length(p));',
  '  let voidGate = smoothstep(voidThreshold - 0.115, voidThreshold + 0.115, low);\n' +
  '  let bound = 1.0 - smoothstep(volumeRadius - 0.9, volumeRadius, length(p));',
  'Cosmic Web void and bound',
);

shader = replaceOnce(
  shader,
  '  let radius = 5.7;',
  '  let radius = modelValue(3u, 3.5, 8.0);',
  'Cosmic Web ray bound',
);

export const MATERIAL_WGSL = shader;
