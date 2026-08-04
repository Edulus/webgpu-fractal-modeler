# WebGPU Fractal Modeler

### ▶ [Live demo](https://edulus.github.io/webgpu-fractal-modeler/)

A self-contained, dependency-free **WebGPU platform for rendering, exploring, and embedding interactive 3D fractals and strange attractors**.

The project began as an animated website background and has evolved into a full-screen 3D fractal model viewer with orbit controls, zoom, adaptive rendering quality, live model and palette switching, and reusable transparent rendering for websites and applications.

No Three.js, no Babylon, no build step, and no npm. Just ES modules, WGSL, and HTML.

## Applications

- Interactive 3D fractal exploration
- Full-screen generative visual experiences
- Website and application backgrounds
- Digital-art installations and gallery displays
- Music visualizers and projection visuals
- Educational demonstrations of fractals and strange attractors
- A reusable WebGPU renderer for other projects

## Included models

- Mandelbulb
- Mandelbox
- Menger sponge
- Quaternion Julia
- Apollonian sphere packing
- Nested sphere packing
- Ornate planet with a polar bloom
- Studded surface packing
- Penrose quasicrystal tiling
- Aizawa strange attractor
- Lorenz strange attractor

## Project structure

```text
├── index.html                    interactive model-viewer and background demo
├── src/
│   ├── fractal-bg.js             device, pipelines, controls, render loop, lifecycle
│   ├── palettes.js               Inigo Quilez cosine-palette presets
│   └── shaders/
│       ├── fractal.wgsl.js       vertex + fragment raymarcher, inlined as WGSL
│       ├── composite.wgsl.js     bloom, ACES tonemap, vignette, and dithering
│       └── attractor.wgsl.js     strange attractors drawn as line geometry
├── tools/
│   └── shader-check.html         compiles every WGSL module and reports errors
└── .github/workflows/pages.yml   deploys the demo to GitHub Pages
```

WGSL is inlined as template strings rather than fetched at runtime, avoiding local CORS and shader-loading problems.

## Quick start

The current API retains its original `initFractalBackground` name for compatibility with existing integrations.

```js
import { initFractalBackground } from './src/fractal-bg.js';

const canvas = document.getElementById('bg');
const handle = await initFractalBackground(canvas, {
  fractal: 'mandelbulb',
  palette: 'aurora',
  quality: 'auto',
  transparent: false,
  onUnsupported: (reason) => {
    canvas.style.display = 'none';
    console.warn(reason);
  },
});
```

### Model-viewer mode

```js
handle.setExplorer(true);
```

Explorer mode provides:

- Mouse or one-finger drag to orbit
- Pinch or mouse-wheel zoom
- Double-tap, double-click, or `resetView()` to recenter
- An opaque presentation background
- A gentle idle rotation when the viewer is untouched

Navigation remains available under `prefers-reduced-motion`; only automatic animation is frozen.

### Background mode

```js
const handle = await initFractalBackground(canvas, {
  fractal: 'mandelbulb',
  palette: 'aurora',
  quality: 'auto',
  transparent: true,
});
```

Recommended canvas CSS:

```css
#bg {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
}
```

`pointer-events: none` keeps the canvas click-through, while the negative z-index places it behind the page interface.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `fractal` | string | `'mandelbulb'` | `'mandelbulb'`, `'mandelbox'`, `'menger'`, `'julia'`, `'apollonian'`, `'spherepack'`, `'encrusted'`, `'surfacepack'`, `'penrose'`, `'attractor'`, or `'lorenz'` |
| `palette` | string | `'aurora'` | `'aurora'`, `'ember'`, `'oil-slick'`, `'mono-ice'`, or `'iridescence'` |
| `quality` | string | `'auto'` | `'low'`, `'medium'`, `'high'`, or adaptive `'auto'` |
| `transparent` | boolean | `true` | Premultiplied transparency over the page or an opaque gradient presentation background |
| `onUnsupported` | function | `() => {}` | Receives a reason string when WebGPU initialization fails or the device is lost |

## Handle API

| Method | Description |
| --- | --- |
| `setFractal(name)` | Switch the model at runtime without reinitializing WebGPU. |
| `setPalette(name)` | Switch the cosine palette at runtime. |
| `setQuality(mode)` | Select low, medium, high, or adaptive rendering quality. |
| `setTransparent(bool)` | Toggle transparent embedding and opaque presentation modes. |
| `setExplorer(bool)` | Toggle the full model-viewer preset. |
| `setControls(bool)` | Enable orbit and zoom controls independently. |
| `setAutoOrbit(bool)` | Toggle time-driven camera movement. |
| `setZoom(n)` / `zoomBy(f)` | Set or multiply camera distance. |
| `resetView()` | Recenter the orbit and reset zoom. |
| `pause()` | Stop the render loop. |
| `resume()` | Resume rendering while respecting visibility gating. |
| `destroy()` | Tear down observers, listeners, textures, and the WebGPU device. |
| `info` | Returns model, quality, FPS, reduced-motion, explorer, and zoom state. |

## Rendering architecture

The renderer uses two principal stages:

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

The raymarch pass writes to an offscreen `rgba16float` texture. Lit colour occupies RGB, while emission and glow feed the alpha channel for post-processing.

Uniforms occupy one 160-byte, 16-byte-aligned buffer. The byte offsets are mirrored between the WGSL structs and the JavaScript `U` offset table in `fractal-bg.js`; keep both definitions synchronized when changing the layout.

## Model implementations

### Distance-estimated surfaces

- **Mandelbulb:** analytic distance estimator with animated power
- **Mandelbox:** box fold and sphere fold
- **Menger sponge:** folding-space iterated function system
- **Quaternion Julia:** four-dimensional iteration projected into a 3D distance field
- **Apollonian:** fold and sphere inversion with a plane-derived primitive
- **Nested sphere pack:** related inversion machinery using a sphere primitive
- **Ornate planet:** a smooth host body with a packing field concentrated around a polar region
- **Studded surface pack:** three scales of repeated cells containing discrete, hash-sized spheres clipped to a shell around a solid core
- **Penrose quasicrystal:** a true P3 rhombus tiling engraved into a disc at two levels of its inflation hierarchy

All shader loops are statically bounded for WGSL portability, with guarded logarithm, power, radius, and inversion domains.

#### Penrose quasicrystal

The tiling is generated by de Bruijn's pentagrid construction: five families of parallel lines, whose offsets sum to an integer, dualize to the two Penrose rhombs (thick 72°/108° and thin 36°/144°). Every line intersection becomes one tile.

Rendering needs the map in reverse — given a point, which rhombus covers it. The forward map averages to a similarity, so scaling the point back down recovers the grid coordinate to within the rounding noise of the construction, and the surrounding grid intersections are then tested directly. Searching only the more ambiguous line of each family pair halves that work; measured against an exhaustive search over 90k sample points it misplaces a tile edge on roughly one point in 100,000, and because it searches a subset it can only over-estimate the distance, which keeps sphere tracing safe.

A Penrose tiling inflated by φ² is another Penrose tiling on the same five directions, so running the identical query on a φ²-scaled point yields the parent tiles. Their edges are cut as wide canyons that partition the fine tiles into their parents and open windows where the two carves coincide — the tiling's self-similarity rendered as geometry. Tiles are coloured by rhombus type and by the perpendicular-space coordinate of the cut-and-project construction, and the whole tiling drifts slowly through perpendicular space, which flips individual tiles between the two rhombs while remaining exactly Penrose. It is the heaviest estimator in the set, so a plain disc bound confines the tiling query to a thin band around the surface.

### Strange attractors

The Aizawa and Lorenz models are trajectories rather than closed surfaces. Their differential equations are integrated on the CPU using fourth-order Runge–Kutta, uploaded as vertex data, and rasterized as line strips. This keeps the curves crisp while orbiting and zooming.

## Palettes

Palettes use Inigo Quilez cosine palettes:

```text
a + b · cos(2π(c · t + d))
```

Available presets:

- **Aurora:** teal to magenta
- **Ember:** deep red to gold
- **Oil slick:** iridescent rainbow
- **Mono ice:** cool monochrome
- **Iridescence:** shifting cyan, magenta, and gold

## Adaptive quality

Adaptive mode uses a rolling FPS estimate to adjust internal rendering resolution and raymarch epsilon. Hysteresis prevents constant quality changes. Coarse-pointer and small-viewport devices begin at a lower tier, while explicit quality settings pin the scale.

## Lifecycle and battery behaviour

- `ResizeObserver` recreates render targets after resizing.
- Device pixel ratio is capped at 2 to protect mobile GPUs.
- `IntersectionObserver` pauses rendering when the canvas leaves the viewport.
- `visibilitychange` pauses rendering in hidden tabs.
- `prefers-reduced-motion` produces a static automatic pose while preserving direct navigation.
- Device loss triggers one automatic reinitialization attempt before `onUnsupported` is called.

## Checking the shaders

Open `tools/shader-check.html` through a local HTTP server in a WebGPU browser after editing WGSL. It compiles every shader module and reports errors with line numbers.

WGSL compilation failures may produce a black canvas without a JavaScript exception, so this checker is an important validation step. Ordinary-looking words such as `patch`, `sample`, `filter`, `binding`, and `enable` may be reserved identifiers.

## Running locally

The hosted build is currently available at:

**https://edulus.github.io/webgpu-fractal-modeler/**

WebGPU requires a secure context. For local development, serve the repository over HTTP instead of opening `index.html` directly:

```bash
python3 -m http.server 8000
# or
npx http-server -c-1
```

Then open `http://localhost:8000/`.

Chrome and Edge block ES-module imports over `file://`. A local server also provides behaviour closer to GitHub Pages deployment.

## Browser support

Requires `navigator.gpu`:

- Chrome and Edge 113+
- Safari 26+
- Firefox with WebGPU enabled

When WebGPU is unavailable, the caller receives `onUnsupported` and can display a CSS, image, or video fallback.
