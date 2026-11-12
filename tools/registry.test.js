// Registry consistency across JS, UI, and the final runtime shader strings.
// Wrapping shader source is allowed; these checks intentionally inspect what
// WebGPU receives rather than the small JavaScript wrapper files on disk.

import fs from 'node:fs';
import { FRACTAL_WGSL } from '../src/shaders/fractal.wgsl.js';
import { MATERIAL_WGSL } from '../src/shaders/material.wgsl.js';
import { COMPOSITE_WGSL } from '../src/shaders/composite.wgsl.js';
import { TEMPORAL_WGSL } from '../src/shaders/temporal.wgsl.js';
import {
  SHAPES, SHAPE_NAMES, FRACTAL_IDS, CAM_RADIUS, shapeKind, shapeKindWGSL,
} from '../src/shapes.js';

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

console.log('\nRegistry consistency across tables, selector and shaders');

const bg = fs.readFileSync('src/fractal-bg.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const diag = fs.readFileSync('src/diagnostics.js', 'utf8');
const fractal = FRACTAL_WGSL;
const material = MATERIAL_WGSL;
const composite = COMPOSITE_WGSL;
const temporal = TEMPORAL_WGSL;

// ---- The registry itself ---------------------------------------------------
const IDS = FRACTAL_IDS;
const names = SHAPE_NAMES;
const maxId = names.length - 1;
ok(names.length > 0, `registry parses (${names.length} shapes, ids 0..${maxId})`);
ok(new Set(names).size === names.length, 'no two shapes share a name');
ok(names.every((n, i) => IDS[n] === i), 'every name maps to its own index, so ids are contiguous from 0');
ok(SHAPES.every((s) => ['surface', 'line', 'volume'].includes(s.kind)), 'every shape has a known kind');
ok(CAM_RADIUS.length === names.length && CAM_RADIUS.every((r) => Number.isFinite(r) && r > 0),
   `CAM_RADIUS has a positive entry per id (${CAM_RADIUS.length}/${names.length})`);

// ---- Nothing keeps its own copy any more -----------------------------------
ok(!/const FRACTAL_IDS = \{/.test(bg) && !/const CAM_RADIUS = \[/.test(bg),
   'the renderer imports the registry rather than keeping a copy');
ok(/import \{ FRACTAL_IDS, CAM_RADIUS, shapeKind \} from '\.\/shapes\.js';/.test(bg), 'renderer imports from shapes.js');
ok(/const names = SHAPE_NAMES;/.test(index), 'the HUD name list is the registry');
ok(/export const MODEL_KEYS = SHAPE_NAMES;/.test(diag), 'diagnostics model names are the registry');
ok(!/fractalType\) >= 25/.test(diag), 'diagnostics no longer guesses the kind from an id threshold');

// ---- Selector --------------------------------------------------------------
// Attribute-tolerant open tag: the select carries an aria-label.
const selector = index.match(/<select id="sel-fractal"[^>]*>([\s\S]*?)<\/select>/)[1];
const options = [...selector.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]);
ok(options.every((o) => o in IDS), 'every selector option names a registered shape');
ok(new Set(options).size === options.length, 'no shape is offered twice');

const labelled = new Set([...index.matchAll(/^\s*(\w+): \['/gm)].map((m) => m[1]));
const unlabelled = options.filter((o) => !labelled.has(o));
ok(unlabelled.length === 0, `every selectable shape has a wall label${unlabelled.length ? `: missing ${unlabelled}` : ''}`);

// ---- Kinds reach the shaders through one generated helper -------------------
const helper = shapeKindWGSL();
for (const [name, src] of [['fractal', fractal], ['material', material], ['composite', composite], ['temporal', temporal]]) {
  ok(src.includes(helper), `${name}.wgsl carries the generated shape-kind helpers`);
}
ok(material.includes('if (isLineShape(u.fractalType)) {') && material.includes('if (isVolumeShape(u.fractalType)) {'),
   'material routes lines and volumes through the helpers');
ok(composite.includes('if (isLineShape(u.fractalType)) {') && composite.includes('let surfaceType = isSurfaceShape(u.fractalType);'),
   'composite asks the helpers, not an id band');
ok(fractal.includes('if (!isSurfaceShape(u.fractalType)) {'), 'the legacy fs_main skips non-surfaces through the helper');
ok(temporal.includes('let lines = isLineShape(u.fractalType);'), 'temporal resolve exempts lines through the helper');
// The helper agrees with the registry for every id (evaluate its range tests in JS).
const lineTestRaw = new Function('ft', 'abs', 'return ' + helper.match(/fn isLineShape[^{]*\{\s*return ([^;]+);/)[1] + ';');
const volTestRaw = new Function('ft', 'abs', 'return ' + helper.match(/fn isVolumeShape[^{]*\{\s*return ([^;]+);/)[1] + ';');
const lineTest = (ft) => lineTestRaw(ft, Math.abs);
const volTest = (ft) => volTestRaw(ft, Math.abs);
ok(names.every((_, i) => lineTest(i) === (shapeKind(i) === 'line') && volTest(i) === (shapeKind(i) === 'volume')),
   'the generated WGSL classifies every id exactly as the registry does');
ok(!lineTest(names.length) && !volTest(names.length), 'and an id past the end is not misread as a line or volume');

ok(bg.includes("return shapeKind(id) === 'line';") && bg.includes("return shapeKind(id) === 'surface';"),
   'isAttractorType / isSurfaceType read the registry kind');
ok(/doProbe[\s\S]{0,600}?isSurfaceType\(state\.fractalType\)/.test(bg),
  'the clearance probe gates on the predicate, not on an id threshold');

// ---- mapDE dispatches every surface, and only surfaces ----------------------
const mapDE = fractal.slice(fractal.indexOf('fn mapDE(pos'), fractal.indexOf('\n}', fractal.indexOf('fn mapDE(pos')));
ok(/switch \(i32\(round\(u\.fractalType\)\)\)/.test(mapDE), 'mapDE dispatches by integer id');
const cased = [...mapDE.matchAll(/case ([\d, ]+):/g)].flatMap((m) => m[1].split(',').map((x) => Number(x.trim())));
const surfaceIds = names.map((_, i) => i).filter((i) => shapeKind(i) === 'surface');
const missing = surfaceIds.filter((i) => !cased.includes(i));
ok(missing.length === 0, `every surface id has a case in mapDE${missing.length ? `: missing ${missing}` : ''}`);
const strays = cased.filter((i) => shapeKind(i) !== 'surface' || i > maxId);
ok(strays.length === 0, `no line, volume or unregistered id is dispatched as a surface${strays.length ? `: ${strays}` : ''}`);
ok(new Set(cased).size === cased.length, 'no id appears in two cases');

// ---- Shader sources must survive being JavaScript template literals --------
// Every WGSL module is carried in a JS backtick string, so a stray backtick or
// an unescaped ${ inside shader source or its comments silently ends the
// literal. That is not a shader error and no WGSL tool sees it -- the module
// simply fails to parse, the renderer never starts, and the page is blank.
//
// It has happened: a comment reading `factor` in the Apollonian estimator broke
// six suites at once. Importing the modules at the top of this file is itself
// the regression test, but assert on the payload too so the failure names the
// cause rather than appearing as an unrelated syntax error.
for (const [name, src] of [['fractal', fractal], ['material', material], ['composite', composite], ['temporal', temporal]]) {
  ok(typeof src === 'string' && src.length > 0, `${name}.wgsl loaded as a string (${src.length} chars)`);
  ok(!src.includes('`'), `${name}.wgsl contains no backtick that would close its template literal`);
}

// Every registered shape must be reachable from the selector.
//
// The reverse check above (every option is registered) does not catch a shape
// that exists, works, and simply has no way to be chosen. That happened: id 8
// was repurposed from the retired Penrose relief into the canonical Descartes
// Apollonian packing, complete with its own estimator and test suite, but no
// option was added and it could not be selected at all.
//
// A shape may be withheld deliberately, so list those here rather than dropping
// the check -- an empty list means every shape is offered.
const WITHHELD = [];
const unreachable = names.filter((n) => !options.includes(n) && !WITHHELD.includes(n));
ok(unreachable.length === 0,
  `every registered shape is selectable${unreachable.length ? `: unreachable ${unreachable}` : ''}`);

// Grouping is presentational, but a mis-nested optgroup silently drops its
// options from the menu, so confirm the count survives the grouping.
const groups = [...selector.matchAll(/<optgroup label="([^"]+)"/g)].map((m) => m[1]);
ok(groups.length > 0, `selector is grouped by family (${groups.length} groups)`);
ok(new Set(options).size === options.length, 'no shape appears twice in the selector');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
