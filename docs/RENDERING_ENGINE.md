# Rendering Engine

This document describes the architecture, performance strategy, and engineering invariants of the WebGPU renderer used by Complex Geometry Explorer.

It is an implementation document rather than an API tutorial. The README explains how to use the library and describes the mathematical models. This file explains how the renderer turns those models into an image, how it adapts to the device it is running on, and which design decisions should be preserved when the engine changes.

The adaptive-quality ladder was introduced in commit `9f0d024`. Commit `104eb59` corrected the governor to use a signal that remains meaningful under vsync and added thermal re-probe backoff. Commit `260c5b7` unified mode entry so `quality: 'max'` and `setQuality('max')` behave identically. Commit `23bddda` made supersampling respect the adapter's texture-dimension limit by fitting the swapchain, capping the quality ladder to allocatable rungs, and retaining an allocation clamp as a final backstop. The subsequent diagnostics layer adds optional observational telemetry and copyable renderer reports so the next quality changes can be driven by measurements from real hardware rather than inferred cost models.

## 1. Design goals

The renderer serves two roles without maintaining two engines:

1. a lightweight animated background that should be frugal with battery and GPU time; and
2. an interactive mathematical explorer that should use available hardware aggressively enough to produce the best image the device can sustain.

The design follows several principles:

- **Measure capability instead of identifying hardware.** Runtime behavior is authoritative; GPU names and device classes are not.
- **Spend headroom on visible quality.** Strong hardware should receive more pixels, more raymarch steps, deeper iteration, and full shading rather than merely producing unused frame rate.
- **Protect interaction first.** While the camera is moving, the controller protects presentation cadence. Once the view is still, the renderer can spend much more time per sample.
- **Keep fixed modes deterministic.** Low, Medium, and High select known rungs. High remains the historical `1.0 / 160 / 12` quality point.
- **Do expensive geometry work once when possible.** Progressive accumulation stores palette-independent material information so palette animation and image controls can remain live without re-marching.
- **Keep decision logic testable without WebGPU.** Quality, camera-rate, recovery, palette parsing, mode planning, and texture-limit fitting are pure where practical.
- **Measure before retuning.** Developer diagnostics observe the renderer without feeding results back into it, so perceptual changes to the upper ladder can be justified by real device/model evidence.

## 2. Main source files

- `src/fractal-bg.js` — device acquisition, pipelines, render targets, uniforms, cameras, render loop, lifecycle, quality plumbing, progressive accumulation, texture-limit fitting, and public API.
- `src/quality.js` — pure adaptive-quality decision logic, quality ladder, mode planning, texture-limit rung calculation, and optional environment-free diagnostic observation hooks.
- `src/diagnostics.js` — developer snapshots, bounded rung history, report formatting, and the optional browser-facing diagnostics controller.
- `src/camera.js` — pure orbit/fly mathematics, drift, zoom-rate helpers, and device-loss policy.
- `src/palettes.js` — built-in cosine palettes.
- `src/palette-io.js` — imported palette parsing and persistence.
- `src/shaders/fractal.wgsl.js` — distance estimators and the clearance/centre-hit compute probe.
- `src/shaders/material.wgsl.js` — palette-independent surface/material pass.
- `src/shaders/attractor.wgsl.js` — strange-attractor line rendering.
- `src/shaders/composite.wgsl.js` — palette resolution, bloom, image controls, tonemapping, and final presentation.
- `src/shaders/engel.wgsl.js` — generated Engel plesiohedron data and estimator.

`quality.js` decides **how much work should be done** and whether a quality rung can actually fit. `fractal-bg.js` applies those decisions to render-target size and shader uniforms. `diagnostics.js` observes the resulting public state and quality events; it has no authority to change a governor decision.

## 3. Two geometry families

### Distance-estimated and implicit surfaces

Most models expose a distance estimator or signed-distance-like field and are sphere-traced in the fullscreen material pass. The adaptive ladder controls live raymarch step ceiling and, where applicable, fractal iteration depth.

### Strange attractors

Aizawa, Lorenz, and Rössler do not expose a closed-form distance field suitable for sphere tracing. Their trajectories are integrated on the CPU with RK4 and uploaded as line-strip geometry. Each currently uses 600,000 trajectory points.

Their line material is also palette-independent, so attractor colour can remain live after accumulation.

## 4. Frame architecture

A frame consists of an optional compute probe followed by the render pipeline.

### 4.1 Clearance / centre-hit probe

In Explorer and Fly modes the renderer can dispatch a one-workgroup compute probe before rendering. It evaluates camera clearance and the centre ray.

It is deliberately:

- dispatched **before** render passes, avoiding expensive tile-memory resolve/reload patterns on tile-based GPUs;
- throttled to `PROBE_INTERVAL_MS = 50`, about 20 Hz; and
- read back asynchronously, accepting a frame or two of latency.

The probe supports clearance-relative fly movement and orbit surface re-pinning for deep zoom.

### 4.2 Material pass

The first render pass writes two full-resolution `rgba16float` attachments, `sceneTex` and `auxTex`. The pass stores material summaries rather than final RGB.

### 4.3 Bloom

Bloom is a two-pass 9-tap Gaussian blur. Palette resolution and bright/emissive extraction occur before the horizontal blur. Bloom runs at half internal resolution.

### 4.4 Composite

The final pass resolves material through the live palette, combines bloom, applies explicit Hue, exposure, ACES tonemapping, gamma, saturation, backdrop-relative contrast, and then writes to the swapchain.

The ordering is deliberate: palette cycling and image controls stay out of the raymarch so they do not invalidate accumulated geometry samples.

## 5. Palette-independent material representation

Built-in cosine palettes and imported colour-stop ramps are both resolved in the post chain from stored palette coordinates.

This allows:

- immediate recolouring of a converged image;
- imported ramps without fitting them to cosine coefficients;
- palette-faithful colour cycling by shifting palette coordinates;
- a separate explicit Hue control that may intentionally rotate final RGB; and
- bloom that follows the current palette because palette resolution happens before bloom extraction.

The distinction between **palette cycling** and **Hue** is an invariant.

## 6. Progressive accumulation

When an interactive view becomes genuinely still, progressive subpixel accumulation begins. Current conditions include no active pointer, no fly movement keys, stopped orbit drift, and at least `ACCUM_IDLE_MS = 400` since interaction.

Samples use an R2 low-discrepancy jitter sequence and are averaged directly into the material targets with fixed-function blending.

The live convergence cap is still:

```text
ACCUM_CAP = 96 samples
```

After convergence, the raymarch/material draw is skipped and the stored material is simply re-presented through the post chain.

`quality.js` contains `accumTarget()` for rung-dependent targets, but `fractal-bg.js` does **not** currently use it. Adaptive accumulation counts are therefore not implemented yet.

## 7. Adaptive quality governor

The governor controls a **deadline**, not a maximum frame rate. Its normal moving-view budget is:

```text
BUDGET_MS = 16.7 ms
```

The first adaptive implementation correctly moved away from averaged FPS, but initially made a second mistake: it tried to infer headroom from mean `requestAnimationFrame` frame time. That signal is quantised by vsync.

### 7.1 Why mean frame time failed under vsync

At 60 Hz, a frame that finishes before the next refresh is generally observed by the animation loop as roughly 16.7 ms whether the GPU work took 1 ms, 8 ms, or 16 ms. A missed refresh is observed near 33.3 ms, then 50 ms, and so on.

Therefore a rule such as “climb when mean frame time falls below 12 ms” can never see headroom on a vsync-locked 60 Hz display. A workstation doing 1 ms of rendering work looks identical to a device doing 15 ms as long as both hit the next refresh.

The old FPS thresholds happened to survive this because `1000 / 16.7` is about 59.9 FPS, just over the previous 58 FPS climb threshold. That was accidental, not a sound measurement model.

The current governor instead uses the signal the display actually exposes reliably: **the fraction of frames that missed the presentation budget**.

### 7.2 Quality ladder

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

Rung 5 is deliberately the former high-quality ceiling.

WGSL keeps higher compile-time bounds:

```text
MAX_STEPS = 320
DE_ITERS  = 20
```

The loops break at the live values in `u.detail`, so raising the static ceiling does not force low rungs to execute high-rung work.

### 7.3 Fixed modes and starting estimate

Fixed presets map onto the same ladder:

| Mode | Rung |
| --- | ---: |
| Low | 1 |
| Medium | 3 |
| High | 5 |
| Max preset rung | 9 |

Before Auto has measurements, it makes a disposable starting guess:

- coarse pointer or less than about 900 device pixels across: rung 1;
- less than about 1700 device pixels across: rung 3;
- otherwise: rung 4.

Runtime evidence is authoritative after that.

### 7.4 Miss-rate signal

A frame counts as having met the budget when it is within a small tolerance:

```text
MET_TOLERANCE = 1.05
```

The miss indicator is exponentially smoothed into `missRate`. The controller currently uses:

```text
CLIMB_MISS    = 0.02
DROP_MISS     = 0.12
CLIMB_SAMPLES = 90
DROP_SAMPLES  = 20
STALL_FACTOR  = 4.0
```

Interpretation:

- an essentially all-on-time run sustained for 90 samples is evidence to try a higher rung;
- a sustained miss rate above 12% is overload and causes a drop after 20 samples; and
- a single catastrophic frame beyond `4.0 × budget` drops one rung immediately — **and records nothing else**.

**The hitch rule was corrected by measurement, and it is the first thing real hardware caught.** On a healthy 60 Hz Windows desktop holding 60 fps, `STALL_FACTOR = 2.5` fired constantly: `2.5 × 16.7 = 41.75 ms`, and a single hitch that misses two vsyncs is 50 ms — ordinary jank from the compositor, a GC pause, or a burst of drag events. Each such frame dropped *two* rungs and recorded `ceiling = index − 1` and `lastFail`, so the repeat-failure backoff doubled: 20 s, 40 s, 80 s. The recovery mechanism built for a thermally throttled phone ended up pinning a perfectly healthy desktop at rung 1 of 10 — 840 × 450 internal, 90 steps, cheap shading — while the machine never dropped a frame's worth of real work. The measured transition log ratcheted 3 → 1 → 2 → 0 and stayed there, with every drop reporting `miss 0`, which is the signature of the stall path rather than genuine overload.

Two changes follow from that. A hitch now drops **one** rung rather than two, and it records **no** ceiling, no `lastFail` and no backoff extension — one late frame is not evidence that a rung is unsustainable, and only the sustained miss-rate path may lower the ceiling. And the threshold moved to `4.0 ×`, which needs four missed refreshes.

Simulated against the corrected rule, a machine that is otherwise flawless reaches the top rung with hitches as often as every three seconds, and only genuinely constant hitching — three times a second — still suppresses quality, which is correct.

The governor still maintains `emaMs`, but the EMA is no longer the climb/drop signal. It remains useful for reporting and for the approximate still-frame cost model in `showcaseIndex()`.

### 7.5 Remembered failed rung and thermal backoff

When a rung proves too expensive, the governor:

1. drops below it;
2. records the **rung that failed** in `lastFail`; and
3. lowers the trusted ceiling to one rung below the failed rung.

The distinction between “failed rung” and “current ceiling” matters. The periodic ceiling reset lifts the ceiling before a retry. Comparing a new failure against the lifted ceiling made repeat-failure detection permanently false in the first implementation.

A failed ceiling is eventually re-probed because the scene may have become cheaper or the device may have cooled. The base retry interval is:

```text
CEILING_RESET_MS = 20000
```

If the same rung fails again, the retry delay is multiplied by:

```text
CEILING_BACKOFF = 2.0
```

up to:

```text
CEILING_RESET_MAX_MS = 300000
```

This makes thermal behavior self-correcting without device-specific thermal APIs. A hot phone or laptop can back down and re-probe increasingly rarely while remaining capable of recovering later.

The intended stability property is therefore **not “the rung never moves once settled.”** Re-probing is deliberate. The property is that repeated probes of a still-bad ceiling become rarer rather than producing continuous climb/stall/drop chatter.

### 7.6 Robustness to bad samples

Non-positive and non-finite samples are ignored. Very long pauses such as tab switches or GC stalls are clamped before entering the running statistics so one multi-second interruption does not dominate subsequent quality decisions.

### 7.7 Converged frames are not governor evidence

This remains a strict invariant, but the reason is more precise under the miss-rate controller than it was under the discarded mean-time controller.

A converged frame skips the expensive raymarch and will usually meet the presentation deadline. Feeding those cheap frames into the governor **dilutes evidence of overload** from interactive frames.

A 50/50 mixture of late interactive frames and cheap converged frames is still detected by the current miss-rate rule. The failure appears at the ratio that is realistic once the accumulator is doing most of the work: for example, if nine out of ten samples are cheap post-only frames, their on-time results can hold the smoothed miss rate below the drop threshold even while every true interactive raymarch frame is late.

Therefore:

**Never feed converged-frame timing into the adaptive governor.**

`fractal-bg.js` already enforces this by returning through the accumulation branch without calling `adaptQuality()`. `tools/quality.test.js` records both the 50/50 non-failure and the realistic high-dilution failure so the boundary is explicit rather than assumed.

## 8. Auto and Max

The selector exposes:

```text
Low -> Medium -> High -> Auto -> Max
```

### Auto

Auto is the normal adaptive mode. It protects the 16.7 ms moving-view budget and searches for the highest rung that can keep presentation misses acceptably rare.

### Max

Max is adaptive however it is entered. Constructing with `quality: 'max'` and later calling `setQuality('max')` produce the same planned state because both go through `planMode()`.

Its more ambitious personality is defined by three differences from Auto:

- **Starting rung:** one above the Auto heuristic estimate.
- **Interactive budget:** `BUDGET_MS * MAX_BUDGET_FACTOR`, where:

```text
MAX_BUDGET_FACTOR = 1.35
```

  This is about 22.5 ms at the current base budget.
- **Miss thresholds:** Max tolerates more late frames before backing down:

```text
MAX_CLIMB_MISS = 0.06
MAX_DROP_MISS  = 0.30
```

  Auto uses `CLIMB_MISS = 0.02` and `DROP_MISS = 0.12`.

Max therefore does more than start higher and accept a longer frame budget. It deliberately tolerates a larger fraction of late frames, which makes it visibly ambitious where Auto is intended to stay unobtrusive.

When the view becomes still, Max can use `showcaseIndex()` with an approximate still-frame budget of 220 ms and escalate beyond the interactive rung.

`showcaseIndex()` estimates higher-rung cost mainly from resolution area, with secondary march-step and iteration factors. It is a useful global approximation, not a per-model performance model.

### Unified mode planning

The single mode-planning entry point is `planMode(mode, autoRung)` in `src/quality.js`. It returns:

```text
{ rung, gov }
```

The contract is:

- every fixed preset returns `gov = null` and its documented preset rung;
- `auto` and `max` return a live governor;
- `init()` and `setQuality()` both call `planMode()`;
- `adaptQuality()` uses it as the lazy fallback if an adaptive mode somehow reaches the render loop without a governor;
- unknown modes fall back to `PRESET_RUNG.high` with no governor; and
- the returned starting rung passes through `clampIndex`, so an Auto heuristic estimate near the top cannot run off the ladder.

The defect fixed by `260c5b7` was not simply an overly narrow `mode === 'auto'` comparison. The deeper problem was that the same decision existed in multiple places. `init()` had one branch that recognised only Auto. `setQuality()` had another that recognised both Auto and Max. A third copy in `adaptQuality()` lazily called `govInit(state.detailRung)`, which silently gave a Max session Auto's default budget if that path was reached.

The fix is one pure decision function rather than wider comparisons in several callers. **Mode-to-governor planning must remain centralised in `planMode()` rather than being duplicated.**

## 9. Resolution, supersampling, DPR, and texture limits

The swapchain normally tracks full device-pixel resolution. DPR is capped at 2, and internal material resolution is:

```text
render width  = device-pixel width  * quality scale
render height = device-pixel height * quality scale
```

Scales above 1.0 are true supersampling. At 2× scale, material pixel count is roughly four times rung 5 before additional march and iteration work is considered.

Supersampling made the adapter's `maxTextureDimension2D` a first-class constraint. `resize()` now obtains that limit from `device.limits.maxTextureDimension2D`, with 8192 as the code's fallback value if the limit is unavailable.

### 9.1 Fit the swapchain without changing aspect ratio

The requested backing-store size begins as CSS size multiplied by DPR. If either axis exceeds the texture limit, `resize()` computes one shared fit factor:

```text
swapFit = min(1, limit / pixelWidth, limit / pixelHeight)
```

That same factor is applied to **both** axes. Width and height must never be fitted independently because doing so would satisfy the allocation limit by stretching the rendered image.

### 9.2 Cap the ladder, not only the allocation

`maxRungForLimit(pxW, pxH, limit)` returns the highest quality rung whose internal target dimensions fit the device limit.

This cap is necessary even though the final allocation is also clamped. A clamp by itself prevents a texture-creation failure, but it creates a false performance signal: if two nominal rungs are both silently clamped to the same pixel dimensions, the higher rung costs little or no additional pixel work. The governor can misread that unchanged frame time as spare headroom and continue climbing. It may then settle at a high rung while delivering the pixel resolution of a lower rung and still paying the higher march-step and iteration budgets.

The quality state therefore has to tell the truth about what the renderer can actually allocate.

`resize()` sets `state.rungCap` from `maxRungForLimit()` and holds both the live rung and any adaptive governor to that cap:

- `state.detailRung` cannot remain above it;
- `state.gov.index` cannot remain above it; and
- `state.gov.ceiling` cannot remain above it.

`applyRung()` is the single choke point for later rung changes and clamps every requested rung to `state.rungCap`, so Auto, Max, showcase escalation, and public quality changes cannot bypass the device limit.

### 9.3 Allocation clamp remains a backstop

After the rung has been capped, `resize()` still computes a final proportional `renderFit` before creating textures. This is deliberate belt-and-braces protection: the logical rung cap should make the allocation legal, but an unexpected oversize texture request can take down the renderer, so the final creation path protects itself independently.

The hierarchy is therefore:

1. proportionally fit an oversized swapchain;
2. compute the highest honest quality rung with `maxRungForLimit()`;
3. cap renderer and governor state to that rung; and
4. proportionally clamp the final internal target as a last-resort allocation guard.

A 5120 × 1440 CSS-pixel ultrawide at DPR 2, for example, requests 10240 pixels across before supersampling. With an 8192-pixel texture limit the backing store is fitted proportionally, and the 2× top rung is no longer presented as available. The renderer caps itself at the highest rung that genuinely fits instead of pretending to run a higher-resolution rung whose allocation has been truncated.

## 10. Mathematical detail controls

The selected rung reaches WGSL through:

```text
detail.x = live raymarch step ceiling
detail.y = live fractal iteration depth
detail.z = cheap/full shading selector
detail.w = spare
```

Higher iteration depth can reveal genuine iterative structure. Higher march-step ceilings reduce missed thin geometry. These dimensions solve different visual failure modes than supersampling.

The current ladder raises resolution, step count, iteration depth, and shading together. Their value and cost vary by model.

## 11. Shading and surface precision

The surface pass includes diffuse lighting, neutral specular, soft shadow, ambient occlusion, fresnel contribution, fog, and model-specific seam/glow terms.

The first two rungs use the cheaper shading path. Full shading begins at rung 2.

Surface hit precision also responds to quality scale so low-resolution moving frames do not spend disproportionate numerical effort resolving detail they cannot display.

## 12. Camera architecture

### Orbit / Explorer

The orbit camera stores an explicit pivot and distance. Zooming in can re-pin the pivot onto the surface under the centre ray using the GPU probe, allowing asymptotic approach toward visible geometry rather than pushing through it toward the centroid.

A throw decays toward a subtle directional drift. Double-tap/double-click or `freezeView()` clears the drift and permits progressive accumulation.

### Fly-through

Fly-through decouples position and look direction from the origin. Travel is clearance-relative:

```text
step = clearance * (1 - exp(-k * dt))
```

This is frame-rate independent and asymptotic near surfaces.

## 13. Device and power selection

The library defaults to a low-power adapter request so the original background-effect use remains frugal. Callers can pass:

```js
power: 'high'
```

to request `high-performance`. The Explorer demo opts into this preference.

Power preference is only a request; runtime measurement remains necessary.

## 14. Reduced motion and lifecycle

`prefers-reduced-motion` suppresses automatic animation where appropriate while leaving manual navigation available.

Visibility and intersection gating stop the animation loop when the page or canvas is not meaningfully visible.

## 15. Device-loss recovery

Device loss is treated as potentially transient. `planDeviceLoss()` distinguishes bursts of repeated failures from separate incidents after a healthy run. Quick repeated failures eventually fall back; a later isolated loss may be retried again.

The policy is pure and covered by `tools/recovery.test.js`.

## 16. Testing strategy

The project moves control logic out of GPU-only code whenever practical.

`tools/quality.test.js` now covers, among other things:

- phone, laptop, and workstation synthetic devices;
- **vsync-quantised** frame reporting rather than only continuous timing;
- a strong device climbing under vsync-locked timing;
- occasional missed-vsync jitter without rung chatter;
- scene cost becoming abruptly more expensive;
- catastrophic single-frame stalls;
- remembered failed-rung ceilings;
- increasingly rare re-probes;
- simulated thermal throttling;
- converged-frame dilution at both 50/50 and realistic high-converged ratios;
- invalid samples and long pauses;
- showcase escalation;
- mode planning in which both adaptive modes produce a governor by either entry route;
- every fixed preset producing no governor and landing on its documented rung;
- unknown modes falling back safely;
- the heuristic starting rung being respected and clamped;
- Max settling no lower than Auto on the same simulated device;
- `maxRungForLimit()` across ordinary displays, 4K-class dimensions, an 8192-wide backing store, an ultrawide, and a 16384-wide stress case;
- the invariant that the selected rung fits the limit and, when a higher rung exists, the next rung does not;
- limits large enough to leave the ladder untouched; and
- degenerate inputs including zero dimensions, zero limits, and a limit below even the lowest rung.

### 16.1 Diagnostics coverage

`tools/diagnostics.test.js` covers the pure diagnostic helpers and observation boundary, including:

- bounded transition history without mutation of the caller's array;
- proportional dimension fitting and aspect preservation;
- reconstruction of requested and effective internal render sizes;
- Auto, Max, and fixed-preset diagnostic personalities;
- frozen quality events and read-only retained snapshots;
- no mutation of governor inputs or outputs by diagnostics;
- differential comparison against the pre-diagnostics governor arithmetic over long deterministic Auto and Max frame sequences;
- no observer notification for ordinary steady frames, so the active diagnostic path does not allocate an event object every frame;
- safe subscriber removal;
- fixed versus adaptive snapshot representation;
- texture-constrained rung information;
- accumulation and convergence reporting;
- graceful formatting when fields are unavailable;
- installation of `getDiagnostics()` and `getRendererReport()` on a diagnostic-wrapped handle;
- mode and accumulation changes in transition/report state; and
- clean restoration of wrapped public methods on `destroy()`.

The diagnostics suite contains 55 assertions in the initial implementation. The existing quality suite remains at 77 assertions from `23bddda`; the last recorded project-wide baseline before diagnostics was 404 assertions.

The quality suite contains 77 assertions as of `23bddda`, up from 62 at `260c5b7`. The project-wide suite reported 404 assertions at that revision.

The texture-limit cap is pure, so its boundary behavior can be tested without WebGPU. Browser/GPU integration still matters because the proportional swapchain fit and actual texture creation live in `fractal-bg.js`.

Synthetic tests prove controller arithmetic against known models. They do not answer perceptual questions such as whether 2× supersampling is the best use of the top-rung budget.

## 17. Important invariants

### 17.1 Renderer diagnostics are observational

The Explorer demo contains a collapsed **Diagnostics** section. It is disabled by default. Opening the section enables live governor sampling; closing it unsubscribes the diagnostic listener again. `?diagnostics=1` opens it at startup for deliberate benchmark sessions.

The diagnostic snapshot draws from three kinds of authoritative evidence:

1. the renderer's public `handle.info` values for the live model, rung, workload, FPS, navigation, and accumulation count;
2. quality-module observations for governor state, showcase decisions, the texture limit, and `rungCap`; and
3. the browser DPR plus canvas backing store for the requested pixel density and the swapchain's actual fitted width and height.

Browser DPR and effective backing-store scale are reported separately because an oversized swapchain may be proportionally fitted below the DPR request. The private material textures are not exposed by the renderer. Their dimensions are therefore reconstructed from the actual swapchain dimensions, live quality scale, observed device limit, and the same proportional fitting rule used by `resize()`. The report labels requested and effective dimensions separately so a requested supersampling scale is never presented as proof that those pixels were allocated.

`src/diagnostics.js` keeps a bounded history of 32 meaningful transitions by default. Rung-change events reuse the existing quality decisions rather than creating another quality controller. The demo refreshes the visible diagnostic text on the existing 500 ms HUD cadence rather than rewriting DOM on every animation frame.

**Copy Renderer Report** produces plain text containing quality/governor state, real dimensions, texture constraint, mathematical workload, accumulation state, current model, recent transitions, and low-entropy browser information such as user agent, platform string, and language.

The measurement boundary is deliberate. Quality subscribers receive frozen event snapshots only after a decision is complete. Subscriber return values are ignored and subscriber exceptions are contained. When no subscriber is active, ordinary `govSample()` frames retain only the governor object already produced by the controller and a few scalar fields; they create no diagnostic event objects, frozen copies, or callbacks. This preserves an accurate last-interactive snapshot even if Diagnostics is opened after the view has converged, while avoiding measurement work substantial enough to manufacture the headroom it is trying to observe.

1. **Use presentation deadline misses as the adaptive climb/drop signal.** Mean `requestAnimationFrame` frame time cannot observe sub-refresh headroom under vsync.
2. **Do not feed converged frames into the governor.** Cheap post-only frames dilute overload evidence from interactive raymarch frames.
3. **Remember the rung that failed, not merely the current ceiling.** Ceiling reset changes the ceiling before a retry.
4. **Back off repeated failed-rung probes.** Thermal throttling should lead to increasingly rare retries, not periodic stalls forever.
5. **Re-probing is intentional.** Stability means probes get rarer, not that the rung can never change after settling.
6. **Keep compile-time WGSL loop ceilings separate from live rung limits.**
7. **Keep palette lookup after material accumulation.**
8. **Keep explicit Hue separate from palette cycling.**
9. **Keep the clearance probe before render passes and throttled.**
10. **Keep interaction and showcase quality conceptually separate.**
11. **High remains the historical `1.0 / 160 / 12` point unless compatibility is deliberately changed.**
12. **A quality-rung change invalidates accumulation.**
13. **Keep all quality-mode entry through `planMode()`.** Constructor, setter, and lazy fallback must not grow separate mode decisions.
14. **Texture limits cap the ladder as well as the allocation.** A silently clamped high rung creates false headroom and wastes step/iteration work.
15. **Fit both axes with one factor.** Independent width/height clamps would distort aspect ratio.
16. **Keep the final allocation clamp even with an honest rung cap.** Texture creation is a hard failure boundary, so the creation path retains its own backstop.
17. **Diagnostics never feed the controller.** They may observe completed decisions, but diagnostic values, callbacks, and UI state must not become governor inputs.
18. **Keep diagnostic UI work off the render loop.** The demo samples for display at a coarse cadence, and live governor telemetry is disabled while Diagnostics is closed.
19. **Report allocated/fitted dimensions honestly.** Requested scale, actual swapchain size, effective internal size, and texture-limit cap are distinct facts.

## 18. Known limitations and next measurements

### Per-model cost learning

The engine still has a global ladder and global showcase cost model. A better long-term direction is online per-device, per-model learning from actual observed model/rung cost rather than guessed constants.

This should wait for real timings. Inventing per-model constants without measurements would turn the governor back into theoretical tuning.

### Real-hardware diagnostic campaign

The diagnostics layer is the bridge from synthetic controller tests to perceptual tuning. The next renderer experiment should collect comparable reports from at least one phone, one laptop, and one desktop/workstation.

For each device, compare Auto and Max while moving and then freeze the view long enough to observe showcase and accumulation behavior. Use at least one inexpensive raymarched model, Mandelbulb or Mandelbox, Barth sextic, Tetrabrot, and one strange attractor. Record the copied renderer report alongside a visual judgement of whether the next rung produced visible improvement.

This campaign should happen before changing the upper ladder, wiring adaptive accumulation, or introducing per-model learned costs. Diagnostics supplies evidence; it does not infer the answer from synthetic timings.

### Top-rung quality allocation

The largest unresolved perceptual question is whether the top of the ladder spends too much on pixels.

Rung 9 uses 2× resolution scale, roughly quadrupling material-pixel work relative to rung 5 before its larger step and iteration limits are counted. On a normal display the visual return from that final supersampling increase may be smaller than the return from tighter surface precision, deeper iteration, or additional accumulation.

This cannot be decided from synthetic timing tests. It should be judged on real hardware and real models. If 2× supersampling is visually inefficient, the top three rungs can be reordered in the single `LADDER` array so mathematical detail or accumulation receives the budget before additional pixels.

### Adaptive accumulation count

`accumTarget()` exists but remains unwired. Connecting it should be a separate, visually tested change.

### Showcase cost model

`showcaseIndex()` still assumes resolution area dominates and adjusts globally for steps/iterations. Models such as the Barth sextic or Tetrabrot may be disproportionately iteration-bound. Real measurements should determine whether the estimator needs model-aware learned costs.

### GPU timestamps

The current controller intentionally uses user-visible presentation outcome. GPU timestamp queries could eventually provide a complementary diagnostic signal for distinguishing GPU work from CPU/presentation effects, but they should not replace the presentation signal the user actually experiences.

Large render targets are no longer an open limitation in the sense previously documented: swapchain fitting, ladder capping, and a final allocation guard now keep requested textures within the active device limit. Future work in this area should focus on visual policy rather than basic allocation safety, for example whether a heavily constrained display should expose the effective rung cap in the UI.

## 19. Performance philosophy

The renderer should not make every device perform the same workload.

The goal is for every device to render the **best version of the same mathematical scene that it can comfortably sustain**.

A phone may use reduced internal resolution, shallower iteration, and cheaper shading while moving. A workstation may supersample and search deeper mathematics. A very large display may hit a texture-dimension ceiling before it hits a performance ceiling; in that case the renderer should stop at the highest rung it can honestly allocate rather than inventing unusable headroom.

When a view becomes still, spare time can be converted into fidelity rather than unused frame rate.

The controlling distinction is therefore:

**responsiveness while interacting; maximal fidelity while observing.**
