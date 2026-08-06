# Handoff — KIMI: Apollonian bubble shell prototype (shader-native)

**Date:** 2026-08-06
**Author:** KIMI
**Branch:** `feature/apollonian-bubble-shell`
**Status:** Prototype complete, CPU-validated, awaiting ChatGPT diff review and Edward's visual/hardware test. **WGSL not yet GPU-compiled** (no WebGPU device on KIMI's machine) — `tools/shader-check.html` remains the first gate.

## Deliverable

One new menu model, **Apollonian bubble shell** (`bubbleshell`, fractal id 11; attractors shift to 12/13), added through the established system only: one shader-native DE, `DEResult`, `mapDE()` dispatch, existing raymarch/shading/camera/menu. No uniform changes, no buffers, no pipelines, no new UI parameters, no existing model touched.

## What the estimator is

**Octave rejection packing** — the final form after three CPU-evidenced rejections (see *Evidence*):

1. Six cellular octaves, cell size cascading 0.34 × 0.55ⁿ.
2. Each octave's lattice is rotated by a distinct fixed rotation (precomputed matrices), so no two octaves share an axis — this kills the grid look.
3. Radii = `cell × min(0.36 + 0.13·hash, 0.49)` — capped at the **kiss limit**, so bubbles touch rather than overlap.
4. **Gap-filling cull:** an octave's sphere is dropped when any coarser octave's sphere already covers its centre — small bubbles grow only in gaps between big ones. This is the Apollonian gap-filling rule in procedural form, and the source of the size cascade and the dark seams (culled → solid core shows through).
5. Cell centres are **projected onto the shell mid-surface** (R = 1.0): every bubble sits on the surface as a proud dome of its full radius. (Unprojected 3D-grid centres drift below the surface and read as flat sliced lenses — visible in evidence image 2.)
6. Asymmetric shell clip: outer bound R+0.20 keeps domes round; inner bound R−0.03 anchors them.

**SDF safety:** every primitive is an exact sphere SDF; intersection (shell clip) and union of exact SDFs are exact. Sphere tracing is unconditionally safe; no Lipschitz analysis needed (unlike the gyroid/Penrose routes).

**Cost:** 6 octaves + 15 coverage probes = 21 sphere evaluations + 18 trig (precomputed rotations) per DE call. Same order as `deSurfacePack`'s seam query; far below Penrose. No static-bound deviation: all loops bound by `BS_LEVELS = 6`.

## Judged against Edward's target doc

| Criterion | Result |
|---|---|
| Discrete bubbles | ✓ clearly separate domes |
| Recursive size hierarchy | ✓ six octaves, continuous-feeling cascade |
| Near-tangent contacts | ✓ kiss-capped radii + gap seams |
| Spherical-shell composition | ✓ shell only, bumpy silhouette |
| Reject: overlapping grid spheres | avoided — rotated lattices + kiss cap |
| Reject: smooth lobes | avoided — no inversion field in final form |
| Reject: volume-filling ball | avoided — shell clip + core only |

## Evidence (CPU renders, `docs/handoff/previews/`)

Per the repo's validate-on-CPU-first rule, the route was chosen on renders, not on prose:

1. **`v1-rejected-inversion-route.png`** — the fold+inversion route proposed in the starting-point note: hemisphere caps without field scaling, lattice artifacts with it, noise with rotation, froth with small primitives. **Rejected on this evidence** — my own starting-point choice did not survive measurement, and the handoff trail shows why.
2. **`v2-unprojected-flat-caps.png`** — octave rejection packing before centre projection: right structure, but bubbles slice flat.
3. **`v3-final-candidate-a.png`** (cell 0.34, ratio 0.55) — **shipped constants.**
4. **`v3-final-candidate-b.png`** (cell 0.36, ratio 0.58) — near-identical alternative, kept for comparison.

The preview tool is committed as `tools/preview-bubbleshell.py` (`python tools/preview-bubbleshell.py out.png [variant]`) — the Python DE mirrors the WGSL line for line, including rotation order (Rz→Rx→Ry, verified against the precomputed matrices).

## Architectural honesty for the reviewer

This is a **procedural Apollonian-style packing, not a literal Descartes/Soddy configuration** — the same implicit-approximation standing as the modeler's other packing models, and a deliberate consequence of Edward's scope reset (shader-native only). The gap-filling cull is a one-sided test (only the sphere *centre* is checked against coarser octaves), so a large fine-octave sphere can still clip a coarse one's boundary at grazing incidence — visible occasionally as a slightly intersecting pair. If Edward's eye rejects that, the fix is a conservative radius margin in the cull, one line. The archived `archive/sphere-union-cost` route remains the fallback if literal tangency is ever demanded.

## Files changed

| File | Change |
|---|---|
| `src/shaders/fractal.wgsl.js` | `deBubbleShell()` + `bsLevelSphere()` + constants, dispatch at id 11, attractor gate 10.5→11.5, header comment |
| `src/fractal-bg.js` | `FRACTAL_IDS` (+bubbleshell 11, attractors 12/13), `CAM_RADIUS` insert (3.1), probe gate → bubbleshell |
| `index.html` | menu option after Kleinian, HUD names array |
| `README.md` | model list + implementation blurb |
| `docs/FUTURE_MODELS.md` | baseline count 13→14 |
| `tools/preview-bubbleshell.py` | CPU validation tool |
| `docs/handoff/` | this note + preview evidence |

## For Edward

1. `python -m http.server 8000` → first open `http://localhost:8000/tools/shader-check.html` (all modules OK?), then `http://localhost:8000/` → model **Apollonian bubble shell**.
2. Judge against `docs/reference/Bubbles.jpg` and `SpherePack.jpg` — structure first; palette/shading tuning (iridescence, seams) is the phase after acceptance.
3. Pixel 6 when the structure is accepted. The DE is ~21 sphere evals — expected to be mid-weight for this catalog, but the repo rule applies: measured, not estimated.

## Constants are hard-coded per the brief; visual tuning controls come later.
