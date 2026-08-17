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
  LADDER, TOP, BUDGET_MS, PRESET_RUNG, CEILING_RESET_MS,
  govInit, govSample, rung, clampIndex, showcaseIndex, accumTarget, planMode,
  MAX_BUDGET_FACTOR, maxRungForLimit, govResync,
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
  const before = { ceiling: g.ceiling, resetMs: g.resetMs, lastFail: g.lastFail };
  g = govSample(g, BUDGET_MS * 5);
  check('one stalled frame drops the rung immediately', g.index < 6, `now ${g.index}`);
  // ...but records NOTHING. This assertion is inverted from what it used to be,
  // because the old behaviour was measured causing real harm: see below.
  check('and does NOT lower the ceiling on one hitch', g.ceiling === before.ceiling,
        `ceiling ${g.ceiling}`);
  check('nor records it as a failed rung', g.lastFail === before.lastFail);
  check('nor extends the retry backoff', g.resetMs === before.resetMs,
        `resetMs ${g.resetMs}`);
}

// THE RATCHET. Measured on a 60fps Windows desktop, not simulated into
// existence: isolated hitches drove the ladder from rung 3 to rung 0 and held it
// there, rendering 840x450 with cheap shading on a machine that never dropped a
// frame's worth of real work. Each stall recorded ceiling = index-1 and
// lastFail, so the thermal backoff doubled -- 20s, 40s, 80s -- and the recovery
// built for a hot phone pinned a healthy machine to the bottom of the ladder.
//
// The trigger was ordinary jank: 2.5 x 16.7 = 41.75ms, and one hitch missing two
// vsyncs is 50ms.
{
  const REFRESH = 1000 / 60;
  const HITCH = 50;                       // two missed vsyncs: compositor, GC, drag burst
  const run = (periodFrames) => {
    let g = planMode('auto', 3).gov;
    for (let f = 0; f < 60 * 60 * 5; f++) {
      g = govSample(g, periodFrames && f % periodFrames === 0 ? HITCH : REFRESH);
    }
    return g;
  };
  const clean = run(0);
  const rare = run(600);                  // a hitch every 10 seconds
  const frequent = run(60);               // a hitch every second

  check('a flawless machine reaches the top of the ladder', clean.index === TOP,
        `rung ${clean.index}`);
  check('and an occasional hitch does not stop it', rare.index === TOP,
        `rung ${rare.index}`);
  check('a hitch never lowers the ceiling', rare.ceiling === TOP && clean.ceiling === TOP,
        `ceilings ${clean.ceiling}, ${rare.ceiling}`);
  check('nor triggers the thermal backoff, which is for sustained overload',
        rare.resetMs === CEILING_RESET_MS && frequent.resetMs === CEILING_RESET_MS,
        `retry ${rare.resetMs}ms, ${frequent.resetMs}ms`);
  const veryFrequent = run(20);           // a hitch three times a second
  check('a hitch every 3s no longer suppresses anything', run(180).index === TOP,
        `rung ${run(180).index}`);
  check('constant hitching still suppresses quality, as it should',
        veryFrequent.index < rare.index, `${veryFrequent.index} vs ${rare.index}`);

  // The threshold itself: one double-miss must no longer count as a stall.
  let g = govInit(6);
  g = govSample(g, HITCH);
  check('a 50ms frame is jank, not a stall', g.index === 6, `now ${g.index}`);
  g = govSample(govInit(6), 70);
  check('a 70ms frame still is one', g.index < 6, `now ${g.index}`);
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

// ---- texture limits ---------------------------------------------------------
// Supersampling made the adapter's 2D texture limit reachable for the first
// time. WebGPU only guarantees 8192, and an ultrawide at DPR 2 asks for more
// than that at the top rung, so the ladder has to be capped to what can be
// allocated -- not merely clamped at allocation time, because a silently
// clamped rung costs no more than the one below it and so reads as headroom.
{
  const L = 8192;
  check('a 1080p display can use the whole ladder',
        maxRungForLimit(1920, 1080, L) === TOP);
  check('4K at DPR 2 still reaches the top',
        maxRungForLimit(3840, 2160, L) === TOP,
        `got ${maxRungForLimit(3840, 2160, L)}`);
  check('an 8192-wide swapchain is capped at 1.0 scale',
        rung(maxRungForLimit(8192, 4320, L)).scale === 1.0,
        `scale ${rung(maxRungForLimit(8192, 4320, L)).scale}`);
  check('an ultrawide at DPR 2 is capped well below the top',
        maxRungForLimit(10240, 2880, L) < TOP,
        `got ${maxRungForLimit(10240, 2880, L)}`);

  // The cap must be honest in both directions.
  for (const [w, h] of [[1920, 1080], [3840, 2160], [8192, 4320], [10240, 2880], [16384, 8192]]) {
    const i = maxRungForLimit(w, h, L);
    const px = Math.round(Math.max(w, h) * rung(i).scale);
    check(`the capped rung fits for ${w}x${h}`, px <= L || i === 0, `${px} > ${L}`);
    if (i < TOP) {
      const next = Math.round(Math.max(w, h) * rung(i + 1).scale);
      check(`and the next rung would not, for ${w}x${h}`, next > L, `${next} <= ${L}`);
    }
  }

  check('a limit larger than anything asked for caps nothing',
        maxRungForLimit(1024, 768, 65536) === TOP);
  check('nonsense dimensions do not cap to zero',
        maxRungForLimit(0, 0, L) === TOP && maxRungForLimit(1920, 1080, 0) === TOP);
  check('a limit smaller than even the lowest rung returns the lowest',
        maxRungForLimit(10000, 10000, 100) === 0);
}


// ---- Governor / showcase desync -------------------------------------------
// The showcase pass raises the rendered rung while the view is still. If the
// governor is not told, it charges the resulting frames to the rung it still
// believes it is on. Reproduces the observed desktop failure: a high showcase
// rung with the governor pinned low, every frame slow, and the ladder unable to
// respond because its index has nowhere lower to go.
{
  console.log('\nGovernor resync after an external rung change');
  const slow = 60;               // ms: far over any interactive budget

  // Without resync: the governor sits at 0 believing it is cheap, so it can
  // never drop, and the renderer stays wherever showcase left it.
  let stale = govInit(0);
  for (let i = 0; i < 400; i++) stale = govSample(stale, slow);
  check(`stale governor cannot drop below its false index (${stale.index})`, stale.index === 0);
  check(`stale governor's miss rate runs away (${stale.missRate.toFixed(2)})`, stale.missRate > 0.5);

  // With resync: told it is actually at 9, it walks the ladder down.
  let synced = govResync(govInit(0), 9);
  check('resync adopts the rung actually being rendered', synced.index === 9);
  check('resync clears evidence gathered at another rung', synced.missRate === 0);
  for (let i = 0; i < 400; i++) synced = govSample(synced, slow);
  check(`synced governor drops away from an unaffordable rung (9 -> ${synced.index})`, synced.index < 9);

  // The hard-won memory of which rungs failed must survive a resync.
  const remembered = govResync({ ...govInit(2), ceiling: 3, lastFail: 4 }, 7);
  check('resync preserves the remembered ceiling and lastFail', remembered.ceiling === 3 && remembered.lastFail === 4);

  // A resync to the rung already held is a no-op, so it cannot be used to
  // silently wipe the governor's evidence every frame.
  const settled = govSample(govInit(4), 5);
  check('resync to the current rung changes nothing', govResync(settled, settled.index) === settled);
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
