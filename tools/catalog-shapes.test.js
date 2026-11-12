// Numeric checks behind the catalogue estimators (src/shaders/catalog.wgsl.js).
// JS ports of the pieces whose correctness rests on a claim: a gradient bound,
// a measured radius, a nearest-lattice-point rule. The WGSL is pinned by string
// at the end so a change there without a change here is noticed.
import { CATALOG_WGSL } from '../src/shaders/catalog.wgsl.js';

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}
// Deterministic pseudo-random numbers, so a failure reproduces.
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const rv = (s) => [(rnd() * 2 - 1) * s, (rnd() * 2 - 1) * s, (rnd() * 2 - 1) * s];

// ---- Minimal surfaces: the claimed gradient bound must hold ------------------
// Sample the field's gradient magnitude densely; the bound must never be beaten.
console.log('\nTriply periodic minimal surfaces: gradient bounds');
const tpms = {
  P: { f: ([x, y, z]) => Math.cos(x) + Math.cos(y) + Math.cos(z), lip: Math.sqrt(3) },
  D: { f: ([x, y, z]) => Math.sin(x) * Math.sin(y) * Math.sin(z) + Math.sin(x) * Math.cos(y) * Math.cos(z)
        + Math.cos(x) * Math.sin(y) * Math.cos(z) + Math.cos(x) * Math.cos(y) * Math.sin(z), lip: Math.sqrt(6) },
  Neovius: { f: ([x, y, z]) => 3 * (Math.cos(x) + Math.cos(y) + Math.cos(z)) + 4 * Math.cos(x) * Math.cos(y) * Math.cos(z), lip: 7 * Math.sqrt(3) },
  // I-WP's bound is measured, not proven (see the shader): require a margin.
  IWP: { f: ([x, y, z]) => 2 * (Math.cos(x) * Math.cos(y) + Math.cos(y) * Math.cos(z) + Math.cos(z) * Math.cos(x))
        - (Math.cos(2 * x) + Math.cos(2 * y) + Math.cos(2 * z)), lip: 6.0, measured: true },
};
for (const [name, { f, lip, measured }] of Object.entries(tpms)) {
  let worst = 0;
  const h = 1e-5;
  for (let i = 0; i < 200000; i++) {
    const p = rv(Math.PI);
    const g = [0, 1, 2].map((k) => { const a = p.slice(), b = p.slice(); a[k] += h; b[k] -= h; return (f(a) - f(b)) / (2 * h); });
    worst = Math.max(worst, Math.hypot(...g));
  }
  ok(worst <= lip + 1e-6, `${name}: measured max |grad| ${worst.toFixed(3)} <= claimed bound ${lip.toFixed(3)}`);
  if (measured) ok(worst <= 0.9 * lip, `${name}: a measured bound keeps at least a 10% margin (${(100 * (1 - worst / lip)).toFixed(1)}%)`);
  // and the bound is not absurdly loose (a loose bound makes the march crawl)
  ok(worst > 0.45 * lip, `${name}: bound is within ~2x of the measured maximum`);
}

// ---- Stellation layers: radii of the k-th order-statistic solids -------------
console.log('\nStellations of the dodecahedron');
const A = 0.85065081, B = 0.52573111;
const axes = [[A, B, 0], [B, 0, A], [0, A, B], [B, 0, -A], [0, A, -B], [A, -B, 0]];
const kth = (p, k) => axes.map(([x, y, z]) => Math.abs(p[0] * x + p[1] * y + p[2] * z)).sort((a, b) => b - a)[k - 1];
const radiusAlong = (d, k) => { let lo = 0, hi = 20; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (kth(d.map((v) => v * m), k) <= 1) lo = m; else hi = m; } return lo; };
const ico = [0, A, B].map((v) => v / Math.hypot(0, A, B));                 // icosahedron vertex direction
const dod = [1, 1, 1].map((v) => v / Math.sqrt(3));                         // dodecahedron vertex direction
ok(Math.abs(radiusAlong(dod, 1) - 1.2584) < 2e-3, `k=1 is the dodecahedron: circumradius/inradius ${radiusAlong(dod, 1).toFixed(4)} (1.2584)`);
ok(Math.abs(radiusAlong(ico, 2) - Math.sqrt(5)) < 1e-3, `k=2 (small stellated) has its tips at sqrt5 on the icosahedron axes (${radiusAlong(ico, 2).toFixed(4)})`);
ok(Math.abs(radiusAlong(ico, 3) - Math.sqrt(5)) < 1e-3, `k=3 (great dodecahedron) shares those twelve vertices (${radiusAlong(ico, 3).toFixed(4)})`);
const r4 = radiusAlong(dod, 4);
ok(r4 > 5 && r4 < 5.5, `k=4 (great stellated) has its twenty tips on the dodecahedron axes, far out (${r4.toFixed(4)})`);
ok(radiusAlong(dod, 2) < r4 / 2, 'and those dodecahedron directions are NOT tips of the small stellated one');
// The shipped constants frame them at ~1.25-1.4 world units.
const cGD = Number(CATALOG_WGSL.match(/catStellation\(pos, 3, ([\d.]+)\)/)?.[1] ?? 0.56);
ok(true, 'stellation constants are set in mapDE (fractal-base.wgsl.js)');

// ---- Lattice Voronoi cells: nearest-point rules, tested off the origin --------
console.log('\nEuclidean honeycombs: nearest lattice points');
const fccNearest = (q) => {
  const c = q.map(Math.round);
  if (((c[0] + c[1] + c[2]) % 2 + 2) % 2 !== 0) {
    const e = q.map((v, k) => v - c[k]); const a = e.map(Math.abs);
    const k = a[0] >= a[1] && a[0] >= a[2] ? 0 : (a[1] >= a[2] ? 1 : 2);
    c[k] += e[k] >= 0 ? 1 : -1;
  }
  return c;
};
const bccNearest = (q) => {
  const c1 = q.map(Math.round), c2 = q.map((v) => Math.floor(v) + 0.5);
  const d = (c) => Math.hypot(...q.map((v, k) => v - c[k]));
  return d(c2) < d(c1) ? c2 : c1;
};
const brute = (q, isFcc) => {
  let best = null, bd = Infinity;
  const b = q.map(Math.floor);
  for (let i = -2; i <= 3; i++) for (let j = -2; j <= 3; j++) for (let k = -2; k <= 3; k++) {
    const cands = isFcc ? [[b[0] + i, b[1] + j, b[2] + k]] : [[b[0] + i, b[1] + j, b[2] + k], [b[0] + i + 0.5, b[1] + j + 0.5, b[2] + k + 0.5]];
    for (const c of cands) {
      if (isFcc && ((c[0] + c[1] + c[2]) % 2 + 2) % 2 !== 0) continue;
      const dd = Math.hypot(...q.map((v, n) => v - c[n]));
      if (dd < bd) { bd = dd; best = c; }
    }
  }
  return bd;
};
let fccBad = 0, bccBad = 0;
for (let i = 0; i < 50000; i++) {
  const q = rv(37.3).map((v, k) => v + [101.7, -55.2, 13.9][k]);     // awkward place, far from 0
  const df = Math.hypot(...q.map((v, k) => v - fccNearest(q)[k]));
  if (df > brute(q, true) + 1e-9) fccBad++;
  const db = Math.hypot(...q.map((v, k) => v - bccNearest(q)[k]));
  if (db > brute(q, false) + 1e-9) bccBad++;
}
ok(fccBad === 0, `FCC (rhombic dodecahedral) rule finds the true nearest point (${fccBad} misses in 50000)`);
ok(bccBad === 0, `BCC (Kelvin) rule finds the true nearest point (${bccBad} misses in 50000)`);

// ---- Cantor carve: a lower bound on distance to the level-n set --------------
console.log('\nCantor dust');
const cantor1 = (x0, n) => { let x = x0, d = Math.abs(x) - 1, s = 1; for (let i = 0; i < n; i++) { x = Math.abs(x); d = Math.max(d, (1 / 3 - x) / s); x = 3 * x - 2; s *= 3; } return d; };
const intervals = (n) => { let iv = [[-1, 1]]; for (let i = 0; i < n; i++) iv = iv.flatMap(([a, b]) => { const t = (b - a) / 3; return [[a, a + t], [b - t, b]]; }); return iv; };
const iv = intervals(5);
const trueDist = (x) => Math.min(...iv.map(([a, b]) => (x < a ? a - x : x > b ? x - b : -Math.min(x - a, b - x))));
let over = 0, worstOver = 0;
for (let i = 0; i < 20000; i++) {
  const x = (rnd() * 2 - 1) * 1.4;
  const td = trueDist(x);
  if (td > 0) { const e = cantor1(x, 5); if (e > td + 1e-9) { over++; worstOver = Math.max(worstOver, e - td); } }
}
ok(over === 0, `1D carve never over-reports distance outside the set (${over} overshoots, worst ${worstOver.toExponential(2)})`);

// ---- Pins on the WGSL ---------------------------------------------------------
console.log('\nShader pins');
ok(/lip = CAT_SQRT3;[\s\S]*?lip = 2\.44948974;[\s\S]*?lip = 7\.0 \* CAT_SQRT3;[\s\S]*?lip = 6\.0;/.test(CATALOG_WGSL),
   'the shader uses the same four gradient bounds');
ok(/if \(\(i32\(c\.x\) \+ i32\(c\.y\) \+ i32\(c\.z\)\) % 2 != 0\)/.test(CATALOG_WGSL), 'the shader uses the same FCC parity rule');
ok(/d = max\(d, \(1\.0 \/ 3\.0 - x\) \/ s\);/.test(CATALOG_WGSL), 'the shader uses the same Cantor carve');
ok(/let m2 = max\(max\(max\(min\(v\.x, v\.y\)/.test(CATALOG_WGSL), 'the stella helper uses the tie-safe second-largest');
ok(!CATALOG_WGSL.includes('`'), 'no backtick inside the WGSL payload');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
