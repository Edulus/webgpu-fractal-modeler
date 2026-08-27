// shape-params.js — public parameter registry.
//
// The established registry and constraint machinery live unchanged in the base
// module. New measured shapes are layered here so existing definitions remain
// byte-for-byte stable.
import { SHAPE_PARAMS } from './shape-params-base.js';
import { installApollonianDescartesUI } from './apollonian-descartes-ui.js';

const APD_K_MIN = 1 + Math.sqrt(6) / 2;

// Internal key `penrose` is the retired id-8 slot. The Penrose relief stopped
// being selectable before Shape maths existed; reusing that dormant slot keeps
// every numeric shape id after 8 stable. The UI presents this as a new canonical
// Apollonian / Descartes sphere packing and never exposes the old internal name.
SHAPE_PARAMS.penrose = [
  {
    slot: 0, key: 'seedCurvature', label: 'Seed curvature κ',
    min: APD_K_MIN, max: 3.2, step: 0.005, default: APD_K_MIN,
    domain: 'geometry',
    constraint: { kind: 'derived', derives: ['fourth seed curvature', 'dual inversion spheres'] },
    note: 'Curvature of three equal inner seed spheres inside the unit enclosing sphere. '
        + 'The fourth inner curvature is solved from the 3D Soddy-Gossett / Descartes '
        + 'equation, so it is deliberately not another slider. The lower bound '
        + '1+sqrt(6)/2 is the symmetric tetrahedral configuration where all four inner '
        + 'spheres are equal. The interval through 3.2 was checked for real Descartes '
        + 'roots, pairwise tangency, valid dual inversions, and conservative marching.',
  },
  {
    slot: 1, key: 'recursionDepth', label: 'Recursion depth',
    min: 4, max: 24, step: 1, default: 18, integer: true,
    domain: 'geometry',
    isIteration: true,
    constraint: { kind: 'cost' },
    note: 'Maximum dual-Apollonian group-word depth used to resolve progressively '
        + 'smaller tangent spheres. It is a mathematical truncation of the infinite '
        + 'packing, not the adaptive renderer iteration budget. Higher values reveal '
        + 'smaller generations and cost more distance-estimator work.',
  },
];

SHAPE_PARAMS.gyroid = [
  {
    slot: 0, key: 'cellSize', label: 'Cell size',
    min: 0.65, max: 2.0, step: 0.01, default: 1.14239733,
    domain: 'geometry',
    constraint: { kind: 'derived', derives: ['frequency', 'Lipschitz bound'] },
    note: 'The cubic unit-cell period a. Frequency is derived as 2*pi/a and the '
        + 'sphere-tracing divisor is derived from that same frequency as '
        + 'sqrt(3)*frequency, so every positive value remains mathematically '
        + 'conservative. The UI range keeps the finest cells within a practical '
        + 'interactive cost and still shows multiple repeats at the coarse end. '
        + 'The default is 2*pi/5.5, reproducing the previously shipped geometry.',
  },
  {
    slot: 1, key: 'levelOffset', label: 'Level offset',
    min: -0.3, max: 0.3, step: 0.01, default: 0,
    domain: 'geometry',
    constraint: { kind: 'free' },
    note: 'Selects the isosurface f = t. The full -0.3..0.3 range is exactly the '
        + 'family the previous autonomous animation traversed, so this hands an '
        + 'already-exercised interval to the user without extending it.',
    replaces: 'Level previously oscillated as 0.3*sin(time*0.08). The slider '
            + 'owns the value now, so the autonomous geometry animation is removed.',
  },
  {
    slot: 2, key: 'wallThickness', label: 'Wall thickness',
    min: 0.17, max: 0.51, step: 0.01, default: 0.34,
    domain: 'geometry',
    constraint: { kind: 'free' },
    note: 'Half-thickness h of the solid sheet around the selected level set. '
        + 'It is a constant subtraction from |f-t| and therefore does not change '
        + 'the field gradient or its Lipschitz safety bound. The initial range is '
        + 'a conservative half-to-one-and-a-half-times span around the shipped '
        + '0.34 value while preserving 0.34 exactly as the default.',
  },
];

// The canonical packing is already present in index.html's selector and NOTES
// table. This browser-only hook now exists solely to translate historical id-8
// HUD text from `penrose` to the public canonical name without renumbering ids.
installApollonianDescartesUI();

export * from './shape-params-base.js';
