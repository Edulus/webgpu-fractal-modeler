// Composite upscale, dither and shadow offset: the last three improvements
// ported from the original renderer. String assertions pin the WGSL; the
// numeric part checks the Catmull-Rom weights the shader uses.
import fs from 'node:fs';
import { COMPOSITE_WGSL } from '../src/shaders/composite.wgsl.js';
import { MATERIAL_WGSL } from '../src/shaders/material.wgsl.js';

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}

console.log('\nCatmull-Rom weights (JS port of catmullRomWeights)');
const cr = (f) => [f * (-0.5 + f * (1 - 0.5 * f)), 1 + f * f * (-2.5 + 1.5 * f),
                   f * (0.5 + f * (2 - 1.5 * f)), f * f * (-0.5 + 0.5 * f)];
let partition = true, interpolates = true;
for (let i = 0; i <= 20; i++) {
  const w = cr(i / 20);
  if (Math.abs(w.reduce((a, b) => a + b, 0) - 1) > 1e-12) partition = false;
}
const w0 = cr(0), w1 = cr(1);
if (Math.abs(w0[1] - 1) > 1e-12 || Math.abs(w1[2] - 1) > 1e-12) interpolates = false;
ok(partition, 'weights sum to 1 across the texel, so flat regions stay flat');
ok(interpolates, 'at a texel centre the filter returns that texel exactly');
ok(cr(0.5)[0] < 0, 'it has negative lobes -- which is why the result must be clamped');
const port = COMPOSITE_WGSL.slice(COMPOSITE_WGSL.indexOf('fn catmullRomWeights'),
                                  COMPOSITE_WGSL.indexOf('fn sampleCatmullRom'));
ok(port.includes('f * (-0.5 + f * (1.0 - 0.5 * f))') && port.includes('f * f * (-0.5 + 0.5 * f)'),
   'the shader uses the same weights as this port');

console.log('\nBicubic upscale in the composite');
ok(/fn resolveSceneEdgeAA\(uv : vec2<f32>\) -> vec4<f32> \{\s*let base = resolveSceneUpscaled\(uv\);/.test(COMPOSITE_WGSL),
   'the composite centre sample is the upscaled one');
ok(/fn resolveSceneUpscaled[\s\S]*?if \(u\.qualityScale > 0\.999\) \{\s*return resolveScene\(uv\);/.test(COMPOSITE_WGSL),
   'native and supersampled rungs keep plain bilinear');
ok(/return clamp\(r, min\(min\(t00, t10\), min\(t01, t11\)\), max\(max\(t00, t10\), max\(t01, t11\)\)\);/.test(COMPOSITE_WGSL),
   'the result is clamped to the four surrounding texels (no ringing, no negative weights)');
ok(/fn resolveScene\(uv : vec2<f32>\) -> vec4<f32> \{\s*return resolveMaterial\(textureSampleLevel/.test(COMPOSITE_WGSL),
   'every other caller (edge taps, sharpen, bloom) stays on the cheap bilinear path');
const prefilter = COMPOSITE_WGSL.slice(COMPOSITE_WGSL.indexOf('fn prefilterAt'), COMPOSITE_WGSL.indexOf('fn fs_bloom_prefilter'));
ok(prefilter.includes('resolveScene(uv)') && !prefilter.includes('Upscaled'), 'bloom does not pay for the bicubic taps');
ok(!COMPOSITE_WGSL.includes('@binding(5)'), 'no new binding in the composite pass');

console.log('\nDither');
ok(/hash21\(in\.pos\.xy \+ fract\(u\.time\) \* 61\.0\)/.test(COMPOSITE_WGSL), 'dither is seeded per canvas pixel');
ok(!/hash21\(in\.uv \* u\.resolution/.test(COMPOSITE_WGSL), 'not per internal texel, which showed as blocks at low rungs');

console.log('\nShadow ray offset');
ok(/let shadowBias = max\(0\.002, hitEps \* t \* 2\.0\);/.test(MATERIAL_WGSL)
   && /softShadow\(pos \+ n \* shadowBias,/.test(MATERIAL_WGSL),
   'the shadow ray starts outside the hit tolerance, which grows on moving frames');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
