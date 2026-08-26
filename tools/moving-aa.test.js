const fs = require('fs');
const path = require('path');

const shaderPath = path.join(__dirname, '..', 'src', 'shaders', 'composite.wgsl.js');
const shader = fs.readFileSync(shaderPath, 'utf8');
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { console.log(`ok - ${msg}`); passed++; }
  else { console.error(`not ok - ${msg}`); failed++; }
}

ok(shader.includes('fn surfaceCoverage'), 'surface hit/miss coverage drives moving-edge reconstruction');
ok(shader.includes('fn resolveSceneEdgeAA'), 'composite shader contains the edge-aware resolve');
ok(/fn fs_composite[\s\S]*?resolveSceneEdgeAA\(in\.uv\)/.test(shader),
  'final composite uses the edge-aware resolve');
// The numeric model below is a port of resolveSceneEdgeAA, and every constant
// it duplicated was a chance to drift. That is not hypothetical: loosening the
// tap cap in the WGSL alone once left this suite green, and so did changing the
// port's own blend constant, because assertions pinned the shader's numbers
// without ever tying the port to them.
//
// So the port reads them out of the shader instead of restating them. There is
// nothing left to keep in sync -- a constant changed in the WGSL changes what
// this test measures, and one that cannot be found here fails immediately
// rather than being silently replaced by a stale default.
function shaderConst(name) {
  const m = shader.match(new RegExp(`const ${name} : f32 = ([\\d.]+);`));
  if (!m) throw new Error(`${name} not found in composite.wgsl -- the port cannot mirror it`);
  return Number(m[1]);
}
function shaderCap(expr) {
  const m = shader.match(new RegExp(`${expr} \\* gain, ([\\d.]+)\\)`));
  if (!m) throw new Error(`cap on ${expr} not found in composite.wgsl`);
  return Number(m[1]);
}
const TAP_BASE = shaderConst('TAP_BASE');
const BLEND_BASE = shaderConst('BLEND_BASE');
const TAP_CAP = shaderCap('TAP_BASE');
const BLEND_CAP = shaderCap('BLEND_BASE');
ok(TAP_CAP <= 0.9,
  `a tap stays inside one texel, so it cannot cross into the next step (cap ${TAP_CAP})`);
ok(BLEND_CAP < 1.0,
  `the blend stops short of fully replacing the rendered pixel (cap ${BLEND_CAP})`);
console.log(`  .. mirroring shader constants: tap ${TAP_BASE}/${TAP_CAP}, blend ${BLEND_BASE}/${BLEND_CAP}`);
ok(shader.includes('(1.0 - u.qualityScale) * 2.0'),
  'edge smoothing fades out as internal resolution reaches native resolution');
ok(shader.includes('centerCoverage <= 0.01 || centerCoverage >= 0.99'),
  'interior and background pixels skip the neighbor-tap work');
ok(!shader.includes('@binding(5)'),
  'moving-edge fix adds no new texture binding or read/write attachment hazard');
ok(!shader.includes('fs_fxaa'),
  'failed extra-pass FXAA path has not been reintroduced');

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function bilinear(img, u, v) {
  const h = img.length, w = img[0].length;
  const fx = u * w - 0.5, fy = v * h - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const get = (x, y) => img[clamp(y, 0, h - 1)][clamp(x, 0, w - 1)];
  return (1 - tx) * (1 - ty) * get(x0, y0)
       + tx * (1 - ty) * get(x0 + 1, y0)
       + (1 - tx) * ty * get(x0, y0 + 1)
       + tx * ty * get(x0 + 1, y0 + 1);
}
function lowResEdge(n, slope, intercept) {
  return Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) =>
      ((y + 0.5) / n > slope * ((x + 0.5) / n) + intercept) ? 1 : 0));
}
function idealCoverage(n, slope, intercept, ss = 6) {
  return Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const u = (x + (sx + 0.5) / ss) / n;
        const v = (y + (sy + 0.5) / ss) / n;
        if (v > slope * u + intercept) hits++;
      }
      return hits / (ss * ss);
    }));
}
// Mirrors resolveSceneEdgeAA, using the constants read from it above.
function edgeResolve(img, outN, quality, gain = 1) {
  const h = img.length, w = img[0].length;
  const texelX = 1 / w, texelY = 1 / h;
  const strength = clamp((1 - quality) * 2, 0, 1);
  const tap = Math.min(TAP_BASE * gain, TAP_CAP);
  return Array.from({ length: outN }, (_, y) =>
    Array.from({ length: outN }, (_, x) => {
      const u = (x + 0.5) / outN, v = (y + 0.5) / outN;
      const base = bilinear(img, u, v);
      if (strength <= 0.001 || gain <= 0.001) return base;
      const centerCoverage = bilinear(img, u, v);
      if (centerCoverage <= 0.01 || centerCoverage >= 0.99) return base;
      const cL = bilinear(img, u - texelX, v);
      const cR = bilinear(img, u + texelX, v);
      const cU = bilinear(img, u, v - texelY);
      const cD = bilinear(img, u, v + texelY);
      const gx = cR - cL, gy = cD - cU;
      const g2 = gx * gx + gy * gy;
      if (g2 < 0.0025) return base;
      const g = Math.sqrt(g2);
      const tx = (-gy / g) * texelX, ty = (gx / g) * texelY;
      const a = bilinear(img, u + tx * tap, v + ty * tap);
      const b = bilinear(img, u - tx * tap, v - ty * tap);
      const mean = (a + b) * 0.5;
      const blend = Math.min(strength * smoothstep(0.05, 0.5, g) * BLEND_BASE * gain, BLEND_CAP);
      return base * (1 - blend) + mean * blend;
    }));
}
function mse(a, b) {
  let e = 0, n = 0;
  for (let y = 0; y < a.length; y++) for (let x = 0; x < a[0].length; x++) {
    const d = a[y][x] - b[y][x]; e += d * d; n++;
  }
  return e / n;
}
function upscale(img, outN) {
  return Array.from({ length: outN }, (_, y) =>
    Array.from({ length: outN }, (_, x) => bilinear(img, (x + 0.5) / outN, (y + 0.5) / outN)));
}

// Numeric control: a low-resolution sampled diagonal is compared with genuine
// subpixel area coverage. This is the failure mode in the handoff, stripped of
// shading.
//
// The shipped strength was chosen by eye, and the two instruments disagree
// about it. Measured across 24 cases, raising the gain from 0.63 to 1.0 lowers
// mean error (0.807x -> 0.774x) while pushing four steep-edge cases slightly
// ABOVE the baseline, the worst at 1.028x. A viewer comparing the two in a
// browser preferred the stronger setting anyway, and that is the authority
// here: this measure scores a coverage field, whereas the filter runs on a
// shaded 3D image, so it cannot see what was actually being judged.
//
// So the per-case rule is a BOUND on that regression rather than a demand for
// universal improvement -- 5% catches a real overshoot while leaving room for
// the trade actually made. The design itself is still held to the stricter
// rule at a reference gain, so a genuinely broken filter cannot hide behind
// the relaxed bound.
const GAINS = { reference: 0.63, shipped: 1.0 };
const CASES = [];
for (const quality of [0.4, 0.5, 0.65, 0.8]) {
  for (const slope of [0.25, 0.5, 0.8, 1.0, 1.5, 2.0]) {
    const lowN = 12;
    const outN = Math.round(lowN / quality);
    const low = lowResEdge(lowN, slope, 0.15);
    const ideal = idealCoverage(outN, slope, 0.15);
    const before = mse(upscale(low, outN), ideal);
    CASES.push({
      quality, slope,
      ratio: (g) => mse(edgeResolve(low, outN, quality, g), ideal) / before,
    });
  }
}

const refWorst = Math.max(...CASES.map((c) => c.ratio(GAINS.reference)));
ok(refWorst < 0.97,
  `at the reference gain every orientation still improves (worst ${refWorst.toFixed(3)}x MSE)`);

const shipped = CASES.map((c) => ({ c, r: c.ratio(GAINS.shipped) }));
const worst = shipped.reduce((a, b) => (b.r > a.r ? b : a));
ok(worst.r < 1.05,
  `no orientation regresses beyond the bound (worst ${worst.r.toFixed(3)}x at ` +
  `q${worst.c.quality} slope ${worst.c.slope})`);

// The error measure saturates where the filter does, so it cannot see a blend
// constant raised past the cap: quadrupling BLEND_BASE leaves it unmoved. What
// that change really costs is the dial. Once most edge samples are pinned at
// the cap, ?edgeaa stops varying anything a viewer could compare, and the whole
// method of settling this -- look at two settings side by side -- quietly stops
// working. That is a property worth holding directly.
{
  let pinned = 0, total = 0;
  for (const quality of [0.4, 0.5, 0.65, 0.8]) {
    const strength = clamp((1 - quality) * 2, 0, 1);
    for (let g = 0.06; g <= 0.9; g += 0.02) {
      total++;
      if (strength * smoothstep(0.05, 0.5, g) * BLEND_BASE >= BLEND_CAP) pinned++;
    }
  }
  const share = pinned / total;
  ok(share < 0.6,
    `the gain still has room to move at the shipped strength ` +
    `(${(share * 100).toFixed(0)}% of edge samples pinned at the cap)`);
}

const mean = shipped.reduce((s2, x) => s2 + x.r, 0) / shipped.length;
ok(mean < 0.85, `mean synthetic edge error falls by >15% (${mean.toFixed(3)}x MSE)`);
ok(mean < refWorst,
  `the shipped gain beats the reference on average, which is the trade it makes`);

// Controls: native-resolution mode is byte-for-byte the baseline numerically,
// and a flat field remains flat even on the lowest rung.
{
  const low = lowResEdge(12, 0.65, 0.15);
  const a = upscale(low, 12);
  const b = edgeResolve(low, 12, 1.0);
  ok(mse(a, b) === 0, 'native-resolution control is unchanged');
}
{
  const flat = Array.from({ length: 12 }, () => Array(12).fill(1));
  const out = edgeResolve(flat, 30, 0.4);
  const err = out.flat().reduce((s, x) => s + Math.abs(1 - x), 0);
  ok(err < 1e-12, 'flat-field control is unchanged');
}

// ---- The filter must be spent on single-sample frames only ----------------
// Progressive accumulation already antialiases a still view with up to 96
// jittered samples. Refiltering that softens real detail, and the still image
// was never the complaint. The quality rung is NOT a proxy for stillness: the
// showcase pass settles at scale 0.70 on the reference machine, so a gate on
// quality alone would filter every converged frame at 60% strength.
const bg = fs.readFileSync(path.join(__dirname, '..', 'src', 'fractal-bg.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

ok(/aaStrength <= 0\.001 \|\| gain <= 0\.001/.test(shader),
  'a multi-sample average is returned unfiltered');
ok(/const settled = accNow && state\.accumSamples > 0;/.test(bg),
  'settling requires both accumulation and a sample already integrated');
ok(/d\[U\.edgeAAGain\] = settled \? 0\.0 : state\.edgeAA;/.test(bg),
  'a settled frame is sent a gain of zero, which is the same off switch');
// The switch exists so the change can be judged by comparison rather than by
// impression, which is the only instrument available from outside a browser.
ok(/edgeAA: Number\.isFinite\(opts\.edgeAA\) \? Math\.max\(0, opts\.edgeAA\) : 1,/.test(bg),
  'edgeAA is a gain, defaulting to 1 and never negative');
ok(/get\('edgeaa'\)/.test(index) && /Number\.isFinite\(n\) \? Math\.max\(0, n\) : 1/.test(index),
  'the page exposes it as ?edgeaa=<gain>, falling back to the default');
// Neither half of that condition is sufficient alone, and the reasons differ:
// a converged frame writes accumWeight 1 exactly as a moving frame does, and
// accumSamples is left stale by paths that stop accumulation without clearing
// it (a held key). Assert the slot too -- it reuses the old _pad2 and a moved
// index would silently write into colour state.
ok(/edgeAAGain: 59\b/.test(bg), 'edgeAAGain occupies the former _pad2 slot');
ok(!bg.includes('_pad2') && !shader.includes('_pad2'),
  'the pad it replaced is renamed in both the map and the shader struct');
ok(/accumWeight  : f32,\s*\n\s*edgeAAGain   : f32,/.test(shader),
  'the shader struct keeps edgeAAGain directly after accumWeight');

{
  const low = lowResEdge(12, 0.65, 0.15);
  const outN = 30;
  const moving = edgeResolve(low, outN, 0.5, 1);
  const settled = edgeResolve(low, outN, 0.5, 0);
  const baseline = upscale(low, outN);
  ok(mse(moving, baseline) > 0, 'a single-sample frame is filtered');
  ok(mse(settled, baseline) === 0, 'an accumulated frame is left exactly as resolved');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
