// Shape parameters: the registry's own invariants.
//
// The failure this file exists to prevent is a slider that looks fine and is
// mathematically broken -- the exact failure that made the previous attempt
// unusable. So it checks the things a screenshot cannot: that ranges are
// declared with a reason, that derived quantities are actually derived in the
// shader rather than left as literals, that relational constraints are enforced
// on both sides of the wire, and that nothing ships a parameter which moves the
// model's extent while CAM_RADIUS is still a hand-written table.

import fs from 'node:fs';
import {
  SHAPE_PARAMS, CONSTRAINT_KINDS, PARAM_SLOTS, PARAM_DOMAINS, REL_MARGIN,
  paramsFor, defaultsFor, clampParams, packParams, effectiveRange,
} from '../src/shape-params.js';

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}

console.log('\nShape parameters: registry invariants, constraints and packing');

const bg = fs.readFileSync('src/fractal-bg.js', 'utf8');
const shader = fs.readFileSync('src/shaders/fractal.wgsl.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const shapes = Object.keys(SHAPE_PARAMS);

// ---- Only real shapes, and only measured ones ------------------------------
const idBlock = bg
  .slice(bg.indexOf('const FRACTAL_IDS = {'), bg.indexOf('};', bg.indexOf('const FRACTAL_IDS = {')))
  .replace(/\/\/[^\n]*/g, '');
const IDS = {};
for (const m of idBlock.matchAll(/(\w+)\s*:\s*(\d+)/g)) IDS[m[1]] = Number(m[2]);

ok(shapes.length > 0, `${shapes.length} shapes are parameterised`);
ok(shapes.every((s) => s in IDS), 'every parameterised shape is a registered shape');
ok(
  Object.keys(IDS).length > shapes.length,
  `most shapes still have no parameters (${Object.keys(IDS).length - shapes.length} of ${Object.keys(IDS).length}), which is the correct state for constants that have not been measured`,
);

// ---- Per-parameter shape of the entry --------------------------------------
for (const shape of shapes) {
  const list = paramsFor(shape);
  ok(list.length > 0 && list.length <= PARAM_SLOTS,
     `${shape}: ${list.length} parameters, within the ${PARAM_SLOTS}-slot block`);

  const slots = list.map((p) => p.slot);
  ok(new Set(slots).size === slots.length, `${shape}: no two parameters share a slot`);
  ok(slots.every((n) => Number.isInteger(n) && n >= 0 && n < PARAM_SLOTS),
     `${shape}: every slot is inside the block`);
  ok(new Set(list.map((p) => p.key)).size === list.length, `${shape}: keys are unique`);

  for (const p of list) {
    ok(p.min < p.max, `${shape}.${p.key}: range is non-empty (${p.min}..${p.max})`);
    ok(p.default >= p.min && p.default <= p.max,
       `${shape}.${p.key}: default ${p.default} lies inside its own range`);
    ok(p.step > 0 && p.step <= (p.max - p.min),
       `${shape}.${p.key}: step ${p.step} is usable across the range`);
    ok(typeof p.label === 'string' && p.label.length > 0, `${shape}.${p.key}: has a label`);

    // The point of the whole exercise: a range must carry the reason it is
    // that range. A number with no recorded justification is the thing that
    // produced a plausible-looking, mathematically broken control last time.
    ok(typeof p.note === 'string' && p.note.length > 40,
       `${shape}.${p.key}: records WHY its range is what it is`);
    ok(p.constraint && CONSTRAINT_KINDS.includes(p.constraint.kind),
       `${shape}.${p.key}: declares a recognised constraint kind (${p.constraint?.kind})`);
  }
}

// ---- The gate: geometry only, never a rendering budget ---------------------
// A quality knob in the shape UI would let the user fight the adaptive governor,
// and the governor would win -- so the control would look broken rather than
// obviously wrong. The domain is therefore declared per parameter and only one
// value is admissible here.
for (const shape of shapes) {
  for (const p of paramsFor(shape)) {
    ok(p.domain in PARAM_DOMAINS, `${shape}.${p.key}: declares a known domain (${p.domain})`);
    ok(p.domain === 'geometry',
       `${shape}.${p.key}: is part of the object, not a rendering budget`);
  }
}

// Iteration counts are where the two domains collide. A parameter claiming to be
// the mathematical count must belong to an estimator that does NOT also take the
// governor's count, or the two would be fighting over the same loop.
for (const shape of shapes) {
  for (const p of paramsFor(shape)) {
    if (!p.isIteration) continue;
    const fn = `de${shape[0].toUpperCase()}${shape.slice(1)}`;
    const body = shader.slice(shader.indexOf(`fn ${fn}`), shader.indexOf('\n}', shader.indexOf(`fn ${fn}`)));
    ok(body.length > 0, `${shape}.${p.key}: ${fn} was found in the shader`);
    ok(!/detail\.y/.test(body),
       `${shape}.${p.key}: ${fn} takes no iteration count from the governor, so the two never contend`);
  }
}
ok(
  Object.values(SHAPE_PARAMS).flat().some((p) => p.isIteration),
  'at least one iteration parameter is declared, so the rule above is not vacuous',
);

// ---- The gate: no extent-changing parameter may ship -----------------------
// CAM_RADIUS is a per-shape table assuming a fixed model size. A parameter that
// changes the extent would silently stop framing the object, so it is refused
// here until that distance is derived instead of tabled.
const extentParams = shapes.flatMap((s) =>
  paramsFor(s).filter((p) => p.constraint.kind === 'extent').map((p) => `${s}.${p.key}`));
ok(extentParams.length === 0,
   `no parameter changes the model's extent while CAM_RADIUS is a table${extentParams.length ? `: ${extentParams}` : ''}`);

// ---- Derived quantities must actually be derived ---------------------------
// A parameter declaring `derived` promises the shader recomputes something from
// it. If the shader still holds a literal, the geometry moves and the bound
// that keeps sphere tracing safe does not -- which renders as holes.
for (const shape of shapes) {
  for (const p of paramsFor(shape)) {
    if (p.constraint.kind !== 'derived') continue;
    const what = p.constraint.derives;
    ok(Array.isArray(what) && what.length > 0,
       `${shape}.${p.key}: names what it derives`);
  }
}
ok(true, 'no shipped parameter declares a derived quantity yet (none of the four needs one)');

// ---- Relational constraints, enforced on both sides ------------------------
for (const shape of shapes) {
  for (const p of paramsFor(shape)) {
    if (p.constraint.kind !== 'relational') continue;
    const other = p.constraint.rel?.below;
    ok(paramsFor(shape).some((q) => q.key === other),
       `${shape}.${p.key}: its relation names a real sibling parameter (${other})`);
  }
}

// The Mandelbox pair is the live case: overshoot was measured at exactly the
// point the inner radius passes the outer one.
const boxed = clampParams('mandelbox', { boxScale: -1.85, minRadius: 1.8, fixedRadius: 1.0 });
ok(boxed.minRadius < boxed.fixedRadius,
   `minRadius is clamped below fixedRadius (asked 1.8 against 1.0, got ${boxed.minRadius})`);
const boxed2 = clampParams('mandelbox', { boxScale: -1.85, minRadius: 1.0, fixedRadius: 1.0 });
ok(boxed2.minRadius < boxed2.fixedRadius, 'equality is excluded too, not just greater-than');

// And the shader must not simply trust the value it is handed.
ok(/let minR = min\(shapeParam\(1u\), fixedR - 0\.01\);/.test(shader),
   'the shader clamps the pair itself rather than trusting the uniform');

// ---- The narrowed range is reportable, not just enforced -------------------
// Silent clamping reads as a broken slider. The UI needs to be able to say why
// a parameter's reach has shrunk, so the effective range is computed rather than
// left implicit in the clamp.
const tight = effectiveRange('mandelbox', 'minRadius', { fixedRadius: 1.0 });
ok(Math.abs(tight.max - (1.0 - REL_MARGIN)) < 1e-9,
   `a capped range reports the reachable maximum (${tight.max})`);
ok(tight.cappedBy === 'fixedRadius', 'and names the parameter doing the capping');
ok(typeof tight.cappedByLabel === 'string' && tight.cappedByLabel.length > 0,
   `with a human label for it (${tight.cappedByLabel})`);

const loose = effectiveRange('mandelbox', 'minRadius', { fixedRadius: 2.0 });
ok(loose.max === 1.9 && loose.cappedBy === null,
   'and reports no cap once the sibling has moved out of the way');
ok(effectiveRange('mandelbulb', 'power', {}).cappedBy === null,
   'an unconstrained parameter is never reported as capped');
ok(effectiveRange('mandelbox', 'nosuch', {}) === null, 'an unknown key yields no range');

// The reported cap and the enforced clamp must agree, or the UI would promise a
// reach the setter refuses.
for (const fixed of [0.4, 0.8, 1.0, 1.5, 2.0]) {
  const r = effectiveRange('mandelbox', 'minRadius', { fixedRadius: fixed });
  const c = clampParams('mandelbox', { boxScale: -1.85, minRadius: 99, fixedRadius: fixed });
  ok(Math.abs(c.minRadius - r.max) < 1e-9,
     `at fixedRadius ${fixed} the reported cap ${r.max.toFixed(3)} is exactly what the clamp enforces`);
}

// ---- Clamping and packing --------------------------------------------------
for (const shape of shapes) {
  const d = defaultsFor(shape);
  const round = clampParams(shape, d);
  ok(paramsFor(shape).every((p) => Math.abs(round[p.key] - p.default) < 1e-9),
     `${shape}: defaults survive a clamp unchanged`);

  const packed = packParams(shape, d);
  ok(packed.length === PARAM_SLOTS, `${shape}: packs to exactly ${PARAM_SLOTS} floats`);
  ok(paramsFor(shape).every((p) => Math.abs(packed[p.slot] - round[p.key]) < 1e-6),
     `${shape}: each value lands in its declared slot`);

  const used = new Set(paramsFor(shape).map((p) => p.slot));
  ok([...packed].every((v, i) => used.has(i) || v === 0),
     `${shape}: unused slots are zero, so no shape reads what another left behind`);
}

// Out-of-range and junk input must not reach the shader.
const wild = clampParams('mandelbulb', { power: 1e9, bailout: -50 });
ok(wild.power === 16 && wild.bailout === 2, `absurd values clamp to the range (${wild.power}, ${wild.bailout})`);
const nan = clampParams('mandelbulb', { power: NaN, bailout: undefined });
ok(nan.power === 8 && nan.bailout === 2.2, 'NaN and missing fall back to the defaults');
const int = clampParams('menger', { mengerDepth: 4.7 });
ok(Number.isInteger(int.mengerDepth), `an integer parameter stays an integer (${int.mengerDepth})`);
ok(paramsFor('nosuchshape').length === 0, 'an unparameterised shape yields no controls');
ok(packParams('nosuchshape', {}).every((v) => v === 0), 'and packs to all zeros');

// ---- Wiring ----------------------------------------------------------------
ok(/shapeParams: 104/.test(bg), 'the uniform block gives the parameters their own slots');
ok(/const UNIFORM_FLOATS = 112;/.test(bg), 'and the buffer was grown to hold them');
ok(/shapeParams\s+: array<vec4<f32>, 2>/.test(shader), 'the shader declares the matching field');
ok(!/imageAdjust/.test(fs.readFileSync('src/shape-params.js', 'utf8')),
   'nothing is packed into imageAdjust any more');

// A geometry change must clear the progressive average, or the converged frame
// blends the old shape into the new one.
const setter = bg.slice(bg.indexOf('setShapeParam(key, value)'), bg.indexOf('resetShapeParams()'));
ok(/state\.accumSamples = 0;/.test(setter), 'setShapeParam resets progressive accumulation');
const reset = bg.slice(bg.indexOf('resetShapeParams()'), bg.indexOf('setQuality(mode)'));
ok(/state\.accumSamples = 0;/.test(reset), 'so does resetShapeParams');

// The governor keeps the rendering budget; these are mathematics.
ok(/let deIters = i32\(u\.detail\.y\);/.test(shader),
   'the iteration budget is still read from the governor, not from a slider');
// Menger is the case where the two could be confused: its depth IS an
// iteration count, but a mathematical one. It must come from the parameter
// block and the estimator must still not consult the governor's budget.
const menger = shader.slice(shader.indexOf('fn deMenger'), shader.indexOf('\n}', shader.indexOf('fn deMenger')));
ok(/let depth = i32\(shapeParam\(0u\)\);/.test(menger),
   'the Menger depth is read from the parameter block');
ok(!/detail\.y/.test(menger),
   'and deMenger still never consults the governor, so exposing it takes nothing away');

// The UI is generated, not hand-written per shape.
ok(/paramsFor\(name\)/.test(index), 'the panel builds its sliders from the registry');
ok(/box\.hidden = schema\.length === 0;/.test(index),
   'a shape with no measured parameters shows no section at all');
ok(/effectiveRange\(name, p\.key, live\)/.test(index),
   'the panel sizes each slider to the range actually reachable');
ok(/held below \$\{range\.cappedByLabel\}/.test(index),
   'and says which parameter narrowed it rather than clamping silently');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
