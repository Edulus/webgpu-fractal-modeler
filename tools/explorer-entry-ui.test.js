let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

console.log('\nExplorer entry UI');

let removed = false;
const style = {};
const duplicate = {
  closest(sel) {
    check('duplicate selector resolves its landing container', sel === 'main.wrap');
    return { remove() { removed = true; } };
  },
};
const explorer = { style };

globalThis.document = {
  readyState: 'complete',
  querySelector(sel) {
    check('targets only the standalone Explorer entry',
      sel === 'main.wrap button[onclick*="btn-explorer"]');
    return duplicate;
  },
  getElementById(id) {
    check('targets the control-panel Explorer button', id === 'btn-explorer');
    return explorer;
  },
};

await import(`../src/palettes.js?explorer-entry-ui=${Date.now()}`);

check('standalone Explorer entry container is removed', removed);
check('panel Explorer button gets stronger accent fill',
  style.background === 'rgba(127, 231, 212, 0.24)');
check('panel Explorer button gets stronger accent border',
  style.borderColor === 'rgba(127, 231, 212, 0.72)');
check('panel Explorer button gets brighter text', style.color === '#dffff8');
check('panel Explorer button gets heavier label weight', style.fontWeight === '700');
check('panel Explorer button gets subtle glow',
  style.boxShadow === '0 0 16px rgba(127, 231, 212, 0.14)');

delete globalThis.document;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
