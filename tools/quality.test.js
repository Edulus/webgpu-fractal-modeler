// Adaptive-quality governor. Run: node tools/quality.test.js
//
// The governor is the one piece of the renderer whose behaviour cannot be seen
// in this environment at all -- there is no GPU here, so there are no real
// frame times. It is written as a pure function of the samples handed to it
// precisely so that it can be driven with SYNTHETIC frame times instead, and
// every claim made for it checked as arithmetic.
//
// The device models below are the point of the file: a phone that stalls above
// a low rung, a laptop that sits mid-ladder, a workstation that can hold the
// top, and a scene that becomes expensive part-way through. Each is a cost
// model in milliseconds per frame as a function of the rung, and the governor
// is run against it for thousands of frames to see where it settles.

import {
  LADDER, TOP, BUDGET_MS, PRESET_RUNG,
  govInit, govSample, rung, clampIndex, showcaseIndex, accumTarget,
} from '../src/quality.js';

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else { failed++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
};

// ---- the ladder ------------------------------------------------------------
check('the ladder is ordered by resolution',
      LADDER.every((r, i) => i === 0 || r.scale > LADDER[i - 1].scale));
check('and by march steps', LADDER.every((r, i) => i === 0 || r.steps >= LADDER[i - 1].steps));
check('and by iteration depth', LADDER.every((r, i) => i === 0 || r.iters >= LADDER[i - 1].iters));
check('it still contains the old fixed ceiling (1.0 / 160 / 12)',
      LADDER.some((r) => r.scale === 1.0 && r.steps === 160 && r.iters === 12));
check('and reaches beyond it, which is the point',
      LADDER[TOP].scale > 1.0 && LADDER[TOP].steps > 160 && LADDER[TOP].iters > 12);
check('every named preset maps to a real rung',
      Object.values(PRESET_RUNG).every((i) => i >= 0 && i <= TOP));
check('clampIndex keeps the rung in range',
      clampIndex(-5) === 0 && clampIndex(999) === TOP && clampIndex(2.4) === 2);

// ---- device models ---------------------------------------------------------
// Cost in ms for a rung: area dominates, steps and iterations add on top.
const device = (msAtUnitScale) => (i) => {
  const r = LADDER[i];
  return msAtUnitScale * (r.scale * r.scale) * (0.55 + 0.3 * (r.steps / 160)
    + 0.15 * (r.iters / 12));
};

function settle(costOf, frames = 6000, gov = govInit(3)) {
  let g = gov;
  const seen = [];
  for (let f = 0; f < frames; f++) {
    g = govSample(g, costOf(g.index));
    seen.push(g.index);
  }
  return { g, seen };
}

const PHONE = device(46);        // ~46ms at scale 1.0: only low rungs are viable
const LAPTOP = device(14);
const WORKSTATION = device(2.2);

for (const [name, cost, wantLo, wantHi] of [
  ['a phone', PHONE, 0, 2],
  ['a laptop', LAPTOP, 2, 6],
  ['a workstation', WORKSTATION, 7, TOP],
]) {
  const { g } = settle(cost);
  const ms = cost(g.index);
  check(`${name} settles in a sensible band`, g.index >= wantLo && g.index <= wantHi,
        `settled at rung ${g.index} (${ms.toFixed(1)}ms, scale ${rung(g.index).scale})`);
  check(`${name} settles inside its frame budget`, ms <= BUDGET_MS * 1.15,
        `${ms.toFixed(1)}ms against ${BUDGET_MS}ms`);
}

// The whole reason for the change: a strong device must be allowed past the
// old ceiling of 1.0 rather than idling there.
{
  const { g } = settle(WORKSTATION);
  check('a workstation supersamples beyond the old 1.0 ceiling',
        rung(g.index).scale > 1.0, `scale ${rung(g.index).scale}`);
}

// ---- stability -------------------------------------------------------------
// Oscillation is the classic failure of a controller like this: climb, stall,
// drop, climb again, forever. Count how often the rung changes once settled.
for (const [name, cost] of [['phone', PHONE], ['laptop', LAPTOP], ['workstation', WORKSTATION]]) {
  const { seen } = settle(cost, 9000);
  const tail = seen.slice(4000);
  let flips = 0;
  for (let i = 1; i < tail.length; i++) if (tail[i] !== tail[i - 1]) flips++;
  check(`${name} does not oscillate once settled`, flips <= 2,
        `${flips} rung changes over the last ${tail.length} frames`);
}

// ---- reacting to a scene that gets expensive -------------------------------
{
  // Settle on a cheap scene, then make every rung four times dearer, as zooming
  // into an expensive region would.
  let { g } = settle(LAPTOP, 4000);
  const before = g.index;
  const dear = (i) => LAPTOP(i) * 4;
  for (let f = 0; f < 1500; f++) g = govSample(g, dear(g.index));
  check('it backs down when the scene becomes expensive', g.index < before,
        `${before} -> ${g.index}`);
  check('and lands inside budget again', dear(g.index) <= BUDGET_MS * 1.2,
        `${dear(g.index).toFixed(1)}ms`);
}

// A single catastrophic frame is acted on at once, not after the hysteresis.
{
  let g = govInit(6);
  g = govSample(g, BUDGET_MS * 5);
  check('one stalled frame drops the rung immediately', g.index < 6, `now ${g.index}`);
  check('and records a ceiling below where it stalled', g.ceiling <= 5, `ceiling ${g.ceiling}`);
}

// After dropping, it must not climb straight back into the same stall.
{
  const cliff = (i) => (i >= 5 ? 40 : 8);      // rung 5 and above stalls
  let g = govInit(3);
  let entries = 0;
  for (let f = 0; f < 8000; f++) {
    g = govSample(g, cliff(g.index));
    if (g.index >= 5) entries++;
  }
  check('a known-bad rung is not re-entered repeatedly', entries < 200,
        `${entries} frames spent at or above the bad rung`);
  check('and it settles just below it', g.index === 4, `settled at ${g.index}`);
}

// ---- converged frames must not be evidence ---------------------------------
{
  // A converged frame costs almost nothing because the raymarch is skipped.
  // Feeding those in would look like limitless headroom.
  let honest = govInit(3);
  let fooled = govInit(3);
  for (let f = 0; f < 4000; f++) {
    honest = govSample(honest, PHONE(honest.index));
    fooled = govSample(fooled, f % 2 === 0 ? PHONE(fooled.index) : 0.4);
  }
  check('cheap frames WOULD mislead the governor if fed in',
        fooled.index > honest.index,
        `honest ${honest.index}, fooled ${fooled.index}`);
  check('...so the honest run stays inside budget', PHONE(honest.index) <= BUDGET_MS * 1.15);
}

// ---- robustness ------------------------------------------------------------
{
  let g = govInit(5);
  const before = g.index;
  g = govSample(g, 0);
  g = govSample(g, -3);
  g = govSample(g, NaN);
  g = govSample(g, Infinity);
  check('rubbish samples are ignored rather than acted on', g.index === before);

  // A multi-second pause (tab hidden, GC) must not dominate the average.
  let h = govInit(5);
  for (let f = 0; f < 200; f++) h = govSample(h, 9.0);
  const calm = h.emaMs;
  h = govSample(h, 4000);
  check('a huge pause is clamped, not allowed to poison the average',
        h.emaMs < calm + BUDGET_MS * 8, `ema went ${calm.toFixed(1)} -> ${h.emaMs.toFixed(1)}`);
}

// ---- showcase --------------------------------------------------------------
{
  // A still frame has no smoothness to protect, so it may go higher than the
  // interactive rung -- but not without limit.
  const g = { ...govInit(3), emaMs: 12 };
  const s = showcaseIndex(g, 220);
  check('a still view climbs above the interactive rung', s > g.index, `${g.index} -> ${s}`);
  check('and stays on the ladder', s <= TOP);

  const slow = { ...govInit(3), emaMs: 200 };
  check('a device already struggling is not pushed further when still',
        showcaseIndex(slow, 220) <= slow.index + 1);

  const top = { ...govInit(TOP), emaMs: 8 };
  check('the top rung cannot be exceeded', showcaseIndex(top, 5000) === TOP);
}

check('accumulation targets rise with the rung',
      accumTarget(TOP) > accumTarget(0), `${accumTarget(0)} -> ${accumTarget(TOP)}`);

console.log(`\n${passed} passed, ${failed} failed`);
{
  const rows = [['phone', PHONE], ['laptop', LAPTOP], ['workstation', WORKSTATION]];
  const out = rows.map(([n, c]) => {
    const { g } = settle(c);
    return `${n} -> rung ${g.index} (scale ${rung(g.index).scale}, ${rung(g.index).steps} steps, ${c(g.index).toFixed(1)}ms)`;
  });
  console.log('(' + out.join('; ') + ')');
}
process.exit(failed ? 1 : 0);
