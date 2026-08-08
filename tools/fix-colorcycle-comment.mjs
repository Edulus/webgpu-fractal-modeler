import fs from 'node:fs';

const path = 'src/fractal-bg.js';
let s = fs.readFileSync(path, 'utf8');
const oldText = `    /**
     * Palette cycling rate, in full colour cycles per second. 0 stops it.
     * Deliberately does NOT reset accumulation: the cycle lives in the post
     * chain, so a converged image keeps its sharpness while the colour moves.
     */
    /**
     * Post-chain image adjustments. Accepts any subset of
     * {exposure, contrast, saturation, hue}; hue is in turns, 0..1.
     * Like the colour cycle these live in the composite pass, so they do NOT
     * reset accumulation -- a slider drag stays sharp instead of re-marching.
     */
    setImageAdjust(next) {
      const im = state.image;
      for (const k of ['exposure', 'contrast', 'saturation', 'hue']) {
        if (next && next[k] !== undefined) im[k] = Number(next[k]) || 0;
      }
      if (!state.running) renderFrame(performance.now(), true);
    },
    setColorCycle(rate) {`;
const newText = `    /**
     * Post-chain image adjustments. Accepts any subset of
     * {exposure, contrast, saturation, hue}; hue is in turns, 0..1.
     * Like the colour cycle these live in the composite pass, so they do NOT
     * reset accumulation -- a slider drag stays sharp instead of re-marching.
     */
    setImageAdjust(next) {
      const im = state.image;
      for (const k of ['exposure', 'contrast', 'saturation', 'hue']) {
        if (next && next[k] !== undefined) im[k] = Number(next[k]) || 0;
      }
      if (!state.running) renderFrame(performance.now(), true);
    },
    /**
     * Palette-coordinate shift rate per second. 0 stops it. The phase is
     * resolved after material accumulation, so a converged image stays sharp
     * while the selected palette moves across its stored coordinates.
     */
    setColorCycle(rate) {`;
if (s.includes(oldText)) {
  s = s.replace(oldText, newText);
  fs.writeFileSync(path, s);
} else if (!s.includes(newText)) {
  throw new Error('colour-cycle API comment target not found');
}
console.log('colour-cycle API comment verified');
