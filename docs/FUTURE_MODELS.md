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

| Priority | Model | Family | Why it belongs | Likely rendering route | Cost |
| --- | --- | --- | --- | --- | --- |
| 1 | **Rössler attractor** | Chaotic system | An iconic folded spiral attractor that contrasts clearly with Lorenz and Aizawa | CPU or compute integration, line strip | Low |
| 2 | **Thomas attractor** | Chaotic system | Cyclic symmetry produces an unusually balanced, woven trajectory | CPU or compute integration, line strip | Low |
| 3 | **Gyroid** | Triply periodic minimal surface | A continuous labyrinth with no straight lines or mirror planes; excellent for interior exploration | Analytic implicit field and raymarching | Low–medium |
| 4 | **Schwarz D surface** | Triply periodic minimal surface | A highly connected diamond-like maze with strong volumetric presence | Analytic implicit field and raymarching | Low–medium |
| 5 | **Kummer quartic** | Algebraic surface | A classical quartic with sixteen singular points and a distinctive sculptural form | Polynomial implicit surface | Medium |
| 6 | **Barth sextic** | Algebraic surface | Icosahedral symmetry and many double points create an immediately recognizable object | Polynomial implicit surface | Medium |
| 7 | **Hopf fibration** | Topology / 4D geometry | Interlocking circles fill space according to a deep geometric construction | Instanced curves or generated line geometry | Medium |
| 8 | **Quaternion Mandelbrot set** | Hypercomplex fractal | Complements the existing Quaternion Julia set with the connected parameter-space family | Distance estimation or sliced membership field | High |
| 9 | **Kleinian group limit set** | Fractal geometry | Inversion-generated tunnels and recursive cavities can produce some of the richest explorable forms | Sphere inversions and distance estimation | High |
| 10 | **ABC flow** | Dynamical flow | A true 3D incompressible flow with chaotic streamlines, islands, and transport barriers | Compute-integrated streamline families | Medium–high |
| 11 | **Clifford torus stereographic projection** | 4D projection | A precise higher-dimensional object whose projected geometry changes meaningfully with orientation | Parametric mesh or line families | Medium |
| 12 | **Icosahedral quasicrystal** | 6D cut-and-project structure | The mathematically appropriate 3D relative of Penrose tiling, with genuine quasiperiodic volume | Precomputed point/voxel field, instancing, or implicit approximation | Research |

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

### Phase 1 — Extend existing pipelines

1. Rössler attractor
2. Thomas attractor
3. Halvorsen attractor

These reuse the trajectory renderer and establish a family-selection architecture.

### Phase 2 — Add implicit labyrinths

1. Gyroid
2. Schwarz D
3. Neovius

These establish a reusable triply periodic implicit-surface renderer with clipping and wall-thickness controls.

### Phase 3 — Add algebraic surfaces

1. Kummer quartic
2. Barth sextic
3. Cayley cubic

These establish polynomial evaluation, bounded raymarching, singularity handling, and equation-aware presets.

### Phase 4 — Add higher-dimensional structures

1. Hopf fibration
2. Clifford torus stereographic projection
3. 24-cell projection

These establish 4D rotation, projection, and generated-geometry controls.

### Phase 5 — Research-grade models

1. Quaternion Mandelbrot set
2. Kleinian group limit set
3. Icosahedral quasicrystal
4. Hyperbolic honeycomb

These should be prototyped separately and admitted to the main model list only after they are visually convincing, mathematically faithful, and scalable across devices.

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
