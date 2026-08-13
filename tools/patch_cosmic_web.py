from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one occurrence, found {count}: {old[:120]!r}")
    p.write_text(s.replace(old, new, 1))


# --- UI registration + wall note -------------------------------------------
replace_once(
    "index.html",
    '        <option value="engel">Engel plesiohedron tiling (38 faces)</option>\n'
    '        <option value="attractor">Strange attractor (Aizawa)</option>',
    '        <option value="engel">Engel plesiohedron tiling (38 faces)</option>\n'
    '        <option value="cosmicweb">Cosmic Web</option>\n'
    '        <option value="attractor">Strange attractor (Aizawa)</option>',
)

replace_once(
    "index.html",
    "        engel: ['Engel plesiohedron',\n"
    "          'Space filled with copies of one 38-faced solid, which is the most faces such a shape can have. Each is the region of space closest to one point of a repeating pattern, and they are drawn shrunk a little so the joints between them show.'],\n"
    "        rossler: ['Rössler attractor',",
    "        engel: ['Engel plesiohedron',\n"
    "          'Space filled with copies of one 38-faced solid, which is the most faces such a shape can have. Each is the region of space closest to one point of a repeating pattern, and they are drawn shrunk a little so the joints between them show.'],\n"
    "        cosmicweb: ['Cosmic Web',\n"
    "          'A hierarchical volumetric web of filaments and dense knots surrounding vast voids, inspired by the multifractal large-scale structure of the universe.'],\n"
    "        rossler: ['Rössler attractor',",
)

# --- Renderer registration --------------------------------------------------
replace_once(
    "src/fractal-bg.js",
    "  attractor: 25, lorenz: 26, rossler: 27,\n};",
    "  attractor: 25, lorenz: 26, rossler: 27,\n"
    "  // Volumetric density field. Kept after the line attractors so their\n"
    "  // established ids remain stable.\n"
    "  cosmicweb: 28,\n};\n\n"
    "function isAttractorType(id) {\n"
    "  return id >= FRACTAL_IDS.attractor && id <= FRACTAL_IDS.rossler;\n"
    "}",
)

replace_once(
    "src/fractal-bg.js",
    "// hyp435o, kleinpack, engel, attractor(Aizawa), lorenz, rossler\n",
    "// hyp435o, kleinpack, engel, attractor(Aizawa), lorenz, rossler, cosmicweb\n",
)

replace_once(
    "src/fractal-bg.js",
    "                    2.3, 3.0, 3.2, 3.0, 3.0];",
    "                    2.3, 3.0, 3.2, 3.0, 3.0, 6.2];",
)

# An animated volumetric field should keep flowing rather than entering the
# still-image accumulation path and freezing its geometry clock.
replace_once(
    "src/fractal-bg.js",
    "  function accumulating(nowMs) {\n"
    "    if (!state.accumOn || !state.controls) return false;",
    "  function accumulating(nowMs) {\n"
    "    if (state.fractalType === FRACTAL_IDS.cosmicweb) return false;\n"
    "    if (!state.accumOn || !state.controls) return false;",
)

for old in [
    "if (state.fractalType >= FRACTAL_IDS.attractor && state.trajBuffer)",
    "if (state.fractalType >= FRACTAL_IDS.attractor) ensureAttractorTrajectory();",
]:
    p = Path("src/fractal-bg.js")
    s = p.read_text()
    if old.endswith("state.trajBuffer)"):
        expected = 1
        new = "if (isAttractorType(state.fractalType) && state.trajBuffer)"
    else:
        expected = 2
        new = "if (isAttractorType(state.fractalType)) ensureAttractorTrajectory();"
    count = s.count(old)
    if count != expected:
        raise SystemExit(f"src/fractal-bg.js: expected {expected} occurrences of {old!r}, found {count}")
    p.write_text(s.replace(old, new))

# --- Volumetric Cosmic Web material ----------------------------------------
material_marker = "};\n\n@fragment\nfn fs_material(in : VSOut) -> MaterialOut {"
cosmic_wgsl = r'''

// ---------------------------------------------------------------------------
// Cosmic Web — a bounded volumetric multifractal density field.
//
// The low-frequency fBm establishes broad void domains and gently warps three
// nested families of quasi-periodic zero surfaces. Intersections of two surfaces
// form filaments; intersections of all three form knots. Successively smaller
// families are allowed to survive mainly near their parents, producing a
// large-void -> backbone -> branch -> fine-thread hierarchy instead of a uniform
// lattice. The weights are strongly nonlinear so matter is intermittent: most
// of the volume is empty and a small fraction carries most of the emission.
struct CosmicWebSample {
  density : f32,
  coord   : f32,
  knot    : f32,
};

fn webHash31(p : vec3<f32>) -> f32 {
  var q = fract(p * 0.1031);
  let h = dot(q, q.yzx + vec3<f32>(33.33));
  q = q + vec3<f32>(h);
  return fract((q.x + q.y) * q.z);
}

fn webNoise3(p : vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u3 = f * f * (vec3<f32>(3.0) - 2.0 * f);

  let n000 = webHash31(i + vec3<f32>(0.0, 0.0, 0.0));
  let n100 = webHash31(i + vec3<f32>(1.0, 0.0, 0.0));
  let n010 = webHash31(i + vec3<f32>(0.0, 1.0, 0.0));
  let n110 = webHash31(i + vec3<f32>(1.0, 1.0, 0.0));
  let n001 = webHash31(i + vec3<f32>(0.0, 0.0, 1.0));
  let n101 = webHash31(i + vec3<f32>(1.0, 0.0, 1.0));
  let n011 = webHash31(i + vec3<f32>(0.0, 1.0, 1.0));
  let n111 = webHash31(i + vec3<f32>(1.0, 1.0, 1.0));

  let nx00 = mix(n000, n100, u3.x);
  let nx10 = mix(n010, n110, u3.x);
  let nx01 = mix(n001, n101, u3.x);
  let nx11 = mix(n011, n111, u3.x);
  let nxy0 = mix(nx00, nx10, u3.y);
  let nxy1 = mix(nx01, nx11, u3.y);
  return mix(nxy0, nxy1, u3.z);
}

// Three octaves are enough to give the void scaffold a scale-free character
// without making every ray sample prohibitively expensive.
fn webFbm3(p0 : vec3<f32>) -> f32 {
  var p = p0;
  var amp = 0.57;
  var sum = 0.0;
  var norm = 0.0;
  for (var i = 0; i < 3; i = i + 1) {
    sum = sum + amp * webNoise3(p);
    norm = norm + amp;
    p = p * 2.03 + vec3<f32>(13.7, -9.2, 5.1);
    amp = amp * 0.52;
  }
  return sum / max(norm, 1e-5);
}

// Three differently oriented, incommensurate wave surfaces. Their pairwise
// intersections are one-dimensional curves, so sharpening the two closest
// surfaces produces filaments rather than cloud blobs or broad sheets.
fn webWave(p : vec3<f32>, scale : f32, phase : f32) -> vec3<f32> {
  let q = p * scale;
  let a = sin(
    dot(q, vec3<f32>(0.91, 0.37, 0.18))
    + 0.45 * sin(dot(q, vec3<f32>(-0.23, 0.79, 0.52)) * 0.71 + phase * 0.41)
    + phase
  );
  let b = sin(
    dot(q, vec3<f32>(0.31, 0.96, -0.27)) * 1.07
    + 0.42 * sin(dot(q, vec3<f32>(0.68, -0.19, 0.71)) * 0.67 - phase * 0.37)
    - phase * 0.83
  );
  let c = sin(
    dot(q, vec3<f32>(-0.41, 0.24, 0.88)) * 0.94
    + 0.39 * sin(dot(q, vec3<f32>(0.56, 0.73, 0.21)) * 0.73 + phase * 0.29)
    + phase * 0.61
  );
  return vec3<f32>(a, b, c);
}

// x = filament support (two surfaces near zero), y = knot support (all three).
fn webFilament(w : vec3<f32>, sharpness : f32) -> vec2<f32> {
  let v = abs(w);
  let pair = min(v.x + v.y, min(v.y + v.z, v.z + v.x));
  let filament = exp(-sharpness * pair);
  let knot = exp(-sharpness * 0.72 * (v.x + v.y + v.z));
  return vec2<f32>(filament, knot);
}

fn cosmicWebSampleAt(p : vec3<f32>, tm : f32) -> CosmicWebSample {
  // Burgers/adhesion-inspired visual motion: a very slow drift plus a spatially
  // varying deformation. It changes local convergence instead of simply
  // wobbling the entire volume in place.
  let drift = tm * vec3<f32>(0.013, -0.007, 0.010);
  let low = webFbm3((p + drift * 0.45) * 0.22
                    + vec3<f32>(tm * 0.0017, -tm * 0.0011, tm * 0.0013));
  let warp = low - 0.5;

  var q = p + drift + vec3<f32>(0.72, -0.46, 0.58) * warp;
  q = q + 0.10 * vec3<f32>(
    sin(q.y * 0.42 + tm * 0.013),
    sin(q.z * 0.37 - tm * 0.011),
    sin(q.x * 0.39 + tm * 0.009)
  );

  let phase = tm * 0.017;
  let wm = webWave(q, 0.78, phase);
  let ws = webWave(q + vec3<f32>(2.7, -1.8, 4.1), 1.56, -phase * 1.13);
  let wf = webWave(q + vec3<f32>(-3.4, 2.2, 1.6), 3.08, phase * 1.31);

  let majorPair = webFilament(wm, 4.7);
  let secondaryPair = webFilament(ws, 5.8);
  let finePair = webFilament(wf, 7.1);

  let major = pow(majorPair.x, 1.35);
  let branchSupport = mix(0.10, 1.0, smoothstep(0.12, 0.62, major));
  let branch = pow(secondaryPair.x, 1.55) * branchSupport;
  let threadParent = max(major, branch);
  let thread = pow(finePair.x, 1.9)
               * mix(0.035, 0.70, smoothstep(0.07, 0.52, threadParent));

  // Three-way intersections become compact high-density knots. Secondary/fine
  // knots matter mainly where a parent filament already exists.
  let knot = max(
    pow(majorPair.y, 1.10),
    max(pow(secondaryPair.y, 1.25) * major,
        pow(finePair.y, 1.45) * branch)
  );

  // A broad low-frequency gate creates genuine large empty domains. The sphere
  // fade gives Shape Viewer a finite object to orbit while Fly mode can enter it.
  let voidGate = smoothstep(0.36, 0.59, low);
  let bound = 1.0 - smoothstep(4.8, 5.7, length(p));

  // Power-law-like intermittency: faint branches are common, strong matter is
  // rare, and the small high-density tail carries the bright knots.
  let hierarchy = 1.35 * major + 0.72 * branch + 0.22 * thread + 1.85 * knot;
  let density = bound * voidGate * pow(max(hierarchy, 0.0), 1.45);

  // One palette coordinate per accumulated ray sample. It varies across scales
  // and shifts a little at knots, while the live global colour-cycle phase is
  // still applied later in the composite pass exactly like every other shape.
  let coord = 0.15 + 0.52 * low + 0.13 * (0.5 + 0.5 * wm.z)
              + 0.09 * branch + 0.31 * knot;

  var s : CosmicWebSample;
  s.density = density;
  s.coord = coord;
  s.knot = knot;
  return s;
}

fn cosmicWebMaterial(ro : vec3<f32>, rd : vec3<f32>) -> MaterialOut {
  var out : MaterialOut;
  out.material = vec4<f32>(0.0);
  out.aux = vec4<f32>(0.0);

  // Intersect the bounded volume first so empty screen-space rays do no density
  // work. This also gives each quality rung a known finite integration span.
  let radius = 5.7;
  let b = dot(ro, rd);
  let c = dot(ro, ro) - radius * radius;
  let h = b * b - c;
  if (h <= 0.0) {
    out.aux.w = 1.0;
    return out;
  }

  let root = sqrt(max(h, 0.0));
  let t0 = max(0.02, -b - root);
  let t1 = -b + root;
  if (t1 <= t0) {
    out.aux.w = 1.0;
    return out;
  }

  var stepCount = i32(u.detail.x * 0.30);
  stepCount = max(28, min(stepCount, 88));
  let dt = (t1 - t0) / f32(stepCount);
  let tm = select(u.time, 0.0, u.reducedMotion > 0.5);

  var transmittance = 1.0;
  var indexWeight = 0.0;
  var paletteWeight = 0.0;
  var glow = 0.0;

  for (var i = 0; i < 88; i = i + 1) {
    if (i >= stepCount) { break; }
    let t = t0 + (f32(i) + 0.5) * dt;
    let s = cosmicWebSampleAt(ro + rd * t, tm);

    if (s.density > 0.0005) {
      let alpha = 1.0 - exp(-s.density * dt * 1.45);
      let brightness = 0.66 + 1.75 * s.knot + 0.22 * sqrt(max(s.density, 0.0));
      let w = transmittance * alpha * brightness;
      paletteWeight = paletteWeight + w;
      indexWeight = indexWeight + s.coord * w;
      glow = glow + w * (0.20 + 2.9 * s.knot + 0.20 * s.density);
      transmittance = transmittance * (1.0 - alpha * 0.88);
    }

    if (transmittance < 0.015) { break; }
  }

  out.material = vec4<f32>(
    indexWeight,
    min(paletteWeight, 7.0),
    0.0,
    clamp(glow * 1.2, 0.0, 8.0)
  );
  // In opaque mode the composite pass uses this as the amount of backdrop that
  // remains visible through the volume. Transparent mode ignores it.
  out.aux.w = clamp(transmittance, 0.0, 1.0);
  return out;
}
'''

p = Path("src/shaders/material.wgsl.js")
s = p.read_text()
if s.count(material_marker) != 1:
    raise SystemExit("material shader insertion marker was not unique")
s = s.replace(material_marker, "};" + cosmic_wgsl + "\n\n@fragment\nfn fs_material(in : VSOut) -> MaterialOut {", 1)

old_attractor = "  if (u.fractalType > 24.5) {\n    out.aux.w = 1.0;\n    return out;\n  }"
new_attractor = (
    "  if (abs(u.fractalType - 28.0) < 0.5) {\n"
    "    return cosmicWebMaterial(ro, rd);\n"
    "  }\n\n"
    "  if (u.fractalType > 24.5 && u.fractalType < 27.5) {\n"
    "    out.aux.w = 1.0;\n"
    "    return out;\n"
    "  }"
)
if s.count(old_attractor) != 1:
    raise SystemExit("material shader attractor marker was not unique")
p.write_text(s.replace(old_attractor, new_attractor, 1))

# Composite must reserve attractor reconstruction for ids 25..27; Cosmic Web
# stores the same material summary as the raymarched surfaces and resolves via
# the normal palette path.
replace_once(
    "src/shaders/composite.wgsl.js",
    "  if (u.fractalType > 24.5) {",
    "  if (u.fractalType > 24.5 && u.fractalType < 27.5) {",
)

# --- Focused regression test ------------------------------------------------
Path("tools/cosmicweb.test.js").write_text(r'''import fs from 'node:fs';

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}

console.log('\nCosmic Web registration and render routing');
const index = fs.readFileSync('index.html', 'utf8');
const bg = fs.readFileSync('src/fractal-bg.js', 'utf8');
const material = fs.readFileSync('src/shaders/material.wgsl.js', 'utf8');
const composite = fs.readFileSync('src/shaders/composite.wgsl.js', 'utf8');

ok(index.includes('<option value="cosmicweb">Cosmic Web</option>'),
   'selector exposes Cosmic Web');
ok(index.includes("cosmicweb: ['Cosmic Web'"),
   'Shape Viewer has a Cosmic Web note');
ok(bg.includes('cosmicweb: 28'),
   'Cosmic Web has a stable id after the existing attractors');
ok(bg.includes('return id >= FRACTAL_IDS.attractor && id <= FRACTAL_IDS.rossler;'),
   'attractor routing excludes Cosmic Web');
ok(bg.includes('state.fractalType === FRACTAL_IDS.cosmicweb) return false;'),
   'animated Cosmic Web does not freeze into progressive accumulation');
ok(material.includes('fn cosmicWebSampleAt(') && material.includes('fn cosmicWebMaterial('),
   'material shader contains the hierarchical volume field');
ok(material.includes('return cosmicWebMaterial(ro, rd);'),
   'Cosmic Web routes through the volumetric material path');
ok(material.includes('u.fractalType > 24.5 && u.fractalType < 27.5'),
   'material attractor path remains limited to ids 25..27');
ok(composite.includes('u.fractalType > 24.5 && u.fractalType < 27.5'),
   'composite attractor reconstruction excludes Cosmic Web');
ok(material.includes('webFbm3') && material.includes('webFilament') && material.includes('voidGate'),
   'field contains fBm hierarchy, filament extraction, and void gating');
ok(material.includes('stepCount = max(28, min(stepCount, 88));'),
   'volume integration scales with the adaptive detail rung');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
''')

print("Cosmic Web patch applied")
