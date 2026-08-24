// shape-params.js — public parameter registry.
//
// The established registry and constraint machinery live unchanged in the base
// module. Gyroid is added here so the feature is isolated and every existing
// shape keeps exactly the parameter definitions it already shipped with.
import { SHAPE_PARAMS } from './shape-params-base.js';

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

export * from './shape-params-base.js';
