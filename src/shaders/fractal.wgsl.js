// fractal.wgsl.js — raymarch pass (vertex + fragment) as an inlined WGSL string.
//
// Inlined (rather than fetched from a .wgsl file) so the demo runs directly
// from file:// with no dev server and no CORS/fetch problems.
//
// Uniform struct layout is mirrored exactly in fractal-bg.js (see UNIFORM_*
// offsets there). Keep the two in lockstep. std140-ish rules: vec3 aligns to
// 16 bytes; we deliberately pack a trailing scalar into each vec3's pad slot.

export const FRACTAL_WGSL = /* wgsl */ `
// ---- Uniforms -------------------------------------------------------------
// Byte offsets (mirror in JS):
//   0   resolution : vec2<f32>
//   8   time       : f32
//   12  dpr        : f32
//   16  camPos     : vec3<f32>   (pad slot -> fov)
//   28  fov        : f32
//   32  camTarget  : vec3<f32>   (pad slot -> fractalType)
//   44  fractalType: f32   (0=mandelbulb, 1=mandelbox, 2=menger, 3=julia,
//                           4=apollonian, 5=spherepack, 6=encrusted,
//                           7=surfacepack, 8=penrose; 9+ are the line-rendered
//                           attractors, which this pass only backgrounds)
//   48  power      : f32
//   52  mbScale    : f32
//   56  mbMinRadius: f32
//   60  mbFixedRad : f32
//   64  paletteA   : vec4<f32>
//   80  paletteB   : vec4<f32>
//   96  paletteC   : vec4<f32>
//   112 paletteD   : vec4<f32>
//   128 glowStrength : f32
//   132 fogDensity   : f32
//   136 shadowSoftness: f32
//   140 aoStrength   : f32
//   144 qualityScale : f32
//   148 bgMode       : f32   (0 = transparent, 1 = gradient background)
//   152 reducedMotion: f32
//   156 _pad         : f32
//   160 viewProj     : mat4x4<f32>  (attractor line rasterization)
struct Uniforms {
  resolution : vec2<f32>,
  time       : f32,
  dpr        : f32,
  camPos     : vec3<f32>,
  fov        : f32,
  camTarget  : vec3<f32>,
  fractalType: f32,
  power      : f32,
  mbScale    : f32,
  mbMinRadius: f32,
  mbFixedRad : f32,
  paletteA   : vec4<f32>,
  paletteB   : vec4<f32>,
  paletteC   : vec4<f32>,
  paletteD   : vec4<f32>,
  glowStrength : f32,
  fogDensity   : f32,
  shadowSoftness: f32,
  aoStrength   : f32,
  qualityScale : f32,
  bgMode       : f32,
  reducedMotion: f32,
  _pad         : f32,
  viewProj     : mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> u : Uniforms;

// ---- Vertex: fullscreen triangle (no vertex buffer) -----------------------
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,   // 0..1 across the screen
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  // Oversized triangle covering the viewport.
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var out : VSOut;
  let xy = p[vid];
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  // Map clip space to 0..1 UV (flip Y so +y is up in world).
  out.uv = vec2<f32>(xy.x * 0.5 + 0.5, 1.0 - (xy.y * 0.5 + 0.5));
  return out;
}

// ---- Constants ------------------------------------------------------------
const PI : f32 = 3.14159265359;
const MAX_STEPS : i32 = 160;
const MAX_DIST  : f32 = 30.0;
const BASE_EPS  : f32 = 0.00035;
const DE_ITERS  : i32 = 12;   // fractal iteration count (static bound)

// Cosine palette.
fn palette(t : f32) -> vec3<f32> {
  return u.paletteA.rgb + u.paletteB.rgb *
         cos(2.0 * PI * (u.paletteC.rgb * t + u.paletteD.rgb));
}

// Orbit trap accumulator carried out of the DE.
struct DEResult {
  dist : f32,
  trap : f32,   // min orbit distance -> palette input
};

// ---- Distance estimators --------------------------------------------------

// Mandelbulb: iterated power-p, analytic DE 0.5*log(r)*r/dr.
fn deMandelbulb(pos : vec3<f32>) -> DEResult {
  var z = pos;
  var dr = 1.0;
  var r = 0.0;
  var trap = 1e10;
  let power = u.power;
  for (var i = 0; i < DE_ITERS; i = i + 1) {
    r = length(z);
    if (r > 2.2) { break; }
    // Orbit trap against origin (and a plane) for iridescent banding.
    trap = min(trap, r);
    // Guard the domain: clamp r away from 0 before log/pow.
    let rr = max(r, 1e-6);
    // running derivative
    dr = pow(rr, power - 1.0) * power * dr + 1.0;
    // to spherical
    var theta = acos(clamp(z.z / rr, -1.0, 1.0));
    var phi = atan2(z.y, z.x);
    let zr = pow(rr, power);
    theta = theta * power;
    phi = phi * power;
    z = zr * vec3<f32>(
      sin(theta) * cos(phi),
      sin(theta) * sin(phi),
      cos(theta)
    ) + pos;
  }
  let rr = max(r, 1e-6);
  var res : DEResult;
  res.dist = 0.5 * log(rr) * rr / max(dr, 1e-6);
  res.trap = trap;
  return res;
}

// Mandelbox: box fold + sphere fold.
fn deMandelbox(pos : vec3<f32>) -> DEResult {
  let scale = u.mbScale;
  let minR2 = u.mbMinRadius * u.mbMinRadius;
  let fixedR2 = u.mbFixedRad * u.mbFixedRad;
  var z = pos;
  var dr = 1.0;
  var trap = 1e10;
  for (var i = 0; i < DE_ITERS; i = i + 1) {
    // box fold
    z = clamp(z, vec3<f32>(-1.0), vec3<f32>(1.0)) * 2.0 - z;
    // sphere fold
    let r2 = dot(z, z);
    if (r2 < minR2) {
      let t = fixedR2 / max(minR2, 1e-6);
      z = z * t;
      dr = dr * t;
    } else if (r2 < fixedR2) {
      let t = fixedR2 / max(r2, 1e-6);
      z = z * t;
      dr = dr * t;
    }
    z = z * scale + pos;
    dr = dr * abs(scale) + 1.0;
    trap = min(trap, length(z));
  }
  var res : DEResult;
  res.dist = length(z) / abs(dr);
  res.trap = trap;
  return res;
}

// Signed-distance box (outer bound for the Menger sponge).
fn sdBox(p : vec3<f32>, b : vec3<f32>) -> f32 {
  let di = abs(p) - b;
  return min(max(di.x, max(di.y, di.z)), 0.0) + length(max(di, vec3<f32>(0.0)));
}

// Menger sponge — canonical folding-space IFS. The sponge occupies roughly
// [-1,1]^3; each of the 5 iterations carves cross-shaped holes at 1/3 scale,
// so the recursive detail actually shows instead of a near-solid box.
fn deMenger(pos : vec3<f32>) -> DEResult {
  var p = pos;
  var d = sdBox(p, vec3<f32>(1.0));
  var s = 1.0;
  var colorTrap = 0.0;
  for (var m = 0; m < 5; m = m + 1) {
    // Euclidean fold: a = mod(p*s, 2) - 1, landing in [-1,1].
    let ps = p * s;
    let a = ps - 2.0 * floor(ps * 0.5) - 1.0;
    s = s * 3.0;
    let r = abs(1.0 - 3.0 * abs(a));
    let da = max(r.x, r.y);
    let db = max(r.y, r.z);
    let dc = max(r.z, r.x);
    let c = (min(da, min(db, dc)) - 1.0) / s;
    if (c > d) {
      d = c;
      // Trap at the recursion level that defines this surface point, mixed
      // with the folded position -> varied iridescent banding (not flat grey).
      colorTrap = f32(m) * 0.16 + length(a) * 0.33;
    }
  }
  var res : DEResult;
  res.dist = d;
  res.trap = colorTrap;
  return res;
}

// Quaternion-ish Julia (stretch fractal) using cubic quaternion iteration.
fn qmul(a : vec4<f32>, b : vec4<f32>) -> vec4<f32> {
  return vec4<f32>(
    a.x * b.x - a.y * b.y - a.z * b.z - a.w * b.w,
    a.x * b.y + a.y * b.x + a.z * b.w - a.w * b.z,
    a.x * b.z - a.y * b.w + a.z * b.x + a.w * b.y,
    a.x * b.w + a.y * b.z - a.z * b.y + a.w * b.x
  );
}

fn deJulia(pos : vec3<f32>) -> DEResult {
  // Animated Julia constant orbiting slowly.
  let t = select(u.time, 0.0, u.reducedMotion > 0.5);
  let c = vec4<f32>(
    0.35 * cos(t * 0.13),
    0.35 * sin(t * 0.11),
    0.28 * cos(t * 0.09 + 1.0),
    0.18
  );
  var z = vec4<f32>(pos, 0.0);
  var dz = vec4<f32>(1.0, 0.0, 0.0, 0.0);
  var trap = 1e10;
  var r2 = 0.0;
  for (var i = 0; i < 10; i = i + 1) {
    r2 = dot(z, z);
    if (r2 > 6.0) { break; }
    trap = min(trap, dot(z.xyz, z.xyz));
    // dz = 2*z*dz
    dz = 2.0 * qmul(z, dz);
    z = qmul(z, z) + c;
  }
  let r = sqrt(max(r2, 1e-8));
  let dr = length(dz);
  var res : DEResult;
  res.dist = 0.5 * r * log(max(r, 1.0001)) / max(dr, 1e-6);
  res.trap = trap;
  return res;
}

// Apollonian gasket — fractal sphere packing via repeated fold + sphere
// inversion. Produces nested spheres of shrinking radius (the "packing
// spheres" look). Classic IQ/Knighty formulation.
fn deApollonian(pos : vec3<f32>) -> DEResult {
  // Packing tightness 's' breathes slowly for a living, re-packing feel.
  let anim = select(sin(u.time * 0.08), 0.0, u.reducedMotion > 0.5);
  let s = 1.25 + 0.11 * anim;

  var p = pos;
  var scale = 1.0;
  var trap = 1e10;
  const AP_ITERS : i32 = 8;
  for (var i = 0; i < AP_ITERS; i = i + 1) {
    // Fold into the [-1,1] cell.
    p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
    let r2 = max(dot(p, p), 1e-6);   // guard the inversion divide
    trap = min(trap, r2);
    let k = s / r2;                  // sphere inversion
    p = p * k;
    scale = scale * k;
  }
  // Approximate distance estimate for the inverted packing.
  let packing = 0.25 * abs(p.y) / scale;

  // The fold is periodic, so the packing tiles all of space — intersect it with
  // a bounding sphere so it reads as a finite ball of packed spheres (like the
  // reference) that you can orbit and pull back from, instead of being forever
  // "inside" an infinite lattice.
  const BOUND : f32 = 1.3;
  let shell = length(pos) - BOUND;

  var res : DEResult;
  res.dist = max(packing, shell);
  res.trap = sqrt(trap);
  return res;
}

// Sphere packing — same fold + inversion machinery as the Apollonian above,
// but the base primitive is a SPHERE rather than a plane. The plane primitive
// (abs(p.y)) is what gives the Apollonian its big smooth sheet-like lobes;
// swapping in a sphere resolves the structure into nested tangent spheres of
// many sizes — the classic "packing spheres" look.
fn deSpherePack(pos : vec3<f32>) -> DEResult {
  let anim = select(sin(u.time * 0.06), 0.0, u.reducedMotion > 0.5);
  let s = 1.28 + 0.05 * anim;

  var p = pos;
  var scale = 1.0;
  var trap = 1e10;
  const SP_ITERS : i32 = 9;
  for (var i = 0; i < SP_ITERS; i = i + 1) {
    p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
    let r2 = max(dot(p, p), 1e-6);   // guard the inversion divide
    trap = min(trap, r2);
    let k = s / r2;
    p = p * k;
    scale = scale * k;
  }

  // Sphere primitive in the folded space.
  let spheres = (length(p) - 1.1) / scale;
  // Bound it so it reads as a finite cluster you can orbit and zoom out from.
  let shell = length(pos) - 1.15;

  var res : DEResult;
  res.dist = max(spheres, shell);
  res.trap = sqrt(trap);
  return res;
}

// Encrusted sphere — a smooth host sphere with a crust of packed spheres
// growing over part of its surface, with a ragged fractal patch boundary.
// Unlike the other two packings (which fill a volume), here the packing is
// confined to a thin shell hugging the surface, so the smooth body shows
// through where the crust hasn't grown.
fn deEncrusted(pos : vec3<f32>) -> DEResult {
  const R : f32 = 0.95;              // host sphere radius
  let r = length(pos);
  let base = r - R;                  // smooth body

  // Packing field (fold + inversion, sphere primitive).
  var p = pos;
  var scale = 1.0;
  var trap = 1e10;
  const EN_ITERS : i32 = 8;
  let anim = select(sin(u.time * 0.05), 0.0, u.reducedMotion > 0.5);
  let s = 1.24 + 0.04 * anim;
  for (var i = 0; i < EN_ITERS; i = i + 1) {
    p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
    let r2 = max(dot(p, p), 1e-6);   // guard the inversion divide
    trap = min(trap, r2);
    let k = s / r2;
    p = p * k;
    scale = scale * k;
  }
  let packing = (length(p) - 1.0) / scale;

  // Confine the packing to a shell sitting on the host surface.
  let shell = max(r - (R + 0.38), (R - 0.03) - r);
  var crust = max(packing, shell);

  // Grow the crust over a cap, with the boundary perturbed by the orbit trap
  // so it breaks up into an organic, coral-like edge instead of a clean circle.
  // The 0.7 bias leaves most of the host sphere bare, as in the reference.
  // NB: 'patch' is a reserved word in WGSL — don't name a variable that.
  let n = pos / max(r, 1e-6);
  let capMask = dot(n, normalize(vec3<f32>(0.35, 1.0, 0.28))) - 0.7
              + (sqrt(trap) - 0.55) * 0.55;
  crust = max(crust, -capMask * 0.3);

  var res : DEResult;
  res.dist = min(base, crust);
  res.trap = sqrt(trap);
  return res;
}

// Hash a cell index to a pseudo-random 0..1 value (varies sphere size + color).
fn hash13(p : vec3<f32>) -> f32 {
  var q = fract(p * 0.3183099 + vec3<f32>(0.1, 0.2, 0.3));
  q = q + vec3<f32>(dot(q, q.yzx + 19.19));
  return fract((q.x + q.y) * q.z);
}

// Surface sphere packing — a solid body studded with DISCRETE spheres of many
// sizes across its whole surface.
//
// The inversion-based packings above resolve into smooth sheets and lobes at
// this scale. This takes the other route: repeat space into cells at three
// scales, put one sphere per cell sized by a hash of the cell index, and clip
// them to a thin shell around the body. The result is hundreds of separate
// spheres of mixed sizes covering the surface — the look of a physical packing
// rather than an analytic fractal. Each sphere takes its own palette color
// from its hash.
fn deSurfacePack(pos : vec3<f32>) -> DEResult {
  const R : f32 = 1.0;
  const SHELL : f32 = 0.09;
  const SP_LEVELS : i32 = 3;

  let r = length(pos);
  // Gentle size pulse so the packing breathes without spheres popping.
  let pulse = select(1.0 + 0.05 * sin(u.time * 0.12), 1.0, u.reducedMotion > 0.5);

  var d = r - R * 0.985;      // solid core just under the shell
  var trapV = 0.5;
  var cellSize = 0.22;

  for (var lvl = 0; lvl < SP_LEVELS; lvl = lvl + 1) {
    let cellId = round(pos / cellSize);
    let q = pos - cellSize * cellId;
    let h = hash13(cellId + vec3<f32>(f32(lvl) * 7.13));
    // Radius must stay under half the cell spacing. Domain repetition only
    // evaluates the sphere in the NEAREST cell, so anything larger gets sliced
    // flat at the cell walls and renders as axis-aligned cube faces. Measured:
    // radii up to 1.10 cell put 3.6% of surface normals exactly on an axis
    // (a smooth sphere baselines at 1.3%); capping at 0.49 returns it to 1.5%.
    // Intersection curves still come from the three levels cutting each other.
    let rad = cellSize * (0.18 + 0.31 * h * h * h) * pulse;
    let shellD = max(r - (R + SHELL), (R - SHELL * 0.9) - r);
    let cand = max(length(q) - rad, shellD);
    if (cand < d) {
      d = cand;
      trapV = h;              // each sphere gets its own color
    }
    cellSize = cellSize * 0.55;
  }

  var res : DEResult;
  res.dist = d;
  res.trap = trapV;
  return res;
}

// Intersection seams for the studded packing.
//
// A plain union hides where spheres cut through each other, so the surface
// reads as flat beads. Here we find the two nearest sphere *surfaces* in the
// local neighbourhood: where both pass through the same point, that point lies
// on an intersection curve between two spheres. Feeding that into emission
// lights up the seams as glowing circles and filigree.
//
// Only called once per pixel at the shading point — never inside the march
// loop — so the 8-neighbour lookup per level stays cheap.
fn surfacePackSeam(pos : vec3<f32>) -> vec2<f32> {
  var d1 = 1e10;
  var d2 = 1e10;
  var hSeam = 0.0;
  var cellSize = 0.22;
  // Must match deSurfacePack's radii exactly or the seams drift off the joins.
  let pulse = select(1.0 + 0.05 * sin(u.time * 0.12), 1.0, u.reducedMotion > 0.5);

  for (var lvl = 0; lvl < 3; lvl = lvl + 1) {
    let base = round(pos / cellSize);
    let sgn = sign(pos - cellSize * base);
    for (var i = 0; i < 8; i = i + 1) {
      let o = vec3<f32>(f32(i & 1), f32((i >> 1u) & 1), f32((i >> 2u) & 1)) * sgn;
      let cellId = base + o;
      let q = pos - cellSize * cellId;
      let h = hash13(cellId + vec3<f32>(f32(lvl) * 7.13));
      let rad = cellSize * (0.18 + 0.31 * h * h * h) * pulse;
      let dd = abs(length(q) - rad);   // distance to that sphere's SURFACE
      if (dd < d1) {
        d2 = d1;
        d1 = dd;
        hSeam = h;
      } else if (dd < d2) {
        d2 = dd;
      }
    }
    cellSize = cellSize * 0.55;
  }

  // Two surfaces meeting here => intersection curve. The falloff is very
  // sensitive and has to be retuned whenever the radii change: measured on real
  // surface samples, 2.6e3 lit 93% of the surface (a white-out). With the
  // current capped radii, 6e4 lights ~3% brightly and ~10% faintly — fine
  // filigree rather than a wash.
  let seam = 1.0 / (1.0 + 60000.0 * d2 * d2);
  return vec2<f32>(seam, hSeam);
}

// ---- Penrose quasicrystal ------------------------------------------------
//
// A genuine P3 Penrose rhombus tiling (thick 72/108 + thin 36/144), built by de
// Bruijn's pentagrid construction and engraved into a disc as two-level relief.
//
// The tiling is the dual of five families of parallel lines ("the pentagrid").
// Each intersection of a line from family j with one from family k dualizes to
// one rhombus whose edges are e_j and e_k. The offsets gamma_l sum to an
// integer, which is exactly the condition for the dual to be Penrose rather
// than a generic rhombic tiling.
//
// Going the other way -- physical point -> which rhombus contains it -- needs
// the inverse of V(x) = sum ceil(dot(x,e_l)+g_l) e_l. That map averages to
// (5/2)x + sum(g_l e_l), so 0.4*(q - shift) recovers x to within the ceil()
// rounding noise (stddev ~0.18 of a line spacing). Too coarse to just round:
// measured over 90k sample points, taking the single nearest intersection per
// pair leaves 3.2% of the plane in no tile at all. Bracketing BOTH neighbouring
// lines of every family (4 combos x 10 pairs) covers 100.0000%, and bracketing
// only the more ambiguous family of each pair -- 2 combos, half the work --
// flips the groove/solid decision on 1 point in 100k with a worst-case SDF
// error of 0.09. That last variant is what runs here. It only ever searches a
// subset of the candidates, so it can only over-estimate the SDF, which keeps
// the carve conservative and sphere tracing safe.
const PHI2 : f32 = 2.61803399;   // phi^2 -- the Penrose inflation ratio

struct PenroseTile {
  sdf  : f32,        // <= 0 inside; -sdf is the distance to this tile's edge
  kind : f32,        // 0 = thick rhomb, 1 = thin rhomb
  perp : vec2<f32>,  // cut-and-project perpendicular-space coordinate
};

// One point query against the tiling, in units where a rhombus edge is 1.
// 'phason' slides the tiling through perpendicular space (see dePenrose).
fn penroseQuery(q : vec2<f32>, phason : vec2<f32>) -> PenroseTile {
  // Grid star e_l, perpendicular star ep_l, and sin(2*pi*d/5) for index gaps.
  var e = array<vec2<f32>, 5>(
    vec2<f32>( 1.0,        0.0),
    vec2<f32>( 0.30901699, 0.95105652),
    vec2<f32>(-0.80901699, 0.58778525),
    vec2<f32>(-0.80901699,-0.58778525),
    vec2<f32>( 0.30901699,-0.95105652));
  var ep = array<vec2<f32>, 5>(
    vec2<f32>( 1.0,        0.0),
    vec2<f32>(-0.80901699, 0.58778525),
    vec2<f32>( 0.30901699,-0.95105652),
    vec2<f32>( 0.30901699, 0.95105652),
    vec2<f32>(-0.80901699,-0.58778525));
  var s5 = array<f32, 5>(0.0, 0.95105652, 0.58778525, -0.58778525, -0.95105652);

  // Offsets sum to 1 (an integer) -> the dual is a Penrose tiling. The phason
  // term is projected onto the perpendicular star, whose five vectors sum to
  // zero, so the drift leaves that sum untouched and the tiling stays Penrose
  // while individual tiles flip.
  var g = array<f32, 5>(0.3, 0.2, -0.1, 0.4, 0.2);
  var shift = vec2<f32>(0.0);
  for (var l = 0; l < 5; l = l + 1) {
    g[l] = g[l] + dot(ep[l], phason);
    shift = shift + g[l] * e[l];
  }

  // Grid-space preimage of q, and how far it sits from each family's lines.
  let x = 0.4 * (q - shift);
  var t = array<f32, 5>(0.0, 0.0, 0.0, 0.0, 0.0);
  for (var l = 0; l < 5; l = l + 1) { t[l] = dot(x, e[l]) + g[l]; }

  var best : PenroseTile;
  best.sdf = 1e9;
  best.kind = 0.0;
  best.perp = vec2<f32>(0.0);

  for (var j = 0; j < 4; j = j + 1) {
    for (var k = j + 1; k < 5; k = k + 1) {
      let det = s5[((k - j) % 5 + 5) % 5];   // = cross(e_j, e_k)
      let inv = 1.0 / det;

      // Bracket the family whose nearest line is most ambiguous; round the
      // other. Two candidate intersections per pair, 20 in total.
      let aj = abs(t[j] - round(t[j]));
      let ak = abs(t[k] - round(t[k]));
      var m0 = round(t[j]);
      var n0 = round(t[k]);
      var dm = 0.0;
      var dn = 0.0;
      if (aj > ak) { m0 = floor(t[j]); dm = 1.0; } else { n0 = floor(t[k]); dn = 1.0; }

      for (var c = 0; c < 2; c = c + 1) {
        let m = m0 + dm * f32(c);
        let n = n0 + dn * f32(c);
        let a = m - g[j];
        let b = n - g[k];

        // The remaining three indices are read off at the intersection point.
        // dot(x*, e_l) is affine in (m,n) with coefficients that depend only on
        // index differences, so x* itself never has to be solved for.
        var v  = m * e[j]  + n * e[k];
        var pw = m * ep[j] + n * ep[k];
        for (var l = 0; l < 5; l = l + 1) {
          if (l == j || l == k) { continue; }
          let cl = (a * s5[((k - l) % 5 + 5) % 5] + b * s5[((l - j) % 5 + 5) % 5]) * inv;
          let kl = ceil(cl + g[l]);
          v  = v  + kl * e[l];
          pw = pw + kl * ep[l];
        }

        // The rhombus spans v -> v + e_j + e_k. It is the intersection of two
        // unit-edge slabs sharing a half-width, so max() of the two slab
        // distances is exact inside and a safe under-estimate outside.
        let ctr = v + 0.5 * (e[j] + e[k]);
        let h = 0.5 * abs(det);
        let d = q - ctr;
        let sd = max(abs(-d.x * e[j].y + d.y * e[j].x) - h,
                     abs(-d.x * e[k].y + d.y * e[k].x) - h);
        if (sd < best.sdf) {
          best.sdf = sd;
          let gap = abs(k - j);
          best.kind = select(1.0, 0.0, min(gap, 5 - gap) == 1);
          best.perp = pw;
        }
      }
    }
  }
  return best;
}

// Penrose tiling engraved into a disc, at two levels of the inflation
// hierarchy. Inflating a Penrose tiling by phi^2 yields another Penrose tiling
// on the same five directions, so the parent level is the identical query run
// on q/phi^2 -- its edges cut wide canyons that partition the fine tiles into
// their parent rhombs, which is the tiling's self-similarity made geometric.
//
// Cost note: this is the heaviest estimator here (two 20-candidate queries per
// evaluation), so the disc bound below is a hard early-out -- the tiling is
// only ever evaluated within a thin band around the surface. Everywhere else
// the ray sees a plain rounded disc.
fn dePenrose(pos : vec3<f32>) -> DEResult {
  const R : f32 = 1.35;        // disc radius
  const HT : f32 = 0.060;      // half thickness
  const SCALE : f32 = 0.17;    // world units per rhombus edge

  let rad = length(pos.xz);

  // Solid-disc bound: the relief only removes material, so this never
  // over-estimates the true distance and is safe to return early.
  let wb = vec2<f32>(rad - R, abs(pos.y) - HT);
  let bound = min(max(wb.x, wb.y), 0.0) + length(max(wb, vec2<f32>(0.0)));

  var res : DEResult;
  if (bound > 0.07) {
    res.dist = bound;
    res.trap = 0.35;
    return res;
  }

  // Phason drift: a slow slide through perpendicular space. This is the real
  // degree of freedom of a quasicrystal -- tiles flip between the two rhombs
  // as it moves, while the tiling stays exactly Penrose throughout.
  let tm = select(u.time, 0.0, u.reducedMotion > 0.5);
  let phason = 0.09 * vec2<f32>(cos(tm * 0.05), sin(tm * 0.043));

  let q = pos.xz / SCALE;
  let child = penroseQuery(q, phason);
  let parent = penroseQuery(q / PHI2, phason);

  // Distance to each level's tile edge, back in world units.
  let ce = max(-child.sdf, 0.0) * SCALE;
  let pe = max(-parent.sdf, 0.0) * SCALE * PHI2;

  // Chamfer both faces towards the edges. The chamfers are kept narrow relative
  // to a tile so the rhombs keep flat tops and legible edges instead of
  // rounding off into cushions. The parent canyon stays a broad groove rather
  // than a cut -- taken much deeper it slices the disc into shards and the
  // hierarchy stops reading. Each depth/width ratio stays below 1, and the 0.55
  // factor on the returned distance covers their combined slope.
  const CW : f32 = 0.013;   // child groove half-width
  const PW : f32 = 0.045;   // parent canyon half-width
  var relief = clamp(1.0 - ce / CW, 0.0, 1.0) * 0.011;
  relief = relief + clamp(1.0 - pe / PW, 0.0, 1.0) * 0.022;

  // Where the two carves coincide they exceed the half thickness and punch
  // clean through, opening windows along the parent edges.
  let w = vec2<f32>(rad - R, abs(pos.y) - (HT - relief));
  let d = min(max(w.x, w.y), 0.0) + length(max(w, vec2<f32>(0.0)));

  res.dist = d * 0.55;
  // Thick and thin rhombs take separate palette bands; the parent tile's
  // perpendicular-space coordinate adds slow variation across the whole disc.
  res.trap = 0.15 + 0.45 * child.kind + 0.3 * clamp(length(parent.perp) * 0.5, 0.0, 1.0);
  return res;
}

// Dispatch to the selected estimator.
fn mapDE(pos : vec3<f32>) -> DEResult {
  let ft = u.fractalType;
  if (ft < 0.5) {
    return deMandelbulb(pos);
  } else if (ft < 1.5) {
    return deMandelbox(pos);
  } else if (ft < 2.5) {
    return deMenger(pos);
  } else if (ft < 3.5) {
    return deJulia(pos);
  } else if (ft < 4.5) {
    return deApollonian(pos);
  } else if (ft < 5.5) {
    return deSpherePack(pos);
  } else if (ft < 6.5) {
    return deEncrusted(pos);
  } else if (ft < 7.5) {
    return deSurfacePack(pos);
  }
  return dePenrose(pos);
}

fn mapDist(pos : vec3<f32>) -> f32 {
  return mapDE(pos).dist;
}

// Tetrahedron (4-sample forward-difference) normal.
fn calcNormal(p : vec3<f32>, eps : f32) -> vec3<f32> {
  let k = vec2<f32>(1.0, -1.0);
  return normalize(
    k.xyy * mapDist(p + k.xyy * eps) +
    k.yyx * mapDist(p + k.yyx * eps) +
    k.yxy * mapDist(p + k.yxy * eps) +
    k.xxx * mapDist(p + k.xxx * eps)
  );
}

// Soft penumbra shadow via min-ratio along the shadow ray.
fn softShadow(ro : vec3<f32>, rd : vec3<f32>, kSoft : f32) -> f32 {
  var res = 1.0;
  var t = 0.02;
  const SH_STEPS : i32 = 40;
  for (var i = 0; i < SH_STEPS; i = i + 1) {
    let h = mapDist(ro + rd * t);
    if (h < 0.0005) { return 0.0; }
    res = min(res, kSoft * h / t);
    t = t + clamp(h, 0.01, 0.25);
    if (t > 12.0) { break; }
  }
  return clamp(res, 0.0, 1.0);
}

// Cheap AO by sampling the DE along the normal.
fn calcAO(p : vec3<f32>, n : vec3<f32>) -> f32 {
  var occ = 0.0;
  var sca = 1.0;
  const AO_STEPS : i32 = 5;
  for (var i = 0; i < AO_STEPS; i = i + 1) {
    let hr = 0.01 + 0.14 * f32(i) / 4.0;
    let d = mapDist(p + n * hr);
    occ = occ + (hr - d) * sca;
    sca = sca * 0.7;
  }
  return clamp(1.0 - 2.5 * occ, 0.0, 1.0);
}

// Background gradient / atmosphere the fractal fogs into.
//
// Kept near-black: the composite pass applies gamma (1/2.2), which lifts small
// linear values hard (0.03 linear reads as ~0.23 on screen). These values land
// around 0.05-0.09 displayed — black enough for emissive filaments to pop,
// with just a whisper of palette tint so it isn't a flat dead grey.
fn backgroundColor(rd : vec3<f32>) -> vec3<f32> {
  let t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  let lo = u.paletteA.rgb * 0.008;
  let hi = u.paletteA.rgb * 0.022 + vec3<f32>(0.002, 0.003, 0.006);
  return mix(lo, hi, t);
}

// ---- Camera ---------------------------------------------------------------
fn cameraRay(uv : vec2<f32>, ro : vec3<f32>, ta : vec3<f32>, fov : f32) -> vec3<f32> {
  // aspect-correct screen coords in [-1,1]
  let aspect = u.resolution.x / max(u.resolution.y, 1.0);
  var p = (uv * 2.0 - 1.0);
  p.x = p.x * aspect;
  let fwd = normalize(ta - ro);
  let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), fwd));
  let up = cross(fwd, right);
  let focal = 1.0 / tan(fov * 0.5);
  return normalize(p.x * right + p.y * up + focal * fwd);
}

// ---- Fragment: raymarch ---------------------------------------------------
@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let uv = in.uv;

  let ro = u.camPos;
  let ta = u.camTarget;
  let rd = cameraRay(vec2<f32>(uv.x, 1.0 - uv.y), ro, ta, u.fov);

  // Strange attractors aren't distance fields — they're rasterized as line
  // geometry by a second pipeline drawn over this pass. Emit only the
  // background here so those lines have something to blend onto.
  if (u.fractalType > 8.5) {
    let bg = backgroundColor(rd);
    return vec4<f32>(select(vec3<f32>(0.0), bg, u.bgMode >= 0.5), 0.0);
  }

  // Adaptive epsilon: coarser when quality is low.
  let epsScale = mix(2.5, 1.0, clamp(u.qualityScale, 0.0, 1.0));
  let hitEps = BASE_EPS * epsScale;

  var t = 0.05;
  var hit = false;
  var trap = 1.0;
  var glow = 0.0;

  // Sphere tracing with a small relaxation factor and glow from near-misses.
  for (var i = 0; i < MAX_STEPS; i = i + 1) {
    let pos = ro + rd * t;
    let de = mapDE(pos);
    let d = de.dist;

    // Accumulate glow: how close we passed to the surface, weighted by 1/dist.
    let near = exp(-d * 42.0);
    glow = glow + near / (1.0 + t * t * 0.35);

    let hitThresh = hitEps * t; // scale epsilon with distance for stable hits
    if (d < hitThresh) {
      hit = true;
      trap = de.trap;
      break;
    }
    // relaxed step (slightly under 1.0 keeps thin filaments from tunneling)
    t = t + d * 0.9;
    if (t > MAX_DIST) { break; }
  }

  var color = vec3<f32>(0.0);
  let bg = backgroundColor(rd);

  if (hit) {
    let pos = ro + rd * t;
    let n = calcNormal(pos, hitEps * t * 2.0);

    // Key + fill directional lighting.
    let keyDir = normalize(vec3<f32>(0.6, 0.7, -0.35));
    let fillDir = normalize(vec3<f32>(-0.5, 0.25, 0.4));
    let diffKey = max(dot(n, keyDir), 0.0);
    let diffFill = max(dot(n, fillDir), 0.0) * 0.35;

    // Soft shadow on the key light.
    let sh = mix(1.0, softShadow(pos + n * 0.002, keyDir, u.shadowSoftness), 0.9);
    // AO.
    let ao = mix(1.0, calcAO(pos, n), u.aoStrength);

    // Orbit-trap -> palette. Fold in a slow time phase for color cycling.
    let phase = select(u.time * 0.03, 0.0, u.reducedMotion > 0.5);
    let base = palette(trap * 1.6 + phase);

    // Fresnel rim for extra luminosity on silhouettes.
    let fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

    var lit = base * (0.18 + 0.9 * diffKey * sh) * ao;
    lit = lit + base * diffFill * ao;
    lit = lit + base * fres * 0.5;

    // Specular glint.
    let h = normalize(keyDir - rd);
    let spec = pow(max(dot(n, h), 0.0), 32.0) * sh;
    lit = lit + vec3<f32>(spec) * 0.4;

    // Studded packing: light up the curves where spheres cut through each
    // other. Evaluated once here, never in the march loop.
    if (u.fractalType > 6.5 && u.fractalType < 7.5) {
      let sm = surfacePackSeam(pos);
      let seamCol = palette(sm.y * 2.1 + phase + 0.35);
      lit = lit + seamCol * sm.x * 1.1;
      glow = glow + sm.x * 3.5;
    }

    // Distance fog into background.
    let fog = 1.0 - exp(-u.fogDensity * t * t * 0.05);
    color = mix(lit, bg, fog);
  } else {
    // No hit: transparent (or gradient) background. In transparent mode the
    // composite pass derives coverage from luminance + glow, so an all-black
    // scene here reads as fully see-through.
    color = select(vec3<f32>(0.0), bg, u.bgMode >= 0.5);
  }

  // Emission/glow term -> alpha channel of the HDR target for the bloom pass.
  let glowOut = clamp(glow * u.glowStrength * 0.02, 0.0, 8.0);

  // Add a little of the glow into RGB too so filaments read even pre-bloom,
  // tinted by the palette for that iridescent thread look.
  let glowTint = palette(u.time * 0.02 + 0.5) * glowOut;
  color = color + glowTint * 0.4;

  // Store straight (non-premultiplied) HDR color in RGB; emission/glow in .a
  // for the bloom pass. The composite pass turns these into final alpha.
  return vec4<f32>(color, glowOut);
}
`;
