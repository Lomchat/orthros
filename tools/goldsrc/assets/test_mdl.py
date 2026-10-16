"""Tests of the asset toolchain: python3 -I tools/goldsrc/assets/test_mdl.py

Round-trips a small studio model through the writer and the reader/validator, checks the exact
animation decoding, strips, corruption detection, smooth skinning (bone weights), the glTF reader and
importer on a tiny synthetic glTF, and the kit (rig IK, meshing, sprites, wav, zip).
"""
import math
import os
import struct
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assets import build as buildmod  # noqa: E402
from assets import builder, gltf, icons, mdl, mesh, official, render, rig as R, sdf, spr, texture, wav, xform  # noqa: E402


def cube_model(bone, center, half, base_uv=(0, 0)):
    """A cube (12 outward-CCW triangles) with one normal per face and simple UVs."""
    c = np.asarray(center, float)
    corners = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], float) * half + c
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    tris, norms = [], []
    for qi, (a, b, cc, d) in enumerate(quads):
        n = np.cross(corners[b] - corners[a], corners[cc] - corners[a])
        n /= np.linalg.norm(n)
        if n @ (corners[a] - c) < 0:  # make outward
            a, b, cc, d = d, cc, b, a
            n = -n
        norms.append(n)
        u0, v0 = base_uv[0] + qi * 10, base_uv[1]
        uv = {a: (u0, v0), b: (u0 + 8, v0), cc: (u0 + 8, v0 + 8), d: (u0, v0 + 8)}
        for t in ((a, b, cc), (a, cc, d)):
            tris.append([(v, qi, *uv[v]) for v in t])
    return corners, np.array(norms), np.array(tris, dtype=np.int64)


def make_studio():
    bones = [mdl.Bone("root", -1, (0, 0, 0), (0, 0, 0)),
             mdl.Bone("body", 0, (0, 0, 10), (0, 0.1, 0)),
             mdl.Bone("head", 1, (1, 0, 8), (0.05, -0.2, 0.3))]
    nb = len(bones)
    rng = np.random.default_rng(5)

    def seq_arrays(nf, amp):
        P = np.tile(np.array([b.pos for b in bones], float), (nf, 1, 1))
        Rr = np.tile(np.array([b.rot for b in bones], float), (nf, 1, 1))
        t = np.linspace(0, 1, nf)
        P[:, 1, 2] += amp * np.sin(2 * np.pi * t)
        Rr[:, 2, 2] += amp * 0.1 * np.sin(2 * np.pi * t + 0.3)
        Rr[:, 1, 0] += amp * 0.05 * np.cos(2 * np.pi * t)
        return P, Rr

    P, Rr = seq_arrays(31, 2.0)
    P[-1], Rr[-1] = P[0], Rr[0]
    idle = mdl.Sequence("idle", P, Rr, fps=15, flags=mdl.STUDIO_LOOPING, activity=mdl.ACT["IDLE"], actweight=1)
    # long sequence with constant stretches longer than 255 frames and repeated values
    nf = 600
    P2 = np.tile(np.array([b.pos for b in bones], float), (nf, 1, 1))
    R2 = np.tile(np.array([b.rot for b in bones], float), (nf, 1, 1))
    P2[100:150, 0, 0] = 3.0
    P2[400:, 0, 0] = np.linspace(0, 5, 200)
    R2[:, 2, 1] = np.round(rng.standard_normal(nf) * 3) / 10.0  # many repeats
    longseq = mdl.Sequence("long", P2, R2, fps=30, events=[mdl.Event(10, 5004, 0, "pokemon/x.wav")],
                           linearmovement=(12, 0, 0), motiontype=mdl.STUDIO_LX, activity=mdl.ACT["WALK"],
                           actweight=1)
    still = mdl.Sequence("still", np.array([[b.pos for b in bones]], float), np.array([[b.rot for b in bones]], float))

    tex0 = mdl.Texture("t0.bmp", (np.arange(64 * 64) % 251).astype(np.uint8).reshape(64, 64),
                       np.stack([np.arange(256)] * 3, 1).astype(np.uint8))
    tex1 = mdl.Texture("t1.bmp", np.full((32, 64), 255, np.uint8), np.zeros((256, 3), np.uint8),
                       flags=mdl.STUDIO_NF_MASKED)
    tex2 = mdl.Texture("t0b.bmp", tex0.pixels[::-1].copy(), tex0.palette, flags=mdl.STUDIO_NF_FLATSHADE)
    v1, n1, t1 = cube_model(1, (0, 0, 0), 4.0)
    v2, n2, t2 = cube_model(2, (2, 0, 0), 2.0, base_uv=(0, 10))
    t2_off = t2.copy()
    t2_off[..., 0] += len(v1)
    t2_off[..., 1] += len(n1)
    t2_off[..., 3] = np.minimum(t2_off[..., 3], 32)
    model = mdl.Model("body", np.concatenate([v1, v2]), np.array([1] * 8 + [2] * 8), np.concatenate([n1, n2]),
                      np.array([1] * 6 + [2] * 6),
                      meshes=[mdl.Mesh(t1, skinref=0), mdl.Mesh(t2_off, skinref=1), mdl.Mesh(t1[:4], skinref=1)])
    v3, n3, t3 = cube_model(0, (0, 0, 1), 1.0)
    small = mdl.Model("acc_a", v3, np.zeros(8, int), n3, np.zeros(6, int), meshes=[mdl.Mesh(t3, 0)])
    small_b = mdl.Model("acc_b", v3 * 2, np.zeros(8, int), n3, np.zeros(6, int), meshes=[mdl.Mesh(t3[:6], 0)])
    st = mdl.Studio(
        name="test/test.mdl", bones=bones, sequences=[idle, longseq, still], textures=[tex0, tex1, tex2],
        bodyparts=[mdl.BodyPart("body", [model]), mdl.BodyPart("acc", [small, small_b])],
        skins=[[0, 1], [2, 1]],
        controllers=[mdl.BoneController(bone=2, type=mdl.STUDIO_ZR, start=-45, end=45, index=0, rest=128)],
        attachments=[mdl.Attachment(bone=2, org=(3, 0, 1), name="mouth"), mdl.Attachment(bone=1, org=(0, 2, 0))],
        hitboxes=[mdl.Hitbox(1, (-4, -4, -4), (4, 4, 4), 2), mdl.Hitbox(2, (-2, -2, -2), (2, 2, 2), 1)],
        eyeposition=(0, 0, 20), min=(-8, -8, 0), max=(8, 8, 24), bbmin=(-8, -8, 0), bbmax=(8, 8, 24))
    return st


def tri_key(tris):
    """Multiset of triangles (vert, norm, s, t) per corner, invariant to rotation of the corners."""
    out = []
    for t in np.asarray(tris).tolist():
        c = [tuple(x) for x in t]
        k = min(range(3), key=lambda i: c[i])
        out.append(tuple(c[k:] + c[:k]))
    return sorted(out)


class MdlRoundTrip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.st = make_studio()
        cls.data = mdl.write(cls.st)
        cls.pm = mdl.read(cls.data)

    def test_deterministic(self):
        self.assertEqual(mdl.write(make_studio()), self.data)

    def test_header(self):
        pm = self.pm
        self.assertEqual(pm.length, len(self.data))
        self.assertEqual(len(self.data) % 4, 0)
        self.assertEqual(pm.name, "test/test.mdl")
        self.assertEqual(pm.errors, [])
        self.assertEqual([b.name for b in pm.bones], ["root", "body", "head"])
        self.assertEqual([b.parent for b in pm.bones], [-1, 0, 1])
        self.assertEqual(pm.bones[2].controller, [-1, -1, -1, -1, -1, 0])
        np.testing.assert_allclose(pm.eyeposition, (0, 0, 20))
        self.assertEqual(pm.skins.tolist(), [[0, 1], [2, 1]])
        self.assertEqual(len(pm.attachments), 2)
        self.assertEqual(pm.attachments[0].name, "mouth")
        self.assertEqual([h.group for h in pm.hitboxes], [2, 1])
        self.assertEqual(pm.seqgroups[0]["label"], "default")
        self.assertEqual(pm.bodyparts[1].base, 1)
        self.assertEqual(len(pm.bodyparts[1].models), 2)

    def test_sequences(self):
        pm = self.pm
        self.assertEqual([s["name"] for s in pm.sequences], ["idle", "long", "still"])
        s = pm.sequences[1]
        self.assertEqual(s["numframes"], 600)
        self.assertEqual(s["activity"], mdl.ACT["WALK"])
        self.assertEqual(s["events"][0].options, "pokemon/x.wav")
        self.assertEqual(s["events"][0].event, 5004)
        np.testing.assert_allclose(s["linearmovement"], (12, 0, 0))
        self.assertTrue(pm.sequences[0]["flags"] & mdl.STUDIO_LOOPING)
        self.assertFalse(pm.sequences[2]["anim_offsets"].any())  # all defaults -> no data

    def test_animation_decoding(self):
        pm = self.pm
        adj = mdl.controller_adj(pm)[0]  # head yaw controller at its rest byte (128)
        for si, seq in enumerate(self.st.sequences):
            P, Rr = seq.pos, seq.rot.copy()
            Rr[:, 2, 2] += adj
            for f in range(seq.numframes):
                pos, q = mdl.calc_rotations(pm, si, float(f))
                for b in range(3):
                    tol_p = pm.bones[b].scale[0:3]
                    np.testing.assert_allclose(pos[b], P[f, b], atol=max(tol_p) + 1e-5)
                    want = xform.euler_matrix(Rr[f, b])
                    got = xform.quaternion_matrix(q[b])
                    self.assertLess(np.abs(want - got).max(), 1e-3, (si, f, b))
        # fractional frame: interpolation between frames 3 and 4 of idle
        pos_a, _ = mdl.calc_rotations(pm, 0, 3.0)
        pos_b, _ = mdl.calc_rotations(pm, 0, 4.0)
        pos_m, _ = mdl.calc_rotations(pm, 0, 3.5)
        np.testing.assert_allclose(pos_m, (pos_a + pos_b) / 2, atol=1e-5)
        # frame past the end wraps to 0 like the engine
        p0, _ = mdl.calc_rotations(pm, 0, 0.0)
        pw, _ = mdl.calc_rotations(pm, 0, 30.5)
        np.testing.assert_allclose(p0, pw)

    def test_controller(self):
        pm = self.pm
        _, q_rest = mdl.calc_rotations(pm, 2, 0.0)
        _, q_max = mdl.calc_rotations(pm, 2, 0.0, controllers=[255, 0, 0, 0])
        m0 = xform.quaternion_matrix(q_rest[2])
        m1 = xform.quaternion_matrix(q_max[2])
        ang = math.degrees(math.acos(max(-1, min(1, (np.trace(m0.T @ m1) - 1) / 2))))
        self.assertAlmostEqual(ang, 45 - (128 / 255 * 90 - 45), delta=0.5)

    def test_geometry(self):
        pm = self.pm
        m_in = self.st.bodyparts[0].models[0]
        m_out = pm.bodyparts[0].models[0]
        np.testing.assert_allclose(m_out.verts, m_in.verts, atol=1e-5)
        self.assertEqual(m_out.vert_bone.tolist(), m_in.vert_bone.tolist())
        self.assertEqual(len(m_out.meshes), 3)
        for me_in, me_out in zip(m_in.meshes, m_out.meshes):
            self.assertEqual(me_out.skinref, me_in.skinref)
            # normal indices were regrouped per mesh: compare through the actual vectors
            a = [(c[0], tuple(np.round(m_in.norms[c[1]], 5)), c[2], c[3]) for t in me_in.tris for c in t]
            b = [(c[0], tuple(np.round(m_out.norms[c[1]], 5)), c[2], c[3]) for t in me_out.tris for c in t]
            ka = sorted(tuple(a[i:i + 3]) for i in range(0, len(a), 3))
            kb = sorted(tuple(b[i:i + 3]) for i in range(0, len(b), 3))
            ra = sorted(min(t[k:] + t[:k] for k in range(3)) for t in ka)
            rb = sorted(min(t[k:] + t[:k] for k in range(3)) for t in kb)
            self.assertEqual(ra, rb)
        self.assertEqual(sum(me.numnorms for me in m_out.meshes), len(m_out.norms))

    def test_on_disk_winding_is_reversed(self):
        # the engine wants the opposite of outward CCW: first strip triangle (v0, v1, v2) must be inward
        m = self.pm.bodyparts[0].models[0]
        kind, vs = m.meshes[0].cmds[0]
        p = m.verts[vs[:3, 0]]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        self.assertLess(n @ (p.mean(0) - np.array([0, 0, 0])), 0)

    def test_textures(self):
        pm = self.pm
        self.assertEqual([t.name for t in pm.textures], ["t0.bmp", "t1.bmp", "t0b.bmp"])
        np.testing.assert_array_equal(pm.textures[0].pixels, self.st.textures[0].pixels)
        np.testing.assert_array_equal(pm.textures[0].palette, self.st.textures[0].palette)
        self.assertEqual(pm.textures[1].flags, mdl.STUDIO_NF_MASKED)

    def test_validator_catches_corruption(self):
        d = bytearray(self.data)
        with self.assertRaises(mdl.MdlError):
            mdl.read(bytes(d[:-100]))
        bad = bytearray(d)
        struct.pack_into("<i", bad, 144, len(d) + 10)  # boneindex out of the file
        with self.assertRaises(mdl.MdlError):
            mdl.read(bytes(bad))
        # corrupt the first vertex index of the first strip of the first mesh
        bpindex = struct.unpack_from("<i", self.data, 208)[0]
        modelindex = struct.unpack_from("<i", self.data, bpindex + 72)[0]
        meshindex = struct.unpack_from("<i", self.data, modelindex + 76)[0]
        triindex = struct.unpack_from("<i", self.data, meshindex + 4)[0]
        bad = bytearray(d)
        struct.pack_into("<h", bad, triindex + 2, 999)
        with self.assertRaises(mdl.MdlError):
            mdl.read(bytes(bad))
        # overlapping regions are reported
        bad = bytearray(d)
        struct.pack_into("<i", bad, 168, struct.unpack_from("<i", d, 144)[0])  # seqindex = boneindex
        with self.assertRaises(mdl.MdlError):
            mdl.read(bytes(bad))

    def test_writer_rejects_bad_input(self):
        st = make_studio()
        st.bones[1].parent = 2
        with self.assertRaises(mdl.MdlError):
            mdl.write(st)
        st = make_studio()
        st.sequences[0].pos = st.sequences[0].pos[:, :2]
        with self.assertRaises(mdl.MdlError):
            mdl.write(st)

    def test_render(self):
        im = render.render_frame(self.pm, 0, 0.0, size=(96, 96), ss=1)
        a = np.asarray(im)
        self.assertEqual(a.shape, (96, 96, 3))
        self.assertGreater(len(np.unique(a.reshape(-1, 3), axis=0)), 8)


class Encoding(unittest.TestCase):
    def test_rle_runs(self):
        rng = np.random.default_rng(1)
        for trial in range(40):
            n = int(rng.integers(1, 700))
            v = np.repeat(rng.integers(-30000, 30000, size=n), rng.integers(1, 40, size=n))[:n]
            if trial % 3 == 0:
                v[:] = 7
            shorts = mdl.rle_encode(v)
            data = struct.pack("<%dh" % len(shorts), *shorts)
            for f in range(n):
                val = mdl._decode_pos_channel(data, 0, f, 0.0)
                self.assertEqual(val, v[f])
                a1, _ = mdl._decode_rot_channel(data, 0, f)
                self.assertEqual(a1, v[f])

    def test_strips(self):
        s = sdf.sphere((0, 0, 0), 5) | sdf.capsule((0, 0, 0), (0, 0, 9), 2)
        m = mesh.surface_nets(s, s.lo, s.hi, 0.8)
        tris = [tuple((int(v), 0, 0, 0) for v in f) for f in m.faces]
        strips = mdl.stripify(tris)
        out = []
        for st in strips:
            for k in range(len(st) - 2):
                out.append((st[k], st[k + 1], st[k + 2]) if k % 2 == 0 else (st[k + 1], st[k], st[k + 2]))
        self.assertEqual(tri_key(out), tri_key(tris))
        self.assertLess(len(strips), len(tris) / 2)

    def test_euler_convention(self):
        a = np.radians([10.0, 20.0, 30.0])
        c, s = np.cos, np.sin
        Rx = np.array([[1, 0, 0], [0, c(a[0]), -s(a[0])], [0, s(a[0]), c(a[0])]])
        Ry = np.array([[c(a[1]), 0, s(a[1])], [0, 1, 0], [-s(a[1]), 0, c(a[1])]])
        Rz = np.array([[c(a[2]), -s(a[2]), 0], [s(a[2]), c(a[2]), 0], [0, 0, 1]])
        np.testing.assert_allclose(xform.euler_matrix(a), Rz @ Ry @ Rx, atol=1e-12)
        np.testing.assert_allclose(xform.matrix_euler(Rz @ Ry @ Rx), a, atol=1e-12)


class Kit(unittest.TestCase):
    def test_meshing(self):
        s = sdf.sphere((0, 0, 0), 10)
        m = mesh.mesh_sdf(s, budget=400)
        self.assertLessEqual(len(m.faces), 400)
        self.assertTrue(m.is_closed_manifold())
        self.assertLess(np.abs(s(m.verts)).max(), 0.05)
        self.assertAlmostEqual(m.area() / (4 * np.pi * 100), 1.0, delta=0.05)
        n, ci = m.normals(60)
        cen = m.verts[m.faces].mean(1)
        self.assertGreater(np.mean(np.sum(n[ci[:, 0]] * cen, 1) > 0), 0.99)

    def test_ik(self):
        rig = R.Rig()
        rig.add("root", None, (0, 0, 0))
        rig.add("hip", "root", (0, 3, 12))
        rig.add("knee", "hip", (0.5, 3, 6))
        rig.add("foot", "knee", (0, 3, 1))
        p = R.Pose()
        p.move("root", z=-1.0)
        target = np.array([2.0, 3.0, 2.0])
        rig.solve_two_bone(p, "hip", "knee", "foot", target, pole=(1, 0, 0), end_world_rot=np.eye(3))
        W = rig.world(p)
        np.testing.assert_allclose(W[rig.index("foot")][:, 3], target, atol=1e-6)
        np.testing.assert_allclose(W[rig.index("foot")][:, :3], np.eye(3), atol=1e-6)
        self.assertGreater(W[rig.index("knee")][0, 3], 0.5)  # bends forward

    def test_sequence_and_keys(self):
        rig = R.Rig()
        rig.add("root", None, (0, 0, 0))
        rig.add("b", "root", (0, 0, 5))
        seq = R.make_sequence(rig, "idle", lambda t: R.Pose().rot("b", z=10 * R.wave(t)), 12, 12, loop=True,
                              activity=mdl.ACT["IDLE"])
        self.assertEqual(seq.numframes, 13)
        np.testing.assert_array_equal(seq.rot[0], seq.rot[-1])
        self.assertAlmostEqual(R.keys(0.5, [(0, 0.0), (1, 10.0)], "linear"), 5.0)
        self.assertAlmostEqual(R.keys(0.25, [(0, 0.0), (0.5, 10.0)], "cubic", loop=True), 5.0)

    def test_quantize(self):
        img = np.zeros((64, 64, 3))
        img[..., 0] = np.linspace(0, 1, 64)[None, :]
        img[..., 1] = np.linspace(0, 1, 64)[:, None]
        idx, pal = texture.quantize(img, 256)
        err = np.abs(pal[idx].astype(float) / 255 - img).max()
        self.assertLess(err, 0.05)
        tr = np.zeros((64, 64), bool)
        tr[:8] = True
        idx, pal = texture.quantize(img, 256, transparent=tr)
        self.assertTrue((idx[:8] == 255).all() and (idx[8:] != 255).all())

    def test_builder_small(self):
        rig = R.Rig()
        rig.add("root", None, (0, 0, 0))
        rig.add("body", "root", (0, 0, 6))
        b = builder.ModelBuilder("t/blob.mdl", rig, skins=2, verbose=False)
        b.group("main", (64, 64))
        b.add(builder.Part("body", sdf.ellipsoid((0, 0, 6), (4, 3, 6)), bone="body", budget=200,
                           paint=lambda P, N, skin: texture.fill(P, "#ff0000" if skin else "#00ff00")))
        b.add_sequence(R.make_sequence(rig, "idle", lambda t: R.Pose().move("body", z=R.wave(t)), 8, 10, loop=True))
        data = b.write()
        pm = mdl.read(data)
        self.assertEqual(len(pm.textures), 2)
        self.assertEqual(pm.skins.tolist(), [[0], [1]])
        self.assertAlmostEqual(pm.sequences[0]["bbmax"][2], 13.0, delta=0.3)

    def test_sprite_roundtrip(self):
        c = icons.Canvas(40, 30)
        c.circle(20, 15, 10, fill="#ffcc00")
        c.bolt(5, 5, 35, 25, 3, fill="#ffffff")
        for fmt in (spr.ADDITIVE, spr.ALPHTEST, spr.INDEXALPHA, spr.NORMAL):
            data = spr.make([c.rgba(), c.rgba()[::-1].copy()], tex_format=fmt)
            s = spr.read(data)
            self.assertEqual((s["width"], s["height"], len(s["frames"])), (40, 30, 2))
            self.assertEqual(s["tex_format"], fmt)
            spr.to_rgba(s, 1)

    def test_wav(self):
        x = wav.normalize(wav.osc(440, 0.5) * wav.env_adsr(wav._n(0.5)))
        for bits in (8, 16):
            y, rate, b, ch = wav.read(wav.write(x, bits=bits))
            self.assertEqual((rate, b, ch, len(y)), (22050, bits, 1, len(x)))
            self.assertLess(np.abs(y - x).max(), 2.0 / (2 ** bits / 2))
        tone = wav.osc(1000, 0.5)
        out = wav.bandpass(tone, 1000, q=4)
        far = wav.bandpass(tone, 4000, q=4)
        self.assertGreater(np.abs(out[2000:]).max(), 3 * np.abs(far[2000:]).max())
        v = wav.voice(wav.glide(300, 500, 0.3), vowels=[(0, "a"), (0.3, "i")])
        self.assertTrue(np.all(np.isfinite(v)) and len(v) == wav._n(0.3))

    def test_zip_deterministic(self):
        files = {"b/x.txt": b"hello", "a/y.txt": b"world" * 100}
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as d:
            p1, p2 = os.path.join(d, "1.pk3"), os.path.join(d, "2.pk3")
            buildmod.write_zip(p1, files)
            buildmod.write_zip(p2, dict(reversed(list(files.items()))))
            with open(p1, "rb") as f1, open(p2, "rb") as f2:
                self.assertEqual(f1.read(), f2.read())


# ----------------------------------------------------------------------------------------------
# smooth skinning
# ----------------------------------------------------------------------------------------------

def make_weighted_studio():
    """A bar along x on two bones (root at x=0, tip at x=10), vertices blended across the joint."""
    bones = [mdl.Bone("root", -1, (0, 0, 5), (0, 0, 0)), mdl.Bone("tip", 0, (10, 0, 0), (0, 0, 0))]
    xs = np.linspace(0, 20, 6)
    verts, vb, vw = [], [], []
    for x in xs:
        for y, z in ((-1, 4), (1, 4), (1, 6), (-1, 6)):
            verts.append((x, y, z))
            t = float(np.clip((x - 5) / 10, 0, 1))  # 0 on root .. 1 on tip
            w1 = int(round(255 * t))
            if w1 == 0:
                vb.append((0, -1, -1, -1)); vw.append((255, 0, 0, 0))
            elif w1 == 255:
                vb.append((1, -1, -1, -1)); vw.append((255, 0, 0, 0))
            else:
                vb.append((1, 0, -1, -1) if w1 > 127 else (0, 1, -1, -1))
                vw.append((max(w1, 255 - w1), min(w1, 255 - w1), 0, 0))
    verts = np.array(verts, float)
    tris = []
    for i in range(len(xs) - 1):
        a, b = 4 * i, 4 * (i + 1)
        for k in range(4):
            k2 = (k + 1) % 4
            # quad (a+k, b+k, b+k2, a+k2), outward ccw
            for t in ((a + k, a + k2, b + k2), (a + k, b + k2, b + k)):
                tris.append([(v, v, (v % 4) * 8, i * 8) for v in t])
    norms = verts - np.array([[x, 0, 5] for x in verts[:, 0]])
    norms /= np.linalg.norm(norms, axis=1, keepdims=True)
    bw = mdl.BoneWeights(np.array(vb), np.array(vw))
    model = mdl.Model("bar", verts=verts, vert_bone=bw.bones[:, 0].copy(), norms=norms,
                      norm_bone=bw.bones[:, 0].copy(), meshes=[mdl.Mesh(np.array(tris, np.int64), 0)],
                      vert_weights=bw, norm_weights=None)
    nf = 9
    P = np.tile(np.array([b.pos for b in bones], float), (nf, 1, 1))
    Rr = np.zeros_like(P)
    Rr[:, 1, 2] = np.linspace(0, math.pi / 2, nf)  # tip yaws 90 degrees
    seq = mdl.Sequence("bend", P, Rr, fps=10)
    tex = mdl.Texture("bar.bmp", (np.arange(32 * 48) % 200).astype(np.uint8).reshape(48, 32),
                      np.stack([np.arange(256)] * 3, 1).astype(np.uint8))
    return mdl.Studio(name="test/bar.mdl", bones=bones, sequences=[seq], textures=[tex],
                      bodyparts=[mdl.BodyPart("body", [model])], bbmin=(0, -1, 4), bbmax=(20, 1, 6))


class Weighted(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.st = make_weighted_studio()
        cls.data = mdl.write(cls.st)
        cls.pm = mdl.read(cls.data)

    def test_flags_and_boneinfo(self):
        pm = self.pm
        self.assertEqual(pm.errors, [])
        self.assertTrue(pm.flags & mdl.STUDIO_HAS_BONEWEIGHTS and pm.flags & mdl.STUDIO_HAS_BONEINFO)
        boneindex = struct.unpack_from("<i", self.data, 64 + 8 + 4 + 15 * 4 + 4 + 4)[0]
        self.assertEqual(boneindex, mdl.SZ_HDR)
        # poseToBone = inverse rest matrices, right after the bones
        rest = mdl.rest_matrices(pm.bones)
        for i in range(2):
            np.testing.assert_allclose(xform.concat(rest[i], pm.pose_to_bone[i]), np.eye(4)[:3], atol=1e-6)
        self.assertEqual(mdl.write(make_weighted_studio()), self.data)  # deterministic

    def test_weights_roundtrip(self):
        m = self.pm.bodyparts[0].models[0]
        src = self.st.bodyparts[0].models[0]
        np.testing.assert_array_equal(m.vert_weights.bones, src.vert_weights.bones)
        np.testing.assert_array_equal(m.vert_weights.weights, src.vert_weights.weights)
        self.assertEqual(len(m.norm_weights.bones), len(m.norms))
        # every normal carries the weights of a vertex that uses it
        for me in m.meshes:
            for v, n in me.tris.reshape(-1, 4)[:, :2]:
                np.testing.assert_array_equal(m.norm_weights.bones[n], m.vert_weights.bones[v])

    def test_skinning_matches_linear_blend(self):
        pm = self.pm
        m = pm.bodyparts[0].models[0]
        for fr in (0, 4, 8):
            bm = mdl.pose(pm, 0, float(fr))
            v, n = mdl.posed_model(pm, m, bm)
            skin = mdl.skin_transforms(pm, bm)
            for i in range(len(m.verts)):
                b, w = m.vert_weights.bones[i], m.vert_weights.weights[i] / 255.0
                exp = sum(w[k] * xform.transform_points(skin[b[k]], m.verts[i:i + 1])[0] for k in range(4) if b[k] >= 0)
                np.testing.assert_allclose(v[i], exp, atol=1e-4)
        # rest frame: identity skinning
        v0, _ = mdl.posed_model(pm, m, mdl.pose(pm, 0, 0.0))
        np.testing.assert_allclose(v0, m.verts, atol=1e-4)
        # bent 90 degrees: the far end of the bar (pure tip) ends up along +y from the joint
        v8, _ = mdl.posed_model(pm, m, mdl.pose(pm, 0, 8.0))
        far = m.verts[:, 0] > 19
        np.testing.assert_allclose(v8[far][:, 1].mean(), 10.0, atol=0.05)
        np.testing.assert_allclose(v8[far][:, 0].mean(), 10.0, atol=0.05)

    def test_validator(self):
        d = bytearray(self.data)
        flags_off = 4 + 4 + 64 + 4 + 15 * 4
        f = struct.unpack_from("<I", d, flags_off)[0]
        struct.pack_into("<I", d, flags_off, f & ~mdl.STUDIO_HAS_BONEINFO)
        with self.assertRaises(mdl.MdlError):
            mdl.read(bytes(d))
        st = make_weighted_studio()
        bw = st.bodyparts[0].models[0].vert_weights
        bw.bones[3] = (-1, 0, -1, -1)
        with self.assertRaises(mdl.MdlError):
            mdl.write(st)
        st = make_weighted_studio()
        st.bodyparts[0].models[0].vert_weights.weights[5] = (200, 100, 0, 0)
        with self.assertRaises(mdl.MdlError):
            mdl.write(st)

    def test_render(self):
        im = render.render_frame(self.pm, 0, 8.0, size=(96, 96), ss=1)
        self.assertEqual(im.size, (96, 96))


# ----------------------------------------------------------------------------------------------
# glTF reader and importer (tiny synthetic file)
# ----------------------------------------------------------------------------------------------

def make_tiny_gltf():
    """A 2-joint skinned column (glTF axes: +Y up, faces +Z), 1 m tall, weights blended in the middle,
    an animation (child joint bends 90 deg about X, LINEAR; root translation CUBICSPLINE; STEP scale),
    normalized ubyte weights, a sparse POSITION accessor, an 8x8 PNG texture with a cut-out (alpha MASK)."""
    import io as _io
    from PIL import Image as _Image
    rows = 5
    pos, uv, joints, weights = [], [], [], []
    for r in range(rows):
        y = r / (rows - 1)
        for (x, z) in ((-0.1, -0.1), (0.1, -0.1), (0.1, 0.1), (-0.1, 0.1)):
            pos.append((x, y, z))
            uv.append((0.5 + x * 2, 1.0 - y))
            t = min(max((y - 0.25) / 0.5, 0.0), 1.0)
            joints.append((0, 1, 0, 0))
            weights.append((int(round(255 * (1 - t))), 255 - int(round(255 * (1 - t))), 0, 0))
    pos = np.array(pos, np.float32)
    idx = []
    for r in range(rows - 1):
        a, b = 4 * r, 4 * (r + 1)
        for k in range(4):
            k2 = (k + 1) % 4
            idx += [a + k, a + k2, b + k2, a + k, b + k2, b + k]
    idx = np.array(idx, np.uint16)
    # outward winding check: flip if needed (glTF front = counter-clockwise seen from outside)
    tri = idx.reshape(-1, 3)
    c = pos[tri].mean(1)
    n = np.cross(pos[tri[:, 1]] - pos[tri[:, 0]], pos[tri[:, 2]] - pos[tri[:, 0]])
    out = np.einsum("ij,ij->i", n, c - np.c_[np.zeros(len(c)), c[:, 1], np.zeros(len(c))]) < 0
    tri[out] = tri[out][:, ::-1]
    idx = tri.reshape(-1).astype(np.uint16)
    img = np.zeros((8, 8, 4), np.uint8)
    img[..., 0] = 220
    img[..., 1] = np.arange(8)[None, :] * 30
    img[..., 3] = 255
    img[3:5, 3:5, 3] = 0
    bio = _io.BytesIO()
    _Image.fromarray(img, "RGBA").save(bio, "PNG")
    png = bio.getvalue()
    # sparse: the stored positions of row 0 are wrong (zeros) and fixed by a sparse substitution
    stored = pos.copy()
    stored[0:4] = 0.0
    sp_idx = np.arange(4, dtype=np.uint8)
    sp_val = pos[0:4]
    ibm = np.stack([np.eye(4), np.eye(4)]).astype(np.float32)
    ibm[1][1, 3] = -0.5                       # joint 1 at y = 0.5 (row-major here, column-major on disk)
    times = np.array([0.0, 1.0], np.float32)
    rot = np.array([[0, 0, 0, 1], [math.sin(math.pi / 4), 0, 0, math.cos(math.pi / 4)]], np.float32)
    # CUBICSPLINE translation: (in, value, out) per key; zero tangents -> smoothstep between the values
    cub = np.array([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0.5], [0, 0, 0]], np.float32)
    step_t = np.array([0.0, 0.5], np.float32)
    step_s = np.array([[1, 1, 1], [1, 1, 1]], np.float32)
    blobs, views, accs = [], [], []

    def add(arr, target=None):
        b = np.ascontiguousarray(arr).tobytes()
        off = sum(len(x) for x in blobs)
        pad = (4 - off % 4) % 4
        if pad:
            blobs.append(b"\0" * pad)
            off += pad
        blobs.append(b)
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(b)}
        if target:
            v["target"] = target
        views.append(v)
        return len(views) - 1

    def acc(arr, ctype, typ, normalized=False, sparse=None, minmax=False):
        a = {"bufferView": add(arr), "componentType": ctype, "count": int(len(arr)), "type": typ}
        if normalized:
            a["normalized"] = True
        if sparse:
            a["sparse"] = sparse
        if minmax:
            a["min"] = arr.min(0).tolist()
            a["max"] = arr.max(0).tolist()
        accs.append(a)
        return len(accs) - 1

    a_pos = acc(stored, 5126, "VEC3", minmax=True)
    accs[a_pos]["sparse"] = {"count": 4, "indices": {"bufferView": add(sp_idx), "componentType": 5121},
                             "values": {"bufferView": add(sp_val)}}
    a_uv = acc(np.array(uv, np.float32), 5126, "VEC2")
    a_j = acc(np.array(joints, np.uint8), 5121, "VEC4")
    a_w = acc(np.array(weights, np.uint8), 5121, "VEC4", normalized=True)
    a_i = acc(idx, 5123, "SCALAR")
    a_ibm = acc(ibm.transpose(0, 2, 1).reshape(2, 16), 5126, "MAT4")
    a_t = acc(times, 5126, "SCALAR")
    a_r = acc(rot, 5126, "VEC4")
    a_c = acc(cub, 5126, "VEC3")
    a_st = acc(step_t, 5126, "SCALAR")
    a_ss = acc(step_s, 5126, "VEC3")
    img_view = add(np.frombuffer(png, np.uint8))
    doc = {
        "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0, 3]}],
        "nodes": [{"name": "Root_1", "children": [1]}, {"name": "Base_2", "children": [2]},
                  {"name": "Top_3", "translation": [0, 0.5, 0]}, {"name": "Body", "mesh": 0, "skin": 0}],
        "skins": [{"joints": [1, 2], "inverseBindMatrices": a_ibm}],
        "meshes": [{"name": "column", "primitives": [{"attributes": {"POSITION": a_pos, "TEXCOORD_0": a_uv,
                                                                    "JOINTS_0": a_j, "WEIGHTS_0": a_w},
                                                     "indices": a_i, "material": 0}]}],
        "materials": [{"name": "skin", "alphaMode": "MASK", "alphaCutoff": 0.5,
                       "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
        "textures": [{"source": 0}], "images": [{"bufferView": img_view, "mimeType": "image/png"}],
        "animations": [{"name": "bend", "samplers": [
            {"input": a_t, "output": a_r, "interpolation": "LINEAR"},
            {"input": a_t, "output": a_c, "interpolation": "CUBICSPLINE"},
            {"input": a_st, "output": a_ss, "interpolation": "STEP"}],
            "channels": [{"sampler": 0, "target": {"node": 2, "path": "rotation"}},
                         {"sampler": 1, "target": {"node": 1, "path": "translation"}},
                         {"sampler": 2, "target": {"node": 1, "path": "scale"}}]}],
    }
    blob = b"".join(blobs)
    doc["buffers"] = [{"byteLength": len(blob)}]
    doc["bufferViews"] = views
    doc["accessors"] = accs
    return gltf.write_glb(doc, blob), pos


class Gltf(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data, cls.pos = make_tiny_gltf()
        cls.g = gltf.loads(cls.data)

    def test_reader(self):
        g = self.g
        p = g.meshes[0].primitives[0]
        np.testing.assert_allclose(p.attributes["POSITION"], self.pos, atol=1e-7)  # sparse applied
        w = p.attributes["WEIGHTS_0"]
        self.assertEqual(w.dtype, np.float64)
        np.testing.assert_allclose(w.sum(1), 1.0, atol=1e-6)                   # normalized ubyte
        self.assertEqual(p.attributes["JOINTS_0"].dtype, np.int64)
        self.assertEqual(p.triangles.shape, (32, 3))
        np.testing.assert_allclose(g.skins[0].inverse_bind[1][1, 3], -0.5)     # column-major MAT4
        a = g.animations[0]
        self.assertAlmostEqual(a.duration, 1.0)
        s = a.sample(0.5)
        np.testing.assert_allclose(s[2]["rotation"], [math.sin(math.pi / 8), 0, 0, math.cos(math.pi / 8)], atol=1e-6)
        np.testing.assert_allclose(s[1]["translation"], [0, 0, 0.25], atol=1e-6)  # hermite, zero tangents
        np.testing.assert_allclose(a.sample(0.25)[1]["translation"][2], 0.5 * (3 * 0.25 ** 2 - 2 * 0.25 ** 3),
                                   atol=1e-6)
        G = g.world_matrices(a, 1.0)
        np.testing.assert_allclose(G[2][:3, 3], [0, 0.5, 0.5], atol=1e-6)
        self.assertEqual(g.texture_image(0).size, (8, 8))
        with self.assertRaises(gltf.GltfError):
            gltf.loads(self.data[:40])

    def test_import(self):
        imp = official.Importer(None, gl=self.g, height=40, verbose=False, min_size=8, max_size=64)
        self.assertEqual(imp.bone_names, ["Base", "Top"])
        np.testing.assert_allclose(imp.heads[1], [0, 0, 20], atol=1e-6)        # glTF +Y up -> +Z, 40 units
        seq = imp.sequence("bend", "bend", fps=10)
        rest = imp.rest_sequence()
        st = imp.studio("t/column.mdl", [rest, seq], attachments=[("top", "Top", (0, 0, 40))])
        data = mdl.write(st)
        pm = mdl.read(data)
        self.assertTrue(pm.flags & mdl.STUDIO_HAS_BONEWEIGHTS)
        m = pm.bodyparts[0].models[0]
        tot = np.where(m.vert_weights.bones >= 0, m.vert_weights.weights, 0).sum(1)
        self.assertTrue((tot == 255).all())
        self.assertTrue(pm.textures[0].flags & mdl.STUDIO_NF_MASKED)
        self.assertTrue((pm.textures[0].pixels == 255).any())
        v0, _ = mdl.posed_model(pm, m, mdl.pose(pm, 0, 0.0))
        self.assertAlmostEqual(float(v0[:, 2].max()), 40.0, places=3)
        self.assertAlmostEqual(float(v0[:, 2].min()), 0.0, places=3)
        # last frame of the bend: the top of the column folded 90 deg toward +Z(glTF) = +X (forward)
        bm = mdl.pose(pm, 1, float(pm.sequences[1]["numframes"] - 1) - 1e-3)
        v1, _ = mdl.posed_model(pm, m, bm)
        top = m.verts[:, 2] > 39
        # truth from the glTF itself (root moved +0.5 m along glTF z = +20 units along x at t = 1)
        G = self.g.world_matrices(self.g.animations[0], 1.0)
        S = [imp.C @ G[n] @ np.linalg.inv(imp.rest_world_full[n]) for n in imp.bone_nodes]
        bw = m.vert_weights
        exp = np.zeros_like(m.verts)
        for k in range(4):
            for i in range(len(m.verts)):
                if bw.bones[i, k] >= 0:
                    Mx = S[bw.bones[i, k]]
                    exp[i] += bw.weights[i, k] / 255.0 * (Mx[:3, :3] @ m.verts[i] + Mx[:3, 3])
        np.testing.assert_allclose(v1, exp, atol=0.05)
        self.assertGreater(float(v1[top][:, 0].mean()), 35.0)
        # attachment on the top joint, bounding boxes cover the bend
        self.assertEqual(pm.attachments[0].bone, 1)
        self.assertGreater(pm.sequences[1]["bbmax"][0], 35.0)
        # skin variant: a recoloured copy of the material's texture in skin family 1
        inv = lambda img: np.concatenate([255 - img[..., :3], img[..., 3:]], -1)
        pm2 = mdl.read(mdl.write(imp.studio("t/column.mdl", [rest], skin_variants=[{"skin": inv}])))
        self.assertEqual(pm2.skins.tolist(), [[0], [1]])
        a0, a1 = pm2.textures[0], pm2.textures[1]
        opaque = a0.pixels != 255
        c0 = a0.palette[a0.pixels[opaque]].astype(int)
        c1 = a1.palette[a1.pixels[opaque]].astype(int)
        self.assertLess(np.abs(c0 + c1 - 255).mean(), 3)
        self.assertEqual(mdl.write(imp.studio("t/column.mdl", [rest])), mdl.write(imp.studio("t/column.mdl", [rest])))

    def test_quantize_and_recolor(self):
        rng = np.random.default_rng(3)
        img = (rng.random((32, 32, 3)) * 255).astype(np.uint8)
        idx, pal = official.quantize_texture(img)
        err = np.abs(pal[idx].astype(int) - img.astype(int)).mean()
        self.assertLess(err, 20)
        grey = np.full((4, 4, 4), 255, np.uint8)
        grey[..., :3] = 80
        grey[0, 0, :3] = 40
        out = official.recolor(grey, [((80, 80, 80), (240, 140, 60))])
        np.testing.assert_allclose(out[1, 1, :3], (240, 140, 60), atol=2)
        self.assertTrue((out[0, 0, :3] < out[1, 1, :3]).all())   # darker shade stays darker


if __name__ == "__main__":
    unittest.main(verbosity=1)
