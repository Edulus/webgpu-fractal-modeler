// Gyroid Shape maths: registry-to-shader contract.
import { paramsFor, defaultsFor, clampParams, packParams } from '../src/shape-params.js';
import { FRACTAL_WGSL } from '../src/shaders/fractal.wgsl.js';

let passed = 0;
let failed = 0;
const ok = (condition, label) => {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
};

console.log('\nGyroid parameters: cell size, level offset and wall thickness');

const list = paramsFor('gyroid');
ok(list.length === 3, 'Gyroid exposes exactly three mathematical controls');
ok(list.map((p) => p.key).join(',') === 'cellSize,levelOffset,wallThickness',
   'the controls are Cell size, Level offset and Wall thickness');

const cell = list[0];
ok(cell.constraint.kind === 'derived', 'Cell size declares a derived constraint');
ok(cell.constraint.derives.includes('frequency')
   && cell.constraint.derives.includes('Lipschitz bound'),
   'Cell size records both quantities that must follow it');

const d = defaultsFor('gyroid');
ok(Math.abs(d.cellSize - 2 * Math.PI / 5.5) < 1e-6,
   'default Cell size reproduces the former FREQ=5.5 geometry');
ok(d.levelOffset === 0, 'default Level offset is the old animation midpoint');
ok(d.wallThickness === 0.34, 'default Wall thickness reproduces the shipped value');

const c = clampParams('gyroid', {
  cellSize: -10,
  levelOffset: 99,
  wallThickness: -1,
});
ok(c.cellSize === cell.min, 'Cell size is clamped to its positive UI range');
ok(c.levelOffset === 0.3, 'Level offset is clamped to the exercised +0.3 boundary');
ok(c.wallThickness === list[2].min, 'Wall thickness is clamped to its declared range');

const packed = packParams('gyroid', d);
ok(Math.abs(packed[0] - d.cellSize) < 1e-6
   && packed[1] === 0
   && Math.abs(packed[2] - 0.34) < 1e-6,
   'the three controls occupy shader slots 0, 1 and 2');
ok([...packed.slice(3)].every((v) => v === 0), 'unused Gyroid parameter slots stay zero');

const start = FRACTAL_WGSL.indexOf('fn deGyroid');
const end = FRACTAL_WGSL.indexOf('\n}', start);
const body = FRACTAL_WGSL.slice(start, end);
ok(start >= 0 && end > start, 'runtime shader contains deGyroid');
ok(/let cellSize = max\(shapeParam\(0u\), 1e-4\);/.test(body),
   'shader reads Cell size from slot 0 and guards it positive');
ok(/let freq = 2\.0 \* PI \/ cellSize;/.test(body),
   'shader derives frequency as 2*pi/Cell size');
ok(/SQRT3 \* freq/.test(body),
   'the same derived frequency drives the Lipschitz distance bound');
ok(/let level = shapeParam\(1u\);/.test(body), 'shader reads Level offset from slot 1');
ok(/let half = max\(shapeParam\(2u\), 0\.0\);/.test(body),
   'shader reads Wall thickness from slot 2');
ok(!/sin\(tm \* 0\.08\)/.test(body),
   'the former autonomous Level animation is removed');
ok(!/const FREQ/.test(body) && !/const HALF/.test(body),
   'the old fixed frequency and thickness literals no longer control Gyroid');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
