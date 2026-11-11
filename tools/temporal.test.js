// Temporal antialiasing of moving frames: the pure frame policy (src/temporal.js)
// and the pins that keep the shader, the uniform table and the renderer
// agreeing about the layout they share.
//
// The numeric parts run the real policy. The string assertions pin WGSL and
// renderer source; they do not execute it.
import fs from 'node:fs';
import {
  JITTER_COUNT, HISTORY_WEIGHT_MOVING, STILL_CAP, ACCUM_SEED_SAMPLES,
  temporalJitter, temporalAllowed, historyWeight, planTemporalFrame,
} from '../src/temporal.js';
import { TEMPORAL_WGSL } from '../src/shaders/temporal.wgsl.js';
import { COMPOSITE_WGSL, BLOOM_LEVELS } from '../src/shaders/composite.wgsl.js';
import { MATERIAL_WGSL } from '../src/shaders/material.wgsl.js';
import { ATTRACTOR_WGSL } from '../src/shaders/attractor.wgsl.js';

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}

console.log('\nJitter sequence');
const js = Array.from({ length: JITTER_COUNT }, (_, i) => temporalJitter(i));
ok(js.every(([x, y]) => Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5), 'offsets stay inside the pixel');
ok(new Set(js.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`)).size === JITTER_COUNT,
   'a full cycle never repeats a sample');
ok(Math.abs(js.reduce((a, [x]) => a + x, 0) / JITTER_COUNT) < 0.05
   && Math.abs(js.reduce((a, [, y]) => a + y, 0) / JITTER_COUNT) < 0.05,
   'a cycle is centred on the pixel, so jitter adds no net shift');
ok(JSON.stringify(temporalJitter(3)) === JSON.stringify(temporalJitter(3 + JITTER_COUNT)),
   'the sequence is periodic');
ok(temporalJitter(-1).every(Number.isFinite), 'a negative frame index is safe');
// Evenness, measured rather than assumed: Halton(2,3) windows of 4 can sit in
// two quadrants (the R2 sequence the accumulator uses does the same), but
// windows of 6 never fewer than three, and history averages over ~10 frames.
const quadrant = ([x, y]) => (x > 0 ? 1 : 0) + (y > 0 ? 2 : 0);
let minWindow6 = 9;
for (let st = 0; st < JITTER_COUNT; st++) {
  const quads = new Set();
  for (let k = 0; k < 6; k++) quads.add(quadrant(temporalJitter(st + k)));
  minWindow6 = Math.min(minWindow6, quads.size);
}
ok(minWindow6 >= 3, `any six consecutive frames cover at least three pixel quadrants (min ${minWindow6})`);
ok(new Set(js.map(quadrant)).size === 4, 'a full cycle covers all four quadrants');

console.log('\nHistory weight');
ok(historyWeight(false, 0) === 0, 'no history -> weight 0');
ok(historyWeight(false, 50) === 0, 'no history ignores stillness');
ok(historyWeight(true, 0) === HISTORY_WEIGHT_MOVING, 'moving with history -> the moving weight');
ok(Math.abs(historyWeight(true, 1) - 0.5) < 1e-9 && Math.abs(historyWeight(true, 3) - 0.75) < 1e-9,
   'still frames average exactly: weight n/(n+1)');
ok(historyWeight(true, 10 * STILL_CAP) === STILL_CAP / (STILL_CAP + 1), 'the still average is capped');

console.log('\ntemporalAllowed');
ok(temporalAllowed(true, 0.5) && temporalAllowed(true, 1.0), 'on at and below native resolution');
ok(!temporalAllowed(true, 1.25) && !temporalAllowed(true, 2.0), 'off on supersampled rungs');
ok(!temporalAllowed(false, 0.5), 'off when switched off');
ok(!temporalAllowed(true, NaN) && !temporalAllowed(true, undefined), 'non-finite scale is not allowed');

console.log('\nFrame planning');
const fresh = { historyValid: false, stillCount: 0, accumHeld: 0 };
const mv = (extra = {}) => ({ allowed: true, accumulating: false, accumSamples: 0, geometrySame: false, ...extra });

let p = planTemporalFrame(fresh, mv());
ok(p.mode === 'temporal' && p.weight === 0 && !p.seedAccum && !p.seedHistory,
   'first moving frame: temporal, but no history to blend yet');
ok(p.historyValid, 'and it leaves history valid for the next frame');

let s = { historyValid: p.historyValid, stillCount: p.stillCount, accumHeld: 0 };
p = planTemporalFrame(s, mv());
ok(p.mode === 'temporal' && p.weight === HISTORY_WEIGHT_MOVING, 'second moving frame blends at the moving weight');

p = planTemporalFrame(s, mv({ allowed: false }));
ok(p.mode === 'single' && p.weight === 0 && !p.historyValid,
   'temporal disallowed -> single sample, and any history is discarded');

// A still view with no looping animation: weights climb as an exact average.
s = { historyValid: true, stillCount: 0, accumHeld: 0 };
const weights = [];
for (let i = 0; i < 5; i++) {
  p = planTemporalFrame(s, mv({ geometrySame: true }));
  weights.push(+p.weight.toFixed(4));
  s = { historyValid: p.historyValid, stillCount: p.stillCount, accumHeld: 0 };
}
ok(weights.join() === [0.5, 0.6667, 0.75, 0.8, 0.8333].join(),
   `motionless frames average exactly (${weights.join(', ')})`);
p = planTemporalFrame({ historyValid: true, stillCount: 9, accumHeld: 0 }, mv({ geometrySame: false }));
ok(p.stillCount === 0 && p.weight === HISTORY_WEIGHT_MOVING, 'movement resets the still count and the weight');

// Hand-over to accumulation.
s = { historyValid: true, stillCount: 4, accumHeld: 0 };
p = planTemporalFrame(s, mv({ accumulating: true, accumSamples: 0, geometrySame: true }));
ok(p.mode === 'accumulate' && p.seedAccum && p.accumSamples === ACCUM_SEED_SAMPLES,
   'coming to rest seeds the accumulator from history');
ok(!p.historyValid, 'and history is dropped, since accumulation does not update it');
p = planTemporalFrame(s, mv({ accumulating: true, accumSamples: 0, geometrySame: false }));
ok(p.mode === 'accumulate' && !p.seedAccum && p.accumSamples === 0,
   'but not if the picture changed since: no seeding from a different image');
p = planTemporalFrame({ historyValid: false, stillCount: 0, accumHeld: 0 },
                      mv({ accumulating: true, accumSamples: 0, geometrySame: true }));
ok(!p.seedAccum && p.accumSamples === 0, 'and not without history');
p = planTemporalFrame(s, mv({ accumulating: true, accumSamples: 17, geometrySame: true }));
ok(!p.seedAccum && p.accumSamples === 17, 'a running accumulation is never reseeded');
p = planTemporalFrame(s, mv({ allowed: false, accumulating: true, accumSamples: 0, geometrySame: true }));
ok(p.mode === 'accumulate' && !p.seedAccum && p.accumSamples === 0,
   'with temporal filtering unavailable, accumulation starts from scratch as it always did');

// Hand-over back to motion.
p = planTemporalFrame({ historyValid: false, stillCount: 0, accumHeld: 96 }, mv());
ok(p.mode === 'temporal' && p.seedHistory && p.weight === HISTORY_WEIGHT_MOVING,
   'leaving a still view seeds history from the accumulated image');
p = planTemporalFrame({ historyValid: false, stillCount: 0, accumHeld: 0 }, mv());
ok(!p.seedHistory && p.weight === 0, 'but there is nothing to seed from after a lone sample');
p = planTemporalFrame({ historyValid: true, stillCount: 0, accumHeld: 96 }, mv());
ok(!p.seedHistory, 'and valid history is never overwritten');

console.log('\nLayout agreement (renderer <-> shaders)');
const bg = fs.readFileSync('src/fractal-bg.js', 'utf8');
const base = fs.readFileSync('src/shaders/fractal-base.wgsl.js', 'utf8');
const slot = (name) => Number(bg.match(new RegExp(`\\b${name}: (\\d+),`))[1]);
const fieldTail = `prevCamPos   : vec3<f32>,\n  historyWeight: f32,\n  prevCamTarget: vec3<f32>,\n  prevYaw      : f32,`;
for (const [name, src] of [['base', base], ['composite', COMPOSITE_WGSL], ['temporal', TEMPORAL_WGSL]]) {
  ok(src.includes(fieldTail) && /temporal     : vec4<f32>,/.test(src),
     `${name} shader declares the temporal uniform fields in the same order`);
}
ok(slot('prevCamPos') === 112 && slot('historyWeight') === 115 && slot('prevCamTarget') === 116
   && slot('prevYaw') === 119 && slot('temporal') === 120,
   'slots match the std140 offsets: vec3 on 16 bytes with a scalar in its pad');
ok(/UNIFORM_FLOATS = 124;/.test(bg) && 124 * 4 === 496, 'the buffer is 496 bytes');
ok(/shapeParams: 104,/.test(bg) && /prevCamPos: 112,/.test(bg), 'new fields follow shapeParams without moving it');
ok(TEMPORAL_WGSL.includes('struct Uniforms {'), 'temporal shader has the shared Uniforms struct');
ok(TEMPORAL_WGSL.split('struct Uniforms').length === 2, 'and only one copy of it');
const unifStruct = (src) => src.slice(src.indexOf('struct Uniforms {'), src.indexOf('\n};', src.indexOf('struct Uniforms {')));
ok(unifStruct(TEMPORAL_WGSL) === unifStruct(COMPOSITE_WGSL), 'it is the composite pass\'s struct, not a hand-kept copy');
ok(!TEMPORAL_WGSL.includes('`') && !COMPOSITE_WGSL.includes('`'), 'no backtick inside a WGSL payload');

console.log('\nTemporal pass structure');
ok(/fn fs_temporal\(/.test(TEMPORAL_WGSL), 'fs_temporal exists');
ok(/@binding\(5\) var histMaterial/.test(TEMPORAL_WGSL) && /@binding\(6\) var histAux/.test(TEMPORAL_WGSL),
   'history is bound as a separate texture pair');
ok(/clamp\(sampleCatmullRom\(histMaterial/.test(TEMPORAL_WGSL) && /clamp\(sampleCatmullRom\(histAux/.test(TEMPORAL_WGSL),
   'history is clamped to the current neighbourhood (rejection)');
ok(/hm\.x = clamp\(hm\.x \/ hm\.y, baseLo, baseHi\) \* hm\.y;/.test(TEMPORAL_WGSL),
   'the palette COORDINATE, not just the weighted sum, is range-clamped');
ok(/if \(abs\(yaw\) < 4\.0\)/.test(TEMPORAL_WGSL), 'reprojection reproduces the explorer yaw camera basis');
ok(/let focal = 1\.0 \/ tan\(u\.fov \* 0\.5\);/.test(TEMPORAL_WGSL), 'and the same focal length as the primary camera');
ok(/out\.pos = vec4<f32>\(xy, 0\.0, 1\.0\);/.test(TEMPORAL_WGSL), 'fullscreen triangle vertex stage');

console.log('\nRaymarch / material outputs');
ok(/@location\(2\) depth : vec4<f32>,/.test(MATERIAL_WGSL), 'material pass writes a third (depth) attachment');
ok(/out\.depth = vec4<f32>\(select\(tNear, t, hit\), 0\.0, 0\.0, 0\.0\);/.test(MATERIAL_WGSL),
   'hits report their distance and misses their closest approach');
ok(/fn hitEpsilon\(\)/.test(MATERIAL_WGSL) && /let hitEps = hitEpsilon\(\);/.test(MATERIAL_WGSL),
   'the surface march uses the pixel-footprint epsilon');
ok(/return max\(fixedEps, pixelAngle \* u\.temporal\.x\);/.test(MATERIAL_WGSL),
   'which is never finer than the fixed epsilon');
ok(/d\[U\.temporal\] = accNow \? 0 : MOVING_CONE_RADIUS;/.test(bg),
   'accumulating frames keep the fixed epsilon (cone radius 0)');
ok(/\{ format: DEPTH_FORMAT, writeMask: 0 \}/.test(bg), 'attractor lines mask the depth attachment off');
ok(/-u\.jitter\.x, u\.jitter\.y/.test(ATTRACTOR_WGSL), 'attractor lines take the same subpixel offset (y flipped for clip space)');

console.log('\nComposite / bloom');
ok(BLOOM_LEVELS === 5 && /const BLOOM_NORM : f32 = 0\.2000/.test(COMPOSITE_WGSL), 'bloom chain length and normalisation agree');
ok(/fn fs_bloom_prefilter/.test(COMPOSITE_WGSL) && /fn fs_bloom_down/.test(COMPOSITE_WGSL) && /fn fs_bloom_up/.test(COMPOSITE_WGSL),
   'bloom chain entry points exist');
ok(!/fs_bloom_h|fs_bloom_v/.test(COMPOSITE_WGSL + bg), 'the old two-pass blur is gone from shader and renderer');
ok(/sceneMax \* 2\.5/.test(COMPOSITE_WGSL), 'transparent coverage uses the brightest channel');
ok(/const GLOW_TINT : f32 = 0\.18;/.test(COMPOSITE_WGSL), 'glow veil strength is a named constant');
ok(!COMPOSITE_WGSL.includes('@binding(5)'), 'composite still gains no binding (see moving-aa.test.js)');
ok(/if \(sharpen > 0\.001\)/.test(COMPOSITE_WGSL), 'sharpening is gated off for accumulated frames');
ok(/if \(temporalFrame && plan\.weight > 0\) d\[U\.edgeAAGain\] = 0\.0;/.test(bg),
   'the moving-edge filter stands down once a frame has temporal history');

console.log('\nRenderer plumbing');
ok(/canvasView = state\.context\.getCurrentTexture\(\)\.createView\(\);[\s\S]*?updateUniforms\(nowMs\);/.test(bg),
   'the swapchain is acquired before temporal state is planned, so a skipped frame cannot desync it');
ok(/destroyTargets\(\);\s*\n\s*state\.trajBuffer/.test(bg), 'destroy() releases every target through destroyTargets()');
ok(!/accumA|accumB|bloomAView|bloomBView/.test(bg), 'no references to the removed accumulation/bloom targets remain');
ok(/history\.length === 2/.test(bg) && /if \(temporalAllowed\(state\.taaOn, state\.qualityScale\)\) \{/.test(bg),
   'history textures exist only where temporal filtering is in use');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
