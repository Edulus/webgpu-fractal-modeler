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
import { COMPOSITE_WGSL } from './shaders/composite.wgsl.js';
import { ATTRACTOR_WGSL } from './shaders/attractor.wgsl.js';
import { getPalette } from './palettes.js';
import { clampStops, averageColor, MAX_STOPS } from './palette-io.js';
import {
  makeFlyCamera, stepFlyCamera, aimFlyCamera, dollyFlyCamera, scaleFlySpeed,
  usableClearance, orbitDragScale, FLY_SPEED_MIN, FLY_SPEED_MAX,
} from './camera.js';

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
  _pad3: 62,        // 62,63 pad the ramp array to a 16-byte boundary
  ramp: 64,         // 8 * vec4 -> slots 64..95 (byte 256)
};
const UNIFORM_FLOATS = 96;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4; // 384

// Distance-estimated fractals occupy ids 0..10; the volumetric/line-rendered
// attractors follow at 11+. The shader keys off that split (see the
// `fractalType > 10.5` test in fractal.wgsl.js), so keep DE types contiguous at
// the front when adding new ones and move the attractors up to match.
const FRACTAL_IDS = {
  mandelbulb: 0, mandelbox: 1, menger: 2, julia: 3, apollonian: 4,
  spherepack: 5, encrusted: 6, surfacepack: 7, penrose: 8, gyroid: 9,
  kleinian: 10, attractor: 11, lorenz: 12,
};

// Quality tiers -> internal-resolution scale factor.
const QUALITY_SCALE = { low: 0.5, medium: 0.7, high: 1.0, screenshot: 1.0 };

// Camera orbit distance per fractal — each estimator lives at a different
// world scale, so a single radius would sit inside the larger ones.
// Indexed by fractal id (see FRACTAL_IDS).
// mandelbulb, mandelbox, menger, julia, apollonian, spherepack, encrusted,
// surfacepack, penrose, gyroid, kleinian, attractor(Aizawa), lorenz
// The Penrose disc is wide and flat, so it needs a little more room than the
// roughly ball-shaped estimators to sit inside the frame edge-on.
const CAM_RADIUS = [2.55, 6.5, 3.6, 3.0, 3.0, 2.9, 3.1, 3.0, 3.5, 3.2, 3.6, 3.2, 3.0];

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
    targets: null, // { sceneTex, bloomA, bloomB, w, h }
    bindGroups: {},
    // config
    fractalType: FRACTAL_IDS[opts.fractal] ?? 0,
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
    // adaptive quality
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
      yaw: 0.6, pitch: 0.35, tyaw: 0.6, tpitch: 0.35, vyaw: 0, vpitch: 0,
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
    accumParity: 0,
    accumOn: true,
    // active pointers for drag / pinch tracking
    pointers: new Map(),
    pinchDist0: 0,
    pinchZoom0: 1,
    lastInteract: 0,
    // tap vs. drag/pinch discrimination (for double-tap-to-reset)
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
      adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
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

    const fractalModule = device.createShaderModule({ code: FRACTAL_WGSL });
    const compositeModule = device.createShaderModule({ code: COMPOSITE_WGSL });

    // Bind group layouts.
    const raymarchBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    // The probe compute pass reads the same uniforms and writes one float.
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
    const compositeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    state._bgl = { raymarchBGL, probeBGL, blurBGL, compositeBGL };

    // Attractor line pipeline: additively blended trajectory over the HDR
    // target, so overlapping filaments accumulate brightness and then bloom.
    const attractorModule = device.createShaderModule({ code: ATTRACTOR_WGSL });
    const addBlend = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    state.pipelines.attractor = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [raymarchBGL] }),
      vertex: {
        module: attractorModule,
        entryPoint: 'vs_line',
        buffers: [{
          arrayStride: 16, // vec3 position + f32 age
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32' },
          ],
        }],
      },
      fragment: {
        module: attractorModule,
        entryPoint: 'fs_line',
        targets: [{ format: HDR_FORMAT, blend: addBlend }],
      },
      primitive: { topology: 'line-strip' },
    });

    // Raymarch pipeline -> HDR target.
    state.pipelines.raymarch = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [raymarchBGL] }),
      vertex: { module: fractalModule, entryPoint: 'vs_main' },
      fragment: {
        module: fractalModule,
        entryPoint: 'fs_main',
        targets: [{ format: HDR_FORMAT }],
      },
      primitive: { topology: 'triangle-list' },
    });

    // Camera clearance probe: one workgroup, one float out.
    state.pipelines.probe = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [probeBGL] }),
      compute: { module: fractalModule, entryPoint: 'cs_probe' },
    });

    // Progressive accumulation: mix(prevHalf, scene, 1/(n+1)) -> other half.
    state.pipelines.accum = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [compositeBGL] }),
      vertex: { module: compositeModule, entryPoint: 'vs_main' },
      fragment: {
        module: compositeModule,
        entryPoint: 'fs_accum',
        targets: [{ format: HDR_FORMAT }],
      },
      primitive: { topology: 'triangle-list' },
    });

    // Bloom horizontal.
    state.pipelines.bloomH = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [blurBGL] }),
      vertex: { module: compositeModule, entryPoint: 'vs_main' },
      fragment: { module: compositeModule, entryPoint: 'fs_bloom_h', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

    // Bloom vertical.
    state.pipelines.bloomV = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [blurBGL] }),
      vertex: { module: compositeModule, entryPoint: 'vs_main' },
      fragment: { module: compositeModule, entryPoint: 'fs_bloom_v', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

    // Composite -> swapchain (premultiplied output; canvas composites over page).
    state.pipelines.composite = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [compositeBGL] }),
      vertex: { module: compositeModule, entryPoint: 'vs_main' },
      fragment: { module: compositeModule, entryPoint: 'fs_composite', targets: [{ format: state.format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  // ---- Offscreen render targets (recreated on resize / quality change) ----
  function createTargets(renderW, renderH) {
    const device = state.device;
    if (state.targets) {
      state.targets.sceneTex.destroy();
      state.targets.bloomA.destroy();
      state.targets.bloomB.destroy();
      state.targets.accumA.destroy();
      state.targets.accumB.destroy();
    }
    const bw = Math.max(1, Math.floor(renderW / 2));
    const bh = Math.max(1, Math.floor(renderH / 2));

    const mk = (w, h) =>
      device.createTexture({
        size: { width: w, height: h },
        format: HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });

    const sceneTex = mk(renderW, renderH);
    const bloomA = mk(bw, bh);
    const bloomB = mk(bw, bh);
    // Accumulation ping-pong, full resolution.
    const accumA = mk(renderW, renderH);
    const accumB = mk(renderW, renderH);

    // Cache views once — reused as render-pass attachments every frame so we
    // don't allocate per-frame.
    const sceneView = sceneTex.createView();
    const bloomAView = bloomA.createView();
    const bloomBView = bloomB.createView();
    const accumAView = accumA.createView();
    const accumBView = accumB.createView();

    state.targets = {
      sceneTex, bloomA, bloomB, accumA, accumB,
      sceneView, bloomAView, bloomBView, accumAView, accumBView,
      w: renderW, h: renderH,
    };
    // A new size invalidates whatever had been averaged.
    state.accumSamples = 0;

    // (Re)build bind groups that reference these views.
    const ub = { buffer: state.uniformBuffer };
    state.bindGroups.raymarch = device.createBindGroup({
      layout: state._bgl.raymarchBGL,
      entries: [{ binding: 0, resource: ub }],
    });
    // Two floats: clearance at the camera, and the centre-ray surface distance.
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
      layout: state._bgl.blurBGL,
      entries: [
        { binding: 0, resource: ub },
        { binding: 1, resource: state.sampler },
        { binding: 2, resource: sceneView },
      ],
    });
    // Accumulation variants. `accum[k]` reads the scene plus half k and writes
    // the other half; `bloomHFrom[k]` / `compositeFrom[k]` then read half k as
    // the source instead of the raw scene.
    const mkAccum = (prevView) => device.createBindGroup({
      layout: state._bgl.compositeBGL,
      entries: [
        { binding: 0, resource: ub },
        { binding: 1, resource: state.sampler },
        { binding: 2, resource: sceneView },
        { binding: 3, resource: prevView },
      ],
    });
    state.bindGroups.accum = [mkAccum(accumAView), mkAccum(accumBView)];

    const mkBloomH = (srcView) => device.createBindGroup({
      layout: state._bgl.blurBGL,
      entries: [
        { binding: 0, resource: ub },
        { binding: 1, resource: state.sampler },
        { binding: 2, resource: srcView },
      ],
    });
    state.bindGroups.bloomHFrom = [mkBloomH(accumBView), mkBloomH(accumAView)];

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
        { binding: 3, resource: bloomBView },
      ],
    });

    const mkComposite = (srcView) => device.createBindGroup({
      layout: state._bgl.compositeBGL,
      entries: [
        { binding: 0, resource: ub },
        { binding: 1, resource: state.sampler },
        { binding: 2, resource: srcView },
        { binding: 3, resource: bloomBView },
      ],
    });
    state.bindGroups.compositeFrom = [mkComposite(accumBView), mkComposite(accumAView)];
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
    return ft === FRACTAL_IDS.lorenz ? 'lorenz' : 'aizawa';
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

    // Swapchain is full device-pixel resolution; internal raymarch res scales.
    const pxW = Math.max(1, Math.round(cssW * dpr));
    const pxH = Math.max(1, Math.round(cssH * dpr));
    // Only touch the backing store when it actually changes. Assigning
    // canvas.width resets the WebGPU swapchain and clears the canvas even when
    // the value is unchanged, which shows as a black frame -- and a quality
    // change calls resize() without altering the CSS size at all.
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;

    const renderW = Math.max(1, Math.round(pxW * state.qualityScale));
    const renderH = Math.max(1, Math.round(pxH * state.qualityScale));

    createTargets(renderW, renderH);

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
      // Model-explorer: spherical orbit driven by drag (with easing/inertia)
      // plus a gentle idle spin when the user isn't touching it.
      const o = state.orbit;
      // Gentle idle spin after a couple of seconds of no interaction; folded
      // into the target so there's no snap when the user grabs it again.
      // The idle spin and progressive accumulation are mutually exclusive: a
      // turning camera can never settle. Sharpening wins for a model viewer.
      if (!rm && !state.accumOn && state.pointers.size === 0
          && nowMs - state.lastInteract > 2500) {
        o.tyaw += 0.0016;
      }
      o.tpitch = Math.max(-1.45, Math.min(1.45, o.tpitch));
      o.yaw += (o.tyaw - o.yaw) * 0.18 + o.vyaw;
      o.pitch += (o.tpitch - o.pitch) * 0.18 + o.vpitch;
      o.vyaw *= 0.9; o.vpitch *= 0.9;
      o.pitch = Math.max(-1.45, Math.min(1.45, o.pitch));
      const cp = Math.cos(o.pitch);
      // dir points target -> eye, so the eye rides a sphere about the pivot.
      const dir = orbitDir(o);
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

    // Fractal parameter morphing.
    const power = rm ? 8.0 : 8.0 + Math.sin(t * 0.15) * 1.0; // breathe 7..9

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
    d[U.fov] = 1.05; // radians

    d[U.camTarget] = tgtX;
    d[U.camTarget + 1] = tgtY;
    d[U.camTarget + 2] = tgtZ;

    d[U.fractalType] = state.fractalType;
    d[U.power] = power;
    d[U.mbScale] = -1.85;
    d[U.mbMinRadius] = 0.35;
    d[U.mbFixedRadius] = 1.0;

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
      [d[U.camTarget], d[U.camTarget + 1], d[U.camTarget + 2]], [0, 1, 0]);
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
                    && state.fractalType <= FRACTAL_IDS.kleinian;
    if (doProbe) {
      state.probeAt = nowMs;
      const cpass = encoder.beginComputePass();
      cpass.setPipeline(state.pipelines.probe);
      cpass.setBindGroup(0, state.bindGroups.probe);
      cpass.dispatchWorkgroups(1);
      cpass.end();
      encoder.copyBufferToBuffer(state.probeBuffer, 0, state.probeStaging, 0, 8);
    }

    // Pass 1: raymarch -> sceneTex
    if (drawScene) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: T.sceneView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(state.pipelines.raymarch);
      pass.setBindGroup(0, state.bindGroups.raymarch);
      pass.draw(3);

      // Attractors: rasterize the trajectory as additive line geometry over
      // the background the raymarch pass just wrote.
      if (state.fractalType >= FRACTAL_IDS.attractor && state.trajBuffer) {
        pass.setPipeline(state.pipelines.attractor);
        pass.setBindGroup(0, state.bindGroups.raymarch);
        pass.setVertexBuffer(0, state.trajBuffer);
        pass.draw(state.trajCount);
      }
      pass.end();
    }

    // Pass 1b: fold the jittered frame into the running average.
    if (acc && drawScene) {
      const dst = state.accumParity === 0 ? T.accumBView : T.accumAView;
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: dst, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      pass.setPipeline(state.pipelines.accum);
      pass.setBindGroup(0, state.bindGroups.accum[state.accumParity]);
      pass.draw(3);
      pass.end();
    }

    // Pass 2: bloom horizontal -> bloomA. Sources the average while
    // accumulating, the raw scene otherwise.
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: T.bloomAView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(state.pipelines.bloomH);
      pass.setBindGroup(0, acc ? state.bindGroups.bloomHFrom[par] : state.bindGroups.bloomH);
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
    // Pass 4: composite -> swapchain
    {
      let view;
      try {
        view = state.context.getCurrentTexture().createView();
      } catch (e) {
        return; // context not ready (e.g. zero-size) — skip frame
      }
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      pass.setPipeline(state.pipelines.composite);
      pass.setBindGroup(0, acc ? state.bindGroups.compositeFrom[par] : state.bindGroups.composite);
      pass.draw(3);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);

    if (acc && drawScene) {
      state.accumSamples += 1;
      state.accumParity ^= 1;
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

  // ---- Adaptive quality (auto mode only) ----
  function adaptQuality(dtMs) {
    if (state.qualityMode !== 'auto') return;
    const fps = 1000 / Math.max(dtMs, 1);
    // EMA smoothing.
    state.fpsEMA = state.fpsEMA * 0.9 + fps * 0.1;

    if (state.fpsEMA < 50) {
      state.slowFrames++;
      state.fastFrames = 0;
    } else if (state.fpsEMA > 58) {
      state.fastFrames++;
      state.slowFrames = 0;
    } else {
      state.slowFrames = 0;
      state.fastFrames = 0;
    }

    const MIN_SCALE = 0.4;
    const MAX_SCALE = 1.0;

    // Hysteresis: require sustained slow/fast before changing.
    if (state.slowFrames > 45 && state.qualityScale > MIN_SCALE) {
      state.qualityScale = Math.max(MIN_SCALE, state.qualityScale - 0.15);
      state.slowFrames = 0;
      resize();
    } else if (state.fastFrames > 120 && state.qualityScale < MAX_SCALE) {
      state.qualityScale = Math.min(MAX_SCALE, state.qualityScale + 0.1);
      state.fastFrames = 0;
      resize();
    }
  }

  // ---- Render loop ----
  function loop(nowMs) {
    if (!state.running || state.disposed) return;

    const dt = state.lastFrameTime ? nowMs - state.lastFrameTime : 16.7;
    state.lastFrameTime = nowMs;

    state.frameDt = dt;

    // Averaging a moving image smears it, so the animation clock stops once the
    // view settles and resumes the moment anything is touched.
    if (accumulating(nowMs)) {
      renderFrame(nowMs, false);
      // Deliberately not sampled by adaptQuality. A converged frame skips the
      // raymarch entirely, so its cost says nothing about whether the renderer
      // can sustain the interactive frame rate. Feeding those frames to the
      // controller reads as headroom, raises quality, and the resize that
      // follows resets the average -- which drops the frame rate again and
      // oscillates, flickering on every change.
      state.rafId = requestAnimationFrame(loop);
      return;
    }

    if (!reducedMotion()) {
      state.animTime += dt / 1000;
      // Ease parallax toward target.
      state.parallax.x += (state.parallax.tx - state.parallax.x) * 0.05;
      state.parallax.y += (state.parallax.ty - state.parallax.y) * 0.05;
    }

    renderFrame(nowMs, false);
    adaptQuality(dt);

    state.rafId = requestAnimationFrame(loop);
  }

  // ---- Lifecycle ----
  function start() {
    if (state.running || state.disposed) return;
    // Under reduced-motion we normally render a single static pose. But when
    // interactive controls are on (explorer mode), keep the loop alive so
    // drag/pinch/zoom stay smooth — we just don't auto-animate parameters.
    if (reducedMotion() && !state.controls) {
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

  function clampDist(d) {
    const baseR = CAM_RADIUS[state.fractalType] ?? 2.55;
    return Math.max(baseR * DIST_MIN_F, Math.min(baseR * DIST_MAX_F, d));
  }

  // Unit vector target -> eye for the current orbit angles.
  function orbitDir(o) {
    const cp = Math.cos(o.pitch);
    return [Math.cos(o.yaw) * cp, Math.sin(o.pitch), Math.sin(o.yaw) * cp];
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
  function accumulating(nowMs) {
    if (!state.accumOn || !state.controls) return false;
    if (state.keys.size > 0) return false;
    if (state.pointers.size > 0) return false;
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
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    state.lastInteract = performance.now();
    state.accumSamples = 0;
    if (state.pointers.size === 1) {
      // Begin a fresh gesture; remember where, to distinguish tap from drag.
      state.gestureMoved = false;
      state.gestureMulti = false;
      state.tapStart = { x: e.clientX, y: e.clientY };
    }
    if (state.pointers.size >= 2) {
      // A second finger means this is a pinch, never a tap.
      state.gestureMulti = true;
      state.pinchDist0 = pinchDistance();
      state.pinchZoom0 = state.orbit.dist;
    }
  }

  function onPointerMove(e) {
    if (!state.controls || !state.pointers.has(e.pointerId)) return;
    const prev = state.pointers.get(e.pointerId);
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    state.lastInteract = performance.now();
    state.accumSamples = 0;

    const k = 3.2 / Math.max(300, Math.min(window.innerWidth, window.innerHeight));

    if (state.pointers.size >= 2) {
      if (state.fly) {
        // Two fingers: spread to move forward, pinch to back up. Zoom is
        // meaningless when the camera is already free to travel.
        const dist = pinchDistance();
        if (state.pinchDist0 > 0 && dist > 0) {
          dollyFlyCamera(state.flyCam,
            (dist - state.pinchDist0) * 0.0025 * (CAM_RADIUS[state.fractalType] ?? 2.55));
          state.pinchDist0 = dist;
        }
      } else {
        // Pinch: fingers apart -> zoom in (smaller radius).
        const dist = pinchDistance();
        if (state.pinchDist0 > 0 && dist > 0) {
          const want = state.pinchZoom0 * (state.pinchDist0 / dist);
          if (want < state.orbit.dist) repinOrbitTarget();
          state.orbit.dist = clampDist(want);
        }
      }
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
      const baseR = CAM_RADIUS[state.fractalType] ?? 2.55;
      const ok = k * orbitDragScale(state.orbit.dist / baseR, state.orbit.pinned);
      state.orbit.tyaw += dx * ok;
      state.orbit.tpitch += dy * ok;
      state.orbit.vyaw = dx * ok * 0.15;
      state.orbit.vpitch = dy * ok * 0.15;
      if (state.tapStart &&
          Math.hypot(e.clientX - state.tapStart.x, e.clientY - state.tapStart.y) > TAP_MOVE) {
        state.gestureMoved = true;
      }
    }
    nudgeRender();
  }

  function onPointerUp(e) {
    if (!state.pointers.has(e.pointerId)) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    state.pointers.delete(e.pointerId);
    state.lastInteract = performance.now();

    if (state.pointers.size === 1) {
      // Dropped from a pinch to one finger: continuing as a drag, not a tap.
      state.gestureMoved = true;
      const remaining = [...state.pointers.values()][0];
      state.tapStart = { x: remaining.x, y: remaining.y };
    } else if (state.pointers.size === 0) {
      // Gesture fully ended. A clean single-finger tap (no movement, no pinch)
      // counts toward double-tap-to-reset — a pinch release never does.
      if (state.controls && !state.gestureMoved && !state.gestureMulti) {
        const now = performance.now();
        if (now - state.tapTime < 320) { resetView(); state.tapTime = 0; }
        else { state.tapTime = now; }
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

    // Device-lost handling: try one re-init, then fall back.
    device.lost.then((info) => {
      if (state.disposed) return;
      // 'destroyed' reason means we tore it down intentionally.
      if (info.reason === 'destroyed') return;
      console.warn('[fractal-bg] device lost:', info.message);
      if (!state._reinitAttempted) {
        state._reinitAttempted = true;
        reinit();
      } else {
        opts.onUnsupported('WebGPU device lost and re-init failed');
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
    if (state.qualityMode === 'auto') {
      state.qualityScale = pickAutoQuality();
    } else {
      state.qualityScale = QUALITY_SCALE[state.qualityMode] ?? 1.0;
    }

    createStaticResources();
    resize();
    if (state.fractalType >= FRACTAL_IDS.attractor) ensureAttractorTrajectory();
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

  function pickAutoQuality() {
    // Heuristic from viewport, DPR, pointer type.
    const px = window.innerWidth * (window.devicePixelRatio || 1);
    if (coarsePointer || px < 900) return 0.5;
    if (px < 1700) return 0.7;
    return 0.9;
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

  // Both camera modes need the same things switched on, and they are mutually
  // exclusive. Deriving that from the flags in one place means callers cannot
  // get the ordering wrong -- an earlier version had setFly enable navigation
  // and a following setExplorer(false) immediately turn it back off.
  function applyCameraMode() {
    const interactive = state.fly || state.explorer;
    applyControls(interactive);
    state.accumSamples = 0;
    applyTransparent(interactive ? false : !!opts.transparent);
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

  function resetView() {
    const o = state.orbit;
    o.tyaw = 0.6; o.tpitch = 0.35; o.vyaw = 0; o.vpitch = 0;
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
        state.fractalType = FRACTAL_IDS[name];
        // Reframe the free camera for the new model's world scale.
        state.probeDist = Infinity;
        state.probeHit = -1;
        state.accumSamples = 0;
        if (state.fly) placeFlyCamera(false);
        // The attractor family needs its trajectory buffer built before use.
        if (state.fractalType >= FRACTAL_IDS.attractor) ensureAttractorTrajectory();
        if (!state.running) renderFrame(performance.now(), true);
      }
    },
    setPalette(name) {
      state.palette = getPalette(name);
      state.paletteRamp = null;
      state.accumSamples = 0;
      if (!state.running) renderFrame(performance.now(), true);
    },
    setQuality(mode) {
      state.qualityMode = mode;
      state.accumSamples = 0;
      if (mode === 'auto') state.qualityScale = pickAutoQuality();
      else state.qualityScale = QUALITY_SCALE[mode] ?? 1.0;
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
      state.accumSamples = 0;
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
      state.explorer = !!on;
      if (state.explorer && state.fly) {
        state.fly = false;
        state.keys.clear();
      }
      applyCameraMode();
      resetView();
      nudgeRender();
    },
    pause() { stop(); },
    resume() { updateRunning(); },
    destroy,
    // Introspection (handy for the demo HUD).
    get info() {
      return {
        fractalType: state.fractalType,
        qualityMode: state.qualityMode,
        qualityScale: +state.qualityScale.toFixed(2),
        fps: Math.round(state.fpsEMA),
        reducedMotion: reducedMotion(),
        explorer: state.explorer,
        fly: state.fly,
        flySpeed: +state.flyCam.speed.toFixed(2),
        flyPos: state.fly ? state.flyCam.pos.map((v) => +v.toFixed(2)) : null,
        clearance: Number.isFinite(state.probeDist) ? +state.probeDist.toFixed(4) : null,
        samples: state.accumSamples,
        zoom: +(state.orbit.dist / (CAM_RADIUS[state.fractalType] ?? 2.55)).toFixed(3),
        pinned: state.orbit.pinned,
      };
    },
  };
}

export default initFractalBackground;
