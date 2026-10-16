"""Import a skinned, animated glTF 2.0 model into a smooth-skinned GoldSrc studio model (Xash3D bone weights).

    imp = official.Importer("/path/model.glb", height=30)          # bind pose, scaled to 30 units tall
    imp.rig                                    # rig.Rig of the kept joints (identity rest rotations, heads)
    imp.animation_names()
    idle = imp.sequence("pm0025_00_defaultwait01_loop", "idle", fps=30, loop=True, activity=mdl.ACT["IDLE"])
    walk = imp.sequence("walk01_loop", "walk", loop=True, activity=mdl.ACT["WALK"], root_motion="feet",
                        feet=["LFoot", "RFoot"])
    jump = R.make_sequence(imp.rig, "spawn", pose_fn, frames=30, fps=30)    # authored on the official skeleton
    st = imp.studio("pokemon/pikachu.mdl", [idle, walk, jump], attachments=[("mouth", "Head", (9, 0, 26))])
    data = mdl.write(st)

What the conversion does (generic, driven only by the glTF content and the options):
  * Axes: glTF +Y up, +Z forward (the model faces +Z), +X its left -> GoldSrc +Z up, +X forward, +Y left
    (a proper rotation, windings kept); `yaw` (degrees) turns the result about +Z if a source faces elsewhere.
    Uniform scale to `height` units (rest pose) or a fixed `scale`; origin: feet on z = 0, x/y from the
    glTF origin ("source") or the rest bounding-box centre ("bbox").
  * Rest pose = the skins' bind pose (inverse bind matrices), placed by the skin's main trunk joint's default
    pose, so meshes are undeformed at rest whatever the file's default node pose is.
  * Skeleton: the skins' joints; joints no vertex uses are dropped unless they lie between used joints (their
    animation is folded into the kept joints' world matrices, so nothing is lost), joints above the common
    ancestor of the used ones are dropped, then the least-weighted leaves are merged into their parents until
    MAXSTUDIOBONES holds.  Bones get IDENTITY rest rotations (heads at the bind joint positions): the rig.py
    conventions and helpers (Pose, IK, make_sequence) work unchanged on the official skeleton.
  * Weights: the 4 strongest per vertex (JOINTS_0/1, WEIGHTS_0/1), pruned joints' weights given to their kept
    ancestors, renormalised to exactly 255 (largest remainder); normals carry their vertex's weights.
  * Animations: sampled at `fps` from the glTF samplers (LINEAR / STEP / CUBICSPLINE); per bone the rigid part
    (polar decomposition) of its model-space skinning matrix W(t) * W(bind)^-1 and its joint position.  Bone
    scale cannot be expressed by the format (the renderer's bone matrices are rigid): animated scale is dropped
    (children still follow the scaled positions).  Root motion: "extract" moves the forward displacement of the
    cycle into linearmovement, "feet" measures it from the planted feet of an in-place gait (no sliding).
  * Materials -> 8-bit textures: base colour texture x factor, wrapped UVs normalised per triangle, cropped to
    the used area (powers of two), downscaled to max_size / upscaled to min_size (finer integer s/t on eyes),
    quantised per texture (256 colours, median cut + k-means); alpha MASK/BLEND -> STUDIO_NF_MASKED with
    index 255 transparent.  Double-sided materials: open surfaces get a back face (GoldSrc culls back faces).
  * Missing normals are rebuilt (positions welded across UV seams, crease angle).
  * Bounding boxes per sequence from the skinned vertices of every frame, hitboxes per main bone from the
    extents of the vertices it dominates.

Untrusted input: the glTF is parsed by gltf.py (bounds-checked); nothing from it is executed.
"""
import math
import sys

import numpy as np
from PIL import Image

from . import gltf, mdl, mesh as meshmod, rig as R, texture

# glTF scene axes -> GoldSrc model axes: gs_x = gl_z (forward), gs_y = gl_x (left), gs_z = gl_y (up)
AXES = np.array([[0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
_AXIS = {"+x": (1, 0, 0), "-x": (-1, 0, 0), "+y": (0, 1, 0), "-y": (0, -1, 0), "+z": (0, 0, 1), "-z": (0, 0, -1)}


def axes_matrix(up="+y", forward="+z"):
    """Rows (forward, left, up) in source coordinates: the rotation from the source scene to GoldSrc axes.
    glTF's convention is up +y, forward +z; some exports (rigs rotated by their converter) differ."""
    u = np.array(_AXIS[up], float)
    f = np.array(_AXIS[forward], float)
    if abs(u @ f) > 1e-9:
        raise ValueError("up and forward must be perpendicular")
    return np.array([f, np.cross(u, f), u])


# ----------------------------------------------------------------------------------------------
# math
# ----------------------------------------------------------------------------------------------

def polar_rotation(a):
    """Nearest rotation matrix (polar decomposition via SVD) of a 3x3 matrix."""
    u, _, vt = np.linalg.svd(np.asarray(a, dtype=np.float64))
    r = u @ vt
    if np.linalg.det(r) < 0:
        u[:, -1] = -u[:, -1]
        r = u @ vt
    return r


def euler_from_matrix(m):
    """Engine euler angles (x roll, y pitch, z yaw radians, R = Rz Ry Rx) of a rotation, robust at gimbal lock."""
    m = np.asarray(m, dtype=np.float64)
    cy = math.hypot(m[0, 0], m[1, 0])
    y = math.atan2(-m[2, 0], cy)
    if cy > 1e-9:
        x = math.atan2(m[2, 1], m[2, 2])
        z = math.atan2(m[1, 0], m[0, 0])
    else:  # cos(pitch) = 0: only x -+ z is determined; take z = 0, then m11 = cos x, m12 = -sin x
        z = 0.0
        x = math.atan2(-m[1, 2], m[1, 1])
    return np.array([x, y, z])


def _largest_remainder(w, total=255):
    """Rows of non-negative weights (n, k) -> integers summing to `total` per row (rows with weight)."""
    w = np.asarray(w, dtype=np.float64)
    s = w.sum(1, keepdims=True)
    f = np.where(s > 0, w / np.where(s > 0, s, 1.0) * total, 0.0)
    base = np.floor(f).astype(np.int64)
    rem = total - base.sum(1)
    frac = f - base
    order = np.argsort(-frac, axis=1, kind="stable")
    out = base.copy()
    for i in np.nonzero(rem > 0)[0]:
        for k in order[i, :rem[i]]:
            out[i, k] += 1
    return out


# ----------------------------------------------------------------------------------------------
# texture quantisation
# ----------------------------------------------------------------------------------------------

def quantize_texture(rgb, transparent=None, iters=12):
    """256-colour quantisation of good quality for one texture: median cut seeded k-means, distances weighted
    toward perceived differences (green > red > blue), deterministic.  Returns (indices, palette)."""
    a = np.asarray(rgb)
    if a.dtype != np.uint8:
        a = np.clip(np.round(a * 255.0), 0, 255).astype(np.uint8)
    H, W = a.shape[:2]
    flat = a.reshape(-1, 3)
    valid = np.ones(H * W, bool) if transparent is None else ~np.asarray(transparent, bool).reshape(-1)
    n = 255 if transparent is not None else 256
    src = flat[valid] if valid.any() else flat[:1]
    uniq, counts = np.unique(src, axis=0, return_counts=True)
    wch = np.array([0.55, 0.75, 0.40])  # channel weights (sqrt of luma-ish weights)
    uf = uniq.astype(np.float64) * wch
    w = counts.astype(np.float64)
    if len(uniq) <= n:
        pal = uf
    else:
        pal = texture._median_cut(uf, np.sqrt(w), n)
        for _ in range(iters):
            lab = texture._nearest(uf, pal)
            sums = np.zeros_like(pal)
            np.add.at(sums, lab, uf * w[:, None])
            tot = np.bincount(lab, weights=w, minlength=len(pal))
            nz = tot > 0
            pal[nz] = sums[nz] / tot[nz][:, None]
            # re-seed empty clusters on the worst represented colours
            if (~nz).any():
                err = np.sum((uf - pal[lab]) ** 2, axis=1) * w
                worst = np.argsort(-err, kind="stable")[:int((~nz).sum())]
                pal[np.nonzero(~nz)[0][:len(worst)]] = uf[worst]
    pal_u8 = np.clip(np.round(pal / wch), 0, 255).astype(np.uint8)
    pal_u8 = np.unique(pal_u8, axis=0)
    lum = pal_u8.astype(np.float64) @ np.array([0.299, 0.587, 0.114])
    order = np.lexsort((pal_u8[:, 2], pal_u8[:, 1], pal_u8[:, 0], lum))
    pal_u8 = pal_u8[order]
    palette = np.zeros((256, 3), np.uint8)
    palette[:len(pal_u8)] = pal_u8
    u2, inv2 = np.unique(flat, axis=0, return_inverse=True)
    idx = texture._nearest(u2.astype(np.float64) * wch, pal_u8.astype(np.float64) * wch)[inv2.reshape(-1)]
    if transparent is not None:
        idx[~valid] = 255
        opaque = flat[valid]
        palette[255] = np.round(opaque.mean(0)).astype(np.uint8) if len(opaque) else (0, 0, 0)
    return idx.reshape(H, W).astype(np.uint8), palette


def _coverage(st, W, H, grow=2):
    """Texels used by triangles with texel coordinates st (T, 3, 2) (one repeat allowed), grown by `grow`."""
    cov = np.zeros((H, W), bool)
    if len(st):
        _, px, py, _ = texture.raster_texels(st, (2 * W, 2 * H))
        cov[py % H, px % W] = True
        c = np.floor(st.reshape(-1, 2)).astype(np.int64)
        cov[c[:, 1] % H, c[:, 0] % W] = True
        # edge midpoints (slivers thinner than a texel)
        for a, b in ((0, 1), (1, 2), (2, 0)):
            for t in (0.25, 0.5, 0.75):
                m = np.floor(st[:, a] * (1 - t) + st[:, b] * t).astype(np.int64)
                cov[m[:, 1] % H, m[:, 0] % W] = True
    for _ in range(grow):
        g = cov.copy()
        g[1:] |= cov[:-1]
        g[:-1] |= cov[1:]
        g[:, 1:] |= cov[:, :-1]
        g[:, :-1] |= cov[:, 1:]
        cov = g
    return cov


def _pot_ceil(n):
    p = 1
    while p < n:
        p *= 2
    return p


def _dilate_rgba(arr, iters=8):
    """Spread opaque colours into transparent texels (bilinear filtering at mask edges, palette not wasted)."""
    rgb = arr[..., :3].astype(np.float64)
    known = arr[..., 3] >= 128
    if known.all() or not known.any():
        return arr
    rgb = texture.dilate(rgb / 255.0, known, iters) * 255.0
    out = arr.copy()
    out[..., :3] = np.clip(np.round(rgb), 0, 255).astype(np.uint8)
    return out


def fire_tint(rgba, stops=((0.0, (0, 0, 0)), (0.3, (140, 25, 0)), (0.6, (235, 100, 10)),
                            (0.85, (255, 165, 40)), (1.0, (255, 215, 110)))):
    """Luminance -> fire colour ramp (black stays black: for STUDIO_NF_ADDITIVE flame masks)."""
    a = np.asarray(rgba).astype(np.float64)
    L = (a[..., :3] @ np.array([0.299, 0.587, 0.114])) / 255.0
    xs = np.array([s[0] for s in stops])
    out = a.copy()
    for c in range(3):
        out[..., c] = np.interp(L, xs, [s[1][c] for s in stops])
    return np.clip(np.round(out), 0, 255).astype(np.uint8)


def recolor(rgba, pairs, sigma=28.0):
    """Shading-preserving colour remap: pairs [(source rgb, target rgb), ...]; each pixel is assigned softly to
    the source keys (Gaussian of the RGB / chromaticity distance, sigma) and becomes the target colour scaled by
    its brightness relative to the source key, so a darker or lighter shade of a source colour becomes the same
    shade of its target.  Add (c, c) pairs to
    protect colours close to a remapped one (e.g. a mouth near a membrane red)."""
    a = np.asarray(rgba).astype(np.float64)
    rgb = a[..., :3]
    src = np.array([p[0] for p in pairs], dtype=np.float64)
    dst = np.array([p[1] for p in pairs], dtype=np.float64)
    d2 = ((rgb[..., None, :] - src) ** 2).sum(-1)
    # luminance-normalised distance as well, so shades of a key still match it
    lum = rgb.sum(-1, keepdims=True) + 1.0
    chroma = rgb / lum
    sch = src / (src.sum(-1, keepdims=True) + 1.0)
    c2 = ((chroma[..., None, :] - sch) ** 2).sum(-1) * (255.0 ** 2) * 9
    w = np.exp(-np.minimum(d2, c2 + 0.25 * d2) / (2 * sigma * sigma))
    tot = w.sum(-1, keepdims=True)
    luma = np.array([0.299, 0.587, 0.114])
    Lp = rgb @ luma + 1.0
    Ls = src @ luma + 1.0
    # target colour at the pixel's relative brightness (clean shades, no per-channel noise amplification)
    cand = dst[None, None] * (Lp[..., None] / Ls)[..., None] if rgb.ndim == 3 else dst * (Lp[..., None] / Ls)[..., None]
    mapped = (w[..., None] * cand).sum(-2) / np.maximum(tot, 1e-12)
    keep = np.clip(1.0 - tot, 0.0, 1.0)  # far from every key: unchanged
    out = a.copy()
    out[..., :3] = mapped * (1.0 - keep) + rgb * keep
    return np.clip(np.round(out), 0, 255).astype(np.uint8)


# ----------------------------------------------------------------------------------------------
# the importer
# ----------------------------------------------------------------------------------------------

class Surface:
    """Triangles of one material: rest model-space corners with weights (filled by Importer)."""

    def __init__(self, material):
        self.material = material
        self.pos = []      # (n, 3) per vertex
        self.nrm = []
        self.uv = []
        self.joints = []   # (n, k) node indices
        self.weights = []  # (n, k)
        self.tris = []     # (t, 3) indices into this surface's vertices


class Importer:
    def __init__(self, path, height=None, scale=None, yaw=0.0, up="+y", forward="+z", origin="source", exclude_meshes=(),
                 exclude_materials=(), keep_joints=(), max_bones=mdl.MAXSTUDIOBONES, max_size=512, min_size=256,
                 crop=True, double_sided="auto", crease=70.0, texture_filter=None, verbose=True, gl=None,
                 strip_suffix=True, height_pose=None, place=None, materials=None):
        """path: .glb/.gltf file (or gl=: an already loaded gltf.GLTF).
        height: rest-pose height in units (uniform scale), or scale: units per glTF unit.
        up / forward: source axes of the model's up and facing directions ("+y" / "+z" in glTF; exports whose
        converter rotated the rig may differ: check the rest views).  yaw: extra turn about +z (degrees).
        origin: "source" (glTF origin over the ground) or "bbox" (rest bounding-box centre).
        exclude_meshes / exclude_materials: names (node, mesh or material) to leave out.
        keep_joints: joint names kept even without vertices (attachment carriers, motion references).
        max_size / min_size: texture size bounds (powers of two; small textures are upscaled so integer s/t
        are finer).  crop: crop textures to the used UV area.  double_sided: "auto" (back faces for the open
        surfaces of doubleSided materials), True (all of them), False.
        texture_filter(material_name, rgba uint8 (H, W, 4)) -> rgba: optional recolouring hook.
        materials: {material name: options} with any of "flags" (texture flags OR'ed in, e.g.
        STUDIO_NF_ADDITIVE | STUDIO_NF_FULLBRIGHT for a flame), "filter" (rgba -> rgba, after texture_filter),
        "max_size", "min_size", "crop", "double_sided" (True / False / "auto"), "exclude" (True).
        height_pose: (animation name, time) measured instead of the bind pose for `height`.
        place: (animation name, time): the pose whose trunk joint places the bind skeleton in the scene, instead
        of the default node pose.  Needed when the file's animations re-orient container nodes above the
        skeleton (e.g. an animation undoing a converter's axis fix): rest and animations then share one frame."""
        self.path = path
        self.g = gl if gl is not None else gltf.load(path)
        self.verbose = verbose
        self.report = []
        self.max_size, self.min_size, self.crop = max_size, min_size, crop
        self.double_sided = double_sided
        self.texture_filter = texture_filter
        self.crease = crease
        self.mat_opts = dict(materials or {})
        exclude_materials = set(exclude_materials) | {k for k, v in self.mat_opts.items() if v.get("exclude")}
        g = self.g
        G = g.world_matrices() if place is None else g.world_matrices(self._anim(place[0]), float(place[1]))

        # --- bind pose per skin -------------------------------------------------------------------
        self.bind = {}       # node -> scene-space bind world matrix (4x4)
        skin_kref = {}
        insts = []
        for ni, mi in g.mesh_instances():
            node = g.nodes[ni]
            m = g.meshes[mi]
            if node.name in exclude_meshes or m.name in exclude_meshes:
                continue
            insts.append((ni, mi))
        used_count = {}
        for ni, mi in insts:
            sk = g.nodes[ni].skin
            if sk < 0:
                continue
            for p in g.meshes[mi].primitives:
                for jn, wn in self._joint_attrs(p):
                    J, W = p.attributes[jn], p.attributes[wn]
                    for j in range(J.shape[1]):
                        nodes = np.asarray(g.skins[sk].joints)[np.clip(J[:, j], 0, len(g.skins[sk].joints) - 1)]
                        for n, w in zip(nodes, W[:, j]):
                            if w > 0:
                                used_count[int(n)] = used_count.get(int(n), 0.0) + float(w)
        for si, s in enumerate(g.skins):
            K = np.einsum("jab,jbc->jac", G[s.joints], s.inverse_bind)
            depth = [self._depth(n) for n in s.joints]
            cand = [j for j, n in enumerate(s.joints) if used_count.get(n, 0) > 0] or list(range(len(s.joints)))
            ref = min(cand, key=lambda j: (depth[j], -used_count.get(s.joints[j], 0.0), j))
            kref = K[ref]
            skin_kref[si] = kref
            for j, n in enumerate(s.joints):
                b = kref @ np.linalg.inv(s.inverse_bind[j])
                if n in self.bind and np.abs(self.bind[n] - b).max() > 1e-4 * max(1.0, np.abs(b).max()):
                    self._log(f"warning: joint {g.nodes[n].name} has different bind matrices in two skins")
                    continue
                self.bind.setdefault(n, b)
            dev = float(np.abs(K - kref).max())
            if dev > 1e-3:
                self._log(f"skin {si}: default node pose differs from the bind pose (max {dev:.3f}); rest = bind pose")

        # --- surfaces in scene space (rest = bind) -----------------------------------------------
        surfaces = {}
        for ni, mi in insts:
            node = g.nodes[ni]
            sk = node.skin
            for p in g.meshes[mi].primitives:
                if p.material >= 0 and g.materials[p.material].name in exclude_materials:
                    continue
                if len(p.triangles) == 0:
                    continue
                pos = p.attributes["POSITION"]
                if sk >= 0:
                    kref = skin_kref[sk]
                    joints, weights = [], []
                    for jn, wn in self._joint_attrs(p):
                        jj = np.clip(p.attributes[jn], 0, len(g.skins[sk].joints) - 1)
                        joints.append(np.asarray(g.skins[sk].joints)[jj])
                        weights.append(np.asarray(p.attributes[wn], dtype=np.float64))
                    joints = np.concatenate(joints, 1)
                    weights = np.concatenate(weights, 1)
                    M = kref
                else:
                    anc = node.index
                    while anc != -1 and anc not in self.bind:
                        anc = g.nodes[anc].parent
                    if anc == -1:
                        anc = node.index
                        self.bind.setdefault(anc, G[anc])
                    joints = np.full((len(pos), 1), anc, np.int64)
                    weights = np.ones((len(pos), 1))
                    M = G[node.index]
                    if anc != node.index:  # rigid on the joint: express in its bind pose
                        M = self.bind[anc] @ np.linalg.inv(G[anc]) @ G[node.index]
                P = pos @ M[:3, :3].T + M[:3, 3]
                if "NORMAL" in p.attributes:
                    Nn = p.attributes["NORMAL"] @ np.linalg.inv(M[:3, :3])  # inverse transpose
                    Nn /= np.maximum(np.linalg.norm(Nn, axis=1, keepdims=True), 1e-12)
                else:
                    Nn = None
                mat = p.material
                matobj = g.materials[mat] if mat >= 0 else gltf.Material(name="default")
                uv = p.attributes.get(f"TEXCOORD_{matobj.texcoord}")
                if uv is None:
                    uv = np.zeros((len(pos), 2))
                if matobj.uv_transform is not None:
                    uv = np.c_[uv, np.ones(len(uv))] @ matobj.uv_transform.T
                    uv = uv[:, :2]
                srf = surfaces.setdefault(mat, Surface(mat))
                base = sum(len(x) for x in srf.pos)
                srf.pos.append(P)
                srf.nrm.append(Nn)
                srf.uv.append(np.asarray(uv, dtype=np.float64))
                srf.joints.append(joints)
                srf.weights.append(weights)
                srf.tris.append(p.triangles + base)
        if not surfaces:
            raise ValueError("no mesh to import")
        self.surfaces = []
        for mat in sorted(surfaces):
            s = surfaces[mat]
            k = max(j.shape[1] for j in s.joints)
            s.pos = np.concatenate(s.pos)
            s.uv = np.concatenate(s.uv)
            s.joints = np.concatenate([np.pad(j, ((0, 0), (0, k - j.shape[1])), constant_values=j[0, 0])
                                       for j in s.joints])
            s.weights = np.concatenate([np.pad(w, ((0, 0), (0, k - w.shape[1]))) for w in s.weights])
            s.tris = np.concatenate(s.tris)
            if any(n is None for n in s.nrm):
                s.nrm = None
            else:
                s.nrm = np.concatenate(s.nrm)
            self.surfaces.append(s)

        # --- model-space conversion ---------------------------------------------------------------
        yr = math.radians(yaw)
        Ry = np.array([[math.cos(yr), -math.sin(yr), 0], [math.sin(yr), math.cos(yr), 0], [0, 0, 1.0]])
        A = Ry @ axes_matrix(up, forward)
        allp = np.concatenate([s.pos for s in self.surfaces]) @ A.T
        if height_pose is not None:
            hp = self._scene_posed_points(*height_pose) @ A.T
        else:
            hp = allp
        if scale is None:
            h = float(hp[:, 2].max() - hp[:, 2].min())
            scale = 1.0 if height is None else float(height) / max(h, 1e-9)
        lo = allp.min(0) * scale
        hi = allp.max(0) * scale
        off = np.zeros(3)
        if origin == "bbox":
            off[:2] = -(lo[:2] + hi[:2]) / 2
        off[2] = -lo[2]
        self.scale = scale
        self.C = np.eye(4)
        self.C[:3, :3] = A * scale
        self.C[:3, 3] = off
        self.Cinv = np.linalg.inv(self.C)
        self.A = A
        for s in self.surfaces:
            s.pos = s.pos @ self.C[:3, :3].T + self.C[:3, 3]
            if s.nrm is not None:
                s.nrm = s.nrm @ A.T
        self._log(f"scale {scale:.4f} units per glTF unit, rest bounds {np.round(lo + off, 1)} .. {np.round(hi + off, 1)}")

        # --- skeleton -----------------------------------------------------------------------------
        self._build_skeleton(keep_joints, max_bones, strip_suffix)
        self._finish_surfaces()

    # helpers ----------------------------------------------------------------------------------
    def _log(self, msg):
        self.report.append(msg)
        if self.verbose:
            print(f"  [import {self.path.rsplit('/', 1)[-1] if isinstance(self.path, str) else ''}] {msg}",
                  file=sys.stderr)

    @staticmethod
    def _joint_attrs(p):
        out = []
        for k in range(4):
            jn, wn = f"JOINTS_{k}", f"WEIGHTS_{k}"
            if jn in p.attributes and wn in p.attributes:
                out.append((jn, wn))
        return out

    def _depth(self, n):
        d = 0
        while self.g.nodes[n].parent != -1:
            n = self.g.nodes[n].parent
            d += 1
        return d

    def _scene_posed_points(self, anim, t):
        """Skinned scene-space points of every surface at animation time t (for height_pose)."""
        a = self._anim(anim)
        G = self.g.world_matrices(a, t)
        pts = []
        for s in self.surfaces:
            S = {n: G[n] @ np.linalg.inv(self.bind[n]) for n in np.unique(s.joints)}
            w = s.weights / np.maximum(s.weights.sum(1, keepdims=True), 1e-12)
            acc = np.zeros_like(s.pos)
            for k in range(s.joints.shape[1]):
                M = np.array([S[int(n)] for n in s.joints[:, k]])
                acc += w[:, k:k + 1] * (np.einsum("nij,nj->ni", M[:, :3, :3], s.pos) + M[:, :3, 3])
            pts.append(acc)
        return np.concatenate(pts)

    def _anim(self, anim):
        if isinstance(anim, gltf.Animation):
            return anim
        if isinstance(anim, int):
            return self.g.animations[anim]
        names = [a.name for a in self.g.animations]
        if anim in names:
            return self.g.animations[names.index(anim)]
        hits = [a for a in self.g.animations if anim in a.name]
        if len(hits) == 1:
            return hits[0]
        raise KeyError(f"animation {anim!r} not found (or ambiguous) in {names}")

    def animation_names(self):
        return [a.name for a in self.g.animations]

    # skeleton ---------------------------------------------------------------------------------
    def _build_skeleton(self, keep_joints, max_bones, strip_suffix):
        g = self.g
        joints = set(self.bind)
        wsum = {}
        for s in self.surfaces:
            for k in range(s.joints.shape[1]):
                for n, w in zip(s.joints[:, k], s.weights[:, k]):
                    if w > 1.0 / 512:
                        wsum[int(n)] = wsum.get(int(n), 0.0) + float(w)
        name_of = {n: g.nodes[n].name for n in joints}
        keep_names = set(keep_joints)
        forced = {n for n in joints if name_of[n] in keep_names or self._clean(name_of[n]) in keep_names}
        missing = keep_names - {name_of[n] for n in forced} - {self._clean(name_of[n]) for n in forced}
        if missing:
            raise KeyError(f"keep_joints not found: {sorted(missing)}")
        used = {n for n in wsum} | forced

        def jparent(n):
            p = g.nodes[n].parent
            while p != -1 and p not in joints:
                p = g.nodes[p].parent
            return p

        def chain(n):
            out = [n]
            p = jparent(n)
            while p != -1:
                out.append(p)
                p = jparent(p)
            return out

        chains = {n: chain(n) for n in used}
        # lowest common ancestor of the used joints (per root tree)
        common = None
        for n in sorted(used):
            c = chains[n][::-1]
            common = c if common is None else [a for a, b in zip(common, c) if a == b]
        lca = common[-1] if common else None
        keep = set()
        for n in used:
            for a in chains[n]:
                keep.add(a)
                if a == lca:
                    break
        # merge least-weighted leaves while over the bone limit
        merged = {}
        while len(keep) > max_bones:
            kids = {n: 0 for n in keep}
            for n in keep:
                p = jparent(n)
                while p != -1 and p not in keep:
                    p = jparent(p)
                if p in kids:
                    kids[p] += 1
            leaves = [n for n in keep if kids[n] == 0 and n not in forced and n != lca]
            if not leaves:
                break
            victim = min(leaves, key=lambda n: (wsum.get(n, 0.0), n))
            keep.discard(victim)
            merged[victim] = True
        if merged:
            self._log(f"merged {len(merged)} joints into their parents to respect {max_bones} bones: "
                      + ", ".join(sorted(name_of[n] for n in merged)))
        dropped = sorted(name_of[n] for n in joints - keep)
        self.dropped_joints = dropped

        # bone order: depth-first, children by node index
        def kparent(n):
            p = jparent(n)
            while p != -1 and p not in keep:
                p = jparent(p)
            return p

        children = {}
        roots = []
        for n in sorted(keep):
            p = kparent(n)
            if p == -1:
                roots.append(n)
            else:
                children.setdefault(p, []).append(n)
        order = []
        stack = list(reversed(roots))
        while stack:
            n = stack.pop()
            order.append(n)
            stack.extend(reversed(children.get(n, [])))
        self.bone_nodes = order
        self.bone_of_node = {n: i for i, n in enumerate(order)}
        # map every joint to its kept bone (itself or the nearest kept ancestor; above the root: the root)
        self.map_node = {}
        for n in joints:
            a = n
            while a != -1 and a not in self.bone_of_node:
                a = jparent(a)
            self.map_node[n] = self.bone_of_node[a] if a != -1 else 0
        # names
        raw = [name_of[n] for n in order]
        names = [self._clean(x) if strip_suffix else x for x in raw]
        if len(set(names)) != len(names):
            names = raw
        names = [x[:31] for x in names]
        seen = {}
        for i, x in enumerate(names):
            if x in seen:
                names[i] = (x[:27] + f"_{i}")[:31]
            seen[names[i]] = i
        self.bone_names = names
        # rest frames (model space): heads of the bind joints
        self.rest_world_full = {}
        heads = []
        self.bind_rot = []
        for n in order:
            W = self.C @ self.bind[n]
            self.rest_world_full[n] = W
            heads.append(W[:3, 3])
            self.bind_rot.append(polar_rotation(W[:3, :3]))
        self.heads = np.array(heads)
        rg = R.Rig()
        for i, n in enumerate(order):
            p = kparent(n)
            rg.add(names[i], None if p == -1 else names[self.bone_of_node[p]], tuple(self.heads[i]))
        self.rig = rg
        self.parents = np.array([b.parent for b in rg.bones])
        self._log(f"skeleton: {len(order)} bones kept of {len(joints)} joints (root {names[0]}); "
                  f"dropped {len(dropped)}: {', '.join(dropped[:40])}{' ...' if len(dropped) > 40 else ''}")

    @staticmethod
    def _clean(name):
        """Exporter suffix "_<digits>" stripped (Sketchfab / FBX converters append node numbers)."""
        head, sep, tail = name.rpartition("_")
        return head if sep and tail.isdigit() and head else name

    def bone(self, name):
        """Bone index from a (clean or original) joint name."""
        if name in self.bone_names:
            return self.bone_names.index(name)
        for i, n in enumerate(self.bone_nodes):
            if self.g.nodes[n].name == name:
                return i
        raise KeyError(f"unknown bone {name!r}")

    # weights / normals ------------------------------------------------------------------------
    def _finish_surfaces(self):
        nb = len(self.bone_nodes)
        for s in self.surfaces:
            nv = len(s.pos)
            acc = np.zeros((nv, nb))
            for k in range(s.joints.shape[1]):
                b = np.array([self.map_node.get(int(n), 0) for n in s.joints[:, k]])
                np.add.at(acc, (np.arange(nv), b), s.weights[:, k])
            order = np.argsort(-acc, axis=1, kind="stable")[:, :4]
            top = np.take_along_axis(acc, order, 1)
            top = np.where(top > 1e-6, top, 0.0)
            wi = _largest_remainder(top)
            bones = np.where(wi > 0, order, -1)
            # pack used slots first (largest remainder can zero a middle slot)
            srt = np.argsort(-wi, axis=1, kind="stable")
            wi = np.take_along_axis(wi, srt, 1)
            bones = np.take_along_axis(bones, srt, 1)
            bones[wi == 0] = -1
            if bones.shape[1] < 4:   # fewer than 4 bones in the model
                pad = 4 - bones.shape[1]
                bones = np.pad(bones, ((0, 0), (0, pad)), constant_values=-1)
                wi = np.pad(wi, ((0, 0), (0, pad)))
            empty = bones[:, 0] < 0
            if empty.any():
                bones[empty, 0] = 0
                wi[empty, 0] = 255
            s.bw_bones, s.bw_weights = bones, wi
            s.main_bone = bones[:, 0].copy()
            if s.nrm is None:
                s.nrm = self._smooth_normals(s)
        nv = sum(len(s.pos) for s in self.surfaces)
        self._log(f"{nv} vertices, {sum(len(s.tris) for s in self.surfaces)} triangles, "
                  f"{sum(int((s.bw_bones >= 0).sum()) for s in self.surfaces) / max(nv, 1):.2f} weights/vertex")

    def _smooth_normals(self, s):
        """Per-vertex normals for a surface without NORMAL: weld positions, crease-angle smoothing."""
        tol = 1e-4 * float(np.ptp(s.pos, axis=0).max() + 1e-9)
        key = np.round(s.pos / tol).astype(np.int64)
        _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
        inv = inv.reshape(-1)
        tm = meshmod.TriMesh(s.pos[first], inv[s.tris])
        nrm, corner = meshmod.crease_normals(tm, self.crease)
        out = np.zeros_like(s.pos)
        for f in range(len(s.tris)):
            for k in range(3):
                out[s.tris[f, k]] = nrm[corner[f, k]]
        self._log(f"material {self._matname(s.material)}: normals rebuilt (crease {self.crease:g} deg)")
        return out

    def _matname(self, mat):
        return self.g.materials[mat].name if mat >= 0 else "default"

    # animation --------------------------------------------------------------------------------
    def bone_world(self, anim=None, t=0.0):
        """(B, 3, 4) rigid model-space bone matrices (identity-rest convention) at animation time t
        (anim None: the rest = bind pose)."""
        nb = len(self.bone_nodes)
        out = np.zeros((nb, 3, 4))
        if anim is None:
            out[:, :, :3] = np.eye(3)
            out[:, :, 3] = self.heads
            return out
        G = self.g.world_matrices(self._anim(anim), t)
        fit = self._bone_fit_points()
        for i, n in enumerate(self.bone_nodes):
            W = self.C @ G[n]
            S = W @ np.linalg.inv(self.rest_world_full[n])  # model-space skinning matrix of the joint
            sv = np.linalg.svd(S[:3, :3], compute_uv=False)
            if np.abs(sv - 1.0).max() < 1e-4 or i not in fit:
                out[i, :, :3] = polar_rotation(S[:3, :3])
                out[i, :, 3] = W[:3, 3]
                continue
            # scaled joint (the format has no bone scale): the rigid motion closest to the true one on the
            # vertices it moves (weighted Kabsch), instead of a rotation about the joint alone
            P, w = fit[i]
            Q = P @ S[:3, :3].T + S[:3, 3]
            pc = (w[:, None] * P).sum(0) / w.sum()
            qc = (w[:, None] * Q).sum(0) / w.sum()
            H = ((P - pc) * w[:, None]).T @ (Q - qc)
            u, _, vt = np.linalg.svd(H)
            d = np.sign(np.linalg.det(vt.T @ u.T))
            Rm = vt.T @ np.diag([1.0, 1.0, d]) @ u.T
            tr = qc - Rm @ pc
            out[i, :, :3] = Rm
            out[i, :, 3] = Rm @ self.heads[i] + tr
        return out

    def _bone_fit_points(self):
        """Per bone: rest positions and weights of the vertices it influences (for the scaled-joint fit)."""
        if getattr(self, "_fit_cache", None) is None:
            fit = {}
            for s in self.surfaces:
                for k in range(4):
                    b = s.bw_bones[:, k]
                    w = s.bw_weights[:, k] / 255.0
                    for bi in np.unique(b[b >= 0]):
                        sel = (b == bi) & (w > 0)
                        fit.setdefault(int(bi), []).append((s.pos[sel], w[sel]))
            self._fit_cache = {b: (np.concatenate([x[0] for x in v]), np.concatenate([x[1] for x in v]))
                               for b, v in fit.items() if sum(len(x[0]) for x in v) >= 3}
        return self._fit_cache

    def local_from_world(self, world):
        """(B, 3, 4) world bone matrices -> (pos (B, 3), euler radians (B, 3)) local values."""
        nb = len(world)
        pos = np.zeros((nb, 3))
        rot = np.zeros((nb, 3))
        for i in range(nb):
            p = self.parents[i]
            if p < 0:
                Rl, tl = world[i, :, :3], world[i, :, 3]
            else:
                Rp = world[p, :, :3]
                Rl = Rp.T @ world[i, :, :3]
                tl = Rp.T @ (world[i, :, 3] - world[p, :, 3])
            pos[i] = tl
            rot[i] = euler_from_matrix(Rl)
        return pos, rot

    def sample(self, anim, times):
        """Local (pos (F, B, 3), rot (F, B, 3)) of an animation at the given times (seconds)."""
        P, Rr = [], []
        for t in times:
            p, r = self.local_from_world(self.bone_world(anim, float(t)))
            P.append(p)
            Rr.append(r)
        return np.array(P), np.array(Rr)

    def pose_at(self, anim, t):
        """rig.Pose of an official animation frame (degrees, offsets from rest): edit it with rig helpers."""
        p, r = self.local_from_world(self.bone_world(anim, t))
        rest = self.rig.rest_local()
        pose = R.Pose()
        for i, name in enumerate(self.bone_names):
            v = np.zeros(6)
            v[:3] = np.degrees(r[i])
            v[3:] = p[i] - rest[i]
            if np.any(np.abs(v) > 1e-9):
                pose[name] = v
        return pose

    def sequence(self, anim, name=None, fps=30.0, loop=False, t0=None, t1=None, activity=0, actweight=1,
                 root_motion=None, feet=None, motion_bone=None, events=(), speed=1.0, frames=None):
        """mdl.Sequence from an official animation.

        fps: sampling rate (frames are spaced evenly over [t0, t1], fps adjusted to fit exactly) and playback;
        speed: playback speed factor (fps of the sequence = sampling fps * speed).  frames: force a frame count.
        loop: last frame = first (the engine loops over numframes - 1 intervals).
        root_motion: None, "extract" (the motion bone's horizontal displacement over the cycle -> linearmovement,
        removed from the roots so the cycle stays in place), "feet" (after that removal, linearmovement from the
        backward speed of the planted `feet` bones: right for in-place gaits too), "lock" (displacement removed,
        no movement).  With feet given, both speeds are logged (equal = no foot sliding)."""
        a = self._anim(anim)
        t0 = a.start if t0 is None else float(t0)
        t1 = a.duration if t1 is None else float(t1)
        dur = max(t1 - t0, 1e-6)
        n = int(frames) - (1 if frames else 0) if frames else max(1, int(round(dur * fps)))
        times = [t0 + dur * i / n for i in range(n + 1)]
        worlds = [self.bone_world(a, t) for t in times]
        lm = np.zeros(3)
        info = ""
        if root_motion not in (None, "extract", "lock", "feet"):
            raise ValueError(f"root_motion {root_motion!r}")
        if root_motion is not None:
            # the motion bone's horizontal displacement over the clip, removed linearly from every bone
            mb = 0 if motion_bone is None else self.bone(motion_bone)
            d = worlds[-1][mb, :, 3] - worlds[0][mb, :, 3]
            d[2] = 0.0
            for i, w in enumerate(worlds):
                w[:, :, 3] -= d * (i / n)
            if root_motion == "extract":
                lm = d
            info = f"root displacement {np.round(d, 2)} ({np.linalg.norm(d) / dur:.1f} units/s)"
            if feet:
                spd = self.feet_speed(worlds, [self.bone(f) for f in feet], dur / n)
                info += f", planted feet {spd:.1f} units/s backward"
                if root_motion == "feet":
                    lm = np.array([spd * dur, 0.0, 0.0])
            elif root_motion == "feet":
                raise ValueError("root_motion='feet' needs feet=[bone names]")
        P = np.zeros((n + 1, len(self.bone_nodes), 3))
        Rr = np.zeros_like(P)
        for i, w in enumerate(worlds):
            P[i], Rr[i] = self.local_from_world(w)
        if loop:
            P[-1], Rr[-1] = P[0], Rr[0]
        evs = [e if isinstance(e, mdl.Event) else mdl.Event(frame=int(e[0]), event=int(e[1]),
                                                             options=str(e[2]) if len(e) > 2 else "")
               for e in events]
        mt = R._linear_flags(tuple(lm)) if np.any(np.abs(lm) > 1e-6) else 0
        seq = mdl.Sequence(name=name or a.name[:31], pos=P, rot=Rr, fps=float(n / dur * speed),
                           flags=mdl.STUDIO_LOOPING if loop else 0, activity=activity,
                           actweight=actweight if activity else 0, events=evs, motiontype=mt,
                           linearmovement=tuple(float(x) for x in lm))
        self._log(f"sequence {seq.name} <- {a.name} [{t0:.3f}, {t1:.3f}] s: {n + 1} frames @ {seq.fps:.2f} fps"
                  + (f", {info}" if info else ""))
        return seq

    @staticmethod
    def feet_speed(worlds, feet, dt):
        """Backward speed (units/s) of the feet while planted (lowest 25 % of their height range)."""
        speeds = []
        for f in feet:
            p = np.array([w[f, :, 3] for w in worlds])
            z = p[:, 2]
            low = z <= z.min() + 0.25 * max(np.ptp(z), 1e-6)
            v = -np.gradient(p[:, 0], dt)
            sel = low & (v > 0)
            if sel.any():
                speeds.append(float(np.median(v[sel])))
        return float(np.mean(speeds)) if speeds else 0.0

    def rest_sequence(self, name="bind", frames=1, fps=30.0, activity=0):
        P = np.tile(self.rig.rest_local(), (frames, 1, 1))
        return mdl.Sequence(name=name, pos=P, rot=np.zeros_like(P), fps=fps, activity=activity,
                            actweight=1 if activity else 0)

    # textures ---------------------------------------------------------------------------------
    def _texture_for(self, s, uvt, extra_filter=None):
        """Bake the texture of a surface for its triangles' (wrapped) UVs: returns (Texture, (W, H) of the
        uv space, (x0, y0) crop origin in source pixels, factor)."""
        g = self.g
        mat = g.materials[s.material] if s.material >= 0 else gltf.Material(name="default")
        if mat.base_texture >= 0:
            img = np.asarray(g.texture_image(mat.base_texture)).copy()
        else:
            img = np.full((8, 8, 4), 255, np.uint8)
        f = np.clip(mat.base_color, 0, 1)
        img = np.clip(np.round(img.astype(np.float64) * f[None, None, :]), 0, 255).astype(np.uint8)
        mo = self.mat_opts.get(mat.name, {})
        if self.texture_filter is not None:
            img = np.asarray(self.texture_filter(mat.name, img), dtype=np.uint8)
        if mo.get("filter") is not None:
            img = np.asarray(mo["filter"](img), dtype=np.uint8)
        if extra_filter is not None:
            img = np.asarray(extra_filter(img), dtype=np.uint8)
        max_size, min_size = mo.get("max_size", self.max_size), mo.get("min_size", self.min_size)
        H0, W0 = img.shape[:2]
        x0, y0, cw, ch = 0, 0, W0, H0
        if mo.get("crop", self.crop):
            umin, umax = uvt.reshape(-1, 2).min(0), uvt.reshape(-1, 2).max(0)
            lo = np.floor(umin * (W0, H0) + 1e-6).astype(int)
            hi = np.ceil(umax * (W0, H0) - 1e-6).astype(int)
            for ax, full in ((0, W0), (1, H0)):
                l, h = max(lo[ax], 0), min(hi[ax], full)
                if umax[ax] > 1.0 + 1e-4:   # triangles wrap across the edge: keep the whole axis
                    l, h = 0, full
                size = min(_pot_ceil(h - l), full) if (full & (full - 1)) == 0 else (h - l)
                l = min(max(l - (size - (h - l)) // 2, 0), full - size)
                if ax == 0:
                    x0, cw = l, size
                else:
                    y0, ch = l, size
        crop = img[y0:y0 + ch, x0:x0 + cw]
        # size: <= max_size, >= min_size (powers of two keep texel centres aligned)
        f = 1.0
        while max(cw, ch) * f > max_size:
            f /= 2
        while max(cw, ch) * f * 2 <= min_size:
            f *= 2
        tw, th = max(1, int(round(cw * f))), max(1, int(round(ch * f)))
        alpha_mode = mat.alpha_mode
        a = crop[..., 3]
        cutoff = mat.alpha_cutoff * 255 if alpha_mode == "MASK" else 127.5
        masked = alpha_mode in ("MASK", "BLEND") and bool((a < cutoff).any())
        src = crop.copy()
        if masked:
            src[..., 3] = np.where(a < cutoff, 0, 255).astype(np.uint8)
            src = _dilate_rgba(src)
        if (tw, th) != (cw, ch):
            im = Image.fromarray(src, "RGBA")
            if masked:
                rgb = im.convert("RGB").resize((tw, th), Image.LANCZOS)
                al = im.getchannel("A").resize((tw, th), Image.BILINEAR)
                src = np.dstack([np.asarray(rgb), np.asarray(al)])
            else:
                src = np.asarray(im.resize((tw, th), Image.LANCZOS))
        transparent = (src[..., 3] < 128) if masked else None
        # gutters: texels no triangle samples get the colours of the nearest used ones, so bilinear filtering
        # and mipmaps do not bleed unrelated atlas content (black backgrounds, other cells) into the seams
        stf = (uvt * (W0, H0) - (x0, y0)) * f
        cov = _coverage(stf, tw, th)
        if not cov.all():
            known = cov & (src[..., 3] >= 128) if masked else cov
            if known.any():
                rgb = texture.dilate(src[..., :3].astype(np.float64) / 255.0, known, iters=24) * 255.0
                src = src.copy()
                src[..., :3] = np.where(known[..., None], src[..., :3], np.clip(np.round(rgb), 0, 255)).astype(np.uint8)
        idx, pal = quantize_texture(src[..., :3], transparent)
        flags = (mdl.STUDIO_NF_MASKED if masked else 0) | int(mo.get("flags", 0))
        return idx, pal, flags, (x0, y0), (W0, H0), f

    # geometry ---------------------------------------------------------------------------------
    def _surface_triangles(self, s):
        """Triangle list of a surface after duplicate removal and double-sided handling, with wrapped UVs:
        (tris (T, 3) vertex ids, flipped (T,) bool, uv (T, 3, 2))."""
        tris = s.tris.copy()
        # drop exact duplicates (coincident copies of the same surface)
        key = np.sort(np.round(s.pos[tris].reshape(len(tris), -1), 4).reshape(len(tris), 3, 3), axis=1)
        _, first = np.unique(key.reshape(len(tris), -1), axis=0, return_index=True)
        dup = len(tris) - len(first)
        tris = tris[np.sort(first)]
        flipped = np.zeros(len(tris), bool)
        mat = self.g.materials[s.material] if s.material >= 0 else None
        ds = self.double_sided
        forced = mat is not None and "double_sided" in self.mat_opts.get(mat.name, {})
        if forced:
            ds = self.mat_opts[mat.name]["double_sided"]
        if ds and mat is not None and (mat.double_sided or forced):
            if ds == "auto":
                open_faces = self._single_sided_faces(s.pos, tris, self._all_pos, self._all_tris)
            else:
                open_faces = np.ones(len(tris), bool)
            if open_faces.any():
                back = tris[open_faces][:, ::-1]
                tris = np.concatenate([tris, back])
                flipped = np.concatenate([flipped, np.ones(len(back), bool)])
                self._log(f"material {mat.name}: {int(open_faces.sum())} single-sided triangles get a back face")
        if dup:
            self._log(f"material {self._matname(s.material)}: {dup} duplicate triangles dropped")
        uv = s.uv[tris]
        uv = uv - np.floor(uv.min(1, keepdims=True) + 1e-6)
        return tris, flipped, uv

    @staticmethod
    def _single_sided_faces(pos, tris, all_pos, all_tris, chunk=256, decal_gap=0.03):
        """Faces that are a thin sheet: a ray from the face centre going inward (against its normal) first meets
        the BACK of another face when the face bounds a volume; it meets nothing, or the front of another
        surface, behind a sheet (wing membranes, flames, fins): those faces need a back face in GoldSrc."""
        a, b, c = (pos[tris[:, k]] for k in range(3))
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n, axis=1)
        good = ln > 1e-12
        n = n / np.where(good, ln, 1.0)[:, None]
        ctr = (a + b + c) / 3
        A, B, Cc = (all_pos[all_tris[:, k]] for k in range(3))
        e1, e2 = B - A, Cc - A
        N = np.cross(e1, e2)
        scale = float(np.ptp(all_pos, axis=0).max() + 1e-9)
        out = np.zeros(len(tris), bool)
        for s0 in range(0, len(tris), chunk):
            o = ctr[s0:s0 + chunk] - n[s0:s0 + chunk] * (1e-4 * scale)
            d = -n[s0:s0 + chunk]
            # Moller-Trumbore, all pairs of the chunk x all triangles
            pvec = np.cross(d[:, None, :], e2[None, :, :])
            det = np.einsum("tk,itk->it", e1, pvec)
            ok = np.abs(det) > 1e-12
            inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
            tvec = o[:, None, :] - A[None, :, :]
            u = np.einsum("itk,itk->it", tvec, pvec) * inv
            qvec = np.cross(tvec, e1[None, :, :])
            v = np.einsum("ik,itk->it", d, qvec) * inv
            t = np.einsum("tk,itk->it", e2, qvec) * inv
            hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-6 * scale)
            t = np.where(hit, t, np.inf)
            first = np.argmin(t, axis=1)
            has = np.isfinite(t[np.arange(len(first)), first])
            facing = np.einsum("ik,ik->i", N[first], d) > 0     # hit from behind: we are inside a volume
            tf = t[np.arange(len(first)), first]
            decal = has & ~facing & (tf < decal_gap * scale)     # a decal lying on another surface
            out[s0:s0 + chunk] = good[s0:s0 + chunk] & ~(has & facing) & ~decal
        return out

    def studio(self, name, sequences, attachments=(), hitbox_groups=None, hitbox_bones=None, eyeposition=None,
               hull=None, controllers=(), skin_variants=(), min_hitbox_verts=12):
        """Assemble the mdl.Studio.

        sequences: mdl.Sequence list (from sequence(), rest_sequence() or rig.make_sequence(self.rig, ...)).
        attachments: [(name, bone, model-space rest position)].
        hitbox_groups: {bone name: HITGROUP_*} (others 0); hitbox_bones: restrict hitboxes to these bones.
        controllers: [(bone, type, start, end, index)].
        skin_variants: extra skin families, each {material name: filter(rgba) -> rgba} applied to the material's
        full source image before cropping (e.g. copy a closed-eyes cell of an expression atlas over the open one,
        or recolour); materials without a filter keep their texture.  Skin 0 is the plain conversion."""
        nb = len(self.bone_nodes)
        base = name.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        offs = np.cumsum([0] + [len(x.pos) for x in self.surfaces])
        self._all_pos = np.concatenate([x.pos for x in self.surfaces])
        self._all_tris = np.concatenate([x.tris + o for x, o in zip(self.surfaces, offs)])
        textures, tex_key = [], {}
        verts, vbones, vweights, vmain = [], [], [], []
        norms, nbones, nweights, nmain = [], [], [], []
        mesh_tris, mesh_seen = {}, {}
        vkey, nkey = {}, {}
        surf_tex, surf_ti = [], []
        for s in self.surfaces:
            tris, flipped, uv = self._surface_triangles(s)
            idx, pal, flags, (x0, y0), (W0, H0), f = self._texture_for(s, uv)
            surf_tex.append((s, uv))
            key = idx.tobytes() + pal.tobytes() + flags.to_bytes(4, "little")
            if key not in tex_key:
                tex_key[key] = len(textures)
                tname = f"{base}_{self._matname(s.material)}".replace(" ", "_").replace("#", "")[:59] + ".bmp"
                if tname.lower().startswith(("dm_base", "remap")):
                    tname = "t_" + tname
                textures.append(mdl.Texture(name=tname, pixels=idx, palette=pal, flags=flags))
            ti = tex_key[key]
            surf_ti.append(ti)
            tex = textures[ti]
            st = np.round((uv * (W0, H0) - (x0, y0)) * f).astype(np.int64)
            st[..., 0] = np.clip(st[..., 0], 0, None)
            st[..., 1] = np.clip(st[..., 1], 0, None)
            if st[..., 0].max() > 2 * tex.width or st[..., 1].max() > 2 * tex.height:
                over = int(((st[..., 0] > 2 * tex.width) | (st[..., 1] > 2 * tex.height)).any(1).sum())
                self._log(f"material {self._matname(s.material)}: {over} triangles span more than one texture "
                          f"repeat (clamped)")
                st[..., 0] = np.minimum(st[..., 0], 2 * tex.width)
                st[..., 1] = np.minimum(st[..., 1], 2 * tex.height)
            out = mesh_tris.setdefault(ti, [])
            seen = mesh_seen.setdefault(ti, set())
            ndup = 0
            for fi in range(len(tris)):
                tk = (tuple(sorted(tuple(np.round(s.pos[int(v)], 4)) for v in tris[fi])), bool(flipped[fi]))
                if tk in seen:
                    ndup += 1
                    continue
                seen.add(tk)
                corner = []
                for k in range(3):
                    vi = int(tris[fi, k])
                    kv = (tuple(np.round(s.pos[vi], 5)), tuple(s.bw_bones[vi]), tuple(s.bw_weights[vi]))
                    if kv not in vkey:
                        vkey[kv] = len(verts)
                        verts.append(s.pos[vi])
                        vbones.append(s.bw_bones[vi])
                        vweights.append(s.bw_weights[vi])
                        vmain.append(s.main_bone[vi])
                    n = -s.nrm[vi] if flipped[fi] else s.nrm[vi]
                    kn = (tuple(np.round(n, 4)), kv[1], kv[2])
                    if kn not in nkey:
                        nkey[kn] = len(norms)
                        norms.append(n)
                        nbones.append(s.bw_bones[vi])
                        nweights.append(s.bw_weights[vi])
                        nmain.append(s.main_bone[vi])
                    corner.append((vkey[kv], nkey[kn], st[fi, k, 0], st[fi, k, 1]))
                out.append(corner)
            if ndup:
                self._log(f"material {self._matname(s.material)}: {ndup} triangles already drawn by another "
                          f"material with the same texture, dropped")
        # skin families: skinref = base texture index; variants substitute re-baked textures
        nbase = len(textures)
        skins = None
        if skin_variants:
            skins = [list(range(nbase))]
            for vi, variant in enumerate(skin_variants):
                fam = list(range(nbase))
                for (s, uv), ti in zip(surf_tex, surf_ti):
                    fn = variant.get(self._matname(s.material))
                    if fn is None:
                        continue
                    idx, pal, flags, _, _, _ = self._texture_for(s, uv, extra_filter=fn)
                    key = idx.tobytes() + pal.tobytes() + flags.to_bytes(4, "little")
                    if key not in tex_key:
                        tex_key[key] = len(textures)
                        t0 = textures[ti]
                        textures.append(mdl.Texture(name=(t0.name[:-4][:55] + f"_s{vi + 1}.bmp"), pixels=idx,
                                                    palette=pal, flags=flags))
                    fam[ti] = tex_key[key]
                skins.append(fam)
        meshes = [mdl.Mesh(tris=np.array(mesh_tris[ti], dtype=np.int64), skinref=ti) for ti in sorted(mesh_tris)]
        model = mdl.Model(name=base, verts=np.array(verts), vert_bone=np.array(vmain), norms=np.array(norms),
                          norm_bone=np.array(nmain), meshes=meshes,
                          vert_weights=mdl.BoneWeights(np.array(vbones), np.array(vweights)),
                          norm_weights=mdl.BoneWeights(np.array(nbones), np.array(nweights)))
        bodyparts = [mdl.BodyPart(name="body", models=[model])]
        self._log(f"model: {len(verts)} verts, {len(norms)} normals, {sum(len(m.tris) for m in meshes)} tris, "
                  f"{len(meshes)} meshes; textures " + ", ".join(f"{t.name} {t.width}x{t.height}"
                                                                + (" masked" if t.flags & mdl.STUDIO_NF_MASKED else "")
                                                                for t in textures))
        bones = self.rig.mdl_bones()

        # bounds per sequence (skinned vertices, every frame)
        V = np.array(verts)
        bw = model.vert_weights
        wv = np.where(bw.bones >= 0, bw.weights, 0) / 255.0
        bi = np.maximum(bw.bones, 0)
        hdr_lo = hdr_hi = None
        for seq in sequences:
            lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
            for fr in range(seq.numframes):
                W = mdl.bone_matrices(bones, seq.pos[fr], seq.rot[fr])
                S = W.copy()
                S[:, :, 3] = W[:, :, 3] - np.einsum("bij,bj->bi", W[:, :, :3], self.heads)
                M = np.einsum("nk,nkij->nij", wv, S[bi])
                p = np.einsum("nij,nj->ni", M[:, :, :3], V) + M[:, :, 3]
                lo = np.minimum(lo, p.min(0))
                hi = np.maximum(hi, p.max(0))
            seq.bbmin, seq.bbmax = tuple(lo), tuple(hi)
            if hdr_lo is None:
                hdr_lo, hdr_hi = lo, hi

        # hitboxes: per main bone, extents of the vertices it dominates (rest pose, bone space)
        hitboxes = []
        dom = bw.bones[:, 0]
        strong = bw.weights[:, 0] >= 128
        allowed = None if hitbox_bones is None else {self.bone(b) for b in hitbox_bones}
        groups = {self.bone(k): v for k, v in (hitbox_groups or {}).items()}
        for b in range(nb):
            if allowed is not None and b not in allowed:
                continue
            sel = (dom == b) & strong
            if sel.sum() < min_hitbox_verts:
                continue
            p = V[sel] - self.heads[b]
            hitboxes.append(mdl.Hitbox(bone=b, group=groups.get(b, 0), bbmin=tuple(p.min(0)), bbmax=tuple(p.max(0))))
        atts = []
        for an, ab, apos in attachments:
            b = self.bone(ab)
            atts.append(mdl.Attachment(bone=b, org=tuple(np.asarray(apos, float) - self.heads[b]), name=an))
        ctrls = []
        for (cb, ctype, cs, ce, cidx) in controllers:
            rest = int(round(255 * (0 - cs) / (ce - cs))) if ce != cs else 0
            ctrls.append(mdl.BoneController(bone=self.bone(cb), type=ctype, start=cs, end=ce, index=cidx,
                                            rest=max(0, min(255, rest))))
        eye = eyeposition if eyeposition is not None else (0.0, 0.0, float(hdr_hi[2]) * 0.85)
        if hull is not None:
            hmin, hmax = hull
        else:
            r = float(max(abs(hdr_lo[0]), abs(hdr_hi[0]), abs(hdr_lo[1]), abs(hdr_hi[1])))
            hmin, hmax = (-r, -r, 0.0), (r, r, float(hdr_hi[2]))
        return mdl.Studio(name=name, bones=bones, sequences=list(sequences), textures=textures, bodyparts=bodyparts,
                          skins=skins, controllers=ctrls, attachments=atts, hitboxes=hitboxes,
                          eyeposition=tuple(eye), min=tuple(hmin), max=tuple(hmax), bbmin=tuple(hdr_lo),
                          bbmax=tuple(hdr_hi))

    def joint_report(self):
        """Lines: bone index, name, parent, rest head (model space), weighted vertex count."""
        counts = np.zeros(len(self.bone_nodes), int)
        for s in self.surfaces:
            np.add.at(counts, s.bw_bones[s.bw_bones >= 0], 1)
        lines = []
        for i, nm in enumerate(self.bone_names):
            p = self.parents[i]
            lines.append(f"{i:3d} {nm:28s} <- {self.bone_names[p] if p >= 0 else '-':28s} "
                         f"head {np.round(self.heads[i], 1)} verts {counts[i]}")
        return lines
