// Runtime material shader plus the per-shape Cosmic Web coordinate controls.
// material-core.wgsl.js still contains the complete original material shader.
import { MATERIAL_WGSL as CORE_MATERIAL_WGSL } from './material-core.wgsl.js';

const FIND = 'fn cosmicWebSampleAt(p : vec3<f32>, tm : f32) -> CosmicWebSample {\n';
const REPLACE = 'fn cosmicWebSampleAt(pos : vec3<f32>, tm : f32) -> CosmicWebSample {\n' +
  '  let p = modelSpace(pos, u.fractalType).p;\n';

const at = CORE_MATERIAL_WGSL.indexOf(FIND);
if (at < 0 || CORE_MATERIAL_WGSL.indexOf(FIND, at + FIND.length) >= 0) {
  throw new Error('[model-params] Cosmic Web shader patch point missing or ambiguous');
}

export const MATERIAL_WGSL =
  CORE_MATERIAL_WGSL.slice(0, at) + REPLACE + CORE_MATERIAL_WGSL.slice(at + FIND.length);
