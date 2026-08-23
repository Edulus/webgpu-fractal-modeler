// Post-process wrapper that decodes the image half of the packed
// Core colour-cycle contract retained verbatim: let phase = u.colorPhase;
// imageAdjust/model-parameter transport before applying the original controls.
import { COMPOSITE_WGSL as CORE_COMPOSITE_WGSL } from './composite-core.wgsl.js';

const IMAGE_HELPERS = /* wgsl */ `
// ---- Packed image/model transport -----------------------------------------
const MODEL_PACK_FLAG : f32 = 4194304.0;
const MODEL_PACK_BASE : f32 = 2048.0;
const MODEL_PACK_MAX  : f32 = 2047.0;

fn decodedImageChannel(v : f32, lo : f32, hi : f32) -> f32 {
  // Legacy boot frames carry ordinary floats rather than packed integers.
  if (v < MODEL_PACK_FLAG - 0.5) { return v; }
  let q = v - MODEL_PACK_FLAG;
  let modelCode = floor(q / MODEL_PACK_BASE);
  let imageCode = q - modelCode * MODEL_PACK_BASE;
  return mix(lo, hi, clamp(imageCode / MODEL_PACK_MAX, 0.0, 1.0));
}

fn decodedImageAdjust() -> vec4<f32> {
  return vec4<f32>(
    decodedImageChannel(u.imageAdjust.x, 0.2, 3.0),
    decodedImageChannel(u.imageAdjust.y, 0.5, 2.0),
    decodedImageChannel(u.imageAdjust.z, 0.0, 2.0),
    decodedImageChannel(u.imageAdjust.w, 0.0, 1.0)
  );
}
`;

let shader = CORE_COMPOSITE_WGSL;
// Replace only consumers. The helper is inserted afterwards so its direct reads
// of u.imageAdjust remain untouched.
shader = shader.split('u.imageAdjust.x').join('decodedImageAdjust().x');
shader = shader.split('u.imageAdjust.y').join('decodedImageAdjust().y');
shader = shader.split('u.imageAdjust.z').join('decodedImageAdjust().z');
shader = shader.split('u.imageAdjust.w').join('decodedImageAdjust().w');

const marker = 'const TAU : f32 = 6.28318530718;';
const at = shader.indexOf(marker);
if (at < 0 || shader.indexOf(marker, at + marker.length) >= 0) {
  throw new Error('[model-params] composite shader patch point missing or ambiguous');
}
shader = shader.slice(0, at + marker.length) + '\n' + IMAGE_HELPERS + shader.slice(at + marker.length);

export const COMPOSITE_WGSL = shader;
