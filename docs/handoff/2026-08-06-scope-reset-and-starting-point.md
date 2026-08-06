# Handoff — KIMI: scope reset + mathematical starting point

**Date:** 2026-08-06
**Author:** KIMI
**Branch:** `feature/apollonian-bubble-shell` (from `main` @ 24b0458)

## Scope reset (accepted)

* `benchmark/sphere-union-cost` is **archived research**, preserved at tag `archive/sphere-union-cost`. **Not for merge.** Its lasting contributions: the binding-2/probe-pipeline analysis, the renderer-route comparison, and the benchmark harness — all available if an explicit-geometry model is ever revisited.
* The Apollonian bubble-shell target continues as the **next model**, implemented through the modeler's established shader-native system: one DE, `DEResult`, `mapDE()` dispatch, existing raymarch/shading/camera/menu conventions. No CPU geometry, no storage buffers, no new pipelines, no new UI parameters.

## Target evidence

`docs/reference/` now carries two ScreenDream (Thomas Helzle) references — `Bubbles.jpg` (iridescent soap film) and `SpherePack.jpg` (chrome). Same geometry, two materials. The decisive structural reads, especially from the chrome version:

* bubbles **kiss with thin dark seams** (near-tangent, not overlapping);
* a **continuous size cascade**: a handful of large bubbles, rings of medium ones, fine granular froth in the interstices;
* **full-shell coverage** with a bumpy silhouette; a dark body shows through the interstices.

## Mathematical starting point (stated before implementation, per protocol)

**`deSpherePack`'s fold-and-inversion field with a sphere primitive, confined to a thin full-surface shell à la `deEncrusted`.**

Why this combination:

1. **Hierarchy for free.** The periodic fold + sphere inversion (`k = s/r²`) iterated 8–9 times generates a self-similar family of spheres spanning many octaves of scale — the continuous size cascade the reference shows. `deSurfacePack`'s hash cells cannot produce this (three discrete sizes, grid placement → rejected look).
2. **Tangency is native.** Inversion-generated packings descend from tangent-sphere geometry, so contacts read as kisses rather than the grid overlaps of `deSurfacePack`. The seams between caps are exactly where the "thin dark seams" of the chrome reference live.
3. **The lobe problem is a *primitive* problem, not a machinery problem.** `deApollonian`'s broad smooth lobes come from its *plane* primitive (`abs(p.y)`); `deSpherePack` already proved that swapping in a *sphere* primitive (`length(p) − c`) resolves discrete nested spheres with the same machinery.
4. **Shell confinement is proven in-repo.** `deEncrusted` already intersects an inversion packing with a thin shell around a host sphere. The bubble shell is that construction driven to its logical end: full-surface coverage (no growth cap), a solid core so interstices read as body rather than void.
5. **Mathematical honesty note for the reviewer.** Slicing an inversion-generated 3D packing with a sphere yields a spherical circle/sphere packing that is the stereographic image of an Apollonian-type gasket — this is closer to the reference's true construction than any grid or hash method, while staying an *implicit approximation*, not a literal Descartes configuration. I am not claiming a genuine Soddy–Gosset packing; Edward's target doc requires the *look* (discrete bubbles, hierarchy, near-tangent seams, shell composition), and the archived CPU-generator route remains the fallback if literal tangency is later demanded.

## Validation method

Per the repo's own rule ("mathematical validation should be settled before any shader is written"; Penrose precedent), the estimator is being rendered on CPU first (`tools/preview-bubbleshell.py`, numpy raymarch) and tuned against the two references before the WGSL port. Preview renders will be attached to the next handoff for ChatGPT/Edward to judge alongside the diff.

## Implementation surface (planned, minimal)

* `fractal.wgsl.js`: `deBubbleShell()` + dispatch branch at id 11; attractor gate 10.5 → 11.5; header comment.
* `fractal-bg.js`: `FRACTAL_IDS` (+`bubbleshell: 11`, attractors 12/13), `CAM_RADIUS` insert, probe gate → `bubbleshell`.
* `index.html`: one `<option>` (after Kleinian, before attractors), HUD names array.
* README model list: one line.
* No uniform struct changes; no existing estimator touched.
