# Rendering Engine

This document describes the architecture, performance strategy, and engineering invariants of the WebGPU renderer used by Complex Geometry Explorer.

It is an implementation document rather than an API tutorial. The README explains how to use the library and describes the mathematical models. This file explains how the renderer turns those models into an image, how it adapts to the device it is running on, and which design decisions should be preserved when the engine changes.

The adaptive-quality system described here was introduced in commit `9f0d024`.

## 1. Design goals

The renderer has to serve two different roles without maintaining two separate engines:

1. a lightweight animated background that should be frugal with battery and GPU time; and
2. an interactive mathematical explorer that should use available hardware aggressively enough to produce the best image the device can sustain.

The resulting design follows several principles:

- **Measure capability instead of identifying hardware.** The adaptive governor learns from observed frame cost rather than from GPU model names or a device database.
- **Spend headroom on visible quality.** A fast GPU should receive more pixels, more raymarch steps, deeper mathematical iteration, and full shading rather than simply rendering the same picture at a higher unused frame rate.
- **Protect interaction first.** While the camera is moving, quality is governed by a frame-time budget. Once the view is still, the renderer can spend much more time per frame because responsiveness is no longer the limiting requirement.
- **Keep fixed modes deterministic.** Low, Medium, and High select known quality rungs. High is deliberately the former pre-governor ceiling, so adding adaptive quality did not reduce or redefine the old high-quality mode.
- **Do expensive geometry work once when possible.** Progressive accumulation stores palette-independent material information. Palette animation and image controls can then remain live without throwing away a converged raymarch.
- **Keep decision logic testable without WebGPU.** Camera rate maths, device-loss policy, palette parsing, and the adaptive-quality governor live in pure modules where practical.

## 2. Main source files

The renderer is split into a small orchestration layer and specialized shader/modules:

- `src/fractal-bg.js` — WebGPU device acquisition, pipelines, render targets, uniforms, cameras, render loop, lifecycle, quality plumbing, progressive accumulation, and the public handle.
- `src/quality.js` — pure adaptive-quality governor and the quality ladder.
- `src/camera.js` — pure camera-rate, fly-through, drift, zoom, and device-loss decision logic.
- `src/palettes.js` — built-in cosine palettes.
- `src/palette-io.js` — imported palette parsing, clamping, and persistence.
- `src/shaders/fractal.wgsl.js` — distance estimators and the GPU clearance/centre-hit probe.
- `src/shaders/material.wgsl.js` — palette-independent surface/material rendering.
- `src/shaders/attractor.wgsl.js` — line rendering for strange attractors.
- `src/shaders/composite.wgsl.js` — palette resolution, bloom, image controls, tonemapping, and final presentation.
- `src/shaders/engel.wgsl.js` — generated Engel plesiohedron data and estimator.

The important separation is that `quality.js` decides **how much work should be done**, while `fractal-bg.js` applies that decision to the WebGPU resources and uniforms.

## 3. Two geometry families

The catalogue contains two fundamentally different rendering families.

### Distance-estimated and implicit surfaces

Most models expose a distance estimator or signed-distance-like field. They are rendered by sphere tracing / raymarching in the fullscreen material pass.

The fragment shader advances a ray through the field until it either reaches a surface threshold or passes the maximum travel distance. Surface hits then receive normal, lighting, shadow, ambient-occlusion, fog, palette-coordinate, and glow information.

The adaptive ladder controls the live raymarch step ceiling and, where applicable, fractal iteration depth.

### Strange attractors

Aizawa, Lorenz, and Rössler do not have a closed-form distance field suitable for sphere tracing. Their trajectories are integrated on the CPU using RK4 and uploaded as line-strip geometry.

Each attractor currently uses 600,000 trajectory points. The per-vertex scalar is derived from velocity and later used as a palette coordinate. Because the geometry is stored as floating-point vertices rather than as a voxel volume, the curve remains geometrically crisp under zoom.

The line renderer writes the same kind of palette-independent summary used by the surface pipeline so attractor colour can also remain live after accumulation.

## 4. Frame architecture

A frame is built from one optional compute operation followed by the rendering pipeline.

### 4.1 Clearance / centre-hit probe

In Explorer and Fly modes the renderer may dispatch a one-workgroup compute probe before the render passes. The probe evaluates the field at the camera and along the centre ray and reports values used by navigation.

It is deliberately:

- dispatched **before** render passes, because inserting compute between render passes can force tile-memory resolve/reload on tile-based mobile GPUs;
- throttled to `PROBE_INTERVAL_MS = 50`, or about 20 Hz; and
- read back asynchronously, accepting a frame or two of latency because camera speed control and surface re-pinning do not require same-frame precision.

The probe drives two major navigation features:

- fly-through movement scales with measured clearance, so travel covers a fraction of the remaining gap instead of a fixed world-space distance;
- orbit zoom can re-pin the camera pivot to the surface under the crosshair, allowing deep zoom toward a visible surface rather than pushing the camera through it toward the model centroid.

### 4.2 Material pass

The first render pass draws the scene into two full-resolution `rgba16float` attachments:

- `sceneTex`
- `auxTex`

For implicit models this is a fullscreen triangle using `fs_material`. For attractors, the line strip is added in the same pass after the background/material draw.

The material pass does **not** store final RGB. It stores enough scalar information to reconstruct the scene later through whichever palette is currently active.

### 4.3 Bloom horizontal

The first bloom pass resolves the live palette, extracts bright/emissive material, and performs the horizontal half of a 9-tap Gaussian blur.

Bloom operates at half the internal render resolution.

### 4.4 Bloom vertical

The second bloom pass completes the vertical blur into the second half-resolution bloom target.

### 4.5 Composite

The final fullscreen pass:

1. resolves material through the current palette and colour-cycle phase;
2. combines bloom;
3. applies the explicit Hue image adjustment when requested;
4. applies exposure before the ACES filmic tonemapper;
5. applies display gamma;
6. applies saturation;
7. applies contrast relative to the reconstructed backdrop rather than conventional mid-grey; and
8. writes to the current swapchain texture with the configured alpha mode.

This ordering matters. Moving palette cycling or image controls back into the raymarch pass would make those controls invalidate expensive accumulated geometry samples.

## 5. Palette-independent material representation

The central rendering optimization is the separation of geometry/material sampling from palette presentation.

Built-in palettes are Inigo Quilez-style cosine palettes. Imported palettes are explicit colour-stop ramps. These are different mathematical representations, but both are resolved in the post chain from stored palette coordinates.

The material targets store weighted palette-coordinate summaries, neutral specular contribution, fog/background contribution, seam contribution where required, glow/emission, and miss/background coverage.

This gives the engine several useful properties:

- switching between built-in palettes can recolour a fully converged image immediately;
- switching to an imported ramp does not require a new raymarch;
- automatic colour cycling shifts **palette coordinates**, so a selected palette remains recognizably itself throughout the cycle;
- the explicit Hue control remains separate and is allowed to rotate the finished RGB image away from the chosen palette;
- bloom follows the live palette because palette resolution happens before bloom extraction.

The distinction between palette cycling and Hue is intentional and should be preserved.

## 6. Progressive accumulation

When an interactive view becomes genuinely still, the renderer begins progressive subpixel accumulation.

Current conditions include:

- interactive controls are enabled;
- no pointer is down;
- no fly-through movement key is held;
- orbit drift has been stopped; and
- no interaction has occurred for `ACCUM_IDLE_MS = 400`.

Each sample uses an R2 low-discrepancy subpixel jitter. R2 samples distribute more evenly than independent random jitter, so the running average converges without random clumping.

Accumulation is performed directly in the two material render targets using fixed-function blending. For sample `n`, the new sample contributes `1/(n+1)` and the existing accumulated result contributes the remainder. This replaces an older ping-pong accumulation pass and avoids two additional full-resolution textures and a fullscreen pass.

The live renderer currently uses a fixed convergence cap of:

```text
ACCUM_CAP = 96 samples
```

Once a still view reaches the cap, the raymarch/material draw is skipped entirely. The already-converged material is simply re-presented through the post chain. That makes an idle converged view much cheaper than a moving view while still allowing palette cycling and post controls to remain live.

`quality.js` contains an `accumTarget()` helper for rung-dependent accumulation targets, but the renderer does **not** currently use it; `fractal-bg.js` still governs convergence with the fixed 96-sample cap. Do not describe adaptive accumulation counts as implemented until that helper is wired into the render loop.

## 7. Adaptive quality governor

Adaptive quality is based on **frame time in milliseconds**, not on an average of FPS values.

A frame-time budget is the quantity being controlled directly, and averaging reciprocal frame times biases the result toward fast frames because:

```text
mean(1 / t) != 1 / mean(t)
```

The governor therefore maintains an exponential moving average of frame milliseconds and decides when to move between quality rungs.

### 7.1 Quality ladder

`src/quality.js` defines ten rungs:

| Rung | Resolution scale | March steps | Fractal iterations | Full shading |
| ---: | ---: | ---: | ---: | :---: |
| 0 | 0.40× | 70 | 6 | No |
| 1 | 0.50× | 90 | 8 | No |
| 2 | 0.60× | 110 | 9 | Yes |
| 3 | 0.70× | 120 | 10 | Yes |
| 4 | 0.85× | 140 | 11 | Yes |
| 5 | 1.00× | 160 | 12 | Yes |
| 6 | 1.25× | 190 | 13 | Yes |
| 7 | 1.50× | 220 | 15 | Yes |
| 8 | 1.75× | 260 | 16 | Yes |
| 9 | 2.00× | 300 | 18 | Yes |

Rung 5 is intentionally the former high-quality ceiling: `1.0 / 160 / 12`.

The WGSL compile-time ceilings are higher than the current live ladder maximum:

```text
MAX_STEPS = 320
DE_ITERS  = 20
```

The shader loops remain statically bounded for WGSL, but break when the live values in `u.detail` are reached. Raising the compile-time ceilings therefore does not force a low rung to execute the full high-end workload.

### 7.2 Fixed modes

Named fixed presets map onto the same ladder:

| Mode | Rung |
| --- | ---: |
| Low | 1 |
| Medium | 3 |
| High | 5 |
| Max fixed rung | 9 |

Using one ladder for both named and adaptive quality prevents two independent definitions of what “high” means.

### 7.3 Starting estimate

Before useful frame measurements exist, Auto makes only a coarse starting guess based on viewport/device characteristics:

- coarse pointer or less than about 900 device pixels across: rung 1;
- less than about 1700 device pixels across: rung 3;
- otherwise: rung 4.

This guess is deliberately disposable. Runtime measurement is the authority.

### 7.4 Interactive budget

The normal interactive budget is:

```text
BUDGET_MS = 16.7 ms
```

This corresponds roughly to a 60 Hz frame interval.

The governor does not climb merely because a frame is under budget. It requires substantial margin:

```text
CLIMB_FRACTION = 0.72
```

So the moving average must be below about 72% of the budget before frames count as evidence for an upward move.

The current hysteresis values are:

```text
CLIMB_SAMPLES = 90
DROP_SAMPLES  = 20
STALL_FACTOR  = 2.0
```

A normal climb therefore requires sustained headroom. Sustained over-budget operation causes a drop. A single frame above twice the budget is treated as a stall and triggers an immediate larger retreat.

### 7.5 Remembered ceiling

A key anti-oscillation mechanism is the remembered ceiling.

When a rung proves too expensive, the governor does two things:

1. drops quality; and
2. records one rung below the failed level as the highest currently trusted rung.

Without this memory, a controller tends to repeat the same loop indefinitely: climb, stall, drop, rediscover apparent headroom, climb back into the same stall.

The ceiling is not permanent. After `CEILING_RESET_MS = 20000` of healthy operation, it can lift by one rung so the renderer can discover that a cheaper scene, a zoomed-out view, or a changed thermal state now permits more work.

This also means thermal throttling does not require special device detection: if a phone or laptop becomes slower after sustained load, the measured frame time rises and the governor backs down.

### 7.6 Sample robustness

The governor rejects non-finite and non-positive frame samples.

Long pauses such as tab switches or garbage-collection events are clamped before entering the exponential moving average. One multi-second pause should not depress rendering quality for the next minute.

### 7.7 Converged frames are not benchmark samples

This is an important invariant.

Once accumulation converges, the raymarch is skipped. Those frames are therefore dramatically cheaper than the workload the governor is supposed to control.

**Never feed converged-frame timing into the adaptive governor.**

Doing so creates false evidence of unlimited headroom. The governor would climb into a quality rung that the device cannot sustain and the failure would only become visible when interaction restarts and raymarching resumes.

`tools/quality.test.js` contains a test that deliberately demonstrates this failure mode.

## 8. Auto and Max

The quality selector exposes:

```text
Low -> Medium -> High -> Auto -> Max
```

### Auto

Auto is the normal adaptive mode. It targets the 16.7 ms interactive budget and searches for the highest rung the current device and scene can sustain with adequate margin.

Its purpose is to be unobtrusive: interaction should remain responsive while strong hardware is allowed to exceed the old 1.0-resolution ceiling.

### Max

Max is intentionally more aggressive.

When selected through the public `setQuality('max')` path it:

- begins one rung above the usual automatic starting estimate; and
- gives the interactive governor a budget of `BUDGET_MS * 1.35`, roughly 22.5 ms.

Once the view is still, Max can escalate beyond the interactive rung using `showcaseIndex()`.

The current still-frame estimate allows up to approximately:

```text
220 ms per showcase frame
```

A still view does not need 60 Hz responsiveness. The engine can therefore trade latency for better resolution and mathematical detail while progressive accumulation refines the picture.

`showcaseIndex()` currently estimates higher-rung cost mainly from pixel area, then adjusts for march-step and iteration ratios. This is a useful first model, not a per-model performance oracle.

## 9. Resolution, supersampling, and DPR

The swapchain remains at full device-pixel resolution.

The renderer caps device pixel ratio at:

```text
dprCap = 2
```

Internal material resolution is then:

```text
render width  = device-pixel width  * quality scale
render height = device-pixel height * quality scale
```

A scale below 1.0 reduces internal workload. A scale above 1.0 is true supersampling: the internal material buffers are larger than the swapchain and are filtered back to presentation resolution in the post chain.

Because pixel cost grows with area, 2× resolution scale can represent roughly four times as many material pixels before accounting for the simultaneously increased raymarch and iteration work. The governor therefore treats supersampling as expensive and only reaches it on devices with measured headroom.

One current limitation: `resize()` does not explicitly clamp supersampled target dimensions against `device.limits.maxTextureDimension2D`. Very large high-DPI canvases therefore rely on the requested targets remaining within device limits. If the application is expanded toward very large displays, explicit limit-aware sizing should be added.

## 10. Mathematical detail controls

Adaptive quality changes more than resolution.

The current rung is sent to WGSL through the `detail` uniform:

```text
detail.x = live raymarch step ceiling
detail.y = live fractal iteration depth
detail.z = cheap/full shading selector
detail.w = spare
```

This design makes mathematical complexity a runtime resource budget.

A higher iteration count can reveal genuine additional structure in iterative models. A higher march-step ceiling can prevent thin geometry from being skipped before the maximum travel distance is reached. These controls therefore improve different failure modes than supersampling.

The relative value and cost of each control varies by model. The current ladder raises them together in a global order rather than maintaining per-model quality recipes.

## 11. Shading and surface precision

The surface pass includes diffuse lighting, neutral specular, soft shadow, ambient occlusion, fresnel contribution, fog, and model-specific seam/glow terms.

The first two ladder rungs use the cheaper shading path. Full shading is enabled from rung 2 upward.

Surface hit precision also responds to quality scale. Higher quality tightens the hit threshold, while lower-quality modes permit a larger epsilon so inexpensive rendering does not spend disproportionate work resolving subpixel surface precision.

The purpose of this is perceptual allocation: a low-resolution moving image should not pay high-end numerical cost for detail it cannot display.

## 12. Camera architecture

### Orbit / Explorer

The orbit camera stores an explicit pivot and distance rather than merely orbiting the global origin.

Zooming in attempts to re-pin the pivot onto the surface under the centre ray using the GPU probe. The eye remains where it is while the pivot slides forward to the measured hit. Subsequent zoom then approaches that surface asymptotically.

This prevents the common failure where deep orbit zoom eventually moves through the visible shell because the camera is actually dollying toward the model centroid.

Orbit movement has momentum. A throw decays toward a small directional drift rather than automatically reaching zero. Double-tap/double-click or `freezeView()` clears the drift and allows the view to become truly still, which in turn enables progressive accumulation.

### Fly-through

Fly-through separates camera position and look direction from the origin.

Movement is clearance-relative rather than based on a fixed number of world units:

```text
step = clearance * (1 - exp(-k * dt))
```

That gives two important properties:

- movement is frame-rate independent; and
- approaching a surface is asymptotic, so one frame cannot consume more than the remaining gap.

Pinch dolly uses the same proximity philosophy.

## 13. Device and power selection

The library defaults to requesting a low-power WebGPU adapter:

```js
navigator.gpu.requestAdapter({ powerPreference: 'low-power' })
```

This preserves its original background-effect use case.

Callers that explicitly want maximum visual capability can pass:

```js
power: 'high'
```

which requests:

```text
high-performance
```

The Explorer demo opts into the high-performance preference.

The preference remains a request rather than a guarantee; browser/OS WebGPU implementation ultimately chooses the adapter. Runtime frame measurement is therefore still required even after requesting high performance.

## 14. Reduced motion and lifecycle

`prefers-reduced-motion` suppresses automatic animation such as background motion, colour-cycle phase motion, and orbit drift where appropriate.

Manual navigation remains available. In interactive modes the render loop can stay alive under reduced motion so drag, pinch, wheel, and fly controls continue to work.

The renderer also gates work using page visibility and canvas intersection. Hidden or non-intersecting canvases stop the animation loop instead of consuming GPU time off-screen.

## 15. Device-loss recovery

WebGPU device loss is treated as potentially transient.

The renderer records how long the device had been healthy and uses the pure `planDeviceLoss()` policy in `camera.js` to distinguish a burst of repeated failures from separate incidents far apart in time.

A loss after a healthy interval resets the incident count and may be retried again. Repeated quick losses eventually stop retrying and call the unsupported/fallback path.

This behavior is covered by `tools/recovery.test.js` because device loss cannot be reliably provoked on demand in normal browser testing.

## 16. Testing strategy

The project intentionally moves decision logic out of GPU-only code when it can be expressed as pure arithmetic.

Relevant suites include:

- `tools/quality.test.js` — synthetic phone/laptop/workstation cost models, stability, expensive-scene reaction, catastrophic stalls, remembered ceilings, converged-frame contamination, invalid samples, long pauses, and showcase escalation.
- `tools/camera.test.js` — orbit/fly camera mathematics.
- `tools/recovery.test.js` — device-loss retry policy.
- `tools/colorcycle.test.js` — palette-cycle and image-adjustment arithmetic.
- `tools/palette.test.js` — imported palette parsing and persistence.
- `tools/attractor.test.js` — attractor fits, step quality, and Lyapunov behavior.
- `tools/kleinpack.test.js` and `tools/engel.test.js` — construction/estimator-specific mathematical checks.
- `tools/shader-check.html` — compilation of WGSL modules in a WebGPU-capable browser.

Synthetic governor tests prove controller behavior under known cost curves. They do **not** replace observation on real GPUs. The constants governing climb margin and showcase estimates still require empirical calibration.

## 17. Important invariants

The following are easy to accidentally simplify away and should be treated as deliberate architecture:

1. **Do not feed converged frame times into the quality governor.** They omit the raymarch and are not representative workload samples.
2. **Keep the remembered bad-rung ceiling.** Hysteresis alone does not prevent repeated climb/stall/drop cycles.
3. **Use frame time, not averaged FPS, as the governor's controlled quantity.**
4. **Keep compile-time WGSL loop ceilings separate from live rung limits.** A high static ceiling should not make low quality execute high-quality work.
5. **Keep palette lookup after material accumulation.** Moving palette resolution into the geometry pass would make palette animation and palette switching invalidate convergence.
6. **Keep explicit Hue separate from palette cycling.** Palette cycling changes coordinates within the selected palette; Hue intentionally transforms final RGB.
7. **Keep the clearance probe before render passes and throttled.** Its synchronization cost matters especially on tile-based mobile GPUs.
8. **Keep interaction and showcase quality conceptually separate.** A still image can spend hundreds of milliseconds per sample without harming camera responsiveness.
9. **High must remain the historical 1.0 / 160 / 12 quality point unless a deliberate compatibility change is made.**
10. **A quality-rung change invalidates accumulation.** Samples gathered at another resolution/detail rung do not describe the same rendered signal.

## 18. Known limitations and next measurements

The adaptive engine is deliberately measurement-driven, but several decisions are still global approximations.

### Per-model cost learning

`showcaseIndex()` currently estimates cost primarily by resolution area with a secondary step/iteration factor. That is reasonable globally, but individual models have different bottlenecks.

For example, a model dominated by expensive estimator iteration can react differently from one dominated by pixel fill or post-processing.

A better long-term design is **online per-device, per-model cost learning** rather than hard-coded model constants. The engine can observe actual cost for model/rung combinations and gradually learn which dimension of quality that particular device can afford for that model.

### Separate quality dimensions

The current ladder raises resolution, march steps, iteration depth, and shading together. That is simple and robust, but eventually leaves performance on the table.

A mature governor could choose among several upgrade actions based on measured visual benefit per millisecond:

- resolution / supersampling;
- march-step ceiling;
- fractal iteration depth;
- surface epsilon / normal quality;
- shadow and AO quality;
- progressive accumulation target.

That would allow a model whose iteration depth is expensive to spend spare GPU time on supersampling instead, while another model might make the opposite trade.

### Adaptive accumulation count

`quality.js` already contains `accumTarget()`, but `fractal-bg.js` still uses the fixed 96-sample convergence cap. Wiring the two together should be treated as a separate change with visual and thermal testing rather than assumed to be active today.

### Hardware timestamps

The current controller observes browser frame intervals, which measure the outcome users care about but also include CPU scheduling, presentation cadence, and other work.

If broadly available and worth the complexity, GPU timestamp queries could provide a second signal that distinguishes GPU saturation from CPU/presentation effects. They should complement rather than replace user-visible frame-time behavior.

### Thermal behavior

The governor should already respond naturally to thermal throttling because it continuously measures frame cost. Real-device testing should verify that its ceiling-reset behavior does not re-probe expensive rungs too aggressively on a device that remains thermally constrained.

### Very large render targets

Supersampling up to 2× combined with a DPR cap of 2 can produce large offscreen textures. Explicit clamping against WebGPU texture limits should be added if the renderer is expected to target unusually large canvases or display walls.

## 19. Performance philosophy

The rendering engine should not aim to make every device render the same workload.

The goal is for every device to render the **best version of the same mathematical scene that it can comfortably sustain**.

On a phone that may mean reduced internal resolution, shallower iteration, and cheaper shading while the user moves. On a workstation it may mean supersampling beyond native resolution with a much deeper mathematical search. When either device becomes still, progressive accumulation can turn spare time into image quality rather than unused frame rate.

That distinction — responsiveness while interacting, maximal fidelity while observing — is the organizing principle behind the current engine.