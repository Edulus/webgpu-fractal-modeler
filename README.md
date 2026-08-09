# Complex Geometry Explorer

### ▶ [Live demo](https://edulus.github.io/webgpu-fractal-modeler/)

**Twenty objects from mathematics, alive in your browser.** Shapes that come out
of equations, symmetry groups and endless repetition — minimal surfaces,
stellated solids, strange attractors, tessellations of curved space. Spin them,
zoom in as far as you like, and fly inside the ones with an interior.

Everything is drawn live, pixel by pixel, as you move. It opens instantly, works
offline, and can also sit behind the content of a web page as a slow animated
background.

*For developers:* built from ES modules and WGSL alone, and runs straight from a
file. See [Project structure](#project-structure) and the model notes below.

Released under the [MIT licence](LICENSE). Every model is implemented from the
published mathematics, cited in its own section below; no code is ported from
another project. The constructions themselves are the work of the
mathematicians named there.

## Uses

- Exploring mathematical objects interactively, on screen or in a lecture
- Full-screen generative visuals
- Website and application backgrounds
- Digital-art installations and gallery displays
- Music visualisers and projection visuals
- A reusable renderer for other projects

## Included models

- Mandelbulb
- Mandelbox
- Menger sponge
- Quaternion Julia
- Apollonian sphere packing
- Nested sphere packing
- Ornate planet with a polar bloom
- Studded surface packing
- Gyroid minimal surface
- Kleinian limit set
- Barth sextic
- Kissing Schottky group (parabolic)
- Schottky group (hyperbolic)
- Tetrabrot (bicomplex Mandelbrot slice)
- Envelope extrusion, octahedral seed (stella octangula)
- Envelope extrusion, dodecahedral seed (small stellated dodecahedron)
- Hyperbolic honeycomb {5,3,4}
- Hyperbolic honeycomb {4,3,5}
- Truncated and omnitruncated forms of both honeycombs
- Kleinian sphere packing {5,3,6}
- Aizawa strange attractor
- Lorenz strange attractor
- Rössler strange attractor

## Project structure

```text
├── index.html                    interactive model-viewer and background demo
├── src/
│   ├── fractal-bg.js             device, pipelines, controls, render loop, lifecycle
│   ├── camera.js                 camera rate maths (pure, no WebGPU)
│   ├── palette-io.js             palette import and persistence (pure)
│   ├── palettes.js               Inigo Quilez cosine-palette presets
│   └── shaders/
│       ├── fractal.wgsl.js       distance estimators + clearance compute shader
│       ├── material.wgsl.js      palette-independent raymarch material pass
│       ├── composite.wgsl.js     palette resolve, bloom, image controls, tonemap
│       └── attractor.wgsl.js     palette-independent strange-attractor lines
├── tools/
│   ├── shader-check.html         compiles every WGSL module and reports errors
│   ├── camera.test.js            camera unit tests (node tools/camera.test.js)
│   ├── palette.test.js           palette import/persistence unit tests
│   ├── recovery.test.js          GPU device-loss recovery decisions
│   ├── colorcycle.test.js        palette-cycle and image-control arithmetic
│   ├── kleinpack.test.js         sphere-packing construction and estimator
│   └── attractor.test.js         attractor fits and Lyapunov exponents
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

**Colours cycle without costing sharpness.** The expensive model pass now stores palette coordinates and lighting weights instead of baking RGB into the converged frame. The post chain looks those coordinates up in the currently selected palette every frame, so a settled 96-sample model can keep changing colour without another raymarch.

That also makes the cycle palette-faithful. Aurora stays an Aurora lookup while the coordinate moves through it; an imported Coolors ramp stays within that ramp. Neutral specular light remains neutral. Bloom is calculated after the live palette lookup, so the glow moves with the surface colour instead of retaining an earlier hue. `setColorCycle()` deliberately does not reset accumulation, and switching palettes can recolour the converged material immediately.

The explicit **Hue** control is separate. It remains an RGB-space image adjustment for cases where the user intentionally wants to move away from the selected palette. Automatic palette motion is suppressed under `prefers-reduced-motion`; manual Hue remains available.

**Brightness, contrast, saturation and hue are camera controls, not filters.** They live in the same post chain as the cycle, for the same reason: dragging a slider re-presents the frame that is already there instead of re-marching it, so the picture stays sharp under the drag rather than dissolving into noise and re-converging. Anything wired to the raymarch behaves the opposite way.

Where each one sits in the chain is what makes it behave. Brightness is an exposure multiply *before* the tonemapper, so highlights roll off along the ACES curve the way a camera's do; the same multiply after the tonemap would clip them flat. Hue is an independent RGB rotation after palette resolution. Saturation comes after gamma, in display space. Contrast is also a display-space control, but it pivots on the backdrop rather than on mid-grey. All four are neutral by default, so an unchanged installation renders exactly what it did before they existed.

**Contrast pivots on the backdrop, not on mid-grey.** The backdrop sits far below mid-grey, so a conventional photographic pivot visibly lifts it when contrast is reduced and crushes it when contrast is increased. The control is meant to shape the model while the space around it holds still.

The composite pass therefore reconstructs the bare backdrop for each pixel and takes it through the same Hue, exposure, tonemap, gamma and saturation chain as the rendered scene. Contrast then rescales the channel so that backdrop is 0 and white is 1, and applies the S-curve `xᵏ / (xᵏ + (1−x)ᵏ)`. Both endpoints remain exact fixed points at every setting, the curve stays monotone, and a crevice darker than the backdrop passes through unchanged rather than being raised to it.

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
| `fractal` | string | `'mandelbulb'` | `'mandelbulb'`, `'mandelbox'`, `'menger'`, `'julia'`, `'apollonian'`, `'spherepack'`, `'encrusted'`, `'surfacepack'`, `'gyroid'`, `'kleinian'`, `'attractor'`, or `'lorenz'` |
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
| `setColorCycle(rate)` | Palette-coordinate shift rate per second; `0` stops it. Re-indexes the selected palette without resetting accumulation. |
| `setImageAdjust({exposure, contrast, saturation, hue})` | Post-chain image controls, any subset. `hue` is in turns. Does not reset accumulation. |
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
| `info` | Model, quality, FPS, reduced-motion, explorer, fly, speed, position, zoom, whether the orbit pivot is pinned, camera clearance, accumulated sample count, cycle rate, and the image settings. |

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

### Palette-faithful colour cycling

Colour cycling re-indexes the palette rather than rotating the finished RGB image. The expensive model pass stores palette coordinates, scalar lighting weights, neutral specular light, fog/background coverage and emission in two `rgba16float` material attachments. The post chain looks those coordinates up in the currently selected cosine preset or imported stop ramp, and applies the live cycle phase before bloom and tonemapping.

That separation has two useful consequences. A converged 96-sample image can keep cycling without another raymarch, and changing from one palette to another recolours the converged material immediately instead of throwing the accumulated geometry samples away. The explicit **Hue** image control remains a separate post-process rotation for users who deliberately want to move away from the selected palette.

Imported stop ramps are cyclic by definition and wrap every palette-coordinate unit. Cosine presets may use different frequencies in their RGB channels, so their phase advances continuously rather than being forcibly wrapped at 1; that avoids a discontinuity in presets such as Ember and Iridescence.

## Progressive accumulation

While the view is still, frames are re-rendered with a subpixel offset and averaged into a running mean, so the image resolves far past what a single sample can show. The high-frequency models benefit most — Penrose grooves and Kleinian filigree alias badly at one sample per pixel.

Offsets walk an **R2 (Roberts) low-discrepancy sequence**, a two-dimensional golden-ratio analogue whose samples interleave evenly instead of clumping the way random jitter does, so the average converges in fewer frames.

Sampling starts after a short pause in input and stops at a cap; past that the raymarch is skipped entirely and the converged material is re-presented through the post chain, which drops idle GPU cost to palette resolution, bloom and composite. Camera/model/quality/size changes reset the average because they change the sampled geometry. Palette changes and colour-cycle phase do not: they are resolved after accumulation.

Two behaviours are suspended while averaging, because a moving image cannot converge: the animation clock stops, and explorer mode's gentle idle rotation is disabled. `handle.setAccumulate(false)` restores both and turns the feature off. The HUD reports the sample count as `48spp`.

Accumulation is confined to the interactive modes — background mode keeps animating.

## Rendering architecture

The renderer uses two principal stages:

1. **Palette-independent model/material pass**
   - Distance-estimated models are sphere-traced in a fullscreen fragment shader.
   - Strange attractors are integrated on the CPU with RK4 and drawn as weighted additive line geometry.
   - Two `rgba16float` attachments carry palette coordinates and scalar shading terms rather than baked RGB.
   - Progressive samples are averaged directly into those attachments with fixed-function blend constants, so no accumulation ping-pong textures or separate accumulation pass are required.

2. **Palette resolve + composite pass**
   - The selected cosine palette or imported stop ramp is evaluated from the stored coordinates at the live cycle phase.
   - Separable Gaussian bloom runs on the resolved HDR colour, so bloom follows the palette cycle too.
   - The explicit Hue image adjustment, exposure, saturation and contrast follow as post controls.
   - ACES tonemapping, gamma correction, vignette and dithering produce the final presentation image.

Surface shading still includes directional lighting, soft shadows, ambient occlusion, orbit-trap colour, Fresnel rim light, emission and distance fog; the difference is where colour is assigned. Geometry and lighting converge first, then the palette is looked up afterwards.

Uniforms occupy one 400-byte, 16-byte-aligned buffer. The byte offsets are mirrored between the WGSL structs and the JavaScript `U` offset table in `fractal-bg.js`; keep both definitions synchronized when changing the layout.

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
- **Schottky groups:** a free discrete group of Möbius transformations of space, at and near the kissing configuration
- **Tetrabrot:** a 3D slice of the bicomplex Mandelbrot set, the parameter-space companion to the quaternion Julia
- **Envelope extrusion:** Thurman's zero-parameter facewise polyhedral operator, which reduces to classical first stellation
- **Hyperbolic honeycomb:** a regular tessellation of hyperbolic 3-space, drawn in the Poincaré ball

All shader loops are statically bounded for WGSL portability, with guarded logarithm, power, radius, and inversion domains.

#### Kleinian limit set

A Kleinian group is a discrete group of Möbius transformations, and its limit set is the fractal set of accumulation points its orbits pile up on. The estimator generates one from two moves iterated together: a box fold reflecting a point back into the fundamental domain of a translation lattice, and an inversion in a sphere that fires only for points already inside it. The accumulated inversion factor carries the final primitive's distance back to world scale — the same fold-and-invert machinery as the Apollonian estimator, with a clamp fold instead of a modulo fold and a conditional inversion instead of an unconditional one.

The smooth caps in the result are not an artefact: they are the group's tangent spheres, with recursive filigree running along the ridges where they meet. Slowly drifting the inversion radius walks the construction through a family of nearby Kleinian groups, morphing the limit set within a narrow band — the structure degenerates quickly outside it.

Parameters came from rendering candidates rather than from a reference. The construction is sharply sensitive to them: of the first four published-looking parameter sets tried, three collapsed into featureless lobes, and swapping the final primitive alone was enough to turn the surface from tangent spheres into granular noise.

#### Kleinian sphere packing

**A packing of round spheres that is somebody's orbit.** Two of the packings above — `apollonian` and `spherepack` — are a periodic lattice fold composed with an inversion. That imitates the look convincingly, and it is the standard trick, but the result is not the orbit of any group and its spheres are not exactly tangent to one another. This one is: every sphere in it is the image of a single sphere under a Kleinian group, and tangency is exact.

The group is `[5,3,6]`, built exactly as the honeycombs above are built. What changes is the last branch of the diagram. With `r = 6` the vertex figure `{3,6}` is a **Euclidean** tiling rather than a spherical one, which pushes the honeycomb's vertex out onto the sphere at infinity: the cells are *ideal* dodecahedra, their corners touching the boundary.

An ideal vertex is a cusp, and a cusp carries **horoballs** — spheres tangent to the boundary from inside, which in hyperbolic terms are surfaces at infinite distance from every interior point. Möbius maps carry horoballs to horoballs, so the orbit of one is a family of Euclidean spheres whose residual set is the limit set of the group. That is a Kleinian sphere packing in the strict sense.

**Which horoball is not a matter of taste.** The fundamental simplex has one ideal vertex `v`, lying on mirrors `m1`, `m2` and the sphere but not on `m0`. Seed with the horoball at `v` tangent to `m0`: its reflection in `m0` is then tangent to it rather than overlapping, and that propagates through the group, giving the *maximal cusp* — the packing where every sphere touches its neighbours and none of them cross. Measured over the orbit: worst overlap 1.7e-16, and every image satisfies `|centre| + radius = 1` to 4.4e-16, i.e. is exactly tangent to the boundary.

The vertex is ideal exactly when the line `m1 ∧ m2` meets the mirror sphere in a *double* point. Substituting `p = t·d` into `|p − c|² = s²` with `|c|² − s² = 1` gives `t² − 2(d·c)t + 1 = 0`, whose roots multiply to 1 — an inversive pair straddling the boundary — unless the discriminant vanishes, which forces `t = ±1`. For `{5,3,6}` the discriminant is exactly 0 and `|v| = 1` to 1e-12.

Run against the **compact** `{5,3,4}` as a control, the same code produces overlaps of 0.23 and tangency errors of 0.38, because that group has no cusp to seed from. The construction fails where it should.

**Why `{5,3,6}` and not `{3,3,6}`.** All four cusped honeycombs give exact packings, but only some can be *seen*. Sampling spherical shells for the fraction lying inside the packing: `{3,3,6}` is 84% covered at every radius and `{3,4,4}` 80%, so both read as a solid ball from outside — the first CPU render of `{3,3,6}` came back a featureless sphere. `{5,3,6}` has the smallest seed horoball of the four and leaves **0% coverage inside radius 0.45** — a hollow core — rising to only 43–63% further out, so there are real gaps to see through and the spheres read as spheres.

The estimator folds into the fundamental domain and measures one exact sphere there, divided by the accumulated conformal factor. It carries a **safety factor of 0.8**, measured: a dense fixed-step reference march found no ray stepping past the surface without one, but marching is a weak test, and the pointwise bound fails — against the exact distance to 282 known orbit spheres the raw quotient over-reports at 36% of sampled points, by up to 0.018, because the fold need not land the point beside the *nearest* orbit sphere. That is the same defect the Schottky estimator charges 0.6 for. The largest factor keeping every sampled point conservative is 0.849, so 0.8 takes it with a margin.

Clipped at radius 0.95 rather than the 0.85 the honeycombs use: these spheres are tangent to the boundary by construction, so a tighter clip would slice a cap off every one of them.

#### Hyperbolic honeycomb

**The first model here whose ambient space is not Euclidean.** Everything else is an object sitting in Euclidean 3-space, or a limit set on the *boundary* of hyperbolic space — the Kleinian and Schottky sets are limit sets *of* hyperbolic isometries. A honeycomb `{p,q,r}` is a regular tessellation *of* hyperbolic 3-space, so what fills the ball is space itself, seen through a conformal chart.

The symmetry group `[p,q,r]` is a Coxeter group on four mirrors, with dihedral angles π/p, π/q, π/r along the chain and right angles otherwise. Three can be taken as Euclidean planes through the origin — generating the finite group `[p,q]` of one cell — and the fourth as a sphere orthogonal to the unit sphere, which carries each cell into the next:

```text
n0 = (1, 0, 0)
n1 = (−cos(π/p), sin(π/p), 0)
n2 = (0, −cos(π/q)/sin(π/p), √(1 − cos²(π/q)/sin²(π/p)))
```

The sphere is orthogonal to the first two, so its centre lies on `u = n0 × n1`, and meets the third at π/r. With `|c|² − s² = 1` for orthogonality to the unit sphere, `t² = cos²(π/r) / (cos²(π/r) − (u·n2)²)`.

**That denominator is the hyperbolicity condition, and it discriminates exactly.** It is positive for precisely the four compact hyperbolic honeycombs, vanishes identically for the Euclidean `{4,3,4}` (0.5 ≤ 0.5, exactly on the boundary), and goes negative for the spherical `{5,3,3}` and `{3,3,3}` — so the construction rejects those for the right reason rather than by accident. All four hyperbolic cases build with their angles exact and orthogonality at machine zero.

Three things had to be got right, and each was caught by measurement rather than by looking:

- **The sphere goes on the negative side of `n2`,** the side the fundamental cone lies on. Placed the other way it never meets the cone at all: the fold reduces by plane reflections alone, the conformal factor stays *exactly* 1, and one cell renders instead of a tessellation. The reflection count exposes it — it should climb toward the boundary (median 4 → 11 as `|p|` goes to 0.99, factor reaching 48) and instead sat flat.
- **The edge skeleton, not the cell walls.** Walls fill the ball, so from outside they render as a featureless sphere. The honeycomb's vertex and edge-midpoint both lie in `n2` and on the mirror sphere, so the geodesic edge between them is an arc of their intersection circle — closed form and cheap.
- **Clipped well inside the ball, not at it.** The edges accumulate on the sphere at infinity, so near `|p| = 1` the structure is finer than any finite reflection budget resolves. Returning the clip distance on its own also makes the clip a surface, since it falls to zero there and trips the hit test; taking `max` with the tube means it only shows where it actually cuts an edge.

Rays are marched in the Euclidean ball, so the estimate must be Euclidean: the conformal factor is accumulated through the inversions and divided out at the end, exactly as the Apollonian and Kleinian estimators do. Fly-through mode is the natural way to see these — a tessellation of space is something to be inside.

**The regular honeycomb is one member of a family.** The Wythoff construction keeps the same four mirrors and adds a *seed point*, labelled by which mirrors it sits off — a four-bit string. The seed lies exactly **on** every inactive mirror and at **equal distance from** every active one, which is three equations in three unknowns for any bit string, so each has an isolated solution. Its orbit gives the vertices, and the orbit of the segments joining it to its mirror images gives the edges. `1000` is the regular honeycomb, `1100` truncated, `1111` omnitruncated — up to fifteen distinct honeycombs per group from mirrors already in hand.

Two facts make this cheap. A circle orthogonal to the boundary sphere is fixed setwise by inversion in it, so the geodesic through the seed and its mirror image also passes through the seed's inverse point — three points determine it in closed form. And the seed depends only on the group and the bit string, so the edge circles are **constants**: solved on the CPU and baked, leaving the shader's per-step cost identical to the regular case.

The `1000` case is the check that matters. Its edge circle is derived completely differently from the one the original honeycomb estimator used — seed-and-reflect versus mirror-sphere-cut-by-a-plane — and the two agree to **1e-16** in centre, radius and normal.

One member is excluded: `0001` places the seed at the cell centre, the origin, whose inverse point is at infinity, so the geodesic is a straight diameter and the circumcircle degenerates. It is also redundant here, since activating only the last mirror gives the *dual* honeycomb and `{5,3,4}` and `{4,3,5}` are each other's duals.

#### Envelope extrusion

Implements the Envelope Extrusion `E(P)` of [Thurman's preprint](https://drive.google.com/file/d/1eA-UfgNv7mfsuTtnFtENk2_OLONeUT7N/view): for each face of a convex seed polyhedron, launch a ray at each shared-edge midpoint toward a parity-dependent farthest feature of the neighbouring face, and take the apex to be the filtered average of the ray family's pairwise closest approaches.

Implementing Definition 1 verbatim reproduces the preprint's published edge ratios exactly — **1 for the octahedron, φ for the dodecahedron, √(2/5) for the icosahedron, 1/√2 for the cuboctahedron** — and Theorem 1's f-vector (`|V| = v+f`, `|E| = 3e`, `|F| = 2e`) on every seed. It also shows the construction is far simpler than its definition, by a lemma the paper does not state:

> **Every ray lies in the plane of the neighbour it came from.** The ray runs from a feature *of* `g` to the midpoint of the shared edge, which is also in `g`; two points of `g` determine a line in `g`'s plane.

So the apex is *forced* onto the intersection of the neighbouring face planes — the classical first-stellation point. Verified to 1e-9 on every seed tested. Each lateral face then lies in a neighbour's plane too, making the pyramid the classical stellation cell, and the whole solid becomes

```text
{ p : p violates at most one of the seed's face half-spaces }
```

Since the seed's face normals come in ± pairs, this reduces to the **second largest of |p·uⱼ|, minus the common offset** — 4 dot products for the octahedral seed, 6 for the dodecahedral. Each term is 1-Lipschitz and an order statistic of 1-Lipschitz functions is 1-Lipschitz, so this is an exact distance under-estimate: the only estimator here needing neither a safety factor nor calibration. Checked against the full plane list at 20,000 points, worst difference 0.

The two shipped seeds are therefore classical solids: the octahedron gives lateral edges equal to seed edges, so every added piece is a regular tetrahedron and the result is **Kepler's stella octangula**; the dodecahedron gives ratio φ and the **small stellated dodecahedron**.

Two seeds are excluded, and the lemma explains both. For the **cube** the neighbouring face planes are parallel in pairs and never meet — the preprint excludes it as "degenerate geometry". For the **tetrahedron** all three neighbours of a face share the single opposite vertex, so all three rays emanate from it and meet only at `t = −1`, behind their origins, where the preprint's own forward filter rejects them. Disabling that filter puts the apex exactly on the seed's opposite vertex, collapsing each pyramid onto the seed itself — which is where the reported ratio of 1.000000 comes from. On that reading `E(Tet)` reproduces its seed rather than extruding it, and is not a new equilateral deltahedron.

#### Tetrabrot

The parameter-space companion to the quaternion Julia set — but deliberately **not** the quaternion Mandelbrot set, which is degenerate.

Starting from `z₀ = 0`, every iterate of `z² + c` is a real polynomial in `c`, so the orbit never leaves the commutative subalgebra `ℝ[c]`, which for a non-real quaternion is isomorphic to `ℂ` by `c ↦ Re(c) + i|Im(c)|`. Membership therefore depends on `c` only through `(Re c, |Im c|)` — making the quaternion Mandelbrot set the **plane Mandelbrot set revolved about the real axis**, a 2D pattern spun around a primitive, which this project's own rules exclude. Measured before discarding it: 4000 random quaternions gave **zero** escape-time mismatches against the complex iteration, and **zero** disagreements across 2400 random rotations of `Im(c)`.

Bicomplex numbers escape this because they are commutative *with zero divisors*. In the idempotent basis `e₁ = (1+ij)/2`, `e₂ = (1−ij)/2` every element splits as `w = w₁e₁ + w₂e₂` with multiplication **componentwise**, so `w ↦ w² + c` decouples into two independent complex quadratic maps and `c` is in the set exactly when both components are in `M`. For the standard slice `c = x + yi + zj`:

```text
c₁ = x + (y − z)i        c₂ = x + (y + z)i
```

So the Tetrabrot is the **intersection of two prisms** over the classical Mandelbrot set, erected along the two diagonals of the `(y,z)` plane. That is genuinely three-dimensional: 580 of 2000 rotated samples change membership, where the quaternion version had none. The `z = 0` cross-section is exactly the classical Mandelbrot set, since both components collapse there — checked cell by cell, 32 disagreements in 25,600, all on the boundary.

The corrugated ridges on the surface are the object, not an artefact — the surface is the preimage of `∂M` under the projection, so the Mandelbrot boundary's filaments are swept along the two prism axes. Raising the bailout and the iteration count leaves them unchanged.

Each component takes the Douady–Hubbard exterior estimate `2|z|log|z|/|z′|`, combined with `max` because the set is an intersection, and divided by `√2` for the projection's metric distortion — `|m(p) − m(q)|² = dx² + (dy∓dz)² ≤ 2|p−q|²`, so the factor is a genuine bound rather than a fudge.

**The formula is sharp at the surface and badly optimistic away from it** — measured ratio to true distance 0.90 close in, but 10.85 against a true 2.9 at the camera, so the opening step cleared the whole object and the first render came back completely empty. The set is contained in a tight box, so the box SDF is also a valid under-estimate and the larger of the two wins: the box in the far field, the formula near the surface. The divisor has to match which region the point is in — 2.4 inside the box (worst sampled 2.248), 4.5 outside (worst sampled 4.139). Using the in-box figure everywhere made *every* reference ray miss.

#### Kissing Schottky groups

A Schottky group is a free discrete group of Möbius transformations built by pairing spheres. Both entries share one estimator and differ only in regime.

The group is generated by inversions in **five mutually tangent spheres**. Its orientation-preserving subgroup has index 2 — hence exactly the same limit set — and is free, generated by the products `σᵢσⱼ`. Those products are the Schottky generators, and their type is forced by the geometry rather than imposed:

- **parabolic** when the two spheres kiss — one fixed point, at the point of tangency;
- **hyperbolic** when they are disjoint, with translation length `2·arccosh(δ)` for the inversive distance `δ = (|c₁−c₂|² − r₁² − r₂²) / (2r₁r₂)`.

`δ` is the exact analogue of the trace: 1 at the parabolic boundary, above 1 in the hyperbolic interior. That is checked, not asserted — iterating a generator to its attracting fixed point and taking `−log` of the multiplier there reproduces `2·arccosh(δ)` **to six decimals**, and at tangency the fixed point converges onto the tangency point with multiplier 1.

**Five spheres, and that is not a free choice.** Four equal spheres with centres equidistant from a point are all orthogonal to a common sphere, so the group preserves it and the entire limit set lies *on* that sphere — a 2D gasket wrapped on a primitive, exactly the failure this project already recorded for the Penrose relief, and unavoidable for the symmetric four-sphere configuration no matter how it is tuned. The fix is the 3D Descartes configuration: four equal spheres at the vertices of a tetrahedron plus one at the centre, all five mutually tangent, with radii fixed by Soddy–Gosset (`(Σk)² = 3Σk²`) at `k_inner = (2 + √6)·k_outer`. A sphere centred at the origin cannot be orthogonal to another centred at the origin, and the symmetry forces any common orthogonal sphere to be origin-centred — so none exists, and the limit set is genuinely three-dimensional: the residual set of the 3D Apollonian packing, Hausdorff dimension about 2.47.

What is drawn is the group orbit of the **central** sphere. The four large generators are deliberately not part of the surface — their orbit is precisely what fills them, so drawing them puts an opaque ball in front of every bit of structure. The first attempt did exactly that and produced four featureless balls.

The shrink parameter is one-sided by necessity: above the kissing configuration the spheres overlap, the Poincaré condition fails and the group stops being discrete. This is a boundary of Schottky space, not a midpoint, so the hyperbolic entry stays strictly below it and the kissing entry is pinned exactly at it.

Like the Apollonian and sphere-pack estimators, this draws a thickened surface rather than a signed field — a limit set has empty interior, so there is no inside to be in. That makes the estimate over-shoot, and the correction is measured: against a dense fixed-step reference the raw quotient skipped **25% of rays** at full step and still **6.5%** at the 0.85 the CPU prototype used — which looked perfectly clean. Pre-scaling by 0.6 against the marcher's 0.9 brings skipping to 0.4%, with a worst remaining error of 0.017 world units.

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

#### Penrose quasicrystal (retired)

*Retired from the model selector.* It is a faithful P3 tiling, but it is a 2D pattern engraved on a disc — the very case this project's own rules exclude, and the failure the Schottky groups were later checked against. The estimator and its id remain in the source so the work is preserved and nothing renumbers; it is simply no longer offered. The construction is recorded below because the cut-and-project machinery is what an icosahedral quasicrystal would build on.

The tiling is generated by de Bruijn's pentagrid construction: five families of parallel lines, whose offsets sum to an integer, dualize to the two Penrose rhombs (thick 72°/108° and thin 36°/144°). Every line intersection becomes one tile.

Rendering needs the map in reverse — given a point, which rhombus covers it. The forward map averages to a similarity, so scaling the point back down recovers the grid coordinate to within the rounding noise of the construction, and the surrounding grid intersections are then tested directly. Searching only the more ambiguous line of each family pair halves that work; measured against an exhaustive search over 90k sample points it misplaces a tile edge on roughly one point in 100,000, and because it searches a subset it can only over-estimate the distance, which keeps sphere tracing safe.

A Penrose tiling inflated by φ² is another Penrose tiling on the same five directions, so running the identical query on a φ²-scaled point yields the parent tiles. Their edges are cut as wide canyons that partition the fine tiles into their parents and open windows where the two carves coincide — the tiling's self-similarity rendered as geometry. Tiles are coloured by rhombus type and by the perpendicular-space coordinate of the cut-and-project construction, and the whole tiling drifts slowly through perpendicular space, which flips individual tiles between the two rhombs while remaining exactly Penrose. It is the heaviest estimator in the set, so a plain disc bound confines the tiling query to a thin band around the surface.

### Strange attractors

The Aizawa, Lorenz and Rössler models are trajectories rather than closed surfaces. Their differential equations are integrated on the CPU using fourth-order Runge–Kutta, uploaded as vertex data, and rasterized as line strips. This keeps the curves crisp while orbiting and zooming.

Each is fitted from a measured run rather than by eye: the trajectory is integrated, its bounding box taken, and the centre and scale chosen to place it in roughly `[-1,1]³`. The step size is picked so the arc length per step is comparable across the three — 0.005 for the compact Aizawa, 0.046 for the large, fast-moving Lorenz, 0.034 for Rössler. Rössler is the only one of the three whose centre is off-axis, because it has no symmetry about the vertical: its measured box is `x[-9.11, 11.43]`, `y[-10.79, 7.84]`, `z[0.01, 22.85]`.

Rössler is also the simplest dissipative chaotic system there is — a single quadratic term, where Lorenz has two. It winds outwards in a nearly flat spiral and then folds sharply up out of the plane, and that fold is the stretch-and-fold mechanism that produces the chaos.

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
