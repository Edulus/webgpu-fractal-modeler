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
//   44  fractalType: f32   (0=mandelbulb, 1=mandelbox, 2=menger, 3=julia)
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
};

@group(0) @binding(0) var<uniform> u : Uniforms;
// Baked strange-attractor density (r = density, g = age along trajectory).
// Only sampled by the attractor branch; a 1^3 placeholder is bound otherwise.
@group(0) @binding(1) var samp3d : sampler;
@group(0) @binding(2) var volTex : texture_3d<f32>;

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

// Ray vs. the [-1,1]^3 box the attractor volume lives in.
fn intersectBox(ro : vec3<f32>, rd : vec3<f32>) -> vec2<f32> {
  let inv = 1.0 / rd;
  let a = (vec3<f32>(-1.0) - ro) * inv;
  let b = (vec3<f32>(1.0) - ro) * inv;
  let tmin = min(a, b);
  let tmax = max(a, b);
  let t0 = max(max(tmin.x, tmin.y), tmin.z);
  let t1 = min(min(tmax.x, tmax.y), tmax.z);
  return vec2<f32>(t0, t1);
}

// Emission-only volume raymarch of the baked strange attractor. Colors by the
// trajectory age so the ribbon cycles through the palette; density drives both
// brightness and the glow channel so the filaments bloom.
fn volumeAttractor(ro : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let bb = intersectBox(ro, rd);
  let tn = max(bb.x, 0.0);
  let tf = bb.y;
  if (tf <= tn) { return vec4<f32>(0.0); }

  // More, finer steps keep filaments crisp when the volume is magnified.
  const VSTEPS : i32 = 220;
  let dt = (tf - tn) / f32(VSTEPS);
  let phase = select(u.time * 0.03, 0.0, u.reducedMotion > 0.5);

  var t = tn + dt * 0.5;
  var col = vec3<f32>(0.0);
  var trans = 1.0;   // remaining transmittance (front-to-back)
  var glow = 0.0;

  for (var i = 0; i < VSTEPS; i = i + 1) {
    let p = ro + rd * t;
    let uvw = p * 0.5 + 0.5;          // [-1,1] -> [0,1] texture coords
    let s = textureSampleLevel(volTex, samp3d, uvw, 0.0);
    let dens = s.r;
    if (dens > 0.02) {
      // Sharpen the transfer function so bright cores read as defined threads.
      let d2 = dens * dens;
      let base = palette(s.g * 1.4 + phase);
      // Higher absorption -> front filaments occlude, giving crisp depth.
      let a = clamp(d2 * 16.0 * dt, 0.0, 1.0);
      col = col + trans * base * d2 * 14.0 * dt;
      trans = trans * (1.0 - a);
      glow = glow + d2 * 4.0 * dt;
    }
    t = t + dt;
    if (trans < 0.015) { break; }
  }

  let glowOut = clamp(glow * u.glowStrength * 0.5, 0.0, 8.0);
  return vec4<f32>(col, glowOut);
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
  }
  return deApollonian(pos);
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
fn backgroundColor(rd : vec3<f32>) -> vec3<f32> {
  let t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  let lo = u.paletteA.rgb * 0.06;
  let hi = u.paletteA.rgb * 0.16 + vec3<f32>(0.01, 0.015, 0.03);
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

  // Strange attractor is volumetric, not a distance field — handle separately.
  if (u.fractalType > 4.5) {
    return volumeAttractor(ro, rd);
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
