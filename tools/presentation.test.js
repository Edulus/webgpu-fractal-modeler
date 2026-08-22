import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

console.log('\nseamless landing / Shape Explorer presentation');
const renderer = readFileSync(new URL('../src/fractal-bg.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const modeStart = renderer.indexOf('  function applyCameraMode() {');
const modeEnd = renderer.indexOf('  // Enable/disable drag/pinch/wheel navigation.', modeStart);
const mode = renderer.slice(modeStart, modeEnd);
check('camera mode still enables interactive controls', mode.includes('applyControls(interactive)'));
check('camera mode still owns auto-orbit lifecycle', mode.includes('state.autoOrbit = !interactive'));
check('entering Explorer does not change transparency/compositing', !mode.includes('applyTransparent('));

const bootStart = html.indexOf('handle = await initFractalBackground');
const bootEnd = html.indexOf('});', bootStart);
const boot = html.slice(bootStart, bootEnd);
check('landing starts in Shape Explorer opaque presentation', boot.includes('transparent: false'));
check('landing does not request the old transparent presentation', !boot.includes('transparent: true'));

const landingStart = html.indexOf('  <!-- The landing view is the artwork itself.');
const landingEnd = html.indexOf('  <script type="module">', landingStart);
const landing = html.slice(landingStart, landingEnd);
check('landing keeps Enter Shape Explorer action', landing.includes('Enter shape explorer'));
check('landing headline is removed', !landing.includes('<h1>'));
check('landing lede is removed', !landing.includes('class="lede"'));
check('landing demo copy is removed', !landing.includes('content-block'));
check('CSS gradient backdrop remains available', html.includes('radial-gradient(1200px 800px at 20% -10%'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
