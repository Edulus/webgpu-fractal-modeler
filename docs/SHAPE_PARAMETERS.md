# Shape Parameterization

## Purpose

The Shape maths feature is intended to make each model explorable through its own **real mathematical parameters**.

A slider belongs here only when it changes the mathematical object being drawn. It must not be a generic deformation applied after the fact, a rendering-quality control, or an estimator safety constant presented as if it were geometry.

This document records:

- the current parameterized shapes;
- the remaining models and the genuine variables already present in their implementations;
- which proposed controls look straightforward and which require coupled calculations or measurement;
- cases where the named mathematical object should remain rigid rather than acquire misleading sliders;
- implementation rules and a recommended rollout order.

This is a feature roadmap, not permission to expose every constant listed below. Every range still needs to be measured or derived before shipping.

---

## Design rule

The current registry in `src/shape-params.js` establishes the rule:

> A shape is not parameterized until its constants have been measured.

An earlier generic approach applied twist/stretch/warp deformations to coordinates before the estimator. That changed a shape from the outside rather than exposing a parameter of the shape itself, and it required hand-tuned distance divisors to keep sphere tracing from failing.

The correct model is therefore:

1. Find a genuine parameter of the construction.
2. Determine whether changing it affects distance estimation, extent, topology, cost, or another parameter.
3. Measure or derive a safe range.
4. Encode those relationships in the registry.
5. Make the estimator enforce any safety-critical relation as well as the UI.
6. Only then expose the slider.

A shape with no proven-safe parameters should continue to have no Shape maths section.

---

## Current state

The selector currently exposes **31 shapes**. Four have Shape maths controls today.

### Already parameterized

| Shape | Current sliders | Count |
|---|---|---:|
| Mandelbulb | Power; Bailout; Polar ratio; Azimuth ratio | 4 |
| Mandelbox | Scale; Min radius; Fixed radius | 3 |
| Menger sponge | Recursion depth | 1 |
| Quaternion Julia | c · real; c · i; c · j; c · k | 4 |

There are currently **12 shape-specific sliders across 4 of 31 shapes**.

### Existing constraint machinery

`src/shape-params.js` already distinguishes these cases:

- `free` — the value can move without another estimator quantity changing.
- `derived` — another quantity must be recomputed from the parameter.
- `relational` — validity depends on another parameter.
- `extent` — the model's bounding radius changes.
- `cost` — the parameter materially changes rendering cost.

The Mandelbox radius relationship and Mandelbulb generalized-angle gate are important precedents: a safety relation is enforced both in JS and in the shader, so another writer cannot bypass the UI clamp and feed the estimator an invalid pair.

The active shape currently has **8 float parameter slots** (`shapeParams`, two `vec4`s). Eight is a ceiling, not a target.

---

# Inventory of unparameterized shapes

## 1. Apollonian sphere packing

### Genuine variables already present

- **Packing tightness / inversion scale** `s`
  - Current centre: `1.25`
  - Currently animated by `±0.11`.
- **Recursion depth**
  - Current `AP_ITERS = 8`.
- **Bounding radius**
  - Current `BOUND = 1.3`.

### Recommended sliders

1. **Packing tightness** — strongest candidate.
2. **Recursion depth** — genuine mathematical depth, but also a cost parameter.

### Notes

Packing tightness already changes autonomously. Once it becomes a slider, the slider should own the value and the old animation should be removed, following the Mandelbulb and Julia precedent.

The bounding radius is primarily presentation/clipping and should not automatically become a Shape maths control.

**Priority: high.**

---

## 2. Sphere pack — nested spheres

### Genuine variables already present

- **Packing tightness / inversion scale** `s`
  - Current centre: `1.28`
  - Currently animated by `±0.05`.
- **Recursion depth**
  - Current `SP_ITERS = 9`.
- Base sphere term in the packing distance.

### Recommended sliders

1. **Packing tightness**.
2. **Recursion depth**.
3. Possibly **base sphere radius**, if measurement shows it creates a useful family without invalidating the pulled-back distance estimate.

**Priority: high.**

---

## 3. Ornate planet / polar bloom (`encrusted`)

### Genuine variables already present

- **Host sphere radius** `R = 0.95`.
- **Packing tightness** `s = 1.24 ± 0.04` animation.
- **Packing recursion depth** `EN_ITERS = 8`.
- Crust shell limits: approximately `R - 0.03` through `R + 0.38`.
- **Crust coverage** — the cap mask uses a `0.7` directional cutoff.
- Boundary perturbation strength from the orbit trap.

### Recommended sliders

1. **Packing tightness**.
2. **Crust coverage** — directly controls how much of the planet is encrusted.
3. **Crust thickness**.
4. **Recursion depth**.

The coverage control should be preferred over exposing the arbitrary cap direction itself.

**Priority: high.**

---

## 4. Packed spheres / studded body (`surfacepack`)

### Genuine variables already present

- **Host radius** `R = 1.0`.
- **Shell thickness** `SHELL = 0.09`.
- **Packing levels** `SP_LEVELS = 3`.
- **Cell spacing / density**, initially `cellSize = 0.22`.
- **Sphere-size distribution**.
  - Radius currently ranges from about `0.18` to `0.49` of cell size.

### Important known constraint

Sphere radius must remain below half the cell spacing because only the sphere in the nearest repeated cell is evaluated. Larger spheres get sliced at cell boundaries and produce axis-aligned faces. The implementation comments already record `0.49` as the practical cap.

### Recommended sliders

1. **Sphere size**.
2. **Shell thickness**.
3. **Sphere density / cell spacing**.
4. **Packing levels** — cost-sensitive.

**Priority: high.**

---

## 5. Gyroid

### Genuine variables already present

- **Level-set offset**
  - Currently `0.3 * sin(time * 0.08)`.
- **Frequency** `FREQ = 5.5`.
- **Wall half-thickness** `HALF = 0.34`.
- Clipping radius `R = 1.35`.

### Recommended sliders

1. **Level**.
2. **Frequency**.
3. **Wall thickness**.

### Why this is an especially good candidate

The current estimator has an analytic global Lipschitz bound. Its distance divisor is `sqrt(3) * frequency`, so Frequency can be a **derived** parameter rather than a guessed safety factor.

Level already moves through a family where one labyrinth widens while the other narrows, and the implementation notes say the current amplitude remains within the connected regime.

**Priority: highest. Recommended next implementation.**

---

## 6. Kleinian limit set

### Genuine variables already present

- Fold half-cell `CS = (0.92436, 0.90756, 0.92436)`.
- Final cylinder radius `CCONST = 0.92436`.
- **Inversion radius squared** `minRad2`.
  - Currently `0.92 ± 0.015` animation.
- Iteration depth `KL_ITERS = 12`.

### Recommended sliders

1. **Inversion radius** — strongest candidate.
2. Possibly **iteration depth**.

### Caution

The implementation explicitly notes that the structure is sharply sensitive to the chosen constants and quickly degenerates to featureless lobes or granular noise. The safe range may be narrow.

The existing inversion-radius animation already demonstrates a nearby family of Kleinian groups, so this should become a user-owned control once its range is measured.

**Priority: high, measurement-sensitive.**

---

## 7. Barth sextic

### Existing constants

- `PHI2 = phi²`.
- `KB = 1 + 2phi`.
- Clipping radius `R = 2.0`.
- `GFLOOR = 0.6` — numerical guard at nodes.
- `MAXSTEP = 0.22` — estimator safety cap at critical points.

### Recommendation

**Do not expose the existing defining constants as sliders.**

`phi²` and `1 + 2phi` are part of the Barth sextic polynomial. Changing them means the object is no longer the Barth sextic. `GFLOOR` and `MAXSTEP` are estimator safety controls, not geometry, and the clipping radius is not an interesting mathematical family parameter.

A slider here should only be added if we intentionally design and name a generalized algebraic-surface family.

**Priority: leave rigid.**

---

## 8. Kissing Schottky group — parabolic

### Defining variable

The shared Schottky estimator uses a sphere-radius shrink factor `s`.

- `s = 1` is the **kissing/parabolic boundary**: all five generating spheres are tangent.
- `s < 1` separates the spheres and enters the hyperbolic Schottky family.
- `s > 1` makes spheres overlap; the Poincare condition fails and the group ceases to be discrete.

### Recommendation

Leave the named **Kissing Schottky** model fixed at `s = 1`.

Moving the same value below 1 is precisely the existing Hyperbolic Schottky model, so the slider belongs there rather than duplicating that family here.

**Priority: leave rigid.**

---

## 9. Schottky group — hyperbolic

### Genuine variable already present

- **Sphere separation / shrink factor** `s`.
  - Currently `0.925 - 0.045 * sin(time * 0.06)`.
  - Must remain `< 1` for the hyperbolic regime.
  - `1` is the parabolic boundary.

### Recommended slider

1. **Separation** or **Generator scale**.

This is an unusually strong candidate because the topology and mathematical boundary are already documented. The slider should be one-sided and may optionally approach but not cross `1`.

Its existing animation should be removed once the slider owns the value.

**Priority: very high.**

---

## 10. Tetrabrot

### Existing constants

- `TB_ITERS = 64`.
- `BAILOUT = 64` (`|z|²`).
- `X_SHIFT = -0.5`.
- Measured safety divisors `KDE_IN`, `KDE_OUT`.
- Measured extent `BOX`.

### Recommendation

There is no obvious honest Shape maths slider in the current formulation.

Iteration count and bailout are convergence/estimation choices; `X_SHIFT` is placement of the measured interior centre; the KDE values are estimator safety factors; and `BOX` is a measured bound.

A parameter should be introduced only by deliberately defining a broader bicomplex family, not by exposing these implementation constants.

**Priority: leave rigid for now.**

---

## 11. Envelope extrusion — octahedral seed

### Existing defining constants

- Octahedral axes based on `(1,1,1)/sqrt(3)`.
- Canonical threshold `C_OCT = 0.40824829`.

### Recommendation

The obvious constants define the canonical construction. Varying the threshold mostly rescales a homogeneous surface rather than producing a compelling new family.

Do not add a slider until a meaningful generalized envelope construction is deliberately specified.

**Priority: leave rigid for now.**

---

## 12. Envelope extrusion — dodecahedral seed

### Existing defining constants

- Icosahedral axis components `A = 0.85065081`, `B = 0.52573111`.
- Canonical threshold `C_DOD = 1.11351636`.

### Recommendation

The golden-ratio axes are part of the object's identity. As with the octahedral version, simply exposing the threshold is mostly scale, not meaningful exploration.

A future generalized envelope family could add real parameters, but the current named object should remain canonical.

**Priority: leave rigid for now.**

---

# Hyperbolic honeycomb family

The following six selector entries share the same estimator and differ by Coxeter group and Wythoffian form:

- Hyperbolic honeycomb `{5,3,4}`.
- `{5,3,4}`, truncated.
- `{5,3,4}`, omnitruncated.
- Hyperbolic honeycomb `{4,3,5}`.
- `{4,3,5}`, truncated.
- `{4,3,5}`, omnitruncated.

The `{p,q,r}` group and Wythoff mirror selections define each named object and should remain fixed.

## Genuine common parameter

- **Edge / tube thickness**.
  - Regular forms currently use about `0.020`.
  - Truncated forms use about `0.017`.
  - Omnitruncated forms use about `0.012`.

### Recommended slider

1. **Edge thickness**.

### Parameters that should not be presented as geometry

- `HC_ITERS` is the reflection-resolution budget.
- `R_CLIP = 0.85` is a deliberate clip inside the Poincare ball to avoid unresolved accumulation at infinity.

Those are not equivalent to changing the honeycomb itself.

**Priority: medium-high; one implementation can serve all six forms.**

---

## 19. Kleinian sphere packing `{5,3,6}`

### Genuine coupled parameter

- **Horoball radius** `HR = 0.26298370`.
- Horoball centre `HO` is geometrically coupled to that radius.

The current value is the **maximal cusp**: the horoballs touch their neighbours without overlap and remain tangent to the sphere at infinity.

### Recommended slider

1. **Horoball size** — from smaller separated horoballs up to the maximal cusp.

### Constraint

This must be implemented as a **derived/coupled** parameter. Changing `HR` alone while leaving `HO` fixed would destroy the intended boundary tangency. The centre must move consistently with the radius.

**Priority: medium-high, mathematically valuable.**

---

## 20. Engel plesiohedron tiling

### Genuine variable already present

- **Cell erosion / joint gap** `GAP = 0.012`.
- The cell's inscribed radius is documented as about `0.070`.
- `R_CLIP = 1.15` merely bounds the otherwise infinite tiling.

### Recommended slider

1. **Joint gap**.

This is a particularly clean control. With zero or very low erosion the space-filling cells approach a solid block; increasing erosion opens the joints and makes the three-dimensional jigsaw structure visible.

**Priority: high.**

---

## 21. Cosmic Web

Cosmic Web is a bounded volumetric multifractal density field rather than a distance-estimated surface, so it has a different safety profile. It does not have the same sphere-tracing overshoot problem, although performance, opacity, and useful visual ranges still need measurement.

### Strong structural parameters already present

- **Void threshold / matter abundance**
  - Current large-void gate uses approximately `smoothstep(0.36, 0.59, low)`.
- **Major structure scale**
  - Wave-family scales roughly `0.78`, `1.56`, `3.08`.
- **Filament sharpness / thickness**
  - Current values roughly `4.7`, `5.8`, `7.1`.
- **Warp strength**
  - Main low-frequency displacement factor about `0.72` plus a smaller sinusoidal deformation around `0.10`.
- Hierarchy weights for major filaments, branches, threads, and knots.
- Density intermittency exponent.

### Recommended first sliders

1. **Void size / matter density**.
2. **Structure scale**.
3. **Filament thickness**.
4. **Warp strength**.

The initial feature should choose a small, legible subset rather than expose every coefficient.

**Priority: high after the surface-parameter path is mature.**

---

## 22. Ziggurat

### Genuine variables already present

- **Cell spacing** `CELL = 0.13`.
- **Step height** `STEP = 0.055`.
- **Cube half-size fraction** `HALF = 0.45`.
- **Terrace count** `RINGS = 11`.
- Step height currently breathes by about `±12%`.

### Important known constraint

`HALF` must remain below `0.5`; only the nearest repeated cell is evaluated, so larger cubes are sliced at cell boundaries.

### Recommended sliders

1. **Step height**.
2. **Cube size**.
3. **Terrace count**.
4. **Cell spacing**.

The step-height animation should be removed when the user takes control.

**Priority: very high.**

---

## 23. Cube stack / block of cubes

### Genuine variables already present

- **Cell spacing** `CELL = 0.0313`.
- **Cube half-size fraction** `HALF = 0.37`.
- **Half-width in cells** `N = 31` (63 cells across a face).
- **Cells per terrace** `STEPC = 2`.
- **Funnel depth** `DEPTH = 15`.

### Recommended sliders

1. **Cube size**.
2. **Terrace / funnel depth**.
3. **Cells per terrace**.
4. **Cell spacing**.
5. Possibly **overall cell count / extent** after the camera can derive framing from parameterized extent.

### Constraint

As with the ziggurat, `HALF` must stay well below `0.5` because only the nearest repeated cell is evaluated.

This is one of the richest natural control sets in the catalog.

**Priority: very high.**

---

## 24. Icosahedral quasicrystal

### Genuine variables already present

- **Wave number / frequency** `K = 30`.
- **Threshold** `THRESH = 1.55` — solid where the six-wave sum exceeds it.
- Clip radius `CLIP = 1.25`.

### Recommended sliders

1. **Threshold** — changes density/connectivity of the labyrinth.
2. **Wave frequency** — changes the spatial scale of the quasicrystal.

### Analytic safety advantage

The global Lipschitz bound is exact:

`LIP = 2 * phi * K`

Therefore Frequency can be implemented as a **derived** parameter: moving `K` must recompute the divisor rather than leaving the current `97.082039` literal behind.

The golden-ratio star directions must stay fixed; they are what make the pattern aperiodic and icosahedrally symmetric.

**Priority: highest tier.**

---

# Strange attractors

The attractors are generated as CPU-integrated line geometry, not sphere-traced surfaces. Their natural sliders are the coefficients of the differential equations themselves.

Changing coefficients will require rebuilding the trajectory vertex buffer. It will also change trajectory extent, so the current fitted centre and scale cannot remain fixed.

A robust attractor parameter system should therefore:

1. integrate the trajectory with the new coefficients;
2. discard the warm-up interval;
3. measure its bounding box;
4. automatically centre and fit the resulting geometry to the viewer;
5. rebuild/upload the line buffer.

This is the attractor equivalent of deriving camera extent instead of using a stale table.

## 25. Aizawa attractor

Current coefficients:

- `a = 0.95`
- `b = 0.7`
- `c = 0.6`
- `d = 3.5`
- `e = 0.25`
- `f = 0.1`

### Recommended sliders

All six are genuine equation parameters. Six fits within the existing eight-slot conceptual ceiling, although CPU-side plumbing will differ from shader `shapeParams`.

Start with the 2–3 coefficients whose measured neighborhoods produce the most legible changes, then add the remainder if useful.

**Priority: high, after automatic refitting exists.**

---

## 26. Lorenz attractor

Current coefficients:

- `sigma = 10`
- `rho = 28`
- `beta = 8/3`

### Recommended sliders

1. **Sigma**.
2. **Rho**.
3. **Beta**.

These are canonical and meaningful. `rho` is especially interesting because the system's qualitative behaviour changes as it crosses bifurcation regimes, so ranges must be chosen deliberately rather than merely made large.

Automatic trajectory fitting is required.

**Priority: very high once attractor plumbing exists.**

---

## 27. Rössler attractor

Current coefficients:

- `a = 0.2`
- `b = 0.2`
- `c = 5.7`

### Recommended sliders

1. **a**.
2. **b**.
3. **c**.

As with Lorenz and Aizawa, coefficient changes require reintegration and automatic refitting.

**Priority: very high once attractor plumbing exists.**

---

# Summary matrix

| Shape / family | Best first controls | Status |
|---|---|---|
| Mandelbulb | Power, Bailout, Polar ratio, Azimuth ratio | Implemented |
| Mandelbox | Scale, Min radius, Fixed radius | Implemented |
| Menger sponge | Recursion depth | Implemented |
| Quaternion Julia | Quaternion c components | Implemented |
| Apollonian | Packing tightness, depth | Strong candidate |
| Sphere pack | Packing tightness, depth | Strong candidate |
| Encrusted planet | Packing tightness, coverage, crust thickness | Strong candidate |
| Surface pack | Sphere size, shell thickness, density | Strong candidate |
| Gyroid | Level, frequency, wall thickness | Best next candidate |
| Kleinian limit set | Inversion radius | Strong but narrow range |
| Barth sextic | — | Keep canonical |
| Kissing Schottky | — | Keep canonical; boundary of hyperbolic family |
| Hyperbolic Schottky | Separation / shrink factor | Very strong candidate |
| Tetrabrot | — | No honest existing slider yet |
| Envelope octahedral | — | Keep canonical for now |
| Envelope dodecahedral | — | Keep canonical for now |
| 6 hyperbolic honeycombs | Edge/tube thickness | Shared implementation candidate |
| Kleinian sphere packing | Horoball size | Coupled/derived candidate |
| Engel tiling | Joint gap / erosion | Clean single slider |
| Cosmic Web | Void size, scale, filament thickness, warp | Rich volumetric candidate |
| Ziggurat | Step height, cube size, terraces, spacing | Very strong candidate |
| Cube stack | Cube size, depth, terrace spacing, cell spacing | Very strong candidate |
| Icosahedral quasicrystal | Threshold, frequency | Best-tier candidate |
| Aizawa | a, b, c, d, e, f | Needs trajectory refit |
| Lorenz | sigma, rho, beta | Needs trajectory refit |
| Rössler | a, b, c | Needs trajectory refit |

---

# Implementation principles

## 1. Geometry only

Shape maths controls belong to the mathematical object.

Do not put these in the shape registry:

- raymarch step budgets;
- adaptive quality rung values;
- shadow/AO budgets;
- safety divisors that only compensate for an estimator;
- camera FOV;
- arbitrary generic twist/stretch/warp controls;
- palette or image-processing values.

If a safety divisor must change because geometry changes, it is a **derived quantity**, not a second user slider.

## 2. User control and autonomous animation cannot own the same value

Several unparameterized shapes currently animate genuine mathematical values for visual liveliness.

When such a value becomes a slider:

- remove the autonomous animation;
- use the old reduced-motion/static pose as the default when appropriate;
- let the slider be the sole owner of the value.

This follows the precedent already established for Mandelbulb Power and Quaternion Julia `c`.

Candidates affected include at least:

- Apollonian packing tightness;
- Sphere Pack packing tightness;
- Encrusted packing tightness;
- Gyroid level;
- Kleinian inversion radius;
- Hyperbolic Schottky separation;
- Ziggurat step height.

## 3. Safe ranges must be measured or proved

Every shipped range needs one of:

- an analytic proof/bound;
- a numerical sweep against a dense reference;
- a combination of both.

Tests should look for:

- ray overshoot / marching through surfaces;
- collapsed or empty geometry;
- featureless degeneration;
- topology changes that should be excluded from the named family;
- extent changes that break framing;
- unexpectedly large cost increases;
- invalid parameter combinations.

## 4. Derived relationships belong in code

Examples already known:

- Quasicrystal Frequency: `LIP = 2 * phi * K`.
- Gyroid Frequency: divisor scales with `sqrt(3) * FREQ`.
- Kleinian packing Horoball size: centre must move with radius to preserve boundary tangency.
- Mandelbox: Min radius must remain below Fixed radius.
- Mandelbulb generalized angles: ratios lock to 1 below the measured Power threshold.

A slider must never change the geometry while silently leaving its required bound or companion quantity at the old constant.

## 5. Extent should eventually become derived

`CAM_RADIUS` is currently tabled per shape. This is the main reason `constraint.kind = 'extent'` is intentionally blocked from shipping.

Some desirable future parameters naturally change size:

- Cube-stack overall cell count or cell spacing;
- clipping or host radii;
- attractor coefficients;
- some generalized fractal families.

Long term, the renderer should be able to derive or measure the active model's useful framing radius instead of assuming the default shape extent forever.

For the attractors this is essential: coefficient changes should trigger a trajectory bounding-box measurement and automatic fit.

## 6. Cost and geometry are separate dimensions

A genuine mathematical iteration count may be a valid shape parameter even though it changes cost. Mark it as `cost`; do not confuse it with the adaptive governor's own iteration/march budgets.

The existing Menger recursion-depth implementation is the model for this distinction.

## 7. Keep the UI small

The fact that a model contains many constants does not mean all of them should be visible.

Prefer controls that:

- produce visually meaningful differences;
- have understandable labels;
- represent independent mathematical degrees of freedom;
- have defensible ranges;
- do not duplicate another selector entry.

A shape with three excellent parameters is better than one with eight obscure constants.

---

# Recommended rollout

## Phase 1 — easiest high-value surface parameters

1. **Gyroid** — Level, Frequency, Wall thickness.
2. **Icosahedral quasicrystal** — Threshold, Frequency.
3. **Apollonian** — Packing tightness, then depth.
4. **Sphere Pack** — Packing tightness, then depth.
5. **Encrusted** — Packing tightness, coverage, thickness.
6. **Hyperbolic Schottky** — Separation.
7. **Ziggurat** — Step height, cube size, terrace count.
8. **Cube Stack** — Cube size, depth, terrace spacing.
9. **Engel** — Joint gap.

These give a large increase in parameterized coverage while mostly reusing constants already intended to vary.

## Phase 2 — shared/coupled systems

10. **Surface Pack** — size/density/shell constraints.
11. **Six Hyperbolic Honeycombs** — shared edge-thickness control.
12. **Kleinian limit set** — carefully measured inversion-radius band.
13. **Kleinian sphere packing** — coupled horoball radius/centre.
14. **Cosmic Web** — choose a restrained structural subset.

## Phase 3 — attractor parameter system

15. Add CPU-side parameter ownership, trajectory reintegration, automatic bounds, and refitting.
16. **Lorenz** — sigma, rho, beta.
17. **Rössler** — a, b, c.
18. **Aizawa** — begin with the most useful coefficients, expanding up to all six if warranted.

## Phase 4 — intentionally generalized families

Only after the straightforward real parameters are covered should we consider inventing broader families for currently rigid named objects such as:

- Barth sextic;
- Tetrabrot;
- Octahedral envelope extrusion;
- Dodecahedral envelope extrusion.

Those should receive sliders only when we can state exactly what generalized mathematical family the controls traverse.

---

# Feature completion target

The goal is **not** necessarily 31/31 shapes with sliders.

The goal is:

> Every shape that has useful, defensible mathematical degrees of freedom exposes them; every canonical or rigid shape remains mathematically honest.

Success means that moving a Shape maths slider teaches the user something about the construction itself, while the renderer continues to preserve safe distance estimation, valid parameter relationships, stable framing, and the adaptive quality governor's authority over rendering cost.
