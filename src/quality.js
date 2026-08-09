// quality.js — the adaptive-quality governor. Pure: no WebGPU, no DOM, no time
// source of its own. Everything it decides is a function of the samples it is
// handed, which is what makes it testable in an environment that has no GPU.
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
//   A BUDGET, NOT A RACE. The governor targets a frame time, not maximum speed.
//   Inside budget with margin it climbs; at budget it stops. Frame time is used
//   directly rather than converted to FPS because the budget is a time and the
//   arithmetic of averaging reciprocals is a trap -- the mean of 1/t is not
//   1/mean(t), so an FPS average is biased by its fastest frames.
//
//   A REMEMBERED CEILING. When a rung proves too expensive the governor drops
//   AND records that rung as known-bad, settling one below it instead of
//   climbing straight back into the stall and oscillating. The ceiling is
//   allowed to lift again only after a long quiet period, so a scene that got
//   cheaper (zooming out of an expensive region) is not punished forever.

// Rungs, cheapest first. `scale` is the internal resolution multiplier; above
// 1.0 it is supersampling, which the old ceiling of 1.0 ruled out entirely.
// `steps` is the raymarch step ceiling, `iters` the fractal iteration depth,
// and `shade` selects cheap or full normals/shadows/occlusion.
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

// The rung matching each fixed preset, so the named modes and the ladder speak
// the same language and `info` can report one number either way.
export const PRESET_RUNG = { low: 1, medium: 3, high: 5, screenshot: 5, max: 9 };

export const TOP = LADDER.length - 1;

// Budgets in milliseconds per frame while the view is MOVING. 16.7 is 60Hz.
export const BUDGET_MS = 16.7;
// Climb only when comfortably inside budget, so the governor is not provoked
// into oscillating by a frame time that merely grazes the target.
export const CLIMB_FRACTION = 0.72;
// A frame this far over budget is a stall, not noise: drop at once.
export const STALL_FACTOR = 2.0;

export const CLIMB_SAMPLES = 90;    // sustained good frames before a step up
export const DROP_SAMPLES = 20;     // sustained bad frames before a step down
export const CEILING_RESET_MS = 20000;

/**
 * Governor state. `index` is the current rung; `ceiling` is the highest rung
 * believed sustainable, which starts optimistic and is lowered by experience.
 */
export function govInit(index = 3, opts = {}) {
  return {
    index: clampIndex(index),
    ceiling: clampIndex(opts.ceiling ?? TOP),
    emaMs: opts.emaMs ?? BUDGET_MS,
    good: 0,
    bad: 0,
    sinceCeilingMs: 0,
    budgetMs: opts.budgetMs ?? BUDGET_MS,
    changed: false,
  };
}

export function clampIndex(i) {
  return Math.max(0, Math.min(TOP, Math.round(i)));
}

export function rung(index) {
  return LADDER[clampIndex(index)];
}

/**
 * Feed one interactive frame time. Returns new governor state; `changed` says
 * whether the rung moved, which is the caller's cue to resize its targets.
 *
 * Converged frames must NOT be fed in. They skip the raymarch entirely, so
 * their cost is not a measurement of the work being governed -- treating them
 * as evidence would let the governor conclude the device has headroom it does
 * not have, climb, and stall the moment the view moves again.
 */
export function govSample(gov, frameMs) {
  const g = { ...gov, changed: false };
  if (!(frameMs > 0) || !Number.isFinite(frameMs)) return g;

  // Clamp before smoothing: an alt-tab or a garbage-collection pause can hand
  // back a frame of several seconds, and one of those must not poison the
  // average that decides quality for the next minute.
  const sample = Math.min(frameMs, g.budgetMs * 8);
  g.emaMs = g.emaMs * 0.9 + sample * 0.1;
  g.sinceCeilingMs += sample;

  // A single catastrophic frame is acted on immediately. Waiting out the
  // hysteresis here would mean twenty more frames at a rung already known to be
  // far too expensive.
  if (sample > g.budgetMs * STALL_FACTOR && g.index > 0) {
    return applyDrop(g, g.index - 2);
  }

  if (g.emaMs > g.budgetMs) {
    g.bad++;
    g.good = 0;
  } else if (g.emaMs < g.budgetMs * CLIMB_FRACTION) {
    g.good++;
    g.bad = 0;
  } else {
    g.good = 0;
    g.bad = 0;
  }

  if (g.bad >= DROP_SAMPLES && g.index > 0) {
    return applyDrop(g, g.index - 1);
  }

  // The ceiling lifts by one rung after a long stretch without trouble, so a
  // scene that has become cheaper can be explored again rather than being held
  // down by a measurement taken somewhere expensive.
  if (g.ceiling < TOP && g.sinceCeilingMs > CEILING_RESET_MS && g.bad === 0) {
    g.ceiling = g.ceiling + 1;
    g.sinceCeilingMs = 0;
  }

  if (g.good >= CLIMB_SAMPLES && g.index < Math.min(TOP, g.ceiling)) {
    g.index = g.index + 1;
    g.good = 0;
    g.changed = true;
    // Assume the new rung costs more, so the next decision is not made on an
    // average gathered at the cheaper one.
    g.emaMs = g.budgetMs * 0.9;
  }
  return g;
}

function applyDrop(g, to) {
  const from = g.index;
  g.index = clampIndex(to);
  // One BELOW the rung that misbehaved, and remember it.
  g.ceiling = Math.max(0, from - 1);
  g.sinceCeilingMs = 0;
  g.good = 0;
  g.bad = 0;
  g.changed = g.index !== from;
  g.emaMs = g.budgetMs * 0.9;
  return g;
}

/**
 * Where to sit once the view has been still long enough to be a showcase
 * rather than an interaction. A still frame has no responsiveness to protect,
 * so it can afford rungs the interactive budget will never reach; the limit is
 * patience, not smoothness.
 *
 * `stillBudgetMs` is how long a single still frame may take. The estimate uses
 * the measured interactive cost and the pixel ratio between rungs, since
 * resolution dominates: cost scales with area, hence with scale squared.
 */
export function showcaseIndex(gov, stillBudgetMs = 220) {
  const here = rung(gov.index);
  const costPerPixel = gov.emaMs / (here.scale * here.scale);
  let best = gov.index;
  for (let i = gov.index + 1; i <= TOP; i++) {
    const r = LADDER[i];
    // Step count and iteration depth also cost, though less sharply than area.
    const work = (r.steps / here.steps) * 0.6 + (r.iters / here.iters) * 0.4;
    const est = costPerPixel * r.scale * r.scale * work;
    if (est > stillBudgetMs) break;
    best = i;
  }
  return best;
}

/**
 * How many accumulated samples to gather before declaring the image finished.
 * Higher rungs already deliver more per sample, so the count rises with the
 * rung rather than being a single global number.
 */
export function accumTarget(index, base = 96) {
  const r = rung(index);
  return Math.round(base * (r.scale >= 1.25 ? 1.5 : 1.0));
}
