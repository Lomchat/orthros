"""Triangle meshes from SDFs: surface nets with a narrow band, projection onto the surface,
Taubin smoothing, quadric-error edge-collapse decimation, crease-aware normals.

Faces are outward counter-clockwise (right-hand rule normals point outside).

    m = mesh_sdf(shape, budget=900)            # adaptive resolution then decimated to <= 900 triangles
    normals, corner_n = m.normals(crease=60)   # unique normals + per-corner indices
"""
import heapq
import math

import numpy as np


class TriMesh:
    def __init__(self, verts, faces):
        self.verts = np.asarray(verts, dtype=np.float64).reshape(-1, 3)
        self.faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)

    def copy(self):
        return TriMesh(self.verts.copy(), self.faces.copy())

    def __repr__(self):
        return f"<TriMesh {len(self.verts)} verts, {len(self.faces)} faces>"

    @property
    def bounds(self):
        return self.verts.min(0), self.verts.max(0)

    def face_normals(self, normalize=True):
        v = self.verts
        f = self.faces
        n = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
        if normalize:
            n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        return n

    def area(self):
        return float(np.sum(np.linalg.norm(self.face_normals(False), axis=1)) * 0.5)

    def transformed(self, R=None, t=None):
        v = self.verts
        if R is not None:
            v = v @ np.asarray(R).T
        if t is not None:
            v = v + np.asarray(t)
        return TriMesh(v, self.faces.copy())

    def normals(self, crease=60.0):
        return crease_normals(self, crease)

    def compact(self):
        """Drop unused vertices and degenerate faces."""
        f = self.faces
        good = (f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])
        f = f[good]
        used = np.unique(f)
        remap = -np.ones(len(self.verts), dtype=np.int64)
        remap[used] = np.arange(len(used))
        return TriMesh(self.verts[used], remap[f])

    def edges(self):
        f = self.faces
        e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
        e = np.sort(e, axis=1)
        return np.unique(e, axis=0)

    def is_closed_manifold(self):
        f = self.faces
        e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
        directed = {tuple(x) for x in e.tolist()}
        if len(directed) != len(e):
            return False
        return all((b, a) in directed for a, b in directed)


def merge(meshes):
    vs, fs, off = [], [], 0
    for m in meshes:
        vs.append(m.verts)
        fs.append(m.faces + off)
        off += len(m.verts)
    return TriMesh(np.concatenate(vs), np.concatenate(fs))


def weld(m, tol=1e-4):
    """Merge vertices closer than tol (grid quantisation)."""
    key = np.round(m.verts / tol).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    return TriMesh(m.verts[first], inv[m.faces]).compact()


# ---------------------------------------------------------------------------------------------
# surface nets
# ---------------------------------------------------------------------------------------------

def _grid_values(sdf, lo, h, shape, band=True):
    """SDF on the grid nodes; with band=True only near the surface (coarse pass every 4 nodes)."""
    nx, ny, nz = shape
    xs = lo[0] + h * np.arange(nx)
    ys = lo[1] + h * np.arange(ny)
    zs = lo[2] + h * np.arange(nz)
    if not band or nx * ny * nz < 64 ** 3:
        P = np.stack(np.meshgrid(xs, ys, zs, indexing="ij"), axis=-1).reshape(-1, 3)
        return _eval_chunked(sdf, P).reshape(nx, ny, nz)
    B = 4
    cx, cy, cz = (nx - 1) // B + 1, (ny - 1) // B + 1, (nz - 1) // B + 1
    CP = np.stack(np.meshgrid(lo[0] + h * B * np.arange(cx), lo[1] + h * B * np.arange(cy),
                              lo[2] + h * B * np.arange(cz), indexing="ij"), axis=-1).reshape(-1, 3)
    C = _eval_chunked(sdf, CP).reshape(cx, cy, cz)
    # a block (coarse cell) needs exact values if any corner is close to the surface
    diag = 1.6 * B * h * math.sqrt(3.0)
    near = np.abs(C) < diag
    blk = np.zeros((max(cx - 1, 1), max(cy - 1, 1), max(cz - 1, 1)), dtype=bool)
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                blk |= near[dx:dx + blk.shape[0], dy:dy + blk.shape[1], dz:dz + blk.shape[2]]
                sgn = C[dx:dx + blk.shape[0], dy:dy + blk.shape[1], dz:dz + blk.shape[2]] < 0
                if dx == dy == dz == 0:
                    s0 = sgn
                else:
                    blk |= sgn != s0
    # nearest coarse value everywhere (correct sign far from the surface)
    ii = np.minimum(np.round(np.arange(nx) / B).astype(int), cx - 1)
    jj = np.minimum(np.round(np.arange(ny) / B).astype(int), cy - 1)
    kk = np.minimum(np.round(np.arange(nz) / B).astype(int), cz - 1)
    D = C[np.ix_(ii, jj, kk)].copy()
    # fine nodes inside flagged blocks (node i belongs to blocks floor(i/B) and floor((i-1)/B))
    bi = np.minimum(np.arange(nx) // B, blk.shape[0] - 1)
    bj = np.minimum(np.arange(ny) // B, blk.shape[1] - 1)
    bk = np.minimum(np.arange(nz) // B, blk.shape[2] - 1)
    bi2 = np.clip((np.arange(nx) - 1) // B, 0, blk.shape[0] - 1)
    bj2 = np.clip((np.arange(ny) - 1) // B, 0, blk.shape[1] - 1)
    bk2 = np.clip((np.arange(nz) - 1) // B, 0, blk.shape[2] - 1)
    mask = np.zeros((nx, ny, nz), dtype=bool)
    for a in (bi, bi2):
        for b in (bj, bj2):
            for c in (bk, bk2):
                mask |= blk[np.ix_(a, b, c)]
    idx = np.nonzero(mask)
    P = np.stack([xs[idx[0]], ys[idx[1]], zs[idx[2]]], axis=1)
    D[idx] = _eval_chunked(sdf, P)
    return D


def _eval_chunked(sdf, P, chunk=400000):
    out = np.empty(len(P))
    for i in range(0, len(P), chunk):
        out[i:i + chunk] = sdf(P[i:i + chunk])
    return out


def surface_nets(sdf, lo, hi, h, band=True):
    """Naive surface nets on a grid of spacing h over [lo, hi] (bounds padded by 2h)."""
    lo = np.asarray(lo, dtype=np.float64) - 2 * h
    hi = np.asarray(hi, dtype=np.float64) + 2 * h
    shape = tuple(int(math.ceil((hi[k] - lo[k]) / h)) + 1 for k in range(3))
    D = _grid_values(sdf, lo, h, shape, band)
    D = np.where(D == 0, 1e-9, D)
    nx, ny, nz = shape
    cs = (nx - 1, ny - 1, nz - 1)
    acc = np.zeros(cs + (3,))
    cnt = np.zeros(cs)
    quads = []
    inside = D < 0
    for axis in range(3):
        sl0 = [slice(None)] * 3
        sl1 = [slice(None)] * 3
        sl0[axis] = slice(0, -1)
        sl1[axis] = slice(1, None)
        d0, d1 = D[tuple(sl0)], D[tuple(sl1)]
        e = (d0 < 0) != (d1 < 0)
        ei = np.nonzero(e)
        if len(ei[0]) == 0:
            continue
        t = d0[ei] / (d0[ei] - d1[ei])
        pts = np.stack([lo[k] + h * ei[k].astype(np.float64) for k in range(3)], axis=1)
        pts[:, axis] += h * t
        o1, o2 = [k for k in range(3) if k != axis]
        # the 4 cells around the edge: offsets (0/-1) along o1, o2
        for a in (0, -1):
            for b in (0, -1):
                c = [ei[0].copy(), ei[1].copy(), ei[2].copy()]
                c[o1] = c[o1] + a
                c[o2] = c[o2] + b
                ok = (c[o1] >= 0) & (c[o1] < cs[o1]) & (c[o2] >= 0) & (c[o2] < cs[o2])
                cc = tuple(x[ok] for x in c)
                np.add.at(acc, cc, pts[ok])
                np.add.at(cnt, cc, 1)
        # quads for interior edges
        ok = (ei[o1] >= 1) & (ei[o1] < cs[o1]) & (ei[o2] >= 1) & (ei[o2] < cs[o2])
        base = [x[ok] for x in ei]
        neg = inside[tuple(sl0)][tuple(base)]
        # (o1-,o2-), (o1+,o2-), (o1+,o2+), (o1-,o2+) with (o1, o2) cyclic after axis -> normal +axis
        # cyclic order: axis x -> (y, z); axis y -> (z, x); axis z -> (x, y)
        if axis == 1:
            p1, p2 = 2, 0
        else:
            p1, p2 = o1, o2
        ring = []
        for a, b in ((-1, -1), (0, -1), (0, 0), (-1, 0)):
            c = [base[0].copy(), base[1].copy(), base[2].copy()]
            c[p1] = c[p1] + a
            c[p2] = c[p2] + b
            ring.append(np.ravel_multi_index(tuple(c), cs))
        ring = np.stack(ring, axis=1)
        ring[~neg] = ring[~neg][:, ::-1]
        quads.append(ring)
    if not quads:
        return TriMesh(np.zeros((0, 3)), np.zeros((0, 3), np.int64))
    quads = np.concatenate(quads)
    active = cnt.reshape(-1) > 0
    vid = -np.ones(active.shape[0], dtype=np.int64)
    vid[active] = np.arange(int(active.sum()))
    verts = (acc.reshape(-1, 3)[active] / cnt.reshape(-1)[active][:, None])
    q = vid[quads]
    a, b, c, d = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    diag_ac = np.linalg.norm(verts[a] - verts[c], axis=1)
    diag_bd = np.linalg.norm(verts[b] - verts[d], axis=1)
    use_ac = diag_ac <= diag_bd
    f1 = np.where(use_ac[:, None], np.stack([a, b, c], 1), np.stack([a, b, d], 1))
    f2 = np.where(use_ac[:, None], np.stack([a, c, d], 1), np.stack([b, c, d], 1))
    return TriMesh(verts, np.concatenate([f1, f2])).compact()


def project(m, sdf, iters=2, max_step=None):
    """Move vertices onto the zero level set along the gradient (Newton steps, clamped)."""
    v = m.verts.copy()
    for _ in range(iters):
        d = sdf(v)
        g = sdf.gradient(v, eps=1e-3)
        g2 = np.maximum(np.sum(g * g, axis=1), 1e-9)
        step = (d / g2)[:, None] * g
        if max_step is not None:
            L = np.linalg.norm(step, axis=1, keepdims=True)
            step = step * np.minimum(1.0, max_step / np.maximum(L, 1e-12))
        v -= step
    return TriMesh(v, m.faces.copy())


def _neighbor_sum(m):
    e = m.edges()
    n = len(m.verts)
    deg = np.bincount(e.reshape(-1), minlength=n).astype(np.float64)
    return e, deg


def taubin(m, iters=5, lam=0.5, mu=-0.53):
    """Taubin lambda/mu smoothing (shrink-free Laplacian)."""
    e, deg = _neighbor_sum(m)
    v = m.verts.copy()
    deg = np.maximum(deg, 1)[:, None]
    for _ in range(iters):
        for f in (lam, mu):
            s = np.zeros_like(v)
            np.add.at(s, e[:, 0], v[e[:, 1]])
            np.add.at(s, e[:, 1], v[e[:, 0]])
            v = v + f * (s / deg - v)
    return TriMesh(v, m.faces.copy())


def laplacian(m, iters=1, lam=0.5, mask=None):
    """Plain Laplacian smoothing (optionally only vertices where mask is True)."""
    e, deg = _neighbor_sum(m)
    v = m.verts.copy()
    deg = np.maximum(deg, 1)[:, None]
    for _ in range(iters):
        s = np.zeros_like(v)
        np.add.at(s, e[:, 0], v[e[:, 1]])
        np.add.at(s, e[:, 1], v[e[:, 0]])
        nv = v + lam * (s / deg - v)
        v = nv if mask is None else np.where(np.asarray(mask)[:, None], nv, v)
    return TriMesh(v, m.faces.copy())


# ---------------------------------------------------------------------------------------------
# quadric error decimation
# ---------------------------------------------------------------------------------------------

def decimate(m, target_faces, min_dot=0.25, max_cost=None):
    """Quadric error metric edge collapse down to target_faces (closed manifold input assumed;
    unsafe collapses - link condition, flips, slivers - are skipped)."""
    m = m.compact()
    nfaces = len(m.faces)
    if nfaces <= target_faces:
        return m
    V = [list(map(float, p)) for p in m.verts]
    F = [list(map(int, f)) for f in m.faces]
    nv = len(V)
    vf = [set() for _ in range(nv)]
    for fi, (a, b, c) in enumerate(F):
        vf[a].add(fi)
        vf[b].add(fi)
        vf[c].add(fi)
    Q = [[0.0] * 10 for _ in range(nv)]
    fn = m.face_normals(False)
    for fi, (a, b, c) in enumerate(F):
        n = fn[fi]
        ar = float(np.linalg.norm(n))
        if ar < 1e-12:
            continue
        nx, ny, nz = n / ar
        d = -(nx * V[a][0] + ny * V[a][1] + nz * V[a][2])
        w = ar * 0.5
        k = (nx * nx, nx * ny, nx * nz, nx * d, ny * ny, ny * nz, ny * d, nz * nz, nz * d, d * d)
        for vtx in (a, b, c):
            q = Q[vtx]
            for i in range(10):
                q[i] += w * k[i]
    avg_edge2 = float(np.mean(np.sum((m.verts[m.faces[:, 0]] - m.verts[m.faces[:, 1]]) ** 2, axis=1)))
    reg = 1e-3 / max(avg_edge2, 1e-12)
    alive_v = [True] * nv
    alive_f = [True] * nfaces
    stamp = [0] * nv

    def qerr(q, x, y, z):
        return (q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y
                + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9])

    def best(u, v):
        q = [Q[u][i] + Q[v][i] for i in range(10)]
        pu, pv = V[u], V[v]
        mid = [(pu[i] + pv[i]) * 0.5 for i in range(3)]
        cands = [pu, pv, mid]
        a11, a12, a13, a22, a23, a33 = q[0], q[1], q[2], q[4], q[5], q[7]
        det = (a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13))
        scale = (abs(a11) + abs(a22) + abs(a33)) ** 3 + 1e-30
        if abs(det) > 1e-6 * scale:
            b1, b2, b3 = -q[3], -q[6], -q[8]
            x = (b1 * (a22 * a33 - a23 * a23) - a12 * (b2 * a33 - a23 * b3) + a13 * (b2 * a23 - a22 * b3)) / det
            y = (a11 * (b2 * a33 - a23 * b3) - b1 * (a12 * a33 - a23 * a13) + a13 * (a12 * b3 - b2 * a13)) / det
            z = (a11 * (a22 * b3 - b2 * a23) - a12 * (a12 * b3 - b2 * a13) + b1 * (a12 * a23 - a22 * a13)) / det
            el = sum((pu[i] - pv[i]) ** 2 for i in range(3))
            if sum(((x, y, z)[i] - mid[i]) ** 2 for i in range(3)) <= el:
                cands.append([x, y, z])
        el2 = sum((pu[i] - pv[i]) ** 2 for i in range(3))
        bc, bp = None, None
        for p in cands:
            c = qerr(q, p[0], p[1], p[2])
            if bc is None or c < bc:
                bc, bp = c, p
        return bc + reg * el2 * el2 * 1e-2 + 1e-9 * el2, bp

    heap = []

    def push(u, v):
        if u > v:
            u, v = v, u
        c, p = best(u, v)
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
    while count > target_faces and heap:
        c, u, v, su, sv, p = heapq.heappop(heap)
        if not (alive_v[u] and alive_v[v]) or stamp[u] != su or stamp[v] != sv:
            continue
        if max_cost is not None and c > max_cost:
            break
        shared = vf[u] & vf[v]
        if len(shared) != 2:
            continue
        opp = set()
        for fi in shared:
            opp.update(F[fi])
        opp -= {u, v}
        if (nbrs(u) & nbrs(v)) != opp:
            continue
        # flip / sliver check
        ok = True
        for w, other in ((u, v), (v, u)):
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
                # reject needle triangles (area vs longest edge)
                e2 = max(sum((pts2[i][k] - pts2[(i + 1) % 3][k]) ** 2 for k in range(3)) for i in range(3))
                if l1 / max(e2, 1e-12) < 0.02:
                    ok = False
                    break
            if not ok:
                break
        if not ok:
            continue
        # collapse v into u
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
        stamp[u] += 1
        for w in nbrs(u):
            push(u, w)
    faces = [F[i] for i in range(nfaces) if alive_f[i]]
    return TriMesh(np.array(V), np.array(faces, dtype=np.int64).reshape(-1, 3)).compact()


# ---------------------------------------------------------------------------------------------
# normals
# ---------------------------------------------------------------------------------------------

def crease_normals(m, crease=60.0):
    """Per-corner normals smoothed across edges whose dihedral angle is below `crease` degrees.

    Returns (normals (K, 3), corner_index (F, 3)) with normals deduplicated per vertex.
    """
    fn_area = m.face_normals(False)  # area weighted
    fn = fn_area / np.maximum(np.linalg.norm(fn_area, axis=1, keepdims=True), 1e-12)
    F = m.faces
    nf = len(F)
    cos_c = math.cos(math.radians(crease))
    # vertex -> incident faces
    order = np.argsort(F.reshape(-1), kind="stable")
    vids = F.reshape(-1)[order]
    starts = np.searchsorted(vids, np.arange(len(m.verts) + 1))
    corner_index = np.zeros((nf, 3), dtype=np.int64)
    normals = []
    if crease >= 180.0:
        vn = np.zeros((len(m.verts), 3))
        np.add.at(vn, F.reshape(-1), np.repeat(fn_area, 3, axis=0))
        vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
        return vn, F.copy()
    for vtx in range(len(m.verts)):
        corners = order[starts[vtx]:starts[vtx + 1]]  # flat corner ids (face*3 + k)
        if len(corners) == 0:
            continue
        faces = corners // 3
        dots = fn[faces] @ fn[faces].T
        groups = {}
        for i, c in enumerate(corners):
            sel = dots[i] >= cos_c
            n = fn_area[faces[sel]].sum(0)
            n = n / max(np.linalg.norm(n), 1e-12)
            key = tuple(np.round(n, 4))
            if key not in groups:
                groups[key] = len(normals)
                normals.append(n)
            corner_index[faces[i], c % 3] = groups[key]
    return np.array(normals), corner_index


# ---------------------------------------------------------------------------------------------
# adaptive SDF meshing
# ---------------------------------------------------------------------------------------------

def mesh_sdf(sdf, budget=800, voxel=None, max_cells=160, oversample=4.0, smooth=2, decimate_to_budget=True):
    """Mesh an SDF: pick the voxel size from the surface area and the triangle budget, surface nets
    in a narrow band, projection, Taubin smoothing, QEM decimation to `budget`, final projection."""
    lo, hi = np.asarray(sdf.lo, float), np.asarray(sdf.hi, float)
    ext = float(np.max(hi - lo))
    if voxel is None:
        thin = float(np.min(hi - lo))
        h0 = min(ext / 48.0, thin / 6.0)
        coarse = surface_nets(sdf, lo, hi, h0, band=True)
        area = max(coarse.area(), 1e-6)
        t0 = max(oversample * budget, 2500.0)
        h = math.sqrt(2.0 * area / t0)
        h = min(h, thin / 8.0)          # keep at least ~8 voxels across the thinnest dimension
        h = max(h, ext / max_cells)
    else:
        h = float(voxel)
    m = surface_nets(sdf, lo, hi, h)
    if len(m.faces) == 0:
        raise ValueError("SDF produced an empty mesh (check bounds/sign)")
    m = project(m, sdf, iters=2, max_step=h)
    if smooth:
        m = taubin(m, iters=smooth)
        m = project(m, sdf, iters=1, max_step=h)
    if decimate_to_budget and len(m.faces) > budget:
        m = decimate(m, budget)
        m = project(m, sdf, iters=1, max_step=0.5 * h)
    m.voxel = h
    return m
