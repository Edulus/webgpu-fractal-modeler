// attractors.js — the strange attractors, as data and pure functions.
//
// Each has no closed-form distance function, so it is integrated (RK4) into a
// trajectory and drawn as a line strip. Per attractor: the derivative, the
// integration step, the transient to discard, and a fit (centre + scale) that
// puts the trajectory in roughly [-1,1]^3.
//
// The fits are MEASURED: integrate, take the bounding box, centre on it and
// scale its largest half-span to 0.9. tools/attractor.test.js re-measures
// every one, so an edited constant that no longer frames its attractor fails
// there. Parameters are the standard chaotic ones; where a commonly quoted
// value turned out not to be chaotic here, the reason is noted.
//
// Kept free of WebGPU and the DOM so Node can import it.

const fit = (center, half) => ({ center, scale: 0.9 / half });

export const ATTRACTORS = {
  // dx/dt = (z-b)x - dy, dy/dt = dx + (z-b)y,
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
  // dx/dt = -y - z, dy/dt = x + ay, dz/dt = b + z(x - c). Off-axis box:
  // x[-9.11, 11.43], y[-10.79, 7.84], z[0.01, 22.85].
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

  // ---- Second set ----------------------------------------------------------
  // Thomas' cyclically symmetric attractor: dx/dt = sin y - bx, and cyclically.
  // b = 0.208186 is the value usually quoted, but it is the edge of chaos:
  // measured here it settles on a lopsided orbit with a Lyapunov exponent of
  // 0.007, essentially zero. b = 0.18 is properly chaotic (0.030) and symmetric
  // about the origin, which is the shape the attractor is known for.
  thomas: {
    init: [0.1, 0.0, 0.0],
    dt: 0.05, warm: 4000,
    ...fit([0, 0, 0], 4.23),
    deriv: (x, y, z) => {
      const b = 0.18;
      return [Math.sin(y) - b * x, Math.sin(z) - b * y, Math.sin(x) - b * z];
    },
  },
  // Halvorsen: dx/dt = -ax - 4y - 4z - y^2, and cyclically. a = 1.27 is
  // Sprott's chaotic value (exponent measured 0.774, published ~0.75). The
  // a = 1.89 also seen quoted measured as periodic here.
  halvorsen: {
    init: [-1.48, -1.51, 2.04],
    dt: 0.0015, warm: 40000,
    ...fit([-3.54, -3.54, -3.54], 9.8),
    deriv: (x, y, z) => {
      const a = 1.27;
      return [-a * x - 4 * y - 4 * z - y * y,
              -a * y - 4 * z - 4 * x - z * z,
              -a * z - 4 * x - 4 * y - x * x];
    },
  },
  // Dadras: dx/dt = y - ax + byz, dy/dt = cy - xz + z, dz/dt = dxy - ez.
  dadras: {
    init: [1.1, 2.1, -2.0],
    dt: 0.004, warm: 5000,
    ...fit([-0.48, -2.11, 0.19], 19.33),
    deriv: (x, y, z) => {
      const a = 3, b = 2.7, c = 1.7, d = 2, e = 9;
      return [y - a * x + b * y * z, c * y - x * z + z, d * x * y - e * z];
    },
  },
  // Chen: dx/dt = a(y-x), dy/dt = (c-a)x - xz + cy, dz/dt = xy - bz. Lorenz's
  // dual: same quadratic terms, opposite sign structure. Fast, so a small dt.
  chen: {
    init: [-0.1, 0.5, -0.6],
    dt: 0.0003, warm: 20000,
    ...fit([-0.32, -0.43, 27.99], 29.97),
    deriv: (x, y, z) => {
      const a = 35, b = 3, c = 28;
      return [a * (y - x), (c - a) * x - x * z + c * y, x * y - b * z];
    },
  },
  // Sprott case B: dx/dt = ayz, dy/dt = x - by, dz/dt = c - xy. One of the
  // simplest three-dimensional chaotic flows Sprott found by search.
  sprott: {
    init: [0.1, 0.1, 0.1],
    dt: 0.02, warm: 5000,
    ...fit([-0.07, -0.03, -0.4], 10.21),
    deriv: (x, y, z) => {
      const a = 0.4, b = 1.2, c = 1;
      return [a * y * z, x - b * y, c - x * y];
    },
  },
  // Rabinovich-Fabrikant: a model of waves in a non-equilibrium medium.
  // gamma = 0.87, alpha = 1.1, measured exponent 0.20. Compact, so the step is
  // as large as smoothness allows (arc ~0.047 per step): at 0.012 the 600k
  // points piled up additively and washed the whole attractor out to white.
  rabinovich: {
    init: [-1.0, 0.0, 0.5],
    dt: 0.025, warm: 5000,
    // A quarter of the usual point count: the loops are tightly nested, so the
    // standard 600k overlap so densely that additive blending saturates to
    // white. 150k still traces every loop many times over.
    points: 150000,
    ...fit([-1.12, 1.07, 0.72], 1.33),
    deriv: (x, y, z) => {
      const alpha = 1.1, gamma = 0.87;
      return [y * (z - 1 + x * x) + gamma * x,
              x * (3 * z + 1 - x * x) + gamma * y,
              -2 * z * (alpha + x * y)];
    },
  },
};

// Points drawn per attractor unless it sets its own `points`.
export const DEFAULT_TRAJECTORY_POINTS = 600000;
export const trajectoryPoints = (cfg) => cfg.points ?? DEFAULT_TRAJECTORY_POINTS;

// Shape name -> attractor. The first shape kept the key 'attractor'.
export const ATTRACTOR_FOR_SHAPE = {
  attractor: 'aizawa', lorenz: 'lorenz', rossler: 'rossler',
  thomas: 'thomas', halvorsen: 'halvorsen', dadras: 'dadras',
  chen: 'chen', sprott: 'sprott', rabinovich: 'rabinovich',
};

// Integrate an attractor into interleaved [x, y, z, speed] vertices: positions
// already through the fit transform, speed normalised to 0..1.
//
// Speed is a smooth function of position on the attractor, so colouring by it
// gives neighbouring strands the same hue and additive overlap deepens that
// hue instead of averaging to white. The sqrt spreads the low end, where most
// of the trajectory sits, across more of the palette.
//
// Speeds are kept in float64 until normalised, and the normalised value is
// clamped at zero. The previous version stored them as float32 first and then
// subtracted the float64 minimum: the slowest sample could round to a hair
// below that minimum, giving sqrt of a negative number -- one NaN vertex, which
// the bloom chain spread into a black rectangle. Measured: Lorenz, Thomas,
// Halvorsen and Rabinovich-Fabrikant each produced exactly one.
export function buildTrajectory(cfg, count) {
  const verts = new Float32Array(count * 4);
  const speeds = new Float64Array(count);
  let x = cfg.init[0], y = cfg.init[1], z = cfg.init[2];
  const dt = cfg.dt, h = dt * 0.5;
  const [cx, cy, cz] = cfg.center;
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
  // Discard the transient so only the attractor itself is drawn.
  for (let i = 0; i < cfg.warm; i++) step();
  let sMin = Infinity, sMax = 0;
  for (let i = 0; i < count; i++) {
    step();
    verts[i * 4] = (x - cx) * s;
    verts[i * 4 + 1] = (y - cy) * s;
    verts[i * 4 + 2] = (z - cz) * s;
    const v = cfg.deriv(x, y, z);
    const sp = Math.hypot(v[0], v[1], v[2]);
    speeds[i] = sp;
    if (sp < sMin) sMin = sp;
    if (sp > sMax) sMax = sp;
  }
  const range = sMax - sMin || 1;
  for (let i = 0; i < count; i++) {
    verts[i * 4 + 3] = Math.sqrt(Math.max(0, (speeds[i] - sMin) / range));
  }
  return verts;
}
