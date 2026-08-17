// quality.js — the adaptive-quality governor. Pure decision logic: no WebGPU,
// DOM, or clock source of its own. Everything it decides is a function of the
// samples it is handed, which is what makes it testable without a GPU.
//
// Optional diagnostics at the bottom of this module observe decisions after
// they have been made. Per-frame telemetry retains references/scalars only;
// frozen copies are created only when diagnostics are read, and subscribers are
// notified only for meaningful quality events such as rung changes. Diagnostic
// output is never read by the governor.
//
// The old controller chased frames per second and moved one dial: internal
// resolution, between 0.4 and 1.0. That answers "is the device keeping up" but
// never "how much has this device got left", so a machine with headroom to
// spare rendered exactly what a laptop did.
//
// This one spends measured headroom on a LADDER of rungs. Each rung raises the
// mathematical work as well as the pixel count, in the order that buys the most
// visible detail per millisecond: resolution first, because aliasing is the
// most obvious defect; then march steps, which is what stops thin structures
// being missed; then iteration depth, which reveals detail that is genuinely
// there in the mathematics; then the quality of normals, shadows and occlusion.
//
// Two ideas do most of the work:
//
//   A BUDGET, NOT A RACE. The governor targets a frame time, not maximum speed,
//   and judges it by the fraction of frames that MISSED that budget rather than
//   by the average frame time -- see the note on vsync below, which is what
//   forced that choice.
//
//   A REMEMBERED CEILING. When a rung proves too expensive the governor drops
//   AND records that rung as known-bad, settling one below it instead of
//   climbing straight back into the stall and oscillating. The ceiling is
//   allowed to lift again only after a long quiet period, so a scene that got
//   cheaper (zooming out of an expensive region) is not punished forever.

export const LADDER = [
  { scale: 0.40, steps: 70, iters: 6, shade: 0 },
  { scale: 0.50, steps: 90, iters: 8, shade: 0 },
  { scale: 0.60, steps: 110, iters: 9, shade: 1 },
  { scale: 0.70, steps: 120, iters: 10, shade: 1 },
  { scale: 0.85, steps: 140, iters: 11, shade: 1 },
  { scale: 1.00, steps: 160, iters: 12, shade: 1 },
  { scale: 1.25, steps: 190, iters: 13, shade: 1 },
  { scale: 1.50, steps: 220, iters: 15, shade: 1 },
  { scale: 1.75, steps: 260, iters: 16, shade: 1 },
  { scale: 2.00, steps: 300, iters: 18, shade: 1 },
];

export const PRESET_RUNG = { low: 1, medium: 3, high: 5, screenshot: 5, max: 9 };
export const TOP = LADDER.length - 1;
export const BUDGET_MS = 16.7;
export const MET_TOLERANCE = 1.05;
// MEASURED ON REAL HARDWARE: at 2.5 this fired constantly on a healthy 60Hz
// desktop, because 2.5 x 16.7 = 41.75ms and one hitch missing two vsyncs is
// 50ms -- ordinary jank from the compositor, a GC pause or a burst of drag
// events. 4.0 needs four missed refreshes, which is catastrophe, not noise.
export const STALL_FACTOR = 4.0;
export const CLIMB_MISS = 0.02;
export const DROP_MISS = 0.12;
export const CLIMB_SAMPLES = 90;
export const DROP_SAMPLES = 20;
export const CEILING_RESET_MS = 20000;
export const MAX_BUDGET_FACTOR = 1.35;
export const MAX_CLIMB_MISS = 0.06;
export const MAX_DROP_MISS = 0.30;
export const CEILING_BACKOFF = 2.0;
export const CEILING_RESET_MAX_MS = 300000;

// ---- Optional, observational diagnostics -----------------------------------
// These hooks deliberately have no browser dependency and no control authority.
// Returned governor objects are already immutable-by-convention snapshots in
// the renderer: govSample() creates a new object every time. We retain only the
// latest reference/scalars on the hot path and materialise frozen copies when a
// diagnostic consumer actually asks for them.
const diagnosticObservers = new Set();
let sequence = 0;
let latestPlan = null;
let latestLimit = null;
let latestShowcase = null;
let latestSampleGov = null;
let latestSampleFrameMs = null;
let latestSampleValid = false;
let latestSampleBeforeIndex = null;
let latestSampleSeq = 0;


function frozenGov(gov) {
  return gov ? Object.freeze({ ...gov }) : null;
}

function freezeEvent(type, payload) {
  return Object.freeze({ type, seq: ++sequence, ...payload });
}

function notify(event) {
  for (const observer of diagnosticObservers) {
    try { observer(event); } catch (_) { /* diagnostics must never affect quality */ }
  }
}

export function subscribeQualityDiagnostics(observer) {
  if (typeof observer !== 'function') return () => {};
  diagnosticObservers.add(observer);
  return () => diagnosticObservers.delete(observer);
}

export function getQualityDiagnosticsState() {
  const sample = latestSampleGov ? Object.freeze({
    type: 'sample',
    seq: latestSampleSeq,
    frameMs: latestSampleFrameMs,
    valid: latestSampleValid,
    beforeIndex: latestSampleBeforeIndex,
    governor: frozenGov(latestSampleGov),
  }) : null;
  return Object.freeze({ plan: latestPlan, sample, limit: latestLimit, showcase: latestShowcase });
}

export function govInit(index = 3, opts = {}) {
  const g = {
    index: clampIndex(index),
    ceiling: clampIndex(opts.ceiling ?? TOP),
    emaMs: opts.emaMs ?? BUDGET_MS,
    missRate: 0,
    good: 0,
    bad: 0,
    sinceCeilingMs: 0,
    resetMs: opts.resetMs ?? CEILING_RESET_MS,
    lastFail: -1,
    budgetMs: opts.budgetMs ?? BUDGET_MS,
    climbMiss: opts.climbMiss ?? CLIMB_MISS,
    dropMiss: opts.dropMiss ?? DROP_MISS,
    changed: false,
  };
  return g;
}

// Tell the governor which rung is actually being rendered.
//
// The governor is not the only thing that sets a rung. The showcase pass raises
// it once the view is still, and callers can set one directly. Its own index is
// otherwise unaware of that, so the frames it samples next describe a rung it
// does not believe it is on.
//
// Observed on a 60Hz desktop: showcase raised the rendered rung while the
// governor still held a much lower index, so every subsequent interactive frame
// was charged to the wrong rung. The miss rate ran to 0.93 and the ladder was
// walked to the floor, while the renderer itself never moved -- the governor
// only calls back into applyRung when its index changes, and its index had
// nowhere lower to go.
//
// The remembered ceiling and lastFail survive: they record which rungs proved
// unaffordable, which is still true. Only the per-rung evidence is cleared,
// because it was gathered at a different rung and does not describe this one.
export function govResync(gov, index) {
  if (!gov) return gov;
  const i = clampIndex(index);
  if (i === gov.index) return gov;
  const g = { ...gov };
  g.index = i;
  g.emaMs = g.budgetMs * 0.9;
  g.missRate = 0;
  g.good = 0;
  g.bad = 0;
  g.changed = false;
  return g;
}

export function clampIndex(i) {
  return Math.max(0, Math.min(TOP, Math.round(i)));
}

export function rung(index) {
  return LADDER[clampIndex(index)];
}

function finishSample(before, g, frameMs, valid) {
  // Retain the already-created governor object plus a few scalars so opening the
  // diagnostics panel on a converged/still view can report the last true
  // interactive governor state immediately. This adds no per-frame objects or
  // freezes. Subscribers and event objects remain dormant while diagnostics is
  // closed.
  latestSampleGov = g;
  latestSampleFrameMs = Number.isFinite(frameMs) ? frameMs : null;
  latestSampleValid = valid;
  latestSampleBeforeIndex = before?.index ?? null;
  latestSampleSeq = ++sequence;

  // Rung transitions are rare and useful for history. Ordinary frames only
  // update the retained reference/scalars above, avoiding diagnostic objects
  // and callbacks on the hot path.
  if (diagnosticObservers.size && before?.index !== g.index) {
    notify(Object.freeze({
      type: 'sample',
      seq: latestSampleSeq,
      frameMs: latestSampleFrameMs,
      valid,
      beforeIndex: before?.index ?? null,
      governor: frozenGov(g),
    }));
  }
  return g;
}

export function govSample(gov, frameMs) {
  const g = { ...gov, changed: false };
  if (!(frameMs > 0) || !Number.isFinite(frameMs)) {
    return finishSample(gov, g, frameMs, false);
  }

  const sample = Math.min(frameMs, g.budgetMs * 8);
  g.emaMs = g.emaMs * 0.9 + sample * 0.1;
  g.sinceCeilingMs += sample;

  const missed = sample > g.budgetMs * MET_TOLERANCE ? 1 : 0;
  g.missRate = g.missRate * 0.94 + missed * 0.06;

  // A hitch drops the rung for responsiveness but records NOTHING. One late
  // frame is not evidence that a rung is unsustainable, and treating it as such
  // was catastrophic in practice: measured on a 60fps Windows desktop, isolated
  // hitches drove the ladder from rung 3 down to rung 0 and held it there. Each
  // stall set ceiling = index-1 and lastFail, so the thermal backoff doubled --
  // 20s, 40s, 80s -- and the recovery built for a hot phone ended up pinning a
  // perfectly healthy machine at 840x450 with cheap shading. Only the sustained
  // miss-rate path may lower the ceiling.
  if (sample > g.budgetMs * STALL_FACTOR && g.index > 0) {
    return finishSample(gov, applyHitch(g, g.index - 1), frameMs, true);
  }

  if (g.missRate > g.dropMiss) {
    g.bad++;
    g.good = 0;
  } else if (g.missRate < g.climbMiss) {
    g.good++;
    g.bad = 0;
  } else {
    g.good = 0;
    g.bad = 0;
  }

  if (g.bad >= DROP_SAMPLES && g.index > 0) {
    return finishSample(gov, applyDrop(g, g.index - 1), frameMs, true);
  }

  if (g.ceiling < TOP && g.sinceCeilingMs > g.resetMs && g.bad === 0) {
    g.ceiling = g.ceiling + 1;
    g.sinceCeilingMs = 0;
  }

  if (g.good >= CLIMB_SAMPLES && g.index < Math.min(TOP, g.ceiling)) {
    g.index = g.index + 1;
    g.good = 0;
    g.changed = true;
    g.missRate = g.climbMiss;
    g.emaMs = g.budgetMs * 0.9;
  }
  return finishSample(gov, g, frameMs, true);
}

// A transient drop: rung only, no memory. Recovers by the ordinary climb.
function applyHitch(g, to) {
  const from = g.index;
  g.index = clampIndex(to);
  g.good = 0;
  g.bad = 0;
  g.missRate = 0;
  g.changed = g.index !== from;
  g.emaMs = g.budgetMs * 0.9;
  return g;
}

function applyDrop(g, to) {
  const from = g.index;
  g.index = clampIndex(to);
  const repeat = g.lastFail === from;
  g.lastFail = from;
  g.ceiling = Math.max(0, from - 1);
  g.resetMs = Math.min(CEILING_RESET_MAX_MS,
    repeat ? g.resetMs * CEILING_BACKOFF : CEILING_RESET_MS);
  g.sinceCeilingMs = 0;
  g.good = 0;
  g.bad = 0;
  g.missRate = 0;
  g.changed = g.index !== from;
  g.emaMs = g.budgetMs * 0.9;
  return g;
}

export function maxRungForLimit(pxW, pxH, limit) {
  const px = Math.max(pxW, pxH);
  let best = TOP;
  if (px > 0 && limit > 0) {
    best = 0;
    for (let i = 0; i <= TOP; i++) {
      if (Math.round(px * LADDER[i].scale) <= limit) best = i;
      else break;
    }
  }
  latestLimit = freezeEvent('limit', {
    pixelWidth: Number.isFinite(pxW) ? pxW : null,
    pixelHeight: Number.isFinite(pxH) ? pxH : null,
    limit: Number.isFinite(limit) ? limit : null,
    rungCap: best,
  });
  if (diagnosticObservers.size) notify(latestLimit);
  return best;
}

export function planMode(mode, autoRung = 3) {
  let plan;
  if (mode === 'auto' || mode === 'max') {
    const start = clampIndex(autoRung + (mode === 'max' ? 1 : 0));
    const opts = mode === 'max'
      ? {
          budgetMs: BUDGET_MS * MAX_BUDGET_FACTOR,
          climbMiss: MAX_CLIMB_MISS,
          dropMiss: MAX_DROP_MISS,
        }
      : {};
    plan = { rung: start, gov: govInit(start, opts) };
  } else {
    plan = { rung: clampIndex(PRESET_RUNG[mode] ?? PRESET_RUNG.high), gov: null };
  }
  latestPlan = freezeEvent('plan', {
    mode,
    autoRung: clampIndex(autoRung),
    rung: plan.rung,
    governor: frozenGov(plan.gov),
  });
  if (diagnosticObservers.size) notify(latestPlan);
  return plan;
}

export function showcaseIndex(gov, stillBudgetMs = 220) {
  const here = rung(gov.index);
  const costPerPixel = gov.emaMs / (here.scale * here.scale);
  let best = gov.index;
  for (let i = gov.index + 1; i <= TOP; i++) {
    const r = LADDER[i];
    const work = (r.steps / here.steps) * 0.6 + (r.iters / here.iters) * 0.4;
    const est = costPerPixel * r.scale * r.scale * work;
    if (est > stillBudgetMs) break;
    best = i;
  }
  latestShowcase = freezeEvent('showcase', {
    fromRung: gov.index,
    rung: best,
    stillBudgetMs,
    governor: frozenGov(gov),
  });
  if (diagnosticObservers.size) notify(latestShowcase);
  return best;
}

export function accumTarget(index, base = 96) {
  const r = rung(index);
  return Math.round(base * (r.scale >= 1.25 ? 1.5 : 1.0));
}
