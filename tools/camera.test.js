// Unit tests for the camera rate maths. Plain Node, no GPU and no DOM:
//
//   node tools/camera.test.js
//
// The renderer only integrates movement inside its frame callback, so on any
// machine that cannot hold a WebGPU device the camera is otherwise impossible
// to exercise. Keeping the maths pure in src/camera.js is what makes these
// checks possible.

import {
  makeFlyCamera, stepFlyCamera, aimFlyCamera, dollyFlyCamera, scaleFlySpeed,
  flyBasis, aimAtOrigin, MAX_PITCH, FLY_SPEED_MIN, FLY_SPEED_MAX,
  usableClearance, travelDistance, orbitDragScale,
  CLEAR_MIN, CLEAR_MAX, TRAVEL_K, DRAG_MIN, DRAG_MAX,
} from '../src/camera.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`); }
}
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }
function len(v) { return Math.hypot(v[0], v[1], v[2]); }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

console.log('\nbasis');
{
  const { forward, right } = flyBasis(0, 0);
  check('yaw 0 looks down +Z', near(forward[0], 0) && near(forward[1], 0) && near(forward[2], 1));
  check('right is +X when facing +Z', near(right[0], 1) && near(right[2], 0));

  for (const [yaw, pitch] of [[0.3, 0.2], [-1.1, 0.9], [2.7, -1.4], [5.0, 0.0]]) {
    const b = flyBasis(yaw, pitch);
    check(`forward is unit (yaw ${yaw}, pitch ${pitch})`, near(len(b.forward), 1, 1e-9));
    check(`right is unit (yaw ${yaw})`, near(len(b.right), 1, 1e-9));
    check(`right is horizontal (yaw ${yaw})`, near(b.right[1], 0));
    check(`right ⟂ forward (yaw ${yaw}, pitch ${pitch})`, near(dot(b.forward, b.right), 0, 1e-9));
  }
}

console.log('\naiming at the origin');
{
  for (const p of [[0, 0, 3], [2.7, 1.2, 1.9], [-1, -2, 0.5], [0, 4, 0], [0, -4, 0]]) {
    const { yaw, pitch } = aimAtOrigin(p);
    const { forward } = flyBasis(yaw, pitch);
    const d = len(p);
    const want = [-p[0] / d, -p[1] / d, -p[2] / d];
    const ok = near(forward[0], want[0], 1e-9) && near(forward[1], want[1], 1e-9)
            && near(forward[2], want[2], 1e-9);
    check(`forward points at origin from [${p}]`, ok,
          `got [${forward.map((v) => v.toFixed(3))}] want [${want.map((v) => v.toFixed(3))}]`);
  }
}

console.log('\nmovement');
{
  // Forward travel must close distance to whatever the camera faces.
  const cam = makeFlyCamera([0, 0, 3]);
  const before = len(cam.pos);
  const keys = new Set(['w']);
  for (let i = 0; i < 60; i++) stepFlyCamera(cam, keys, 1 / 60, 3.0);
  check('W approaches the origin', len(cam.pos) < before - 0.2,
        `${before.toFixed(3)} -> ${len(cam.pos).toFixed(3)}`);

  // stepFlyCamera is told the clearance; it does not track it. Holding it fixed
  // is the open-space case, where each frame covers the same slice.
  const c2 = makeFlyCamera([0, 0, 3]);
  const p0 = c2.pos.slice();
  for (let i = 0; i < 60; i++) stepFlyCamera(c2, new Set(['w']), 1 / 60, 3.0, 1.0);
  const travelled = Math.hypot(c2.pos[0] - p0[0], c2.pos[1] - p0[1], c2.pos[2] - p0[2]);
  check('constant clearance gives 60 equal slices',
        near(travelled, 60 * travelDistance(1.0, 1 / 60, 1), 1e-9),
        `travelled ${travelled.toFixed(6)}`);

  // S reverses W exactly.
  const c3 = makeFlyCamera([0, 0, 3]);
  const start = c3.pos.slice();
  for (let i = 0; i < 30; i++) stepFlyCamera(c3, new Set(['w']), 1 / 60, 3.0, 1.0);
  for (let i = 0; i < 30; i++) stepFlyCamera(c3, new Set(['s']), 1 / 60, 3.0, 1.0);
  check('S undoes W', near(c3.pos[2], start[2], 1e-9), `z ${c3.pos[2]} vs ${start[2]}`);

  // Opposed keys cancel.
  const c4 = makeFlyCamera([0, 0, 3]);
  for (let i = 0; i < 30; i++) stepFlyCamera(c4, new Set(['w', 's']), 1 / 60, 3.0, 1.0);
  check('W+S cancel', near(c4.pos[2], 3, 1e-9));

  // Vertical uses world up, so it works while looking straight down.
  const c5 = makeFlyCamera([0, 0, 3]);
  c5.pitch = -MAX_PITCH; c5.tpitch = -MAX_PITCH;
  const y0 = c5.pos[1];
  for (let i = 0; i < 30; i++) stepFlyCamera(c5, new Set(['e']), 1 / 60, 3.0, 1.0);
  check('E rises even when looking down', c5.pos[1] > y0 + 0.05);
  const y1 = c5.pos[1];
  for (let i = 0; i < 30; i++) stepFlyCamera(c5, new Set(['q']), 1 / 60, 3.0, 1.0);
  check('Q descends', c5.pos[1] < y1 - 0.05);

  // Strafe is perpendicular to view and horizontal.
  const c6 = makeFlyCamera([0, 0, 3]);
  const s0 = c6.pos.slice();
  for (let i = 0; i < 30; i++) stepFlyCamera(c6, new Set(['d']), 1 / 60, 3.0, 1.0);
  const delta = [c6.pos[0] - s0[0], c6.pos[1] - s0[1], c6.pos[2] - s0[2]];
  check('D moves sideways only', Math.abs(delta[0]) > 0.05 && near(delta[1], 0) && near(delta[2], 0, 1e-9),
        `delta [${delta.map((v) => v.toFixed(4))}]`);

  // Closing on a wall: the renderer re-reads clearance from the probe every
  // frame, so the gap shrinks as the camera advances. That feedback is what
  // makes the approach asymptotic, and the simulation has to model it.
  const approach = (keys2) => {
    const c = makeFlyCamera([0, 0, 3]);
    let gap = 1.0;
    for (let i = 0; i < 60; i++) {
      const before = c.pos[2];
      stepFlyCamera(c, keys2, 1 / 60, 3.0, gap);
      gap -= before - c.pos[2];
    }
    return 3 - c.pos[2];
  };
  check('shift covers more ground', approach(new Set(['w', 'shift'])) > approach(new Set(['w'])));
  check('alt covers less ground', approach(new Set(['w', 'alt'])) < approach(new Set(['w'])));
  // The safety property: no speed and no frame length reaches the surface.
  check('sprinting still never reaches the wall', approach(new Set(['w', 'shift'])) < 1.0,
        `covered ${approach(new Set(['w', 'shift'])).toFixed(4)} of a 1.0 gap`);

  // A stalled frame must not teleport the camera.
  const c7 = makeFlyCamera([0, 0, 3]);
  stepFlyCamera(c7, new Set(['w']), 30.0, 3.0, 1.0);   // 30-second frame
  check('huge dt is clamped', 3 - c7.pos[2] <= 1 - Math.exp(-TRAVEL_K * 0.1) + 1e-9,
        `moved ${(3 - c7.pos[2]).toFixed(4)}`);
}

console.log('\naim and speed');
{
  const cam = makeFlyCamera([0, 0, 3]);
  aimFlyCamera(cam, 0, 99);
  check('pitch target clamps up', near(cam.tpitch, MAX_PITCH));
  aimFlyCamera(cam, 0, -99);
  check('pitch target clamps down', near(cam.tpitch, -MAX_PITCH));

  // Easing converges on the target rather than snapping or overshooting.
  const c2 = makeFlyCamera([0, 0, 3]);
  c2.tyaw = c2.yaw + 1.0;
  const firstStep = (() => { stepFlyCamera(c2, new Set(), 1 / 60, 3); return c2.yaw; })();
  check('easing does not snap', firstStep < c2.tyaw - 0.5);
  for (let i = 0; i < 200; i++) stepFlyCamera(c2, new Set(), 1 / 60, 3);
  check('easing converges', near(c2.yaw, c2.tyaw, 1e-6));

  const c3 = makeFlyCamera([0, 0, 3]);
  for (let i = 0; i < 100; i++) scaleFlySpeed(c3, 0.87);
  check('speed floor holds', near(c3.speed, FLY_SPEED_MIN));
  for (let i = 0; i < 200; i++) scaleFlySpeed(c3, 1.15);
  check('speed ceiling holds', near(c3.speed, FLY_SPEED_MAX));

  const c4 = makeFlyCamera([0, 0, 3]);
  dollyFlyCamera(c4, 1.0);
  check('dolly moves along view', near(c4.pos[2], 2.0, 1e-9), `z ${c4.pos[2]}`);
}

console.log('\nrate scaling: clearance and exponential travel');
{
  const baseR = 3.2;

  // Clearance clamps: never zero (you must be able to leave a wall), never
  // unbounded (open space must not turn into a bolt).
  check('wall clamps to the floor',
        near(usableClearance(0, baseR), CLEAR_MIN * baseR));
  check('open space clamps to the ceiling',
        near(usableClearance(1e6, baseR), CLEAR_MAX * baseR));
  check('mid-range passes through', near(usableClearance(0.5, baseR), 0.5));

  // Inside solid material the estimate is negative; travel must still work or
  // the camera would be trapped in a wall.
  check('inside a wall is symmetric with outside',
        near(usableClearance(-0.3, baseR), usableClearance(0.3, baseR)));
  check('missing reading falls back to the ceiling, not zero',
        near(usableClearance(Infinity, baseR), CLEAR_MAX * baseR));
  check('NaN reading falls back to the ceiling',
        near(usableClearance(NaN, baseR), CLEAR_MAX * baseR));

  // The headline property of exponential integration: identical ground covered
  // regardless of frame rate. The linear form this replaced did not have it.
  const walk = (steps, dt) => {
    let gap = 1.0, acc = 0;
    for (let i = 0; i < steps; i++) {
      const s2 = travelDistance(gap, dt, 1);
      acc += s2; gap -= s2;
    }
    return acc;
  };
  const closed = 1 - Math.exp(-TRAVEL_K);
  check('60fps and 100fps cover the same ground', near(walk(60, 1 / 60), walk(100, 0.01), 1e-9));
  check('60fps and 20fps cover the same ground', near(walk(60, 1 / 60), walk(20, 0.05), 1e-9));
  check('matches the closed form 1-exp(-k*t)', near(walk(60, 1 / 60), closed, 1e-9),
        `${walk(60, 1 / 60).toFixed(9)} vs ${closed.toFixed(9)}`);

  // Asymptotic approach: one step never crosses the gap, at any frame length
  // and across the whole reachable speed range (FLY_SPEED_MAX, times the sprint
  // modifier). That is what makes crashing into a surface impossible.
  let crosses = false;
  for (const dt of [1 / 240, 1 / 60, 0.05, 0.1, 5, 100]) {
    for (const mult of [1, 3, 12, FLY_SPEED_MAX * 3]) {
      if (travelDistance(1.0, dt, mult) >= 1.0) crosses = true;
    }
  }
  check('a step never covers the whole gap at any reachable speed', !crosses);
  check('zero dt travels nothing', near(travelDistance(1.0, 0, 1), 0));
  check('travel grows with the multiplier',
        travelDistance(1, 1 / 60, 3) > travelDistance(1, 1 / 60, 1));
  check('travel grows with the gap',
        travelDistance(2, 1 / 60, 1) > travelDistance(1, 1 / 60, 1));
}

console.log('\nrate scaling: orbit drag vs zoom');
{
  let prev = -1;
  let monotonic = true;
  for (const z of [0.2, 0.4, 0.6, 0.8, 1.0, 1.5, 2, 3, 8, 14]) {
    const f = orbitDragScale(z);
    if (f < prev - 1e-12) monotonic = false;
    prev = f;
  }
  check('drag rate rises monotonically with zoom', monotonic);
  check('default zoom is unchanged (1.0x)', near(orbitDragScale(1), 1, 1e-12));
  check('zoomed in is much slower', orbitDragScale(0.3) < 0.15,
        `${orbitDragScale(0.3).toFixed(3)}`);
  check('deepest zoom clamps to the floor', near(orbitDragScale(0.2), DRAG_MIN));
  check('far zoom clamps to the ceiling', near(orbitDragScale(14), DRAG_MAX));
  check('never zero (still steerable up close)', orbitDragScale(0.2) > 0);

  // With the pivot pinned onto the surface, the point under the crosshair is
  // the point being orbited: it does not move at all, and its neighbours move
  // by the drag angle however close the eye sits. No correction is wanted, and
  // applying the unpinned curve would make close inspection feel dead.
  for (const z of [0.001, 0.05, 0.2, 1, 5, 14]) {
    check(`pinned pivot needs no damping (zoom ${z})`, orbitDragScale(z, true) === 1);
  }
  check('unpinned still damps', orbitDragScale(0.2, false) < 0.1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
