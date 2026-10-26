"""Blastoise (Tortank): models/pokemon/blastoise.mdl.

Official model (when installed): Game Freak's Blastoise, `plain/9.glb` under $POKEMON_OFFICIAL_DIR (default
/srv/orthros/data/installers/pokemon-official; owner's decision, never copied into the repository), imported by
`official.Importer` with its own 42-bone rig, smooth skinning and textures, scaled to 60 units.  The file has no
animation: the eight sequences are authored below on its real bones (OfficialAnimator).  Without the file, the model
generated from scratch further down is built instead (make_generated_model).

Generated model: a heavy bipedal turtle about 60 units tall: blue skin, a brown carapace with a raised cream rim, a
cream segmented plastron, two silver cannons coming out of the shell over the shoulders, small pointed ears, thick
limbs with cream claws and a short tail.

Both: facing +x, origin on the ground between the feet.  Sequences (the Pokemon model contract): idle, walk, run,
attack (braces, fires both cannons with recoil at 40 %), flinch, die (falls backward onto its shell), spawn (comes
out of its shell with a roar), victory (stomps and roars).  Attachment 0 = left cannon muzzle, 1 = right cannon muzzle.
"""
import math
import os

import numpy as np
from PIL import Image

from .. import builder, mdl, official, rig as R, sdf, texture as T, xform

# ---------------------------------------------------------------------------------------------------------------------
# palette

# light sky blue leaning to cyan: blue loses most under the maps' warm light, so it is kept light (QA r1: read
# as navy next to Charizard at #5b8fd8)
SKIN = T.rgb("#74b0f2")
SKIN_DARK = T.rgb("#4e88cc")
SKIN_LIGHT = T.rgb("#a8d6fc")
SHELL = T.rgb("#a56b3c")
SHELL_DARK = T.rgb("#74482a")
SHELL_LIGHT = T.rgb("#c8925a")
RIM = T.rgb("#f8f0d8")
PLASTRON = T.rgb("#eedc9e")
PLASTRON_LINE = T.rgb("#b3925a")
METAL = T.rgb("#aeb6c0")
METAL_DARK = T.rgb("#5b636e")
METAL_LIGHT = T.rgb("#eef3f8")
BORE = T.rgb("#16191e")
CLAW = T.rgb("#f3efe2")
MOUTH = T.rgb("#6e2230")
THROAT = T.rgb("#240a10")
TONGUE = T.rgb("#d46a7a")
SHADOW = "#5a5f9a"

SIDES = (("l", 1.0), ("r", -1.0))

# ---------------------------------------------------------------------------------------------------------------------
# skeleton (rest heads in model space)


def side(v, s):
    return (v[0], v[1] * s, v[2])


PELVIS = (0.0, 0.0, 16.0)
SPINE = (0.0, 0.0, 24.0)
NECK = (1.6, 0.0, 40.0)
HEAD = (3.2, 0.0, 46.5)
MOUTH_Z = 48.3
JAW = (3.4, 0.0, MOUTH_Z)
EAR = (1.2, 5.2, 55.8)
EAR_TIP = (-1.5, 8.1, 59.6)
CANNON_BASE = (1.2, 14.3, 44.95)    # pivot just inside the shell, 1.5 behind where the barrel comes out
CANNON_TIP = (14.5, 14.8, 47.5)
SHOULDER = (2.5, 14.8, 37.0)
ELBOW = (4.8, 19.6, 30.0)
WRIST = (7.6, 21.0, 24.2)
HIP = (0.6, 9.0, 15.0)
KNEE = (5.2, 10.4, 8.8)
ANKLE = (0.8, 10.8, 4.3)
TAIL1 = (-10.5, 0.0, 14.6)
TAIL2 = (-15.2, 0.0, 11.6)
TAIL_END = (-19.6, 0.0, 9.2)

CANNON_DIR = np.array(CANNON_TIP) - np.array(CANNON_BASE)
CANNON_LEN = float(np.linalg.norm(CANNON_DIR))
CANNON_DIR = CANNON_DIR / CANNON_LEN


BAND = (4.4, 5.6)                 # the dark ring around the barrel, distances from the pivot
CANNON_R, CANNON_LIP_R, CANNON_BORE_R = 3.2, 3.8, 2.1
COLLAR_MAJOR, COLLAR_MINOR = 3.9, 1.15


def cannon_dir(k):
    return CANNON_DIR * np.array([1.0, k, 1.0])


def make_rig():
    rig = R.Rig()
    rig.add("root", None, (0, 0, 0))
    rig.add("pelvis", "root", PELVIS)
    rig.add("spine", "pelvis", SPINE, tail=(0, 0, 44))
    rig.add("neck", "spine", NECK, tail=HEAD)
    rig.add("head", "neck", HEAD, tail=(9, 0, 53))
    rig.add("jaw", "head", JAW, tail=(13, 0, 47))
    for s, k in SIDES:
        rig.add(f"ear_{s}", "head", side(EAR, k), tail=side(EAR_TIP, k))
    for s, k in SIDES:
        rig.add(f"cannon_{s}", "spine", side(CANNON_BASE, k), tail=side(CANNON_TIP, k))
    for s, k in SIDES:
        rig.add(f"arm_{s}", "spine", side(SHOULDER, k))
        rig.add(f"forearm_{s}", f"arm_{s}", side(ELBOW, k))
        rig.add(f"hand_{s}", f"forearm_{s}", side(WRIST, k), tail=side((9.0, 21.6, 18.0), k))
    for s, k in SIDES:
        rig.add(f"thigh_{s}", "pelvis", side(HIP, k))
        rig.add(f"shin_{s}", f"thigh_{s}", side(KNEE, k))
        rig.add(f"foot_{s}", f"shin_{s}", side(ANKLE, k), tail=side((9.0, 10.8, 1.5), k))
    rig.add("tail1", "pelvis", TAIL1)
    rig.add("tail2", "tail1", TAIL2, tail=TAIL_END)
    return rig


# ---------------------------------------------------------------------------------------------------------------------
# shapes

CORE_C, CORE_R = np.array([1.6, 0.0, 29.0]), np.array([12.2, 15.6, 17.6])
CARA_C, CARA_R = np.array([-3.6, 0.0, 30.4]), np.array([14.8, 19.2, 19.6])
CUT_X, CUT_TILT = 1.2, 0.10       # front edge of the shell: x = CUT_X + CUT_TILT (z - 30)
CUT_Z = 13.4                      # lower edge of the shell (legs and tail come out under it)
RIM_W = 3.6                       # width of the cream rim along the edge
PLATE_LINES = (20.5, 26.5, 32.5, 38.5)


def _edge_d(p):
    """Signed distance-like value to the shell's edge (negative on the shell side)."""
    nx = 1.0 / math.sqrt(1 + CUT_TILT ** 2)
    e1 = ((p[:, 0] - CUT_X) - CUT_TILT * (p[:, 2] - 30.0)) * nx
    e2 = CUT_Z - p[:, 2]
    k = 2.0
    h = np.clip(0.5 + 0.5 * (e1 - e2) / k, 0.0, 1.0)      # smooth max: rounded corner at the hips
    return e2 * (1 - h) + e1 * h + k * h * (1 - h)


def _plate_d(p):
    """Distance to the plastron's segment lines (curving up toward the sides)."""
    y, z = p[:, 1], p[:, 2]
    d = np.full(len(p), 1e9)
    for z0 in PLATE_LINES:
        d = np.minimum(d, np.abs(z - (z0 + 0.016 * y * y)))
    return d


def core_shape():
    core = sdf.ellipsoid(CORE_C, CORE_R)

    def groove(p):  # shallow grooves between the plastron plates (front only)
        front = np.clip((p[:, 0] - 5.0) / 3.0, 0.0, 1.0)
        return 0.45 * np.exp(-(_plate_d(p) / 0.8) ** 2) * front

    return core.displace(groove, 0.46)


def carapace_shape():
    cara = sdf.ellipsoid(CARA_C, CARA_R)
    # broad shoulders: the shell rises around the cannons' bases
    mound = sdf.ellipsoid((-2.0, 12.6, 41.5), (7.5, 6.6, 6.6)).mirror_y()
    cara = sdf.union(cara, mound, k=9.0)

    def ridge(p):  # the rim stands out along the edge
        return -1.5 * np.exp(-((_edge_d(p) + RIM_W * 0.5) / (RIM_W * 0.5)) ** 2)

    cara = cara.displace(ridge, 1.6)
    edge = sdf.SDF(_edge_d, CARA_C - CARA_R - 3, CARA_C + CARA_R + 3)
    return sdf.intersect(cara, edge, k=1.3)


def _cannon_exit(k):
    """Where the cannon's axis leaves the carapace (bisection along the axis from the pivot)."""
    return surface_point(_shell_only(), side(CANNON_BASE, k), cannon_dir(k), max_dist=12.0)


_SHELL_CACHE = []


def _shell_only():
    if not _SHELL_CACHE:
        _SHELL_CACHE.append(carapace_shape())
    return _SHELL_CACHE[0]


def collar_shape(k):
    """Raised ring around the hole the cannon comes out of (a socket for the barrel)."""
    d = cannon_dir(k)
    c = _cannon_exit(k) - 0.35 * d
    return sdf.torus(tuple(c), COLLAR_MAJOR, COLLAR_MINOR, axis=tuple(d))


def torso_shape():
    t = sdf.union(core_shape(), carapace_shape(), k=0.7)
    return sdf.union(t, collar_shape(1.0), collar_shape(-1.0), k=0.9)


def neck_shape():
    return sdf.rounded_cone((0.5, 0.0, 37.0), (3.8, 0.0, 47.0), 6.9, 6.0)


def head_full():
    skull = sdf.ellipsoid((4.6, 0.0, 51.4), (7.0, 7.7, 6.6))
    snout = sdf.ellipsoid((9.4, 0.0, 49.3), (5.0, 5.9, 4.3))
    cheeks = sdf.ellipsoid((6.0, 3.7, 48.8), (4.3, 3.7, 3.3)).mirror_y()
    brow = sdf.ellipsoid((8.9, 3.4, 54.0), (2.6, 2.7, 1.6)).mirror_y()
    h = sdf.union(skull, snout, k=3.0)
    h = sdf.union(h, cheeks, k=2.0)
    return sdf.union(h, brow, k=1.6)


def _mouth_plane(p):
    return p[:, 2] - (MOUTH_Z - 0.03 * (p[:, 0] - JAW[0]))


def jaw_region():
    below = sdf.SDF(_mouth_plane, (-30, -30, 0), (30, 30, 80))
    front = sdf.SDF(lambda p: (JAW[0] - 0.4) - p[:, 0], (-30, -30, 0), (30, 30, 80))
    return sdf.intersect(below, front)


def head_shape():
    return sdf.subtract(head_full(), jaw_region(), k=0.45)


def jaw_shape():
    return sdf.intersect(head_full(), jaw_region(), k=0.45)


def ear_shape(k):
    a, b = side(EAR, k), side(EAR_TIP, k)
    a = (a[0], a[1], a[2] + 0.6)
    cone = sdf.rounded_cone(a, b, 2.1, 0.45)
    return cone.stretch((0.6, 1.0, 1.0), center=a)


def cannon_shape(k):
    a = np.array(side(CANNON_BASE, k))
    b = np.array(side(CANNON_TIP, k))
    d = cannon_dir(k)
    barrel = sdf.cylinder(a - 5.0 * d, b, CANNON_R, round_r=0.5)     # deep in the shell: never shows its end
    lip = sdf.cylinder(b - 2.5 * d, b + 0.1 * d, CANNON_LIP_R, round_r=0.8)
    band = sdf.cylinder(a + BAND[0] * d, a + BAND[1] * d, CANNON_R + 0.35, round_r=0.45)
    c = sdf.union(barrel, lip, k=0.5)
    c = sdf.union(c, band, k=0.4)
    bore = sdf.cylinder(b - 3.0 * d, b + 2.0 * d, CANNON_BORE_R)
    return sdf.subtract(c, bore, k=0.35)



def upperarm_shape(k):
    return sdf.rounded_cone(side(SHOULDER, k), side(ELBOW, k), 5.4, 4.9)


def forearm_shape(k):
    return sdf.rounded_cone(side(ELBOW, k), side(WRIST, k), 4.9, 4.3)


HAND_C = (8.4, 21.4, 21.4)


def hand_shape(k):
    palm = sdf.ellipsoid(side(HAND_C, k), (3.9, 3.5, 3.8))
    fingers = []
    for dx, dy in ((2.3, -1.9), (3.0, 0.3), (1.5, 2.3)):
        a = side((HAND_C[0] + dx * 0.4, HAND_C[1] + dy * 0.5, 20.2), k)
        b = side((HAND_C[0] + dx, HAND_C[1] + dy, 16.6), k)
        fingers.append(sdf.rounded_cone(a, b, 1.7, 1.1))
    return sdf.union(palm, *fingers, k=1.0)


def thigh_shape(k):
    return sdf.rounded_cone(side(HIP, k), side(KNEE, k), 6.3, 5.2)


def shin_shape(k):
    return sdf.rounded_cone(side(KNEE, k), side(ANKLE, k), 5.2, 4.4)


def foot_shape(k):
    sole = sdf.ellipsoid(side((3.2, 10.8, 2.5), k), (6.4, 5.0, 3.0))
    ankle = sdf.sphere(side(ANKLE, k), 4.3)
    claws = []
    for dy in (-2.9, 0.0, 2.9):
        a = side((7.4, 10.8 + dy, 1.9), k)
        b = side((10.2, 10.8 + dy * 1.1, 1.0), k)
        claws.append(sdf.rounded_cone(a, b, 1.45, 0.55))
    f = sdf.union(sole, ankle, k=2.5)
    f = sdf.union(f, *claws, k=0.8)
    floor = sdf.halfspace((0, 0, 0.0), (0, 0, -1))
    return sdf.intersect(f, floor, k=0.6)


def tail_shape():
    return sdf.tube([(-7.5, 0.0, 16.0), TAIL1, TAIL2, TAIL_END], [4.8, 4.4, 3.0, 1.0])


# ---------------------------------------------------------------------------------------------------------------------
# paint


def surface_point(shape, inside, direction, max_dist=40.0):
    """Point where the ray from `inside` along `direction` leaves the shape (bisection)."""
    o = np.asarray(inside, dtype=np.float64)
    d = np.asarray(direction, dtype=np.float64)
    d = d / np.linalg.norm(d)
    lo, hi = 0.0, max_dist
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if shape(o + d * mid) < 0:
            lo = mid
        else:
            hi = mid
    return o + d * lo


class Painter:
    """Paint functions.  Baked occlusion is computed per part against what stays next to it whatever the pose:
    the trunk (torso, neck, head, tail) against the trunk, each limb segment and cannon against itself only, so
    no stain shows when an arm or a leg moves away."""

    def __init__(self):
        self.core = core_shape()
        self.cara = carapace_shape()
        self.head_sdf = head_full()
        self.trunk = sdf.union(torso_shape(), neck_shape(), self.head_sdf, tail_shape())
        self.head_ears = sdf.union(self.head_sdf, ear_shape(1.0), ear_shape(-1.0))
        self.exits = {k: _cannon_exit(k) for _s, k in SIDES}
        self.eyes = []
        for _s, k in SIDES:
            d = np.array([1.0, 0.5 * k, 0.05])
            c = surface_point(self.head_sdf, (4.8, 2.8 * k, 52.6), d)
            self.eyes.append((c, d / np.linalg.norm(d), k))
        self.nostrils = [surface_point(self.head_sdf, (9.0, 1.25 * k, 50.6), (1, 0.15 * k, 0.25)) for k in (1, -1)]

    @staticmethod
    def finish(c, P, N, occ, ao_dist=3.0, top=0.16, ao_strength=0.62):
        """Soft top light + occlusion; ao_strength (scalar or per point) also scales the cool shadow tint, so
        surfaces painted with little occlusion (the cream rim, the collars) stay clean."""
        ao = T.ambient_occlusion(occ, P, N, dist=ao_dist)
        ao = 1.0 - (1.0 - ao) * np.clip(np.asarray(ao_strength) / 0.62, 0.0, 1.0)
        return T.shade(c, N, ao=ao, ao_strength=0.62, top=top, shadow_tint=SHADOW)

    def skin(self, P, N, under=0.30, light=0.25):
        """Blue skin: lighter on top, a touch darker underneath."""
        c = T.fill(P, SKIN)
        c = T.mix(c, SKIN_LIGHT, light * T.facing(N, (0.3, 0, 1), 0.2, 1.0))
        c = T.mix(c, SKIN_DARK, under * T.facing(N, (0, 0, -1), 0.1, 1.0))
        return c

    # parts ---------------------------------------------------------------------------------------------------
    def torso(self, P, N, skin):
        e = _edge_d(P)
        on_shell = T.edge(self.cara(P) - self.core(P), 0.3)
        # carapace: brown, darker low, a broad sheen on the upper back, a darker band just inside the rim
        sh = T.gradient(P, (0, 0, 1), 20.0, 44.0, SHELL_DARK, SHELL)
        sh = T.mix(sh, SHELL_LIGHT, 0.7 * T.facing(N, (-0.55, 0.25, 0.8), 0.35, 1.0))
        inside_rim = T.edge(-(e + RIM_W + 2.4), 1.0) * (1 - T.edge(-(e + RIM_W + 0.1), 0.5))
        sh = T.mix(sh, SHELL_DARK, 0.42 * inside_rim)
        # plastron: cream, plate grooves with a light bevel above each one
        pl = T.fill(P, PLASTRON)
        pl = T.mix(pl, T.rgb("#f7edc4"), 0.55 * T.facing(N, (1, 0, 0.25), 0.55, 1.0))
        front = np.clip((P[:, 0] - 4.0) / 3.0, 0, 1)
        y, z = P[:, 1], P[:, 2]
        bevel = np.full(len(P), 1e9)
        for z0 in PLATE_LINES:
            bevel = np.minimum(bevel, np.abs(z - (z0 + 0.016 * y * y + 0.95)))
        pl = T.mix(pl, T.rgb("#fff6d8"), 0.75 * T.edge(bevel - 0.3, 0.3) * front)
        line = T.edge(_plate_d(P) - 0.45, 0.35) * front
        pl = T.mix(pl, PLASTRON_LINE, 0.85 * line)
        c = T.mix(pl, sh, on_shell)
        # cream rim on the raised edge of the shell, a thin dark line on its inner side
        rim = T.edge(-(e + RIM_W), 0.35) * on_shell
        c = T.mix(c, RIM, rim)
        inner = T.edge(np.abs(e + RIM_W) - 0.2, 0.25) * on_shell
        c = T.mix(c, SHELL_DARK * 0.8, 0.75 * inner)
        sep = T.edge(np.abs(e) - 0.25, 0.3) * (1 - on_shell)
        c = T.mix(c, PLASTRON_LINE * 0.75, 0.7 * sep)
        # collars around the cannon holes: a cream ring, dark inside where the barrel goes in
        collar = np.zeros(len(P))
        for _s, k in SIDES:
            d = cannon_dir(k)
            q = P - self.exits[k]
            along = q @ d
            r = np.linalg.norm(q - np.outer(along, d), axis=1)
            ring = T.edge(r - (COLLAR_MAJOR + COLLAR_MINOR + 0.35), 0.3) * T.edge(np.abs(along + 0.35) - 2.2, 0.4)
            c = T.mix(c, RIM, ring)
            c = T.mix(c, SHELL_DARK * 0.45, ring * T.edge(r - (COLLAR_MAJOR - 0.25), 0.35))
            collar = np.maximum(collar, ring)
        ao_s = 0.5 * (1 - on_shell) + 0.35 * on_shell
        ao_s = ao_s * (1 - rim) * (1 - collar) + 0.06 * np.maximum(rim, collar)
        return self.finish(c, P, N, self.trunk, ao_dist=3.5, ao_strength=ao_s)

    def neck(self, P, N, skin):
        # the top of the neck sits inside the head: it is the back of the throat seen when the jaw opens
        inside = T.edge(self.head_sdf(P) + 0.5, 0.35)
        c = T.mix(self.skin(P, N), T.mix(MOUTH, THROAT, np.clip((8.0 - P[:, 0]) / 4.0, 0, 1)), inside)
        return self.finish(c, P, N, self.trunk, ao_strength=0.62 * (1 - inside))

    def _inside(self, P, depth=0.3):
        """1 on the faces cut through the head (mouth roof / floor), 0 on its outer skin."""
        return T.edge(self.head_sdf(P) + depth, 0.2)

    def head(self, P, N, skin):
        c = self.skin(P, N)
        mp = _mouth_plane(P)
        # mouth roof: the whole cut face under the upper head
        roof = self._inside(P) * T.edge(np.abs(mp) - 0.6, 0.3)
        c = T.mix(c, T.mix(MOUTH, THROAT, np.clip((7.0 - P[:, 0]) / 5.0, 0, 1)), roof)
        # mouth line on the outside
        lip = T.edge(np.abs(mp) - 0.16, 0.2) * (P[:, 0] > JAW[0] + 1.5) * (1 - roof)
        c = T.mix(c, SKIN_DARK * 0.4, 0.9 * lip)
        for ec, ed, k in self.eyes:
            col, m = T.eye(P, ec, ed, (1.9, 2.2), iris="#6a3420", iris_radius=0.62, pupil="#120a08",
                           pupil_radius=0.34, sclera="#fbfaf4", highlight="#ffffff", highlight_pos=(0.12, 0.40),
                           highlight_radius=0.27, look=(0.18, -0.05), soft=0.12, outline="#141019",
                           outline_width=0.22)
            # heavy brow: the lid covers the upper inner part of the eye (determined look)
            q = P - ec
            upv = np.array([0, 0, 1.0])
            right = np.cross(ed, upv)
            right /= np.linalg.norm(right)
            u = q @ right * (-k)   # > 0 toward the nose
            v = q @ upv
            lid_v = 1.0 - 0.40 * u
            m = m * (1 - T.edge(-(v - lid_v), 0.12))
            c = T.mix(c, col, m)
            lidline = T.edge(np.abs(v - lid_v) - 0.22, 0.14) * T.ellipse(P, ec, (2.7, 2.7, 2.7), soft=0.4)
            c = T.mix(c, "#1b2240", 0.92 * lidline * (u > -2.25))
        for n in self.nostrils:
            c = T.mix(c, SKIN_DARK * 0.45, T.spot(P, n, 0.32, soft=0.2))
        return self.finish(c, P, N, self.head_ears, ao_dist=2.0, ao_strength=0.62 * (1 - roof))

    def jaw(self, P, N, skin):
        c = self.skin(P, N)
        mp = _mouth_plane(P)
        floor = self._inside(P) * T.edge(np.abs(mp) - 0.6, 0.3)
        tongue = T.ellipse(P, (8.6, 0.0, MOUTH_Z), (3.4, 2.5, 1.2), soft=0.5)
        inner = T.mix(MOUTH, THROAT, np.clip((6.0 - P[:, 0]) / 4.0, 0, 1))
        c = T.mix(c, T.mix(inner, TONGUE, tongue), floor)
        lip = T.edge(np.abs(mp) - 0.16, 0.2) * (P[:, 0] > JAW[0] + 1.5) * (1 - floor)
        c = T.mix(c, SKIN_DARK * 0.4, 0.9 * lip)
        return self.finish(c, P, N, self.head_sdf, ao_dist=2.0, ao_strength=0.62 * (1 - floor))

    def ear(self, P, N, skin):
        c = self.skin(P, N)
        c = T.mix(c, SKIN_DARK, 0.45 * T.facing(N, (1, 0, 0.2), 0.3, 0.8))
        return self.finish(c, P, N, self.head_ears, ao_dist=1.5)

    def cannon(self, P, N, skin):
        k = 1.0 if np.mean(P[:, 1]) > 0 else -1.0
        a = np.array(side(CANNON_BASE, k))
        d = cannon_dir(k)
        q = P - a
        along = q @ d
        radial_v = q - np.outer(along, d)
        r = np.linalg.norm(radial_v, axis=1)
        up = np.array([0, 0, 1.0]) - d * d[2]
        up /= np.linalg.norm(up)
        cosu = (radial_v @ up) / np.maximum(r, 1e-6)
        # polished metal: bright top streak, dark underside
        c = T.mix(METAL_DARK, METAL, np.clip(0.55 + 0.6 * cosu, 0, 1))
        c = T.mix(c, METAL_LIGHT, T.edge(np.abs(cosu - 0.75) - 0.14, 0.14) * (along < CANNON_LEN - 0.5))
        c = T.mix(c, BORE, T.edge(r - (CANNON_BORE_R + 0.15), 0.25) * (along > CANNON_LEN - 3.2))
        for s0 in (CANNON_LEN - 2.5, BAND[0], BAND[1]):
            c = T.mix(c, METAL_DARK * 0.8, 0.6 * T.edge(np.abs(along - s0) - 0.14, 0.2) * (r > CANNON_BORE_R + 0.2))
        # darker where it enters the collar
        c = T.mix(c, METAL_DARK * 0.6, 0.6 * T.edge(along - 1.9, 0.6))
        ao = T.ambient_occlusion(self.cannon_occ[k], P, N, dist=2.5)
        return T.shade(c, N, ao=ao, ao_strength=0.55, top=0.1)

    def limb_paint(self, shape, under=0.08, ao_dist=1.5):
        """Arm and leg segments: occluded by themselves only (they swing far from the body)."""
        def paint(P, N, skin):
            # little directional paint: it is baked in the rest pose and these parts turn far from it
            return self.finish(self.skin(P, N, under=under, light=0.1), P, N, shape, ao_dist=ao_dist,
                               ao_strength=0.45, top=0.08)
        return paint

    def hand_paint(self, shape):
        def paint(P, N, skin):
            c = self.skin(P, N, under=0.08, light=0.1)
            c = T.mix(c, CLAW, T.halfspace(P, (0, 0, 17.0), (0, 0, -1), soft=0.45))
            return self.finish(c, P, N, shape, ao_dist=1.5)
        return paint

    def foot_paint(self, shape):
        def paint(P, N, skin):
            c = self.skin(P, N)
            c = T.mix(c, CLAW, T.halfspace(P, (8.7, 0, 0), (1, 0, -0.25), soft=0.5))
            c = T.mix(c, SKIN_DARK, 0.35 * T.facing(N, (0, 0, -1), 0.5, 0.9))
            return self.finish(c, P, N, shape, ao_dist=1.5)
        return paint

    def tail(self, P, N, skin):
        return self.finish(self.skin(P, N), P, N, self.trunk)


# ---------------------------------------------------------------------------------------------------------------------
# model


def make_builder(verbose=False):
    rig = make_rig()
    pt = Painter()
    b = builder.ModelBuilder("pokemon/blastoise.mdl", rig, verbose=verbose)
    b.group("body", size=(512, 256), pack="skyline")
    b.group("limbs", size=(512, 256), pack="skyline")
    b.group("head", size=(512, 256), pack="skyline")
    P = builder.Part
    round_charts = {"smooth_iters": 8, "min_dot": 0.2}
    b.add(P("torso", torso_shape(), bone="spine", paint=pt.torso, group="body", budget=860))
    b.add(P("tail", tail_shape(), bones=["tail1", "tail2"], paint=pt.tail, group="body", budget=90))
    b.add(P("neck", neck_shape(), bone="neck", paint=pt.neck, group="head", budget=110, density=0.5))
    b.add(P("head", head_shape(), bone="head", paint=pt.head, group="head", budget=470, density=1.3))
    b.add(P("jaw", jaw_shape(), bone="jaw", paint=pt.jaw, group="head", budget=130, density=0.6))
    pt.cannon_occ = {}
    for s, k in SIDES:
        b.add(P(f"ear_{s}", ear_shape(k), bone=f"ear_{s}", paint=pt.ear, group="head", budget=36))
        pt.cannon_occ[k] = cannon_shape(k)
        b.add(P(f"cannon_{s}", pt.cannon_occ[k], bone=f"cannon_{s}", paint=pt.cannon, group="head", budget=150,
                density=0.8))
        for name, shape, bone, budget, paint in (
                ("arm", upperarm_shape(k), "arm", 70, None), ("forearm", forearm_shape(k), "forearm", 60, None),
                ("hand", hand_shape(k), "hand", 100, pt.hand_paint), ("thigh", thigh_shape(k), "thigh", 75, None),
                ("shin", shin_shape(k), "shin", 50, None), ("foot", foot_shape(k), "foot", 110, pt.foot_paint)):
            paint = (paint or pt.limb_paint)(shape)
            b.add(P(f"{name}_{s}", shape, bone=f"{bone}_{s}", paint=paint, group="limbs", budget=budget,
                    charts=round_charts if name in ("arm", "forearm", "thigh", "shin") else None))
    return b, rig


def make_generated_model(verbose=False):
    """The model generated from scratch (used when the official source file is not installed)."""
    b, rig = make_builder(verbose)
    b.mesh_parts()
    anim = Animator(rig, b)
    for seq in anim.sequences():
        b.add_sequence(seq)
    for s, k in SIDES:
        tip = np.array(side(CANNON_TIP, k)) + cannon_dir(k) * 0.6
        b.attachment(f"cannon_{s}", f"cannon_{s}", tuple(tip))
    b.eyeposition = (8.0, 0.0, 52.5)
    b.hull = ((-16.0, -16.0, 0.0), (16.0, 16.0, 72.0))
    return b.write()


def make_model(verbose=False):
    """The official model when its source is installed, else the generated one."""
    src = official_source()
    if src is not None:
        return make_official_model(src, verbose=verbose)
    return make_generated_model(verbose)


def build(out):
    out["models/pokemon/blastoise.mdl"] = make_model()


# ---------------------------------------------------------------------------------------------------------------------
# animation


LEGS = [("thigh_l", "shin_l", "foot_l"), ("thigh_r", "shin_r", "foot_r")]


class Animator:
    def __init__(self, rig, b):
        self.rig = rig
        self.verts = np.concatenate([p.tri.verts for p in b.parts])
        self.vbone = np.concatenate([p.vbone for p in b.parts])

    # helpers ---------------------------------------------------------------------------------------------------
    def plant(self, p, targets=None, pole=(1.0, 0.0, 0.0), pitch=(0.0, 0.0)):
        """Feet on the ground at their rest spots (or `targets` per side), whatever the pelvis does."""
        for i, ((up, lo, end), (s, k)) in enumerate(zip(LEGS, SIDES)):
            t = self.rig.head(end) if targets is None or targets[i] is None else np.asarray(targets[i], float)
            pl = np.array(pole, float) + np.array([0, 0.35 * k, 0])
            self.rig.solve_two_bone(p, up, lo, end, t, pole=pl, end_world_rot=xform.rot_deg(0, pitch[i], 0))
        return p

    def lowest(self, p):
        m = self.rig.skin_matrices(p)
        W = m[self.vbone]
        v = np.einsum("nij,nj->ni", W[:, :, :3], self.verts) + W[:, :, 3]
        return float(v[:, 2].min())

    def cannon_recoil(self, p, amount):
        for s, k in SIDES:
            rot = p.get_rot(f"cannon_{s}")
            d = xform.rot_deg(*rot) @ cannon_dir(k)
            p.move(f"cannon_{s}", *(-amount * d))
        return p

    def base_breath(self, p, t, amp=1.0, freq=1):
        br = R.breathe(t, freq=freq) * amp
        p.move("pelvis", z=0.25 * br)
        p.rot("spine", y=-1.0 * br)
        p.rot("neck", y=0.6 * br)
        p.rot("head", y=0.4 * br)
        for s, k in SIDES:
            p.rot(f"arm_{s}", x=1.4 * br * k)
            p.rot(f"cannon_{s}", y=-0.8 * br)
        return br

    def arms(self, p, out=0.0, swing=0.0, bend=0.0, hand=0.0, twist=0.0, sides=(1.0, 1.0)):
        """Both arms: out = abduction (deg, away from the body), swing = pitch (deg, + backward), bend = elbow
        flexion (deg, + bends the forearm forward/up), hand = wrist curl; values per side via `sides` scale."""
        for (s, k), w in zip(SIDES, sides):
            p.rot(f"arm_{s}", x=out * k * w, y=swing * w, z=twist * k * w)
            p.rot(f"forearm_{s}", y=-bend * w)
            p.rot(f"hand_{s}", y=-hand * w)
        return p

    def bone_lowest(self, p, bones):
        m = self.rig.skin_matrices(p)
        sel = np.isin(self.vbone, [self.rig.index(b) for b in bones])
        W = m[self.vbone[sel]]
        v = np.einsum("nij,nj->ni", W[:, :, :3], self.verts[sel]) + W[:, :, 3]
        return float(v[:, 2].min())

    # sequences -------------------------------------------------------------------------------------------------
    def idle(self, t):
        p = R.Pose()
        br = self.base_breath(p, t, 1.0, freq=2)
        look = R.keys(t, [(0.0, 0.0), (0.18, 0.0), (0.32, 16.0), (0.5, 16.0), (0.66, -10.0), (0.84, -10.0)],
                      interp="smooth", loop=True)
        tilt = R.keys(t, [(0.0, 0.0), (0.2, 0.0), (0.34, -4.0), (0.5, -2.0), (0.68, 3.0), (0.84, 0.0)],
                      interp="smooth", loop=True)
        p.rot("neck", z=0.35 * look)
        p.rot("head", z=0.65 * look, x=tilt, y=-0.6 * abs(look) * 0.2)
        tw = R.chain_wave(t, 2, 7.0, lag=0.15, freq=2)
        p.rot("tail1", z=tw[0])
        p.rot("tail2", z=tw[1])
        for s, k in SIDES:
            t0 = 0.36 if k > 0 else 0.72
            flick = R.pulse(t, t0, t0 + 0.025, t0 + 0.05, t0 + 0.12)
            p.rot(f"ear_{s}", x=-16 * flick * k, y=-8 * flick)
        self.arms(p, out=3.0 + 0.8 * br, bend=6.0 + 1.5 * br, hand=6.0)
        return self.plant(p)

    def walk(self, t):
        p = R.Pose()
        u = 2 * math.pi * t
        # heavy waddle: the body drops hard as each foot lands and rolls over the planted leg, the shoulders
        # counter-roll so that the head stays fairly level
        bob = -1.8 + 1.9 * abs(math.sin(u - 0.25))
        p.move("pelvis", z=bob, y=2.0 * math.sin(u - 0.15))
        p.rot("pelvis", x=-7.0 * math.sin(u - 0.15), z=-6.0 * math.cos(u))
        p.rot("spine", y=5.0 + 1.2 * math.cos(2 * u - 0.5), x=4.0 * math.sin(u - 0.35), z=3.0 * math.cos(u))
        p.rot("neck", y=-3.0 + 1.5 * math.cos(2 * u - 0.7), z=-2.0 * math.cos(u), x=1.5 * math.sin(u - 0.5))
        p.rot("head", y=-1.5 + 1.5 * math.cos(2 * u - 1.0), x=1.5 * math.sin(u - 0.6), z=-1.0 * math.cos(u))
        for s, k in SIDES:
            sw = math.cos(u - 0.3) * k            # + when this arm swings back (its leg forward)
            p.rot(f"arm_{s}", y=16.0 * sw, x=(8.0 + 3.0 * math.sin(u) * k) * k)
            p.rot(f"forearm_{s}", y=-16.0 - 10.0 * max(0.0, -sw))
            p.rot(f"hand_{s}", y=-10.0)
            p.rot(f"cannon_{s}", y=2.0 * math.cos(2 * u - 0.9))
            p.rot(f"ear_{s}", x=4.0 * math.cos(2 * u - 1.0) * k)
        tw = R.chain_wave(t, 2, 11.0, lag=0.14)
        p.rot("tail1", z=tw[0], y=3 * math.cos(2 * u - 0.8))
        p.rot("tail2", z=tw[1])
        return R.walk_legs(self.rig, p, t, LEGS, stride=WALK_STRIDE, lift=4.5, duty=WALK_DUTY, phases=[0.0, 0.5],
                           pole=(1.0, 0.0, 0.0), foot_pitch=-12.0)

    def run(self, t):
        p = R.Pose()
        u = 2 * math.pi * t
        # charging run: the shell pitched well forward over the legs, head driving ahead, arms pumping,
        # low at mid-stance and airborne between the steps
        mid = 2 * math.pi * RUN_DUTY * 0.5
        bob = -0.5 - 1.9 * math.cos(2 * (u - mid))
        p.move("pelvis", z=bob, x=-0.4, y=1.0 * math.sin(u - 0.3))
        p.rot("pelvis", x=-4.0 * math.sin(u - 0.3), z=-7.0 * math.cos(u))
        p.rot("spine", y=22.0 + 3.0 * math.cos(2 * (u - mid) - 0.6), z=5.0 * math.cos(u), x=2.0 * math.sin(u))
        p.rot("neck", y=-6.0 - 2.0 * math.cos(2 * (u - mid) - 1.0))
        p.rot("head", y=-2.0 - 1.5 * math.cos(2 * (u - mid) - 1.4), x=1.5 * math.sin(u))
        for s, k in SIDES:
            sw = math.cos(u - 0.2) * k
            p.rot(f"arm_{s}", y=34.0 * sw + 4.0, x=(14.0 + 3.0 * math.sin(u) * k) * k)
            p.rot(f"forearm_{s}", y=-62.0 - 10.0 * max(0.0, -sw))
            p.rot(f"hand_{s}", y=-35.0)
            p.rot(f"cannon_{s}", y=-3.0 + 3.0 * math.cos(2 * (u - mid) - 1.2))
            p.rot(f"ear_{s}", x=-6.0 * k, y=-20.0 + 3.0 * math.cos(2 * u - 1.0))
        tw = R.chain_wave(t, 2, 10.0, lag=0.16)
        p.rot("tail1", z=tw[0], y=16 + 4 * math.cos(2 * (u - mid) - 1.0))
        p.rot("tail2", z=tw[1], y=6 + 4 * math.cos(2 * (u - mid) - 1.4))
        return R.walk_legs(self.rig, p, t, LEGS, stride=RUN_STRIDE, lift=8.0, duty=RUN_DUTY, phases=[0.0, 0.5],
                           pole=(1.0, 0.0, 0.0), foot_pitch=-22.0)

    def attack(self, t):
        p = R.Pose()
        hit = ATTACK_HIT
        # anticipation (crouches, draws the head in, plants both hands), the shot exactly at `hit` with the
        # cannons level, then a hard shove back that settles while the jets pour out, and an ease back
        brace = R.window(t, 0.0, 0.3, R.ease_in_out) * (1.0 - R.window(t, 0.72, 1.0, R.ease_in_out))
        build = R.window(t, 0.2, hit, R.ease_in) * (t < hit)                  # trembling before the shot
        kick = 0.0
        if t >= hit:
            x = (t - hit) / 0.3
            kick = (1.0 - math.exp(-x * 14.0)) * math.exp(-2.4 * x) * math.cos(3.6 * x) * (1.0 - R.window(t, 0.72, 1.0))
        pour = R.pulse(t, hit, hit + 0.03, 0.62, 0.74)
        buzz = math.sin(t * 2 * math.pi * 17)
        shake = buzz * (0.5 * build + 0.9 * pour)
        p.move("pelvis", z=-5.0 * brace + 0.6 * kick, x=-1.0 * brace - 4.0 * kick - 1.2 * pour)
        p.rot("spine", y=18.0 * brace - 14.0 * kick - 3.0 * pour, x=0.8 * shake)
        p.move("neck", z=-4.0 * brace, x=-2.0 * brace)             # head drawn into the shell
        p.rot("neck", y=-8.0 * brace + 5.0 * kick)
        p.rot("head", y=-8.0 * brace + 7.0 * kick, z=0.8 * shake)
        p.rot("jaw", y=5.0 * brace + 14.0 * R.pulse(t, hit - 0.06, hit, 0.6, 0.72))
        self.arms(p, out=18.0 * brace + 6.0 * kick, swing=-25.0 * brace + 14.0 * kick, bend=35.0 * brace - 8.0 * kick,
                  hand=20.0 * brace)
        for s, k in SIDES:
            # the cannons level off at the target, kick up with the recoil, settle
            p.rot(f"cannon_{s}", y=-5.0 * brace - 12.0 * kick + 0.9 * shake * k)
            p.rot(f"ear_{s}", x=(-10.0 * brace - 14.0 * kick) * k, y=-14.0 * brace)
        self.cannon_recoil(p, 3.5 * max(kick, 0.0) - 0.6 * build + 0.3 * shake)
        p.rot("tail1", y=8.0 * brace - 8.0 * kick)
        p.rot("tail2", y=6.0 * brace - 8.0 * kick)
        wide = 2.2 * brace
        targets = [self.rig.head(f"foot_{s}") + np.array([0.0, wide * k, 0.0]) for s, k in SIDES]
        return self.plant(p, targets)

    def flinch(self, t):
        p = R.Pose()
        # ducks into the shell: peak at frame 2, holds 2 frames, comes back out with a small overshoot
        back = R.window(t, 0.0, 2 / 12, R.ease_out) * (1 - R.window(t, 4 / 12, 1.0, R.ease_in_out))
        over = R.pulse(t, 0.55, 0.72, 0.78, 1.0) * 0.3
        p.move("pelvis", x=-1.3 * back, z=-2.0 * back)
        p.rot("spine", y=-6.0 * back + 3.0 * over, x=4.0 * back)
        p.move("neck", z=-6.0 * back, x=-2.5 * back)
        p.rot("neck", y=-3.0 * back - 4.0 * over, z=5.0 * back)
        p.rot("head", y=10.0 * back + 3.0 * over, x=-6.0 * back)
        p.rot("jaw", y=8.0 * back)
        self.arms(p, out=-6.0 * back, swing=20.0 * back, bend=60.0 * back, hand=18.0 * back)
        for s, k in SIDES:
            p.rot(f"cannon_{s}", y=-8.0 * back + 2.0 * over)
            p.rot(f"ear_{s}", x=-18.0 * back * k, y=-16 * back)
        self.cannon_recoil(p, 2.0 * back)
        p.rot("tail1", y=-10.0 * back)
        return self.plant(p)

    def die(self, t):
        p = R.Pose()
        # 0 .. 0.18: hit, staggers; 0.18 .. 0.6: topples backward onto the shell (pivoting on the shell's back,
        # so it lands where it stood); rocks on it; the limbs and head drop onto the ground
        stag = R.window(t, 0.0, 0.12, R.ease_out)
        fall = R.window(t, 0.18, 0.6, R.ease_in)
        rock = 0.0
        if t > 0.6:
            x = (t - 0.6) / 0.4
            rock = math.exp(-4.0 * x) * math.sin(x * 2 * math.pi * 1.6)
        limp = R.window(t, 0.62, 0.95, R.ease_out)

        def lerp(a, b):
            return a + (b - a) * limp

        p.rot("root", y=-86.0 * fall + 9.0 * rock)
        p.move("root", x=DIE_SLIDE * fall - 1.8 * rock)
        p.move("pelvis", z=-1.5 * stag * (1 - fall))
        p.rot("spine", y=-8.0 * stag + 4.0 * fall)
        p.rot("neck", y=lerp(-10.0 * stag + 18.0 * fall, DIE_NECK), z=4.0 * stag * (1 - fall))
        p.rot("head", y=lerp(-14.0 * stag + 20.0 * fall - 6.0 * rock, DIE_HEAD), z=26.0 * limp, x=-8.0 * limp)
        p.rot("jaw", y=16.0 * R.pulse(t, 0.0, 0.1, 0.6, 0.85) + 7.0 * limp)
        a_out, a_swing, a_bend, a_twist = DIE_ARM
        self.arms(p, out=lerp(34.0 * stag * (1 - fall) + 20.0 * fall, a_out),
                  swing=lerp(-50.0 * fall, a_swing), bend=lerp(30.0 * stag + 26.0 * fall, a_bend),
                  hand=lerp(14.0 * fall, 6.0), twist=a_twist * limp)
        self.cannon_recoil(p, DIE_CANNON_IN * fall)
        for s, k in SIDES:
            p.rot(f"cannon_{s}", y=-6.0 * stag + DIE_CANNON * fall)
            p.rot(f"ear_{s}", x=-16.0 * stag * k, y=-14 * stag)
            p.rot(f"thigh_{s}", y=lerp(-38.0 * fall + 6 * rock, DIE_THIGH), x=8.0 * limp * k)
            p.rot(f"shin_{s}", y=lerp(30.0 * fall, DIE_SHIN))
            p.rot(f"foot_{s}", y=lerp(-18.0 * fall, 10.0))
        p.rot("tail1", y=lerp(14.0 * fall, DIE_TAIL))
        p.rot("tail2", y=DIE_TAIL * 0.5 * limp)
        if t < 0.18:
            self.plant(p)
        # nothing goes under the ground; once down, it rests on it
        low = self.lowest(p)
        p.move("root", z=-low if t > 0.6 else max(0.0, -low))
        return p

    def spawn(self, t):
        p = R.Pose()
        # withdrawn in its shell -> pops out (overshoot) -> flexes, cannons up, cries -> settles to idle
        tuck = 1.0 - R.window(t, 0.12, 0.4, R.ease_out_back)
        legs = 1.0 - R.window(t, 0.12, 0.34, R.ease_out)
        flex = R.pulse(t, 0.4, 0.54, 0.8, 0.97, R.ease_in_out)
        cry = R.pulse(t, 0.48, 0.56, 0.76, 0.86)
        shake = math.sin(t * 2 * math.pi * 10) * R.pulse(t, 0.55, 0.6, 0.74, 0.8)
        p.move("pelvis", z=-6.0 * legs + 0.6 * flex)
        p.rot("spine", y=8.0 * tuck - 5.0 * flex)
        p.move("neck", x=-4.0 * tuck, z=-10.0 * tuck)
        p.rot("neck", y=4.0 * tuck - 8.0 * flex)
        p.rot("head", y=6.0 * tuck - 10.0 * flex + 1.5 * shake, z=3.0 * shake)
        p.rot("jaw", y=22.0 * cry)
        self.arms(p, out=-14.0 * tuck + 58.0 * flex, swing=35.0 * tuck, bend=120.0 * tuck + 100.0 * flex,
                  hand=20.0 * tuck + 25.0 * flex)
        for s, k in SIDES:
            p.move(f"arm_{s}", y=-1.5 * tuck * k, z=-1.0 * tuck)
            p.rot(f"cannon_{s}", y=10.0 * tuck - 20.0 * flex + 1.0 * shake)
            p.rot(f"ear_{s}", x=(-12.0 * tuck + 8.0 * flex) * k, y=-20 * tuck)
        self.cannon_recoil(p, 3.0 * tuck)
        p.rot("tail1", y=-12.0 * tuck)
        return self.plant(p)

    def victory(self, t):
        p = R.Pose()
        # stomp left, stomp right, then both fists up pumping in turn, a roar to the sky with the cannons raised
        st_l = R.pulse(t, 0.03, 0.12, 0.14, 0.2, R.ease_out)
        st_r = R.pulse(t, 0.22, 0.31, 0.33, 0.39, R.ease_out)
        land = R.pulse(t, 0.19, 0.2, 0.21, 0.27) + R.pulse(t, 0.38, 0.39, 0.4, 0.46)
        roar = R.pulse(t, 0.46, 0.58, 0.84, 0.98, R.ease_in_out)
        held = R.pulse(t, 0.54, 0.62, 0.82, 0.9)
        shake = math.sin(t * 2 * math.pi * 9) * R.pulse(t, 0.58, 0.62, 0.8, 0.84)
        sway = 2.6 * (st_r - st_l)
        p.move("pelvis", y=sway * 0.6, z=-0.6 * (st_l + st_r) - 1.2 * land + 0.8 * roar)
        p.rot("pelvis", x=sway * 1.2)
        p.rot("spine", y=-12.0 * roar + 3.0 * (st_l + st_r) + 3.0 * land, x=-sway)
        p.rot("neck", y=-10.0 * roar)
        p.rot("head", y=-16.0 * roar + 2.0 * shake + 4.0 * land, z=3.0 * shake)
        p.rot("jaw", y=24.0 * roar + 3.0 * shake)
        for (s, k), lift_ in zip(SIDES, (st_l, st_r)):
            pump = math.sin(2 * math.pi * (6.0 * t) + (0.0 if k > 0 else math.pi)) * held   # ~3 Hz, in turn
            p.rot(f"arm_{s}", y=-62.0 * roar - 5.0 * pump, x=(52.0 * roar + 18.0 * lift_) * k)
            p.rot(f"forearm_{s}", y=-70.0 * roar - 30.0 * lift_ - 15.0 * pump, x=-14.0 * roar * k)
            p.rot(f"hand_{s}", y=-25.0 * roar - 10 * lift_)
            p.rot(f"cannon_{s}", y=-34.0 * roar + 4.0 * pump + 1.5 * shake + 3.0 * land)
            p.rot(f"ear_{s}", x=(-12.0 * roar) * k)
        tw = R.chain_wave(t, 2, 10.0 * roar + 4.0, lag=0.15, freq=4)
        p.rot("tail1", z=tw[0])
        p.rot("tail2", z=tw[1])
        targets = []
        for (s, k), lf in zip(SIDES, (st_l, st_r)):
            targets.append(self.rig.head(f"foot_{s}") + np.array([1.2 * lf, 0.4 * k * lf, 7.0 * lf]))
        return self.plant(p, targets, pitch=(-12 * st_l, -12 * st_r))

    def sequences(self):
        rig = self.rig
        mk = R.make_sequence
        A = mdl.ACT
        return [
            mk(rig, "idle", self.idle, frames=48, fps=16, loop=True, activity=A["IDLE"]),
            mk(rig, "walk", self.walk, frames=WALK_FRAMES, fps=WALK_FPS, loop=True, activity=A["WALK"],
               linear=R.gait_linear_movement(WALK_STRIDE, WALK_DUTY)),
            mk(rig, "run", self.run, frames=RUN_FRAMES, fps=RUN_FPS, loop=True, activity=A["RUN"],
               linear=R.gait_linear_movement(RUN_STRIDE, RUN_DUTY)),
            mk(rig, "attack", self.attack, frames=ATTACK_FRAMES, fps=24, activity=A["RANGE_ATTACK1"]),
            mk(rig, "flinch", self.flinch, frames=13, fps=26, activity=A["SMALL_FLINCH"]),
            mk(rig, "die", self.die, frames=41, fps=24, activity=A["DIESIMPLE"]),
            mk(rig, "spawn", self.spawn, frames=33, fps=26, activity=A["ARM"]),
            mk(rig, "victory", self.victory, frames=41, fps=20, activity=A["VICTORY_DANCE"]),
        ]


WALK_STRIDE, WALK_DUTY = 18.0, 0.56
WALK_FRAMES = 16
WALK_FPS = WALK_FRAMES / (R.gait_linear_movement(WALK_STRIDE, WALK_DUTY) / 85.0)   # ~85 units/s at rate 1
RUN_STRIDE, RUN_DUTY = 17.0, 0.28
RUN_FRAMES = 14
RUN_FPS = RUN_FRAMES / (R.gait_linear_movement(RUN_STRIDE, RUN_DUTY) / 205.0)       # ~205 units/s at rate 1
ATTACK_FRAMES = 34
ATTACK_HIT = 0.4
DIE_SLIDE = 28.0
DIE_NECK, DIE_HEAD = -40.0, -20.0      # limp: the head lolls back and to the side, toward the ground
DIE_THIGH, DIE_SHIN = 60.0, 25.0        # limp legs droop toward the ground beyond the shell's edge
DIE_ARM = (72.0, 10.0, 12.0, 85.0)      # out, swing, bend, twist of the limp arms: lying beside the shell
DIE_TAIL = -40.0
DIE_CANNON, DIE_CANNON_IN = 25.0, 2.5


# =====================================================================================================================
# official model: Game Freak's Blastoise (9.glb, the owner's choice), imported with its own rig; the file has no
# animation, so the eight sequences are authored here on its real bones (identity rest rotations, rig.py conventions)

OFFICIAL_FILE = os.path.join("plain", "9.glb")
OFFICIAL_HEIGHT = 60.0
OSIDES = (("L", 1.0), ("R", -1.0))
OLEGS = [("LThigh", "LLeg", "LFoot"), ("RThigh", "RLeg", "RFoot")]
OARMS = [("LArm", "LForeArm", "LHand"), ("RArm", "RForeArm", "RHand")]
HITBOX_BONES = ("Waist", "Head", "Jaw", "LArm", "LForeArm", "LHand", "RArm", "RForeArm", "RHand", "LThigh", "LLeg",
                "LFoot", "RThigh", "RLeg", "RFoot", "LFeelerC", "RFeelerC", "Tail1", "Tail2")


def official_source():
    """Path of the official source file, or None when it is not installed ($POKEMON_OFFICIAL_DIR)."""
    d = os.environ.get("POKEMON_OFFICIAL_DIR", "/srv/orthros/data/installers/pokemon-official")
    p = os.path.join(d, OFFICIAL_FILE)
    return p if os.path.isfile(p) else None


def _erode(m, n):
    for _ in range(n):
        e = m.copy()
        e[1:] &= m[:-1]
        e[:-1] &= m[1:]
        e[:, 1:] &= m[:, :-1]
        e[:, :-1] &= m[:, 1:]
        m = e
    return m


def _grow(m, within=None, n=1):
    for _ in range(n):
        g = m.copy()
        g[1:] |= m[:-1]
        g[:-1] |= m[1:]
        g[:, 1:] |= m[:, :-1]
        g[:, :-1] |= m[:, 1:]
        if within is not None:
            g &= within
        if (g == m).all():
            break
        m = g
    return m


def fill_hidden_flat(rgba, key=(51, 51, 51), tol=10, min_width=4, outline_luma=90.0, outline=10):
    """Texture regions painted one flat dark key colour (the parts an official model hides under its shell or
    collar: neck, collar underside) get the colours of what surrounds them, so a pose that uncovers them shows
    skin instead of a dark void.  Only regions at least 2 * min_width texels wide (small dark details such as the
    inside of the ears stay), plus the dark outline around them; the source file is untouched."""
    a = np.asarray(rgba)
    rgb = a[..., :3].astype(np.float64)
    core = np.abs(rgb - np.asarray(key, float)).max(-1) <= tol
    region = _grow(_erode(core, min_width), within=core, n=4096)          # reconstruction of the wide regions
    luma = rgb @ np.array([0.299, 0.587, 0.114])
    region = _grow(region, within=region | (luma < outline_luma), n=outline)
    if not region.any():
        return a
    filled = T.dilate(rgb / 255.0, ~region, iters=4096) * 255.0
    # then smoothed (harmonic: each filled texel the mean of its 4 neighbours) for soft gradients, no streaks
    for _ in range(300):
        f = np.pad(filled, ((1, 1), (1, 1), (0, 0)), mode="edge")
        avg = (f[:-2, 1:-1] + f[2:, 1:-1] + f[1:-1, :-2] + f[1:-1, 2:]) * 0.25
        filled = np.where(region[..., None], avg, rgb)
    out = a.copy()
    out[..., :3] = np.where(region[..., None], np.clip(np.round(filled), 0, 255), rgb).astype(np.uint8)
    return out


def upscale_masked(rgba, factor=4):
    """A small alpha-masked overlay (an iris) upscaled before the importer cuts its mask: the 1-bit edge then
    follows the smoothed outline instead of the source's texel staircase."""
    a = np.asarray(rgba)
    H, W = a.shape[:2]
    known = a[..., 3] >= 128
    rgb = a[..., :3].astype(np.float64) / 255.0
    if known.any() and not known.all():
        rgb = T.dilate(rgb, known, iters=64)
    size = (W * factor, H * factor)
    im = Image.fromarray(np.clip(np.round(rgb * 255.0), 0, 255).astype(np.uint8), "RGB").resize(size, Image.LANCZOS)
    al = Image.fromarray(a[..., 3]).resize(size, Image.BICUBIC)
    return np.dstack([np.asarray(im), np.asarray(al)])


# the official materials: #85 skin, #86 shell (carapace, collar, cannons), #87 eye whites, #88 irises (BLEND)
OFFICIAL_MATERIALS = {
    "Material #85": {"double_sided": "auto", "filter": fill_hidden_flat},
    "Material #86": {"double_sided": "auto", "filter": fill_hidden_flat},
    "Material #88": {"filter": upscale_masked},
}


# gaits: stride (units a planted foot travels per step), stance fraction; linearmovement per cycle = stride / duty
# walk: native speed 60 units/s, a 0.66 s cycle (a heavy waddle; the server plays it faster at its walking speed);
# run: a bounding charge, 0.45 s cycle at 210 units/s, airborne 56 % of each step
O_WALK_STRIDE, O_WALK_DUTY, O_WALK_LIFT, O_WALK_FRAMES, O_WALK_SPEED = 23.0, 0.58, 4.5, 20, 60.0
O_RUN_STRIDE, O_RUN_DUTY, O_RUN_LIFT, O_RUN_FRAMES, O_RUN_SPEED = 20.8, 0.22, 9.0, 18, 210.0
O_RUN_HEEL, O_FOOT_BALL = 40.0, (5.2, 1.5)   # heel lift at push-off (degrees); ball of the front toes (x from the
#                                             ankle, height): where they bend
O_ATTACK_FRAMES, O_ATTACK_FPS, O_ATTACK_HIT = 36, 24.0, 0.4


class OfficialAnimator:
    """Pose helpers and the eight sequences on the official skeleton."""

    def __init__(self, imp):
        self.imp = imp
        self.rig = imp.rig
        self.V = np.concatenate([s.pos for s in imp.surfaces])
        self.wb = np.concatenate([s.bw_bones for s in imp.surfaces])
        self.ww = np.concatenate([s.bw_weights for s in imp.surfaces]) / 255.0
        main = self.wb[:, 0]
        # the barrels (cannon bones' own vertices): axis, base (where they leave the shell), muzzle centre
        self.barrel = {}
        for s, k in OSIDES:
            P = self.V[main == imp.bone(f"{s}FeelerC")]
            c = P.mean(0)
            ax = np.linalg.svd(P - c)[2][0]
            ax = ax if ax[0] > 0 else -ax
            d = (P - c) @ ax
            self.barrel[s] = (ax, c + ax * d.min(), P[d > d.max() - 0.6].mean(0))
        self.shoulder = {s: self.rig.head(f"{s}Arm") for s, _ in OSIDES}
        # what it rolls on when it falls (not the tail: it bends out of the way)
        self.contact = ~np.isin(main, [imp.bone("Tail1"), imp.bone("Tail2")])
        # the shell and the body without the legs (what it sits down on)
        self.shell = self.contact & ~np.isin(main, [imp.bone(f"{s}{b}") for s, _ in OSIDES
                                                    for b in ("Thigh", "Leg", "Foot", "ToeA", "ToeB", "ToeC", "ToeD")])

    # geometry -------------------------------------------------------------------------------------------------
    def posed(self, p, sel=None):
        S = self.rig.skin_matrices(p)
        wb, ww, V = self.wb, self.ww, self.V
        if sel is not None:
            wb, ww, V = wb[sel], ww[sel], V[sel]
        M = np.einsum("nk,nkij->nij", np.where(wb >= 0, ww, 0.0), S[np.maximum(wb, 0)])
        return np.einsum("nij,nj->ni", M[:, :, :3], V) + M[:, :, 3]

    def lowest(self, p):
        return float(self.posed(p)[:, 2].min())

    def carried(self, p, bone, q):
        """Where the rest model-space point q is when carried by `bone` in pose p."""
        S = self.rig.skin_matrices(p)[self.rig.index(bone)]
        return S[:, :3] @ np.asarray(q, float) + S[:, 3]

    def turned(self, p, bone, v):
        """Rest model-space direction v as turned by `bone` in pose p."""
        return self.rig.world(p)[self.rig.index(bone)][:, :3] @ np.asarray(v, float)

    def turn(self, p, bone, pivot, x=0.0, y=0.0, z=0.0):
        """Add euler degrees to `bone` rotating about `pivot` (rest model space) instead of its head."""
        e0 = p.get_rot(bone)
        e1 = e0 + (x, y, z)
        d = np.asarray(pivot, float) - self.rig.head(bone)
        p.set_rot(bone, *e1)
        p.move(bone, *((xform.rot_deg(*e0) - xform.rot_deg(*e1)) @ d))
        return p

    # body parts -------------------------------------------------------------------------------------------------
    def plant(self, p, targets=None, pitch=(0.0, 0.0), pole=(1.0, 0.0, 0.0)):
        """Feet flat at their rest spots (or targets), whatever the Waist does; knees forward and a little out."""
        for i, ((up, lo, end), (s, k)) in enumerate(zip(OLEGS, OSIDES)):
            t = self.rig.head(end) if targets is None or targets[i] is None else np.asarray(targets[i], float)
            pl = np.asarray(pole, float) + (0.0, 0.3 * k, 0.0)
            self.rig.solve_two_bone(p, up, lo, end, t, pole=pl, end_world_rot=xform.rot_deg(0, pitch[i], 0))
        return p

    def arms(self, p, wrist=((4.0, 5.0, -12.5), (4.0, 5.0, -12.5)), pole=(-0.6, 1.0, -0.3), hand=(0.0, 0.0),
             hand_x=(0.0, 0.0), fingers=(0.0, 0.0)):
        """Both arms by IK: wrist offsets from the shoulder (left-side convention, mirrored for the right,
        in the Waist's frame), elbows toward `pole` (Waist frame, mirrored), then wrist curl / roll and claws."""
        for (up, lo, end), (s, k), w, h, hx, f in zip(OARMS, OSIDES, wrist, hand, hand_x, fingers):
            sh = self.shoulder[s]
            tgt = self.carried(p, "Waist", sh + np.array([w[0], w[1] * k, w[2]]))
            pl = self.turned(p, "Waist", (pole[0], pole[1] * k, pole[2]))
            self.rig.solve_two_bone(p, up, lo, end, tgt, pole=pl)
            p.rot(end, x=hx * k, y=h)
            for fn in ("FingerA", "FingerB", "FingerC"):
                p.rot(f"{s}{fn}", y=f)
        return p

    def cannons(self, p, pitch=0.0, aim_in=0.0, recoil=0.0, sides=(1.0, 1.0)):
        """Barrels turned about where they leave the shell (pitch + = muzzle down, aim_in + = toward the
        middle) and pushed back along their axis by `recoil` units."""
        for (s, k), w in zip(OSIDES, sides):
            bone = f"{s}FeelerC"
            ax, base, _ = self.barrel[s]
            self.turn(p, bone, base, y=pitch * w, z=-aim_in * k * w)
            d = xform.rot_deg(*p.get_rot(bone)) @ ax
            p.move(bone, *(-recoil * w * d))
        return p

    def tail_clear(self, p, floor=0.4):
        """Lift the tail (Tail1 pitch) until it stays above the ground: a leaning or lowered shell would push it
        under."""
        sel = np.isin(self.wb[:, 0], [self.rig.index("Tail1"), self.rig.index("Tail2")])
        for _ in range(10):
            z = float(self.posed(p, sel)[:, 2].min())
            if z >= floor - 0.05:
                break
            p.rot("Tail1", y=(floor - z) * 4.0)
        return p

    def breath(self, p, t, amp=1.0, freq=1):
        br = R.breathe(t, freq=freq) * amp
        p.move("Waist", z=0.3 * br)
        p.rot("Waist", y=-0.9 * br)
        p.rot("Neck", y=0.5 * br)
        p.rot("Head", y=0.4 * br)
        return br

    # sequences --------------------------------------------------------------------------------------------------
    def idle(self, t):
        p = R.Pose()
        u = 2 * math.pi * t
        br = self.breath(p, t, 1.0, freq=2)
        bounce = 0.5 + 0.5 * math.cos(2 * u)                 # the official battle-wait bounce, on the knees
        p.move("Waist", z=-1.2 - 0.7 * bounce)
        look = R.keys(t, [(0.0, 0.0), (0.16, 0.0), (0.3, 14.0), (0.5, 14.0), (0.64, -10.0), (0.84, -10.0)],
                      interp="smooth", loop=True)
        tilt = R.keys(t, [(0.0, 0.0), (0.18, 0.0), (0.32, -4.0), (0.5, -2.0), (0.66, 3.0), (0.84, 0.0)],
                      interp="smooth", loop=True)
        p.rot("Neck", z=0.4 * look, y=1.5 * bounce)
        p.rot("Head", z=0.6 * look, x=tilt, y=-1.0 * bounce)
        tw = R.chain_wave(t, 2, 6.0, lag=0.15, freq=2)
        p.rot("Tail1", z=tw[0], y=-2.0 * bounce)
        p.rot("Tail2", z=tw[1])
        for s, k in OSIDES:
            t0 = 0.36 if k > 0 else 0.72
            flick = R.pulse(t, t0, t0 + 0.025, t0 + 0.05, t0 + 0.12)
            p.rot(f"{s}Ear", x=-14 * flick * k, y=-8 * flick)
        self.arms(p, wrist=[(4.0, 5.0 + 0.4 * br, -12.5 + 0.6 * bounce)] * 2, hand=(10.0, 10.0))
        self.cannons(p, pitch=-0.8 * br + 1.2 * bounce)
        return self.plant(p)

    def walk(self, t):
        p = R.Pose()
        u = 2 * math.pi * t
        mid = O_WALK_DUTY / 2                                  # left foot's mid-stance
        c = math.cos(2 * math.pi * (t - mid))                  # +1 over the left foot, -1 over the right
        land = abs(math.sin(2 * math.pi * (t - 0.03)))         # 0 as each foot strikes: the body drops on it
        p.move("Waist", z=-3.1 + 1.5 * land, y=1.6 * c)
        # the hips swing with the legs (longer steps), the shell rolls over the planted foot
        p.rot("Waist", x=-6.0 * c, z=-12.0 * math.cos(u), y=4.0 + 1.0 * math.cos(2 * u - 0.6))
        # the head stays level and facing forward over the waddle (a little lag)
        p.rot("Neck", x=4.5 * math.cos(2 * math.pi * (t - mid - 0.04)), z=9.5 * math.cos(u - 0.25),
              y=-3.0 + 1.2 * math.cos(2 * u - 1.0))
        p.rot("Head", y=-1.0 + 1.0 * math.cos(2 * u - 1.4), x=1.0 * c)
        p.rot("Jaw", y=1.5 * (1 - land))
        for s, k in OSIDES:
            sw = math.cos(u - 0.35) * k                       # + when this side's arm is back (its leg forward)
            p.rot(f"{s}Ear", x=3.0 * math.cos(2 * u - 1.2) * k)
        self.arms(p, wrist=[(5.5 - 4.5 * math.cos(u - 0.35) * k, 6.0 + 0.6 * c * k, -12.0 + 0.8 * land)
                            for _, k in OSIDES], hand=(14.0, 14.0))
        self.cannons(p, pitch=2.0 * math.cos(2 * u - 1.0))
        tw = R.chain_wave(t, 2, 12.0, lag=0.14)
        p.rot("Tail1", z=tw[0], y=3 * math.cos(2 * u - 0.8))
        p.rot("Tail2", z=tw[1])
        return R.walk_legs(self.rig, p, t, OLEGS, stride=O_WALK_STRIDE, lift=O_WALK_LIFT, duty=O_WALK_DUTY,
                           phases=[0.0, 0.5], pole=(1.0, 0.0, 0.0), foot_pitch=-14.0)

    def run(self, t):
        p = R.Pose()
        # a bounding charge: short stances, long airborne arcs, a heavy landing on each foot (the body sinks and
        # the shell nods forward on the impact), the head low and looking ahead
        u = 2 * math.pi * t
        mid = 2 * math.pi * O_RUN_DUTY * 0.5
        c = math.cos(u - mid)                                  # +1 over the left foot, -1 over the right
        sd = O_RUN_DUTY / 0.5                                  # stance share of each half cycle
        h = (t % 0.5) / 0.5
        comp = math.sin(math.pi * (h / sd) ** 0.5) if h < sd else 0.0         # lands, sinks, pushes off
        air = math.sin(math.pi * (h - sd) / (1 - sd)) if h >= sd else 0.0     # airborne arc
        hl = ((t - 0.04) % 0.5) / 0.5                          # the same, a little later (follow-through)
        comp_l = math.sin(math.pi * (hl / sd) ** 0.5) if hl < sd else 0.0
        p.move("Waist", z=-1.6 - 3.4 * comp + 2.2 * air, x=2.4, y=1.0 * c)
        p.rot("Waist", y=18.0 + 4.0 * comp_l - 1.5 * air, x=-5.0 * c, z=-8.0 * math.cos(u))
        # the head does not lift off the shell (the neck's dark underside): it stays low, nodding on impacts
        p.rot("Neck", y=-6.0 - 1.5 * comp_l, z=6.0 * math.cos(u - 0.3), x=3.0 * c)
        p.rot("Head", y=-1.0 + 1.5 * comp_l)
        p.rot("Jaw", y=4.0 + 4.0 * comp_l)
        for s, k in OSIDES:
            p.rot(f"{s}Ear", y=-14.0 + 4.0 * comp_l)
        # arms pump; going back they swing out a little and bend instead of reaching behind the shoulder
        w = []
        for _, k in OSIDES:
            sw = math.cos(u - 0.3) * k                         # + when this arm is back
            w.append((6.0 - 5.0 * sw, 7.0 + 2.0 * max(sw, 0.0), -7.5 + 1.5 * math.sin(u - 0.3) * k - 1.0 * comp_l))
        self.arms(p, wrist=w, pole=(-1.0, 0.5, -0.4), hand=(-10.0, -10.0))
        self.cannons(p, pitch=-4.0 + 4.0 * comp_l)
        tw = R.chain_wave(t, 2, 10.0, lag=0.16)
        p.rot("Tail1", z=tw[0], y=-12 + 6 * comp_l)
        p.rot("Tail2", z=tw[1], y=-6 + 6 * comp_l)
        R.walk_legs(self.rig, p, t, OLEGS, stride=O_RUN_STRIDE, lift=O_RUN_LIFT, duty=O_RUN_DUTY, phases=[0.0, 0.5],
                    pole=(1.0, 0.0, 0.0), foot_pitch=-24.0)
        # push-off: late in the stance the heel comes up, the foot rolling over the ball of its toes (which stays
        # where it was planted), so the shin does not dip into the ground behind the body
        for (up, lo, end), ph in zip(OLEGS, (0.0, 0.5)):
            st = ((t + ph) % 1.0) / O_RUN_DUTY
            if 0.45 < st < 1.0:
                a = O_RUN_HEEL * R.smoothstep((st - 0.45) / 0.55)
                dx, _ = R.foot_cycle(t, O_RUN_STRIDE, O_RUN_LIFT, O_RUN_DUTY, ph)
                ankle = self.rig.head(end) + np.array([dx, 0.0, 0.0])
                ball = ankle + np.array([O_FOOT_BALL[0], 0.0, O_FOOT_BALL[1] - ankle[2]])
                rot = xform.rot_deg(0, a, 0)
                self.rig.solve_two_bone(p, up, lo, end, ball + rot @ (ankle - ball), pole=(1.0, 0.0, 0.0),
                                        end_world_rot=rot)
                for toe in ("ToeA", "ToeD"):                   # the front toes stay flat on the ground
                    p.rot(end[0] + toe, y=-a)
        return p

    def attack(self, t):
        p = R.Pose()
        hit = O_ATTACK_HIT
        # Hydro Pump: braces wide and low leaning into it, head down and the cannons levelled and converging on the
        # target, trembling as the pressure builds; at `hit` both barrels kick back and up and the whole body is
        # shoved back with a roar while the jets pour; it settles and eases back up
        brace = R.window(t, 0.0, 0.26, R.ease_in_out) * (1.0 - R.window(t, 0.74, 1.0, R.ease_in_out))
        build = R.window(t, 0.2, hit, R.ease_in) * (t < hit)
        kick = 0.0
        if t >= hit:
            x = (t - hit) / 0.3
            kick = (1.0 - math.exp(-x * 18.0)) * math.exp(-2.2 * x) * math.cos(3.0 * x) * (1.0 - R.window(t, 0.72, 1.0))
        pour = R.pulse(t, hit, hit + 0.03, 0.62, 0.76)
        shake = math.sin(t * 2 * math.pi * 17) * (0.6 * build + 1.0 * pour)
        p.move("Waist", z=-4.5 * brace - 0.8 * build + 0.8 * kick, x=1.0 * brace - 5.0 * kick - 1.5 * pour,
               y=0.3 * shake)
        p.rot("Waist", y=14.0 * brace + 2.0 * build - 15.0 * kick - 3.0 * pour, x=1.0 * shake)
        p.move("Neck", x=-1.5 * brace, z=-2.0 * brace + 1.0 * kick)
        p.rot("Neck", y=-5.0 * brace + 6.0 * kick)
        p.rot("Head", y=-2.0 * brace - 7.0 * kick, z=1.0 * shake)
        p.rot("Jaw", y=3.0 * brace + 22.0 * R.pulse(t, hit - 0.04, hit + 0.01, 0.6, 0.74))
        for s, k in OSIDES:
            p.rot(f"{s}Ear", x=(-10.0 * brace - 14.0 * kick) * k, y=-14.0 * brace)
        # fists clenched by the hips, elbows out, flung forward a little by the kick
        w = [(3.0 - 3.0 * brace + 4.0 * kick, 6.5 + 3.0 * brace, -12.0 + 1.5 * brace) for _ in OSIDES]
        self.arms(p, wrist=w, pole=(-0.6, 1.0, -0.1), hand=(10.0 + 25.0 * brace,) * 2,
                  fingers=(35.0 * brace,) * 2)
        self.cannons(p, pitch=-1.0 * brace - 14.0 * kick + 1.0 * shake, aim_in=12.0 * brace,
                     recoil=4.0 * max(kick, 0.0) + 1.0 * build + 0.3 * shake)
        p.rot("Tail1", y=8.0 * brace - 10.0 * kick)
        p.rot("Tail2", y=6.0 * brace - 10.0 * kick)
        wide = 3.5 * brace
        targets = [self.rig.head(f"{s}Foot") + np.array([0.8 * brace, wide * k, 0.0]) for s, k in OSIDES]
        return self.plant(p, targets)

    def flinch(self, t):
        p = R.Pose()
        # knocked back, ducks into its shell: peak at frame 2, holds, comes back out with a small overshoot
        back = R.window(t, 0.0, 2 / 11, R.ease_out) * (1 - R.window(t, 4 / 11, 1.0, R.ease_in_out))
        over = R.pulse(t, 0.55, 0.72, 0.78, 1.0) * 0.3
        p.move("Waist", x=-1.6 * back, z=-2.2 * back)
        p.rot("Waist", y=-7.0 * back + 3.0 * over, x=4.0 * back)
        p.move("Neck", x=-2.0 * back, z=-3.8 * back)
        p.rot("Neck", y=-4.0 * back - 4.0 * over, z=6.0 * back)
        p.rot("Head", y=8.0 * back + 3.0 * over, x=-6.0 * back)
        p.rot("Jaw", y=9.0 * back)
        for s, k in OSIDES:
            p.rot(f"{s}Ear", x=-18.0 * back * k, y=-16 * back)
        self.arms(p, wrist=[(7.5 * back + 4.0 * (1 - back), 5.0 - 1.0 * back, -12.5 + 8.0 * back)] * 2,
                  pole=(-0.6, 1.0, -0.6), hand=(10.0 + 25.0 * back,) * 2, fingers=(20.0 * back,) * 2)
        self.cannons(p, pitch=-7.0 * back + 2.0 * over, recoil=2.0 * back)
        p.rot("Tail1", y=8.0 * back)
        return self.plant(p)

    def roll_back(self, p, angle, step=2.0):
        """Topple the whole body backward by `angle` degrees as a rigid body rolling on the ground: it pivots
        on its lowest, rearmost point (the heels first, then the rim of the shell, then along the shell), so
        nothing lifts off and nothing sinks.  The Waist (the root) must only be pitched (y) so far."""
        sel = self.contact
        n = max(1, int(math.ceil(abs(angle) / step)))
        d = -angle / n
        for _ in range(n):
            P = self.posed(p, sel)
            z0 = P[:, 2].min()
            near = P[:, 2] < z0 + 0.05
            c = P[near][np.argmin(P[near][:, 0]) if d < 0 else np.argmax(P[near][:, 0])]
            S = self.rig.skin_matrices(p)[0]
            q = np.linalg.solve(S[:, :3], c - S[:, 3])
            self.turn(p, "Waist", q, y=d)
            low = self.posed(p, sel)[:, 2].min()
            if low < 0.0:
                p.move("Waist", z=-low)
        return p

    def die(self, t):
        p = R.Pose()
        # thrown back by the hit with a cry, staggers forward on buckling knees, then its feet slip forward and it
        # sits down hard on the back rim of its shell (feet still planted), rolls back along the shell onto its back
        # and rocks on it; the head lolls to the side onto the shell's rim, the limbs go limp, the tail lies flat.
        # Nothing rises once it starts going down (dev check: top and centre of mass per frame)
        hitb = R.pulse(t, 0.0, 0.06, 0.1, 0.2, R.ease_out)
        stag = R.pulse(t, 0.1, 0.2, 0.24, 0.34)
        crouch = R.window(t, 0.1, 0.22, R.ease_out)            # the knees buckle and stay bent
        sit = R.window(t, 0.28, 0.46, R.ease_in)
        roll = R.window(t, 0.44, 0.64, R.ease_in)
        fall = R.window(t, 0.3, 0.64, R.ease_in)
        slip = roll
        rock = 0.0
        if t > 0.64:
            x = (t - 0.64) / 0.36
            rock = math.exp(-4.0 * x) * math.sin(x * 2 * math.pi * 1.4)
        limp = R.window(t, 0.6, 0.92, R.ease_out)
        p.rot("Waist", y=-4.0 * hitb + 6.0 * stag - O_DIE_SIT * sit)
        p.move("Waist", z=-3.0 * hitb - 3.0 * crouch)
        # the head goes back with the roll (it would swing up otherwise), then lolls to the side
        whip = R.pulse(t, 0.42, 0.52, 0.6, 0.74)
        flop = max(limp, R.window(t, 0.38, 0.52))         # the head falls to the side as it goes down
        duck = R.pulse(t, 0.38, 0.48, 0.58, 0.7)                   # and ducks into the collar while it rolls
        p.move("Neck", x=-2.0 * duck, z=-4.0 * duck)
        p.rot("Neck", y=-6.0 * hitb + 8.0 * stag + 10.0 * sit + (O_DIE_NECK - 10.0) * roll - 40.0 * whip,
              z=5.0 * stag + O_DIE_ROLL * 0.45 * flop)
        p.rot("Head", y=-8.0 * hitb + 4.0 * stag + 6.0 * sit - 10.0 * roll - 14.0 * whip - 5.0 * rock,
              z=O_DIE_ROLL * 0.55 * flop, x=-6.0 * limp)
        p.rot("Jaw", y=22.0 * R.pulse(t, 0.0, 0.07, 0.3, 0.5) + 8.0 * R.window(t, 0.5, 0.8) + 4.0 * limp)
        for s, k in OSIDES:
            p.rot(f"{s}Ear", x=-16.0 * hitb * k, y=-14 * hitb - 10 * limp)
        w = [(4.0 + 3.0 * hitb + 2.0 * stag - 6.0 * fall, 5.0 + 6.0 * hitb + 5.0 * fall + 4.0 * limp,
              -12.5 + 6.0 * hitb + 9.0 * fall) for _ in OSIDES]
        self.arms(p, wrist=w, pole=(-0.6, 1.0, -0.3 + 0.9 * fall), hand=(10.0 - 25.0 * limp,) * 2,
                  hand_x=(-20.0 * limp,) * 2)
        self.cannons(p, pitch=-6.0 * hitb + 10.0 * fall, recoil=1.5 * fall)
        p.rot("Tail1", y=-60.0 * fall + 8.0 * rock)
        p.rot("Tail2", y=-12.0 * fall)
        # sitting down: the shell's back rim goes down to the ground (the legs fold under it, feet planted)
        if sit > 0.0:
            low = float(self.posed(p, self.shell)[:, 2].min())
            p.move("Waist", z=-low * sit)
        slipped = [self.rig.head(f"{s}Foot") + np.array([O_DIE_FEET_SLIP * sit, 0.0, 0.0]) for s, _ in OSIDES]
        self.plant(p, slipped, pole=(1.0, 0.5 * stag, 0.0))
        # rolling: the legs leave the ground with the body and go limp
        for s, k in OSIDES:
            for bone, limp_rot in ((f"{s}Thigh", (14.0 * k, -10.0 + 6 * rock, 0.0)), (f"{s}Leg", (0.0, 50.0, 0.0)),
                                   (f"{s}Foot", (10.0 * k, 25.0, 0.0))):
                e = np.asarray(p.get_rot(bone), float)
                p.set_rot(bone, *(e + (np.asarray(limp_rot) - e) * roll))
        self.roll_back(p, (O_DIE_ANGLE - O_DIE_SIT) * roll - 9.0 * rock)
        p.move("Waist", x=O_DIE_SLIDE * slip)
        self.tail_clear(p)
        # safety only (the roll keeps it on the ground): nothing under the ground
        low = self.lowest(p)
        if low < 0.0:
            p.move("Waist", z=-low)
        return p

    def spawn(self, t):
        p = R.Pose()
        # withdrawn in its shell -> pops out (overshoot) -> roars, flexing, cannons up -> settles to idle
        tuck = 1.0 - R.window(t, 0.1, 0.38, R.ease_out_back)
        legs = 1.0 - R.window(t, 0.1, 0.32, R.ease_out)
        flex = R.pulse(t, 0.38, 0.52, 0.8, 0.98, R.ease_in_out)
        cry = R.pulse(t, 0.44, 0.54, 0.76, 0.88)
        shake = math.sin(t * 2 * math.pi * 10) * R.pulse(t, 0.52, 0.58, 0.74, 0.8)
        p.move("Waist", z=-5.0 * legs + 0.6 * flex)
        p.rot("Waist", y=6.0 * tuck - 14.0 * flex)
        p.move("Neck", x=-2.0 * tuck, z=-3.5 * tuck)
        p.rot("Neck", y=4.0 * tuck - 3.0 * flex)
        p.rot("Head", y=12.0 * tuck - 4.0 * flex + 1.5 * shake, z=3.0 * shake)
        p.rot("Jaw", y=24.0 * cry)
        for s, k in OSIDES:
            p.rot(f"{s}Ear", x=(-12.0 * tuck + 8.0 * flex) * k, y=-20 * tuck)
        rest = np.array((4.0, 5.0, -12.5))
        tucked = np.array((-2.0, -1.0, -8.0))
        flexed = np.array((3.0, 9.0, 0.0))
        w = rest + (tucked - rest) * tuck + (flexed - rest) * flex
        self.arms(p, wrist=[tuple(w)] * 2, pole=(-0.6, 1.0, -0.4 - 0.6 * flex), hand=(20.0 * tuck + 30.0 * flex,) * 2,
                  fingers=(30.0 * flex,) * 2)
        self.cannons(p, pitch=8.0 * tuck - 18.0 * flex + 1.0 * shake, recoil=4.0 * tuck)
        p.rot("Tail1", y=-14.0 * tuck)
        return self.plant(p, pole=(1.0, 0.8, 0.0))

    def victory(self, t):
        p = R.Pose()
        # stomp left, stomp right, then both fists up pumping in turn, a roar to the sky with the cannons raised
        st_l = R.pulse(t, 0.03, 0.12, 0.14, 0.2, R.ease_out)
        st_r = R.pulse(t, 0.22, 0.31, 0.33, 0.39, R.ease_out)
        land = R.pulse(t, 0.19, 0.2, 0.21, 0.27) + R.pulse(t, 0.38, 0.39, 0.4, 0.46)
        roar = R.pulse(t, 0.46, 0.58, 0.84, 0.98, R.ease_in_out)
        held = R.pulse(t, 0.54, 0.62, 0.82, 0.9)
        shake = math.sin(t * 2 * math.pi * 9) * R.pulse(t, 0.58, 0.62, 0.8, 0.84)
        sway = 2.4 * (st_r - st_l)
        p.move("Waist", y=sway * 0.6, z=-1.0 - 0.6 * (st_l + st_r) - 1.4 * land + 0.8 * roar)
        p.rot("Waist", x=sway * 1.6, y=-18.0 * roar + 3.0 * (st_l + st_r) + 3.0 * land)
        p.rot("Neck", y=-3.0 * roar, x=-sway)
        p.rot("Head", y=-4.0 * roar + 2.0 * shake + 4.0 * land, z=3.0 * shake)
        p.rot("Jaw", y=26.0 * roar + 3.0 * shake)
        w = []
        for (s, k), lift_ in zip(OSIDES, (st_l, st_r)):
            pump = math.sin(2 * math.pi * (6.0 * t) + (0.0 if k > 0 else math.pi)) * held   # ~3 Hz, in turn
            rest = np.array((4.0, 5.0, -12.5))
            up = np.array((3.0, 8.0, 12.0 + 2.5 * pump))
            w.append(tuple(rest + (up - rest) * roar + np.array((2.0, 2.0, 4.0)) * lift_))
            p.rot(f"{s}Ear", x=(-12.0 * roar) * k)
        self.arms(p, wrist=w, pole=(-0.3, 1.0, -0.8 * roar), hand=(10.0 - 30.0 * roar,) * 2,
                  fingers=(25.0 * roar,) * 2)
        self.cannons(p, pitch=-30.0 * roar + 1.5 * shake + 3.0 * land)
        tw = R.chain_wave(t, 2, 10.0 * roar + 4.0, lag=0.15, freq=4)
        p.rot("Tail1", z=tw[0])
        p.rot("Tail2", z=tw[1])
        targets = [self.rig.head(f"{s}Foot") + np.array([1.2 * lf, 0.4 * k * lf, 6.0 * lf])
                   for (s, k), lf in zip(OSIDES, (st_l, st_r))]
        return self.plant(p, targets, pitch=(-12 * st_l, -12 * st_r))

    def sequences(self):
        rig, A = self.rig, mdl.ACT

        def mk(r, name, fn, **kw):
            return R.make_sequence(r, name, fn if name == "die" else (lambda t: self.tail_clear(fn(t))), **kw)

        walk_lm = R.gait_linear_movement(O_WALK_STRIDE, O_WALK_DUTY)
        run_lm = R.gait_linear_movement(O_RUN_STRIDE, O_RUN_DUTY)
        return [
            mk(rig, "idle", self.idle, frames=60, fps=20, loop=True, activity=A["IDLE"]),
            mk(rig, "walk", self.walk, frames=O_WALK_FRAMES, fps=O_WALK_FRAMES * O_WALK_SPEED / walk_lm, loop=True,
               activity=A["WALK"], linear=walk_lm),
            mk(rig, "run", self.run, frames=O_RUN_FRAMES, fps=O_RUN_FRAMES * O_RUN_SPEED / run_lm, loop=True,
               activity=A["RUN"], linear=run_lm),
            mk(rig, "attack", self.attack, frames=O_ATTACK_FRAMES, fps=O_ATTACK_FPS, activity=A["RANGE_ATTACK1"]),
            mk(rig, "flinch", self.flinch, frames=12, fps=24, activity=A["SMALL_FLINCH"]),
            mk(rig, "die", self.die, frames=40, fps=24, activity=A["DIESIMPLE"]),
            mk(rig, "spawn", self.spawn, frames=30, fps=26, activity=A["ARM"]),
            mk(rig, "victory", self.victory, frames=41, fps=20, activity=A["VICTORY_DANCE"]),
        ]


O_DIE_SLIDE, O_DIE_ANGLE, O_DIE_SIT, O_DIE_FEET_SLIP = 40.0, 96.0, 2.0, 6.0
O_DIE_NECK, O_DIE_ROLL = -32.0, 36.0     # limp: the neck bends back a little, the head lolls to the side


def official_importer(src, verbose=False):
    return official.Importer(src, height=OFFICIAL_HEIGHT, verbose=verbose, materials=OFFICIAL_MATERIALS)


def make_official_model(src, verbose=False):
    imp = official_importer(src, verbose)
    anim = OfficialAnimator(imp)
    atts = [(f"cannon_{s.lower()}", f"{s}FeelerC", tuple(anim.barrel[s][2])) for s, _ in OSIDES]
    st = imp.studio("pokemon/blastoise.mdl", anim.sequences(), attachments=atts, hitbox_bones=HITBOX_BONES,
                    eyeposition=(24.0, 0.0, 52.0), hull=((-16.0, -16.0, 0.0), (16.0, 16.0, 72.0)))
    data = mdl.write(st)
    mdl.read(data)
    return data
