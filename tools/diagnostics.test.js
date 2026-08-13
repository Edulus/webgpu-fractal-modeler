// Renderer diagnostics pure helpers and quality telemetry. Run: node tools/diagnostics.test.js
import {
  LADDER, TOP, BUDGET_MS, MET_TOLERANCE, STALL_FACTOR, CLIMB_SAMPLES, DROP_SAMPLES,
  CEILING_RESET_MS, CEILING_BACKOFF, CEILING_RESET_MAX_MS,
  govInit, govSample, planMode, maxRungForLimit, showcaseIndex,
  subscribeQualityDiagnostics, getQualityDiagnosticsState,
} from '../src/quality.js';
import {
  HISTORY_LIMIT, pushBounded, fitDimensions, effectiveRenderSize, modeDefaults,
  buildDiagnosticsSnapshot, formatRendererReport, installRendererDiagnostics,
} from '../src/diagnostics.js';

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else { failed++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
};

// Bounded history is deterministic and does not mutate its input.
{
  const original = [{ n: 0 }];
  let h = original;
  for (let i = 1; i <= HISTORY_LIMIT + 5; i++) h = pushBounded(h, { n: i });
  check('history is bounded', h.length === HISTORY_LIMIT, `${h.length}`);
  check('history keeps newest entry', h.at(-1).n === HISTORY_LIMIT + 5);
  check('history discards oldest entries', h[0].n === 6, `${h[0].n}`);
  check('pushBounded does not mutate input', original.length === 1);
}

// One factor fits both axes and preserves aspect.
{
  const f = fitDimensions(10240, 2880, 8192);
  check('oversize width is capped', f.width === 8192, `${f.width}`);
  check('height is reduced by same factor', f.height === 2304, `${f.height}`);
  check('aspect ratio is preserved', Math.abs(f.width / f.height - 10240 / 2880) < 1e-12);
  const r = effectiveRenderSize(8192, 2304, 2, 8192);
  check('render size reports requested dimensions', r.requestedWidth === 16384 && r.requestedHeight === 4608);
  check('render size backstop also preserves aspect', Math.abs(r.width / r.height - 8192 / 2304) < 1e-12);
}

// Adaptive mode personalities are represented exactly from quality constants.
{
  const a = modeDefaults('auto');
  const m = modeDefaults('max');
  const h = modeDefaults('high');
  check('Auto diagnostics have a budget', a.budgetMs > 0);
  check('Max diagnostics have a wider budget', m.budgetMs > a.budgetMs);
  check('Max tolerates more misses', m.dropMiss > a.dropMiss && m.climbMiss > a.climbMiss);
  check('fixed modes report no adaptive budget', h.budgetMs === null && h.dropMiss === null);
}

// Telemetry is observational: events are frozen, governor inputs are not mutated,
// and unsubscribing stops delivery.
{
  const events = [];
  const unsubscribe = subscribeQualityDiagnostics((e) => events.push(e));
  const p = planMode('auto', 3);
  const before = { ...p.gov };
  const beforeSteadySample = events.length;
  const next = govSample(p.gov, 16.7);
  check('ordinary steady frames do not notify observers', events.length === beforeSteadySample);
  const changed = govSample(next, BUDGET_MS * 5); // rung transition: worth publishing
  const cap = maxRungForLimit(8192, 4320, 8192);
  showcaseIndex(changed, 220);
  const countBeforeUnsubscribe = events.length;
  unsubscribe();
  govSample(changed, BUDGET_MS * 5);

  check('plan event is published', events.some((e) => e.type === 'plan'));
  check('sample event is published', events.some((e) => e.type === 'sample'));
  check('limit event is published', events.some((e) => e.type === 'limit' && e.rungCap === cap));
  check('showcase event is published', events.some((e) => e.type === 'showcase'));
  check('observer events are frozen', events.every(Object.isFrozen));
  check('governor snapshots are frozen', events.filter((e) => e.governor).every((e) => Object.isFrozen(e.governor)));
  check('sampling still does not mutate its input', JSON.stringify(p.gov) === JSON.stringify(before));
  check('sampling still returns a new state', next !== p.gov);
  check('unsubscribe stops telemetry', events.length === countBeforeUnsubscribe);
}

// Retained telemetry can seed diagnostics installed after renderer init.
{
  planMode('max', 4);
  maxRungForLimit(10240, 2880, 8192);
  const t = getQualityDiagnosticsState();
  check('latest plan is retained', t.plan?.mode === 'max');
  check('latest texture cap is retained', Number.isFinite(t.limit?.rungCap));
  const copy = getQualityDiagnosticsState();
  let rejected = false;
  try { copy.plan = null; } catch (_) { rejected = true; }
  check('returned telemetry container is frozen', Object.isFrozen(copy) && rejected);
  check('retained telemetry cannot be replaced by callers', getQualityDiagnosticsState().plan?.mode === 'max');
}


// Differential guard: the diagnostic tap must leave the pre-diagnostics governor
// arithmetic unchanged. This is the original controller expressed locally and
// compared over long deterministic frame sequences in both adaptive modes.
{
  const refClamp = (i) => Math.max(0, Math.min(TOP, Math.round(i)));
  const refDrop = (g, to) => {
    const from = g.index;
    g.index = refClamp(to);
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
  };
  const refSample = (gov, frameMs) => {
    const g = { ...gov, changed: false };
    if (!(frameMs > 0) || !Number.isFinite(frameMs)) return g;
    const sample = Math.min(frameMs, g.budgetMs * 8);
    g.emaMs = g.emaMs * 0.9 + sample * 0.1;
    g.sinceCeilingMs += sample;
    const missed = sample > g.budgetMs * MET_TOLERANCE ? 1 : 0;
    g.missRate = g.missRate * 0.94 + missed * 0.06;
    // A hitch drops the rung only; it records no ceiling, no failed rung and no
    // backoff. Mirrors applyHitch(), which replaced a two-rung applyDrop() after
    // isolated jank was measured ratcheting a healthy desktop to the bottom.
    if (sample > g.budgetMs * STALL_FACTOR && g.index > 0) {
      const from = g.index;
      g.index = refClamp(g.index - 1);
      g.good = 0; g.bad = 0; g.missRate = 0;
      g.changed = g.index !== from;
      g.emaMs = g.budgetMs * 0.9;
      return g;
    }
    if (g.missRate > g.dropMiss) { g.bad++; g.good = 0; }
    else if (g.missRate < g.climbMiss) { g.good++; g.bad = 0; }
    else { g.good = 0; g.bad = 0; }
    if (g.bad >= DROP_SAMPLES && g.index > 0) return refDrop(g, g.index - 1);
    if (g.ceiling < TOP && g.sinceCeilingMs > g.resetMs && g.bad === 0) {
      g.ceiling++; g.sinceCeilingMs = 0;
    }
    if (g.good >= CLIMB_SAMPLES && g.index < Math.min(TOP, g.ceiling)) {
      g.index++; g.good = 0; g.changed = true;
      g.missRate = g.climbMiss; g.emaMs = g.budgetMs * 0.9;
    }
    return g;
  };
  const run = (mode) => {
    let actual = planMode(mode, 3).gov;
    let reference = { ...actual };
    for (let i = 0; i < 12000; i++) {
      // Deterministic mix of on-time frames, missed refreshes, jitter and rare stalls.
      // 5x clears STALL_FACTOR so the hitch path is actually compared; 2x is a
      // single missed refresh, which must NOT be treated as a stall.
      const frame = i % 997 === 0 ? actual.budgetMs * 5
        : (i % 29 === 0 ? actual.budgetMs * 2 : actual.budgetMs);
      actual = govSample(actual, frame);
      reference = refSample(reference, frame);
      if (JSON.stringify(actual) !== JSON.stringify(reference)) return false;
    }
    return true;
  };
  check('diagnostic instrumentation preserves Auto governor arithmetic', run('auto'));
  check('diagnostic instrumentation preserves Max governor arithmetic', run('max'));
}

// Snapshot truth: fixed/adaptive distinction, constrained dimensions and accumulation.
{
  let g = govInit(5, { ceiling: 7 });
  for (let i = 0; i < 5; i++) g = govSample(g, 16.7);
  const telemetry = getQualityDiagnosticsState();
  const canvas = {
    width: 8192, height: 2304,
    getBoundingClientRect: () => ({ width: 5120, height: 1440 }),
  };
  const info = {
    fractalType: 11, qualityMode: 'max', qualityScale: 1,
    rung: 5, steps: 160, iters: 12, frameMs: 16.7, fps: 60,
    samples: 96, explorer: true, fly: false, reducedMotion: false,
  };
  const s = buildDiagnosticsSnapshot({ info, canvas, telemetry, accumOn: true, accumCap: 96, devicePixelRatio: 2 });
  check('snapshot names the model', s.model.key === 'barth');
  check('snapshot identifies a raymarched model', s.model.family === 'raymarched surface');
  check('snapshot reports the current rung', s.quality.rung === 5);
  check('snapshot carries a texture rung cap', Number.isFinite(s.quality.rungCap));
  check('snapshot reports real swapchain dimensions', s.dimensions.swapchain.width === 8192 && s.dimensions.swapchain.height === 2304);
  check('snapshot separates browser DPR from fitted backing scale', s.dimensions.dpr === 2 && s.dimensions.backingScale === 1.6);
  check('snapshot reports workload', s.workload.steps === 160 && s.workload.iterations === 12 && s.workload.shading === 'full');
  check('converged accumulation is explicit', s.accumulation.converged && s.accumulation.raymarchSkipped);
  check('snapshot history is copied', Array.isArray(s.history) && s.history !== undefined);

  const fixed = buildDiagnosticsSnapshot({
    info: { ...info, qualityMode: 'high', samples: 0 }, canvas, telemetry: {}, accumOn: true,
  });
  check('fixed preset reports no governor', fixed.governor.exists === false);
  check('fixed preset has no adaptive budget', fixed.governor.budgetMs === null);
}

// Report is plain text, compact and useful when fields are missing.
{
  const report = formatRendererReport(buildDiagnosticsSnapshot({
    info: { fractalType: 25, qualityMode: 'auto', qualityScale: LADDER[3].scale, rung: 3, samples: 0 },
    canvas: { width: 1280, height: 720, getBoundingClientRect: () => ({ width: 1280, height: 720 }) },
    telemetry: {},
  }));
  check('report has a stable title', report.startsWith('Fractal WebGPU Modeler Renderer Report'));
  check('report identifies attractor family', report.includes('(attractor)'));
  check('report includes quality state', report.includes('Mode: auto') && report.includes('Rung: 3'));
  check('report includes dimensions', report.includes('Swapchain: 1280 × 720'));
  check('report degrades gracefully for unavailable fields', report.includes('n/a'));
}


// Installed diagnostics wrap only public observation points and cleanly restore them.
{
  const state = {
    fractalType: 0, qualityMode: 'auto', qualityScale: LADDER[3].scale,
    rung: 3, steps: LADDER[3].steps, iters: LADDER[3].iters,
    frameMs: 16.7, fps: 60, samples: 0,
    explorer: false, fly: false, reducedMotion: false,
  };
  const originalSetQuality = function (mode) {
    state.qualityMode = mode;
    const p = planMode(mode, 3);
    state.rung = p.rung;
    state.qualityScale = LADDER[p.rung].scale;
    state.steps = LADDER[p.rung].steps;
    state.iters = LADDER[p.rung].iters;
  };
  const originalSetAccumulate = function (on) { state.samples = 0; state.accumOn = !!on; };
  const handle = {
    get info() { return { ...state }; },
    setQuality: originalSetQuality,
    setAccumulate: originalSetAccumulate,
  };
  const canvas = { width: 1280, height: 720, getBoundingClientRect: () => ({ width: 1280, height: 720 }) };
  const d = installRendererDiagnostics(handle, canvas, { historyLimit: 4 });
  check('installer adds getDiagnostics', typeof handle.getDiagnostics === 'function');
  check('installer adds getRendererReport', typeof handle.getRendererReport === 'function');
  handle.setQuality('max');
  const snap = d.snapshot();
  check('mode changes are recorded', snap.history.some((h) => h.reason === 'mode:max'));
  check('installed snapshot reflects Max', snap.quality.mode === 'max');
  check('installed report is copyable text', handle.getRendererReport().includes('Mode: max'));
  handle.setAccumulate(false);
  check('accumulation disable is represented', d.snapshot().accumulation.enabled === false);
  const historyCopy = d.history;
  historyCopy.length = 0;
  check('history getter returns a copy', d.history.length > 0);
  d.destroy();
  check('destroy restores setQuality identity', handle.setQuality === originalSetQuality);
  check('destroy restores setAccumulate identity', handle.setAccumulate === originalSetAccumulate);
  check('destroy removes diagnostic handle methods', !('getDiagnostics' in handle) && !('getRendererReport' in handle));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
