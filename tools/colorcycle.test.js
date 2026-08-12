// Palette-cycle and image-adjustment arithmetic. Run:
//
//   node tools/colorcycle.test.js
//
// The GPU path now accumulates palette-independent material and resolves the
// selected palette afterwards. These tests pin that contract: phase moves the
// palette coordinate, imported ramps remain cyclic, fixed-function weighted
// blending produces the same running mean as the old accumulation shader, and
// the explicit Hue slider remains a separate post-image adjustment.

import { readFileSync } from 'node:fs';
import { PALETTES } from '../src/palettes.js';
import { colorCycleMotionAllowed, colorCycleNeedsLoop } from '../src/fractal-bg.js';

const PI = Math.PI;
const TAU = 2 * PI;
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const nearV = (a, b, e = 1e-6) => a.length === b.length && a.every((x, i) => near(x, b[i], e));
const add = (a, b) => a.map((x, i) => x + b[i]);
const scale = (a, k) => a.map((x) => x * k);

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function cosinePalette(p, t) {
  return [0, 1, 2].map((i) => p.a[i] + p.b[i] * Math.cos(TAU * (p.c[i] * t + p.d[i])));
}

function fract(x) { return x - Math.floor(x); }
function rampColor(stops, t) {
  const n = stops.length;
  const x = fract(t) * n;
  const i0 = Math.floor(x) % n;
  const i1 = (i0 + 1) % n;
  const f = fract(x);
  return stops[i0].map((v, i) => v + (stops[i1][i] - v) * f);
}

// Material encoding mirrors fs_material:
// m = [baseIndex*baseWeight, baseWeight, neutralSpec, glow]
// a = [backgroundWeight, seamIndex*seamWeight, seamWeight, missWeight]
function resolveDE(m, a, palette, phase = 0, { bgMode = true, bg = [0.01, 0.015, 0.02] } = {}) {
  let c = scale(bg, a[0] + (bgMode ? a[3] : 0));
  if (m[1] > 1e-9) c = add(c, scale(palette(m[0] / m[1] + phase), m[1]));
  c = add(c, [m[2], m[2], m[2]]);
  if (a[2] > 1e-9) c = add(c, scale(palette(a[1] / a[2] + phase), a[2]));
  c = add(c, scale(palette(0.5 + phase), m[3] * 0.4));
  return c;
}

console.log('\ncolour-cycle motion policy');
{
  check('reduced motion suppresses the autonomous boot-time cycle',
        !colorCycleMotionAllowed(true, false));
  check('moving the slider explicitly opts colour motion back in',
        colorCycleMotionAllowed(true, true));
  check('normal motion allows cycling without an explicit opt-in',
        colorCycleMotionAllowed(false, false));
  check('reduced-motion static page can sleep before opt-in',
        !colorCycleNeedsLoop(true, false, false, 0.025));
  check('positive explicit slider rate keeps the reduced-motion page rendering',
        colorCycleNeedsLoop(true, false, true, 0.025));
  check('slider at zero lets a reduced-motion static page sleep again',
        !colorCycleNeedsLoop(true, false, true, 0));
  check('interactive viewer keeps rendering under reduced motion',
        colorCycleNeedsLoop(true, true, false, 0));
}

console.log('\nshader colour-cycle phase');
{
  const shaderSource = readFileSync(new URL('../src/shaders/composite.wgsl.js', import.meta.url), 'utf8');
  check('composite consumes the CPU-approved colour phase directly',
        shaderSource.includes('let phase = u.colorPhase;'));
  check('composite no longer suppresses colour phase under reduced motion',
        !shaderSource.includes('select(u.colorPhase, 0.0, u.reducedMotion'));
}

console.log('\npalette-coordinate cycling');
{
  const aurora = (t) => cosinePalette(PALETTES.aurora, t);
  const ember = (t) => cosinePalette(PALETTES.ember, t);
  const stops = [
    [0.10, 0.20, 0.80],
    [0.95, 0.30, 0.15],
    [0.95, 0.85, 0.20],
    [0.10, 0.75, 0.55],
  ];
  const ramp = (t) => rampColor(stops, t);

  const m = [0.42 * 0.83, 0.83, 0.07, 0.24];
  const a = [0.18, 1.13 * 0.22, 0.22, 0];

  // At phase zero, resolving the stored material must reproduce the algebra the
  // old raymarch performed before it baked RGB into the accumulation target.
  const oldStatic = add(
    add(
      add(scale(aurora(0.42), 0.83), [0.07, 0.07, 0.07]),
      scale(aurora(1.13), 0.22)),
    add(scale(aurora(0.5), 0.24 * 0.4), scale([0.01, 0.015, 0.02], 0.18)));
  check('phase zero reproduces the old static shading algebra',
        nearV(resolveDE(m, a, aurora, 0), oldStatic, 1e-12));

  // The defining new behavior: changing phase is exactly a change in the
  // palette lookup coordinate. No RGB-space transform is involved.
  const phase = 0.237;
  const expected = add(
    add(
      add(scale(aurora(0.42 + phase), 0.83), [0.07, 0.07, 0.07]),
      scale(aurora(1.13 + phase), 0.22)),
    add(scale(aurora(0.5 + phase), 0.24 * 0.4), scale([0.01, 0.015, 0.02], 0.18)));
  check('phase re-indexes the selected cosine palette',
        nearV(resolveDE(m, a, aurora, phase), expected, 1e-12));

  const emberExpected = add(
    add(
      add(scale(ember(0.42 + phase), 0.83), [0.07, 0.07, 0.07]),
      scale(ember(1.13 + phase), 0.22)),
    add(scale(ember(0.5 + phase), 0.24 * 0.4), scale([0.01, 0.015, 0.02], 0.18)));
  check('the same material can be recoloured with another preset',
        nearV(resolveDE(m, a, ember, phase), emberExpected, 1e-12));

  const rampExpected = add(
    add(
      add(scale(ramp(0.42 + phase), 0.83), [0.07, 0.07, 0.07]),
      scale(ramp(1.13 + phase), 0.22)),
    add(scale(ramp(0.5 + phase), 0.24 * 0.4), scale([0.01, 0.015, 0.02], 0.18)));
  check('the same material can be recoloured with an imported ramp',
        nearV(resolveDE(m, a, ramp, phase), rampExpected, 1e-12));

  // Imported ramps are explicitly cyclic: one palette-coordinate unit is one
  // complete loop, including across the last->first seam.
  for (const t of [-1.7, -0.01, 0, 0.23, 0.99, 1.44, 9.2]) {
    check(`imported ramp repeats after one unit at ${t}`,
          nearV(ramp(t), ramp(t + 1), 1e-12));
  }
  check('ramp seam is continuous from both sides',
        nearV(ramp(1 - 1e-8), ramp(0 - 1e-8), 1e-6));

  // Cosine presets with per-channel frequencies do not all have period 1.
  // The renderer therefore keeps phase unbounded rather than wrapping it at
  // each integer. Crossing phase=1 must be an ordinary tiny step, not a jump.
  for (const [name, p] of Object.entries(PALETTES)) {
    const t = 0.37;
    const left = cosinePalette(p, t + 0.99999);
    const right = cosinePalette(p, t + 1.00001);
    const delta = Math.max(...left.map((v, i) => Math.abs(v - right[i])));
    check(`${name} stays continuous through phase 1`, delta < 0.001);
  }

  // Opaque/transparent presentation is resolved from miss coverage after the
  // expensive material accumulation, so presentation mode need not re-march.
  const missM = [0, 0, 0, 0];
  const missA = [0, 0, 0, 1];
  check('opaque miss resolves to background',
        nearV(resolveDE(missM, missA, aurora, 0, { bgMode: true, bg: [0.1, 0.2, 0.3] }), [0.1, 0.2, 0.3]));
  check('transparent miss resolves to black',
        nearV(resolveDE(missM, missA, aurora, 0, { bgMode: false, bg: [0.1, 0.2, 0.3] }), [0, 0, 0]));
}

console.log('\nprogressive material accumulation');
{
  const samples = [
    [0.18, 0.6, 0.02, 0.1],
    [0.22, 0.7, 0.04, 0.2],
    [0.15, 0.5, 0.03, 0.0],
    [0.30, 0.8, 0.01, 0.3],
  ];
  let avg = [0, 0, 0, 0];
  for (let i = 0; i < samples.length; i++) {
    const w = 1 / (i + 1);
    avg = avg.map((v, k) => samples[i][k] * w + v * (1 - w));
    const direct = [0, 1, 2, 3].map((k) =>
      samples.slice(0, i + 1).reduce((sum, s) => sum + s[k], 0) / (i + 1));
    check(`blend constant produces arithmetic mean at sample ${i + 1}`, nearV(avg, direct, 1e-12));
  }

  // Weighted coordinates are essential at silhouettes: a miss has zero weight,
  // so it cannot pull the palette coordinate toward zero when jitter averages.
  const hit = [0.91 * 0.8, 0.8, 0, 0];
  const miss = [0, 0, 0, 0];
  const mixed = hit.map((v, i) => (v + miss[i]) / 2);
  check('a hit mixed with a miss keeps its palette coordinate', near(mixed[0] / mixed[1], 0.91));
}

console.log('\nattractor palette coordinates');
{
  function lineMaterial(t, intensity = 1, glow = 0.7) {
    const a = TAU * t;
    return {
      material: [t * intensity, intensity, intensity * glow, 0],
      aux: [Math.cos(a) * intensity, Math.sin(a) * intensity, intensity, 0],
    };
  }
  const x = lineMaterial(0.99);
  const y = lineMaterial(0.01);
  const m = add(x.material, y.material);
  const a = add(x.aux, y.aux);

  const linearT = m[0] / m[1];
  check('cosine palettes retain the unwrapped linear mean', near(linearT, 0.5), `t=${linearT}`);
  check('linear representation retains the summed line intensity', near(m[1], 2));
  check('line emission remains scalar and additive', near(m[2], 1.4));

  let circularT = Math.atan2(a[1], a[0]) / TAU;
  if (circularT < 0) circularT += 1;
  check('imported ramps average around the palette seam', circularT < 0.02 || circularT > 0.98, `t=${circularT}`);
  check('circular representation retains the summed line intensity', near(a[2], 2));
}

// ---- Explicit image adjustments ------------------------------------------
// Hue remains independent from palette cycling: cycling shifts palette
// coordinates before bloom; Hue is an optional RGB-space camera adjustment.
console.log('\nimage adjustments');
{
  const K = [0.57735027, 0.57735027, 0.57735027];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  function hueRotate(c, a) {
    const ca = Math.cos(a), sa = Math.sin(a), kc = cross(K, c), kd = dot(K, c);
    return [0, 1, 2].map((i) => c[i] * ca + kc[i] * sa + K[i] * kd * (1 - ca));
  }
  const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
  const acesFilm = (c) => c.map((x) => clamp01((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  function toDisplay(hdr, { exposure = 1, saturation = 1, hue = 0 } = {}) {
    let c = hue !== 0 ? hueRotate(hdr, TAU * hue).map((v) => Math.max(v, 0)) : [...hdr];
    c = acesFilm(c.map((v) => v * 1.05 * exposure)).map((v) => Math.pow(v, 1 / 2.2));
    const L = luma(c);
    return c.map((v) => L + (v - L) * saturation);
  }

  function contrastCurve(c, bg, k) {
    return c.map((v, i) => {
      const span = Math.max(1 - bg[i], 1e-4);
      const x = (v - bg[i]) / span;
      if (!(x > 0)) return v;
      const xc = Math.min(x, 1);
      const a = Math.pow(xc, k), b = Math.pow(1 - xc, k);
      return bg[i] + span * (a / Math.max(a + b, 1e-6));
    });
  }

  const BACKDROP = [0.0102, 0.0126, 0.0138];
  function adjust(hdr, opts = {}, bg = BACKDROP) {
    const { contrast = 1 } = opts;
    const c = toDisplay(hdr, opts);
    const pivot = toDisplay(bg, opts);
    return contrastCurve(c, pivot, contrast).map((v) => Math.max(v, 0));
  }

  const mixed = [0.8, 0.3, 0.55];
  const grey = [0.5, 0.5, 0.5];
  check('Hue zero is the identity before the tone chain', nearV(hueRotate(mixed, 0), mixed));
  check('a full Hue turn returns to the start', nearV(hueRotate(mixed, TAU), mixed, 1e-6));
  check('Hue leaves grey fixed', nearV(hueRotate(grey, 1.7), grey, 1e-6));

  const oldChain = (hdr) => acesFilm(hdr.map((v) => v * 1.05)).map((v) => Math.pow(v, 1 / 2.2));
  for (const c of [mixed, grey, [0.05, 0.9, 0.2], [2.4, 1.8, 0.3]]) {
    check(`neutral settings preserve the established tone chain for ${c}`, nearV(adjust(c), oldChain(c), 1e-12));
  }

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
  check('brightness remains monotone', monotone);
  check('brightness remains inside display white', inRange);

  const flat = adjust(mixed, { saturation: 0 });
  check('saturation zero is achromatic', near(flat[0], flat[1]) && near(flat[1], flat[2]));
  check('saturation zero preserves luminance', near(luma(flat), luma(adjust(mixed)), 1e-6));

  // Contrast is anchored to the backdrop after Hue/exposure/saturation. The
  // surrounding space therefore remains fixed while the model changes.
  const KS = [0.5, 0.7, 1, 1.3, 2, 3];
  let bgDrift = 0, whiteDrift = 0;
  for (const k of KS) {
    const bgOut = adjust(BACKDROP, { contrast: k });
    const ref = adjust(BACKDROP);
    bgDrift = Math.max(bgDrift, ...bgOut.map((v, i) => Math.abs(v - ref[i])));
    for (const o of [{ exposure: 2.2 }, { saturation: 0 }, { hue: 0.31 }]) {
      const a = adjust(BACKDROP, { ...o, contrast: k });
      const b = adjust(BACKDROP, o);
      bgDrift = Math.max(bgDrift, ...a.map((v, i) => Math.abs(v - b[i])));
    }
    const w = adjust([40, 40, 40], { contrast: k });
    whiteDrift = Math.max(whiteDrift, ...w.map((v) => Math.abs(v - 1)));
  }
  check('contrast leaves the backdrop exactly where it is', bgDrift < 1e-9);
  check('contrast leaves white exactly where it is', whiteDrift < 1e-6);

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
  check('contrast stays inside the display range', outOfRange === 0);

  const BLACK = [0, 0, 0];
  let blackDrift = 0;
  for (const k of KS) blackDrift = Math.max(blackDrift, adjust(BLACK, { contrast: k }, BLACK)[0]);
  check('black stays black in transparent mode', blackDrift < 1e-9);
  check('the model still gains contrast in transparent mode',
        adjust([0.35, 0.35, 0.35], { contrast: 2 }, BLACK)[0] >
        adjust([0.35, 0.35, 0.35], {}, BLACK)[0]);

  const deep = [0.002, 0.002, 0.002];
  check('values below the backdrop are left alone',
        nearV(adjust(deep, { contrast: 2.5 }), adjust(deep), 1e-12));

  // Hue has its own post-image semantics; palette phase was already tested in
  // resolveDE above and never enters this function.
  check('a full Hue turn is neutral', nearV(adjust(mixed, { hue: 1 }), adjust(mixed), 1e-6));

  let neg = 0, nan = 0;
  for (const c of [[1, 0, 0], mixed, grey, [0, 0, 0], [3, 0.1, 0.02]]) {
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
  check('no image-control combination goes negative', neg === 0);
  check('no image-control combination produces NaN', nan === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
