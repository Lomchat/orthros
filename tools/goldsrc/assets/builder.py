"""ModelBuilder: from parts (SDF shape + bone(s) + paint function) to a complete mdl.Studio.

    b = ModelBuilder("pokemon/example.mdl", rig, skins=1)
    b.group("main", size=(256, 256))
    b.add(Part("body", body_sdf, bone="spine", paint=paint_body, budget=900))
    b.add(Part("tail", tail_sdf, bones=["tail1", "tail2", "tail3"], paint=paint_tail, budget=300))
    b.add_sequence(rig_idle_sequence)
    b.attachment("mouth", "head", (9, 0, 26))
    st = b.build()
    data = mdl.write(st)

Each part is meshed separately (closed surface) and bound rigidly to one bone, or with bones=[...]
each vertex goes to the nearest bone segment (soft parts such as tails).  Make parts overlap at the
joints (a limb's top sinks into the body) so nothing cracks when animated.

All parts of a texture group share one atlas (one mesh per bodypart model); paint functions are
evaluated on the rest-pose surface (model space) so markings are continuous across parts and UV seams.
Skins: paint(P, N, skin) is called for skin = 0..skins-1; identical results are stored once.
"""
import math
import sys
import time

import numpy as np

from . import mdl, mesh as meshmod, texture, xform


class Part:
    def __init__(self, name, shape=None, bone=None, bones=None, paint=None, group="main", budget=600,
                 crease=65.0, smooth=2, density=1.0, hitgroup=0, hitbox=True, voxel=None, mesh=None,
                 ao_shape=None, charts=None):
        """shape: sdf.SDF (or mesh: a mesh.TriMesh built by hand, rest model space).
        bone: name of the bone the part is rigidly bound to; bones: list for nearest-segment binding.
        paint(P, N, skin) -> colours (N, 3) in [0, 1] (or (colours, alpha) in masked groups).
        budget: triangle budget of the part; density: relative texel density in the atlas (eyes 2.0).
        hitgroup: hitbox group for its bone(s) (0 generic, 1 head, ...); hitbox=False: none from it.
        charts: optional texture.box_charts options for this part (e.g. {"smooth_iters": 8, "min_dot": 0.2}:
        fewer, larger UV charts on rounded limbs; {"frame": R}: box axes turned by the rotation R, e.g. to
        centre one chart on a decal)."""
        if shape is None and mesh is None:
            raise ValueError("Part needs a shape or a mesh")
        if (bone is None) == (bones is None):
            raise ValueError("Part needs exactly one of bone= or bones=")
        self.name = name
        self.shape = shape
        self.bone = bone
        self.bones = bones
        self.paint = paint
        self.group = group
        self.budget = budget
        self.crease = crease
        self.smooth = smooth
        self.density = density
        self.hitgroup = hitgroup
        self.hitbox = hitbox
        self.voxel = voxel
        self.mesh = mesh
        self.ao_shape = ao_shape
        self.charts = charts


class TextureGroup:
    def __init__(self, name, size=(256, 256), flags=0, dither=0.0, pack="shelf", gutter=None, skin_flags=None):
        self.name = name
        self.size = tuple(size)
        self.flags = flags
        self.dither = dither
        self.pack = pack
        self.gutter = gutter
        self.skin_flags = dict(skin_flags or {})

    def gutter_for(self, skin):
        """Colour of the atlas texels no chart reaches (beyond the islands' dilation), or None (their mean)."""
        g = self.gutter(skin) if callable(self.gutter) else self.gutter
        return None if g is None else np.asarray(g, dtype=np.float64)

    @property
    def masked(self):
        return bool(self.flags & mdl.STUDIO_NF_MASKED)


def _default_paint(P, N, skin):
    return np.tile([0.7, 0.7, 0.7], (len(P), 1))


def point_segment_distance(P, a, b):
    ab = b - a
    L2 = float(ab @ ab)
    if L2 < 1e-12:
        return np.linalg.norm(P - a, axis=1)
    t = np.clip((P - a) @ ab / L2, 0.0, 1.0)
    return np.linalg.norm(P - (a + np.outer(t, ab)), axis=1)


class ModelBuilder:
    def __init__(self, name, rig, skins=1, verbose=True):
        self.name = name
        self.rig = rig
        self.skins = skins
        self.parts = []
        self.groups = {}
        self.sequences = []
        self.attachments = []
        self.hitboxes = None
        self.controllers = []
        self.eyeposition = None
        self.hull = None
        self.flags = 0              # header flags (mdl.STUDIO_AMBIENT_LIGHT, ...)
        self.verbose = verbose
        self.report = []

    # declaration ------------------------------------------------------------------------------
    def group(self, name, size=(256, 256), flags=0, dither=0.0, pack="shelf", gutter=None, skin_flags=None):
        """Texture group (one atlas): pack="skyline" packs the UV charts denser than the default "shelf".
        gutter: rgb (or skin -> rgb / None) for the unused atlas space (default: the mean colour), e.g. black for
        additive skins; skin_flags: {skin: extra texture flags} (e.g. STUDIO_NF_FULLBRIGHT on one skin only)."""
        self.groups[name] = TextureGroup(name, size, flags, dither, pack, gutter, skin_flags)
        return self.groups[name]

    def add(self, part):
        if part.group not in self.groups:
            self.group(part.group)
        self.parts.append(part)
        return part

    def add_sequence(self, seq):
        self.sequences.append(seq)
        return seq

    def attachment(self, name, bone, pos):
        """Attachment at model-space rest position pos, carried by `bone`."""
        org = np.asarray(pos, dtype=np.float64) - self.rig.head(bone)
        self.attachments.append(mdl.Attachment(bone=self.rig.index(bone), org=tuple(org), name=name))

    def hitbox(self, bone, bbmin, bbmax, group=0):
        """Manual hitbox in model-space rest coordinates (disables the automatic ones)."""
        if self.hitboxes is None:
            self.hitboxes = []
        h = self.rig.head(bone)
        self.hitboxes.append(mdl.Hitbox(bone=self.rig.index(bone), group=group,
                                        bbmin=tuple(np.asarray(bbmin) - h), bbmax=tuple(np.asarray(bbmax) - h)))

    def controller(self, bone, type=mdl.STUDIO_ZR, start=-45.0, end=45.0, index=0):
        """Bone controller (e.g. head yaw: type STUDIO_ZR, -45..45 degrees, index 0)."""
        rest = int(round(255 * (0 - start) / (end - start))) if end != start else 0
        self.controllers.append(mdl.BoneController(bone=self.rig.index(bone), type=type, start=start, end=end,
                                                   index=index, rest=max(0, min(255, rest))))

    # build ------------------------------------------------------------------------------------
    def _log(self, msg):
        self.report.append(msg)
        if self.verbose:
            print(f"  [{self.name}] {msg}", file=sys.stderr)

    def mesh_parts(self):
        """Mesh every part (cached on the part as .tri, .nrm, .corner_n, .vbone)."""
        rig = self.rig
        for part in self.parts:
            if getattr(part, "tri", None) is not None:
                continue
            t0 = time.time()
            if part.mesh is not None:
                m = part.mesh.compact()
            else:
                m = meshmod.mesh_sdf(part.shape, budget=part.budget, voxel=part.voxel, smooth=part.smooth)
            nrm, corner_n = meshmod.crease_normals(m, part.crease)
            if part.bone is not None:
                vb = np.full(len(m.verts), rig.index(part.bone), dtype=np.int64)
            else:
                d = np.stack([point_segment_distance(m.verts, rig.head(b), rig.tail(b)) for b in part.bones], axis=1)
                vb = np.array([rig.index(b) for b in part.bones])[np.argmin(d, axis=1)]
            part.tri, part.nrm, part.corner_n, part.vbone = m, nrm, corner_n, vb
            self._log(f"part {part.name}: {len(m.faces)} tris, {len(m.verts)} verts ({time.time() - t0:.1f}s)")

    def build(self):
        rig = self.rig
        if not self.sequences:
            raise ValueError("no sequences")
        self.mesh_parts()
        group_names = [g for g in self.groups if any(p.group == g for p in self.parts)]

        # --- UV layout per group
        for g in group_names:
            charts = []
            for pi, part in enumerate(self.parts):
                if part.group != g:
                    continue
                for c in texture.box_charts(part.tri.verts, part.tri.faces, **(part.charts or {})):
                    c["part"] = pi
                    c["density"] = part.density
                    charts.append(c)
            dens = texture.pack_charts(charts, self.groups[g].size, method=self.groups[g].pack)
            self._log(f"group {g}: {len(charts)} charts, {dens:.2f} px/unit")
            for part in self.parts:
                if part.group == g:
                    part.st = np.zeros((len(part.tri.faces), 3, 2), dtype=np.int64)
            for c in charts:
                self.parts[c["part"]].st[c["faces"]] = c["st"]

        # --- textures (group x skin), deduplicated
        textures, tex_keys = [], {}
        skin_table = [[0] * len(group_names) for _ in range(self.skins)]
        base = self.name.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        for gi, g in enumerate(group_names):
            grp = self.groups[g]
            members = [pi for pi, p in enumerate(self.parts) if p.group == g]
            st = np.concatenate([self.parts[pi].st for pi in members])
            pos = np.concatenate([self.parts[pi].tri.verts[self.parts[pi].tri.faces] for pi in members])
            nrm = np.concatenate([self.parts[pi].nrm[self.parts[pi].corner_n] for pi in members])
            tags = np.concatenate([np.full(len(self.parts[pi].tri.faces), pi) for pi in members])

            def dispatch(P, N, skin, tag, _parts=self.parts, masked=grp.masked):
                col = np.zeros((len(P), 3))
                alpha = np.ones(len(P))
                for pi in np.unique(tag):
                    sel = tag == pi
                    fn = _parts[pi].paint or _default_paint
                    out = fn(P[sel], N[sel], skin)
                    if isinstance(out, tuple):
                        col[sel], alpha[sel] = out[0], out[1]
                    else:
                        col[sel] = out
                return (col, alpha) if masked else col

            for skin in range(self.skins):
                img, alpha, _ = texture.bake(grp.size, st, pos, nrm, dispatch, skin, extra=tags,
                                             gutter=grp.gutter_for(skin))
                tflags = grp.flags | grp.skin_flags.get(skin, 0)
                transparent = (alpha < 0.5) if alpha is not None else None
                idx, pal = texture.quantize(img, 256, transparent=transparent, dither=grp.dither)
                key = idx.tobytes() + pal.tobytes() + bytes([tflags & 0xFF, tflags >> 8 & 0xFF])
                if key not in tex_keys:
                    tex_keys[key] = len(textures)
                    textures.append(mdl.Texture(name=f"{base}_{g}{skin}.bmp"[:63], pixels=idx, palette=pal,
                                                flags=tflags))
                skin_table[skin][gi] = tex_keys[key]

        # --- geometry: one model per bodypart; parts are distributed so that limits hold
        rest_heads = np.array([b.head for b in rig.bones])
        chunks, cur, cur_v, cur_n = [], [], 0, 0
        for pi, part in enumerate(self.parts):
            nv = len(part.tri.verts)
            nn = len(np.unique(np.stack([part.corner_n, part.vbone[part.tri.faces]], -1).reshape(-1, 2), axis=0))
            if cur and (cur_v + nv > mdl.MAXSTUDIOVERTS or cur_n + nn > mdl.MAXSTUDIOVERTS - 64):
                chunks.append(cur)
                cur, cur_v, cur_n = [], 0, 0
            cur.append(pi)
            cur_v += nv
            cur_n += nn
        if cur:
            chunks.append(cur)
        bodyparts = []
        for ci, chunk in enumerate(chunks):
            verts, vbone, norms, nbone = [], [], [], []
            mesh_tris = {g: [] for g in group_names}
            for pi in chunk:
                part = self.parts[pi]
                v0 = len(verts)
                verts.extend(part.tri.verts - rest_heads[part.vbone])
                vbone.extend(part.vbone.tolist())
                # normals keyed by (normal id, bone)
                nkey = {}
                F = part.tri.faces
                tri = np.zeros((len(F), 3, 4), dtype=np.int64)
                for f in range(len(F)):
                    for k in range(3):
                        vi = int(F[f, k])
                        key = (int(part.corner_n[f, k]), int(part.vbone[vi]))
                        if key not in nkey:
                            nkey[key] = len(norms)
                            norms.append(part.nrm[key[0]])
                            nbone.append(key[1])
                        tri[f, k] = (v0 + vi, nkey[key], part.st[f, k, 0], part.st[f, k, 1])
                mesh_tris[part.group].append(tri)
            meshes = [mdl.Mesh(tris=np.concatenate(mesh_tris[g]), skinref=gi)
                      for gi, g in enumerate(group_names) if mesh_tris[g]]
            model = mdl.Model(name=f"{base}_body{ci}" if len(chunks) > 1 else base, verts=np.array(verts),
                              vert_bone=np.array(vbone), norms=np.array(norms), norm_bone=np.array(nbone),
                              meshes=meshes)
            bodyparts.append(mdl.BodyPart(name=f"body{ci}" if len(chunks) > 1 else "body", models=[model]))
            self._log(f"bodypart {bodyparts[-1].name}: {len(verts)} verts, {len(norms)} normals, "
                      f"{sum(len(m.tris) for m in meshes)} tris")

        # --- bounding boxes per sequence (rest model-space verts posed by every frame)
        all_v = np.concatenate([p.tri.verts for p in self.parts])
        all_b = np.concatenate([p.vbone for p in self.parts])
        bones = rig.mdl_bones()
        hdr_lo, hdr_hi = None, None
        for s in self.sequences:
            lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
            for f in range(s.numframes):
                W = mdl.bone_matrices(bones, s.pos[f], s.rot[f])
                local = all_v - rest_heads[all_b]
                p = np.einsum("nij,nj->ni", W[all_b][:, :, :3], local) + W[all_b][:, :, 3]
                lo = np.minimum(lo, p.min(0))
                hi = np.maximum(hi, p.max(0))
            s.bbmin, s.bbmax = tuple(lo), tuple(hi)
            if hdr_lo is None:
                hdr_lo, hdr_hi = lo, hi
        ntris = sum(len(p.tri.faces) for p in self.parts)
        self._log(f"total {ntris} triangles, {len(textures)} textures, rest bbox {np.round(hdr_lo, 1)} .. "
                  f"{np.round(hdr_hi, 1)}")

        # --- hitboxes
        if self.hitboxes is None:
            hitboxes = []
            for bi, b in enumerate(rig.bones):
                sel = np.zeros(0, dtype=bool)
                pts, groups = [], []
                for part in self.parts:
                    if not part.hitbox:
                        continue
                    m = part.vbone == bi
                    if m.any():
                        pts.append(part.tri.verts[m])
                        groups.append(part.hitgroup)
                if not pts:
                    continue
                p = np.concatenate(pts)
                if len(p) < 4:
                    continue
                lo, hi = p.min(0) - b.head, p.max(0) - b.head
                hitboxes.append(mdl.Hitbox(bone=bi, group=max(groups), bbmin=tuple(lo), bbmax=tuple(hi)))
        else:
            hitboxes = self.hitboxes

        eye = self.eyeposition if self.eyeposition is not None else (0.0, 0.0, float(hdr_hi[2]) * 0.85)
        if self.hull is not None:
            hmin, hmax = self.hull
        else:
            r = float(max(abs(hdr_lo[0]), abs(hdr_hi[0]), abs(hdr_lo[1]), abs(hdr_hi[1])))
            hmin, hmax = (-r, -r, 0.0), (r, r, float(hdr_hi[2]))
        return mdl.Studio(name=self.name, bones=bones, sequences=self.sequences, textures=textures,
                          bodyparts=bodyparts, skins=skin_table, controllers=self.controllers,
                          attachments=self.attachments, hitboxes=hitboxes, eyeposition=tuple(eye),
                          min=tuple(hmin), max=tuple(hmax), bbmin=tuple(hdr_lo), bbmax=tuple(hdr_hi),
                          flags=self.flags)

    def write(self, path=None):
        """Build, serialise and validate; returns the bytes (and writes them to path if given)."""
        st = self.build()
        data = mdl.write(st)
        mdl.read(data)  # validation
        if path:
            with open(path, "wb") as f:
                f.write(data)
        return data
