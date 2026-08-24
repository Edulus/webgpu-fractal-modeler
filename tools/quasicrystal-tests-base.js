// Icosahedral quasicrystal: the star, the bound, and the two properties that
// make it a quasicrystal rather than a crystal or a blob.
//
// The construction is six lines of shader, which makes it easy to break in ways
// that still render something plausible. Perturb the axes and it silently
// becomes a periodic crystal; get the Lipschitz constant wrong and rays punch
// through thin walls; move the threshold and it is a featureless ball or empty
// space. Each of those is checked here rather than by looking at it.
//
// Constants are read back out of the shader instead of restated, so this cannot
// pass against numbers the renderer no longer uses.

import fs from 'node:fs';

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}

console.log('\nIcosahedral quasicrystal: star, Lipschitz bound, symmetry, aperiodicity');

// ---- Constants, taken from the shader --------------------------------------
const src = fs.readFileSync('src/shaders/fractal.wgsl.js', 'utf8');
const body = src.slice(src.indexOf('fn deQuasicrystal'), src.indexOf('\n}', src.indexOf('fn deQuasicrystal')));
const num = (name) => {
  const m = body.match(new RegExp(`const ${name} : f32 = ([-\\d.]+)`));
  if (!m) throw new Error(`deQuasicrystal has no constant ${name}`);
  return Number(m[1]);
};
const K = num('K');
const THRESH = num('THRESH');
const CLIP = num('CLIP');
const A = num('A');
const B = num('B');
const LIP = num('LIP');
ok(Number.isFinite(K + THRESH + CLIP + A + B + LIP),
   `constants parse from the shader (K=${K}, THRESH=${THRESH}, CLIP=${CLIP}, LIP=${LIP})`);

const PHI = (1 + Math.sqrt(5)) / 2;
const U = [
  [0, A, B], [0, A, -B],
  [A, B, 0], [-A, B, 0],
  [B, 0, A], [B, 0, -A],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---- The star is genuinely icosahedral -------------------------------------
// A perturbed star still renders a plausible aperiodic-looking solid, so this
// is checked by angle rather than by eye. Distinct 5-fold axes of an
// icosahedron meet at exactly arccos(1/sqrt5).
ok(U.every((u) => Math.abs(Math.hypot(...u) - 1) < 1e-6), 'all six axes are unit vectors');
ok(Math.abs(A - 1 / Math.hypot(1, PHI)) < 1e-6, 'A is 1/sqrt(1+phi^2)');
ok(Math.abs(B - PHI / Math.hypot(1, PHI)) < 1e-6, 'B is phi/sqrt(1+phi^2)');

let worstAngle = 0;
for (let i = 0; i < 6; i++) {
  for (let j = i + 1; j < 6; j++) {
    const c = Math.abs(dot(U[i], U[j]));
    worstAngle = Math.max(worstAngle, Math.abs(c - 1 / Math.sqrt(5)));
  }
}
ok(worstAngle < 1e-6,
   `every pair of axes meets at arccos(1/sqrt5) = 63.4349 deg (worst error ${worstAngle.toExponential(1)})`);

// No two axes are the same, and none is another's antipode -- either would drop
// the star to five effective waves and change the symmetry.
let distinct = true;
for (let i = 0; i < 6; i++) {
  for (let j = i + 1; j < 6; j++) if (Math.abs(Math.abs(dot(U[i], U[j])) - 1) < 1e-9) distinct = false;
}
ok(distinct, 'the six axes are distinct and non-antipodal');

// ---- The field --------------------------------------------------------------
const f = (p) => U.reduce((s, u) => s + Math.cos(K * dot(u, p)), 0);
const grad = (p) => {
  const g = [0, 0, 0];
  for (const u of U) {
    const t = -K * Math.sin(K * dot(u, p));
    g[0] += t * u[0]; g[1] += t * u[1]; g[2] += t * u[2];
  }
  return g;
};

let rng = 20240917;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pt = (r = CLIP) => [(rand() * 2 - 1) * r, (rand() * 2 - 1) * r, (rand() * 2 - 1) * r];

// ---- The Lipschitz bound is exact, not sampled ------------------------------
// |grad f| = K|sum sin(..) u_i| <= K * max over sign patterns |sum +-u_i|, and
// that maximum is 1 + 5*(1/sqrt5) = 1 + sqrt5 = 2*phi. All 64 patterns are
// enumerated rather than trusting the derivation.
let signMax = 0;
for (let m = 0; m < 64; m++) {
  const s = [0, 0, 0];
  for (let i = 0; i < 6; i++) {
    const e = (m >> i) & 1 ? 1 : -1;
    s[0] += e * U[i][0]; s[1] += e * U[i][1]; s[2] += e * U[i][2];
  }
  signMax = Math.max(signMax, Math.hypot(...s));
}
ok(Math.abs(signMax - 2 * PHI) < 1e-6,
   `max |sum +-u_i| is exactly 2*phi = 1+sqrt5 = ${(2 * PHI).toFixed(6)} (got ${signMax.toFixed(6)})`);
ok(Math.abs(LIP - 2 * PHI * K) < 1e-3,
   `the shader's LIP is 2*phi*K = ${(2 * PHI * K).toFixed(4)}`);

// The bound must never be exceeded -- that is what makes the estimator safe
// without an empirical safety factor.
let gmax = 0;
for (let i = 0; i < 250000; i++) gmax = Math.max(gmax, Math.hypot(...grad(pt())));
ok(gmax <= LIP, `sampled max |grad| = ${gmax.toFixed(3)} never exceeds the bound ${LIP.toFixed(3)}`);
ok(LIP / gmax < 1.3,
   `and the bound is tight enough to be worth using (${(LIP / gmax).toFixed(3)}x the sampled max)`);

// ---- Density: can the object be seen at all? -------------------------------
// The catalog's own trap. A field 90% solid renders as a ball and one at 1%
// renders as nothing; neither failure looks like a bug in the estimator.
let inside = 0;
let solid = 0;
for (let i = 0; i < 200000; i++) {
  const p = pt();
  if (Math.hypot(...p) > CLIP) continue;
  inside++;
  if (f(p) > THRESH) solid++;
}
const frac = solid / inside;
ok(frac > 0.10 && frac < 0.45,
   `solid fraction inside the clip is ${(100 * frac).toFixed(1)}% -- neither a ball nor empty`);

// ---- Symmetry: icosahedral, and nothing continuous -------------------------
function rot(axis, ang) {
  const [x, y, z] = axis, c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  return [
    [t*x*x + c,   t*x*y - s*z, t*x*z + s*y],
    [t*x*y + s*z, t*y*y + c,   t*y*z - s*x],
    [t*x*z - s*y, t*y*z + s*x, t*z*z + c  ],
  ];
}
const apply = (M, p) => [dot(M[0], p), dot(M[1], p), dot(M[2], p)];
const maxDiff = (M, n = 40000) => {
  let d = 0;
  for (let i = 0; i < n; i++) {
    const p = pt();
    d = Math.max(d, Math.abs(f(p) - f(apply(M, p))));
  }
  return d;
};

// Two separate claims, because they have different limits. The CONSTRUCTION is
// exactly icosahedral -- checked with full-precision phi, where the residual is
// float64 noise. The SHIPPED CONSTANTS are only as good as f32, whose epsilon is
// 1.2e-7, so the same check against them bottoms out near 1e-6. Testing the
// second at the first's tolerance would fail for no reason a renderer cares
// about; testing the first at the second's would not prove the construction.
const NRM = Math.hypot(1, PHI);
const EXACT = [
  [0, 1, PHI], [0, 1, -PHI], [1, PHI, 0], [-1, PHI, 0], [PHI, 0, 1], [PHI, 0, -1],
].map((v) => v.map((c) => c / NRM));
const fExact = (p) => EXACT.reduce((s, u) => s + Math.cos(K * dot(u, p)), 0);
let exactWorst = 0;
for (let i = 0; i < 6; i++) {
  const M = rot(EXACT[i], 2 * Math.PI / 5);
  for (let n = 0; n < 4000; n++) {
    const p = pt();
    exactWorst = Math.max(exactWorst, Math.abs(fExact(p) - fExact(apply(M, p))));
  }
}
ok(exactWorst < 1e-12,
   `in exact arithmetic a 72-degree turn about any axis is an exact symmetry (${exactWorst.toExponential(1)})`);

let shippedWorst = 0;
for (let i = 0; i < 6; i++) {
  shippedWorst = Math.max(shippedWorst, maxDiff(rot(U[i], 2 * Math.PI / 5), 6000));
}
ok(shippedWorst < 1e-4,
   `and the shipped constants hold it to f32 precision (${shippedWorst.toExponential(1)}, against a field spanning ~10)`);

// The trap that has caught this catalog twice: a hidden continuous invariance,
// which would mean a 2D pattern wearing a 3D costume. If any rotation angle
// worked, the object would be a surface of revolution.
const arbitrary = maxDiff(rot(U[0], 0.7));
ok(arbitrary > 1.0,
   `an arbitrary turn about the same axis moves the field by ${arbitrary.toFixed(2)} -- no continuous symmetry`);
const offAxis = maxDiff(rot([0.3714, 0.5571, 0.7428], 2 * Math.PI / 5));
ok(offAxis > 1.0,
   `a 72-degree turn about a non-axis moves it by ${offAxis.toFixed(2)} -- the symmetry is the icosahedron's, not a coincidence`);

// ---- Aperiodicity ----------------------------------------------------------
// Quasiperiodic means almost-periodic: translations that nearly repeat the
// field exist and improve without bound, but none ever closes. Both halves
// matter -- "never comes close" would be wrong, and so would "repeats".
const wl = 2 * Math.PI / K;
function bestRepeat(limit) {
  let best = Infinity;
  for (let step = 1; ; step++) {
    const d = wl + step * 0.01;
    if (d > limit) break;
    let m = 0;
    for (let i = 0; i < 200; i++) {
      const p = pt(1);
      const q = [p[0] + d * U[0][0], p[1] + d * U[0][1], p[2] + d * U[0][2]];
      m = Math.max(m, Math.abs(f(p) - f(q)));
      if (m >= best) break;
    }
    if (m < best) best = m;
  }
  return best;
}
const near10 = bestRepeat(10);
const near100 = bestRepeat(100);
ok(near10 > 0, `no exact period within 10 units (best leaves |df| = ${near10.toFixed(4)})`);
ok(near100 < near10,
   `near-periods keep improving with range (${near10.toFixed(4)} -> ${near100.toFixed(4)}): almost-periodic`);
ok(near100 > 1e-6,
   'but never close entirely -- quasiperiodic, not periodic');

// And the reason, stated as arithmetic: a period needs sqrt5 rational.
ok(Math.abs(Math.abs(dot(U[0], U[1])) - 1 / Math.sqrt(5)) < 1e-6,
   'the phase-rate ratio between axes is sqrt5 = 2*phi - 1, which is irrational');

// ---- The estimator never overshoots ----------------------------------------
// Marching alone is a weak test, which is why the bound above is proved rather
// than sampled. This is the complementary end-to-end check.
const de = (p) => Math.max((THRESH - f(p)) / LIP, Math.hypot(...p) - CLIP);
let hits = 0;
let skipped = 0;
for (let r = 0; r < 1500; r++) {
  const dir = pt(1);
  const n = Math.hypot(...dir);
  if (n < 1e-6) continue;
  const d = dir.map((c) => c / n);
  const ro = [-d[0] * 3, -d[1] * 3, -d[2] * 3];
  let t = 0;
  let hit = -1;
  for (let i = 0; i < 800; i++) {
    const p = [ro[0] + d[0] * t, ro[1] + d[1] * t, ro[2] + d[2] * t];
    const h = de(p);
    if (h < 1e-5) { hit = t; break; }
    t += h;
    if (t > 8) break;
  }
  let ref = -1;
  for (let s = 0; s <= 8; s += 0.001) {
    const p = [ro[0] + d[0] * s, ro[1] + d[1] * s, ro[2] + d[2] * s];
    if (Math.hypot(...p) <= CLIP && f(p) > THRESH) { ref = s; break; }
  }
  if (ref >= 0) { hits++; if (hit < 0 || hit > ref + 0.01) skipped++; }
}
ok(hits > 500, `the march reaches the solid on ${hits} of 1500 rays`);
ok(skipped === 0, `and skips past the first surface on none of them (${skipped})`);

// ---- The clip is an intersection, not a surface ----------------------------
// Returning the clip alone makes it register as a hit and renders a smooth
// ball at CLIP. This has caused three misdiagnoses in this repo already.
ok(/max\(\(THRESH - s\) \/ LIP, length\(pos\) - CLIP\)/.test(body),
   'the clip is combined with max(), so it only shows where it actually cuts');
ok(!/\/ LIP\s*\*\s*0\.\d/.test(body) && !/0\.\d+\s*\*\s*\(THRESH/.test(body),
   'no empirical safety factor: the bound is exact, so none is needed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
