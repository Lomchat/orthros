"""Le M (the owner's brother, Half Strike r9): models/others/lem.mdl.

Source (when installed): his AI reconstruction rigged with 22 clips, `rigged/lem_rigged.glb` under $LEM_DIR
(default /srv/orthros/data/installers/le-m; never copied into the repository), imported by `official.Importer`
(height 72, facing +x, origin on the ground, the file's 24 joints), then converted for the studio format:

* geometry: the 31k-triangle scan is welded and decimated (quadric edge collapse with per-vertex importance: the
  face x10, the head x6, the hands x2.5; open / non-manifold edges locked) to 7200 triangles; smooth normals;
* skinning: every kept vertex takes the bone weights of the closest same-facing point of the source surface
  (barycentric), 4 bones, 255 total; the T-shirt's vertices keep at most 0.2 on the legs (the hem rides on the
  hips), the change spread over the trousers' top by smoothing;
* textures: the scan's 2048 atlas is hundreds of small islands, so the model gets its own UV charts and the
  colours are re-baked from the source surface (closest same-facing point, bilinear, 2x supersampled): one
  512x512 texture for the head and neck (the face's charts at twice the density, ~36 texels/unit: glasses,
  moustache and eyes stay crisp, its own 256-colour palette, unsharp-masked) and one 1024x512 for the body;
  the cap's texels moved from the scan's dull brown-grey to olive khaki (the photos white-balanced on his T-shirt);
  the T-shirt repainted plain white with its soft shading (the scan's specks cleaned) and a round crew neck drawn
  in model space; the glasses' rims a little darker and wider, the upper eyelids a touch lighter;
* skin family 1 = his hologram (the server shows it the first ~0.55 s of his materialisation, additive): a green
  lattice (planes every 1.6 units along x, y, z, triplanar: the same model-space lattice on head and body, lines
  antialiased against the texel size) over a dim green copy of his own shading; its two textures are additive +
  fullbright.
The conversion (~1 min) is cached in $LEM_DIR/cache, keyed by the source's hash and CONVERT_VERSION (same bytes
with or without the cache).

Sequences (Pokemon model contract): 0 idle (the calm idle clip, a 10 s loop at 15 fps), 1 walk and 2 run (the
in-place clips, strides lengthened 1.25 / 1.3 by leg IK so that the cadence stays natural; linearmovement from the
planted toes: 90 and 250 units/s at 37 / 30 fps, feet planted within ~1 unit), 3 attack "Hack" (authored: the hands
rise through the front, elbows down, palms out before the chest, thrust forward at 40 %, wrists fluttering "typing
in the air" while the code flows, back down through the front; slerped / arc-length paths, at most ~6 units per
frame; 1.1 s), 4 flinch (authored: a ~12 degree jolt back recovered by 0.3 s, the whole body glitched 2.5 units
sideways for two frames; 0.5 s),
5 die (the electrocution clip: arms out, shaking, head thrown back, 1.4 s, last frame held: the server dissolves
him into pixels), 6 spawn ACT_ARM ("compiling", 1.5 s: the bind A-pose with glitch jumps, looks at his right hand
then his left, settles into the idle), 7 victory (the victory clip's raised arms, most of its body twist
cancelled so that he faces the viewer, 2.4 s).  Every one-shot starts and ends exactly on the idle's first frame;
the standing sequences put the lowest sole point on z = 0 every frame, walk and run during their stance.  Attachment 0 = right hand (Hack bolt origin, in front of the palm), 1 = left
hand.  Hitboxes on the main bones, all group 0 (the chest box covers the shoulders and the neck, the head box the
face).

Without the source a simple stand-in built from scratch is produced (same skeleton, same sequences on procedural
clips, same skins: a figure in a white T-shirt, dark trousers, white shoes, an olive cap worn backwards, round
glasses and a moustache).
"""
import hashlib
import heapq
import math
import os
import sys
import time

import numpy as np
from PIL import Image, ImageFilter

from .. import builder, mdl, mesh as M, official, rig as R, sdf, texture as T, xform

MODEL_PATH = "models/others/lem.mdl"
HEIGHT = 72.0
FPS = 30.0
CONVERT_VERSION = 5          # bump when the conversion changes (cache key)

HEAD_BONES = ("Head", "head_end", "headfront")
HAND_BONES = ("LeftHand", "RightHand")
SIDES = (("Left", 1.0), ("Right", -1.0))
LEGS = [("LeftUpLeg", "LeftLeg", "LeftFoot"), ("RightUpLeg", "RightLeg", "RightFoot")]
ARMS = [("LeftArm", "LeftForeArm", "LeftHand"), ("RightArm", "RightForeArm", "RightHand")]

TARGET_TRIS = 7200
HEAD_TEX = (512, 512)
BODY_TEX = (1024, 512)
SS = 2                       # bake supersampling
CLIP_T0 = 1.0 / 30.0         # the rigged file's clips hold their first key one frame (t = 0 and 1/30 are equal):
#                              their cycles run from 1/30 to the end (which equals the start)


def lem_dir():
    return os.environ.get("LEM_DIR", "/srv/orthros/data/installers/le-m")


def source_path():
    p = os.path.join(lem_dir(), "rigged", "lem_rigged.glb")
    return p if os.path.isfile(p) else None


def _log(msg):
    print(f"  [lem] {msg}", file=sys.stderr)


# =====================================================================================================================
# geometry: weld, decimate
# =====================================================================================================================

def weld(pos, tol=1e-5):
    key = np.round(pos / tol).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    # keep the first occurrence order deterministic: renumber by first index
    order = np.argsort(first, kind="stable")
    rank = np.empty_like(order)
    rank[order] = np.arange(len(order))
    return pos[first[order]], rank[inv], first[order]


def decimate(V, F, target, importance, locked, min_dot=0.3):
    """Quadric edge collapse (mesh.decimate's algorithm) with per-vertex importance (quadrics scaled: important
    regions keep more triangles) and locked vertices (open / non-manifold edges: never moved).  Returns (V, F)."""
    V = [list(map(float, p)) for p in V]
    F = [list(map(int, f)) for f in F]
    nv, nfaces = len(V), len(F)
    vf = [set() for _ in range(nv)]
    for fi, (a, b, c) in enumerate(F):
        vf[a].add(fi)
        vf[b].add(fi)
        vf[c].add(fi)
    Q = [[0.0] * 10 for _ in range(nv)]
    Va = np.asarray(V)
    Fa = np.asarray(F)
    fn = np.cross(Va[Fa[:, 1]] - Va[Fa[:, 0]], Va[Fa[:, 2]] - Va[Fa[:, 0]])
    for fi, (a, b, c) in enumerate(F):
        n = fn[fi]
        ar = float(np.linalg.norm(n))
        if ar < 1e-12:
            continue
        nx, ny, nz = n / ar
        d = -(nx * V[a][0] + ny * V[a][1] + nz * V[a][2])
        k = (nx * nx, nx * ny, nx * nz, nx * d, ny * ny, ny * nz, ny * d, nz * nz, nz * d, d * d)
        for vtx in (a, b, c):
            w = ar * 0.5 * float(importance[vtx])
            q = Q[vtx]
            for i in range(10):
                q[i] += w * k[i]
    avg_edge2 = float(np.mean(np.sum((Va[Fa[:, 0]] - Va[Fa[:, 1]]) ** 2, axis=1)))
    reg = 1e-3 / max(avg_edge2, 1e-12)
    imp = [float(x) for x in importance]
    lock = [bool(x) for x in locked]
    alive_v = [True] * nv
    alive_f = [True] * nfaces
    stamp = [0] * nv

    def qerr(q, x, y, z):
        return (q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y
                + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9])

    def best(u, v):
        q = [Q[u][i] + Q[v][i] for i in range(10)]
        pu, pv = V[u], V[v]
        if lock[u] and lock[v]:
            return None, None
        if lock[u] or lock[v]:
            p = pu if lock[u] else pv
            el2 = sum((pu[i] - pv[i]) ** 2 for i in range(3))
            return qerr(q, *p) + reg * el2 * el2 * 1e-2 * max(imp[u], imp[v]), p
        mid = [(pu[i] + pv[i]) * 0.5 for i in range(3)]
        cands = [pu, pv, mid]
        a11, a12, a13, a22, a23, a33 = q[0], q[1], q[2], q[4], q[5], q[7]
        det = (a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13))
        scale = (abs(a11) + abs(a22) + abs(a33)) ** 3 + 1e-30
        el2 = sum((pu[i] - pv[i]) ** 2 for i in range(3))
        if abs(det) > 1e-6 * scale:
            b1, b2, b3 = -q[3], -q[6], -q[8]
            x = (b1 * (a22 * a33 - a23 * a23) - a12 * (b2 * a33 - a23 * b3) + a13 * (b2 * a23 - a22 * b3)) / det
            y = (a11 * (b2 * a33 - a23 * b3) - b1 * (a12 * a33 - a23 * a13) + a13 * (a12 * b3 - b2 * a13)) / det
            z = (a11 * (a22 * b3 - b2 * a23) - a12 * (a12 * b3 - b2 * a13) + b1 * (a12 * a23 - a22 * a13)) / det
            if sum(((x, y, z)[i] - mid[i]) ** 2 for i in range(3)) <= el2:
                cands.append([x, y, z])
        bc, bp = None, None
        for p in cands:
            c = qerr(q, p[0], p[1], p[2])
            if bc is None or c < bc:
                bc, bp = c, p
        # (a regularisation by the edge length, scaled by importance: important regions keep shorter edges)
        return bc + (reg * el2 * el2 * 1e-2 + 1e-9 * el2) * max(imp[u], imp[v]), bp

    heap = []

    def push(u, v):
        if u > v:
            u, v = v, u
        c, p = best(u, v)
        if c is not None:
            heapq.heappush(heap, (c, u, v, stamp[u], stamp[v], p))

    seen = set()
    for f in F:
        for a, b in ((f[0], f[1]), (f[1], f[2]), (f[2], f[0])):
            key = (min(a, b), max(a, b))
            if key not in seen:
                seen.add(key)
                push(*key)

    def nbrs(u):
        s = set()
        for fi in vf[u]:
            s.update(F[fi])
        s.discard(u)
        return s

    def fnorm(a, b, c):
        ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
        return (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)

    count = nfaces
    while count > target and heap:
        c, u, v, su, sv, p = heapq.heappop(heap)
        if not (alive_v[u] and alive_v[v]) or stamp[u] != su or stamp[v] != sv:
            continue
        shared = vf[u] & vf[v]
        if len(shared) != 2:
            continue
        opp = set()
        for fi in shared:
            opp.update(F[fi])
        opp -= {u, v}
        if (nbrs(u) & nbrs(v)) != opp:
            continue
        ok = True
        for w in (u, v):
            for fi in vf[w]:
                if fi in shared:
                    continue
                pts = [V[x] for x in F[fi]]
                n0 = fnorm(*pts)
                pts2 = [p if x == w else V[x] for x in F[fi]]
                n1 = fnorm(*pts2)
                l0 = math.sqrt(n0[0] ** 2 + n0[1] ** 2 + n0[2] ** 2)
                l1 = math.sqrt(n1[0] ** 2 + n1[1] ** 2 + n1[2] ** 2)
                if l1 < 1e-12 or l0 < 1e-12:
                    ok = False
                    break
                if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1) < min_dot:
                    ok = False
                    break
                e2 = max(sum((pts2[i][k] - pts2[(i + 1) % 3][k]) ** 2 for k in range(3)) for i in range(3))
                if l1 / max(e2, 1e-12) < 0.03:
                    ok = False
                    break
            if not ok:
                break
        if not ok:
            continue
        for fi in shared:
            alive_f[fi] = False
            for x in F[fi]:
                vf[x].discard(fi)
            count -= 1
        for fi in vf[v]:
            F[fi] = [u if x == v else x for x in F[fi]]
            vf[u].add(fi)
        vf[v] = set()
        alive_v[v] = False
        V[u] = list(p)
        Q[u] = [Q[u][i] + Q[v][i] for i in range(10)]
        imp[u] = max(imp[u], imp[v])
        lock[u] = lock[u] or lock[v]
        stamp[u] += 1
        for w in nbrs(u):
            push(u, w)
    faces = np.array([F[i] for i in range(nfaces) if alive_f[i]], dtype=np.int64).reshape(-1, 3)
    m = M.TriMesh(np.array(V), faces).compact()
    return m.verts, m.faces


# =====================================================================================================================
# closest points on the source surface
# =====================================================================================================================

def closest_on_triangles(p, a, b, c):
    """Ericson's closest point on triangles, vectorised (broadcasting (..., 3)); returns barycentrics (..., 3)."""
    ab, ac, ap = b - a, c - a, p - a
    d1 = np.einsum("...k,...k->...", ab, ap)
    d2 = np.einsum("...k,...k->...", ac, ap)
    bp = p - b
    d3 = np.einsum("...k,...k->...", ab, bp)
    d4 = np.einsum("...k,...k->...", ac, bp)
    cp = p - c
    d5 = np.einsum("...k,...k->...", ab, cp)
    d6 = np.einsum("...k,...k->...", ac, cp)
    vc = d1 * d4 - d3 * d2
    vb = d5 * d2 - d1 * d6
    va = d3 * d6 - d5 * d4
    with np.errstate(divide="ignore", invalid="ignore"):
        den = va + vb + vc
        den = np.where(np.abs(den) > 1e-20, den, 1e-20)
        v_in, w_in = vb / den, vc / den
        t_ab = d1 / np.where(np.abs(d1 - d3) > 1e-20, d1 - d3, 1e-20)
        t_ac = d2 / np.where(np.abs(d2 - d6) > 1e-20, d2 - d6, 1e-20)
        e_bc = (d4 - d3) + (d5 - d6)
        t_bc = (d4 - d3) / np.where(np.abs(e_bc) > 1e-20, e_bc, 1e-20)
    conds = [
        (d1 <= 0) & (d2 <= 0),
        (d3 >= 0) & (d4 <= d3),
        (vc <= 0) & (d1 >= 0) & (d3 <= 0),
        (d6 >= 0) & (d5 <= d6),
        (vb <= 0) & (d2 >= 0) & (d6 <= 0),
        (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0),
    ]
    one, zero = np.ones_like(d1), np.zeros_like(d1)
    v = np.select(conds, [zero, one, t_ab, zero, zero, 1 - t_bc], v_in)
    w = np.select(conds, [zero, zero, zero, one, t_ac, t_bc], w_in)
    return np.stack([1 - v - w, v, w], axis=-1)


class SurfaceIndex:
    """Uniform grid over the source triangles (each listed in the cells its box, grown by `margin`, overlaps):
    closest same-facing source point of query points."""

    def __init__(self, V, F, cell=0.6, margin=0.4):
        self.V, self.F = np.asarray(V, float), np.asarray(F, np.int64)
        self.A, self.B, self.C = (self.V[self.F[:, k]] for k in range(3))
        n = np.cross(self.B - self.A, self.C - self.A)
        self.fn = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        self.cell = cell
        self.lo = self.V.min(0) - 2 * cell - margin
        tl = np.minimum(np.minimum(self.A, self.B), self.C) - margin
        th = np.maximum(np.maximum(self.A, self.B), self.C) + margin
        self.dims = (np.ceil((self.V.max(0) + 2 * cell + margin - self.lo) / cell)).astype(np.int64) + 1
        i0 = np.floor((tl - self.lo) / cell).astype(np.int64)
        i1 = np.floor((th - self.lo) / cell).astype(np.int64)
        cells, tris = [], []
        span = i1 - i0 + 1
        for dx in range(int(span[:, 0].max())):
            for dy in range(int(span[:, 1].max())):
                for dz in range(int(span[:, 2].max())):
                    sel = (dx < span[:, 0]) & (dy < span[:, 1]) & (dz < span[:, 2])
                    ii = i0[sel] + (dx, dy, dz)
                    cells.append(self._cid(ii))
                    tris.append(np.nonzero(sel)[0])
        cells, tris = np.concatenate(cells), np.concatenate(tris)
        order = np.lexsort((tris, cells))
        self.cells, self.tris = cells[order], tris[order]

    def _cid(self, ii):
        d = self.dims
        ii = np.clip(ii, 0, d - 1)
        return (ii[..., 0] * d[1] + ii[..., 1]) * d[2] + ii[..., 2]

    def candidates(self, lo, hi):
        i0 = np.maximum(np.floor((np.asarray(lo) - self.lo) / self.cell).astype(np.int64), 0)
        i1 = np.minimum(np.floor((np.asarray(hi) - self.lo) / self.cell).astype(np.int64), self.dims - 1)
        g = np.stack(np.meshgrid(*[np.arange(i0[k], i1[k] + 1) for k in range(3)], indexing="ij"), -1).reshape(-1, 3)
        ids = self._cid(g)
        s = np.searchsorted(self.cells, ids, "left")
        e = np.searchsorted(self.cells, ids, "right")
        if not (e > s).any():
            return np.zeros(0, np.int64)
        return np.unique(np.concatenate([self.tris[a:b] for a, b in zip(s, e) if b > a]))

    def query(self, P, N, cand, facing=0.1):
        """Closest point of each query (P (K, 3), N (K, 3) unit) among the candidate triangles (C,): returns
        (triangle (K,), barycentrics (K, 3), distance (K,)).  Triangles facing away (dot < facing) only count
        when nothing else is near (penalised)."""
        A, B, Cc = self.A[cand][None], self.B[cand][None], self.C[cand][None]
        bary = closest_on_triangles(P[:, None, :], A, B, Cc)
        q = bary[..., 0:1] * A + bary[..., 1:2] * B + bary[..., 2:3] * Cc
        d2 = np.sum((q - P[:, None, :]) ** 2, axis=-1)
        dot = N @ self.fn[cand].T
        score = d2 + np.where(dot < facing, 25.0 + 25.0 * (facing - dot), 0.0)
        j = np.argmin(score, axis=1)
        k = np.arange(len(P))
        return cand[j], bary[k, j], np.sqrt(d2[k, j])

    def query_all(self, P, N, max_dist=0.4):
        """query() for many points, grouped by grid cell (each cell lists the triangles within the margin);
        points with no near candidate search a growing box."""
        P, N = np.asarray(P, float), np.asarray(N, float)
        K = len(P)
        tri = np.zeros(K, np.int64)
        bary = np.zeros((K, 3))
        dist = np.full(K, np.inf)
        cid = self._cid(np.floor((P - self.lo) / self.cell).astype(np.int64))
        order = np.argsort(cid, kind="stable")
        sc = cid[order]
        starts = np.nonzero(np.r_[True, sc[1:] != sc[:-1]])[0]
        ends = np.r_[starts[1:], K]
        cs = np.searchsorted(self.cells, sc[starts], "left")
        ce = np.searchsorted(self.cells, sc[starts], "right")
        for a, b, c0, c1 in zip(starts, ends, cs, ce):
            if c1 <= c0:
                continue
            cand = self.tris[c0:c1]
            for s0 in range(a, b, 256):
                ss = order[s0:min(b, s0 + 256)]
                tri[ss], bary[ss], dist[ss] = self.query(P[ss], N[ss], cand)
        far = np.nonzero(dist > max_dist)[0]
        for i in far:
            m = 2 * max_dist
            while True:
                cand = self.candidates(P[i] - m, P[i] + m)
                if len(cand):
                    t, bb, d = self.query(P[i:i + 1], N[i:i + 1], cand)
                    if d[0] <= m or m > 64:
                        tri[i], bary[i], dist[i] = t[0], bb[0], d[0]
                        break
                m *= 2
        return tri, bary, dist


# =====================================================================================================================
# conversion (cached under $LEM_DIR/cache: a pure function of the source file and this code's version)
# =====================================================================================================================

def _importance(imp, s, Vw, first):
    """Per welded vertex: decimation importance from its dominant source bone (and the face's front)."""
    main = s.bw_bones[first, 0]
    names = imp.bone_names
    w = np.ones(len(Vw))
    head = np.isin(main, [names.index(b) for b in HEAD_BONES])
    neck = main == names.index("neck")
    hands = np.isin(main, [names.index(b) for b in HAND_BONES])
    feet = np.isin(main, [names.index(b) for b in ("LeftFoot", "RightFoot", "LeftToeBase", "RightToeBase")])
    w[head] = 6.0
    w[neck & (Vw[:, 2] > 60.0)] = 4.0
    w[neck & (Vw[:, 2] <= 60.0)] = 2.0
    w[hands] = 2.5
    w[feet] = 1.5
    face = head & (Vw[:, 0] > 0.5) & (Vw[:, 2] > 60.0) & (Vw[:, 2] < 69.0)
    w[face] = 10.0
    return w


def _boundary_vertices(F, nv):
    e = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    u, cnt = np.unique(e, axis=0, return_counts=True)
    bad = u[cnt != 2]
    locked = np.zeros(nv, bool)
    locked[bad.reshape(-1)] = True
    return locked, int((cnt == 1).sum()), int((cnt > 2).sum())


def _sample_bilinear(img, uv):
    """img (H, W, C) float, uv (K, 2) glTF (v down) -> (K, C), wrapped."""
    H, W = img.shape[:2]
    x = (uv[:, 0] % 1.0) * W - 0.5
    y = (uv[:, 1] % 1.0) * H - 0.5
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    x0, x1 = x0 % W, (x0 + 1) % W
    y0, y1 = y0 % H, (y0 + 1) % H
    return ((img[y0, x0] * (1 - fx) + img[y0, x1] * fx) * (1 - fy)
            + (img[y1, x0] * (1 - fx) + img[y1, x1] * fx) * fy)


def _head_faces(Vd, Fd, wb, names):
    """Triangles of the head / neck texture: their corners' main bones on the head or the neck above the collar."""
    hb = [names.index(b) for b in HEAD_BONES]
    nk = names.index("neck")
    main = wb[:, 0]
    vh = np.isin(main, hb) | ((main == nk) & (Vd[:, 2] > 58.5))
    ctr = Vd[Fd].mean(1)
    return (vh[Fd].sum(1) >= 2) | (ctr[:, 2] > 61.0)


def _face_front(P):
    """The face's front (density 2 in the head atlas): forehead to chin, in front of the ears."""
    return (P[:, 0] > 0.8) & (P[:, 2] > 59.5) & (P[:, 2] < 69.5) & (np.abs(P[:, 1]) < 5.0)


def convert(imp, src):
    """The studio geometry, weights, UVs and baked textures of the scan.  Returns a dict of arrays."""
    with open(src, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()[:16]
    params = f"{CONVERT_VERSION}-{TARGET_TRIS}-{HEAD_TEX}-{BODY_TEX}-{SS}"
    key = hashlib.sha256((digest + params).encode()).hexdigest()[:20]
    cdir = os.path.join(lem_dir(), "cache")
    cpath = os.path.join(cdir, f"lem-{key}.npz")
    if os.path.isfile(cpath):
        try:
            with np.load(cpath, allow_pickle=False) as z:
                return {k: z[k] for k in z.files}
        except Exception:
            pass
    t0 = time.time()
    s = imp.surfaces[0]
    names = imp.bone_names
    Vw, inv, first = weld(s.pos)
    Fw = inv[s.tris]
    locked, nopen, nnm = _boundary_vertices(Fw, len(Vw))
    importance = _importance(imp, s, Vw, first)
    _log(f"source: {len(Vw)} positions, {len(Fw)} tris, {nopen} open + {nnm} non-manifold edges locked")
    Vd, Fd = decimate(Vw, Fw, TARGET_TRIS, importance, locked)
    _log(f"decimated to {len(Fd)} tris, {len(Vd)} verts ({time.time() - t0:.1f}s)")
    md = M.TriMesh(Vd, Fd)
    nrm, corner_n = M.crease_normals(md, 80.0)
    vn = np.zeros_like(Vd)
    np.add.at(vn, Fd.reshape(-1), np.repeat(md.face_normals(False), 3, axis=0))
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)

    # --- weights from the source surface
    index = SurfaceIndex(Vw, Fw)
    dense = np.zeros((len(Vw), len(names)))
    for k in range(4):
        b = s.bw_bones[first, k]
        ok = b >= 0
        np.add.at(dense, (np.nonzero(ok)[0], b[ok]), s.bw_weights[first, k][ok] / 255.0)
    tri, bary, dist = index.query_all(Vd, vn)
    W = np.einsum("kc,kcb->kb", bary, dense[Fw[tri]])
    # the T-shirt's hem rides on the hips, not on the thighs (the scan's weights pulled it over the forward leg
    # into a point): on shirt vertices (white, above the crotch) the legs' share is capped at 0.2, the rest
    # moved to the hips
    mat = imp.g.materials[s.material]
    src_img = np.asarray(imp.g.texture_image(mat.base_texture).convert("RGB"), np.float64) / 255.0
    vcol = _sample_bilinear(src_img, np.einsum("kc,kcd->kd", bary, s.uv[s.tris[tri]]))
    vhsv = _rgb_to_hsv(vcol)
    shirt = (vhsv[:, 2] > 0.55) & (vhsv[:, 1] < 0.2) & (Vd[:, 2] > 28.0) & (Vd[:, 2] < 62.0)
    legs = [names.index(b) for up, lo, _ in LEGS for b in (up, lo)]
    hips = names.index("Hips")
    capped = shirt & (W[:, legs].sum(1) > 0.2)

    def cap(W):
        lw = W[:, legs].sum(1)
        k = np.where(capped & (lw > 0.2), 0.2 / np.maximum(lw, 1e-9), 1.0)
        W[:, hips] += lw * (1 - k)
        W[:, legs] *= k[:, None]
        return W

    # (the hips -> legs change then spreads over the trousers' top below the hem: weights smoothed over the mesh
    # in a band around the crotch, the shirt's cap kept; no stretched row under the hem)
    W = cap(W)
    band = (Vd[:, 2] > 26.0) & (Vd[:, 2] < 44.0) & (W[:, legs + [hips]].sum(1) > 0.05)
    e = np.concatenate([Fd[:, [0, 1]], Fd[:, [1, 2]], Fd[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    deg = np.bincount(e[:, 0], minlength=len(Vd)).astype(np.float64)
    for _ in range(12):
        acc = np.zeros_like(W)
        np.add.at(acc, e[:, 0], W[e[:, 1]])
        Wn = (W + acc) / (1.0 + deg)[:, None]
        W = np.where(band[:, None], Wn, W)
        W = cap(W)
    _log(f"weights: {int(capped.sum())} shirt vertices taken off the legs")
    order = np.argsort(-W, axis=1, kind="stable")[:, :4]
    top = np.take_along_axis(W, order, 1)
    top = np.where(top > 0.01, top, 0.0)
    wi = official._largest_remainder(top)
    wb = np.where(wi > 0, order, -1)
    srt = np.argsort(-wi, axis=1, kind="stable")
    wi = np.take_along_axis(wi, srt, 1)
    wb = np.take_along_axis(wb, srt, 1)
    wb[wi == 0] = -1
    _log(f"weights: source distance mean {dist.mean():.3f}, max {dist.max():.3f} units ({time.time() - t0:.1f}s)")

    # --- UV charts, two atlases
    head = _head_faces(Vd, Fd, wb, names)
    st = np.zeros((len(Fd), 3, 2), np.int64)
    group = np.where(head, 0, 1)
    for g, size in ((0, HEAD_TEX), (1, BODY_TEX)):
        fids = np.nonzero(group == g)[0]
        charts = T.box_charts(Vd, Fd[fids], smooth_iters=6, min_dot=0.25)
        for c in charts:
            c["faces"] = fids[c["faces"]]
            ctr = Vd[Fd[c["faces"]]].mean(1)
            c["density"] = 2.0 if (g == 0 and _face_front(ctr).mean() > 0.5) else 1.0
        dens = T.pack_charts(charts, size, pad=2, method="skyline")
        for c in charts:
            st[c["faces"]] = c["st"]
        _log(f"atlas {g} {size}: {len(fids)} tris, {len(charts)} charts, {dens:.1f} texels/unit")

    # --- bake the colours from the source texture
    uv_src = s.uv
    textures = []
    tex_pos, tex_nrm = [], []
    for g, size in ((0, HEAD_TEX), (1, BODY_TEX)):
        fids = np.nonzero(group == g)[0]
        Wd, Hd = size[0] * SS, size[1] * SS
        ti, px, py, bc = T.raster_texels(st[fids] * SS, (Wd, Hd))
        P = np.einsum("kc,kcd->kd", bc, Vd[Fd[fids[ti]]])
        Nn = np.einsum("kc,kcd->kd", bc, nrm[corner_n[fids[ti]]])
        Nn /= np.maximum(np.linalg.norm(Nn, axis=1, keepdims=True), 1e-12)
        stri, sbary, sdist = index.query_all(P, Nn)
        uv = np.einsum("kc,kcd->kd", sbary, uv_src[s.tris[stri]])
        col = _sample_bilinear(src_img, uv)
        img = np.zeros((Hd, Wd, 3))
        cov = np.zeros((Hd, Wd), bool)
        img[py, px] = col
        cov[py, px] = True
        img = T.dilate(img, cov, iters=12 * SS)
        # holo paint inputs: rest positions / normals per texel
        pimg = np.zeros((Hd, Wd, 3))
        nimg = np.zeros((Hd, Wd, 3))
        pimg[py, px] = P
        nimg[py, px] = Nn
        pimg = T.dilate(pimg, cov, iters=12 * SS)
        nimg = T.dilate(nimg, cov, iters=12 * SS)
        # supersampled -> final size (box filter)
        img = img.reshape(size[1], SS, size[0], SS, 3).mean((1, 3))
        pimg = pimg.reshape(size[1], SS, size[0], SS, 3).mean((1, 3))
        nimg = nimg.reshape(size[1], SS, size[0], SS, 3).mean((1, 3))
        textures.append(img)
        tex_pos.append(pimg)
        tex_nrm.append(nimg)
        _log(f"atlas {g}: baked {len(px)} texels, source distance mean {sdist.mean():.3f} max {sdist.max():.2f} "
             f"({time.time() - t0:.1f}s)")
    out = {
        "verts": Vd, "faces": Fd, "normals": nrm, "corner_n": corner_n, "wbones": wb, "wweights": wi,
        "group": group, "st": st,
        "tex0": textures[0].astype(np.float32), "tex1": textures[1].astype(np.float32),
        "pos0": tex_pos[0].astype(np.float32), "pos1": tex_pos[1].astype(np.float32),
        "nrm0": tex_nrm[0].astype(np.float32), "nrm1": tex_nrm[1].astype(np.float32),
    }
    _log(f"conversion done ({time.time() - t0:.1f}s)")
    try:
        os.makedirs(cdir, exist_ok=True)
        tmp = cpath + ".tmp.npz"
        np.savez_compressed(tmp, **out)
        os.replace(tmp, cpath)
    except OSError:
        pass
    return out


# =====================================================================================================================
# textures and the studio model
# =====================================================================================================================

HOLO_GREEN = np.array([0.24, 1.0, 0.45])


def _luma(img):
    return img @ np.array([0.299, 0.587, 0.114])


def sharpen(img, mask=None, radius=1.2, amount=0.45):
    """Unsharp mask (float RGB [0, 1]), optionally limited to a mask (H, W) in [0, 1]."""
    im = Image.fromarray(np.clip(np.round(img * 255), 0, 255).astype(np.uint8))
    blur = np.asarray(im.filter(ImageFilter.GaussianBlur(radius)), np.float64) / 255.0
    out = img + (img - blur) * amount * (1.0 if mask is None else mask[..., None])
    return np.clip(out, 0, 1)


def texel_size(P):
    """Model-space size of each texel (H, W) from the baked position image: the smallest step to a neighbour
    (chart borders and gutters ignored), clipped to [0.01, 0.5]."""
    big = np.full(P.shape[:2], np.inf)
    d = np.linalg.norm(P[:, 1:] - P[:, :-1], axis=-1)
    dx = np.minimum(np.c_[d, big[:, :1]], np.c_[big[:, :1], d])
    d = np.linalg.norm(P[1:] - P[:-1], axis=-1)
    dy = np.minimum(np.r_[d, big[:1]], np.r_[big[:1], d])
    ts = np.minimum(dx, dy)
    ts = np.where(ts < 1e-4, np.inf, ts)            # (gutters: dilated copies)
    return np.clip(np.where(np.isfinite(ts), ts, 0.05), 0.01, 0.5)


def gauss(a, sigma):
    """Separable Gaussian blur of an (H, W[, C]) float array (edges clamped)."""
    r = max(1, int(math.ceil(3 * sigma)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    out = a.astype(np.float64)
    for ax in (0, 1):
        n = out.shape[ax]
        idx = np.clip(np.arange(n)[:, None] + np.arange(-r, r + 1)[None, :], 0, n - 1)
        acc = np.zeros_like(out)
        for j, kj in enumerate(k):
            acc += kj * np.take(out, idx[:, j], axis=ax)
        out = acc
    return out


def holo_texture(img, P, N, spacing=1.6, line=0.11, texel=None):
    """His hologram: a green lattice (the surface cut by planes every `spacing` units along x, y and z, projected
    triplanar: each surface shows the two families that cross it steeply, blended by its normal; the same
    model-space lattice on the head and the body) over a dim green copy of his own shading (the face still
    reads).  Lines antialiased against the local texel size (`texel` (H, W), model units)."""
    H, W = img.shape[:2]
    Pf, Nf = P.reshape(-1, 3), N.reshape(-1, 3)
    ts = np.full(len(Pf), 0.06) if texel is None else np.asarray(texel, float).reshape(-1)
    hw = np.maximum(line, ts)
    cov = []
    for ax in range(3):
        d = np.abs(Pf[:, ax] / spacing - np.round(Pf[:, ax] / spacing)) * spacing
        cov.append(np.clip((hw - d) / ts + 0.5, 0.0, 1.0))
    w = np.abs(Nf) ** 4
    w /= np.maximum(w.sum(1, keepdims=True), 1e-9)
    ln = sum(w[:, a] * np.maximum(cov[(a + 1) % 3], cov[(a + 2) % 3]) for a in range(3))
    lum = _luma(img.reshape(-1, 3))
    col = HOLO_GREEN[None, :] * (0.06 + 0.55 * lum ** 1.2 + 0.7 * ln)[:, None]
    col = col + np.array([0.45, 0.5, 0.45])[None, :] * (0.3 * ln)[:, None]
    return np.clip(col, 0, 1).reshape(H, W, 3)


# the cap: olive khaki (the photos white-balanced on his T-shirt: hue ~40-50 deg, saturation ~0.45); the scan made it a
# dull brown-grey (hue 38, saturation 0.28, value 0.31): its texels are moved toward olive, shading kept
CAP_HUE, CAP_SAT, CAP_GAIN = 48.0 / 360.0, 1.4, 1.15


def _rgb_to_hsv(c):
    mx, mn = c.max(-1), c.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-9
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    rm = nz & (mx == r)
    gm = nz & (mx == g) & ~rm
    bm = nz & ~rm & ~gm
    h[rm] = ((g - b)[rm] / d[rm]) % 6
    h[gm] = (b - r)[gm] / d[gm] + 2
    h[bm] = (r - g)[bm] / d[bm] + 4
    return np.stack([h / 6.0, np.where(mx > 1e-9, d / np.maximum(mx, 1e-9), 0.0), mx], -1)


def _hsv_to_rgb(hsv):
    h, s_, v = hsv[..., 0] * 6.0, hsv[..., 1], hsv[..., 2]
    i = np.floor(h).astype(int) % 6
    f = h - np.floor(h)
    p, q, t = v * (1 - s_), v * (1 - s_ * f), v * (1 - s_ * (1 - f))
    out = np.select([i[..., None] == k for k in range(6)],
                    [np.stack(x, -1) for x in ((v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q))])
    return out


def cap_mask(img, P):
    """Soft mask (H, W) of the cap's texels in the head atlas: on the cap's shell (top, back, above the ears; not
    the face) and of its colour (yellow-brown hue, low saturation, dark; not the redder hair or skin)."""
    hsv = _rgb_to_hsv(img)
    x, y, z = P[..., 0], P[..., 1], P[..., 2]
    shell = (z > 66.0) | ((x < -2.5) & (z > 61.0)) | ((np.abs(y) > 4.0) & (z > 65.0) & (x < 1.0))
    shell &= ~((x > 3.0) & (z < 69.0))
    hue = hsv[..., 0] * 360.0
    col = (T._sstep(28.0, 33.0, hue) * (1 - T._sstep(62.0, 70.0, hue)) * (1 - T._sstep(0.45, 0.6, hsv[..., 1]))
           * (1 - T._sstep(0.5, 0.62, hsv[..., 2])))
    m = shell.astype(np.float64) * col
    m = np.asarray(Image.fromarray(np.clip(m * 255, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)),
                   np.float64) / 255.0
    return np.clip(m * 1.3, 0, 1)


def recolor_cap(img, P):
    m = cap_mask(img, P)
    hsv = _rgb_to_hsv(img)
    hsv2 = hsv.copy()
    hsv2[..., 0] = CAP_HUE
    hsv2[..., 1] = np.clip(hsv[..., 1] * CAP_SAT, 0, 0.55)
    hsv2[..., 2] = np.clip(hsv[..., 2] * CAP_GAIN, 0, 1)
    return img * (1 - m[..., None]) + _hsv_to_rgb(hsv2) * m[..., None]


# the face (head atlas): his thin metal glasses' rims (round, ~1.15 units, centred before each eye) a little darker
# and one texel wider so that they still read beyond ~100 units; the upper eyelids a touch lighter (the eyes read
# open, as in the photos)
EYES = ((1.5, 66.75), (-1.5, 66.75))       # (y, z) of each lens' centre
RIM_R = 1.15


def enhance_face(img, P):
    x, y, z = P[..., 0], P[..., 1], P[..., 2]
    front = x > 1.0
    L = _luma(img)
    L8 = Image.fromarray(np.clip(L * 255, 0, 255).astype(np.uint8))
    closed = np.asarray(L8.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5)), np.float64) / 255.0
    bh = np.clip(closed - L, 0, 1)                       # thin dark features
    ring = np.zeros(L.shape, bool)
    lid = np.zeros(L.shape)
    for ey, ez in EYES:
        ring |= np.abs(np.hypot(y - ey, z - ez) - RIM_R) < 0.22
        lid = np.maximum(lid, T.edge(np.hypot((y - ey) / 0.75, (z - (ez + 0.62)) / 0.22) - 1.0, 0.6))
    ring &= front
    rim = ring & (bh > 0.05)
    rimw = np.clip(gauss(rim.astype(np.float64), 0.8) * 2.0, 0, 1) * ring
    metal = np.median(img[rim], axis=0) * 0.75 if rim.sum() > 32 else np.array([0.3, 0.25, 0.2])
    out = img * (1 - 0.3 * rimw[..., None]) + metal[None, None, :] * (0.3 * rimw[..., None])
    # the lids: toward the surrounding skin (the face's texels blurred, dark features left out)
    skin_ok = (bh < 0.02) & front
    sk = gauss(out * skin_ok[..., None], 4.0) / np.maximum(gauss(skin_ok.astype(np.float64), 4.0), 1e-3)[..., None]
    w = (0.35 * lid * front)[..., None]
    out = out * (1 - w) + np.maximum(sk, out) * w
    return np.clip(out, 0, 1)


# the T-shirt (photos 2 and 4: a plain white crew-neck tee): the scan's shirt texels repainted plain white with
# its soft shading only (specks, a tag-like patch and frayed flecks cleaned), the neckline a round crew neck drawn
# in model space around the neck's axis (lowest at the front)
NECK_AXIS = (-2.1, -0.2)
NECK_BACK, NECK_DROP, NECK_R = 61.8, 1.4, 6.0
SHIRT_WHITE = np.array([0.95, 0.94, 0.925])


def neckline(P):
    """(height of the crew neckline above each point's azimuth round the neck, distance to the neck's axis)."""
    dx, dy = P[..., 0] - NECK_AXIS[0], P[..., 1] - NECK_AXIS[1]
    c = np.clip(dx / np.maximum(np.hypot(dx, dy), 1e-9), 0.0, 1.0)
    return NECK_BACK - NECK_DROP * c ** 1.5, np.hypot(dx, dy)


def clean_shirt(img, P, N, ts):
    hsv = _rgb_to_hsv(img)
    L = _luma(img)
    z = P[..., 2]
    zn, r = neckline(P)
    neck = (r < NECK_R) & (z > 56.5) & (z < 63.5)
    above = neck & (z >= zn)
    zone = (z > 30.0) & (z < 62.5) & ~above
    whiteish = (hsv[..., 2] > 0.55) & (hsv[..., 1] < 0.2)
    white = whiteish & zone
    # specks: greyish texels mostly surrounded by shirt
    frac = gauss(white.astype(np.float64), 2.5)
    grey = zone & ~white & (hsv[..., 1] < 0.3)
    speck = grey & (((hsv[..., 2] > 0.1) & (frac > 0.6)) | ((hsv[..., 2] > 0.3) & (frac > 0.45)))
    m = white | speck | (neck & ~above)
    # soft shading only: the white texels' luminance, blurred
    src = white.astype(np.float64)
    Ls = gauss(L * src, 2.0) / np.maximum(gauss(src, 2.0), 1e-3)
    Ls = np.where(gauss(src, 2.0) > 0.02, Ls, np.median(L[white]) if white.any() else 0.85)
    Ls = np.clip(Ls, 0.55, 1.0)
    # (round the collar the scan's own shadows and its V-neck's notch: plain lit white, the engine shades it)
    if white.any():
        Ls = np.where(neck & ~above, np.maximum(Ls, np.percentile(L[white], 70)), Ls)
    shirt = np.clip(SHIRT_WHITE[None, None, :] / _luma(SHIRT_WHITE) * Ls[..., None], 0, 1)
    # the collar's rib: a narrow band just under the neckline, a touch greyer, its top edge a shade darker
    dn = zn - z
    rib = neck & (dn >= 0.0) & (dn < 0.45)
    shirt = np.where(rib[..., None], shirt * (0.95 - 0.05 * (dn < 0.12))[..., None], shirt)
    out = np.where(m[..., None], shirt, img)
    # the neck above the line: skin (the scan's white texels there take the neck's skin colour)
    near = above & (z < zn + 1.5) & (hsv[..., 1] > 0.2) & (hsv[..., 2] > 0.35)
    skin = np.median(img[near], axis=0) if near.sum() > 16 else np.array([0.78, 0.6, 0.5])
    shade = (0.9 + 0.1 * N[..., 2])[..., None]
    # (white or grey - the scan's collar - above the line: skin)
    fill = above & (z < zn + 1.4) & (whiteish | ((hsv[..., 1] < 0.15) & (hsv[..., 2] > 0.25)))
    out = np.where(fill[..., None], skin[None, None, :] * shade, out)
    # antialiased neckline (over one texel)
    c = np.clip(dn / ts + 0.5, 0.0, 1.0)[..., None]
    edge = neck & (np.abs(dn) < ts)
    up = np.where(fill[..., None], skin[None, None, :] * shade, img)
    out = np.where(edge[..., None], shirt * c + up * (1 - c), out)
    return np.clip(out, 0, 1)


def make_textures(conv):
    """(textures, skins): head, body (skin 0); their holograms (skin 1)."""
    tex = []
    head = conv["tex0"].astype(np.float64)
    face = _face_front(conv["pos0"].reshape(-1, 3).astype(np.float64)).reshape(head.shape[:2]).astype(np.float64)
    face = np.asarray(Image.fromarray((face * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3)),
                      np.float64) / 255.0
    P0, P1 = conv["pos0"].astype(np.float64), conv["pos1"].astype(np.float64)
    N0, N1 = conv["nrm0"].astype(np.float64), conv["nrm1"].astype(np.float64)
    ts0, ts1 = texel_size(P0), texel_size(P1)
    head = sharpen(head, mask=0.4 + 0.6 * face, radius=1.0, amount=0.55)
    head = recolor_cap(head, P0)
    head = enhance_face(head, P0)
    head = clean_shirt(head, P0, N0, ts0)
    body = sharpen(conv["tex1"].astype(np.float64), radius=1.0, amount=0.3)
    body = clean_shirt(body, P1, N1, ts1)
    for name, img in (("lem_head.bmp", head), ("lem_body.bmp", body)):
        idx, pal = official.quantize_texture(np.clip(np.round(img * 255), 0, 255).astype(np.uint8))
        tex.append(mdl.Texture(name=name, pixels=idx, palette=pal, flags=0))
    for name, img, g in (("lem_head_holo.bmp", head, 0), ("lem_body_holo.bmp", body, 1)):
        h = holo_texture(img, (P0, P1)[g], (N0, N1)[g], texel=(ts0, ts1)[g])
        idx, pal = official.quantize_texture(np.clip(np.round(h * 255), 0, 255).astype(np.uint8))
        tex.append(mdl.Texture(name=name, pixels=idx, palette=pal,
                               flags=mdl.STUDIO_NF_ADDITIVE | mdl.STUDIO_NF_FULLBRIGHT))
    return tex, [[0, 1], [2, 3]]


def assemble(rig, conv, sequences, attachments=(), hitbox_groups=None, hitbox_bones=None, eyeposition=None,
             hull=None, name=MODEL_PATH):
    """mdl.Studio from the converted geometry (weighted, model space at rest) and the sequences."""
    V, F = conv["verts"], conv["faces"]
    nrm, cn = conv["normals"], conv["corner_n"]
    wb, ww = conv["wbones"], conv["wweights"]
    st, group = conv["st"], conv["group"]
    textures, skins = make_textures(conv)
    # normals: one per (corner normal id); each belongs to one vertex
    n_vert = np.zeros(len(nrm), np.int64)
    n_vert[cn.reshape(-1)] = F.reshape(-1)
    meshes = []
    for g in (0, 1):
        fids = np.nonzero(group == g)[0]
        tris = np.zeros((len(fids), 3, 4), np.int64)
        tris[..., 0] = F[fids]
        tris[..., 1] = cn[fids]
        tris[..., 2:] = st[fids]
        meshes.append(mdl.Mesh(tris=tris, skinref=g))
    model = mdl.Model(name="lem", verts=V.copy(), vert_bone=wb[:, 0].copy(), norms=nrm.copy(),
                      norm_bone=wb[n_vert, 0].copy(), meshes=meshes,
                      vert_weights=mdl.BoneWeights(wb.copy(), ww.copy()),
                      norm_weights=mdl.BoneWeights(wb[n_vert].copy(), ww[n_vert].copy()))
    bones = rig.mdl_bones()
    heads = np.array([b.head for b in rig.bones])
    wv = np.where(wb >= 0, ww, 0) / 255.0
    bi = np.maximum(wb, 0)
    hdr_lo = hdr_hi = None
    for seq in sequences:
        lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
        for fr in range(seq.numframes):
            Wm = mdl.bone_matrices(bones, seq.pos[fr], seq.rot[fr])
            S = Wm.copy()
            S[:, :, 3] = Wm[:, :, 3] - np.einsum("bij,bj->bi", Wm[:, :, :3], heads)
            Mx = np.einsum("nk,nkij->nij", wv, S[bi])
            p = np.einsum("nij,nj->ni", Mx[:, :, :3], V) + Mx[:, :, 3]
            lo, hi = np.minimum(lo, p.min(0)), np.maximum(hi, p.max(0))
        seq.bbmin, seq.bbmax = tuple(lo), tuple(hi)
        if hdr_lo is None:
            hdr_lo, hdr_hi = lo, hi
    names = [b.name for b in rig.bones]
    hitboxes = []
    groups = {names.index(k): v for k, v in (hitbox_groups or {}).items()}
    allowed = None if hitbox_bones is None else {names.index(b) for b in hitbox_bones}
    for b in range(len(names)):
        if allowed is not None and b not in allowed:
            continue
        own = [b] + [names.index(m) for m in HITBOX_MERGE.get(names[b], ())]
        sel = np.isin(wb[:, 0], own) & (ww[:, 0] >= 96)
        if sel.sum() < 8:
            continue
        p = V[sel] - heads[b]
        hitboxes.append(mdl.Hitbox(bone=b, group=groups.get(b, 0), bbmin=tuple(p.min(0)), bbmax=tuple(p.max(0))))
    atts = [mdl.Attachment(bone=names.index(ab), org=tuple(np.asarray(apos, float) - heads[names.index(ab)]),
                           name=an) for an, ab, apos in attachments]
    eye = eyeposition if eyeposition is not None else (0.0, 0.0, float(hdr_hi[2]) * 0.9)
    hmin, hmax = hull if hull is not None else ((-16.0, -16.0, 0.0), (16.0, 16.0, 72.0))
    return mdl.Studio(name=name, bones=bones, sequences=list(sequences), textures=textures,
                      bodyparts=[mdl.BodyPart(name="body", models=[model])], skins=skins, attachments=atts,
                      hitboxes=hitboxes, eyeposition=tuple(eye), min=tuple(hmin), max=tuple(hmax),
                      bbmin=tuple(hdr_lo), bbmax=tuple(hdr_hi))


# =====================================================================================================================
# animation (the rig of the scan: identity rest rotations, rig.py conventions)
# =====================================================================================================================

def qblend(a, b, w):
    """Pose blend with quaternion slerp of the local rotations (w = 0 -> a, 1 -> b)."""
    w = float(np.clip(w, 0.0, 1.0))
    if w <= 0.0:
        return a.copy()
    if w >= 1.0:
        return b.copy()
    out = R.Pose()
    for k in sorted(set(a) | set(b)):
        va = a[k] if k in a else np.zeros(6)
        vb = b[k] if k in b else np.zeros(6)
        qa = xform.angle_quaternion(np.radians(va[:3]))
        qb = xform.angle_quaternion(np.radians(vb[:3]))
        q = xform.quaternion_slerp(qa, qb, w)
        e = np.degrees(xform.matrix_euler(xform.quaternion_matrix(np.asarray(q))))
        out[k] = np.r_[e, va[3:] * (1 - w) + vb[3:] * w]
    return out


def turn(p, bone, x=0.0, y=0.0, z=0.0):
    """Rotate a bone by euler degrees applied in its parent's frame (before its own rotation)."""
    e = p.get_rot(bone)
    m = xform.rot_deg(x, y, z) @ xform.rot_deg(*e)
    p.set_rot(bone, *np.degrees(xform.matrix_euler(m)))
    return p


def _unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / max(float(np.linalg.norm(v)), 1e-12)


def _trapezoid(x, a=0.3):
    """0 -> 1 with a trapezoidal speed (accelerates over the first `a`, constant, decelerates over the last `a`):
    the peak speed is 1 / (1 - a) times the mean (smoothstep: 1.5)."""
    x = R.clamp01(x)
    v = 1.0 / (1.0 - a)
    if x < a:
        return 0.5 * v * x * x / a
    if x > 1.0 - a:
        return 1.0 - 0.5 * v * (1.0 - x) ** 2 / a
    return 0.5 * v * a + v * (x - a)


def _jitter(t, seed, freqs=(23.0, 37.0, 51.0)):
    """Deterministic tremor in [-1, 1] (sum of incommensurate sines)."""
    return sum(math.sin(2 * math.pi * (f * t + 0.137 * seed * (i + 1))) for i, f in enumerate(freqs)) / len(freqs)


def scan_hand_frames(imp):
    """Per hand: finger direction, palm normal (rest pose) and finger length, from the scan's hand vertices (its
    hands are one bone each)."""
    s = imp.surfaces[0]
    out = {}
    for side, k in SIDES:
        b = imp.bone(f"{side}Hand")
        sel = (s.bw_bones[:, 0] == b) & (s.bw_weights[:, 0] >= 200)
        P = s.pos[sel]
        h = imp.rig.head(f"{side}Hand")
        f = _unit(P.mean(0) - h)
        ev = np.linalg.svd(P - P.mean(0), full_matrices=False)[2]
        n = _unit(ev[2] - f * (ev[2] @ f))
        if n @ np.array([0.0, -k, 0.0]) < 0:      # the palm faces the thigh in the A-pose
            n = -n
        out[side] = (f, n, float(((P - h) @ f).max()))
    return out


class ScanClips:
    """The rigged file's clips (pose_at, duration) through the importer."""

    def __init__(self, imp):
        self.imp = imp

    def duration(self, name):
        return self.imp._anim(name).duration

    def pose_at(self, name, t):
        return self.imp.pose_at(name, t)


class Animator:
    """The eight sequences on Le M's skeleton: clips where they fit (`clips`: the scan's, or the stand-in's
    procedural ones), the rest authored."""

    def __init__(self, rig, clips, hand_frame, soles=None):
        self.rig = rig
        self.clips = clips
        self.heads = {b.name: self.rig.head(b.name) for b in rig.bones}
        self.hand_frame = hand_frame
        self.strides = (1.25, 1.3)      # walk, run: the clips' strides lengthened (natural cadence at speed)
        # the soles: rest-pose points (n, 3) with their bones / weights (n, 4) as the mesh skins them; the lowest
        # one is the ground
        if soles is None:
            pts, bones = [], []
            for _, _, end in LEGS:
                for b in (end, f"{end[:-4]}ToeBase"):
                    h = np.array(self.heads[b], float)
                    pts += [[h[0] + dx, h[1], 0.0] for dx in (-2.5, 0.0, 2.5)]
                    bones += [self.rig.index(b)] * 3
            soles = (np.array(pts), np.array([[b, -1, -1, -1] for b in bones]),
                     np.array([[255, 0, 0, 0]] * len(bones)))
        sp, sb, sw = soles
        self.soles = (np.asarray(sp, float), np.maximum(np.asarray(sb), 0), np.where(np.asarray(sb) >= 0, sw, 0) / 255.0)
        self.idle0 = self.ground(clips.pose_at("idle_calm", 0.0))

    # helpers --------------------------------------------------------------------------------------------------
    def world(self, p):
        return self.rig.world(p)

    def sole_z(self, p):
        """Height of the lowest sole point (model space) in pose p."""
        S = self.rig.skin_matrices(p)
        pts, b, w = self.soles
        Mx = np.einsum("nk,nkij->nij", w, S[b])          # blended matrices, as the renderer skins
        return float((np.einsum("nij,nj->ni", Mx[:, :, :3], pts) + Mx[:, :, 3])[:, 2].min())

    def ground(self, p):
        """p with the whole body moved vertically so that its lowest sole point is on z = 0 (standing clips)."""
        p.move("Hips", z=-self.sole_z(p))
        return p

    def carried(self, p, bone, q):
        S = self.rig.skin_matrices(p)[self.rig.index(bone)]
        return S[:, :3] @ np.asarray(q, float) + S[:, 3]

    def hand_rot(self, side, fingers, palm):
        """World rotation of a hand whose fingers point along `fingers` with the palm facing `palm`."""
        f_r, n_r, _ = self.hand_frame[side]
        f_t = _unit(fingers)
        n_t = _unit(np.asarray(palm, float) - f_t * (np.asarray(palm, float) @ f_t))
        A = np.stack([f_r, n_r, np.cross(f_r, n_r)], 1)
        B = np.stack([f_t, n_t, np.cross(f_t, n_t)], 1)
        return B @ A.T

    def plant(self, p, ref=None):
        """Feet where they are in `ref` (default the idle's first frame), same orientation; knees in their plane."""
        ref = self.idle0 if ref is None else ref
        W0 = self.world(ref)
        ix = self.rig.index
        for up, lo, end in LEGS:
            tgt = W0[ix(end)][:, 3]
            knee = W0[ix(lo)][:, 3]
            mid = (W0[ix(up)][:, 3] + tgt) / 2
            self.rig.solve_two_bone(p, up, lo, end, tgt, pole=_unit(knee - mid + (0.3, 0, 0)),
                                    end_world_rot=W0[ix(end)][:, :3])
            p.set_rot(f"{end[:-4]}ToeBase", *ref.get_rot(f"{end[:-4]}ToeBase"))
        return p

    def arm_to(self, p, side, target, pole, rot=None):
        up, lo, end = ARMS[0] if side == "Left" else ARMS[1]
        self.rig.solve_two_bone(p, up, lo, end, target, pole=_unit(pole), end_world_rot=rot)
        return p

    def attachment_points(self):
        out = []
        for side in ("Right", "Left"):
            f, n, tip = self.hand_frame[side]
            h = self.heads[f"{side}Hand"]
            out.append((f"{side.lower()}_hand", f"{side}Hand", tuple(h + f * min(tip * 0.75, 4.5) + n * 0.8)))
        return out

    def seq(self, name, fn, frames, fps, loop=False, activity=0, linear=None):
        # (standing sequences: every frame's lowest sole point on the ground)
        return R.make_sequence(self.rig, name, lambda t: self.ground(fn(t)), frames=frames, fps=fps, loop=loop,
                               activity=activity, linear=linear)

    def ends(self, p, t, t0, t1):
        """The one-shots start and end exactly on the idle's first frame: p blended onto it before t0 / after t1."""
        return qblend(self.idle0, p, R.window(t, 0.0, t0) * (1 - R.window(t, t1, 1.0)))

    # 0 idle -----------------------------------------------------------------------------------------------------
    def idle(self):
        # the clip loops by itself (its last frame is its first): played whole, ~10 s, sampled at 15 fps
        d = self.clips.duration("idle_calm") - CLIP_T0
        n = int(round(d * 15.0))
        return self.seq("idle", lambda t: self.clips.pose_at("idle_calm", CLIP_T0 + d * t), frames=n, fps=n / d,
                        loop=True, activity=mdl.ACT["IDLE"])

    # 1 walk, 2 run: the in-place clips with longer strides --------------------------------------------------------
    def gait(self, clip, name, stride_k, speed, activity):
        clips, rig = self.clips, self.rig
        d = clips.duration(clip) - CLIP_T0
        n = int(round(d * FPS))
        ts = [CLIP_T0 + d * i / n for i in range(n)]
        poses = [clips.pose_at(clip, t) for t in ts]
        ix = rig.index
        Ws = [self.world(p) for p in poses]
        cx = float(np.mean([W[ix("Hips")][0, 3] for W in Ws]))
        L = {}
        for up, lo, end in LEGS:
            L[up] = (np.linalg.norm(self.heads[lo] - self.heads[up]) + np.linalg.norm(self.heads[end] - self.heads[lo]))
        # targets and the hips' drop so that the longer stride stays in reach
        tg, drop = [], np.zeros(n)
        for i, W in enumerate(Ws):
            row = {}
            for up, lo, end in LEGS:
                f = W[ix(end)][:, 3].copy()
                f[0] = cx + stride_k * (f[0] - cx)
                hip = W[ix(up)][:, 3]
                reach = 0.985 * L[up]
                dxy = np.hypot(f[0] - hip[0], f[1] - hip[1])
                if f[2] < self.heads[end][2] + 3.0 and dxy < reach:     # (feet on or near the ground only)
                    need = hip[2] - f[2] - math.sqrt(reach ** 2 - dxy ** 2)
                    drop[i] = max(drop[i], need)
                row[end] = f
            tg.append(row)
        drop = np.maximum(drop, 0.0)
        # (smoothed around the loop, never less than needed)
        for _ in range(3):
            drop = np.maximum(drop, (np.roll(drop, 1) + drop + np.roll(drop, -1)) / 3)
        out = []
        for i, (p, W) in enumerate(zip(poses, Ws)):
            p = p.copy()
            p.move("Hips", z=-float(drop[i]))
            for up, lo, end in LEGS:
                knee = W[ix(lo)][:, 3]
                mid = (W[ix(up)][:, 3] + W[ix(end)][:, 3]) / 2
                pole = knee - mid
                pole = pole + (0.4, 0.0, 0.0) if np.linalg.norm(pole) < 0.3 else pole
                rig.solve_two_bone(p, up, lo, end, tg[i][end], pole=_unit(pole), end_world_rot=W[ix(end)][:, :3])
            out.append(p)
        # planted feet speed (backward, toes within 0.6 units of their lowest)
        fr = [self.world(p) for p in out]
        speeds = []
        for up, lo, end in LEGS:
            toe = f"{end[:-4]}ToeBase"
            P = np.array([W[ix(toe)][:, 3] for W in fr] + [fr[0][ix(toe)][:, 3]])
            z = P[:, 2]
            v = -(np.roll(P[:, 0], -1) - np.roll(P[:, 0], 1))[:-1] / (2 * d / n)
            v = np.r_[v, v[0]]
            low = z <= z.min() + 0.6
            sel = low & (v > 0)
            speeds.append(float(np.median(v[sel])))
        v = float(np.mean(speeds))
        lm = v * d
        fps = n / d * speed / v
        # the supporting foot on the ground: frames whose lowest sole point is within 1.2 units of the cycle's
        # lowest are contact frames (lowered / raised onto z = 0); the flight frames between take the offsets
        # interpolated around the loop (the run's airborne phases keep their height)
        mz = np.array([self.sole_z(p) for p in out])
        contact = np.nonzero(mz <= mz.min() + 1.2)[0]
        cz = mz[contact]
        off = np.interp(np.arange(n), np.r_[contact - n, contact, contact + n], np.r_[cz, cz, cz])
        for p, o in zip(out, off):
            p.move("Hips", z=-float(o))
        _log(f"{name}: stride x{stride_k}, hips drop max {drop.max():.2f}, native {v:.1f} u/s, played at "
             f"{fps:.1f} fps ({n / fps:.2f} s cycle) for {speed:.0f} u/s, linearmovement {lm:.1f}")
        P = np.zeros((n + 1, len(rig), 3))
        Rr = np.zeros_like(P)
        for i, p in enumerate(out):
            P[i], Rr[i] = rig.local_arrays(p)
        P[-1], Rr[-1] = P[0], Rr[0]
        return mdl.Sequence(name=name, pos=P, rot=Rr, fps=float(fps), flags=mdl.STUDIO_LOOPING, activity=activity,
                            actweight=1, motiontype=mdl.STUDIO_LX, linearmovement=(float(lm), 0.0, 0.0))

    # 3 attack: Hack ---------------------------------------------------------------------------------------------
    @staticmethod
    def _qrot(m):
        return np.asarray(xform.angle_quaternion(xform.matrix_euler(m)))

    @staticmethod
    def _path(s, keys):
        """Hand path through keys [(position, rotation matrix), ...] at s in [0, 1]: positions on a Catmull-Rom
        curve, the keys spread over s by their distances (an even speed); rotations slerped key to key at an even
        angular speed (spread by their angles: the fingertips never whip round in one frame)."""
        P = [np.asarray(k[0], float) for k in keys]
        dl = np.r_[0.0, np.cumsum([np.linalg.norm(b - a) + 1e-6 for a, b in zip(P[:-1], P[1:])])]
        pos = R.keys(s, [(float(d / dl[-1]), tuple(p)) for d, p in zip(dl, P)], interp="cubic")
        qs = [Animator._qrot(k[1]) for k in keys]
        ang = [0.0]
        for a, b in zip(qs[:-1], qs[1:]):
            ang.append(ang[-1] + 2.0 * math.acos(min(1.0, abs(float(np.dot(a, b))))) + 1e-6)
        sr = np.array(ang) / ang[-1]
        i = int(np.clip(np.searchsorted(sr, s, "right") - 1, 0, len(keys) - 2))
        u = R.clamp01((s - sr[i]) / (sr[i + 1] - sr[i]))
        q = xform.quaternion_slerp(qs[i], qs[i + 1], u)
        return np.asarray(pos, float), xform.quaternion_matrix(np.asarray(q))

    # attack timing (fractions of the 1.1 s): the hands rise through the front, palms out, and thrust (the hit at
    # 40 %), "type" in the air, then come back down through the front
    T_HIT, T_BACK0 = 0.41, 0.62

    def attack_pose(self, t):
        p = self.idle0.copy()
        T_HIT, T_BACK0 = self.T_HIT, self.T_BACK0
        rise = R.pulse(t, 0.0, 0.26, 0.30, 0.38)
        thrust = R.window(t, 0.28, T_HIT) * (1 - R.window(t, T_BACK0, 1.0))
        hold = R.window(t, 0.39, 0.43) * (1 - R.window(t, T_BACK0 - 0.06, T_BACK0 + 0.04))
        # body: leans back while the hands rise, into the thrust; knees give a little
        turn(p, "Spine02", y=-4 * rise + 5 * thrust, z=-5 * rise + 2 * thrust)
        turn(p, "Spine01", y=-3 * rise + 4 * thrust)
        turn(p, "neck", y=2 * rise - 5 * thrust)
        turn(p, "Head", y=-2 * thrust + 1.5 * hold * _jitter(t, 3, (9.0, 13.0)))
        p.move("Hips", x=-0.6 * rise + 0.8 * thrust, z=-0.6 * rise - 1.0 * thrust)
        self.plant(p)
        if t <= 0.0 or t >= 1.0:
            return self.ends(p, t, 0.03, 0.94)
        q = p.copy()
        W0 = self.world(self.idle0)
        Wsp = self.world(p)[self.rig.index("Spine")][:, :3]
        for side, k in SIDES:
            hi = self.rig.index(f"{side}Hand")
            # the hand's path (carried by the chest): idle -> in front of the belly (fingers forward, elbows down
            # and in) -> palms out before the chest -> thrust forward (the hit) -> in front of the hips -> idle:
            # always through the front, never out to the side
            idle = (W0[hi][:, 3], W0[hi][:, :3])
            front = (self.carried(p, "Spine", (8.0, 7.0 * k, 43.0)),
                     self.hand_rot(side, Wsp @ np.array([1.0, 0.1 * k, -0.4]), Wsp @ np.array([0.2, -k, 0.3])))
            wind = (self.carried(p, "Spine", (9.0, 8.0 * k, 49.5)),
                    self.hand_rot(side, Wsp @ np.array([0.3, 0.05 * k, 1.0]), Wsp @ np.array([1.0, -0.3 * k, -0.2])))
            hit = (self.carried(p, "Spine", (17.5, (5.0 if side == "Left" else 6.0) * k, 52.5)),
                   self.hand_rot(side, Wsp @ np.array([0.35, 0.1 * k, 1.0]), Wsp @ np.array([1.0, -0.15 * k, -0.2])))
            low = (self.carried(p, "Spine", (6.5, 8.0 * k, 41.0)),
                   self.hand_rot(side, Wsp @ np.array([0.9, 0.1 * k, -1.0]), Wsp @ np.array([0.1, -k, 0.1])))
            if t < T_HIT:
                s_ = _trapezoid(t / T_HIT, 0.2)
                pt, rot = self._path(s_, [idle, front, wind, hit])
            elif t < T_BACK0:
                pt, rot = hit
            else:
                s_ = _trapezoid((t - T_BACK0) / (1.0 - T_BACK0), 0.2)
                pt, rot = self._path(s_, [hit, low, idle])
            pt = pt + hold * 0.35 * np.array([_jitter(t, 1 + k), _jitter(t, 5 + k), _jitter(t, 9 + k)])
            # elbows: down, a little back and out (in the idle's plane at both ends)
            a = R.window(t, 0.0, 0.12) * (1 - R.window(t, 0.88, 1.0))
            elbow = W0[self.rig.index(f"{side}ForeArm")][:, 3] - W0[self.rig.index(f"{side}Arm")][:, 3]
            pole = _unit(elbow) * (1 - a) + _unit(Wsp @ np.array([-0.35, 0.3 * k, -1.0])) * a
            self.arm_to(q, side, pt, pole, rot)
            # (the fingers "type" in the air while the code flows: quick wrist flutters)
            turn(q, f"{side}Hand", x=6 * hold * _jitter(t, 11 + k, (17.0, 29.0)),
                 y=8 * hold * _jitter(t, 7 + k, (19.0, 31.0)))
        return self.ends(q, t, 0.03, 0.94)

    def attack(self):
        return self.seq("attack", self.attack_pose, frames=34, fps=30.0, activity=mdl.ACT["RANGE_ATTACK1"])

    # 4 flinch ---------------------------------------------------------------------------------------------------
    FLINCH_FRAMES = 16

    def flinch_pose(self, t):
        p = self.idle0.copy()
        sec = t * (self.FLINCH_FRAMES - 1) / 30.0
        # a short jolt: the torso snaps back ~12 degrees (peak at ~0.08 s, sharp ease-out), recovered by ~0.3 s;
        # the head adds less than half of it; the arms simply ride with the torso
        k = R.ease_out(R.clamp01(sec / 0.08)) * (1 - R.smoothstep(R.clamp01((sec - 0.1) / 0.2)))
        turn(p, "Spine02", y=-5 * k, x=1.5 * k)
        turn(p, "Spine01", y=-4 * k, z=3 * k)
        turn(p, "Spine", y=-3 * k)
        turn(p, "neck", y=-2 * k)
        turn(p, "Head", y=-3 * k, x=-2 * k)
        p.move("Hips", x=-0.8 * k, z=-0.4 * k)
        self.plant(p)
        # (a digital glitch: the whole body, feet included, two frames shifted sideways)
        if int(round(sec * 30.0)) in (4, 5):
            p.move("Hips", y=2.5)
        return self.ends(p, t, 0.05, 0.94)

    def flinch(self):
        return self.seq("flinch", self.flinch_pose, frames=self.FLINCH_FRAMES, fps=30.0,
                        activity=mdl.ACT["SMALL_FLINCH"])

    # 5 die: a stagger and a freeze (the server dissolves him into pixels) ------------------------------------------
    def die_pose(self, t):
        ct = 0.25 + 1.3 * min(t / 0.86, 1.0)
        p = self.clips.pose_at("electrocution_reaction", ct)
        p = qblend(self.idle0, p, R.smoothstep(R.clamp01(t / 0.15)))
        g = (1 - R.window(t, 0.75, 1.0)) * R.window(t, 0.05, 0.2)
        turn(p, "Spine01", z=3 * g * _jitter(t, 2, (11.0, 17.0)))
        turn(p, "Head", x=4 * g * _jitter(t, 4, (13.0, 19.0)))
        return p

    def die(self):
        return self.seq("die", self.die_pose, frames=42, fps=30.0, activity=mdl.ACT["DIESIMPLE"])

    # 6 spawn: "compiling" ---------------------------------------------------------------------------------------
    def spawn_pose(self, t):
        bind = R.Pose()
        base = qblend(bind, self.idle0, R.smoothstep(R.clamp01((t - 0.62) / 0.36)))
        p = base.copy()
        # stiff at first (a freshly generated mesh), glitch jumps
        if t < 0.3 and int(t * 30) % 4 == 1:
            turn(p, "Head", z=4.0 * _jitter(t, 7))
            turn(p, "Spine", x=2.0 * _jitter(t, 8))
        r = R.pulse(t, 0.22, 0.38, 0.52, 0.70)          # looks at his right hand
        l = R.pulse(t, 0.45, 0.60, 0.72, 0.88)          # then his left
        look_r = R.pulse(t, 0.22, 0.36, 0.50, 0.58)
        look_l = R.pulse(t, 0.50, 0.58, 0.72, 0.86)
        turn(p, "neck", y=16 * (look_r + look_l), z=-16 * look_r + 16 * look_l)
        turn(p, "Head", y=16 * (look_r + look_l), z=-12 * look_r + 12 * look_l)
        turn(p, "Spine01", y=4 * (look_r + look_l))
        q = p.copy()
        for side, k, w in (("Right", -1.0, r), ("Left", 1.0, l)):
            if w <= 0:
                continue
            flex = _jitter(t, 3 + k, (6.0, 9.0))
            tgt = self.carried(p, "Spine", (13.0, 7.5 * k, 47.0 + 1.0 * flex))
            Wsp = self.world(p)[self.rig.index("Spine")][:, :3]
            hr = self.hand_rot(side, Wsp @ np.array([1.0, -0.35 * k, 0.2]), Wsp @ np.array([0.0, 0.0, 1.0]))
            qq = q.copy()
            self.arm_to(qq, side, tgt, Wsp @ np.array([-0.3, 0.8 * k, -1.0]), hr)
            turn(qq, f"{side}Hand", x=10 * flex * k)
            q = qblend(q, qq, R.smoothstep(w))
        return q

    def spawn(self):
        return self.seq("spawn", self.spawn_pose, frames=45, fps=30.0, activity=mdl.ACT["ARM"])

    # 7 victory --------------------------------------------------------------------------------------------------
    def victory_pose(self, t):
        ct = 1.3 + (4.4 - 1.3) * t
        p = self.clips.pose_at("victory", ct)
        # (the clip twists the body ~50 degrees away and back: most of the hips' and the chest's yaw cancelled,
        # feet kept where they were, so that he celebrates facing whoever looks at him)
        ref = p.copy()
        ix = self.rig.index
        W = self.world(p)

        def yaw(m):
            f = m[:, :3] @ np.array([1.0, 0.0, 0.0])
            return math.degrees(math.atan2(f[1], f[0]))

        hy = yaw(W[ix("Hips")])
        sy = yaw(W[ix("Spine")]) - hy
        Wi = self.world(self.idle0)
        hy0, sy0 = yaw(Wi[ix("Hips")]), yaw(Wi[ix("Spine")]) - yaw(Wi[ix("Hips")])
        turn(p, "Hips", z=-0.75 * (hy - hy0))
        turn(p, "Spine01", z=-0.5 * (sy - sy0))
        self.plant(p, ref)
        w = R.smoothstep(R.clamp01(t / 0.13)) * (1 - R.smoothstep(R.clamp01((t - 0.86) / 0.14)))
        return qblend(self.idle0, p, w)

    def victory(self):
        return self.seq("victory", self.victory_pose, frames=72, fps=30.0, activity=mdl.ACT["VICTORY_DANCE"])

    def sequences(self):
        A = mdl.ACT
        return [
            self.idle(),
            self.gait("walk", "walk", self.strides[0], 90.0, A["WALK"]),
            self.gait("run", "run", self.strides[1], 250.0, A["RUN"]),
            self.attack(),
            self.flinch(),
            self.die(),
            self.spawn(),
            self.victory(),
        ]


# (bones without a box of their own are covered by a neighbour's: the chest by Spine01's, the face by the head's)
HITBOX_MERGE = {"Spine01": ("Spine", "neck", "LeftShoulder", "RightShoulder"), "Head": ("head_end", "headfront")}
HITBOX_BONES = ("Hips", "Spine02", "Spine01", "Head",
                "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand",
                "LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot")


def scan_soles(rig, conv):
    """The shoes' bottom vertices (rest z < 1.5) with their skinning (points, bones, weights)."""
    V, wb, ww = conv["verts"], conv["wbones"], conv["wweights"]
    sel = V[:, 2] < 1.5
    return V[sel].astype(np.float64), wb[sel], ww[sel]


def make_scan_model(src):
    imp = official.Importer(src, height=HEIGHT, verbose=False)
    conv = convert(imp, src)
    anim = Animator(imp.rig, ScanClips(imp), scan_hand_frames(imp), soles=scan_soles(imp.rig, conv))
    st = assemble(imp.rig, conv, anim.sequences(), attachments=anim.attachment_points(), hitbox_bones=HITBOX_BONES,
                  eyeposition=(4.0, 0.0, 65.0), hull=((-16.0, -16.0, 0.0), (16.0, 16.0, 72.0)))
    data = mdl.write(st)
    mdl.read(data)
    return data


# =====================================================================================================================
# the stand-in (no source installed): built from scratch on the same skeleton, procedural clips
# =====================================================================================================================

# the scan's skeleton (rest heads at height 72, A-pose): names, parents, heads
SKELETON = [
    ("Hips", None, (-1.0, -0.2, 39.7)), ("Spine02", "Hips", (-1.2, -0.2, 44.8)),
    ("Spine01", "Spine02", (-1.4, -0.2, 49.9)), ("Spine", "Spine01", (-1.6, -0.2, 55.2)),
    ("neck", "Spine", (-1.8, -0.2, 59.0)), ("Head", "neck", (-1.9, -0.2, 61.9)),
    ("head_end", "Head", (-0.5, 0.6, 71.5)), ("headfront", "Head", (2.5, -0.2, 61.9)),
    ("LeftShoulder", "Spine", (-1.7, 1.4, 57.0)), ("LeftArm", "LeftShoulder", (-2.4, 7.8, 57.0)),
    ("LeftForeArm", "LeftArm", (-2.6, 12.0, 46.6)), ("LeftHand", "LeftForeArm", (0.6, 17.2, 37.6)),
    ("RightShoulder", "Spine", (-1.7, -1.7, 57.0)), ("RightArm", "RightShoulder", (-2.5, -7.8, 57.0)),
    ("RightForeArm", "RightArm", (-2.6, -12.3, 46.7)), ("RightHand", "RightForeArm", (0.6, -17.4, 37.7)),
    ("LeftUpLeg", "Hips", (-1.0, 3.1, 35.8)), ("LeftLeg", "LeftUpLeg", (0.0, 4.5, 20.3)),
    ("LeftFoot", "LeftLeg", (-0.5, 4.6, 5.3)), ("LeftToeBase", "LeftFoot", (3.1, 5.7, 1.1)),
    ("RightUpLeg", "Hips", (-1.0, -3.4, 35.8)), ("RightLeg", "RightUpLeg", (0.0, -4.8, 20.3)),
    ("RightFoot", "RightLeg", (-0.5, -4.7, 5.2)), ("RightToeBase", "RightFoot", (2.6, -6.2, 1.1)),
]
TAILS = {"Hips": (-1.0, -0.2, 44.8), "Head": (-0.5, 0.6, 71.5), "LeftHand": (2.2, 19.8, 33.2),
         "RightHand": (2.2, -20.0, 33.3), "LeftToeBase": (6.5, 5.9, 1.0), "RightToeBase": (6.0, -6.4, 1.0),
         "head_end": (-0.4, 0.6, 72.5), "headfront": (5.5, -0.2, 63.0)}


def standin_rig():
    rig = R.Rig()
    heads = {n: h for n, _, h in SKELETON}
    kids = {}
    for n, par, _ in SKELETON:
        if par:
            kids.setdefault(par, []).append(n)
    for n, par, h in SKELETON:
        tail = TAILS.get(n) or heads[kids[n][0]]
        rig.add(n, par, h, tail=tail)
    return rig


class StandinClips:
    """Procedural stand-ins for the clips the animator uses (same names, CLIP_T0 convention)."""

    DUR = {"idle_calm": 4.0 + CLIP_T0, "walk": 1.0 + CLIP_T0, "run": 0.64 + CLIP_T0,
           "electrocution_reaction": 2.0, "victory": 5.0}

    def __init__(self, rig):
        self.rig = rig

    def duration(self, name):
        return self.DUR[name]

    def relaxed(self, t=0.0, amp=1.0):
        p = R.Pose()
        b = R.breathe(t, 1.0)
        turn(p, "Spine02", y=0.8 * b * amp)
        turn(p, "LeftArm", x=-17.0 + 1.0 * b * amp)
        turn(p, "RightArm", x=17.0 - 1.0 * b * amp)
        turn(p, "LeftForeArm", y=-8.0)
        turn(p, "RightForeArm", y=-8.0)
        turn(p, "Head", z=4.0 * math.sin(2 * math.pi * t) * amp, y=1.0 * b * amp)
        return p

    def pose_at(self, name, t):
        rig = self.rig
        if name == "idle_calm":
            u = (t - CLIP_T0) / (self.DUR[name] - CLIP_T0)
            return self.relaxed(u)
        if name in ("walk", "run"):
            u = ((t - CLIP_T0) / (self.DUR[name] - CLIP_T0)) % 1.0
            run = name == "run"
            p = self.relaxed(0.0, 0.0)
            stride, lift, duty = (40.0, 10.0, 0.34) if run else (30.0, 4.0, 0.6)
            p.move("Hips", z=(-3.0 if run else -1.2) + (1.6 if run else 0.8) * math.cos(4 * math.pi * u))
            turn(p, "Spine02", y=8.0 if run else 2.0, z=5.0 * math.sin(2 * math.pi * u))
            sw = (40.0 if run else 22.0) * math.sin(2 * math.pi * u)
            turn(p, "LeftArm", y=sw)
            turn(p, "RightArm", y=-sw)
            if run:
                turn(p, "LeftForeArm", y=-70.0)
                turn(p, "RightForeArm", y=-70.0)
            return R.walk_legs(rig, p, u, LEGS, stride=stride, lift=lift, duty=duty, phases=[0.5, 0.0])
        if name == "electrocution_reaction":
            p = self.relaxed(0.0, 0.0)
            a = R.smoothstep(R.clamp01(t / 0.6))
            turn(p, "LeftArm", x=60 * a + 6 * _jitter(t, 1))
            turn(p, "RightArm", x=-60 * a + 6 * _jitter(t, 2))
            turn(p, "neck", y=-15 * a + 4 * _jitter(t, 3))
            turn(p, "Spine01", y=-6 * a, x=3 * _jitter(t, 4))
            return p
        if name == "victory":
            p = self.relaxed(t / 5.0, 0.0)
            a = R.smoothstep(R.clamp01((t - 1.0) / 0.4))
            for side, k in SIDES:
                turn(p, f"{side}Arm", x=k * 125 * a + 10 * a * math.sin(6 * t + k))
                turn(p, f"{side}ForeArm", y=-20 * a)
            p.move("Hips", z=0.8 * a * abs(math.sin(4 * t)))
            return p
        raise KeyError(name)


SHIRT, SKIN_C, TROUSERS, SHOE = T.rgb("#eeece8"), T.rgb("#d9a184"), T.rgb("#1d1d22"), T.rgb("#ecebe6")
CAP, HAIR, LIP, FRAME = T.rgb("#6b6440"), T.rgb("#3b2a20"), T.rgb("#b56f62"), T.rgb("#a08a5a")


def _standin_parts():
    S = sdf
    parts = []
    torso = S.union(S.ellipsoid((-1.2, 0.0, 50.5), (5.0, 7.6, 8.0)), S.ellipsoid((-1.0, 0.0, 43.0), (4.6, 6.8, 6.0)),
                    S.ellipsoid((-1.6, 0.0, 55.6), (4.2, 9.2, 3.2)), k=2.0)
    pelvis = S.ellipsoid((-1.0, 0.0, 37.5), (4.6, 7.0, 4.6))
    neck = S.capsule((-1.6, 0.0, 56.0), (-1.2, 0.0, 62.0), 2.4)
    head = S.ellipsoid((0.0, 0.0, 66.0), (4.4, 3.8, 5.2)).smooth_union(
        S.ellipsoid((4.3, 0.0, 64.6), (0.8, 0.7, 1.3)), 0.6)
    ears = S.ellipsoid((-0.8, 3.8, 65.6), (0.9, 0.5, 1.4)).mirror_y()
    cap = (S.sphere((-0.3, 0.0, 67.0), 4.8) & S.halfspace((0, 0, 67.4), _unit((0.32, 0, -1)))).smooth_union(
        S.rounded_box((-5.6, 0.0, 66.9), (2.6, 3.4, 0.3), 0.25, rotation=(0, -18, 0)), 0.8)
    parts.append(builder.Part("torso", torso, bones=["Spine02", "Spine01", "Spine"], paint=_paint, budget=500))
    parts.append(builder.Part("pelvis", pelvis, bone="Hips", paint=_paint, budget=200))
    parts.append(builder.Part("neck", neck, bones=["neck", "Head"], paint=_paint, budget=120))
    parts.append(builder.Part("head", head | ears, bone="Head", paint=_paint, budget=700, density=2.5))
    parts.append(builder.Part("cap", cap, bone="Head", paint=_paint_cap, budget=300, density=1.5))
    for side, k in SIDES:
        h = {n: np.array(hh) for n, _, hh in SKELETON}
        sh, el, wr = h[f"{side}Arm"], h[f"{side}ForeArm"], h[f"{side}Hand"]
        f = _unit(wr - el)
        parts.append(builder.Part(f"upperarm_{side}", S.capsule(sh + (0, -0.8 * k, 0), el, 2.0),
                                  bones=[f"{side}Arm"], paint=_paint, budget=150))
        parts.append(builder.Part(f"forearm_{side}", S.rounded_cone(el, wr, 1.7, 1.3),
                                  bones=[f"{side}ForeArm"], paint=_paint, budget=120))
        hand = S.ellipsoid(wr + f * 1.8, (2.4, 0.8, 1.5)).transform(R._align((1, 0, 0), f), wr + f * 1.8)
        parts.append(builder.Part(f"hand_{side}", hand, bone=f"{side}Hand", paint=_paint, budget=100))
        hip, knee, ank = h[f"{side}UpLeg"], h[f"{side}Leg"], h[f"{side}Foot"]
        parts.append(builder.Part(f"thigh_{side}", S.rounded_cone(hip + (0, 0, 2.0), knee, 3.6, 2.6),
                                  bones=[f"{side}UpLeg"], paint=_paint, budget=180))
        parts.append(builder.Part(f"shin_{side}", S.rounded_cone(knee, ank + (0, 0, 0.5), 2.6, 2.0),
                                  bones=[f"{side}Leg"], paint=_paint, budget=150))
        parts.append(builder.Part(f"shoe_{side}", S.rounded_box((1.6, 4.8 * k, 2.0), (4.8, 1.9, 1.9), 1.2),
                                  bones=[f"{side}Foot", f"{side}ToeBase"], paint=_paint, budget=160))
    return parts


def _paint(P, N, skin):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    c = T.fill(P, SHIRT)
    arm = np.abs(y) > 8.5
    c = T.mix(c, SKIN_C, (arm & (z < 50.5))[:, None].astype(float))       # below the sleeves
    neck = (z > 59.0) | ((z > 56.0) & (np.hypot(x + 1.4, y) < 2.9))
    c = T.mix(c, SKIN_C, neck[:, None].astype(float))                      # neck, face
    c = T.mix(c, TROUSERS, ((z < 40.5) & ~arm)[:, None].astype(float))
    c = T.mix(c, SHOE, (z < 4.2)[:, None].astype(float))
    head = z > 60.5
    # hair at the back and sides, the cap above
    hair = head & (z > 63.5) & ((x < -1.5) | (np.abs(y) > 3.3)) & (z < 67.0)
    c = T.mix(c, HAIR, hair[:, None].astype(float))
    # face: brows, eyes, glasses, moustache, lips
    fr = head & (x > 2.0)
    for k in (1.0, -1.0):
        ey = (np.hypot(y - 1.55 * k, (z - 66.0) * 1.3) < 0.42) & fr
        c = T.mix(c, T.rgb("#2a1c16"), ey[:, None].astype(float))
        rim = np.abs(np.hypot(y - 1.6 * k, z - 66.0) - 1.25) < 0.12
        c = T.mix(c, FRAME, (rim & fr)[:, None].astype(float))
        brow = (np.abs(z - 67.25) < 0.17) & (np.abs(y - 1.6 * k) < 0.95) & fr
        c = T.mix(c, HAIR, brow[:, None].astype(float))
    bridge = (np.abs(z - 66.2) < 0.1) & (np.abs(y) < 0.4) & fr
    c = T.mix(c, FRAME, bridge[:, None].astype(float))
    mou = (np.abs(z - 63.6 + 0.25 * np.abs(y)) < 0.28) & (np.abs(y) < 1.6) & fr
    c = T.mix(c, HAIR, mou[:, None].astype(float))
    lip = (np.abs(z - 63.0) < 0.2) & (np.abs(y) < 1.0) & fr
    c = T.mix(c, LIP, lip[:, None].astype(float))
    c = T.shade(c, N, top=0.12)
    if skin == 1:
        return holo_texture(c[:, None, :], P[:, None, :], N[:, None, :])[:, 0, :]
    return c


def _paint_cap(P, N, skin):
    c = T.shade(T.fill(P, CAP), N, top=0.12)
    seam = np.abs(P[:, 1]) < 0.12
    c = T.mix(c, CAP * 0.7, seam[:, None].astype(float))
    if skin == 1:
        return holo_texture(c[:, None, :], P[:, None, :], N[:, None, :])[:, 0, :]
    return c


def make_standin_model():
    rig = standin_rig()
    b = builder.ModelBuilder(MODEL_PATH, rig, skins=2, verbose=False)
    b.group("main", size=(512, 512))
    for part in _standin_parts():
        b.add(part)
    hf = {}
    for side, k in SIDES:
        el, wr = np.array(rig.head(f"{side}ForeArm")), np.array(rig.head(f"{side}Hand"))
        f = _unit(wr - el)
        n = _unit(np.array([0.0, -k, 0.0]) - f * (-k * f[1]))
        hf[side] = (f, n, 4.0)
    anim = Animator(rig, StandinClips(rig), hf)
    anim.strides = (1.0, 1.0)
    for seq in anim.sequences():
        b.add_sequence(seq)
    for an, ab, apos in anim.attachment_points():
        b.attachment(an, ab, apos)
    b.eyeposition = (4.0, 0.0, 65.0)
    b.hull = ((-16.0, -16.0, 0.0), (16.0, 16.0, 72.0))
    st = b.build()
    for ti in set(st.skins[1]) - set(st.skins[0]):
        st.textures[ti].flags |= mdl.STUDIO_NF_ADDITIVE | mdl.STUDIO_NF_FULLBRIGHT
    data = mdl.write(st)
    mdl.read(data)
    return data


# =====================================================================================================================

def make_model():
    src = source_path()
    if src is not None:
        return make_scan_model(src)
    _log(f"source not installed ({lem_dir()}/rigged/lem_rigged.glb): the stand-in is built")
    return make_standin_model()


def build(out):
    out[MODEL_PATH] = make_model()
