// Run the established shape-parameter invariant suite against the final shader
// string WebGPU receives. fractal.wgsl.js is now an assembler around the proven
// base shader, so its JavaScript source is not itself the WGSL under test.
import fs from 'node:fs';
import { FRACTAL_WGSL } from '../src/shaders/fractal.wgsl.js';

const readFileSync = fs.readFileSync.bind(fs);
fs.readFileSync = (path, ...args) => {
  if (String(path).replaceAll('\\', '/') === 'src/shaders/fractal.wgsl.js') {
    return FRACTAL_WGSL;
  }
  return readFileSync(path, ...args);
};

await import('./shape-params-tests-base.js');
