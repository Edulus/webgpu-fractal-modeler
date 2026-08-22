from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'pattern not found in {path}: {old[:80]!r}')
    if s.count(old) != 1:
        raise SystemExit(f'pattern occurs {s.count(old)} times in {path}')
    p.write_text(s.replace(old, new, 1))

# camera.js: add pure conversion helpers for preserving a live camera pose/rate.
replace_once('src/camera.js', '''export function orbitBasis(yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return {
    dir: [cy * cp, sp, sy * cp],
    right: [-sy, 0, cy],
    up: [-cy * sp, cp, -sy * sp],
  };
}

/**
 * Yaw/pitch that points a camera at `pos` back towards the origin.
''', '''export function orbitBasis(yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return {
    dir: [cy * cp, sp, sy * cp],
    right: [-sy, 0, cy],
    up: [-cy * sp, cp, -sy * sp],
  };
}

/**
 * Recover the orbit-camera pose that exactly reproduces an eye/target view.
 * `dir` in orbitBasis points target -> eye, so yaw is atan2(z,x).
 * Returns null for a degenerate or non-finite view.
 */
export function orbitPoseFromView(eye, target) {
  if (!eye || !target || eye.length < 3 || target.length < 3) return null;
  const dx = Number(eye[0]) - Number(target[0]);
  const dy = Number(eye[1]) - Number(target[1]);
  const dz = Number(eye[2]) - Number(target[2]);
  if (![dx, dy, dz].every(Number.isFinite)) return null;
  const dist = Math.hypot(dx, dy, dz);
  if (!(dist > 1e-9)) return null;
  return {
    yaw: Math.atan2(dz, dx),
    pitch: Math.asin(clamp(dy / dist, -1, 1)),
    dist,
  };
}

/**
 * Angular velocity between two sampled orbit poses. Yaw uses the shortest
 * wrapped delta so crossing +/-PI does not manufacture a full-turn spike.
 * Samples are {yaw, pitch, t}, with t in milliseconds.
 */
export function orbitRatesFromSamples(prev, next) {
  if (!prev || !next) return [0, 0];
  const dt = (Number(next.t) - Number(prev.t)) / 1000;
  if (!(dt > 1e-4) || !Number.isFinite(dt)) return [0, 0];
  const a = Number(next.yaw) - Number(prev.yaw);
  const dp = Number(next.pitch) - Number(prev.pitch);
  if (!Number.isFinite(a) || !Number.isFinite(dp)) return [0, 0];
  const dy = Math.atan2(Math.sin(a), Math.cos(a));
  return [dy / dt, dp / dt];
}

/**
 * Yaw/pitch that points a camera at `pos` back towards the origin.
''')

# fractal-bg.js imports.
replace_once('src/fractal-bg.js', '''  usableClearance, orbitDragScale, pinchZoomFactor, pinchDollyDistance,
  orbitBasis, flickVelocity, FLICK_WINDOW_MS,
''', '''  usableClearance, orbitDragScale, pinchZoomFactor, pinchDollyDistance,
  orbitBasis, orbitPoseFromView, orbitRatesFromSamples, flickVelocity, FLICK_WINDOW_MS,
''')

# Track the target and measured landing-camera angular rate.
replace_once('src/fractal-bg.js', '''    lastCamPos: [0, 0, 3.2],
    // Clearance at the camera, read back from the GPU one frame late. Only the
''', '''    lastCamPos: [0, 0, 3.2],
    lastCamTarget: [0, 0, 0],
    // The landing/background camera follows a time-driven path. Keep its most
    // recent orbit-equivalent sample and angular rate so entering Shape Explorer
    // can continue the exact pose and motion already on screen instead of
    // jumping to the canned reset pose.
    backgroundOrbitSample: null,
    backgroundOrbitRate: [0, 0],
    // Clearance at the camera, read back from the GPU one frame late. Only the
''')

# Sample the actual landing view (including parallax and moving target) and save target.
replace_once('src/fractal-bg.js', '''    // Fractal parameter morphing.
    const power = rm ? 8.0 : 8.0 + Math.sin(t * 0.15) * 1.0; // breathe 7..9

    // resolution / time / dpr
''', '''    // Preserve the camera path as an orbit-equivalent pose while on the landing
    // view. This samples the ACTUAL rendered eye/target pair, so mouse parallax
    // and the tiny moving target are included rather than approximated.
    if (!state.fly && !state.explorer) {
      const pose = orbitPoseFromView([camX, camY, camZ], [tgtX, tgtY, tgtZ]);
      if (pose) {
        const sample = { yaw: pose.yaw, pitch: pose.pitch, t: nowMs };
        if (state.backgroundOrbitSample) {
          const [vyaw, vpitch] = orbitRatesFromSamples(state.backgroundOrbitSample, sample);
          state.backgroundOrbitRate[0] = vyaw;
          state.backgroundOrbitRate[1] = vpitch;
        }
        state.backgroundOrbitSample = sample;
      }
    }

    // Fractal parameter morphing.
    const power = rm ? 8.0 : 8.0 + Math.sin(t * 0.15) * 1.0; // breathe 7..9

    // resolution / time / dpr
''')

replace_once('src/fractal-bg.js', '''    state.lastCamPos[0] = camX;
    state.lastCamPos[1] = camY;
    state.lastCamPos[2] = camZ;
    d[U.fov] = 1.05; // radians

    d[U.camTarget] = tgtX;
''', '''    state.lastCamPos[0] = camX;
    state.lastCamPos[1] = camY;
    state.lastCamPos[2] = camZ;
    state.lastCamTarget[0] = tgtX;
    state.lastCamTarget[1] = tgtY;
    state.lastCamTarget[2] = tgtZ;
    d[U.fov] = 1.05; // radians

    d[U.camTarget] = tgtX;
''')

# Add the live-view adoption helper immediately before resetView.
replace_once('src/fractal-bg.js', '''  function resetView() {
    const o = state.orbit;
''', '''  function adoptCurrentViewAsOrbit() {
    const pose = orbitPoseFromView(state.lastCamPos, state.lastCamTarget);
    if (!pose) return false;

    const o = state.orbit;
    o.yaw = pose.yaw; o.tyaw = pose.yaw;
    o.pitch = pose.pitch; o.tpitch = pose.pitch;
    o.target[0] = state.lastCamTarget[0];
    o.target[1] = state.lastCamTarget[1];
    o.target[2] = state.lastCamTarget[2];
    o.dist = clampDist(pose.dist);
    o.pinned = false;

    // Continue the landing camera's instantaneous angular motion. Explorer's
    // normal momentum law takes over from here, so it begins at the same rate
    // and then naturally settles towards its subtle drift floor.
    const vyaw = Number(state.backgroundOrbitRate[0]) || 0;
    const vpitch = Number(state.backgroundOrbitRate[1]) || 0;
    o.vyaw = vyaw; o.vpitch = vpitch;
    if (Math.hypot(vyaw, vpitch) > 1e-6) {
      o.dyaw = vyaw; o.dpitch = vpitch;
    } else {
      o.dyaw = 0; o.dpitch = 0;
    }
    o.flickAt = 0;
    o.flickSamples = [];
    state.probeHit = -1;
    state.accumSamples = 0;
    state.lastInteract = performance.now();
    return true;
  }

  function resetView() {
    const o = state.orbit;
''')

# Replace Explorer entry reset with seamless adoption; keep Reset View as the reset.
replace_once('src/fractal-bg.js', '''    setExplorer(on) {
      state.explorer = !!on;
      if (state.explorer && state.fly) {
        state.fly = false;
        state.keys.clear();
      }
      applyCameraMode();
      resetView();
      nudgeRender();
    },
''', '''    setExplorer(on) {
      const want = !!on;
      if (want === state.explorer) return;

      // Capture the live landing pose BEFORE changing mode: applyCameraMode()
      // can render immediately, so adopting afterwards would already expose one
      // frame of the old canned Explorer pose. Palette state and colorPhase are
      // intentionally untouched; only camera-control ownership changes here.
      const continued = want ? adoptCurrentViewAsOrbit() : false;
      state.explorer = want;
      if (state.explorer && state.fly) {
        state.fly = false;
        state.keys.clear();
      }
      applyCameraMode();
      // A degenerate camera is extraordinarily unlikely, but retain the old
      // known-good starting pose as a safe fallback. Leaving Explorer also
      // resets its private orbit state; the landing camera has its own path.
      if ((want && !continued) || !want) resetView();
      nudgeRender();
    },
''')

# camera.test.js imports and focused handoff tests.
replace_once('tools/camera.test.js', '''  flyBasis, orbitBasis, flickVelocity, FLICK_WINDOW_MS, FLICK_MAX_RATE,
''', '''  flyBasis, orbitBasis, orbitPoseFromView, orbitRatesFromSamples,
  flickVelocity, FLICK_WINDOW_MS, FLICK_MAX_RATE,
''')

replace_once('tools/camera.test.js', '''console.log('\\naiming at the origin');
''', '''console.log('\\nlanding-to-explorer orbit handoff');
{
  for (const [yaw, pitch, dist, target] of [
    [0.2, 0.1, 2.55, [0, 0, 0]],
    [-2.4, 0.7, 4.2, [0.3, -0.2, 0.6]],
    [2.9, -1.2, 1.1, [-0.4, 0.5, -0.1]],
  ]) {
    const dir = orbitBasis(yaw, pitch).dir;
    const eye = target.map((v, i) => v + dir[i] * dist);
    const got = orbitPoseFromView(eye, target);
    check(`recovers exact pose at yaw ${yaw}`, !!got
      && near(got.dist, dist, 1e-9)
      && near(got.pitch, pitch, 1e-9)
      && near(Math.atan2(Math.sin(got.yaw - yaw), Math.cos(got.yaw - yaw)), 0, 1e-9));
  }

  const rate = orbitRatesFromSamples(
    { yaw: Math.PI - 0.01, pitch: 0.2, t: 1000 },
    { yaw: -Math.PI + 0.01, pitch: 0.23, t: 1100 });
  check('yaw rate crosses +/-PI by the short path', near(rate[0], 0.2, 1e-9));
  check('pitch rate is preserved', near(rate[1], 0.3, 1e-9));
  check('degenerate eye/target is rejected', orbitPoseFromView([1, 2, 3], [1, 2, 3]) === null);
}

console.log('\\naiming at the origin');
''')

print('seamless Explorer patch applied')
