from pathlib import Path

html_path = Path('index.html')
html = html_path.read_text()
old_style = '''    #btn-explorer {\n      background: rgba(127, 231, 212, 0.14);\n      border-color: rgba(127, 231, 212, 0.4);\n      color: var(--accent);\n      font-weight: 600;\n    }\n'''
new_style = '''    #btn-explorer {\n      background: rgba(127, 231, 212, 0.24);\n      border-color: rgba(127, 231, 212, 0.72);\n      color: #dffff8;\n      font-weight: 700;\n      box-shadow: 0 0 16px rgba(127, 231, 212, 0.14);\n    }\n    #btn-explorer:hover {\n      background: rgba(127, 231, 212, 0.32);\n      border-color: var(--accent);\n    }\n'''
if old_style not in html:
    raise SystemExit('explorer button style block not found')
html = html.replace(old_style, new_style, 1)

old_landing = '''  <!-- The landing view is the artwork itself. Keep only the one action needed\n       to hand control of that same view to the user. -->\n  <main class="wrap">\n    <div class="actions">\n      <button class="btn primary" onclick="document.getElementById('btn-explorer').click()">Enter shape explorer</button>\n    </div>\n  </main>\n\n'''
if old_landing not in html:
    raise SystemExit('standalone landing explorer button block not found')
html = html.replace(old_landing, '', 1)
html_path.write_text(html)

test_path = Path('tools/presentation.test.js')
test = test_path.read_text()
old_tests = '''const landingStart = html.indexOf('  <!-- The landing view is the artwork itself.');\nconst landingEnd = html.indexOf('  <script type="module">', landingStart);\nconst landing = html.slice(landingStart, landingEnd);\ncheck('landing keeps Enter Shape Explorer action', landing.includes('Enter shape explorer'));\ncheck('landing headline is removed', !landing.includes('<h1>'));\ncheck('landing lede is removed', !landing.includes('class="lede"'));\ncheck('landing demo copy is removed', !landing.includes('content-block'));\ncheck('CSS gradient backdrop remains available', html.includes('radial-gradient(1200px 800px at 20% -10%'));\n'''
new_tests = '''check('standalone landing Explorer action is removed',\n  !html.includes("document.getElementById('btn-explorer').click()"));\ncheck('control-panel Explorer button remains', html.includes('<button id="btn-explorer">Enter shape explorer</button>'));\ncheck('control-panel Explorer button is visually emphasized',\n  html.includes('background: rgba(127, 231, 212, 0.24)') &&\n  html.includes('border-color: rgba(127, 231, 212, 0.72)') &&\n  html.includes('font-weight: 700'));\ncheck('landing headline is removed', !html.includes('<h1>'));\ncheck('landing lede is removed', !html.includes('class="lede"'));\ncheck('landing demo copy is removed', !html.includes('content-block'));\ncheck('CSS gradient backdrop remains available', html.includes('radial-gradient(1200px 800px at 20% -10%'));\n'''
if old_tests not in test:
    raise SystemExit('presentation landing test block not found')
test = test.replace(old_tests, new_tests, 1)
test_path.write_text(test)
