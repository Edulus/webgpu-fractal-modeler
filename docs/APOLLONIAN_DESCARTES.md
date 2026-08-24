# Canonical Apollonian Sphere Packing (Descartes)

## Status

Implemented as a new selectable shape using the retired internal shape slot `penrose` (numeric id 8). The old Penrose relief had already been removed from the selector; reusing its dormant id preserves every existing numeric shape id after it.

Public name: **Canonical Apollonian sphere packing (Descartes)**.

The existing `apollonian` shape remains unchanged. It is an Apollonian-style fold/inversion construction and is intentionally kept distinct from this canonical Descartes packing.

## Seed configuration

The canonical model uses one enclosing unit sphere with signed curvature `-1` and four mutually tangent inner spheres. Three inner seed spheres share a user-controlled curvature `k`. The fourth curvature is derived from the three-dimensional Soddy–Gossett form of Descartes' theorem:

```text
(k1 + k2 + k3 + k4 + k5)^2 = 3 (k1^2 + k2^2 + k3^2 + k4^2 + k5^2)
```

For the curvature vector

```text
(-1, k, k, k, k4)
```

the lower positive root is

```text
k4 = (3k - 1 - sqrt(9k^2 - 18k - 3)) / 2
```

The symmetric configuration occurs at

```text
k = 1 + sqrt(6)/2 ≈ 2.224744871
```

where all four inner spheres have equal curvature and their centres form a tetrahedral configuration.

The user does **not** get an independent fourth-curvature slider. Doing so would allow the UI to leave Descartes space and destroy the mutual tangencies.

## Shape maths controls

### Seed curvature κ

Range:

```text
1 + sqrt(6)/2  ≤  κ  ≤  3.2
```

Default: the symmetric value `1 + sqrt(6)/2`.

Increasing κ shrinks the three equal seed spheres. The fourth sphere grows according to the Descartes constraint, producing an asymmetric but still exactly tangent seed configuration.

The range was checked numerically for:

- a real lower-branch Descartes root;
- internal tangency to the enclosing unit sphere;
- pairwise tangency of all four inner seed spheres;
- nonsingular dual inversion generators;
- valid alternate Descartes curvatures after inversion.

### Recursion depth

Range: `4..24`, integer. Default: `18`.

This is the maximum dual-Apollonian group-word depth used by the distance estimator. It is a mathematical truncation of an infinite packing, so it is marked as a geometry/cost parameter rather than being tied to the adaptive rendering governor.

## Recursive construction

For each of the four inner seed spheres, construct its **dual inversion sphere**. That dual sphere is orthogonal to:

- the enclosing unit sphere; and
- the other three inner seed spheres.

Inversion in that dual sphere fixes those four spheres and maps the excluded seed sphere to the alternate sphere tangent to them. Its curvature is exactly the other Soddy–Gossett root. Repeating these four involutions generates the 3D Apollonian packing.

This is fundamentally different from the older fold/inversion estimator: the recursive transformations are derived from a Descartes configuration and preserve its tangency geometry.

## Distance estimator

A point is repeatedly inverted through whichever dual generator contains it most deeply. The accumulated conformal scale is tracked. Once the point reaches the root Descartes cell, its distance to the nearest of the four seed spheres is pulled back through that accumulated scale.

The raw conformal pull-back is exact infinitesimally but can overestimate finite Euclidean distance away from a surface. It was compared against explicit finite reference packings (depth 8, about 2,900 spheres) across the user curvature interval. The worst sampled raw overestimate was about 6%, so the shipped estimator multiplies the pulled-back distance by `0.85` before sphere tracing.

The enclosing unit sphere is also used as an exact outer bound for cheap safe steps outside the packing.

## Derived properties

These are informative properties, not user controls:

- the fourth seed curvature;
- all dual inversion centres/radii;
- all descendant sphere curvatures and positions;
- packing density at a chosen finite generation;
- the fractal dimension of the infinite residual set.

In particular, fractal dimension is not a slider. It is a property of the resulting infinite packing/group.

## Tests

`tools/apollonian-descartes.test.js` checks:

- the Soddy–Gossett equation across the slider range;
- pairwise and enclosing-sphere tangencies;
- dual-generator orthogonality;
- inversion to the alternate Descartes curvature;
- preservation of tangency to the enclosing sphere;
- the registry defaults and runtime estimator wiring.
