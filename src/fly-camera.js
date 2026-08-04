// fly-camera.js — free-flight camera maths, kept pure and dependency-free.
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

// Travel speed in world units per second before the user's multiplier. Scaled
// by the model's orbit radius so one constant suits every world size.
export const FLY_BASE = 0.22;
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
 */
export function stepFlyCamera(cam, keys, dtSec, baseR) {
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
    let speed = FLY_BASE * baseR * cam.speed;
    if (keys.has('shift')) speed *= 3.0;
    if (keys.has('alt')) speed *= 0.25;
    // Clamp dt so a stalled tab or a very slow frame cannot teleport the
    // camera through a wall in one step.
    const step = speed * clamp(dtSec, 0.001, 0.1);
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
