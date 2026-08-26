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

// There are two modes and the page is always in one of them, so the landing
// state is gone entirely -- along with the control for entering and leaving it.
// The failure this guards against is a half-removal: the button gone but the
// markup or CSS for the landing still there, or vice versa, which leaves a
// state reachable that nothing can steer.
check('landing markup is gone', !html.includes('<main class="wrap"'));
check('no Enter/Exit Shape Explorer control remains', !html.includes('btn-explorer'));
check('landing copy is gone', !html.includes('content-block') && !html.includes('class="lede"'));
check('landing CSS went with it', !html.includes('    .wrap {') && !html.includes('    .btn {'));
check('the fly-through toggle is the only mode control', html.includes('id="btn-fly"'));
check('CSS gradient backdrop remains available', html.includes('radial-gradient(1200px 800px at 20% -10%'));

// Explorer is entered by the page itself, not by a click, and before the first
// frame -- so no frame is ever shown in a mode the page does not offer.
check('the page enters Shape Explorer on its own', boot.includes('handle.setExplorer(true)')
  || html.includes('if (handle) handle.setExplorer(true);'));

// setFly(false) alone drops the camera into the library's background mode,
// which this page no longer has. Leaving fly-through must therefore say so.
const flyStart = html.indexOf("btnFly.addEventListener('click'");
const fly = html.slice(flyStart, html.indexOf('});', flyStart));
check('leaving fly-through returns to Explorer rather than a third state',
  fly.includes('handle.setExplorer(true)'));

// palettes.js briefly carried demo-page DOM chrome to manage the old Enter
// button. That button is gone, so the module must be a palette module again --
// a renderer dependency reaching into the page is exactly the coupling that
// makes a UI change like this one hard.
const palettes = readFileSync(new URL('../src/palettes.js', import.meta.url), 'utf8');
check('palettes.js touches no DOM', !palettes.includes('document'));

// ---- Starting up ----------------------------------------------------------
// The wait is announced in exactly one place. It used to be a word in the panel
// as well, which said the same thing twice and then sat there stale, since the
// panel readout is only replaced once the renderer reports a frame.
check('the panel readout starts empty rather than naming the wait',
  /<div id="hud"><\/div>/.test(html));
check('the boot card is what states the renderer is starting',
  /<div id="boot-title">Starting the renderer<\/div>/.test(html));
check('the empty readout still holds its height, so the panel does not jump',
  /#hud \{[^}]*min-height:/.test(html));

// The bar is indeterminate by intent: nothing between "compile requested" and
// "compiled" tells us how far along it is. A one-way sweep that restarts reads
// as a queue being drained -- a claim about progress this cannot make -- so it
// travels back instead.
const barCss = html.slice(html.indexOf('#boot-bar i {'), html.indexOf('body.booting #panel {'));
check('the bar reverses rather than sweeping and snapping back',
  /animation:[^;]*alternate/.test(barCss));
check('the bar travels between the ends of its track, staying visible',
  /from \{ transform: translateX\(0\); \}/.test(barCss)
  && /to   \{ transform: translateX\(163%\); \}/.test(barCss));
// 38% wide, so 163% of its own width is exactly the remaining track. Getting
// this wrong slides it out of view at one end, which looks like a stall.
const barWidth = Number(barCss.match(/width: ([\d.]+)%;/)[1]);
const travel = Number(barCss.match(/to   \{ transform: translateX\((\d+)%\); \}/)[1]);
check('the travel matches the bar width, so it lands flush at each end',
  Math.abs((100 - barWidth) / barWidth * 100 - travel) < 2);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
