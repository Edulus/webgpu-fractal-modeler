// The Family -> Type -> Shape picker: pure catalogue logic (src/catalog.js) and
// the menu markup it is built from.
import fs from 'node:fs';
import { buildCatalog, locate, pick } from '../src/catalog.js';
import { SHAPES } from '../src/shapes.js';

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}

// ---- The markup is the catalogue --------------------------------------------
const index = fs.readFileSync('index.html', 'utf8');
const select = index.match(/<select id="sel-fractal"[^>]*>([\s\S]*?)<\/select>/)[1];
const groups = [...select.matchAll(/<optgroup label="([^"]+)" data-family="([^"]+)">([\s\S]*?)<\/optgroup>/g)]
  .map(([, label, family, body]) => ({
    label, family,
    options: [...body.matchAll(/<option value="(\w+)">([^<]+)<\/option>/g)].map(([, value, l]) => ({ value, label: l })),
  }));
const allGroups = [...select.matchAll(/<optgroup /g)].length;

console.log('\nMenu markup');
ok(groups.length === allGroups, `every optgroup (type) names its family (${groups.length}/${allGroups})`);
const FAMILIES = ['Fractals', 'Packings and groups', 'Tessellations', 'Surfaces', 'Polyhedra',
                  'Curves and dynamics', 'Fields and assemblies'];
ok(groups.every((g) => FAMILIES.includes(g.family)), 'every family is one of the seven');
ok(groups.every((g) => g.options.length > 0), 'no type is empty');
const offered = groups.flatMap((g) => g.options.map((o) => o.value));
ok(new Set(offered).size === offered.length, 'no shape is listed twice');
const registered = SHAPES.map((s) => s.name);
const missing = registered.filter((n) => !offered.includes(n));
ok(missing.length === 0, `every registered shape is in the menu${missing.length ? `: missing ${missing}` : ''}`);

// Families stay contiguous in the markup, so the picker's family order is the
// order a reader of the plain grouped list would see.
const order = groups.map((g) => g.family);
ok(order.every((f, i) => i === 0 || f === order[i - 1] || !order.slice(0, i).includes(f)),
   'each family\'s types are contiguous');

// ---- Pure logic --------------------------------------------------------------
console.log('\nCatalogue logic');
const cat = buildCatalog(groups);
ok(cat.families.map((f) => f.name).join('|') === FAMILIES.filter((f) => order.includes(f)).join('|'),
   'families appear in menu order');
ok(cat.families.reduce((n, f) => n + f.types.reduce((m, t) => m + t.shapes.length, 0), 0) === offered.length,
   'no shape is lost building the catalogue');
for (const name of offered) {
  const at = locate(cat, name);
  if (!at || !cat.families[at.family].types[at.type].shapes.some((s) => s.value === name)) {
    ok(false, `locate finds ${name}`);
  }
}
ok(true, 'locate finds every listed shape in its own type');
ok(locate(cat, 'no-such-shape') === null, 'locate returns null for an unlisted shape');

const fractals = cat.families.findIndex((f) => f.name === 'Fractals');
const curves = cat.families.findIndex((f) => f.name === 'Curves and dynamics');
let c = pick(cat, 'mandelbulb', curves, 0);
ok(c.changed && c.value === cat.families[curves].types[0].shapes[0].value,
   'choosing another family opens its first type and selects its first shape');
c = pick(cat, 'mandelbulb', fractals, 0);
ok(!c.changed && c.value === 'mandelbulb', 'choosing the family already shown keeps the current shape');
c = pick(cat, 'mandelbulb', fractals, 99);
ok(c.type === cat.families[fractals].types.length - 1, 'an out-of-range type index is clamped');
ok(pick(cat, 'mandelbulb', 99, 0) === null, 'an unknown family yields nothing');

// ---- Page wiring -----------------------------------------------------------
console.log('\nPage wiring');
ok(/<div id="shape-picker">\s*<select id="sel-family"[^>]*><\/select>\s*<select id="sel-type"[^>]*><\/select>/.test(index),
   'the picker sits above the shape select');
ok(/selShape\.dispatchEvent\(new Event\('change'\)\)/.test(index),
   "the picker drives the shape select's own change event, so existing listeners still fire");
ok(/if \(choice\.changed\) selShape\.dispatchEvent/.test(index), 'and only when the shape actually changed');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
