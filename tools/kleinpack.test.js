// Kleinian sphere packing. Run: node tools/kleinpack.test.js
//
// A JS mirror of deKleinPack() in fractal.wgsl.js, plus the construction behind
// the constants it bakes in. The GPU cannot be exercised here -- this
// environment loses the device -- so the claims the estimator rests on are
// checked as arithmetic: that the group is [5,3,6], that its honeycomb vertex is
// ideal, that the orbit of the seed horoball is a genuine packing (tangent,
// never overlapping, every sphere touching the boundary), and that the estimator
// never reports more distance than there is.
//
// The control matters as much as the test. Run on the COMPACT {5,3,4}, which has
// no cusp to seed from, the same construction must fail -- otherwise the tests
// below would pass for a group that cannot support a packing at all.

const PI = Math.PI;
const sub = (a, b) => a.map((x, i) => x - b[i]);
const addv = (a, b) => a.map((x, i) => x + b[i]);
const mul = (a, k) => a.map((x) => x * k);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
                         a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.sqrt(dot(a, a));
const unit = (a) => mul(a, 1 / (norm(a) || 1));

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else { failed++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
};
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const nearV = (a, b, e = 1e-6) => a.every((x, i) => near(x, b[i], e));

// ---- the construction ------------------------------------------------------
// Three plane mirrors through the origin and one sphere orthogonal to the unit
// sphere, at dihedral angles pi/p, pi/q, pi/r along the Coxeter chain.
function mirrors(p, q, r) {
  const cp = Math.cos(PI / p), sp = Math.sin(PI / p);
  const cq = Math.cos(PI / q), cr = Math.cos(PI / r);
  const n0 = [1, 0, 0];
  const n1 = [-cp, sp, 0];
  const k = cq / sp;
  const n2 = [0, -k, Math.sqrt(1 - k * k)];
  const u = unit(cross(n0, n1));
  const un2 = dot(u, n2);
  const den = cr * cr - un2 * un2;
  if (den <= 1e-12) return null;             // not compact hyperbolic
  const t = Math.sqrt(cr * cr / den);
  return { ns: [n0, n1, n2], c: mul(u, -t), s: Math.sqrt(t * t - 1) };
}

// The vertex is ideal exactly when the line m1^m2 meets the mirror sphere in a
// DOUBLE point: t^2 - 2(d.c)t + 1 = 0 has roots multiplying to 1, so they
// straddle the boundary unless the discriminant vanishes, forcing t = +-1.
function idealVertex({ ns, c }) {
  const d = unit(cross(ns[1], ns[2]));
  const b = dot(d, c);
  const disc = b * b - 1;
  const t = Math.abs(disc) < 1e-9 ? b : b - Math.sign(b) * Math.sqrt(Math.max(disc, 0));
  let v = mul(d, t);
  if (dot(v, ns[0]) > 0) v = mul(v, -1);
  return { v, disc };
}

// The horoball at that vertex, tangent to the one mirror it does not lie on.
function horoball(m) {
  const { v, disc } = idealVertex(m);
  const a = Math.abs(dot(v, m.ns[0]));
  const r = a / (1 + a);
  return { o: mul(v, 1 - r), r, v, disc };
}

// ---- what the shader bakes -------------------------------------------------
const KP = {
  N0: [1.0, 0.0, 0.0],
  N1: [-0.80901699, 0.58778525, 0.0],
  N2: [0.0, -0.85065081, 0.52573111],
  CEN: [0.0, 0.0, -1.25840857],
  S2: 0.58359214,
  HO: [-0.26298370, -0.36196601, -0.58567330],
  HR: 0.26298370,
  ITERS: 24,
  R_CLIP: 0.95,
  SAFETY: 0.8,
};

const m536 = mirrors(5, 3, 6);
check('{5,3,6} is hyperbolic and constructs', m536 !== null);
check('baked n0 matches the construction', nearV(KP.N0, m536.ns[0], 1e-8));
check('baked n1 matches the construction', nearV(KP.N1, m536.ns[1], 1e-8));
check('baked n2 matches the construction', nearV(KP.N2, m536.ns[2], 1e-8));
check('baked mirror-sphere centre matches', nearV(KP.CEN, m536.c, 1e-8));
check('baked mirror-sphere radius matches', near(KP.S2, m536.s * m536.s, 1e-8));

// The Coxeter angles are what make it the group it claims to be.
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, -dot(a, b))));
check('m0^m1 = pi/5', near(ang(m536.ns[0], m536.ns[1]), PI / 5, 1e-9));
check('m1^m2 = pi/3', near(ang(m536.ns[1], m536.ns[2]), PI / 3, 1e-9));
check('m0^m2 = pi/2', near(ang(m536.ns[0], m536.ns[2]), PI / 2, 1e-9));
check('sphere orthogonal to m0', near(dot(m536.c, m536.ns[0]), 0, 1e-12));
check('sphere orthogonal to m1', near(dot(m536.c, m536.ns[1]), 0, 1e-12));
check('sphere meets m2 at pi/6',
      near(Math.acos(Math.abs(dot(m536.c, m536.ns[2])) / m536.s), PI / 6, 1e-9));
check('sphere orthogonal to the unit ball',
      near(dot(m536.c, m536.c) - m536.s * m536.s, 1, 1e-12));

// ---- the cusp --------------------------------------------------------------
const hb = horoball(m536);
check('the honeycomb vertex is IDEAL (discriminant zero)', Math.abs(hb.disc) < 1e-9,
      `disc=${hb.disc}`);
check('and therefore lies exactly on the boundary', near(norm(hb.v), 1, 1e-12));
check('baked horoball centre matches', nearV(KP.HO, hb.o, 1e-8));
check('baked horoball radius matches', near(KP.HR, hb.r, 1e-8));
check('the horoball is tangent to the boundary', near(norm(hb.o) + hb.r, 1, 1e-12));
check('and tangent to the mirror it is not on',
      near(Math.abs(dot(hb.o, m536.ns[0])), hb.r, 1e-12));

// ---- the orbit is a packing ------------------------------------------------
function orbit(m, seed, depth, limit) {
  const reflect = (o, n) => sub(o, mul(n, 2 * dot(o, n)));
  const invert = (o, rad) => {
    const v = sub(o, m.c);
    const k = dot(v, v) - rad * rad;
    if (Math.abs(k) < 1e-14) return null;
    const f = m.s * m.s / k;
    return { o: addv(m.c, mul(v, f)), r: Math.abs(f) * rad };
  };
  // Round BEFORE formatting, and add zero: a coordinate that lands on -1e-11
  // formats as "-0.000000" and so reads as a different sphere from the one at
  // "0.000000". That let a duplicate of the seed through and it registered as an
  // overlap of exactly twice its radius.
  const nz = (x) => { const q = Math.round(x * 1e6) / 1e6; return (q + 0).toFixed(6); };
  const key = (t) => t.o.map(nz).join(',') + '|' + nz(t.r);
  const seen = [{ o: seed.o, r: seed.r }];
  const keys = new Set([key(seen[0])]);
  let frontier = seen.slice();
  for (let d = 0; d < depth && seen.length < limit; d++) {
    const next = [];
    for (const t of frontier) {
      const cands = m.ns.map((n) => ({ o: reflect(t.o, n), r: t.r }));
      const im = invert(t.o, t.r);
      if (im) cands.push(im);
      for (const cd of cands) {
        if (cd.r < 1e-4 || keys.has(key(cd))) continue;
        keys.add(key(cd));
        seen.push(cd); next.push(cd);
        if (seen.length >= limit) break;
      }
    }
    frontier = next;
  }
  return seen;
}

function packingStats(m, seed, depth = 9, limit = 400) {
  const sp = orbit(m, seed, depth, limit);
  let overlap = 0, tangent = 0, horoErr = 0;
  for (const t of sp) horoErr = Math.max(horoErr, Math.abs(norm(t.o) + t.r - 1));
  for (let i = 0; i < sp.length; i++) {
    for (let j = i + 1; j < sp.length; j++) {
      const gap = norm(sub(sp[i].o, sp[j].o)) - (sp[i].r + sp[j].r);
      if (gap < -overlap) overlap = -gap;
      if (Math.abs(gap) < 1e-9) tangent++;
    }
  }
  return { n: sp.length, overlap, tangent, horoErr, spheres: sp };
}

const st = packingStats(m536, hb);
check('the orbit keeps producing new spheres', st.n > 40, `n=${st.n}`);
check('no two spheres in the orbit overlap', st.overlap < 1e-12,
      `worst overlap ${st.overlap}`);
check('they are genuinely tangent to one another, not merely disjoint',
      st.tangent > 20, `${st.tangent} tangent pairs`);
check('every image is a horoball: |centre| + radius = 1', st.horoErr < 1e-12,
      `worst ${st.horoErr}`);

// The control. {5,3,4} is compact -- no ideal vertex, so no cusp and no
// horoball to seed with. The same code must NOT produce a packing.
const m534 = mirrors(5, 3, 4);
const hb534 = horoball(m534);
check('the compact {5,3,4} has NO ideal vertex', Math.abs(hb534.disc) > 0.1,
      `disc=${hb534.disc}`);
check('...its vertex is strictly inside the ball', norm(hb534.v) < 0.99);
const st534 = packingStats(m534, hb534);
check('...and the same construction there overlaps badly', st534.overlap > 0.1,
      `overlap ${st534.overlap}`);
check('...with images that are not tangent to the boundary', st534.horoErr > 0.1,
      `error ${st534.horoErr}`);

// ---- the estimator, transliterated from the shader -------------------------
function deKleinPack(pos) {
  const r = norm(pos);
  const clip = r - KP.R_CLIP;
  if (r >= 0.999) return { dist: clip, word: 0 };

  let p = pos, factor = 1, word = 0;
  for (let i = 0; i < KP.ITERS; i++) {
    let moved = false;
    const d0 = dot(p, KP.N0);
    if (d0 > 0) { p = sub(p, mul(KP.N0, 2 * d0)); moved = true; }
    const d1 = dot(p, KP.N1);
    if (d1 > 0) { p = sub(p, mul(KP.N1, 2 * d1)); moved = true; }
    const d2 = dot(p, KP.N2);
    if (d2 > 0) { p = sub(p, mul(KP.N2, 2 * d2)); moved = true; }
    const v = sub(p, KP.CEN);
    const q2 = dot(v, v);
    if (q2 < KP.S2) {
      const k = KP.S2 / Math.max(q2, 1e-18);
      p = addv(KP.CEN, mul(v, k));
      factor *= k;
      moved = true;
    }
    if (!moved) break;
    word++;
  }
  const horo = KP.SAFETY * (norm(sub(p, KP.HO)) - KP.HR) / Math.max(factor, 1e-9);
  return { dist: Math.max(horo, clip), word };
}

// A deterministic spread of points, so the run is reproducible.
function points(n, radius) {
  const out = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  while (out.length < n) {
    const p = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    if (norm(p) <= 1 && norm(p) > 1e-6) out.push(mul(p, radius / 1));
  }
  return out;
}

// Conservative: the estimator may never claim more room than the nearest KNOWN
// sphere leaves. Anything else and the march steps through a surface.
let worstOver = 0, tested = 0;
for (const p of points(1500, 0.9)) {
  if (norm(p) > 0.9) continue;
  const brute = Math.min(...st.spheres.map((t) => norm(sub(p, t.o)) - t.r));
  if (brute <= 0) continue;                  // inside a known sphere
  const d = deKleinPack(p).dist;
  tested++;
  if (d - brute > worstOver) worstOver = d - brute;
}
check('the estimator never over-reports the distance', worstOver < 1e-6,
      `worst excess ${worstOver.toFixed(8)} over ${tested} points`);

// Inside a sphere it must report inside, or the surface has holes.
let insideOk = 0, insideBad = 0;
for (const t of st.spheres.slice(0, 24)) {
  const d = deKleinPack(t.o).dist;
  if (d < 0) insideOk++; else insideBad++;
}
check('the centre of every orbit sphere reads as inside', insideBad === 0,
      `${insideBad} of ${insideOk + insideBad} failed`);

// The hollow core is what makes this one viewable from outside where the other
// three cusped honeycombs are not: nothing reaches within 0.45 of the centre.
let coreHits = 0;
for (const p of points(2000, 0.44)) {
  if (deKleinPack(p).dist <= 0) coreHits++;
}
check('the middle of the ball is empty, so the packing can be seen into',
      coreHits === 0, `${coreHits} points inside the packing`);

// Nothing may reach outside the ball, and the clip has to bound it.
let outside = 0;
for (const p of points(800, 1.6)) {
  if (norm(p) > 1.0 && deKleinPack(p).dist <= 0) outside++;
}
check('nothing is drawn outside the unit ball', outside === 0);

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`(orbit sampled: ${st.n} spheres, ${st.tangent} tangent pairs, `
  + `worst overlap ${st.overlap.toExponential(1)})`);
process.exit(failed ? 1 : 0);
