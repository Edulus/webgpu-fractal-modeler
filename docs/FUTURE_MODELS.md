# Future Mathematical Models

This document is the model roadmap for **WebGPU Fractal Modeler**. It focuses on mathematically substantial objects that create genuinely interesting three-dimensional exploration.

The catalog deliberately excludes elementary solids such as cubes, spheres, cones, cylinders, ordinary tori, prisms, and simple extrusions. A future model should have a recognizable mathematical identity, reveal meaningful structure from multiple viewpoints, and justify its computational cost.

## What counts as a model

The project uses “volumetric mathematical object” broadly. A model may be:

- a solid or distance field;
- an implicit or algebraic surface;
- a chaotic trajectory or flow field;
- a recursive fractal construction;
- a three-dimensional slice or projection of a higher-dimensional object;
- a topological structure such as a knot, fibration, or non-orientable surface;
- an isosurface derived from an eigenfunction, probability field, or dynamical system.

Lorenz and Aizawa attractors are curves rather than solids, but they remain fully explorable mathematical structures in 3D and belong in the catalog.

## Current baseline

The renderer already includes:

Listed in menu order, matching `FRACTAL_IDS` in `src/fractal-bg.js`:

- Mandelbulb
- Mandelbox
- Menger sponge
- Quaternion Julia set
- Apollonian sphere packing
- Nested sphere packing
- Ornate planet with a polar bloom
- Studded surface packing
- Penrose quasicrystal relief
- Aizawa attractor
- Lorenz attractor

All eleven are reachable from the demo's model selector. The first nine are
distance-estimated surfaces sharing the raymarch pass; the two attractors are
line geometry drawn by a second pipeline.

## Selection criteria

A strong candidate should satisfy most of these conditions:

1. **Mathematical depth** — the form follows a real equation, construction, topology, or dynamical system.
2. **Three-dimensional interest** — orbiting, zooming, slicing, or entering the structure reveals new information.
3. **Visual identity** — it does not look like a generic distorted sphere, tube, or noise field.
4. **Parameter value** — changing meaningful parameters produces related mathematical forms.
5. **Renderer fit** — it has a plausible implementation through distance estimation, implicit raymarching, line geometry, instancing, slicing, or precomputed fields.
6. **Scalability** — complexity can be reduced without destroying the mathematical idea.

## Recommended next models

These offer the best balance of visual distinction, mathematical legitimacy, implementation variety, and WebGPU feasibility.

The ordering below applies three tie-breakers, in this order:

1. **Capability before variety.** A model that unlocks a new kind of exploration outranks one that adds another shape to orbit. Every model shipped so far is an object viewed from outside; the first interior structure is worth more than a fourth attractor.
2. **Reuse of proven machinery.** Candidates whose mathematics already has a working relative in `fractal.wgsl.js` carry far less risk than their raw complexity suggests.
3. **Shared infrastructure first.** Where several candidates need the same new renderer path, the cheapest one goes first so the path is built once.

| Priority | Model | Family | Why it belongs | Likely rendering route | Cost |
| --- | --- | --- | --- | --- | --- |
| 1 | **Gyroid** | Triply periodic minimal surface | A continuous labyrinth with no straight lines or mirror planes. Six trig operations, and the first model in the catalog with a navigable interior | Analytic implicit field, Lipschitz-normalised | Low |
| 2 | **Schwarz D surface** | Triply periodic minimal surface | A highly connected diamond-like maze with strong volumetric presence; near-free once the gyroid evaluator exists | Same implicit path as the gyroid | Low |
| 3 | **Kleinian group limit set** | Fractal geometry | Inversion-generated tunnels and recursive cavities, among the richest explorable forms available. The fold-and-sphere-inversion machinery is already proven here by three shipped estimators | Sphere inversions and distance estimation | Medium |
| 4 | **Rössler attractor** | Chaotic system | An iconic folded spiral that contrasts clearly with Lorenz and Aizawa | Existing trajectory pipeline, unchanged | Low |
| 5 | **Thomas attractor** | Chaotic system | Cyclic symmetry produces an unusually balanced, woven trajectory — the most visually distinct of the attractor candidates | Existing trajectory pipeline, unchanged | Low |
| 6 | **Sierpiński tetrahedron / octahedral IFS** | Recursive solid | A tetrahedral symmetry group genuinely unlike the cube-based Menger sponge, for roughly ten lines of fold-and-scale | Fold-and-scale distance estimator | Low |
| 7 | **Barth sextic** | Algebraic surface | Icosahedral symmetry and a large singular set make it immediately recognizable | Bounded polynomial implicit, Lipschitz-normalised | Medium |
| 8 | **Kummer quartic** | Algebraic surface | Sixteen singular points, the maximum for a quartic; reuses the Barth path | Same implicit path as the Barth sextic | Medium |
| 9 | **Ammann rhombohedral / icosahedral quasicrystal** | 6D cut-and-project structure | The mathematically appropriate 3D relative of the Penrose relief, and the construction that retires the "extruded 2D pattern" objection | de Bruijn cut-and-project lifted 6D→3D, generalising `dePenrose` | Medium–high |
| 10 | **Hopf fibration** | Topology / 4D geometry | Interlocking circles filling space by a deep geometric construction | Instanced or indexed line geometry — needs a new pipeline | Medium |
| 11 | **Quaternion Mandelbrot set** | Hypercomplex fractal | Complements the existing Quaternion Julia set with the connected parameter-space family | Distance estimation or sliced membership field | High |
| 12 | **ABC flow** | Dynamical flow | A true 3D incompressible flow with chaotic streamlines, islands, and transport barriers | Compute-integrated streamline families | Medium–high |

**Clifford torus stereographic projection** remains a good candidate but is grouped with the Hopf fibration: both wait on the same line-geometry pipeline work, and neither should precede it.

## Renderer prerequisites

Three pieces of infrastructure gate large parts of the catalog. Each is worth building deliberately once rather than improvised per model.

### Interior navigation

Every model shipped so far is a bounded object orbited from outside, and the camera reflects that: `CAM_RADIUS` is a per-model orbit distance about the origin. Triply periodic surfaces, Kleinian limit sets, and hyperbolic honeycombs are interiors — their whole value is being inside them, where an orbit radius is meaningless.

This needs a fly-through camera mode: free position, look direction decoupled from the origin, and near-plane behaviour that tolerates being arbitrarily close to a surface. It is the single largest unlock in this document, and priorities 1–3 all depend on it.

### Lipschitz normalisation for implicit fields

An implicit field `f(p) = 0` is not a distance field. Sphere tracing on a raw `f` overshoots wherever the gradient exceeds one, which punches holes through thin structure. Both the minimal surfaces and the algebraic surfaces need `f / |∇f|` — or a conservative fixed divisor — plus a step-size safety factor.

The Penrose relief already carries a hand-derived version of this (its returned distance is scaled to cover the relief's slope), so the concept is established in the codebase; what is missing is a reusable helper rather than a per-model constant.

### Line and instanced geometry

The attractor pipeline draws a single non-indexed line strip from one vertex buffer. The Hopf fibration, Clifford torus, polytope projections, and knot families all need many separate curves, which means instancing or indexed draws. This is genuine pipeline work and should not be attempted as a variation on the attractor path.

## Chaotic attractors and dynamical systems

These are efficient additions because they can share the existing attractor pipeline while contributing very different geometry.

| Candidate | Distinctive character | Notes |
| --- | --- | --- |
| **Rössler attractor** | Folded spiral sheet | First attractor to add |
| **Thomas cyclically symmetric attractor** | Threefold woven symmetry | Visually unlike Lorenz |
| **Halvorsen attractor** | Three-wing rotational structure | Dense and sculptural |
| **Dadras attractor** | Paired wings with strong internal folding | Good intermediate complexity |
| **Rabinovich–Fabrikant attractor** | Multiple lobes and sensitive parameter regimes | Needs careful stable presets |
| **Chua double-scroll attractor** | Two scrolls joined through a central transition | Historically important and visually clear |
| **Chen attractor** | Dense double-wing structure | Useful comparison with Lorenz |
| **Lü attractor** | Transitional geometry between Lorenz and Chen families | Best presented as part of a comparison mode |
| **Four-wing attractor** | Four-lobed chaotic structure | Strong silhouette |
| **Sprott attractor collection** | Compact catalog of minimal chaotic systems | Better as a parameterized family than many separate menu items |

### Flow-field models

- **ABC flow** — chaotic streamlines in a periodic incompressible velocity field.
- **Beltrami flow** — velocity aligned with vorticity, suitable for vortex-line visualization.
- **Taylor–Green vortex** — symmetric 3D vortex field with evolving structures.
- **Vortex-knot fields** — trefoil and linked vortex tubes derived from fluid equations.
- **Magnetic field-line systems** — dipole combinations, null points, separatrices, and braided fields.

## Triply periodic minimal surfaces and labyrinths

These are especially well suited to raymarching because they are analytic implicit fields, naturally volumetric, and scalable across devices.

| Candidate | Character |
| --- | --- |
| **Gyroid** | Smooth chiral labyrinth with two interpenetrating regions |
| **Schwarz P surface** | Periodic chambers connected through rounded openings |
| **Schwarz D surface** | Diamond-network labyrinth |
| **Neovius surface** | Deep cavities and narrow connecting necks |
| **I-WP surface** | Mixed chamber sizes and branching passages |
| **Fischer–Koch S surface** | Strongly twisted periodic channels |
| **Schoen G family** | Gyroid-related parameter variations |
| **Lidinoid** | Dense curved network with striking periodic symmetry |
| **Split-P surface** | More complex partitioning than Schwarz P |

These should support clipping planes, sectional views, wall thickness, and an interior-navigation mode.

## Algebraic and implicit surfaces

These objects are defined by polynomial or transcendental equations. They can be rendered as zero sets, thickened shells, or bounded solid regions.

| Candidate | Mathematical interest |
| --- | --- |
| **Kummer quartic** | Sixteen singular points, the maximum possible for a quartic surface |
| **Barth sextic** | Icosahedral symmetry and a large singular set |
| **Cayley cubic** | Four conical singularities and tetrahedral organization |
| **Clebsch diagonal cubic** | Twenty-seven real lines on a cubic surface |
| **Chmutov surface family** | High numbers of singular points generated through Chebyshev polynomials |
| **Roman surface** | Immersed projective plane with self-intersections |
| **Boy’s surface** | Smooth immersion of the real projective plane |
| **Steiner surface family** | Projective surfaces with characteristic singular loci |
| **Enneper surface** | Self-intersecting minimal surface with strong rotational structure |
| **Costa surface** | Genus-one minimal surface with three ends |
| **Helicoid–catenoid associate family** | Continuous deformation between two classical minimal surfaces |
| **Dini surface** | Twisted pseudospherical surface with constant negative curvature |

## Hypercomplex and iterative fractals

| Candidate | Description | Route |
| --- | --- | --- |
| **Quaternion Mandelbrot set** | Parameter-space companion to Quaternion Julia | Distance estimate or slices |
| **Quaternion Newton fractal** | Basins of attraction for roots under quaternion iteration | Iteration field and isosurfaces |
| **Bicomplex Julia slices** | 3D slices through a four-real-dimensional dynamical system | Slice renderer |
| **Tricomplex fractal slices** | Selected 3D sections of higher hypercomplex sets | Research |
| **Kleinian group limit sets** | Recursive inversion geometry from Möbius transformations | Distance estimator |
| **Quaternion Kleinian fractals** | Higher-dimensional inversion dynamics projected into 3D | Research |
| **3D Newton basins** | Volumetric boundaries between polynomial root basins | Voxel or implicit field |
| **Octahedral and tetrahedral IFS fractals** | Recursive solids governed by symmetry groups | Fold-and-scale distance estimator |
| **Jerusalem cube** | Recursive cube fractal with cross-shaped void hierarchy | Distance estimator |
| **Sierpiński tetrahedron variants** | Recursive tetrahedral void structures | Distance estimator or instancing |

A model should only be added when it has a clear visual and mathematical distinction from the Mandelbulb, Mandelbox, and Menger sponge already present.

## Higher-dimensional projections and slices

| Candidate | What the viewer would reveal |
| --- | --- |
| **Hopf fibration** | Families of linked circles generated from the 3-sphere |
| **Clifford torus projection** | A flat torus in four dimensions viewed through stereographic projection |
| **Tesseract projection** | Rotating cells, edges, and 3D cross-sections of a 4-cube |
| **24-cell projection** | A uniquely four-dimensional regular polytope with octahedral cells |
| **120-cell projection** | A vast dodecahedral 4-polytope with rich nested structure |
| **600-cell projection** | Dense tetrahedral symmetry and exceptional rotational behavior |
| **4D Julia slices** | Animated movement through a higher-dimensional fractal field |
| **Calabi–Yau quintic slice** | A carefully defined slice or projection of a complex algebraic manifold |
| **4D rotation laboratory** | Apply independent double rotations before projecting selected objects into 3D |

Higher-dimensional models should expose projection method, slice coordinate, and 4D rotation planes rather than presenting a fixed decorative mesh.

## Topological objects, knots, and links

| Candidate | Mathematical value |
| --- | --- |
| **Trefoil and figure-eight knot fields** | Canonical knots with contrasting topology |
| **Torus-knot family** | Parameterized `(p, q)` knots rather than one fixed tube |
| **Lissajous knots** | Knots generated by orthogonal harmonic motion |
| **Borromean rings** | Three components linked collectively while every pair is unlinked |
| **Hopf link families** | Foundational linked-circle structures |
| **Seifert surfaces** | Surfaces spanning knots, revealing genus and orientation |
| **Minimal knot surfaces** | Energy-minimized or minimal-like spanning surfaces |
| **Knot complement cusp geometry** | Hyperbolic structure surrounding selected knots | Research |
| **Braided torus and vortex knots** | Animated topology with meaningful strand parameters |

Simple tubes alone are insufficient. Knot models should expose invariants, spanning surfaces, linking behavior, or field structure.

## Quasicrystals, tessellations, and cellular structures

| Candidate | Description |
| --- | --- |
| **Icosahedral quasicrystal** | 3D cut-and-project set derived from a six-dimensional lattice |
| **Ammann rhombohedral tiling** | Quasiperiodic filling by prolate and oblate golden rhombohedra |
| **3D Penrose tiling** | Genuine quasiperiodic rhombohedral structure rather than an extruded 2D pattern |
| **Hyperbolic honeycombs** | Regular cells filling hyperbolic 3-space, viewed in a Poincaré ball |
| **Weaire–Phelan foam** | Low-area equal-volume cellular partition |
| **Kelvin foam** | Truncated-octahedral foam structure |
| **Weighted Voronoi / Laguerre foam** | Parameterized cellular volumes with controllable seeds and weights |
| **Aperiodic monotile-derived structures** | Three-dimensional interpretations only when a rigorous construction is available |

The failed Penrose Sponge experiment establishes an important rule: a 2D pattern extruded through a sphere does not become a convincing 3D quasicrystal. Future quasicrystal work should begin from a genuine 3D construction.

That rule applies to the shipped Penrose relief as well. It is an honest P3 tiling — de Bruijn pentagrid, two levels of φ² inflation, phason drift — but it is a 2D tiling engraved on a disc, which is exactly the pattern the "models to avoid" list warns about. It earns its place as a correct implementation of the 2D construction and as working cut-and-project machinery, not as a 3D quasicrystal.

The successor is a direct generalisation rather than open research. The relief's query inverts the de Bruijn map from a 5D lattice projected to 2D; an icosahedral quasicrystal is the same construction from a 6D lattice projected to 3D, using the six icosahedral star vectors. The structure of the code carries over, including the candidate-bracketing that makes the inverse map exact. The cost does grow substantially — tiles are dual to *triples* of grid hyperplanes rather than pairs, so the search goes from 10 pairs × 2 candidates to 20 triples × 8, and each candidate does more work. Treat it as expensive and well-understood, not speculative.

## Eigenfunctions, wave fields, and probability volumes

| Candidate | Visual model |
| --- | --- |
| **Hydrogen atomic orbitals** | Probability-density isosurfaces with phase coloring |
| **Spherical harmonics** | Signed radial fields and nodal surfaces |
| **3D Laplacian eigenmodes** | Nodal volumes inside bounded domains |
| **Chladni-type nodal surfaces** | Three-dimensional standing-wave zero sets |
| **Wave-interference volumes** | Parameterized nodal networks from multiple sources |
| **Quantum harmonic-oscillator states** | Cartesian and spherical eigenfunction families |
| **Phase-vortex fields** | Lines and surfaces where complex phase becomes singular |
| **Reaction–diffusion isosurfaces** | Evolving 3D Gray–Scott or related fields | High cost |

These should display both amplitude and sign/phase where mathematically relevant.

## Models to avoid

The catalog should resist visually attractive ideas that lack enough mathematical or three-dimensional substance:

- elementary solids presented as standalone models;
- ordinary spheres or tori with decorative noise;
- 2D patterns merely engraved on, wrapped around, or extruded through a primitive;
- arbitrary metaball clusters without a defined mathematical system;
- generic procedural caves;
- cosmetic variants of existing fractals with only palette or exponent changes;
- thickened curves that reveal no topology, dynamics, or field structure;
- “Calabi–Yau-style” or “quantum-style” objects without a precise construction.

## Suggested implementation sequence

### Phase 0 — Establish a performance baseline

Measure real frame rates for the existing eleven models across a low-end integrated GPU, a mid-range discrete GPU, and a phone. The Penrose relief in particular is the heaviest estimator in the set and has never been profiled on hardware.

Everything below adds cost. Without a baseline there is no way to tell whether a new model is slow or the renderer already was, and no basis for deciding when to optimise instead of adding.

### Phase 1 — Interior navigation and implicit labyrinths

1. Fly-through camera mode (see *Renderer prerequisites*)
2. Lipschitz-normalised implicit-field helper
3. Gyroid
4. Schwarz D
5. Neovius

This phase carries the largest single gain in the document: the first models the viewer can move through rather than around. The two infrastructure items come first because the surfaces are nearly trivial once they exist.

### Phase 2 — Extend the existing trajectory pipeline

1. Rössler attractor
2. Thomas attractor
3. Halvorsen attractor

These reuse the trajectory renderer unchanged and establish a family-selection architecture. Low risk and quick, but they add variety rather than capability — worth slotting in around heavier work rather than blocking on.

### Phase 3 — Inversion geometry and recursive solids

1. Kleinian group limit set
2. Sierpiński tetrahedron and octahedral IFS variants

The Kleinian estimator is the strongest visual payoff on the roadmap and reuses inversion machinery already proven by the Apollonian, nested-pack, and ornate-planet estimators. It also benefits directly from the Phase 1 camera work.

### Phase 4 — Algebraic surfaces

1. Barth sextic
2. Kummer quartic
3. Cayley cubic

These reuse the Phase 1 implicit path and add polynomial evaluation, bounded raymarching, singularity handling, and equation-aware presets.

### Phase 5 — Line-geometry pipeline and higher-dimensional structures

1. Instanced or indexed line-geometry pipeline (see *Renderer prerequisites*)
2. Hopf fibration
3. Clifford torus stereographic projection
4. 24-cell projection

These establish 4D rotation, projection, and generated-geometry controls on top of the new pipeline.

### Phase 6 — Research-grade models

1. Icosahedral quasicrystal / Ammann rhombohedral tiling
2. Quaternion Mandelbrot set
3. Hyperbolic honeycomb

These should be prototyped separately and admitted to the main model list only after they are visually convincing, mathematically faithful, and scalable across devices. The quasicrystal is the best understood of the three, being a dimensional lift of code already in the repository.

## Candidate evaluation record

Before implementation, each proposed model should receive a short design note containing:

- defining equation or construction;
- dimensionality and what is actually being displayed;
- rendering method;
- expected GPU cost;
- low-, medium-, and high-quality versions;
- meaningful user parameters;
- visual reference target;
- mathematical validation method;
- reason it adds something distinct to the existing catalog.

Two of these deserve more weight than the rest, because both have already caused problems in this repository.

**Mathematical validation should be settled before any shader is written.** The Penrose relief was validated by implementing the construction on CPU first and rendering it to an image, which surfaced a candidate-search flaw leaving 3.2% of the plane untiled — invisible in a description, obvious in a picture. Prototype the mathematics in whatever language is convenient, look at the output, and only then port.

**Measured cost should replace expected cost.** Record a real frame rate on at least one low-end device against the Phase 0 baseline. An estimate written during design is not evidence, and a model whose cost is still unmeasured should not be described as shipped.
