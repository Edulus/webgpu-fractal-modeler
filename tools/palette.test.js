// Unit tests for palette import and persistence. Plain Node, no GPU, no DOM:
//
//   node tools/palette.test.js
//
// Every parser here handles untrusted input — text a user pasted, a file they
// dropped — so the bulk of these check that malformed input is REJECTED rather
// than partially accepted. A parser that half-understands a file imports wrong
// colours silently, which is worse than refusing it.

// Minimal localStorage stand-in, installed before the module loads.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};

const {
  parseHexColor, parseCoolorsUrl, parseGPL, parseHexList, parsePalette,
  clampStops, averageColor, toHex,
  listSavedPalettes, savePalette, deletePalette, MAX_STOPS,
} = await import('../src/palette-io.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`); }
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const eqColor = (c, r, g, b) => c && near(c[0], r, 2e-3) && near(c[1], g, 2e-3) && near(c[2], b, 2e-3);

console.log('\nhex parsing');
{
  check('#rrggbb', eqColor(parseHexColor('#264653'), 38 / 255, 70 / 255, 83 / 255));
  check('bare rrggbb', eqColor(parseHexColor('264653'), 38 / 255, 70 / 255, 83 / 255));
  check('#rgb shorthand expands', eqColor(parseHexColor('#f0a'), 1, 0, 170 / 255));
  check('white', eqColor(parseHexColor('#ffffff'), 1, 1, 1));
  check('black', eqColor(parseHexColor('#000000'), 0, 0, 0));
  for (const bad of ['', '#', '#12', '#12345', '#1234567', 'ggghhh', '#zzzzzz', null, 42, undefined, {}]) {
    check(`rejects ${JSON.stringify(bad)}`, parseHexColor(bad) === null);
  }
}

console.log('\ncoolors.co URLs');
{
  const want = ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'];
  const forms = [
    'https://coolors.co/264653-2a9d8f-e9c46a-f4a261-e76f51',
    'https://coolors.co/palette/264653-2a9d8f-e9c46a-f4a261-e76f51',
    'https://coolors.co/visualizer/264653-2a9d8f-e9c46a-f4a261-e76f51',
    'coolors.co/264653-2a9d8f-e9c46a-f4a261-e76f51',
    'https://coolors.co/264653-2a9d8f-e9c46a-f4a261-e76f51/',
    '  https://coolors.co/264653-2a9d8f-e9c46a-f4a261-e76f51?x=1  ',
  ];
  for (const f of forms) {
    const c = parseCoolorsUrl(f);
    const ok = c && c.length === 5 && c.map(toHex).join(',') === want.join(',');
    check(`parses ${f.trim().slice(0, 44)}`, ok);
  }
  check('rejects a non-coolors URL', parseCoolorsUrl('https://example.com/a-b-c') === null);
  check('rejects a coolors URL with junk', parseCoolorsUrl('https://coolors.co/264653-notahex') === null);
  check('rejects a single colour', parseCoolorsUrl('https://coolors.co/264653') === null);
}

console.log('\nGIMP .gpl');
{
  const gpl = [
    'GIMP Palette',
    'Name: Sunset',
    'Columns: 5',
    '#  a comment',
    ' 38  70  83\tDark',
    ' 42 157 143\tTeal',
    '233 196 106\tSand',
    '',
  ].join('\n');
  const p = parseGPL(gpl);
  check('reads the name', p && p.name === 'Sunset');
  check('reads every colour', p && p.colors.length === 3);
  check('first colour is right', p && eqColor(p.colors[0], 38 / 255, 70 / 255, 83 / 255));
  check('handles a missing trailing newline', parseGPL(gpl.trim()) !== null);
  check('survives CRLF', parseGPL(gpl.replace(/\n/g, '\r\n')) !== null);

  check('rejects a file without the magic line',
        parseGPL('Name: X\n 1 2 3') === null);
  check('rejects out-of-range channels',
        parseGPL('GIMP Palette\nName: X\n 300 0 0\n 0 0 0') === null);
  check('rejects a palette of one colour',
        parseGPL('GIMP Palette\nName: X\n 1 2 3') === null);
  check('rejects non-string input', parseGPL(null) === null);

  // A name is optional; a file without one should still import.
  const noName = parseGPL('GIMP Palette\n 10 20 30\n 40 50 60');
  check('name is optional', noName !== null && noName.colors.length === 2);
}

console.log('\nloose hex lists and dispatch');
{
  check('comma separated', parseHexList('#264653, #2a9d8f, #e9c46a')?.length === 3);
  check('newline separated', parseHexList('264653\n2a9d8f\ne9c46a')?.length === 3);
  check('rejects a list with one bad token', parseHexList('#264653, nope') === null);

  check('dispatch finds gpl', parsePalette('GIMP Palette\nName: N\n 1 2 3\n 4 5 6')?.source === 'gpl');
  check('dispatch finds coolors',
        parsePalette('https://coolors.co/264653-2a9d8f')?.source === 'coolors');
  check('dispatch finds hex list', parsePalette('#264653 #2a9d8f')?.source === 'hex');
  check('dispatch rejects prose', parsePalette('hello there, nice palette') === null);
  check('dispatch rejects empty', parsePalette('   ') === null);
  check('dispatch rejects non-string', parsePalette(undefined) === null);
}

console.log('\nstop fitting');
{
  const many = Array.from({ length: 20 }, (_, i) => [i / 19, 0, 1 - i / 19]);
  const fit = clampStops(many);
  check('long palettes resample to the cap', fit.length === MAX_STOPS);
  check('resampling keeps the first colour', eqColor(fit[0], 0, 0, 1));
  check('resampling keeps the last colour', eqColor(fit[MAX_STOPS - 1], 1, 0, 0));
  check('short palettes pass through', clampStops([[0, 0, 0], [1, 1, 1]]).length === 2);
  check('out-of-range values are clamped',
        eqColor(clampStops([[2, -1, 0.5]])[0], 1, 0, 0.5));
  check('garbage entries do not throw', clampStops([null, 'x', [0.5, 0.5, 0.5]]).length === 3);
  check('empty in, empty out', clampStops([]).length === 0);

  check('average of black and white is grey', eqColor(averageColor([[0, 0, 0], [1, 1, 1]]), 0.5, 0.5, 0.5));
  check('average of nothing is neutral', eqColor(averageColor([]), 0.5, 0.5, 0.5));
  check('round trip through hex', toHex(parseHexColor('#3a7bd5')) === '#3a7bd5');
}

console.log('\npersistence');
{
  mem.clear();
  check('starts empty', Object.keys(listSavedPalettes()).length === 0);
  check('saves', savePalette('Sunset', [[1, 0, 0], [0, 0, 1]]) === true);
  check('lists what was saved', listSavedPalettes().Sunset?.length === 2);
  check('survives a reload', eqColor(listSavedPalettes().Sunset[0], 1, 0, 0));
  check('overwrites by name', savePalette('Sunset', [[0, 1, 0], [0, 0, 1], [1, 1, 0]]) &&
        listSavedPalettes().Sunset.length === 3);
  check('rejects an empty name', savePalette('   ', [[1, 0, 0], [0, 1, 0]]) === false);
  check('rejects a one-colour palette', savePalette('Bad', [[1, 0, 0]]) === false);
  check('deletes', deletePalette('Sunset') === true &&
        Object.keys(listSavedPalettes()).length === 0);
  check('deleting what is absent is not an error', deletePalette('Nope') === false);

  // Corrupted storage must degrade to empty, never throw.
  mem.set('wgpu-fractal-modeler.palettes.v1', '{not json');
  check('corrupt storage reads as empty', Object.keys(listSavedPalettes()).length === 0);
  mem.set('wgpu-fractal-modeler.palettes.v1', '["an","array"]');
  check('wrong-shaped storage reads as empty', Object.keys(listSavedPalettes()).length === 0);
  mem.clear();

  // Storage can throw merely on access in private browsing / embedded webviews.
  const real = globalThis.localStorage;
  globalThis.localStorage = { get getItem() { throw new Error('denied'); },
                              setItem() { throw new Error('denied'); } };
  check('unavailable storage lists empty', Object.keys(listSavedPalettes()).length === 0);
  check('unavailable storage reports a failed save',
        savePalette('X', [[1, 0, 0], [0, 1, 0]]) === false);
  globalThis.localStorage = real;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
