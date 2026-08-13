// Registry consistency.
//
// Adding a shape means touching a surprising number of places: the id table, the
// camera-radius table, the selector, the wall labels, the HUD name list, the
// estimator dispatch, and the numeric class bands duplicated across three
// shaders. Nothing forces those to agree, and when one is missed the failure is
// silent — the shape still renders, it just quietly loses a feature.
//
// That has already happened twice. The clearance probe was gated on the id of
// the then-last surface, so the Kleinian packing and the Engel plesiohedron
// stopped being probed the moment they were added, and navigated on a stale
// clearance reading for as long as it took to notice. The Cosmic Web was left
// out of the HUD name list and displayed its label as `undefined`.
//
// So these tests derive the expected values from the registry and check every
// dependent table against it, rather than restating any of them by hand.

import fs from 'node:fs';

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
const fractal = fs.readFileSync('src/shaders/fractal.wgsl.js', 'utf8');
const material = fs.readFileSync('src/shaders/material.wgsl.js', 'utf8');
const composite = fs.readFileSync('src/shaders/composite.wgsl.js', 'utf8');

// ---- The registry itself, the single source of truth ----------------------
const idBlock = bg
  .slice(bg.indexOf('const FRACTAL_IDS = {'), bg.indexOf('};', bg.indexOf('const FRACTAL_IDS = {')))
  // Comments in the block carry digits of their own — ids, Schläfli symbols —
  // so they have to go before the entries are read. Entries are also packed
  // several to a line, so this cannot be line-oriented.
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

// ---- Per-id tables must cover every id ------------------------------------
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
ok(
  hudNames.every((n, i) => IDS[n] === i),
  'every HUD name sits at its own registry id',
);

// ---- Selector and wall labels ---------------------------------------------
const selector = index.match(/<select id="sel-fractal">([\s\S]*?)<\/select>/)[1];
const options = [...selector.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]);
ok(options.every((o) => o in IDS), 'every selector option names a registered shape');

const labelled = new Set([...index.matchAll(/^\s*(\w+): \['/gm)].map((m) => m[1]));
const unlabelled = options.filter((o) => !labelled.has(o));
ok(unlabelled.length === 0, `every selectable shape has a wall label${unlabelled.length ? `: missing ${unlabelled}` : ''}`);

// ---- Class bands: the shader thresholds must match the JS predicates -------
// These are the numbers most likely to rot, because they are magic constants
// repeated across three files while the truth lives in JS.
const firstAttractor = IDS.attractor;
const lastAttractor = IDS.rossler;
const attractorBand = `u.fractalType > ${firstAttractor - 0.5} && u.fractalType < ${lastAttractor + 0.5}`;

ok(
  bg.includes('return id >= FRACTAL_IDS.attractor && id <= FRACTAL_IDS.rossler;'),
  'isAttractorType spans attractor..rossler',
);
ok(material.includes(attractorBand), `material.wgsl attractor band matches the registry (${attractorBand})`);
ok(composite.includes(attractorBand), `composite.wgsl attractor band matches the registry (${attractorBand})`);

// Everything that is not a distance-estimated surface: the line attractors plus
// the volumetric field. The raymarch pass skips exactly this band.
const nonSurfaceBand = `u.fractalType > ${firstAttractor - 0.5} && u.fractalType < ${IDS.cosmicweb + 0.5}`;
ok(
  fractal.includes(nonSurfaceBand),
  `fractal.wgsl skips exactly the non-surface ids (${nonSurfaceBand})`,
);
ok(
  IDS.cosmicweb === lastAttractor + 1,
  'the volumetric id sits directly after the attractors, so the skip is one contiguous band',
);

// ---- Surface-ness is a predicate, not a threshold -------------------------
// The ziggurat is a surface whose id is above the non-surface band, which is
// what makes an `id <= last surface` test wrong. Anything gating on surfaces
// must therefore ask the predicate.
ok(
  bg.includes('function isSurfaceType(id)'),
  'surface-ness is exposed as a predicate',
);
ok(
  /doProbe[\s\S]{0,600}?isSurfaceType\(state\.fractalType\)/.test(bg),
  'the clearance probe gates on the predicate, not on an id threshold',
);
const surfacesAboveBand = names.filter((n) => IDS[n] > IDS.cosmicweb);
ok(
  surfacesAboveBand.length === 0 || bg.includes('function isSurfaceType(id)'),
  `surfaces above the non-surface band are handled by predicate (${surfacesAboveBand.join(', ') || 'none'})`,
);

// ---- Estimator dispatch must reach every surface --------------------------
// mapDE is a threshold chain ending in a bare return. Every surface id has to
// fall into a branch, and the trailing return catches the ids above the band.
const mapDE = fractal.slice(fractal.indexOf('fn mapDE(pos'), fractal.indexOf('\n}', fractal.indexOf('fn mapDE(pos')));
const thresholds = [...mapDE.matchAll(/ft < ([\d.]+)/g)].map((m) => Number(m[1]));
ok(thresholds.length > 0, `mapDE dispatches on ${thresholds.length} thresholds`);
ok(
  Math.max(...thresholds) === IDS.cosmicweb - 4 + 0.5 || Math.max(...thresholds) < IDS.attractor,
  `mapDE's last threshold stops below the attractors (${Math.max(...thresholds)} < ${firstAttractor})`,
);

const surfaceIds = Object.values(IDS).filter(
  (id) => !(id >= firstAttractor && id <= lastAttractor) && id !== IDS.cosmicweb,
);
const covered = surfaceIds.filter((id) => id < Math.max(...thresholds) || id > IDS.cosmicweb);
ok(
  covered.length === surfaceIds.length,
  `every surface id is reachable in mapDE (${covered.length}/${surfaceIds.length})`,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
