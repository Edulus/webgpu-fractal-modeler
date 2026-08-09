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
  if (u.fractalType > 24.5) {
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

    let sh = mix(1.0, softShadow(pos + n * 0.002, keyDir, u.shadowSoftness), 0.9);
    let ao = mix(1.0, calcAO(pos, n), u.aoStrength);
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
