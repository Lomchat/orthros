"""Pikachu (Half Strike Poke Ball): models/pokemon/pikachu.mdl.

Two builds, the same contract (sequences idle, walk, run, attack, flinch, die, spawn, victory in that order with
their activities; facing +x, origin on the ground; attachments 0 and 1 in front of the mouth, where the
Thunderbolt starts; hitboxes on the main bones, group 0):

* official_model(): when `$POKEMON_OFFICIAL_DIR/plain/25.glb` exists (default directory
  /srv/orthros/data/installers/pokemon-official, git-ignored: the files and anything converted from them never go
  into the repository), Game Freak's model as official.Importer converts it (mesh, textures, smooth skinning,
  31-bone rig), 30 units tall in its battle stance.  attack is its official Thunderbolt ("Impactrueno"), retimed
  to the server's 1.1 s with the hit at 40 % and the leap at half height; the others are keyframed here on its
  real bones: idle (the official battle stance breathing, looking around, ear flicks), walk (a running trot on
  all fours, 125 u/s) and run (a half-bound dash, 300 u/s) whose planted paws do not slide, flinch, die (faints
  and falls on its right side, the last frame lies on the floor), spawn (out of the ball curled up, a hop, then
  "Pika!" with the cheeks sparking), victory (cheering hops, an arm raised).  Six additive spark ribbons on
  their own bones (children of the head) swing out of the cheeks when needed.  The face changes expression with
  the official atlas cells (eyes open / half / closed, mouth closed / open / wide, cheeks red / white while
  sparking): each state is a copy of the official decal with its own texture.  Hidden sparks and states are
  collapsed to zero-area lines by two extra bones each (Kit), never parked out of sight, so nothing crosses
  visible space between frames or shows through the translucent corpse; fx_check verifies it at fractional
  frames on every build.
* generated_model(): otherwise, our own Pikachu generated from scratch (below), so the repository builds without
  the sources.

The generated model: chubby yellow body, big head, long black-tipped ears, red cheeks, brown back stripes, a
lightning-bolt tail (round brown stem, flat yellow bolt), big shiny black eyes.  ~34 units tall to the ear tips.
Sequences: idle, walk (bouncy biped jog), run (all-fours half bound), attack (crouch, then a Thunderbolt
discharge at 40 %), flinch, die (falls on its side), spawn (curled ball -> pops up -> "Pika!" pose), victory
(hops with a spin and arms up).  Planted feet and paws do not slide; generated_model checks it, the die end
pose and the normals (see normal_report).  Electric effects: additive/fullbright bolts on their own bones,
hidden inside the opaque head / body at rest and swung out when needed (spark_l0..2, spark_r0..2 on the head,
bolt0..3 on the spine), moved under the floor once the body lies dead.
"""
import dataclasses
import math
import os

import numpy as np

from .. import builder, mdl, mesh as meshmod, official, rig as R, sdf, texture as T, xform

# --------------------------------------------------------------------------------------------
# palette
# --------------------------------------------------------------------------------------------
YELLOW = T.rgb("#f6cd2c")
YELLOW_LIGHT = T.rgb("#ffe46a")
YELLOW_RIM = T.rgb("#d9a520")
SHADOW = "#e08a34"
WARM = "#f4b048"
BROWN = T.rgb("#8c5524")
BROWN_DARK = T.rgb("#6e3f18")
BLACK = T.rgb("#1c1717")
CHEEK = T.rgb("#e5392b")
CHEEK_LIGHT = T.rgb("#ff6b55")
MOUTH = T.rgb("#6a1e20")
LINE = T.rgb("#3a1a14")
TONGUE = T.rgb("#ef7d86")
NOSE = T.rgb("#2a1c18")

# --------------------------------------------------------------------------------------------
# key positions (model space, rest pose)
# --------------------------------------------------------------------------------------------
HEAD_C = np.array([0.8, 0.0, 19.2])
EAR_LEN = 13.5


def _unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def _frame_from(z_axis, x_hint):
    """Rotation matrix whose columns are (x, y, z) with z = z_axis and x as close to x_hint as possible."""
    ez = _unit(z_axis)
    ex = np.asarray(x_hint, dtype=np.float64)
    ex = _unit(ex - ez * (ex @ ez))
    ey = np.cross(ez, ex)
    return np.stack([ex, ey, ez], axis=1)


JOINTS = {
    "shoulder": (1.0, 4.3, 12.4), "elbow": (1.9, 5.5, 9.6), "wrist": (4.5, 5.0, 8.4),
    "hip": (-0.4, 2.7, 6.4), "knee": (1.0, 3.0, 3.8), "ankle": (0.1, 3.05, 1.5),
}


def joint(name, sx):
    x, y, z = JOINTS[name]
    return np.array([x, y * sx, z])


def ear_axis(side):
    return _unit((-0.22, 0.50 * side, 0.84))


EAR_SINK = 1.6  # the leaf starts this far inside the head


def ear_base(side):
    """Where the ear leaves the head (its pivot)."""
    return HEAD_C + np.array([-1.1, 3.3 * side, 3.9])


def ear_tip(side):
    return ear_base(side) + ear_axis(side) * (EAR_LEN - EAR_SINK)


# --------------------------------------------------------------------------------------------
# custom shapes
# --------------------------------------------------------------------------------------------

def _poly2d(P, V):
    """Exact signed distance to a closed 2D polygon V (M, 2) for points P (N, 2); negative inside."""
    d = np.full(len(P), np.inf)
    s = np.ones(len(P))
    M = len(V)
    for i in range(M):
        a, b = V[i], V[i - 1]
        e = b - a
        w = P - a
        t = np.clip((w @ e) / (e @ e), 0.0, 1.0)
        q = w - np.outer(t, e)
        d = np.minimum(d, np.einsum("ij,ij->i", q, q))
        c1 = P[:, 1] >= a[1]
        c2 = P[:, 1] < b[1]
        c3 = e[0] * w[:, 1] > e[1] * w[:, 0]
        flip = (c1 & c2 & c3) | (~c1 & ~c2 & ~c3)
        s[flip] *= -1
    return s * np.sqrt(d)


def slab_polygon(V, half_t, round_r, y0=0.0):
    """Polygon V (x, z) extruded along y (|y - y0| <= half_t(p)), edges rounded by round_r.
    half_t: a number or a function of the points (thickness taper)."""
    V = np.asarray(V, dtype=np.float64)
    r = float(round_r)
    ht = half_t if callable(half_t) else (lambda p, _h=float(half_t): np.full(len(p), _h))

    def f(p):
        d2 = _poly2d(p[:, [0, 2]], V) + r
        dy = np.abs(p[:, 1] - y0) - (ht(p) - r)
        qx, qy = np.maximum(d2, 0), np.maximum(dy, 0)
        return np.sqrt(qx * qx + qy * qy) + np.minimum(np.maximum(d2, dy), 0) - r

    hmax = float(np.max(ht(np.c_[V[:, 0], np.zeros(len(V)), V[:, 1]])))
    lo = np.array([V[:, 0].min() - 0.2, y0 - hmax - 0.2, V[:, 1].min() - 0.2])
    hi = np.array([V[:, 0].max() + 0.2, y0 + hmax + 0.2, V[:, 1].max() + 0.2])
    return sdf.SDF(f, lo, hi)


def ribbon_outline(C, hw):
    """Zigzag ribbon polygon around the polyline C (n+1, 2) with half widths hw (n,) per segment
    (mitred joints)."""
    C = np.asarray(C, dtype=np.float64)
    n = len(C) - 1
    d = [_unit(C[i + 1] - C[i]) for i in range(n)]
    nrm = [np.array([-di[1], di[0]]) for di in d]

    def side(sign):
        pts = [C[0] + sign * nrm[0] * hw[0]]
        for k in range(1, n):
            p1, d1 = C[k] + sign * nrm[k - 1] * hw[k - 1], d[k - 1]
            p2, d2 = C[k] + sign * nrm[k] * hw[k], d[k]
            A = np.array([d1, -d2]).T
            try:
                ts = np.linalg.solve(A, p2 - p1)
                pts.append(p1 + d1 * ts[0])
            except np.linalg.LinAlgError:
                pts.append(p2)
        pts.append(C[n] + sign * nrm[n - 1] * hw[n - 1])
        return pts

    left, right = side(1.0), side(-1.0)
    return np.array(left + right[::-1])


# tail: zigzag centerline in the x-z plane (side view, Pikachu facing +x).  C0 -> C1 is the round
# brown stem (bones tail1, tail2); the flat bolt C1 -> C5 is rigid on tail3 (C1..C3, first zig) and
# tail4 (C3..C5, the flag), so it only bends at the C3 corner where its outline already turns.
TAIL_C = np.array([(-3.4, 6.4), (-8.4, 8.2), (-7.4, 11.6), (-12.0, 13.6), (-10.6, 16.2), (-15.8, 22.8)])
TAIL_HW = [1.0, 1.3, 1.55, 2.8]
TAIL_STEM = ((-3.0, 6.3), 1.0, 0.74)   # stem start (inside the rump), radius at the rump, at C1


def tail_polygon():
    C = TAIL_C[1:].copy()
    # the bolt starts a little before C1 (the stem's end is buried in it)
    C[0] = C[0] - _unit(C[1] - C[0]) * 0.5
    V = ribbon_outline(C, TAIL_HW)
    # slanted top of the flag: its back corner points up, its front corner is cut lower
    n = len(C) - 1
    d = _unit(C[-1] - C[-2])
    V[n] = V[n] + d * 1.6           # left (back/upper) outline end
    V[n + 1] = V[n + 1] - d * 1.2   # right (front) outline end
    return V


def tail_half_t(p):
    """Bolt thickness: 0.8 at the stem, 0.5 at the flag."""
    s = np.clip((p[:, 2] - 8.2) / (17.0 - 8.2), 0.0, 1.0)
    return 0.8 - 0.3 * s


def tail_shapes():
    a, ra, rb = TAIL_STEM
    stem = sdf.rounded_cone((a[0], 0, a[1]), (TAIL_C[1][0], 0, TAIL_C[1][1]), ra, rb)
    bolt = slab_polygon(tail_polygon(), tail_half_t, 0.45)
    return stem, bolt


EAR_FLAT = (0.38, 1.0, 1.0)   # the round lance flattened front to back


def ear_leaf():
    """The ear before flattening: a round lance along local +z (widest at ~40 %)."""
    return sdf.union(sdf.rounded_cone((0, 0, 0), (0, 0, 0.4 * EAR_LEN), 1.25, 1.65),
                     sdf.rounded_cone((0, 0, 0.4 * EAR_LEN), (0, 0, EAR_LEN), 1.65, 0.16), k=1.0)


def ear_frame(sx):
    """Rotation and origin of the ear's local frame (flat side facing forward)."""
    return _frame_from(ear_axis(sx), (1.0, -0.25 * sx, 0.0)), ear_base(sx) - ear_axis(sx) * EAR_SINK


def ear_mesh(sx, budget):
    """The ear meshed round in its own frame, then flattened and placed: meshing the thin flat lance
    directly (its axis-aligned bounds are not thin, so the voxels are too coarse for its 1.2-unit
    thickness) folded a few triangles inside out near the tip."""
    m = meshmod.mesh_sdf(ear_leaf(), budget=budget)
    Rm, base = ear_frame(sx)
    return meshmod.TriMesh((m.verts * np.asarray(EAR_FLAT)) @ Rm.T + base, m.faces.copy())


def shapes():
    s = {}
    # body: pear shape
    body = sdf.ellipsoid((-0.4, 0, 9.0), (4.9, 5.3, 6.2))
    belly = sdf.ellipsoid((0.0, 0, 7.0), (5.3, 5.9, 4.7))
    chest = sdf.ellipsoid((0.2, 0, 12.6), (3.8, 4.3, 3.0))
    s["body"] = sdf.union(body, belly, chest, k=2.0)

    head = sdf.ellipsoid(HEAD_C, (5.7, 6.5, 5.7))
    jowl = sdf.ellipsoid(HEAD_C + (0.6, 0, -1.6), (5.0, 6.9, 4.2))
    muzzle = sdf.ellipsoid(HEAD_C + (4.7, 0, -1.4), (1.9, 2.7, 1.7))
    s["head"] = sdf.union(head, jowl, k=2.0).smooth_union(muzzle, 1.4)

    for side, sx in (("l", 1), ("r", -1)):
        Rm, base = ear_frame(sx)
        s[f"ear_{side}"] = ear_leaf().stretch(EAR_FLAT).transform(Rm).translate(base)

        hip, knee, ankle = joint("hip", sx), joint("knee", sx), joint("ankle", sx)
        s[f"thigh_{side}"] = sdf.rounded_cone(hip, knee, 2.5, 1.7)
        s[f"shin_{side}"] = sdf.rounded_cone(knee, ankle, 1.65, 1.3)
        foot = sdf.ellipsoid((0, 0, 0), (2.6, 1.5, 1.05)).rotate(z=8 * sx).translate((1.5, 3.2 * sx, 1.2))
        heel = sdf.sphere(ankle + (-0.1, 0, -0.25), 1.15)
        s[f"foot_{side}"] = foot.smooth_union(heel, 0.9)

        sh, el, wr = joint("shoulder", sx), joint("elbow", sx), joint("wrist", sx)
        s[f"arm_{side}"] = sdf.rounded_cone(sh, el, 1.45, 1.15)
        s[f"forearm_{side}"] = sdf.rounded_cone(el, wr, 1.15, 1.0)
        hand = sdf.ellipsoid((0, 0, 0), (1.35, 1.05, 1.15)).rotate(z=-15 * sx).translate(wr + (0.9, -0.25 * sx, -0.2))
        s[f"hand_{side}"] = hand

    stem, bolt = tail_shapes()
    s["tail_stem"], s["tail_bolt"] = stem, bolt
    s["tail"] = stem.smooth_union(bolt, 0.5)
    return s


# --------------------------------------------------------------------------------------------
# rig
# --------------------------------------------------------------------------------------------

TAIL2_HEAD = (np.array(TAIL_C[0]) + np.array(TAIL_C[1])) * 0.5


def make_rig(cheeks, bolts):
    rig = R.Rig()
    rig.add("root", None, (0, 0, 0))
    rig.add("pelvis", "root", (0, 0, 6.4), tail=(0, 0, 10.0))
    rig.add("spine", "pelvis", (0, 0, 10.0), tail=(0.2, 0, 14.6))
    rig.add("head", "spine", (0.6, 0, 14.6), tail=HEAD_C + (1.0, 0, 3.0))
    for side, sx in (("l", 1), ("r", -1)):
        b, tip = ear_base(sx), ear_tip(sx)
        rig.add(f"ear_{side}", "head", b)
        rig.add(f"ear2_{side}", f"ear_{side}", b + (tip - b) * 0.5, tail=tip)
    for side, (cp, cn) in zip(("l", "r"), cheeks):
        for i in range(SPARK_N):
            base, d = spark_rest(cp, cn)
            rig.add(f"spark_{side}{i}", "head", base, tail=base + d * SPARK_LEN)
    for i, (base, d, _) in enumerate(bolts):
        rig.add(f"bolt{i}", "spine", base, tail=base + d * BOLT_LEN)
    for side, sx in (("l", 1), ("r", -1)):
        rig.add(f"arm_{side}", "spine", joint("shoulder", sx))
        rig.add(f"forearm_{side}", f"arm_{side}", joint("elbow", sx))
        rig.add(f"hand_{side}", f"forearm_{side}", joint("wrist", sx), tail=joint("wrist", sx) + (1.7, -0.4 * sx, -0.3))
    for side, sx in (("l", 1), ("r", -1)):
        rig.add(f"thigh_{side}", "pelvis", joint("hip", sx))
        rig.add(f"shin_{side}", f"thigh_{side}", joint("knee", sx))
        rig.add(f"foot_{side}", f"shin_{side}", joint("ankle", sx), tail=(3.6, 3.4 * sx, 1.0))
    c = TAIL_C
    rig.add("tail1", "pelvis", (c[0][0], 0, c[0][1]))
    rig.add("tail2", "tail1", (TAIL2_HEAD[0], 0, TAIL2_HEAD[1]))
    rig.add("tail3", "tail2", (c[1][0], 0, c[1][1]))
    rig.add("tail4", "tail3", (c[3][0], 0, c[3][1]), tail=(c[5][0], 0, c[5][1]))
    return rig


def tail_vbones(rig, verts, stem, bolt):
    """Bone per tail vertex: stem -> tail1 / tail2 (split at its middle), bolt -> tail3 (C1..C3) /
    tail4 (C3..C5, split on the C3 corner's bisector)."""
    q = verts[:, [0, 2]]
    on_stem = stem(verts) < bolt(verts)
    a, b = np.array(TAIL_STEM[0]), TAIL_C[1]
    e = b - a
    m = TAIL2_HEAD
    stem_bone = np.where((q - a) @ e < (m - a) @ e, rig.index("tail1"), rig.index("tail2"))
    # bisector of the corner at C3
    d_in, d_out = _unit(TAIL_C[3] - TAIL_C[2]), _unit(TAIL_C[4] - TAIL_C[3])
    nb = _unit(d_in + d_out)
    upper = (q - TAIL_C[3]) @ nb > 0
    bolt_bone = np.where(upper, rig.index("tail4"), rig.index("tail3"))
    return np.where(on_stem, stem_bone, bolt_bone)


# --------------------------------------------------------------------------------------------
# electric bolts (cheek sparks, aura)
# --------------------------------------------------------------------------------------------

def _ray_hit(shape, origin, direction, t_max=20.0):
    o = np.asarray(origin, dtype=np.float64)
    d = _unit(direction)
    lo, hi = 0.0, t_max
    for _ in range(60):
        m = 0.5 * (lo + hi)
        if shape(o + d * m) < 0:
            lo = m
        else:
            hi = m
    p = o + d * lo
    return p, _unit(shape.normal(p[None])[0])


def cheek_points(head):
    """(surface point, outward normal) of the left and right cheek centres (well inside the front
    silhouette: the whole disc reads from the front)."""
    return [_ray_hit(head, HEAD_C + (0, 0, -0.2), (0.78, 0.66 * sx, -0.36)) for sx in (1, -1)]


SPARK_N = 3
SPARK_LEN = 10.5
SPARK_SINK = 0.9
BOLT_LEN = 8.5
BOLT_SINK = 1.0
# aura bolts: ray directions from the body centre (shoulders / lower back, both sides)
BOLT_DIRS = [(-0.45, 0.55, 0.7), (-0.45, -0.55, 0.7), (-0.85, 0.5, -0.05), (-0.85, -0.5, -0.05)]
BOLT_CENTER = np.array([-0.4, 0.0, 9.6])


def spark_rest(cp, cn):
    """Rest base and direction of a cheek spark: from just under the cheek toward the head's centre
    (hidden inside it)."""
    base = cp - cn * SPARK_SINK
    return base, _unit(HEAD_C + (0.4, 0, -0.8) - base)


def body_bolts(body):
    out = []
    for d in BOLT_DIRS:
        p, n = _ray_hit(body, BOLT_CENTER, d)
        base = p - n * BOLT_SINK
        out.append((base, _unit(BOLT_CENTER - base), n))
    return out


def bolt_mesh(base, direction, length, seed, w0=0.62, w1=0.3, zig=1.2, segs=4):
    """One jagged bolt from `base` along `direction` (two crossed two-sided ribbons) and its centre
    polyline / half widths (for the paint)."""
    rng = np.random.default_rng(seed)
    n = _unit(direction)
    e1 = _unit(np.cross(n, (0.0, 0.0, 1.0)) if abs(n[2]) < 0.9 else np.cross(n, (1.0, 0.0, 0.0)))
    e2 = np.cross(n, e1)
    verts, faces = [], []

    def ribbon(pts, widths, side):
        base_i = len(verts)
        for i, (q, w) in enumerate(zip(pts, widths)):
            d = _unit(pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)])
            o = _unit(np.cross(d, side)) * w
            verts.extend([q + o, q - o])
        k = len(pts)
        for i in range(k - 1):
            a, b, c, d = base_i + 2 * i, base_i + 2 * i + 1, base_i + 2 * i + 2, base_i + 2 * i + 3
            faces.extend([(a, b, d), (a, d, c)])
        base2 = len(verts)  # back side: same positions, own vertices, reversed winding
        verts.extend(verts[base_i:base2])
        for i in range(k - 1):
            a, b, c, d = base2 + 2 * i, base2 + 2 * i + 1, base2 + 2 * i + 2, base2 + 2 * i + 3
            faces.extend([(a, d, b), (a, c, d)])

    lat_a = rng.uniform(0, 2 * math.pi)
    lat = math.cos(lat_a) * e1 + math.sin(lat_a) * e2
    pts = []
    for i, r in enumerate(np.linspace(0.0, length, segs + 1)):
        zig_i = 0.0 if i == 0 else (zig if i % 2 else -zig) * (1.0 - 0.3 * i / segs) + rng.uniform(-0.15, 0.15)
        pts.append(np.asarray(base) + n * r + lat * zig_i)
    pts = np.array(pts)
    widths = np.linspace(w0, w1, len(pts))
    ribbon(pts, widths, lat)
    ribbon(pts, widths, np.cross(n, lat))
    return meshmod.TriMesh(np.array(verts), np.array(faces)), (pts, widths)


# --------------------------------------------------------------------------------------------
# paint
# --------------------------------------------------------------------------------------------

def projected(shape, fn):
    """Paint on the exact surface: texel positions (on the low-poly chords) are projected onto the
    part's SDF and the normals taken from it, so the baked shading does not show the tessellation."""
    def paint(P, N, skin):
        P = np.asarray(P, dtype=np.float64)
        for _ in range(2):
            P = P - shape(P)[:, None] * shape.normal(P)
        return fn(P, shape.normal(P), skin)
    return paint


def make_paints(S, bolt_lines):
    head = S["head"]
    # occlusion baked per region from the shapes that stay put relative to it (moving limbs would
    # otherwise leave dark prints on the body when they move away)
    legs = [S[f"{n}_{s}"] for n in ("thigh", "shin", "foot") for s in ("l", "r")]
    occ_head = head
    occ_body = sdf.union(S["body"], *legs[:2], k=0.5)
    occ_legs = sdf.union(S["body"], *legs, k=0.3)
    occ_tail = sdf.union(S["body"], S["tail"], k=0.3)
    legs_shape = sdf.union(*legs)

    eyes = []
    for sx in (1, -1):
        p, n = _ray_hit(head, HEAD_C, (0.80, 0.42 * sx, 0.30))
        eyes.append((p, n, sx))
    cheeks = cheek_points(head)
    nose_p, _ = _ray_hit(head, HEAD_C + (0, 0, -0.6), (1.0, 0, 0.12))
    mouth_p, _ = _ray_hit(head, HEAD_C + (0, 0, -1.9), (1.0, 0, -0.05))
    stem_a = np.array([TAIL_STEM[0][0], 0, TAIL_STEM[0][1]])
    stem_b = np.array([TAIL_C[1][0], 0, TAIL_C[1][1]])
    tail_root, _ = _ray_hit(S["body"], stem_a, stem_b - stem_a)

    def finish(c, P, N, occ, ao_dist=2.5, top=0.14, strength=0.55, tint=SHADOW):
        ao = T.ambient_occlusion(occ, P, N, dist=ao_dist)
        return T.shade(c, N, ao=ao, ao_strength=strength, top=top, shadow_tint=tint)

    def yellow(P, N):
        # gentle warm gradient: lighter on top
        return T.gradient(P, (0, 0, 1), 2.0, 26.0, YELLOW * 0.97, YELLOW_LIGHT * 0.98 + YELLOW * 0.02)

    def paint_head(P, N, skin):
        c = yellow(P, N)
        # cheeks: round red discs, a lighter spot up-front
        for cp, cn in cheeks:
            m = T.spot(P, cp, 2.1, soft=0.16) * (N @ cn > 0.2)
            cc = T.mix(CHEEK, CHEEK_LIGHT, T.spot(P, cp + cn * 0.2 + (0.25, 0, 0.6), 0.9, soft=0.8) * 0.45)
            c = T.mix(c, cc, m)
        # nose
        c = T.mix(c, NOSE, T.ellipse(P, nose_p, (0.5, 0.48, 0.32), soft=0.1))
        # mouth (front view coordinates y, z around mouth_p): a smooth "w" line and a small open smile
        front = T.edge(HEAD_C[0] + 3.4 - P[:, 0], 0.2)
        y, z = P[:, 1] - mouth_p[1], P[:, 2] - mouth_p[2]
        w_line = np.full(len(P), np.inf)
        for sy in (1, -1):
            cy, cz, r = 0.5 * sy, 0.32, 0.5
            dc = np.abs(np.hypot(y - cy, z - cz) - r)
            w_line = np.minimum(w_line, np.where(z < cz, dc, np.hypot(np.abs(y - cy) - r, z - cz)))
        line_m = T.edge(w_line - 0.09, 0.05) * front
        my, mz, ry, rz = 0.0, -0.12, 0.56, 0.5
        k = np.hypot(y / ry, (z - mz) / rz)
        mouth_m = T.edge((k - 1.0) * rz, 0.06) * T.edge(z - mz, 0.05) * front
        tongue_m = T.edge((np.hypot(y / 0.36, (z - mz + 0.42) / 0.2) - 1.0) * 0.2, 0.06)
        c = T.mix(c, T.mix(MOUTH, TONGUE, tongue_m), mouth_m)
        c = T.mix(c, LINE, line_m)
        out = finish(c, P, N, occ_head, top=0.1, tint=WARM)
        # eyes painted over the shading: glossy black with a big highlight (same light side on both)
        for p, n, sx in eyes:
            col, m = T.eye(P, p, n, (1.3, 1.55), highlight_pos=(0.12, 0.42), highlight_radius=0.36,
                           pupil="#141010", outline=None, soft=0.07)
            out = T.mix(out, col, m)
        return out

    def paint_ear(sx):
        a, base = ear_axis(sx), ear_base(sx)
        occ_ear = sdf.union(head, S['ear_l' if sx > 0 else 'ear_r'], k=0.3)

        def paint(P, N, skin):
            c = yellow(P, N)
            along = (P - base) @ a
            # tip boundary slightly slanted
            slant = (P - base) @ _unit(np.cross(a, (1, 0, 0))) * 0.18 * sx
            c = T.mix(c, BLACK, T.edge(EAR_LEN * 0.6 - along + slant, 0.25))
            return finish(c, P, N, occ_ear, ao_dist=1.0, strength=0.25, top=0.1, tint=WARM)
        return paint

    def paint_body(P, N, skin):
        c = yellow(P, N)
        # two brown stripes across the back
        phi = np.arctan2(P[:, 1], -(P[:, 0] + 0.4))  # 0 at the middle of the back
        back = np.clip(1.0 - (phi / 1.0) ** 2, 0.0, 1.0)
        for zc, hw in ((11.6, 0.75), (9.1, 0.7)):
            zz = zc - 0.55 * phi ** 2
            d = np.abs(P[:, 2] - zz) - hw * np.sqrt(back)
            m = T.edge(d, 0.22) * (back > 0) * (P[:, 0] < 0.5)
            c = T.mix(c, BROWN, m)
        # brown root of the tail, continuous with the stem
        c = T.mix(c, BROWN, T.spot(P, tail_root, 1.55, soft=0.35))
        return finish(c, P, N, occ_body)

    def paint_tail(P, N, skin):
        c = yellow(P, N)
        # round stem brown (into the first zig a little), the bolt yellow with a darker rim
        q = P[:, [0, 2]]
        a, b = np.array(TAIL_STEM[0]), TAIL_C[1]
        e = b - a
        t = (q - a) @ e / (e @ e)
        brown = T.edge(t - 1.12, 0.05) * (np.linalg.norm(q - (a + np.outer(np.clip(t, 0, 1), e)), axis=1) < 2.2)
        c = T.mix(c, BROWN, brown)
        # darker rounded edges (from the exact normals: a smooth band, no stair steps)
        rim = np.clip((0.9 - np.abs(N[:, 1])) / 0.5, 0.0, 1.0) * (1.0 - brown)
        c = T.mix(c, YELLOW_RIM, rim * 0.75)
        return finish(c, P, N, occ_tail, ao_dist=1.2, top=0.08, strength=0.35, tint=WARM)

    lines = bolt_lines  # [(pts (k, 3), half widths (k,)), ...] at rest

    def paint_spark(P, N, skin):
        # white core, yellow halo, dim orange edge (additive: dark = transparent), dimmer at the tip
        best = np.full(len(P), np.inf)
        frac = np.zeros(len(P))
        for pts, hw in lines:
            for i in range(len(pts) - 1):
                a, b = pts[i], pts[i + 1]
                e = b - a
                t = np.clip((P - a) @ e / (e @ e), 0.0, 1.0)
                d = np.linalg.norm(P - (a + np.outer(t, e)), axis=1)
                w = hw[i] + (hw[i + 1] - hw[i]) * t
                r = d / w
                along = (i + t) / (len(pts) - 1)
                sel = r < best
                best[sel] = r[sel]
                frac[sel] = along[sel]
        r = np.clip(best, 0.0, 1.2)
        core = T.rgb("#ffffff")
        halo = T.rgb("#ffe23a")
        edge_c = T.rgb("#b86a00")
        col = T.mix(core, halo, T.edge(0.32 - r, 0.12))
        col = T.mix(col, edge_c, T.edge(0.78 - r, 0.14))
        col = col * (1.0 - 0.35 * frac)[:, None] * (1.0 - 0.6 * np.clip(r - 0.8, 0, 1))[:, None]
        return np.clip(col, 0, 1)

    def paint_legs(P, N, skin):
        return finish(yellow(P, N), P, N, occ_legs, ao_dist=1.0, strength=0.25, top=0.1, tint=WARM)

    def paint_arm(side):
        occ = sdf.union(S[f"arm_{side}"], S[f"forearm_{side}"], S[f"hand_{side}"], k=0.3)

        def paint(P, N, skin):
            return finish(yellow(P, N), P, N, occ, ao_dist=1.0, strength=0.25, top=0.1, tint=WARM)
        return paint

    arm_shape = {s: sdf.union(S[f"arm_{s}"], S[f"forearm_{s}"], S[f"hand_{s}"]) for s in ("l", "r")}
    return {"head": projected(head, paint_head),
            "ear_l": projected(S["ear_l"], paint_ear(1)), "ear_r": projected(S["ear_r"], paint_ear(-1)),
            "body": projected(S["body"], paint_body), "tail": projected(S["tail"], paint_tail),
            "legs": projected(legs_shape, paint_legs), "spark": paint_spark,
            "arm_l": projected(arm_shape["l"], paint_arm("l")), "arm_r": projected(arm_shape["r"], paint_arm("r"))}


# --------------------------------------------------------------------------------------------
# animation helpers
# --------------------------------------------------------------------------------------------

LEGS = [("thigh_l", "shin_l", "foot_l"), ("thigh_r", "shin_r", "foot_r")]
ARMS = [("arm_l", "forearm_l", "hand_l"), ("arm_r", "forearm_r", "hand_r")]
FX_BONES = tuple(f"spark_{s}{i}" for s in "lr" for i in range(SPARK_N)) + tuple(f"bolt{i}" for i in range(4))


class Anim:
    """Pose helpers bound to the rig and the meshed parts (posed-vertex ground contact)."""

    def __init__(self, rig, parts):
        self.rig = rig
        self.parts = parts
        self.verts = np.concatenate([p.tri.verts for p in parts])
        self.vbone = np.concatenate([p.vbone for p in parts])
        self.byname = {p.name: p for p in parts}
        # foot contact pivot (ball of the foot) and palm contact point, rest model space
        # ball of the foot: its lowest point when the heel is lifted 35 degrees
        self.ball, self.foot_v = {}, {}
        for (u, l, e) in LEGS:
            v = self.byname[e].tri.verts
            q = (v - rig.head(e)) @ xform.rot_deg(0, 35, 0).T
            self.ball[e] = v[np.argmin(q[:, 2])].copy()
            self.foot_v[e] = v
        self.palm = {}
        for (u, l, e) in ARMS:
            v = self.byname[e].tri.verts
            self.palm[e] = np.array([v[:, 0].mean(), v[:, 1].mean(), v[:, 2].min()])
        self.leg_len = {}
        for chain in LEGS + ARMS:
            u, l, e = chain
            self.leg_len[chain] = (np.linalg.norm(rig.head(l) - rig.head(u)) +
                                   np.linalg.norm(rig.head(e) - rig.head(l)))

    def posed(self, pose, mask=None):
        M = self.rig.skin_matrices(pose)
        v, b = self.verts, self.vbone
        if mask is not None:
            v, b = v[mask], b[mask]
        return np.einsum("nij,nj->ni", M[b][:, :, :3], v) + M[b][:, :, 3]

    def mask(self, bones):
        ids = [self.rig.index(n) for n in bones]
        return np.isin(self.vbone, ids)

    def min_z(self, pose, bones=None):
        return float(self.posed(pose, None if bones is None else self.mask(bones))[:, 2].min())

    CORE = ("pelvis", "spine", "head", "tail1", "tail2", "tail3", "tail4", "ear_l", "ear2_l", "ear_r", "ear2_r")
    TORSO = ("pelvis", "spine", "head")

    def keep_above(self, pose, margin=0.25, bones=CORE):
        """Raise the root so that the body (not the IK-driven limbs) stays above the ground."""
        mz = self.min_z(pose, bones)
        if mz < margin:
            pose.move("root", z=margin - mz)
        return pose

    def plant_feet(self, pose, offsets=((0, 0, 0), (0, 0, 0)), pitch=(0.0, 0.0)):
        """IK both legs to their rest foot positions + offsets (model space), feet flat (or pitched)."""
        for (u, l, e), off, pt in zip(LEGS, offsets, pitch):
            target = self.rig.head(e) + np.asarray(off, dtype=np.float64)
            self.rig.solve_two_bone(pose, u, l, e, target, pole=(1, 0, 0), end_world_rot=xform.rot_deg(0, pt, 0))
        return pose

    def foot_contact(self, e, pitch):
        """Height of the pivot above the foot's lowest point when pitched (rest units)."""
        Rm = xform.rot_deg(0, pitch, 0)
        q = (self.foot_v[e] - self.ball[e]) @ Rm.T
        return -float(q[:, 2].min())

    def pivot_foot(self, pose, chain, pivot, pitch, reach=0.97, max_pitch=60.0):
        """IK a leg so that the foot's ball (rest point self.ball) is at x/y = pivot and the foot's lowest
        point at the rest sole height + pivot z, the foot pitched nose-down by `pitch` degrees about the
        ball; if the leg cannot reach, the heel lifts more (the foot rolls on its ball, which stays put)."""
        u, l, e = chain
        W = self.rig.world(pose)
        hip = W[self.rig.index(u)][:, 3]
        A_r, B_r = self.rig.head(e), self.ball[e]
        L = self.leg_len[chain] * reach
        sole = self.foot_v[e][:, 2].min()

        def ankle(pt):
            b = np.array([pivot[0], pivot[1], sole + pivot[2] + self.foot_contact(e, pt)])
            return b + xform.rot_deg(0, pt, 0) @ (A_r - B_r)

        pt = float(min(pitch, max_pitch))
        if np.linalg.norm(ankle(pt) - hip) > L:
            lo, hi = pt, max_pitch
            if np.linalg.norm(ankle(hi) - hip) <= L:
                for _ in range(30):
                    m = 0.5 * (lo + hi)
                    if np.linalg.norm(ankle(m) - hip) > L:
                        lo = m
                    else:
                        hi = m
                pt = hi
            else:
                pt = max_pitch
        self.rig.solve_two_bone(pose, u, l, e, ankle(pt), pole=(1, 0, 0), end_world_rot=xform.rot_deg(0, pt, 0))
        return pt

    def pivot_hand(self, pose, chain, contact, hand_rot, pole=(-1, 0, 0.2)):
        """IK an arm so that the palm's lowest rest point is at `contact`, the hand turned by hand_rot."""
        u, l, e = chain
        W_r, P_r = self.rig.head(e), self.palm[e]
        target = np.asarray(contact) + hand_rot @ (W_r - P_r)
        self.rig.solve_two_bone(pose, u, l, e, target, pole=pole, end_world_rot=hand_rot)

    def reach_hands(self, pose, targets, pole=(-1, 0, -0.3), hand_rot=None, ground=True):
        """IK both arms; with ground=True a hand that would go through the ground is lifted onto it."""
        for i, ((u, l, e), tg) in enumerate(zip(ARMS, targets)):
            if tg is None:
                continue
            tg = np.asarray(tg, dtype=np.float64).copy()
            for _ in range(3):
                self.rig.solve_two_bone(pose, u, l, e, tg, pole=pole,
                                        end_world_rot=None if hand_rot is None else hand_rot[i])
                if not ground:
                    break
                mz = self.min_z(pose, (e,))
                if mz >= -0.02:
                    break
                tg[2] -= mz
        return pose

    def world_to_local_offset(self, pose, bone, world_vec):
        """A model-space displacement expressed in `bone`'s parent frame (for Pose.move)."""
        W = self.rig.world(pose)
        parent = self.rig.bones[self.rig.index(bone)].parent
        Rp = W[parent][:, :3]
        return Rp.T @ np.asarray(world_vec, dtype=np.float64)


def ears(p, x=0.0, y=0.0, z=0.0, tip=(0.0, 0.0, 0.0), l=None, r=None):
    """Ear motion mirrored on both sides: x > 0 leans them in (toward the middle), x < 0 spreads them,
    y > 0 tips them forward, y < 0 lays them back, z turns them (front face outward for z > 0);
    tip: bend of the upper half; l / r: extra per-side (x, y, z) rotations (unmirrored)."""
    for side, sx, extra in (("l", 1, l), ("r", -1, r)):
        ex = (0.0, 0.0, 0.0) if extra is None else extra
        p.rot(f"ear_{side}", x=sx * x + ex[0], y=y + ex[1], z=sx * z + ex[2])
        p.rot(f"ear2_{side}", x=sx * tip[0], y=tip[1], z=sx * tip[2])
    return p


def tail(p, angles):
    """angles: list of (x, y, z) per tail bone (tail1, tail2 = stem; tail3, tail4 = bolt);
    y > 0 raises the tail (toward the back of the head), z = side-to-side wag."""
    for i, a in enumerate(angles):
        p.rot(f"tail{i + 1}", x=a[0], y=a[1], z=a[2])
    return p


def arms(p, l=(0, 0, 0), r=None, fl=(0, 0, 0), fr=None):
    """Arm rotations (x, y, z) mirrored for the right side when r is None (x and z flipped)."""
    if r is None:
        r = (-l[0], l[1], -l[2])
    if fr is None:
        fr = (-fl[0], fl[1], -fl[2])
    p.rot("arm_l", *l)
    p.rot("arm_r", *r)
    p.rot("forearm_l", *fl)
    p.rot("forearm_r", *fr)
    return p


def gait_track(u, duty, lm, x_front, lift, pitch_stance, pitch_swing):
    """Pivot path of one foot/paw for gait phase u in [0, 1): stance (u < duty) moves the contact
    point back by exactly lm * u (model space; the body moves forward at lm per cycle, so in the
    world it stays put); swing brings it forward again on an arc.  Returns (dx, dz, pitch)."""
    x_back = x_front - lm * duty
    if u < duty:
        s = u / duty
        return x_front - lm * u, 0.0, pitch_stance(s)
    s = (u - duty) / (1.0 - duty)
    e = R.smoothstep(R.smoothstep(s) * 0.7 + s * 0.3)
    return x_back + (x_front - x_back) * e, lift * math.sin(math.pi * s) ** 0.5, pitch_swing(s)


def make_sequences(rig, A):
    seqs = []
    checks = {}
    W = R.wave

    def frame_sign(t, frames):
        """+1 / -1 alternating per frame (a buzz the engine interpolates)."""
        return 1.0 if int(round(t * (frames - 1))) % 2 == 0 else -1.0

    def fan(p, bone, rest_dir, out_dir, spread, az):
        """Point an effect bone (rest direction rest_dir, parent frame) toward out_dir, tilted by
        `spread` degrees around it at azimuth az."""
        n = _unit(out_dir)
        e1 = _unit(np.cross(n, (0.0, 0.0, 1.0)) if abs(n[2]) < 0.9 else np.cross(n, (1.0, 0.0, 0.0)))
        e2 = np.cross(n, e1)
        tilt = math.radians(spread)
        d = math.cos(tilt) * n + math.sin(tilt) * (math.cos(az) * e1 + math.sin(az) * e2)
        p.set_rot(bone, *np.degrees(xform.matrix_euler(R._align(rest_dir, d))))

    def sparks(p, vis, t, frames, forward=0.0):
        """Cheek sparks swung out of the cheeks when vis >= 0.5, in a fan that changes every frame;
        forward > 0 aims them more toward the front (the target)."""
        if vis < 0.5:
            return p
        i = int(round(t * (frames - 1)))
        for k, (side, (cp, cn)) in enumerate(zip(("l", "r"), A.cheeks)):
            _, rest = spark_rest(cp, cn)
            out = _unit(cn + np.array([forward, 0.0, 0.15]))
            for j in range(SPARK_N):
                az = math.radians(120 * j + 77 * i + 50 * k)
                fan(p, f"spark_{side}{j}", rest, out, 38 + 14 * ((i + j) % 3 - 1), az)
        return p

    def aura(p, vis, t, frames):
        """Aura bolts out of the back and shoulders (Thunderbolt release)."""
        if vis < 0.5:
            return p
        i = int(round(t * (frames - 1)))
        for j, (base, rest, n) in enumerate(A.bolts):
            out = _unit(n + np.array([0.0, 0.0, 0.9]))
            fan(p, f"bolt{j}", rest, out, 24 + 12 * ((i + j) % 3 - 1), math.radians(97 * j + 131 * i))
        return p

    def bury_fx(p):
        """Move every effect bolt well under the floor (the corpse fades out translucent)."""
        for b in FX_BONES:
            off = A.world_to_local_offset(p, b, (0.0, 0.0, -40.0))
            p.move(b, *off)
        return p

    def stand(p, w=1.0):
        """The resting posture every standing sequence starts and ends in: hands in front of the chest."""
        arms(p, l=(5 * w, -16 * w, 0), fl=(0, -40 * w, -8 * w))
        return p

    # ---------------------------------------------------------------- idle (4.8 s loop)
    IDLE_FRAMES = 72

    def idle(t):
        p = R.Pose()
        br = R.breathe(t, freq=3)
        sway = W(t, 1, 0.1)
        p.move("pelvis", y=0.35 * sway, z=-0.15 + 0.12 * br)
        p.rot("pelvis", x=-2.0 * sway)
        p.rot("spine", y=1.4 * br, x=1.2 * sway)
        look = R.keys(t, [(0, 0), (0.12, 0), (0.24, 15), (0.42, 15), (0.54, -10), (0.7, -10), (0.82, 0), (1.0, 0)],
                      interp="smooth", loop=True)
        tilt = R.keys(t, [(0, 0), (0.14, 0), (0.26, -9), (0.42, -9), (0.55, 6), (0.7, 6), (0.84, 0), (1.0, 0)],
                      interp="smooth", loop=True)
        p.rot("head", x=tilt + 1.0 * sway, y=-1.5 * br, z=look)
        # ear flicks: the right one at ~30 %, both at ~75 % (with a little follow-through of the tips)
        f1 = R.pulse(t, 0.29, 0.31, 0.33, 0.38)
        f2 = R.pulse(t, 0.74, 0.76, 0.78, 0.84)
        ears(p, x=1.5 * W(t, 2), y=-2 + 2 * W(t, 2, 0.2) - 10 * f2, tip=(0, 1.5 * W(t, 2, 0.1) + 6 * f2, 0),
             r=(-6 * f1, -14 * f1, 10 * f1))
        p.rot("ear2_r", y=8 * R.pulse(t, 0.31, 0.33, 0.35, 0.41))
        stand(p)
        p.rot("arm_l", y=1.5 * br)
        p.rot("arm_r", y=1.5 * br)
        tw = R.chain_wave(t, 4, 7, lag=0.08, freq=2)
        tail(p, [(0, 3 * W(t, 2, 0.3), tw[0] - 3 * sway), (0, 0, tw[1]), (0, 0, tw[2]), (0, 0, tw[3])])
        return A.plant_feet(p)

    seqs.append(R.make_sequence(rig, "idle", idle, frames=IDLE_FRAMES, fps=15, loop=True, activity=mdl.ACT["IDLE"]))

    # ---------------------------------------------------------------- walk: bouncy biped jog
    WALK_FRAMES, WALK_FPS, WALK_DUTY = 16, 48.0, 0.22
    WALK_ROLL_LAG = 0.08   # the waddle's peak, after each contact (cycle fraction)
    walk_linear = 125.0 * WALK_FRAMES / WALK_FPS   # 41.7 units per cycle at 125 u/s

    def walk_body(t):
        p = R.Pose()
        # two steps per cycle; contact at t = 0 (left) and 0.5 (right), flight in between
        ph2 = (2 * t) % 1.0
        d2 = 2 * WALK_DUTY
        bounce = R.keys(ph2, [(0.0, 0.15), (0.2, -0.3), (d2, 0.3), (0.72, 1.0), (1.0, 0.15)], loop=True)
        # surge: the body lags while a foot is planted, catches up in the air
        surge = R.keys(ph2, [(0.0, 1.5), (d2, -1.5), (1.0, 1.5)], interp="smooth", loop=True)
        p.move("root", z=-1.2 + 2.8 * bounce, x=0.6 + surge)
        side = W(t, 1, 0.25)
        # waddle: the whole body (head included) rolls over the planted foot, ~6 degrees each way,
        # a little after the contact (left contact at t = 0: left side down = negative roll)
        roll = -W(t, 1, 0.25 - WALK_ROLL_LAG)
        p.rot("root", x=5.5 * roll)
        # forward lean ~15 degrees carried up to the head (not straightened by the neck), the hips
        # twisting with the stride
        p.rot("pelvis", y=14, z=9 * side)
        p.rot("spine", y=4 - 3 * bounce, z=-11 * side, x=-0.5 * roll)
        p.rot("head", y=-3 + 5 * bounce, z=3 * side, x=1.0 * roll)
        sw = 50 * W(t, 1, 0.25)
        arms(p, l=(10, -14 + sw, 0), r=(-10, -14 - sw, 0), fl=(0, -55 + 14 * W(t, 1, 0.1), 0),
             fr=(0, -55 - 14 * W(t, 1, 0.1), 0))
        # ears and tail lag the bounce (flop down on landing, spring up in the air) and the waddle
        lag = R.keys(ph2, [(0.0, 1.0), (0.25, 0.3), (0.5, -0.8), (0.8, -0.2), (1.0, 1.0)], loop=True)
        sway = -W(t, 1, 0.25 - WALK_ROLL_LAG - 0.12)
        ears(p, y=-12 + 11 * lag, x=-4, tip=(0, 15 * lag, 0), l=(-6 * sway, 0, 3 * side), r=(-6 * sway, 0, 3 * side))
        tw = R.chain_wave(t, 4, 12, lag=0.12)
        tail(p, [(0, 9 * lag - 7, tw[0] - 6 * sway), (0, 3 * lag, tw[1]), (0, 5 * lag, 0.6 * tw[2]),
                 (0, 6 * lag, 0.5 * tw[3])])
        return p

    def stance_start(body_fn, bone, ph):
        """Model-space position of `bone` at the start of a stance (the contact is fixed from it)."""
        return rig.world(body_fn(ph % 1.0))[rig.index(bone)][:, 3]

    def walk(t):
        p = walk_body(t)
        for chain, ph in zip(LEGS, (0.0, 0.5)):
            e = chain[2]
            u = (t - ph) % 1.0
            hip0 = stance_start(walk_body, chain[0], ph)
            x_front = hip0[0] + (A.ball[e][0] - rig.head(e)[0]) + 2.6
            dx, dz, pt = gait_track(u, WALK_DUTY, walk_linear, x_front, 3.6,
                                    lambda s: 24 * R.smoothstep(R.clamp01((s - 0.35) / 0.65)),
                                    lambda s: R.keys(s, [(0, 24), (0.25, 50), (0.65, 0), (0.85, -14), (1.0, 0)]))
            A.pivot_foot(p, chain, (dx, A.ball[e][1], dz), pt)
        return p

    seqs.append(R.make_sequence(rig, "walk", walk, frames=WALK_FRAMES, fps=WALK_FPS, loop=True,
                                activity=mdl.ACT["WALK"], linear=walk_linear))
    checks["walk"] = (walk, WALK_FRAMES, walk_linear)

    # ---------------------------------------------------------------- run: all-fours half bound
    RUN_FRAMES, RUN_FPS, RUN_DUTY = 16, 64.0, 0.12
    run_linear = 300.0 * RUN_FRAMES / RUN_FPS      # 75 units per cycle at 300 u/s
    HIND = (0.0, 0.0625)
    FRONT = (0.4375, 0.5)

    def run_body(t):
        p = R.Pose()
        # hind push 0..0.18, extended flight (legs stretched fore and aft), front paws 0.44..0.62,
        # gathered flight (hind legs swing under the body)
        ext = R.keys(t, [(0.0, 0.0), (0.16, 0.7), (0.3, 1.0), (0.44, 0.6), (0.6, -0.4), (0.8, -1.0), (1.0, 0.0)],
                     loop=True)
        lift = R.keys(t, [(0.0, 0.0), (0.12, 0.15), (0.28, 1.0), (0.42, 0.35), (0.5, 0.0), (0.64, 0.25),
                          (0.82, 0.75), (1.0, 0.0)], loop=True)
        # surge: lags during the stances, catches up in the flights
        surge = R.keys(t, [(0.0, 1.5), (0.18, -1.5), (0.4375, 1.5), (0.62, -1.5), (1.0, 1.5)], loop=True)
        rock = R.keys(t, [(0.0, -1.0), (0.3, 0.2), (0.55, 1.0), (0.8, -0.2), (1.0, -1.0)], loop=True)
        p.move("root", x=-2.6 + surge, z=-0.9 + 3.0 * lift)
        p.rot("root", y=6 * rock)
        p.rot("pelvis", y=76 - 10 * ext)
        p.rot("spine", y=6 + 12 * ext)
        p.rot("head", y=-82 + 4 * ext - 6 * rock, z=0)
        # ears and tail trail the bound: they lag the rise and fall of the body by ~0.1 cycle
        lift_lag = R.keys((t - 0.1) % 1.0, [(0.0, 0.0), (0.12, 0.15), (0.28, 1.0), (0.42, 0.35), (0.5, 0.0),
                                            (0.64, 0.25), (0.82, 0.75), (1.0, 0.0)], loop=True)
        ears(p, y=-60 - 14 * lift_lag, x=-6, tip=(0, -8 + 14 * W(t, 1, -0.2), 0))
        tw = R.chain_wave(t, 4, 6, lag=0.12)
        tail(p, [(0, -100 + 16 * W(t, 1, 0.05), tw[0]), (0, 4 + 7 * W(t, 1, -0.1), tw[1]),
                 (0, 9 * W(t, 1, -0.25), 0.6 * tw[2]), (0, 12 * W(t, 1, -0.4), 0.5 * tw[3])])
        return p

    def run(t):
        p = run_body(t)
        # hind legs (nearly together): planted on their toes, thrown far back after the push
        for chain, ph in zip(LEGS, HIND):
            e = chain[2]
            u = (t - ph) % 1.0
            hip0 = stance_start(run_body, chain[0], ph)
            x_front = hip0[0] + (A.ball[e][0] - rig.head(e)[0]) + RUN_HIND_REACH
            back = 3.0 * R.pulse(u, RUN_DUTY, 0.3, 0.42, 0.62)   # extended flight: the feet trail behind
            dx, dz, pt = gait_track(u, RUN_DUTY, run_linear, x_front, 2.6,
                                    lambda s: 30 + 15 * s,
                                    lambda s: R.keys(s, [(0, 45), (0.25, 60), (0.6, 10), (0.85, 0), (1.0, 30)]))
            A.pivot_foot(p, chain, (dx - back, A.ball[e][1], dz), pt)
        for chain, sx, ph in zip(ARMS, (1, -1), FRONT):
            e = chain[2]
            u = (t - ph) % 1.0
            sh0 = stance_start(run_body, chain[0], ph)
            x_front = sh0[0] + RUN_FRONT_REACH
            reach = 2.5 * R.pulse(u, 0.5, 0.7, 0.85, 0.98)       # stretched forward before landing
            dx, dz, pt = gait_track(u, RUN_DUTY, run_linear, x_front, 3.2,
                                    lambda s: 0.0,
                                    lambda s: R.keys(s, [(0, 20), (0.3, 80), (0.75, -25), (1.0, 0)]))
            A.pivot_hand(p, chain, np.array([dx + reach, 4.6 * sx, dz]), xform.rot_deg(0, pt, 0))
        return p

    RUN_HIND_REACH, RUN_FRONT_REACH = 2.6, 2.6
    seqs.append(R.make_sequence(rig, "run", run, frames=RUN_FRAMES, fps=RUN_FPS, loop=True,
                                activity=mdl.ACT["RUN"], linear=run_linear))
    checks["run"] = (run, RUN_FRAMES, run_linear)

    # ---------------------------------------------------------------- attack: Thunderbolt
    ATK_FRAMES = 24   # hit at 40 % = frame 9.2

    def attack(t):
        p = R.Pose()
        g = R.keys(t, [(0, 0), (0.06, 0.15), (0.28, 1.0), (0.355, 1.05), (0.4, 0.0)], interp="smooth")
        f = R.keys(t, [(0.355, 0), (0.4, 1.0), (0.64, 0.9), (0.74, 0.0)], interp="smooth")
        rc = R.pulse(t, 0.62, 0.67, 0.72, 0.84)
        settle = R.keys(t, [(0.82, 0), (0.9, -0.25), (1.0, 0)], interp="smooth")
        on = frame_sign(t, ATK_FRAMES)
        buzz = on * (0.35 * g * R.window(t, 0.12, 0.3) + 1.0 * f)
        # wind-up: low crouch, leaning in, ears pinned back, arms tucked
        p.move("root", z=-3.8 * g - 1.2 * f - 0.6 * rc, x=-0.4 * g + 1.0 * f - 1.4 * rc)
        p.rot("pelvis", y=24 * g + 22 * f - 8 * rc + 3 * settle, x=0.8 * buzz)
        p.rot("spine", y=14 * g + 10 * f - 6 * rc, x=-0.8 * buzz)
        p.rot("head", y=-28 * g - 20 * f - 6 * rc, x=1.5 * buzz, z=0.6 * buzz)
        ears(p, y=-62 * g + 16 * f + 10 * rc, x=-10 * g + 26 * f, tip=(0, -14 * g + 4 * f + 3 * buzz, 3 * buzz))
        stand(p, 1 - max(g, f, rc))
        # tucked: elbows in, fists at the chest; release: arms thrown back and down
        arms(p, l=(-6 * g + 24 * f + 10 * rc, -30 * g + 78 * f + 20 * rc, 0), fl=(0, -95 * g - 4 * f - 25 * rc, 0))
        # tail: curled down while charging, rigid and vertical on the release
        tail(p, [(0, -10 * g + 28 * f + 20 * rc, 2 * buzz), (0, -6 * g + 6 * f, -2 * buzz),
                 (0, 6 * g - 4 * f, 3 * buzz), (0, 4 * g + 6 * f, -3 * buzz)])
        crackle = 0.8 if (g > 0.55 and on > 0) else 0.0
        sparks(p, max(crackle, R.pulse(t, 0.355, 0.38, 0.72, 0.75)), t, ATK_FRAMES, forward=0.9 * f)
        aura(p, R.pulse(t, 0.37, 0.39, 0.72, 0.75), t, ATK_FRAMES)
        spread = 2.2 * f
        A.keep_above(p)
        return A.plant_feet(p, offsets=((-0.6 * f + 0.4 * g, spread, 0), (-0.6 * f + 0.4 * g, -spread, 0)))

    seqs.append(R.make_sequence(rig, "attack", attack, frames=ATK_FRAMES, fps=26, activity=mdl.ACT["RANGE_ATTACK1"]))

    # ---------------------------------------------------------------- flinch
    def flinch(t):
        p = R.Pose()
        k = R.keys(t, [(0, 0), (0.12, 1), (0.4, 0.7), (0.8, 0.1), (1.0, 0)], interp="smooth")
        e = R.keys(t, [(0, 0), (0.1, 0.6), (0.25, 1), (0.6, 0.5), (1.0, 0)], interp="smooth")
        p.move("root", x=-1.4 * k, z=-0.7 * k)
        p.rot("pelvis", y=-7 * k)
        p.rot("spine", y=-12 * k, x=5 * k)
        p.rot("head", y=-10 * k, x=12 * k, z=-8 * k)
        ears(p, y=-42 * e, x=-12 * e, tip=(0, -14 * e, 0))
        stand(p, 1 - k)
        arms(p, l=(18 * k, -48 * k, 0), fl=(0, -70 * k, 0))
        tail(p, [(0, 18 * e, 0), (0, 8 * e, 0), (0, -6 * e, 0), (0, -4 * e, 0)])
        return A.plant_feet(p, offsets=((-0.8 * k, 0, 0), (-0.3 * k, 0, 0)))

    seqs.append(R.make_sequence(rig, "flinch", flinch, frames=10, fps=22, activity=mdl.ACT["SMALL_FLINCH"]))

    # ---------------------------------------------------------------- die: falls on its right side
    DIE_FRAMES = 30
    LIE_ROLL = 86.0
    LIMBS = ("thigh_l", "shin_l", "foot_l", "thigh_r", "shin_r", "foot_r", "arm_l", "forearm_l", "hand_l",
             "arm_r", "forearm_r", "hand_r", "ear_l", "ear2_l", "ear_r", "ear2_r",
             "tail1", "tail2", "tail3", "tail4")

    def die_body(t):
        """Torso/head motion of the death (no root roll, no limbs)."""
        p = R.Pose()
        hit = R.keys(t, [(0, 0), (0.08, 1), (0.25, 0.55), (0.4, 0.3), (1.0, 0.3)], interp="smooth")
        wob = R.window(t, 0.1, 0.25) * (1 - R.window(t, 0.4, 0.5)) * W(t, 3.2, 0.1)
        buckle = R.window(t, 0.12, 0.42)
        fall = R.window(t, 0.32, 0.62, lambda x: R.clamp01(x) ** 2)
        limp = R.window(t, 0.6, 0.9)
        p.rot("pelvis", y=-6 * hit + 8 * buckle * (1 - fall) + 10 * limp, x=4 * wob)
        p.rot("spine", y=-10 * hit + 6 * buckle + 6 * limp, x=3 * wob)
        p.rot("head", y=-16 * hit + 12 * buckle + 6 * limp, x=9 * wob + 8 * buckle - 18 * limp)
        return p, hit, wob, buckle, fall, limp

    def aim_world(p, bone, R_world):
        """Set a bone's local rotation so that its world rotation is R_world."""
        Wm = rig.world(p)
        parent = rig.bones[rig.index(bone)].parent
        Rl = Wm[parent][:, :3].T @ R_world
        p.set_rot(bone, *np.degrees(xform.matrix_euler(Rl)))

    def lying():
        """The final pose: lying on the right side, torso and head on the ground, the right ear laid
        along the ground behind the head, the bolt flat on the floor, the upper limbs flopped down."""
        p, hit, wob, buckle, fall, limp = die_body(1.0)
        p.rot("root", x=LIE_ROLL)
        p.move("root", y=2.5)
        p.move("root", z=-A.min_z(p, A.TORSO))
        Wm = rig.world(p)

        def wpos(b):
            return Wm[rig.index(b)][:, 3]
        lie = xform.rot_deg(LIE_ROLL, 0, 0)
        # arms: the lower one along the ground in front, the upper one draped down in front of the chest
        tl, tr = wpos("arm_l") + (3.0, -0.6, 0), wpos("arm_r") + (3.4, -0.4, 0)
        tl[2], tr[2] = 3.0, 1.1
        A.reach_hands(p, [tl, tr], pole=(0.3, 0.0, 1.0),
                      hand_rot=[lie @ xform.rot_deg(0, 30, 10), lie @ xform.rot_deg(0, 20, 0)])
        # legs: knees forward, the upper foot resting on the lower one
        for (u, l, e), off, zt, pt, pole in zip(LEGS, ((2.4, 3.6), (2.2, 3.4)), (3.0, 1.9), (35, 20),
                                                ((1, 0, 0), (1, 0, 1.2))):
            hip = wpos(u)
            target = np.array([hip[0] + off[0], hip[1] + off[1], zt])
            rig.solve_two_bone(p, u, l, e, target, pole=pole, end_world_rot=lie @ xform.rot_deg(0, pt, 0))
        # ears: the lower one swung back to lie along the ground behind the head (not a prop), the upper
        # one flopped back over it
        def set_ear_r(k):
            aim_world(p, "ear_r", R._align(ear_axis(-1), _unit((-0.5, -0.85, k))))
            p.set_rot("ear2_r", 0, -4, 0)
        lo, hi = -0.8, 0.4
        for _ in range(24):
            m = 0.5 * (lo + hi)
            set_ear_r(m)
            if A.min_z(p, ("ear_r", "ear2_r")) < 0.12:
                lo = m
            else:
                hi = m
        set_ear_r(hi)
        aim_world(p, "ear_l", R._align(ear_axis(1), _unit((-0.7, -0.6, -0.2))))
        p.set_rot("ear2_l", 0, -12, 0)
        # tail: the stem bends down from the rump to the floor, the bolt lies flat on it
        stem_rest = _unit(np.array([TAIL_C[1][0] - TAIL_C[0][0], 0, TAIL_C[1][1] - TAIL_C[0][1]]))
        h = rig.world(p)[rig.index("tail1")][2, 3]
        L = float(np.linalg.norm(TAIL_C[1] - TAIL_C[0]))
        sz = max(-0.95, min(0.0, (0.9 - h) / L))
        horiz = _unit((-0.8, 0.6, 0.0)) * math.sqrt(1 - sz * sz)
        aim_world(p, "tail1", R._align(stem_rest, horiz + (0, 0, sz)))
        p.set_rot("tail2", 0, 0, 0)
        along_r = _unit(np.array([TAIL_C[5][0] - TAIL_C[1][0], 0, TAIL_C[5][1] - TAIL_C[1][1]]))
        n_r = np.array([0.0, 1.0, 0.0])
        a_d = _unit((-0.55, 0.83, 0.0))
        n_d = np.array([0.0, 0.0, 1.0])
        F_r = np.stack([along_r, n_r, np.cross(along_r, n_r)], 1)
        F_d = np.stack([a_d, n_d, np.cross(a_d, n_d)], 1)
        aim_world(p, "tail3", F_d @ F_r.T)
        p.set_rot("tail4", 0, 0, 0)
        A.keep_above(p, margin=0.0, bones=None)
        return p

    LYING = lying()

    def die(t):
        p, hit, wob, buckle, fall, limp = die_body(t)
        bounce = R.keys(t, [(0.62, 0), (0.68, 1), (0.76, 0), (0.82, 0.3), (0.88, 0)], interp="smooth")
        ears(p, y=-30 * hit, x=-10 * hit, tip=(0, -12 * hit, 0))
        stand(p, 1 - hit)
        arms(p, l=(30 * hit, -60 * hit, 0), fl=(0, -40 * hit, 0))
        tail(p, [(0, 14 * hit, 0), (0, 6 * hit, 0), (0, 0, 0), (0, 0, 0)])
        # knees buckle while standing
        p.move("root", z=-1.6 * buckle * (1 - fall))
        A.plant_feet(p, offsets=((0.6 * buckle, 0.4 * buckle, 0), (0.2 * buckle, -0.4 * buckle, 0)))
        # limbs, ears and tail settle into the lying pose as it falls
        wl = R.smoothstep(R.clamp01(fall * 0.6 + limp * 0.6))
        if wl > 0:
            for n in LIMBS:
                p.set_rot(n, *(p.get_rot(n) * (1 - wl) + LYING.get_rot(n) * wl))
        # tips over onto its right side, the lowest point resting on the ground from the moment it
        # leaves its feet
        p.rot("root", x=LIE_ROLL * fall - 6 * bounce)
        p.move("root", y=2.5 * fall)
        if fall > 0:
            p.move("root", z=-A.min_z(p) + 0.7 * bounce)
        if fall >= 0.98:
            bury_fx(p)
        return p

    seqs.append(R.make_sequence(rig, "die", die, frames=DIE_FRAMES, fps=20, activity=mdl.ACT["DIESIMPLE"]))
    checks["die"] = die

    # ---------------------------------------------------------------- spawn: ball -> stands -> pose/cry
    SPAWN_FRAMES = 26

    def ball_pose():
        p = R.Pose()
        p.rot("pelvis", y=48)
        p.rot("spine", y=28)
        p.rot("head", y=34)
        ears(p, y=-78, x=-10, tip=(0, -8, 0))
        arms(p, l=(-12, -72, 0), fl=(0, -110, 0))
        for side in ("l", "r"):
            p.rot(f"thigh_{side}", y=-95)
            p.rot(f"shin_{side}", y=125)
            p.rot(f"foot_{side}", y=-20)
        tail(p, [(0, 40, 0), (0, 25, 0), (0, 20, 0), (0, 10, 0)])
        p.move("root", z=-A.min_z(p))
        return p

    BALL = ball_pose()

    def spawn_stand(t):
        p = R.Pose()
        hop = R.keys(t, [(0.04, 0), (0.17, 3.2), (0.27, 0)], interp="smooth")
        squash = R.pulse(t, 0.25, 0.28, 0.31, 0.38)
        pose = R.pulse(t, 0.36, 0.46, 0.8, 0.96)
        wave_ = R.window(t, 0.44, 0.5) * (1 - R.window(t, 0.76, 0.84)) * W(t, 4.0)
        over = R.keys(t, [(0.24, 0), (0.3, 1.0), (0.37, -0.4), (0.44, 0)], interp="smooth")
        p.move("root", z=hop - 1.4 * squash)
        p.rot("pelvis", y=10 * squash)
        p.rot("spine", y=8 * squash - 6 * pose)
        p.rot("head", y=-6 * squash - 10 * pose, x=10 * pose)
        ears(p, y=-14 * R.window(t, 0.04, 0.2) * (1 - R.window(t, 0.2, 0.3)) + 16 * over, x=6 * pose,
             tip=(0, 12 * over, 0))
        stand(p, 1 - pose)
        # pose: left arm raised high (waving), right fist at the chest
        arms(p, l=(150 * pose, -20 * pose, 0), r=(0, -25 * pose, 0),
             fl=(0, -4 * pose + 12 * wave_, 0), fr=(0, -60 * pose, 0))
        p.rot("arm_l", y=10 * wave_)
        tw = R.chain_wave(t, 4, 12 * pose, lag=0.1, freq=4)
        tail(p, [(0, -6 * pose + 10 * squash, tw[0]), (0, 0, tw[1]), (0, 0, 0.6 * tw[2]), (0, 0, 0.5 * tw[3])])
        A.keep_above(p)
        return A.plant_feet(p, offsets=((0, 0, max(hop, 0)), (0, 0, max(hop, 0))))

    def spawn(t):
        u = R.smoothstep(R.clamp01((t - 0.04) / 0.2))   # unfolds over frames 1..6
        p = R.blend(BALL, spawn_stand(t), u) if u < 1 else spawn_stand(t)
        if 0 < u < 1:
            A.keep_above(p, margin=0.0, bones=None)
        i = int(round(t * (SPAWN_FRAMES - 1)))
        sparks(p, 1.0 if 12 <= i <= 15 else 0.0, t, SPAWN_FRAMES, forward=0.4)
        return p

    seqs.append(R.make_sequence(rig, "spawn", spawn, frames=SPAWN_FRAMES, fps=24, activity=mdl.ACT["ARM"]))

    # ---------------------------------------------------------------- victory: two hops (the second spins), arms up
    VIC_FRAMES = 36

    def victory(t):
        p = R.Pose()
        z = R.keys(t, [(0.0, 0), (0.07, -1.2), (0.13, 0), (0.24, 4.5), (0.35, 0), (0.41, -1.2), (0.47, 0),
                       (0.62, 6.5), (0.77, 0), (0.83, -1.0), (0.9, 0), (1.0, 0)], interp="smooth")
        air = max(z, 0.0)
        squash = max(-z, 0.0)
        p.move("root", z=z)
        p.rot("root", z=360 * R.window(t, 0.47, 0.77, R.ease_in_out))
        cheer = R.pulse(t, 0.1, 0.2, 0.84, 0.96)
        p.rot("pelvis", y=6 * squash)
        p.rot("spine", y=-6 * cheer + 6 * squash)
        p.rot("head", y=-12 * cheer, x=7 * W(t, 2) * cheer)
        stand(p, 1 - cheer)
        arms(p, l=(125 * cheer - 20 * squash, -22 * cheer, 0), fl=(0, -25 * cheer, 0))
        lag = R.keys(t, [(0.13, 0), (0.2, -1), (0.3, 0.6), (0.4, -0.3), (0.47, 0), (0.55, -1), (0.72, 0.6),
                         (0.82, -0.4), (0.92, 0.2), (1.0, 0)], interp="smooth")
        ears(p, y=12 * lag, x=-6 * cheer, tip=(0, 10 * lag, 0))
        tw = R.chain_wave(t, 4, 16 * cheer, lag=0.12, freq=4)
        tail(p, [(0, -8 * cheer + 8 * lag, tw[0]), (0, 4 * lag, tw[1]), (0, 0, 0.6 * tw[2]), (0, 0, 0.5 * tw[3])])
        i = int(round(t * (VIC_FRAMES - 1)))
        sparks(p, 1.0 if 24 <= i <= 27 else 0.0, t, VIC_FRAMES, forward=0.2)
        tuck = air / 6.5
        foot = (-1.0 * tuck, 0, z + squash + 1.8 * tuck)
        return A.plant_feet(p, offsets=(foot, foot), pitch=(25 * tuck, 25 * tuck))

    seqs.append(R.make_sequence(rig, "victory", victory, frames=VIC_FRAMES, fps=24, activity=mdl.ACT["VICTORY_DANCE"]))
    return seqs, checks


# --------------------------------------------------------------------------------------------
# checks
# --------------------------------------------------------------------------------------------

def contact_slip(A, pose_fn, frames, linear, parts, ground=0.3):
    """Largest world-space slip (units per frame) of vertices of `parts` that touch the ground
    (z < ground) in two consecutive frames of a looping gait."""
    masks = [np.isin(np.arange(len(A.verts)), idx) for idx in parts]
    poses = [A.posed(pose_fn(i / frames)) for i in range(frames)]
    worst = 0.0
    for i in range(frames):
        a, b = poses[i], poses[(i + 1) % frames]
        xa = a[:, 0] + linear * i / frames
        xb = b[:, 0] + linear * (i + 1) / frames
        for m in masks:
            sel = m & (a[:, 2] < ground) & (b[:, 2] < ground)
            if sel.any():
                worst = max(worst, float(np.abs(xb[sel] - xa[sel]).max()),
                            float(np.abs(b[sel, 1] - a[sel, 1]).max()))
    return worst


def _closest_on_polyline(P, pts):
    """Closest points of the polyline pts (k, 3) to the points P (N, 3)."""
    best = np.full(len(P), np.inf)
    out = np.zeros_like(P)
    for a, b in zip(pts[:-1], pts[1:]):
        e = b - a
        t = np.clip((P - a) @ e / (e @ e), 0.0, 1.0)
        q = a + np.outer(t, e)
        d = np.einsum("ij,ij->i", P - q, P - q)
        sel = d < best
        best[sel], out[sel] = d[sel], q[sel]
    return out


def normal_report(parts):
    """Outward-normal check of the opaque parts: for every corner, the dot product of its (unit) vertex
    normal with the unit direction from the part's core to the vertex.  Core: the centroid for the
    convex parts (the head's two parts share the head's), the lance axis for the ears, the centre line
    for the tail (round stem + flat bolt).  Also counts folded triangles (face normal against the
    part's exact surface normal).  Returns {part: (min dot, bad corners + folds, corners, max |len - 1|)}."""
    byname = {p.name: p for p in parts}
    head_c = np.concatenate([byname[n].tri.verts for n in ("face", "skull") if n in byname]).mean(0)
    tail_line = np.array([(TAIL_STEM[0][0], 0.0, TAIL_STEM[0][1])] + [(x, 0.0, z) for x, z in TAIL_C[1:]])
    rep = {}
    for p in parts:
        if p.name.startswith(("spark", "bolt")):
            continue    # two-sided additive ribbons
        V = p.tri.verts[p.tri.faces].reshape(-1, 3)
        N = p.nrm[p.corner_n].reshape(-1, 3)
        if p.name in ("face", "skull"):
            C = np.broadcast_to(head_c, V.shape)
        elif p.name.startswith("ear_"):
            sx = 1 if p.name == "ear_l" else -1
            a = ear_base(sx) - ear_axis(sx) * EAR_SINK
            C = _closest_on_polyline(V, np.array([a, ear_tip(sx)]))
        elif p.name == "tail":
            C = _closest_on_polyline(V, tail_line)
        else:
            C = np.broadcast_to(p.tri.verts.mean(0), V.shape)
        D = V - C
        D = D / np.maximum(np.linalg.norm(D, axis=1, keepdims=True), 1e-9)
        L = np.linalg.norm(N, axis=1)
        dots = np.einsum("ij,ij->i", N / L[:, None], D)
        # folds: triangles turned inside out against the exact surface
        folds = 0
        if p.shape is not None:
            c = p.tri.verts[p.tri.faces].mean(1)
            folds = int((np.einsum("ij,ij->i", p.tri.face_normals(), p.shape.normal(c)) <= 0).sum())
        rep[p.name] = (float(dots.min()), int((dots <= 0).sum()) + folds, len(dots), float(np.abs(L - 1).max()))
    return rep


# every opaque part is rounded (the ear lances and the tail bolt too: their rims are round, radius
# ~0.5): one area-weighted normal per vertex, no crease split (a split normal is a hard step under the
# engine's dynamic lights)
SMOOTH_PARTS = ("thigh", "shin", "foot", "arm", "forearm", "hand")


# --------------------------------------------------------------------------------------------
# model
# --------------------------------------------------------------------------------------------

def _premesh(part, rig, m, vbone, nrm=None, corner_n=None):
    if nrm is None:
        nrm, corner_n = meshmod.crease_normals(m, part.crease)
    part.tri, part.nrm, part.corner_n, part.vbone = m, nrm, corner_n, vbone
    return part


def _sub(m, faces_sel, corner_n):
    """Sub-mesh (compacted vertices) of selected faces, with their corner normal ids."""
    f = m.faces[faces_sel]
    used = np.unique(f)
    remap = -np.ones(len(m.verts), dtype=np.int64)
    remap[used] = np.arange(len(used))
    return meshmod.TriMesh(m.verts[used], remap[f]), corner_n[faces_sel]


def generated_model(path=None, verbose=False, return_checks=False, strict=True):
    S = shapes()
    cheeks = cheek_points(S["head"])
    bolts = body_bolts(S["body"])
    rig = make_rig(cheeks, bolts)

    # effect meshes (and their centre lines for the paint)
    fx_meshes, fx_lines = [], []
    for k, (side, (cp, cn)) in enumerate(zip(("l", "r"), cheeks)):
        base, d = spark_rest(cp, cn)
        for i in range(SPARK_N):
            m, line = bolt_mesh(base, d, SPARK_LEN, seed=11 + 7 * k + i)
            fx_meshes.append((f"spark_{side}{i}", m))
            fx_lines.append(line)
    for i, (base, d, _) in enumerate(bolts):
        m, line = bolt_mesh(base, d, BOLT_LEN, seed=41 + i, w0=0.7, w1=0.32, zig=1.1)
        fx_meshes.append((f"bolt{i}", m))
        fx_lines.append(line)

    P = make_paints(S, fx_lines)
    b = builder.ModelBuilder("pokemon/pikachu.mdl", rig, skins=1, verbose=verbose)
    b.group("head", size=(512, 256), pack="skyline")
    b.group("body", size=(512, 256), pack="skyline")
    b.group("limbs", size=(512, 256), pack="skyline")
    b.group("spark", size=(256, 128), flags=mdl.STUDIO_NF_ADDITIVE | mdl.STUDIO_NF_FULLBRIGHT, pack="skyline")

    # head: one mesh, split in two parts so that the face gets twice the texel density (shared
    # vertices and normals: no seam in the shading)
    face_part = builder.Part("face", S["head"], bone="head", paint=P["head"], group="head", density=1.7)
    skull_part = builder.Part("skull", S["head"], bone="head", paint=P["head"], group="head")
    hm = meshmod.mesh_sdf(S["head"], budget=860)
    hn, hc = meshmod.crease_normals(hm, 180.0)
    ctr = hm.verts[hm.faces].mean(1)
    fn = hm.face_normals()
    is_face = (fn[:, 0] > 0.25) & (ctr[:, 0] > HEAD_C[0] + 1.0) & (ctr[:, 2] < HEAD_C[2] + 4.2)
    for part, sel in ((face_part, is_face), (skull_part, ~is_face)):
        m, cn_ = _sub(hm, sel, hc)
        _premesh(part, rig, m, np.full(len(m.verts), rig.index("head")), hn, cn_)
        b.add(part)

    for side, sx in (("l", 1), ("r", -1)):
        b.add(builder.Part(f"ear_{side}", S[f"ear_{side}"], bones=[f"ear_{side}", f"ear2_{side}"],
                           paint=P[f"ear_{side}"], group="body", mesh=ear_mesh(sx, 130), crease=180.0))
    b.add(builder.Part("body", S["body"], bones=["pelvis", "spine"], paint=P["body"], group="body", budget=430,
                       crease=180.0))
    tail_part = builder.Part("tail", S["tail"], bones=["tail1", "tail2", "tail3", "tail4"], paint=P["tail"],
                             group="limbs", charts={"smooth_iters": 6, "min_dot": 0.2}, crease=180.0)
    tm = meshmod.mesh_sdf(S["tail"], budget=290)
    b.add(_premesh(tail_part, rig, tm, tail_vbones(rig, tm.verts, S["tail_stem"], S["tail_bolt"])))
    limb_charts = {"smooth_iters": 8, "min_dot": 0.15}
    for side in ("l", "r"):
        for name, budget, paint in (("thigh", 76, P["legs"]), ("shin", 56, P["legs"]), ("foot", 100, P["legs"]),
                                    ("arm", 56, P[f"arm_{side}"]), ("forearm", 46, P[f"arm_{side}"]),
                                    ("hand", 64, P[f"arm_{side}"])):
            b.add(builder.Part(f"{name}_{side}", S[f"{name}_{side}"], bone=f"{name}_{side}", paint=paint,
                               group="limbs", budget=budget, charts=limb_charts,
                               crease=180.0 if name in SMOOTH_PARTS else 65.0))
    for name, m in fx_meshes:
        b.add(builder.Part(name, mesh=m, bone=name, paint=P["spark"], group="spark", hitbox=False, crease=180))
    b.mesh_parts()
    nrep = normal_report([q for q in b.parts])
    if strict:
        bad = {k: v for k, v in nrep.items() if v[1] or v[3] > 1e-6}
        assert not bad, f"vertex normals not unit / not pointing outward: {bad}"
    for part in b.parts:
        if part.name.startswith("spark"):
            assert S["head"](part.tri.verts).max() < -0.15, "cheek sparks must hide inside the head"
        if part.name.startswith("bolt"):
            assert S["body"](part.tri.verts).max() < -0.15, "aura bolts must hide inside the body"
    A = Anim(rig, [q for q in b.parts if not q.name.startswith(("spark", "bolt"))])
    A.cheeks = cheeks
    A.bolts = bolts
    seqs, checks = make_sequences(rig, A)
    for s in seqs:
        b.add_sequence(s)

    # --- checks: planted feet / paws do not slide; the corpse lies on the floor
    feet = [np.flatnonzero(A.mask((e,))) for e in ("foot_l", "foot_r")]
    hands = [np.flatnonzero(A.mask((e,))) for e in ("hand_l", "hand_r")]
    slip = {}
    for name, parts in (("walk", feet), ("run", feet + hands)):
        fn_, frames, lin = checks[name]
        slip[name] = contact_slip(A, fn_, frames, lin, parts)
        if strict:
            assert slip[name] < 0.4, f"{name}: planted feet slide {slip[name]:.2f} u/frame"
    end = checks["die"](1.0)
    core_min = A.min_z(end, A.TORSO)
    tail_min = A.min_z(end, ("tail1", "tail2", "tail3", "tail4"))
    all_min = A.min_z(end)
    # the effect bolts are buried under the corpse while it lies (and fades out)
    Mx = rig.skin_matrices(end)
    fx_top = max(float((np.einsum("ij,nj->ni", Mx[q.vbone[0]][:, :3], q.tri.verts) + Mx[q.vbone[0]][:, 3])[:, 2].max())
                 for q in b.parts if q.name.startswith(("spark", "bolt")))
    if strict:
        assert fx_top < -5.0, fx_top
    if strict:
        assert core_min < 0.5 and tail_min < 1.0 and all_min > -0.05, (core_min, tail_min, all_min)

    zap = HEAD_C + (6.8, 0, -1.6)
    b.attachment("zap", "head", zap)
    b.attachment("zap2", "head", zap)
    b.eyeposition = (0, 0, 20)
    b.hull = ((-16, -16, 0), (16, 16, 36))
    st = b.build()
    # the buried effect bolts do not count in the death's bounds
    die_i = [s.name for s in st.sequences].index("die")
    keep = np.concatenate([~np.isin(p.vbone, [rig.index(n) for n in FX_BONES]) for p in b.parts])
    all_v = np.concatenate([p.tri.verts for p in b.parts])[keep]
    all_b = np.concatenate([p.vbone for p in b.parts])[keep]
    heads = np.array([bn.head for bn in rig.bones])
    s = st.sequences[die_i]
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for f in range(s.numframes):
        Wm = mdl.bone_matrices(st.bones, s.pos[f], s.rot[f])
        pts = np.einsum("nij,nj->ni", Wm[all_b][:, :, :3], all_v - heads[all_b]) + Wm[all_b][:, :, 3]
        lo, hi = np.minimum(lo, pts.min(0)), np.maximum(hi, pts.max(0))
    s.bbmin, s.bbmax = tuple(lo), tuple(hi)
    data = mdl.write(st)
    mdl.read(data)
    if path:
        with open(path, "wb") as f:
            f.write(data)
    if return_checks:
        return data, {"slip": slip, "die_fx_top": fx_top, "die_core_min": core_min, "die_tail_min": tail_min, "die_all_min": all_min,
                      "report": b.report}
    return data


# ============================================================================================
# The official model (Game Freak's, from the owner's local copy; never stored in the repository)
# ============================================================================================
#
# models/pokemon/pikachu.mdl is built from `<POKEMON_OFFICIAL_DIR>/plain/25.glb` when that file exists:
# its mesh, textures, smooth skinning and 31-bone rig as official.Importer converts them, its one official
# animation (Thunderbolt, "Impactrueno") retimed for the attack, and the other sequences keyframed here on its
# real bones.  Without the file, generated_model() above builds our own Pikachu (same contract).

OFFICIAL_ENV = "POKEMON_OFFICIAL_DIR"
OFFICIAL_DEFAULT = "/srv/orthros/data/installers/pokemon-official"
OFFICIAL_FILE = ("plain", "25.glb")
OFFICIAL_ANIM = "Impactrueno"
OFFICIAL_HEIGHT = 30.0          # the battle stance (the clip's first frame) to the ear tips


def official_source():
    """Path of the official Pikachu glTF, or None when the sources are not installed."""
    root = os.environ.get(OFFICIAL_ENV) or OFFICIAL_DEFAULT
    path = os.path.join(root, *OFFICIAL_FILE)
    return path if os.path.isfile(path) else None


def _quat(m):
    """3x3 rotation -> quaternion (x, y, z, w)."""
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q = ((m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s)
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = (0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s)
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = ((m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s)
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = ((m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s)
    return np.array(q)


def _slerp_m(a, b, w):
    q = xform.quaternion_slerp(_quat(a), _quat(b), w)
    q = np.asarray(q) / np.linalg.norm(q)
    return xform.quaternion_matrix(q)


class OPose:
    """A pose of the official skeleton: local rotation matrices R (B, 3, 3) and local positions T (B, 3)
    (parent frame; rest rotations are identity, so at rest every local frame is the model frame)."""

    def __init__(self, kit, R=None, T=None):
        self.kit = kit
        n = len(kit.names)
        self.R = np.tile(np.eye(3), (n, 1, 1)) if R is None else R
        self.T = kit.rest.copy() if T is None else T
        # expression (Kit.finalize turns it into the decals' collapse bones): a state name per kind, or an
        # (L, R) pair; Cheek None = "white" on a side whose sparks are out, else "red"
        self.face = {"Eye": "open", "Mouth": "closed", "Cheek": None}
        self.spark_on = set()      # spark bones shown this frame
        self.spark_set = set()     # spark bones aimed this frame (the others get the frame's fan, collapsed)

    def copy(self):
        p = OPose(self.kit, self.R.copy(), self.T.copy())
        p.face = dict(self.face)
        p.spark_on, p.spark_set = set(self.spark_on), set(self.spark_set)
        return p

    def expr(self, eye=None, mouth=None, cheek=None):
        """Set the expression: eye "open" | "half" | "closed", mouth "closed" | "open" | "wide",
        cheek "red" | "white" (each a state or an (L, R) pair; None keeps it)."""
        for k, v in (("Eye", eye), ("Mouth", mouth), ("Cheek", cheek)):
            if v is not None:
                self.face[k] = v
        return self

    def rot(self, bone, x=0.0, y=0.0, z=0.0):
        """Rotate a bone (and its subtree) about its head by euler degrees in its PARENT's frame."""
        i = self.kit.index(bone)
        self.R[i] = xform.rot_deg(x, y, z) @ self.R[i]
        return self

    def spin(self, bone, x=0.0, y=0.0, z=0.0):
        """Rotate a bone about its own (posed) axes."""
        i = self.kit.index(bone)
        self.R[i] = self.R[i] @ xform.rot_deg(x, y, z)
        return self

    def turn(self, bone, x=0.0, y=0.0, z=0.0, M=None):
        """Rotate a bone's subtree about its head by a MODEL-space rotation (euler degrees or matrix M)."""
        i = self.kit.index(bone)
        M = xform.rot_deg(x, y, z) if M is None else M
        p = self.kit.parents[i]
        Rp = self.world()[p][:, :3] if p >= 0 else np.eye(3)
        self.R[i] = Rp.T @ M @ Rp @ self.R[i]
        return self

    def move(self, bone, x=0.0, y=0.0, z=0.0):
        """Offset a bone in its parent's frame (the root: model space)."""
        self.T[self.kit.index(bone)] += (x, y, z)
        return self

    def world(self):
        k = self.kit
        W = np.empty((len(k.names), 3, 4))
        for i, p in enumerate(k.parents):
            if p < 0:
                W[i, :, :3] = self.R[i]
                W[i, :, 3] = self.T[i]
            else:
                W[i, :, :3] = W[p, :, :3] @ self.R[i]
                W[i, :, 3] = W[p, :, :3] @ self.T[i] + W[p, :, 3]
        return W

    def head(self, bone):
        return self.world()[self.kit.index(bone)][:, 3].copy()

    def arrays(self):
        rot = np.array([xform.matrix_euler(r) for r in self.R])
        return self.T.copy(), rot


def oblend(a, b, w):
    """Blend two poses (w = 0: a, 1: b): rotations slerped, positions interpolated."""
    if w <= 0:
        return a.copy()
    if w >= 1:
        return b.copy()
    out = a.copy()
    for i in range(len(a.R)):
        if not np.allclose(a.R[i], b.R[i], atol=1e-9):
            out.R[i] = _slerp_m(a.R[i], b.R[i], w)
    out.T = a.T * (1 - w) + b.T * w
    return out


def _align(a, b):
    return R._align(a, b)


SPARK_SIDES = ("L", "R")
SPARK_N2 = 3                     # per cheek
SPARK_LEN2 = 5.2
SPARK_SINK2 = 0.5
FX_NAMES = tuple(f"{s}Spark{i}" for s in SPARK_SIDES for i in range(SPARK_N2))

# Expression decals of the official face: (material, kind, per side, {state: cell}).  The official textures are
# atlases of 4 cells stacked vertically (the games swap them by a UV offset); cell 0 is the one the mesh maps.
# Every state is a copy of the decal with its own texture (that cell copied over cell 0, same crop and s/t).
DECALS = (("material", "Eye", True, {"open": 0, "half": 1, "closed": 2}),
          ("Mouth", "Mouth", False, {"closed": 0, "open": 2, "wide": 3}),
          ("BodyB", "Cheek", True, {"red": 0, "white": 2}))
DECAL_CELLS = 4
COLLAPSE_DEG = 120.0


def _decal_name(kind, state, side=None):
    return f"{kind}_{state}" + (f"_{side}" if side else "")


class Kit:
    """The official skeleton plus the effect bones, its skinned vertices (for the checks) and the official
    clip, with the posing helpers the sequences use."""

    def __init__(self, imp):
        self.imp = imp
        self.nmain = len(imp.bone_names)
        self.names = list(imp.bone_names)
        self.parents = [int(p) for p in imp.parents]
        self.heads = np.array(imp.heads, dtype=np.float64)
        self._index = {n: i for i, n in enumerate(self.names)}
        V, B, W, M = [], [], [], []
        for s in imp.surfaces:
            V.append(s.pos)
            B.append(s.bw_bones)
            W.append(s.bw_weights)
            M.append(np.full(len(s.pos), s.material))
        self.V = np.concatenate(V)
        self.VB = np.concatenate(B)
        self.VW = np.where(self.VB >= 0, np.concatenate(W), 0) / 255.0
        self.vmat = np.concatenate(M)
        self.cheeks = self._find_cheeks()
        head = self.index("Head")
        hv = self.V[self.VB[:, 0] == head]
        self.head_center = (hv.min(0) + hv.max(0)) / 2
        # Hidden effects and expression states are collapsed, never parked out of sight: each element is
        # skinned 85/85/85 to its carrier bone and two collapse bones (children with the same head).  Shown, the
        # collapse bones keep the carrier's frame (the blend is the carrier's matrix); hidden, they turn +-120
        # degrees about the element's axis, and (I + R(+120) + R(-120)) / 3 projects onto that axis: the
        # element is a line of zero area, wherever it is, even inside a translucent corpse.  Between two hidden
        # frames (or blended sequences) it stays a line; shown <-> hidden squashes it toward the axis.
        self.fx = {}               # element -> (carrier, plus bone, minus bone, axis at rest)
        for side, (cp, cn) in zip(SPARK_SIDES, self.cheeks):
            base, inward, _ = self.spark_dirs(side)
            for i in range(SPARK_N2):
                nm = f"{side}Spark{i}"
                self._add(nm, head, base)
                self._collapser(nm, self.index(nm), base, inward)
        self.decals = {}           # element -> (material, kind, state, side, cell)
        self.decal_geo = {}        # (material, side) -> (centre, axis)
        for mat, kind, per_side, states in DECALS:
            surf = [s for s in imp.surfaces if imp._matname(s.material) == mat]
            if not surf:
                raise ValueError(f"official Pikachu: no {mat} decal")
            s = surf[0]
            for side, sy in ((("L", 1), ("R", -1)) if per_side else ((None, 0),)):
                sel = np.ones(len(s.pos), bool) if sy == 0 else (np.sign(s.pos[:, 1]) == sy)
                c = s.pos[sel].mean(0)
                n = s.nrm[sel].mean(0)
                a = np.cross(n / np.linalg.norm(n), (0.0, 0.0, 1.0))
                a /= np.linalg.norm(a)
                self.decal_geo[(mat, side)] = (c, a)
                for state, cell in states.items():
                    nm = _decal_name(kind, state, side)
                    self.decals[nm] = (mat, kind, state, side, cell)
                    self._collapser(nm, head, c, a)
        self.rest = np.array([self.heads[i] - (self.heads[p] if p >= 0 else 0.0)
                              for i, p in enumerate(self.parents)])
        self._cache = {}
        self.shown = {}            # sequence name -> shown elements per frame (Kit.finalize)
        st = self.official(0.0, grounded=False)
        self.ground = float(self.skin(st)[:, 2].min())

    def _add(self, name, parent, head):
        self._index[name] = len(self.names)
        self.names.append(name)
        self.parents.append(parent)
        self.heads = np.vstack([self.heads, head])

    def _collapser(self, element, carrier, centre, axis):
        self._add(element + "+", carrier, centre)
        self._add(element + "-", carrier, centre)
        self.fx[element] = (carrier, self.index(element + "+"), self.index(element + "-"),
                            np.asarray(axis, float) / np.linalg.norm(axis))

    def weights_of(self, element):
        """Bone slots and weights (4 each) of an element's vertices."""
        c, ip, im, _ = self.fx[element]
        return [c, ip, im, -1], [85, 85, 85, 0]

    def want(self, pose, kind, side):
        """The expression state of a decal kind on one side in a pose."""
        want = pose.face.get(kind)
        if kind == "Cheek" and want is None:
            sparking = any(f"{side}Spark{j}" in pose.spark_on for j in range(SPARK_N2))
            want = "white" if sparking else "red"
        if isinstance(want, (tuple, list)):
            want = want[0 if side == "L" else 1]
        return want

    def visible(self, pose, element, hide_base=()):
        """Whether an element is shown in a pose.  The official decal (cell 0) is the base layer, shown under
        the other states (drawn a little in front of it) so that a state squashing in or out never uncovers
        the head under the decal; it is collapsed only where a covering state holds (hide_base)."""
        if element in FX_NAMES:
            return element in pose.spark_on
        mat, kind, state, side, cell = self.decals[element]
        if cell == 0:
            return element not in hide_base
        return state == self.want(pose, kind, side)

    def expression_problems(self, name):
        """A state coincides with the base decal and wins the depth test only while fully shown: shown on
        both sides of an interval.  So every state must hold >= 2 frames, and go to / come from the base (two
        states in a row would show the base between them)."""
        out = []
        sh = self.shown[name]
        for el, (mat, kind, state, side, cell) in self.decals.items():
            if cell == 0:
                continue
            on = [el in x for x in sh]
            for i in range(len(on)):
                if on[i] and not (i > 0 and on[i - 1]) and not (i + 1 < len(on) and on[i + 1]):
                    out.append(f"{name}: {el} shown on frame {i} only")
        for i in range(len(sh) - 1):
            for el, (mat, kind, state, side, cell) in self.decals.items():
                if cell == 0 or el not in sh[i] or el in sh[i + 1]:
                    continue
                nxt = [e for e in sh[i + 1] if e != el and self.decals.get(e, (None, None, None, None, 0))[1] == kind
                       and self.decals[e][3] == side and self.decals[e][4] != 0]
                if nxt:
                    out.append(f"{name}: {el} -> {nxt[0]} on frames {i} -> {i + 1}")
        return out

    def auto_cheeks(self, poses, loop):
        """Cheeks left automatic turn white on a side whose sparks are out on that frame or a neighbour (a
        state switches on whole frames, so a one-frame crackle still shows its white cheeks)."""
        n = len(poses)
        on = [[any(f"{sd}Spark{j}" in q.spark_on for j in range(SPARK_N2)) for sd in SPARK_SIDES] for q in poses]
        for i, q in enumerate(poses):
            if q.face.get("Cheek") is not None:
                continue
            near = [(j % n) if loop else min(max(j, 0), n - 1) for j in (i - 1, i, i + 1)]
            q.face["Cheek"] = tuple("white" if any(on[j][k] for j in near) else "red" for k in range(2))

    def base_hidden(self, poses, i, loop):
        """Base decals collapsible at frame i: one covering state holds on frame i and both neighbours (a
        sequence's first frame keeps its base, its last frame holds)."""
        out = set()
        n = len(poses)
        for el, (mat, kind, state, side, cell) in self.decals.items():
            if cell != 0:
                continue
            got = []
            for j in (i - 1, i, i + 1):
                if loop:
                    j %= n
                elif j < 0:
                    got.append(state)
                    continue
                elif j >= n:
                    j = n - 1
                got.append(self.want(poses[j], kind, side))
            if len(set(got)) == 1 and got[0] != state:
                out.add(el)
        return out

    def finalize(self, pose, frame_i, hide_base=()):
        """Aim the sparks not aimed this frame (the frame's fan, collapsed) and set every collapse bone.
        Returns the set of shown elements."""
        for sd in SPARK_SIDES:
            if any(f"{sd}Spark{j}" not in pose.spark_set for j in range(SPARK_N2)):
                self.sparks(pose, frame_i, 0.0, side=sd, only_unset=True)
        shown = set()
        for el, (c, ip, im, a) in self.fx.items():
            if self.visible(pose, el, hide_base):
                shown.add(el)
                pose.R[ip] = np.eye(3)
                pose.R[im] = np.eye(3)
            else:
                pose.R[ip] = xform.axis_angle_matrix(a, COLLAPSE_DEG)
                pose.R[im] = xform.axis_angle_matrix(a, -COLLAPSE_DEG)
        return shown

    def index(self, name):
        return name if isinstance(name, (int, np.integer)) else self._index[name]

    def _find_cheeks(self):
        """Centre and outward normal of each red cheek disc, from the texture colour at the vertices."""
        g = self.imp.g
        out = {}
        for s in self.imp.surfaces:
            if s.material < 0 or g.materials[s.material].base_texture is None:
                continue
            img = np.asarray(g.texture_image(g.materials[s.material].base_texture)).astype(np.float64) / 255
            H, W = img.shape[:2]
            uv = s.uv % 1.0
            px = img[np.clip((uv[:, 1] * H).astype(int), 0, H - 1), np.clip((uv[:, 0] * W).astype(int), 0, W - 1)]
            red = (px[:, 0] > 0.6) & (px[:, 1] < 0.3) & (px[:, 2] < 0.3)
            for sy in (1, -1):
                sel = red & (np.sign(s.pos[:, 1]) == sy)
                if sel.sum() >= 4 and sy not in out:
                    n = s.nrm[sel].mean(0)
                    out[sy] = (s.pos[sel].mean(0), n / np.linalg.norm(n))
        if len(out) != 2:
            raise ValueError("official Pikachu: cheeks not found")
        return [out[1], out[-1]]

    # poses ------------------------------------------------------------------------------------
    def rest_pose(self):
        return OPose(self)

    def official(self, t, grounded=True):
        """The official clip's pose at time t (s), feet on the ground (the clip floats above z = 0)."""
        key = round(float(t), 6)
        if key not in self._cache:
            pos, rot = self.imp.local_from_world(self.imp.bone_world(OFFICIAL_ANIM, key))
            p = OPose(self)
            p.T[:self.nmain] = pos
            p.R[:self.nmain] = xform.euler_matrix(rot)
            self._cache[key] = p
        p = self._cache[key].copy()
        if grounded:
            p.T[0, 2] -= self.ground
        return p

    def skin(self, pose, sel=None):
        """Skinned positions of the official mesh's vertices (all, or a boolean selection)."""
        W = pose.world()[:self.nmain]
        S = W.copy()
        S[:, :, 3] = W[:, :, 3] - np.einsum("bij,bj->bi", W[:, :, :3], self.heads[:self.nmain])
        V, B, Wt = (self.V, self.VB, self.VW) if sel is None else (self.V[sel], self.VB[sel], self.VW[sel])
        M = np.einsum("nk,nkij->nij", Wt, S[np.maximum(B, 0)])
        return np.einsum("nij,nj->ni", M[:, :, :3], V) + M[:, :, 3]

    def dominated(self, bones):
        return np.isin(self.VB[:, 0], [self.index(b) for b in bones]) & (self.VW[:, 0] >= 0.5)

    def contact_height(self, bones, Rw):
        """Height of the end bone's head above the lowest of its (and its children's) vertices when the end
        bone has world rotation Rw: the IK target height that puts the limb on the floor."""
        sel = self.dominated(bones)
        h = self.heads[self.index(bones[0])]
        return float(-((self.V[sel] - h) @ np.asarray(Rw).T)[:, 2].min())

    def ik(self, pose, upper, lower, end, target, pole, end_rot=None):
        """Two-bone IK: end's head to `target` (model space), the middle joint toward `pole`; twist kept from
        the current pose (minimal rotations).  end_rot: world rotation of the end bone (None: keep local)."""
        iu, il, ie = self.index(upper), self.index(lower), self.index(end)
        W = pose.world()
        pu = self.parents[iu]
        Rp = W[pu][:, :3] if pu >= 0 else np.eye(3)
        A = W[iu][:, 3]
        off1, off2 = pose.T[il], pose.T[ie]
        L1, L2 = float(np.linalg.norm(off1)), float(np.linalg.norm(off2))
        T = np.asarray(target, dtype=np.float64)
        d = T - A
        D0 = float(np.linalg.norm(d))
        D = min(max(D0, abs(L1 - L2) + 1e-4), L1 + L2 - 1e-4)
        dn = d / max(D0, 1e-9)
        pv = np.asarray(pole, dtype=np.float64)
        pv = pv - dn * (pv @ dn)
        pv = pv / max(np.linalg.norm(pv), 1e-9)
        ca = (L1 * L1 + D * D - L2 * L2) / (2 * L1 * D)
        al = math.acos(max(-1.0, min(1.0, ca)))
        knee = A + L1 * (math.cos(al) * dn + math.sin(al) * pv)
        T2 = A + dn * D
        Wu0 = W[iu][:, :3]
        Wu = _align(Wu0 @ off1, knee - A) @ Wu0
        Wl0 = Wu @ pose.R[il]
        Wl = _align(Wl0 @ off2, T2 - knee) @ Wl0
        pose.R[iu] = Rp.T @ Wu
        pose.R[il] = Wu.T @ Wl
        if end_rot is not None:
            pose.R[ie] = Wl.T @ np.asarray(end_rot)
        return D0 - D        # > 0: out of reach by that much

    # effects ------------------------------------------------------------------------------------
    def spark_dirs(self, side):
        cp, cn = self.cheeks[SPARK_SIDES.index(side)]
        base = cp - cn * SPARK_SINK2
        inward = self.head_center + (0.0, 0.0, 0.5) - base
        return base, inward / np.linalg.norm(inward), cn

    def sparks(self, pose, frame_i, amount=1.0, forward=0.0, side=None, only_unset=False):
        """Aim the cheek sparks out of the cheeks (a fan that changes every frame), shown when amount >= 0.5.
        Hidden ones are aimed too (collapsed): showing them then grows them in place, out of the cheek."""
        for k, sd in enumerate(SPARK_SIDES):
            if side is not None and sd != side:
                continue
            _, inward, cn = self.spark_dirs(sd)
            out = cn + np.array([forward, 0.0, 0.25])
            out /= np.linalg.norm(out)
            e1 = np.cross(out, (0.0, 0.0, 1.0))
            e1 /= np.linalg.norm(e1)
            e2 = np.cross(out, e1)
            for j in range(SPARK_N2):
                nm = f"{sd}Spark{j}"
                if only_unset and nm in pose.spark_set:
                    continue
                az = math.radians(120 * j + 77 * frame_i + 50 * k)
                tilt = math.radians(34 + 14 * ((frame_i + j) % 3 - 1))
                d = math.cos(tilt) * out + math.sin(tilt) * (math.cos(az) * e1 + math.sin(az) * e2)
                pose.R[self.index(nm)] = _align(inward, d)
                pose.spark_set.add(nm)
                if amount >= 0.5:
                    pose.spark_on.add(nm)
                else:
                    pose.spark_on.discard(nm)
        return pose


def _oseq(kit, name, fn, frames, fps, loop=False, activity=0, linear=None, events=()):
    """Sample fn(t, i) -> OPose into an mdl.Sequence (loop: `frames` distinct frames + the first again)."""
    ts = [i / frames for i in range(frames)] if loop else [i / max(frames - 1, 1) for i in range(frames)]
    P, Rr, shown = [], [], []
    poses = [fn(t, i).copy() for i, t in enumerate(ts)]
    kit.auto_cheeks(poses, loop)
    for i, q in enumerate(poses):
        shown.append(kit.finalize(q, i, kit.base_hidden(poses, i, loop)))
        p, r = q.arrays()
        P.append(p)
        Rr.append(r)
    if loop:
        P.append(P[0])
        Rr.append(Rr[0])
        shown.append(shown[0])
    kit.shown[name] = shown
    lm = (0.0, 0.0, 0.0) if linear is None else (float(linear), 0.0, 0.0)
    evs = [e if isinstance(e, mdl.Event) else mdl.Event(frame=int(e[0]), event=int(e[1]),
                                                         options=str(e[2]) if len(e) > 2 else "") for e in events]
    return mdl.Sequence(name=name, pos=np.array(P), rot=np.array(Rr), fps=float(fps),
                        flags=mdl.STUDIO_LOOPING if loop else 0, activity=activity,
                        actweight=1 if activity else 0, events=evs,
                        motiontype=mdl.STUDIO_LX if linear else 0, linearmovement=lm)


def spark_texture(w=32, h=64):
    """Additive spark ribbon texture: s across the ribbon (white-hot core, yellow edges), t along it (fading
    toward the tip); black is nothing (additive)."""
    s = (np.arange(w) + 0.5) / w
    t = (np.arange(h) + 0.5) / h
    across = np.clip(1.0 - np.abs(2 * s - 1), 0, 1)          # 0 at the edges, 1 in the middle
    along = np.clip(1.15 - 0.85 * t, 0, 1)
    core = across[None, :] ** 3.0
    glow = across[None, :] ** 0.8
    a = along[:, None]
    rgb = np.stack([(0.95 * glow + 0.05 * core) * a, (0.82 * glow + 0.18 * core) * a,
                    (0.18 * glow + 0.8 * core) * a], axis=-1)
    rgb[:, [0, -1]] = 0.0
    return np.clip(rgb, 0, 1)


def _spark_geometry(kit):
    """Ribbon meshes of the cheek sparks, built along their hidden (inward) rest direction:
    (verts, faces, st (per vertex, texels), bone per vertex)."""
    verts, faces, st, bones = [], [], [], []
    for k, side in enumerate(SPARK_SIDES):
        base, inward, _ = kit.spark_dirs(side)
        for j in range(SPARK_N2):
            m, (pts, widths) = bolt_mesh(base, inward, SPARK_LEN2, seed=101 + 7 * k + j, w0=0.62, w1=0.26, zig=0.8,
                                         segs=4)
            nv = len(m.verts)
            # bolt_mesh: per ribbon 2 vertices per point (+ the same again for the back side), 2 ribbons
            npts = len(pts)
            per = 2 * npts
            s_col, t_row = [], []
            for v in range(nv):
                r = v % per
                s_col.append(0 if r % 2 == 0 else 31)
                t_row.append(int(round((r // 2) / (npts - 1) * 63)))
            off = sum(len(v) for v in verts)
            verts.append(m.verts)
            faces.append(m.faces + off)
            st.append(np.c_[s_col, t_row])
            bones.append(np.full(nv, kit.index(f"{side}Spark{j}")))
    return np.concatenate(verts), np.concatenate(faces), np.concatenate(st), np.concatenate(bones)


def _add_sparks(st, kit):
    """Append the spark bones' ribbons to the studio: one additive fullbright texture, one mesh in the body
    model (weighted 255 on their bone, model space at rest as the other weighted vertices)."""
    verts, faces, stc, vb = _spark_geometry(kit)
    rgb = spark_texture()
    idx, pal = official.quantize_texture(rgb)
    ti = len(st.textures)
    st.textures.append(mdl.Texture(name="pikachu_spark.bmp", pixels=idx, palette=pal,
                                   flags=mdl.STUDIO_NF_ADDITIVE | mdl.STUDIO_NF_FULLBRIGHT))
    _add_texture(st, ti)
    m = st.bodyparts[0].models[0]
    v0, n0 = len(m.verts), len(m.norms)
    fn = np.cross(verts[faces[:, 1]] - verts[faces[:, 0]], verts[faces[:, 2]] - verts[faces[:, 0]])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    tris = np.zeros((len(faces), 3, 4), np.int64)
    norms, nwb = [], []
    for f in range(len(faces)):
        for c in range(3):
            v = faces[f, c]
            tris[f, c] = (v0 + v, n0 + len(norms), stc[v, 0], stc[v, 1])
            norms.append(fn[f])
            nwb.append(kit.weights_of(kit.names[vb[v]]))
    vwb = [kit.weights_of(kit.names[b]) for b in vb]
    _append_vertices(m, verts, vwb, np.array(norms), nwb)
    m.meshes.append(mdl.Mesh(tris=tris, skinref=ti))


def _add_texture(st, ti):
    if st.skins:
        for fam in st.skins:
            fam.append(ti)


def _append_vertices(m, verts, vwb, norms, nwb):
    """Append weighted vertices / normals ((bones, weights) per item) to model m."""
    vb = np.array([b for b, _ in vwb], np.int64).reshape(-1, 4)
    vw = np.array([w for _, w in vwb], np.int64).reshape(-1, 4)
    nb_ = np.array([b for b, _ in nwb], np.int64).reshape(-1, 4)
    nw = np.array([w for _, w in nwb], np.int64).reshape(-1, 4)
    m.verts = np.vstack([m.verts, np.asarray(verts, float).reshape(-1, 3)])
    m.vert_bone = np.concatenate([m.vert_bone, vb[:, 0]])
    m.norms = np.vstack([m.norms, norms])
    m.norm_bone = np.concatenate([m.norm_bone, nb_[:, 0]])
    m.vert_weights = mdl.BoneWeights(np.vstack([m.vert_weights.bones, vb]), np.vstack([m.vert_weights.weights, vw]))
    m.norm_weights = mdl.BoneWeights(np.vstack([m.norm_weights.bones, nb_]), np.vstack([m.norm_weights.weights, nw]))


def _cell_filter(cell):
    """Copy cell `cell` of a 4-cell vertical atlas over cell 0 (the one the decal maps)."""
    def f(img):
        img = np.array(img, copy=True)
        ch = img.shape[0] // DECAL_CELLS
        img[:ch] = img[cell * ch:(cell + 1) * ch]
        return img
    return f


def _add_decals(st, kit, imp, base="pikachu"):
    """Expression states: the official eye, mouth and cheek decals re-skinned to their collapse bones, and one
    copy per extra state (same vertices and s/t, its own texture baked from that atlas cell)."""
    m = st.bodyparts[0].models[0]
    for mat, kind, per_side, states in DECALS:
        tname = f"{base}_{mat}.bmp"
        ti = next(k for k, t in enumerate(st.textures) if t.name == tname)
        mi = next(k for k, me in enumerate(m.meshes) if me.skinref == ti)
        mesh = m.meshes[mi]
        surf = next(s for s in imp.surfaces if imp._matname(s.material) == mat)
        others = {int(v) for k, me in enumerate(m.meshes) if k != mi for v in me.tris[:, :, 0].ravel()}
        tv = mesh.tris[:, :, 0]
        assert not (set(tv.ravel().tolist()) & others), f"{mat}: decal vertices shared with another mesh"
        sides = (("L", 1), ("R", -1)) if per_side else ((None, 0),)
        side_of = np.sign(m.verts[tv].mean(1)[:, 1])          # per triangle
        for state, cell in states.items():
            if cell == 0:
                ti_s = ti
            else:
                _, _, uv = imp._surface_triangles(surf)
                idx, pal, flags, _, _, _ = imp._texture_for(surf, uv, extra_filter=_cell_filter(cell))
                ti_s = len(st.textures)
                st.textures.append(mdl.Texture(name=f"{base}_{kind}_{state}.bmp", pixels=idx, palette=pal,
                                               flags=flags))
                _add_texture(st, ti_s)
            new_tris = []
            official_tris = mesh.tris.copy()
            for side, sy in sides:
                el = _decal_name(kind, state, side)
                wb = kit.weights_of(el)
                sel = np.ones(len(tv), bool) if sy == 0 else (side_of == sy)
                tr = mesh.tris[sel]
                vs = sorted(set(tr[:, :, 0].ravel().tolist()))
                ns = sorted(set(tr[:, :, 1].ravel().tolist()))
                v0, n0 = len(m.verts), len(m.norms)
                vmap = {v: v0 + k for k, v in enumerate(vs)}
                nmap = {n: n0 + k for k, n in enumerate(ns)}
                if cell == 0:
                    # the official decal: its own vertices re-skinned (the mouth's few % of a neck bone dropped);
                    # its normals copied (the importer shares equal normals with the head around it)
                    m.vert_weights.bones[vs] = wb[0]
                    m.vert_weights.weights[vs] = wb[1]
                    m.vert_bone[vs] = wb[0][0]
                    vmap = {v: v for v in vs}
                    _append_vertices(m, np.zeros((0, 3)), [], m.norms[ns], [wb] * len(ns))
                else:
                    # the same positions as the base decal (and the rim of the face around it: no crack); drawn
                    # after it, the state wins the depth test (studio meshes are drawn in order, GL_LEQUAL)
                    _append_vertices(m, m.verts[vs], [wb] * len(vs), m.norms[ns], [wb] * len(ns))
                tr = tr.copy()
                tr[:, :, 0] = np.vectorize(vmap.get)(tr[:, :, 0])
                tr[:, :, 1] = np.vectorize(nmap.get)(tr[:, :, 1])
                new_tris.append(tr)
                official_tris[sel] = tr
            if cell == 0:
                mesh.tris = official_tris          # same triangle order (side_of stays valid)
            else:
                m.meshes.append(mdl.Mesh(tris=np.concatenate(new_tris), skinref=ti_s))


def fx_check(pm, kit, step=0.1, eps=1e-3):
    """Every collapsible element, sampled at fractional frames as the engine interpolates them: the largest
    area (units^2) of a hidden element (hidden on both sides of the sample), and the smallest area of a shown
    one.  Hidden must stay below eps everywhere: nothing moves through visible space or shows through a
    translucent corpse."""
    m = pm.bodyparts[0].models[0]
    wb = np.asarray(m.vert_weights.bones)
    tri_el = {}
    for me in m.meshes:
        for tr in me.tris:
            v = tr[:, 0]
            b = int(wb[v[0], 1])
            for el, (c, ip, im, a) in kit.fx.items():
                if b == ip:
                    tri_el.setdefault(el, []).append(v)
                    break
    tri_el = {k: np.array(v) for k, v in tri_el.items()}
    missing = set(kit.fx) - set(tri_el)
    assert not missing, f"elements without triangles: {sorted(missing)}"
    worst_hidden, worst_where, min_shown = 0.0, None, np.inf
    names = [s["name"] for s in pm.sequences]
    for si, name in enumerate(names):
        shown = kit.shown[name]
        nf = pm.sequences[si]["numframes"]
        for f in np.arange(0.0, nf - 1 + 1e-9, step):
            f = min(float(f), nf - 1.0)
            a, b = int(math.floor(f + 1e-9)), min(int(math.ceil(f - 1e-9)), nf - 1)
            V, _ = mdl.posed_model(pm, m, mdl.pose(pm, si, f))
            for el, T_ in tri_el.items():
                P = V[T_]
                area = float(np.linalg.norm(np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]), axis=1).sum() / 2)
                hid = el not in shown[a] and el not in shown[b]
                if hid and area > worst_hidden:
                    worst_hidden, worst_where = area, (name, round(f, 2), el)
                if el in shown[a] and el in shown[b]:
                    min_shown = min(min_shown, area)
    return worst_hidden, worst_where, min_shown


def collapse_consistency(pm, kit):
    """Largest spread of a collapse bone's decoded local transform (quaternion up to sign, position) over all
    the frames of all sequences where its element is hidden: 0 means any blend of hidden frames stays hidden."""
    names = [s["name"] for s in pm.sequences]
    ref, worst = {}, 0.0
    for si, name in enumerate(names):
        shown = kit.shown[name]
        nf = pm.sequences[si]["numframes"]
        for fr in range(nf):
            pos, q = mdl.calc_rotations(pm, si, float(min(fr, nf - 1)))
            for el, (c, ip, im, a) in kit.fx.items():
                if el in shown[fr]:
                    continue
                for b in (ip, im):
                    cur = (np.asarray(q[b], float), np.asarray(pos[b], float))
                    if b not in ref:
                        ref[b] = cur
                        continue
                    q0, p0 = ref[b]
                    dq = min(np.abs(cur[0] - q0).max(), np.abs(cur[0] + q0).max())
                    worst = max(worst, float(dq), float(np.abs(cur[1] - p0).max()))
    return worst


HITBOX_BONES = ("Spine1", "Spine2", "Head", "Hips", "LArm", "LForeArm", "LHand", "RArm", "RForeArm", "RHand",
                "LThigh", "LLeg", "LFoot", "RThigh", "RLeg", "RFoot", "Tail2", "Tail3", "Feeler")


def official_model(path=None, verbose=False, return_checks=False, only=None):
    """models/pokemon/pikachu.mdl from the official glTF (path: default official_source())."""
    src = path or official_source()
    imp = official.Importer(src, height=OFFICIAL_HEIGHT, height_pose=(OFFICIAL_ANIM, 0.0),
                            place=(OFFICIAL_ANIM, 0.0), verbose=verbose)
    kit = Kit(imp)
    seqs, checks = official_sequences(kit, only)
    nm = kit.nmain
    trimmed = [dataclasses.replace(s, pos=s.pos[:, :nm], rot=s.rot[:, :nm]) for s in seqs]
    # attack origin: in front of the mouth, between the cheeks
    head = kit.index("Head")
    mouth = [s for s in imp.surfaces if imp._matname(s.material) == "Mouth"]
    mx = max(float(s.pos[:, 0].max()) for s in mouth) if mouth else float(kit.V[kit.VB[:, 0] == head][:, 0].max())
    zap = np.array([mx + 0.4, 0.0, float(np.mean([c[0][2] for c in kit.cheeks])) + 0.5])
    st = imp.studio("pokemon/pikachu.mdl", trimmed, attachments=[("zap", "Head", zap), ("zap2", "Head", zap)],
                    hitbox_bones=HITBOX_BONES, eyeposition=(0.0, 0.0, 20.0), hull=((-16, -16, 0), (16, 16, 36)))
    for i in range(nm, len(kit.names)):
        st.bones.append(mdl.Bone(name=kit.names[i], parent=kit.parents[i], pos=tuple(kit.rest[i]), rot=(0.0, 0.0, 0.0)))
    for s, t in zip(seqs, trimmed):
        s.bbmin, s.bbmax = t.bbmin, t.bbmax
    st.sequences = seqs
    _add_sparks(st, kit)
    _add_decals(st, kit, imp)
    data = mdl.write(st)
    pm = mdl.read(data)
    # hidden sparks / expression states: zero area at every interpolated frame; states held whole frames
    hid, where, shown = fx_check(pm, kit)
    checks["fx_hidden_max_area"] = hid
    checks["fx_hidden_worst"] = where
    checks["fx_shown_min_area"] = shown
    if hid >= 1e-3:
        raise ValueError(f"official Pikachu: a hidden effect / expression shows ({hid:.4f} units^2 at {where})")
    # hidden under ANY blend (frame interpolation, the engine's 0.2 s sequence crossfade, per-bone slerp): every
    # collapse bone has one local transform wherever its element is hidden, in every sequence, so a slerp between
    # two hidden frames of any sequences is that same transform (the carrier's pose does not matter)
    xf = collapse_consistency(pm, kit)
    checks["fx_collapse_spread"] = xf
    if xf > 1e-4:
        raise ValueError(f"official Pikachu: collapse bones differ between hidden frames ({xf:.6f})")
    if "idle" in kit.shown:
        calm = sorted({e for x in kit.shown["idle"] for e in x if e in FX_NAMES or e.startswith("Cheek_white")})
        if calm:
            raise ValueError(f"official Pikachu: idle (the buy menu's preview) shows {calm}")
    probs = [x for s_ in st.sequences for x in kit.expression_problems(s_.name)]
    checks["expression_problems"] = probs
    if probs:
        raise ValueError("official Pikachu: " + "; ".join(probs))
    if return_checks:
        return data, checks
    return data


def build(out):
    src = official_source()
    out["models/pokemon/pikachu.mdl"] = official_model(src) if src else generated_model()


def pchip(x, xs, ys):
    """Monotone piecewise-cubic interpolation (Fritsch-Carlson) of the keys (xs, ys) at x (clamped)."""
    xs = np.asarray(xs, float)
    ys = np.asarray(ys, float)
    if x <= xs[0]:
        return float(ys[0])
    if x >= xs[-1]:
        return float(ys[-1])
    h = np.diff(xs)
    d = np.diff(ys) / h
    m = np.zeros(len(xs))
    for k in range(1, len(xs) - 1):
        if d[k - 1] * d[k] > 0:
            w1, w2 = 2 * h[k] + h[k - 1], h[k] + 2 * h[k - 1]
            m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k])
    m[0], m[-1] = d[0], d[-1]
    k = int(np.searchsorted(xs, x) - 1)
    u = (x - xs[k]) / h[k]
    h00, h10, h01, h11 = 2 * u ** 3 - 3 * u ** 2 + 1, u ** 3 - 2 * u ** 2 + u, -2 * u ** 3 + 3 * u ** 2, u ** 3 - u ** 2
    return float(h00 * ys[k] + h10 * h[k] * m[k] + h01 * ys[k + 1] + h11 * h[k] * m[k + 1])


def _ears(p, back=0.0, spread=0.0, twist=0.0, tip=0.0, l=None, r=None):
    """Both ears (mirrored): back = pitched back (deg), spread = out to the side, twist = turned outward,
    tip = the upper segments curling back; l / r: extra (back, spread, twist) for one ear."""
    for side, sx, extra in (("L", 1, l), ("R", -1, r)):
        b, s_, tw = back, spread, twist
        if extra is not None:
            b, s_, tw = b + extra[0], s_ + extra[1], tw + extra[2]
        p.rot(f"{side}Ear1", x=-sx * s_, y=-b, z=sx * tw)
        if tip:
            p.rot(f"{side}Ear2", y=-0.6 * tip)
            p.rot(f"{side}Ear3", y=-0.4 * tip)
    return p


def _tail(p, angles):
    """(pitch, yaw) per tail bone: pitch > 0 raises it (toward the back), yaw > 0 swings it to the left."""
    for b, (pt, yw) in zip(("Tail1", "Tail2", "Tail3"), angles):
        p.rot(b, y=pt, z=yw)
    return p


def official_sequences(kit, only=None):
    """The eight contract sequences on the official skeleton, and the measured checks."""
    seqs, checks = {}, {}
    W = R.wave
    stance = kit.official(0.0)
    Wst = stance.world()
    LEGS2 = (("L", 1), ("R", -1))

    def leg_chain(s):
        return (f"{s}Thigh", f"{s}Leg", f"{s}Foot")

    def arm_chain(s):
        return (f"{s}Arm", f"{s}ForeArm", f"{s}Hand")

    def knee_pole(ref_w, s):
        a, b, c = (ref_w[kit.index(n)][:, 3] for n in leg_chain(s))
        d = c - a
        v = (b - a) - d * ((b - a) @ d) / (d @ d)
        return v / np.linalg.norm(v)

    def plant(p, ref=stance, offsets=None):
        """Feet back where they are in `ref` (positions and world rotations), plus model-space offsets."""
        rw = ref.world()
        for k, (s, sx) in enumerate(LEGS2):
            u, l, e = leg_chain(s)
            tgt = rw[kit.index(e)][:, 3].copy()
            if offsets is not None:
                tgt = tgt + offsets[k]
            kit.ik(p, u, l, e, tgt, knee_pole(rw, s), rw[kit.index(e)][:, :3])
        return p

    def want(name):
        return only is None or name in only

    def floor(p):
        """Nothing below the floor: raise the whole body if a vertex went under z = 0."""
        mz = float(kit.skin(p)[:, 2].min())
        if mz < 0:
            p.T[0, 2] -= mz
        return p


    # ------------------------------------------------------------------ idle (3.2 s loop)
    IDLE_FRAMES, IDLE_FPS = 48, 15

    def idle(t, i):
        p = stance.copy()
        br = R.breathe(t, freq=2)
        sway = W(t, 1, 0.1)
        bob = 0.5 - 0.5 * math.cos(2 * math.pi * 2 * t)    # two soft knee bounces a cycle
        p.move("Waist", y=0.25 * sway, z=-0.35 * bob)
        p.rot("Waist", x=-1.5 * sway)
        p.rot("Spine1", y=1.2 * br, x=1.0 * sway)
        p.rot("Spine2", y=0.8 * br)
        look = R.keys(t, [(0, 0), (0.15, 0), (0.27, 14), (0.45, 14), (0.57, -9), (0.72, -9), (0.84, 0), (1.0, 0)],
                      interp="smooth", loop=True)
        tilt = R.keys(t, [(0, 0), (0.16, 0), (0.28, -8), (0.45, -8), (0.58, 5), (0.72, 5), (0.86, 0), (1.0, 0)],
                      interp="smooth", loop=True)
        p.rot("Head", x=tilt + 1.2 * sway, y=-1.4 * br + 1.5 * bob, z=look)
        f1 = R.pulse(t, 0.30, 0.32, 0.34, 0.40)
        f2 = R.pulse(t, 0.76, 0.78, 0.80, 0.86)
        _ears(p, back=1.5 * W(t, 2) - 6 * f2, spread=1.0 * W(t, 2, 0.2), tip=-5 * f2 + 3 * bob,
              r=(-8 * f1, 6 * f1, -10 * f1))
        p.rot("LArm", y=-2.0 * bob, x=-1.0 * br)
        p.rot("RArm", y=-2.0 * bob, x=1.0 * br)
        tw = R.chain_wave(t, 3, 6, lag=0.1, freq=2)
        _tail(p, [(2.0 * W(t, 2, 0.3) - 2 * bob, tw[0] - 3 * sway), (1.5 * bob, tw[1]), (0, tw[2])])
        # a calm stance: no crackle (idle is also the buy menu's preview, which starts at frame 0 and would land on
        # it ~2 s after opening; sparks and white cheeks belong to attack, spawn and victory)
        # two blinks a loop (0.13 s)
        p.expr(eye="closed" if (9 <= i <= 11 or 39 <= i <= 41) else "open")
        return plant(p)

    if want("idle"):
        seqs["idle"] = _oseq(kit, "idle", idle, IDLE_FRAMES, IDLE_FPS, loop=True, activity=mdl.ACT["IDLE"])

    # ------------------------------------------------------------------ attack: the official Thunderbolt
    ATK_FRAMES, ATK_FPS = 34, 30.0        # 1.1 s (the server's Thunderbolt interval), the hit at 40 %
    ATK_U = (0.0, 0.06, 0.12, 0.22, 0.34, 0.56, 0.68, 0.80, 1.0)
    ATK_SRC = (0.0, 0.15, 0.80, 0.95, 1.20, 2.40, 2.80, 3.00, 3.40)
    ATK_HOP = 0.5                         # the leap at half the official height (it repeats every 1.1 s)
    z_stance = stance.T[0, 2]

    def attack(t, i):
        src = pchip(t, ATK_U, ATK_SRC)
        p = kit.official(src)
        p.T[0, 2] = z_stance + ATK_HOP * (p.T[0, 2] - z_stance) if p.T[0, 2] > z_stance else p.T[0, 2]
        p = oblend(p, stance, R.window(t, 0.9, 1.0))
        crackle = 1.0 if (0.14 < t < 0.3 and i % 2 == 0) else 0.0
        kit.sparks(p, i, max(crackle, R.pulse(t, 0.3, 0.32, 0.62, 0.64)), forward=0.8)
        # squints charging up, shouts from the anticipation to the release
        p.expr(eye="half" if 5 <= i <= 8 else "open", mouth="wide" if 9 <= i <= 18 else "closed")
        return floor(p)

    if want("attack"):
        seqs["attack"] = _oseq(kit, "attack", attack, ATK_FRAMES, ATK_FPS, activity=mdl.ACT["RANGE_ATTACK1"])

    # ------------------------------------------------------------------ quadruped gaits
    # On all fours like the games' overworld Pikachu: the whole body pitched forward about the waist, the back
    # bent down to the shoulders, the hips partly back under it, the head pitched back up to look ahead.
    # Every planted paw moves backward in model space at exactly the sequence's linearmovement rate (no
    # sliding: measured on the skinned mesh in checks); a hind foot that cannot reach rolls onto its toes.
    vs = lambda u: R.smoothstep(R.clamp01(u))

    def quad_body(th, lift=0.0, hips=0.25, spine=(14.0, 6.0), head=0.0, roll=0.0, yaw=0.0, x=0.0):
        p = kit.rest_pose()
        p.move("Waist", x=x, z=lift)
        p.rot("Waist", x=roll, y=th, z=yaw)
        p.rot("Hips", y=-hips * th)
        p.rot("Spine1", y=spine[0])
        p.rot("Spine2", y=spine[1])
        p.rot("Head", y=-(th + spine[0] + spine[1]) + 14 + head)
        return p

    H_FOOT = kit.contact_height(("LFoot", "LToe"), np.eye(3))
    HAND_PITCH = 62.0
    H_HAND = kit.contact_height(("LHand",), xform.rot_deg(0, HAND_PITCH, 0))

    def toe_pivot(s):
        """The front of the sole (foot flat, relative to the foot's head): what a foot rolls on."""
        sel = kit.dominated((f"{s}Foot", f"{s}Toe"))
        h = kit.heads[kit.index(f"{s}Foot")]
        v = kit.V[sel] - h
        sole = v[v[:, 2] < v[:, 2].min() + 0.3]
        return sole[np.argmax(sole[:, 0])] * (1, 0, 1)

    PIVOT = {s: toe_pivot(s) for s, _ in LEGS2}

    def track(u, duty, S, x_front, lift, back=0.0, reach=0.0, rise=0.85):
        """Paw path (x, dz, swing fraction or -1 in stance): planted from x_front back by S over the stance,
        then a swing forward with an arc; `back` = extra trail behind after lift-off, `reach` = overshoot
        forward before touch-down; rise < 1 lifts the paw off sooner (clear of the floor on the first swing
        frame, before the body passes it)."""
        if u < duty:
            return x_front - S * u / duty, 0.0, -1.0
        s = (u - duty) / (1 - duty)
        x = x_front - S + S * vs(s) - back * math.sin(math.pi * R.clamp01(s / 0.6)) \
            + reach * math.sin(math.pi * R.clamp01((s - 0.45) / 0.55))
        return x, lift * math.sin(math.pi * s) ** rise, s

    def place_leg(p, s, x, y, dz, pitch, planted):
        Rw = xform.rot_deg(0, pitch, 0)
        if not planted:
            h = kit.contact_height((f"{s}Foot", f"{s}Toe"), Rw)
            return kit.ik(p, *leg_chain(s), (x, y, h + dz), (1.0, 0.0, 0.0), Rw)
        # planted: flat, or rolled onto the toes as far as needed to stay in reach
        piv = np.array([x + PIVOT[s][0], y, H_FOOT + PIVOT[s][2]])
        for roll in range(0, 75, 3):
            Rr = xform.rot_deg(0, roll, 0)
            ankle = piv + Rr @ np.array([-PIVOT[s][0], 0.0, -PIVOT[s][2]])
            q = p.copy()
            miss = kit.ik(q, *leg_chain(s), ankle, (1.0, 0.0, 0.0), Rr)
            if miss <= 1e-6:
                break
        p.R[:], p.T[:] = q.R, q.T
        return miss

    def place_limbs(p, u, duty_h, duty_f, L, specs, rise=0.85):
        """specs: per limb (kind, side, phase, x_front, y, lift, back, reach, pitch fn(swing fraction))."""
        miss = 0.0
        for kind, s, ph, x_front, y, lift, back, reach, pitch_fn in specs:
            uu = (u - ph) % 1.0
            duty = duty_h if kind == "leg" else duty_f
            x, dz, sw = track(uu, duty, duty * L, x_front, lift, back, reach, rise)
            pitch = pitch_fn(sw)
            if kind == "leg":
                m = place_leg(p, s, x, y, dz, pitch, sw < 0)
            else:
                Rw = xform.rot_deg(0, pitch, 0)
                h = H_HAND if sw < 0 else kit.contact_height((f"{s}Hand",), Rw)
                m = kit.ik(p, *arm_chain(s), (x, y, h + dz), (-1.0, 0.25 * (1 if s == "L" else -1), 0.0), Rw)
            if sw < 0:
                miss = max(miss, m)
        return miss

    def slip(fn, frames, linear, limbs=(("LFoot", "LToe"), ("RFoot", "RToe"), ("LHand",), ("RHand",)), ground=0.1):
        """Largest sliding of a planted paw (units per frame): the vertices on the ground in two successive
        frames must move back by exactly linear / frames."""
        step = linear / frames
        pts = [kit.skin(fn(i / frames, i)) for i in range(frames + 1)]
        worst = 0.0
        for bones in limbs:
            sel = kit.dominated(bones)
            for i in range(frames):
                a, b = pts[i][sel], pts[i + 1][sel]
                on = (a[:, 2] < ground) & (b[:, 2] < ground)
                if on.sum() >= 3:
                    d = (b[on] - a[on]) + (step, 0.0, 0.0)
                    worst = max(worst, float(np.abs(d[:, :2]).max()))
        return worst

    def clearance(fn, frames):
        """Lowest point of the trunk and head over the cycle (the belly must not drag)."""
        sel = kit.dominated(("Spine1", "Spine2", "Head", "Hips", "Feeler"))
        return min(float(kit.skin(fn(i / frames, i), sel)[:, 2].min()) for i in range(frames))

    # walk: a brisk running trot (diagonal pairs, short suspensions)
    WALK_FRAMES, WALK_FPS = 12, 60.0
    walk_linear = 125.0 * WALK_FRAMES / WALK_FPS          # 25 units per cycle at 125 u/s
    WALK_DUTY = 0.3

    def walk(t, i):
        ph2 = (2 * t) % 1.0
        bob = math.cos(2 * math.pi * (ph2 - 0.15))           # low at mid-stance, up in the suspension
        side = W(t, 1, 0.0)
        p = quad_body(60, 0.3 + 0.45 * bob, spine=(14 - 2 * bob, 6), head=-3 * bob, roll=3 * side, yaw=2.5 * side)
        _ears(p, back=14 - 7 * W(2 * t, 1, -0.1), spread=4, tip=8 + 6 * W(2 * t, 1, -0.2))
        tw = R.chain_wave(t, 3, 8, lag=0.12)
        _tail(p, [(-50 + 6 * W(2 * t, 1, -0.1), tw[0]), (4 * W(2 * t, 1, -0.25), tw[1]), (5 * W(2 * t, 1, -0.4), tw[2])])
        hp = lambda sw: 0.0 if sw < 0 else 45 * math.sin(math.pi * min(1.0, sw / 0.8))
        fp = lambda sw: HAND_PITCH if sw < 0 else HAND_PITCH + 35 * math.sin(math.pi * sw) - 25 * R.pulse(sw, 0.5, 0.75, 0.85, 1.0)
        specs = [("leg", "L", 0.0, 4.4, 4.2, 2.4, 1.0, 0.0, hp), ("leg", "R", 0.5, 4.4, -4.4, 2.4, 1.0, 0.0, hp),
                 ("arm", "L", 0.5, 12.0, 5.4, 2.8, 0.0, 1.0, fp), ("arm", "R", 0.0, 12.0, -5.6, 2.8, 0.0, 1.0, fp)]
        place_limbs(p, t, WALK_DUTY, WALK_DUTY, walk_linear, specs)
        return p

    if want("walk"):
        seqs["walk"] = _oseq(kit, "walk", walk, WALK_FRAMES, WALK_FPS, loop=True, activity=mdl.ACT["WALK"],
                             linear=walk_linear)
        checks["walk_slip"] = slip(walk, WALK_FRAMES, walk_linear)
        checks["walk_clearance"] = clearance(walk, WALK_FRAMES)

    # run: the dash, a half bound (hind feet nearly together, the front paws one after the other)
    RUN_FRAMES, RUN_FPS = 12, 60.0
    run_linear = 300.0 * RUN_FRAMES / RUN_FPS             # 60 units per cycle at 300 u/s
    RUN_DUTY_H, RUN_DUTY_F = 0.15, 0.13

    def run(t, i):
        ext = R.keys(t, [(0.0, 0.2), (0.15, 0.8), (0.3, 1.0), (0.45, 0.4), (0.6, -0.4), (0.8, -1.0), (1.0, 0.2)], loop=True)
        up = R.keys(t, [(0.0, 0.1), (0.1, 0.0), (0.3, 1.0), (0.5, 0.0), (0.62, 0.1), (0.82, 0.7), (1.0, 0.1)], loop=True)
        rock = R.keys(t, [(0.0, -1.0), (0.3, 0.0), (0.55, 1.0), (0.8, 0.0), (1.0, -1.0)], loop=True)
        p = quad_body(62 + 8 * rock, 0.0 + 3.0 * up, hips=0.25 + 0.2 * ext, spine=(14 - 9 * ext, 6 - 6 * ext),
                      head=-8 * rock + 3 * ext)
        lag = R.keys((t - 0.1) % 1.0, [(0.0, 0.1), (0.1, 0.0), (0.3, 1.0), (0.5, 0.0), (0.62, 0.1), (0.82, 0.7),
                                         (1.0, 0.1)], loop=True)
        _ears(p, back=50 + 12 * lag, spread=-16, twist=-10, tip=12 - 10 * lag)
        tw = R.chain_wave(t, 3, 5, lag=0.12)
        _tail(p, [(-70 + 10 * W(t, 1, 0.05), tw[0]), (4 + 6 * W(t, 1, -0.1), tw[1]), (8 * W(t, 1, -0.25), tw[2])])
        # swinging hind foot: at most ~25 degrees toe-down, folded up under the haunch (not a spike below it)
        hp = lambda sw: 0.0 if sw < 0 else 25 * math.sin(math.pi * R.clamp01(sw / 0.7))
        fp = lambda sw: HAND_PITCH if sw < 0 else HAND_PITCH + 50 * math.sin(math.pi * R.clamp01(sw / 0.6)) - 30 * R.pulse(sw, 0.55, 0.75, 0.9, 1.0)
        specs = [("leg", "L", 0.0, 6.0, 4.0, 3.4, 1.0, 1.0, hp), ("leg", "R", 0.04, 6.0, -4.2, 3.4, 1.0, 1.0, hp),
                 ("arm", "L", 0.45, 13.0, 5.2, 3.0, 1.5, 2.0, fp), ("arm", "R", 0.52, 13.0, -5.4, 3.0, 1.5, 2.0, fp)]
        place_limbs(p, t, RUN_DUTY_H, RUN_DUTY_F, run_linear, specs, rise=0.4)
        return p

    if want("run"):
        seqs["run"] = _oseq(kit, "run", run, RUN_FRAMES, RUN_FPS, loop=True, activity=mdl.ACT["RUN"],
                            linear=run_linear)
        checks["run_slip"] = slip(run, RUN_FRAMES, run_linear)
        checks["run_clearance"] = clearance(run, RUN_FRAMES)

    # ------------------------------------------------------------------ helpers for the standing sequences
    def arm_to(p, s, off, pole=(-0.6, 0.0, -0.8), hand=None):
        """Hand (its head) to shoulder + off (model space); elbow toward pole (mirrored in y for R)."""
        sx = 1 if s == "L" else -1
        sh = p.world()[kit.index(f"{s}Arm")][:, 3]
        o = np.array([off[0], off[1] * sx, off[2]], float)
        pl = np.array([pole[0], pole[1] * sx, pole[2]], float)
        kit.ik(p, *arm_chain(s), sh + o, pl, hand)
        return p

    def hand_off(p, s):
        W_ = p.world()
        sx = 1 if s == "L" else -1
        d = W_[kit.index(f"{s}Hand")][:, 3] - W_[kit.index(f"{s}Arm")][:, 3]
        return np.array([d[0], d[1] * sx, d[2]])

    ST_HAND = {s: hand_off(stance, s) for s, _ in LEGS2}

    def arms_blend(p, offs_l, offs_r=None, pole=(-0.6, 0.0, -0.8)):
        arm_to(p, "L", offs_l, pole)
        arm_to(p, "R", offs_l if offs_r is None else offs_r, pole)
        return p

    def lerp(a, b, w):
        return np.asarray(a, float) * (1 - w) + np.asarray(b, float) * w

    def ground_shift(p, keep=1.0, allow_below=0.0):
        """Raise / lower the whole body so its lowest vertex touches the floor (weight keep)."""
        mz = float(kit.skin(p)[:, 2].min())
        p.T[0, 2] -= keep * (mz + allow_below)
        return p

    # ------------------------------------------------------------------ flinch (0.37 s)
    FLINCH_FRAMES, FLINCH_FPS = 12, 30.0

    def flinch(t, i):
        k = R.keys(t, [(0, 0), (0.14, 1.0), (0.42, 0.7), (0.8, 0.12), (1.0, 0)], interp="smooth")
        e = R.keys(t, [(0, 0), (0.1, 0.6), (0.24, 1.0), (0.6, 0.5), (1.0, 0)], interp="smooth")
        p = stance.copy()
        p.move("Waist", x=-0.9 * k, z=-0.5 * k)
        p.rot("Waist", y=-9 * k, x=3 * k)
        p.rot("Spine1", y=-6 * k)
        p.rot("Spine2", y=-5 * k)
        p.rot("Head", y=-12 * k, x=10 * k, z=-10 * k)
        _ears(p, back=34 * e, spread=12 * e, tip=10 * e)
        plant(p, offsets=((-0.5 * k, 0, 0), (-0.2 * k, 0, 0)))
        arms_blend(p, lerp(ST_HAND["L"], (2.2, 0.6, 3.6), k), lerp(ST_HAND["R"], (2.6, 0.2, 3.0), k))
        _tail(p, [(14 * e, 0), (8 * e, 0), (-6 * e, 0)])
        # eyes squeezed shut, mouth open
        p.expr(eye="closed" if 1 <= i <= 6 else "open", mouth="open" if 1 <= i <= 6 else "closed")
        return p

    if want("flinch"):
        seqs["flinch"] = _oseq(kit, "flinch", flinch, FLINCH_FRAMES, FLINCH_FPS, activity=mdl.ACT["SMALL_FLINCH"])

    # ------------------------------------------------------------------ die: faints, falls on its right side
    DIE_FRAMES, DIE_FPS = 36, 30.0                         # 1.17 s, the last frame holds
    LIE_ROLL = 84.0

    def die(t, i):
        hit = R.keys(t, [(0, 0), (0.08, 1.0), (0.22, 0.6), (0.4, 0.2), (1.0, 0.0)], interp="smooth")
        buckle = R.keys(t, [(0.12, 0.0), (0.38, 1.0), (1.0, 1.0)], interp="smooth")
        fall = R.ease_in(R.clamp01((t - 0.36) / 0.3))
        bounce = R.keys(t, [(0.66, 0.0), (0.74, 1.0), (0.84, 0.0), (0.9, 0.25), (1.0, 0.0)], interp="smooth")
        limp = R.window(t, 0.5, 0.85)
        p = stance.copy()
        # recoil, then the knees give way and it sways to its right
        p.move("Waist", x=-0.8 * hit, z=-1.6 * buckle)
        p.rot("Waist", y=-8 * hit + 10 * buckle * (1 - fall), x=6 * buckle * (1 - fall))
        p.rot("Spine1", y=-5 * hit + 6 * buckle)
        p.rot("Head", y=-14 * hit + 22 * buckle, x=12 * hit - 6 * buckle, z=-8 * hit)
        _ears(p, back=30 * hit + 25 * buckle, spread=10 * hit + 25 * limp, tip=10 + 20 * limp)
        if t < 0.5:
            plant(p, offsets=((-0.4 * hit, 0, 0), (-0.2 * hit, 0, 0)))
        arms_blend(p, lerp(lerp(ST_HAND["L"], (2.0, 0.8, 3.2), hit), (1.2, 2.2, -4.2), limp),
                   lerp(lerp(ST_HAND["R"], (2.4, 0.4, 2.8), hit), (2.6, 0.0, -4.5), limp))
        # topples about its right foot onto its right side; legs, arms, ears and tail go limp
        piv = np.array([1.3, -4.6, 0.0])
        roll = LIE_ROLL * fall - 6 * bounce
        M = xform.rot_deg(roll, 0, 0)
        Wst0 = p.world()[0]
        p.R[0] = M @ p.R[0]
        p.T[0] = piv + M @ (p.T[0] - piv)
        p.rot("Head", x=12 * limp, y=-10 * limp)
        p.rot("LThigh", y=10 * limp, x=-6 * limp)
        p.rot("RThigh", y=18 * limp, x=6 * limp)
        p.rot("LLeg", y=-14 * limp)
        p.rot("RLeg", y=-20 * limp)
        # both ears flop along the floor, past the top of the head
        if limp > 0:
            for side in ("L", "R"):
                Wd = p.world()
                Rh = Wd[kit.index("Head")][:, :3]
                a = Wd[kit.index(f"{side}Ear1")][:, 3]
                cur = Wd[kit.index(f"{side}Ear3")][:, 3] - a
                tgt = Rh[:, 2] - 0.18 * np.array([0.0, 0.0, 1.0]) - 0.35 * Rh[:, 0] + (0.25 if side == "L" else -0.1) * Rh[:, 1]
                M_ = _slerp_m(np.eye(3), _align(cur, tgt), limp)
                p.turn(f"{side}Ear1", M=M_)
        # the tail swings down into the body's plane and lies flat on the floor behind it
        lay = R.window(t, 0.45, 0.8)
        for b, M_ in (("Tail1", xform.rot_deg(16, -6, 0)), ("Tail2", xform.rot_deg(6, 4, 0)), ("Tail3", np.eye(3))):
            p.R[kit.index(b)] = _slerp_m(p.R[kit.index(b)], M_, lay)
        if t > 0.36:
            ground_shift(p, R.window(t, 0.4, 0.72))
        # winces with a cry, then faints: eyes closed to the end
        p.expr(eye="open" if i < 2 else "closed", mouth="wide" if 1 <= i <= 7 else "closed")
        return floor(p)

    if want("die"):
        seqs["die"] = _oseq(kit, "die", die, DIE_FRAMES, DIE_FPS, activity=mdl.ACT["DIESIMPLE"])
        end = die(1.0, DIE_FRAMES - 1)
        sk = kit.skin(end)
        checks["die_end_min_z"] = float(sk[:, 2].min())
        checks["die_end_max_z"] = float(sk[:, 2].max())

    # ------------------------------------------------------------------ spawn: out of the ball, "Pika!" (1 s)
    SPAWN_FRAMES, SPAWN_FPS = 31, 30.0

    def spawn(t, i):
        curl = 1 - R.window(t, 0.08, 0.3, R.ease_out)
        hop = R.keys(t, [(0.0, 0.0), (0.1, 0.0), (0.24, 1.0), (0.38, 0.0), (1.0, 0.0)], interp="smooth")
        land = R.keys(t, [(0.34, 0.0), (0.42, 1.0), (0.5, 0.3), (1.0, 0.0)], interp="smooth")
        pika = R.pulse(t, 0.42, 0.52, 0.8, 0.95)
        buzz = (1 if i % 2 else -1) * R.pulse(t, 0.5, 0.54, 0.76, 0.8)
        p = stance.copy()
        p.move("Waist", z=-2.6 * curl - 1.4 * land - 0.9 * pika + 5.5 * hop, x=1.0 * pika)
        p.rot("Waist", y=26 * curl + 18 * pika, x=0.8 * buzz)
        p.rot("Spine1", y=10 * curl + 6 * pika)
        p.rot("Spine2", y=8 * curl + 3 * pika)
        p.rot("Head", y=26 * curl - 22 * pika - 6 * hop, x=1.5 * buzz, z=0.8 * buzz)
        _ears(p, back=40 * curl - 16 * pika - 10 * hop, spread=-4 * pika + 10 * curl, tip=-8 * pika + 2 * buzz)
        if t < 0.12 or t > 0.36:
            plant(p, offsets=((0.2 * pika, 0.7 * pika, 0), (0.2 * pika, -0.7 * pika, 0)))
        # arms: tucked in the ball, flung out in the hop, braced out and down at its sides for the "Pika!"
        off = lerp(ST_HAND["L"], (1.0, -1.2, -1.5), curl)
        off = lerp(off, (1.5, 2.4, 2.5), hop)
        off = lerp(off, (1.6, 4.2, -3.2), pika)
        arms_blend(p, off, pole=(-0.6, 0.3, -0.8))
        _tail(p, [(-20 * curl + 16 * pika, 6 * W(t, 4) * (1 - curl) + 2 * buzz), (10 * pika, 0), (6 * pika, 0)])
        kit.sparks(p, i, 1.0 if (pika > 0.45 and i % 3 != 2) else 0.0, forward=0.2)
        # eyes shut curled up in the ball, open in the hop; "Pika!" with happy closed eyes, mouth wide
        eye = "closed" if (i <= 4 or 15 <= i <= 24) else "open"
        p.expr(eye=eye, mouth="wide" if 14 <= i <= 25 else "closed")
        return floor(p)

    if want("spawn"):
        seqs["spawn"] = _oseq(kit, "spawn", spawn, SPAWN_FRAMES, SPAWN_FPS, activity=mdl.ACT["ARM"])

    # ------------------------------------------------------------------ victory: cheering hops (2 s)
    VIC_FRAMES, VIC_FPS = 48, 24.0

    def victory(t, i):
        hops = [(0.06, 0.3), (0.38, 0.62)]
        hop = sum(math.sin(math.pi * R.clamp01((t - a) / (b - a))) ** 1.2 for a, b in hops)
        squash = sum(R.pulse(t, a - 0.06, a, a, a + 0.05) + R.pulse(t, b - 0.02, b + 0.03, b + 0.03, b + 0.1)
                     for a, b in hops)
        cheer = R.pulse(t, 0.04, 0.14, 0.62, 0.72)
        wave_ = R.pulse(t, 0.66, 0.74, 0.9, 0.98)
        p = stance.copy()
        p.move("Waist", z=6.0 * hop - 1.0 * squash)
        p.rot("Waist", y=-6 * hop + 6 * squash, x=4 * W(t, 2) * cheer)
        p.rot("Spine1", y=-4 * cheer)
        p.rot("Head", y=-10 * cheer - 4 * hop, x=10 * W(t, 2, 0.2) * (cheer + wave_), z=6 * wave_)
        _ears(p, back=-8 * cheer - 10 * hop + 8 * squash, spread=4 * W(t, 4) * cheer, tip=-6 * hop)
        if hop < 1e-6:
            plant(p)
        else:
            rw = stance.world()
            for s, sx in LEGS2:
                u, l, e = leg_chain(s)
                tgt = rw[kit.index(e)][:, 3] + (0.0, 0.0, 6.0 * hop - 1.4 * hop)
                kit.ik(p, u, l, e, tgt, knee_pole(rw, s), xform.rot_deg(0, 25 * hop, 0) @ rw[kit.index(e)][:, :3])
        up = (0.6, 4.4, 4.2)
        offl = lerp(lerp(ST_HAND["L"], up, cheer), (0.2, 5.0, 3.8), wave_)
        offr = lerp(ST_HAND["R"], up, cheer)
        arms_blend(p, offl, offr, pole=(-0.5, 0.6, -0.4))
        if wave_ > 0:
            p.rot("LHand", z=25 * W(t, 6) * wave_)
        tw = R.chain_wave(t, 3, 14 * (cheer + wave_), lag=0.12, freq=4)
        _tail(p, [(6 * cheer, tw[0]), (0, tw[1]), (0, tw[2])])
        kit.sparks(p, i, 1.0 if (0.2 < t < 0.6 and i % 4 == 0) else 0.0, forward=-0.2)
        # happy closed eyes and an open smile while cheering, then a wink with the wave
        eye = "closed" if 3 <= i <= 31 else "open"
        if 37 <= i <= 42:
            eye = ("closed", "open")
        p.expr(eye=eye, mouth="wide" if 3 <= i <= 45 else "closed")
        return p

    if want("victory"):
        seqs["victory"] = _oseq(kit, "victory", victory, VIC_FRAMES, VIC_FPS, activity=mdl.ACT["VICTORY_DANCE"])

    order = [("idle", "IDLE"), ("walk", "WALK"), ("run", "RUN"), ("attack", "RANGE_ATTACK1"),
             ("flinch", "SMALL_FLINCH"), ("die", "DIESIMPLE"), ("spawn", "ARM"), ("victory", "VICTORY_DANCE")]
    out = []
    for name, act in order:
        out.append(seqs[name] if name in seqs else
                   _oseq(kit, name, lambda t, i: stance, 2, 10, activity=mdl.ACT[act]))
    out += [s for n, s in seqs.items() if n not in dict(order)]
    return out, checks
