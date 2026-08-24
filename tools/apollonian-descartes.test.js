// Canonical 3D Apollonian / Descartes sphere packing.
// Run: node tools/apollonian-descartes.test.js
//
// This checks the mathematics the shader relies on rather than merely checking
// that a slider exists: the seed satisfies Soddy-Gossett, every pair of inner
// spheres is tangent, every dual generator is orthogonal to the four spheres it
// must fix, and inversion through that dual produces exactly the alternate
// Descartes curvature.

import fs from 'node:fs';
import { FRACTAL_WGSL } from '../src/shaders/fractal.wgsl.js';
import { paramsFor, defaultsFor } from '../src/shape-params.js';

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}
const near = (a, b, e = 1e-8) => Math.abs(a - b) <= e;
const add = (a,b) => a.map((x,i) => x+b[i]);
const sub = (a,b) => a.map((x,i) => x-b[i]);
const mul = (a,s) => a.map((x) => x*s);
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const len = (a) => Math.sqrt(dot(a,a));
const unit = (a) => mul(a, 1/len(a));

console.log('\nCanonical Apollonian packing: Descartes seed and dual inversions');

const schema = paramsFor('penrose');
ok(schema.map((p) => p.key).join(',') === 'seedCurvature,recursionDepth',
   'retired id 8 exposes curvature and recursion depth only');
const defaults = defaultsFor('penrose');
const KMIN = 1 + Math.sqrt(6) / 2;
ok(near(defaults.seedCurvature, KMIN, 1e-12),
   'default curvature is the symmetric tetrahedral value 1+sqrt(6)/2');
ok(defaults.recursionDepth === 18, 'default recursion depth is 18');

const shader = FRACTAL_WGSL;
const start = shader.indexOf('fn dePenrose');
const body = shader.slice(start, shader.indexOf('\n}', start) + 2);
ok(start >= 0, 'runtime id-8 estimator exists');
ok(body.includes('9.0 * k * k - 18.0 * k - 3.0'),
   'fourth curvature is derived from the 3D Descartes discriminant');
ok(body.includes('0.85 * base / max(factor, 1e-9)'),
   'measured conservative pull-back factor is present');
ok(!body.includes('u.time') && !body.includes('reducedMotion'),
   'canonical packing geometry has no autonomous animation competing with sliders');

function solveUnitPlanes(a,b,c) {
  const bc = cross(b,c), ca = cross(c,a), ab = cross(a,b);
  const det = dot(a,bc);
  return mul(add(add(bc,ca),ab), 1/det);
}

function makeSeed(k) {
  const disc = 9*k*k - 18*k - 3;
  const k4 = 0.5*(3*k - 1 - Math.sqrt(disc));
  const curvatures = [-1,k,k,k,k4];
  const r = 1/k, r4 = 1/k4;
  const h = 1-r, h4 = 1-r4;
  const pair = 2*r;
  const c1 = [h,0,0];
  const x2 = (2*h*h - pair*pair)/(2*h);
  const y2 = Math.sqrt(h*h-x2*x2);
  const c2 = [x2,y2,0];
  const pairDot = 0.5*(2*h*h-pair*pair);
  const x3 = pairDot/h;
  const y3 = (pairDot-x3*x2)/y2;
  const z3 = Math.sqrt(h*h-x3*x3-y3*y3);
  const c3 = [x3,y3,z3];
  const pair4 = r+r4;
  const dot4 = 0.5*(h4*h4+h*h-pair4*pair4);
  const x4 = dot4/h;
  const y4 = (dot4-x4*x2)/y2;
  const z4 = (dot4-x4*x3-y4*y3)/z3;
  const c4 = [x4,y4,z4];
  return { curvatures, radii:[r,r,r,r4], centers:[c1,c2,c3,c4] };
}

function invertSphere(c, r, d, R2) {
  const v = sub(c,d);
  const den = dot(v,v)-r*r;
  return {
    c: add(d, mul(v, R2/den)),
    r: Math.abs(R2*r/den),
  };
}

for (const k of [KMIN, 2.4, 2.8, 3.2]) {
  const seed = makeSeed(k);
  const s = seed.curvatures.reduce((a,b) => a+b, 0);
  const q = seed.curvatures.reduce((a,b) => a+b*b, 0);
  ok(near(s*s, 3*q, 2e-8), `k=${k.toFixed(3)} satisfies 3D Soddy-Gossett`);

  let tangent = true;
  for (let i=0; i<4; i++) {
    tangent &&= near(len(seed.centers[i]), 1-seed.radii[i], 2e-8);
    for (let j=i+1; j<4; j++) {
      tangent &&= near(len(sub(seed.centers[i],seed.centers[j])),
                      seed.radii[i]+seed.radii[j], 2e-8);
    }
  }
  ok(tangent, `k=${k.toFixed(3)} places four pairwise tangent spheres inside the unit sphere`);

  const normals = seed.centers.map(unit);
  for (let excluded=0; excluded<4; excluded++) {
    const held = [0,1,2,3].filter((j) => j !== excluded);
    const d = solveUnitPlanes(normals[held[0]], normals[held[1]], normals[held[2]]);
    const R2 = dot(d,d)-1;
    let orthogonal = R2 > 0;
    for (const j of held) {
      const lhs = dot(sub(d,seed.centers[j]), sub(d,seed.centers[j]));
      orthogonal &&= near(lhs, R2 + seed.radii[j]*seed.radii[j], 3e-8);
    }
    ok(orthogonal, `k=${k.toFixed(3)} generator ${excluded+1} is orthogonal to all four fixed spheres`);

    const image = invertSphere(seed.centers[excluded], seed.radii[excluded], d, R2);
    const oldK = 1/seed.radii[excluded];
    const otherSum = seed.curvatures.reduce((sum,x,idx) => idx === excluded+1 ? sum : sum+x, 0);
    const alternateK = otherSum - oldK; // roots sum to the other four curvatures in 3D
    ok(near(1/image.r, alternateK, 5e-8),
       `k=${k.toFixed(3)} generator ${excluded+1} produces the alternate Descartes curvature`);
    ok(near(len(image.c)+image.r, 1, 5e-8),
       `k=${k.toFixed(3)} replacement sphere remains internally tangent to the enclosure`);
  }
}

const ui = fs.readFileSync('src/apollonian-descartes-ui.js','utf8');
ok(ui.includes('Canonical Apollonian sphere packing (Descartes)') && ui.includes("INTERNAL_KEY = 'penrose'"),
   'browser adapter exposes the retired slot under its canonical public name');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
