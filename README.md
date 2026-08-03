# WebGPU Raymarched 3D Fractal Background

A self-contained, dependency-free **WebGPU** animated background that renders a
distance-estimated 3D fractal (Mandelbulb by default; Mandelbox, Menger sponge,
and a quaternion Julia are also selectable). It's built to sit *behind* page
content as a full-viewport decorative layer — dazzling but never in the way —
and it degrades gracefully when WebGPU is unavailable.

No Three.js, no Babylon, no build step, no npm. Just ES modules, WGSL, and HTML.

```
webgpu-fractal-background/
├── index.html                    demo page: real text/buttons on top, canvas behind
├── src/
│   ├── fractal-bg.js             main module — device, pipelines, render loop, lifecycle
│   ├── palettes.js               Inigo Quilez cosine-palette presets
│   └── shaders/
│       ├── fractal.wgsl.js       vertex + fragment raymarcher (inlined WGSL)
│       └── composite.wgsl.js     post-process: bloom + ACES tonemap + vignette + dither
└── README.md
```

WGSL is **inlined as template strings** (not `fetch`-ed) so there are no
CORS/fetch problems when running locally.

## Quick start

```js
import { initFractalBackground } from './src/fractal-bg.js';

const canvas = document.getElementById('bg');
const handle = await initFractalBackground(canvas, {
  fractal: 'mandelbulb',
  palette: 'aurora',
  quality: 'auto',
  transparent: true,
  onUnsupported: (reason) => {
    // WebGPU missing/failed — show your own CSS fallback.
    canvas.style.display = 'none';
    console.warn(reason);
  },
});
```

The recommended CSS for the canvas (see `index.html`):

```css
#bg { position: fixed; inset: 0; z-index: -1; pointer-events: none; }
```

`pointer-events: none` keeps the background click-through; `z-index: -1` keeps it
behind your DOM.

### Running the demo

- **Firefox and Safari 26+** load ES modules directly from `file://`, so you can
  just open `index.html`.
- **Chrome/Edge** block ES-module `import` from `file://` (their CORS policy for
  module scripts — unrelated to this project). Serve the folder over HTTP:

  ```bash
  # any static server works; pick one
  python3 -m http.server 8000
  npx http-server -c-1
  ```

  then visit `http://localhost:8000/`.

## Options

| Option          | Type       | Default        | Description                                                                 |
| --------------- | ---------- | -------------- | --------------------------------------------------------------------------- |
| `fractal`       | string     | `'mandelbulb'` | `'mandelbulb'` \| `'mandelbox'` \| `'menger'` \| `'julia'` \| `'apollonian'` \| `'spherepack'` \| `'encrusted'` \| `'attractor'` (Aizawa) \| `'lorenz'` |
| `palette`       | string     | `'aurora'`     | `'aurora'` \| `'ember'` \| `'oil-slick'` \| `'mono-ice'` \| `'iridescence'`  |
| `quality`       | string     | `'auto'`       | `'low'` \| `'medium'` \| `'high'` \| `'auto'` (adaptive)                     |
| `transparent`   | boolean    | `true`         | `true` = premultiplied alpha over the page; `false` = opaque gradient bg    |
| `onUnsupported` | function   | `() => {}`     | Called with a reason string if WebGPU is missing or the device is lost      |

## Handle API

`initFractalBackground` resolves to a handle (or `null` if unsupported):

| Method                      | Description                                                        |
| --------------------------- | ----------------------------------------------------------------- |
| `setFractal(name)`          | Switch fractal at runtime (no re-init).                           |
| `setPalette(name)`          | Switch cosine palette at runtime.                                 |
| `setQuality(mode)`          | `'low'`/`'medium'`/`'high'`/`'auto'`; recreates render targets.   |
| `setTransparent(bool)`      | Toggle transparent-over-page vs. opaque gradient background.      |
| `setExplorer(bool)`         | Model-explorer preset: opaque bg, no auto-drift, full navigation. |
| `setControls(bool)`         | Enable drag/pinch/wheel navigation without the full preset.       |
| `setAutoOrbit(bool)`        | Toggle the time-driven camera drift.                             |
| `setZoom(n)` / `zoomBy(f)`  | Set/multiply the camera distance (1 = default framing).          |
| `resetView()`               | Recenter the orbit and reset zoom.                               |
| `pause()`                   | Stop the render loop.                                             |
| `resume()`                  | Resume (respects visibility/intersection gating).                |
| `destroy()`                 | Tear down: observers, listeners, GPU textures, and the device.   |
| `info` (getter)             | `{ fractalType, qualityMode, qualityScale, fps, reducedMotion, explorer, zoom }`. |

### Navigation & explorer mode

Beyond the drifting background, the fractal can be driven as a navigable 3D
model. `setControls(true)` (or the all-in-one `setExplorer(true)`) enables:

- **Drag** (mouse or one finger) to orbit around the fractal.
- **Pinch** (two fingers) or **mouse wheel** to zoom in/out.
- **Double-tap / double-click** or `resetView()` to recenter.

`setExplorer(true)` additionally switches to an opaque background, stops the
automatic camera drift, and adds a gentle idle spin when you're not touching it
— turning the piece into a full-screen model viewer. Turning it back off
restores the original background configuration. In the demo, the **Enter
explorer mode** button wires this up and fades the page text out of the way.
Navigation stays smooth even under `prefers-reduced-motion` (only the automatic
parameter animation is frozen, not your input).

## How it works

**Two render passes into HDR, then composite:**

1. **Raymarch pass** → renders the fractal into an offscreen `rgba16float`
   texture at an internal resolution (scaled by the quality tier). A fullscreen
   triangle (generated from `vertex_index`, no vertex buffer) drives a
   distance-estimation sphere-tracing fragment shader. Output: lit color in RGB,
   emission/glow in A.
   - **Distance estimators:** Mandelbulb (analytic `0.5·log(r)·r/dr` with an
     animated `power`), Mandelbox (box fold + sphere fold), Menger sponge
     (folding-space IFS), a quaternion Julia, and an **Apollonian** gasket
     (fold + sphere inversion — a fractal sphere packing of nested,
     shrinking spheres with a slowly breathing packing tightness), and
     **`'spherepack'`** — the same fold + inversion machinery but with a
     *sphere* base primitive instead of the Apollonian's plane, which resolves
     the structure into nested tangent spheres rather than smooth sheet-like
     lobes, and **`'encrusted'`** — a smooth host sphere with the packing
     confined to a thin surface shell, grown over a cap whose boundary is
     perturbed by the orbit trap into a ragged, coral-like edge, so bare body
     shows through where the crust hasn't grown. All loops are statically
     bounded (`const` limits) for WGSL
     portability, with guarded `log`/`pow`/inversion domains and clamped radii
     to avoid NaNs.
   - **Strange attractors** (`'attractor'` = Aizawa, `'lorenz'` = the classic
     butterfly): the odd ones out. An attractor is a *trajectory*, not a
     surface, and has no closed-form distance function — so it can't be
     sphere-traced. Instead the ODE is integrated on the CPU with **RK4** to
     600k exact float positions, uploaded as a vertex buffer, and rasterized as
     an additively-blended **line strip** over the background in the same pass.
     Because that's vector geometry rather than a baked voxel grid, the curve
     stays crisp at any zoom. Color comes from position along the trajectory,
     and the accumulated emission feeds the bloom pass. The trajectory is
     rebuilt lazily whenever a different attractor is selected.
   - **Shading:** tetrahedron (4-sample) normals, one key + fill directional
     light, **soft penumbra shadows** (min-ratio along the shadow ray),
     **ambient occlusion** from DE sampling, **orbit-trap coloring** fed into a
     cosine palette for iridescent banding, a Fresnel rim, near-miss **glow**,
     and exponential **distance fog** into a background gradient.
2. **Composite pass** → separable Gaussian **bloom** on the emission/bright
   pixels (at half resolution, two passes), **ACES** tonemap, gamma, a subtle
   **vignette** (keeps edges dark for text legibility), and **dithering** to
   kill banding. Writes premultiplied color to the swap-chain.

**Uniforms** are packed into a single 160-byte buffer with a std140-friendly,
16-byte-aligned layout. The byte offsets are mirrored between the WGSL `struct`
(both shader files) and the JS `U` offset table in `fractal-bg.js` — keep them in
lockstep if you edit the struct.

### Color / palettes

Palettes use Inigo Quilez cosine palettes, `a + b·cos(2π(c·t + d))`, with the
coefficients uploaded as uniforms so they swap at runtime. The palette input is
the orbit-trap value plus a slow time phase, so colors gently cycle. Presets live
in `src/palettes.js`: **aurora** (teal→magenta), **ember** (deep red→gold),
**oil-slick** (iridescent rainbow), **mono-ice** (cool monochrome), and
**iridescence** (soap-bubble / beetle-shell thin-film sheen — per-channel
frequencies drift in and out of phase for a shifting cyan→magenta→gold shimmer).
Bloom and overall exposure are tuned dark and moody so text stays readable on top.

## Adaptive quality

In `'auto'` mode a rolling FPS estimate (EMA) drives the internal render
resolution and epsilon. If it stays below ~50 fps it steps `qualityScale` down;
if it's comfortably above target for a sustained window it steps back up — with
hysteresis so it never thrashes. Coarse-pointer / small-viewport devices start at
a lower tier. Explicit tiers (`low`/`medium`/`high`) pin the scale.

## Battery / lifecycle

- **`ResizeObserver`** recreates render targets on resize; device pixel ratio is
  capped (max 2) to protect mobile GPUs.
- **`IntersectionObserver`** + **`visibilitychange`** pause the loop when the
  canvas is scrolled offscreen or the tab is hidden.
- **`prefers-reduced-motion`** freezes the camera and parameter animation to a
  static pose and renders a single frame instead of spinning `requestAnimationFrame`.
- **Device-lost** is handled: one automatic re-init attempt, then `onUnsupported`.
- Pipelines, bind groups, samplers, and textures are created once; only the
  uniform buffer is rewritten per frame (targets are recreated only on
  resize/quality change).

## Browser support

Requires WebGPU (`navigator.gpu`):

- **Chrome / Edge** 113+ (desktop; Android with WebGPU enabled).
- **Safari 26+** (macOS/iOS).
- **Firefox** with WebGPU enabled.

If `navigator.gpu` is missing or `requestAdapter()` returns `null`,
`onUnsupported` fires and nothing is rendered — the caller shows a fallback (the
demo swaps in a static CSS gradient).

## Stretch features included

- Mouse-move **parallax** that gently nudges the camera (disabled under
  reduced-motion).
- A fourth fractal (**quaternion Julia**).
- **Dithering** to reduce banding on the dark gradient.
