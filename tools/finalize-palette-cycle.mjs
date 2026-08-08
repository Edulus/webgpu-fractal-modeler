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
  'tools/colorcycle.test.js',
`console.log('\\nattractor circular palette coordinate');
{
  function lineMaterial(t, intensity = 1) {
    const a = TAU * t;
    return [Math.cos(a) * intensity, Math.sin(a) * intensity, intensity, 0];
  }
  const x = lineMaterial(0.99);
  const y = lineMaterial(0.01);
  const sum = add(x, y);
  let t = Math.atan2(sum[1], sum[0]) / TAU;
  if (t < 0) t += 1;
  check('0.99 and 0.01 average around the palette seam, not opposite it', t < 0.02 || t > 0.98, \`t=\${t}\`);
  check('circular mean retains the summed line intensity', near(sum[2], 2));
}`,
`console.log('\\nattractor palette coordinates');
{
  function lineMaterial(t, intensity = 1, glow = 0.7) {
    const a = TAU * t;
    return {
      material: [t * intensity, intensity, intensity * glow, 0],
      aux: [Math.cos(a) * intensity, Math.sin(a) * intensity, intensity, 0],
    };
  }
  const x = lineMaterial(0.99);
  const y = lineMaterial(0.01);
  const m = add(x.material, y.material);
  const a = add(x.aux, y.aux);

  const linearT = m[0] / m[1];
  check('cosine palettes retain the unwrapped linear mean', near(linearT, 0.5), \`t=\${linearT}\`);
  check('linear representation retains the summed line intensity', near(m[1], 2));
  check('line emission remains scalar and additive', near(m[2], 1.4));

  let circularT = Math.atan2(a[1], a[0]) / TAU;
  if (circularT < 0) circularT += 1;
  check('imported ramps average around the palette seam', circularT < 0.02 || circularT > 0.98, \`t=\${circularT}\`);
  check('circular representation retains the summed line intensity', near(a[2], 2));
}`,
  'dual attractor palette tests');

replaceOnce(
  'README.md',
`| \`setColorCycle(rate)\` | Hue cycles per second; \`0\` stops it. Does not reset accumulation. |`,
`| \`setColorCycle(rate)\` | Palette-coordinate shift rate per second; \`0\` stops it. Re-indexes the selected palette without resetting accumulation. |`,
  'setColorCycle API wording');

replaceOnce(
  'README.md',
`Parsing runs on untrusted input — pasted text, dropped files — so every parser returns null rather than throwing, and refuses input it only partly understands rather than importing wrong colours silently. \`localStorage\` is used over cookies: cookies cap near 4KB and travel with every request. Storage that is unavailable (private browsing, embedded webviews, quota) degrades to "could not save" instead of breaking the page. All of it is covered by \`node tools/palette.test.js\`.

## Progressive accumulation`,
`Parsing runs on untrusted input — pasted text, dropped files — so every parser returns null rather than throwing, and refuses input it only partly understands rather than importing wrong colours silently. \`localStorage\` is used over cookies: cookies cap near 4KB and travel with every request. Storage that is unavailable (private browsing, embedded webviews, quota) degrades to "could not save" instead of breaking the page. All of it is covered by \`node tools/palette.test.js\`.

### Palette-faithful colour cycling

Colour cycling re-indexes the palette rather than rotating the finished RGB image. The expensive model pass stores palette coordinates, scalar lighting weights, neutral specular light, fog/background coverage and emission in two \`rgba16float\` material attachments. The post chain looks those coordinates up in the currently selected cosine preset or imported stop ramp, and applies the live cycle phase before bloom and tonemapping.

That separation has two useful consequences. A converged 96-sample image can keep cycling without another raymarch, and changing from one palette to another recolours the converged material immediately instead of throwing the accumulated geometry samples away. The explicit **Hue** image control remains a separate post-process rotation for users who deliberately want to move away from the selected palette.

Imported stop ramps are cyclic by definition and wrap every palette-coordinate unit. Cosine presets may use different frequencies in their RGB channels, so their phase advances continuously rather than being forcibly wrapped at 1; that avoids a discontinuity in presets such as Ember and Iridescence.

## Progressive accumulation`,
  'palette-faithful documentation section');

replaceOnce(
  'README.md',
`Sampling starts after a short pause in input and stops at a cap; past that the raymarch is skipped entirely and the converged image is re-presented, which drops idle GPU cost to the post-processing chain alone. Any input, or a change of model, palette, quality or size, resets the average.`,
`Sampling starts after a short pause in input and stops at a cap; past that the raymarch is skipped entirely and the converged material is re-presented through the post chain, which drops idle GPU cost to palette resolution, bloom and composite. Camera/model/quality/size changes reset the average because they change the sampled geometry. Palette changes and colour-cycle phase do not: they are resolved after accumulation.`,
  'progressive accumulation invalidation');

replaceOnce(
  'README.md',
`The renderer uses two principal stages:

1. **HDR model pass**
   - Distance-estimated models are sphere-traced in a fullscreen fragment shader.
   - Strange attractors are integrated on the CPU with RK4 and drawn as additively blended line geometry.
   - Surface shading includes tetrahedron normals, directional lighting, soft shadows, ambient occlusion, orbit-trap colour, Fresnel rim light, near-miss glow, and distance fog.

2. **Composite pass**
   - Separable Gaussian bloom
   - ACES tonemapping
   - Gamma correction
   - Subtle vignette
   - Dithering to reduce banding

The raymarch pass writes to an offscreen \`rgba16float\` texture. Lit colour occupies RGB, while emission and glow feed the alpha channel for post-processing.

Uniforms occupy one 160-byte, 16-byte-aligned buffer. The byte offsets are mirrored between the WGSL structs and the JavaScript \`U\` offset table in \`fractal-bg.js\`; keep both definitions synchronized when changing the layout.`,
`The renderer uses two principal stages:

1. **Palette-independent model/material pass**
   - Distance-estimated models are sphere-traced in a fullscreen fragment shader.
   - Strange attractors are integrated on the CPU with RK4 and drawn as weighted additive line geometry.
   - Two \`rgba16float\` attachments carry palette coordinates and scalar shading terms rather than baked RGB.
   - Progressive samples are averaged directly into those attachments with fixed-function blend constants, so no accumulation ping-pong textures or separate accumulation pass are required.

2. **Palette resolve + composite pass**
   - The selected cosine palette or imported stop ramp is evaluated from the stored coordinates at the live cycle phase.
   - Separable Gaussian bloom runs on the resolved HDR colour, so bloom follows the palette cycle too.
   - The explicit Hue image adjustment, exposure, saturation and contrast follow as post controls.
   - ACES tonemapping, gamma correction, vignette and dithering produce the final presentation image.

Surface shading still includes directional lighting, soft shadows, ambient occlusion, orbit-trap colour, Fresnel rim light, emission and distance fog; the difference is where colour is assigned. Geometry and lighting converge first, then the palette is looked up afterwards.

Uniforms occupy one 400-byte, 16-byte-aligned buffer. The byte offsets are mirrored between the WGSL structs and the JavaScript \`U\` offset table in \`fractal-bg.js\`; keep both definitions synchronized when changing the layout.`,
  'rendering architecture documentation');

console.log('palette cycle docs and tests finalized');
