from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'pattern not found in {path}: {old[:100]!r}')
    if s.count(old) != 1:
        raise SystemExit(f'pattern occurs {s.count(old)} times in {path}')
    p.write_text(s.replace(old, new, 1))

# This app should present the same opaque/background treatment before and after
# Enter Shape Explorer. Explorer already preserves the active presentation mode,
# so initialize the app in the desired Explorer-style mode from frame one.
replace_once('index.html', '''      transparent: true,
      onUnsupported: (reason) => {
''', '''      // Match the Shape Explorer presentation from the first rendered frame.
      // Entering Explorer then changes camera ownership only, with no colour cut.
      transparent: false,
      onUnsupported: (reason) => {
''')

# Extend the existing transition regression test to lock in the direction of
# continuity: landing adopts Explorer's opaque presentation, rather than making
# Explorer adopt the former transparent landing treatment.
p = Path('tools/presentation.test.js')
s = p.read_text()
needle = "check('entering Explorer does not change transparency/compositing', !mode.includes('applyTransparent('));\n"
insert = needle + "\nconst bootStart = html.indexOf('handle = await initFractalBackground');\nconst bootEnd = html.indexOf('});', bootStart);\nconst boot = html.slice(bootStart, bootEnd);\ncheck('landing starts in Shape Explorer opaque presentation', boot.includes('transparent: false'));\ncheck('landing does not request the old transparent presentation', !boot.includes('transparent: true'));\n"
if s.count(needle) != 1:
    raise SystemExit(f'expected one presentation-test insertion point, got {s.count(needle)}')
p.write_text(s.replace(needle, insert, 1))
