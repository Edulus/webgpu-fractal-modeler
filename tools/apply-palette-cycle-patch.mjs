// Temporary branch-only migration helper. Applies the palette-faithful cycle
// renderer refactor with asserted replacements, then is deleted once CI proves
// the generated source. It is deliberately idempotent so a workflow rerun is
// harmless.
import fs from 'node:fs';

function replaceOnce(text, oldText, newText, label) {
  if (text.includes(newText)) return text; // already applied
  const first = text.indexOf(oldText);
  if (first < 0) throw new Error(`patch target missing: ${label}`);
  if (text.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`patch target not unique: ${label}`);
  }
  return text.slice(0, first) + newText + text.slice(first + oldText.length);
}

function replaceRegexOnce(text, re, replacement, label) {
  if (!re.test(text)) {
    if (text.includes(replacement)) return text;
    throw new Error(`patch target missing: ${label}`);
  }
  re.lastIndex = 0;
  return text.replace(re, replacement);
}

const path = 'src/fractal-bg.js';
let s = fs.readFileSync(path, 'utf8');

s = replaceOnce(s,
`import { FRACTAL_WGSL } from './shaders/fractal.wgsl.js';
import { COMPOSITE_WGSL } from './shaders/composite.wgsl.js';`,
`import { FRACTAL_WGSL } from './shaders/fractal.wgsl.js';
import { MATERIAL_WGSL } from './shaders/material.wgsl.js';
import { COMPOSITE_WGSL } from './shaders/composite.wgsl.js';`,
'import material shader');

s = replaceOnce(s,
`  colorCycle: 62,   // palette cycles per second; 0 = static
  _pad3: 63,        // pads the ramp array to a 16-byte boundary`,
`  colorCycle: 62,   // palette cycles per second; 0 = static
  colorPhase: 63,   // live palette-coordinate offset, in turns`,
'color phase uniform');

s = replaceOnce(s,
`    // Palette cycles per second. One full turn of hue every 40s by default.
    colorCycle: opts.colorCycle ?? 0.025,
    // Neutral by default, so the shipped image is unchanged.
    image: { exposure: 1, contrast: 1, saturation: 1, hue: 0 },
    accumParity: 0,
    accumOn: true,`,
`    // Palette cycles per second. Phase advances independently of the geometry
    // clock so it keeps moving after progressive accumulation has converged.
    colorCycle: opts.colorCycle ?? 0.025,
    colorPhase: 0,
    // Neutral by default, so the shipped image is unchanged.
    image: { exposure: 1, contrast: 1, saturation: 1, hue: 0 },
    accumOn: true,`,
'cycle state');

const staticResources = `  function createStaticResources() {
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
  }`;

s = replaceRegexOnce(s,
/  function createStaticResources\(\) \{[\s\S]*?\n  \}\n\n  \/\/ ---- Offscreen render targets/,
staticResources + `\n\n  // ---- Offscreen render targets`,
'createStaticResources');

const createTargets = `  function createTargets(renderW, renderH) {
    const device = state.device;
    if (state.targets) {
      state.targets.sceneTex.destroy();
      state.targets.auxTex.destroy();
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

    // Two full-resolution material attachments replace RGB + two accumulation
    // ping-pong textures. They are averaged in place by blend constants.
    const sceneTex = mk(renderW, renderH);
    const auxTex = mk(renderW, renderH);
    const bloomA = mk(bw, bh);
    const bloomB = mk(bw, bh);

    const sceneView = sceneTex.createView();
    const auxView = auxTex.createView();
    const bloomAView = bloomA.createView();
    const bloomBView = bloomB.createView();

    state.targets = {
      sceneTex, auxTex, bloomA, bloomB,
      sceneView, auxView, bloomAView, bloomBView,
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
      ],
    });
  }`;

s = replaceRegexOnce(s,
/  function createTargets\(renderW, renderH\) \{[\s\S]*?\n  \}\n\n  \/\/ ---- Strange attractors/,
createTargets + `\n\n  // ---- Strange attractors`,
'createTargets');

s = replaceOnce(s,
`    // Cycles per second. Read by the COMPOSITE pass, not the raymarch, so
    // changing it never invalidates the accumulated image -- which is the whole
    // point: the colour keeps moving on a frame that has already converged.
    d[U.colorCycle] = state.colorCycle;`,
`    // The rate remains public API state; the composite shader consumes the
    // integrated phase. Separating this clock from animTime is what lets colour
    // keep moving while geometry is frozen for progressive accumulation.
    d[U.colorCycle] = state.colorCycle;
    d[U.colorPhase] = rm ? 0.0 : state.colorPhase;`,
'write color phase');

s = replaceOnce(s,
`    // Which accumulation half this frame writes; the other holds the average so
    // far. When idle-converged, keep reading the half last written.
    const par = acc ? (state.accumParity ^ (converged ? 1 : 0)) : 0;
`,
``,
'remove accumulation parity');

const oldPasses = `    // Pass 1: raymarch -> sceneTex
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
`;

const newPasses = `    // Pass 1: raymarch -> palette-independent material attachments. While
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
      if (state.fractalType >= FRACTAL_IDS.attractor && state.trajBuffer) {
        pass.setPipeline(state.pipelines.attractor);
        pass.setBindGroup(0, state.bindGroups.raymarch);
        pass.setVertexBuffer(0, state.trajBuffer);
        pass.draw(state.trajCount);
      }
      pass.end();
    }
`;

s = replaceOnce(s, oldPasses, newPasses, 'material render pass');

s = replaceOnce(s,
`      pass.setPipeline(state.pipelines.bloomH);
      pass.setBindGroup(0, acc ? state.bindGroups.bloomHFrom[par] : state.bindGroups.bloomH);`,
`      pass.setPipeline(state.pipelines.bloomH);
      pass.setBindGroup(0, state.bindGroups.bloomH);`,
'bloom source');

s = replaceOnce(s,
`      pass.setPipeline(state.pipelines.composite);
      pass.setBindGroup(0, acc ? state.bindGroups.compositeFrom[par] : state.bindGroups.composite);`,
`      pass.setPipeline(state.pipelines.composite);
      pass.setBindGroup(0, state.bindGroups.composite);`,
'composite source');

s = replaceOnce(s,
`    if (acc && drawScene) {
      state.accumSamples += 1;
      state.accumParity ^= 1;
    }`,
`    if (acc && drawScene) {
      state.accumSamples += 1;
    }`,
'accumulation count');

const oldLoop = `  function loop(nowMs) {
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
  }`;

const newLoop = `  function loop(nowMs) {
    if (!state.running || state.disposed) return;

    const dt = state.lastFrameTime ? nowMs - state.lastFrameTime : 16.7;
    state.lastFrameTime = nowMs;
    state.frameDt = dt;

    const acc = accumulating(nowMs);
    if (!reducedMotion()) {
      // Palette phase has its own clock: it remains live on a converged frame.
      // Geometry time still freezes while accumulating, so the material samples
      // describe one stable scene instead of smearing animation together.
      state.colorPhase = (state.colorPhase + (dt / 1000) * state.colorCycle) % 1;
      if (!acc) {
        state.animTime += dt / 1000;
        state.parallax.x += (state.parallax.tx - state.parallax.x) * 0.05;
        state.parallax.y += (state.parallax.ty - state.parallax.y) * 0.05;
      }
    }

    if (acc) {
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
  }`;

s = replaceOnce(s, oldLoop, newLoop, 'render loop clocks');

s = replaceOnce(s,
`      if (state.targets) {
        state.targets.sceneTex.destroy();
        state.targets.bloomA.destroy();
        state.targets.bloomB.destroy();
      }`,
`      if (state.targets) {
        state.targets.sceneTex.destroy();
        state.targets.auxTex.destroy();
        state.targets.bloomA.destroy();
        state.targets.bloomB.destroy();
      }`,
'destroy material targets');

s = replaceOnce(s,
`      if (state.targets) {
        state.targets.accumA.destroy();
        state.targets.accumB.destroy();
      }
`,
``,
'remove accumulation texture destroy');

s = replaceOnce(s,
`    setPalette(name) {
      state.palette = getPalette(name);
      state.paletteRamp = null;
      state.accumSamples = 0;
      if (!state.running) renderFrame(performance.now(), true);
    },`,
`    setPalette(name) {
      state.palette = getPalette(name);
      state.paletteRamp = null;
      // Material accumulation is palette-independent: recolour the converged
      // frame immediately rather than throwing away 96 geometry samples.
      if (!state.running) renderFrame(performance.now(), true);
    },`,
'palette switch preserves accumulation');

s = replaceOnce(s,
`      state.accumSamples = 0;
      nudgeRender();
      return true;
    },

    // Progressive accumulation.`,
`      // Imported ramps are resolved from the same stored coordinates as cosine
      // presets, so changing one also preserves a converged material buffer.
      nudgeRender();
      return true;
    },

    // Progressive accumulation.`,
'imported palette preserves accumulation');

// The old state comment is now actively misleading.
s = s.replace(
`    targets: null, // { sceneTex, bloomA, bloomB, w, h }`,
`    targets: null, // { sceneTex, auxTex, bloomA, bloomB, w, h }`);

fs.writeFileSync(path, s);

// Resolve miss/background coverage from aux.w at presentation time. The shader
// was added before this last representation tweak, so patch it here with an
// asserted replacement too.
const compPath = 'src/shaders/composite.wgsl.js';
let c = fs.readFileSync(compPath, 'utf8');
c = replaceOnce(c,
`  let bg = backgroundColor(uv);
  var color = bg * a.x;`,
`  let bg = backgroundColor(uv);
  let missBg = select(0.0, a.w, u.bgMode >= 0.5);
  var color = bg * (a.x + missBg);`,
'post-resolve background coverage');
fs.writeFileSync(compPath, c);

console.log('palette-faithful renderer patch applied');
