// Registry consistency across JS, UI, and the final runtime shader strings.
// Wrapping shader source is allowed; these checks intentionally inspect what
// WebGPU receives rather than the small JavaScript wrapper files on disk.

import fs from 'node:fs';
import { FRACTAL_WGSL } from '../src/shaders/fractal.wgsl.js';
import { MATERIAL_WGSL } from '../src/shaders/material.wgsl.js';
import { COMPOSITE_WGSL } from '../src/shaders/composite.wgsl.js';

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
const fractal = FRACTAL_WGSL;
const material = MATERIAL_WGSL;
const composite = COMPOSITE_WGSL;

const idBlock = bg
  .slice(bg.indexOf('const FRACTAL_IDS = {'), bg.indexOf('};', bg.indexOf('const FRACTAL_IDS = {')))
  .replace(/\/\/[^\n]*/g, '');
const IDS = {};
for (const m of idBlock.matchAll(/(\w+)\s*:\s*(\d+)/g)) IDS[m[1]] = Number(m[2]);
const names = Object.keys(IDS);
const maxId = Math.max(...Object.values(IDS));

ok(names.length > 0, `registry parses (${names.length} shapes, ids 0..${maxId})`);
ok(new Set(Object.values(IDS)).size === names.length, 'no two shapes share an id');
ok(
  Array.from({ length: maxId + 1 }, (_, i) => i).every((i) => Object.values(IDS).includes(i)),
  'ids are contiguous from 0, so every id indexes a real shape',
);

const camEntries = bg
  .match(/const CAM_RADIUS = \[([\s\S]*?)\]/)[1]
  .split(',')
  .filter((s) => s.trim()).length;
ok(camEntries === maxId + 1, `CAM_RADIUS has an entry per id (${camEntries}/${maxId + 1})`);

const hudNames = index
  .match(/const names = \[([\s\S]*?)\]/)[1]
  .split(',')
  .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
  .filter(Boolean);
ok(hudNames.length === maxId + 1, `HUD name list has an entry per id (${hudNames.length}/${maxId + 1})`);
ok(hudNames.every((n, i) => IDS[n] === i), 'every HUD name sits at its own registry id');

// Attribute-tolerant: the select carries an aria-label now that the panel's
// sections are disclosures and the <label> wrapper that used to name it is
// gone. Matching the open tag exactly made this fail on an accessibility
// attribute, which is not what the test is about.
const selector = index.match(/<select id="sel-fractal"[^>]*>([\s\S]*?)<\/select>/)[1];
const options = [...selector.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]);
ok(options.every((o) => o in IDS), 'every selector option names a registered shape');

const labelled = new Set([...index.matchAll(/^\s*(\w+): \['/gm)].map((m) => m[1]));
const unlabelled = options.filter((o) => !labelled.has(o));
ok(unlabelled.length === 0, `every selectable shape has a wall label${unlabelled.length ? `: missing ${unlabelled}` : ''}`);

const firstAttractor = IDS.attractor;
const lastAttractor = IDS.rossler;
const attractorBand = `u.fractalType > ${firstAttractor - 0.5} && u.fractalType < ${lastAttractor + 0.5}`;

ok(bg.includes('return id >= FRACTAL_IDS.attractor && id <= FRACTAL_IDS.rossler;'),
  'isAttractorType spans attractor..rossler');
ok(material.includes(attractorBand), `material.wgsl attractor band matches the registry (${attractorBand})`);
ok(composite.includes(attractorBand), `composite.wgsl attractor band matches the registry (${attractorBand})`);

const nonSurfaceBand = `u.fractalType > ${firstAttractor - 0.5} && u.fractalType < ${IDS.cosmicweb + 0.5}`;
ok(fractal.includes(nonSurfaceBand), `fractal.wgsl skips exactly the non-surface ids (${nonSurfaceBand})`);
ok(IDS.cosmicweb === lastAttractor + 1,
  'the volumetric id sits directly after the attractors, so the skip is one contiguous band');

ok(bg.includes('function isSurfaceType(id)'), 'surface-ness is exposed as a predicate');
ok(/doProbe[\s\S]{0,600}?isSurfaceType\(state\.fractalType\)/.test(bg),
  'the clearance probe gates on the predicate, not on an id threshold');
const surfacesAboveBand = names.filter((n) => IDS[n] > IDS.cosmicweb);
ok(surfacesAboveBand.length === 0 || bg.includes('function isSurfaceType(id)'),
  `surfaces above the non-surface band are handled by predicate (${surfacesAboveBand.join(', ') || 'none'})`);

const mapDE = fractal.slice(fractal.indexOf('fn mapDE(pos'), fractal.indexOf('\n}', fractal.indexOf('fn mapDE(pos')));
const thresholds = [...mapDE.matchAll(/ft < ([\d.]+)/g)].map((m) => Number(m[1]));
ok(thresholds.length > 0, `mapDE dispatches on ${thresholds.length} thresholds`);

const inBand = thresholds.filter((t) => t > firstAttractor - 0.5 && t <= IDS.cosmicweb + 0.5);
ok(inBand.length === 0,
  `no mapDE threshold splits the non-surface band${inBand.length ? `: ${inBand}` : ''}`);

const surfaceIds = Object.values(IDS).filter(
  (id) => !(id >= firstAttractor && id <= lastAttractor) && id !== IDS.cosmicweb,
);
const covered = surfaceIds.filter((id) => id < Math.max(...thresholds) || id > IDS.cosmicweb);
ok(covered.length === surfaceIds.length,
  `every surface id is reachable in mapDE (${covered.length}/${surfaceIds.length})`);

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
for (const [name, src] of [['fractal', fractal], ['material', material], ['composite', composite]]) {
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

// The FXAA pass is one entry point in the composite module plus one pipeline
// that reads the composited image back. Both halves have to exist together: a
// pipeline without the entry point fails at device creation, and an entry point
// with nothing driving it is dead code that silently stops smoothing anything.
ok(composite.includes('fn fs_fxaa'), 'composite.wgsl provides the FXAA entry point');
ok(bg.includes("entryPoint: 'fs_fxaa'"), 'a pipeline is built from that entry point');
ok(/smoothing[\s\S]{0,200}?!acc/.test(bg),
  'FXAA is skipped once accumulation has converged, so a resolved frame is not refiltered');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
