// camera.js — camera rate maths for both navigation modes, kept pure and
// dependency-free.
//
// The orbit camera in fractal-bg.js derives its position from an angle and a
// fixed radius about the origin, which is fine for a bounded object but cannot
// enter one. This module supplies the other mode: a free position with a look
// direction decoupled from the origin, so a viewer can travel through the
// triply periodic and inversion-generated models rather than circling them.
//
// Everything here is a plain function over plain objects — no WebGPU, no DOM —
// so the navigation can be tested without a GPU. That matters: the renderer
// only integrates movement inside its frame callback, which makes the camera
// untestable in any environment that cannot hold a WebGPU device.
//
// The recurring problem both modes share is that these fractals have no
// characteristic size. Any rate written as a fixed number of world units or
// radians is only correct at one distance, and feels violent everywhere closer.
// Both scaling helpers below exist to cancel that.

export const FLY_SPEED_MIN = 0.15;
export const FLY_SPEED_MAX = 12.0;

// Stop just short of vertical: at exactly +/-PI/2 the yaw axis degenerates and
// the horizontal basis vector is undefined.
export const MAX_PITCH = 1.5;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Camera basis for a yaw/pitch pair. Mirrors the shader's convention exactly:
 * right = cross(worldUp, forward), with yaw 0 looking down +Z.
 * @returns {{forward: number[], right: number[]}}
 */
export function flyBasis(yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  // right is cross((0,1,0), forward) = (forward.z, 0, -forward.x), normalised;
  // the common factor of cos(pitch) divides out.
  return { forward: [cp * sy, sp, cp * cy], right: [cy, 0, -sy] };
}

/**
 * Yaw/pitch that points a camera at `pos` back towards the origin.
 * @returns {{yaw: number, pitch: number}}
 */
export function aimAtOrigin(pos) {
  const d = Math.hypot(pos[0], pos[1], pos[2]) || 1;
  return {
    pitch: Math.asin(clamp(-pos[1] / d, -1, 1)),
    yaw: Math.atan2(-pos[0], -pos[2]),
  };
}

/**
 * Create a fly camera placed at `pos`, facing the origin.
 */
export function makeFlyCamera(pos) {
  const { yaw, pitch } = aimAtOrigin(pos);
  return {
    pos: [pos[0], pos[1], pos[2]],
    yaw, pitch, tyaw: yaw, tpitch: pitch,
    speed: 1.0,
  };
}

/**
 * Advance one frame: ease the look angles towards their drag targets, then
 * integrate held-key movement. Mutates `cam` and returns the forward vector so
 * the caller can build a look-at target from it.
 *
 * @param {object} cam    from makeFlyCamera
 * @param {Set<string>} keys  held keys: w a s d q e, plus shift / alt
 * @param {number} dtSec  seconds since the last frame
 * @param {number} baseR  the model's orbit radius, used to scale speed
 * @param {number} [speedScale=1]  proximity factor, see proximitySpeedScale
 */
export function stepFlyCamera(cam, keys, dtSec, baseR, clearance = null) {
  // Easing matches the orbit camera so a flick of the pointer glides rather
  // than snapping.
  cam.pitch += (cam.tpitch - cam.pitch) * 0.25;
  cam.yaw += (cam.tyaw - cam.yaw) * 0.25;
  cam.pitch = clamp(cam.pitch, -MAX_PITCH, MAX_PITCH);

  const { forward, right } = flyBasis(cam.yaw, cam.pitch);

  const held = (a, b) => (keys.has(a) ? 1 : 0) - (keys.has(b) ? 1 : 0);
  const mf = held('w', 's');
  const ms = held('d', 'a');
  const mu = held('e', 'q');

  if (mf || ms || mu) {
    let mult = cam.speed;
    if (keys.has('shift')) mult *= 3.0;
    if (keys.has('alt')) mult *= 0.25;
    // dt is clamped inside travelDistance, so a stalled tab cannot teleport the
    // camera through a wall in one step.
    const gap = clearance === null ? CLEAR_MAX * Math.max(baseR, 1e-3) : clearance;
    const step = travelDistance(gap, dtSec, mult);
    cam.pos[0] += (forward[0] * mf + right[0] * ms) * step;
    // Vertical travel uses world up, not camera up: holding E while looking
    // down should still rise, which is what a viewer expects.
    cam.pos[1] += (forward[1] * mf + mu) * step;
    cam.pos[2] += (forward[2] * mf + right[2] * ms) * step;
  }
  return forward;
}

/**
 * Move along the current view direction by `amount` world units. Used by the
 * two-finger gesture, where a pinch has no zoom to apply.
 */
export function dollyFlyCamera(cam, amount) {
  const { forward } = flyBasis(cam.yaw, cam.pitch);
  cam.pos[0] += forward[0] * amount;
  cam.pos[1] += forward[1] * amount;
  cam.pos[2] += forward[2] * amount;
}

/** Apply a pointer drag to the look targets. */
export function aimFlyCamera(cam, dYaw, dPitch) {
  cam.tyaw += dYaw;
  cam.tpitch = clamp(cam.tpitch + dPitch, -MAX_PITCH, MAX_PITCH);
}

/** Multiply travel speed, clamped to the usable range. */
export function scaleFlySpeed(cam, factor) {
  cam.speed = clamp(cam.speed * factor, FLY_SPEED_MIN, FLY_SPEED_MAX);
}

// ---- Rate scaling ---------------------------------------------------------

// Clearance bounds, as fractions of the model's orbit radius. The floor keeps a
// camera buried in a wall able to leave; the ceiling stops open space turning
// into a bolt.
export const CLEAR_MIN = 0.004;
export const CLEAR_MAX = 0.45;

// Fraction of the remaining gap covered per second at full speed. 0.7 halves the
// distance to a surface roughly every second.
export const TRAVEL_K = 0.7;

/**
 * Usable clearance at the camera, clamped into the band above.
 *
 * The absolute value matters — in fly mode the camera can be inside solid
 * material, where the estimate goes negative. Using |d| there still scales by
 * the distance to the nearest surface, so it stays possible to travel back out.
 * A missing reading (no probe yet, or a model with no estimator) falls back to
 * the ceiling rather than to zero, so navigation never simply freezes.
 */
export function usableClearance(dist, baseR) {
  const r = Math.max(baseR, 1e-3);
  if (!Number.isFinite(dist)) return CLEAR_MAX * r;
  return clamp(Math.abs(dist), CLEAR_MIN * r, CLEAR_MAX * r);
}

/**
 * Distance to travel this frame, integrated exponentially.
 *
 * Movement covers a fixed FRACTION of the available gap per second rather than
 * a fixed number of world units, so it feels identical at every scale. Writing
 * it as `gap * (1 - exp(-k*dt))` rather than `speed * dt` buys two things: it is
 * exactly frame-rate independent, where the linear form makes a 30fps machine
 * travel a different distance than a 60fps one for the same held key; and the
 * approach is asymptotic, so closing on a surface slows without ever crossing it
 * in a single step.
 *
 * @param {number} clearance  usable clearance (see usableClearance)
 * @param {number} dtSec      seconds since the last frame
 * @param {number} mult       user speed multiplier
 */
export function travelDistance(clearance, dtSec, mult = 1) {
  const dt = clamp(dtSec, 0, 0.1) * Math.max(mult, 0);
  return clearance * (1 - Math.exp(-TRAVEL_K * dt));
}

// ---- Orbit momentum -------------------------------------------------------

// The angular rate a drifting view settles at and never falls below, in radians
// per second. About two degrees a second: a full turn takes three minutes, so
// it reads as the model being alive rather than as motion going somewhere.
export const DRIFT_RATE = 0.035;

// Seconds for a flick to shed half its excess speed on the way down to the
// drift rate.
export const MOMENTUM_HALFLIFE = 0.4;

/**
 * The floor a drifting velocity settles onto: the direction of the last
 * movement, at `rate`. A zero direction means nothing has been thrown yet, and
 * the floor is zero — a view that has never been dragged has no last movement
 * to retain, and stands still.
 */
export function driftFloor(vyaw, vpitch, rate = DRIFT_RATE) {
  const m = Math.hypot(vyaw, vpitch);
  if (!(m > 1e-12) || !Number.isFinite(m) || !Number.isFinite(rate)) return [0, 0];
  return [(vyaw / m) * rate, (vpitch / m) * rate];
}

/**
 * Decay a velocity towards `floor` rather than towards zero.
 *
 * Same exponential form as travelDistance and for the same reason: written as a
 * per-frame multiplier, a flick dies in a fixed number of FRAMES, so it lasts
 * twice as long on a 120Hz phone as on a 60Hz laptop. Anchored to a half-life in
 * seconds, a throw feels the same everywhere.
 */
export function decayMomentum(v, floor, dtSec) {
  if (!Number.isFinite(v)) return floor;
  const dt = clamp(dtSec, 0, 0.25);
  return floor + (v - floor) * Math.pow(0.5, dt / MOMENTUM_HALFLIFE);
}

// ---- Pinch gestures -------------------------------------------------------

// Below this separation (CSS px) the ratio between two readings stops meaning
// anything: two fingertips cannot really be closer than about this, so a
// smaller number is a mis-registration, and dividing by it produces an
// arbitrarily large factor.
export const PINCH_MIN_SEP = 40;

// Exponent on the separation ratio. 1.0 is raw direct manipulation, where the
// camera distance tracks finger separation exactly; on a phone that is far too
// hot, because the usable spread runs from roughly 60px to the width of the
// screen and hands that whole range onto one gesture. Halving the exponent
// halves the rate in log space: the same full spread now closes in by about
// 2.8x instead of 6.7x, and a second pinch continues smoothly from there.
export const PINCH_GAIN = 0.55;

// Ceiling on a single move event's factor. This is NOT the rate limiter — the
// factors telescope, so the total zoom depends only on where the fingers
// started and finished, not on how many events arrived. It is a guard against
// one discontinuous reading: a third finger landing, a fingertip lost and
// re-acquired, or a coalesced batch after a stall, any of which can make the
// separation jump by hundreds of pixels between consecutive events.
//
// So it has to sit above anything a hand can actually do, or it silently
// becomes a rate limiter and makes the gesture under-zoom on slow event
// streams. The worst honest case is a fast finger leaving the tightest usable
// pinch — separation off the floor, where relative change is largest. At this
// value the guard engages only past about 2.5x separation growth in a single
// event, which no pair of fingers produces.
export const PINCH_MAX_STEP = 1.7;

// Finger spread, in px, that corresponds to one full approach step in fly mode.
export const PINCH_DOLLY_PX = 260;

/**
 * Zoom factor for one pinch move event, from the previous and current finger
 * separations in CSS px. Fingers apart returns < 1 (closer in), together > 1.
 *
 * Deliberately incremental rather than anchored to the separation at gesture
 * start. An anchored form has to be evaluated against the distance the gesture
 * began with, which stops being the right frame of reference the moment the
 * pivot is re-pinned onto a surface mid-gesture; the incremental form composes
 * with re-pinning because each step is relative to wherever the camera now is.
 * The two agree exactly when nothing re-pins, since the ratios telescope.
 */
export function pinchZoomFactor(prevSep, curSep, gain = PINCH_GAIN) {
  if (!Number.isFinite(prevSep) || !Number.isFinite(curSep)) return 1;
  const a = Math.max(prevSep, PINCH_MIN_SEP);
  const b = Math.max(curSep, PINCH_MIN_SEP);
  if (!(a > 0) || !(b > 0)) return 1;
  return clamp(Math.pow(a / b, gain), 1 / PINCH_MAX_STEP, PINCH_MAX_STEP);
}

/**
 * World distance to dolly for one pinch move event in fly mode, given the
 * change in finger separation.
 *
 * Uses the same law as travelDistance for the same reason: a fixed number of
 * world units per pixel of spread is only correct at one scale. Hovering a
 * hundredth of a radius from a wall, a fixed step is many multiples of the
 * clearance and puts the camera straight through it, which is exactly the
 * "moves at light speed when zoomed in" complaint. A fraction of the remaining
 * gap approaches the surface without ever crossing it.
 */
export function pinchDollyDistance(clearance, deltaPx) {
  if (!Number.isFinite(deltaPx) || deltaPx === 0) return 0;
  const f = clamp(deltaPx / PINCH_DOLLY_PX, -1, 1);
  return Math.sign(f) * clearance * (1 - Math.exp(-Math.abs(f)));
}

export const DRAG_MIN = 0.06;
export const DRAG_MAX = 3.0;

/**
 * Orbit drag-rate factor for a given zoom.
 *
 * Orbiting by a fixed angle moves a surface feature across the screen by
 * roughly dtheta * R / (r - R), where r is the orbit radius and R the model's
 * half-size: the closer the camera, the more violent the same angular step.
 * Cancelling that means scaling the rate by the clearance (r - R).
 *
 * Orbit radius is baseR * zoom, and each model's baseR is chosen so the model
 * roughly fills the frame, which puts R near half of it. So clearance tracks
 * (zoom - 0.5), normalised here to give exactly 1.0 at the default zoom of 1.
 *
 * The floor matters because ZOOM_MIN lets the camera inside the model, where
 * clearance is negative and the linear law stops meaning anything. The ceiling
 * is comfort rather than theory: the law keeps growing as you pull away, but
 * beyond a few multiples the model is a speck and a drag would spin it wildly.
 */
export function orbitDragScale(zoom, pinned = false) {
  // A target pinned onto the surface is already the right pivot: the point under
  // the crosshair does not move at all as you orbit it, and its neighbours move
  // by the drag angle regardless of how close the eye sits. No correction is
  // needed, and applying one would make close inspection feel dead.
  //
  // The curve below is the fallback for an unpinned target — still parked at the
  // origin, so the camera is orbiting the centroid rather than the surface, and
  // a fixed angular step whips the view once it closes in.
  if (pinned) return 1;
  return clamp((zoom - 0.45) / 0.55, DRAG_MIN, DRAG_MAX);
}


// ---- Device-loss recovery ---------------------------------------------------
//
// A lost GPU device is usually transient -- a driver reset, a laptop switching
// GPUs, a tab backgrounded too long -- and re-initialising recovers it. What is
// NOT recoverable is losing the device again and again in quick succession.
//
// The first version of this recorded a single boolean the moment it re-tried
// and never cleared it, so the SECOND loss in a session was fatal however many
// hours apart the two were, and it reported "re-init failed" even though the
// earlier re-init had actually succeeded. The visible result was a hidden
// canvas and a "WebGPU unavailable" banner on a machine where WebGPU worked.
//
// Pure so it can be tested without a GPU, which is the whole difficulty with
// this path: a device loss cannot be provoked on demand.

/** Re-init attempts allowed inside one burst before giving up. */
export const MAX_REINITS = 3;
/** A device that survives this long is treated as recovered, not as failing. */
export const REINIT_RESET_MS = 60000;

/**
 * Decide what to do when the device is lost.
 *
 * @param {number} attempts  re-inits already made in the current burst
 * @param {number} aliveMs   how long the device lasted since it came up
 * @returns {{retry: boolean, attempts: number}} the decision, and the attempt
 *   count to carry forward -- reset to zero when the device had been alive long
 *   enough to count as recovered rather than failing.
 */
export function planDeviceLoss(attempts, aliveMs) {
  // Survived long enough that this is a fresh incident, not the same burst.
  if (aliveMs >= REINIT_RESET_MS) return { retry: true, attempts: 1 };
  if (attempts < MAX_REINITS) return { retry: true, attempts: attempts + 1 };
  return { retry: false, attempts };
}
