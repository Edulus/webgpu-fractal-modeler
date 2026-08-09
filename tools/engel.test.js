// Engel plesiohedron tiling. Run: node tools/engel.test.js
//
// The three constant tables in engel.wgsl.js are GENERATED, so this test reads
// them back out of the shader source itself rather than keeping a second copy
// that could drift. What is checked is that they describe a space-filling
// tiling by one 38-faced polyhedron, which is a strong enough claim that a
// wrong table cannot satisfy it by accident:
//
//   * every face plane of every cell is the perpendicular bisector between that
//     cell's site and another site -- which is the definition of a Voronoi cell,
//     and ties the sites, the rotations and the planes together in one check;
//   * every point of space lies inside its own nearest site's cell, which is the
//     statement that the cells TILE rather than merely sit near each other;
//   * the estimator is 1-Lipschitz, so it is a true signed distance and needs no
//     safety factor, unlike every iterative estimator in this project.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'shaders', 'engel.wgsl.js'), 'utf8');

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else { failed++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
};

// ---- read the tables out of the shader -------------------------------------
function table(name, arity) {
  const start = src.indexOf(`${name} : array<`);
  if (start < 0) throw new Error(`no table ${name}`);
  const open = src.indexOf('(', src.indexOf('array<', src.indexOf('=', start)));
  const end = src.indexOf('\n);', open);
  const body = src.slice(open, end);
  const re = new RegExp(`vec${arity}<f32>\\(([^)]*)\\)`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(body))) {
    const v = m[1].split(',').map((s) => parseFloat(s));
    if (v.length !== arity || v.some(Number.isNaN)) throw new Error(`bad entry in ${name}`);
    out.push(v);
  }
  return out;
}

const SITES = table('ENGEL_SITE', 3);
const ROT = table('ENGEL_ROT', 3);
const PLANES = table('ENGEL_PLANE', 4);
const GAP = parseFloat(/const GAP : f32 = ([0-9.]+)/.exec(src)[1]);
const CLIP = parseFloat(/const R_CLIP : f32 = ([0-9.]+)/.exec(src)[1]);

check('48 sites', SITES.length === 48, `${SITES.length}`);
check('144 rotation rows (three per site)', ROT.length === 144, `${ROT.length}`);
check('38 face planes — the maximum a plesiohedron can have',
      PLANES.length === 38, `${PLANES.length}`);

// ---- basic sanity ----------------------------------------------------------
check('every site lies in the unit cell',
      SITES.every((s) => s.every((c) => c >= 0 && c < 1)));
{
  let dup = 0;
  for (let i = 0; i < SITES.length; i++) {
    for (let j = i + 1; j < SITES.length; j++) {
      if (SITES[i].every((c, k) => Math.abs(c - SITES[j][k]) < 1e-9)) dup++;
    }
  }
  check('the 48 sites are distinct', dup === 0, `${dup} duplicates`);
}
check('face normals are unit length',
      PLANES.every((p) => Math.abs(Math.hypot(p[0], p[1], p[2]) - 1) < 1e-6));
check('face offsets are positive, so the site is inside its own cell',
      PLANES.every((p) => p[3] > 0));

// Rotations must be genuine rotations: orthonormal, determinant +1. A reflection
// would slip in a mirror image of the cell and the tiling would not close up.
{
  let bad = 0, det1 = 0;
  for (let i = 0; i < 48; i++) {
    const R = [ROT[i * 3], ROT[i * 3 + 1], ROT[i * 3 + 2]];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        const d = R[a][0] * R[b][0] + R[a][1] * R[b][1] + R[a][2] * R[b][2];
        if (Math.abs(d - (a === b ? 1 : 0)) > 1e-9) bad++;
      }
    }
    const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1])
              - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0])
              + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
    if (Math.abs(det - 1) < 1e-9) det1++;
  }
  check('every stored rotation is orthonormal', bad === 0, `${bad} bad entries`);
  check('and proper (determinant +1, no reflections)', det1 === 48, `${det1}/48`);
}

// ---- the Voronoi property --------------------------------------------------
// A face plane at offset h with normal n means the neighbouring site sits at
// 2h*n from this one -- that is what "perpendicular bisector" means. Carry each
// canonical plane out to each site through that site's rotation and the result
// must land on another site of the orbit, modulo the lattice.
{
  const key = (v) => v.map((c) => {
    const q = Math.round(((c % 1) + 1) % 1 * 1e6) / 1e6;
    return (q >= 1 ? q - 1 : q).toFixed(6);
  }).join(',');
  const known = new Set(SITES.map(key));
  let missed = 0, worst = 0, count = 0;
  for (let i = 0; i < 48; i++) {
    const R = [ROT[i * 3], ROT[i * 3 + 1], ROT[i * 3 + 2]];
    for (const p of PLANES) {
      // canonical offset to the neighbour, then R (not R^T) back to world
      const c = [2 * p[3] * p[0], 2 * p[3] * p[1], 2 * p[3] * p[2]];
      const w = [0, 1, 2].map((k) => R[0][k] * c[0] + R[1][k] * c[1] + R[2][k] * c[2]);
      const nb = [0, 1, 2].map((k) => SITES[i][k] + w[k]);
      count++;
      if (!known.has(key(nb))) {
        missed++;
        // how far off, for the report
        let best = 9;
        for (const s of SITES) {
          let d = 0;
          for (let k = 0; k < 3; k++) {
            let t = Math.abs(((nb[k] % 1) + 1) % 1 - s[k]);
            t = Math.min(t, 1 - t);
            d += t * t;
          }
          best = Math.min(best, Math.sqrt(d));
        }
        worst = Math.max(worst, best);
      }
    }
  }
  check('every face bisects the gap to another site of the orbit',
        missed === 0, `${missed} of ${count} miss, worst by ${worst.toExponential(2)}`);
}

// ---- the estimator, transliterated from the shader -------------------------
function de(pos, gap = GAP, clip = CLIP) {
  const xf = pos.map((c) => c - Math.floor(c));
  let bq = 1e9, bd = [0, 0, 0], bi = 0;
  for (let i = 0; i < 48; i++) {
    const d = [0, 1, 2].map((k) => xf[k] - SITES[i][k]);
    for (let k = 0; k < 3; k++) d[k] -= Math.round(d[k]);
    const q = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    if (q < bq) { bq = q; bd = d; bi = i; }
  }
  const R = [ROT[bi * 3], ROT[bi * 3 + 1], ROT[bi * 3 + 2]];
  const y = R.map((r) => r[0] * bd[0] + r[1] * bd[1] + r[2] * bd[2]);
  let d = -1e9;
  for (const p of PLANES) d = Math.max(d, p[0] * y[0] + p[1] * y[1] + p[2] * y[2] - p[3]);
  return Math.max(d + gap, Math.hypot(...pos) - clip);
}

function points(n, spread) {
  const out = [];
  let seed = 20260809;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < n; i++) out.push([0, 1, 2].map(() => (rnd() * 2 - 1) * spread));
  return out;
}

// THE tiling test. With no erosion, every point of space is inside the cell of
// its own nearest site -- that is exactly what it means for the cells to fill
// space with no gaps and no overlaps. A wrong rotation or a missing face shows
// up here immediately.
{
  let outside = 0, worst = 0;
  const pts = points(6000, 1.4);
  for (const p of pts) {
    const d = de(p, 0, 1e9);
    if (d > 1e-9) { outside++; worst = Math.max(worst, d); }
  }
  check('the cells tile space: no point falls outside its own cell',
        outside === 0, `${outside} of ${pts.length}, worst by ${worst.toExponential(2)}`);
}

// Eroding opens the joints: some of space must now be empty, but most of a cell
// must survive, or the tiling reads as dust.
{
  let empty = 0;
  const pts = points(6000, 1.4);
  for (const p of pts) if (de(p, GAP, 1e9) > 0) empty++;
  const frac = empty / pts.length;
  check('the gap opens the joints', frac > 0.05, `${(100 * frac).toFixed(1)}% empty`);
  check('without eating the cells', frac < 0.6, `${(100 * frac).toFixed(1)}% empty`);
}

// 1-Lipschitz: the defining property of a signed distance, and the reason this
// estimator needs no safety factor when every iterative one here does.
{
  let worst = 0, bad = 0;
  const a = points(4000, 1.2);
  for (const p of a) {
    const q = p.map((c) => c + (Math.random() - 0.5) * 0.08);
    const step = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    const r = Math.abs(de(p) - de(q)) / Math.max(step, 1e-12);
    worst = Math.max(worst, r);
    if (r > 1 + 1e-9) bad++;
  }
  check('the estimator is 1-Lipschitz', bad === 0,
        `${bad} pairs exceed 1, worst ratio ${worst.toFixed(4)}`);
}

// The clip bounds it, or the tiling runs to the horizon and never terminates.
{
  let inside = 0;
  for (const p of points(1500, 3.0)) {
    if (Math.hypot(...p) > CLIP + 0.05 && de(p) <= 0) inside++;
  }
  check('nothing is drawn beyond the clip radius', inside === 0, `${inside} points`);
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`(38 faces, 48 cells per unit cell, gap ${GAP}, clip ${CLIP})`);
process.exit(failed ? 1 : 0);
