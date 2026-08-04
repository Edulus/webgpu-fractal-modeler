// Unit tests for the fly-through camera. Plain Node, no GPU and no DOM:
//
//   node tools/fly-camera.test.js
//
// The renderer only integrates movement inside its frame callback, so on any
// machine that cannot hold a WebGPU device the camera is otherwise impossible
// to exercise. Keeping the maths pure in src/fly-camera.js is what makes these
// checks possible.

import {
  makeFlyCamera, stepFlyCamera, aimFlyCamera, dollyFlyCamera, scaleFlySpeed,
  flyBasis, aimAtOrigin, MAX_PITCH, FLY_SPEED_MIN, FLY_SPEED_MAX,
} from '../src/fly-camera.js';

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

  // Distance travelled over one second should match FLY_BASE * baseR.
  const c2 = makeFlyCamera([0, 0, 3]);
  const p0 = c2.pos.slice();
  for (let i = 0; i < 60; i++) stepFlyCamera(c2, new Set(['w']), 1 / 60, 3.0);
  const travelled = Math.hypot(c2.pos[0] - p0[0], c2.pos[1] - p0[1], c2.pos[2] - p0[2]);
  check('one second of travel is FLY_BASE * baseR', near(travelled, 0.22 * 3.0, 1e-6),
        `travelled ${travelled.toFixed(4)}`);

  // S reverses W exactly.
  const c3 = makeFlyCamera([0, 0, 3]);
  const start = c3.pos.slice();
  for (let i = 0; i < 30; i++) stepFlyCamera(c3, new Set(['w']), 1 / 60, 3.0);
  for (let i = 0; i < 30; i++) stepFlyCamera(c3, new Set(['s']), 1 / 60, 3.0);
  check('S undoes W', near(c3.pos[2], start[2], 1e-9), `z ${c3.pos[2]} vs ${start[2]}`);

  // Opposed keys cancel.
  const c4 = makeFlyCamera([0, 0, 3]);
  for (let i = 0; i < 30; i++) stepFlyCamera(c4, new Set(['w', 's']), 1 / 60, 3.0);
  check('W+S cancel', near(c4.pos[2], 3, 1e-9));

  // Vertical uses world up, so it works while looking straight down.
  const c5 = makeFlyCamera([0, 0, 3]);
  c5.pitch = -MAX_PITCH; c5.tpitch = -MAX_PITCH;
  const y0 = c5.pos[1];
  for (let i = 0; i < 30; i++) stepFlyCamera(c5, new Set(['e']), 1 / 60, 3.0);
  check('E rises even when looking down', c5.pos[1] > y0 + 0.05);
  const y1 = c5.pos[1];
  for (let i = 0; i < 30; i++) stepFlyCamera(c5, new Set(['q']), 1 / 60, 3.0);
  check('Q descends', c5.pos[1] < y1 - 0.05);

  // Strafe is perpendicular to view and horizontal.
  const c6 = makeFlyCamera([0, 0, 3]);
  const s0 = c6.pos.slice();
  for (let i = 0; i < 30; i++) stepFlyCamera(c6, new Set(['d']), 1 / 60, 3.0);
  const delta = [c6.pos[0] - s0[0], c6.pos[1] - s0[1], c6.pos[2] - s0[2]];
  check('D moves sideways only', Math.abs(delta[0]) > 0.05 && near(delta[1], 0) && near(delta[2], 0, 1e-9),
        `delta [${delta.map((v) => v.toFixed(4))}]`);

  // Modifiers scale speed.
  const base = (keys2) => {
    const c = makeFlyCamera([0, 0, 3]);
    for (let i = 0; i < 60; i++) stepFlyCamera(c, keys2, 1 / 60, 3.0);
    return 3 - c.pos[2];
  };
  check('shift triples speed', near(base(new Set(['w', 'shift'])), base(new Set(['w'])) * 3, 1e-6));
  check('alt quarters speed', near(base(new Set(['w', 'alt'])), base(new Set(['w'])) * 0.25, 1e-6));

  // A stalled frame must not teleport the camera.
  const c7 = makeFlyCamera([0, 0, 3]);
  stepFlyCamera(c7, new Set(['w']), 30.0, 3.0);   // 30-second frame
  check('huge dt is clamped', 3 - c7.pos[2] <= 0.22 * 3.0 * 0.1 + 1e-9,
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
