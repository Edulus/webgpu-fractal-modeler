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
