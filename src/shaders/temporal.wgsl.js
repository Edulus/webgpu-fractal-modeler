// temporal.wgsl.js — temporal resolve for MOVING frames, inlined WGSL.
//
// A still view is antialiased by progressive accumulation. A moving one cannot
// simply be averaged, so until now it was one sample per pixel. This pass keeps
// an average going across motion: for every pixel it works out where that
// surface point was on screen in the previous frame, reads the previous result
// there, and blends this frame's jittered sample into it.
//
// It is a pass of its own, with its own bindings, deliberately. The composite
// pass has a standing rule (tools/moving-aa.test.js) that it gains no binding
// and no render target, because a texture bound for reading while it is also
// the attachment being written is an invalid pass and renders nothing. Here
// that cannot happen by construction: history is two pairs of textures, the
// pass reads one pair and writes the other, and they swap every frame.
//
// It operates on the encoded MATERIAL (palette coordinates and lighting
// weights), not on colour, so everything downstream — palette, colour cycle,
// image controls — stays live and unchanged.

import { COMPOSITE_WGSL } from './composite.wgsl.js';

// One Uniforms struct, not a fifth hand-kept copy: lift the composite pass's.
const structStart = COMPOSITE_WGSL.indexOf('struct Uniforms {');
const structEnd = COMPOSITE_WGSL.indexOf('\n};', structStart);
if (structStart < 0 || structEnd < 0) {
  throw new Error('Uniforms struct not found in composite shader');
}
const UNIFORMS_STRUCT = COMPOSITE_WGSL.slice(structStart, structEnd + 3);

export const TEMPORAL_WGSL = /* wgsl */ `
${UNIFORMS_STRUCT}

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var curMaterial : texture_2d<f32>;   // this frame, jittered
@group(0) @binding(3) var curAux : texture_2d<f32>;
@group(0) @binding(4) var curDepth : texture_2d<f32>;      // ray distance, .x
@group(0) @binding(5) var histMaterial : texture_2d<f32>;  // last frame's resolve
@group(0) @binding(6) var histAux : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var out : VSOut;
  let xy = p[vid];
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>(xy.x * 0.5 + 0.5, 1.0 - (xy.y * 0.5 + 0.5));
  return out;
}

// ---- Camera ---------------------------------------------------------------
// This must stay the exact inverse of cameraRay() in fractal-base.wgsl.js,
// including the Shape Explorer yaw basis. yaw is what detail.w held for the
// frame in question: an angle in [-PI, PI], or the sentinel 10 for the
// world-up basis.
struct Basis {
  fwd : vec3<f32>,
  right : vec3<f32>,
  up : vec3<f32>,
};

fn cameraBasis(ro : vec3<f32>, ta : vec3<f32>, yaw : f32) -> Basis {
  var b : Basis;
  b.fwd = normalize(ta - ro);
  if (abs(yaw) < 4.0) {
    b.right = vec3<f32>(-sin(yaw), 0.0, cos(yaw));
  } else {
    b.right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), b.fwd));
  }
  b.up = cross(b.fwd, b.right);
  return b;
}

// Texture-space uv (y down) -> world ray direction, for the current camera.
fn rayDir(uv : vec2<f32>) -> vec3<f32> {
  let b = cameraBasis(u.camPos, u.camTarget, u.detail.w);
  let aspect = u.resolution.x / max(u.resolution.y, 1.0);
  var p = vec2<f32>(uv.x, 1.0 - uv.y) * 2.0 - 1.0;
  p.x = p.x * aspect;
  let focal = 1.0 / tan(u.fov * 0.5);
  return normalize(p.x * b.right + p.y * b.up + focal * b.fwd);
}

// World point -> texture-space uv in the PREVIOUS camera. z is the distance in
// front of that camera; a point behind it has no previous position.
fn previousUV(P : vec3<f32>) -> vec3<f32> {
  let b = cameraBasis(u.prevCamPos, u.prevCamTarget, u.prevYaw);
  let aspect = u.resolution.x / max(u.resolution.y, 1.0);
  let d = P - u.prevCamPos;
  let z = dot(d, b.fwd);
  let focal = 1.0 / tan(u.fov * 0.5);
  var p = vec2<f32>(dot(d, b.right), dot(d, b.up)) * focal / max(z, 1e-4);
  p.x = p.x / aspect;
  let c = p * 0.5 + 0.5;
  return vec3<f32>(c.x, 1.0 - c.y, z);
}

// Catmull-Rom (bicubic) sampling in 9 bilinear taps. History is re-read every
// frame; reading it bilinearly softens it a little each time and the softness
// compounds, which is the usual reason temporal filtering looks blurry.
fn sampleCatmullRom(tex : texture_2d<f32>, uv : vec2<f32>, dims : vec2<f32>) -> vec4<f32> {
  let samplePos = uv * dims;
  let texPos1 = floor(samplePos - 0.5) + 0.5;
  let f = samplePos - texPos1;

  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);

  let w12 = w1 + w2;
  let offset12 = w2 / w12;

  let tp0 = (texPos1 - 1.0) / dims;
  let tp3 = (texPos1 + 2.0) / dims;
  let tp12 = (texPos1 + offset12) / dims;

  var r = vec4<f32>(0.0);
  r += textureSampleLevel(tex, samp, vec2<f32>(tp0.x, tp0.y), 0.0) * (w0.x * w0.y);
  r += textureSampleLevel(tex, samp, vec2<f32>(tp12.x, tp0.y), 0.0) * (w12.x * w0.y);
  r += textureSampleLevel(tex, samp, vec2<f32>(tp3.x, tp0.y), 0.0) * (w3.x * w0.y);

  r += textureSampleLevel(tex, samp, vec2<f32>(tp0.x, tp12.y), 0.0) * (w0.x * w12.y);
  r += textureSampleLevel(tex, samp, vec2<f32>(tp12.x, tp12.y), 0.0) * (w12.x * w12.y);
  r += textureSampleLevel(tex, samp, vec2<f32>(tp3.x, tp12.y), 0.0) * (w3.x * w12.y);

  r += textureSampleLevel(tex, samp, vec2<f32>(tp0.x, tp3.y), 0.0) * (w0.x * w3.y);
  r += textureSampleLevel(tex, samp, vec2<f32>(tp12.x, tp3.y), 0.0) * (w12.x * w3.y);
  r += textureSampleLevel(tex, samp, vec2<f32>(tp3.x, tp3.y), 0.0) * (w3.x * w3.y);
  return r;
}

struct TemporalOut {
  @location(0) material : vec4<f32>,
  @location(1) aux : vec4<f32>,
};

@fragment
fn fs_temporal(in : VSOut) -> TemporalOut {
  let dimsI = vec2<i32>(textureDimensions(curMaterial, 0));
  let dims = vec2<f32>(dimsI);
  let maxP = dimsI - vec2<i32>(1);
  let px = clamp(vec2<i32>(in.pos.xy), vec2<i32>(0), maxP);

  let cm = textureLoad(curMaterial, px, 0);
  let ca = textureLoad(curAux, px, 0);

  // Range of the 3x3 neighbourhood in this frame. History is clamped into it,
  // so a stale value -- a disocclusion, the surface morphing, a reprojection
  // that was slightly off -- can never show something the current frame does
  // not have nearby. This is the history rejection that stops moving edges
  // smearing into trails.
  //
  // The material stores palette coordinates pre-multiplied by their weight
  // (x = coordinate * weight, y = weight). Clamping x and y separately would
  // keep each in range and still let their RATIO -- the coordinate, i.e. the
  // colour -- land outside anything nearby. So the coordinate gets a range of
  // its own.
  var mMin = cm;
  var mMax = cm;
  var aMin = ca;
  var aMax = ca;
  var baseLo = 1e9;
  var baseHi = -1e9;
  var seamLo = 1e9;
  var seamHi = -1e9;
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      let q = clamp(px + vec2<i32>(i, j), vec2<i32>(0), maxP);
      let m = textureLoad(curMaterial, q, 0);
      let a = textureLoad(curAux, q, 0);
      mMin = min(mMin, m);
      mMax = max(mMax, m);
      aMin = min(aMin, a);
      aMax = max(aMax, a);
      if (m.y > 1e-6) {
        let c = m.x / m.y;
        baseLo = min(baseLo, c);
        baseHi = max(baseHi, c);
      }
      if (a.z > 1e-6) {
        let c = a.y / a.z;
        seamLo = min(seamLo, c);
        seamHi = max(seamHi, c);
      }
    }
  }

  // Nearest distance in a small cross. A silhouette pixel then follows the
  // foreground's motion rather than the background's, which keeps moving
  // edges antialiased instead of dissolving them.
  var t = textureLoad(curDepth, px, 0).x;
  t = min(t, textureLoad(curDepth, clamp(px + vec2<i32>( 1, 0), vec2<i32>(0), maxP), 0).x);
  t = min(t, textureLoad(curDepth, clamp(px + vec2<i32>(-1, 0), vec2<i32>(0), maxP), 0).x);
  t = min(t, textureLoad(curDepth, clamp(px + vec2<i32>(0,  1), vec2<i32>(0), maxP), 0).x);
  t = min(t, textureLoad(curDepth, clamp(px + vec2<i32>(0, -1), vec2<i32>(0), maxP), 0).x);

  // Where was this point on screen last frame?
  let P = u.camPos + rayDir(in.uv) * t;
  let prev = previousUV(P);

  var w = u.historyWeight;
  if (prev.z <= 0.0 || prev.x < 0.0 || prev.x > 1.0 || prev.y < 0.0 || prev.y > 1.0) {
    w = 0.0;   // it was off screen: there is nothing to reuse
  }

  var hm = clamp(sampleCatmullRom(histMaterial, prev.xy, dims), mMin, mMax);
  var ha = clamp(sampleCatmullRom(histAux, prev.xy, dims), aMin, aMax);

  // The line attractors use these channels differently (aux.xyz is a circular
  // mean), so the coordinate clamp applies to everything else.
  let lines = u.fractalType > 24.5 && u.fractalType < 27.5;
  if (!lines) {
    if (hm.y > 1e-6 && baseHi >= baseLo) {
      hm.x = clamp(hm.x / hm.y, baseLo, baseHi) * hm.y;
    }
    if (ha.z > 1e-6 && seamHi >= seamLo) {
      ha.y = clamp(ha.y / ha.z, seamLo, seamHi) * ha.z;
    }
  }

  var out : TemporalOut;
  out.material = mix(cm, hm, w);
  out.aux = mix(ca, ha, w);
  return out;
}
`;
