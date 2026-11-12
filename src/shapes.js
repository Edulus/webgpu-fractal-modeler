// shapes.js — the one registry of shapes.
//
// Every shape has a stable numeric id (its index here), a kind, and the orbit
// distance that frames it. Everything else is derived from this list: the
// renderer's FRACTAL_IDS and CAM_RADIUS, the diagnostics' model names, the HUD
// names, and -- through shapeKindWGSL() -- the shader tests for "is this a line
// attractor / a volume / a surface". Those used to be hand-kept copies in five
// files, and they had drifted: diagnostics was missing four shapes and guessed
// "attractor" from id >= 25, which mislabelled the ziggurat.
//
// RULES
// - Ids are positions in SHAPES. Never reorder or delete an entry: a shipped id
//   must keep meaning the same shape. New shapes are appended.
// - kind is 'surface' (distance-estimated, sphere-traced), 'line' (an ODE
//   trajectory drawn as a line strip) or 'volume' (a density field). Kinds no
//   longer have to form contiguous id bands; the shader helpers test the set.
// - Retired shapes stay registered (see penrose's note in fractal-bg.js) so no
//   id after them moves.
//
// Notes carried over from the old id table in fractal-bg.js:
// - schottky (12) and schottkyh (13) share one estimator; deSchottky picks the
//   regime from the id (kissing/parabolic vs separated/hyperbolic), so they
//   must stay adjacent and in this order.
// - envoct (15) and envdodec (16) share deEnvelope; the id selects the seed.
// - The honeycombs share deHoneycomb, which groups them by id: {5,3,4} holds
//   17/19/20 and {4,3,5} holds 18/21/22. They must stay put.
// - penrose (8) was an honest P3 tiling engraved on a disc, retired as the
//   2D-pattern-on-a-primitive case the roadmap warns against; the slot now
//   holds the canonical Descartes Apollonian packing under the old key.
//
// cam: orbit distance in world units. Each estimator lives at its own scale, so
// one radius would sit inside the larger ones. The measured reasons for the
// existing values are kept in fractal-bg.js beside the camera code.

export const SHAPES = [
  { name: 'mandelbulb', kind: 'surface', cam: 2.55 },  // 0
  { name: 'mandelbox', kind: 'surface', cam: 6.5 },    // 1
  { name: 'menger', kind: 'surface', cam: 3.6 },       // 2
  { name: 'julia', kind: 'surface', cam: 3.0 },        // 3
  { name: 'apollonian', kind: 'surface', cam: 3.0 },   // 4
  { name: 'spherepack', kind: 'surface', cam: 2.9 },   // 5
  { name: 'encrusted', kind: 'surface', cam: 3.1 },    // 6
  { name: 'surfacepack', kind: 'surface', cam: 3.0 },  // 7
  // id 8 keeps its historical key; it now holds the canonical Descartes
  // Apollonian packing (see fractal.wgsl.js).
  { name: 'penrose', kind: 'surface', cam: 3.5 },      // 8
  { name: 'gyroid', kind: 'surface', cam: 3.2 },       // 9
  { name: 'kleinian', kind: 'surface', cam: 3.6 },     // 10
  { name: 'barth', kind: 'surface', cam: 4.6 },        // 11
  { name: 'schottky', kind: 'surface', cam: 1.55 },    // 12
  { name: 'schottkyh', kind: 'surface', cam: 1.75 },   // 13
  { name: 'tetrabrot', kind: 'surface', cam: 3.4 },    // 14
  { name: 'envoct', kind: 'surface', cam: 2.85 },      // 15
  { name: 'envdodec', kind: 'surface', cam: 5.75 },    // 16
  { name: 'hyp534', kind: 'surface', cam: 2.0 },       // 17
  { name: 'hyp435', kind: 'surface', cam: 2.0 },       // 18
  { name: 'hyp534t', kind: 'surface', cam: 2.0 },      // 19
  { name: 'hyp534o', kind: 'surface', cam: 2.0 },      // 20
  { name: 'hyp435t', kind: 'surface', cam: 2.0 },      // 21
  { name: 'hyp435o', kind: 'surface', cam: 2.0 },      // 22
  { name: 'kleinpack', kind: 'surface', cam: 2.3 },    // 23
  { name: 'engel', kind: 'surface', cam: 3.0 },        // 24
  { name: 'attractor', kind: 'line', cam: 3.2 },       // 25  Aizawa
  { name: 'lorenz', kind: 'line', cam: 3.0 },          // 26
  { name: 'rossler', kind: 'line', cam: 3.0 },         // 27
  { name: 'cosmicweb', kind: 'volume', cam: 6.2 },     // 28
  { name: 'ziggurat', kind: 'surface', cam: 2.6 },     // 29
  { name: 'cubestack', kind: 'surface', cam: 2.6 },    // 30
  { name: 'quasicrystal', kind: 'surface', cam: 3.1 }, // 31
  // ---- Strange attractors, second set (fitted in src/attractors.js) ----
  { name: 'thomas', kind: 'line', cam: 3.0 },          // 32
  { name: 'halvorsen', kind: 'line', cam: 3.0 },       // 33
  { name: 'dadras', kind: 'line', cam: 3.0 },          // 34
  { name: 'chen', kind: 'line', cam: 3.0 },            // 35
  { name: 'sprott', kind: 'line', cam: 3.0 },          // 36
  { name: 'rabinovich', kind: 'line', cam: 3.0 },      // 37
  // ---- Triply periodic minimal surfaces (catalog.wgsl.js) ----
  { name: 'schwarzp', kind: 'surface', cam: 3.2 },  // 38
  { name: 'schwarzd', kind: 'surface', cam: 3.2 },  // 39
  { name: 'neovius', kind: 'surface', cam: 3.2 },   // 40
  { name: 'iwp', kind: 'surface', cam: 3.2 },       // 41
  // ---- Algebraic surfaces (catalog.wgsl.js) ----
  { name: 'cayley', kind: 'surface', cam: 3.6 },    // 42
  { name: 'clebsch', kind: 'surface', cam: 3.6 },   // 43
  { name: 'kummer', kind: 'surface', cam: 3.6 },    // 44
  // ---- Star polyhedra and compounds (catalog.wgsl.js) ----
  { name: 'gsdodec', kind: 'surface', cam: 3.4 },   // 45
  { name: 'gdodec', kind: 'surface', cam: 3.0 },    // 46
  { name: 'tet5', kind: 'surface', cam: 2.8 },      // 47
  { name: 'cube5', kind: 'surface', cam: 2.6 },     // 48
  // ---- Self-similar (IFS) fractals (catalog.wgsl.js) ----
  { name: 'sierpinski', kind: 'surface', cam: 4.0 },// 49
  { name: 'octaflake', kind: 'surface', cam: 2.6 }, // 50
  { name: 'jerusalem', kind: 'surface', cam: 4.0 }, // 51
  { name: 'cantordust', kind: 'surface', cam: 4.0 },// 52
  { name: 'stellafractal', kind: 'surface', cam: 3.0 },// 53
  { name: 'kifs', kind: 'surface', cam: 3.2 },      // 54
  // ---- Euclidean honeycombs (catalog.wgsl.js) ----
  { name: 'cubichc', kind: 'surface', cam: 3.0 },   // 55
  { name: 'tetoct', kind: 'surface', cam: 3.0 },    // 56
  { name: 'rhombichc', kind: 'surface', cam: 3.0 }, // 57
  { name: 'kelvinhc', kind: 'surface', cam: 3.0 },  // 58
  // ---- Ruled surfaces, tori and implicit forms (catalog.wgsl.js) ----
  { name: 'hyperboloid', kind: 'surface', cam: 2.8 },// 59
  { name: 'hypar', kind: 'surface', cam: 3.0 },     // 60
  { name: 'horntorus', kind: 'surface', cam: 3.0 }, // 61
  { name: 'spindletorus', kind: 'surface', cam: 2.8 },// 62
  { name: 'linkedtori', kind: 'surface', cam: 2.8 },// 63
  { name: 'genus2', kind: 'surface', cam: 3.2 },    // 64
  { name: 'metaballs', kind: 'surface', cam: 3.0 }, // 65
  { name: 'superquadric', kind: 'surface', cam: 2.6 },// 66
];

export const SHAPE_NAMES = SHAPES.map((s) => s.name);
export const FRACTAL_IDS = Object.fromEntries(SHAPES.map((s, i) => [s.name, i]));
export const CAM_RADIUS = SHAPES.map((s) => s.cam);

const idsOfKind = (kind) => SHAPES.flatMap((s, i) => (s.kind === kind ? [i] : []));
export const LINE_IDS = idsOfKind('line');
export const VOLUME_IDS = idsOfKind('volume');

export function shapeKind(id) {
  return SHAPES[id]?.kind ?? 'surface';
}

// Collapse a sorted id list into [first, last] runs, so the generated WGSL is
// one range test per run rather than one comparison per id.
function runs(ids) {
  const out = [];
  for (const id of ids) {
    const last = out[out.length - 1];
    if (last && id === last[1] + 1) last[1] = id;
    else out.push([id, id]);
  }
  return out;
}

function rangeTest(ids) {
  if (!ids.length) return 'false';
  return runs(ids)
    .map(([a, b]) => (a === b
      ? `abs(ft - ${a}.0) < 0.5`
      : `(ft > ${(a - 0.5).toFixed(1)} && ft < ${(b + 0.5).toFixed(1)})`))
    .join(' || ');
}

// The shader side of the registry. Inserted into every module that has to ask
// what kind of shape is being drawn, so they cannot disagree with each other or
// with this file. Kept free of backticks: it is interpolated into template
// literals.
export function shapeKindWGSL() {
  return `
// ---- Shape kinds (generated from src/shapes.js; do not edit by hand) ----
fn isLineShape(ft : f32) -> bool {
  return ${rangeTest(LINE_IDS)};
}
fn isVolumeShape(ft : f32) -> bool {
  return ${rangeTest(VOLUME_IDS)};
}
fn isSurfaceShape(ft : f32) -> bool {
  return !isLineShape(ft) && !isVolumeShape(ft);
}
`;
}
