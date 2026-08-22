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
  flyBasis, orbitBasis, orbitPoseFromView, orbitRatesFromSamples,
  flickVelocity, FLICK_WINDOW_MS, FLICK_MAX_RATE,
  aimAtOrigin, MAX_PITCH, FLY_SPEED_MIN, FLY_SPEED_MAX,
  usableClearance, travelDistance, orbitDragScale,
  pinchZoomFactor, pinchDollyDistance, driftFloor, decayMomentum,
  CLEAR_MIN, CLEAR_MAX, TRAVEL_K, DRAG_MIN, DRAG_MAX,
  PINCH_MIN_SEP, PINCH_MAX_STEP, PINCH_GAIN, PINCH_DOLLY_PX,
  DRIFT_RATE, MOMENTUM_HALFLIFE,
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

console.log('\nlanding-to-explorer orbit handoff');
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

console.log('\npinch to zoom');
{
  check('no movement is no zoom', near(pinchZoomFactor(200, 200), 1));
  check('fingers apart zooms in', pinchZoomFactor(200, 260) < 1);
  check('fingers together zooms out', pinchZoomFactor(260, 200) > 1);
  check('the two directions are exact inverses',
        near(pinchZoomFactor(200, 260) * pinchZoomFactor(260, 200), 1, 1e-12));

  // The property that makes the gesture frame-rate independent: the factors
  // telescope, so the total zoom depends only on where the fingers started and
  // finished, never on how many move events the browser chose to deliver.
  const total = (steps) => {
    let f = 1, prev = 60;
    for (let i = 1; i <= steps; i++) {
      const cur = 60 + (380 - 60) * (i / steps);
      f *= pinchZoomFactor(prev, cur);
      prev = cur;
    }
    return f;
  };
  // The yardstick is the analytic total, not a single call spanning the whole
  // spread: one 60px-to-380px event would trip the discontinuity guard, which
  // no real gesture ever delivers in one go.
  const analytic = Math.pow(60 / 380, PINCH_GAIN);
  for (const n of [10, 40, 120, 400]) {
    check(`${n} events give the same total zoom`, near(total(n), analytic, 1e-9),
          `${total(n).toFixed(6)} vs ${analytic.toFixed(6)}`);
  }

  // Rate. A raw ratio hands the whole 60px-to-screen-width spread to a single
  // gesture, which is the "light speed" complaint; the gain tames it without
  // making a deliberate spread feel inert.
  check('a full spread is gentler than the raw ratio', analytic > 60 / 380);
  check('a full spread still does real work', analytic < 0.5 && analytic > 0.2,
        `${analytic.toFixed(3)}`);
  check('gain 1 is the raw ratio',
        near(pinchZoomFactor(200, 260, 1), 200 / 260, 1e-12));
  check('the shipped gain is below 1 (that is the whole point)', PINCH_GAIN < 1);

  // A single event must never be able to jump the camera, whatever the pointer
  // stream does — a third finger landing, or a coalesced batch after a stall.
  check('one absurd event is capped in',
        near(pinchZoomFactor(20, 4000), 1 / PINCH_MAX_STEP));
  check('one absurd event is capped out',
        near(pinchZoomFactor(4000, 20), PINCH_MAX_STEP));

  // ...but the cap must sit above anything a hand can do, or it stops being a
  // guard and starts quietly eating the gesture. 50px of separation change in
  // one event is a fast finger at 60Hz; from the tightest usable pinch, that is
  // still the largest honest step there is.
  check('a fast finger from a tight pinch is not capped',
        pinchZoomFactor(PINCH_MIN_SEP, PINCH_MIN_SEP + 50) > 1 / PINCH_MAX_STEP);
  check('the cap needs the separation to roughly triple',
        pinchZoomFactor(100, 250) > 1 / PINCH_MAX_STEP &&
        near(pinchZoomFactor(100, 400), 1 / PINCH_MAX_STEP));

  // Degenerate separations: two fingertips cannot really be 2px apart, so a
  // reading like that is mis-registration, and dividing by it explodes.
  check('below the floor, both sides clamp to no zoom',
        near(pinchZoomFactor(1, 3), 1));
  check('the floor is one-sided', pinchZoomFactor(1, 400) < 1);
  check('floored ratio matches an explicit floor',
        near(pinchZoomFactor(5, 400), pinchZoomFactor(PINCH_MIN_SEP, 400)));
  for (const [a, b] of [[0, 100], [100, 0], [-5, 100], [NaN, 100],
                        [100, NaN], [Infinity, 100], [100, Infinity]]) {
    const f = pinchZoomFactor(a, b);
    check(`degenerate (${a}, ${b}) stays finite and bounded`,
          Number.isFinite(f) && f >= 1 / PINCH_MAX_STEP && f <= PINCH_MAX_STEP);
  }
}

console.log('\npinch to dolly (fly mode)');
{
  check('no spread is no travel', pinchDollyDistance(1, 0) === 0);
  check('spreading moves forward', pinchDollyDistance(1, 100) > 0);
  check('pinching moves back', pinchDollyDistance(1, -100) < 0);
  check('symmetric in direction',
        near(pinchDollyDistance(1, 80), -pinchDollyDistance(1, -80)));

  // The reason this exists: a fixed number of world units per pixel is only
  // correct at one scale. Scaling by the gap makes the same gesture cover the
  // same FRACTION of it whether the camera is a radius away or a thousandth.
  const frac = (c) => pinchDollyDistance(c, 120) / c;
  check('the same gesture covers the same fraction at every scale',
        near(frac(10), frac(0.001), 1e-12));

  // Never crosses the surface in one step, at any spread the screen allows.
  let crosses = false;
  for (let px = 1; px <= 4000; px += 7) {
    if (pinchDollyDistance(1, px) >= 1) crosses = true;
  }
  check('no single event covers the whole gap', !crosses);
  check('a full-screen spread is capped like a full one',
        near(pinchDollyDistance(1, PINCH_DOLLY_PX * 4),
             pinchDollyDistance(1, PINCH_DOLLY_PX)));
  check('a full step covers most of the gap, not all',
        pinchDollyDistance(1, PINCH_DOLLY_PX) > 0.5 &&
        pinchDollyDistance(1, PINCH_DOLLY_PX) < 0.7);
  for (const bad of [NaN, Infinity, -Infinity]) {
    check(`degenerate delta ${bad} travels nothing`,
          pinchDollyDistance(1, bad) === 0);
  }
}

console.log('\nflick velocity: event-rate and axis independent');
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

console.log('\norbit momentum: a throw that never quite dies');
{
  const mag = (a, b) => Math.hypot(a, b);

  check('a floor points where the movement went',
        near(mag(...driftFloor(3, 0)), DRIFT_RATE) && driftFloor(3, 0)[0] > 0);
  check('direction is preserved, magnitude is not',
        near(driftFloor(1, 1)[0], driftFloor(9, 9)[0]));
  check('sign is preserved both ways', driftFloor(-2, 0)[0] < 0);
  check('a diagonal throw drifts diagonally',
        near(driftFloor(1, 1)[0], driftFloor(1, 1)[1]));

  // Nothing thrown yet: there is no last movement to retain, so no drift.
  check('never dragged means no drift', driftFloor(0, 0).every((v) => v === 0));
  for (const bad of [[NaN, 0], [0, NaN], [Infinity, 1], [1e-300, 0]]) {
    check(`degenerate direction (${bad}) yields no drift`,
          driftFloor(...bad).every((v) => v === 0));
  }

  check('decay moves towards the floor, not past it',
        decayMomentum(1, DRIFT_RATE, 0.1) > DRIFT_RATE);
  // Two half-half-lives, because a single dt of MOMENTUM_HALFLIFE would be
  // clamped as an implausibly long frame.
  check('one half-life sheds half the excess',
        near(decayMomentum(decayMomentum(1, 0.2, MOMENTUM_HALFLIFE / 2),
                           0.2, MOMENTUM_HALFLIFE / 2), 0.6, 1e-9));
  check('dt of zero changes nothing', near(decayMomentum(0.5, 0, 0), 0.5));
  check('a stalled tab cannot skip the whole decay',
        near(decayMomentum(1, 0, 1e6), decayMomentum(1, 0, 0.25)));
  check('and one long frame cannot kill a throw outright',
        decayMomentum(1, 0, 20) > 0.5);

  // The property the feature is named for: after any finite time, a view that
  // was thrown is still moving — and at a rate that has stopped changing.
  let v = 2.4;                                  // a hard flick
  const floor = driftFloor(1, 0)[0];
  const dt = 1 / 60;
  const at = {};
  for (let i = 1; i <= 60 * 600; i++) {         // ten minutes of frames
    v = decayMomentum(v, floor, dt);
    if (i === 60 || i === 60 * 5 || i === 60 * 60) at[i / 60] = v;
  }
  check('a flick has calmed within a second', at[1] < 0.5 * 2.4);
  check('it has settled by five seconds', near(at[5], floor, 1e-3));
  check('ten minutes later it is still turning', v >= floor - 1e-12);
  check('and turning at exactly the drift rate', near(v, floor, 1e-12));

  // Frame rate must not change how long a throw lasts, or the same flick
  // decays twice as fast on a 120Hz phone as on a 60Hz laptop.
  const after = (hz, secs) => {
    let x = 2.4;
    for (let i = 0; i < hz * secs; i++) x = decayMomentum(x, floor, 1 / hz);
    return x;
  };
  check('60Hz and 120Hz agree after a second', near(after(60, 1), after(120, 1), 1e-6));
  check('30Hz agrees too', near(after(30, 1), after(60, 1), 1e-6));

  // Clearing the direction is the full stop. This is what double-tap does.
  let stopping = 1.0;
  for (let i = 0; i < 60 * 10; i++) stopping = decayMomentum(stopping, 0, dt);
  check('clearing the direction brings it to a genuine halt', stopping < 1e-6);

  // Scaling the floor by the drag scale keeps a close-in unpinned view calm.
  const closeFloor = driftFloor(1, 0, DRIFT_RATE * orbitDragScale(0.3, false))[0];
  check('drift is damped close in, unpinned', closeFloor < DRIFT_RATE * 0.2);
  check('drift is undamped on a pinned pivot',
        near(driftFloor(1, 0, DRIFT_RATE * orbitDragScale(0.3, true))[0], DRIFT_RATE));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
