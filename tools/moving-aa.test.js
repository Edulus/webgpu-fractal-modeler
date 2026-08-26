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
function edgeResolve(img, outN, quality) {
  const h = img.length, w = img[0].length;
  const texelX = 1 / w, texelY = 1 / h;
  const strength = clamp((1 - quality) * 2, 0, 1);
  return Array.from({ length: outN }, (_, y) =>
    Array.from({ length: outN }, (_, x) => {
      const u = (x + 0.5) / outN, v = (y + 0.5) / outN;
      const base = bilinear(img, u, v);
      if (strength <= 0.001) return base;
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
      const a = bilinear(img, u + tx * 0.4, v + ty * 0.4);
      const b = bilinear(img, u - tx * 0.4, v - ty * 0.4);
      const mean = (a + b) * 0.5;
      const blend = strength * smoothstep(0.05, 0.5, g) * 0.7;
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
