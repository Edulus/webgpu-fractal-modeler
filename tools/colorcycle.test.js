// Colour maths of the composite pass. Run: node tools/colorcycle.test.js
//
// A JS mirror of hueRotate() and the image-adjustment chain in
// composite.wgsl.js. The shader itself cannot be exercised here -- this
// environment loses the GPU device -- so the properties that make the cycle
// seamless, and the sliders well-behaved, are checked on the arithmetic.

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

// ---- Image adjustments -----------------------------------------------------
// The rest of fs_composite, up to the vignette: exposure into the tonemapper,
// gamma, then saturation and contrast in display space.

const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const acesFilm = (c) => c.map((x) =>
  clamp01((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// Everything bar the contrast curve, which needs two values in display space.
function toDisplay(hdr, { exposure = 1, saturation = 1 } = {}, turns = 0) {
  let c = turns !== 0 ? hueRotate(hdr, TAU * turns).map((v) => Math.max(v, 0)) : hdr;
  c = acesFilm(c.map((v) => v * 1.05 * exposure)).map((v) => Math.pow(v, 1 / 2.2));
  const L = luma(c);
  return c.map((v) => L + (v - L) * saturation);
}

// Contrast pivots on the backdrop, not on mid-grey: the channel is rescaled to
// put the backdrop at 0 and white at 1, and an S-curve that fixes both ends is
// applied there.
function contrastCurve(c, bg, k) {
  return c.map((v, i) => {
    const span = Math.max(1 - bg[i], 1e-4);
    const x = (v - bg[i]) / span;
    if (!(x > 0)) return v;          // darker than the backdrop: left alone
    const xc = Math.min(x, 1);
    const a = Math.pow(xc, k), b = Math.pow(1 - xc, k);
    return bg[i] + span * (a / Math.max(a + b, 1e-6));
  });
}

// The backdrop the raymarch writes where nothing is hit: a very dark gradient
// in presentation mode, exactly black in transparent mode.
const BACKDROP = [0.0102, 0.0126, 0.0138];

// hue is in turns; phase is what the cycle contributes at this instant.
function adjust(hdr, opts = {}, phase = 0, bg = BACKDROP) {
  const { contrast = 1, hue = 0 } = opts;
  const turns = hue + phase;
  const c = toDisplay(hdr, opts, turns);
  return contrastCurve(c, toDisplay(bg, opts, turns), contrast).map((v) => Math.max(v, 0));
}

// The shipped defaults must leave the picture exactly as it was before the
// sliders existed, or every screenshot in the README is now wrong.
const oldChain = (hdr) => acesFilm(hdr.map((v) => v * 1.05)).map((v) => Math.pow(v, 1 / 2.2));
for (const c of [red, mixed, grey, [0.05, 0.9, 0.2], [2.4, 1.8, 0.3]]) {
  check(`neutral settings are the untouched chain for ${c}`, nearV(adjust(c), oldChain(c), 1e-12));
}

// Exposure sits BEFORE the tonemapper, which is what makes it roll off rather
// than clip: brighter always reads as brighter, and never leaves the display
// range even at the top of the slider.
let monotone = true, inRange = true;
for (const c of [mixed, [0.2, 0.4, 0.9], [1.5, 1.5, 1.5]]) {
  let prev = -1;
  for (let e = 0.2; e <= 3.0001; e += 0.05) {
    const out = adjust(c, { exposure: e });
    if (luma(out) < prev - 1e-9) monotone = false;
    if (out.some((v) => v > 1 + 1e-9)) inRange = false;
    prev = luma(out);
  }
}
check('brightness is monotone across its whole range', monotone);
check('and never pushes a channel past white', inRange);

// Saturation: 0 is the greyscale of the same picture, 1 changes nothing.
check('saturation 1 is the identity', nearV(adjust(mixed, { saturation: 1 }), adjust(mixed), 1e-12));
const flat = adjust(mixed, { saturation: 0 });
check('saturation 0 is achromatic', near(flat[0], flat[1]) && near(flat[1], flat[2]));
check('and holds the luminance it started from', near(luma(flat), luma(adjust(mixed)), 1e-6));

// Contrast pivots on the BACKDROP, which is the whole point of the curve: the
// space around the model must hold still while the model gains contrast.
// Mid-grey, which is what a photo editor pivots on, lifts a 0.06 backdrop to a
// flat grey at k<1 and crushes it to dead black at k>1.
const KS = [0.5, 0.7, 1, 1.3, 2, 3];
let bgDrift = 0, whiteDrift = 0;
for (const k of KS) {
  const bgOut = adjust(BACKDROP, { contrast: k });
  const ref = adjust(BACKDROP);
  bgDrift = Math.max(bgDrift, ...bgOut.map((v, i) => Math.abs(v - ref[i])));
  // ...and with the other three sliders moved as well, since the pivot has to
  // follow the backdrop through exposure, hue and saturation to stay on it.
  for (const o of [{ exposure: 2.2 }, { saturation: 0 }, { hue: 0.31 }]) {
    const a = adjust(BACKDROP, { ...o, contrast: k });
    const b = adjust(BACKDROP, o);
    bgDrift = Math.max(bgDrift, ...a.map((v, i) => Math.abs(v - b[i])));
  }
  const w = adjust([40, 40, 40], { contrast: k });   // far into the highlights
  whiteDrift = Math.max(whiteDrift, ...w.map((v) => Math.abs(v - 1)));
}
check('contrast leaves the backdrop exactly where it is', bgDrift < 1e-9);
check('and leaves white where it is', whiteDrift < 1e-6);

// The curve is an S about the middle of the model's own range: k > 1 steepens
// it, k < 1 flattens it, and both are monotone in the input, so no ordering of
// brightnesses is ever inverted.
const objMid = adjust([0.1441075, 0.1441075, 0.1441075]);
check('contrast > 1 pushes an upper mid-tone brighter',
      adjust([0.35, 0.35, 0.35], { contrast: 2 })[0] > adjust([0.35, 0.35, 0.35])[0]);
check('contrast > 1 pushes a lower mid-tone darker',
      adjust([0.05, 0.05, 0.05], { contrast: 2 })[0] < adjust([0.05, 0.05, 0.05])[0]);
check('contrast < 1 flattens towards the middle',
      adjust([0.35, 0.35, 0.35], { contrast: 0.6 })[0] < adjust([0.35, 0.35, 0.35])[0] &&
      adjust([0.05, 0.05, 0.05], { contrast: 0.6 })[0] > adjust([0.05, 0.05, 0.05])[0]);

let inv = 0, outOfRange = 0;
for (const k of KS) {
  let prev = -1;
  for (let v = 0; v <= 3.0001; v += 0.01) {
    const out = adjust([v, v, v], { contrast: k })[0];
    if (out < prev - 1e-9) inv++;
    if (out < 0 || out > 1 + 1e-9) outOfRange++;
    prev = out;
  }
}
check('contrast is monotone at every setting', inv === 0);
check('and cannot crush to black or blow out to white', outOfRange === 0);

// In transparent mode the raymarch writes black where nothing is hit, so the
// pivot is black and the same properties have to hold there.
const BLACK = [0, 0, 0];
let tDrift = 0;
for (const k of KS) {
  tDrift = Math.max(tDrift, adjust(BLACK, { contrast: k }, 0, BLACK)[0]);
}
check('black stays black in transparent mode', tDrift < 1e-9);
check('and the model still gains contrast there',
      adjust([0.35, 0.35, 0.35], { contrast: 2 }, 0, BLACK)[0] >
      adjust([0.35, 0.35, 0.35], {}, 0, BLACK)[0]);

// A crevice darker than the backdrop is passed through untouched rather than
// being raised to the backdrop's own brightness.
const deep = [0.002, 0.002, 0.002];
check('values below the backdrop are left alone',
      nearV(adjust(deep, { contrast: 2.5 }), adjust(deep), 1e-12));

// The hue slider and the cycle are added together, so one offsets the loop
// rather than overriding it -- and a whole turn of slider is no turn at all.
check('slider hue and cycle phase compose',
      nearV(adjust(mixed, { hue: 0.25 }), adjust(mixed, { hue: 0 }, 0.25), 1e-12));
check('a full turn of the hue slider is neutral',
      nearV(adjust(mixed, { hue: 1 }), adjust(mixed), 1e-6));

// Nothing anywhere in the parameter space may leave a negative channel: the
// gamma step is pow(), and pow() of a negative base is NaN -- black or garbage
// pixels rather than a merely wrong colour.
let neg = 0, nan = 0;
for (const c of [red, mixed, grey, [1, 1, 1], [0, 0, 0], [3, 0.1, 0.02]]) {
  for (const exposure of [0.2, 1, 3]) {
    for (const contrast of [0.5, 1, 2]) {
      for (const saturation of [0, 1, 2]) {
        for (let h = 0; h < 1; h += 0.05) {
          const out = adjust(c, { exposure, contrast, saturation, hue: h });
          if (out.some((v) => v < 0)) neg++;
          if (out.some((v) => Number.isNaN(v))) nan++;
        }
      }
    }
  }
}
check('no combination of the four sliders goes negative', neg === 0);
check('and none produces NaN', nan === 0);

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`(${negatives}/2000 angles drive a channel negative for pure red)`);
process.exit(failed ? 1 : 0);
