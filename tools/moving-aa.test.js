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
ok(shader.includes('TAP_BASE : f32 = 0.55') && shader.includes('BLEND_BASE : f32 = 0.85'),
  'the shader carries the strengthened constants this port mirrors');
// Demonstrated, not assumed: loosening the tap cap in the WGSL alone left this
// suite green, because the port below keeps its own copy of every number. Each
// one the port duplicates needs pinning by name, or the numeric result silently
// describes code that is no longer running.
ok(/min\(TAP_BASE \* gain, 0\.9\)/.test(shader),
  'a tap stays inside one texel, so it cannot cross into the next step');
ok(/BLEND_BASE \* gain, 0\.95\)/.test(shader),
  'the blend stops short of fully replacing the rendered pixel');
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
// Mirrors resolveSceneEdgeAA. TAP_BASE/BLEND_BASE and the two caps must track
// the WGSL constants of the same name; nothing here reads the shader, so a
// change made in one place and not the other leaves these numbers describing
// code that is no longer running.
const TAP_BASE = 0.55;
const BLEND_BASE = 0.85;
function edgeResolve(img, outN, quality, gain = 1) {
  const h = img.length, w = img[0].length;
  const texelX = 1 / w, texelY = 1 / h;
  const strength = clamp((1 - quality) * 2, 0, 1);
  const tap = Math.min(TAP_BASE * gain, 0.9);
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
      const blend = Math.min(strength * smoothstep(0.05, 0.5, g) * BLEND_BASE * gain, 0.95);
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
// shading. The shader's tangent filter must improve every tested orientation,
// not merely one cherry-picked diagonal.
let ratioSum = 0;
let cases = 0;
for (const quality of [0.4, 0.5, 0.65, 0.8]) {
  const lowN = 12;
  const outN = Math.round(lowN / quality);
  for (const slope of [0.25, 0.5, 0.8, 1.0, 1.5, 2.0]) {
    const low = lowResEdge(lowN, slope, 0.15);
    const ideal = idealCoverage(outN, slope, 0.15);
    const baseline = upscale(low, outN);
    const filtered = edgeResolve(low, outN, quality);
    const before = mse(baseline, ideal);
    const after = mse(filtered, ideal);
    ok(after < before * 0.97,
      `edge reconstruction improves q${quality} slope ${slope} (${(after / before).toFixed(3)}x MSE)`);
    ratioSum += after / before;
    cases++;
  }
}
ok(ratioSum / cases < 0.90,
  `mean synthetic edge error falls by >10% (${(ratioSum / cases).toFixed(3)}x MSE)`);

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
