import fs from 'node:fs';

function replaceOnce(path, oldText, newText, label) {
  let s = fs.readFileSync(path, 'utf8');
  if (s.includes(newText)) return;
  const i = s.indexOf(oldText);
  if (i < 0) throw new Error(`missing ${label} in ${path}`);
  if (s.indexOf(oldText, i + oldText.length) >= 0) throw new Error(`non-unique ${label} in ${path}`);
  s = s.slice(0, i) + newText + s.slice(i + oldText.length);
  fs.writeFileSync(path, s);
}

replaceOnce(
  'src/shaders/material.wgsl.js',
  `  let glowOut = clamp(glow * u.glowStrength * 0.02, 0.0, 8.0);`,
  `  // fs_main discarded near-miss glow when no surface was actually hit. Keep
  // that static-image contract while moving the hit material into post.
  let glowOut = select(0.0, clamp(glow * u.glowStrength * 0.02, 0.0, 8.0), hit);`,
  'hit-only glow');

replaceOnce(
  'src/shaders/attractor.wgsl.js',
`  // A circular mean survives the cyclic 1->0 boundary: averaging bare t values
  // would turn samples near 0.99 and 0.01 into 0.5, the opposite side of the
  // palette. x/y carry the weighted unit circle; z carries total intensity.
  out.material = vec4<f32>(cos(a) * intensity,
                           sin(a) * intensity,
                           intensity,
                           intensity * 0.7 * u.glowStrength);
  out.aux = vec4<f32>(0.0);`,
`  // Keep both coordinate representations. Cosine presets can have different
  // per-channel frequencies and therefore are not necessarily period-1, so a
  // linear weighted mean preserves their unwrapped t. Imported stop ramps are
  // explicitly cyclic, so the auxiliary attachment carries a circular mean
  // that treats 0.99 and 0.01 as neighbours instead of averaging them to 0.5.
  // Emission is scalar and palette-independent, so it lives beside the linear
  // coordinate rather than consuming another circular channel.
  out.material = vec4<f32>(in.speed * 1.15 * intensity,
                           intensity,
                           intensity * 0.7 * u.glowStrength,
                           0.0);
  out.aux = vec4<f32>(cos(a) * intensity,
                      sin(a) * intensity,
                      intensity,
                      0.0);`,
  'dual attractor coordinates');

replaceOnce(
  'src/shaders/composite.wgsl.js',
`  if (u.fractalType > 22.5) {
    // For additive line geometry, m.xy is the intensity-weighted circular mean
    // of the palette coordinate and m.z is total line intensity.
    if (m.z > 1e-7) {
      let t = atan2(m.y, m.x) / TAU;
      color = color + attractorPalette(t + phase) * m.z;
    }
    // Attractors did not have the raymarcher's pre-bloom glow tint; their alpha
    // is emission only, so preserve that behavior here.
    return vec4<f32>(color, m.w);
  }`,
`  if (u.fractalType > 22.5) {
    // Cosine presets use the unwrapped linear mean in material.xy. Imported
    // ramps are period-1 by construction, so use the circular mean in aux.xyz
    // to keep samples on either side of the 1->0 seam adjacent.
    if (m.y > 1e-7) {
      var t = m.x / m.y;
      if (u.paletteMode > 0.5 && a.z > 1e-7) {
        t = atan2(a.y, a.x) / TAU;
      }
      color = color + attractorPalette(t + phase) * m.y;
    }
    // Attractors did not have the raymarcher's pre-bloom glow tint; their alpha
    // is emission only, so preserve that behavior here.
    return vec4<f32>(color, m.z);
  }`,
  'attractor resolve');

replaceOnce(
  'tools/shader-check.html',
`import { FRACTAL_WGSL } from '../src/shaders/fractal.wgsl.js';
import { COMPOSITE_WGSL } from '../src/shaders/composite.wgsl.js';`,
`import { FRACTAL_WGSL } from '../src/shaders/fractal.wgsl.js';
import { MATERIAL_WGSL } from '../src/shaders/material.wgsl.js';
import { COMPOSITE_WGSL } from '../src/shaders/composite.wgsl.js';`,
  'material shader import');

replaceOnce(
  'tools/shader-check.html',
`    ['fractal.wgsl', FRACTAL_WGSL],
    ['composite.wgsl', COMPOSITE_WGSL],`,
`    ['fractal.wgsl', FRACTAL_WGSL],
    ['material.wgsl', MATERIAL_WGSL],
    ['composite.wgsl', COMPOSITE_WGSL],`,
  'material shader compile list');

console.log('palette material details verified');
