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
// Apollonian bubble shell — a hierarchy of fully rounded spheres distributed
// over a spherical body. This is an implicit, shader-native packing rather than
// a literal finite Soddy list.
//
// The rejected prototype evaluated only one cubic cell, then projected that
// cell's sphere centre onto the shell. A projected sphere routinely extended
// outside the sole cell that knew about it, so cell boundaries sliced it into
// flat faces. It also left every centre on an exact cubic lattice.
//
// This version fixes both causes:
//   * each scale searches the complete 3x3x3 neighbourhood, so a sphere remains
//     visible across cell boundaries;
//   * every centre is deterministically jittered before a limited radial pull,
//     breaking rows and square rings without allowing a centre to escape the
//     searched neighbourhood;
//   * no sphere is intersected with a shell clip. Every visible bubble is a
//     complete sphere. The shell comes from where centres are admitted;
//   * finer scales sit progressively farther behind the coarse scale. Large
//     bubbles naturally occlude them, while the small bubbles show through the
//     irregular gaps — hierarchy without planar subtraction or centre culling.
//
// Five rotated frames prevent the residual statistics of one jittered lattice
// from lining up across scales. The matrices are constants, so this estimator
// performs no trigonometry.
const BS_LEVELS : i32 = 5;
const BS_CELL   : f32 = 0.72;
const BS_RATIO  : f32 = 0.55;
const BS_R      : f32 = 1.0;
const BS_CORE   : f32 = 0.88;
const BS_JITTER : f32 = 0.70;
const BS_BAND   : f32 = 0.46;
const BS_RADLO  : f32 = 0.18;
const BS_RADHI  : f32 = 0.07;

struct BSLevelHit {
  dist : f32,
  trap : f32,
};

fn bsHash33(p : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    hash13(p + vec3<f32>(17.17,  3.11,  9.43)),
    hash13(p + vec3<f32>(41.73, 23.57,  5.29)),
    hash13(p + vec3<f32>(11.91, 59.21, 31.07))
  );
}

// Exact union distance for the locally relevant spheres of one scale.
//
// Candidate centres begin inside neighbouring cells around q. Jitter moves a
// centre by at most 0.35 cell, the radial correction by less than 0.30 cell,
// and the radius is at most 0.25 cell. Therefore a sphere capable of reaching q
// must originate in this 3x3x3 neighbourhood.
fn bsNearestLevel(
  q : vec3<f32>,
  cs : f32,
  seed : f32,
  levelFrac : f32
) -> BSLevelHit {
  let base = floor(q / cs);

  var best = 1e9;
  var bestTrap = 0.5;

  for (var ix = -1; ix <= 1; ix = ix + 1) {
    for (var iy = -1; iy <= 1; iy = iy + 1) {
      for (var iz = -1; iz <= 1; iz = iz + 1) {
        let cell = base + vec3<f32>(f32(ix), f32(iy), f32(iz));
        let key = cell + vec3<f32>(seed, seed * 1.73, seed * 2.31);
        let jitter = (bsHash33(key) - vec3<f32>(0.5)) * BS_JITTER;
        let rawCentre = (cell + vec3<f32>(0.5) + jitter) * cs;
        let rawR = length(rawCentre);

        // Keep one irregular layer of candidate cells around the host sphere.
        // Cells farther away produce no bubble at this scale.
        if (abs(rawR - BS_R) <= cs * BS_BAND) {
          let h = hash13(key + vec3<f32>(13.37));
          let rad = cs * (BS_RADLO + BS_RADHI * h);
          let dir = rawCentre / max(rawR, 1e-6);

          // Coarse bubbles sit slightly proud of the shell. Finer bubbles sit
          // farther back, so they become visible mainly through coarse gaps.
          let radialLayer = mix(0.20, -0.38, levelFrac);
          let targetR = BS_R + rad * (radialLayer + (h - 0.5) * 0.12);

          // Pull only partway to the target radius. A full projection was the
          // source of the old cell-boundary truncation.
          let centre = rawCentre + dir * (targetR - rawR) * 0.55;
          let sd = length(q - centre) - rad;

          if (sd < best) {
            best = sd;
            bestTrap = h;
          }
        }
      }
    }
  }

  var hit : BSLevelHit;
  hit.dist = best;
  hit.trap = bestTrap;
  return hit;
}

fn deBubbleShell(pos : vec3<f32>) -> DEResult {
  let r = length(pos);

  var res : DEResult;

  // Conservative spherical envelope around every possible bubble. Outside it,
  // this under-estimate is safe and avoids running the neighbourhood searches.
  let envelope = abs(r - BS_R) - 0.44;
  if (envelope > 0.12) {
    res.dist = envelope * 0.85;
    res.trap = 0.45;
    return res;
  }

  // Constant orthonormal frames. WGSL matrices are column-major.
  var frames = array<mat3x3<f32>, 5>(
    mat3x3<f32>(
      vec3<f32>( 1.0,         0.0,         0.0),
      vec3<f32>( 0.0,         1.0,         0.0),
      vec3<f32>( 0.0,         0.0,         1.0)),
    mat3x3<f32>(
      vec3<f32>( 0.76484219,  0.59336378,  0.25087018),
      vec3<f32>(-0.64421769,  0.70446631,  0.29784358),
      vec3<f32>( 0.0,        -0.38941834,  0.92106099)),
    mat3x3<f32>(
      vec3<f32>( 0.67189980, -0.31150831,  0.67194735),
      vec3<f32>(-0.72424288, -0.08647958,  0.68410053),
      vec3<f32>(-0.15499327, -0.94630009, -0.28371329)),
    mat3x3<f32>(
      vec3<f32>( 0.37361601,  0.53657955,  0.75663298),
      vec3<f32>(-0.74398487, -0.31381737,  0.58991963),
      vec3<f32>( 0.55398338, -0.78332691,  0.28195987)),
    mat3x3<f32>(
      vec3<f32>(-0.01377127, -0.33368820, -0.94258291),
      vec3<f32>( 0.55086751, -0.78924681,  0.27135671),
      vec3<f32>(-0.83447908, -0.51550137,  0.19468692))
  );
  var seeds = array<f32, 5>(0.0, 7.13, 3.71, 9.37, 5.51);

  // The dark body is deliberately recessed. It closes the object and provides
  // the thin dark interstices without slicing the visible fronts of bubbles.
  var d = r - BS_CORE;
  var trapV = 0.5;
  var cs = BS_CELL;

  for (var lvl = 0; lvl < BS_LEVELS; lvl = lvl + 1) {
    let levelFrac = f32(lvl) / f32(BS_LEVELS - 1);
    let hit = bsNearestLevel(frames[lvl] * pos, cs, seeds[lvl], levelFrac);
    if (hit.dist < d) {
      d = hit.dist;
      trapV = hit.trap;
    }
    cs = cs * BS_RATIO;
  }

  // The neighbourhood search is exact near every candidate sphere. This small
  // positive cap only protects empty shell gaps from a long step toward an
  // unexamined distant cell; it never wins at a sphere surface or inside solid.
  if (d > 0.0) {
    d = min(d, max(abs(r - BS_R) - 0.44, 0.006));
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

Write-Host "Replaced deBubbleShell implementation."
git diff --check
git diff --stat
