// Material pass: the fragment entry point that actually draws surfaces.
//
// fs_material was forked from fs_main and is the one the renderer runs, so
// anything the quality ladder promises has to be honoured HERE. These are
// string assertions over the assembled WGSL: they pin the shader, they do not
// execute it.
import { MATERIAL_WGSL } from '../src/shaders/material.wgsl.js';

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

console.log('\nMaterial pass honours the quality rung');
const start = MATERIAL_WGSL.indexOf('fn fs_material(');
ok(start > 0, 'fs_material is present in the assembled material shader');
const body = MATERIAL_WGSL.slice(start);

// The ladder's march-step column reaches WGSL as u.detail.x. The loop bound
// MAX_STEPS is only the compile-time ceiling; without the live break every
// rung marches to that ceiling and a low rung is no cheaper per ray.
ok(/let maxSteps = i32\(u\.detail\.x\);/.test(body),
   'fs_material reads the live march-step ceiling from u.detail.x');
ok(/for \(var i = 0; i < MAX_STEPS; i = i \+ 1\) \{\s*if \(i >= maxSteps\) \{ break; \}/.test(body),
   'the surface march breaks at the live ceiling on its first statement');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
