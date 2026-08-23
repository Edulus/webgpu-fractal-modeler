// Per-shape mathematical controls for the Shape Explorer.
//
// The four packed transport slots are only an implementation detail. Their
// meanings are defined independently for every model below, and models may use
// one, two, three, or four controls. A slider must correspond to a quantity that
// participates in that model's own construction; there is no universal
// scale/twist/stretch/warp layer.

const PACK_FLAG = 4194304; // 2^22
const PACK_BASE = 2048;    // 11 bits per value
const PACK_MAX = PACK_BASE - 1;

export const IMAGE_RANGES = Object.freeze({
  exposure: [0.2, 3],
  contrast: [0.5, 2],
  saturation: [0, 2],
  hue: [0, 1],
});

const p = (key, label, min, max, step, defaultValue) =>
  ({ key, label, min, max, step, default: defaultValue });

export const MODEL_PARAMETERS = Object.freeze({
  mandelbulb: [
    p('power', 'Power', 2, 12, 0.05, 8),
    p('bailout', 'Escape radius', 1.5, 6, 0.05, 2.2),
  ],
  mandelbox: [
    p('foldScale', 'Fold scale', -3, -1, 0.01, -1.85),
    p('minRadius', 'Minimum radius', 0.1, 0.8, 0.005, 0.35),
    p('fixedRadius', 'Fixed radius', 0.5, 1.5, 0.01, 1),
  ],
  menger: [
    p('levels', 'Recursion levels', 1, 7, 1, 5),
    p('halfSize', 'Outer half-size', 0.6, 1.4, 0.01, 1),
  ],
  julia: [
    p('cx', 'Julia c · x', -0.8, 0.8, 0.005, 0.35),
    p('cy', 'Julia c · y', -0.8, 0.8, 0.005, 0),
    p('cz', 'Julia c · z', -0.8, 0.8, 0.005, 0.1513),
    p('cw', 'Julia c · w', -0.8, 0.8, 0.005, 0.18),
  ],
  apollonian: [
    p('inversion', 'Inversion scale', 1.05, 1.55, 0.005, 1.25),
    p('iterations', 'Packing iterations', 3, 12, 1, 8),
    p('boundRadius', 'Packing radius', 0.8, 1.8, 0.01, 1.3),
  ],
  spherepack: [
    p('inversion', 'Inversion scale', 1.05, 1.55, 0.005, 1.28),
    p('iterations', 'Packing iterations', 3, 12, 1, 9),
    p('sphereRadius', 'Folded sphere radius', 0.7, 1.4, 0.01, 1.1),
    p('boundRadius', 'Cluster radius', 0.8, 1.6, 0.01, 1.15),
  ],
  encrusted: [
    p('hostRadius', 'Host radius', 0.65, 1.25, 0.01, 0.95),
    p('crustReach', 'Crust reach', 0.12, 0.55, 0.005, 0.38),
    p('capThreshold', 'Crust coverage', 0.2, 0.9, 0.005, 0.7),
    p('inversion', 'Packing inversion', 1.05, 1.45, 0.005, 1.24),
  ],
  surfacepack: [
    p('bodyRadius', 'Body radius', 0.7, 1.3, 0.01, 1),
    p('shell', 'Packing shell', 0.03, 0.2, 0.002, 0.09),
    p('cellSize', 'Base cell spacing', 0.12, 0.35, 0.002, 0.22),
    p('studScale', 'Stud radius scale', 0.55, 1.35, 0.01, 1),
  ],
  penrose: [
    p('discRadius', 'Disc radius', 0.8, 1.8, 0.01, 1.35),
    p('halfThickness', 'Half thickness', 0.025, 0.11, 0.001, 0.06),
    p('tileScale', 'Rhombus edge scale', 0.09, 0.28, 0.002, 0.17),
    p('phason', 'Phason amplitude', 0, 0.2, 0.002, 0.09),
  ],
  gyroid: [
    p('frequency', 'Lattice frequency', 2.5, 9, 0.05, 5.5),
    p('wall', 'Wall half-thickness', 0.12, 0.6, 0.005, 0.34),
    p('level', 'Level-set offset', -0.7, 0.7, 0.005, 0),
    p('clipRadius', 'Orbit clip radius', 0.8, 2.2, 0.01, 1.35),
  ],
  kleinian: [
    p('foldCell', 'Fold-cell scale', 0.85, 1.15, 0.002, 1),
    p('inversionRadius2', 'Inversion radius²', 0.75, 1.08, 0.002, 0.92),
    p('primitiveRadius', 'Primitive radius', 0.65, 1.2, 0.005, 0.92436),
    p('boundRadius', 'Limit-set radius', 1.1, 2.2, 0.01, 1.55),
  ],
  barth: [
    p('pencilW2', 'Pencil parameter w²', 0.75, 1.25, 0.002, 1),
  ],
  schottky: [
    p('sphereScale', 'Generator sphere scale', 0.96, 1, 0.001, 1),
  ],
  schottkyh: [
    p('sphereScale', 'Generator separation scale', 0.82, 0.98, 0.001, 0.925),
  ],
  tetrabrot: [
    p('xShift', 'Real-axis slice shift', -0.9, -0.1, 0.005, -0.5),
    p('crossCoupling', 'Bicomplex cross-coupling', 0.45, 1.55, 0.005, 1),
  ],
  envoct: [
    p('offset', 'Stellation offset', 0.25, 0.65, 0.002, 0.40824829),
  ],
  envdodec: [
    p('offset', 'Stellation offset', 0.75, 1.45, 0.002, 1.11351636),
  ],
  hyp534: [
    p('edgeRadius', 'Geodesic edge radius', 0.006, 0.04, 0.001, 0.02),
    p('clipRadius', 'Poincaré-ball clip', 0.65, 0.95, 0.005, 0.85),
  ],
  hyp435: [
    p('edgeRadius', 'Geodesic edge radius', 0.006, 0.04, 0.001, 0.02),
    p('clipRadius', 'Poincaré-ball clip', 0.65, 0.95, 0.005, 0.85),
  ],
  hyp534t: [
    p('edgeRadius', 'Truncated-edge radius', 0.006, 0.04, 0.001, 0.017),
    p('clipRadius', 'Poincaré-ball clip', 0.65, 0.95, 0.005, 0.85),
  ],
  hyp534o: [
    p('edgeRadius', 'Omnitruncated-edge radius', 0.006, 0.04, 0.001, 0.012),
    p('clipRadius', 'Poincaré-ball clip', 0.65, 0.95, 0.005, 0.85),
  ],
  hyp435t: [
    p('edgeRadius', 'Truncated-edge radius', 0.006, 0.04, 0.001, 0.017),
    p('clipRadius', 'Poincaré-ball clip', 0.65, 0.95, 0.005, 0.85),
  ],
  hyp435o: [
    p('edgeRadius', 'Omnitruncated-edge radius', 0.006, 0.04, 0.001, 0.012),
    p('clipRadius', 'Poincaré-ball clip', 0.65, 0.95, 0.005, 0.85),
  ],
  kleinpack: [
    p('horoballRadius', 'Seed horoball radius', 0.12, 0.36, 0.002, 0.2629837),
    p('clipRadius', 'Packing clip radius', 0.75, 0.99, 0.005, 0.95),
  ],
  engel: [
    p('cellScale', 'Lattice cell scale', 0.6, 1.4, 0.01, 1),
    p('gap', 'Cell-joint gap', 0, 0.035, 0.0005, 0.012),
    p('clipRadius', 'Tiling radius', 0.75, 1.8, 0.01, 1.15),
  ],
  // The attractors are line geometry rather than distance fields. These
  // controls alter their rendered trajectory geometry in model space.
  attractor: [
    p('ringScale', 'Ring scale', 0.65, 1.35, 0.01, 1),
    p('coilTorsion', 'Coil torsion', -2, 2, 0.02, 0),
    p('verticalScale', 'Vertical scale', 0.65, 1.35, 0.01, 1),
    p('fold', 'Fold amplitude', -0.3, 0.3, 0.005, 0),
  ],
  lorenz: [
    p('lobeScale', 'Lobe scale', 0.65, 1.35, 0.01, 1),
    p('lobeTorsion', 'Lobe torsion', -2, 2, 0.02, 0),
    p('verticalScale', 'Vertical extent', 0.65, 1.35, 0.01, 1),
    p('wingCurve', 'Wing curvature', -0.3, 0.3, 0.005, 0),
  ],
  rossler: [
    p('spiralScale', 'Spiral scale', 0.65, 1.35, 0.01, 1),
    p('spiralTorsion', 'Spiral torsion', -2, 2, 0.02, 0),
    p('foldHeight', 'Fold height', 0.65, 1.35, 0.01, 1),
    p('foldCurve', 'Fold curvature', -0.3, 0.3, 0.005, 0),
  ],
  cosmicweb: [
    p('baseFrequency', 'Backbone frequency', 0.45, 1.2, 0.005, 0.78),
    p('sharpness', 'Filament sharpness', 2.5, 8, 0.05, 4.7),
    p('voidThreshold', 'Void threshold', 0.25, 0.65, 0.005, 0.475),
    p('volumeRadius', 'Web volume radius', 3.5, 8, 0.05, 5.7),
  ],
  ziggurat: [
    p('cell', 'Cell spacing', 0.07, 0.22, 0.002, 0.13),
    p('stepHeight', 'Terrace step height', 0.02, 0.1, 0.001, 0.055),
    p('halfWidth', 'Cube half-width ratio', 0.25, 0.49, 0.005, 0.45),
    p('rings', 'Terrace rings', 4, 18, 1, 11),
  ],
  cubestack: [
    p('cell', 'Cube spacing', 0.02, 0.055, 0.0005, 0.0313),
    p('halfWidth', 'Cube half-width ratio', 0.2, 0.48, 0.005, 0.37),
    p('terraceCells', 'Cells per terrace', 1, 5, 0.1, 2),
    p('depth', 'Funnel depth', 5, 25, 1, 15),
  ],
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(v)));
}

export function defaultValuesFor(shape) {
  const schema = MODEL_PARAMETERS[shape] || [];
  return Object.fromEntries(schema.map((param) => [param.key, param.default]));
}

export function normalizedValuesFor(shape, values = {}) {
  const schema = MODEL_PARAMETERS[shape] || [];
  return schema.map((param) => {
    const value = values[param.key] === undefined
      ? param.default : clamp(values[param.key], param.min, param.max);
    return (value - param.min) / (param.max - param.min);
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
  return Number(value).toFixed(Math.min(4, decimalsFor(param.step)));
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
