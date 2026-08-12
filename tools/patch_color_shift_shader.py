from pathlib import Path

shader = Path('src/shaders/composite.wgsl.js')
s = shader.read_text()
old = "  let phase = select(u.colorPhase, 0.0, u.reducedMotion > 0.5);"
new = "  // Reduced-motion policy is enforced on the CPU. If the user explicitly\n  // moves the colour-speed slider, u.colorPhase is allowed to advance even\n  // under reduced motion, so the shader must consume that phase unchanged.\n  let phase = u.colorPhase;"
if old not in s:
    raise SystemExit('expected reduced-motion phase gate not found')
shader.write_text(s.replace(old, new, 1))

test = Path('tools/colorcycle.test.js')
t = test.read_text()
if "from 'node:fs'" not in t:
    anchor = "import { PALETTES } from '../src/palettes.js';\n"
    if anchor not in t:
        raise SystemExit('palette import anchor not found')
    t = t.replace(anchor, "import { readFileSync } from 'node:fs';\n" + anchor, 1)

marker = "console.log('\\npalette-coordinate cycling');\n"
block = """console.log('\\nshader colour-cycle phase');
{
  const shaderSource = readFileSync(new URL('../src/shaders/composite.wgsl.js', import.meta.url), 'utf8');
  check('composite consumes the CPU-approved colour phase directly',
        shaderSource.includes('let phase = u.colorPhase;'));
  check('composite no longer suppresses colour phase under reduced motion',
        !shaderSource.includes('select(u.colorPhase, 0.0, u.reducedMotion'));
}

"""
if block not in t:
    if marker not in t:
        raise SystemExit('test insertion marker not found')
    t = t.replace(marker, block + marker, 1)
test.write_text(t)
print('shader colour-shift gate removed and regression tests added')
