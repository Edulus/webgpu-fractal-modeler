// catalog.wgsl.js — distance estimators for the catalogue shapes added with
// the Family/Type/Shape menu (ids 38+). Appended to FRACTAL_WGSL, so the
// visible march, the material pass and the clearance probe all share them.
//
// Every estimator here returns a LOWER bound on distance (a function that is
// 1-Lipschitz, or a value divided by a proven bound on its gradient), so sphere
// tracing cannot step through a surface. Where an estimate is a heuristic
// rather than a bound (the "nearest piece" IFS choices), it says so and is
// scaled down.
//
// No backticks or dollar-brace sequences: this is a JS template literal.

export const CATALOG_WGSL = /* wgsl */ `
// ---- Catalogue shapes --------------------------------------------------------
const CAT_PHI : f32 = 1.61803399;
const CAT_SQRT2 : f32 = 1.41421356;
const CAT_SQRT3 : f32 = 1.73205081;

// Rodrigues rotation about a unit axis.
fn catRot(p : vec3<f32>, axis : vec3<f32>, a : f32) -> vec3<f32> {
  let c = cos(a);
  let s = sin(a);
  return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
}

fn catSegment(p : vec3<f32>, a : vec3<f32>, b : vec3<f32>) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Regular tetrahedron with vertices (s,s,s), (s,-s,-s), (-s,s,-s), (-s,-s,s):
// the largest of its four face-plane distances. Exact inside, a lower bound
// outside.
fn catTetra(p : vec3<f32>, s : f32) -> f32 {
  let m = max(max(-p.x - p.y - p.z, -p.x + p.y + p.z), max(p.x - p.y + p.z, p.x + p.y - p.z));
  return (m - s) / CAT_SQRT3;
}

// IFS depth that follows the quality ladder's iteration budget, so a low rung
// does less recursion: u.detail.y runs 6..18 across the ladder.
fn catLevels(lo : i32, hi : i32) -> i32 {
  return clamp(i32(u.detail.y) - 4, lo, hi);
}

// ---- Triply periodic minimal surfaces -----------------------------------------
// Same construction as the gyroid: a solid sheet of half-thickness h (in field
// units) around the zero set of a trigonometric field, divided by a PROVEN
// bound on the field's gradient (times the frequency), and clipped to a ball
// outside fly-through so the infinite surface reads as an object.
fn catTPMS(pos : vec3<f32>, which : i32) -> DEResult {
  const R : f32 = 1.35;
  const FREQ : f32 = 5.5;
  var res : DEResult;
  let clipped = u.flyMode < 0.5;
  let ball = length(pos) - R;
  if (clipped && ball > 0.25) {
    res.dist = ball;
    res.trap = 0.4;
    return res;
  }
  let q = pos * FREQ;
  let s = sin(q);
  let c = cos(q);
  var f = 0.0;
  var lip = 1.0;
  var half = 0.3;
  if (which == 0) {
    // Schwarz P: cos x + cos y + cos z. |grad| <= sqrt3.
    f = c.x + c.y + c.z;
    lip = CAT_SQRT3;
    half = 0.45;
  } else if (which == 1) {
    // Schwarz D (diamond). Each partial derivative is cx cos(y-z) - sx sin(y+z),
    // at most sqrt2 by Cauchy-Schwarz, so |grad| <= sqrt6.
    f = s.x * s.y * s.z + s.x * c.y * c.z + c.x * s.y * c.z + c.x * c.y * s.z;
    lip = 2.44948974;
    half = 0.32;
  } else if (which == 2) {
    // Neovius: 3(cx + cy + cz) + 4 cx cy cz. |d/dx| = |sx (3 + 4 cy cz)| <= 7.
    f = 3.0 * (c.x + c.y + c.z) + 4.0 * c.x * c.y * c.z;
    lip = 7.0 * CAT_SQRT3;
    half = 1.7;
  } else {
    // Schoen I-WP: 2(cx cy + cy cz + cz cx) - (c2x + c2y + c2z).
    // d/dx = 2 sx (2cx - cy - cz) gives a provable 8 sqrt3 = 13.9, but the
    // gradient never exceeds 3 sqrt3 = 5.196 (dense sampling of the periodic
    // cell, tools/catalog-shapes.test.js), and a bound 2.7x too large makes
    // rays crawl. 6.0 is that MEASURED maximum plus 15%, the same practice as
    // the measured safety factors elsewhere in the estimators.
    let c2 = cos(2.0 * q);
    f = 2.0 * (c.x * c.y + c.y * c.z + c.z * c.x) - (c2.x + c2.y + c2.z);
    lip = 6.0;
    half = 1.1;
  }
  let shell = (abs(f) - half) / (lip * FREQ);
  res.dist = select(shell, max(shell, ball), clipped);
  // The two faces look into the two interpenetrating labyrinths.
  res.trap = 0.22 + 0.42 * select(0.0, 1.0, f >= 0.0) + 0.16 * clamp(0.5 + 0.25 * (c.x - c.y), 0.0, 1.0);
  return res;
}

// ---- Algebraic surfaces --------------------------------------------------------
// Polynomials in surface coordinates q = pos / S. Distance is |f| / |grad f|
// (in world units), with Barth's guards: a floor on the gradient (it vanishes at
// the nodes, which ARE on the surface) and a step cap (critical points away from
// the surface). The surfaces are unbounded, so they are clipped to a ball.
fn catPoly(q : vec3<f32>, which : i32) -> f32 {
  if (which == 0) {
    // Cayley nodal cubic in tetrahedral form: 1/p1 + 1/p2 + 1/p3 + 1/p4 = 0
    // with p_i the four face planes of a regular tetrahedron, cleared of
    // denominators. Its four nodes are the tetrahedron's vertices, where three
    // planes meet -- the most a cubic surface can have.
    let p1 = 1.0 - (q.x + q.y + q.z);
    let p2 = 1.0 - (q.x - q.y - q.z);
    let p3 = 1.0 - (-q.x + q.y - q.z);
    let p4 = 1.0 - (-q.x - q.y + q.z);
    return p2 * p3 * p4 + p1 * p3 * p4 + p1 * p2 * p4 + p1 * p2 * p3;
  } else if (which == 1) {
    // Clebsch diagonal cubic (affine form): the cubic surface on which all 27
    // lines are real.
    let x = q.x; let y = q.y; let z = q.z;
    return 81.0 * (x * x * x + y * y * y + z * z * z)
         - 189.0 * (x * x * y + x * x * z + y * y * x + y * y * z + z * z * x + z * z * y)
         + 54.0 * x * y * z + 126.0 * (x * y + x * z + y * z)
         - 9.0 * (x * x + y * y + z * z) - 9.0 * (x + y + z) + 1.0;
  }
  // Kummer quartic with 16 real nodes: (r^2 - mu^2)^2 - lambda * pqrs, where p..s
  // are the faces of a tetrahedron and lambda = (3mu^2 - 1)/(3 - mu^2).
  let mu2 = 1.3;
  let lam = (3.0 * mu2 - 1.0) / (3.0 - mu2);
  let r2 = dot(q, q) - mu2;
  let p = 1.0 - q.z - CAT_SQRT2 * q.x;
  let qq = 1.0 - q.z + CAT_SQRT2 * q.x;
  let r = 1.0 + q.z + CAT_SQRT2 * q.y;
  let s = 1.0 + q.z - CAT_SQRT2 * q.y;
  return r2 * r2 - lam * p * qq * r * s;
}

fn catAlgebraic(pos : vec3<f32>, which : i32) -> DEResult {
  var S = 0.55;      // world size of one surface unit
  var R = 1.45;      // clipping ball (world)
  if (which == 1) { S = 0.85; R = 1.35; }
  if (which == 2) { S = 0.62; R = 1.45; }
  const GFLOOR : f32 = 0.5;
  const MAXSTEP : f32 = 0.12;
  var res : DEResult;
  let ball = length(pos) - R;
  if (ball > 0.3) {
    res.dist = ball;
    res.trap = 0.4;
    return res;
  }
  let q = pos / S;
  let f = catPoly(q, which);
  let h = 1e-3;
  let g = vec3<f32>(
    catPoly(q + vec3<f32>(h, 0.0, 0.0), which) - catPoly(q - vec3<f32>(h, 0.0, 0.0), which),
    catPoly(q + vec3<f32>(0.0, h, 0.0), which) - catPoly(q - vec3<f32>(0.0, h, 0.0), which),
    catPoly(q + vec3<f32>(0.0, 0.0, h), which) - catPoly(q - vec3<f32>(0.0, 0.0, h), which)) / (2.0 * h);
  let d = min(S * abs(f) / max(length(g), GFLOOR), MAXSTEP);
  res.dist = max(d, ball);
  res.trap = clamp(0.15 + 0.6 * length(pos) / R, 0.0, 1.0);
  return res;
}

// ---- Star polyhedra: stellations of the dodecahedron ----------------------------
// The dodecahedron's twelve face planes come in six parallel pairs, one per
// icosahedron vertex direction. The k-th largest of |p . u_j| measured against
// the inradius c gives the stellation layers: k = 1 the dodecahedron, 2 the
// small stellated dodecahedron (the shipped envdodec), 3 the great dodecahedron,
// 4 the great stellated dodecahedron. An order statistic of 1-Lipschitz
// functions is 1-Lipschitz, so this is a safe distance bound.
fn catStellation(pos : vec3<f32>, k : i32, c : f32) -> DEResult {
  const A : f32 = 0.85065081;
  const B : f32 = 0.52573111;
  var v = array<f32, 6>(
    abs(A * pos.x + B * pos.y),
    abs(B * pos.x + A * pos.z),
    abs(A * pos.y + B * pos.z),
    abs(B * pos.x - A * pos.z),
    abs(A * pos.y - B * pos.z),
    abs(A * pos.x - B * pos.y));
  // Partial selection sort: the first k entries end up largest-first.
  for (var i = 0; i < 4; i = i + 1) {
    var best = i;
    for (var j = i + 1; j < 6; j = j + 1) {
      if (v[j] > v[best]) { best = j; }
    }
    let t = v[i];
    v[i] = v[best];
    v[best] = t;
  }
  var res : DEResult;
  let mk = v[k - 1];
  res.dist = mk - c;
  // Depth into a spike: the gap between the top value and the k-th.
  res.trap = clamp(0.15 + 0.6 * (v[0] - mk) / (3.0 * c), 0.0, 1.0);
  return res;
}

// ---- Polyhedron compounds -------------------------------------------------------
// Five cubes (or five tetrahedra) inscribed in one dodecahedron. The cube with
// vertices (+-1,+-1,+-1) is one of the five; a fifth-turn about a five-fold axis
// of that dodecahedron, (0, 1, phi), carries it to the next.
fn catCompound5(pos : vec3<f32>, cubes : bool) -> DEResult {
  let axis = normalize(vec3<f32>(0.0, 1.0, CAT_PHI));
  let s = select(0.62, 0.56, cubes);
  var d = 1e9;
  var which = 0;
  for (var k = 0; k < 5; k = k + 1) {
    let q = catRot(pos, axis, -f32(k) * 1.25663706);
    var dk = 0.0;
    if (cubes) { dk = sdBox(q, vec3<f32>(s)); } else { dk = catTetra(q, s); }
    if (dk < d) { d = dk; which = k; }
  }
  var res : DEResult;
  res.dist = d;
  res.trap = 0.12 + 0.17 * f32(which);
  return res;
}

// ---- Self-similar (IFS) solids ---------------------------------------------------
fn catSierpinski(pos : vec3<f32>) -> DEResult {
  const S0 : f32 = 1.0;
  var p = pos / S0;
  var scale = 1.0;
  var trap = 0.0;
  let n = catLevels(4, 10);
  for (var i = 0; i < 10; i = i + 1) {
    if (i >= n) { break; }
    // Reflect into the region of the vertex (1,1,1)...
    if (p.x + p.y < 0.0) { p = vec3<f32>(-p.y, -p.x, p.z); trap = trap + 0.11; }
    if (p.x + p.z < 0.0) { p = vec3<f32>(-p.z, p.y, -p.x); trap = trap + 0.07; }
    if (p.y + p.z < 0.0) { p = vec3<f32>(p.x, -p.z, -p.y); trap = trap + 0.05; }
    // ...and scale by 2 about it.
    p = p * 2.0 - vec3<f32>(1.0);
    scale = scale * 2.0;
  }
  var res : DEResult;
  res.dist = catTetra(p, 1.0) / scale * S0;
  res.trap = fract(trap * 0.6 + 0.2);
  return res;
}

fn catOctaflake(pos : vec3<f32>) -> DEResult {
  var p = pos;
  var scale = 1.0;
  var trap = 0.0;
  let n = catLevels(4, 9);
  for (var i = 0; i < 9; i = i + 1) {
    if (i >= n) { break; }
    p = abs(p);
    // Largest coordinate first: the copy at that axis's vertex is the nearest.
    if (p.x < p.y) { p = p.yxz; trap = trap + 0.07; }
    if (p.x < p.z) { p = p.zyx; trap = trap + 0.05; }
    // Six half-size octahedra at (+-1/2,0,0) and permutations.
    p = p * 2.0 - vec3<f32>(1.0, 0.0, 0.0);
    scale = scale * 2.0;
  }
  let a = abs(p);
  var res : DEResult;
  res.dist = (a.x + a.y + a.z - 1.0) / CAT_SQRT3 / scale;
  res.trap = fract(trap + 0.15);
  return res;
}

// Jerusalem cube: 8 corner cubes of ratio r = sqrt2 - 1 and 12 edge cubes of
// ratio r^2 (2r + r^2 = 1). The fold reduces to one corner and one edge
// candidate; the nearer BOX is followed. That choice is a heuristic -- a deeper
// level of the other piece can be nearer -- so the estimate is scaled down.
fn catJerusalem(pos : vec3<f32>) -> DEResult {
  const R1 : f32 = 0.41421356;
  const R2 : f32 = 0.17157288;
  var p = pos;
  var scale = 1.0;
  var trap = 0.0;
  let n = catLevels(3, 7);
  for (var i = 0; i < 7; i = i + 1) {
    if (i >= n) { break; }
    p = abs(p);
    if (p.x < p.y) { p = p.yxz; }
    if (p.x < p.z) { p = p.zyx; }
    if (p.y < p.z) { p = p.xzy; }
    let cCorner = vec3<f32>(1.0 - R1);
    let cEdge = vec3<f32>(1.0 - R2, 1.0 - R2, 0.0);
    let dC = sdBox(p - cCorner, vec3<f32>(R1));
    let dE = sdBox(p - cEdge, vec3<f32>(R2));
    if (dC <= dE) {
      p = (p - cCorner) / R1;
      scale = scale * R1;
      trap = trap + 0.09;
    } else {
      p = (p - cEdge) / R2;
      scale = scale * R2;
      trap = trap + 0.23;
    }
  }
  var res : DEResult;
  res.dist = 0.8 * sdBox(p, vec3<f32>(1.0)) * scale;
  res.trap = fract(trap + 0.1);
  return res;
}

// Cantor dust: the product of three Cantor sets, i.e. the cubes left after
// removing middle thirds along every axis at every level. Each axis is carved
// like the Menger sponge (fold, then cut the gap), and the three are intersected.
fn catCantor1(x0 : f32, n : i32) -> f32 {
  var x = x0;
  var d = abs(x) - 1.0;
  var s = 1.0;
  for (var i = 0; i < 8; i = i + 1) {
    if (i >= n) { break; }
    x = abs(x);
    d = max(d, (1.0 / 3.0 - x) / s);
    x = 3.0 * x - 2.0;
    s = s * 3.0;
  }
  return d;
}

fn catCantorDust(pos : vec3<f32>) -> DEResult {
  let n = catLevels(3, 6);
  var res : DEResult;
  res.dist = max(catCantor1(pos.x, n), max(catCantor1(pos.y, n), catCantor1(pos.z, n)));
  let cell = floor(pos * 4.5);
  res.trap = 0.2 + 0.6 * hash13(cell);
  return res;
}

// Stella octangula fractal: a stella octangula built from half-size stellae, at
// its centre and at its eight tips, recursively. Eight half-size copies at the
// corners of a cube tile that cube exactly, so carried on, this converges to
// the solid cube the first star is inscribed in -- by the fifth level it is
// indistinguishable from one. It is therefore shown at its second or third
// stage, where it is still visibly stars made of stars. Base solid: the stella as the
// envelope estimator builds it (second largest |p . d| over the four cube
// diagonals). Nearest-copy choice, so scaled like the Jerusalem cube.
fn catStella(p : vec3<f32>, c : f32) -> f32 {
  let T = 0.57735027;
  let v = vec4<f32>(abs(p.x + p.y + p.z), abs(p.x + p.y - p.z), abs(p.x - p.y + p.z), abs(p.x - p.y - p.z)) * T;
  // Second largest of four, tie-safe: the largest of the six pairwise minima.
  let m2 = max(max(max(min(v.x, v.y), min(v.x, v.z)), max(min(v.x, v.w), min(v.y, v.z))),
               max(min(v.y, v.w), min(v.z, v.w)));
  return m2 - c;
}

fn catStellaFractal(pos : vec3<f32>) -> DEResult {
  const C : f32 = 0.40824829;          // tips at radius 3c = 1.2247
  let tip = vec3<f32>(0.35355339);     // child centre: half-way to a tip
  var p = pos;
  var scale = 1.0;
  var trap = 0.0;
  let n = catLevels(2, 3);
  for (var i = 0; i < 3; i = i + 1) {
    if (i >= n) { break; }
    p = abs(p);
    let dCentre = catStella(p * 2.0, C) * 0.5;
    let dTip = catStella((p - tip) * 2.0, C) * 0.5;
    if (dTip < dCentre) {
      p = (p - tip) * 2.0;
      trap = trap + 0.21;
    } else {
      p = p * 2.0;
      trap = trap + 0.08;
    }
    scale = scale * 0.5;
  }
  var res : DEResult;
  res.dist = 0.8 * catStella(p, C) * scale;
  res.trap = fract(trap + 0.12);
  return res;
}

// Kaleidoscopic IFS, octahedral: fold into one chamber of the octahedral group,
// twist, then scale away from a corner. Folds and the rotation are isometries
// or 1-Lipschitz, so dividing by the accumulated scale keeps it a bound.
fn catKIFS(pos : vec3<f32>) -> DEResult {
  const SCALE : f32 = 2.2;
  let offset = vec3<f32>(1.0, 0.72, 0.38);
  let axis = normalize(vec3<f32>(1.0, 1.0, 1.0));
  var p = pos * 1.25;
  var scale = 1.25;
  var trap = 1e9;
  let n = catLevels(5, 12);
  for (var i = 0; i < 12; i = i + 1) {
    if (i >= n) { break; }
    p = abs(p);
    if (p.x < p.y) { p = p.yxz; }
    if (p.x < p.z) { p = p.zyx; }
    if (p.y < p.z) { p = p.xzy; }
    p = catRot(p, axis, 0.26);
    p = p * SCALE - offset * (SCALE - 1.0);
    scale = scale * SCALE;
    trap = min(trap, dot(p, p));
  }
  var res : DEResult;
  res.dist = sdBox(p, vec3<f32>(1.0)) / scale;
  res.trap = clamp(0.1 + 0.25 * sqrt(trap), 0.0, 1.0);
  return res;
}

// ---- Euclidean honeycombs ---------------------------------------------------------
// Cells drawn shrunk by a gap so the joints show, clipped to a ball, coloured by
// a hash of the cell -- the Engel plesiohedron's presentation.
fn catHoneycomb(pos : vec3<f32>, which : i32) -> DEResult {
  const L : f32 = 0.42;     // lattice unit (world)
  const GAP : f32 = 0.05;   // half-gap, in lattice units
  const R : f32 = 1.15;
  var res : DEResult;
  let ball = length(pos) - R;
  if (ball > 0.3) {
    res.dist = ball;
    res.trap = 0.4;
    return res;
  }
  let q = pos / L;
  var d = 0.0;
  var cell = vec3<f32>(0.0);
  if (which == 0) {
    // Cubic honeycomb: the planes x, y, z = integer.
    let t = abs(q - round(q));
    d = GAP - min(t.x, min(t.y, t.z));
    cell = floor(q);
  } else if (which == 1) {
    // Tetrahedral-octahedral honeycomb: the four plane families
    // +-x +-y +-z = integer cut space into regular tetrahedra and octahedra.
    let a = vec4<f32>(q.x + q.y + q.z, q.x - q.y - q.z, -q.x + q.y - q.z, -q.x - q.y + q.z);
    let t = abs(a - round(a)) / CAT_SQRT3;
    d = GAP - min(min(t.x, t.y), min(t.z, t.w));
    cell = vec3<f32>(floor(a.x) + 0.5 * floor(a.w), floor(a.y), floor(a.z));
  } else if (which == 2) {
    // Rhombic dodecahedral honeycomb: Voronoi cells of the face-centred cubic
    // lattice (integer points with even coordinate sum). Nearest point first.
    var c = round(q);
    if ((i32(c.x) + i32(c.y) + i32(c.z)) % 2 != 0) {
      let e = q - c;
      let a = abs(e);
      if (a.x >= a.y && a.x >= a.z) { c.x = c.x + select(-1.0, 1.0, e.x >= 0.0); }
      else if (a.y >= a.z) { c.y = c.y + select(-1.0, 1.0, e.y >= 0.0); }
      else { c.z = c.z + select(-1.0, 1.0, e.z >= 0.0); }
    }
    let v = abs(q - c);
    d = max(v.x + v.y, max(v.y + v.z, v.x + v.z)) / CAT_SQRT2 - (0.70710678 - GAP);
    cell = c;
  } else {
    // Bitruncated cubic (Kelvin) honeycomb: Voronoi cells of the body-centred
    // cubic lattice, truncated octahedra. Nearest of the two cubic sublattices.
    let c1 = round(q);
    let c2 = floor(q) + vec3<f32>(0.5);
    var c = c1;
    if (length(q - c2) < length(q - c1)) { c = c2; }
    let v = abs(q - c);
    d = max(max(v.x, max(v.y, v.z)) - (0.5 - GAP), (v.x + v.y + v.z) / CAT_SQRT3 - (0.4330127 - GAP));
    cell = c;
  }
  res.dist = max(d * L, ball);
  res.trap = 0.15 + 0.7 * hash13(cell + vec3<f32>(f32(which) * 7.1));
  return res;
}

// ---- Ruled surfaces, as string models ----------------------------------------------
// A ruled surface is swept by straight lines, so it is drawn by its lines: thin
// rods along both families of rulings, the way such surfaces were modelled in
// thread a century ago. Only the rods nearest the point are tested.
fn catHyperboloid(pos : vec3<f32>) -> DEResult {
  const A : f32 = 0.45;     // waist radius
  const C : f32 = 0.6;      // x^2 + z^2 - (A/C)^2 y^2 = A^2
  const N : f32 = 28.0;     // rods per family
  const ROD : f32 = 0.011;
  let sMax = 1.0 / C;       // y runs -1..1
  let phi = atan2(pos.z, pos.x);
  let yc = clamp(pos.y, -1.0, 1.0);
  var d = 1e9;
  var fam = 0.0;
  for (var f = 0; f < 2; f = f + 1) {
    let sgn = select(-1.0, 1.0, f == 0);
    // The rod through angle t passes azimuth t + sgn*atan(y/C) at height y.
    let t0 = phi - sgn * atan(yc / C);
    let k0 = round(t0 / (6.28318531 / N));
    for (var j = -1; j <= 1; j = j + 1) {
      let t = (k0 + f32(j)) * 6.28318531 / N;
      let ct = cos(t);
      let st = sin(t);
      let a = vec3<f32>(A * ct + sgn * A * sMax * st, -1.0, A * st - sgn * A * sMax * ct);
      let b = vec3<f32>(A * ct - sgn * A * sMax * st, 1.0, A * st + sgn * A * sMax * ct);
      let dj = catSegment(pos, a, b) - ROD;
      if (dj < d) { d = dj; fam = f32(f); }
    }
  }
  // Rims top and bottom.
  let rTop = A * sqrt(1.0 + sMax * sMax);
  let rim = min(length(vec2<f32>(length(pos.xz) - rTop, pos.y - 1.0)),
                length(vec2<f32>(length(pos.xz) - rTop, pos.y + 1.0))) - ROD * 2.0;
  var res : DEResult;
  res.dist = min(d, rim);
  res.trap = select(0.25 + 0.4 * fam, 0.8, rim < d);
  return res;
}

fn catHypar(pos : vec3<f32>) -> DEResult {
  // y = K u v over the square |u|, |v| <= 1, with u, v the diagonals of x, z.
  const K : f32 = 0.75;
  const N : i32 = 17;       // rods per family
  const ROD : f32 = 0.011;
  let eu = vec3<f32>(0.70710678, 0.0, 0.70710678);
  let ev = vec3<f32>(0.70710678, 0.0, -0.70710678);
  let pu = dot(pos, eu);
  let pv = dot(pos, ev);
  let sp = 2.0 / f32(N - 1);
  var d = 1e9;
  var fam = 0.0;
  for (var f = 0; f < 2; f = f + 1) {
    let across = select(pv, pu, f == 0);
    let i0 = i32(round((across + 1.0) / sp));
    for (var j = -1; j <= 1; j = j + 1) {
      let i = clamp(i0 + j, 0, N - 1);
      let w = -1.0 + f32(i) * sp;
      var a = vec3<f32>(0.0);
      var b = vec3<f32>(0.0);
      if (f == 0) {
        // u = w, v runs -1..1
        a = eu * w - ev + vec3<f32>(0.0, -K * w, 0.0);
        b = eu * w + ev + vec3<f32>(0.0, K * w, 0.0);
      } else {
        a = ev * w - eu + vec3<f32>(0.0, -K * w, 0.0);
        b = ev * w + eu + vec3<f32>(0.0, K * w, 0.0);
      }
      let dj = catSegment(pos, a, b) - ROD;
      if (dj < d) { d = dj; fam = f32(f); }
    }
  }
  var res : DEResult;
  res.dist = d;
  res.trap = 0.25 + 0.4 * fam;
  return res;
}

// ---- Tori ----------------------------------------------------------------------------
fn catTorus(p : vec3<f32>, R : f32, r : f32) -> f32 {
  return length(vec2<f32>(length(p.xz) - R, p.y)) - r;
}

// Horn and spindle tori are drawn as thin shells with a quarter cut away, so the
// place where the tube meets itself (horn) or passes through itself (spindle)
// can be seen. min(x, z) is the distance to the removed quarter.
fn catCutTorus(pos : vec3<f32>, R : f32, r : f32) -> DEResult {
  let t = catTorus(pos, R, r);
  let shell = abs(t) - 0.02;
  var res : DEResult;
  res.dist = max(shell, min(pos.x, pos.z));
  res.trap = select(0.3, 0.7, t < 0.0) + 0.1 * clamp(pos.y, -1.0, 1.0);
  return res;
}

fn catLinkedTori(pos : vec3<f32>) -> DEResult {
  let d1 = catTorus(pos - vec3<f32>(-0.32, 0.0, 0.0), 0.55, 0.13);
  let q = pos - vec3<f32>(0.32, 0.0, 0.0);
  let d2 = catTorus(vec3<f32>(q.x, q.z, q.y), 0.55, 0.13);
  var res : DEResult;
  res.dist = min(d1, d2);
  res.trap = select(0.3, 0.72, d2 < d1);
  return res;
}

// A genus-two surface: a tube around the lemniscate of Bernoulli,
// (x^2 + y^2)^2 = x^2 - y^2, so two holes. f / |grad f| with guards.
fn catGenus2F(q : vec3<f32>) -> f32 {
  let r2 = q.x * q.x + q.y * q.y;
  let l = r2 * r2 - (q.x * q.x - q.y * q.y);
  return l * l + q.z * q.z - 0.012;
}

fn catGenus2(pos : vec3<f32>) -> DEResult {
  const S : f32 = 1.05;
  var res : DEResult;
  let ball = length(pos) - 1.4;
  if (ball > 0.3) {
    res.dist = ball;
    res.trap = 0.4;
    return res;
  }
  let q = pos / S;
  let f = catGenus2F(q);
  let h = 1e-3;
  let g = vec3<f32>(
    catGenus2F(q + vec3<f32>(h, 0.0, 0.0)) - catGenus2F(q - vec3<f32>(h, 0.0, 0.0)),
    catGenus2F(q + vec3<f32>(0.0, h, 0.0)) - catGenus2F(q - vec3<f32>(0.0, h, 0.0)),
    catGenus2F(q + vec3<f32>(0.0, 0.0, h)) - catGenus2F(q - vec3<f32>(0.0, 0.0, h))) / (2.0 * h);
  res.dist = max(min(S * abs(f) / max(length(g), 0.08), 0.1), ball);
  res.trap = clamp(0.2 + 0.5 * abs(q.x), 0.0, 1.0);
  return res;
}

// ---- Implicit and blended forms ------------------------------------------------------
// Metaballs: spheres blended by a polynomial smooth minimum, drifting slowly.
fn catSmin(a : f32, b : f32, k : f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn catMetaballs(pos : vec3<f32>) -> DEResult {
  let tm = select(u.time, 0.0, u.reducedMotion > 0.5) * 0.35;
  var d = 1e9;
  var trap = 0.0;
  for (var i = 0; i < 7; i = i + 1) {
    let fi = f32(i);
    let c = 0.55 * vec3<f32>(sin(tm * (0.7 + 0.13 * fi) + fi * 1.7),
                             cos(tm * (0.6 + 0.11 * fi) + fi * 2.3),
                             sin(tm * (0.5 + 0.07 * fi) + fi * 0.9));
    let di = length(pos - c) - (0.28 + 0.04 * sin(fi * 3.1));
    if (di < d) { trap = fi / 7.0; }
    d = catSmin(d, di, 0.32);
  }
  var res : DEResult;
  res.dist = d;
  res.trap = 0.15 + 0.7 * trap;
  return res;
}

// Superquadric: nested p-norms, ||(||(x, z)||_a, y)||_b - 1. Each norm with
// p >= 1 is 1-Lipschitz, so the composition is a safe bound.
fn catPNorm2(v : vec2<f32>, e : f32) -> f32 {
  let a = abs(v);
  return pow(pow(a.x, e) + pow(a.y, e), 1.0 / e);
}

fn catSuperquadric(pos : vec3<f32>) -> DEResult {
  const S : f32 = 0.95;
  let q = pos / S;
  let r = catPNorm2(q.xz, 4.0);
  var res : DEResult;
  res.dist = (catPNorm2(vec2<f32>(r, q.y), 1.35) - 1.0) * S;
  res.trap = clamp(0.2 + 0.6 * abs(q.y), 0.0, 1.0);
  return res;
}
`;
