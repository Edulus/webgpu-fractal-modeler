import fs from 'node:fs';

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
const material = fs.readFileSync('src/shaders/material.wgsl.js', 'utf8');
const composite = fs.readFileSync('src/shaders/composite.wgsl.js', 'utf8');

ok(index.includes('<option value="cosmicweb">Cosmic Web</option>'),
   'selector exposes Cosmic Web');
ok(index.includes("cosmicweb: ['Cosmic Web'"),
   'Shape Explorer has a Cosmic Web note');
ok(bg.includes('cosmicweb: 28'),
   'Cosmic Web has a stable id after the existing attractors');
ok(bg.includes('return id >= FRACTAL_IDS.attractor && id <= FRACTAL_IDS.rossler;'),
   'attractor routing excludes Cosmic Web');
ok(bg.includes('state.fractalType === FRACTAL_IDS.cosmicweb) return false;'),
   'animated Cosmic Web does not freeze into progressive accumulation');
ok(material.includes('fn cosmicWebSampleAt(') && material.includes('fn cosmicWebMaterial('),
   'material shader contains the hierarchical volume field');
ok(material.includes('return cosmicWebMaterial(ro, rd);'),
   'Cosmic Web routes through the volumetric material path');
ok(material.includes('u.fractalType > 24.5 && u.fractalType < 27.5'),
   'material attractor path remains limited to ids 25..27');
ok(composite.includes('u.fractalType > 24.5 && u.fractalType < 27.5'),
   'composite attractor reconstruction excludes Cosmic Web');
ok(material.includes('webFbm3') && material.includes('webFilament') && material.includes('voidGate'),
   'field contains fBm hierarchy, filament extraction, and void gating');
ok(material.includes('stepCount = max(28, min(stepCount, 88));'),
   'volume integration scales with the adaptive detail rung');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
