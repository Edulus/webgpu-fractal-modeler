$ErrorActionPreference = "Stop"

$repo = "J:\Users\Mr. Edwards\Documents\kimi\workspace\webgpu-fractal-modeler"
Set-Location -LiteralPath $repo

$expectedBranch = "feature/apollonian-bubble-shell-sol"
$currentBranch = (git branch --show-current).Trim()
if ($currentBranch -ne $expectedBranch) {
    throw "Expected branch '$expectedBranch' but current branch is '$currentBranch'."
}

$path = Join-Path $repo "src\shaders\fractal.wgsl.js"
$text = [System.IO.File]::ReadAllText($path)

$startMarker = "// Apollonian bubble shell —"
$endMarker = "// ---- Penrose quasicrystal"

$start = $text.IndexOf($startMarker, [System.StringComparison]::Ordinal)
$end = $text.IndexOf($endMarker, $start, [System.StringComparison]::Ordinal)

if ($start -lt 0 -or $end -lt 0 -or $end -le $start) {
    throw "Could not locate the existing bubble-shell estimator block."
}

$newBlock = @'
// Apollonian-style bubble shell — a hierarchy of complete spheres distributed
// by spherical Fibonacci point sets.
//
// This replaces the rejected cubic-cell construction. The former estimator
// projected one cell's centre onto the host sphere but evaluated that sphere
// only inside its original cell. Cell boundaries therefore sliced bubbles into
// planes, while integer lattice centres exposed square and cubic groupings.
//
// Spherical Fibonacci sets have no rows, square cells, poles, or preferred
// longitude. The inverse map below finds the nearest point of a set in constant
// time by testing four candidates. Each scale is therefore the exact union of
// equal-radius spheres at that level, without enumerating the whole set.
//
// Four independently rotated levels form a phi-like size cascade. Finer levels
// sit progressively farther behind the coarse level: large bubbles occlude
// them where they overlap, while small bubbles appear through irregular gaps.
// No shell intersection is applied, so every visible bubble remains round.
//
// This is a shader-native Apollonian-style hierarchy, not a literal
// Soddy-Gosset packing.
const BS_LEVELS : i32 = 4;
const BS_TAU    : f32 = 6.28318530718;
const BS_PHI    : f32 = 1.61803398875;
const BS_ROOT5  : f32 = 2.23606797750;
const BS_CORE   : f32 = 0.875;

struct BSFibHit {
  dir   : vec3<f32>,
  id    : f32,
  dist2 : f32,
};

fn bsFibPoint(id : f32, count : f32) -> vec3<f32> {
  let az = BS_TAU * fract(id * BS_PHI);
  let z = 1.0 - (2.0 * id + 1.0) / count;
  let rr = sqrt(max(1.0 - z * z, 0.0));
  return vec3<f32>(cos(az) * rr, sin(az) * rr, z);
}

// Constant-time inverse spherical-Fibonacci map.
//
// The local Fibonacci basis brackets the query in lattice coordinates. Its
// four cell corners are the only candidates that can be nearest.
fn bsNearestFib(n : vec3<f32>, count : f32) -> BSFibHit {
  let sin2 = max(1.0 - n.z * n.z, 1e-8);
  let numer = max(count * BS_TAU * 0.5 * BS_ROOT5 * sin2, 1e-8);
  let k = max(2.0, floor(log2(numer) / log2(BS_PHI + 1.0)));

  let fk = pow(BS_PHI, k) / BS_ROOT5;
  let fib = round(vec2<f32>(fk, fk * BS_PHI));

  let colA = 2.0 * fib / count;
  let colB = (fract((fib + vec2<f32>(1.0)) * BS_PHI)
            - vec2<f32>(BS_PHI - 1.0)) * BS_TAU;

  let v = vec2<f32>(
    atan2(n.y, n.x),
    n.z - 1.0 + 1.0 / count
  );

  let det = colA.x * colB.y - colA.y * colB.x;
  let invDet = 1.0 / select(
    det,
    select(-1e-8, 1e-8, det >= 0.0),
    abs(det) < 1e-8
  );

  let base = floor(vec2<f32>(
    (v.x * colB.y - colB.x * v.y) * invDet,
    (colA.x * v.y - v.x * colA.y) * invDet
  ));

  var best : BSFibHit;
  best.dir = vec3<f32>(0.0, 0.0, 1.0);
  best.id = 0.0;
  best.dist2 = 8.0;

  for (var s = 0; s < 4; s = s + 1) {
    var corner = vec2<f32>(0.0);
    if (s == 1) {
      corner = vec2<f32>(1.0, 0.0);
    } else if (s == 2) {
      corner = vec2<f32>(0.0, 1.0);
    } else if (s == 3) {
      corner = vec2<f32>(1.0, 1.0);
    }

    let id = round(clamp(dot(fib, base + corner), 0.0, count - 1.0));
    let q = bsFibPoint(id, count);
    let delta = q - n;
    let d2 = dot(delta, delta);

    if (d2 < best.dist2) {
      best.dir = q;
      best.id = id;
      best.dist2 = d2;
    }
  }

  return best;
}

fn deBubbleShell(pos : vec3<f32>) -> DEResult {
  let r = length(pos);

  var res : DEResult;

  // All bubbles lie inside radius 1.36. Outside that ball, this is a safe
  // lower bound and avoids the inverse-map work.
  let outer = r - 1.36;
  if (outer > 0.20) {
    res.dist = outer;
    res.trap = 0.45;
    return res;
  }

  // Counts grow by approximately phi^2 while radii shrink by approximately
  // 1/phi. The resulting levels read as one continuous recursive hierarchy.
  var counts = array<f32, 4>(24.0, 64.0, 168.0, 440.0);
  var radii = array<f32, 4>(0.270, 0.165, 0.101, 0.062);

  // Constant orthonormal frames; WGSL matrices are column-major.
  var frames = array<mat3x3<f32>, 4>(
    mat3x3<f32>(
      vec3<f32>( 1.0,         0.0,         0.0),
      vec3<f32>( 0.0,         1.0,         0.0),
      vec3<f32>( 0.0,         0.0,         1.0)),
    mat3x3<f32>(
      vec3<f32>( 0.55092617,  0.83416556,  0.02545943),
      vec3<f32>(-0.51344583,  0.31474090,  0.79831795),
      vec3<f32>( 0.65791621, -0.45288629,  0.60169783)),
    mat3x3<f32>(
      vec3<f32>( 0.07069068,  0.11588730, -0.99074364),
      vec3<f32>( 0.98270547,  0.16232783,  0.08910463),
      vec3<f32>( 0.17115136, -0.97990806, -0.10240802)),
    mat3x3<f32>(
      vec3<f32>( 0.10726108, -0.66037687,  0.74323445),
      vec3<f32>(-0.95727725,  0.13331762,  0.25660606),
      vec3<f32>(-0.26854296, -0.73900528, -0.61786396))
  );

  // Recessed host body: it closes the shell and supplies dark interstices
  // without intersecting the visible fronts of the bubbles.
  var d = r - BS_CORE;
  var trapV = 0.5;

  if (r > 1e-7) {
    for (var lvl = 0; lvl < BS_LEVELS; lvl = lvl + 1) {
      let q = frames[lvl] * pos;
      let n = q / r;
      let hit = bsNearestFib(n, counts[lvl]);
      let levelFrac = f32(lvl) / f32(BS_LEVELS - 1);

      // Coarse bubbles sit proud. Finer bubbles recede behind them and become
      // visible primarily in the gaps, creating the interstitial hierarchy.
      let layer = mix(0.28, -0.55, levelFrac);
      let centreR = 1.0 + radii[lvl] * layer;
      let sphereD = length(q - hit.dir * centreR) - radii[lvl];

      if (sphereD < d) {
        d = sphereD;
        trapV = fract(
          hit.id * 0.61803399
          + f32(lvl) * 0.217
          + hit.dir.z * 0.11
        );
      }
    }
  }

  res.dist = d;
  res.trap = trapV;
  return res;
}
'@

$newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
$newBlock = ($newBlock -replace "`r`n", "`n") -replace "`n", $newline

$updated = $text.Substring(0, $start) + $newBlock + $newline + $newline + $text.Substring($end)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($path, $updated, $utf8NoBom)

Write-Host "Replaced the rejected cubic estimator with a spherical-Fibonacci hierarchy."
git diff --check
node --check src/shaders/fractal.wgsl.js
git diff --stat
git status --short
