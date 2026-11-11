// Clearance probe readback. The bug this pins: buffers recreated mid-flight, a
// late readback clearing the NEW probe's busy flag, and the next probe copying
// into a staging buffer that was still waiting to be mapped.
//
// The behavioural half drives startProbeReadback() with fake buffers whose maps
// the test completes by hand, so the interleavings are exact rather than racy.
// The string half pins the renderer wiring that makes the interleaving
// impossible in the first place; it does not execute it.
import fs from 'node:fs';
import { startProbeReadback } from '../src/probe.js';

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}

// A staging buffer whose mapAsync settles only when the test says so. It also
// enforces WebGPU's rule: a second map while one is pending is an error, and so
// is reading a range of a buffer that is not mapped.
function fakeStaging(values = [1.5, 2.5]) {
  const b = {
    mapped: false, pendingMap: false, unmaps: 0, values,
    mapAsync() {
      if (b.pendingMap || b.mapped) return Promise.reject(new Error('already has an outstanding map'));
      b.pendingMap = true;
      return new Promise((res, rej) => { b._res = res; b._rej = rej; });
    },
    getMappedRange() {
      if (!b.mapped) throw new Error('getMappedRange failed: not mapped');
      return new Float32Array(b.values).buffer;
    },
    unmap() { b.mapped = false; b.unmaps++; },
    finish() { b.pendingMap = false; b.mapped = true; b._res(); },
    abort() { b.pendingMap = false; b._rej(new Error('aborted')); },
  };
  return b;
}
const makeProbe = (values) => ({ staging: fakeStaging(values), busy: false });
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log('\nOrdinary readback');
{
  const probe = makeProbe([0.75, 3]);
  let reading = null;
  const p = startProbeReadback(probe, () => true, (d, h) => { reading = [d, h]; }, 1);
  ok(probe.busy, 'busy while the map is pending');
  probe.staging.finish();
  await p;
  ok(!probe.busy, 'free once the readback completes');
  ok(reading && reading[0] === 0.75 && reading[1] === 3, 'the reading is published');
  ok(probe.staging.unmaps === 1 && !probe.staging.mapped, 'the buffer is unmapped again, ready for the next copy');
}

console.log('\nAn aborted map');
{
  const probe = makeProbe();
  let published = false;
  const p = startProbeReadback(probe, () => true, () => { published = true; }, 1);
  probe.staging.abort();
  await p;
  ok(!probe.busy && !published, 'the probe is freed and nothing is published');
}

console.log('\nThe race: a readback outlives the probe it started on');
{
  // Probe A starts a readback. The renderer replaces it with probe B (this is
  // what a resize used to do), and B starts its own readback. Then A's map
  // finishes late.
  const state = { probe: makeProbe([1, 1]) };
  const A = state.probe;
  const readings = [];
  const pA = startProbeReadback(A, () => A === state.probe, (d, h) => readings.push(['A', d, h]), 1);

  state.probe = makeProbe([9, 9]);
  const B = state.probe;
  const pB = startProbeReadback(B, () => B === state.probe, (d, h) => readings.push(['B', d, h]), 1);
  ok(B.busy && B.staging.pendingMap, 'B has its own readback in flight');

  A.staging.finish();
  await pA;
  ok(B.busy, "A finishing does not clear B's busy flag");
  ok(B.staging.pendingMap, "and does not touch B's buffer");
  ok(!readings.some(([who]) => who === 'A'), "a stale probe's reading is not published");
  ok(!A.busy, 'A itself is freed');

  // The gate the renderer uses must still say "not yet" for B.
  const wouldProbeAgain = !state.probe.busy;
  ok(!wouldProbeAgain, 'so the renderer does not start another probe into a pending buffer');

  B.staging.finish();
  await pB;
  ok(!B.busy && readings.length === 1 && readings[0][0] === 'B' && readings[0][1] === 9,
     "B's own reading is published when it completes");
}

console.log('\nBack-to-back probes on one buffer');
{
  const probe = makeProbe([4, 5]);
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const p = startProbeReadback(probe, () => true, (d) => seen.push(d), 1);
    ok(probe.busy, `probe ${i + 1}: gate closed while pending`);
    probe.staging.finish();
    await p;
  }
  ok(seen.length === 5 && !probe.busy, 'five sequential readbacks all complete cleanly');
  await tick();
}

console.log('\nRenderer wiring');
const bg = fs.readFileSync('src/fractal-bg.js', 'utf8');
const createTargets = bg.slice(bg.indexOf('  function createTargets('), bg.indexOf('  // ---- Strange attractors'));
ok(createTargets.length > 500, 'located createTargets()');
ok(!/clearance-probe|probeStaging|probe\.staging|createBuffer/.test(createTargets.replace(/\/\/.*$/gm, '')),
   'createTargets() allocates no probe buffers: it runs on every resize and rung change');
ok(/function createStaticResources\(\)[\s\S]*?label: 'clearance-probe-staging'/.test(bg),
   'the probe buffers are created once per device, in createStaticResources()');
ok(/label: 'clearance-probe-storage'/.test(bg) && /label: 'clearance-probe-staging'/.test(bg),
   'both are labelled, so a validation error names the buffer');
ok(/startProbeReadback\(probe, \(\) => probe === state\.probe/.test(bg),
   'the readback is handed its own probe and checks it is still current');
ok(!/state\.probeBusy|state\.probeStaging|state\.probeBuffer/.test(bg),
   'no state-level probe fields remain for a late callback to reach');
ok(/state\.probe && !state\.probe\.busy && probeDue/.test(bg), 'the probe gate reads the live probe object');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
