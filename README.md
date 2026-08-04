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
- Gyroid minimal surface
- Kleinian limit set
- Aizawa strange attractor
- Lorenz strange attractor

## Project structure

```text
├── index.html                    interactive model-viewer and background demo
├── src/
│   ├── fractal-bg.js             device, pipelines, controls, render loop, lifecycle
│   ├── fly-camera.js             free-flight camera maths (pure, no WebGPU)
│   ├── palettes.js               Inigo Quilez cosine-palette presets
│   └── shaders/
│       ├── fractal.wgsl.js       vertex + fragment raymarcher, inlined as WGSL
│       ├── composite.wgsl.js     bloom, ACES tonemap, vignette, and dithering
│       └── attractor.wgsl.js     strange attractors drawn as line geometry
├── tools/
│   ├── shader-check.html         compiles every WGSL module and reports errors
│   └── fly-camera.test.js        camera unit tests (node tools/fly-camera.test.js)
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

### Fly-through mode

```js
handle.setFly(true);
```

Every other camera in the project orbits a bounded object at a fixed radius from the origin. Fly-through replaces that with a free position and a look direction decoupled from the origin, so the camera can travel *into* a model rather than around it.

- `W`/`S` forward and back, `A`/`D` strafe, `Q`/`E` down and up (arrows and PageUp/PageDown also work)
- Hold `Shift` to sprint, `Alt` to creep
- Drag to look; scroll to trim travel speed
- On touch, drag to look and pinch to move along the view direction

Vertical travel uses world up rather than camera up, so `E` still rises while looking straight down. Speed scales with each model's world size, and the frame delta is clamped so a stalled tab cannot teleport the camera through a wall.

Two models change shape in this mode. The gyroid drops its bounding ball entirely — it is genuinely infinite and periodic, and the ball existed only to give the orbit camera something to circle. The Kleinian limit set widens its ball rather than removing it, since an unbounded version would let rays march forever through the gaps instead of terminating on the background.

Because the camera can end up inside solid material, the raymarcher walks the ray origin forward into free space before tracing, and the marching step has a floor so a negative distance estimate can never drive the ray backwards.

The camera maths lives in `src/fly-camera.js` as pure functions and is covered by `tools/fly-camera.test.js`, which runs in plain Node without a GPU:

```sh
node tools/fly-camera.test.js
```

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
| `fractal` | string | `'mandelbulb'` | `'mandelbulb'`, `'mandelbox'`, `'menger'`, `'julia'`, `'apollonian'`, `'spherepack'`, `'encrusted'`, `'surfacepack'`, `'penrose'`, `'gyroid'`, `'kleinian'`, `'attractor'`, or `'lorenz'` |
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
| `setFly(bool)` | Toggle free flight; interior models drop their bounding clip. |
| `setFlySpeed(n)` | Set the travel speed multiplier. |
| `setControls(bool)` | Enable orbit and zoom controls independently. |
| `setAutoOrbit(bool)` | Toggle time-driven camera movement. |
| `setZoom(n)` / `zoomBy(f)` | Set or multiply camera distance. |
| `resetView()` | Recenter the orbit and reset zoom. |
| `pause()` | Stop the render loop. |
| `resume()` | Resume rendering while respecting visibility gating. |
| `destroy()` | Tear down observers, listeners, textures, and the WebGPU device. |
| `info` | Returns model, quality, FPS, reduced-motion, explorer, fly, speed, position, and zoom state. |

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
- **Gyroid:** Schoen's triply periodic minimal surface, clipped to a ball
- **Kleinian limit set:** box fold and conditional sphere inversion generating a discrete group's accumulation set

All shader loops are statically bounded for WGSL portability, with guarded logarithm, power, radius, and inversion domains.

#### Kleinian limit set

A Kleinian group is a discrete group of Möbius transformations, and its limit set is the fractal set of accumulation points its orbits pile up on. The estimator generates one from two moves iterated together: a box fold reflecting a point back into the fundamental domain of a translation lattice, and an inversion in a sphere that fires only for points already inside it. The accumulated inversion factor carries the final primitive's distance back to world scale — the same fold-and-invert machinery as the Apollonian estimator, with a clamp fold instead of a modulo fold and a conditional inversion instead of an unconditional one.

The smooth caps in the result are not an artefact: they are the group's tangent spheres, with recursive filigree running along the ridges where they meet. Slowly drifting the inversion radius walks the construction through a family of nearby Kleinian groups, morphing the limit set within a narrow band — the structure degenerates quickly outside it.

Parameters came from rendering candidates rather than from a reference. The construction is sharply sensitive to them: of the first four published-looking parameter sets tried, three collapsed into featureless lobes, and swapping the final primitive alone was enough to turn the surface from tangent spheres into granular noise.

#### Gyroid

Schoen's gyroid is the triply periodic minimal surface `cos x sin y + cos y sin z + cos z sin x = 0`. Its zero set separates two congruent, interpenetrating labyrinths, and it contains no straight lines and no mirror planes. The two faces of the wall look into different labyrinths, so they take separate palette bands. Sliding the level-set parameter widens one labyrinth while narrowing the other, staying inside the regime where the surface remains connected.

The surface is genuinely something to travel through rather than orbit, so until the renderer grows a fly-through camera it is clipped to a ball, which opens its channels to the outside and keeps it legible from a normal orbit.

That implicit field is **not** a distance field, and sphere-tracing it directly overshoots wherever its gradient exceeds one. The textbook remedy is to divide by the analytic gradient, but that gradient falls to `0.035` at the field's critical points, and dividing by such a small number inflates a marching step roughly fiftyfold. Dividing by the global bound instead is both safe and cheaper: sampled across a full period at 729,000 points, the gradient magnitude reaches exactly √3 and never exceeds it, so dividing by √3 under-estimates the true distance everywhere and needs no empirical safety factor. It costs about 1.26× more marching steps than an exact gradient would need at the surface — less than computing that gradient would cost.

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
