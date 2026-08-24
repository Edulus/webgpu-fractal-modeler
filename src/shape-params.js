// shape-params.js — which constants of which estimators are safe to expose,
// over what range, and what else has to move when they do.
//
// The rule this file exists to enforce: a shape is not parameterised until its
// constants have been measured. An earlier attempt gave every shape four
// sliders by applying a generic twist/stretch/warp deformation to the
// coordinates before the estimator saw them. That is a deformation applied TO
// mathematics rather than a parameter OF it, and it needed a hand-tuned
// distance divisor to stop sphere tracing from breaking. Shapes that have not
// been measured get no sliders here, and that is the correct state for them.
//
// `constraint` is the load-bearing field, not decoration. Ranges are chosen
// from measurement, and the constraint records what the measurement found and
// what depends on the value:
//
//   free       nothing else in the estimator moves with it.
//   derived    the shader must recompute something from it (`derives` names
//              what). A literal left in the shader instead is a silent bug:
//              the geometry changes and the distance bound does not.
//   relational must satisfy a condition involving another parameter of the same
//              shape (`rel`). Enforced twice -- clamped here AND in the shader
//              -- because the estimator must never be handed an invalid pair
//              however the uniform came to hold it. Two forms exist:
//                rel.below   -- must stay under a sibling's value.
//                rel.locksTo -- is pinned to one value entirely unless a
//                               sibling meets a threshold (`rel.unless`). This
//                               is for a parameter whose whole VALIDITY, not
//                               merely its range, depends on another: the
//                               generalized Mandelbulb's angle ratios are only
//                               safe at power 8 and above, and below that the
//                               estimator marches through surfaces.
//   extent     changes the model's bounding radius. NOTHING may ship with this
//              until CAM_RADIUS is derived rather than tabled, because the
//              orbit distance is a per-shape constant that would silently stop
//              framing the object. tools/shape-params.test.js refuses it.
//   cost       materially changes marching cost. Allowed, but flagged, because
//              the quality governor will absorb it by lowering the rung.
export const CONSTRAINT_KINDS = ['free', 'derived', 'relational', 'extent', 'cost'];

// Which SYSTEM a number belongs to. Recorded explicitly because the two are easy
// to confuse and the confusion is one-way harmful: a rendering budget wired into
// the shape UI would let the user fight the adaptive governor, and the governor
// would win, so the control would appear broken rather than obviously wrong.
//
// Only 'geometry' may appear in this registry at all. 'quality' is listed so the
// distinction is written down and so the test has something to refuse.
export const PARAM_DOMAINS = {
  geometry: 'part of the mathematical object -- changing it changes what is drawn',
  quality: 'a rendering budget -- belongs to the adaptive governor, never to a shape',
};

// Iteration counts are where the two domains collide, because both are "how many
// times round the loop". A parameter carrying isIteration promises it is the
// MATHEMATICAL count -- the recursion depth of the object -- and the test checks
// that its estimator does not also read the governor's u.detail.y, which would
// mean the two were fighting over the same loop.


// Two vec4 in the uniform block. Eight is not a target to fill -- most shapes
// use fewer, and a shape with none is normal.
export const PARAM_SLOTS = 8;

// Measured with a Node port of each estimator: rays are sphere-traced against a
// dense reference march at each value, reporting whether the object still
// exists, whether it has collapsed to a featureless ball, and whether the
// estimator has started marching through surfaces. Every range below is the
// clean interval that produced.
export const SHAPE_PARAMS = {
  mandelbulb: [
    {
      slot: 0, key: 'power', label: 'Power',
      min: 2, max: 16, step: 0.05, default: 8,
      domain: 'geometry',
      constraint: { kind: 'free' },
      note: 'The exponent of the triplex power. Measured clean from 2 to 20; at '
          + '1.5 the estimator marched through surfaces on 3 rays in 160, so the '
          + 'range starts at 2 -- which is also where the escape-time '
          + 'construction stops being a Mandelbulb.',
      replaces: 'Power previously breathed between 7 and 9 on a timer. A value '
              + 'cannot be both animated and controlled, so the slider owns it '
              + 'and the default is the reduced-motion value.',
    },
    {
      slot: 1, key: 'bailout', label: 'Bailout',
      min: 2, max: 16, step: 0.1, default: 2.2,
      domain: 'geometry',
      constraint: { kind: 'free' },
      note: 'Escape radius. This range is set by the mathematics rather than by '
          + 'a failure: no overshoot was measured anywhere from 1.2 up, but a '
          + 'point with |z| > 2 provably escapes, so a bailout below 2 truncates '
          + 'the set instead of resolving it. Larger values refine the boundary '
          + 'and cost iterations.',
    },
    // The generalized family. v^n = r^n <sin(p*th)cos(q*ph), sin(p*th)sin(q*ph),
    // cos(p*th)>, where the classic sets p = q = n. Exposing p and q as RATIOS
    // of the power rather than as absolute multipliers is what keeps Power
    // meaning what it always meant: at ratio 1 the map is exactly the classic
    // one, so the defaults reproduce the existing shape bit for bit.
    {
      slot: 2, key: 'polarRatio', label: 'Polar ratio',
      min: 0.25, max: 1.75, step: 0.01, default: 1,
      domain: 'geometry',
      constraint: { kind: 'relational', rel: { locksTo: 1, unless: { param: 'power', atLeast: 8 } } },
      note: 'Multiplies the polar angle by power * this, instead of by power. '
          + 'Valid only at power 8 and above, and the threshold is measured over '
          + 'the whole reachable space rather than chosen cautiously. Two '
          + 'separate things fail below it. At power 2, seven of thirteen ratio '
          + 'pairs march through surfaces, because the shipped dr rule assumes '
          + 'the map is conformal and the ratios break that. At power 4 nothing '
          + 'overshoots but the extent still swings 2.6x across the ratios, which '
          + 'the tabled CAM_RADIUS cannot follow. Only from 8 up are both quiet: '
          + 'zero overshoot and the extent moving about 5%.',
    },
    {
      slot: 3, key: 'azimuthRatio', label: 'Azimuth ratio',
      min: 0.25, max: 1.75, step: 0.01, default: 1,
      domain: 'geometry',
      constraint: { kind: 'relational', rel: { locksTo: 1, unless: { param: 'power', atLeast: 8 } } },
      note: 'Multiplies the azimuthal angle by power * this. Setting the two '
          + 'ratios differently is what breaks the rotational symmetry and turns '
          + 'one shape into a family; leaving both at 1 is the classic '
          + 'Mandelbulb exactly. Same measured power floor as the polar ratio.',
    },
  ],

  mandelbox: [
    {
      slot: 0, key: 'boxScale', label: 'Scale',
      min: -3, max: -1.5, step: 0.01, default: -1.85,
      domain: 'geometry',
      constraint: { kind: 'free' },
      note: 'The fold scale. Measured overshoot at -1.2 (3 rays) and -0.8 (12), '
          + 'so |scale| must stay above about 1.5 -- below it the iteration '
          + 'contracts instead of escaping. The positive branch 2..3 is clean '
          + 'and is a different-looking family, but a contiguous slider cannot '
          + 'reach it without crossing the middle, where 1.5 measured as a '
          + 'featureless ball that also overshot.',
    },
    {
      slot: 1, key: 'minRadius', label: 'Min radius',
      min: 0.05, max: 1.9, step: 0.005, default: 0.35,
      domain: 'geometry',
      constraint: { kind: 'relational', rel: { below: 'fixedRadius' } },
      note: 'Inner radius of the sphere fold. The upper bound is not a measured '
          + 'limit of its own: overshoot appeared at exactly minRadius 1.2 '
          + 'against fixedRadius 1.0, i.e. the moment the inner radius passed '
          + 'the outer one and the two fold branches inverted. It is therefore '
          + 'held below fixedRadius rather than below a constant.',
    },
    {
      slot: 2, key: 'fixedRadius', label: 'Fixed radius',
      min: 0.3, max: 2, step: 0.01, default: 1,
      domain: 'geometry',
      constraint: { kind: 'free' },
      note: 'Outer radius of the sphere fold. Clean throughout; past 2.0 the '
          + 'solid thins and starts leaving the frame (hit rate 97% at 2.0, '
          + '69% at 2.5), which is where the range stops.',
    },
  ],

  menger: [
    {
      slot: 0, key: 'mengerDepth', label: 'Recursion depth',
      min: 1, max: 8, step: 1, default: 5, integer: true,
      domain: 'geometry',
      isIteration: true,
      constraint: { kind: 'cost' },
      note: 'How many times the cross is carved out. This is the mathematical '
          + 'recursion depth and is deliberately separate from the governor\'s '
          + 'iteration budget -- deMenger never read u.detail.y, so nothing is '
          + 'being taken away from the governor here. Measured clean at every '
          + 'depth from 0 to 8 with no overshoot; the range starts at 1 because '
          + 'depth 0 is an uncarved cube rather than a sponge.',
    },
  ],

  julia: [
    {
      slot: 0, key: 'juliaCx', label: 'c · real',
      min: -0.55, max: 0.55, step: 0.005, default: 0.35,
      domain: 'geometry',
      constraint: { kind: 'free' },
      note: 'Real component of the quaternion constant.',
      replaces: 'c previously orbited on a timer. The slider owns it now; the '
              + 'defaults are the pose that timer held at t = 0.',
    },
    {
      slot: 1, key: 'juliaCy', label: 'c · i',
      min: -0.55, max: 0.55, step: 0.005, default: 0,
      domain: 'geometry',
      constraint: { kind: 'free' },
      note: 'First imaginary component. Zero by default, which is where the old '
          + 'animation started it; moving it off zero breaks the symmetry the '
          + 'default pose has about that axis.',
    },
    {
      slot: 2, key: 'juliaCz', label: 'c · j',
      min: -0.55, max: 0.55, step: 0.005, default: 0.1512717,
      domain: 'geometry',
      constraint: { kind: 'free' },
      note: 'Second imaginary component. The default is 0.28*cos(1), the value '
          + 'the old animation held at t = 0.',
    },
    {
      slot: 3, key: 'juliaCw', label: 'c · k',
      min: -0.55, max: 0.55, step: 0.005, default: 0.18,
      domain: 'geometry',
      constraint: { kind: 'free' },
      note: 'Third imaginary component. Every component shares one measured '
          + 'range: each was swept independently and each stayed clean to about '
          + '±0.6, beyond which the set thins towards empty and the estimator '
          + 'begins to overshoot -- 0.55 keeps the whole cube of combinations '
          + 'inside the interval that measured clean.',
    },
  ],
};

// The range a parameter can actually reach RIGHT NOW, given its siblings.
// Separate from its declared range because a relational constraint narrows it as
// another value moves, and the UI has to be able to say so rather than letting a
// slider silently refuse to go where it appears able to.
export const REL_MARGIN = 0.01;

export function effectiveRange(shape, key, values) {
  const list = paramsFor(shape);
  const p = list.find((q) => q.key === key);
  if (!p) return null;
  const rel = p.constraint?.rel;
  const labelOf = (k) => list.find((q) => q.key === k)?.label ?? k;

  // A lock is not a narrowed range but a closed one: the parameter has a single
  // admissible value until its precondition is met. Reported as a range of zero
  // width so the UI can render it as an immovable slider and say why, rather
  // than as a control that silently refuses to move.
  if (rel?.locksTo !== undefined && rel.unless) {
    const gate = Number(values?.[rel.unless.param]);
    const met = Number.isFinite(gate) && gate >= rel.unless.atLeast;
    if (!met) {
      return {
        min: rel.locksTo,
        max: rel.locksTo,
        locked: true,
        lockedAt: rel.locksTo,
        lockedBy: rel.unless.param,
        lockedByLabel: labelOf(rel.unless.param),
        needs: rel.unless.atLeast,
        cappedBy: null,
        cappedByLabel: null,
      };
    }
  }

  let max = p.max;
  let cappedBy = null;
  if (rel?.below !== undefined && values?.[rel.below] !== undefined) {
    const limit = Number(values[rel.below]) - REL_MARGIN;
    if (limit < max) {
      max = Math.max(p.min, limit);
      cappedBy = rel.below;
    }
  }
  return {
    min: p.min, max, locked: false,
    cappedBy, cappedByLabel: cappedBy ? labelOf(cappedBy) : null,
  };
}

export function paramsFor(shape) {
  return SHAPE_PARAMS[shape] || [];
}

export function defaultsFor(shape) {
  const out = {};
  for (const p of paramsFor(shape)) out[p.key] = p.default;
  return out;
}

const clampTo = (v, p) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return p.default;
  const c = Math.min(p.max, Math.max(p.min, n));
  return p.integer ? Math.round(c) : c;
};

// Clamp to each parameter's own range, then apply the relational constraints.
// Both halves matter: a value inside its own range can still be invalid against
// another parameter, which is exactly the Mandelbox fold-radius case.
export function clampParams(shape, values) {
  const out = {};
  const list = paramsFor(shape);
  for (const p of list) out[p.key] = clampTo(values?.[p.key], p);
  for (const p of list) {
    const rel = p.constraint?.rel;
    if (!rel) continue;
    if (rel.locksTo !== undefined && rel.unless) {
      const gate = Number(out[rel.unless.param]);
      if (!(Number.isFinite(gate) && gate >= rel.unless.atLeast)) out[p.key] = rel.locksTo;
    }
    if (rel.below !== undefined && out[rel.below] !== undefined) {
      // Strictly below, with a margin, so equality cannot sneak through and
      // make the two fold branches degenerate.
      out[p.key] = Math.min(out[p.key], out[rel.below] - REL_MARGIN);
      out[p.key] = Math.max(out[p.key], p.min);
    }
  }
  return out;
}

// The eight floats as the shader sees them. Unused slots are zero rather than
// stale: a shape must never read a value another shape left behind.
export function packParams(shape, values) {
  const packed = new Float32Array(PARAM_SLOTS);
  const clamped = clampParams(shape, values);
  for (const p of paramsFor(shape)) packed[p.slot] = clamped[p.key];
  return packed;
}
