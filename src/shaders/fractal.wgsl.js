// fractal.wgsl.js — raymarch pass (vertex + fragment) as an inlined WGSL string.
//
// Inlined (rather than fetched from a .wgsl file) so the demo runs directly
// from file:// with no dev server and no CORS/fetch problems.
//
// Uniform struct layout is mirrored exactly in fractal-bg.js (see UNIFORM_*
// offsets there). Keep the two in lockstep. std140-ish rules: vec3 aligns to
// 16 bytes; we deliberately pack a trailing scalar into each vec3's pad slot.

// Engel's plesiohedron carries 728 generated constants, so its tables and
// estimator live in their own module and are spliced in below.
import { ENGEL_WGSL } from './engel.wgsl.js';

export const FRACTAL_WGSL = /* wgsl */ `
// Stop count carried for an imported palette. Mirrored by MAX_STOPS in
// palette-io.js, which resamples longer palettes down to it.
const RAMP_MAX : u32 = 8u;

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
//                           7=surfacepack, 8=penrose, 9=gyroid, 10=kleinian,
//                           11=barth, 12=schottky (kissing/parabolic),
//                           13=schottkyh (hyperbolic), 14=tetrabrot,
//                           15=envoct, 16=envdodec, 17=hyp534, 18=hyp435,
//                           19=hyp534t, 20=hyp534o, 21=hyp435t, 22=hyp435o;
//                           23+ are the line-rendered attractors, which this
//                           pass only backgrounds)
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
//   156 flyMode      : f32   (0 = orbit, 1 = free fly-through)
//   160 viewProj     : mat4x4<f32>  (attractor line rasterization)
//   224 jitter       : vec2<f32>   (subpixel offset, progressive accumulation)
//   232 accumWeight  : f32         (1/(n+1) running-average weight)
//   236 _pad2        : f32
//   240 paletteMode  : f32   (0 = cosine preset, 1 = imported stop ramp)
//   244 rampCount    : f32   (live stops, 2..8)
//   248 colorCycle   : f32   (palette cycles per second; 0 = static)
//   252 _pad3        : f32
//   256 ramp         : array<vec4<f32>, 8>  (imported palette stops)
//   384 imageAdjust  : vec4<f32>  (exposure, contrast, saturation, hue)
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
  flyMode      : f32,
  viewProj     : mat4x4<f32>,
  jitter       : vec2<f32>,
  accumWeight  : f32,
  _pad2        : f32,
  paletteMode  : f32,
  rampCount    : f32,
  colorCycle   : f32,
  _pad3        : f32,
  ramp         : array<vec4<f32>, RAMP_MAX>,
  // (exposure, contrast, saturation, hue turns) -- composite pass only.
  imageAdjust  : vec4<f32>,
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

// Imported palette: linear interpolation across the stops.
//
// Cyclic, because the cosine presets it sits alongside are periodic and every
// caller feeds this an unbounded value (orbit traps, a time phase). Wrapping
// the last stop back to the first keeps the ramp continuous instead of clamping
// to a flat band at either end.
fn rampColor(t : f32) -> vec3<f32> {
  let n = max(u32(u.rampCount), 2u);
  let x = fract(t) * f32(n);
  let i0 = u32(floor(x)) % n;
  let i1 = (i0 + 1u) % n;
  return mix(u.ramp[i0].rgb, u.ramp[i1].rgb, fract(x));
}

// Cosine preset, or an imported stop ramp.
fn palette(t : f32) -> vec3<f32> {
  if (u.paletteMode > 0.5) {
    return rampColor(t);
  }
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

// ---- Gyroid ---------------------------------------------------------------
//
// Schoen's gyroid, the triply periodic minimal surface
//
//     f(p) = cos x sin y + cos y sin z + cos z sin x = 0
//
// whose zero set separates two congruent, interpenetrating labyrinths. It has
// no straight lines and no mirror planes. Unlike every other model here it is
// really a structure to travel through rather than orbit, so until there is a
// fly-through camera it is clipped to a ball, which opens its channels to the
// outside and makes it legible from a normal orbit.
//
// f is an implicit field, NOT a distance field: sphere tracing it raw
// overshoots wherever the gradient exceeds 1. Normalising by the analytic
// gradient is the textbook fix, but |grad f| falls to 0.035 at its critical
// points and dividing by that inflates a step roughly fiftyfold. Dividing by
// the global bound instead is both safe and cheaper: sampled over a full period
// at 729000 points, |grad f| reaches sqrt(3) and never exceeds it, so
// (|f| - h)/sqrt(3) under-estimates the true distance everywhere and needs no
// empirical safety factor at all. The price is 1.26x more marching steps than
// an exact gradient would need at the surface -- less than the gradient costs.
fn deGyroid(pos : vec3<f32>) -> DEResult {
  const R : f32 = 1.35;            // clipping ball
  const FREQ : f32 = 5.5;          // lattice periods per world unit
  const HALF : f32 = 0.34;         // wall half-thickness, in units of f
  const SQRT3 : f32 = 1.73205081;  // exact bound on |grad f|

  var res : DEResult;

  // The ball exists only to give the orbit camera a bounded object to circle.
  // Fly-through mode lifts it: the gyroid is genuinely infinite and periodic,
  // and its interior is the whole point of a triply periodic surface.
  let clipped = u.flyMode < 0.5;
  let ball = length(pos) - R;
  if (clipped && ball > 0.25) {
    res.dist = ball;
    res.trap = 0.4;
    return res;
  }

  // Level-set parameter. Sliding it through the family widens one labyrinth
  // and narrows the other; the amplitude stays well inside the connected
  // regime, so the surface never pinches apart.
  let tm = select(u.time, 0.0, u.reducedMotion > 0.5);
  let level = 0.3 * sin(tm * 0.08);

  let q = pos * FREQ;
  let s = sin(q);
  let c = cos(q);
  let f = c.x * s.y + c.y * s.z + c.z * s.x;

  let shell = (abs(f - level) - HALF) / (SQRT3 * FREQ);
  res.dist = select(shell, max(shell, ball), clipped);

  // Which face of the wall this is: each looks into one of the two labyrinths,
  // so they take separate palette bands. Free -- reuses the trig above.
  let face = select(0.0, 1.0, f - level >= 0.0);
  let aux = c.x * s.y - c.z * s.x;
  res.trap = 0.2 + 0.4 * face + 0.18 * clamp(0.5 + 0.35 * aux, 0.0, 1.0);
  return res;
}

// ---- Kleinian limit set ---------------------------------------------------
//
// A Kleinian group is a discrete group of Mobius transformations; its limit set
// is the fractal set of accumulation points its orbits pile up on. This is the
// pseudo-Kleinian construction, generated by two moves iterated together:
//
//   * a box fold, reflecting a point back into the fundamental domain of a
//     translation lattice, and
//   * an inversion in a sphere that fires only for points already inside it.
//
// The accumulated inversion factor converts the final primitive's distance back
// to world scale, exactly as in the Apollonian estimator above -- this is the
// same fold-and-invert machinery, with a clamp fold in place of the modulo fold
// and a conditional inversion in place of an unconditional one.
//
// The smooth caps this produces are not a defect of the estimator: they are the
// group's tangent spheres, with the recursive filigree running along the ridges
// where they meet. Parameters were chosen by rendering candidates rather than
// taken from a reference -- the structure is sharply sensitive to them, and
// most sets collapse into featureless lobes or granular noise.
fn deKleinian(pos : vec3<f32>) -> DEResult {
  const CS : vec3<f32> = vec3<f32>(0.92436, 0.90756, 0.92436);  // fold half-cell
  const CCONST : f32 = 0.92436;   // radius of the final cylinder primitive
  const BOUND : f32 = 1.55;       // clipping ball
  const KL_ITERS : i32 = 12;

  var res : DEResult;

  // The limit set lies wholly inside the ball, so this never over-estimates.
  // Fly-through mode widens the ball instead of removing it: the construction
  // does tile space, but an unbounded version would let rays march forever
  // through the gaps rather than terminating on the background.
  let bnd = select(BOUND, 7.0, u.flyMode > 0.5);
  let shell = length(pos) - bnd;
  if (shell > 0.30) {
    res.dist = shell;
    res.trap = 0.4;
    return res;
  }

  // Drifting the inversion radius walks the group through a family of nearby
  // Kleinian groups, morphing the limit set. Kept to a narrow band: the
  // structure degenerates quickly outside it.
  let anim = select(sin(u.time * 0.045), 0.0, u.reducedMotion > 0.5);
  let minRad2 = 0.92 + 0.015 * anim;

  var p = pos;
  var factor = 1.0;
  for (var i = 0; i < KL_ITERS; i = i + 1) {
    // Box fold into the fundamental domain of the translation lattice.
    p = 2.0 * clamp(p, -CS, CS) - p;
    // Conditional sphere inversion: only points inside the sphere move.
    let r2 = max(dot(p, p), 1e-9);   // guard the inversion divide
    let k = max(minRad2 / r2, 1.0);
    p = p * k;
    factor = factor * k;
  }

  // Distance to a cylinder capped by a cone, carried back through the
  // accumulated scaling. The 0.5 keeps the estimate conservative.
  let rxy = length(p.xy);
  let ln = max(length(p), 1e-9);
  let prim = 0.5 * max(rxy - CCONST, rxy * p.z / ln) / factor;

  res.dist = max(prim, shell);
  // How hard the point was folded and inverted -- deep recursion reads as a
  // different palette band from the smooth tangent spheres.
  res.trap = clamp(log(factor + 1.0) * 0.22, 0.0, 1.0);
  return res;
}

// ---- Barth sextic ---------------------------------------------------------
//
// The degree-6 algebraic surface
//
//   f = 4(P^2 x^2 - y^2)(P^2 y^2 - z^2)(P^2 z^2 - x^2)
//       - (1 + 2P)(x^2 + y^2 + z^2 - w^2)^2 w^2 = 0,   P = golden ratio
//
// with icosahedral symmetry and 65 ordinary double points -- the most a sextic
// can have, a bound proved by Jaffe and Ruberman. Fifty of them are finite and
// were located exactly while building this: 20 at the vertices of a dodecahedron
// at radius sqrt(3), and 30 at an icosidodecahedron at radius exactly 1. The
// other 15 lie at infinity. Both finite shells sit inside the clipping ball, so
// what you orbit is the whole singular structure.
//
// This is the first algebraic surface here, and it inverts the lesson the gyroid
// taught. There, dividing by the analytic gradient was WRONG -- |grad f| bottoms
// out at 0.035 near the surface and inflates a step fiftyfold -- and a global
// Lipschitz constant was both safe and cheap. Here the opposite holds, for a
// reason worth recording:
//
//   * A constant divisor is useless for a polynomial. Measured over the clip
//     ball, |grad f| reaches 749 while its median ON the surface is 9.3, so a
//     rigorous constant would step eighty times finer than necessary
//     everywhere. Making the bound radius-dependent, max(7, 25 r^5), narrows
//     that but still costs 2.5x the marching steps.
//   * The gradient is well behaved exactly where it looked dangerous. At an
//     ordinary double point f vanishes quadratically and |grad f| linearly, so
//     |f|/|grad f| tends to a multiple of the distance rather than diverging.
//     Sampled against a dense reference march, the first-order estimator lands
//     on the correct sheet for 99.4% of rays and skips none at all.
//
// So the divisor here is the analytic gradient, with a floor that in practice
// never binds -- results are identical at 0.1, 0.6 and 2.0 -- and exists only so
// that a point landing exactly on a node cannot evaluate 0/0.
fn deBarth(pos : vec3<f32>) -> DEResult {
  const R : f32 = 2.0;             // clipping ball, outside both node shells
  const PHI2 : f32 = 2.61803399;   // phi^2
  const KB : f32 = 4.23606798;     // 1 + 2*phi
  const GFLOOR : f32 = 0.6;        // guards 0/0 at a node, nothing more
  const MAXSTEP : f32 = 0.22;      // caps the step at critical points of f
                                   // that are AWAY from the zero set, where
                                   // |grad f| is small but |f| is not

  var res : DEResult;
  let r = length(pos);
  let ball = r - R;
  if (ball > 0.35) {
    res.dist = ball;
    res.trap = 0.4;
    return res;
  }

  // The pencil parameter. w = 1 is the distinguished member -- the surface
  // carrying all 65 nodes -- and sliding w off it dissolves them into a smooth
  // surface, so the amplitude stays small and reduced motion pins it exactly.
  let tm = select(u.time, 0.0, u.reducedMotion > 0.5);
  let w2 = 1.0 + 0.10 * sin(tm * 0.07);

  let s = pos * pos;
  let a = PHI2 * s.x - s.y;
  let b = PHI2 * s.y - s.z;
  let c = PHI2 * s.z - s.x;
  let sm = s.x + s.y + s.z - w2;
  let f = 4.0 * a * b * c - KB * sm * sm * w2;

  // Analytic gradient. d/dx of 4abc is 8x(P^2 bc - ab) and cyclically; the
  // sphere term contributes 4 K w^2 (S - w^2) p.
  let g = 8.0 * pos * vec3<f32>(PHI2 * b * c - a * b,
                                PHI2 * c * a - b * c,
                                PHI2 * a * b - c * a)
          - 4.0 * KB * w2 * sm * pos;

  let d = min(abs(f) / max(length(g), GFLOOR), MAXSTEP);
  res.dist = max(d, ball);
  // Radius. The surface's own structure is two concentric node shells, so this
  // paints what the object actually is; the alternative tried here, the balance
  // of the three quadric factors, is more colourful but fragments the form.
  res.trap = clamp(0.16 + 0.66 * (r / R), 0.0, 1.0);
  return res;
}

// ---- Kissing Schottky group ------------------------------------------------
//
// A Schottky group is a free discrete group of Mobius transformations built by
// pairing spheres. This is the KISSING case and its hyperbolic neighbours: the
// group generated by inversions in five MUTUALLY TANGENT spheres, whose
// orientation-preserving subgroup has index 2 -- hence exactly the same limit
// set -- and is free, generated by the products sigma_i sigma_j. Those products
// are the Schottky generators, and their type is forced by the geometry:
//
//   * PARABOLIC when the two spheres kiss. One fixed point, at the point of
//     tangency. Verified by iteration: the fixed point converges to the
//     tangency point and the multiplier to 1.
//   * HYPERBOLIC when they are disjoint, with translation length
//     2*acosh(delta) for the inversive distance
//         delta = (|c1-c2|^2 - r1^2 - r2^2) / (2 r1 r2).
//     Measured against -log of the multiplier at the attracting fixed point,
//     the two agree to six decimals, so delta is the exact analogue of the
//     trace: 1 at the parabolic boundary, above 1 in the hyperbolic interior.
//
// SPHERES = 5, and that is not a free choice. Four equal spheres with centres
// equidistant from a point are all orthogonal to a common sphere, so the group
// preserves it and the whole limit set lies ON that sphere -- a 2D gasket
// wrapped on a primitive, which is the failure this project already recorded
// for the Penrose relief. The fix is the 3D Descartes configuration: four equal
// spheres at the vertices of a tetrahedron plus one at the centre, all five
// mutually tangent, with radii fixed by Soddy-Gosset ((sum k)^2 = 3 sum k^2) at
// k_inner = (2 + sqrt 6) k_outer. A sphere centred at the origin cannot be
// orthogonal to another centred at the origin, and the symmetry forces any
// common orthogonal sphere to be origin-centred, so none exists. The limit set
// is then genuinely three-dimensional -- the residual set of the 3D Apollonian
// packing, Hausdorff dimension about 2.47.
//
// What is drawn is the group orbit of the CENTRAL sphere. The four large
// generators are deliberately not part of the surface: their orbit is precisely
// what fills them, so drawing them puts an opaque ball in front of every bit of
// structure. Rendering the first attempt that way produced four featureless
// balls and nothing else.
//
// Like the Apollonian and sphere-pack estimators above, this is a thickened
// surface rather than a signed field -- a limit set has empty interior, so
// there is no inside to be in.
fn deSchottky(pos : vec3<f32>) -> DEResult {
  const R_OUT : f32 = 0.81649658;   // tangency radius for the four
  const R_IN  : f32 = 0.18350342;   // R_OUT / (2 + sqrt 6)
  const SK_ITERS : i32 = 20;

  // Tetrahedron vertices, normalised: centres sit at distance 1.
  const C0 : vec3<f32> = vec3<f32>( 0.57735027,  0.57735027,  0.57735027);
  const C1 : vec3<f32> = vec3<f32>( 0.57735027, -0.57735027, -0.57735027);
  const C2 : vec3<f32> = vec3<f32>(-0.57735027,  0.57735027, -0.57735027);
  const C3 : vec3<f32> = vec3<f32>(-0.57735027, -0.57735027,  0.57735027);

  var res : DEResult;

  // Shrink factor on every radius. s = 1 is the kissing configuration, where
  // all five spheres are tangent and every generator is parabolic; below 1 they
  // separate and every generator becomes hyperbolic. Above 1 they would
  // overlap, the Poincare condition fails and the group stops being discrete,
  // so the band is strictly one-sided -- this is a boundary of Schottky space,
  // not a midpoint.
  var s : f32 = 1.0;
  if (u.fractalType > 12.5) {
    let tm = select(u.time, 0.0, u.reducedMotion > 0.5);
    s = 0.925 - 0.045 * sin(tm * 0.06);
  }

  let ro = R_OUT * s;
  let ri = R_IN * s;
  let ro2 = ro * ro;
  let ri2 = ri * ri;

  var p = pos;
  var factor = 1.0;
  var word = 0.0;

  // Reduce towards the fundamental domain: invert whenever inside a generator.
  // On the limit set this never terminates, which is what the iteration cap is.
  for (var i = 0; i < SK_ITERS; i = i + 1) {
    var moved = false;

    // The four outer spheres.
    let d0 = p - C0;
    let d1 = p - C1;
    let d2 = p - C2;
    let d3 = p - C3;
    let q0 = dot(d0, d0);
    let q1 = dot(d1, d1);
    let q2 = dot(d2, d2);
    let q3 = dot(d3, d3);
    if (q0 < ro2) {
      let k = ro2 / max(q0, 1e-12);
      p = C0 + d0 * k; factor = factor * k; moved = true;
    } else if (q1 < ro2) {
      let k = ro2 / max(q1, 1e-12);
      p = C1 + d1 * k; factor = factor * k; moved = true;
    } else if (q2 < ro2) {
      let k = ro2 / max(q2, 1e-12);
      p = C2 + d2 * k; factor = factor * k; moved = true;
    } else if (q3 < ro2) {
      let k = ro2 / max(q3, 1e-12);
      p = C3 + d3 * k; factor = factor * k; moved = true;
    } else {
      // The central sphere. Including it as a GENERATOR, not merely as the
      // primitive, is what makes the limit set three-dimensional.
      let qc = dot(p, p);
      if (qc < ri2) {
        let k = ri2 / max(qc, 1e-12);
        p = p * k; factor = factor * k; moved = true;
      }
    }

    if (!moved) { break; }
    word = word + 1.0;
  }

  // Distance to the orbit of the central sphere, carried back to world scale by
  // the accumulated conformal factor -- the same pull-back the Apollonian and
  // Kleinian estimators use.
  //
  // The 0.6 is measured, not taste. Because the nearest orbit sphere need not
  // be the one this reduction lands next to, the raw quotient over-estimates
  // the true distance and the march skips sheets: against a dense fixed-step
  // reference it skipped 25% of rays at full step, and still 6.5% at the 0.85
  // the CPU prototype used -- which looked perfectly clean, exactly the trap
  // the Barth sextic already charged for. 0.6 against the shared marcher's 0.9
  // gives an effective 0.54, where skipping falls to 0.4% and the worst
  // remaining error is 0.017 world units.
  res.dist = 0.6 * (length(p) - ri) / max(factor, 1e-9);
  // Word length: how deep into the group this point sits. Shallow spheres and
  // the deep filigree take separate palette bands.
  res.trap = clamp(0.10 + 0.105 * word, 0.0, 1.0);
  return res;
}

// ---- Tetrabrot (bicomplex Mandelbrot slice) --------------------------------
//
// The parameter-space companion to the quaternion Julia set -- but NOT the
// quaternion Mandelbrot set, which is degenerate. Starting from z0 = 0, every
// iterate of z^2 + c is a real polynomial in c, so the orbit never leaves the
// commutative subalgebra R[c], which for a non-real quaternion is isomorphic to
// C by c -> Re(c) + i|Im(c)|. Membership therefore depends on c only through
// (Re c, |Im c|), making the quaternion Mandelbrot set the plane Mandelbrot set
// REVOLVED about the real axis -- a 2D pattern spun around a primitive, which
// this project's own rules exclude. Measured before discarding it: 4000 random
// quaternions, zero escape-time mismatches against the complex iteration, and
// zero disagreements across 2400 random rotations of Im(c).
//
// Bicomplex numbers escape this because they are commutative WITH ZERO
// DIVISORS. In the idempotent basis e1 = (1 + ij)/2, e2 = (1 - ij)/2 every
// element splits as w = w1 e1 + w2 e2 and multiplication is componentwise, so
// w -> w^2 + c decouples into two independent complex quadratic maps and
//
//     c is in the set  <=>  c1 in M and c2 in M.
//
// For the standard slice c = x + y i + z j the components are
//
//     c1 = x + (y - z) i ,     c2 = x + (y + z) i
//
// so the Tetrabrot is the INTERSECTION OF TWO PRISMS over the classical
// Mandelbrot set, erected along the two diagonals of the (y,z) plane. That is
// genuinely three-dimensional: 580 of 2000 rotated samples change membership,
// where the quaternion version had zero.
fn deTetrabrot(pos : vec3<f32>) -> DEResult {
  const TB_ITERS : i32 = 64;
  const BAILOUT : f32 = 64.0;      // |z|^2
  const X_SHIFT : f32 = -0.5;      // measured interior centre is c_x = -0.495
  const SQRT2 : f32 = 1.41421356;
  const KDE_IN : f32 = 2.4;        // in-box safety factor (worst sampled 2.248)
  const KDE_OUT : f32 = 4.5;       // outside it            (worst sampled 4.139)
  const BOX : vec3<f32> = vec3<f32>(0.90, 0.86, 0.86);   // measured extent

  var res : DEResult;

  let c1 = vec2<f32>(pos.x + X_SHIFT, pos.y - pos.z);
  let c2 = vec2<f32>(pos.x + X_SHIFT, pos.y + pos.z);

  // Both components iterate together; each carries its own derivative for the
  // Douady-Hubbard exterior estimate D = 2|z| log|z| / |z'|.
  var z1 = vec2<f32>(0.0); var d1 = vec2<f32>(1.0, 0.0);
  var z2 = vec2<f32>(0.0); var d2 = vec2<f32>(1.0, 0.0);
  var e1 = 0.0; var e2 = 0.0;      // escape estimates, 0 while still bounded
  var esc = f32(TB_ITERS);
  var live1 = true; var live2 = true;

  for (var i = 0; i < TB_ITERS; i = i + 1) {
    if (live1) {
      // z' = 2 z z' + 1, using z BEFORE the update
      d1 = 2.0 * vec2<f32>(z1.x * d1.x - z1.y * d1.y,
                           z1.x * d1.y + z1.y * d1.x) + vec2<f32>(1.0, 0.0);
      z1 = vec2<f32>(z1.x * z1.x - z1.y * z1.y, 2.0 * z1.x * z1.y) + c1;
      let m2 = dot(z1, z1);
      if (m2 > BAILOUT) {
        let m = sqrt(m2);
        e1 = 2.0 * m * log(m) / max(length(d1), 1e-12);
        esc = min(esc, f32(i));
        live1 = false;
      }
    }
    if (live2) {
      d2 = 2.0 * vec2<f32>(z2.x * d2.x - z2.y * d2.y,
                           z2.x * d2.y + z2.y * d2.x) + vec2<f32>(1.0, 0.0);
      z2 = vec2<f32>(z2.x * z2.x - z2.y * z2.y, 2.0 * z2.x * z2.y) + c2;
      let m2 = dot(z2, z2);
      if (m2 > BAILOUT) {
        let m = sqrt(m2);
        e2 = 2.0 * m * log(m) / max(length(d2), 1e-12);
        esc = min(esc, f32(i));
        live2 = false;
      }
    }
    if (!live1 && !live2) { break; }
  }

  // Intersection of the two prisms, so the larger estimate governs. The sqrt2
  // is the projection's metric distortion, not a fudge: for m(p) = (x, y -+ z),
  // |m(p) - m(q)|^2 = dx^2 + (dy -+ dz)^2 <= 2|p - q|^2, so |p - q| >= D/sqrt2.
  let field = max(e1, e2) / SQRT2;

  // The formula is sharp at the surface (measured ratio to true distance 0.90)
  // but increasingly optimistic away from it -- at the camera it claimed 10.85
  // against a true 2.9, and the first CPU render came back completely empty
  // because the opening step cleared the whole object. The set is contained in
  // the box, so the box SDF is also a valid under-estimate; the max of the two
  // takes the box in the far field and the formula near the surface.
  //
  // The divisor has to match where the point is. max() of two estimates is only
  // valid when BOTH under-estimate, and 2.4 holds only inside the box -- outside
  // it the formula runs to 4.14x, and using 2.4 there let the march skip the
  // object entirely: every ray in the reference sweep reported a miss.
  let q = abs(pos) - BOX;
  let box = min(max(q.x, max(q.y, q.z)), 0.0) + length(max(q, vec3<f32>(0.0)));
  let kde = select(KDE_IN, KDE_OUT, box > 0.0);

  res.dist = max(box, field / kde);
  // Escape iteration: the boundary's filigree reads as a different band from
  // the solid body, which never escapes at all.
  res.trap = clamp(0.10 + 0.028 * esc, 0.0, 1.0);
  return res;
}

// ---- Envelope extrusion ----------------------------------------------------
//
// Thurman's Envelope Extrusion E(P): for each face of a convex seed polyhedron,
// launch a ray at each shared-edge midpoint toward a parity-dependent farthest
// feature of the neighbouring face, and take the apex to be the filtered
// average of the ray family's pairwise closest approaches. The output is the
// lateral triangles of the resulting per-face pyramids.
//
// Implementing it verbatim reproduced the preprint's published edge ratios
// exactly -- 1 for the octahedron, phi for the dodecahedron, sqrt(2/5) for the
// icosahedron, 1/sqrt2 for the cuboctahedron -- and Theorem 1's f-vector on
// every seed. It also showed the construction is far simpler than its
// definition, by a lemma the paper does not state:
//
//   EVERY RAY LIES IN THE PLANE OF THE NEIGHBOUR IT CAME FROM. The ray runs
//   from a feature OF g to the midpoint of the shared edge, which is also in g,
//   and two points of g determine a line in g's plane.
//
// So the apex is forced onto the intersection of the neighbouring face planes,
// which is exactly the classical first-stellation point -- verified to 1e-9 on
// every seed. Each lateral face then lies in a neighbour's plane too, making
// the pyramid the classical stellation cell, and the whole solid becomes
//
//     { p : p violates AT MOST ONE of the seed's face half-spaces }.
//
// Because the seed's face normals come in +- pairs, the half-space values
// reduce to |p . u_j| over the axes, and the estimator is the SECOND LARGEST of
// those, minus the common offset. Each term is 1-Lipschitz and an order
// statistic of 1-Lipschitz functions is 1-Lipschitz, so this is an exact
// distance under-estimate needing no safety factor and no calibration -- the
// only estimator here that required neither. Checked against the full plane
// list at 20000 points: worst difference 0.
//
// Two seeds ship. The octahedron gives lateral edges equal to seed edges, so
// every added piece is a regular tetrahedron and the solid is Kepler's stella
// octangula; the dodecahedron gives ratio phi and the small stellated
// dodecahedron. The tetrahedron and cube are excluded: for the cube the
// neighbouring planes are parallel in pairs and never meet, and for the
// tetrahedron all three neighbours share the opposite vertex, so the rays meet
// only behind their origins, at t = -1, on that vertex.
fn deEnvelope(pos : vec3<f32>) -> DEResult {
  const A : f32 = 0.85065081;   // icosahedral axis components, dodecahedron seed
  const B : f32 = 0.52573111;
  const T : f32 = 0.57735027;   // (1,1,1)/sqrt3, octahedron seed
  const C_OCT : f32 = 0.40824829;
  const C_DOD : f32 = 1.11351636;

  var res : DEResult;

  // Largest and second largest of |p . u_j|.
  var m1 = -1e30;
  var m2 = -1e30;
  var c = C_OCT;

  // Six slots; the octahedral seed uses the first four and repeats the last
  // value, which cannot disturb the top two.
  var vals = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  var n = 6;

  if (u.fractalType < 15.5) {
    // Octahedral seed: four axes, the cube diagonals.
    vals[0] = abs(pos.x + pos.y + pos.z) * T;
    vals[1] = abs(pos.x + pos.y - pos.z) * T;
    vals[2] = abs(pos.x - pos.y + pos.z) * T;
    vals[3] = abs(pos.x - pos.y - pos.z) * T;
    n = 4;
  } else {
    c = C_DOD;
    // Dodecahedral seed: six axes, the icosahedron's vertex directions.
    vals[0] = abs(A * pos.x + B * pos.y);
    vals[1] = abs(B * pos.x + A * pos.z);
    vals[2] = abs(A * pos.y + B * pos.z);
    vals[3] = abs(B * pos.x - A * pos.z);
    vals[4] = abs(A * pos.y - B * pos.z);
    vals[5] = abs(A * pos.x - B * pos.y);
  }

  for (var i = 0; i < n; i = i + 1) {
    let t = vals[i];
    if (t > m1) { m2 = m1; m1 = t; } else if (t > m2) { m2 = t; }
  }

  res.dist = m2 - c;
  // How deep into a spike the point sits: at a tip one axis dominates and the
  // gap is wide, on the flats between spikes the top two are nearly equal.
  res.trap = clamp(0.18 + 0.55 * (m1 - m2) / c, 0.0, 1.0);
  return res;
}

// ---- Hyperbolic honeycomb --------------------------------------------------
//
// A regular tessellation {p,q,r} of HYPERBOLIC 3-space, drawn in the Poincare
// ball. This is the first model here whose ambient space is not Euclidean:
// everything else is an object sitting in Euclidean 3-space, or a limit set on
// the boundary of hyperbolic space. Here what fills the ball is space itself.
//
// The symmetry group [p,q,r] is a Coxeter group on four mirrors, with dihedral
// angles pi/p, pi/q, pi/r along the chain and right angles otherwise. Three of
// them can be taken as Euclidean planes through the origin -- they generate the
// finite group [p,q] of a single cell -- and the fourth as a sphere orthogonal
// to the unit sphere, which is what carries one cell into the next:
//
//   n0 = (1, 0, 0)
//   n1 = (-cos(pi/p), sin(pi/p), 0)
//   n2 = (0, -cos(pi/q)/sin(pi/p), sqrt(1 - cos^2(pi/q)/sin^2(pi/p)))
//
// The sphere is orthogonal to the first two, so its centre lies on u = n0 x n1,
// and meets the third at pi/r. With |c|^2 - s^2 = 1 for orthogonality to the
// unit sphere, that gives t^2 = cos^2(pi/r) / (cos^2(pi/r) - (u.n2)^2). The
// denominator is positive exactly for the four compact hyperbolic honeycombs:
// it vanishes for the Euclidean {4,3,4} and goes negative for the spherical
// {5,3,3}, so the construction rejects those for the right reason.
//
// The centre goes on the NEGATIVE side of n2, the side the fundamental cone
// lies on. Placed the other way the sphere never meets the cone: the fold
// reduces by plane reflections alone, the conformal factor stays exactly 1, and
// what renders is one cell rather than a tessellation. The measured reflection
// count is what exposes it -- it should climb toward the boundary (4 to 11 as
// |p| goes to 0.99, with the factor reaching 48), and instead sat flat.
//
// What is drawn is the edge skeleton. The honeycomb's vertex and edge-midpoint
// both lie in n2 and on the mirror sphere, so the geodesic edge between them is
// an arc of their intersection circle, which is cheap in closed form. Cell walls
// were the first attempt and are the wrong choice: they fill the ball, so from
// outside they render as a featureless sphere.
//
// Clipped well inside the unit ball, not at it. The edges accumulate on the
// sphere at infinity, so near |p| = 1 the structure is finer than any finite
// reflection budget resolves.
fn deHoneycomb(pos : vec3<f32>) -> DEResult {
  const HC_ITERS : i32 = 40;
  const R_CLIP : f32 = 0.85;

  var res : DEResult;

  let r = length(pos);
  let clip = r - R_CLIP;
  if (r >= 0.999) {
    // Outside the ball the fold is not valid. The clip is a safe step and is
    // far enough above zero here that it cannot itself register as a surface.
    res.dist = clip;
    res.trap = 0.4;
    return res;
  }

  let ft = u.fractalType;
  // {5,3,4} carries ids 17, 19, 20; {4,3,5} carries 18, 21, 22.
  let is435 = (ft > 17.5 && ft < 18.5) || (ft > 20.5);

  var n0 = vec3<f32>(1.0, 0.0, 0.0);
  var n1 = vec3<f32>(-0.80901699, 0.58778525, 0.0);   // p = 5
  var n2 = vec3<f32>(0.0, -0.85065081, 0.52573111);
  var cen = vec3<f32>(0.0, 0.0, -1.49534878);          // r = 4
  var sph = 1.11178595;
  if (is435) {
    n1 = vec3<f32>(-0.70710678, 0.70710678, 0.0);      // p = 4
    n2 = vec3<f32>(0.0, -0.70710678, 0.70710678);
    cen = vec3<f32>(0.0, 0.0, -2.05817103);            // r = 5
    sph = 1.79890744;
  }

  // Baked Wythoff edge circles: centre.xyz with radius in w, and the circle's
  // plane normal. The seed depends only on the group and the active-mirror
  // string, so these are constants and the per-step cost is unchanged.
  var ec = array<vec4<f32>, 4>(vec4<f32>(0.0), vec4<f32>(0.0),
                               vec4<f32>(0.0), vec4<f32>(0.0));
  var en = array<vec3<f32>, 4>(vec3<f32>(0.0), vec3<f32>(0.0),
                               vec3<f32>(0.0), vec3<f32>(0.0));
  var ecount = 1;
  var thick = 0.020;

  if (ft < 18.5) {
    // 1000 -- regular. Verified against the independently derived circle the
    // first honeycomb estimator used: centres agree to 1e-16.
    if (is435) {
      ec[0] = vec4<f32>(0.0, -1.02908551, -1.02908551, 1.05737126);
      en[0] = vec3<f32>(0.0, 0.70710678, -0.70710678);
    } else {
      ec[0] = vec4<f32>(0.0, -0.66874030, -1.08204454, 0.78615138);
      en[0] = vec3<f32>(0.0, 0.85065081, -0.52573111);
    }
  } else if (ft < 19.5) {
    // {5,3,4} 1100 -- truncated
    ec[0] = vec4<f32>(0.0, -0.66874030, -1.08204454, 0.78615138);
    en[0] = vec3<f32>(0.0, 0.85065081, -0.52573111);
    ec[1] = vec4<f32>(-0.39307569, -0.54102227, -1.08204454, 0.78615138);
    en[1] = vec3<f32>(-0.5, -0.68819096, 0.52573111);
    ecount = 2; thick = 0.017;
  } else if (ft < 20.5) {
    // {5,3,4} 1111 -- omnitruncated
    ec[0] = vec4<f32>(0.0, -0.61749045, -1.38075061, 1.13479809);
    en[0] = vec3<f32>(0.0, 0.91287093, -0.40824829);
    ec[1] = vec4<f32>(-0.36295178, -0.49956026, -1.38075061, 1.13479809);
    en[1] = vec3<f32>(-0.53657208, -0.73852813, 0.40824829);
    ec[2] = vec4<f32>(-0.20063481, -0.78816061, -1.27527065, 1.13479809);
    en[2] = vec3<f32>(0.99116321, -0.06973710, -0.11283710);
    ec[3] = vec4<f32>(-0.64938335, -1.99859645, -0.66874030, 1.96552795);
    en[3] = vec3<f32>(-0.95105652, 0.30901699, 0.0);
    ecount = 4; thick = 0.012;
  } else if (ft < 21.5) {
    // {4,3,5} 1100 -- truncated
    ec[0] = vec4<f32>(0.0, -1.02908551, -1.02908551, 1.05737126);
    en[0] = vec3<f32>(0.0, 0.70710678, -0.70710678);
    ec[1] = vec4<f32>(-0.72767335, -0.72767335, -1.02908551, 1.05737126);
    en[1] = vec3<f32>(-0.5, -0.5, 0.70710678);
    ecount = 2; thick = 0.017;
  } else {
    // {4,3,5} 1111 -- omnitruncated
    ec[0] = vec4<f32>(0.0, -1.14061807, -1.80877666, 1.89015411);
    en[0] = vec3<f32>(0.0, 0.84586181, -0.53340209);
    ec[1] = vec4<f32>(-0.80653877, -0.80653877, -1.80877666, 1.89015411);
    en[1] = vec3<f32>(-0.59811460, -0.59811460, 0.53340209);
    ec[2] = vec4<f32>(-0.47245947, -1.47469736, -1.47469736, 1.89015411);
    en[2] = vec3<f32>(0.97528690, -0.15622989, -0.15622989);
    ec[3] = vec4<f32>(-1.14497143, -2.76420555, -0.48586827, 2.86144367);
    en[3] = vec3<f32>(-0.92387953, 0.38268343, 0.0);
    ecount = 4; thick = 0.012;
  }

  var p = pos;
  var factor = 1.0;
  var word = 0.0;
  let s2 = sph * sph;

  for (var i = 0; i < HC_ITERS; i = i + 1) {
    var moved = false;
    let d0 = dot(p, n0);
    if (d0 > 0.0) { p = p - n0 * (2.0 * d0); moved = true; }
    let d1 = dot(p, n1);
    if (d1 > 0.0) { p = p - n1 * (2.0 * d1); moved = true; }
    let d2 = dot(p, n2);
    if (d2 > 0.0) { p = p - n2 * (2.0 * d2); moved = true; }
    let v = p - cen;
    let q2 = dot(v, v);
    if (q2 < s2) {
      let k = s2 / max(q2, 1e-18);
      p = cen + v * k;
      factor = factor * k;
      moved = true;
    }
    if (!moved) { break; }
    word = word + 1.0;
  }

  // Nearest of the seed's edges, carried back through the conformal factor --
  // rays are marched in the Euclidean ball, so the estimate must be Euclidean.
  var best = 1e30;
  for (var i = 0; i < ecount; i = i + 1) {
    let w = p - ec[i].xyz;
    let axial = dot(w, en[i]);
    let radial = sqrt(max(dot(w, w) - axial * axial, 0.0)) - ec[i].w;
    best = min(best, sqrt(radial * radial + axial * axial));
  }
  let tube = (best - thick) / max(factor, 1e-9);

  res.dist = max(tube, clip);
  // Reflection depth: cells near the boundary took far more folding than the
  // one around the origin, so this reads as hyperbolic distance from the centre.
  res.trap = clamp(0.12 + 0.055 * word, 0.0, 1.0);
  return res;
}

// ---- Kleinian sphere packing -----------------------------------------------
//
// A packing of round spheres, every one of them tangent to the sphere at
// infinity and to its neighbours, arising as the ORBIT of a single sphere under
// a Kleinian group. That is a different object from the two packings already
// here: those are a periodic lattice fold composed with an inversion, which
// imitates the look without being anybody's orbit, and their spheres are not
// exactly tangent to one another.
//
// The group is the honeycomb group [5,3,6], built exactly as deHoneycomb builds
// its own -- three plane mirrors through the origin and one sphere orthogonal to
// the unit sphere. What changes is the last branch of the Coxeter diagram. With
// r = 6 the vertex figure {3,6} is a EUCLIDEAN tiling rather than a spherical
// one, which pushes the honeycomb's vertex out onto the sphere at infinity: the
// cells are IDEAL dodecahedra, their corners touching the boundary.
//
// An ideal vertex is a cusp, and a cusp carries HOROBALLS -- spheres tangent to
// the boundary from inside, which in hyperbolic terms are surfaces at infinite
// distance from every interior point. Mobius maps carry horoballs to horoballs,
// so the orbit of one is a family of Euclidean spheres, and their residual set
// is the limit set of the group. This is a Kleinian sphere packing in the strict
// sense.
//
// WHICH HOROBALL, measured rather than chosen. The fundamental simplex has one
// ideal vertex v, lying on mirrors m1, m2 and the sphere but not on m0. Seeding
// with the horoball at v tangent to m0 makes its reflection in m0 tangent to it
// rather than overlapping, and that propagates through the group: the orbit is
// the maximal cusp, where every sphere touches its neighbours and none of them
// cross. Checked on the CPU over the orbit: worst overlap 1.7e-16, and every
// image satisfies |centre| + radius = 1 to 4.4e-16, i.e. is exactly tangent to
// the boundary. Run against the COMPACT {5,3,4} as a control the same code
// produces overlaps of 0.23 and tangency errors of 0.38, because that group has
// no cusp to seed from -- so the construction fails where it should.
//
// The vertex is ideal exactly when the line m1^m2 meets the mirror sphere in a
// double point: substituting p = t*d into |p - c|^2 = s^2 with |c|^2 - s^2 = 1
// gives t^2 - 2(d.c)t + 1 = 0, whose roots multiply to 1, so they are an
// inversive pair straddling the boundary unless the discriminant vanishes, which
// forces t = +-1. Measured for {5,3,6}: discriminant exactly 0, |v| = 1 to 1e-12.
//
// WHY {5,3,6} AND NOT {3,3,6}. All four cusped honeycombs give exact packings,
// but only some can be SEEN. Sampling shells for the fraction lying inside the
// packing: {3,3,6} is 84% covered at every radius and {3,4,4} 80%, so both read
// as a solid ball from outside. {5,3,6} has the smallest seed horoball of the
// four and leaves 0% coverage inside radius 0.45 -- a hollow core -- rising to
// only 43-63% further out, so there are real gaps to see through and the
// spheres read as spheres.
//
// SAFETY FACTOR 0.8, measured. A dense fixed-step reference march found no ray
// stepping past the surface without one -- 150 rays at each of four fold caps,
// zero lost, median error 1.3e-4 short -- but marching is a weak test, and the
// pointwise bound is not satisfied: against the exact distance to 282 known
// orbit spheres the raw quotient over-reports at 36% of sampled points, by up to
// 0.018, because the fold need not land the point beside the NEAREST orbit
// sphere. That is the same defect the Schottky estimator charges 0.6 for. The
// largest factor that keeps every sampled point conservative is 0.849, so 0.8
// takes that with a margin.
fn deKleinPack(pos : vec3<f32>) -> DEResult {
  const KP_ITERS : i32 = 24;
  const R_CLIP : f32 = 0.95;      // the packing is tangent to |p| = 1

  // [5,3,6]: p = 5 and q = 3 give the same two plane mirrors as {5,3,4}; only
  // the mirror sphere differs, being the branch that carries r.
  const N0 : vec3<f32> = vec3<f32>(1.0, 0.0, 0.0);
  const N1 : vec3<f32> = vec3<f32>(-0.80901699, 0.58778525, 0.0);
  const N2 : vec3<f32> = vec3<f32>(0.0, -0.85065081, 0.52573111);
  const CEN : vec3<f32> = vec3<f32>(0.0, 0.0, -1.25840857);
  const S2 : f32 = 0.58359214;    // sphere radius 0.76393202, squared
  // Seed horoball: centre (1 - r) * v at the ideal vertex, radius r.
  const HO : vec3<f32> = vec3<f32>(-0.26298370, -0.36196601, -0.58567330);
  const HR : f32 = 0.26298370;

  var res : DEResult;

  let r = length(pos);
  let clip = r - R_CLIP;
  if (r >= 0.999) {
    // Outside the ball the fold is not valid. The clip is a safe step, and far
    // enough above zero here that it cannot itself register as a surface.
    res.dist = clip;
    res.trap = 0.5;
    return res;
  }

  var p = pos;
  var factor = 1.0;
  var word = 0.0;

  for (var i = 0; i < KP_ITERS; i = i + 1) {
    var moved = false;
    let d0 = dot(p, N0);
    if (d0 > 0.0) { p = p - N0 * (2.0 * d0); moved = true; }
    let d1 = dot(p, N1);
    if (d1 > 0.0) { p = p - N1 * (2.0 * d1); moved = true; }
    let d2 = dot(p, N2);
    if (d2 > 0.0) { p = p - N2 * (2.0 * d2); moved = true; }
    let v = p - CEN;
    let q2 = dot(v, v);
    if (q2 < S2) {
      let k = S2 / max(q2, 1e-18);
      p = CEN + v * k;
      factor = factor * k;
      moved = true;
    }
    if (!moved) { break; }
    word = word + 1.0;
  }

  // An exact sphere in the folded frame, carried back to world scale by the
  // accumulated conformal factor. Rays are marched in the Euclidean ball, so the
  // estimate has to be a Euclidean one. The clip is exact and is deliberately
  // left outside the safety factor.
  let horo = 0.8 * (length(p - HO) - HR) / max(factor, 1e-9);

  res.dist = max(horo, clip);
  // How deep into the group this sphere sits. The few big spheres come out of
  // shallow words and the cascade filling their gaps out of long ones, so this
  // separates the generations into palette bands.
  res.trap = clamp(0.10 + 0.075 * word, 0.0, 1.0);
  return res;
}

${ENGEL_WGSL}

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
  } else if (ft < 8.5) {
    return dePenrose(pos);
  } else if (ft < 9.5) {
    return deGyroid(pos);
  } else if (ft < 10.5) {
    return deKleinian(pos);
  } else if (ft < 11.5) {
    return deBarth(pos);
  } else if (ft < 13.5) {
    // Both Schottky entries share one estimator; the id selects the regime.
    return deSchottky(pos);
  } else if (ft < 14.5) {
    return deTetrabrot(pos);
  } else if (ft < 16.5) {
    // Both envelope entries share one estimator; the id selects the seed.
    return deEnvelope(pos);
  } else if (ft < 22.5) {
    // The six honeycomb entries share one estimator; the id selects {p,q,r}
    // and the active-mirror string.
    return deHoneycomb(pos);
  } else if (ft < 23.5) {
    return deKleinPack(pos);
  }
  return deEngel(pos);
}

fn mapDist(pos : vec3<f32>) -> f32 {
  return mapDE(pos).dist;
}

// ---- Camera clearance probe ------------------------------------------------
//
// One float per frame: how far the camera is from the nearest surface. The CPU
// reads it back to scale fly-through speed, so travel covers a constant
// fraction of the available space rather than a constant number of world units.
//
// It has to happen here because the distance estimators only exist on the GPU.
// The value is a frame or two stale by the time JavaScript sees it, which is
// irrelevant for a speed control.
//
// Declared as a separate entry point rather than folded into the fragment
// shader. Bindings are validated per entry point, so the raymarch pipeline's
// layout stays as it was -- it never reaches this storage buffer.
@group(0) @binding(1) var<storage, read_write> probe : array<f32>;

@compute @workgroup_size(1)
fn cs_probe() {
  // [0] clearance at the camera, scaling fly travel.
  let d0 = mapDE(u.camPos).dist;
  probe[0] = d0;

  // [1] distance to the first surface straight ahead, or -1 for a miss. The
  // orbit camera re-pins its pivot onto this point when zooming, so that zoom
  // dollies towards the surface being inspected rather than towards the
  // model's centroid -- which is what drives the eye through the surface and
  // into the interior.
  //
  // Bail when the camera is already at or inside a surface: retargeting from
  // there would pin the pivot to the wall the camera is buried in.
  var hit = -1.0;
  let toTarget = u.camTarget - u.camPos;
  if (d0 > 1e-4 && length(toTarget) > 1e-9) {
    let fwd = normalize(toTarget);
    // Kept short deliberately: this is one thread, so every step here stalls
    // the whole GPU. The models all live well inside the far bound, and a miss
    // simply means no re-pin this tick -- the next probe tries again.
    var t = 1e-3;
    for (var i = 0; i < 96; i = i + 1) {
      let d = mapDE(u.camPos + fwd * t).dist;
      if (d < 1e-3 * t) { hit = t; break; }      // relative eps, as the marcher uses
      t = t + max(d * 0.8, 1e-5);                // no zero-step stall
      if (t > 60.0) { break; }
    }
  }
  probe[1] = hit;
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
  // Subpixel offset for progressive accumulation. Zero on a moving frame, so
  // the interactive image is unchanged; while the view is still it walks an R2
  // low-discrepancy sequence and the running average resolves the aliasing that
  // the high-frequency models (Penrose grooves, Kleinian filigree) suffer from.
  let uv = in.uv + u.jitter / max(u.resolution, vec2<f32>(1.0));

  let ro = u.camPos;
  let ta = u.camTarget;
  let rd = cameraRay(vec2<f32>(uv.x, 1.0 - uv.y), ro, ta, u.fov);

  // Strange attractors aren't distance fields — they're rasterized as line
  // geometry by a second pipeline drawn over this pass. Emit only the
  // background here so those lines have something to blend onto.
  if (u.fractalType > 24.5) {
    let bg = backgroundColor(rd);
    return vec4<f32>(select(vec3<f32>(0.0), bg, u.bgMode >= 0.5), 0.0);
  }

  // Adaptive epsilon: coarser when quality is low.
  let epsScale = mix(2.5, 1.0, clamp(u.qualityScale, 0.0, 1.0));
  let hitEps = BASE_EPS * epsScale;

  // Fly-through mode can put the camera inside solid material, where the DE is
  // negative. Marching from there would report an instant hit and fill the
  // screen with a flat wall, so walk the origin forward until it is in free
  // space first. Costs one extra evaluation per pixel when already outside.
  var ro2 = ro;
  if (u.flyMode > 0.5) {
    for (var g = 0; g < 12; g = g + 1) {
      let dd = mapDE(ro2).dist;
      if (dd > 0.0) { break; }
      ro2 = ro2 + rd * max(-dd * 1.05, 0.01);
    }
  }

  // Start closer in when flying: walls can be a hair in front of the camera.
  var t = select(0.05, 0.008, u.flyMode > 0.5);
  var hit = false;
  var trap = 1.0;
  var glow = 0.0;

  // Sphere tracing with a small relaxation factor and glow from near-misses.
  for (var i = 0; i < MAX_STEPS; i = i + 1) {
    let pos = ro2 + rd * t;
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
    // Relaxed step (slightly under 1.0 keeps thin filaments from tunneling).
    // The floor guarantees forward progress: without it a near-zero or negative
    // estimate stalls the march, or walks it backwards.
    t = t + max(d * 0.9, 0.0008);
    if (t > MAX_DIST) { break; }
  }

  var color = vec3<f32>(0.0);
  let bg = backgroundColor(rd);

  if (hit) {
    let pos = ro2 + rd * t;
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

    // Orbit-trap -> palette. NO time phase here, deliberately.
    //
    // Colour cycling used to live on this line, and it could only ever be seen
    // while the view was moving: once progressive accumulation converges, the
    // raymarch is skipped entirely and the stored frame is re-presented, so the
    // colour froze at exactly the moment the picture became sharp. Anything
    // time-varying baked in here also smears across the running average while
    // it accumulates. The cycle now happens in the composite pass, which runs
    // every frame regardless, so the colour moves on a converged image and
    // convergence is never thrown away.
    let phase = 0.0;
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
  // Fixed phase for the same reason: this fed u.time in, which made the
  // accumulated buffer time-dependent and put the glow on a different cycle
  // rate (0.02) from the surface (0.03), so the two drifted out of step.
  let glowTint = palette(0.5) * glowOut;
  color = color + glowTint * 0.4;

  // Store straight (non-premultiplied) HDR color in RGB; emission/glow in .a
  // for the bloom pass. The composite pass turns these into final alpha.
  return vec4<f32>(color, glowOut);
}
`;
