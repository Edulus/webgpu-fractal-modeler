# Handoff: antialiasing while the view is moving

**Status: solved, and confirmed by eye.** Kept as the record of how, because
three attempts failed first and the reasons are worth not repeating.

Repo: https://github.com/Edulus/webgpu-fractal-modeler
Live: https://edulus.github.io/webgpu-fractal-modeler/
A/B: append `?edgeaa=0` to turn the fix off and compare.

## 0. Outcome

Edge-aware silhouette reconstruction inside the existing composite pass
(`5fcb075`..`7e2e1ad`, gated in `ab34af6`, switchable in `8a1b60b`). It reads
the binary hit/miss coverage the material pass already writes to `aux.w`,
estimates the local edge tangent from its gradient, and averages two short taps
ALONG the edge rather than across it. No extra pass, no new binding, no extra
render target.

Measured at 0.881x MSE against supersampled reference coverage across 24
combinations of render scale and edge angle — a ~12% improvement, which is
small enough that it could not be trusted on its own. So the filter was made
switchable and compared directly in a browser. Verdict from that comparison:
**filter on is better.** That is the evidence that matters here; the synthetic
figure only established the sign.

It is spent only on single-sample frames. Once accumulation has more than one
sample the silhouette is already resolved by up to 96 jittered samples, and
refiltering it would soften real detail.

---

## 1. The problem

Silhouette edges **staircase visibly while the camera is moving** and become
clean the moment it stops. The user's words: *"when the user freezes the view,
the jaggy edges disappear... is there a way to have the shape smooth and high
resolution even while moving?"* It is most obvious on the hyperbolic honeycombs,
whose thin tube edges show hard stair steps against the background.

### Why still frames are clean

While the view is still, the renderer does **progressive accumulation**: it
re-renders with an R2 (Roberts low-discrepancy) subpixel jitter and averages in
place via blend constants, up to `ACCUM_CAP = 96` samples. That is a very good
antialiaser. See `src/fractal-bg.js` — `r2jitter()`, `ACCUM_CAP`, `accumulating()`,
`state.accumSamples`, and the `blendWeight = 1 / (accumSamples + 1)` in pass 1.

### Why moving frames are not

Motion resets `accumSamples` to 0, so a moving frame is **one sample**, taken on
the *internal* render grid — which at a low quality rung is a fraction of the
display size. The composite pass upsamples that with a linear filter, so the
edge is a ramp rather than a cliff, but the ramp still turns over on internal-
pixel boundaries and reads as a staircase.

### Why "just render at higher resolution" is not the answer

Measured, not assumed. The adaptive governor (`src/quality.js`) pins the test
machine to **rung 1** (`scale 0.50, steps 90, iters 8`) at full-screen size.
Rung 2 does not fit inside a vsync interval there. A separate measurement:
shrinking the browser window took the *same scene* from rung 1 to rung 4, which
establishes the low rung is a genuine fill-rate limit rather than a governor
bug. (There *was* a governor bug — see §4 — and it was fixed; this persists
after the fix.)

---

## 2. Renderer architecture you need to know

`src/fractal-bg.js` (~2.2k lines) is the whole renderer. Vanilla WebGPU, no
dependencies, no build step. WGSL lives in JS template literals under
`src/shaders/` so the thing can be opened over `file://`.

Per frame, in `frame()`:

| Pass | Pipeline | Target | Notes |
|---|---|---|---|
| 0 | `probe` (compute) | storage buffer | one-thread clearance probe, ~20Hz |
| 1 | `raymarch` / `attractor` | `sceneTex` + `auxTex` (HDR, **internal** res) | encoded material, accumulated via blend constants |
| 2 | `bloomH` | `bloomA` (half internal res) | |
| 3 | `bloomV` | `bloomB` | |
| 4 | `composite` | **swapchain** (display res) | resolve + bloom + ACES + vignette; upsamples pass 1 |

Bind group layouts are built once in `_bgl`; **bind groups are rebuilt in
`createTargets()`** on every resize *and every quality-rung change*. Anything you
add has to be created there or it will be stale after the first rung change.

Key state: `state.detailRung`, `state.showcaseRung`, `state.accumSamples`,
`state.targets`, `state.bindGroups`, `state.pipelines`.

Useful constants: `LADDER` in `src/quality.js` (10 rungs, `scale` 0.40 → 2.00),
`BUDGET_MS = 16.7`, `ACCUM_CAP = 96`.

---

## 3. What was tried, and what happened

### Attempt 1: FXAA as a fifth pass — **failed, reverted**

Commits `8884cc3` → `8c84689` → `9393364`, all reverted in `7db737b`.
`git show 8884cc3` for the original diff; it is worth reading before you redo it.

The design was sound on paper: run a classic luma-edge FXAA over the *finished,
tonemapped* image, so it costs the raymarch nothing and cannot push the quality
ladder down a rung. Composite renders to an LDR texture at swapchain size, then
an FXAA pass reads that and writes the swapchain. Enabled only while moving —
`const smoothing = state.fxaaOn && !acc && ...` — because refiltering a
converged frame would soften detail that is genuinely resolved.

Three bugs shipped, in order:

1. **Nothing visibly improved.** Cause found later: the filter took its texel
   size from `u.resolution`, which carries the **internal** render size, not the
   swapchain size. On a `scale 0.5` frame every tap landed ~2 output pixels away
   — across the staircase rather than along it, close to the worst possible
   sample position.
2. **Fixed the texel** with `textureDimensions(ldrTex, 0)` and strengthened the
   blend. Still broken.
3. **The page rendered nothing at all.** The composite pass rendered *into*
   `ldrTex` while its own bind group also bound `ldrTex` at slot 5. WebGPU
   forbids a texture being a writable render attachment and a readable binding
   in the same pass, so the pass was invalid. Fixed with a separate
   `bindGroups.fxaa`; composite binds `sceneView` at slot 5, which it never
   samples.
4. **Still broken after that fix.** Cause unknown — this is where it was
   reverted rather than guessed at a fourth time.

**Read this before rewriting FXAA:** all three commits were pushed on the same
evidence — the shaders compile and a simulated frame raises no error. That
evidence is insufficient and was the direct cause of every one of the failures
above. It cannot see a wrong texel size and it cannot see a resource-usage
violation.

### Attempt 2: edge-aware resolve inside the composite pass — **worked**

See §0. The decisive difference from attempt 1 was not the filter maths, which
is similar in spirit. It was staying inside a pass that already existed, so
there was no new binding and no new render target — and therefore no way to
commit either of the two bugs that killed attempt 1.

### Ruled out by reasoning, not tried

- **Temporal reprojection (TAA).** Would keep accumulation across motion, and
  is a more complete answer than filtering one frame's edges. Needs history
  rejection; without it, moving edges smear. Not attempted, and no longer
  urgent now that the cheap fix is confirmed to work.
- **MSAA on the raymarch pass.** Not useful as-is: the geometry is a full-screen
  triangle, so there are no primitive edges for MSAA to find. The silhouette is
  a discontinuity *inside* the fragment shader.

---

## 4. Fixed already — do not re-diagnose these

- **Governor desync** (`effff4d`). `applyRung()` moved the renderer without
  updating `state.gov.index`, so the governor charged frames to the wrong rung;
  miss rate ran to 0.93 and the ladder walked to the floor. Fixed with
  `govResync()` in `src/quality.js`. This is *not* the cause of the aliasing —
  confirmed by the window-resize measurement in §1.
- **A backtick inside a WGSL comment** (`effb15c`) ended the JS template literal
  and made the entire renderer fail to load — a blank page with a syntax error
  naming an unrelated identifier. `tools/registry.test.js` now asserts no shader
  payload contains a backtick.
- **`patch` is a WGSL reserved keyword** and was used as a variable, which
  failed compilation of the whole fractal module and blacked out every shape.

---

## 5. Obstacles in the working environment

These are why it took four attempts rather than one, and they may or may not
apply to you. None of them went away; the fix landed in spite of them, by
putting the change behind a switch and having a human compare.

- **No usable WebGPU in the sandbox.** Headless SwiftShader initialises and then
  dies within about a second. No screenshots, and validation errors cannot be
  captured reliably before the device is gone. This is the single biggest
  obstacle: *the renderer could not be looked at while it was being changed.*
- **Compile-and-validate is not verification.** `getCompilationInfo()` (see
  `tools/shader-check.html`) proves WGSL parses. It says nothing about resource
  usage rules, texel sizes, or whether the image looks right.
- Outbound proxy blocks `github.io`, so the deployed page cannot be fetched from
  the sandbox either.
- Foreground `sleep` is blocked.

### What worked instead

A **measurement-driven** method: port the distance estimator and a minimal
raymarcher to Node, render to an array, and measure a numeric property —
axis-aligned normal percentage, local depth minima, seam luminance, pixel-change
rate under a parameter sweep. Crucially, **validate the metric against controls
before trusting it** (a smooth sphere must score 0 bumps; a studded ball must
score many). One metric in this session was wrong and produced a confidently
false conclusion because it was never controlled.

Also: **mutation testing.** After adding a test, reintroduce the bug and confirm
the test fails. A green suite proves nothing about what it would catch. Warning
learned twice the hard way — `git checkout -- <file>` to undo a mutation will
silently discard uncommitted work in that file. **Commit first, mutate second.**

---

## 6. Verification available to you

- `for f in tools/*.test.js; do node "$f"; done` — 17 suites, all currently
  passing, no framework. `tools/registry.test.js` is the cross-cutting one: it
  checks id contiguity, selector↔registry agreement in both directions, shader
  dispatch bands derived from the registry, and the backtick guard.
- `tools/shader-check.html` — compiles all four shader modules in a real browser
  and prints `getCompilationInfo()` diagnostics.
- **In-app "Copy Renderer Report"** (Diagnostics section of the control panel).
  Emits the live rung, scale, fps, miss rate, rung transitions with reasons, and
  accumulation sample count. This is the best signal available from a machine
  that can actually run the thing — ask the user for one.
- GitHub Pages deploys `main` on push, about 60–90s.

---

## 7. If you pick this up again

The problem is solved, so this section is about not undoing it.

**Look at it in a real browser between writing it and pushing it.** If you
cannot run WebGPU, ship the change behind a switch and have someone compare,
the way `?edgeaa=0` was used to settle this one. A screenshot must be taken
*mid-drag* — a settled frame is clean regardless of whether the change works,
so an after-the-fact screenshot proves nothing.

Remaining directions, in order of what they would buy:

1. **Strengthen the filter.** The blend is deliberately conservative: taps at
   0.4 texel, maximum weight 0.7. Now that the effect is confirmed visible,
   there is room to push both — bounded by over-softening, which the same A/B
   will show.
2. **Temporal reprojection.** The complete answer rather than a reconstruction
   from one frame. Considerably more work, and it now has to beat something
   that already works.

And a caveat that still stands: `tools/moving-aa.test.js` measures a JS port of
the filter, not the WGSL. The string assertions pin the shader; the numeric part
does not. If you change the WGSL, change the port with it or the numbers will
quietly describe code that is no longer running.
