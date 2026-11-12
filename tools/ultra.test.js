// The 'ultra' quality tier: High's rung at up to 3x device pixel ratio.
import fs from 'node:fs';
import {
  PRESET_RUNG, LADDER, DPR_CAP, DPR_CAP_ULTRA, dprCapFor, planMode, maxRungForLimit,
} from '../src/quality.js';
import { buildDiagnosticsSnapshot } from '../src/diagnostics.js';

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}

console.log('\nPreset');
ok(PRESET_RUNG.ultra === PRESET_RUNG.high, 'ultra uses the same rung as high');
ok(LADDER[PRESET_RUNG.ultra].scale === 1, 'that rung renders at 1:1 with the canvas');
const plan = planMode('ultra', 3);
ok(plan.rung === PRESET_RUNG.high && plan.gov === null, 'ultra is a fixed mode: no governor');
ok(planMode('high', 3).gov === null && planMode('auto', 3).gov !== null, 'the other modes are unchanged');

console.log('\nPixel-density cap');
ok(DPR_CAP === 2 && DPR_CAP_ULTRA === 3, 'caps are 2 normally and 3 for ultra');
ok(dprCapFor('ultra') === 3, 'ultra lifts the cap');
for (const m of ['low', 'medium', 'high', 'auto', 'max', 'screenshot', undefined, 'nonsense']) {
  ok(dprCapFor(m) === 2, `${String(m)} keeps the cap at 2`);
}

console.log('\nTexture limits still bind at 3x');
// A 2560x1440 CSS display at 3x asks for 7680x4320. With an 8192 limit the
// swapchain fits as is and rung 5 (scale 1.0) is allocatable.
ok(maxRungForLimit(7680, 4320, 8192) >= PRESET_RUNG.ultra, 'a 3x 1440p canvas can hold the ultra rung under an 8192 limit');
// With a 4096 limit the same request must be capped below rung 5 -- the cap,
// not the preset, decides what is allocated.
ok(maxRungForLimit(7680, 4320, 4096) < PRESET_RUNG.ultra, 'under a 4096 limit the rung cap overrides the preset');

console.log('\nRenderer wiring');
const bg = fs.readFileSync('src/fractal-bg.js', 'utf8');
ok(/const dprCap = dprCapFor\(state\.qualityMode\);/.test(bg), 'resize() takes its cap from dprCapFor(mode)');
ok(!/const dprCap = 2;/.test(bg), 'no hard-coded cap remains');
ok(/dpr: \+state\.dpr\.toFixed\(3\),/.test(bg), 'handle.info reports the pixel ratio actually in use');
const setQ = bg.slice(bg.indexOf('    setQuality(mode) {'), bg.indexOf('    },', bg.indexOf('    setQuality(mode) {')));
ok(/resize\(\);/.test(setQ), 'setQuality() resizes, so switching to or from ultra changes the backing store');

console.log('\nDemo page');
const html = fs.readFileSync('index.html', 'utf8');
const sel = html.match(/<select id="sel-quality"[^>]*>([\s\S]*?)<\/select>/)[1];
const order = [...sel.matchAll(/value="(\w+)"/g)].map((m) => m[1]);
ok(order.join() === 'low,medium,high,ultra,auto,max', `selector order is low,medium,high,ultra,auto,max (${order.join()})`);
ok(/i\.qualityMode === 'ultra' \? ` @\$\{i\.dpr\}x` : ''/.test(html), 'the HUD shows the density in ultra, which otherwise reads like high');

console.log('\nDiagnostics');
const snap = buildDiagnosticsSnapshot({
  info: { qualityMode: 'ultra', qualityScale: 1, dpr: 3, rung: 5, fractalType: 0, samples: 0 },
  canvas: { width: 1200, height: 780, getBoundingClientRect: () => ({ width: 400, height: 260 }) },
  devicePixelRatio: 3,
});
ok(snap.dimensions.dpr === 3, 'the report shows the ultra pixel ratio, not an assumed cap of 2');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
