import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const FEATURE = 'origin/agent/palette-faithful-cycle';

function fromFeature(path) {
  return execFileSync('git', ['show', `${FEATURE}:${path}`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

function replaceOnce(text, oldText, newText, label) {
  if (text.includes(newText)) return text;
  const i = text.indexOf(oldText);
  if (i < 0) throw new Error(`missing integration target: ${label}`);
  if (text.indexOf(oldText, i + oldText.length) >= 0) throw new Error(`non-unique integration target: ${label}`);
  return text.slice(0, i) + newText + text.slice(i + oldText.length);
}

// Files whose palette-branch versions do not overlap the newer main commit.
for (const path of [
  'src/fractal-bg.js',
  'src/shaders/material.wgsl.js',
  'src/shaders/attractor.wgsl.js',
  'tools/shader-check.html',
]) {
  fs.writeFileSync(path, fromFeature(path));
}

// ---- Composite: palette-late resolve + backdrop-relative contrast ----------
let composite = fromFeature('src/shaders/composite.wgsl.js');
composite = composite.replace(
`// The attractor line renderer stores a circular mean of its palette coordinate
// rather than finished RGB. Reapply the same saturation/normalization that the
// old line shader used after looking up the live palette.`,
`// The attractor line renderer stores palette-coordinate summaries rather than
// finished RGB. Reapply the same saturation/normalization that the old line
// shader used after looking up the live palette.`);

const fsStart = composite.indexOf('@fragment\nfn fs_composite');
const moduleEnd = composite.lastIndexOf('\n`;');
if (fsStart < 0 || moduleEnd < 0 || moduleEnd <= fsStart) throw new Error('composite final fragment not found');

const finalComposite = `// Scene HDR -> display: explicit hue, exposure, tonemap, gamma, saturation.
// Palette cycling has already happened in resolveScene(), before bloom; Hue is
// intentionally independent and may rotate the finished image away from the
// selected palette when the user asks for it.
fn toDisplay(hdr : vec3<f32>, hueTurns : f32) -> vec3<f32> {
  var c = hdr;
  if (hueTurns != 0.0) {
    c = max(hueRotate(c, TAU * hueTurns), vec3<f32>(0.0));
  }
  c = acesFilm(c * 1.05 * u.imageAdjust.x);
  c = pow(c, vec3<f32>(1.0 / 2.2));
  return mix(vec3<f32>(luma(c)), c, u.imageAdjust.z);
}

// Contrast pivots on the presentation backdrop rather than on mid-grey. The
// backdrop is mapped to 0, white to 1, and an S-curve is applied in between.
// Both endpoints are exact fixed points at every setting. Values below the
// backdrop (deep crevices) pass through unchanged instead of being lifted.
fn contrastCurve(c : vec3<f32>, bg : vec3<f32>, k : f32) -> vec3<f32> {
  let span = max(vec3<f32>(1.0) - bg, vec3<f32>(1e-4));
  let x = (c - bg) / span;
  let xc = clamp(x, vec3<f32>(0.0), vec3<f32>(1.0));
  let a = pow(xc, vec3<f32>(k));
  let b = pow(vec3<f32>(1.0) - xc, vec3<f32>(k));
  let curved = bg + span * (a / max(a + b, vec3<f32>(1e-6)));
  return select(c, curved, x > vec3<f32>(0.0));
}

@fragment
fn fs_composite(in : VSOut) -> @location(0) vec4<f32> {
  let scene = resolveScene(in.uv);
  let bloom = textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb;
  let hdr = scene.rgb + bloom * 1.1;

  // Colour-cycle phase is already a palette-coordinate offset inside
  // resolveScene(). The Hue slider is a distinct, explicit RGB adjustment.
  let hueTurns = u.imageAdjust.w;

  // Reconstruct exactly the bare HDR backdrop for this pixel. backgroundColor
  // is the same helper resolveScene uses for miss/fog material; black is the
  // backdrop in transparent mode. Passing this through the identical display
  // chain makes the contrast pivot follow exposure, saturation and Hue too.
  let bgHdr = select(vec3<f32>(0.0), backgroundColor(in.uv), u.bgMode >= 0.5);
  var col = toDisplay(hdr, hueTurns);
  col = max(contrastCurve(col, toDisplay(bgHdr, hueTurns), u.imageAdjust.y),
            vec3<f32>(0.0));

  let q = in.uv - vec2<f32>(0.5);
  let vig = smoothstep(0.9, 0.35, length(q));
  col = col * mix(0.72, 1.0, vig);

  let d = (hash21(in.uv * u.resolution + u.time) - 0.5) / 255.0;
  col = col + vec3<f32>(d);
  col = clamp(col, vec3<f32>(0.0), vec3<f32>(1.0));

  var alpha = 1.0;
  if (u.bgMode < 0.5) {
    let cov = clamp(luma(scene.rgb) * 1.8 + scene.a * 0.9 + luma(bloom) * 1.4, 0.0, 1.0);
    alpha = cov;
  }

  return vec4<f32>(col * alpha, alpha);
}`;

composite = composite.slice(0, fsStart) + finalComposite + composite.slice(moduleEnd);
fs.writeFileSync('src/shaders/composite.wgsl.js', composite);

// ---- Tests: retain palette-coordinate contract + newer contrast properties -
let tests = fromFeature('tools/colorcycle.test.js');
const imageStart = tests.indexOf('// ---- Explicit image adjustments');
const imageEnd = tests.indexOf('\nconsole.log(`\\n${passed} passed, ${failed} failed`);', imageStart);
if (imageStart < 0 || imageEnd < 0) throw new Error('image-adjustment test section not found');

const imageTests = `// ---- Explicit image adjustments ------------------------------------------
// Hue remains independent from palette cycling: cycling shifts palette
// coordinates before bloom; Hue is an optional RGB-space camera adjustment.
console.log('\\nimage adjustments');
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
    check(\`neutral settings preserve the established tone chain for \${c}\`, nearV(adjust(c), oldChain(c), 1e-12));
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
`;

tests = tests.slice(0, imageStart) + imageTests + tests.slice(imageEnd);
fs.writeFileSync('tools/colorcycle.test.js', tests);

// ---- README: retain palette architecture, carry forward contrast semantics --
let readme = fromFeature('README.md');
readme = replaceOnce(readme,
`│       ├── fractal.wgsl.js       vertex + fragment raymarcher, inlined as WGSL
│       ├── composite.wgsl.js     bloom, ACES tonemap, vignette, and dithering
│       └── attractor.wgsl.js     strange attractors drawn as line geometry`,
`│       ├── fractal.wgsl.js       distance estimators + clearance compute shader
│       ├── material.wgsl.js      palette-independent raymarch material pass
│       ├── composite.wgsl.js     palette resolve, bloom, image controls, tonemap
│       └── attractor.wgsl.js     palette-independent strange-attractor lines`,
'project shader list');
readme = readme.replace(
`│   └── colorcycle.test.js        hue-rotation maths for the colour cycle`,
`│   └── colorcycle.test.js        palette-cycle and image-control arithmetic`);

const oldCycleStart = readme.indexOf('**Colours cycle without costing sharpness.**');
const oldControls = readme.indexOf('**Brightness, contrast, saturation and hue are camera controls, not filters.**', oldCycleStart);
if (oldCycleStart < 0 || oldControls < 0) throw new Error('README colour-cycle narrative not found');
const newCycleNarrative = `**Colours cycle without costing sharpness.** The expensive model pass now stores palette coordinates and lighting weights instead of baking RGB into the converged frame. The post chain looks those coordinates up in the currently selected palette every frame, so a settled 96-sample model can keep changing colour without another raymarch.

That also makes the cycle palette-faithful. Aurora stays an Aurora lookup while the coordinate moves through it; an imported Coolors ramp stays within that ramp. Neutral specular light remains neutral. Bloom is calculated after the live palette lookup, so the glow moves with the surface colour instead of retaining an earlier hue. \`setColorCycle()\` deliberately does not reset accumulation, and switching palettes can recolour the converged material immediately.

The explicit **Hue** control is separate. It remains an RGB-space image adjustment for cases where the user intentionally wants to move away from the selected palette. Automatic palette motion is suppressed under \`prefers-reduced-motion\`; manual Hue remains available.

`;
readme = readme.slice(0, oldCycleStart) + newCycleNarrative + readme.slice(oldControls);

const oldPlacement = `Where each one sits in the chain is what makes it behave. Brightness is an exposure multiply *before* the tonemapper, so highlights roll off along the ACES curve the way a camera's do; the same multiply after the tonemap would clip them flat. Hue joins the cycle's phase by addition, so the slider offsets where the loop sits rather than fighting it, and with cycling off it is a plain hue control. Saturation and contrast come after gamma, in display space, and contrast pivots on mid-grey — pivot anywhere else and the picture visibly brightens or darkens as the control is turned. All four are neutral by default, so an unchanged installation renders exactly what it did before they existed.`;
const newPlacement = `Where each one sits in the chain is what makes it behave. Brightness is an exposure multiply *before* the tonemapper, so highlights roll off along the ACES curve the way a camera's do; the same multiply after the tonemap would clip them flat. Hue is an independent RGB rotation after palette resolution. Saturation comes after gamma, in display space. Contrast is also a display-space control, but it pivots on the backdrop rather than on mid-grey. All four are neutral by default, so an unchanged installation renders exactly what it did before they existed.

**Contrast pivots on the backdrop, not on mid-grey.** The backdrop sits far below mid-grey, so a conventional photographic pivot visibly lifts it when contrast is reduced and crushes it when contrast is increased. The control is meant to shape the model while the space around it holds still.

The composite pass therefore reconstructs the bare backdrop for each pixel and takes it through the same Hue, exposure, tonemap, gamma and saturation chain as the rendered scene. Contrast then rescales the channel so that backdrop is 0 and white is 1, and applies the S-curve \`xᵏ / (xᵏ + (1−x)ᵏ)\`. Both endpoints remain exact fixed points at every setting, the curve stays monotone, and a crevice darker than the backdrop passes through unchanged rather than being raised to it.`;
readme = replaceOnce(readme, oldPlacement, newPlacement, 'image-control placement');

// The detailed palette section lower in the README is authoritative; make sure
// no old RGB-cycle wording survived the earlier narrative.
for (const stale of [
  'full turn of hue every forty seconds',
  'The rotation is about the grey axis',
  "Hue joins the cycle's phase",
  'contrast pivots on mid-grey',
]) {
  if (readme.includes(stale)) throw new Error(`stale README wording remains: ${stale}`);
}
fs.writeFileSync('README.md', readme);

console.log('integrated palette-faithful cycle with current main');
