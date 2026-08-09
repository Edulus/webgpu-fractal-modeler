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
  govInit, govSample, rung, clampIndex, showcaseIndex, accumTarget, planMode,
  MAX_BUDGET_FACTOR,
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
const work = (msAtUnitScale) => (i) => {
  const r = LADDER[i];
  return msAtUnitScale * (r.scale * r.scale) * (0.55 + 0.3 * (r.steps / 160)
    + 0.15 * (r.iters / 12));
};

// What a display actually REPORTS. requestAnimationFrame is vsync-locked, so
// frame time is quantised to whole refresh periods: work of 1ms and work of
// 16ms are both reported as 16.7ms at 60Hz. Every device below is presented
// this way, because that is the only signal the real governor will ever see.
const REFRESH = 1000 / 60;
const present = (ms) => Math.ceil(ms / REFRESH) * REFRESH;
const device = (msAtUnitScale) => {
  const w = work(msAtUnitScale);
  const f = (i) => present(w(i));
  f.work = w;
  return f;
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
  const ms = cost.work ? cost.work(g.index) : cost(g.index);
  check(`${name} settles in a sensible band`, g.index >= wantLo && g.index <= wantHi,
        `settled at rung ${g.index} (${ms.toFixed(1)}ms of work, scale ${rung(g.index).scale})`);
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
// The governor re-probes its ceiling on purpose, so that a view which has become
// cheaper can be explored again. The property that matters is not "never
// changes" but that probing gets RARER: each failure at the same rung doubles
// the wait. Measure the first third of a long run against the last.
for (const [name, cost] of [['phone', PHONE], ['laptop', LAPTOP], ['workstation', WORKSTATION]]) {
  const { seen } = settle(cost, 30000);
  const third = Math.floor(seen.length / 3);
  const count = (from, to) => {
    let n = 0;
    for (let i = from + 1; i < to; i++) if (seen[i] !== seen[i - 1]) n++;
    return n;
  };
  const early = count(0, third);
  const late = count(seen.length - third, seen.length);
  check(`${name} settles rather than oscillating`, late <= 2,
        `${late} rung changes in the last ${third} frames (${early} in the first)`);
  check(`${name} probes less often as it goes`, late <= early,
        `early ${early}, late ${late}`);
}

// ---- reacting to a scene that gets expensive -------------------------------
{
  // Settle on a cheap scene, then make every rung four times dearer, as zooming
  // into an expensive region would.
  let { g } = settle(LAPTOP, 4000);
  const before = g.index;
  const dear = (i) => present(LAPTOP.work(i) * 4);
  for (let f = 0; f < 1500; f++) g = govSample(g, dear(g.index));
  check('it backs down when the scene becomes expensive', g.index < before,
        `${before} -> ${g.index}`);
  check('and lands inside budget again', LAPTOP.work(g.index) * 4 <= BUDGET_MS * 1.2,
        `${(LAPTOP.work(g.index) * 4).toFixed(1)}ms of work`);
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
  // A converged frame skips the raymarch, so it always presents on time. Under
  // a MISS-RATE signal that does not invent headroom the way a mean would --
  // but it does DILUTE evidence of overload, which is the real hazard: half the
  // frames arriving on time can hold the miss rate under the drop threshold
  // while the interactive ones are all late. Here every interactive frame at
  // rung 3 and above misses, and the diluted run fails to notice.
  // The dilution that matters is the realistic one. While the accumulator is
  // running MOST frames are converged, so a one-in-ten mixture is the honest
  // model -- and at that ratio nine on-time frames hold the miss rate below the
  // threshold while every interactive frame is late.
  const cliff = (i) => (i >= 3 ? REFRESH * 2 : REFRESH);
  let honest = govInit(5);
  let half = govInit(5);
  let mostly = govInit(5);
  for (let f = 0; f < 6000; f++) {
    honest = govSample(honest, cliff(honest.index));
    half = govSample(half, f % 2 === 0 ? cliff(half.index) : REFRESH);
    mostly = govSample(mostly, f % 10 === 0 ? cliff(mostly.index) : REFRESH);
  }
  check('the honest run finds the sustainable rung', honest.index <= 2,
        `settled at ${honest.index}`);
  // Worth recording: at 50/50 the miss-rate rule is NOT fooled, where the mean
  // rule this replaced would have been. It takes a realistic dilution to break.
  check('a half-and-half mixture is still caught', half.index <= 2,
        `settled at ${half.index}`);
  check('but converged frames DO hide the overload at a realistic ratio',
        mostly.index > honest.index,
        `honest ${honest.index}, nine-in-ten converged ${mostly.index}`);
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

// ---- vsync: the signal the governor will actually be given ------------------
// This is the scenario that condemned the first version of this governor. With
// timing quantised to the refresh, a mean-frame-time rule can never observe
// headroom: every frame that meets the budget reports 16.7ms whether the work
// took 1ms or 16ms. A rule needing a mean below 12ms therefore never fires.
{
  const raw = (i) => WORKSTATION.work(i);          // continuous, unrealistic
  let a = govInit(3), b = govInit(3);
  for (let f = 0; f < 6000; f++) {
    a = govSample(a, raw(a.index));
    b = govSample(b, WORKSTATION(b.index));        // vsync-locked, realistic
  }
  check('a strong device climbs under vsync-locked timing, not just continuous',
        b.index === a.index && b.index >= 7,
        `continuous ${a.index}, vsync ${b.index}`);
  check('and is genuinely using its headroom',
        WORKSTATION.work(b.index) > 8, `${WORKSTATION.work(b.index).toFixed(1)}ms of work`);
}

// A frame that misses presentation reports double, so a device sitting exactly
// on the boundary alternates 16.7 / 33.3. That must not become rung chatter.
{
  let g = govInit(4);
  let flips = 0, last = g.index;
  for (let f = 0; f < 6000; f++) {
    // one frame in thirty misses: jitter, not overload. (One in six would be a
    // sustained 50fps, which the governor is right to treat as too expensive.)
    g = govSample(g, f % 30 === 0 ? REFRESH * 2 : REFRESH);
    if (g.index !== last) { flips++; last = g.index; }
  }
  check('occasional missed vsyncs do not cause rung chatter', flips <= 2,
        `${flips} rung changes over 6000 frames`);
}

// ---- thermal throttling -----------------------------------------------------
// A rung that is comfortable for thirty seconds can become too expensive once
// the device is hot. The governor should back down and STAY down while it is
// throttled, rather than probing the stall every time its ceiling resets.
{
  const hot = (i, tMs) => {
    const factor = 1 + 0.9 * Math.min(1, Math.max(0, (tMs - 30000) / 60000));
    return present(LAPTOP.work(i) * factor);
  };
  let g = govInit(3);
  let tMs = 0, settledCool = -1, changesWhileHot = 0, last = -1;
  for (let f = 0; f < 40000; f++) {
    const dt = hot(g.index, tMs);
    tMs += dt;
    g = govSample(g, dt);
    if (tMs < 30000) settledCool = g.index;
    else {
      if (last >= 0 && g.index !== last) changesWhileHot++;
      last = g.index;
    }
  }
  check('a throttling device backs down', g.index < settledCool,
        `cool rung ${settledCool} -> hot rung ${g.index}`);
  // It should keep re-checking occasionally -- the device may cool down -- but
  // rarely. Over roughly twenty simulated minutes of throttling this is about
  // one re-probe every hundred seconds, against sixty before the backoff was
  // fixed.
  check('and probes the stall rarely rather than constantly', changesWhileHot <= 16,
        `${changesWhileHot} rung changes over ${Math.round(tMs / 1000)}s while hot`);
  check('the retry backoff grew, which is what stops the probing',
        g.resetMs > 20000, `resetMs ${Math.round(g.resetMs)}`);
}

// ---- one decision, however you arrive at it ---------------------------------
// The constructor and the selector used to decide this separately, and the
// constructor only recognised 'auto'. A renderer built with quality:'max'
// therefore started at the top rung with no governor, while choosing Max from
// the selector started near the heuristic guess with a wider budget: the same
// mode behaving two ways depending on how you got there.
{
  for (const mode of ['auto', 'max']) {
    const p = planMode(mode, 4);
    check(`${mode} is adaptive however it is entered`, p.gov !== null);
    check(`${mode} starts on the ladder`, p.rung >= 0 && p.rung <= TOP);
  }
  for (const mode of ['low', 'medium', 'high', 'screenshot']) {
    const p = planMode(mode, 4);
    check(`${mode} is fixed, with no governor`, p.gov === null);
    check(`${mode} maps to its preset rung`, p.rung === PRESET_RUNG[mode]);
  }

  const auto = planMode('auto', 4);
  const max = planMode('max', 4);
  check('max starts above auto', max.rung > auto.rung, `${auto.rung} vs ${max.rung}`);
  check('max carries the wider budget',
        max.gov.budgetMs > auto.gov.budgetMs * 1.2,
        `${auto.gov.budgetMs.toFixed(1)}ms vs ${max.gov.budgetMs.toFixed(1)}ms`);
  check('and tolerates more late frames, which is its personality',
        max.gov.dropMiss > auto.gov.dropMiss);
  check('the budget factor is the documented one',
        Math.abs(max.gov.budgetMs / auto.gov.budgetMs - MAX_BUDGET_FACTOR) < 1e-9);

  // An unknown mode must not produce a broken renderer.
  const junk = planMode('nonsense', 4);
  check('an unknown mode falls back to a fixed rung', junk.gov === null
        && junk.rung >= 0 && junk.rung <= TOP, `rung ${junk.rung}`);

  // The heuristic start is only a starting point, but it must be respected.
  check('the starting rung follows the heuristic', planMode('auto', 1).rung === 1);
  check('and is clamped at the top', planMode('max', TOP).rung === TOP);
}

// Max should reach higher than auto on the same hardware, which is the whole
// reason for it being a separate mode.
{
  const run = (mode) => {
    let g = planMode(mode, 3).gov;
    for (let f = 0; f < 12000; f++) g = govSample(g, LAPTOP(g.index));
    return g.index;
  };
  const a = run('auto');
  const m = run('max');
  check('max settles no lower than auto on the same device', m >= a,
        `auto ${a}, max ${m}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
{
  const rows = [['phone', PHONE], ['laptop', LAPTOP], ['workstation', WORKSTATION]];
  const out = rows.map(([n, c]) => {
    const { g } = settle(c);
    return `${n} -> rung ${g.index} (scale ${rung(g.index).scale}, ${rung(g.index).steps} steps, ${c.work(g.index).toFixed(1)}ms work)`;
  });
  console.log('(' + out.join('; ') + ')');
}
process.exit(failed ? 1 : 0);
