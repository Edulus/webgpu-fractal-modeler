// diagnostics.js — observational renderer diagnostics for real-hardware testing.
//
// This module consumes the renderer's existing public `info` snapshot plus
// immutable events published by quality.js. It never feeds measurements back to
// the governor. Install it only where diagnostics are useful (the demo does so);
// the background library remains unchanged for callers that do not import it.

import {
  LADDER, TOP, BUDGET_MS, CLIMB_MISS, DROP_MISS,
  MAX_BUDGET_FACTOR, MAX_CLIMB_MISS, MAX_DROP_MISS,
  getQualityDiagnosticsState, subscribeQualityDiagnostics,
} from './quality.js';

export const HISTORY_LIMIT = 32;
export const DEFAULT_ACCUM_CAP = 96;

export const MODEL_KEYS = [
  'mandelbulb', 'mandelbox', 'menger', 'julia', 'apollonian',
  'spherepack', 'encrusted', 'surfacepack', 'penrose', 'gyroid',
  'kleinian', 'barth', 'schottky', 'schottkyh', 'tetrabrot',
  'envoct', 'envdodec', 'hyp534', 'hyp435', 'hyp534t', 'hyp534o',
  'hyp435t', 'hyp435o', 'kleinpack', 'engel', 'attractor', 'lorenz', 'rossler',
];

export function pushBounded(history, event, limit = HISTORY_LIMIT) {
  const out = [...(history || []), event];
  if (out.length > limit) out.splice(0, out.length - limit);
  return out;
}

export function fitDimensions(width, height, limit) {
  let w = Math.max(1, Math.round(Number(width) || 1));
  let h = Math.max(1, Math.round(Number(height) || 1));
  const lim = Number(limit);
  if (!(lim > 0)) return { width: w, height: h, factor: 1 };
  const factor = Math.min(1, lim / w, lim / h);
  if (factor < 1) {
    w = Math.max(1, Math.floor(w * factor));
    h = Math.max(1, Math.floor(h * factor));
  }
  return { width: w, height: h, factor };
}

export function effectiveRenderSize(swapWidth, swapHeight, scale, limit) {
  const requestedWidth = Math.max(1, Math.round((Number(swapWidth) || 1) * (Number(scale) || 1)));
  const requestedHeight = Math.max(1, Math.round((Number(swapHeight) || 1) * (Number(scale) || 1)));
  const fit = fitDimensions(requestedWidth, requestedHeight, limit);
  return { requestedWidth, requestedHeight, width: fit.width, height: fit.height, factor: fit.factor };
}

export function modeDefaults(mode) {
  if (mode === 'max') {
    return {
      budgetMs: BUDGET_MS * MAX_BUDGET_FACTOR,
      climbMiss: MAX_CLIMB_MISS,
      dropMiss: MAX_DROP_MISS,
    };
  }
  if (mode === 'auto') {
    return { budgetMs: BUDGET_MS, climbMiss: CLIMB_MISS, dropMiss: DROP_MISS };
  }
  return { budgetMs: null, climbMiss: null, dropMiss: null };
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function cloneHistory(history) {
  return (history || []).map((entry) => ({ ...entry }));
}

export function buildDiagnosticsSnapshot({
  info = {}, canvas = {}, telemetry = {}, history = [],
  accumOn = true, accumCap = DEFAULT_ACCUM_CAP, devicePixelRatio = null,
  userAgent = null, platform = null, language = null,
} = {}) {
  const mode = info.qualityMode ?? 'unknown';
  const currentRung = Number.isFinite(info.rung) ? info.rung : 0;
  const rung = LADDER[Math.max(0, Math.min(TOP, Math.round(currentRung)))] || LADDER[0];
  const latestGovEvent = telemetry.sample?.governor ? telemetry.sample : telemetry.plan;
  const gov = latestGovEvent?.governor || null;
  const defaults = modeDefaults(mode);
  const limitEvent = telemetry.limit || null;
  const textureLimit = limitEvent?.limit ?? null;
  const rungCap = Number.isFinite(limitEvent?.rungCap) ? limitEvent.rungCap : TOP;

  const rect = typeof canvas.getBoundingClientRect === 'function'
    ? canvas.getBoundingClientRect()
    : { width: canvas.clientWidth ?? canvas.width ?? 0, height: canvas.clientHeight ?? canvas.height ?? 0 };
  const cssWidth = round(Number(rect.width) || 0, 1);
  const cssHeight = round(Number(rect.height) || 0, 1);
  const swapWidth = Math.max(0, Number(canvas.width) || 0);
  const swapHeight = Math.max(0, Number(canvas.height) || 0);
  const internal = effectiveRenderSize(swapWidth || 1, swapHeight || 1, info.qualityScale ?? rung.scale, textureLimit);
  const effectiveScale = swapWidth > 0 ? internal.width / swapWidth : null;
  const backingScale = cssWidth > 0 ? swapWidth / cssWidth : null;
  const reportedDpr = Number.isFinite(info.dpr)
    ? info.dpr
    : (Number.isFinite(devicePixelRatio) ? Math.min(devicePixelRatio, 2) : backingScale);

  const samples = Math.max(0, Number(info.samples) || 0);
  const accumulating = !!accumOn && samples > 0 && samples < accumCap;
  const converged = !!accumOn && samples >= accumCap;
  const modelKey = MODEL_KEYS[info.fractalType] ?? `model-${info.fractalType ?? '?'}`;
  const geometryFamily = Number(info.fractalType) >= 25 ? 'attractor' : 'raymarched surface';
  const showcaseRung = telemetry.showcase?.rung ?? null;
  const showcaseIsLatest = (telemetry.showcase?.seq ?? -1) > Math.max(
    telemetry.sample?.seq ?? -1, telemetry.plan?.seq ?? -1);
  const source = showcaseIsLatest && showcaseRung === currentRung && mode === 'max' && samples > 0
    ? 'showcase'
    : (mode === 'auto' || mode === 'max' ? 'interactive governor' : 'fixed preset');

  return {
    model: { key: modelKey, id: info.fractalType ?? null, family: geometryFamily },
    quality: {
      mode,
      rung: currentRung,
      rungCap,
      source,
      textureConstrained: rungCap < TOP,
      showcaseRung,
      scale: round(info.qualityScale ?? rung.scale, 3),
    },
    governor: {
      exists: !!gov && (mode === 'auto' || mode === 'max'),
      budgetMs: round(gov?.budgetMs ?? defaults.budgetMs, 3),
      missRate: round(gov?.missRate, 4),
      climbMiss: round(gov?.climbMiss ?? defaults.climbMiss, 4),
      dropMiss: round(gov?.dropMiss ?? defaults.dropMiss, 4),
      ceiling: gov?.ceiling ?? null,
      lastFail: gov?.lastFail ?? null,
      retryMs: gov?.resetMs ?? null,
      emaMs: round(gov?.emaMs ?? info.frameMs, 3),
    },
    dimensions: {
      css: { width: cssWidth, height: cssHeight },
      dpr: round(reportedDpr, 3),
      backingScale: round(backingScale, 3),
      swapchain: { width: swapWidth, height: swapHeight },
      internal: { width: internal.width, height: internal.height },
      requestedInternal: { width: internal.requestedWidth, height: internal.requestedHeight },
      requestedScale: round(info.qualityScale ?? rung.scale, 3),
      effectiveScale: round(effectiveScale, 3),
      maxTextureDimension2D: textureLimit,
    },
    workload: {
      steps: info.steps ?? rung.steps,
      iterations: info.iters ?? rung.iters,
      shading: rung.shade ? 'full' : 'cheap',
    },
    accumulation: {
      enabled: !!accumOn,
      samples,
      cap: accumCap,
      accumulating,
      converged,
      raymarchSkipped: converged,
    },
    performance: {
      fps: Number.isFinite(info.fps) ? info.fps : null,
      governorEmaMs: round(info.frameMs ?? gov?.emaMs, 3),
      missRate: round(gov?.missRate, 4),
    },
    navigation: {
      explorer: !!info.explorer,
      fly: !!info.fly,
      reducedMotion: !!info.reducedMotion,
    },
    environment: { userAgent, platform, language },
    history: cloneHistory(history),
  };
}

function fmt(value, fallback = 'n/a') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

export function formatRendererReport(snapshot) {
  const s = snapshot || {};
  const q = s.quality || {};
  const g = s.governor || {};
  const d = s.dimensions || {};
  const w = s.workload || {};
  const a = s.accumulation || {};
  const p = s.performance || {};
  const e = s.environment || {};
  const lines = [
    'Fractal WebGPU Modeler Renderer Report',
    `Model: ${fmt(s.model?.key)} (${fmt(s.model?.family)})`,
    `Mode: ${fmt(q.mode)}`,
    `Rung: ${fmt(q.rung)} / cap ${fmt(q.rungCap)} (${fmt(q.source)})`,
    `Texture constrained: ${q.textureConstrained ? 'yes' : 'no'}`,
    `Showcase rung: ${fmt(q.showcaseRung)}`,
    `Governor: ${g.exists ? 'adaptive' : 'fixed'}`,
    `Governor ceiling: ${fmt(g.ceiling)} · last fail: ${fmt(g.lastFail)}`,
    `Budget: ${fmt(g.budgetMs)} ms · miss rate: ${fmt(g.missRate)}`,
    `Miss thresholds: climb ${fmt(g.climbMiss)} · drop ${fmt(g.dropMiss)}`,
    `Retry interval: ${fmt(g.retryMs)} ms`,
    `FPS: ${fmt(p.fps)} · governor EMA: ${fmt(p.governorEmaMs)} ms`,
    `Steps: ${fmt(w.steps)} · iterations: ${fmt(w.iterations)} · shading: ${fmt(w.shading)}`,
    `Canvas CSS: ${fmt(d.css?.width)} × ${fmt(d.css?.height)}`,
    `DPR: ${fmt(d.dpr)} · effective backing scale: ${fmt(d.backingScale)}`,
    `Swapchain: ${fmt(d.swapchain?.width)} × ${fmt(d.swapchain?.height)}`,
    `Internal render: ${fmt(d.internal?.width)} × ${fmt(d.internal?.height)} (q${fmt(d.effectiveScale)})`,
    `Requested internal: ${fmt(d.requestedInternal?.width)} × ${fmt(d.requestedInternal?.height)}`,
    `Texture limit: ${fmt(d.maxTextureDimension2D)}`,
    `Accumulation: ${fmt(a.samples)} / ${fmt(a.cap)}${a.converged ? ' · converged · raymarch skipped' : (a.accumulating ? ' · accumulating' : '')}`,
  ];
  if (e.userAgent) lines.push(`User agent: ${e.userAgent}`);
  if (e.platform) lines.push(`Platform: ${e.platform}`);
  if (e.language) lines.push(`Language: ${e.language}`);
  lines.push('Recent transitions:');
  if (!s.history?.length) lines.push('  (none)');
  else {
    for (const h of s.history) {
      const at = Number.isFinite(h.atMs) ? `${(h.atMs / 1000).toFixed(1)}s` : '?';
      lines.push(`  ${at} · ${fmt(h.from)} → ${fmt(h.to)} · ${fmt(h.reason)} · ${fmt(h.model)}` +
        (h.missRate === null || h.missRate === undefined ? '' : ` · miss ${h.missRate}`));
    }
  }
  return lines.join('\n');
}

export function formatDiagnosticsPanel(snapshot) {
  const s = snapshot;
  const q = s.quality, g = s.governor, d = s.dimensions, w = s.workload, a = s.accumulation;
  return [
    `${s.model.key} · ${s.model.family}`,
    `${q.mode} · rung ${q.rung}/${q.rungCap} · ${q.source}`,
    `gov ${g.exists ? `ceil ${g.ceiling} · miss ${fmt(g.missRate)}` : 'fixed'} · ${fmt(g.budgetMs)}ms`,
    `${d.internal.width}×${d.internal.height} internal · q${fmt(d.effectiveScale)}`,
    `${d.swapchain.width}×${d.swapchain.height} swap · DPR ${fmt(d.dpr)} · backing ${fmt(d.backingScale)}`,
    `tex ${fmt(d.maxTextureDimension2D)}${q.textureConstrained ? ' · CAPPED' : ''}`,
    `${w.steps} steps · ${w.iterations} iter · ${w.shading}`,
    `${a.samples}/${a.cap} spp${a.converged ? ' · converged' : (a.accumulating ? ' · accumulating' : '')}`,
  ].join('\n');
}

function nowFrom(startedAt) {
  return typeof performance !== 'undefined' ? Math.max(0, performance.now() - startedAt) : 0;
}

export function installRendererDiagnostics(handle, canvas, options = {}) {
  if (!handle || !canvas) throw new TypeError('installRendererDiagnostics requires a renderer handle and canvas');
  const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
  const accumCap = options.accumCap ?? DEFAULT_ACCUM_CAP;
  let accumOn = options.accumOn ?? true;
  let history = [];
  let lastRung = handle.info?.rung ?? null;
  let lastMode = handle.info?.qualityMode ?? null;

  const addTransition = (from, to, reason, extra = {}) => {
    if (from === to && reason !== 'initialization') return;
    history = pushBounded(history, {
      atMs: nowFrom(startedAt),
      from,
      to,
      reason,
      model: MODEL_KEYS[handle.info?.fractalType] ?? `model-${handle.info?.fractalType ?? '?'}`,
      missRate: extra.missRate ?? null,
      ceiling: extra.ceiling ?? null,
    }, options.historyLimit ?? HISTORY_LIMIT);
    lastRung = to;
  };

  addTransition(null, lastRung, 'initialization');

  const onQualityEvent = (event) => {
    if (event.type === 'sample' && event.governor && event.beforeIndex !== event.governor.index) {
      addTransition(event.beforeIndex, event.governor.index, 'governor', {
        missRate: event.governor.missRate,
        ceiling: event.governor.ceiling,
      });
    } else if (event.type === 'showcase' && event.rung !== event.fromRung) {
      addTransition(event.fromRung, event.rung, 'showcase', {
        missRate: event.governor?.missRate,
        ceiling: event.governor?.ceiling,
      });
    } else if (event.type === 'limit') {
      const current = handle.info?.rung;
      if (Number.isFinite(current) && current > event.rungCap) {
        addTransition(current, event.rungCap, 'texture-limit');
      }
    }
  };
  let unsubscribe = null;
  let enabled = false;
  const setEnabled = (on) => {
    const want = !!on;
    if (want === enabled) return enabled;
    enabled = want;
    if (enabled) unsubscribe = subscribeQualityDiagnostics(onQualityEvent);
    else if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    return enabled;
  };
  setEnabled(!!options.enabled);

  // Track explicit mode and accumulation changes without touching renderer
  // internals. The original methods are still the only code that changes state.
  const originalSetQuality = handle.setQuality;
  if (typeof originalSetQuality === 'function') {
    handle.setQuality = (mode) => {
      const before = handle.info?.rung ?? lastRung;
      originalSetQuality.call(handle, mode);
      const after = handle.info?.rung ?? before;
      lastMode = mode;
      addTransition(before, after, `mode:${mode}`);
    };
  }
  const originalSetAccumulate = handle.setAccumulate;
  if (typeof originalSetAccumulate === 'function') {
    handle.setAccumulate = (on) => {
      accumOn = !!on;
      return originalSetAccumulate.call(handle, on);
    };
  }

  const snapshot = () => {
    const info = handle.info || {};
    // Reconcile changes that happened through another caller without inventing a
    // reason. This is history bookkeeping only and never touches quality state.
    if (Number.isFinite(info.rung) && info.rung !== lastRung) {
      addTransition(lastRung, info.rung, info.qualityMode === lastMode ? 'external' : `mode:${info.qualityMode}`);
    }
    lastMode = info.qualityMode;
    const telemetry = getQualityDiagnosticsState();
    return buildDiagnosticsSnapshot({
      info,
      canvas,
      telemetry,
      history,
      accumOn,
      accumCap,
      devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : null,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      platform: typeof navigator !== 'undefined' ? navigator.platform : null,
      language: typeof navigator !== 'undefined' ? navigator.language : null,
    });
  };

  const report = () => formatRendererReport(snapshot());
  handle.getDiagnostics = snapshot;
  handle.getRendererReport = report;

  return {
    snapshot,
    report,
    setEnabled,
    get enabled() { return enabled; },
    get history() { return cloneHistory(history); },
    destroy() {
      setEnabled(false);
      if (originalSetQuality) handle.setQuality = originalSetQuality;
      if (originalSetAccumulate) handle.setAccumulate = originalSetAccumulate;
      if (handle.getDiagnostics === snapshot) delete handle.getDiagnostics;
      if (handle.getRendererReport === report) delete handle.getRendererReport;
    },
  };
}
