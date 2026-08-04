// fractal-bg.js — self-contained WebGPU raymarched fractal background.
//
//   const handle = await initFractalBackground(canvas, options);
//
// Public handle API:
//   handle.setFractal('mandelbulb' | 'mandelbox' | 'menger' | 'julia')
//   handle.setPalette('aurora' | 'ember' | 'oil-slick' | 'mono-ice')
//   handle.setQuality('low' | 'medium' | 'high' | 'auto')
//   handle.pause() / handle.resume() / handle.destroy()
//
// No build step, no dependencies. Runs from file://. See README.md.

import { FRACTAL_WGSL } from './shaders/fractal.wgsl.js';
import { COMPOSITE_WGSL } from './shaders/composite.wgsl.js';
import { ATTRACTOR_WGSL } from './shaders/attractor.wgsl.js';
import { getPalette } from './palettes.js';

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
  _pad: 39,
  viewProj: 40, // mat4 -> slots 40..55 (byte 160, 16-byte aligned)
};
const UNIFORM_FLOATS = 56;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4; // 224

// Distance-estimated fractals occupy ids 0..9; the line-rendered
// attractors follow at 10+. The shader keys off that split (see the
// `fractalType > 9.5` test in fractal.wgsl.js), so keep DE types contiguous at
// the front when adding new ones and move the attractors up to match.
const FRACTAL_IDS = {
  mandelbulb: 0, mandelbox: 1, menger: 2, julia: 3, apollonian: 4,
  spherepack: 5, encrusted: 6, surfacepack: 7, penrose: 8,
  'penrose-sponge': 9, attractor: 10, lorenz: 11,
};

// Quality tiers -> internal-resolution scale factor.
const QUALITY_SCALE = { low: 0.5, medium: 0.7, high: 1.0, screenshot: 1.0 };

// Camera orbit distance per fractal — each estimator lives at a different
// world scale, so a single radius would sit inside the larger ones.
// Indexed by fractal id (see FRACTAL_IDS).
// mandelbulb, mandelbox, menger, julia, apollonian, spherepack, encrusted,
// surfacepack, Penrose relief, Penrose sponge, attractor(Aizawa), lorenz
// The relief disc needs extra room edge-on; the volumetric sponge uses framing
// similar to the other roughly spherical distance-estimated models.
const CAM_RADIUS = [2.55, 6.5, 3.6, 3.0, 3.0, 2.9, 3.1, 3.0, 3.5, 3.25, 3.2, 3.0];

// Number of integrated trajectory samples drawn as a line strip per attractor.
// These are exact float positions (vector geometry), so the curve stays crisp
// at any zoom — unlike a baked voxel grid, which quantizes it.
const TRAJECTORY_POINTS = 600000;

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
    zoom: 1.0,            // camera distance multiplier (pinch/wheel)
    orbit: { yaw: 0.6, pitch: 0.35, tyaw: 0.6, tpitch: 0.35, vyaw: 0, vpitch: 0 },
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

    state._bgl = { raymarchBGL, blurBGL, compositeBGL };

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

    // Cache views once — reused as render-pass attachments every frame so we
    // don't allocate per-frame.
    const sceneView = sceneTex.createView();
    const bloomAView = bloomA.createView();
    const bloomBView = bloomB.createView();

    state.targets = {
      sceneTex, bloomA, bloomB, sceneView, bloomAView, bloomBView,
      w: renderW, h: renderH,
    };

    // (Re)build bind groups that reference these views.
    const ub = { buffer: state.uniformBuffer };
    state.bindGroups.raymarch = device.createBindGroup({
      layout: state._bgl.raymarchBGL,
      entries: [{ binding: 0, resource: ub }],
    });
    state.bindGroups.bloomH = device.createBindGroup({
      layout: state._bgl.blurBGL,
      entries: [
        { binding: 0, resource: ub },
        { binding: 1, resource: state.sampler },
        { binding: 2, resource: sceneView },
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
        { binding: 3, resource: bloomBView },
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
    canvas.width = pxW;
    canvas.height = pxH;

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
    const radius = baseR * state.zoom;

    let camX, camY, camZ;
    if (state.explorer) {
      // Model-explorer: spherical orbit driven by drag (with easing/inertia)
      // plus a gentle idle spin when the user isn't touching it.
      const o = state.orbit;
      // Gentle idle spin after a couple of seconds of no interaction; folded
      // into the target so there's no snap when the user grabs it again.
      if (!rm && state.pointers.size === 0 && nowMs - state.lastInteract > 2500) {
        o.tyaw += 0.0016;
      }
      o.tpitch = Math.max(-1.45, Math.min(1.45, o.tpitch));
      o.yaw += (o.tyaw - o.yaw) * 0.18 + o.vyaw;
      o.pitch += (o.tpitch - o.pitch) * 0.18 + o.vpitch;
      o.vyaw *= 0.9; o.vpitch *= 0.9;
      o.pitch = Math.max(-1.45, Math.min(1.45, o.pitch));
      const cp = Math.cos(o.pitch);
      camX = Math.cos(o.yaw) * cp * radius;
      camY = Math.sin(o.pitch) * radius;
      camZ = Math.sin(o.yaw) * cp * radius;
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
    d[U.fov] = 1.05; // radians

    d[U.camTarget] = 0.0;
    d[U.camTarget + 1] = rm ? 0.0 : Math.sin(t * 0.05) * 0.05;
    d[U.camTarget + 2] = 0.0;

    d[U.fractalType] = state.fractalType;
    d[U.power] = power;
    d[U.mbScale] = -1.85;
    d[U.mbMinRadius] = 0.35;
    d[U.mbFixedRadius] = 1.0;

    const p = state.palette;
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

    // Pass 1: raymarch -> sceneTex
    {
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
    // Pass 2: bloom horizontal -> bloomA
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
      pass.setBindGroup(0, state.bindGroups.composite);
      pass.draw(3);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
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
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 14.0;   // large so you can pull fully outside any fractal
  const TAP_MOVE = 10;     // px of movement that disqualifies a tap
  const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

  function pinchDistance() {
    const pts = [...state.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
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
      state.pinchZoom0 = state.zoom;
    }
  }

  function onPointerMove(e) {
    if (!state.controls || !state.pointers.has(e.pointerId)) return;
    const prev = state.pointers.get(e.pointerId);
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    state.lastInteract = performance.now();

    if (state.pointers.size >= 2) {
      // Pinch: fingers apart -> zoom in (smaller radius).
      const dist = pinchDistance();
      if (state.pinchDist0 > 0 && dist > 0) {
        state.zoom = clampZoom(state.pinchZoom0 * (state.pinchDist0 / dist));
      }
    } else {
      // Single-pointer drag: orbit. Scale by viewport so it feels consistent.
      const k = 3.2 / Math.max(300, Math.min(window.innerWidth, window.innerHeight));
      state.orbit.tyaw += dx * k;
      state.orbit.tpitch += dy * k;
      state.orbit.vyaw = dx * k * 0.15;
      state.orbit.vpitch = dy * k * 0.15;
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
    e.preventDefault();
    state.zoom = clampZoom(state.zoom * (e.deltaY > 0 ? 1.1 : 0.9));
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
    try {
      if (state.targets) {
        state.targets.sceneTex.destroy();
        state.targets.bloomA.destroy();
        state.targets.bloomB.destroy();
      }
      state.trajBuffer && state.trajBuffer.destroy();
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
    state.zoom = 1.0;
    const o = state.orbit;
    o.tyaw = 0.6; o.tpitch = 0.35; o.vyaw = 0; o.vpitch = 0;
    state.lastInteract = performance.now();
    nudgeRender();
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

  isVisible = document.visibilityState === 'visible';
  updateRunning();

  // ---- Public handle ----
  return {
    setFractal(name) {
      if (name in FRACTAL_IDS) {
        state.fractalType = FRACTAL_IDS[name];
        // The attractor family needs its trajectory buffer built before use.
        if (state.fractalType >= FRACTAL_IDS.attractor) ensureAttractorTrajectory();
        if (!state.running) renderFrame(performance.now(), true);
      }
    },
    setPalette(name) {
      state.palette = getPalette(name);
      if (!state.running) renderFrame(performance.now(), true);
    },
    setQuality(mode) {
      state.qualityMode = mode;
      if (mode === 'auto') state.qualityScale = pickAutoQuality();
      else state.qualityScale = QUALITY_SCALE[mode] ?? 1.0;
      resize();
    },
    setTransparent(v) { applyTransparent(v); },
    // Enable drag/pinch/wheel navigation without the full explorer preset.
    setControls(on) { applyControls(on); },
    setAutoOrbit(on) { state.autoOrbit = !!on; nudgeRender(); },
    // Camera distance multiplier (1 = default framing). Also see resetView().
    setZoom(z) { state.zoom = clampZoom(z); nudgeRender(); },
    zoomBy(factor) { state.zoom = clampZoom(state.zoom * factor); nudgeRender(); },
    resetView,
    // Model-explorer preset: opaque background, no auto-drift, full navigation.
    // Turning it off restores the original (background) configuration.
    setExplorer(on) {
      state.explorer = !!on;
      state.autoOrbit = !on;
      applyControls(!!on);
      applyTransparent(on ? false : !!opts.transparent);
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
        zoom: +state.zoom.toFixed(2),
      };
    },
  };
}

export default initFractalBackground;
