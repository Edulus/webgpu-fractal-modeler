// Per-shape mathematical controls for the Shape Explorer.
//
// The renderer's existing imageAdjust vec4 is transported as four exact 23-bit
// integers. Each integer packs one image-adjustment value and one normalized
// model parameter, allowing shape controls to ride the existing uniform layout
// without expanding the WebGPU buffer or disturbing the public image controls.

const PACK_FLAG = 4194304; // 2^22
const PACK_BASE = 2048;    // 11 bits per value
const PACK_MAX = PACK_BASE - 1;

export const IMAGE_RANGES = Object.freeze({
  exposure: [0.2, 3],
  contrast: [0.5, 2],
  saturation: [0, 2],
  hue: [0, 1],
});

const generic = (scale, twist, stretch, warp) => [
  { key: 'scale', label: scale, min: 0.65, max: 1.35, step: 0.01, default: 1 },
  { key: 'twist', label: twist, min: -2, max: 2, step: 0.02, default: 0 },
  { key: 'stretch', label: stretch, min: 0.65, max: 1.35, step: 0.01, default: 1 },
  { key: 'warp', label: warp, min: -0.3, max: 0.3, step: 0.005, default: 0 },
];

export const MODEL_PARAMETERS = Object.freeze({
  mandelbulb: [
    { key: 'power', label: 'Power', min: 2, max: 12, step: 0.05, default: 8 },
    { key: 'twist', label: 'Axial twist', min: -2.5, max: 2.5, step: 0.025, default: 0 },
    { key: 'stretch', label: 'Vertical stretch', min: 0.6, max: 1.4, step: 0.01, default: 1 },
    { key: 'warp', label: 'Radial warp', min: -0.25, max: 0.25, step: 0.005, default: 0 },
  ],
  mandelbox: [
    { key: 'foldScale', label: 'Fold scale', min: -3, max: -1, step: 0.01, default: -1.85 },
    { key: 'minRadius', label: 'Minimum radius', min: 0.1, max: 0.8, step: 0.005, default: 0.35 },
    { key: 'fixedRadius', label: 'Fixed radius', min: 0.5, max: 1.5, step: 0.01, default: 1 },
    { key: 'warp', label: 'Axis warp', min: -0.3, max: 0.3, step: 0.005, default: 0 },
  ],
  menger: generic('Cell scale', 'Cross twist', 'Vertical stretch', 'Bore warp'),
  julia: generic('Julia scale', 'Orbit twist', 'Vertical stretch', 'Slice warp'),
  apollonian: generic('Packing scale', 'Packing twist', 'Axial stretch', 'Gap warp'),
  spherepack: generic('Nest scale', 'Shell twist', 'Axial stretch', 'Tangency warp'),
  encrusted: generic('Bloom scale', 'Polar twist', 'Polar stretch', 'Crust warp'),
  surfacepack: generic('Stud scale', 'Lattice twist', 'Body stretch', 'Surface warp'),
  penrose: generic('Disc scale', 'Tiling twist', 'Disc stretch', 'Tile warp'),
  gyroid: generic('Cell scale', 'Labyrinth twist', 'Vertical stretch', 'Surface warp'),
  kleinian: generic('Group scale', 'Inversion twist', 'Axial stretch', 'Limit-set warp'),
  barth: generic('Sextic scale', 'Icosahedral twist', 'Vertical stretch', 'Node warp'),
  schottky: generic('Sphere scale', 'Generator twist', 'Axial stretch', 'Tangency warp'),
  schottkyh: generic('Separation scale', 'Hyperbolic twist', 'Axial stretch', 'Gap warp'),
  tetrabrot: generic('Bicomplex scale', 'Cross twist', 'Vertical stretch', 'Slice warp'),
  envoct: generic('Envelope scale', 'Spike twist', 'Axial stretch', 'Face warp'),
  envdodec: generic('Envelope scale', 'Golden twist', 'Axial stretch', 'Face warp'),
  hyp534: generic('Ball scale', 'Geodesic twist', 'Vertical stretch', 'Boundary warp'),
  hyp534t: generic('Cell scale', 'Truncation twist', 'Vertical stretch', 'Boundary warp'),
  hyp534o: generic('Cell scale', 'Omni twist', 'Vertical stretch', 'Boundary warp'),
  hyp435: generic('Ball scale', 'Cubic twist', 'Vertical stretch', 'Boundary warp'),
  hyp435t: generic('Cell scale', 'Truncation twist', 'Vertical stretch', 'Boundary warp'),
  hyp435o: generic('Cell scale', 'Omni twist', 'Vertical stretch', 'Boundary warp'),
  kleinpack: generic('Packing scale', 'Reflection twist', 'Axial stretch', 'Horoball warp'),
  engel: generic('Cell scale', 'Tiling twist', 'Vertical stretch', 'Face warp'),
  attractor: generic('Trajectory scale', 'Coil twist', 'Vertical spread', 'Orbit warp'),
  lorenz: generic('Butterfly scale', 'Lobe twist', 'Vertical spread', 'Wing warp'),
  rossler: generic('Spiral scale', 'Fold twist', 'Vertical spread', 'Spiral warp'),
  cosmicweb: generic('Web scale', 'Filament twist', 'Vertical stretch', 'Void warp'),
  ziggurat: generic('Terrace scale', 'Chevron twist', 'Height stretch', 'Ring warp'),
  cubestack: generic('Cube scale', 'Funnel twist', 'Axis stretch', 'Well warp'),
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(v)));
}

export function defaultValuesFor(shape) {
  const schema = MODEL_PARAMETERS[shape] || [];
  return Object.fromEntries(schema.map((p) => [p.key, p.default]));
}

export function normalizedValuesFor(shape, values = {}) {
  const schema = MODEL_PARAMETERS[shape] || [];
  return schema.map((p) => {
    const value = values[p.key] === undefined ? p.default : clamp(values[p.key], p.min, p.max);
    return (value - p.min) / (p.max - p.min);
  });
}

function encode11(value, lo, hi) {
  const t = (clamp(value, lo, hi) - lo) / (hi - lo);
  return Math.round(t * PACK_MAX);
}

function decode11(code, lo, hi) {
  return lo + (hi - lo) * (Math.max(0, Math.min(PACK_MAX, code)) / PACK_MAX);
}

export function packImageAndModel(image, modelNorm) {
  const keys = ['exposure', 'contrast', 'saturation', 'hue'];
  const out = {};
  for (let i = 0; i < 4; i++) {
    const key = keys[i];
    const [lo, hi] = IMAGE_RANGES[key];
    const imageCode = encode11(image[key], lo, hi);
    const modelCode = Math.round(clamp(modelNorm[i] ?? 0.5, 0, 1) * PACK_MAX);
    out[key] = PACK_FLAG + imageCode + modelCode * PACK_BASE;
  }
  return out;
}

// Test/debug helper; production decoding happens in WGSL.
export function unpackChannel(packed, imageKey) {
  const [lo, hi] = IMAGE_RANGES[imageKey];
  if (!(packed >= PACK_FLAG)) return { image: Number(packed), model: 0.5, packed: false };
  const q = Math.round(packed - PACK_FLAG);
  const imageCode = q % PACK_BASE;
  const modelCode = Math.floor(q / PACK_BASE);
  return {
    image: decode11(imageCode, lo, hi),
    model: modelCode / PACK_MAX,
    packed: true,
  };
}

function decimalsFor(step) {
  const s = String(step);
  return s.includes('.') ? s.length - s.indexOf('.') - 1 : 0;
}

function formatValue(param, value) {
  return Number(value).toFixed(Math.min(3, decimalsFor(param.step)));
}

function installStyle() {
  if (document.getElementById('model-param-style')) return;
  const style = document.createElement('style');
  style.id = 'model-param-style';
  style.textContent = `
    #model-io { color: var(--muted); font-size: 12px; }
    #model-io summary { cursor: pointer; padding: 2px 0; color: var(--muted); }
    #model-io > *:not(summary) { margin-top: 7px; }
    #model-param-list { display: grid; gap: 7px; }
    #model-param-list label { gap: 2px; }
    .model-param-head { display: flex; justify-content: space-between; gap: 8px; }
    .model-param-head output { color: var(--fg); font-variant-numeric: tabular-nums; }
    #model-param-reset { margin-top: 8px; }
  `;
  document.head.appendChild(style);
}

/** Install the dynamic Shape parameters panel and extend window.fractalHandle. */
export function installModelParameterControls() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const select = document.getElementById('sel-fractal');
  if (!select || document.getElementById('model-io')) return;

  installStyle();

  const details = document.createElement('details');
  details.id = 'model-io';
  details.open = !window.matchMedia('(max-width: 640px)').matches;
  const summary = document.createElement('summary');
  summary.textContent = 'Shape parameters…';
  const list = document.createElement('div');
  list.id = 'model-param-list';
  const reset = document.createElement('button');
  reset.id = 'model-param-reset';
  reset.type = 'button';
  reset.textContent = 'Reset shape';
  details.append(summary, list, reset);

  const shapeLabel = select.closest('label');
  shapeLabel.insertAdjacentElement('afterend', details);

  let handle = null;
  let activeShape = select.value;
  let imageState = { exposure: 1, contrast: 1, saturation: 1, hue: 0 };
  let accumulateOn = true;
  const shapeState = new Map();

  function valuesFor(shape) {
    if (!shapeState.has(shape)) shapeState.set(shape, defaultValuesFor(shape));
    return shapeState.get(shape);
  }

  function render(shape) {
    activeShape = shape;
    list.replaceChildren();
    const schema = MODEL_PARAMETERS[shape] || [];
    const values = valuesFor(shape);
    for (const param of schema) {
      const label = document.createElement('label');
      label.className = 'slider';
      const head = document.createElement('span');
      head.className = 'model-param-head';
      const name = document.createElement('span');
      name.textContent = param.label;
      const output = document.createElement('output');
      output.textContent = formatValue(param, values[param.key]);
      head.append(name, output);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(param.min);
      input.max = String(param.max);
      input.step = String(param.step);
      input.value = String(values[param.key]);
      input.disabled = !handle;
      input.setAttribute('aria-label', `${param.label} for ${shape}`);
      input.addEventListener('input', () => {
        const value = clamp(input.value, param.min, param.max);
        values[param.key] = value;
        output.textContent = formatValue(param, value);
        if (handle && typeof handle.setModelParams === 'function') {
          handle.setModelParams({ [param.key]: value });
        }
      });
      label.append(head, input);
      list.appendChild(label);
    }
    reset.disabled = !handle;
  }

  function wireHandle(nextHandle) {
    if (!nextHandle || handle) return;
    handle = nextHandle;

    const originalSetImageAdjust = handle.setImageAdjust.bind(handle);
    const originalSetFractal = handle.setFractal.bind(handle);
    const originalSetAccumulate = handle.setAccumulate.bind(handle);
    const infoDescriptor = Object.getOwnPropertyDescriptor(handle, 'info');
    if (infoDescriptor && typeof infoDescriptor.get === 'function') {
      const originalInfo = infoDescriptor.get;
      const initial = originalInfo.call(handle);
      if (initial && initial.image) imageState = { ...imageState, ...initial.image };
      Object.defineProperty(handle, 'info', {
        enumerable: infoDescriptor.enumerable,
        configurable: true,
        get() {
          const info = originalInfo.call(handle);
          return {
            ...info,
            image: { ...imageState },
            modelParams: {
              shape: activeShape,
              values: { ...valuesFor(activeShape) },
            },
          };
        },
      });
    }

    function applyPacked(resetGeometry) {
      const norms = normalizedValuesFor(activeShape, valuesFor(activeShape));
      originalSetImageAdjust(packImageAndModel(imageState, norms));
      if (resetGeometry) originalSetAccumulate(accumulateOn);
    }

    handle.setImageAdjust = (next) => {
      for (const key of Object.keys(IMAGE_RANGES)) {
        if (next && next[key] !== undefined) imageState[key] = Number(next[key]);
      }
      applyPacked(false);
    };

    handle.setAccumulate = (on) => {
      accumulateOn = !!on;
      originalSetAccumulate(accumulateOn);
    };

    handle.setModelParams = (next) => {
      const schema = MODEL_PARAMETERS[activeShape] || [];
      const values = valuesFor(activeShape);
      for (const param of schema) {
        if (next && next[param.key] !== undefined) {
          values[param.key] = clamp(next[param.key], param.min, param.max);
        }
      }
      applyPacked(true);
    };

    handle.resetModelParams = () => {
      shapeState.set(activeShape, defaultValuesFor(activeShape));
      render(activeShape);
      applyPacked(true);
    };

    handle.setFractal = (name) => {
      originalSetFractal(name);
      if (MODEL_PARAMETERS[name]) {
        activeShape = name;
        render(name);
        applyPacked(false); // setFractal already invalidates geometry accumulation.
      }
    };

    handle.modelParameterSchema = MODEL_PARAMETERS;
    activeShape = select.value;
    render(activeShape);
    applyPacked(true);
  }

  reset.addEventListener('click', () => {
    if (handle && typeof handle.resetModelParams === 'function') handle.resetModelParams();
  });

  render(activeShape);

  // index.html publishes the renderer handle synchronously after initialization;
  // poll on animation frames so this module stays independent of that boot path.
  const started = performance.now();
  function findHandle() {
    if (window.fractalHandle) {
      wireHandle(window.fractalHandle);
      return;
    }
    if (performance.now() - started < 30000) requestAnimationFrame(findHandle);
  }
  requestAnimationFrame(findHandle);
}
