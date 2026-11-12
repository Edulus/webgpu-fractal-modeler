# Shape Catalogue Plan

How the shapes are organised, what has been built, and what comes next. This is
the working plan behind the Family → Type → Shape picker. For the deeper
research notes on individual candidates — selection criteria, density traps,
models to avoid — see [FUTURE_MODELS.md](FUTURE_MODELS.md).

## 1. Principle

Shapes are grouped by **the branch of mathematics that defines them**, not by
how they look or how they are computed. The previous menu mixed all three, which
put the Menger sponge under "Cube lattices" because it is made of cubes, filed
the Apollonian packing apart from the Kleinian groups whose limit set it is, and
mixed algebraic geometry with differential geometry under "Surfaces".

Two further rules:

- **Proper names in the menu.** "Envelope, octahedral seed" became *Stella
  octangula*; "Envelope, dodecahedral seed" became *Small stellated
  dodecahedron*.
- **Type versus preset.** Original constructions that are not standard
  mathematical objects keep their descriptive names but are marked as presets of
  the type they belong to — *Studded surface (preset)* and *Polar bloom / Ornate
  planet (preset)* under Sphere packings.

## 2. The menu

Seven families. Each `<optgroup>` in `index.html` is one **type** and carries its
family in `data-family`, so that markup *is* the catalogue: the Family and Type
dropdowns are built from it at runtime (`src/catalog.js`), and without
JavaScript it still works as one grouped list.

| Family | Type | Shapes |
|---|---|---|
| **Fractals** | Escape-time | Mandelbulb, Mandelbox, Quaternion Julia, Tetrabrot |
| | Self-similar (IFS) | Menger sponge, Sierpiński tetrahedron, Octahedron flake, Jerusalem cube, Cantor dust, Stella octangula fractal |
| | Kaleidoscopic and folding | Kaleidoscopic IFS (octahedral) |
| **Packings and groups** | Sphere packings | Canonical Apollonian (Descartes), Apollonian packing (inversion), Nested sphere packing, Kleinian packing {5,3,6}, *Studded surface (preset)*, *Polar bloom / Ornate planet (preset)* |
| | Group limit sets | Kleinian limit set, Kissing Schottky (parabolic), Schottky (hyperbolic) |
| **Tessellations** | Hyperbolic honeycombs | {5,3,4} and {4,3,5}, each regular, truncated and omnitruncated |
| | Euclidean honeycombs and space-fillers | Engel plesiohedron, Cubic, Tetrahedral–octahedral, Rhombic dodecahedral, Bitruncated cubic (Kelvin) |
| | Aperiodic order | Icosahedral quasicrystal |
| **Surfaces** | Triply periodic minimal surfaces | Gyroid, Schwarz P, Schwarz D, Neovius, Schoen I-WP |
| | Algebraic surfaces | Barth sextic (65 nodes), Cayley nodal cubic (4), Clebsch diagonal cubic (27 lines), Kummer quartic (16) |
| | Ruled surfaces | Hyperboloid of one sheet, Hyperbolic paraboloid |
| | Tori and higher genus | Horn torus, Spindle torus, Linked tori (Hopf link), Genus-two surface |
| | Implicit and blended | Metaballs, Superquadric |
| **Polyhedra** | Stellated and star polyhedra | Stella octangula, Small stellated dodecahedron, Great dodecahedron, Great stellated dodecahedron |
| | Compounds | Compound of five tetrahedra, Compound of five cubes |
| **Curves and dynamics** | Strange attractors | Aizawa, Lorenz, Rössler, Thomas, Halvorsen, Dadras, Chen, Sprott (case B), Rabinovich–Fabrikant |
| **Fields and assemblies** | Volumetric fields | Cosmic Web |
| | Procedural assemblies | Ziggurat, Cube stack |

67 shapes: the original 32, plus 35 added with this plan.

## 3. How a shape is registered

`src/shapes.js` is the single registry. Each entry is `{ name, kind, cam }` and
its **id is its index**:

- `kind` is `surface` (distance-estimated and sphere-traced), `line` (an ODE
  trajectory drawn as a line strip) or `volume` (a density field).
- `cam` is the orbit distance that frames it.

Everything else is derived: the renderer's `FRACTAL_IDS` and `CAM_RADIUS`, the
HUD names, the diagnostics model names, and — through `shapeKindWGSL()` — the
shader tests `isLineShape` / `isVolumeShape` / `isSurfaceShape`. Before this,
those were hand-kept copies in five files and had drifted (diagnostics was four
shapes behind and called anything with id ≥ 25 an attractor, including the
ziggurat).

**Never reorder or delete an entry**: a shipped id must keep meaning the same
shape. New shapes are appended. Kinds no longer need contiguous id ranges, and
`mapDE` dispatches with a `switch` on the integer id rather than a ladder of
float thresholds.

### Checklist for a new surface

1. Append `{ name, kind: 'surface', cam }` to `SHAPES`.
2. Write the estimator (new ones go in `src/shaders/catalog.wgsl.js`) and add a
   `case` for its id in `mapDE` (`fractal-base.wgsl.js`).
3. Add an `<option>` under the right type in `index.html`, and a note in `NOTES`.
4. `node tools/registry.test.js` checks the id is dispatched, selectable and
   described; `tools/catalog.test.js` checks the menu.

### Checklist for a new attractor

1. Add its definition to `src/attractors.js` with a **measured** fit.
2. Map the shape name to it in `ATTRACTOR_FOR_SHAPE`, and append
   `{ name, kind: 'line', cam }` to `SHAPES`.
3. Menu option and note, as above. `tools/attractor.test.js` re-measures every
   attractor: bounded, framed, finely stepped, positive Lyapunov exponent, and
   every uploaded vertex finite.

## 4. What was built, and how each was checked

### Strange attractors (6 added)

Each was integrated in Node and measured for boundedness, bounding box (to set
its fit) and largest Lyapunov exponent. The estimator was first validated on
Lorenz (0.897 against the published 0.906). Two commonly quoted parameter values
measured **non-chaotic** here and were replaced:

- **Thomas** at b = 0.208186 settles on a lopsided orbit (exponent 0.007); b = 0.18
  is chaotic (0.030) and symmetric.
- **Halvorsen** at a = 1.89 is periodic; Sprott's a = 1.27 is chaotic (0.774,
  published ~0.75).

**Rabinovich–Fabrikant** is compact, so its loops pile up: it uses a larger step
and a quarter of the usual point count, or additive blending saturates it to
white. Point counts are now per attractor.

A latent bug surfaced along the way: speeds were rounded to float32 before the
float64 minimum was subtracted, so the slowest sample could go fractionally
negative under a square root — one NaN vertex, which the bloom chain spreads into
a black rectangle. It affected the shipped **Lorenz** attractor as well as three
of the new ones. Fixed, and the test now checks every uploaded vertex.

### Surfaces (29 added)

Every estimator returns a lower bound on distance, so the march cannot step
through a surface:

- **Triply periodic minimal surfaces** divide the field by a *proven* bound on its
  gradient (√3, √6, 7√3, 8√3 times the frequency), as the gyroid does.
- **Algebraic surfaces** use |f| / |∇f| with the Barth sextic's guards (a gradient
  floor at the nodes, a step cap away from them), clipped to a ball.
- **Star polyhedra** use the k-th largest distance to the dodecahedron's face
  planes. k = 3 and k = 4 give the great dodecahedron and the great stellated
  dodecahedron; their vertex positions were measured (√5 along the icosahedron
  axes for k = 2 and 3, ≈5.32 along the dodecahedron axes for k = 4) and match
  the known solids. An order statistic of 1-Lipschitz functions is 1-Lipschitz.
- **Compounds** rotate one cube or tetrahedron by fifth-turns about a five-fold
  axis of the dodecahedron it is inscribed in.
- **IFS solids** use folds and scaling. The Jerusalem cube and the stella
  octangula fractal follow the *nearer* of two pieces, which is a heuristic, so
  their estimates are scaled by 0.8.
- **Euclidean honeycombs** are shrunk cells clipped to a ball, Engel-style: plane
  families for the cubic and tetrahedral–octahedral honeycombs, nearest-lattice-
  point Voronoi cells (FCC, BCC) for the rhombic dodecahedral and Kelvin ones.
- **Ruled surfaces** are drawn as string models — rods along both families of
  rulings — which shows what "ruled" means.
- **Horn and spindle tori** are thin shells with a quarter cut away so the
  self-contact and self-intersection can be seen.

## 5. Tension with the curation rules

[FUTURE_MODELS.md](FUTURE_MODELS.md) lists *models to avoid*, including
"arbitrary metaball clusters without a defined mathematical system" and
"elementary solids presented as standalone models". **Metaballs** and the
**superquadric** were added at the owner's request but sit against those rules;
the horn and spindle tori are closer to the line but carry real content in the
cutaway. They are grouped under *Implicit and blended* and *Tori and higher
genus* so they are easy to withdraw. Decision pending.

## 6. Next, by cost

The renderer has three ways of drawing — distance-estimated surfaces, line
trajectories, density volumes — and no triangle-mesh pipeline or simulation
step. That sets the cost of each remaining type.

**Moderate: new geometry, existing renderer**

- Knots and links as tubes: trefoil, figure-eight, torus knots, Borromean rings.
- Space-filling curves as tubes: 3D Hilbert curve.
- Four-dimensional polytopes as projected edge tubes: tesseract, 24-cell, 120-cell, 600-cell.
- The remaining compact regular hyperbolic honeycombs, {3,5,3} and {5,3,5}, which
  complete the set of four. Needs the honeycomb code extended to new groups.
- Kepler–Poinsot completion: the great icosahedron (a stellation of the
  icosahedron, not reachable by the dodecahedron layers used here).
- More compounds: five octahedra, ten tetrahedra, three cubes.
- Voronoi foams and Weaire–Phelan.
- L-system trees and fractal terrain (heightfield, as the ziggurat).
- Sphere packings FCC and HCP (cheap but visually plain; low priority).

**Expensive: needs new engine work**

- Surfaces defined only parametrically — Costa, Boy's surface, the Klein bottle,
  Enneper — have no usable implicit form; they need a mesh pipeline.
- Simulation-grown forms — reaction–diffusion, diffusion-limited aggregation,
  crystal growth — need a compute step and stored state.
- Two-dimensional objects — circle packings, Ford circles, Penrose and
  Ammann–Beenker tilings, the Barnsley fern, the 2D Hilbert and Peano curves —
  need a decision on how to show a flat object in a 3D viewer (extrude, wrap on a
  sphere, or a flat mode). FUTURE_MODELS.md warns against 2D patterns engraved on
  primitives, so this wants care.

## 7. Open decisions

1. Keep or withdraw metaballs and the superquadric (section 5).
2. Whether to admit 2D-native types, and how to present them.
3. Order for the moderate tier. Suggested: knots and links (one tube estimator
   serves all of them), then 4D polytopes (same tubes), then the two remaining
   hyperbolic honeycombs.

## 8. Session log and next session

### State at the end of session 1 (branch `claude/shape-catalog`, not merged)

Done and verified:

- Shape registry (`src/shapes.js`), generated shader kind helpers, `mapDE`
  switch. All 32 original ids and camera distances checked identical.
- Family → Type → Shape picker, driven in a real browser: all seven families,
  type switching, renderer and description follow, every shape reachable, no
  errors.
- Six attractors: measured, tested, and rendered.
- NaN fix for attractor speeds, affecting the shipped **Lorenz** attractor too.
- All 25 test suites pass. All shader modules compile.

Built, compiled and tested, but **visual check incomplete** (software rendering
of the new surfaces was too slow to finish in session):

| Status | Shapes |
|---|---|
| Rendered, look right | Great dodecahedron, Hyperbolic paraboloid, Schwarz P, Schwarz D, Neovius, Schoen I-WP, Compound of five tetrahedra |
| Rendered, need work | Horn torus and Spindle torus (the cutaway faces the camera, so they read as beans, not tori); Kaleidoscopic IFS (renders as a featureless lump; needs offset/twist tuning or a different chamber) |
| Fixed, not re-rendered | Stella octangula fractal (first render was a solid cube; it converges to one, so it is now held at its 2nd–3rd stage) |
| Not yet rendered | Cayley, Clebsch, Kummer, Great stellated dodecahedron, Compound of five cubes, Sierpiński tetrahedron, Octahedron flake, Jerusalem cube, Cantor dust, the four Euclidean honeycombs, Hyperboloid, Linked tori, Genus-two surface, Metaballs, Superquadric |

### Plan for session 2

1. **Finish the visual pass** on the 19 unrendered shapes plus the stella
   fractal. To keep it fast: render at 200×130 with 2 samples, at most three
   workers on this four-core machine, and look at them in batches of six rather
   than waiting for all. (TPMS-style shapes are slow under software rendering
   because a global gradient bound means many small steps; that is a software-GPU
   cost, not a real-hardware one.)
2. **Fix what the pass finds.** Already known:
   - Tori: rotate the cut so it faces sideways (or cut a wedge on the far side),
     and frame them from slightly above.
   - Kaleidoscopic IFS: tune scale/offset/twist, or switch to the icosahedral
     chamber, until it reads as an ornament.
   - Shapes likely to need framing tweaks: the algebraic surfaces (clip radius and
     scale were set from formulas, not looked at), the honeycombs (cell size).
3. **Decide on metaballs and the superquadric** (section 5) with the owner.
4. **Confirm on real hardware** that the picker feels right on a phone (the two
   dropdowns stack below 420px wide).
5. **Open the pull request** for `claude/shape-catalog`, merge when the owner
   agrees, and check the deployed page.
6. Then start the **moderate tier** (section 6), suggested order: knots and links
   → 4D polytopes → {3,5,3} and {5,3,5} honeycombs.
