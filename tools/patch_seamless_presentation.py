from pathlib import Path
import re


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if s.count(old) != 1:
        raise SystemExit(f'expected one match in {path}, got {s.count(old)}')
    p.write_text(s.replace(old, new, 1))


# Keep the renderer presentation mode stable while camera ownership changes.
# Entering Shape Explorer should enable navigation, not reconfigure the canvas
# from transparent/background compositing to the opaque viewer presentation.
replace_once(
    'src/fractal-bg.js',
    '''  // Both camera modes need the same things switched on, and they are mutually
  // exclusive. Deriving that from the flags in one place means callers cannot
  // get the ordering wrong -- an earlier version had setFly enable navigation
  // and a following setExplorer(false) immediately turn it back off.
  function applyCameraMode() {
    const interactive = state.fly || state.explorer;
    applyControls(interactive);
    state.accumSamples = 0;
    applyTransparent(interactive ? false : !!opts.transparent);
    state.autoOrbit = !interactive;
  }
''',
    '''  // Camera mode changes only who owns navigation. Presentation remains
  // unchanged so entering Shape Explorer cannot alter the apparent palette by
  // switching the canvas from transparent-over-page compositing to opaque.
  // Fly and Explorer are mutually exclusive; deriving controls from the flags
  // here keeps their input lifecycle in one place.
  function applyCameraMode() {
    const interactive = state.fly || state.explorer;
    applyControls(interactive);
    state.accumSamples = 0;
    state.autoOrbit = !interactive;
  }
''')

p = Path('index.html')
s = p.read_text()
pattern = re.compile(
    r'''  <!-- Page content demonstrating the embeddable background mode -->\n  <main class="wrap">.*?\n  </main>''',
    re.S,
)
replacement = '''  <!-- The landing view is the artwork itself. Keep only the one action needed
       to hand control of that same view to the user. -->
  <main class="wrap">
    <div class="actions">
      <button class="btn primary" onclick="document.getElementById('btn-explorer').click()">Enter shape explorer</button>
    </div>
  </main>'''
s2, n = pattern.subn(replacement, s, count=1)
if n != 1:
    raise SystemExit(f'expected one landing-content block, got {n}')

s2 = s2.replace(
    '''    /* Explorer mode: fade the reading content out of the way so the fractal
       becomes a full-screen, navigable shape. */''',
    '''    /* Explorer mode hides the one landing action so the artwork becomes a
       full-screen navigable shape. */''',
    1,
)
p.write_text(s2)

# Persistent source-contract regression test. It deliberately checks the mode
# boundary rather than shader colours: if Explorer does not change transparency,
# the same bgMode, CSS backdrop, palette and color phase continue across entry.
Path('tools/presentation.test.js').write_text(r'''import { readFileSync } from 'node:fs';

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
''')
