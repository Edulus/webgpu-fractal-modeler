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
import { getPalette } from './palettes.js';

// ---- Uniform buffer layout (mirror of the WGSL Uniforms struct) -----------
// 40 f32 slots = 160 bytes. Byte offset = slot * 4.
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
};
const UNIFORM_FLOATS = 40;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4; // 160

const FRACTAL_IDS = { mandelbulb: 0, mandelbox: 1, menger: 2, julia: 3 };

// Quality tiers -> internal-resolution scale factor.
const QUALITY_SCALE = { low: 0.5, medium: 0.7, high: 1.0, screenshot: 1.0 };

// Camera orbit distance per fractal — each estimator lives at a different
// world scale, so a single radius would sit inside the larger ones.
// Indexed by fractal id (see FRACTAL_IDS).
const CAM_RADIUS = [2.55, 6.5, 3.6, 3.0]; // mandelbulb, mandelbox, menger, julia

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
  };
  state.uniformU32 = new Uint32Array(state.uniformData.buffer);

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
    const uniformOnlyBGL = device.createBindGroupLayout({
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

    state._bgl = { uniformOnlyBGL, blurBGL, compositeBGL };

    // Raymarch pipeline -> HDR target.
    state.pipelines.raymarch = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [uniformOnlyBGL] }),
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
      layout: state._bgl.uniformOnlyBGL,
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

    // Orbital Lissajous drift, always looking near origin. Distance and bob
    // scale with the selected fractal's world size so it always frames well.
    const radius = CAM_RADIUS[state.fractalType] ?? 2.55;
    const ax = rm ? 0.9 : t * 0.09;
    const ay = rm ? 0.55 : t * 0.063;
    // Parallax nudge (disabled under reduced motion), scaled to distance.
    const px = rm ? 0 : state.parallax.x * radius * 0.2;
    const py = rm ? 0 : state.parallax.y * radius * 0.16;

    const camX = Math.cos(ax) * radius + px;
    const camY = Math.sin(ay) * (radius * 0.35) + radius * 0.06 + py;
    const camZ = Math.sin(ax) * radius;

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
    if (reducedMotion()) {
      // Static pose: render once, do not spin rAF.
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
    if (reducedMotion()) renderFrame(performance.now(), true);
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
    try {
      if (state.targets) {
        state.targets.sceneTex.destroy();
        state.targets.bloomA.destroy();
        state.targets.bloomB.destroy();
      }
      state.uniformBuffer && state.uniformBuffer.destroy();
      state.device && state.device.destroy();
    } catch (e) {
      /* ignore */
    }
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

  isVisible = document.visibilityState === 'visible';
  updateRunning();

  // ---- Public handle ----
  return {
    setFractal(name) {
      if (name in FRACTAL_IDS) {
        state.fractalType = FRACTAL_IDS[name];
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
    setTransparent(v) {
      state.transparent = !!v;
      state.context.configure({
        device: state.device,
        format: state.format,
        alphaMode: state.transparent ? 'premultiplied' : 'opaque',
      });
      if (!state.running) renderFrame(performance.now(), true);
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
      };
    },
  };
}

export default initFractalBackground;
