// fractal-bg.js — self-contained WebGPU raymarched fractal background.
//
//   const handle = await initFractalBackground(canvas, options);
//
// Public handle API:
//   handle.setFractal('mandelbulb' | 'mandelbox' | 'menger' | 'julia')
//   handle.setPalette('aurora' | 'ember' | 'oil-slick' | 'mono-ice')
//   handle.setQuality('low' | 'medium' | 'high' | 'auto')
//   handle.setExplorer(bool)   orbit a model
//   handle.setFly(bool)        free flight, able to travel inside a model
//   handle.pause() / handle.resume() / handle.destroy()
//
// No build step, no dependencies. Runs from file://. See README.md.

import { FRACTAL_WGSL } from './shaders/fractal.wgsl.js';
import { MATERIAL_WGSL } from './shaders/material.wgsl.js';
import { COMPOSITE_WGSL } from './shaders/composite.wgsl.js';
import { ATTRACTOR_WGSL } from './shaders/attractor.wgsl.js';
import {
  LADDER, TOP, PRESET_RUNG, BUDGET_MS,
  govInit, govSample, govResync, rung, clampIndex, showcaseIndex, planMode, maxRungForLimit,
} from './quality.js';
import { getPalette } from './palettes.js';
import { packParams, clampParams, defaultsFor, paramsFor } from './shape-params.js';
import { clampStops, averageColor, MAX_STOPS } from './palette-io.js';
import {
  makeFlyCamera, stepFlyCamera, aimFlyCamera, dollyFlyCamera, scaleFlySpeed,
  usableClearance, orbitDragScale, pinchZoomFactor, pinchDollyDistance,
  orbitBasis, orbitPoseFromView, orbitRatesFromSamples, flickVelocity, FLICK_WINDOW_MS,
  driftFloor, decayMomentum, DRIFT_RATE, FLY_SPEED_MIN, FLY_SPEED_MAX,
  planDeviceLoss, MAX_REINITS,
} from './camera.js';

// Reduced-motion suppresses autonomous colour cycling, but a user moving
// the colour-speed slider is an explicit request for that animation. Keep
// this policy pure so the desktop/reduced-motion behaviour is testable.
export function colorCycleMotionAllowed(reducedMotion, explicit) {
  return !reducedMotion || !!explicit;
}

export function colorCycleNeedsLoop(reducedMotion, controls, explicit, rate) {
  return !reducedMotion || !!controls || (!!explicit && Number(rate) > 0);
}

// ---- Uniform buffer layout (mirror of the WGSL Uniforms struct) -----------
// 56 f32 slots = 224 bytes. Byte offset = slot * 4.
const U = {
  resolution: 0, // vec2 -> slots 0,1
  time: 2,
  dpr: 3,
  camPos: 4, // vec3 -> 4,5,6
  fov: 7,
  camTarget: 8, // vec3 -> 8,9,10
  fractalType: 11,
  power: 12,
  mbScale: 13,
  mbMinRadius: 14,
  mbFixedRadius: 15,
  paletteA: 16, // vec4 -> 16..19
  paletteB: 20,
  paletteC: 24,
  paletteD: 28,
  glowStrength: 32,
  fogDensity: 33,
  shadowSoftness: 34,
  aoStrength: 35,
  qualityScale: 36,
  bgMode: 37,
  reducedMotion: 38,
  flyMode: 39,
  viewProj: 40, // mat4 -> slots 40..55 (byte 160, 16-byte aligned)
  jitter: 56,   // vec2 -> 56,57 (byte 224)
  accumWeight: 58,
  _pad2: 59,
  paletteMode: 60,  // 0 = cosine preset, 1 = imported stop ramp
  rampCount: 61,
  colorCycle: 62,   // palette cycles per second; 0 = static
  colorPhase: 63,   // live palette-coordinate offset, in turns
  ramp: 64,         // 8 * vec4 -> slots 64..95 (byte 256)
  // Post-chain image adjustments, applied in the composite pass only, so
  // changing them never re-marches the scene or resets accumulation.
  // (exposure, contrast, saturation, hue turns). Byte 384, 16-byte aligned.
  imageAdjust: 96,
  detail: 100,
  // Per-shape mathematical parameters: two vec4, eight floats, holding only the
  // ACTIVE shape's values. Dedicated storage rather than smuggled inside
  // imageAdjust, which is what the previous attempt did -- that forced the
  // composite pass to decode its own controls back out of packed integers
  // before it could use them, and coupled two features with nothing to do with
  // one another. Appended after detail so the material, composite and attractor
  // shaders, whose structs end there, stay valid against this buffer.
  //
  // power / mbScale / mbMinRadius / mbFixedRadius above are RETIRED by this and
  // now written as zero. They are left declared because the struct is repeated
  // in four shader files and removing a field shifts every offset after it; only
  // fractal.wgsl ever read them, and it reads shapeParams now.
  shapeParams: 104,   // 2 * vec4 -> slots 104..111 (byte 416, 16-byte aligned)
};
const UNIFORM_FLOATS = 112;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4; // 416

// Distance-estimated fractals occupy ids 0..23; the volumetric/line-rendered
// attractors follow at 24+ and must stay contiguous at the end. The shader keys off that split (see the
// `fractalType > 23.5` test in fractal.wgsl.js), so keep DE types contiguous at
// the front when adding new ones and move the attractors up to match.
//
// The two Schottky entries share a single estimator and differ only in regime:
// `schottky` is the kissing configuration, where all five spheres are tangent
// and every generator is parabolic, and `schottkyh` separates them so every
// generator becomes hyperbolic. deSchottky keys off the id to pick the regime,
// so these two must stay adjacent and in this order.
const FRACTAL_IDS = {
  mandelbulb: 0, mandelbox: 1, menger: 2, julia: 3, apollonian: 4,
  // penrose (8) is RETIRED: it is an honest P3 tiling, but engraved on a disc,
  // which is the 2D-pattern-on-a-primitive case the roadmap warns against. The
  // id and its estimator are kept so nothing renumbers and the work is not
  // lost; it is simply no longer offered in the selector. Still reachable via
  // setFractal('penrose').
  spherepack: 5, encrusted: 6, surfacepack: 7, penrose: 8, gyroid: 9,
  kleinian: 10, barth: 11, schottky: 12, schottkyh: 13, tetrabrot: 14,
  envoct: 15, envdodec: 16, hyp534: 17, hyp435: 18,
  // Wythoffian forms of the same two groups: the active-mirror string picks
  // which member of the family the seed generates. deHoneycomb groups these by
  // id ({5,3,4} holds 17/19/20, {4,3,5} holds 18/21/22), so they must stay put.
  hyp534t: 19, hyp534o: 20, hyp435t: 21, hyp435o: 22,
  // The packing shares the honeycombs' machinery but not their group: [5,3,6]
  // is cusped, which is what gives it horoballs to make a packing out of.
  kleinpack: 23,
  // Engel's plesiohedron: a space-filling tiling, not a fractal, and the only
  // estimator here that is an exact signed distance.
  engel: 24,
  attractor: 25, lorenz: 26, rossler: 27,
  // Volumetric density field. Kept after the line attractors so their
  // established ids remain stable.
  cosmicweb: 28,
  // A distance-estimated surface, but appended after the non-surface ids rather
  // than inserted among the surfaces, so that nothing already shipped
  // renumbers. Surface-ness is therefore a predicate, not an id threshold.
  ziggurat: 29,
  // The ziggurat's volumetric relative: cubes filling a 3D lattice rather than
  // a heightfield over a plane.
  cubestack: 30,
  // Six plane waves on the icosahedron's 5-fold axes. Aperiodic because those
  // axes meet at arccos(1/sqrt5) and sqrt5 = 2*phi - 1 is irrational.
  quasicrystal: 31,
};

// The registry is keyed by name while the renderer works in ids, so the two
// need one bridge. Built once from FRACTAL_IDS rather than restated, so it
// cannot drift from it.
const FRACTAL_NAMES = Object.fromEntries(
  Object.entries(FRACTAL_IDS).map(([name, id]) => [id, name]));

function shapeName(id) {
  return FRACTAL_NAMES[id] ?? 'mandelbulb';
}

function isAttractorType(id) {
  return id >= FRACTAL_IDS.attractor && id <= FRACTAL_IDS.rossler;
}

// A distance-estimated surface: anything that is neither line geometry nor a
// volumetric field. Stated as an exclusion rather than "id <= <last surface>"
// because surfaces are no longer one contiguous block, and because naming the
// last surface means every new surface has to remember to update this.
function isSurfaceType(id) {
  return !isAttractorType(id) && id !== FRACTAL_IDS.cosmicweb;
}

// Quality tiers -> internal-resolution scale factor.
// The named presets pin a rung of the ladder in quality.js, so a fixed mode and
// an adaptive one describe quality in the same units.
const QUALITY_SCALE = Object.fromEntries(
  Object.entries(PRESET_RUNG).map(([k, i]) => [k, LADDER[i].scale]));

// Camera orbit distance per fractal — each estimator lives at a different
// world scale, so a single radius would sit inside the larger ones.
// Indexed by fractal id (see FRACTAL_IDS).
// mandelbulb, mandelbox, menger, julia, apollonian, spherepack, encrusted,
// surfacepack, penrose, gyroid, kleinian, barth, schottky, schottkyh,
// tetrabrot, envoct, envdodec, hyp534, hyp435, hyp534t, hyp534o, hyp435t,
// hyp435o, kleinpack, engel, attractor(Aizawa), lorenz, rossler, cosmicweb
// The Penrose disc is wide and flat, so it needs a little more room than the
// roughly ball-shaped estimators to sit inside the frame edge-on. The Barth
// sextic clips at radius 2.0, the largest here, and its 4.6 keeps the same
// fraction of the frame the others use at this field of view.
// The Schottky orbit is compact -- measured extent is radius 0.6 at tangency,
// 0.76 separated -- so it needs a much closer orbit than anything else here.
// The Tetrabrot's measured bounding radius is 1.483, so 3.4 frames it to the
// same fraction of the view the other models use at this field of view.
// The envelope solids' spikes reach their apexes: measured 1.2247 for the
// octahedral seed and 2.4899 for the dodecahedral one.
// The honeycombs are clipped to radius 0.85 inside the Poincare ball, so they
// need the closest orbit of anything here. The sphere packing is clipped at
// 0.95 instead, because its spheres are tangent to the boundary and a tighter
// clip would slice a cap off every one of them.
// The quasicrystal is clipped at 1.25, between the honeycombs' 0.85 and the
// Barth sextic's 2.0, and 3.1 frames it to the same fraction of the view.
const CAM_RADIUS = [2.55, 6.5, 3.6, 3.0, 3.0, 2.9, 3.1, 3.0, 3.5, 3.2, 3.6, 4.6,
                    1.55, 1.75, 3.4, 2.85, 5.75, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0,
                    2.3, 3.0, 3.2, 3.0, 3.0, 6.2, 2.6, 2.6, 3.1];

// Number of integrated trajectory samples drawn as a line strip per attractor.
// These are exact float positions (vector geometry), so the curve stays crisp
// at any zoom — unlike a baked voxel grid, which quantizes it.
const TRAJECTORY_POINTS = 600000;

// Progressive accumulation. While the view is still, frames are re-rendered
// with a subpixel offset and averaged, which resolves the aliasing the
// high-frequency models suffer from and gives the quality of a much higher
// sample count for free. Capped because the average converges: past this the
// raymarch is skipped entirely and the converged image is simply re-presented,
// which also drops idle GPU load to almost nothing.
const ACCUM_CAP = 96;

// The clearance probe is one thread marching the estimator, so it serialises
// against the whole GPU. 20Hz is ample for what consumes it.
const PROBE_INTERVAL_MS = 50;
const ACCUM_IDLE_MS = 400;   // stillness required before sampling starts

// R2 (Roberts) low-discrepancy sequence — a 2D golden-ratio analogue. Its
// samples interleave far more evenly than random jitter, so the average
// converges in fewer frames and without clumping.
const R2_A1 = 1 / 1.32471795724474602596;        // 1/plastic number
const R2_A2 = 1 / (1.32471795724474602596 ** 2);
function r2jitter(i) {
  return [
    ((0.5 + R2_A1 * (i + 1)) % 1) - 0.5,
    ((0.5 + R2_A2 * (i + 1)) % 1) - 0.5,
  ];
}

// ---- Small column-major mat4 helpers (WebGPU depth range [0,1]) ----
function mat4Perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = far / (near - far); out[11] = -1;
  out[12] = 0; out[13] = 0; out[14] = (far * near) / (near - far); out[15] = 0;
}

function mat4LookAt(out, eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl; zy /= zl; zz /= zl;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
}

function mat4Mul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
}

const HDR_FORMAT = 'rgba16float';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} [options]
 * @param {string}  [options.fractal='mandelbulb']
 * @param {string}  [options.palette='aurora']
 * @param {string}  [options.quality='auto']  'low'|'medium'|'high'|'auto'
 * @param {boolean} [options.transparent=true]
 * @param {(reason:string)=>void} [options.onUnsupported]
 * @returns {Promise<object|null>} handle, or null if unsupported
 */
export async function initFractalBackground(canvas, options = {}) {
  const opts = {
    fractal: 'mandelbulb',
    palette: 'aurora',
    quality: 'auto',
    transparent: true,
    onUnsupported: () => {},
    ...options,
  };

  // ---- Feature detection ----
  if (!('gpu' in navigator) || !navigator.gpu) {
    opts.onUnsupported('navigator.gpu is unavailable (WebGPU not supported)');
    return null;
  }

  // ---- State shared across (re)inits ----
  const state = {
    adapter: null,
    device: null,
    context: null,
    format: null,
    sampler: null,
    uniformBuffer: null,
    uniformData: new Float32Array(UNIFORM_FLOATS),
    uniformU32: null, // aliased view (unused for now; all fields are f32)
    pipelines: {},
    targets: null, // { sceneTex, auxTex, bloomA, bloomB, w, h }
    bindGroups: {},
    // config
    fractalType: FRACTAL_IDS[opts.fractal] ?? 0,
    // Mathematical parameters of the ACTIVE shape only, kept as named values
    // plus the packed eight floats the uniform block wants. Values are not
    // carried across a shape change: `power` means something to the Mandelbulb
    // and nothing to the Menger sponge, so each shape starts at its own
    // measured defaults.
    shapeParamValues: defaultsFor(opts.fractal ?? 'mandelbulb'),
    shapeParamsPacked: packParams(opts.fractal ?? 'mandelbulb',
                                  defaultsFor(opts.fractal ?? 'mandelbulb')),
    palette: getPalette(opts.palette),
    // An imported palette, kept as its own stops rather than fitted to cosine
    // coefficients. Null means the cosine preset above is in use.
    paletteRamp: null,
    transparent: !!opts.transparent,
    qualityMode: opts.quality, // 'low'|'medium'|'high'|'auto'
    qualityScale: 1.0,
    // runtime
    running: false,
    disposed: false,
    rafId: 0,
    startTime: 0,
    lastFrameTime: 0,
    animTime: 0, // accumulated animation clock (respects reduced motion)
    dpr: 1,
    cssW: 1,
    cssH: 1,
    // adaptive quality: the governor's own state lives in quality.js and is
    // pure, so it can be unit-tested without a GPU.
    gov: null,
    detailRung: PRESET_RUNG.medium,
    // Highest rung this display can actually allocate; set by resize().
    rungCap: TOP,
    showcaseRung: -1,
    // Edge antialiasing for moving frames; see the composite pass.
    fxaaOn: true,
    fpsEMA: 60,
    slowFrames: 0,
    fastFrames: 0,
    // input parallax
    parallax: { x: 0, y: 0, tx: 0, ty: 0 },
    // navigation
    autoOrbit: true,      // time-driven camera drift (background feel)
    controls: false,      // drag/pinch/wheel interaction enabled
    explorer: false,      // model-explorer preset (opaque, no auto-drift)
    // The orbit camera keeps an explicit target and distance rather than a
    // multiplier on a fixed radius about the origin. Zooming re-pins the target
    // onto the surface ahead, so the eye dollies towards what is being looked
    // at instead of towards the model's centroid -- which is what used to drive
    // it through the surface and into the interior at deep zoom.
    orbit: {
      yaw: 0.6, pitch: 0.35, tyaw: 0.6, tpitch: 0.35,
      // Angular velocity in rad/s, and the direction the last movement left
      // behind. Velocity decays towards that direction at DRIFT_RATE rather
      // than towards zero, so a view that has been moved keeps drifting; a
      // zero direction (never dragged, or reset) means it settles to a stop.
      vyaw: 0, vpitch: 0, dyaw: 0, dpitch: 0,
      // Timestamp of the most recent non-zero drag sample. Pointer release uses
      // this to distinguish a true flick from a drag that paused before lifting.
      flickAt: 0,
      flickSamples: [],
      target: [0, 0, 0],
      dist: 2.55,
      pinned: false,     // has the target been placed on a surface?
    },
    // Fly-through: a free position with a look direction decoupled from the
    // origin. The orbit camera cannot enter a model; this one can.
    fly: false,
    flyCam: makeFlyCamera([0, 0, 3.2]),
    keys: new Set(),
    frameDt: 16,
    lastCamPos: [0, 0, 3.2],
    lastCamTarget: [0, 0, 0],
    // The landing/background camera follows a time-driven path. Keep its most
    // recent orbit-equivalent sample and angular rate so entering Shape Explorer
    // can continue the exact pose and motion already on screen instead of
    // jumping to the canned reset pose.
    backgroundOrbitSample: null,
    backgroundOrbitRate: [0, 0],
    // Clearance at the camera, read back from the GPU one frame late. Only the
    // GPU can evaluate the distance estimators, and fly speed scales by this so
    // travel feels the same close up as in open space.
    probeBuffer: null,
    probeStaging: null,
    probeBusy: false,
    probeDist: Infinity,
    probeHit: -1,        // centre-ray surface distance, -1 = miss
    probeAt: 0,          // last probe dispatch, for throttling
    // Progressive accumulation
    accumSamples: 0,
    // Palette cycles per second. Phase advances independently of the geometry
    // clock so it keeps moving after progressive accumulation has converged.
    colorCycle: opts.colorCycle ?? 0.025,
    // False until the user explicitly moves the colour-speed control.
    // This lets prefers-reduced-motion suppress the boot-time animation
    // without disabling a later deliberate request from the user.
    colorCycleExplicit: false,
    colorPhase: 0,
    // Neutral by default, so the shipped image is unchanged.
    image: { exposure: 1, contrast: 1, saturation: 1, hue: 0 },
    accumOn: true,
    // active pointers for drag / pinch tracking
    pointers: new Map(),
    pinchDist0: 0,       // finger separation at the previous move event
    lastInteract: 0,
    // tap vs. drag/pinch discrimination (for double-tap-to-freeze)
    gestureMoved: false,
    gestureMulti: false,
    tapStart: null,
    tapTime: 0,
  };
  state.uniformU32 = new Uint32Array(state.uniformData.buffer);

  // Scratch matrices, reused each frame (no per-frame allocation).
  const _proj = new Float32Array(16);
  const _view = new Float32Array(16);
  const _viewProj = new Float32Array(16);

  const reducedMotionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

  function reducedMotion() {
    return reducedMotionMQ.matches;
  }

  // ---- Device acquisition ----
  async function acquireDevice() {
    let adapter;
    try {
      // A background effect should be frugal; an explorer being asked to show
      // what the machine can do should not be. Default stays low-power so the
      // library's original use is unchanged, and the demo opts in.
      const pref = opts.power === 'high' ? 'high-performance' : 'low-power';
      adapter = await navigator.gpu.requestAdapter({ powerPreference: pref });
    } catch (e) {
      adapter = null;
    }
    if (!adapter) {
      adapter = await navigator.gpu.requestAdapter().catch(() => null);
    }
    if (!adapter) {
      throw new Error('requestAdapter() returned null');
    }
    // Retain the adapter on state: if the GPUAdapter wrapper is garbage
    // collected, some implementations drop the underlying instance and lose
    // the device ("external Instance reference no longer exists").
    state.adapter = adapter;
    const device = await adapter.requestDevice();
    return device;
  }

  // ---- Pipeline / resource creation (once per device) ----
  function createStaticResources() {
    const device = state.device;

    state.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    state.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Keep the original module for the clearance compute entry point. The
    // material module contains the same estimators plus fs_material, which is
    // the palette-independent fragment entry point used for drawing.
    const fractalModule = device.createShaderModule({ code: FRACTAL_WGSL });
    const materialModule = device.createShaderModule({ code: MATERIAL_WGSL });
    const compositeModule = device.createShaderModule({ code: COMPOSITE_WGSL });

    const raymarchBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const probeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const blurBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const resolveBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const compositeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        // The composited LDR image, read only by the FXAA pass. One layout
        // serves both pipelines; the composite pass simply never samples it.
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    state._bgl = { raymarchBGL, probeBGL, blurBGL, resolveBGL, compositeBGL };

    // Progressive accumulation is done by fixed-function blending directly in
    // the material targets. For sample n, source contributes 1/(n+1) and the
    // existing average contributes n/(n+1). This is mathematically identical
    // to the old ping-pong fs_accum pass but works for both MRT attachments and
    // removes two full-resolution textures plus one fullscreen pass.
    const averageBlend = {
      color: { srcFactor: 'constant', dstFactor: 'one-minus-constant', operation: 'add' },
      alpha: { srcFactor: 'constant', dstFactor: 'one-minus-constant', operation: 'add' },
    };
    const weightedAddBlend = {
      color: { srcFactor: 'constant', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'constant', dstFactor: 'one', operation: 'add' },
    };

    const attractorModule = device.createShaderModule({ code: ATTRACTOR_WGSL });
    state.pipelines.attractor = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [raymarchBGL] }),
      vertex: {
        module: attractorModule,
        entryPoint: 'vs_line',
        buffers: [{
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32' },
          ],
        }],
      },
      fragment: {
        module: attractorModule,
        entryPoint: 'fs_line',
        targets: [
          { format: HDR_FORMAT, blend: weightedAddBlend },
          { format: HDR_FORMAT, blend: weightedAddBlend },
        ],
      },
      primitive: { topology: 'line-strip' },
    });

    state.pipelines.raymarch = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [raymarchBGL] }),
      vertex: { module: materialModule, entryPoint: 'vs_main' },
      fragment: {
        module: materialModule,
        entryPoint: 'fs_material',
        targets: [
          { format: HDR_FORMAT, blend: averageBlend },
          { format: HDR_FORMAT, blend: averageBlend },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });

    state.pipelines.probe = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [probeBGL] }),
      compute: { module: fractalModule, entryPoint: 'cs_probe' },
    });

    state.pipelines.bloomH = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [resolveBGL] }),
      vertex: { module: compositeModule, entryPoint: 'vs_main' },
      fragment: { module: compositeModule, entryPoint: 'fs_bloom_h', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

    state.pipelines.bloomV = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [blurBGL] }),
      vertex: { module: compositeModule, entryPoint: 'vs_main' },
      fragment: { module: compositeModule, entryPoint: 'fs_bloom_v', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

    state.pipelines.composite = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [compositeBGL] }),
      vertex: { module: compositeModule, entryPoint: 'vs_main' },
      fragment: { module: compositeModule, entryPoint: 'fs_composite', targets: [{ format: state.format }] },
      primitive: { topology: 'triangle-list' },
    });

    // Edge antialiasing for moving frames. Same layout and module as the
    // composite; it differs only in reading the composited image back.
    state.pipelines.fxaa = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [state._bgl.compositeBGL] }),
      vertex: { module: compositeModule, entryPoint: 'vs_main' },
      fragment: { module: compositeModule, entryPoint: 'fs_fxaa', targets: [{ format: state.format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  // ---- Offscreen render targets (recreated on resize / quality change) ----
  function createTargets(renderW, renderH, swapW, swapH) {
    const device = state.device;
    if (state.targets) {
      state.targets.sceneTex.destroy();
      state.targets.auxTex.destroy();
      state.targets.bloomA.destroy();
      state.targets.bloomB.destroy();
      state.targets.ldrTex.destroy();
    }
    const bw = Math.max(1, Math.floor(renderW / 2));
    const bh = Math.max(1, Math.floor(renderH / 2));

    const mk = (w, h) =>
      device.createTexture({
        size: { width: w, height: h },
        format: HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });

    // Two full-resolution material attachments replace RGB + two accumulation
    // ping-pong textures. They are averaged in place by blend constants.
    const sceneTex = mk(renderW, renderH);
    const auxTex = mk(renderW, renderH);
    const bloomA = mk(bw, bh);
    const bloomB = mk(bw, bh);

    // The composited image, at display resolution, so FXAA can read it back.
    // Swapchain format rather than HDR: this is the finished picture, already
    // tonemapped and dithered, which is exactly what FXAA should judge.
    const ldrTex = device.createTexture({
      size: { width: Math.max(1, swapW), height: Math.max(1, swapH) },
      format: state.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const ldrView = ldrTex.createView();

    const sceneView = sceneTex.createView();
    const auxView = auxTex.createView();
    const bloomAView = bloomA.createView();
    const bloomBView = bloomB.createView();

    state.targets = {
      sceneTex, auxTex, bloomA, bloomB, ldrTex,
      sceneView, auxView, bloomAView, bloomBView, ldrView,
      w: renderW, h: renderH,
    };
    state.accumSamples = 0;

    const ub = { buffer: state.uniformBuffer };
    state.bindGroups.raymarch = device.createBindGroup({
      layout: state._bgl.raymarchBGL,
      entries: [{ binding: 0, resource: ub }],
    });

    state.probeBuffer = device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    state.probeStaging = device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    state.probeBusy = false;
    state.bindGroups.probe = device.createBindGroup({
      layout: state._bgl.probeBGL,
      entries: [
        { binding: 0, resource: ub },
        { binding: 1, resource: { buffer: state.probeBuffer } },
      ],
    });

    state.bindGroups.bloomH = device.createBindGroup({
      layout: state._bgl.resolveBGL,
      entries: [
        { binding: 0, resource: ub },
        { binding: 1, resource: state.sampler },
        { binding: 2, resource: sceneView },
        { binding: 3, resource: auxView },
      ],
    });
    state.bindGroups.bloomV = device.createBindGroup({
      layout: state._bgl.blurBGL,
      entries: [
        { binding: 0, resource: ub },
        { binding: 1, resource: state.sampler },
        { binding: 2, resource: bloomAView },
      ],
    });
    state.bindGroups.composite = device.createBindGroup({
      layout: state._bgl.compositeBGL,
      entries: [
        { binding: 0, resource: ub },
        { binding: 1, resource: state.sampler },
        { binding: 2, resource: sceneView },
        { binding: 3, resource: auxView },
        { binding: 4, resource: bloomBView },
        { binding: 5, resource: ldrView },
      ],
    });
  }

  // ---- Strange attractors: integrate the trajectory into line geometry ----
  // Each attractor is defined by an ODE with no closed-form distance function,
  // so it can't be sphere-traced. We integrate it to exact float positions and
  // upload those as a vertex buffer drawn as a line strip — vector geometry,
  // so it stays crisp at any zoom (a baked voxel grid would quantize it).
  //
  // Per-attractor config: the derivative, integration step, and a fit transform
  // (center + scale) placing the attractor in roughly [-1,1]^3. Lorenz is large
  // and fast-moving, so it needs a much smaller dt than the compact Aizawa.
  const ATTRACTORS = {
    // dx/dt = (z-b)x - dy
    // dy/dt = dx + (z-b)y
    // dz/dt = c + az - z^3/3 - (x^2+y^2)(1+ez) + f z x^3
    aizawa: {
      init: [0.1, 0.0, 0.0],
      dt: 0.002, warm: 5000,
      center: [0, 0, 0.6], scale: 0.9 / 1.35,
      deriv: (x, y, z) => {
        const a = 0.95, b = 0.7, c = 0.6, d = 3.5, e = 0.25, f = 0.1;
        return [
          (z - b) * x - d * y,
          d * x + (z - b) * y,
          c + a * z - (z * z * z) / 3 - (x * x + y * y) * (1 + e * z) + f * z * x * x * x,
        ];
      },
    },
    // dx/dt = -y - z, dy/dt = x + ay, dz/dt = b + z(x - c)
    //
    // The simplest of the three: one quadratic term, where Lorenz has two. It
    // spends most of its time in a nearly flat spiral and then folds sharply up
    // out of the plane, which is what makes it the textbook picture of period
    // doubling. Fitted from a measured run: the box is x[-9.11, 11.43],
    // y[-10.79, 7.84], z[0.01, 22.85], so the centre is off-axis, unlike the two
    // symmetric attractors above. dt gives 0.034 of arc per step, between the
    // other two, and the spiral sits at the bottom of the box with the fold
    // reaching the top.
    rossler: {
      init: [0.1, 0.0, 0.0],
      dt: 0.004, warm: 4000,
      center: [1.2, -1.5, 11.4], scale: 0.9 / 11.5,
      deriv: (x, y, z) => {
        const a = 0.2, b = 0.2, c = 5.7;
        return [-y - z, x + a * y, b + z * (x - c)];
      },
    },
    // dx/dt = sigma(y-x), dy/dt = x(rho-z)-y, dz/dt = xy - beta*z
    lorenz: {
      init: [0.1, 0.0, 0.0],
      dt: 0.0005, warm: 3000,
      center: [0, 0, 25], scale: 0.9 / 28,
      deriv: (x, y, z) => {
        const sigma = 10, rho = 28, beta = 8 / 3;
        return [sigma * (y - x), x * (rho - z) - y, x * y - beta * z];
      },
    },
  };

  // Integrate with RK4 so the path stays accurate at larger steps (fewer,
  // better-placed points beat many sloppy Euler ones). Writes interleaved
  // [x, y, z, age] vertices.
  function buildAttractorTrajectory(variant) {
    const cfg = ATTRACTORS[variant] || ATTRACTORS.aizawa;
    const N = TRAJECTORY_POINTS;
    const verts = new Float32Array(N * 4);

    let x = cfg.init[0], y = cfg.init[1], z = cfg.init[2];
    const dt = cfg.dt, h = dt * 0.5;
    const cx = cfg.center[0], cy = cfg.center[1], cz = cfg.center[2];
    const s = cfg.scale;

    const step = () => {
      const k1 = cfg.deriv(x, y, z);
      const k2 = cfg.deriv(x + k1[0] * h, y + k1[1] * h, z + k1[2] * h);
      const k3 = cfg.deriv(x + k2[0] * h, y + k2[1] * h, z + k2[2] * h);
      const k4 = cfg.deriv(x + k3[0] * dt, y + k3[1] * dt, z + k3[2] * dt);
      x += (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      y += (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      z += (dt / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
    };

    // Discard the transient so we only draw the attractor itself.
    for (let i = 0; i < cfg.warm; i++) step();

    // Store |velocity| per point. Speed is a smooth function of position on the
    // attractor, so it gives spatially coherent color — neighbouring strands
    // share a hue and additive overlap deepens it instead of averaging to white.
    let sMin = Infinity, sMax = 0;
    for (let i = 0; i < N; i++) {
      step();
      verts[i * 4] = (x - cx) * s;
      verts[i * 4 + 1] = (y - cy) * s;
      verts[i * 4 + 2] = (z - cz) * s;
      const v = cfg.deriv(x, y, z);
      const sp = Math.hypot(v[0], v[1], v[2]);
      verts[i * 4 + 3] = sp;
      if (sp < sMin) sMin = sp;
      if (sp > sMax) sMax = sp;
    }

    // Normalize speed to 0..1. The sqrt spreads the low end, where most of the
    // trajectory sits, across more of the palette.
    const range = sMax - sMin || 1;
    for (let i = 0; i < N; i++) {
      verts[i * 4 + 3] = Math.sqrt((verts[i * 4 + 3] - sMin) / range);
    }

    if (state.trajBuffer) state.trajBuffer.destroy();
    state.trajBuffer = state.device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    state.device.queue.writeBuffer(state.trajBuffer, 0, verts);
    state.trajCount = N;
    state.trajVariant = variant;
  }

  // Which attractor a given fractal id maps to.
  function attractorVariantForType(ft) {
    if (ft === FRACTAL_IDS.lorenz) return 'lorenz';
    if (ft === FRACTAL_IDS.rossler) return 'rossler';
    return 'aizawa';
  }

  // (Re)build the trajectory if missing or holding a different attractor.
  function ensureAttractorTrajectory() {
    if (!state.device) return;
    const v = attractorVariantForType(state.fractalType);
    if (!state.trajBuffer || state.trajVariant !== v) buildAttractorTrajectory(v);
  }

  // ---- Resize handling ----
  function resize() {
    const dprCap = 2;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || window.innerWidth);
    const cssH = Math.max(1, rect.height || window.innerHeight);

    state.dpr = dpr;
    state.cssW = cssW;
    state.cssH = cssH;

    // Every texture here is bounded by the adapter's 2D limit, which WebGPU only
    // guarantees to be 8192. That was unreachable while the internal scale was
    // capped at 1.0; supersampling makes it reachable, so both the swapchain and
    // the internal targets are fitted to it. The fit is a single factor applied
    // to BOTH axes, because scaling them independently would stretch the image.
    const texLimit = state.device?.limits?.maxTextureDimension2D ?? 8192;
    let pxW = Math.max(1, Math.round(cssW * dpr));
    let pxH = Math.max(1, Math.round(cssH * dpr));
    const swapFit = Math.min(1, texLimit / pxW, texLimit / pxH);
    if (swapFit < 1) {
      pxW = Math.max(1, Math.floor(pxW * swapFit));
      pxH = Math.max(1, Math.floor(pxH * swapFit));
    }
    // Cap the ladder to what can actually be allocated, so the governor cannot
    // climb into a rung that would be quietly clamped -- which costs no more
    // than the rung below and therefore reads as free headroom.
    state.rungCap = maxRungForLimit(pxW, pxH, texLimit);
    if (state.detailRung > state.rungCap) {
      state.detailRung = state.rungCap;
      state.qualityScale = LADDER[state.rungCap].scale;
    }
    if (state.gov) {
      state.gov.ceiling = Math.min(state.gov.ceiling, state.rungCap);
      state.gov.index = Math.min(state.gov.index, state.rungCap);
    }
    // Only touch the backing store when it actually changes. Assigning
    // canvas.width resets the WebGPU swapchain and clears the canvas even when
    // the value is unchanged, which shows as a black frame -- and a quality
    // change calls resize() without altering the CSS size at all.
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;

    let renderW = Math.max(1, Math.round(pxW * state.qualityScale));
    let renderH = Math.max(1, Math.round(pxH * state.qualityScale));
    // Belt and braces: the rung cap should already have prevented this, but a
    // failed allocation here takes the whole renderer down, so clamp anyway.
    const renderFit = Math.min(1, texLimit / renderW, texLimit / renderH);
    if (renderFit < 1) {
      renderW = Math.max(1, Math.floor(renderW * renderFit));
      renderH = Math.max(1, Math.floor(renderH * renderFit));
    }

    createTargets(renderW, renderH, pxW, pxH);

    if (!state.running || reducedMotion()) {
      renderFrame(performance.now(), true);
    }
  }

  // ---- Camera + animated parameters ----
  function updateUniforms(nowMs) {
    const d = state.uniformData;
    const t = state.animTime;
    const rm = reducedMotion();

    // Base distance scales with the fractal's world size; zoom (pinch/wheel)
    // multiplies it. Always looking near origin.
    const baseR = CAM_RADIUS[state.fractalType] ?? 2.55;
    // Background drift keeps the old framing; the interactive modes carry their
    // own distance state.
    const radius = baseR;

    let camX, camY, camZ;
    let camUpX = 0, camUpY = 1, camUpZ = 0;
    let tgtX = 0, tgtY = rm ? 0.0 : Math.sin(t * 0.05) * 0.05, tgtZ = 0;

    if (state.fly) {
      // Free flight: position is state and the look direction is independent of
      // the origin, so the camera can travel into a structure instead of
      // circling it. The maths lives in camera.js so it can be tested
      // without a GPU (see tools/camera.test.js).
      const cam = state.flyCam;
      // Travel covers a fixed fraction of the clearance the GPU last reported,
      // so a metre from a wall and a hundred metres out feel the same.
      const gap = usableClearance(state.probeDist, baseR);
      const fwd = stepFlyCamera(cam, state.keys, state.frameDt / 1000, baseR, gap);
      camX = cam.pos[0]; camY = cam.pos[1]; camZ = cam.pos[2];
      tgtX = camX + fwd[0]; tgtY = camY + fwd[1]; tgtZ = camZ + fwd[2];
    } else if (state.explorer) {
      // Model-explorer: spherical orbit driven by drag, eased, and carrying
      // momentum that settles into a drift rather than dying.
      const o = state.orbit;
      // Momentum. Velocity decays towards the drift floor rather than towards
      // zero, so a throw slows to a subtle turn and stays there instead of
      // dying: the view never fully settles once it has been moved. Only
      // freezeView -- double-tap, double-click -- clears the direction and
      // lets it come to a genuine stop, without moving the view.
      //
      // It is integrated into the TARGET angles, not the eased ones. Adding it
      // to the eased angle instead would put it in tension with the easing
      // spring, which pulls back towards the target: the two balance at a fixed
      // offset and the drift silently stalls.
      // While a pointer is down, direct manipulation owns the target angles.
      // Momentum begins only after release, so the object does not run away under
      // the user's finger or mouse while a throw velocity is being sampled.
      if (state.pointers.size === 0) {
        const dt = Math.min(state.frameDt / 1000, 0.1);
        // Reduced-motion suppresses automatic animation, but a flick is direct,
        // intentional input. Once the user throws the shape, honour that motion
        // on the same terms as a drag instead of silently zeroing it.
        const scale = orbitDragScale(o.dist / baseR, o.pinned);
        const [fy, fp] = driftFloor(o.dyaw, o.dpitch, DRIFT_RATE * scale);
        o.vyaw = decayMomentum(o.vyaw, fy, dt);
        o.vpitch = decayMomentum(o.vpitch, fp, dt);
        o.tyaw += o.vyaw * dt;
        o.tpitch += o.vpitch * dt;
      }
      o.yaw += (o.tyaw - o.yaw) * 0.18;
      o.pitch += (o.tpitch - o.pitch) * 0.18;

      // Pitch is deliberately unbounded. The pole-safe basis keeps camera roll
      // continuous at +/-PI/2, so a vertical throw can make complete revolutions
      // just as yaw already can horizontally.
      const frame = orbitBasis(o.yaw, o.pitch);
      const dir = frame.dir;
      camUpX = frame.up[0]; camUpY = frame.up[1]; camUpZ = frame.up[2];
      camX = o.target[0] + dir[0] * o.dist;
      camY = o.target[1] + dir[1] * o.dist;
      camZ = o.target[2] + dir[2] * o.dist;
      tgtX = o.target[0]; tgtY = o.target[1]; tgtZ = o.target[2];
    } else {
      // Background: hypnotic Lissajous drift.
      const ax = rm ? 0.9 : t * 0.09;
      const ay = rm ? 0.55 : t * 0.063;
      const px = rm ? 0 : state.parallax.x * radius * 0.2;
      const py = rm ? 0 : state.parallax.y * radius * 0.16;
      camX = Math.cos(ax) * radius + px;
      camY = Math.sin(ay) * (radius * 0.35) + radius * 0.06 + py;
      camZ = Math.sin(ax) * radius;
    }

    // Preserve the camera path as an orbit-equivalent pose while on the landing
    // view. This samples the ACTUAL rendered eye/target pair, so mouse parallax
    // and the tiny moving target are included rather than approximated.
    if (!state.fly && !state.explorer) {
      const pose = orbitPoseFromView([camX, camY, camZ], [tgtX, tgtY, tgtZ]);
      if (pose) {
        const sample = { yaw: pose.yaw, pitch: pose.pitch, t: nowMs };
        if (state.backgroundOrbitSample) {
          const [vyaw, vpitch] = orbitRatesFromSamples(state.backgroundOrbitSample, sample);
          state.backgroundOrbitRate[0] = vyaw;
          state.backgroundOrbitRate[1] = vpitch;
        }
        state.backgroundOrbitSample = sample;
      }
    }


    // resolution / time / dpr
    d[U.resolution] = state.targets ? state.targets.w : canvas.width;
    d[U.resolution + 1] = state.targets ? state.targets.h : canvas.height;
    d[U.time] = rm ? 1.7 : t;
    d[U.dpr] = state.dpr;

    d[U.camPos] = camX;
    d[U.camPos + 1] = camY;
    d[U.camPos + 2] = camZ;
    state.lastCamPos[0] = camX;
    state.lastCamPos[1] = camY;
    state.lastCamPos[2] = camZ;
    state.lastCamTarget[0] = tgtX;
    state.lastCamTarget[1] = tgtY;
    state.lastCamTarget[2] = tgtZ;
    d[U.fov] = 1.05; // radians

    d[U.camTarget] = tgtX;
    d[U.camTarget + 1] = tgtY;
    d[U.camTarget + 2] = tgtZ;

    d[U.fractalType] = state.fractalType;
    // Retired -- see the layout note. Written explicitly rather than left alone
    // so a stale value cannot outlive the estimator that used to read it.
    d[U.power] = 0;
    d[U.mbScale] = 0;
    d[U.mbMinRadius] = 0;
    d[U.mbFixedRadius] = 0;
    for (let i = 0; i < 8; i++) d[U.shapeParams + i] = state.shapeParamsPacked[i];

    // The rate remains public API state; the composite shader consumes the
    // integrated phase. Separating this clock from animTime is what lets colour
    // keep moving while geometry is frozen for progressive accumulation.
    d[U.colorCycle] = state.colorCycle;
    d[U.colorPhase] = colorCycleMotionAllowed(rm, state.colorCycleExplicit)
      ? state.colorPhase : 0.0;
    const im = state.image;
    const rg = LADDER[clampIndex(state.detailRung)];
    d[U.detail] = rg.steps;
    d[U.detail + 1] = rg.iters;
    d[U.detail + 2] = rg.shade;
    // Spare slot: Shape Explorer yaw, wrapped to [-PI,PI]. The shader uses it to
    // build a pole-safe screen basis. 10 is a sentinel for the ordinary
    // world-up camera path used outside the orbit viewer.
    d[U.detail + 3] = (state.explorer && !state.fly)
      ? Math.atan2(Math.sin(state.orbit.yaw), Math.cos(state.orbit.yaw))
      : 10;

    d[U.imageAdjust] = im.exposure;
    d[U.imageAdjust + 1] = im.contrast;
    d[U.imageAdjust + 2] = im.saturation;
    d[U.imageAdjust + 3] = im.hue;

    const p = state.palette;
    const ramp = state.paletteRamp;
    d[U.paletteMode] = ramp ? 1 : 0;
    d[U.rampCount] = ramp ? ramp.length : 0;
    if (ramp) {
      for (let i = 0; i < MAX_STOPS; i++) {
        const c = ramp[Math.min(i, ramp.length - 1)];
        d[U.ramp + i * 4] = c[0];
        d[U.ramp + i * 4 + 1] = c[1];
        d[U.ramp + i * 4 + 2] = c[2];
        d[U.ramp + i * 4 + 3] = 0;
      }
    }
    // paletteA doubles as the background tint, which backgroundColor() reads
    // directly in both modes — so an imported ramp writes its mean here.
    d[U.paletteA] = p.a[0]; d[U.paletteA + 1] = p.a[1]; d[U.paletteA + 2] = p.a[2]; d[U.paletteA + 3] = 0;
    d[U.paletteB] = p.b[0]; d[U.paletteB + 1] = p.b[1]; d[U.paletteB + 2] = p.b[2]; d[U.paletteB + 3] = 0;
    d[U.paletteC] = p.c[0]; d[U.paletteC + 1] = p.c[1]; d[U.paletteC + 2] = p.c[2]; d[U.paletteC + 3] = 0;
    d[U.paletteD] = p.d[0]; d[U.paletteD + 1] = p.d[1]; d[U.paletteD + 2] = p.d[2]; d[U.paletteD + 3] = 0;

    d[U.glowStrength] = 1.0;
    d[U.fogDensity] = 0.5;
    d[U.shadowSoftness] = 12.0;
    d[U.aoStrength] = 0.85;
    d[U.qualityScale] = state.qualityScale;
    d[U.bgMode] = state.transparent ? 0.0 : 1.0;
    d[U.reducedMotion] = rm ? 1.0 : 0.0;
    d[U.flyMode] = state.fly ? 1.0 : 0.0;

    // Jitter is zero on a moving frame, so the interactive image is untouched.
    const accNow = accumulating(nowMs);
    if (accNow && state.accumSamples < ACCUM_CAP) {
      const j = r2jitter(state.accumSamples);
      d[U.jitter] = j[0];
      d[U.jitter + 1] = j[1];
      d[U.accumWeight] = 1 / (state.accumSamples + 1);
    } else {
      d[U.jitter] = 0; d[U.jitter + 1] = 0; d[U.accumWeight] = 1;
    }
    d[U._pad] = 0.0;

    // View-projection for the attractor line pass (matches the raymarcher's
    // camera: same eye, target, and vertical FOV).
    const aspect = (state.targets ? state.targets.w / state.targets.h : 1) || 1;
    mat4Perspective(_proj, d[U.fov], aspect, 0.01, 100.0);
    mat4LookAt(_view, [camX, camY, camZ],
      [d[U.camTarget], d[U.camTarget + 1], d[U.camTarget + 2]],
      [camUpX, camUpY, camUpZ]);
    mat4Mul(_viewProj, _proj, _view);
    d.set(_viewProj, U.viewProj);

    state.device.queue.writeBuffer(state.uniformBuffer, 0, state.uniformData);
  }

  // ---- Single frame ----
  function renderFrame(nowMs, force) {
    if (state.disposed || !state.device || !state.targets) return;

    updateUniforms(nowMs);

    const device = state.device;
    const encoder = device.createCommandEncoder();
    const T = state.targets;

    // Progressive accumulation state for this frame. Once the average has
    // converged the raymarch is skipped entirely and the stored image is simply
    // re-presented, which drops idle GPU load to the post chain alone.
    const acc = accumulating(nowMs);
    const converged = acc && state.accumSamples >= ACCUM_CAP;
    const drawScene = !converged;
    // Which accumulation half this frame writes; the other holds the average so
    // far. When idle-converged, keep reading the half last written.
    const par = acc ? (state.accumParity ^ (converged ? 1 : 0)) : 0;

    // Clearance probe. Runs BEFORE any render pass: a compute pass sandwiched
    // between render passes forces a tile-memory resolve and reload on the
    // tile-based GPUs phones use, which costs far more than the probe itself.
    //
    // Also throttled rather than run every frame. It is a single thread marching
    // the estimator, so the rest of the GPU waits on it; at 20Hz it is
    // imperceptible for a speed control and for zoom re-pinning, both of which
    // tolerate a stale reading by design.
    const probeDue = nowMs - state.probeAt >= PROBE_INTERVAL_MS;
    const doProbe = (state.fly || state.explorer) && state.pipelines.probe
                    && !state.probeBusy && probeDue
                    // Every distance-estimated surface. Attractors are line
                    // geometry and the cosmic web is a density field, so
                    // neither has a surface to probe for. This was previously
                    // pinned to the id of the then-last surface, which silently
                    // stopped probing every surface added after it.
                    && isSurfaceType(state.fractalType);
    if (doProbe) {
      state.probeAt = nowMs;
      const cpass = encoder.beginComputePass();
      cpass.setPipeline(state.pipelines.probe);
      cpass.setBindGroup(0, state.bindGroups.probe);
      cpass.dispatchWorkgroups(1);
      cpass.end();
      encoder.copyBufferToBuffer(state.probeBuffer, 0, state.probeStaging, 0, 8);
    }

    // Pass 1: raymarch -> palette-independent material attachments. While
    // accumulating, blend the new jitter sample into the running average in
    // place. The first sample clears; subsequent samples load the prior mean.
    if (drawScene) {
      const continuing = acc && state.accumSamples > 0;
      const blendWeight = acc ? 1 / (state.accumSamples + 1) : 1;
      const loadOp = continuing ? 'load' : 'clear';
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: T.sceneView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp,
            storeOp: 'store',
          },
          {
            view: T.auxView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp,
            storeOp: 'store',
          },
        ],
      });
      pass.setBlendConstant({ r: blendWeight, g: blendWeight, b: blendWeight, a: blendWeight });
      pass.setPipeline(state.pipelines.raymarch);
      pass.setBindGroup(0, state.bindGroups.raymarch);
      pass.draw(3);

      // Attractor line material is weighted-additive. The raymarch draw above
      // has already averaged the background sample; every segment now adds its
      // current sample contribution with the same 1/(n+1) weight.
      if (isAttractorType(state.fractalType) && state.trajBuffer) {
        pass.setPipeline(state.pipelines.attractor);
        pass.setBindGroup(0, state.bindGroups.raymarch);
        pass.setVertexBuffer(0, state.trajBuffer);
        pass.draw(state.trajCount);
      }
      pass.end();
    }

    // Pass 2: bloom horizontal -> bloomA. Sources the average while
    // accumulating, the raw scene otherwise.
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: T.bloomAView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(state.pipelines.bloomH);
      pass.setBindGroup(0, state.bindGroups.bloomH);
      pass.draw(3);
      pass.end();
    }
    // Pass 3: bloom vertical -> bloomB
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: T.bloomBView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(state.pipelines.bloomV);
      pass.setBindGroup(0, state.bindGroups.bloomV);
      pass.draw(3);
      pass.end();
    }
    // Pass 4: composite -> swapchain, or -> LDR then FXAA -> swapchain.
    //
    // A converged frame is already antialiased, by up to 96 jittered samples,
    // and running an edge filter over it would only soften detail that is real.
    // A moving frame has one sample taken on the internal grid, so its
    // silhouettes step; that is the case FXAA exists for. The extra pass is
    // therefore spent only while moving, when it is also the only pass cheap
    // enough to add without costing a rung.
    {
      let view;
      try {
        view = state.context.getCurrentTexture().createView();
      } catch (e) {
        return; // context not ready (e.g. zero-size) — skip frame
      }
      const smoothing = state.fxaaOn && !acc && state.pipelines.fxaa && state.targets.ldrView;
      const clear = { r: 0, g: 0, b: 0, a: 0 };
      {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: smoothing ? state.targets.ldrView : view,
            loadOp: 'clear', storeOp: 'store', clearValue: clear,
          }],
        });
        pass.setPipeline(state.pipelines.composite);
        pass.setBindGroup(0, state.bindGroups.composite);
        pass.draw(3);
        pass.end();
      }
      if (smoothing) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: clear }],
        });
        pass.setPipeline(state.pipelines.fxaa);
        pass.setBindGroup(0, state.bindGroups.composite);
        pass.draw(3);
        pass.end();
      }
    }

    device.queue.submit([encoder.finish()]);

    if (acc && drawScene) {
      state.accumSamples += 1;
    }

    if (doProbe) {
      // Async map; the value lands a frame or two later, which is fine for a
      // speed control. Failures (device lost mid-flight) just clear the flag.
      state.probeBusy = true;
      state.probeStaging.mapAsync(GPUMapMode.READ).then(() => {
        const v = new Float32Array(state.probeStaging.getMappedRange());
        state.probeDist = v[0];
        state.probeHit = v[1];
        state.probeStaging.unmap();
        state.probeBusy = false;
      }).catch(() => { state.probeBusy = false; });
    }
  }

  // ---- Adaptive quality ----
  // The decision logic is in quality.js and is pure; this is only the plumbing
  // that hands it frame times and applies the rung it returns.
  function applyRung(index, why) {
    const i = Math.min(clampIndex(index), state.rungCap ?? TOP);
    if (i === state.detailRung) return false;
    state.detailRung = i;
    state.qualityScale = LADDER[i].scale;
    // Keep the governor's idea of the current rung in step with what is really
    // being rendered. A rung applied by anything other than the governor --
    // showcase, or a direct call -- otherwise leaves it charging frames to a
    // rung it is not on, which drove the ladder to the floor in practice.
    if (why !== 'governor' && state.gov) state.gov = govResync(state.gov, i);
    // Resolution changed, so the accumulated image is the wrong size and any
    // samples gathered at the old rung no longer describe this one.
    state.accumSamples = 0;
    resize();
    return true;
  }

  function adaptQuality(dtMs) {
    if (state.qualityMode !== 'auto' && state.qualityMode !== 'max') return;
    if (!state.gov) state.gov = planMode(state.qualityMode, state.detailRung).gov;
    if (!state.gov) return;
    // Kept for the HUD; the governor itself works in frame TIME, because the
    // budget is a time and averaging reciprocals biases towards fast frames.
    state.fpsEMA = state.fpsEMA * 0.9 + (1000 / Math.max(dtMs, 1)) * 0.1;

    state.gov = govSample(state.gov, dtMs);
    state.showcaseRung = -1;
    if (state.gov.changed) applyRung(state.gov.index, 'governor');
  }

  // Once the view has been still long enough to be a showcase rather than an
  // interaction, there is no responsiveness left to protect: a single frame may
  // take a quarter of a second, and the accumulator will keep refining it. This
  // is the same philosophy the progressive accumulation already follows, applied
  // to resolution and march precision as well as to sample count.
  function considerShowcase() {
    if (state.qualityMode !== 'max' || !state.gov) return;
    if (state.showcaseRung >= 0) return;
    const want = showcaseIndex(state.gov, 220);
    state.showcaseRung = want;
    if (want > state.detailRung) applyRung(want, 'showcase');
  }

  // ---- Render loop ----
  function loop(nowMs) {
    if (!state.running || state.disposed) return;

    const dt = state.lastFrameTime ? nowMs - state.lastFrameTime : 16.7;
    state.lastFrameTime = nowMs;
    state.frameDt = dt;

    const acc = accumulating(nowMs);
    const rm = reducedMotion();
    // Colour cycling is independent of geometry motion. Reduced-motion keeps
    // autonomous animation still, while moving the speed slider explicitly
    // opts colour motion back in.
    if (colorCycleMotionAllowed(rm, state.colorCycleExplicit)) {
      state.colorPhase += (dt / 1000) * state.colorCycle;
    }
    // Geometry/parallax remain governed by reduced-motion exactly as before.
    if (!rm && !acc) {
      state.animTime += dt / 1000;
      state.parallax.x += (state.parallax.tx - state.parallax.x) * 0.05;
      state.parallax.y += (state.parallax.ty - state.parallax.y) * 0.05;
    }

    if (acc) {
      // A still view: spend the headroom on the picture rather than on frames.
      considerShowcase();
      renderFrame(nowMs, false);
      // Deliberately not sampled by adaptQuality. A converged frame skips the
      // raymarch entirely, so its post-chain cost is not an interactive FPS
      // measurement and must not drive the adaptive-resolution controller.
      state.rafId = requestAnimationFrame(loop);
      return;
    }

    renderFrame(nowMs, false);
    adaptQuality(dt);
    state.rafId = requestAnimationFrame(loop);
  }

  // ---- Lifecycle ----
  function start() {
    if (state.running || state.disposed) return;
    // Under reduced-motion we normally render a single static pose. Keep the
    // loop alive for interactive navigation, or when the user explicitly asks
    // the colour-speed slider for a non-zero animation rate.
    if (!colorCycleNeedsLoop(
      reducedMotion(), state.controls, state.colorCycleExplicit, state.colorCycle)) {
      renderFrame(performance.now(), true);
      return;
    }
    state.running = true;
    state.lastFrameTime = 0;
    state.rafId = requestAnimationFrame(loop);
  }

  function stop() {
    state.running = false;
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }

  // ---- Visibility / intersection gating ----
  let isVisible = true;
  let isIntersecting = true;

  function updateRunning() {
    const shouldRun = isVisible && isIntersecting && !state.disposed;
    if (shouldRun) start();
    else stop();
  }

  function onVisibility() {
    isVisible = document.visibilityState === 'visible';
    updateRunning();
  }

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) isIntersecting = e.isIntersecting;
        updateRunning();
      }, { threshold: 0 })
    : null;

  const ro = 'ResizeObserver' in window
    ? new ResizeObserver(() => resize())
    : null;

  function onParallaxMove(e) {
    if (reducedMotion()) return;
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = (e.clientY / window.innerHeight) * 2 - 1;
    state.parallax.tx = nx;
    state.parallax.ty = ny;
  }

  function onReducedMotionChange() {
    // Re-evaluate loop behavior when the user toggles the preference.
    stop();
    updateRunning();
    if (reducedMotion() && !state.controls) renderFrame(performance.now(), true);
  }

  // ---- Navigation: drag to orbit, pinch / wheel to zoom ----
  // Distance bounds are relative to the model's framing radius. The inner bound
  // is a numerical floor rather than a usability one: with the target pinned to
  // a surface, closing in stays crisp all the way down, and the approach is
  // asymptotic so it never actually arrives.
  const DIST_MIN_F = 1e-4;
  const DIST_MAX_F = 14.0;
  const TAP_MOVE = 10;     // px of movement that disqualifies a tap
  // Release velocity is measured over a short real-time gesture window in
  // camera.js. That makes a 1000Hz mouse, coalesced desktop events and a 60Hz
  // touchscreen describe the same physical throw.
  const FLICK_RELEASE_GRACE_MS = 120;  // pause longer than this kills the throw

  function clampDist(d) {
    const baseR = CAM_RADIUS[state.fractalType] ?? 2.55;
    return Math.max(baseR * DIST_MIN_F, Math.min(baseR * DIST_MAX_F, d));
  }

  // Unit vector target -> eye for the current orbit angles.
  function orbitDir(o) {
    return orbitBasis(o.yaw, o.pitch).dir;
  }

  function gestureTime(e) {
    const t = Number(e && e.timeStamp);
    // PointerEvent.timeStamp shares performance.now()'s monotonic clock in
    // modern browsers. Fall back for older WebViews that expose a non-finite one.
    return Number.isFinite(t) ? t : performance.now();
  }

  function appendFlickSamples(e) {
    if (!e || state.fly) return;
    let events = [];
    try {
      if (typeof e.getCoalescedEvents === 'function') events = e.getCoalescedEvents() || [];
    } catch (_) {}
    if (!events.length) events = [e];

    for (const q of events) {
      const sample = { x: q.clientX, y: q.clientY, t: gestureTime(q) };
      const last = state.orbit.flickSamples[state.orbit.flickSamples.length - 1];
      if (!last || sample.t > last.t || sample.x !== last.x || sample.y !== last.y) {
        state.orbit.flickSamples.push(sample);
      }
    }
    const last = state.orbit.flickSamples[state.orbit.flickSamples.length - 1];
    if (!last) return;
    const cutoff = last.t - FLICK_WINDOW_MS * 2;
    while (state.orbit.flickSamples.length > 2
        && state.orbit.flickSamples[1].t < cutoff) {
      state.orbit.flickSamples.shift();
    }
  }

  function orbitPointerScale() {
    const k = 3.2 / Math.max(300, Math.min(window.innerWidth, window.innerHeight));
    const baseR = CAM_RADIUS[state.fractalType] ?? 2.55;
    return k * orbitDragScale(state.orbit.dist / baseR, state.orbit.pinned);
  }

  function updateFlickVelocity() {
    const [vyaw, vpitch] = flickVelocity(state.orbit.flickSamples, orbitPointerScale());
    state.orbit.vyaw = vyaw;
    state.orbit.vpitch = vpitch;
    return Math.hypot(vyaw, vpitch);
  }

  // Move the pivot onto the surface straight ahead, using the distance the GPU
  // probe last measured along the centre ray.
  //
  // Without this, zoom slides the eye towards a target parked at the origin --
  // the model's centroid -- so closing in far enough pushes the eye through the
  // surface and into the interior, where the frame washes out. Re-pinning makes
  // zoom dolly towards whatever is being looked at instead, approaching it
  // asymptotically and never crossing it.
  //
  // The eye does not move: only the pivot slides forward along the view ray to
  // land on the surface, and the distance shrinks to match.
  function repinOrbitTarget() {
    const hit = state.probeHit;
    if (!(hit > 0) || !Number.isFinite(hit)) return false;
    const o = state.orbit;
    const dir = orbitDir(o);
    const slide = o.dist - hit;
    o.target[0] += dir[0] * slide;
    o.target[1] += dir[1] * slide;
    o.target[2] += dir[2] * slide;
    o.dist = hit;
    o.pinned = true;
    return true;
  }

  // Zoom by a factor. Closing in re-pins first so the dolly runs towards the
  // surface; pulling back just grows the distance from the current pivot.
  function applyZoom(factor) {
    if (factor < 1) repinOrbitTarget();
    state.orbit.dist = clampDist(state.orbit.dist * factor);
  }

  function pinchDistance() {
    const pts = [...state.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  // Accumulate only when the view is genuinely still: interactive modes only,
  // no input for a moment, no keys held, and animation frozen (the estimators
  // move over time, and averaging a moving image just smears it).
  // Is the orbit view still drifting from its last movement?
  function orbitDrifting() {
    return state.explorer && !state.fly
           && (state.orbit.dyaw !== 0 || state.orbit.dpitch !== 0);
  }

  function accumulating(nowMs) {
    if (state.fractalType === FRACTAL_IDS.cosmicweb) return false;
    if (!state.accumOn || !state.controls) return false;
    if (state.keys.size > 0) return false;
    if (state.pointers.size > 0) return false;
    // A drifting camera can never settle, and averaging a moving image just
    // smears it. So the two are exclusive by construction: the view drifts
    // until it is stopped, and stopping it is what lets the image converge.
    if (orbitDrifting()) return false;
    return nowMs - state.lastInteract > ACCUM_IDLE_MS;
  }

  function resetAccum() {
    state.accumSamples = 0;
    state.lastInteract = performance.now();
  }

  function nudgeRender() {
    // If the loop isn't spinning (e.g. reduced-motion static), draw one frame.
    if (!state.running) renderFrame(performance.now(), true);
  }

  function onPointerDown(e) {
    if (!state.controls) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    const now = performance.now();
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: gestureTime(e) });
    state.lastInteract = now;
    state.accumSamples = 0;
    if (state.pointers.size === 1) {
      // Begin a fresh gesture; remember where, to distinguish tap from drag.
      state.gestureMoved = false;
      state.gestureMulti = false;
      state.tapStart = { x: e.clientX, y: e.clientY };
      if (!state.fly) {
        // Grabbing a spinning object catches it immediately. New momentum will
        // be sampled from this gesture and released only when the pointer lifts.
        state.orbit.vyaw = 0; state.orbit.vpitch = 0; state.orbit.flickAt = 0;
        state.orbit.flickSamples = [];
        appendFlickSamples(e);
      }
    }
    if (state.pointers.size >= 2) {
      if (!state.fly) {
        state.orbit.vyaw = 0; state.orbit.vpitch = 0; state.orbit.flickAt = 0;
        state.orbit.flickSamples = [];
      }
      // A second finger means this is a pinch, never a tap. Re-baseline the
      // separation on every touch down: which two pointers pinchDistance()
      // measures can change as fingers land, and carrying a stale baseline
      // across that would read as one enormous spread.
      state.gestureMulti = true;
      state.pinchDist0 = pinchDistance();
    }
  }

  function onPointerMove(e) {
    if (!state.controls || !state.pointers.has(e.pointerId)) return;
    const prev = state.pointers.get(e.pointerId);
    const now = performance.now();
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: gestureTime(e) });
    if (state.pointers.size === 1 && !state.fly) appendFlickSamples(e);
    state.lastInteract = now;
    state.accumSamples = 0;

    const k = 3.2 / Math.max(300, Math.min(window.innerWidth, window.innerHeight));

    if (state.pointers.size >= 2) {
      // Both gestures are integrated from the CHANGE in finger separation since
      // the previous event, not from the separation the gesture started at.
      // Each step is then relative to where the camera actually is, which is
      // what makes them compose with re-pinning and with proximity scaling.
      const sep = pinchDistance();
      const baseR = CAM_RADIUS[state.fractalType] ?? 2.55;
      if (state.pinchDist0 > 0 && sep > 0) {
        if (state.fly) {
          // Two fingers: spread to move forward, pinch to back up. Zoom is
          // meaningless when the camera is already free to travel.
          dollyFlyCamera(state.flyCam, pinchDollyDistance(
            usableClearance(state.probeDist, baseR), sep - state.pinchDist0));
        } else {
          // Pinch: fingers apart -> zoom in (smaller radius).
          applyZoom(pinchZoomFactor(state.pinchDist0, sep));
        }
      }
      if (sep > 0) state.pinchDist0 = sep;
    } else if (state.fly) {
      // Single-pointer drag: aim. Drag right looks right, drag down looks down.
      aimFlyCamera(state.flyCam, dx * k, -dy * k);
      if (state.tapStart &&
          Math.hypot(e.clientX - state.tapStart.x, e.clientY - state.tapStart.y) > TAP_MOVE) {
        state.gestureMoved = true;
      }
    } else {
      // Single-pointer drag: orbit. Scaled by viewport so it feels consistent,
      // and by zoom so it stays gentle up close -- a fixed angular rate whips
      // the view once the camera is near the surface.
      const ok = orbitPointerScale();
      state.orbit.tyaw += dx * ok;
      state.orbit.tpitch += dy * ok;
      // Estimate the gesture over a short TIME window. This deliberately uses
      // coalesced samples and later also pointerup, so high-poll mice do not
      // produce a stream of tiny velocities that vanish at release.
      const speed = updateFlickVelocity();
      if (dx || dy) {
        if (speed > 0) {
          state.orbit.dyaw = state.orbit.vyaw;
          state.orbit.dpitch = state.orbit.vpitch;
        }
        state.orbit.flickAt = now;
      }
      if (state.tapStart &&
          Math.hypot(e.clientX - state.tapStart.x, e.clientY - state.tapStart.y) > TAP_MOVE) {
        state.gestureMoved = true;
      }
    }
    nudgeRender();
  }

  function onPointerUp(e) {
    if (!state.pointers.has(e.pointerId)) return;
    const now = performance.now();
    const cancelled = e.type === 'pointercancel';
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!state.fly && state.pointers.size === 1) {
      const prev = state.pointers.get(e.pointerId);
      appendFlickSamples(e);
      const speed = updateFlickVelocity();
      if (prev && (e.clientX !== prev.x || e.clientY !== prev.y)) {
        if (speed > 0) {
          state.orbit.dyaw = state.orbit.vyaw;
          state.orbit.dpitch = state.orbit.vpitch;
        }
        state.orbit.flickAt = now;
      }
    }
    state.pointers.delete(e.pointerId);
    state.lastInteract = now;

    if (state.pointers.size >= 2) {
      // Still a pinch, but on a different pair of fingers. Same reason as on
      // pointer down: re-baseline rather than measure against the pair that
      // just changed.
      state.pinchDist0 = pinchDistance();
    } else if (state.pointers.size === 1) {
      // Dropped from a pinch to one finger: continuing as a drag, not a tap.
      state.gestureMoved = true;
      const remaining = [...state.pointers.values()][0];
      state.pointers.set([...state.pointers.keys()][0], { ...remaining, t: now });
      state.tapStart = { x: remaining.x, y: remaining.y };
      if (!state.fly) {
        // A pinch transitioning back to one finger starts a fresh throw sample.
        state.orbit.vyaw = 0; state.orbit.vpitch = 0; state.orbit.flickAt = 0;
        state.orbit.flickSamples = [{ x: remaining.x, y: remaining.y, t: gestureTime(e) }];
      }
    } else if (state.pointers.size === 0) {
      if (!state.fly) {
        // Releasing immediately after motion launches the sampled velocity. If
        // the user paused before lifting (or the OS cancelled the gesture), the
        // throw is suppressed while the existing subtle drift direction remains.
        const recent = state.orbit.flickAt > 0
          && now - state.orbit.flickAt <= FLICK_RELEASE_GRACE_MS;
        if (cancelled || !recent) {
          state.orbit.vyaw = 0; state.orbit.vpitch = 0;
        }
      }
      // Gesture fully ended. A clean single-finger tap (no movement, no pinch)
      // counts toward the double-tap — a pinch release never does.
      if (state.controls && !state.gestureMoved && !state.gestureMulti) {
        const now = performance.now();
        if (now - state.tapTime < 320) {
          // Freeze where you are, rather than recentre. The point of the
          // gesture is to hold the view you have found; recentring throws it
          // away, which is the opposite of what stopping is for. Reset stays
          // available as resetView() and as the demo's Reset view button.
          //
          // Fly mode has no drift to stop, so there the gesture still recentres.
          if (state.fly) resetView(); else freezeView();
          state.tapTime = 0;
        } else { state.tapTime = now; }
      }
      state.gestureMulti = false;
    }
  }

  function onWheel(e) {
    if (!state.controls) return;
    resetAccum();
    e.preventDefault();
    if (state.fly) {
      // Wheel trims travel speed; there is nothing to zoom towards in flight.
      scaleFlySpeed(state.flyCam, e.deltaY > 0 ? 0.87 : 1.15);
    } else {
      applyZoom(e.deltaY > 0 ? 1.1 : 0.9);
    }
    state.lastInteract = performance.now();
    nudgeRender();
  }

  // ---- Init / re-init ----
  async function init(isReinit) {
    const device = await acquireDevice();
    state.device = device;
    // When this device came up, so a later loss can tell a fresh incident from
    // the continuation of a failing burst.
    state._deviceUpAt = performance.now();

    // Device-lost handling: try one re-init, then fall back.
    device.lost.then((info) => {
      if (state.disposed) return;
      // 'destroyed' reason means we tore it down intentionally.
      if (info.reason === 'destroyed') return;
      console.warn('[fractal-bg] device lost:', info.message);
      // A loss is usually transient and re-initialising recovers it. Only a
      // BURST of losses is fatal: a device that ran for a while before failing
      // starts a fresh count, so one bad moment hours into a session is not
      // treated as the continuation of an earlier one.
      const aliveMs = performance.now() - (state._deviceUpAt || 0);
      const plan = planDeviceLoss(state._reinits || 0, aliveMs);
      state._reinits = plan.attempts;
      if (plan.retry) {
        reinit();
      } else {
        opts.onUnsupported(
          `WebGPU device lost ${plan.attempts} times in quick succession`);
        destroy();
      }
    });

    state.context = canvas.getContext('webgpu');
    state.format = navigator.gpu.getPreferredCanvasFormat();
    state.context.configure({
      device,
      format: state.format,
      alphaMode: state.transparent ? 'premultiplied' : 'opaque',
    });

    // Pick starting quality tier.
    // Same decision the selector makes, from the same function: init used to
    // have its own copy that only recognised 'auto', so quality:'max' at
    // construction behaved differently from choosing Max later.
    {
      const plan = planMode(state.qualityMode, pickAutoRung());
      state.detailRung = plan.rung;
      state.gov = plan.gov;
      state.qualityScale = LADDER[plan.rung].scale;
    }

    createStaticResources();
    resize();
    if (isAttractorType(state.fractalType)) ensureAttractorTrajectory();
  }

  async function reinit() {
    try {
      stop();
      state.targets = null;
      await init(true);
      updateRunning();
    } catch (e) {
      opts.onUnsupported('WebGPU re-init failed: ' + e.message);
      destroy();
    }
  }

  // Where to START before any frame has been measured. Only a guess: the
  // governor replaces it with evidence within a second or two either way.
  function pickAutoRung() {
    const px = window.innerWidth * (window.devicePixelRatio || 1);
    if (coarsePointer || px < 900) return 1;
    if (px < 1700) return 3;
    return 4;
  }

  // ---- Destroy ----
  function destroy() {
    if (state.disposed) return;
    state.disposed = true;
    stop();
    if (io) io.disconnect();
    if (ro) ro.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pointermove', onParallaxMove);
    removeMQListener(reducedMotionMQ, onReducedMotionChange);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    try {
      if (state.targets) {
        state.targets.sceneTex.destroy();
        state.targets.auxTex.destroy();
        state.targets.bloomA.destroy();
        state.targets.bloomB.destroy();
      }
      state.trajBuffer && state.trajBuffer.destroy();
      state.probeBuffer && state.probeBuffer.destroy();
      state.probeStaging && state.probeStaging.destroy();
      if (state.targets) {
        state.targets.accumA.destroy();
        state.targets.accumB.destroy();
      }
      state.uniformBuffer && state.uniformBuffer.destroy();
      state.device && state.device.destroy();
    } catch (e) {
      /* ignore */
    }
  }

  // Apply the background alpha mode (transparent-over-page vs. opaque viewer).
  function applyTransparent(v) {
    state.transparent = !!v;
    state.context.configure({
      device: state.device,
      format: state.format,
      alphaMode: state.transparent ? 'premultiplied' : 'opaque',
    });
    if (!state.running) renderFrame(performance.now(), true);
  }

  // ---- Fly-through keyboard ------------------------------------------------
  // Only WASD/QE plus the modifiers; everything else falls through so the page
  // stays usable. Ignored while the user is typing into a field.
  const FLY_KEYS = {
    KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyQ: 'q', KeyE: 'e',
    ArrowUp: 'w', ArrowDown: 's', ArrowLeft: 'a', ArrowRight: 'd',
    PageUp: 'e', PageDown: 'q',
  };

  function typingTarget(e) {
    const el = e.target;
    if (!el || el === document.body || el === canvas) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function onKeyDown(e) {
    if (!state.fly || typingTarget(e)) return;
    const k = FLY_KEYS[e.code];
    if (k) {
      state.keys.add(k);
      resetAccum();
      e.preventDefault();     // arrows and PageUp/Down would scroll the page
    }
    if (e.shiftKey) state.keys.add('shift');
    if (e.altKey) state.keys.add('alt');
    if (k) nudgeRender();
  }

  function onKeyUp(e) {
    const k = FLY_KEYS[e.code];
    if (k) state.keys.delete(k);
    if (!e.shiftKey) state.keys.delete('shift');
    if (!e.altKey) state.keys.delete('alt');
  }

  // Held keys would otherwise stick down while the tab is in the background.
  function onBlur() { state.keys.clear(); }

  // Camera mode changes only who owns navigation. Presentation remains
  // unchanged so entering Shape Explorer cannot alter the apparent palette by
  // switching the canvas from transparent-over-page compositing to opaque.
  // Fly and Explorer are mutually exclusive; deriving controls from the flags
  // here keeps their input lifecycle in one place.
  function applyCameraMode() {
    const interactive = state.fly || state.explorer;
    applyControls(interactive);
    state.accumSamples = 0;
    state.autoOrbit = !interactive;
  }

  // Enable/disable drag/pinch/wheel navigation.
  function applyControls(on) {
    state.controls = !!on;
    canvas.style.pointerEvents = on ? 'auto' : 'none';
    canvas.style.touchAction = on ? 'none' : '';
    if (!on) state.pointers.clear();
    updateRunning();
    nudgeRender();
  }

  /**
   * Stop the view exactly where it is, keeping the angles, pivot and distance.
   *
   * Clearing the drift direction leaves the momentum with nothing to settle
   * onto, so it decays to a genuine halt. The target angles are pulled onto the
   * eased ones in the same move: the easing spring is mid-flight towards a
   * target the drift has been advancing, and leaving that gap in place would
   * let the view glide on for another half second after being told to stop.
   */
  function freezeView() {
    const o = state.orbit;
    o.tyaw = o.yaw; o.tpitch = o.pitch;
    o.vyaw = 0; o.vpitch = 0; o.dyaw = 0; o.dpitch = 0; o.flickAt = 0; o.flickSamples = [];
    state.accumSamples = 0;
    state.lastInteract = performance.now();
    nudgeRender();
  }

  function adoptCurrentViewAsOrbit() {
    const pose = orbitPoseFromView(state.lastCamPos, state.lastCamTarget);
    if (!pose) return false;

    const o = state.orbit;
    o.yaw = pose.yaw; o.tyaw = pose.yaw;
    o.pitch = pose.pitch; o.tpitch = pose.pitch;
    o.target[0] = state.lastCamTarget[0];
    o.target[1] = state.lastCamTarget[1];
    o.target[2] = state.lastCamTarget[2];
    o.dist = clampDist(pose.dist);
    o.pinned = false;

    // Continue the landing camera's instantaneous angular motion. Explorer's
    // normal momentum law takes over from here, so it begins at the same rate
    // and then naturally settles towards its subtle drift floor.
    const vyaw = Number(state.backgroundOrbitRate[0]) || 0;
    const vpitch = Number(state.backgroundOrbitRate[1]) || 0;
    o.vyaw = vyaw; o.vpitch = vpitch;
    if (Math.hypot(vyaw, vpitch) > 1e-6) {
      o.dyaw = vyaw; o.dpitch = vpitch;
    } else {
      o.dyaw = 0; o.dpitch = 0;
    }
    o.flickAt = 0;
    o.flickSamples = [];
    state.probeHit = -1;
    state.accumSamples = 0;
    state.lastInteract = performance.now();
    return true;
  }

  function resetView() {
    const o = state.orbit;
    // Clearing the drift direction as well as the velocity is what makes this
    // the only full stop: with no direction to settle onto, momentum decays to
    // nothing and the view holds still (and can then converge).
    o.tyaw = 0.6; o.tpitch = 0.35;
    o.vyaw = 0; o.vpitch = 0; o.dyaw = 0; o.dpitch = 0; o.flickAt = 0; o.flickSamples = [];
    o.target[0] = 0; o.target[1] = 0; o.target[2] = 0;
    o.dist = CAM_RADIUS[state.fractalType] ?? 2.55;
    o.pinned = false;
    state.probeHit = -1;
    state.accumSamples = 0;
    if (state.fly) placeFlyCamera(false);
    state.lastInteract = performance.now();
    nudgeRender();
  }

  // Drop the free camera at the model's orbit distance, facing the origin, so
  // entering fly mode starts from a framing the viewer already recognises.
  function placeFlyCamera(continueFromCurrent) {
    const r = state.orbit.dist;
    const c = state.lastCamPos;
    const len = Math.hypot(c[0], c[1], c[2]);
    // Entering fly mode continues from wherever the orbit camera was, so the
    // transition is seamless. Switching models does not: world scales differ by
    // more than 2x across the catalog, and keeping the old position would drop
    // the camera inside the larger ones.
    const p = (continueFromCurrent && len > 1e-3) ? [c[0], c[1], c[2]] : [0, 0, r];
    state.flyCam = makeFlyCamera(p);
    state.keys.clear();
  }

  // matchMedia listener compat (older Safari uses addListener).
  function addMQListener(mq, fn) {
    if (mq.addEventListener) mq.addEventListener('change', fn);
    else if (mq.addListener) mq.addListener(fn);
  }
  function removeMQListener(mq, fn) {
    if (mq.removeEventListener) mq.removeEventListener('change', fn);
    else if (mq.removeListener) mq.removeListener(fn);
  }

  // ---- Boot ----
  try {
    await init(false);
  } catch (e) {
    console.warn('[fractal-bg] init failed:', e);
    opts.onUnsupported(e.message || String(e));
    return null;
  }

  // Wire observers/listeners after successful init.
  if (io) io.observe(canvas);
  if (ro) ro.observe(canvas);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pointermove', onParallaxMove, { passive: true });
  addMQListener(reducedMotionMQ, onReducedMotionChange);

  // Navigation listeners live on the canvas; they no-op unless controls are on.
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  isVisible = document.visibilityState === 'visible';
  updateRunning();

  // ---- Public handle ----
  return {
    setFractal(name) {
      if (name in FRACTAL_IDS) {
        const prevR = CAM_RADIUS[state.fractalType] ?? 2.55;
        state.fractalType = FRACTAL_IDS[name];
        // Carry the viewer's zoom across as a RATIO, not as an absolute
        // distance. Each estimator lives at a different world scale -- that is
        // what CAM_RADIUS is for -- so keeping the raw distance means arriving
        // at a model framed by the previous one's size. Switching to the Barth
        // sextic, the largest here at clip radius 2.0, from the default 2.55
        // used to land the camera among its spikes.
        const nextR = CAM_RADIUS[state.fractalType] ?? 2.55;
        state.orbit.dist = clampDist(state.orbit.dist * (nextR / prevR));
        // The pivot described a surface that no longer exists.
        state.orbit.target[0] = 0;
        state.orbit.target[1] = 0;
        state.orbit.target[2] = 0;
        state.orbit.pinned = false;
        // Reframe the free camera for the new model's world scale.
        state.probeDist = Infinity;
        state.probeHit = -1;
        state.accumSamples = 0;
        // Each shape owns its own parameters, so a shape change resets them to
        // that shape's defaults rather than carrying numbers across.
        state.shapeParamValues = defaultsFor(name);
        state.shapeParamsPacked = packParams(name, state.shapeParamValues);
        if (state.fly) placeFlyCamera(false);
        // The attractor family needs its trajectory buffer built before use.
        if (isAttractorType(state.fractalType)) ensureAttractorTrajectory();
        if (!state.running) renderFrame(performance.now(), true);
      }
    },
    /**
     * Post-chain image adjustments. Accepts any subset of
     * {exposure, contrast, saturation, hue}; hue is in turns, 0..1.
     * Like the colour cycle these live in the composite pass, so they do NOT
     * reset accumulation -- a slider drag stays sharp instead of re-marching.
     */
    setImageAdjust(next) {
      const im = state.image;
      for (const k of ['exposure', 'contrast', 'saturation', 'hue']) {
        if (next && next[k] !== undefined) im[k] = Number(next[k]) || 0;
      }
      if (!state.running) renderFrame(performance.now(), true);
    },
    /**
     * Palette-coordinate shift rate per second. 0 stops it. The phase is
     * resolved after material accumulation, so a converged image stays sharp
     * while the selected palette moves across its stored coordinates.
     */
    setColorCycle(rate) {
      // Calling this method represents deliberate user/application intent. It
      // therefore overrides the automatic reduced-motion suppression for the
      // colour cycle only; geometry motion remains suppressed.
      state.colorCycleExplicit = true;
      state.colorCycle = Math.max(0, Number(rate) || 0);
      // A reduced-motion landing page may be sitting on its one static frame.
      // Re-evaluate the loop immediately: positive rates animate, zero goes
      // back to sleeping after presenting the current phase once.
      if (reducedMotion() && !state.controls) {
        stop();
        updateRunning();
      } else if (!state.running) {
        renderFrame(performance.now(), true);
      }
    },
    setPalette(name) {
      state.palette = getPalette(name);
      state.paletteRamp = null;
      // Material accumulation is palette-independent: recolour the converged
      // frame immediately rather than throwing away 96 geometry samples.
      if (!state.running) renderFrame(performance.now(), true);
    },
    // ---- Shape parameters ------------------------------------------------
    // Changing one changes the geometry, so it must clear the progressive
    // average: without that the converged frame blends the old shape into the
    // new one and the picture dissolves rather than changes.
    setShapeParam(key, value) {
      const name = shapeName(state.fractalType);
      if (!paramsFor(name).some((p) => p.key === key)) return;
      state.shapeParamValues = clampParams(name, {
        ...state.shapeParamValues, [key]: value,
      });
      state.shapeParamsPacked = packParams(name, state.shapeParamValues);
      state.accumSamples = 0;
      nudgeRender();
    },

    resetShapeParams() {
      const name = shapeName(state.fractalType);
      state.shapeParamValues = defaultsFor(name);
      state.shapeParamsPacked = packParams(name, state.shapeParamValues);
      state.accumSamples = 0;
      nudgeRender();
    },

    setQuality(mode) {
      state.qualityMode = mode;
      state.accumSamples = 0;
      state.showcaseRung = -1;
      const plan = planMode(mode, pickAutoRung());
      state.gov = plan.gov;
      applyRung(plan.rung);
      resize();
    },
    setTransparent(v) { applyTransparent(v); },
    // Enable drag/pinch/wheel navigation without the full explorer preset.
    setControls(on) { applyControls(on); },
    setAutoOrbit(on) { state.autoOrbit = !!on; nudgeRender(); },
    // Camera distance multiplier (1 = default framing). Also see resetView().
    setZoom(z) {
      const baseR = CAM_RADIUS[state.fractalType] ?? 2.55;
      state.orbit.dist = clampDist(baseR * z);
      nudgeRender();
    },
    zoomBy(factor) { applyZoom(factor); nudgeRender(); },
    resetView,
    // Stop the drift without moving the view. What double-tap does.
    freezeView,
    // Free fly-through: the camera leaves its orbit and can travel into a
    // model. Interior structures (gyroid, Kleinian) drop their bounding clip
    // while this is on, so there is something to travel through.
    setFly(on) {
      const want = !!on;
      if (want === state.fly) return;
      state.fly = want;
      if (want) {
        // Leaving explorer first, and placing the camera before anything can
        // trigger a frame: placeFlyCamera reads the last rendered camera
        // position, which a render in between would overwrite with a stale one.
        state.explorer = false;
        state.probeDist = Infinity;   // stale reading from another model/pose
        state.probeHit = -1;
        placeFlyCamera(true);
      } else {
        state.keys.clear();
      }
      applyCameraMode();
      updateRunning();
      nudgeRender();
    },
    // Travel speed multiplier (wheel adjusts this while flying).
    // Use an imported palette: a list of [r,g,b] triples in 0..1, kept exactly
    // rather than fitted to cosine coefficients. Pass null to return to the
    // cosine preset selected by setPalette.
    setPaletteColors(colors) {
      if (!colors) {
        state.paletteRamp = null;
      } else {
        const stops = clampStops(colors);
        if (stops.length < 2) return false;
        state.paletteRamp = stops;
        // Keep the background tint in step with the imported colours.
        const mean = averageColor(stops);
        state.palette = { ...state.palette, a: mean };
      }
      // Imported ramps are resolved from the same stored coordinates as cosine
      // presets, so changing one also preserves a converged material buffer.
      nudgeRender();
      return true;
    },

    // Progressive accumulation. On by default in the interactive modes; turning
    // it off restores the idle spin and continuous animation.
    setAccumulate(on) {
      state.accumOn = !!on;
      state.accumSamples = 0;
      nudgeRender();
    },
    setFlySpeed(v) {
      state.flyCam.speed = Math.max(FLY_SPEED_MIN, Math.min(FLY_SPEED_MAX, v));
      nudgeRender();
    },
    // Model-explorer preset: opaque background, no auto-drift, full navigation.
    // Turning it off restores the original (background) configuration.
    setExplorer(on) {
      const want = !!on;
      if (want === state.explorer) return;

      // Capture the live landing pose BEFORE changing mode: applyCameraMode()
      // can render immediately, so adopting afterwards would already expose one
      // frame of the old canned Explorer pose. Palette state and colorPhase are
      // intentionally untouched; only camera-control ownership changes here.
      const continued = want ? adoptCurrentViewAsOrbit() : false;
      state.explorer = want;
      if (state.explorer && state.fly) {
        state.fly = false;
        state.keys.clear();
      }
      applyCameraMode();
      // A degenerate camera is extraordinarily unlikely, but retain the old
      // known-good starting pose as a safe fallback. Leaving Explorer also
      // resets its private orbit state; the landing camera has its own path.
      if ((want && !continued) || !want) resetView();
      nudgeRender();
    },
    pause() { stop(); },
    resume() { updateRunning(); },
    destroy,
    // Introspection (handy for the demo HUD).
    get info() {
      return {
        fractalType: state.fractalType,
        shapeParams: { ...state.shapeParamValues },
        qualityMode: state.qualityMode,
        qualityScale: +state.qualityScale.toFixed(2),
        rung: state.detailRung,
        steps: LADDER[clampIndex(state.detailRung)].steps,
        iters: LADDER[clampIndex(state.detailRung)].iters,
        frameMs: state.gov ? +state.gov.emaMs.toFixed(2) : null,
        fps: Math.round(state.fpsEMA),
        reducedMotion: reducedMotion(),
        explorer: state.explorer,
        fly: state.fly,
        flySpeed: +state.flyCam.speed.toFixed(2),
        flyPos: state.fly ? state.flyCam.pos.map((v) => +v.toFixed(2)) : null,
        clearance: Number.isFinite(state.probeDist) ? +state.probeDist.toFixed(4) : null,
        samples: state.accumSamples,
        colorCycle: state.colorCycle,
        colorCycleActive: state.colorCycle > 0
          && colorCycleMotionAllowed(reducedMotion(), state.colorCycleExplicit),
        image: { ...state.image },
        zoom: +(state.orbit.dist / (CAM_RADIUS[state.fractalType] ?? 2.55)).toFixed(3),
        pinned: state.orbit.pinned,
        drifting: orbitDrifting(),
      };
    },
  };
}

export default initFractalBackground;
