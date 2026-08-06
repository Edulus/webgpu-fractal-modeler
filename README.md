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
- Barth sextic
- Aizawa strange attractor
- Lorenz strange attractor

## Project structure

```text
├── index.html                    interactive model-viewer and background demo
├── src/
│   ├── fractal-bg.js             device, pipelines, controls, render loop, lifecycle
│   ├── camera.js                 camera rate maths (pure, no WebGPU)
│   ├── palette-io.js             palette import and persistence (pure)
│   ├── palettes.js               Inigo Quilez cosine-palette presets
│   └── shaders/
│       ├── fractal.wgsl.js       vertex + fragment raymarcher, inlined as WGSL
│       ├── composite.wgsl.js     bloom, ACES tonemap, vignette, and dithering
│       └── attractor.wgsl.js     strange attractors drawn as line geometry
├── tools/
│   ├── shader-check.html         compiles every WGSL module and reports errors
│   ├── camera.test.js            camera unit tests (node tools/camera.test.js)
│   └── palette.test.js           palette import/persistence unit tests
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

- Mouse or one-finger drag to orbit around the pinned pivot
- Pinch or mouse-wheel zoom
- Momentum: a throw slows into a slow drift and keeps turning
- Double-tap, double-click, or `freezeView()` to stop the drift where it is
- `resetView()` to recenter
- An opaque presentation background

**Zoom dollies towards the surface, not the centroid.** The orbit camera keeps an explicit pivot and distance. Zooming in first re-pins the pivot onto whatever the centre of the view is pointing at, using a distance measured by the GPU probe along the view ray; the eye does not move, the pivot slides forward onto the surface and the distance shrinks to match. Closing in then approaches that surface asymptotically instead of sliding towards the model's centroid — which is what used to push the eye through the surface into the interior, where the frame washes out.

**Switching models carries the zoom as a ratio.** Each estimator lives at a different world scale, which is what the per-model orbit radius is for, so keeping the raw distance across a switch means arriving at a model framed by the previous one's size. The distance is rescaled by the ratio of the two radii and the pivot returns to the origin, since it described a surface that no longer exists.

**The view keeps its momentum.** Angular velocity decays towards a floor rather than towards zero: a throw sheds its speed over a few seconds and settles into a drift of about two degrees a second — a full turn in three minutes — which it then holds indefinitely. The floor points wherever the last movement went, so the model carries on the way you left it going. A view that has never been dragged has no last movement to retain and stands still.

Double-tap, double-click, or `freezeView()` clears the direction, and with nothing to settle onto the momentum decays to a genuine halt. That is the only full stop.

Freezing keeps the angles, pivot and distance exactly as they are — it stops the view, it does not recentre it. Stopping on something worth looking at should not throw it away, so recentring is a separate action (`resetView()`, or the demo's **Reset view** button). Freezing also pulls the target angles onto the eased ones, because the easing spring is mid-flight towards a target the drift has been advancing. Leaving that gap in place would let the view coast about a sixth of a degree over the following half second — small, but the difference between a stop and a settle. With the snap, the frozen angles do not change at all: not at the instant of freezing, and not five seconds later.

Three details make it work rather than merely exist. The drift is integrated into the *target* angles, not the eased ones — added to the eased angle it would fight the easing spring, which pulls back towards the target, and the two would balance at a fixed offset with the drift silently stalled. The decay is anchored to a half-life in seconds rather than a per-frame multiplier, so a flick lasts the same time on a 120Hz phone as on a 60Hz laptop; only the spring's one-off settling transient differs, by about two degrees, and it does not accumulate. And a drift with a vertical component bounces off the pitch limits instead of parking against them, since coming to rest at the pole is exactly the full stop the drift exists to avoid.

The floor is scaled by the same curve as the drag rate, so a drift that is barely perceptible framing the whole model does not become a sweep once the camera is close to an unpinned centroid.

This supersedes the old idle auto-rotation, which was mutually exclusive with progressive accumulation — a turning camera can never settle — and so was switched off by default. The exclusivity is still real, but it now falls the right way round: the view drifts until you stop it, and stopping it is what lets the image converge. Double-tap therefore both settles the view and sharpens it. The cost of drifting is that the renderer never reaches its cheap converged state, where the raymarch is skipped entirely; on a phone that is the difference between a full raymarch every frame and the post chain alone.

Drift is suppressed under `prefers-reduced-motion`, and applies to the orbit camera only — in fly-through, a look direction that would not hold still is disorienting rather than alive.

**Pinch is integrated, not anchored.** A pinch is read as the *change* in finger separation since the previous move event, and each step is applied relative to wherever the camera now is — the same path the mouse wheel takes. The obvious alternative, anchoring to the separation and distance the gesture started at, is subtly wrong here: that distance is measured against the pivot the gesture began with, and re-pinning moves the pivot mid-gesture. Assigning an anchored distance into a frame that has since shifted displaces the eye by the whole difference, on every move event, sixty to a hundred and twenty times a second. The incremental form composes with re-pinning, and the two agree exactly when nothing re-pins, because the ratios telescope. Telescoping also makes the gesture frame-rate independent: the total zoom depends only on where the fingers started and finished, never on how many events the browser delivered.

The separation ratio is raised to a power below 1 before it is applied. Raw direct manipulation hands the whole usable spread — from fingers nearly touching to the width of the phone — to a single gesture, which is far too much travel for one motion of the hand; the exponent halves the rate in log space, so a full spread closes about 60% of the gap to the surface and a second pinch continues smoothly from there. A floor on the separation keeps a mis-registered fingertip from dividing by something near zero, and a per-event ceiling catches genuinely discontinuous readings — a third finger landing, a coalesced batch after a stall. The ceiling sits above anything a hand can do, at roughly 2.5× separation growth in one event, so that it stays a discontinuity guard and never quietly becomes a rate limiter.

Pinning the pivot also fixes the drag rate for free: the point under the crosshair is the point being orbited, so it does not move at all and its neighbours move by the drag angle however close the eye sits. When no pivot has been placed — nothing under the crosshair, or the view has just been reset — the rate falls back to a curve that damps with distance, because orbiting the centroid does whip the view once the camera is close.

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

Vertical travel uses world up rather than camera up, so `E` still rises while looking straight down. The frame delta is clamped so a stalled tab cannot teleport the camera through a wall.

**Travel covers a fraction of the gap, not a fixed distance.** These fractals have no characteristic size, so a fixed number of world units per second is only correct at one distance: a hair from a gyroid wall, a nominal rate crosses seventy wall-thicknesses a second. Movement is instead integrated as

```text
step = clearance × (1 − exp(−k · dt))
```

which buys two things over the `speed × dt` form it replaced. It is exactly frame-rate independent — the linear form makes a 30fps machine cover different ground than a 60fps one for the same held key — and the approach is asymptotic, so no speed and no frame length can cross the remaining gap in a single step. Closing on a surface slows smoothly and never arrives.

The clearance comes from the GPU: a one-thread compute pass evaluates the distance estimator at the camera each frame and reports it alongside the centre-ray hit that the orbit camera uses for pinning. Only the GPU can evaluate the estimators, so there is no way to obtain this on the CPU. The reading is a frame or two stale, which is immaterial for a rate control — and the feedback loop of re-reading it every frame is precisely what makes the approach asymptotic.

Absolute value is used deliberately: in fly mode the camera can be *inside* solid material, where the estimate goes negative, and using `|d|` keeps it possible to travel back out. Clearance is floored so you are never frozen and capped so you never bolt in open space.

The two-finger dolly is scaled the same way, and for the same reason. A fixed number of world units per pixel of spread is only correct at one scale: hovering a hundredth of a radius from a wall, a nominal step is two hundred times the clearance and puts the camera straight through it. Expressed as a fraction of the measured gap, one full spread covers the same proportion of it whether the camera is a radius away or a thousandth.

Two models change shape in this mode. The gyroid drops its bounding ball entirely — it is genuinely infinite and periodic, and the ball existed only to give the orbit camera something to circle. The Kleinian limit set widens its ball rather than removing it, since an unbounded version would let rays march forever through the gaps instead of terminating on the background.

Because the camera can end up inside solid material, the raymarcher walks the ray origin forward into free space before tracing, and the marching step has a floor so a negative distance estimate can never drive the ray backwards.

The camera maths lives in `src/camera.js` as pure functions and is covered by `tools/camera.test.js`, which runs in plain Node without a GPU:

```sh
node tools/camera.test.js
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
| `setPaletteColors(colors)` | Use an imported palette: `[[r,g,b], …]` in 0..1. `null` returns to the preset. |
| `setQuality(mode)` | Select low, medium, high, or adaptive rendering quality. |
| `setTransparent(bool)` | Toggle transparent embedding and opaque presentation modes. |
| `setExplorer(bool)` | Toggle the full model-viewer preset. |
| `setFly(bool)` | Toggle free flight; interior models drop their bounding clip. |
| `setAccumulate(bool)` | Toggle progressive accumulation while the view is still. |
| `setFlySpeed(n)` | Set the travel speed multiplier. |
| `setControls(bool)` | Enable orbit and zoom controls independently. |
| `setAutoOrbit(bool)` | Toggle time-driven camera movement. |
| `setZoom(n)` / `zoomBy(f)` | Set or multiply camera distance; zooming in re-pins the pivot onto the surface. |
| `resetView()` | Recenter the orbit and reset zoom. |
| `pause()` | Stop the render loop. |
| `resume()` | Resume rendering while respecting visibility gating. |
| `destroy()` | Tear down observers, listeners, textures, and the WebGPU device. |
| `info` | Model, quality, FPS, reduced-motion, explorer, fly, speed, position, zoom, whether the orbit pivot is pinned, camera clearance, and accumulated sample count. |

## Loading palettes

The demo's **Load palette…** panel accepts three things, auto-detected:

- a **coolors.co** link — `https://coolors.co/264653-2a9d8f-e9c46a-f4a261-e76f51`, including the `/palette/` and `/visualizer/` forms
- a **GIMP `.gpl`** file, pasted or picked with **File…** or dropped anywhere on the page
- a plain **hex list**, comma- or newline-separated

Name it and press **Save** and it persists in `localStorage`, appearing in the palette selector on every later visit. **Delete** removes it.

### Why imported palettes are not fitted to the presets

The built-in palettes are Inigo Quilez cosine palettes: `a + b·cos(2π(c·t + d))`, four coefficient triples producing a smooth, endlessly periodic ramp. An imported palette is a different kind of object — a short list of specific colours somebody chose.

Fitting cosine coefficients to those swatches would reproduce most palettes only loosely and ones with a deliberate hard contrast not at all, so imported palettes are instead kept as what they are. The shader carries a second palette mode that interpolates up to eight stops directly, cyclically so it stays continuous the way the cosine presets are. **The colours that come out are the colours that went in.** Palettes longer than eight stops are resampled evenly across the original rather than truncated, so the overall sweep survives.

Parsing runs on untrusted input — pasted text, dropped files — so every parser returns null rather than throwing, and refuses input it only partly understands rather than importing wrong colours silently. `localStorage` is used over cookies: cookies cap near 4KB and travel with every request. Storage that is unavailable (private browsing, embedded webviews, quota) degrades to "could not save" instead of breaking the page. All of it is covered by `node tools/palette.test.js`.

## Progressive accumulation

While the view is still, frames are re-rendered with a subpixel offset and averaged into a running mean, so the image resolves far past what a single sample can show. The high-frequency models benefit most — Penrose grooves and Kleinian filigree alias badly at one sample per pixel.

Offsets walk an **R2 (Roberts) low-discrepancy sequence**, a two-dimensional golden-ratio analogue whose samples interleave evenly instead of clumping the way random jitter does, so the average converges in fewer frames.

Sampling starts after a short pause in input and stops at a cap; past that the raymarch is skipped entirely and the converged image is re-presented, which drops idle GPU cost to the post-processing chain alone. Any input, or a change of model, palette, quality or size, resets the average.

Two behaviours are suspended while averaging, because a moving image cannot converge: the animation clock stops, and explorer mode's gentle idle rotation is disabled. `handle.setAccumulate(false)` restores both and turns the feature off. The HUD reports the sample count as `48spp`.

Accumulation is confined to the interactive modes — background mode keeps animating.

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
- **Barth sextic:** a degree-6 algebraic surface carrying the maximum number of nodes a sextic can have

All shader loops are statically bounded for WGSL portability, with guarded logarithm, power, radius, and inversion domains.

#### Kleinian limit set

A Kleinian group is a discrete group of Möbius transformations, and its limit set is the fractal set of accumulation points its orbits pile up on. The estimator generates one from two moves iterated together: a box fold reflecting a point back into the fundamental domain of a translation lattice, and an inversion in a sphere that fires only for points already inside it. The accumulated inversion factor carries the final primitive's distance back to world scale — the same fold-and-invert machinery as the Apollonian estimator, with a clamp fold instead of a modulo fold and a conditional inversion instead of an unconditional one.

The smooth caps in the result are not an artefact: they are the group's tangent spheres, with recursive filigree running along the ridges where they meet. Slowly drifting the inversion radius walks the construction through a family of nearby Kleinian groups, morphing the limit set within a narrow band — the structure degenerates quickly outside it.

Parameters came from rendering candidates rather than from a reference. The construction is sharply sensitive to them: of the first four published-looking parameter sets tried, three collapsed into featureless lobes, and swapping the final primitive alone was enough to turn the surface from tangent spheres into granular noise.

#### Barth sextic

The first algebraic surface here, and the first model whose defining feature is its singularities:

```text
f = 4(φ²x² − y²)(φ²y² − z²)(φ²z² − x²) − (1 + 2φ)(x² + y² + z² − w²)² w² = 0
```

At `w = 1` this degree-6 surface has 65 ordinary double points — the maximum a sextic can have, a bound proved by Jaffe and Ruberman — arranged with icosahedral symmetry. Fifty are finite and were located exactly while building the estimator: **20 at the vertices of a dodecahedron at radius √3, and 30 at an icosidodecahedron at radius exactly 1.** The other 15 lie at infinity. Both finite shells sit inside the clipping ball, so what you orbit is the entire singular structure. `w` is the pencil parameter; sliding it off 1 dissolves the nodes into a smooth surface, so the animation keeps a small amplitude around the distinguished member and reduced motion pins it exactly at `w = 1`.

**It inverts the lesson the gyroid taught, and that is the interesting part.** For the gyroid, dividing by the analytic gradient is wrong and a constant divisor is right. Here it is the other way round, for two measured reasons:

- *A constant divisor is useless for a polynomial.* Over the clipping ball `|∇f|` reaches 749, while its median **on the surface** is 9.3 — so a rigorous constant would step eighty times finer than necessary everywhere. Making the bound radius-dependent, `max(7, 25r⁵)` (verified against 2.4M samples), narrows the gap but still costs 2.5× the marching steps.
- *The gradient is well behaved exactly where it looked dangerous.* The obvious worry is that `|∇f|` vanishes at every node, making `|f|/|∇f|` a `0/0`. But at an ordinary double point `f` vanishes quadratically while `|∇f|` vanishes linearly, so the ratio tends to a multiple of the distance rather than diverging. Measured against a dense reference march with bisection, the first-order estimator lands on the correct sheet for **99.4% of rays and skips none at all** at the marcher's step scale, averaging 22 steps. The gradient floor in the code never binds — results are identical at 0.1, 0.6 and 2.0 — and exists only so a point landing exactly on a node cannot evaluate `0/0`.

The estimator is also cheap in a way the step count hides: it is one degree-6 polynomial and its gradient, sharing sub-expressions, with no transcendentals and no iteration loop at all — unlike every other surface here.

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

## Acknowledgements

Two navigation techniques here were adopted after reading [fractbox-engine](https://github.com/fractbox/fractbox-engine) (MIT, © 2026 Vladimir Weinstein), a composable WebGPU distance-estimated fractal engine:

- **Zoom to surface.** Its `zoomsurface.js` identifies why plain zoom fails on a distance-estimated fractal — the eye slides towards the model's centroid and eventually passes through the surface — and re-pins the orbit pivot onto the surface ahead instead. That diagnosis replaced an earlier workaround here that damped the drag rate, treating the symptom rather than the cause.
- **Exponential travel integration.** Its `cruise.js` expresses camera motion as a fixed fraction of the remaining gap per second, which is frame-rate exact and makes approach asymptotic.

No code was copied; both were reimplemented against this renderer's architecture. The engine is worth reading for its operator IR, which treats a formula as data and has each primitive declare how it affects the running distance-estimate derivative.
