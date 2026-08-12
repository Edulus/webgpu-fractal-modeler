from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    assert count == 1, f"{label}: expected 1 match, found {count}"
    return text.replace(old, new, 1)


# Renderer: reduced-motion should suppress only autonomous colour animation.
# Once the user moves the colour-speed slider, that is an explicit opt-in.
p = Path('src/fractal-bg.js')
s = p.read_text()

s = replace_once(
    s,
    "} from './camera.js';\n\n// ---- Uniform buffer layout",
    "} from './camera.js';\n\n"
    "// Reduced-motion suppresses autonomous colour cycling, but a user moving\n"
    "// the colour-speed slider is an explicit request for that animation. Keep\n"
    "// this policy pure so the desktop/reduced-motion behaviour is testable.\n"
    "export function colorCycleMotionAllowed(reducedMotion, explicit) {\n"
    "  return !reducedMotion || !!explicit;\n"
    "}\n\n"
    "export function colorCycleNeedsLoop(reducedMotion, controls, explicit, rate) {\n"
    "  return !reducedMotion || !!controls || (!!explicit && Number(rate) > 0);\n"
    "}\n\n"
    "// ---- Uniform buffer layout",
    'insert colour-cycle motion policy',
)

s = replace_once(
    s,
    "    colorCycle: opts.colorCycle ?? 0.025,\n    colorPhase: 0,",
    "    colorCycle: opts.colorCycle ?? 0.025,\n"
    "    // False until the user explicitly moves the colour-speed control.\n"
    "    // This lets prefers-reduced-motion suppress the boot-time animation\n"
    "    // without disabling a later deliberate request from the user.\n"
    "    colorCycleExplicit: false,\n"
    "    colorPhase: 0,",
    'add explicit colour-cycle state',
)

s = replace_once(
    s,
    "    d[U.colorCycle] = state.colorCycle;\n    d[U.colorPhase] = rm ? 0.0 : state.colorPhase;",
    "    d[U.colorCycle] = state.colorCycle;\n"
    "    d[U.colorPhase] = colorCycleMotionAllowed(rm, state.colorCycleExplicit)\n"
    "      ? state.colorPhase : 0.0;",
    'allow explicit phase under reduced motion',
)

old_loop = """    const acc = accumulating(nowMs);
    if (!reducedMotion()) {
      // Palette phase has its own clock: it remains live on a converged frame.
      // Geometry time still freezes while accumulating, so the material samples
      // describe one stable scene instead of smearing animation together.
      state.colorPhase += (dt / 1000) * state.colorCycle;
      if (!acc) {
        state.animTime += dt / 1000;
        state.parallax.x += (state.parallax.tx - state.parallax.x) * 0.05;
        state.parallax.y += (state.parallax.ty - state.parallax.y) * 0.05;
      }
    }
"""
new_loop = """    const acc = accumulating(nowMs);
    const rm = reducedMotion();
    // Colour cycling is independent of geometry motion. Reduced-motion keeps
    // autonomous animation still, while moving the speed slider explicitly
    // opts colour motion back in.
    if (colorCycleMotionAllowed(rm, state.colorCycleExplicit)) {
      state.colorPhase += (dt / 1000) * state.colorCycle;
    }
    // Geometry/parallax remain governed by reduced-motion exactly as before.
    if (!rm && !acc) {
      state.animTime += dt / 1000;
      state.parallax.x += (state.parallax.tx - state.parallax.x) * 0.05;
      state.parallax.y += (state.parallax.ty - state.parallax.y) * 0.05;
    }
"""
s = replace_once(s, old_loop, new_loop, 'split colour clock from geometry reduced-motion policy')

old_start = """    // Under reduced-motion we normally render a single static pose. But when
    // interactive controls are on (explorer mode), keep the loop alive so
    // drag/pinch/zoom stay smooth — we just don't auto-animate parameters.
    if (reducedMotion() && !state.controls) {
      renderFrame(performance.now(), true);
      return;
    }
"""
new_start = """    // Under reduced-motion we normally render a single static pose. Keep the
    // loop alive for interactive navigation, or when the user explicitly asks
    // the colour-speed slider for a non-zero animation rate.
    if (!colorCycleNeedsLoop(
      reducedMotion(), state.controls, state.colorCycleExplicit, state.colorCycle)) {
      renderFrame(performance.now(), true);
      return;
    }
"""
s = replace_once(s, old_start, new_start, 'keep loop alive for explicit colour cycling')

old_setter = """    setColorCycle(rate) {
      state.colorCycle = Math.max(0, Number(rate) || 0);
      if (!state.running) renderFrame(performance.now(), true);
    },
"""
new_setter = """    setColorCycle(rate) {
      // Calling this method represents deliberate user/application intent. It
      // therefore overrides the automatic reduced-motion suppression for the
      // colour cycle only; geometry motion remains suppressed.
      state.colorCycleExplicit = true;
      state.colorCycle = Math.max(0, Number(rate) || 0);
      // A reduced-motion landing page may be sitting on its one static frame.
      // Re-evaluate the loop immediately: positive rates animate, zero goes
      // back to sleeping after presenting the current phase once.
      if (reducedMotion() && !state.controls) {
        stop();
        updateRunning();
      } else if (!state.running) {
        renderFrame(performance.now(), true);
      }
    },
"""
s = replace_once(s, old_setter, new_setter, 'make slider an explicit reduced-motion opt-in')

s = replace_once(
    s,
    "        colorCycle: state.colorCycle,\n        image: { ...state.image },",
    "        colorCycle: state.colorCycle,\n"
    "        colorCycleActive: state.colorCycle > 0\n"
    "          && colorCycleMotionAllowed(reducedMotion(), state.colorCycleExplicit),\n"
    "        image: { ...state.image },",
    'expose effective colour-cycle state',
)

p.write_text(s)


# Demo UI: if reduced-motion suppressed the boot-time cycle, show the slider at
# 0 instead of claiming speed 1 while the image is static. Moving it to 1+ calls
# setColorCycle(), which is the explicit opt-in above.
p = Path('index.html')
s = p.read_text()
old_ui = """        const currentRate = Math.max(0, Number(handle.info.colorCycle) || 0);
        const baseRate = currentRate > 0 ? currentRate : 0.025;
        speed.value = currentRate > 0 ? '1' : '0';
        value.textContent = speed.value;
"""
new_ui = """        const currentRate = Math.max(0, Number(handle.info.colorCycle) || 0);
        const baseRate = currentRate > 0 ? currentRate : 0.025;
        // On a reduced-motion desktop the boot-time colour cycle is suppressed.
        // Reflect the EFFECTIVE state so the control does not say speed 1 while
        // the picture is static; moving it above zero is an explicit opt-in.
        const cycleActive = handle.info.colorCycleActive
          ?? (currentRate > 0 && !handle.info.reducedMotion);
        speed.value = cycleActive ? '1' : '0';
        value.textContent = speed.value;
"""
s = replace_once(s, old_ui, new_ui, 'show effective colour-cycle state in slider')
p.write_text(s)


# Tests: pin the reduced-motion/explicit-intent contract.
p = Path('tools/colorcycle.test.js')
s = p.read_text()
s = replace_once(
    s,
    "import { PALETTES } from '../src/palettes.js';\n",
    "import { PALETTES } from '../src/palettes.js';\n"
    "import { colorCycleMotionAllowed, colorCycleNeedsLoop } from '../src/fractal-bg.js';\n",
    'import colour-cycle policy helpers',
)

marker = "console.log('\\npalette-coordinate cycling');\n"
section = """console.log('\\ncolour-cycle motion policy');
{
  check('reduced motion suppresses the autonomous boot-time cycle',
        !colorCycleMotionAllowed(true, false));
  check('moving the slider explicitly opts colour motion back in',
        colorCycleMotionAllowed(true, true));
  check('normal motion allows cycling without an explicit opt-in',
        colorCycleMotionAllowed(false, false));
  check('reduced-motion static page can sleep before opt-in',
        !colorCycleNeedsLoop(true, false, false, 0.025));
  check('positive explicit slider rate keeps the reduced-motion page rendering',
        colorCycleNeedsLoop(true, false, true, 0.025));
  check('slider at zero lets a reduced-motion static page sleep again',
        !colorCycleNeedsLoop(true, false, true, 0));
  check('interactive viewer keeps rendering under reduced motion',
        colorCycleNeedsLoop(true, true, false, 0));
}

"""
s = replace_once(s, marker, section + marker, 'add reduced-motion colour-cycle tests')
p.write_text(s)

print('desktop colour-shift patch applied')
