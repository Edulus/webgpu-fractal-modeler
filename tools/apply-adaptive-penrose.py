from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


js_path = Path('src/fractal-bg.js')
shader_path = Path('src/shaders/fractal.wgsl.js')
index_path = Path('index.html')
readme_path = Path('README.md')

js = js_path.read_text()
shader = shader_path.read_text()
index = index_path.read_text()
readme = readme_path.read_text()

# ---------------------------------------------------------------------------
# JavaScript: device classification, model-specific resolution caps, live
# downgrade logic, and a low-tier frame-rate cap.
js = replace_once(js, '  _pad: 39,', '  performanceTier: 39,', 'uniform offset name')

js = replace_once(
    js,
    "    qualityMode: opts.quality, // 'low'|'medium'|'high'|'auto'\n"
    "    qualityScale: 1.0,\n"
    "    // runtime",
    "    qualityMode: opts.quality, // 'low'|'medium'|'high'|'auto'\n"
    "    qualityScale: 1.0,\n"
    "    deviceTier: 1,       // detected hardware class: 0 low, 1 medium, 2 high\n"
    "    performanceTier: 1,  // live Penrose complexity tier; may downgrade on slow FPS\n"
    "    // runtime",
    'state performance tiers')

js = replace_once(
    js,
    "    lastFrameTime: 0,\n"
    "    animTime: 0, // accumulated animation clock (respects reduced motion)",
    "    lastFrameTime: 0,\n"
    "    lastRenderTime: 0,\n"
    "    animTime: 0, // accumulated animation clock (respects reduced motion)",
    'last render time')

js = replace_once(
    js,
    "  const reducedMotionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');\n"
    "  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;\n\n"
    "  function reducedMotion() {\n"
    "    return reducedMotionMQ.matches;\n"
    "  }",
    "  const reducedMotionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');\n"
    "  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;\n"
    "  const hardwareThreads = Number(navigator.hardwareConcurrency) || 4;\n"
    "  const deviceMemory = Number(navigator.deviceMemory) || 8;\n\n"
    "  function reducedMotion() {\n"
    "    return reducedMotionMQ.matches;\n"
    "  }\n\n"
    "  function isPenroseSponge() {\n"
    "    return state.fractalType === FRACTAL_IDS['penrose-sponge'];\n"
    "  }\n\n"
    "  // A deliberately conservative hardware heuristic. Pointer type catches\n"
    "  // phones/tablets, while memory, logical cores, and physical pixel count\n"
    "  // separate modest laptops from desktop-class GPUs. Live FPS feedback can\n"
    "  // only lower this tier, preventing an optimistic guess from wedging a GPU.\n"
    "  function detectDeviceTier() {\n"
    "    const dpr = Math.min(window.devicePixelRatio || 1, 2);\n"
    "    const pixels = window.innerWidth * window.innerHeight * dpr * dpr;\n"
    "    if (coarsePointer || deviceMemory <= 4 || hardwareThreads <= 4 || pixels > 3200000) return 0;\n"
    "    if (deviceMemory <= 8 || hardwareThreads <= 8 || pixels > 1800000) return 1;\n"
    "    return 2;\n"
    "  }\n\n"
    "  function qualityCapForCurrentModel() {\n"
    "    if (!isPenroseSponge()) return 1.0;\n"
    "    return [0.24, 0.42, 0.72][state.performanceTier] ?? 0.24;\n"
    "  }\n\n"
    "  function requestedQualityScale() {\n"
    "    return state.qualityMode === 'auto'\n"
    "      ? pickAutoQuality()\n"
    "      : (QUALITY_SCALE[state.qualityMode] ?? 1.0);\n"
    "  }\n\n"
    "  function applyModelQuality(resizeTargets = true) {\n"
    "    const next = Math.min(requestedQualityScale(), qualityCapForCurrentModel());\n"
    "    const changed = Math.abs(next - state.qualityScale) > 0.001;\n"
    "    state.qualityScale = next;\n"
    "    if (changed && resizeTargets && state.device) resize();\n"
    "  }",
    'device heuristic helpers')

js = replace_once(
    js,
    "    d[U.glowStrength] = 1.0;\n"
    "    d[U.fogDensity] = 0.5;\n"
    "    d[U.shadowSoftness] = 12.0;\n"
    "    d[U.aoStrength] = 0.85;\n"
    "    d[U.qualityScale] = state.qualityScale;\n"
    "    d[U.bgMode] = state.transparent ? 0.0 : 1.0;\n"
    "    d[U.reducedMotion] = rm ? 1.0 : 0.0;\n"
    "    d[U._pad] = 0.0;",
    "    d[U.glowStrength] = isPenroseSponge() && state.performanceTier === 0 ? 0.55 : 1.0;\n"
    "    d[U.fogDensity] = 0.5;\n"
    "    d[U.shadowSoftness] = 12.0;\n"
    "    d[U.aoStrength] = 0.85;\n"
    "    d[U.qualityScale] = state.qualityScale;\n"
    "    d[U.bgMode] = state.transparent ? 0.0 : 1.0;\n"
    "    d[U.reducedMotion] = rm ? 1.0 : 0.0;\n"
    "    d[U.performanceTier] = state.performanceTier;",
    'uniform writes')

old_adapt = """  // ---- Adaptive quality (auto mode only) ----
  function adaptQuality(dtMs) {
    if (state.qualityMode !== 'auto') return;
    const fps = 1000 / Math.max(dtMs, 1);
    // EMA smoothing.
    state.fpsEMA = state.fpsEMA * 0.9 + fps * 0.1;

    if (state.fpsEMA < 50) {
      state.slowFrames++;
      state.fastFrames = 0;
    } else if (state.fpsEMA > 58) {
      state.fastFrames++;
      state.slowFrames = 0;
    } else {
      state.slowFrames = 0;
      state.fastFrames = 0;
    }

    const MIN_SCALE = 0.4;
    const MAX_SCALE = 1.0;

    // Hysteresis: require sustained slow/fast before changing.
    if (state.slowFrames > 45 && state.qualityScale > MIN_SCALE) {
      state.qualityScale = Math.max(MIN_SCALE, state.qualityScale - 0.15);
      state.slowFrames = 0;
      resize();
    } else if (state.fastFrames > 120 && state.qualityScale < MAX_SCALE) {
      state.qualityScale = Math.min(MAX_SCALE, state.qualityScale + 0.1);
      state.fastFrames = 0;
      resize();
    }
  }
"""
new_adapt = """  // ---- Adaptive quality and Penrose complexity ----------------------------
  function adaptQuality(dtMs) {
    const sponge = isPenroseSponge();
    if (state.qualityMode !== 'auto' && !sponge) return;

    const fps = 1000 / Math.max(dtMs, 1);
    state.fpsEMA = state.fpsEMA * 0.9 + fps * 0.1;

    const slowThreshold = sponge ? 28 : 50;
    const fastThreshold = sponge ? 46 : 58;
    if (state.fpsEMA < slowThreshold) {
      state.slowFrames++;
      state.fastFrames = 0;
    } else if (state.fpsEMA > fastThreshold) {
      state.fastFrames++;
      state.slowFrames = 0;
    } else {
      state.slowFrames = 0;
      state.fastFrames = 0;
    }

    const minScale = sponge ? 0.20 : 0.4;
    const maxScale = sponge ? qualityCapForCurrentModel() : 1.0;
    const slowLimit = sponge ? 10 : 45;
    const fastLimit = sponge ? 240 : 120;

    // Penrose first drops geometric complexity, then resolution. This reacts
    // quickly enough to avoid mobile GPU timeouts. Recovery is intentionally
    // conservative: resolution may rise, while complexity never rises during
    // the session without the user reselecting the model.
    if (state.slowFrames > slowLimit) {
      if (sponge && state.performanceTier > 0) {
        state.performanceTier--;
        state.qualityScale = Math.min(state.qualityScale, qualityCapForCurrentModel());
        resize();
      } else if (state.qualityMode === 'auto' && state.qualityScale > minScale) {
        state.qualityScale = Math.max(minScale, state.qualityScale - (sponge ? 0.06 : 0.15));
        resize();
      }
      state.slowFrames = 0;
    } else if (state.qualityMode === 'auto' &&
               state.fastFrames > fastLimit && state.qualityScale < maxScale) {
      state.qualityScale = Math.min(maxScale, state.qualityScale + (sponge ? 0.04 : 0.1));
      state.fastFrames = 0;
      resize();
    }
  }
"""
js = replace_once(js, old_adapt, new_adapt, 'adaptive quality function')

js = replace_once(
    js,
    "    const dt = state.lastFrameTime ? nowMs - state.lastFrameTime : 16.7;\n"
    "    state.lastFrameTime = nowMs;\n\n"
    "    if (!reducedMotion()) {",
    "    const dt = state.lastFrameTime ? nowMs - state.lastFrameTime : 16.7;\n"
    "    state.lastFrameTime = nowMs;\n\n"
    "    // Low-tier Penrose deliberately targets about 20 fps. Fewer submitted\n"
    "    // frames reduces sustained mobile GPU load without affecting controls.\n"
    "    if (isPenroseSponge() && state.performanceTier === 0 &&\n"
    "        nowMs - state.lastRenderTime < 50) {\n"
    "      state.rafId = requestAnimationFrame(loop);\n"
    "      return;\n"
    "    }\n\n"
    "    if (!reducedMotion()) {",
    'low tier frame cap')

js = replace_once(
    js,
    "    renderFrame(nowMs, false);\n"
    "    adaptQuality(dt);",
    "    renderFrame(nowMs, false);\n"
    "    state.lastRenderTime = nowMs;\n"
    "    adaptQuality(dt);",
    'record render time')

js = replace_once(
    js,
    "      console.warn('[fractal-bg] device lost:', info.message);\n"
    "      if (!state._reinitAttempted) {",
    "      console.warn('[fractal-bg] device lost:', info.message);\n"
    "      if (isPenroseSponge()) {\n"
    "        state.performanceTier = 0;\n"
    "        state.qualityScale = Math.min(state.qualityScale, 0.20);\n"
    "      }\n"
    "      if (!state._reinitAttempted) {",
    'device loss fallback')

js = replace_once(
    js,
    "    const device = await acquireDevice();\n"
    "    state.device = device;\n\n"
    "    // Device-lost handling",
    "    const device = await acquireDevice();\n"
    "    state.device = device;\n"
    "    const detectedTier = detectDeviceTier();\n"
    "    if (!isReinit) {\n"
    "      state.deviceTier = detectedTier;\n"
    "      state.performanceTier = detectedTier;\n"
    "    } else {\n"
    "      state.deviceTier = Math.min(state.deviceTier, detectedTier);\n"
    "      state.performanceTier = Math.min(state.performanceTier, state.deviceTier);\n"
    "    }\n\n"
    "    // Device-lost handling",
    'initialize device tier')

js = replace_once(
    js,
    "    // Pick starting quality tier.\n"
    "    if (state.qualityMode === 'auto') {\n"
    "      state.qualityScale = pickAutoQuality();\n"
    "    } else {\n"
    "      state.qualityScale = QUALITY_SCALE[state.qualityMode] ?? 1.0;\n"
    "    }",
    "    // Pick starting quality, then apply the active model's safe cap.\n"
    "    applyModelQuality(false);",
    'initial model quality')

js = replace_once(
    js,
    "        state.fractalType = FRACTAL_IDS[name];\n"
    "        // The attractor family needs its trajectory buffer built before use.\n"
    "        if (state.fractalType >= FRACTAL_IDS.attractor) ensureAttractorTrajectory();\n"
    "        if (!state.running) renderFrame(performance.now(), true);",
    "        state.fractalType = FRACTAL_IDS[name];\n"
    "        state.performanceTier = state.deviceTier;\n"
    "        state.slowFrames = 0;\n"
    "        state.fastFrames = 0;\n"
    "        state.lastRenderTime = 0;\n"
    "        applyModelQuality();\n"
    "        // The attractor family needs its trajectory buffer built before use.\n"
    "        if (state.fractalType >= FRACTAL_IDS.attractor) ensureAttractorTrajectory();\n"
    "        if (!state.running) renderFrame(performance.now(), true);",
    'setFractal model budget')

js = replace_once(
    js,
    "      state.qualityMode = mode;\n"
    "      if (mode === 'auto') state.qualityScale = pickAutoQuality();\n"
    "      else state.qualityScale = QUALITY_SCALE[mode] ?? 1.0;\n"
    "      resize();",
    "      state.qualityMode = mode;\n"
    "      applyModelQuality();",
    'setQuality model cap')

js = replace_once(
    js,
    "        fps: Math.round(state.fpsEMA),\n"
    "        reducedMotion: reducedMotion(),",
    "        fps: Math.round(state.fpsEMA),\n"
    "        performanceTier: state.performanceTier,\n"
    "        deviceTier: state.deviceTier,\n"
    "        reducedMotion: reducedMotion(),",
    'info tiers')

# ---------------------------------------------------------------------------
# WGSL: reuse the former padding slot as a tier uniform and compile three
# distinct Penrose workloads: two planes, three planes, and full hierarchy.
shader = replace_once(shader, '//   156 _pad         : f32',
                      '//   156 performanceTier: f32 (0=low, 1=medium, 2=high)',
                      'shader uniform comment')
shader = replace_once(shader, '  _pad         : f32,', '  performanceTier: f32,',
                      'shader uniform field')

start = shader.index('fn dePenroseSponge(pos : vec3<f32>) -> DEResult {')
end = shader.index('// Dispatch to the selected estimator.', start)
new_sponge = r'''fn dePenroseSponge(pos : vec3<f32>) -> DEResult {
  const R : f32 = 1.28;
  const SCALE : f32 = 0.18;
  const FINE_W : f32 = 0.030;
  const PARENT_W : f32 = 0.062;

  let host = length(pos) - R;
  var res : DEResult;
  if (host > 0.12) {
    res.dist = host;
    res.trap = 0.28;
    return res;
  }

  let tier = clamp(u.performanceTier, 0.0, 2.0);
  let animatePhason = tier > 0.5 && u.reducedMotion < 0.5;
  let tm = select(0.0, u.time, animatePhason);
  let drift = 0.075 * vec2<f32>(cos(tm * 0.041), sin(tm * 0.037));
  let phXY = drift;
  let phYZ = vec2<f32>(drift.y, -drift.x) + vec2<f32>(0.11, -0.07);
  let phZX = vec2<f32>(-drift.x - drift.y, drift.x) + vec2<f32>(-0.08, 0.13);

  let qXY = vec2<f32>(
    0.98480775 * pos.x - 0.17364818 * pos.y,
    0.17364818 * pos.x + 0.98480775 * pos.y) / SCALE;
  let qYZ = vec2<f32>(
    0.93232735 * pos.y - 0.36161543 * pos.z,
    0.36161543 * pos.y + 0.93232735 * pos.z) / SCALE;
  let qZX = vec2<f32>(
    0.81915204 * pos.z + 0.57357644 * pos.x,
   -0.57357644 * pos.z + 0.81915204 * pos.x) / SCALE;

  // Low tier: two Penrose projections form one family of volumetric tunnels.
  // Medium adds the third projection and its branching pairwise intersections.
  // High repeats all three at phi^2, restoring the full hierarchy.
  let childXY = penroseQuery(qXY, phXY);
  let childYZ = penroseQuery(qYZ, phYZ);
  let edgeXY = max(-childXY.sdf, 0.0) * SCALE;
  let edgeYZ = max(-childYZ.sdf, 0.0) * SCALE;

  var fineTunnels = max(edgeXY - FINE_W, edgeYZ - FINE_W);
  var kindMix = 0.5 * (childXY.kind + childYZ.kind);
  var perpMix = clamp(
    (length(childXY.perp) + length(childYZ.perp)) / 6.0, 0.0, 1.0);

  if (tier > 0.5) {
    let childZX = penroseQuery(qZX, phZX);
    let edgeZX = max(-childZX.sdf, 0.0) * SCALE;
    fineTunnels = penroseTunnelNetwork(edgeXY, edgeYZ, edgeZX, FINE_W);
    kindMix = (childXY.kind + childYZ.kind + childZX.kind) / 3.0;
    perpMix = clamp(
      (length(childXY.perp) + length(childYZ.perp) + length(childZX.perp)) / 9.0,
      0.0, 1.0);
  }

  var tunnels = fineTunnels;
  var hierarchy = 0.0;
  if (tier > 1.5) {
    let parentXY = penroseQuery(qXY / PHI2, phXY);
    let parentYZ = penroseQuery(qYZ / PHI2, phYZ);
    let parentZX = penroseQuery(qZX / PHI2, phZX);
    let parentEdgeXY = max(-parentXY.sdf, 0.0) * SCALE * PHI2;
    let parentEdgeYZ = max(-parentYZ.sdf, 0.0) * SCALE * PHI2;
    let parentEdgeZX = max(-parentZX.sdf, 0.0) * SCALE * PHI2;
    let parentTunnels = penroseTunnelNetwork(
      parentEdgeXY, parentEdgeYZ, parentEdgeZX, PARENT_W);
    tunnels = min(tunnels, parentTunnels);
    let parentPerp = clamp(
      (length(parentXY.perp) + length(parentYZ.perp) + length(parentZX.perp)) / 9.0,
      0.0, 1.0);
    perpMix = mix(perpMix, parentPerp, 0.65);
    hierarchy = clamp(
      1.0 - min(parentEdgeXY, min(parentEdgeYZ, parentEdgeZX)) / PARENT_W,
      0.0, 1.0);
  }

  var safety = select(0.31, 0.35, tier > 0.5);
  if (tier > 1.5) { safety = 0.38; }
  res.dist = max(host, -tunnels) * safety;
  res.trap = 0.10 + 0.38 * kindMix + 0.30 * perpMix + 0.22 * hierarchy;
  return res;
}

'''
shader = shader[:start] + new_sponge + shader[end:]

shader = replace_once(
    shader,
    "  const SH_STEPS : i32 = 40;\n"
    "  let activeSteps = select(40, 18, u.fractalType > 8.5 && u.fractalType < 9.5);",
    "  const SH_STEPS : i32 = 40;\n"
    "  var activeSteps = 40;\n"
    "  if (u.fractalType > 8.5 && u.fractalType < 9.5) {\n"
    "    activeSteps = select(0, 8, u.performanceTier > 0.5);\n"
    "    if (u.performanceTier > 1.5) { activeSteps = 14; }\n"
    "  }",
    'tiered shadows')

shader = replace_once(
    shader,
    "  const AO_STEPS : i32 = 5;\n"
    "  let activeSteps = select(5, 3, u.fractalType > 8.5 && u.fractalType < 9.5);",
    "  const AO_STEPS : i32 = 5;\n"
    "  var activeSteps = 5;\n"
    "  if (u.fractalType > 8.5 && u.fractalType < 9.5) {\n"
    "    activeSteps = select(0, 2, u.performanceTier > 0.5);\n"
    "    if (u.performanceTier > 1.5) { activeSteps = 3; }\n"
    "  }",
    'tiered AO')

shader = replace_once(
    shader,
    "  let hitEps = BASE_EPS * epsScale;\n\n"
    "  var t = 0.05;",
    "  let hitEps = BASE_EPS * epsScale;\n"
    "  let sponge = u.fractalType > 8.5 && u.fractalType < 9.5;\n"
    "  var activeMarchSteps = MAX_STEPS;\n"
    "  if (sponge) {\n"
    "    activeMarchSteps = select(56, 88, u.performanceTier > 0.5);\n"
    "    if (u.performanceTier > 1.5) { activeMarchSteps = 128; }\n"
    "  }\n\n"
    "  var t = 0.05;",
    'tiered march budget')

shader = replace_once(
    shader,
    "  for (var i = 0; i < MAX_STEPS; i = i + 1) {\n"
    "    let pos = ro + rd * t;",
    "  for (var i = 0; i < MAX_STEPS; i = i + 1) {\n"
    "    if (i >= activeMarchSteps) { break; }\n"
    "    let pos = ro + rd * t;",
    'march loop break')

shader = replace_once(
    shader,
    "    // Accumulate glow: how close we passed to the surface, weighted by 1/dist.\n"
    "    let near = exp(-d * 42.0);\n"
    "    glow = glow + near / (1.0 + t * t * 0.35);",
    "    // Skip the exponential near-miss glow on the lowest mobile tier.\n"
    "    if (!sponge || u.performanceTier > 0.5) {\n"
    "      let near = exp(-d * 42.0);\n"
    "      glow = glow + near / (1.0 + t * t * 0.35);\n"
    "    }",
    'low tier glow')

# ---------------------------------------------------------------------------
# Demo HUD and documentation.
index = replace_once(
    index,
    "      setInterval(() => {\n"
    "        const i = handle.info;\n"
    "        hud.textContent = `${names[i.fractalType]} · q${i.qualityScale} · ${i.fps}fps` +\n"
    "          (i.explorer ? ` · ${i.zoom}×` : '') +",
    "      const tiers = ['low', 'medium', 'high'];\n"
    "      setInterval(() => {\n"
    "        const i = handle.info;\n"
    "        hud.textContent = `${names[i.fractalType]} · q${i.qualityScale} · ${i.fps}fps` +\n"
    "          (i.fractalType === 9 ? ` · ${tiers[i.performanceTier]} complexity` : '') +\n"
    "          (i.explorer ? ` · ${i.zoom}×` : '') +",
    'HUD complexity tier')

readme = replace_once(
    readme,
    "The volumetric model evaluates independently phased Penrose tilings on the XY, YZ, and ZX planes. Each tile-edge field is extruded through the host volume, and the pairwise intersections of those sheets become branching tunnels. The same construction runs again at the φ² parent scale, producing broad passages that contain a finer self-similar network.\n\n"
    "A spherical host keeps the first implementation compact and fully explorable from every direction. The tunnels reach the exterior, exposing internal chambers and passages as the camera orbits and zooms. Phason drift changes all three quasicrystalline fields over time while preserving valid Penrose structure. Because this estimator performs six pentagrid queries per distance sample, its soft-shadow and ambient-occlusion sample counts are reduced specifically for this model.",
    "The volumetric model uses device-scaled workloads. Low-tier devices evaluate two Penrose projections to form a lightweight family of volumetric tunnels. Medium-tier devices add the third projection and its branching pairwise intersections. High-tier devices also evaluate all three projections at the φ² parent scale, restoring the broad passages and fine self-similar network together.\n\n"
    "A spherical host keeps the model compact and explorable from every direction. The renderer classifies the device from pointer type, memory, logical cores, and physical pixel count, then watches live FPS. Sustained slow rendering lowers geometric complexity before reducing resolution; the low tier also disables Penrose shadows and ambient occlusion, limits march steps, and targets roughly 20 fps. This allows the same model to range from a mobile-safe approximation to the complete six-query hierarchy.",
    'Penrose sponge docs')

readme = replace_once(
    readme,
    "Adaptive mode uses a rolling FPS estimate to adjust internal rendering resolution and raymarch epsilon. Hysteresis prevents constant quality changes. Coarse-pointer and small-viewport devices begin at a lower tier, while explicit quality settings pin the scale.",
    "Adaptive mode uses a rolling FPS estimate to adjust internal rendering resolution and raymarch epsilon. Hysteresis prevents constant quality changes. Penrose Sponge additionally selects low, medium, or high geometric complexity from device characteristics and can downgrade that complexity after sustained slow frames. Explicit quality settings remain subject to the model's device-safe resolution cap.",
    'adaptive quality docs')

js_path.write_text(js)
shader_path.write_text(shader)
index_path.write_text(index)
readme_path.write_text(readme)

print('Adaptive Penrose patch applied.')
