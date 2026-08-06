#!/usr/bin/env python3
# preview-bubbleshell.py — CPU preview render of candidate deBubbleShell
# distance estimators, BEFORE the WGSL port (repo rule: validate the math on
# CPU first; the Penrose relief caught its candidate-search flaw this way).
#
# v1 (fold + inversion, shell-sliced) was rejected on CPU evidence: hemisphere
# caps without F, lattice artifacts with F, noise with rotation, sparse froth
# with small prim_r. Renders preserved in the handoff.
#
# v2 (this file): APOLLONIAN-STYLE OCTAVE REJECTION PACKING, descending from
# deSurfacePack's cellular machinery with its two reject-criteria fixed:
#   * grid overlap  -> per-level rotations (no shared axes) + radii capped at
#                      the kiss limit (<= 0.49 cell), so bubbles touch, not lap
#   * 3 flat sizes  -> 5 cascading octaves; an octave's sphere is CULLED when
#                      any coarser octave's sphere already covers its centre,
#                      so small bubbles only grow in the gaps between big ones
#                      (the Apollonian gap-filling rule, procedural form)
# Dark seams come free: where a bubble is culled, the solid core shows through.
#
# Usage:
#   python tools/preview-bubbleshell.py [out.png]

import sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def hash13(p):
    q = np.mod(p * 0.3183099 + np.array([0.1, 0.2, 0.3]), 1.0)
    q = q + np.sum(q * (q[..., [1, 2, 0]] + 19.19), axis=-1, keepdims=True)
    return np.mod((q[..., 0] + q[..., 1]) * q[..., 2], 1.0)


def rot2(v, axis, ang):
    """Rotate (..., 3) around 'x'|'y'|'z' by ang."""
    c, s = np.cos(ang), np.sin(ang)
    x, y, z = v[..., 0], v[..., 1], v[..., 2]
    if axis == "z":
        return np.stack([c * x - s * y, s * x + c * y, z], axis=-1)
    if axis == "x":
        return np.stack([x, c * y - s * z, s * y + c * z], axis=-1)
    return np.stack([c * x + s * z, y, -s * x + c * z], axis=-1)


# Per-level frames: distinct rotations so no two octaves share a lattice axis.
LEVEL_ROT = [
    (("z", 0.0), ("x", 0.0), ("y", 0.0)),
    (("z", 0.70), ("x", 0.40), ("y", 0.00)),
    (("z", 1.30), ("x", 1.90), ("y", 0.50)),
    (("z", 2.10), ("x", 0.90), ("y", 1.10)),
    (("z", 0.40), ("x", 2.60), ("y", 1.80)),
    (("z", 1.80), ("x", 0.30), ("y", 2.40)),
    (("z", 2.90), ("x", 1.40), ("y", 0.80)),
]
LEVEL_SEED = [0.0, 7.13, 3.71, 9.37, 5.51, 2.97, 8.23]


def frame(p, lvl):
    q = p
    for axis, ang in LEVEL_ROT[lvl % len(LEVEL_ROT)]:
        if ang:
            q = rot2(q, axis, ang)
    return q


def level_sphere(q, lvl, cs, radcap, rad_lo=0.36, rad_hi=0.13, R_proj=1.0):
    """Nearest sphere of octave lvl at frame-space point q.
    Returns (surface dist, centre, radius, hash).

    The cell centre is projected onto the shell mid-surface (radius R_proj):
    bubbles then sit ON the surface as proud domes of their full radius,
    instead of 3D-grid centres drifting below the surface and surfacing as
    flat sliced lenses.
    """
    cell = np.round(q / cs)
    centre = cs * cell
    centre = centre / np.maximum(np.linalg.norm(centre, axis=-1, keepdims=True), 1e-9) * R_proj
    h = hash13(cell + np.array([LEVEL_SEED[lvl % len(LEVEL_SEED)]] * 3))
    rad = cs * np.minimum(rad_lo + rad_hi * h, radcap)
    return np.linalg.norm(q - centre, axis=-1) - rad, centre, rad, h


def de_bubble_shell(p, R=1.0, shell_out=0.20, shell_in=0.03, base_cell=0.34,
                    ratio=0.55, levels=6, radcap=0.49, rad_lo=0.36, rad_hi=0.13,
                    cover=0.90):
    """p: (..., 3). Returns (dist, trap).

    Asymmetric shell: a generous outer bound lets bubbles protrude as ROUND
    DOMES (a symmetric thin shell slices every large cap flat at r = R+shell);
    a tight inner bound anchors them to the core. Dark seams are the core
    showing through where a bubble was culled by the gap-filling rule.
    """
    r = np.linalg.norm(p, axis=-1)
    shell_d = np.maximum(r - (R + shell_out), (R - shell_in) - r)
    d = r - R * 0.985                      # solid core under the shell
    trap = np.full(p.shape[:-1], 0.5)

    cs = [base_cell * (ratio ** l) for l in range(levels)]
    for lvl in range(levels):
        q = frame(p, lvl)
        surf, centre, rad, h = level_sphere(q, lvl, cs[lvl], radcap, rad_lo, rad_hi)
        # Gap-filling rule: cull if a coarser octave's sphere covers the centre.
        covered = np.zeros(p.shape[:-1], bool)
        for j in range(lvl):
            qc = frame(centre, j)
            _, _, bigrad, _ = level_sphere(qc, lvl=j, cs=cs[j], radcap=radcap,
                                           rad_lo=rad_lo, rad_hi=rad_hi)
            cellj = np.round(qc / cs[j]) * cs[j]
            dist_cc = np.linalg.norm(centre - cellj, axis=-1)
            covered |= dist_cc < bigrad + rad * cover
        cand = np.maximum(surf, shell_d)
        take = (~covered) & (cand < d)
        d = np.where(take, cand, d)
        trap = np.where(take, h, trap)
    return d, trap


def render(variant, res=300, max_steps=110, max_dist=30.0, eps=3.5e-4):
    shell_out, shell_in, base_cell, ratio, levels, radcap = variant
    kw = dict(shell_out=shell_out, shell_in=shell_in, base_cell=base_cell,
              ratio=ratio, levels=levels, radcap=radcap)
    cam = np.array([0.0, 0.45, 3.0])
    ta = np.zeros(3)
    fwd = (ta - cam) / np.linalg.norm(ta - cam)
    right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    focal = 1.0 / np.tan(1.05 / 2)

    ys, xs = np.mgrid[0:res, 0:res]
    uv = (np.stack([xs, ys], axis=-1) + 0.5) / res * 2 - 1
    uv[..., 1] *= -1
    rd = (uv[..., 0:1] * right + uv[..., 1:2] * up + focal * fwd)
    rd /= np.linalg.norm(rd, axis=-1, keepdims=True)

    t = np.full((res, res), 0.008)
    hit = np.zeros((res, res), bool)
    trap = np.zeros((res, res))
    alive = np.ones((res, res), bool)
    for _ in range(max_steps):
        p = cam + t[..., None] * rd
        d, tr = de_bubble_shell(p, **kw)
        newly = alive & (d < eps * t)
        hit |= newly
        trap = np.where(newly, tr, trap)
        step_ok = alive & ~newly
        t = np.where(step_ok, t + np.maximum(d * 0.9, 8e-4), t)
        alive = step_ok & (t <= max_dist)
        if not alive.any():
            break

    p = cam + t[..., None] * rd
    e = eps * t * 2
    k = np.array([[1, -1, -1], [-1, 1, -1], [-1, -1, 1], [1, 1, 1]])
    n = np.zeros((res, res, 3))
    for kk in k:
        n += kk * de_bubble_shell(p + kk * e[..., None], **kw)[0][..., None]
    n /= np.linalg.norm(n, axis=-1, keepdims=True) + 1e-9

    key = np.array([0.6, 0.7, -0.35]); key /= np.linalg.norm(key)
    diff = np.clip(np.sum(n * key, axis=-1), 0, 1)
    fres = np.clip(1 - np.sum(n * (-rd), axis=-1), 0, 1) ** 3

    a = np.array([0.5, 0.5, 0.5]); b = np.array([0.5, 0.5, 0.5])
    c = np.array([1.0, 1.0, 1.0]); dd = np.array([0.0, 0.33, 0.67])
    base = a + b * np.cos(2 * np.pi * (c * (trap[..., None] * 1.6) + dd))
    lit = base * (0.15 + 0.95 * diff[..., None]) + base * fres[..., None] * 0.6
    img = np.where(hit[..., None], lit, 0.02)
    return np.clip(img, 0, 1) ** (1 / 2.2)


VARIANTS = [
    # (shell_out, shell_in, base_cell, ratio, levels, radcap)
    (0.20, 0.03, 0.34, 0.55, 6, 0.49),
    (0.16, 0.03, 0.30, 0.55, 6, 0.49),
    (0.22, 0.04, 0.36, 0.58, 6, 0.49),
    (0.18, 0.03, 0.34, 0.55, 7, 0.49),
]

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "preview-bubbleshell.png"
    # Optional: render a single variant index per invocation (v2 DE is ~15x
    # the v1 cost per evaluation; the full grid can exceed shell timeouts).
    if len(sys.argv) > 2:
        i = int(sys.argv[2])
        fig, ax = plt.subplots(figsize=(6, 6), facecolor="black")
        v = VARIANTS[i]
        ax.imshow(render(v))
        ax.set_title(f"out={v[0]} in={v[1]} cell={v[2]} ratio={v[3]} lvls={v[4]}",
                     color="white", fontsize=10)
        ax.axis("off")
        fig.tight_layout()
        fig.savefig(out, dpi=110, facecolor="black", bbox_inches="tight")
        print("wrote", out)
        sys.exit(0)
    fig, axes = plt.subplots(2, 2, figsize=(11, 11), facecolor="black")
    for ax, v in zip(axes.ravel(), VARIANTS):
        img = render(v)
        ax.imshow(img)
        ax.set_title(f"out={v[0]} in={v[1]} cell={v[2]} ratio={v[3]} lvls={v[4]}",
                     color="white", fontsize=10)
        ax.axis("off")
    fig.tight_layout()
    fig.savefig(out, dpi=110, facecolor="black", bbox_inches="tight")
    print("wrote", out)
