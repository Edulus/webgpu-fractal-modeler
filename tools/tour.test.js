// Boot tour sequencing.
//
// The tour fills the renderer's start-up, so its whole job is timing against an
// event whose duration is not knowable in advance -- measured cold start here is
// ~640ms, but a cold shader cache on real hardware is seconds. The two rules
// that keep it from misbehaving at either end are that a step is never cut off
// part-way and that a fast start still gets a minimum number of steps, and both
// are easy to break by adjusting a constant. So they are pinned here.

import fs from 'node:fs';
import {
  TOUR_STEPS, STEP_MS, MIN_STEPS, BOOT_PHASES,
  tourStepAt, tourEndsAt, tourStateAt, bootPhaseAt,
} from '../src/tour.js';

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

console.log('\nBoot tour: steps, sequencing and the two timing rules');

// ---- The step list ---------------------------------------------------------
const N = TOUR_STEPS.length;
ok(N >= 3, `there is a tour to run (${N} steps)`);
ok(
  TOUR_STEPS.every((s) => s.target && s.title && s.body),
  'every step names a target and carries a title and a body',
);
ok(
  new Set(TOUR_STEPS.map((s) => s.target)).size === N,
  'no control is pointed at twice',
);

// Every step must point at something that actually exists in the page, or the
// tour silently skips it -- the highlight simply never appears and there is no
// error anywhere. This is the same class of rot registry.test.js guards.
const index = fs.readFileSync('index.html', 'utf8');
const missing = TOUR_STEPS
  .map((s) => s.target)
  .filter((t) => !index.includes(`id="${t.replace(/^#/, '')}"`));
ok(missing.length === 0, `every step targets an element that exists${missing.length ? `: missing ${missing}` : ''}`);

// The tour is read while waiting, so the text has to be short enough to finish
// inside one step. ~200 characters is comfortably under 2.2s of reading.
const tooLong = TOUR_STEPS.filter((s) => s.body.length > 200).map((s) => s.title);
ok(tooLong.length === 0, `no step outruns its own time on screen${tooLong.length ? `: ${tooLong}` : ''}`);

// ---- Which step is showing -------------------------------------------------
ok(tourStepAt(0, N) === 0, 'the first step is up immediately');
ok(tourStepAt(STEP_MS - 1, N) === 0, 'a step holds for its whole duration');
ok(tourStepAt(STEP_MS, N) === 1, 'the next step takes over exactly on the boundary');
ok(tourStepAt(STEP_MS * 2.5, N) === 2, 'mid-step resolves to that step');

// Holding rather than cycling. A slow start should look like progress, not like
// the lesson stuttering back to the beginning.
ok(tourStepAt(STEP_MS * N, N) === N - 1, 'the last step holds once the sequence runs out');
ok(tourStepAt(STEP_MS * 1000, N) === N - 1, 'and keeps holding however long the start takes');

// Degenerate inputs: a tour of nothing, and a clock that has misbehaved.
ok(tourStepAt(0, 0) === -1, 'an empty tour shows nothing');
ok(tourStepAt(-50, N) === 0, 'a negative elapsed time clamps to the first step');
ok(tourStepAt(NaN, N) === 0, 'a NaN clock clamps to the first step rather than vanishing');

// ---- When the tour comes down ----------------------------------------------
// The floor is the whole sequence, so for any start quicker than the tour the
// floor is what decides the end -- which on real hardware is every start.
ok(MIN_STEPS === N, 'the floor is the whole sequence, so every step gets played');
ok(tourEndsAt(1, N) === N * STEP_MS, 'an instant start still plays all seven steps');

// Rule 1 -- readiness never cuts a step off part-way -- is therefore only
// reachable by a start SLOWER than the whole tour. Tested past the floor, where
// it is the rule actually doing the work.
const past = N * STEP_MS;
ok(
  tourEndsAt(past + 1, N) === past + STEP_MS,
  'readiness one millisecond past the sequence still lets that step finish',
);
ok(
  tourEndsAt(past, N) === past,
  'readiness exactly on a boundary does not buy an extra step',
);
ok(
  tourEndsAt(past + STEP_MS * 3 + 5, N) === past + STEP_MS * 4,
  'a start well past the sequence rounds up to its own step boundary',
);

// Rule 2: the floor. This is what a fast machine actually hits.
ok(tourEndsAt(0, N) === MIN_STEPS * STEP_MS, 'ready before the first frame still plays the minimum');
ok(tourEndsAt(640, N) === MIN_STEPS * STEP_MS, 'the measured ~640ms cold start plays the minimum, not one flash');
ok(tourEndsAt(-5, N) === MIN_STEPS * STEP_MS, 'a nonsense negative readiness cannot end the tour early');

// A slow start holds the tour open indefinitely; that is what keeps the last
// step on screen while the shaders compile.
ok(tourEndsAt(null, N) === Infinity, 'not ready yet means no end time');
ok(tourEndsAt(undefined, N) === Infinity, 'an absent readiness is treated as not ready');

// The floor can never demand more steps than exist.
ok(tourEndsAt(0, 1, STEP_MS, 5) === STEP_MS, 'the minimum cannot exceed the number of steps');

// ---- The combined state ----------------------------------------------------
const early = tourStateAt({ elapsedMs: 100, readyMs: null });
ok(!early.done && early.index === 0, 'still starting: first step showing');

const held = tourStateAt({ elapsedMs: STEP_MS * 50, readyMs: null });
ok(!held.done && held.index === N - 1, 'a long start holds on the last step rather than finishing');

const fast = tourStateAt({ elapsedMs: STEP_MS * MIN_STEPS, readyMs: 300 });
ok(fast.done, 'a fast start ends the tour once the minimum has played');

const midStep = tourStateAt({ elapsedMs: STEP_MS * MIN_STEPS - 1, readyMs: 300 });
ok(!midStep.done, 'and not one millisecond before');

// Skipping is immediate and beats both rules -- someone dismissing the tour is
// not asking to see the rest of the current step.
const skipped = tourStateAt({ elapsedMs: 10, readyMs: null, dismissed: true });
ok(skipped.done && skipped.index === -1, 'dismissing ends the tour at once');

// The tour must never outlive a start it was filling by more than one step.
for (const ready of [0, 200, 640, 1500, 5000, 12000]) {
  const end = tourEndsAt(ready, N);
  const overrun = end - Math.max(ready, MIN_STEPS * STEP_MS);
  ok(
    overrun < STEP_MS,
    `a ${ready}ms start is followed by under one step of tour (${Math.round(overrun)}ms)`,
  );
}

// ---- Boot phase text -------------------------------------------------------
ok(bootPhaseAt(0) === BOOT_PHASES[0].text, 'the first phase is up from the start');
ok(bootPhaseAt(500) === BOOT_PHASES[0].text, 'and holds until the next threshold');
ok(bootPhaseAt(BOOT_PHASES[1].at) === BOOT_PHASES[1].text, 'the next phase takes over on its threshold');
ok(bootPhaseAt(1e9) === BOOT_PHASES[BOOT_PHASES.length - 1].text, 'a very slow start lands on the last phase');
ok(bootPhaseAt(NaN) === BOOT_PHASES[0].text, 'a NaN clock still reads as the first phase');
ok(
  BOOT_PHASES.every((p, i) => i === 0 || p.at > BOOT_PHASES[i - 1].at),
  'phase thresholds are strictly increasing, so each one is reachable',
);
ok(BOOT_PHASES[0].at === 0, 'there is always something to say at t=0');

// A step has to be long enough to read a sentence and look at what is being
// pointed at. 2200ms was reported as too quick, so the floor is set above it --
// a future tidy-up that quietly restores the old value fails here rather than
// silently making the tour unreadable again.
ok(STEP_MS >= 4000, `a step is long enough to read (${STEP_MS}ms)`);
ok(TOUR_STEPS.length * STEP_MS > 30000,
  `the whole tour outlasts a fast start by design (${(TOUR_STEPS.length * STEP_MS / 1000).toFixed(1)}s)`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
