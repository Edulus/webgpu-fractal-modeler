// material.wgsl.js — palette-independent raymarch output.
//
// The expensive distance-field pass must be able to converge once and stay
// converged while the palette moves. The original raymarch shader bakes RGB
// into its HDR output, which makes any later colour cycle a transform of the
// finished pixel rather than a re-indexing of the selected palette.
//
// Reuse every estimator, camera helper, normal/shadow/AO routine and constant
// from the main shader, then add one fragment entry point that stores material
// coordinates and scalar lighting weights instead of palette RGB. The post
// chain can then evaluate the current palette at any phase without re-marching.

import { FRACTAL_WGSL } from './fractal.wgsl.js';

export const MATERIAL_WGSL = FRACTAL_WGSL + /* wgsl */ `

struct MaterialOut {
  // x = palette coordinate * base weight
  // y = base palette weight
  // z = neutral specular weight
  // w = emission/glow
  @location(0) material : vec4<f32>,
  // x = fog/background weight on surface hits
  // y = seam palette coordinate * seam weight
  // z = seam palette weight
  // w = miss/background coverage (resolved as opaque or transparent later)
  @location(1) aux : vec4<f32>,
};

// ---------------------------------------------------------------------------
// Cosmic Web — a bounded volumetric multifractal density field.
//
// The low-frequency fBm establishes broad void domains and gently warps three
// nested families of quasi-periodic zero surfaces. Intersections of two surfaces
// form filaments; intersections of all three form knots. Successively smaller
// families are allowed to survive mainly near their parents, producing a
// large-void -> backbone -> branch -> fine-thread hierarchy instead of a uniform
// lattice. The weights are strongly nonlinear so matter is intermittent: most
// of the volume is empty and a small fraction carries most of the emission.
struct CosmicWebSample {
  density : f32,
  coord   : f32,
  knot    : f32,
};

fn webHash31(p : vec3<f32>) -> f32 {
  var q = fract(p * 0.1031);
  let h = dot(q, q.yzx + vec3<f32>(33.33));
  q = q + vec3<f32>(h);
  return fract((q.x + q.y) * q.z);
}

fn webNoise3(p : vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u3 = f * f * (vec3<f32>(3.0) - 2.0 * f);

  let n000 = webHash31(i + vec3<f32>(0.0, 0.0, 0.0));
  let n100 = webHash31(i + vec3<f32>(1.0, 0.0, 0.0));
  let n010 = webHash31(i + vec3<f32>(0.0, 1.0, 0.0));
  let n110 = webHash31(i + vec3<f32>(1.0, 1.0, 0.0));
  let n001 = webHash31(i + vec3<f32>(0.0, 0.0, 1.0));
  let n101 = webHash31(i + vec3<f32>(1.0, 0.0, 1.0));
  let n011 = webHash31(i + vec3<f32>(0.0, 1.0, 1.0));
  let n111 = webHash31(i + vec3<f32>(1.0, 1.0, 1.0));

  let nx00 = mix(n000, n100, u3.x);
  let nx10 = mix(n010, n110, u3.x);
  let nx01 = mix(n001, n101, u3.x);
  let nx11 = mix(n011, n111, u3.x);
  let nxy0 = mix(nx00, nx10, u3.y);
  let nxy1 = mix(nx01, nx11, u3.y);
  return mix(nxy0, nxy1, u3.z);
}

// Three octaves are enough to give the void scaffold a scale-free character
// without making every ray sample prohibitively expensive.
fn webFbm3(p0 : vec3<f32>) -> f32 {
  var p = p0;
  var amp = 0.57;
  var sum = 0.0;
  var norm = 0.0;
  for (var i = 0; i < 3; i = i + 1) {
    sum = sum + amp * webNoise3(p);
    norm = norm + amp;
    p = p * 2.03 + vec3<f32>(13.7, -9.2, 5.1);
    amp = amp * 0.52;
  }
  return sum / max(norm, 1e-5);
}

// Three differently oriented, incommensurate wave surfaces. Their pairwise
// intersections are one-dimensional curves, so sharpening the two closest
// surfaces produces filaments rather than cloud blobs or broad sheets.
fn webWave(p : vec3<f32>, scale : f32, phase : f32) -> vec3<f32> {
  let q = p * scale;
  let a = sin(
    dot(q, vec3<f32>(0.91, 0.37, 0.18))
    + 0.45 * sin(dot(q, vec3<f32>(-0.23, 0.79, 0.52)) * 0.71 + phase * 0.41)
    + phase
  );
  let b = sin(
    dot(q, vec3<f32>(0.31, 0.96, -0.27)) * 1.07
    + 0.42 * sin(dot(q, vec3<f32>(0.68, -0.19, 0.71)) * 0.67 - phase * 0.37)
    - phase * 0.83
  );
  let c = sin(
    dot(q, vec3<f32>(-0.41, 0.24, 0.88)) * 0.94
    + 0.39 * sin(dot(q, vec3<f32>(0.56, 0.73, 0.21)) * 0.73 + phase * 0.29)
    + phase * 0.61
  );
  return vec3<f32>(a, b, c);
}

// x = filament support (two surfaces near zero), y = knot support (all three).
fn webFilament(w : vec3<f32>, sharpness : f32) -> vec2<f32> {
  let v = abs(w);
  let pair = min(v.x + v.y, min(v.y + v.z, v.z + v.x));
  let filament = exp(-sharpness * pair);
  let knot = exp(-sharpness * 0.72 * (v.x + v.y + v.z));
  return vec2<f32>(filament, knot);
}

fn cosmicWebSampleAt(p : vec3<f32>, tm : f32) -> CosmicWebSample {
  // Burgers/adhesion-inspired visual motion: a very slow drift plus a spatially
  // varying deformation. It changes local convergence instead of simply
  // wobbling the entire volume in place.
  let drift = tm * vec3<f32>(0.013, -0.007, 0.010);
  let low = webFbm3((p + drift * 0.45) * 0.22
                    + vec3<f32>(tm * 0.0017, -tm * 0.0011, tm * 0.0013));
  let warp = low - 0.5;

  var q = p + drift + vec3<f32>(0.72, -0.46, 0.58) * warp;
  q = q + 0.10 * vec3<f32>(
    sin(q.y * 0.42 + tm * 0.013),
    sin(q.z * 0.37 - tm * 0.011),
    sin(q.x * 0.39 + tm * 0.009)
  );

  let phase = tm * 0.017;
  let wm = webWave(q, 0.78, phase);
  let ws = webWave(q + vec3<f32>(2.7, -1.8, 4.1), 1.56, -phase * 1.13);
  let wf = webWave(q + vec3<f32>(-3.4, 2.2, 1.6), 3.08, phase * 1.31);

  let majorPair = webFilament(wm, 4.7);
  let secondaryPair = webFilament(ws, 5.8);
  let finePair = webFilament(wf, 7.1);

  let major = pow(majorPair.x, 1.35);
  let branchSupport = mix(0.10, 1.0, smoothstep(0.12, 0.62, major));
  let branch = pow(secondaryPair.x, 1.55) * branchSupport;
  let threadParent = max(major, branch);
  let thread = pow(finePair.x, 1.9)
               * mix(0.035, 0.70, smoothstep(0.07, 0.52, threadParent));

  // Three-way intersections become compact high-density knots. Secondary/fine
  // knots matter mainly where a parent filament already exists.
  let knot = max(
    pow(majorPair.y, 1.10),
    max(pow(secondaryPair.y, 1.25) * major,
        pow(finePair.y, 1.45) * branch)
  );

  // A broad low-frequency gate creates genuine large empty domains. The sphere
  // fade gives Shape Viewer a finite object to orbit while Fly mode can enter it.
  let voidGate = smoothstep(0.36, 0.59, low);
  let bound = 1.0 - smoothstep(4.8, 5.7, length(p));

  // Power-law-like intermittency: faint branches are common, strong matter is
  // rare, and the small high-density tail carries the bright knots.
  let hierarchy = 1.35 * major + 0.72 * branch + 0.22 * thread + 1.85 * knot;
  let density = bound * voidGate * pow(max(hierarchy, 0.0), 1.45);

  // One palette coordinate per accumulated ray sample. It varies across scales
  // and shifts a little at knots, while the live global colour-cycle phase is
  // still applied later in the composite pass exactly like every other shape.
  let coord = 0.15 + 0.52 * low + 0.13 * (0.5 + 0.5 * wm.z)
              + 0.09 * branch + 0.31 * knot;

  var s : CosmicWebSample;
  s.density = density;
  s.coord = coord;
  s.knot = knot;
  return s;
}

fn cosmicWebMaterial(ro : vec3<f32>, rd : vec3<f32>) -> MaterialOut {
  var out : MaterialOut;
  out.material = vec4<f32>(0.0);
  out.aux = vec4<f32>(0.0);

  // Intersect the bounded volume first so empty screen-space rays do no density
  // work. This also gives each quality rung a known finite integration span.
  let radius = 5.7;
  let b = dot(ro, rd);
  let c = dot(ro, ro) - radius * radius;
  let h = b * b - c;
  if (h <= 0.0) {
    out.aux.w = 1.0;
    return out;
  }

  let root = sqrt(max(h, 0.0));
  let t0 = max(0.02, -b - root);
  let t1 = -b + root;
  if (t1 <= t0) {
    out.aux.w = 1.0;
    return out;
  }

  var stepCount = i32(u.detail.x * 0.30);
  stepCount = max(28, min(stepCount, 88));
  let dt = (t1 - t0) / f32(stepCount);
  let tm = select(u.time, 0.0, u.reducedMotion > 0.5);

  var transmittance = 1.0;
  var indexWeight = 0.0;
  var paletteWeight = 0.0;
  var glow = 0.0;

  for (var i = 0; i < 88; i = i + 1) {
    if (i >= stepCount) { break; }
    let t = t0 + (f32(i) + 0.5) * dt;
    let s = cosmicWebSampleAt(ro + rd * t, tm);

    if (s.density > 0.0005) {
      let alpha = 1.0 - exp(-s.density * dt * 1.45);
      let brightness = 0.66 + 1.75 * s.knot + 0.22 * sqrt(max(s.density, 0.0));
      let w = transmittance * alpha * brightness;
      paletteWeight = paletteWeight + w;
      indexWeight = indexWeight + s.coord * w;
      glow = glow + w * (0.20 + 2.9 * s.knot + 0.20 * s.density);
      transmittance = transmittance * (1.0 - alpha * 0.88);
    }

    if (transmittance < 0.015) { break; }
  }

  out.material = vec4<f32>(
    indexWeight,
    min(paletteWeight, 7.0),
    0.0,
    clamp(glow * 1.2, 0.0, 8.0)
  );
  // In opaque mode the composite pass uses this as the amount of backdrop that
  // remains visible through the volume. Transparent mode ignores it.
  out.aux.w = clamp(transmittance, 0.0, 1.0);
  return out;
}


@fragment
fn fs_material(in : VSOut) -> MaterialOut {
  // Match fs_main's subpixel walk exactly: the values accumulated here must
  // represent the same rays the old RGB accumulation represented.
  let uv = in.uv + u.jitter / max(u.resolution, vec2<f32>(1.0));

  let ro = u.camPos;
  let ta = u.camTarget;
  let rd = cameraRay(vec2<f32>(uv.x, 1.0 - uv.y), ro, ta, u.fov);

  var out : MaterialOut;
  out.material = vec4<f32>(0.0);
  out.aux = vec4<f32>(0.0);

  // Attractors are rasterized as line geometry after this draw. The raymarch
  // contributes one full background/miss sample; the post chain decides whether
  // that sample is opaque or transparent from the live bgMode.
  if (abs(u.fractalType - 28.0) < 0.5) {
    return cosmicWebMaterial(ro, rd);
  }

  if (u.fractalType > 24.5 && u.fractalType < 27.5) {
    out.aux.w = 1.0;
    return out;
  }

  let epsScale = mix(2.5, 1.0, clamp(u.qualityScale, 0.0, 1.0));
  let hitEps = BASE_EPS * epsScale;

  var ro2 = ro;
  if (u.flyMode > 0.5) {
    for (var g = 0; g < 12; g = g + 1) {
      let dd = mapDE(ro2).dist;
      if (dd > 0.0) { break; }
      ro2 = ro2 + rd * max(-dd * 1.05, 0.01);
    }
  }

  var t = select(0.05, 0.008, u.flyMode > 0.5);
  var hit = false;
  var trap = 1.0;
  var glow = 0.0;

  for (var i = 0; i < MAX_STEPS; i = i + 1) {
    let pos = ro2 + rd * t;
    let de = mapDE(pos);
    let d = de.dist;

    let near = exp(-d * 42.0);
    glow = glow + near / (1.0 + t * t * 0.35);

    let hitThresh = hitEps * t;
    if (d < hitThresh) {
      hit = true;
      trap = de.trap;
      break;
    }
    t = t + max(d * 0.9, 0.0008);
    if (t > MAX_DIST) { break; }
  }

  var baseIndex = 0.0;
  var baseWeight = 0.0;
  var specWeight = 0.0;
  var bgWeight = 0.0;
  var seamIndex = 0.0;
  var seamWeight = 0.0;
  var missWeight = 0.0;

  if (hit) {
    let pos = ro2 + rd * t;
    let n = calcNormal(pos, hitEps * t * 2.0);

    let keyDir = normalize(vec3<f32>(0.6, 0.7, -0.35));
    let fillDir = normalize(vec3<f32>(-0.5, 0.25, 0.4));
    let diffKey = max(dot(n, keyDir), 0.0);
    let diffFill = max(dot(n, fillDir), 0.0) * 0.35;

    // Soft shadows and occlusion are the first thing dropped on a weak device:
    // they are extra marches per pixel, and a branch really does skip them.
    var sh = 1.0;
    var ao = 1.0;
    if (u.detail.z > 0.5) {
      sh = mix(1.0, softShadow(pos + n * 0.002, keyDir, u.shadowSoftness), 0.9);
      ao = mix(1.0, calcAO(pos, n), u.aoStrength);
    }
    let fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

    // Palette-independent form of the old base shading:
    //   base * ((ambient + key) * AO + fill * AO + fresnel)
    baseIndex = trap * 1.6;
    baseWeight = (0.18 + 0.9 * diffKey * sh) * ao
               + diffFill * ao
               + fres * 0.5;

    let h = normalize(keyDir - rd);
    let spec = pow(max(dot(n, h), 0.0), 32.0) * sh;
    specWeight = spec * 0.4;

    if (u.fractalType > 6.5 && u.fractalType < 7.5) {
      let sm = surfacePackSeam(pos);
      seamIndex = sm.y * 2.1 + 0.35;
      seamWeight = sm.x * 1.1;
      glow = glow + sm.x * 3.5;
    }

    // Apply fog to the scalar contributions now. This keeps the later palette
    // lookup linear: resolve can reconstruct exactly the old static shading as
    // palette(index) * weight + neutral spec + background * weight.
    let fog = 1.0 - exp(-u.fogDensity * t * t * 0.05);
    let visible = 1.0 - fog;
    baseWeight = baseWeight * visible;
    specWeight = specWeight * visible;
    seamWeight = seamWeight * visible;
    bgWeight = fog;
  } else {
    // Keep a miss independent of presentation mode. Opaque/transparent is a
    // post decision, so toggling it on a converged image needs no re-march.
    missWeight = 1.0;
  }

  // fs_main discarded near-miss glow when no surface was actually hit. Keep
  // that static-image contract while moving the hit material into post.
  let glowOut = select(0.0, clamp(glow * u.glowStrength * 0.02, 0.0, 8.0), hit);

  // Store weighted indices rather than bare indices. Miss samples then carry no
  // coordinate into the running average, so an antialiased silhouette does not
  // drag the palette lookup toward zero merely because some jitter samples miss.
  out.material = vec4<f32>(baseIndex * baseWeight, baseWeight, specWeight, glowOut);
  out.aux = vec4<f32>(bgWeight, seamIndex * seamWeight, seamWeight, missWeight);
  return out;
}
`;
