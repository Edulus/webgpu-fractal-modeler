// Colour-cycle maths. Run: node tools/colorcycle.test.js
//
// A JS mirror of hueRotate() in composite.wgsl.js. The shader itself cannot be
// exercised here -- this environment loses the GPU device -- so the properties
// that make the cycle seamless are checked on the arithmetic instead.

const K = [0.57735027, 0.57735027, 0.57735027];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

function hueRotate(c, a) {
  const ca = Math.cos(a), sa = Math.sin(a), kc = cross(K, c), kd = dot(K, c);
  return [0,1,2].map(i => c[i]*ca + kc[i]*sa + K[i]*kd*(1-ca));
}

let passed = 0, failed = 0;
const check = (name, ok) => { if (ok) passed++; else { failed++; console.log(`  FAIL: ${name}`); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const nearV = (a, b, e = 1e-6) => a.every((x, i) => near(x, b[i], e));

const TAU = 2 * Math.PI;
const red = [1, 0, 0], grey = [0.5, 0.5, 0.5], mixed = [0.8, 0.3, 0.55];

// Seamlessness: a full turn must land exactly where it started, or the cycle
// visibly jumps once per period.
check('a full turn returns to the start', nearV(hueRotate(red, TAU), red, 1e-6));
check('and so does a full turn on a mixed colour', nearV(hueRotate(mixed, TAU), mixed, 1e-6));
check('zero rotation is the identity', nearV(hueRotate(mixed, 0), mixed));

// Rotating about grey fixes the achromatic axis, so greys, whites and blacks
// do not drift -- the background and the specular highlights stay neutral.
for (const a of [0.3, 1.1, 2.7, 5.0]) {
  check(`grey is fixed at ${a}`, nearV(hueRotate(grey, a), grey, 1e-6));
}
check('black is fixed', nearV(hueRotate([0,0,0], 1.3), [0,0,0]));

// The sum of channels is the projection onto grey, and rotation preserves it,
// so overall brightness holds steady as the hue travels.
for (const a of [0.5, 2.0, 4.4]) {
  check(`channel sum is preserved at ${a}`,
        near(mixed[0]+mixed[1]+mixed[2], hueRotate(mixed, a).reduce((s,x)=>s+x,0), 1e-6));
}

// A third of a turn permutes the axes exactly: red -> green -> blue.
check('a third of a turn permutes RGB', nearV(hueRotate(red, TAU/3), [0,1,0], 1e-6));
check('two thirds completes the permutation', nearV(hueRotate(red, 2*TAU/3), [0,0,1], 1e-6));

// Chromatic colours really do move, or the feature does nothing.
check('a chromatic colour actually changes', !nearV(hueRotate(red, 0.6), red, 1e-3));

// Saturated colours CAN leave the positive octant under this rotation, which
// would feed negative values into the tonemapper.
let negatives = 0;
for (let i = 0; i < 2000; i++) {
  const a = TAU * i / 2000;
  if (hueRotate(red, a).some(v => v < -1e-9)) negatives++;
}
check('saturated colours do go negative, so the shader must clamp', negatives > 0);

// What the shader actually applies: the rotation followed by a clamp to zero.
// Everything downstream -- acesFilm, then pow(col, 1/2.2) -- needs a
// non-negative base, and pow() of a negative is NaN.
const shaderRotate = (c, a) => hueRotate(c, a).map(v => Math.max(v, 0));
let bad = 0;
for (let i = 0; i < 2000; i++) {
  const a = TAU * i / 2000;
  for (const c of [red, mixed, grey, [1,1,1], [0.05,0.9,0.2]]) {
    if (shaderRotate(c, a).some(v => !(v >= 0))) bad++;
  }
}
check('the clamped form is non-negative everywhere', bad === 0);
check('clamping leaves grey untouched', nearV(shaderRotate(grey, 2.0), grey, 1e-6));
check('and still returns to the start after a full turn',
      nearV(shaderRotate(mixed, TAU), mixed, 1e-6));

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`(${negatives}/2000 angles drive a channel negative for pure red)`);
process.exit(failed ? 1 : 0);
