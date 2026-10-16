"""Charizard (Dracaufeu): models/pokemon/charizard.mdl, generated from scratch.

Orange fire dragon standing on its hind legs, ~78 units tall at the horns (the half-open wings rise
to ~83), facing +x, origin on the ground between its feet: cream belly, throat and lower jaw, big
head with a broad muzzle, brow ridges and eyes readable from the front, two horns, muscular legs
with clawed three-toed feet, small arms with hands and claws, large wings with teal inner membranes
(two-sided thin geometry, painted veins) and a long tail ending in an additive, fullbright flame
that flickers in every sequence.  A fullbright glow lines the throat (seen when the mouth opens).

Sequences (contract order): idle, walk (~98 u/s native), run (wing-assisted bound, ~245 u/s),
attack (rears up, then breathes forward from 40 %, head straight, mouth held open to 94 %), flinch, die (collapses
on its right side, centred on the origin, the tail flame shrinks), spawn (curled with folded wings ->
stands -> roar), victory (wing-assisted hop + roar).  Attachments 0 and 1: between the jaws;
2: the tail flame.
"""
import math

import numpy as np

from .. import builder, mdl, mesh as M, rig as R, sdf, texture as T, xform

# ---------------------------------------------------------------------------------------------
# palette
# ---------------------------------------------------------------------------------------------
ORANGE = T.rgb("#f08a3a")
ORANGE_DARK = T.rgb("#d86a24")
ORANGE_DEEP = T.rgb("#b8521c")
ORANGE_LIGHT = T.rgb("#f8a457")
CREAM = T.rgb("#f7df9c")
TEAL = T.rgb("#2a8a9c")
TEAL_DARK = T.rgb("#1d6676")
CLAW = T.rgb("#f4efe2")
MOUTH = T.rgb("#7c1f22")
TONGUE = T.rgb("#c8505a")
SHADOW = "#a87868"

# ---------------------------------------------------------------------------------------------
# skeleton: everything is designed in "design units" then scaled by S into model units
# ---------------------------------------------------------------------------------------------
S = 1.09
HIP = (-1.5, 7.5, 25.5)
KNEE = (3.5, 9.5, 14.5)
ANKLE = (-1.0, 10.0, 4.8)
TOE = (6.5, 10.0, 1.0)
SHOULDER = (4.5, 8.0, 43.0)
ELBOW = (6.5, 11.0, 36.5)
WRIST = (12.0, 10.0, 35.5)
WING_ROOT = (-6.0, 4.5, 47.0)
WING_SCALE = 1.3                     # wings scaled out from the root (Charizard's main read at distance)


def _wing(p, back=0.0, up=0.0):
    r = np.array(WING_ROOT)
    q = r + (np.array(p, float) - r) * WING_SCALE + np.array([-back, 0.0, up])
    return tuple(float(x) for x in q)


WING_WRIST = _wing((-14.0, 12.0, 69.0), back=2.0, up=-1.5)
WING_ELBOW = _wing((-10.5, 9.0, 59.0), back=1.0)
WING_TIPS = [_wing((-22.5, 27.5, 65.5), up=-2.0), _wing((-28.5, 25.0, 52.5)), _wing((-24.5, 16.0, 42.5))]
WING_BACK = (-8.0, 5.0, 37.5)
TAIL = [(-7.0, 0.0, 25.0), (-14.0, 0.0, 19.5), (-22.0, 0.0, 16.0), (-30.0, 0.0, 16.0), (-36.0, 0.0, 19.5),
        (-39.0, 0.0, 25.0)]
TAIL_R = [6.2, 4.8, 3.8, 3.0, 2.4, 1.9]
FLAME_BASE = (-39.3, 0.0, 26.3)
FLAME_SCALE = 1.6
BUDGET = {"torso": 470, "tail": 180, "head": 450, "jaw": 140, "leg": 190, "foot": 110, "arm": 50, "forearm": 100,
          "wingarm": 70, "fingers": 80, "flame_a": 76, "flame_b": 54, "flame_c": 30, "throat": 20, "tongue_glow": 16}
# The head is modelled in its own "head design" frame (HEAD0) and placed by head_xf(): scaled up
# around HEAD0 and lowered (shorter, thicker neck, bigger head).
HEAD0 = np.array([6.5, 0.0, 61.0])
HEAD_SCALE = 1.15
HEAD_DROP = 2.5


def head_xf(p):
    """Head design point(s) -> body design point(s)."""
    return HEAD0 + (np.asarray(p, float) - HEAD0) * HEAD_SCALE - np.array([0.0, 0.0, HEAD_DROP])


def head_xf_inv(P):
    """Body design point(s) -> head design point(s)."""
    return (np.asarray(P, float) + np.array([0.0, 0.0, HEAD_DROP]) - HEAD0) / HEAD_SCALE + HEAD0


def head_place(shape):
    return shape.scale(HEAD_SCALE, center=HEAD0).translate((0.0, 0.0, -HEAD_DROP))


NECK = [(2.0, 0.0, 44.0), (4.3, 0.0, 50.0), (5.7, 0.0, 54.8), (6.6, 0.0, 58.5)]
NECK_R = [6.6, 5.4, 4.8, 4.4]
HEAD = tuple(head_xf(HEAD0))
JAW = tuple(head_xf((8.0, 0.0, 61.5)))
MOUTH_TIP0 = (20.2, 0.0, 62.5)                       # head design frame
FIRE_POINT = tuple(head_xf(np.array(MOUTH_TIP0) + np.array([-1.5, 0.0, -1.8])))   # between the jaws


def side_pt(p, s):
    return (p[0], p[1] * s, p[2])


class ScaledRig(R.Rig):
    """Rig declared in design units, stored in model units."""

    def add(self, name, parent, head, tail=None):
        return super().add(name, parent, tuple(np.asarray(head, float) * S),
                           None if tail is None else tuple(np.asarray(tail, float) * S))


def finger_folds(k):
    """Per finger (axis, degrees): rotating finger i by fold * degrees about axis brings it next to the
    wing arm (fan folding); k = +1 left wing, -1 right wing."""
    wr = np.array(side_pt(WING_WRIST, k))
    a = np.array(side_pt(WING_ROOT, k)) - wr
    a /= np.linalg.norm(a)
    out = []
    for tip in WING_TIPS:
        d = np.array(side_pt(tip, k)) - wr
        d /= np.linalg.norm(d)
        axis = np.cross(d, a)
        out.append((axis / np.linalg.norm(axis), math.degrees(math.acos(float(np.clip(d @ a, -1, 1))))))
    return out


FOLDS = {"l": finger_folds(1), "r": finger_folds(-1)}


def make_rig():
    rig = ScaledRig()
    rig.add("root", None, (0, 0, 0))
    rig.add("pelvis", "root", (-1.5, 0, 26), tail=(-0.5, 0, 33))
    rig.add("spine", "pelvis", (-0.5, 0, 33), tail=(1.0, 0, 40))
    rig.add("chest", "spine", (1.0, 0, 40), tail=NECK[0])
    rig.add("neck1", "chest", NECK[0], tail=NECK[1])
    rig.add("neck2", "neck1", NECK[1], tail=NECK[3])
    rig.add("head", "neck2", HEAD, tail=tuple(head_xf((16, 0, 64))))
    rig.add("jaw", "head", JAW, tail=tuple(head_xf((18, 0, 61))))
    for i in range(5):
        rig.add(f"tail{i + 1}", "pelvis" if i == 0 else f"tail{i}", TAIL[i], tail=TAIL[i + 1])
    for name in ("flame_a", "flame_b", "flame_c"):
        rig.add(name, "tail5", FLAME_BASE, tail=(FLAME_BASE[0], 0, FLAME_BASE[2] + 6))
    for s, k in (("l", 1), ("r", -1)):
        rig.add(f"thigh_{s}", "pelvis", side_pt(HIP, k), tail=side_pt(KNEE, k))
        rig.add(f"shin_{s}", f"thigh_{s}", side_pt(KNEE, k), tail=side_pt(ANKLE, k))
        rig.add(f"foot_{s}", f"shin_{s}", side_pt(ANKLE, k), tail=side_pt(TOE, k))
        rig.add(f"arm_{s}", "chest", side_pt(SHOULDER, k), tail=side_pt(ELBOW, k))
        rig.add(f"forearm_{s}", f"arm_{s}", side_pt(ELBOW, k), tail=side_pt(WRIST, k))
        rig.add(f"wingback_{s}", "chest", side_pt(WING_ROOT, k), tail=side_pt(WING_BACK, k))
        rig.add(f"wing1_{s}", "chest", side_pt(WING_ROOT, k), tail=side_pt(WING_WRIST, k))
        mid = np.mean(WING_TIPS, axis=0)
        rig.add(f"wing2_{s}", f"wing1_{s}", side_pt(WING_WRIST, k), tail=side_pt(mid, k))
        for i, tip in enumerate(WING_TIPS):
            rig.add(f"finger{i + 1}_{s}", f"wing2_{s}", side_pt(WING_WRIST, k), tail=side_pt(tip, k))
    return rig


# ---------------------------------------------------------------------------------------------
# shapes
# ---------------------------------------------------------------------------------------------

def on_surface(shape, p, iters=8):
    """Project a point onto an SDF surface; returns (point, outward normal)."""
    q = np.asarray(p, dtype=np.float64)[None]
    for _ in range(iters):
        q = q - shape(q)[:, None] * shape.normal(q)
    return q[0], shape.normal(q)[0]


def torso_shape():
    belly = sdf.ellipsoid((0.5, 0, 31), (10.5, 10.5, 12.0))
    chest = sdf.ellipsoid((1.5, 0, 41), (7.8, 8.6, 7.0))
    hips = sdf.ellipsoid((-2.5, 0, 25.5), (8.5, 10.5, 7.0))
    shoulders = sdf.ellipsoid((1.0, 0, 43.5), (5.5, 9.0, 3.5))
    neck = sdf.tube(NECK, NECK_R)
    tail = sdf.tube(TAIL, TAIL_R)
    body = sdf.union(belly, chest, hips, k=5.0)
    body = sdf.union(body, shoulders, k=3.0)
    body = sdf.union(body, neck, k=3.5)
    body = sdf.union(body, tail, k=3.0)
    return body


EYE_SOCKET = np.array([15.2, 5.0, 66.0])


def head_shapes():
    """(upper head, jaw) in the head design frame (see head_place)."""
    cranium = sdf.ellipsoid((8.4, 0, 64.9), (6.2, 5.0, 4.8))
    snout = sdf.rounded_cone((12.4, 0, 64.2), (18.9, 0, 63.7), 3.75, 3.05).stretch((1, 1.2, 1),
                                                                                center=(15.5, 0, 64))
    cheeks = sdf.ellipsoid((10.2, 3.4, 63.0), (4.0, 2.6, 2.7)).mirror_y()
    brow = sdf.ellipsoid((13.5, 3.4, 67.75), (3.0, 1.6, 1.15)).rotate(z=24, y=-12, center=(13.5, 3.4, 67.75)).mirror_y()
    horn = (sdf.tube([(5.0, 2.6, 67.6), (1.5, 3.2, 69.0), (-2.5, 3.6, 70.4), (-6.0, 3.8, 72.0)],
                     [1.75, 1.25, 0.75, 0.3])).mirror_y()
    upper = sdf.union(cranium, snout, k=3.0)
    upper = sdf.union(upper, cheeks, k=1.8)
    upper = sdf.union(upper, brow, k=1.8)
    upper = sdf.union(upper, horn, k=1.1)
    # eye sockets: shallow dents under the brow so the eyes sit in the face
    for k in (1, -1):
        upper = sdf.subtract(upper, sdf.ellipsoid(EYE_SOCKET * (1, k, 1), (1.5, 1.5, 1.2)).rotate(
            z=-38 * k, center=EYE_SOCKET * (1, k, 1)), k=0.9)
    # the mouth: cut the snout's underside flat along the mouth line (slightly rising toward the back)
    cut = mouth_plane(62.3)  # inside: below the mouth line
    front = sdf.halfspace((9.5, 0, 0), (1, 0, 0))
    mouth_cut = sdf.intersect(cut.with_bounds((-100, -100, 0), (100, 100, 64)), front)
    upper = sdf.subtract(upper, mouth_cut.with_bounds((8, -8, 55), (26, 8, 63.5)), k=1.2)
    jaw = sdf.rounded_cone((10.0, 0, 61.2), (18.5, 0, 61.9), 3.0, 2.15).stretch((1, 1.38, 0.78),
                                                                             center=(14.5, 0, 61.5))
    jaw = sdf.union(jaw, sdf.ellipsoid((9.6, 0, 61.0), (3.6, 3.8, 2.3)), k=1.6)
    lid = sdf.halfspace((0, 0, 62.75), (0, 0, 1)).rotate(y=-3.0, center=(16, 0, 62.75))
    jaw = sdf.intersect(jaw, lid.with_bounds((0, -8, 55), (24, 8, 63.5)), k=1.0)
    return upper, jaw


def mouth_plane(z):
    """Signed distance to the (slightly tilted) mouth plane, negative below it."""
    return sdf.halfspace((0, 0, z), (0, 0, 1)).rotate(y=-3.0, center=(16, 0, z))


def fangs():
    """Two upper fangs inside the mouth (visible when it opens); head design frame."""
    return sdf.union(*[sdf.rounded_cone((16.5, 2.0 * k, 62.9), (16.7, 2.05 * k, 60.4), 0.85, 0.14)
                       for k in (1, -1)])


def lower_fangs():
    """Two small lower fangs on the jaw (hidden inside the snout when the mouth is closed)."""
    return sdf.union(*[sdf.rounded_cone((14.9, 1.95 * k, 61.4), (15.0, 2.0 * k, 63.4), 0.62, 0.11)
                       for k in (1, -1)])


def throat_shape():
    """Glowing throat at the back of the mouth (fx group), buried while the mouth is closed."""
    return sdf.ellipsoid((11.4, 0, 61.9), (2.0, 1.6, 1.1))


def tongue_glow_shape():
    """Glow lying on the back of the tongue (jaw bone): inside the head while the mouth is closed."""
    return sdf.ellipsoid((12.6, 0, 62.62), (3.4, 1.55, 0.4))


def leg_shapes(k):
    hip, knee, ankle = side_pt(HIP, k), side_pt(KNEE, k), side_pt(ANKLE, k)
    thigh = sdf.ellipsoid((0.9, 9.0 * k, 19.6), (7.4, 6.0, 8.4)).rotate(y=-20, center=(0.9, 9.0 * k, 19.6))
    thigh = sdf.union(thigh, sdf.sphere(hip, 5.4), k=2.5)
    shin = sdf.rounded_cone((knee[0] - 0.6, knee[1], knee[2] + 1.0), ankle, 4.0, 2.7)
    foot = sdf.ellipsoid((2.2, 10.0 * k, 2.4), (5.4, 3.7, 2.4))
    foot = sdf.union(foot, sdf.sphere((-1.3, 10.0 * k, 3.7), 2.9), k=1.5)
    claws = []
    toes = []
    for dy, ln in ((-2.2, 0.9), (0.0, 1.0), (2.2, 0.9)):
        y = 10.3 * k + dy
        a = (5.0, y, 1.8)
        b = (6.6 + 1.6 * ln, y + dy * 0.25, 1.4)
        toes.append(sdf.rounded_cone(a, b, 1.35, 1.05))
        claws.append(sdf.rounded_cone(b, (b[0] + 1.6, b[1] + dy * 0.1, 0.55), 0.9, 0.25))
    foot = sdf.union(foot, *toes, k=1.0)
    claw = sdf.union(*claws)
    foot = sdf.union(foot, claw, k=0.25)
    # flat sole
    foot = sdf.intersect(foot, sdf.halfspace((0, 0, 0.0), (0, 0, -1)).with_bounds((-10, -20, 0), (15, 20, 10)))
    return thigh, shin, foot, claw


def arm_shapes(k):
    sh, el, wr = side_pt(SHOULDER, k), side_pt(ELBOW, k), side_pt(WRIST, k)
    root = (sh[0] - 1.0, sh[1] - 2.0 * k, sh[2] - 0.6)          # starts inside the chest: no cap showing
    arm = sdf.rounded_cone(root, el, 3.3, 2.0)
    fore = sdf.rounded_cone(el, wr, 2.0, 1.55)
    palm = sdf.ellipsoid((wr[0] + 1.1, wr[1], wr[2] - 0.2), (1.6, 1.3, 1.05)).rotate(
        y=18, center=(wr[0] + 1.1, wr[1], wr[2] - 0.2))
    fingers, claws = [], []
    for dy, dz in ((-1.0, 0.35), (0.15, 0.55), (1.05, -0.2)):
        a = (wr[0] + 2.0, wr[1] + dy * k, wr[2] + dz - 0.3)
        b = (wr[0] + 3.2, wr[1] + dy * 1.2 * k, wr[2] + dz - 0.9)
        fingers.append(sdf.rounded_cone(a, b, 0.6, 0.5))
        c = (b[0] + 1.1, b[1] + dy * 0.15 * k, b[2] - 1.1)
        claws.append(sdf.rounded_cone(b, c, 0.47, 0.12))
    claw = sdf.union(*claws)
    hand = sdf.union(palm, *fingers, k=0.5)
    fore = sdf.union(fore, hand, k=1.0)
    fore = sdf.union(fore, claw, k=0.25)
    return arm, fore, claw


def wing_spars(k):
    root, wr = side_pt(WING_ROOT, k), side_pt(WING_WRIST, k)
    inner = (root[0] + 1.5, root[1] - 1.5 * k, root[2] - 1.0)
    arm = sdf.tube([inner, root, side_pt(WING_ELBOW, k), wr], [2.2, 2.0, 1.5, 1.2])
    knob = sdf.sphere(wr, 1.4)
    arm = sdf.union(arm, knob, k=0.8)
    fingers = []
    for i, tip in enumerate(WING_TIPS):
        t = side_pt(tip, k)
        m = (wr[0] + (t[0] - wr[0]) * 0.5, wr[1] + (t[1] - wr[1]) * 0.5, wr[2] + (t[2] - wr[2]) * 0.5 + 0.9)
        fingers.append(sdf.tube([wr, m, t], [1.0 if i == 0 else 0.75, 0.58, 0.22]))
    return arm, sdf.union(*fingers, k=0.6)


def wing_membrane(k, rings=3, thick=0.22):
    """Thin two-sided membrane (left wing for k=+1): a fan from the wrist to a boundary made of the
    back attachment and three scallops between the finger tips.  Returns (front TriMesh, back TriMesh)
    where the front faces forward (the teal inner side)."""
    wr = np.array(WING_WRIST, float)
    root = np.array(WING_ROOT, float) + np.array([1.2, -0.8, 0.0])   # attachment sunk into the back
    back = np.array(WING_BACK, float) + np.array([1.2, -0.6, 0.0])
    tips = [np.array(t, float) for t in WING_TIPS]
    nrm = np.cross(tips[0] - wr, back - wr)
    nrm /= np.linalg.norm(nrm)
    if nrm[0] < 0:
        nrm = -nrm
    bnd = []
    for u in np.linspace(0, 1, 4)[:-1]:          # along the back, root -> back
        bnd.append(root + (back - root) * u + np.array([-0.6, 0, 0]) * math.sin(math.pi * u))
    chain = [back, tips[2], tips[1], tips[0]]
    for a, b in zip(chain[:-1], chain[1:]):
        n = 5
        mid = (a + b) / 2
        inward = wr - mid
        inward -= nrm * (inward @ nrm)
        inward /= np.linalg.norm(inward)
        depth = 0.18 * np.linalg.norm(b - a)
        for u in np.linspace(0, 1, n + 1)[:-1]:
            bnd.append(a + (b - a) * u + inward * depth * math.sin(math.pi * u) ** 1.2)
    bnd.append(tips[0])
    bnd = np.array(bnd)
    Mb = len(bnd)
    verts = [wr]
    rows = []
    for i in range(1, rings + 1):
        f = i / rings
        row = []
        for j in range(Mb):
            p = wr + (bnd[j] - wr) * f
            # gentle billow toward the back (membrane sags away from the front)
            billow = -1.1 * math.sin(math.pi * f) * math.sin(math.pi * j / (Mb - 1)) ** 0.7
            row.append(len(verts))
            verts.append(p + nrm * billow)
        rows.append(row)
    faces = []
    for j in range(Mb - 1):
        faces.append((0, rows[0][j], rows[0][j + 1]))
    for i in range(rings - 1):
        for j in range(Mb - 1):
            a, b, c, d = rows[i][j], rows[i][j + 1], rows[i + 1][j], rows[i + 1][j + 1]
            faces.append((a, c, d))
            faces.append((a, d, b))
    V = np.array(verts)
    F = np.array(faces)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    if np.sum(fn @ nrm) < 0:
        F = F[:, ::-1]
    front = M.TriMesh(V + nrm * thick * 0.5, F)
    backm = M.TriMesh(V - nrm * thick * 0.5, F[:, ::-1])
    if k < 0:
        flip = np.array([1.0, -1.0, 1.0])
        front = M.TriMesh(front.verts * flip, front.faces[:, ::-1])
        backm = M.TriMesh(backm.verts * flip, backm.faces[:, ::-1])
    return front, backm, nrm


def flame_shapes():
    b = np.array(FLAME_BASE)
    outer = sdf.union(sdf.sphere(b + (0, 0, 0.6), 2.9),
                      sdf.rounded_cone(b + (0, 0, 0.8), b + (0.3, 0, 10.5), 2.7, 0.25), k=1.2)
    outer = sdf.union(outer, sdf.rounded_cone(b + (0.4, 1.0, 1.5), b + (1.4, 2.6, 7.0), 1.6, 0.2),
                      sdf.rounded_cone(b + (0.0, -1.2, 1.5), b + (-0.9, -2.4, 8.0), 1.6, 0.2), k=0.9)
    inner = sdf.union(sdf.sphere(b + (0, 0, 0.8), 2.0),
                      sdf.rounded_cone(b + (0, 0, 1.0), b + (-0.2, 0, 7.5), 1.9, 0.2), k=0.8)
    core = sdf.union(sdf.sphere(b + (0, 0, 1.0), 1.25),
                     sdf.rounded_cone(b + (0, 0, 1.0), b + (0.1, 0, 4.6), 1.2, 0.15), k=0.5)
    return tuple(x.scale(FLAME_SCALE, center=b) for x in (outer, inner, core))


# ---------------------------------------------------------------------------------------------
# model
# ---------------------------------------------------------------------------------------------

def vnoise(P, scale, seed=0):
    """Deterministic 3D value noise in [-1, 1] (features about `scale` units)."""
    q = np.asarray(P, dtype=np.float64) / scale
    i = np.floor(q).astype(np.int64)
    f = q - i
    f = f * f * (3 - 2 * f)

    def h(dx, dy, dz):
        x = (i[:, 0] + dx) * 73856093 ^ (i[:, 1] + dy) * 19349663 ^ (i[:, 2] + dz) * 83492791 ^ (seed * 2654435761)
        x = (x ^ (x >> 13)) * 1274126177
        x = x ^ (x >> 16)
        return (x & 0xFFFF) / 32767.5 - 1.0

    out = 0.0
    for dx in (0, 1):
        wx = f[:, 0] if dx else 1 - f[:, 0]
        for dy in (0, 1):
            wy = f[:, 1] if dy else 1 - f[:, 1]
            for dz in (0, 1):
                wz = f[:, 2] if dz else 1 - f[:, 2]
                out = out + wx * wy * wz * h(dx, dy, dz)
    return out


def grain(c, P, amp=0.04, seed=0):
    """Low-amplitude value noise on the colour (breaks the flat CG look)."""
    n = 0.6 * vnoise(P, 0.55, seed) + 0.4 * vnoise(P, 1.7, seed + 7)
    return np.clip(c * (1.0 + amp * n)[:, None], 0.0, 1.0)


EYE_CENTER0 = np.array([13.75, 4.3, 66.0])      # head design frame (left eye)
EYE_DIR0 = (0.68, 0.7, 0.1)
EYE_SIZE = (1.62, 1.25)                         # half width, half height (head design units)


def make_model():
    rig = make_rig()
    torso = torso_shape()
    head0, jaw0 = head_shapes()                   # head design frame (painted there)
    head, jaw = head_place(head0), head_place(jaw0)
    legs = {s: leg_shapes(k) for s, k in (("l", 1), ("r", -1))}
    arms = {s: arm_shapes(k) for s, k in (("l", 1), ("r", -1))}
    spars = {s: wing_spars(k) for s, k in (("l", 1), ("r", -1))}
    # baked AO: the torso does not get the arms' occlusion (they move a lot, a baked shadow would stay)
    no_arms = sdf.union(torso, head, jaw, *[x for s in legs for x in legs[s][:3]])
    whole = sdf.union(no_arms, *[x for s in arms for x in arms[s][:2]])

    belly_zone = sdf.union(sdf.ellipsoid((7.5, 0, 31.0), (8.0, 8.2, 13.5)),
                           sdf.tube([(7.0, 0, 40), (8.0, 0, 45.5), (8.8, 0, 50.5), (9.6, 0, 55.0), (10.2, 0, 57.5)],
                                    [6.4, 5.6, 4.6, 4.0, 3.4]), k=3.0)

    def body_shade(c, P, N, ao_dist=3.0, ao_strength=0.6, shape=None):
        ao = T.ambient_occlusion(whole if shape is None else shape, P, N, dist=ao_dist)
        return T.shade(c, N, ao=ao, ao_strength=ao_strength, top=0.14, shadow_tint=SHADOW, cavity_floor=0.5)

    def dorsal(P, N):
        """1 on the back/top line (the back of the body, the top of the tail), 0 on the flanks."""
        w = np.clip((-P[:, 0] - 8.0) / 8.0, 0.0, 1.0)[:, None]
        d = (1 - w) * np.array([-1.0, 0.0, 0.3]) + w * np.array([0.0, 0.0, 1.0])
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        return T._sstep(0.15, 0.95, np.sum(N * d, axis=1))

    def belly_mask(P, N, grow=0.0, soft=1.0):
        return T.sdf_mask(belly_zone, P, soft=soft, grow=grow) * T.facing(N, (1, 0, -0.1), -0.25 - 0.12 * grow,
                                                                          0.15 - 0.12 * grow)

    def paint_torso(P, N, skin):
        # the caps where the body and tail parts overlap are inside the torso: painted as the nearest
        # surface so that slivers along the seam do not show
        d = torso(P)
        inside = d < -0.12
        if inside.any():
            P, N = P.copy(), N.copy()
            n_in = torso.normal(P[inside])
            P[inside] = P[inside] - d[inside, None] * n_in
            N[inside] = n_in
        c = T.fill(P, ORANGE)
        c = T.mix(c, ORANGE_DARK, 0.55 * dorsal(P, N))
        c = T.mix(c, ORANGE_DEEP, 0.35 * T._sstep(0.8, 1.0, dorsal(P, N)) * T.band(P, (0, 1, 0), -1.2, 1.2, soft=1.5))
        rim = np.clip(belly_mask(P, N, grow=2.2, soft=2.5) - belly_mask(P, N, grow=0.4), 0, 1)
        c = T.mix(c, ORANGE_LIGHT, 0.45 * rim)
        line = np.clip(belly_mask(P, N, grow=0.45, soft=0.5) - belly_mask(P, N, grow=0.0, soft=0.5), 0, 1)
        c = T.mix(c, ORANGE_DEEP, 0.55 * line)
        belly = belly_mask(P, N, soft=1.0)
        cream = T.mix(T.fill(P, CREAM), "#e9c47e", 0.35 * T.facing(N, (0, 0, -1), 0.2, 0.9))
        c = T.mix(c, cream, belly)
        c = grain(c, P, 0.045, 1)
        return body_shade(c, P, N, shape=no_arms)

    def limb_base(P, N):
        c = T.fill(P, ORANGE)
        c = T.mix(c, ORANGE_DARK, 0.45 * T.facing(N, (-0.6, 0, 0.8), 0.1, 0.95))
        c = T.mix(c, ORANGE_LIGHT, 0.3 * T.facing(N, (0.7, 0, -0.4), 0.2, 0.9))
        return grain(c, P, 0.045, 2)

    def paint_limb(claw):
        def paint(P, N, skin):
            c = limb_base(P, N)
            c = T.mix(c, CLAW, T.sdf_mask(claw, P, soft=0.25, grow=0.08))
            return body_shade(c, P, N, 2.0, 0.45)
        return paint

    def paint_plain(P, N, skin):
        return body_shade(limb_base(P, N), P, N, 2.5, 0.55)

    eyes = []
    for k in (1, -1):
        c, _ = on_surface(head0, EYE_CENTER0 * np.array([1, k, 1]))
        d = np.array(EYE_DIR0) * np.array([1, k, 1])
        eyes.append((c, d / np.linalg.norm(d)))
    nostrils = [on_surface(head0, (20.4, 1.25 * k, 65.0))[0] for k in (1, -1)]
    plane = mouth_plane(62.3)
    head_ao = sdf.union(head0, jaw0)
    fang_shape = fangs()

    def paint_head(P, N, skin):
        P = head_xf_inv(P)                     # head design frame
        c = T.fill(P, ORANGE)
        c = T.mix(c, ORANGE_DARK, 0.4 * T.facing(N, (-0.4, 0, 1), 0.3, 1.0))
        c = T.mix(c, ORANGE_LIGHT, 0.3 * T.facing(N, (0.5, 0, -0.8), 0.2, 0.9))
        # inside of the mouth (palate) under the mouth line
        d = plane(P)
        palate = T.edge(d - 0.25, 0.2) * (P[:, 0] > 10.0) * T.facing(N, (0, 0, -1), 0.5, 0.8)
        palate = palate * T.band(P, (0, 1, 0), -2.2, 2.2, soft=0.6) * T.band(P, (1, 0, 0), 9.0, 18.0, soft=0.6)
        c = T.mix(c, MOUTH, palate)
        # mouth line along the seam with the jaw
        front = np.clip((P[:, 0] - 10.5) / 1.5, 0, 1) * (1 - palate)
        c = T.mix(c, ORANGE_DEEP * 0.8, T.edge(d + 0.35, 0.3) * front)      # lip underside, in shadow
        line = T.edge(np.abs(d + 0.12) - 0.24, 0.16) * front
        c = T.mix(c, "#5a2414", 0.8 * line)
        for p in nostrils:
            c = T.mix(c, "#4a1a10", T.spot(P, p, 0.36, soft=0.15))
        c = T.mix(c, CLAW, T.sdf_mask(fang_shape, P, soft=0.15, grow=0.06))
        c = grain(c, P, 0.035, 3)
        for (ec, ed) in eyes:
            col, m = T.eye(P, ec, ed, EYE_SIZE, sclera="#f6f4ee", iris="#2a7cc4", iris_radius=0.86,
                           pupil="#0b0b10", pupil_radius=0.42, highlight_pos=(0.24, 0.24), highlight_radius=0.28,
                           look=(0.3, -0.08), outline_width=0.2, soft=0.07)
            # stern upper lid: slants down toward the snout
            lid_n = np.array([0.45, 0.0, 1.0]) / math.hypot(0.45, 1.0)
            dl = (P - (ec + np.array([0, 0, 0.75]))) @ lid_n
            lid = T.edge(-dl, 0.1) * m
            col = T.mix(col, ORANGE_DARK * 0.9, lid)
            col = T.mix(col, "#2a120c", T.edge(np.abs(dl) - 0.17, 0.08) * m)
            c = T.mix(c, col, m)
            # dark socket rim around the eye
            ring = T.spot(P, ec, max(EYE_SIZE) * 1.35, soft=0.9) * (1 - m)
            c = T.mix(c, ORANGE_DEEP, 0.35 * ring)
        return T.shade(c, N, ao=T.ambient_occlusion(head_ao, P, N, dist=1.5), top=0.14, shadow_tint=SHADOW)

    def paint_jaw(P, N, skin):
        P = head_xf_inv(P)
        c = T.fill(P, CREAM)
        c = T.mix(c, ORANGE, T.halfspace(P, (9.5, 0, 0), (-1, 0, 0), soft=1.5) * T.facing(N, (0, 0, 1), -0.6, 0.0))
        top = T.facing(N, (0, 0, 1), 0.4, 0.8) * T.halfspace(P, (0, 0, 62.0), (0, 0, 1), soft=0.2)
        tongue = top * T.band(P, (0, 1, 0), -1.5, 1.5, soft=0.5) * T.band(P, (1, 0, 0), 8.0, 17.6, soft=0.8)
        c = T.mix(c, MOUTH, top * 0.9)
        c = T.mix(c, TONGUE, tongue)
        c = T.mix(c, "#9a3440", tongue * T.band(P, (0, 1, 0), -0.18, 0.18, soft=0.2) * 0.7)
        c = T.mix(c, CLAW, T.sdf_mask(lower_fangs(), P, soft=0.2, grow=0.05))
        # shadow line under the upper lip (hides the seam with the head)
        lip = T.halfspace(P, (0, 0, 62.05), (0, 0, 1), soft=0.3) * (1 - T.facing(N, (0, 0, 1), 0.4, 0.8))
        c = T.mix(c, "#5a2414", 0.7 * lip * np.clip((P[:, 0] - 10.5) / 1.5, 0, 1))
        c = grain(c, P, 0.03, 4)
        return T.shade(c, N, ao=T.ambient_occlusion(head_ao, P, N, dist=1.5), top=0.1, shadow_tint=SHADOW)

    wr = np.array(WING_WRIST)
    chain = [np.array(WING_BACK, float)] + [np.array(t, float) for t in WING_TIPS[::-1]]
    vein_ends = [(a + b) / 2 for a, b in zip(chain[:-1], chain[1:])]

    wn = np.cross(np.array(WING_TIPS[0]) - wr, np.array(WING_BACK) - wr)
    wn /= np.linalg.norm(wn)

    def plane_seg_dist(Q, a, b):
        """Distance to segment a-b measured in the membrane's plane (ignores its billow)."""
        ab = b - a
        u = np.clip((Q - a) @ ab / (ab @ ab), 0.0, 1.0)
        r = Q - (a + u[:, None] * ab)
        r = r - (r @ wn)[:, None] * wn
        return np.linalg.norm(r, axis=1), u

    def paint_membrane(inner):
        def paint(P, N, skin):
            k = np.where(P[:, 1] >= 0, 1.0, -1.0)
            Q = P * np.stack([np.ones_like(k), k, np.ones_like(k)], 1)     # left-wing frame
            d = np.linalg.norm(Q - wr, axis=1)
            vein = np.zeros(len(P))
            for e in vein_ends:
                dist, u = plane_seg_dist(Q, wr, wr + (e - wr) * 0.92)
                vein = np.maximum(vein, T.edge(dist - (0.42 - 0.25 * u), 0.3) * (1 - u ** 3))
            # trailing edge (far from the wrist and low): darker
            trail = np.clip((d - 10.0) / 22.0, 0, 1) * np.clip((wr[2] + 4 - Q[:, 2]) / 30.0, 0.3, 1.0)
            if not inner:
                c = T.fill(P, ORANGE)
                c = T.mix(c, ORANGE_LIGHT, 0.35 * np.clip(1 - d / 12.0, 0, 1))
                c = T.mix(c, ORANGE_DEEP, 0.75 * trail)
                c = T.mix(c, ORANGE_DEEP * 0.85, 0.6 * vein)
                return T.shade(grain(c, P, 0.03, 5), N, top=0.12)
            c = T.fill(P, TEAL)
            c = T.mix(c, "#3aa3b2", 0.4 * np.clip(1 - d / 12.0, 0, 1))
            c = T.mix(c, TEAL_DARK, 0.75 * trail)
            c = T.mix(c, TEAL_DARK * 0.75, 0.65 * vein)
            return T.shade(grain(c, P, 0.03, 6), N, top=0.1)
        return paint

    def paint_spar(P, N, skin):
        c = T.mix(T.fill(P, ORANGE), ORANGE_DARK, 0.35 * T.facing(N, (-0.5, 0, 0.8), 0.1, 0.95))
        return T.shade(grain(c, P, 0.035, 8), N, top=0.14)

    def paint_flame(level):
        cols = {0: ("#c8460e", "#7a1806"), 1: ("#f59420", "#b83a0c"), 2: ("#fff6d0", "#ffbe40")}[level]

        def paint(P, N, skin):
            z0 = FLAME_BASE[2]
            h = (10 if level == 0 else 7 if level == 1 else 4.5) * FLAME_SCALE / 1.35
            return T.gradient(P, (0, 0, 1), z0, z0 + h, cols[0], cols[1])
        return paint

    def paint_throat(P, N, skin):
        P = head_xf_inv(P)
        # hottest at the back of the throat, fading toward the front of the tongue
        d = np.clip((P[:, 0] - 10.0) / 6.0, 0, 1) + 0.6 * np.abs(P[:, 1]) / 1.6
        return T.mix(T.mix(T.fill(P, "#ffe27a"), "#ff8a1e", np.clip(d * 1.6, 0, 1)), "#7a1a06", np.clip(d - 0.55, 0, 1) * 2)

    b = builder.ModelBuilder("pokemon/charizard.mdl", rig)
    b.group("body", size=(512, 256), pack="skyline")
    b.group("limbs", size=(512, 256), pack="skyline")
    b.group("head", size=(512, 256), pack="skyline")
    b.group("wing", size=(512, 256), pack="skyline")
    b.group("fx", size=(128, 128), flags=mdl.STUDIO_NF_ADDITIVE | mdl.STUDIO_NF_FULLBRIGHT)

    def add(name, shape=None, paint=None, mesh=None, voxel=None, **kw):
        """Part in design units: the shape/mesh is scaled by S, the paint gets design-unit points."""
        def scaled_paint(P, N, skin, _f=paint):
            return _f(np.asarray(P) / S, N, skin)
        b.add(builder.Part(name, None if shape is None else shape.scale(S), paint=scaled_paint,
                           mesh=None if mesh is None else M.TriMesh(mesh.verts * S, mesh.faces),
                           voxel=None if voxel is None else voxel * S, **kw))

    # the tail is its own part (cut half-way along tail2, the two overlapping 2 units, both bound to tail2
    # there): its charts pack apart from the body's, which doubles the texel density of both
    a, c = np.array(TAIL[1]), np.array(TAIL[2])
    n = (c - a) / np.linalg.norm(c - a)
    cut = (a + c) / 2
    body_part = sdf.intersect(torso, sdf.halfspace(cut + 1.0 * n, n))
    tail_part = sdf.intersect(torso, sdf.halfspace(cut - 1.0 * n, -n))
    add("torso", body_part, bones=["pelvis", "spine", "chest", "neck1", "neck2", "tail1", "tail2"],
        paint=paint_torso, group="body", budget=BUDGET["torso"])
    add("tail", tail_part, bones=["tail2", "tail3", "tail4", "tail5"], paint=paint_torso, group="limbs",
        budget=BUDGET["tail"])
    add("head", head_place(sdf.union(head0, fangs())), bone="head", paint=paint_head, group="head",
        budget=BUDGET["head"], voxel=0.42)
    add("jaw", head_place(sdf.union(jaw0, lower_fangs())), bone="jaw", paint=paint_jaw, group="head",
        budget=BUDGET["jaw"], voxel=0.24, density=0.7)
    for s, k in (("l", 1), ("r", -1)):
        thigh, shin, foot, claw = legs[s]
        arm, fore, aclaw = arms[s]
        add(f"leg_{s}", sdf.union(thigh, shin, k=2.5), bones=[f"thigh_{s}", f"shin_{s}"], paint=paint_plain,
            group="limbs", budget=BUDGET["leg"])
        add(f"foot_{s}", foot, bone=f"foot_{s}", paint=paint_limb(claw), group="limbs", budget=BUDGET["foot"],
            voxel=0.3)
        add(f"arm_{s}", arm, bone=f"arm_{s}", paint=paint_plain, group="limbs", budget=BUDGET["arm"])
        add(f"forearm_{s}", fore, bone=f"forearm_{s}", paint=paint_limb(aclaw), group="limbs",
            budget=BUDGET["forearm"], voxel=0.2)
        warm, fing = spars[s]
        add(f"wingarm_{s}", warm, bone=f"wing1_{s}", paint=paint_spar, group="wing", budget=BUDGET["wingarm"])
        add(f"fingers_{s}", fing, bones=[f"finger{i}_{s}" for i in (1, 2, 3)], paint=paint_spar, group="wing",
            budget=BUDGET["fingers"],
            voxel=0.2, hitbox=False)
        front, backm, _ = wing_membrane(k)
        wb = [f"wingback_{s}", f"wing1_{s}"] + [f"finger{i}_{s}" for i in (1, 2, 3)]
        add(f"membrane_in_{s}", mesh=front, bones=wb, paint=paint_membrane(True), group="wing", hitbox=False,
            crease=80)
        add(f"membrane_out_{s}", mesh=backm, bones=wb, paint=paint_membrane(False), group="wing", hitbox=False,
            crease=80)
    for (name, shape), level in zip(zip(("flame_a", "flame_b", "flame_c"), flame_shapes()), range(3)):
        add(name, shape, bone=name, paint=paint_flame(level), group="fx", budget=BUDGET[name], hitbox=False)
    add("throat", head_place(throat_shape()), bone="head", paint=paint_throat, group="fx", budget=BUDGET["throat"],
        hitbox=False)
    add("tongue_glow", head_place(tongue_glow_shape()), bone="jaw", paint=paint_throat, group="fx",
        budget=BUDGET["tongue_glow"], hitbox=False)

    for seq in make_sequences(rig):
        b.add_sequence(seq)
    b.attachment("mouth", "head", np.array(FIRE_POINT) * S)
    b.attachment("mouth2", "head", np.array(FIRE_POINT) * S)
    b.attachment("tail_flame", "flame_a", (np.array(FLAME_BASE) + np.array([0.0, 0.0, 3.0])) * S)
    # (the server uses its own hull 32x32x72 and eye height 64: same values here)
    b.eyeposition = (tuple(head_xf((14.0, 0.0, 66.0)) * S)[0], 0.0, 64.0)
    b.hull = ((-16.0, -16.0, 0.0), (16.0, 16.0, 72.0))
    return b.write()


# ---------------------------------------------------------------------------------------------
# animation
# ---------------------------------------------------------------------------------------------
# Poses are described by a few named parameters (degrees, design units), keyframed per sequence
# and turned into bone rotations by apply(); procedural layers (gait, breathing, sway, flame
# flicker) are added on top.

NEUTRAL = {
    "root_x": 0.0, "root_y": 0.0, "root_z": 0.0, "root_roll": 0.0, "root_pitch": 0.0, "root_yaw": 0.0,
    "pelvis_x": 0.0, "pelvis_z": -0.3, "pelvis_pitch": 0.0, "pelvis_roll": 0.0, "pelvis_yaw": 0.0,
    "spine": 0.0, "chest": 0.0, "chest_yaw": 0.0, "chest_roll": 0.0,
    "neck1": 0.0, "neck2": 0.0, "head": 0.0, "head_yaw": 0.0, "head_roll": 0.0, "jaw": 0.0,
    "spread": 0.0, "flap": 0.0, "fold": 0.12, "flap2": 0.0, "wing_pitch": 0.0, "spread_r": 0.0, "flap_r": 0.0, "fold_r": 0.0,
    "arm_raise": 0.0, "arm_out": 0.0, "elbow": 0.0, "arm_out_r": 0.0,
    "tail_lift": 0.0, "tail_curl": 0.0, "tail_droop": 0.0,
    "flame": 1.0,
    "foot_l_x": 0.0, "foot_l_z": 0.0, "foot_r_x": 0.0, "foot_r_z": 0.0, "foot_l_y": 0.0, "foot_r_y": 0.0,
    "foot_pitch_l": 0.0, "foot_pitch_r": 0.0, "plant": 0.0,
}
PARAMS = sorted(NEUTRAL)


class Track:
    """Keyframed parameter set: keys [(t, {param: value, ...}), ...]; unspecified params are neutral
    at that key.  Monotone cubic (PCHIP) interpolation per parameter: smooth, passes through every key
    and never overshoots (no feet sinking into the ground); zero slope at the first and last key."""

    def __init__(self, keys, base=None):
        b = dict(NEUTRAL if base is None else base)
        self.t = np.array([float(t) for t, _ in keys])
        self.v = np.array([[{**b, **d}[n] for n in PARAMS] for _, d in keys], dtype=np.float64)
        h = np.diff(self.t)
        d = np.diff(self.v, axis=0) / h[:, None]
        m = np.zeros_like(self.v)
        for k in range(1, len(self.t) - 1):
            w1, w2 = 2 * h[k] + h[k - 1], h[k] + 2 * h[k - 1]
            a, c = d[k - 1], d[k]
            same = a * c > 0
            with np.errstate(divide="ignore", invalid="ignore"):
                hm = (w1 + w2) / (w1 / a + w2 / c)
            m[k] = np.where(same, hm, 0.0)
        self.m = m

    def __call__(self, t):
        ts = self.t
        if t <= ts[0]:
            v = self.v[0]
        elif t >= ts[-1]:
            v = self.v[-1]
        else:
            k = int(np.searchsorted(ts, t, side="right") - 1)
            h = ts[k + 1] - ts[k]
            u = (t - ts[k]) / h
            h00, h10 = 2 * u ** 3 - 3 * u ** 2 + 1, u ** 3 - 2 * u ** 2 + u
            h01, h11 = -2 * u ** 3 + 3 * u ** 2, u ** 3 - u ** 2
            v = h00 * self.v[k] + h10 * h * self.m[k] + h01 * self.v[k + 1] + h11 * h * self.m[k + 1]
        return dict(zip(PARAMS, v))


def flicker(t, dur, seed, amp=1.0):
    """Deterministic flicker in about [-amp, amp]: a few sines at ~3-11 Hz with whole cycles over
    the sequence so loops stay seamless."""
    out = 0.0
    for i, (hz, w) in enumerate(((3.3, 0.5), (6.9, 0.32), (11.3, 0.18))):
        n = max(1, int(round(hz * dur)))
        ph = (seed * 0.6180339 + i * 0.37) % 1.0
        out += w * math.sin(2 * math.pi * (n * t + ph))
    return amp * out


def flame_pose(rig, p, t, dur, scale=1.0):
    """Flame layers: kept close to world-up whatever the tail does, jittered (rotation) and pumped
    (sinking into the tail tip changes their visible size); scale < 1 shrinks the flame."""
    W = rig.world(p)
    up = W[rig.index("tail5")][:, :3].T @ np.array([0.0, 0.0, 1.0])
    base = np.degrees(xform.matrix_euler(R._align((0, 0, 1), up)))
    for i, name in enumerate(("flame_a", "flame_b", "flame_c")):
        f1, f2, f3 = (flicker(t, dur, 3 * i + j) for j in (1, 2, 3))
        p.set_rot(name, *base)
        a = 10.0 - 2.5 * i
        p.rot(name, x=a * f1, y=a * f2 - 4.0)
        sink = max((1.0 - scale) * (8.5 - 2.5 * i), -1.0)   # flares rise a little, never off the tip
        off = up * S * (-sink + 0.8 * f3 - 0.25)      # along the flame's own axis (parent frame)
        p.move(name, x=off[0], y=off[1], z=off[2])
    return p


def mv(p, bone, x=0.0, y=0.0, z=0.0):
    p.move(bone, x=x * S, y=y * S, z=z * S)


def apply(rig, q, legs=True):
    """Parameters (dict) -> Pose (the leg IK keeps the feet at their rest spots + offsets, in the
    root's frame so that falls carry the feet along)."""
    p = R.Pose()
    mv(p, "root", x=q["root_x"], y=q["root_y"], z=q["root_z"])
    p.rot("root", x=q["root_roll"], y=q["root_pitch"], z=q["root_yaw"])
    mv(p, "pelvis", x=q["pelvis_x"], z=q["pelvis_z"])
    p.rot("pelvis", x=q["pelvis_roll"], y=q["pelvis_pitch"], z=q["pelvis_yaw"])
    p.rot("spine", y=q["spine"], z=0.4 * q["chest_yaw"], x=0.4 * q["chest_roll"])
    p.rot("chest", y=q["chest"], z=0.6 * q["chest_yaw"], x=0.6 * q["chest_roll"])
    p.rot("neck1", y=q["neck1"], z=0.3 * q["head_yaw"])
    p.rot("neck2", y=q["neck2"], z=0.3 * q["head_yaw"])
    p.rot("head", y=q["head"], z=0.4 * q["head_yaw"], x=q["head_roll"])
    p.rot("jaw", y=q["jaw"])
    for s, k in (("l", 1), ("r", -1)):
        spread = q["spread"] + (q["spread_r"] if k < 0 else 0.0)
        flap = q["flap"] + (q["flap_r"] if k < 0 else 0.0)
        p.rot(f"wing1_{s}", x=k * flap, y=q["wing_pitch"], z=-k * spread)
        p.rot(f"wing2_{s}", x=k * (0.5 * flap + q["flap2"]), z=-k * 0.4 * spread)
        fold = q["fold"] + (q["fold_r"] if k < 0 else 0.0)
        for i, (axis, deg) in enumerate(FOLDS[s]):
            e = xform.matrix_euler(xform.axis_angle_matrix(axis, fold * deg * (0.92 - 0.04 * i)))
            p.set_rot(f"finger{i + 1}_{s}", *np.degrees(e))
        p.rot(f"arm_{s}", y=-q["arm_raise"], x=k * (q["arm_out"] + (q["arm_out_r"] if k < 0 else 0.0)))
        p.rot(f"forearm_{s}", y=-q["elbow"])
    for i in range(5):
        p.rot(f"tail{i + 1}", y=q["tail_lift"] * (0.5 - 0.1 * i) + q["tail_droop"] * (0.1 + 0.08 * i),
              z=q["tail_curl"] * (0.12 + 0.05 * i))
    if legs:
        feet = {s: (q[f"foot_{s}_x"], q[f"foot_{s}_y"], max(0.0, q[f"foot_{s}_z"]), max(0.0, q[f"foot_pitch_{s}"]))
                for s in "lr"}
        legs_ik(rig, p, feet, plant=q["plant"])
    return p


def legs_ik(rig, p, feet, plant=0.0):
    """feet: {side: (dx, dy, dz, pitch)} design-unit offsets of each foot from its rest spot, in the
    root's frame; plant (0..1) blends toward the feet staying on the ground whatever the root does."""
    Wr = rig.world(p)[rig.index("root")]
    for s in ("l", "r"):
        dx, dy, dz, pitch = feet.get(s, (0, 0, 0, 0))
        local = rig.head(f"foot_{s}") + np.array([dx, dy, dz]) * S
        target = (1 - plant) * (Wr[:, :3] @ local + Wr[:, 3]) + plant * local
        rot = Wr[:, :3] if plant < 0.5 else np.eye(3)
        rig.solve_two_bone(p, f"thigh_{s}", f"shin_{s}", f"foot_{s}", target, pole=Wr[:, :3] @ np.array([1.0, 0, 0]),
                           end_world_rot=rot @ xform.rot_deg(0, pitch, 0))
    return p


def tail_sway(p, t, amp, lag=0.1, freq=1, phase=0.0, vertical=0.0):
    for i, a in enumerate(R.chain_wave(t, 5, amp, lag=lag, freq=freq, phase=phase)):
        p.rot(f"tail{i + 1}", z=a)
    if vertical:
        for i, a in enumerate(R.chain_wave(t, 5, vertical, lag=lag, freq=2 * freq, phase=phase + 0.2)):
            p.rot(f"tail{i + 1}", y=a)
    return p


def add_pose(p, extra):
    for k, v in extra.items():
        if k in p:
            p[k] = p[k] + v
        else:
            p[k] = v.copy()
    return p


# --- sequences -------------------------------------------------------------------------------

IDLE_DUR = 2.5


def look_wave(t, phase=0.0, sharp=2.5):
    """Slow look-left / look-right with holds: a rounded square wave in [-1, 1] (loops over t in [0, 1])."""
    return math.tanh(sharp * math.sin(2 * math.pi * (t + phase))) / math.tanh(sharp)


def idle_params(t):
    br = R.breathe(t, freq=2)
    settle = math.sin(2 * math.pi * (t - 0.58) / 0.28) if 0.58 <= t <= 0.86 else 0.0   # one wing settle
    q = dict(NEUTRAL)
    q.update(pelvis_z=-0.3 + 0.18 * br, spine=-1.0 * br, chest=-1.2 * br, neck1=0.8 * br, head=-1.0 * br,
             head_yaw=14.0 * look_wave(t, 0.06), head_roll=3.0 * look_wave(t, 0.12), chest_yaw=3.0 * look_wave(t, 0.02),
             spread=2.0 * br, flap=2.0 * R.wave(t, freq=2, phase=0.12) + 6.0 * settle,
             flap2=1.5 * R.wave(t, freq=2, phase=0.05) + 3.0 * settle,
             arm_raise=2.5 * br, elbow=3.0 * br)
    return q


def seq_idle(rig):
    def pose(t):
        p = apply(rig, idle_params(t))
        tail_sway(p, t, 9.0, lag=0.1)
        return flame_pose(rig, p, t, IDLE_DUR)
    return R.make_sequence(rig, "idle", pose, frames=30, fps=12, loop=True, activity=mdl.ACT["IDLE"])


# Gaits: native ground speed linearmovement * fps / frames close to the server's walk/run speeds
# (100 / 240 u/s), so its playback-rate matching stays near 1.
WALK = dict(frames=12, fps=24, stride=26.0, lift=5.0, duty=0.58)     # 0.5 s cycle, ~98 u/s
RUN = dict(frames=16, fps=24, stride=30.0, lift=7.5, duty=0.2)       # wing-assisted bound, ~245 u/s


def gait_pose(rig, t, g, run):
    dur = g["frames"] / g["fps"]
    q = dict(NEUTRAL)
    c = math.cos(2 * math.pi * t)
    st = g["duty"] / 2                           # left foot mid-stance
    ph = 4 * math.pi * (t - st)                  # 0 at both mid-stances
    bob = math.cos(ph)
    if run:
        # low bound: compressed at mid-stance, long flight with a big wing downbeat
        q.update(pelvis_z=-5.0 - 1.7 * bob, pelvis_x=1.0, pelvis_pitch=22.0 + 3.0 * bob, spine=8.0, chest=6.0,
                 neck1=-8.0 - 2.0 * bob, neck2=-10.0, head=-18.0 - 3.0 * math.cos(ph - 0.6),
                 pelvis_yaw=-5.0 * c, chest_yaw=7.0 * c, pelvis_roll=-2.5 * c,
                 spread=24.0 + 6.0 * math.cos(ph - 0.9), flap=6.0 + 30.0 * math.cos(ph - 0.3 * math.pi),
                 flap2=12.0 * math.cos(ph - 0.55 * math.pi), fold=-0.05,
                 arm_raise=24.0 + 8.0 * c, elbow=50.0, arm_out=6.0, tail_lift=10.0 + 4.0 * math.cos(ph - 1.0),
                 jaw=5.0)
    else:
        # heavy walk: settles into each step, big hip sway
        q.update(pelvis_z=-3.4 - 0.7 * bob, pelvis_x=0.6, pelvis_pitch=4.0, spine=2.0, chest=1.0,
                 head=-2.0 + 2.0 * math.cos(ph - 0.5), neck1=1.0 * math.cos(ph - 0.3),
                 pelvis_yaw=-6.0 * c, chest_yaw=8.0 * c, pelvis_roll=-3.5 * c, chest_roll=2.0 * c,
                 spread=4.0, flap=2.0 - 5.0 * math.cos(ph - 0.9), flap2=-3.0 * math.cos(ph - 1.5),
                 arm_raise=4.0 + 9.0 * c, elbow=12.0 + 4.0 * c, tail_lift=2.0)
    p = apply(rig, q, legs=False)
    # side to side weight shift over the stance foot
    mv(p, "pelvis", y=(1.8 if not run else 0.8) * math.cos(2 * math.pi * (t - st)))
    for s, k in (("l", 1), ("r", -1)):
        sw = c * k
        p.rot(f"arm_{s}", y=(12.0 if not run else 10.0) * sw)
    tail_sway(p, t, 10.0 if not run else 7.0, lag=0.11, phase=0.15, vertical=3.0 if run else 1.5)
    R.walk_legs(rig, p, t, [("thigh_l", "shin_l", "foot_l"), ("thigh_r", "shin_r", "foot_r")],
                stride=g["stride"] * S, lift=g["lift"] * S, duty=g["duty"], phases=[0.0, 0.5],
                foot_pitch=30.0 if run else 18.0)
    return flame_pose(rig, p, t, dur)


def seq_gait(rig, name, g, run):
    return R.make_sequence(rig, name, lambda t: gait_pose(rig, t, g, run), frames=g["frames"], fps=g["fps"],
                           loop=True, activity=mdl.ACT["RUN" if run else "WALK"],
                           linear=R.gait_linear_movement(g["stride"] * S, g["duty"]))


def one_shot(rig, name, track, frames, fps, activity, overlay=None, flame=None):
    dur = (frames - 1) / fps

    def pose(t):
        q = track(t)
        p = apply(rig, q)
        if overlay:
            overlay(p, t, q)
        return flame_pose(rig, p, t, dur, scale=q["flame"] if flame is None else flame(t))
    return R.make_sequence(rig, name, pose, frames=frames, fps=fps, loop=False, activity=activity)


# Roars: the snout is kept below ~45 degrees above horizontal (the face stays readable); the arch
# comes from the spine, chest and wings.
def roar_pose(base, **kw):
    q = dict(base, pelvis_z=-1.2, spine=-11.0, chest=-13.0, neck1=-9.0, neck2=-4.0, head=-9.0, jaw=36.0,
             spread=34.0, flap=16.0, flap2=8.0, arm_raise=30.0, arm_out=16.0, elbow=44.0, tail_lift=10.0, flame=1.25)
    q.update(kw)
    return q


def seq_attack(rig):
    # 0 -> .30 rear up and inhale, .40 thrust forward with the mouth wide open (the flame), held to .94
    # (the server spreads the last 60 % over its 1.0 s stream), recover.  From the wind-up on, the head, neck and
    # chest face straight ahead (no idle look-around): the server aims the stream along the body's facing from
    # attachment 0, so the mouth stays on that axis and the head points where the flame goes.
    I = idle_params(0.0)
    A = dict(I, head_yaw=0.0, head_roll=0.0, chest_yaw=0.0)
    rear = dict(A, pelvis_z=-1.0, spine=-7.0, chest=-10.0, neck1=-10.0, neck2=-5.0, head=-10.0, jaw=10.0,
                spread=24.0, flap=22.0, flap2=8.0, arm_raise=18.0, arm_out=10.0, elbow=30.0, tail_lift=6.0)
    blast = dict(A, pelvis_z=-2.2, pelvis_x=1.0, pelvis_pitch=4.0, spine=8.0, chest=10.0, neck1=14.0, neck2=-4.0,
                 head=-26.0, jaw=34.0, spread=28.0, flap=-8.0, flap2=-8.0, fold=-0.1, arm_raise=8.0, arm_out=6.0,
                 elbow=24.0, tail_lift=10.0, flame=1.2)
    hold = dict(blast, chest=12.0, neck1=16.0, head=-29.0, jaw=37.0, flap=-2.0)
    tr = Track([(0.0, I), (0.12, dict(A, pelvis_z=-0.6, chest=-2.0, head=-4.0)), (0.30, rear),
                (0.36, dict(rear, spine=-8.0, neck1=-11.0, head=-12.0)), (0.40, blast), (0.62, hold),
                (0.94, dict(hold, chest=11.0, jaw=35.0, flap=-4.0)), (0.98, dict(A, jaw=8.0, chest=2.0, head=-2.0)),
                (1.0, I)])

    def overlay(p, t, q):
        # breath tremor while the flame pours out (a slight sway only: the stream itself does not sweep)
        w = R.pulse(t, 0.40, 0.46, 0.92, 0.97)
        p.rot("head", z=1.5 * w * math.sin(2 * math.pi * (t - 0.4) * 2.2), x=1.5 * w * math.sin(2 * math.pi * t * 9))
        p.rot("chest", z=1.5 * w * math.sin(2 * math.pi * (t - 0.4) * 2.2 - 0.6))
        tail_sway(p, t, 5.0, lag=0.12)
    return one_shot(rig, "attack", tr, 40, 27, mdl.ACT["RANGE_ATTACK1"], overlay)


def seq_flinch(rig):
    I = idle_params(0.0)
    hit = dict(I, pelvis_z=-1.4, pelvis_x=-0.8, spine=-6.0, chest=-9.0, chest_yaw=-8.0, neck1=-8.0, neck2=6.0,
               head=-14.0, head_yaw=16.0, head_roll=-10.0, jaw=18.0, spread=18.0, flap=16.0, flap2=10.0,
               arm_raise=14.0, arm_out=12.0, elbow=30.0, tail_lift=6.0, tail_curl=10.0)
    tr = Track([(0.0, I), (0.18, hit), (0.38, dict(hit, chest=-6.0, head=-9.0, jaw=8.0, flap=6.0, head_yaw=10.0)),
                (0.7, dict(I, chest=1.0, head=1.5, flap=-2.0)), (1.0, I)])
    return one_shot(rig, "flinch", tr, 13, 24, mdl.ACT["SMALL_FLINCH"])


def seq_die(rig):
    I = idle_params(0.0)
    roar = roar_pose(I, jaw=34.0, spread=26.0, flap=24.0, flap2=10.0, arm_raise=20.0, arm_out=14.0, elbow=30.0,
                     flame=1.0)
    sag = dict(I, pelvis_z=-6.0, pelvis_pitch=8.0, spine=10.0, chest=12.0, neck1=16.0, neck2=8.0, head=4.0,
               jaw=10.0, spread=6.0, flap=-8.0, fold=0.35, arm_raise=2.0, elbow=6.0, tail_droop=6.0,
               chest_roll=6.0, flame=0.8, plant=1.0)
    kneel = dict(sag, pelvis_z=-12.0, root_roll=18.0, root_y=2.0, pelvis_pitch=10.0, spine=14.0, chest=12.0,
                 neck1=24.0, neck2=14.0, head=10.0, jaw=6.0, flap=-12.0, fold=0.55, tail_droop=10.0, flame=0.6,
                 foot_l_x=1.0, flap_r=20.0, plant=1.0)
    # lying on its right side, the torso centred near the origin (inside the hull), the neck slumped
    down = dict(kneel, root_roll=84.0, root_y=17.0, root_z=11.5, pelvis_z=-10.0, spine=6.0, chest=4.0,
                neck1=12.0, neck2=6.0, head=2.0, head_roll=-14.0, jaw=10.0, spread=-6.0, flap=-28.0, fold=0.7,
                flap_r=30.0, spread_r=-60.0, fold_r=0.15, arm_raise=10.0, elbow=10.0, arm_out_r=-14.0,
                head_yaw=-20.0, tail_droop=2.0, tail_curl=14.0, foot_r_y=10.0, foot_r_z=3.0, foot_r_x=3.0, foot_l_x=3.0, flame=0.35,
                plant=0.0)
    rest = dict(down, root_roll=88.0, root_z=12.8, neck1=15.0, neck2=7.0, head=3.0, head_yaw=-30.0, head_roll=-6.0,
                jaw=12.0, flap=-34.0, tail_curl=20.0, flame=0.42)
    tr = Track([(0.0, I), (0.12, roar), (0.22, dict(roar, head=-7.0, jaw=28.0)), (0.40, sag), (0.55, kneel),
                (0.76, down), (0.84, dict(down, root_roll=91.0, root_z=13.4, flap=-26.0)), (0.92, rest),
                (1.0, rest)])
    return one_shot(rig, "die", tr, 40, 20, mdl.ACT["DIESIMPLE"])


def seq_spawn(rig):
    I = idle_params(0.0)
    # curled up as it pops out of the ball: snout tilted down but visible, wings folded down along the back
    curl = dict(I, pelvis_z=-9.0, pelvis_pitch=6.0, spine=18.0, chest=16.0, neck1=14.0, neck2=8.0, head=-32.0,
                spread=0.0, flap=10.0, wing_pitch=-110.0, fold=0.95, flap2=-10.0, arm_raise=10.0, arm_out=-4.0, elbow=40.0,
                tail_curl=120.0, tail_droop=4.0, flame=0.55)
    rise = dict(I, pelvis_z=-1.5, spine=-4.0, chest=-6.0, neck1=-6.0, neck2=-3.0, head=-8.0, jaw=6.0,
                spread=30.0, flap=26.0, flap2=12.0, arm_raise=14.0, arm_out=10.0, elbow=24.0, tail_lift=8.0,
                flame=1.15)
    roar = roar_pose(I)
    tr = Track([(0.0, curl), (0.12, dict(curl, pelvis_z=-9.4, spine=20.0)), (0.40, rise), (0.52, roar),
                (0.74, dict(roar, head=-7.0, jaw=32.0, flap=22.0)), (0.88, dict(I, jaw=4.0, flap=-3.0)),
                (1.0, I)])

    def overlay(p, t, q):
        w = R.pulse(t, 0.5, 0.56, 0.74, 0.86)
        p.rot("head", x=2.0 * w * math.sin(2 * math.pi * t * 11))
        tail_sway(p, t, 6.0, lag=0.12)
    return one_shot(rig, "spawn", tr, 30, 25, mdl.ACT["ARM"], overlay)


def seq_victory(rig):
    # wing-assisted hop: anticipation (wings up), jump on a full downbeat, hang at the apex, land with a
    # squash, then a roar with two flaps.  44 frames at 20 fps (2.15 s).
    I = idle_params(0.0)
    crouch = dict(I, pelvis_z=-9.0, pelvis_pitch=8.0, spine=12.0, chest=8.0, neck1=6.0, neck2=2.0, head=-2.0,
                  spread=26.0, flap=40.0, flap2=18.0, arm_raise=6.0, elbow=34.0, tail_droop=6.0, plant=1.0)
    push = dict(I, root_z=9.0, pelvis_z=0.5, pelvis_pitch=-2.0, spine=-6.0, chest=-8.0, neck1=-6.0, neck2=-3.0,
                head=-12.0, jaw=10.0, spread=32.0, flap=-20.0, flap2=-10.0, arm_raise=34.0, arm_out=14.0,
                elbow=46.0, tail_lift=10.0, foot_l_z=3.0, foot_r_z=3.0, foot_pitch_l=26.0, foot_pitch_r=26.0,
                flame=1.25)
    apex = dict(push, root_z=20.0, pelvis_z=-1.0, flap=-40.0, flap2=-18.0, spread=30.0, head=-14.0, jaw=16.0,
                foot_l_z=4.0, foot_r_z=4.0, foot_l_x=2.0, foot_r_x=2.0, foot_pitch_l=26.0, foot_pitch_r=26.0,
                tail_lift=14.0)
    apex2 = dict(apex, root_z=19.0, flap=-20.0, flap2=-4.0, spread=34.0)
    fall = dict(apex, root_z=6.0, pelvis_z=-0.5, flap=12.0, flap2=8.0, spread=36.0, foot_l_z=1.0, foot_r_z=1.0,
                foot_l_x=0.5, foot_r_x=0.5, foot_pitch_l=8.0, foot_pitch_r=8.0, jaw=6.0, head=-6.0)
    land = dict(I, pelvis_z=-7.0, pelvis_pitch=6.0, spine=8.0, chest=6.0, neck1=6.0, head=2.0, spread=30.0,
                flap=22.0, flap2=10.0, arm_raise=18.0, elbow=30.0, tail_droop=4.0, flame=1.1, plant=1.0)
    settle = dict(I, pelvis_z=-2.0, spine=1.0, chest=0.0, spread=20.0, flap=6.0, arm_raise=14.0, elbow=24.0,
                  flame=1.1)
    roar = roar_pose(I, arm_raise=46.0, arm_out=20.0, elbow=56.0, flame=1.3)
    tr = Track([(0.0, I), (0.12, crouch), (0.17, dict(crouch, pelvis_z=-9.4)), (0.22, push), (0.28, apex),
                (0.34, apex2), (0.41, fall), (0.45, land), (0.52, settle), (0.60, roar),
                (0.68, dict(roar, flap=-12.0, flap2=-8.0)), (0.76, dict(roar, flap=22.0, head=-8.0)),
                (0.84, dict(roar, flap=-8.0, flap2=-6.0, jaw=26.0)), (0.91, dict(I, jaw=6.0, flap=3.0)), (1.0, I)])

    def overlay(p, t, q):
        w = R.pulse(t, 0.57, 0.62, 0.82, 0.9)
        p.rot("head", x=2.5 * w * math.sin(2 * math.pi * t * 14))
        tail_sway(p, t, 8.0, lag=0.12, freq=2)
    return one_shot(rig, "victory", tr, 44, 20, mdl.ACT["VICTORY_DANCE"], overlay)


def make_sequences(rig):
    return [seq_idle(rig), seq_gait(rig, "walk", WALK, False), seq_gait(rig, "run", RUN, True), seq_attack(rig),
            seq_flinch(rig), seq_die(rig), seq_spawn(rig), seq_victory(rig)]


def build(out):
    out["models/pokemon/charizard.mdl"] = make_model()
