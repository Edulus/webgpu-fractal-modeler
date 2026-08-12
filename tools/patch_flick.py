from pathlib import Path


def must_replace(text, old, new, count=1, label=None):
    n = text.count(old)
    if n < count:
        raise AssertionError(f"{label or 'replacement'}: expected at least {count}, found {n}: {old[:120]!r}")
    return text.replace(old, new, count)


# ---- camera.js: pure orbit basis + time-window flick estimator ----------------
p = Path("src/camera.js")
s = p.read_text()

anchor = """export function flyBasis(yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  // right is cross((0,1,0), forward) = (forward.z, 0, -forward.x), normalised;
  // the common factor of cos(pitch) divides out.
  return { forward: [cp * sy, sp, cp * cy], right: [cy, 0, -sy] };
}
"""
addition = anchor + """
/**
 * Pole-safe basis for the orbit camera.
 *
 * Unlike a world-up cross product, this stays defined as pitch passes through
 * +/-PI/2, so a vertical flick can carry the camera through a pole and continue
 * into a full end-over-end revolution. `dir` points target -> eye.
 */
export function orbitBasis(yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return {
    dir: [cy * cp, sp, sy * cp],
    right: [-sy, 0, cy],
    up: [-cy * sp, cp, -sy * sp],
  };
}
"""
s = must_replace(s, anchor, addition, label="orbitBasis insertion")

anchor = """export function decayMomentum(v, floor, dtSec) {
  if (!Number.isFinite(v)) return floor;
  const dt = clamp(dtSec, 0, 0.25);
  return floor + (v - floor) * Math.pow(0.5, dt / MOMENTUM_HALFLIFE);
}
"""
addition = anchor + """
// A release velocity should describe the gesture, not whichever single pointer
// event happened to arrive last. Browsers can deliver a 1000Hz mouse as tiny
// events, coalesce them, or leave the final few pixels for pointerup. Measuring
// a short trailing time window makes all three representations equivalent.
export const FLICK_WINDOW_MS = 72;
export const FLICK_MAX_RATE = 8.0;

/**
 * Angular release velocity from pointer samples `{x,y,t}`.
 * Returns [yawRate, pitchRate] in rad/s and caps the 2D vector as a whole.
 */
export function flickVelocity(samples, angularScale, maxRate = FLICK_MAX_RATE,
                              windowMs = FLICK_WINDOW_MS) {
  if (!Array.isArray(samples) || samples.length < 2 || !(angularScale > 0)) return [0, 0];
  const clean = samples.filter((q) =>
    q && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.t));
  if (clean.length < 2) return [0, 0];

  const last = clean[clean.length - 1];
  const cutoff = last.t - Math.max(1, Number(windowMs) || FLICK_WINDOW_MS);
  let first = clean[0];
  // Choose the oldest sample still inside the trailing window. Keeping at
  // least one earlier sample makes a release just after the boundary stable.
  for (let i = clean.length - 2; i >= 0; i--) {
    first = clean[i];
    if (first.t <= cutoff) break;
  }
  const dtMs = last.t - first.t;
  // Sub-millisecond intervals are polling noise, not a trustworthy gesture.
  if (!(dtMs >= 2)) return [0, 0];

  let yaw = (last.x - first.x) * angularScale * (1000 / dtMs);
  let pitch = (last.y - first.y) * angularScale * (1000 / dtMs);
  const mag = Math.hypot(yaw, pitch);
  const cap = Math.max(0, Number(maxRate) || 0);
  if (cap > 0 && mag > cap) {
    const k = cap / mag;
    yaw *= k; pitch *= k;
  }
  return [yaw, pitch];
}
"""
s = must_replace(s, anchor, addition, label="flickVelocity insertion")
p.write_text(s)


# ---- fractal-bg.js: continuous vertical orbit and robust gesture sampling -----
p = Path("src/fractal-bg.js")
s = p.read_text()

s = must_replace(
    s,
    """  makeFlyCamera, stepFlyCamera, aimFlyCamera, dollyFlyCamera, scaleFlySpeed,
  usableClearance, orbitDragScale, pinchZoomFactor, pinchDollyDistance,
  driftFloor, decayMomentum, DRIFT_RATE, FLY_SPEED_MIN, FLY_SPEED_MAX,
""",
    """  makeFlyCamera, stepFlyCamera, aimFlyCamera, dollyFlyCamera, scaleFlySpeed,
  usableClearance, orbitDragScale, pinchZoomFactor, pinchDollyDistance,
  orbitBasis, flickVelocity, FLICK_WINDOW_MS,
  driftFloor, decayMomentum, DRIFT_RATE, FLY_SPEED_MIN, FLY_SPEED_MAX,
""",
    label="camera imports")

s = must_replace(
    s,
    """      flickAt: 0,
      target: [0, 0, 0],
""",
    """      flickAt: 0,
      flickSamples: [],
      target: [0, 0, 0],
""",
    label="flick sample state")

s = must_replace(
    s,
    """    let camX, camY, camZ;
    let tgtX = 0, tgtY = rm ? 0.0 : Math.sin(t * 0.05) * 0.05, tgtZ = 0;
""",
    """    let camX, camY, camZ;
    let camUpX = 0, camUpY = 1, camUpZ = 0;
    let tgtX = 0, tgtY = rm ? 0.0 : Math.sin(t * 0.05) * 0.05, tgtZ = 0;
""",
    label="camera up locals")

old = """      if (!rm && state.pointers.size === 0) {
        const dt = Math.min(state.frameDt / 1000, 0.1);
        // The floor is scaled the same way a drag is, so a drift that is barely
        // perceptible framing the whole model does not become a sweep once the
        // camera is close to an unpinned centroid.
        const scale = orbitDragScale(o.dist / baseR, o.pinned);
        const [fy, fp] = driftFloor(o.dyaw, o.dpitch, DRIFT_RATE * scale);
        o.vyaw = decayMomentum(o.vyaw, fy, dt);
        o.vpitch = decayMomentum(o.vpitch, fp, dt);
        o.tyaw += o.vyaw * dt;
        o.tpitch += o.vpitch * dt;
        // Bounce off the poles. Without this a drift with any vertical
        // component parks against the pitch clamp and dies there, which is
        // exactly the full stop the drift exists to avoid.
        if (o.tpitch > 1.45 || o.tpitch < -1.45) {
          o.dpitch = -o.dpitch;
          o.vpitch = -o.vpitch;
        }
      } else if (rm) {
        o.vyaw = 0; o.vpitch = 0;
      }
      o.tpitch = Math.max(-1.45, Math.min(1.45, o.tpitch));
      o.yaw += (o.tyaw - o.yaw) * 0.18;
      o.pitch += (o.tpitch - o.pitch) * 0.18;
      o.pitch = Math.max(-1.45, Math.min(1.45, o.pitch));
      const cp = Math.cos(o.pitch);
      // dir points target -> eye, so the eye rides a sphere about the pivot.
      const dir = orbitDir(o);
      camX = o.target[0] + dir[0] * o.dist;
      camY = o.target[1] + dir[1] * o.dist;
      camZ = o.target[2] + dir[2] * o.dist;
      tgtX = o.target[0]; tgtY = o.target[1]; tgtZ = o.target[2];
"""
new = """      if (state.pointers.size === 0) {
        const dt = Math.min(state.frameDt / 1000, 0.1);
        // Reduced-motion suppresses automatic animation, but a flick is direct,
        // intentional input. Once the user throws the shape, honour that motion
        // on the same terms as a drag instead of silently zeroing it.
        const scale = orbitDragScale(o.dist / baseR, o.pinned);
        const [fy, fp] = driftFloor(o.dyaw, o.dpitch, DRIFT_RATE * scale);
        o.vyaw = decayMomentum(o.vyaw, fy, dt);
        o.vpitch = decayMomentum(o.vpitch, fp, dt);
        o.tyaw += o.vyaw * dt;
        o.tpitch += o.vpitch * dt;
      }
      o.yaw += (o.tyaw - o.yaw) * 0.18;
      o.pitch += (o.tpitch - o.pitch) * 0.18;

      // Pitch is deliberately unbounded. The pole-safe basis keeps camera roll
      // continuous at +/-PI/2, so a vertical throw can make complete revolutions
      // just as yaw already can horizontally.
      const frame = orbitBasis(o.yaw, o.pitch);
      const dir = frame.dir;
      camUpX = frame.up[0]; camUpY = frame.up[1]; camUpZ = frame.up[2];
      camX = o.target[0] + dir[0] * o.dist;
      camY = o.target[1] + dir[1] * o.dist;
      camZ = o.target[2] + dir[2] * o.dist;
      tgtX = o.target[0]; tgtY = o.target[1]; tgtZ = o.target[2];
"""
s = must_replace(s, old, new, label="continuous orbit integration")

s = must_replace(
    s,
    """    d[U.detail] = rg.steps;
    d[U.detail + 1] = rg.iters;
    d[U.detail + 2] = rg.shade;
    d[U.detail + 3] = 0;
""",
    """    d[U.detail] = rg.steps;
    d[U.detail + 1] = rg.iters;
    d[U.detail + 2] = rg.shade;
    // Spare slot: Shape Viewer yaw, wrapped to [-PI,PI]. The shader uses it to
    // build a pole-safe screen basis. 10 is a sentinel for the ordinary
    // world-up camera path used outside the orbit viewer.
    d[U.detail + 3] = (state.explorer && !state.fly)
      ? Math.atan2(Math.sin(state.orbit.yaw), Math.cos(state.orbit.yaw))
      : 10;
""",
    label="orbit yaw uniform")

s = must_replace(
    s,
    """    mat4LookAt(_view, [camX, camY, camZ],
      [d[U.camTarget], d[U.camTarget + 1], d[U.camTarget + 2]], [0, 1, 0]);
""",
    """    mat4LookAt(_view, [camX, camY, camZ],
      [d[U.camTarget], d[U.camTarget + 1], d[U.camTarget + 2]],
      [camUpX, camUpY, camUpZ]);
""",
    label="attractor pole-safe lookAt")

s = must_replace(
    s,
    """  // Flick sampling is time-normalised, so a fast 1000 Hz mouse and a 60 Hz
  // touchscreen impart comparable angular velocity for the same physical throw.
  const FLICK_MAX_RATE = 8.0;          // rad/s, safety cap (~1.27 turns/s)
  const FLICK_MIN_DT_MS = 1.0;         // reject sub-millisecond timing spikes
  const FLICK_MAX_DT_MS = 80.0;        // stale samples are not treated as speed
  const FLICK_SMOOTH_MS = 24.0;        // velocity EMA time constant
  const FLICK_RELEASE_GRACE_MS = 110;  // pause longer than this kills the throw
""",
    """  // Release velocity is measured over a short real-time gesture window in
  // camera.js. That makes a 1000Hz mouse, coalesced desktop events and a 60Hz
  // touchscreen describe the same physical throw.
  const FLICK_RELEASE_GRACE_MS = 120;  // pause longer than this kills the throw
""",
    label="flick constants")

s = must_replace(
    s,
    """  function orbitDir(o) {
    const cp = Math.cos(o.pitch);
    return [Math.cos(o.yaw) * cp, Math.sin(o.pitch), Math.sin(o.yaw) * cp];
  }
""",
    """  function orbitDir(o) {
    return orbitBasis(o.yaw, o.pitch).dir;
  }

  function gestureTime(e) {
    const t = Number(e && e.timeStamp);
    // PointerEvent.timeStamp shares performance.now()'s monotonic clock in
    // modern browsers. Fall back for older WebViews that expose a non-finite one.
    return Number.isFinite(t) ? t : performance.now();
  }

  function appendFlickSamples(e) {
    if (!e || state.fly) return;
    let events = [];
    try {
      if (typeof e.getCoalescedEvents === 'function') events = e.getCoalescedEvents() || [];
    } catch (_) {}
    if (!events.length) events = [e];

    for (const q of events) {
      const sample = { x: q.clientX, y: q.clientY, t: gestureTime(q) };
      const last = state.orbit.flickSamples[state.orbit.flickSamples.length - 1];
      if (!last || sample.t > last.t || sample.x !== last.x || sample.y !== last.y) {
        state.orbit.flickSamples.push(sample);
      }
    }
    const last = state.orbit.flickSamples[state.orbit.flickSamples.length - 1];
    if (!last) return;
    const cutoff = last.t - FLICK_WINDOW_MS * 2;
    while (state.orbit.flickSamples.length > 2
        && state.orbit.flickSamples[1].t < cutoff) {
      state.orbit.flickSamples.shift();
    }
  }

  function orbitPointerScale() {
    const k = 3.2 / Math.max(300, Math.min(window.innerWidth, window.innerHeight));
    const baseR = CAM_RADIUS[state.fractalType] ?? 2.55;
    return k * orbitDragScale(state.orbit.dist / baseR, state.orbit.pinned);
  }

  function updateFlickVelocity() {
    const [vyaw, vpitch] = flickVelocity(state.orbit.flickSamples, orbitPointerScale());
    state.orbit.vyaw = vyaw;
    state.orbit.vpitch = vpitch;
    return Math.hypot(vyaw, vpitch);
  }
""",
    label="gesture helpers")

s = must_replace(
    s,
    """    return state.explorer && !state.fly && !reducedMotion()
           && (state.orbit.dyaw !== 0 || state.orbit.dpitch !== 0);
""",
    """    return state.explorer && !state.fly
           && (state.orbit.dyaw !== 0 || state.orbit.dpitch !== 0);
""",
    label="reduced motion drift accounting")

s = must_replace(
    s,
    """    const now = performance.now();
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now });
""",
    """    const now = performance.now();
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: gestureTime(e) });
""",
    label="pointerdown timestamp")

s = must_replace(
    s,
    """        state.orbit.vyaw = 0; state.orbit.vpitch = 0; state.orbit.flickAt = 0;
""",
    """        state.orbit.vyaw = 0; state.orbit.vpitch = 0; state.orbit.flickAt = 0;
        state.orbit.flickSamples = [];
        appendFlickSamples(e);
""",
    count=1,
    label="seed flick history on pointerdown")

needle = """        state.orbit.vyaw = 0; state.orbit.vpitch = 0; state.orbit.flickAt = 0;
"""
idx = s.find(needle, s.find("if (state.pointers.size >= 2)"))
if idx < 0:
    raise AssertionError("pinch velocity reset not found")
s = s[:idx] + needle.rstrip("\n") + "\n        state.orbit.flickSamples = [];\n" + s[idx+len(needle):]

old = """    const prev = state.pointers.get(e.pointerId);
    const now = performance.now();
    const elapsed = prev.t == null ? 16.7 : now - prev.t;
    const dtMs = Math.max(FLICK_MIN_DT_MS, Math.min(FLICK_MAX_DT_MS, elapsed));
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now });
"""
new = """    const prev = state.pointers.get(e.pointerId);
    const now = performance.now();
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: gestureTime(e) });
    if (state.pointers.size === 1 && !state.fly) appendFlickSamples(e);
"""
s = must_replace(s, old, new, label="pointermove event-time history")

old = """      const baseR = CAM_RADIUS[state.fractalType] ?? 2.55;
      const ok = k * orbitDragScale(state.orbit.dist / baseR, state.orbit.pinned);
      state.orbit.tyaw += dx * ok;
      state.orbit.tpitch += dy * ok;
      // Sample angular velocity in rad/s from distance / elapsed time rather
      // than distance / pointer event. That makes an energetic flick energetic
      // on both high-polling mice and lower-rate touchscreens. Smooth the samples
      // over a short real-time window, then cap the vector to prevent one noisy
      // event from launching an unusably fast spin.
      let sampleYaw = dx * ok * (1000 / dtMs);
      let samplePitch = dy * ok * (1000 / dtMs);
      const sampleMag = Math.hypot(sampleYaw, samplePitch);
      if (sampleMag > FLICK_MAX_RATE) {
        const s = FLICK_MAX_RATE / sampleMag;
        sampleYaw *= s; samplePitch *= s;
      }
      const w = 1 - Math.exp(-dtMs / FLICK_SMOOTH_MS);
      state.orbit.vyaw += (sampleYaw - state.orbit.vyaw) * w;
      state.orbit.vpitch += (samplePitch - state.orbit.vpitch) * w;
      if (dx || dy) {
        state.orbit.dyaw = state.orbit.vyaw;
        state.orbit.dpitch = state.orbit.vpitch;
        state.orbit.flickAt = now;
      }
"""
new = """      const ok = orbitPointerScale();
      state.orbit.tyaw += dx * ok;
      state.orbit.tpitch += dy * ok;
      // Estimate the gesture over a short TIME window. This deliberately uses
      // coalesced samples and later also pointerup, so high-poll mice do not
      // produce a stream of tiny velocities that vanish at release.
      const speed = updateFlickVelocity();
      if (dx || dy) {
        if (speed > 0) {
          state.orbit.dyaw = state.orbit.vyaw;
          state.orbit.dpitch = state.orbit.vpitch;
        }
        state.orbit.flickAt = now;
      }
"""
s = must_replace(s, old, new, label="history-based flick sampling")

s = must_replace(
    s,
    """    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    state.pointers.delete(e.pointerId);
    state.lastInteract = now;
""",
    """    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!state.fly && state.pointers.size === 1) {
      const prev = state.pointers.get(e.pointerId);
      appendFlickSamples(e);
      const speed = updateFlickVelocity();
      if (prev && (e.clientX !== prev.x || e.clientY !== prev.y)) {
        if (speed > 0) {
          state.orbit.dyaw = state.orbit.vyaw;
          state.orbit.dpitch = state.orbit.vpitch;
        }
        state.orbit.flickAt = now;
      }
    }
    state.pointers.delete(e.pointerId);
    state.lastInteract = now;
""",
    label="pointerup final sample")

s = must_replace(
    s,
    """        state.orbit.vyaw = 0; state.orbit.vpitch = 0; state.orbit.flickAt = 0;
      }
    } else if (state.pointers.size === 0) {
""",
    """        state.orbit.vyaw = 0; state.orbit.vpitch = 0; state.orbit.flickAt = 0;
        state.orbit.flickSamples = [{ x: remaining.x, y: remaining.y, t: gestureTime(e) }];
      }
    } else if (state.pointers.size === 0) {
""",
    label="pinch-to-drag history reset")

s = s.replace(
    """    o.vyaw = 0; o.vpitch = 0; o.dyaw = 0; o.dpitch = 0; o.flickAt = 0;
""",
    """    o.vyaw = 0; o.vpitch = 0; o.dyaw = 0; o.dpitch = 0; o.flickAt = 0; o.flickSamples = [];
""",
    2)
if s.count("o.flickSamples = [];") < 2:
    raise AssertionError("freeze/reset flick history clears not inserted twice")

p.write_text(s)


# ---- shader: use orbit yaw for a pole-safe screen basis -----------------------
p = Path("src/shaders/fractal.wgsl.js")
s = p.read_text()
old = """  let fwd = normalize(ta - ro);
  let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), fwd));
  let up = cross(fwd, right);
"""
new = """  let fwd = normalize(ta - ro);
  // detail.w carries Shape Viewer's wrapped yaw. It gives a screen-right vector
  // that remains defined at the north/south poles, allowing pitch to continue
  // through +/-PI/2. Outside Shape Viewer JS writes sentinel 10 and the original
  // world-up camera basis is preserved.
  var right : vec3<f32>;
  if (abs(u.detail.w) < 4.0) {
    right = vec3<f32>(-sin(u.detail.w), 0.0, cos(u.detail.w));
  } else {
    right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), fwd));
  }
  let up = cross(fwd, right);
"""
s = must_replace(s, old, new, label="shader pole-safe basis")
p.write_text(s)


# ---- camera tests -------------------------------------------------------------
p = Path("tools/camera.test.js")
s = p.read_text()
s = must_replace(
    s,
    """  makeFlyCamera, stepFlyCamera, aimFlyCamera, dollyFlyCamera, scaleFlySpeed,
  flyBasis, aimAtOrigin, MAX_PITCH, FLY_SPEED_MIN, FLY_SPEED_MAX,
""",
    """  makeFlyCamera, stepFlyCamera, aimFlyCamera, dollyFlyCamera, scaleFlySpeed,
  flyBasis, orbitBasis, flickVelocity, FLICK_WINDOW_MS, FLICK_MAX_RATE,
  aimAtOrigin, MAX_PITCH, FLY_SPEED_MIN, FLY_SPEED_MAX,
""",
    label="camera test imports")

marker = "orbit momentum: a throw that never quite dies"
tests = r"""console.log('\nflick velocity: event-rate and axis independent');
{
  const scale = 0.01;
  const gesture = (hz, dx, dy, ms = 60) => {
    const n = Math.max(2, Math.round(hz * ms / 1000));
    const samples = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      samples.push({ x: dx * f, y: dy * f, t: ms * f });
    }
    return flickVelocity(samples, scale);
  };

  const mouse = gesture(1000, 120, 0);
  const touch = gesture(60, 120, 0);
  check('1000Hz mouse and 60Hz touch give the same throw',
        near(mouse[0], touch[0], 1e-9), `${mouse[0]} vs ${touch[0]}`);

  const horizontal = gesture(120, 24, 0, 80);
  const vertical = gesture(120, 0, 24, 80);
  check('horizontal and vertical flicks have equal gain',
        near(Math.abs(horizontal[0]), Math.abs(vertical[1]), 1e-9));
  check('pure vertical has no yaw leakage', near(vertical[0], 0, 1e-12));
  check('pure horizontal has no pitch leakage', near(horizontal[1], 0, 1e-12));

  const diagonal = gesture(120, 1000, 1000, FLICK_WINDOW_MS);
  check('diagonal safety cap applies to the vector',
        near(Math.hypot(...diagonal), FLICK_MAX_RATE, 1e-9));

  check('sub-millisecond polling noise cannot launch a throw',
        flickVelocity([{x:0,y:0,t:0}, {x:100,y:0,t:1}], scale).every(v => v === 0));
}

console.log('\norbit basis: vertical revolutions are continuous');
{
  for (const pitch of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2, 2 * Math.PI]) {
    const b = orbitBasis(0.73, pitch);
    check(`basis finite at pitch ${pitch.toFixed(3)}`,
          [...b.dir, ...b.right, ...b.up].every(Number.isFinite));
    check(`basis unit at pitch ${pitch.toFixed(3)}`,
          near(len(b.dir), 1, 1e-9) && near(len(b.right), 1, 1e-9) && near(len(b.up), 1, 1e-9));
    check(`screen axes stay perpendicular at pitch ${pitch.toFixed(3)}`,
          near(dot(b.dir, b.right), 0, 1e-9) &&
          near(dot(b.dir, b.up), 0, 1e-9) &&
          near(dot(b.right, b.up), 0, 1e-9));
  }
  const a = orbitBasis(1.17, 0.35).dir;
  const b = orbitBasis(1.17, 0.35 + Math.PI * 2).dir;
  check('one full vertical revolution returns to the same eye direction',
        a.every((v, i) => near(v, b[i], 1e-9)));
}

"""
pos = s.find(marker)
if pos < 0:
    raise AssertionError("camera test insertion marker not found")
line_start = s.rfind("console.log", 0, pos)
if line_start < 0:
    raise AssertionError("camera test console.log anchor not found")
s = s[:line_start] + tests + s[line_start:]
p.write_text(s)

print("patch applied")
