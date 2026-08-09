// engel.wgsl.js — constants for Engel's 38-faced space-filling polyhedron.
//
// Generated from the verified construction, not typed by hand. The Voronoi cell
// of the point (427/6984, 761/6984, 1421/6984) under the cubic space group whose
// 2-fold about z carries (0, 1/2, 0) and whose 2-fold about [110] carries
// (1/4, 3/4, 3/4). That group was identified by search rather than recalled: of
// the eight order-48 groups with point group 432 and a body-centred lattice,
// exactly one gives Engel's f-vector of 70 vertices, 106 edges and 38 faces, and
// its cell has volume 1/48 to 2.7e-15 relative error -- which is the statement
// that the cells tile space.
//
// Three tables, all in fractional coordinates of the cubic cell:
//   ENGEL_SITE  48 orbit points, one per cell in the unit cube
//   ENGEL_ROT   the transpose of each site's rotation, three rows apiece
//   ENGEL_PLANE the 38 faces of the canonical cell, as (unit normal, offset)
//               measured from the generating point

export const ENGEL_WGSL = /* wgsl */ `
var<private> ENGEL_SITE : array<vec3<f32>, 48> = array<vec3<f32>, 48>(
  vec3<f32>(0.04653494, 0.14103666, 0.18886025),
  vec3<f32>(0.04653494, 0.85896334, 0.31113975),
  vec3<f32>(0.06113975, 0.10896334, 0.20346506),
  vec3<f32>(0.06113975, 0.89103666, 0.29653494),
  vec3<f32>(0.10896334, 0.20346506, 0.06113975),
  vec3<f32>(0.10896334, 0.79653494, 0.43886025),
  vec3<f32>(0.14103666, 0.18886025, 0.04653494),
  vec3<f32>(0.14103666, 0.81113975, 0.45346506),
  vec3<f32>(0.18886025, 0.04653494, 0.14103666),
  vec3<f32>(0.18886025, 0.95346506, 0.35896334),
  vec3<f32>(0.20346506, 0.06113975, 0.10896334),
  vec3<f32>(0.20346506, 0.93886025, 0.39103666),
  vec3<f32>(0.29653494, 0.06113975, 0.89103666),
  vec3<f32>(0.29653494, 0.93886025, 0.60896334),
  vec3<f32>(0.31113975, 0.04653494, 0.85896334),
  vec3<f32>(0.31113975, 0.95346506, 0.64103666),
  vec3<f32>(0.35896334, 0.18886025, 0.95346506),
  vec3<f32>(0.35896334, 0.81113975, 0.54653494),
  vec3<f32>(0.39103666, 0.20346506, 0.93886025),
  vec3<f32>(0.39103666, 0.79653494, 0.56113975),
  vec3<f32>(0.43886025, 0.10896334, 0.79653494),
  vec3<f32>(0.43886025, 0.89103666, 0.70346506),
  vec3<f32>(0.45346506, 0.14103666, 0.81113975),
  vec3<f32>(0.45346506, 0.85896334, 0.68886025),
  vec3<f32>(0.54653494, 0.35896334, 0.81113975),
  vec3<f32>(0.54653494, 0.64103666, 0.68886025),
  vec3<f32>(0.56113975, 0.39103666, 0.79653494),
  vec3<f32>(0.56113975, 0.60896334, 0.70346506),
  vec3<f32>(0.60896334, 0.29653494, 0.93886025),
  vec3<f32>(0.60896334, 0.70346506, 0.56113975),
  vec3<f32>(0.64103666, 0.31113975, 0.95346506),
  vec3<f32>(0.64103666, 0.68886025, 0.54653494),
  vec3<f32>(0.68886025, 0.45346506, 0.85896334),
  vec3<f32>(0.68886025, 0.54653494, 0.64103666),
  vec3<f32>(0.70346506, 0.43886025, 0.89103666),
  vec3<f32>(0.70346506, 0.56113975, 0.60896334),
  vec3<f32>(0.79653494, 0.43886025, 0.10896334),
  vec3<f32>(0.79653494, 0.56113975, 0.39103666),
  vec3<f32>(0.81113975, 0.45346506, 0.14103666),
  vec3<f32>(0.81113975, 0.54653494, 0.35896334),
  vec3<f32>(0.85896334, 0.31113975, 0.04653494),
  vec3<f32>(0.85896334, 0.68886025, 0.45346506),
  vec3<f32>(0.89103666, 0.29653494, 0.06113975),
  vec3<f32>(0.89103666, 0.70346506, 0.43886025),
  vec3<f32>(0.93886025, 0.39103666, 0.20346506),
  vec3<f32>(0.93886025, 0.60896334, 0.29653494),
  vec3<f32>(0.95346506, 0.35896334, 0.18886025),
  vec3<f32>(0.95346506, 0.64103666, 0.31113975),
);

var<private> ENGEL_ROT : array<vec3<f32>, 144> = array<vec3<f32>, 144>(
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(-1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, 0.0, -1.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
  vec3<f32>(0.0, -1.0, 0.0),
  vec3<f32>(1.0, 0.0, 0.0),
);

var<private> ENGEL_PLANE : array<vec4<f32>, 38> = array<vec4<f32>, 38>(
  vec4<f32>(-0.38284232, 0.84075176, -0.38284232, 0.01907419),
  vec4<f32>(0.82259826, -0.40207717, -0.40207717, 0.07763237),
  vec4<f32>(0.26956600, 0.53267533, -0.80224134, 0.08870480),
  vec4<f32>(0.80224134, -0.26956600, -0.53267533, 0.08870480),
  vec4<f32>(0.00000000, -0.91964435, 0.39275218, 0.11848422),
  vec4<f32>(0.50222996, -0.61145935, 0.61145935, 0.12715341),
  vec4<f32>(-0.39500113, 0.91711699, -0.05357728, 0.13629668),
  vec4<f32>(-0.05357728, -0.91711699, 0.39500113, 0.13629668),
  vec4<f32>(-0.58560691, 0.64574499, -0.48997750, 0.14523658),
  vec4<f32>(0.48997750, -0.58560691, 0.64574499, 0.14523658),
  vec4<f32>(-0.39773814, 0.91749898, 0.00000000, 0.15371860),
  vec4<f32>(-0.47402534, 0.82968009, 0.29484050, 0.26369898),
  vec4<f32>(0.47402534, -0.29484050, 0.82968009, 0.26369898),
  vec4<f32>(-0.81257550, 0.33707217, -0.47550333, 0.27823655),
  vec4<f32>(-0.47550333, 0.81257550, 0.33707217, 0.27823655),
  vec4<f32>(0.53719169, 0.00000000, 0.84346019, 0.35156957),
  vec4<f32>(-0.50744283, 0.64151500, 0.57529147, 0.35242855),
  vec4<f32>(-0.64151500, -0.57529147, 0.50744283, 0.35242855),
  vec4<f32>(-0.51550104, 0.60591199, 0.60591199, 0.36108511),
  vec4<f32>(-0.83929735, 0.04429845, -0.54186493, 0.36201394),
  vec4<f32>(0.54186493, 0.04429845, 0.83929735, 0.36201394),
  vec4<f32>(-0.83693569, 0.00000000, -0.54730125, 0.37176064),
  vec4<f32>(-0.74385027, -0.30602322, 0.59416880, 0.40846573),
  vec4<f32>(0.59416880, 0.30602322, 0.74385027, 0.40846573),
  vec4<f32>(-0.60576154, 0.34173832, 0.71851784, 0.41270366),
  vec4<f32>(0.60576154, 0.34173832, 0.71851784, 0.41270366),
  vec4<f32>(-0.75201720, -0.26336175, -0.60424392, 0.41374020),
  vec4<f32>(-0.75201720, -0.26336175, 0.60424392, 0.41374020),
  vec4<f32>(-0.44916519, -0.79087625, -0.41565056, 0.41441267),
  vec4<f32>(-0.44916519, 0.41565056, 0.79087625, 0.41441267),
  vec4<f32>(-0.72808750, -0.29953835, -0.61657551, 0.41730883),
  vec4<f32>(-0.61657551, 0.29953835, 0.72808750, 0.41730883),
  vec4<f32>(-0.72389230, 0.00000000, 0.68991300, 0.42981497),
  vec4<f32>(-0.70661484, 0.03729541, 0.70661484, 0.42999004),
  vec4<f32>(-0.59477316, -0.54082323, -0.59477316, 0.43260594),
  vec4<f32>(-0.57735027, -0.57735027, -0.57735027, 0.43301270),
  vec4<f32>(0.57735027, 0.57735027, 0.57735027, 0.43301270),
  vec4<f32>(-0.42390972, -0.64042976, -0.64042976, 0.43910234),
);

// ---- Engel's 38-faced space-filling polyhedron -----------------------------
//
// A PLESIOHEDRON is the Voronoi cell of one point of a discrete point set.
// Voronoi cells tile space by construction, so every plesiohedron fills space;
// the question Engel settled in 1981 is how complicated one can be. Searching
// Dirichlet partitions of cubic symmetry he found 172 types, two of them with 38
// faces and 70 vertices, and 38 is now known to be the most a plesiohedron can
// have. This is that polyhedron, and what is drawn is the TILING: a single cell
// is a thin 38-faced wedge, 13:1 from longest axis to shortest, and not much to
// look at. Filling space with it is the point of the thing.
//
// The estimator is the cheapest and sharpest here, and the only one that is
// exact. A convex polyhedron given as half-spaces with unit normals has signed
// distance exactly max(n_k . y - h_k), with no iteration and no safety factor;
// every cell is a copy of one polyhedron, so:
//
//   d = minimum-image offset from the point to the nearest of the 48 sites
//   y = R^T d, carrying it into the canonical cell's own frame
//   SDF = max over the 38 planes, then eroded by GAP so the joints show
//
// Working RELATIVE to the site is what removes the translation, leaving only a
// rotation to store. Minimum image is legitimate because it only has to find the
// NEAREST site, and no point of a cell is further than the circumradius 0.4442
// from its own site -- inside the half-period the convention requires. Measured
// against a brute-force search over the full 27-image neighbourhood: worst
// difference 8.6e-16 over 500 points, and the Lipschitz ratio over 4000 pairs
// peaks at 0.986, never exceeding 1.
//
// The cells are eroded rather than drawn solid because a space-filling tiling
// drawn solid is a solid block -- the same lesson the honeycomb's cell walls
// taught. Eroding opens the joints and turns it into a three-dimensional jigsaw.
fn deEngel(pos : vec3<f32>) -> DEResult {
  const GAP : f32 = 0.012;        // erosion; the cell's inscribed radius is 0.070
  const R_CLIP : f32 = 1.15;      // the tiling is infinite, so bound it

  var res : DEResult;

  // Fold into the unit cell. The tiling is lattice-periodic, so the offset to
  // the nearest site is all that survives.
  let xf = pos - floor(pos);

  var bd = vec3<f32>(0.0);
  var bq = 1e9;
  var bi = 0;
  for (var i = 0; i < 48; i = i + 1) {
    var d = xf - ENGEL_SITE[i];
    d = d - round(d);
    let q = dot(d, d);
    if (q < bq) { bq = q; bd = d; bi = i; }
  }

  // Into the canonical cell's frame. ENGEL_ROT holds R^T a row at a time.
  let y = vec3<f32>(dot(ENGEL_ROT[bi * 3], bd),
                    dot(ENGEL_ROT[bi * 3 + 1], bd),
                    dot(ENGEL_ROT[bi * 3 + 2], bd));

  var d = -1e9;
  for (var k = 0; k < 38; k = k + 1) {
    let pl = ENGEL_PLANE[k];
    d = max(d, dot(pl.xyz, y) - pl.w);
  }

  res.dist = max(d + GAP, length(pos) - R_CLIP);
  // Which of the 48 cells in the unit cell this is, so neighbours take
  // different palette bands and the jigsaw reads as separate pieces.
  res.trap = clamp(0.08 + 0.88 * (f32(bi) / 48.0), 0.0, 1.0);
  return res;
}
`;
