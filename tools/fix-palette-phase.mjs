import fs from 'node:fs';

const path = 'src/fractal-bg.js';
let s = fs.readFileSync(path, 'utf8');
const oldText = `      state.colorPhase = (state.colorPhase + (dt / 1000) * state.colorCycle) % 1;`;
const newText = `      state.colorPhase += (dt / 1000) * state.colorCycle;`;
if (s.includes(oldText)) {
  s = s.replace(oldText, newText);
  fs.writeFileSync(path, s);
} else if (!s.includes(newText)) {
  throw new Error('color phase update site not found');
}
console.log('continuous palette phase verified');
