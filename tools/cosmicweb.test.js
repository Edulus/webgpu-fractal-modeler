import fs from 'node:fs';
import { MATERIAL_WGSL } from '../src/shaders/material.wgsl.js';
import { COMPOSITE_WGSL } from '../src/shaders/composite.wgsl.js';
import { FRACTAL_IDS, shapeKind, shapeKindWGSL } from '../src/shapes.js';

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}

console.log('\nCosmic Web registration and render routing');
const index = fs.readFileSync('index.html', 'utf8');
const bg = fs.readFileSync('src/fractal-bg.js', 'utf8');
const material = MATERIAL_WGSL;
const composite = COMPOSITE_WGSL;

ok(index.includes('<option value="cosmicweb">Cosmic Web</option>'),
   'selector exposes Cosmic Web');
ok(index.includes("cosmicweb: ['Cosmic Web'"),
   'Shape Explorer has a Cosmic Web note');
ok(FRACTAL_IDS.cosmicweb === 28 && shapeKind(28) === 'volume',
   'Cosmic Web keeps its stable id 28 and is the volume kind');
ok(shapeKind(28) !== 'line', 'attractor routing excludes Cosmic Web');
ok(bg.includes('state.fractalType === FRACTAL_IDS.cosmicweb) return false;'),
   'animated Cosmic Web does not freeze into progressive accumulation');
ok(material.includes('fn cosmicWebSampleAt(') && material.includes('fn cosmicWebMaterial('),
   'material shader contains the hierarchical volume field');
ok(material.includes('return cosmicWebMaterial(ro, rd);'),
   'Cosmic Web routes through the volumetric material path');
ok(material.includes('if (isVolumeShape(u.fractalType)) {') && material.includes('if (isLineShape(u.fractalType)) {'),
   'material routes the volume and the line attractors separately');
ok(!/abs\(ft - 28\.0\) < 0\.5/.test(shapeKindWGSL().split('fn isVolumeShape')[0]),
   'the generated line test does not include Cosmic Web');
ok(composite.includes('if (isLineShape(u.fractalType)) {'),
   'composite attractor reconstruction excludes Cosmic Web');
ok(material.includes('webFbm3') && material.includes('webFilament') && material.includes('voidGate'),
   'field contains fBm hierarchy, filament extraction, and void gating');
ok(material.includes('stepCount = max(28, min(stepCount, 88));'),
   'volume integration scales with the adaptive detail rung');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
