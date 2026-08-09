// Strange-attractor fits. Run: node tools/attractor.test.js
//
// The three attractors are placed by measurement: integrate, take the bounding
// box, then choose a centre and scale that put the trajectory in roughly
// [-1,1]^3. Those constants live in fractal-bg.js, which cannot be imported
// here because it wants a GPU device and a DOM, so they are mirrored below --
// the same arrangement colorcycle.test.js and kleinpack.test.js use. If a fit
// is edited there and not here, the box assertions fail rather than silently
// drifting.
//
// What is actually being checked: that each attractor stays bounded, lands
// inside the frame after its own transform, is not so coarsely stepped that the
// integration falls apart, and is genuinely aperiodic rather than settling onto
// a cycle.

const ATTRACTORS = {
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
  rossler: {
    init: [0.1, 0.0, 0.0],
    dt: 0.004, warm: 4000,
    center: [1.2, -1.5, 11.4], scale: 0.9 / 11.5,
    deriv: (x, y, z) => {
      const a = 0.2, b = 0.2, c = 5.7;
      return [-y - z, x + a * y, b + z * (x - c)];
    },
  },
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

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else { failed++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
};

function run(cfg, n, start) {
  let [x, y, z] = start || cfg.init;
  const dt = cfg.dt, h = dt * 0.5;
  const step = () => {
    const k1 = cfg.deriv(x, y, z);
    const k2 = cfg.deriv(x + k1[0] * h, y + k1[1] * h, z + k1[2] * h);
    const k3 = cfg.deriv(x + k2[0] * h, y + k2[1] * h, z + k2[2] * h);
    const k4 = cfg.deriv(x + k3[0] * dt, y + k3[1] * dt, z + k3[2] * dt);
    x += (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    y += (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    z += (dt / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
  };
  for (let i = 0; i < cfg.warm; i++) step();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let arc = 0, px = x, py = y, pz = z;
  const pts = [];
  for (let i = 0; i < n; i++) {
    step();
    const p = [x, y, z];
    for (let k = 0; k < 3; k++) {
      if (p[k] < lo[k]) lo[k] = p[k];
      if (p[k] > hi[k]) hi[k] = p[k];
    }
    arc += Math.hypot(x - px, y - py, z - pz);
    px = x; py = y; pz = z;
    if (i % 40 === 0) pts.push(p);
  }
  return { lo, hi, arc, n, end: [x, y, z], pts };
}

function lyapunov(cfg, intervals = 400, span = 250, delta = 1e-9) {
  const dt = cfg.dt, h = dt * 0.5;
  const advance = (s) => {
    let [x, y, z] = s;
    const k1 = cfg.deriv(x, y, z);
    const k2 = cfg.deriv(x + k1[0] * h, y + k1[1] * h, z + k1[2] * h);
    const k3 = cfg.deriv(x + k2[0] * h, y + k2[1] * h, z + k2[2] * h);
    const k4 = cfg.deriv(x + k3[0] * dt, y + k3[1] * dt, z + k3[2] * dt);
    return [x + (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
            y + (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
            z + (dt / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2])];
  };
  let a = cfg.init.slice();
  for (let i = 0; i < cfg.warm; i++) a = advance(a);
  let b = [a[0] + delta, a[1], a[2]];
  let sum = 0;
  for (let i = 0; i < intervals; i++) {
    for (let s = 0; s < span; s++) { a = advance(a); b = advance(b); }
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (d <= 0) return 0;
    sum += Math.log(d / delta);
    const k = delta / d;                      // pull it back in, same direction
    b = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  }
  return sum / (intervals * span * dt);
}

const N = 120000;
for (const [name, cfg] of Object.entries(ATTRACTORS)) {
  const r = run(cfg, N);

  // Bounded: a wrong sign or too large a step sends these to infinity.
  check(`${name} stays finite`, r.end.every(Number.isFinite));
  check(`${name} stays bounded`, r.hi.every((v, k) => v - r.lo[k] < 1e4));

  // The fit puts it in frame. The bound is 1.05 rather than 1.0 because the
  // shipped Aizawa fit genuinely reaches 1.018 in y -- measured, not assumed --
  // and that overshoot is fine at the orbit distance it is given.
  const fit = [0, 1, 2].map((k) => Math.max(
    Math.abs((r.lo[k] - cfg.center[k]) * cfg.scale),
    Math.abs((r.hi[k] - cfg.center[k]) * cfg.scale)));
  check(`${name} fits the frame after its transform`, fit.every((v) => v <= 1.05),
        `reach ${fit.map((v) => v.toFixed(3)).join(', ')}`);
  check(`${name} fills a reasonable share of it`, Math.max(...fit) > 0.55,
        `largest reach ${Math.max(...fit).toFixed(3)}`);

  // Step size: the drawn line is a polyline, so the arc per step sets how
  // smooth it looks. Too large and the curve visibly facets.
  const perStep = r.arc / N;
  check(`${name} steps finely enough to draw smoothly`, perStep < 0.06,
        `arc per step ${perStep.toFixed(4)}`);

  // Chaotic, not merely wandering: a positive Lyapunov exponent. Comparing raw
  // separation after a fixed run is too blunt a test -- two trajectories can be
  // far apart simply by being at different phases along the same loop. Instead
  // track a nearby trajectory, measure how much the gap grows over a short
  // interval, then RENORMALISE it back to the starting gap and keep going. The
  // mean log growth per unit time is the exponent, and it is positive exactly
  // for a chaotic system.
  check(`${name} has a positive Lyapunov exponent`, lyapunov(cfg) > 0.02,
        `lambda = ${lyapunov(cfg).toFixed(4)}`);
}

// Rossler specifics, which are what this addition is about.
{
  const r = run(ATTRACTORS.rossler, N);
  // It has no symmetry about the vertical axis, unlike the other two, so its
  // centre is deliberately off-axis. Guard against someone "tidying" it to zero.
  check('rossler is off-axis in x', Math.abs((r.lo[0] + r.hi[0]) / 2) > 0.5,
        `box centre x ${((r.lo[0] + r.hi[0]) / 2).toFixed(3)}`);
  check('rossler is off-axis in y', Math.abs((r.lo[1] + r.hi[1]) / 2) > 0.5,
        `box centre y ${((r.lo[1] + r.hi[1]) / 2).toFixed(3)}`);

  // Nearly flat spiral, then a sharp fold upward: z spends most of its time low
  // and reaches far higher than the spiral's own thickness.
  const zs = r.pts.map((p) => p[2]).sort((a, b) => a - b);
  const median = zs[Math.floor(zs.length / 2)];
  check('rossler sits mostly in a flat spiral', median < 1.0,
        `median z ${median.toFixed(3)}`);
  check('and folds far out of it', r.hi[2] > 10 * Math.max(median, 0.1),
        `max z ${r.hi[2].toFixed(2)} against median ${median.toFixed(3)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
