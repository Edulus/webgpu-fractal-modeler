// Run the existing quasicrystal suite against the final shader string WebGPU
// receives. fractal.wgsl.js is now a small assembler, so reading its JS source
// would test the wrapper rather than the WGSL it exports.
import fs from 'node:fs';
import { FRACTAL_WGSL } from '../src/shaders/fractal.wgsl.js';

const readFileSync = fs.readFileSync.bind(fs);
fs.readFileSync = (path, ...args) => {
  if (String(path).replaceAll('\\', '/') === 'src/shaders/fractal.wgsl.js') {
    return FRACTAL_WGSL;
  }
  return readFileSync(path, ...args);
};

await import('./quasicrystal-tests-base.js');
