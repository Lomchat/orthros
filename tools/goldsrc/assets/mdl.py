"""GoldSrc studio model (MDL version 10, "IDST") writer, reader/validator and animation decoding.

Follows engine/studio.h (the Half-Life SDK layout, all little-endian, 32-bit offsets from the start of the
file).  The whole model lives in one file: textures included, a single sequence group (0) whose animations
are stored in the main file.

Conventions of this module (the public API, both for writing and for what `read` returns):
  * Bone euler angles are radians (x roll, y pitch, z yaw), see xform.py.
  * Model.verts / Model.norms are stored exactly as in the file: in the space of their bone's
    reference (default) pose, i.e. vertex_world = bone_matrix @ vert.  The high-level builder
    (builder.py) converts from model space.
  * Triangles are given OUTWARD COUNTER-CLOCKWISE (right-hand rule normal points out of the surface).
    On disk GoldSrc wants the opposite (studiomdl flips triangles: the engine culls GL_FRONT), so the
    writer reverses every triangle and the reader reverses them back.
  * s, t texture coordinates are integers in texture pixels (0..width, 0..height).
  * Animations: Sequence.pos / Sequence.rot are absolute local bone values per frame
    (numframes, numbones, 3).  The writer stores them as deltas from the bone defaults with per-bone
    per-channel scales (shared by all sequences, as the format requires) using the RLE
    mstudioanimvalue_t encoding.  A looping sequence's last frame should equal its first: the engine
    loops over numframes - 1 intervals.
"""
import math
import struct
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

from . import xform

IDST = 0x54534449  # "IDST"
VERSION = 10

# texture flags (engine/studio.h; Xash3D understands the extended ones)
STUDIO_NF_FLATSHADE = 0x0001
STUDIO_NF_CHROME = 0x0002
STUDIO_NF_FULLBRIGHT = 0x0004
STUDIO_NF_NOMIPS = 0x0008
STUDIO_NF_ADDITIVE = 0x0020
STUDIO_NF_MASKED = 0x0040  # palette index 255 is transparent

# motion / controller types
STUDIO_X, STUDIO_Y, STUDIO_Z = 0x0001, 0x0002, 0x0004
STUDIO_XR, STUDIO_YR, STUDIO_ZR = 0x0008, 0x0010, 0x0020
STUDIO_LX, STUDIO_LY, STUDIO_LZ = 0x0040, 0x0080, 0x0100
STUDIO_AX, STUDIO_AY, STUDIO_AZ = 0x0200, 0x0400, 0x0800
STUDIO_AXR, STUDIO_AYR, STUDIO_AZR = 0x1000, 0x2000, 0x4000
STUDIO_TYPES = 0x7FFF
STUDIO_RLOOP = 0x8000

STUDIO_LOOPING = 0x0001

# header flags of Xash3D's smooth skinning (engine/studio.h): STUDIO_HAS_BONEINFO = an mstudioboneinfo_t
# (poseToBone matrix, ...) per bone right after the bones; STUDIO_HAS_BONEWEIGHTS = per-model
# blendvertinfoindex / blendnorminfoindex arrays of mstudioboneweight_t (the renderer skins every vertex
# with worldtransform = bonetransform * poseToBone, ref/gl/gl_studio.c R_StudioSetupRenderer /
# R_StudioComputeSkinMatrix).  Without BONEINFO the renderer's worldtransform stays stale: both are required.
STUDIO_HAS_BONEINFO = 1 << 30
STUDIO_HAS_BONEWEIGHTS = 1 << 31

# hitbox groups (HITGROUP_* of the game code)
HITGROUP_GENERIC, HITGROUP_HEAD, HITGROUP_CHEST, HITGROUP_STOMACH = 0, 1, 2, 3
HITGROUP_LEFTARM, HITGROUP_RIGHTARM, HITGROUP_LEFTLEG, HITGROUP_RIGHTLEG = 4, 5, 6, 7

# limits.  MAXSTUDIOVERTS is the classic GoldSrc one (the SDF builder splits its models at it); the writer
# and reader enforce Xash3D FWGS' (engine/studio.h MAXSTUDIOVERTS 16384 per submodel) and its GL renderer's
# per-submodel vertex arrays (arrayverts[MAXSTUDIOVERTS], filled with every strip/fan corner of every mesh of
# the submodel without a bounds check when r_studio_drawelements is 1, the default).
MAXSTUDIOVERTS = 2048
XASH_MAXSTUDIOVERTS = 16384
XASH_MAXARRAYVERTS = 16384
MAXSTUDIOBONEWEIGHTS = 4
MAXSTUDIOBONES = 128
MAXSTUDIOSEQUENCES = 256
MAXSTUDIOSKINS = 100
MAXSTUDIOCONTROLLERS = 8

# activities (dlls/activity.h order)
_ACT_NAMES = (
    "RESET IDLE GUARD WALK RUN FLY SWIM HOP LEAP FALL LAND STRAFE_LEFT STRAFE_RIGHT ROLL_LEFT ROLL_RIGHT "
    "TURN_LEFT TURN_RIGHT CROUCH CROUCHIDLE STAND USE SIGNAL1 SIGNAL2 SIGNAL3 TWITCH COWER SMALL_FLINCH "
    "BIG_FLINCH RANGE_ATTACK1 RANGE_ATTACK2 MELEE_ATTACK1 MELEE_ATTACK2 RELOAD ARM DISARM EAT DIESIMPLE "
    "DIEBACKWARD DIEFORWARD DIEVIOLENT BARNACLE_HIT BARNACLE_PULL BARNACLE_CHOMP BARNACLE_CHEW SLEEP "
    "INSPECT_FLOOR INSPECT_WALL IDLE_ANGRY WALK_HURT RUN_HURT HOVER GLIDE FLY_LEFT FLY_RIGHT DETECT_SCENT "
    "SNIFF BITE THREAT_DISPLAY FEAR_DISPLAY EXCITED SPECIAL_ATTACK1 SPECIAL_ATTACK2 COMBAT_IDLE WALK_SCARED "
    "RUN_SCARED VICTORY_DANCE DIE_HEADSHOT DIE_CHESTSHOT DIE_GUTSHOT DIE_BACKSHOT FLINCH_HEAD FLINCH_CHEST "
    "FLINCH_STOMACH FLINCH_LEFTARM FLINCH_RIGHTARM FLINCH_LEFTLEG FLINCH_RIGHTLEG FLINCH LARGE_FLINCH"
).split()
ACT = {name: i for i, name in enumerate(_ACT_NAMES)}  # e.g. ACT["IDLE"] == 1, ACT["RANGE_ATTACK1"] == 28

# struct sizes (bytes)
SZ_HDR, SZ_BONE, SZ_CTRL, SZ_BBOX, SZ_SEQGROUP, SZ_SEQ = 244, 112, 24, 32, 104, 176
SZ_EVENT, SZ_PIVOT, SZ_ATTACH, SZ_ANIM, SZ_BODYPART, SZ_TEXTURE, SZ_MODEL, SZ_MESH = 76, 20, 88, 12, 76, 80, 112, 20
SZ_BONEINFO, SZ_BONEWEIGHT = 128, 8


class MdlError(ValueError):
    """Raised by the writer on bad input and by the reader/validator on a malformed file."""


# ----------------------------------------------------------------------------------------------
# data model
# ----------------------------------------------------------------------------------------------

@dataclass
class Bone:
    name: str
    parent: int = -1                   # must be < own index (-1 for roots)
    pos: tuple = (0.0, 0.0, 0.0)       # default local position
    rot: tuple = (0.0, 0.0, 0.0)       # default local euler (radians)
    flags: int = 0
    # filled by the writer / reader:
    controller: List[int] = field(default_factory=lambda: [-1] * 6)
    scale: List[float] = field(default_factory=lambda: [1.0] * 6)


@dataclass
class BoneController:
    bone: int
    type: int                 # STUDIO_X..STUDIO_ZR, optionally | STUDIO_RLOOP
    start: float              # degrees for rotations, units for translations
    end: float
    index: int = 0            # 0-3 user controllers, 4 = mouth
    rest: int = 0             # byte value at rest


@dataclass
class Attachment:
    bone: int
    org: tuple                # in the bone's space
    name: str = ""
    type: int = 0
    vectors: tuple = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))


@dataclass
class Hitbox:
    bone: int
    bbmin: tuple              # in the bone's space
    bbmax: tuple
    group: int = 0


@dataclass
class Event:
    frame: int
    event: int
    type: int = 0
    options: str = ""


@dataclass
class Sequence:
    name: str
    pos: np.ndarray           # (numframes, numbones, 3) absolute local positions
    rot: np.ndarray           # (numframes, numbones, 3) absolute local euler radians
    fps: float = 30.0
    flags: int = 0            # STUDIO_LOOPING
    activity: int = 0
    actweight: int = 0
    events: List[Event] = field(default_factory=list)
    motiontype: int = 0
    motionbone: int = 0
    linearmovement: tuple = (0.0, 0.0, 0.0)
    bbmin: tuple = (0.0, 0.0, 0.0)
    bbmax: tuple = (0.0, 0.0, 0.0)
    nextseq: int = 0
    entrynode: int = 0
    exitnode: int = 0
    nodeflags: int = 0

    @property
    def numframes(self):
        return int(np.asarray(self.pos).shape[0])


@dataclass
class Texture:
    name: str
    pixels: np.ndarray        # (height, width) uint8 palette indices
    palette: np.ndarray       # (256, 3) uint8
    flags: int = 0

    @property
    def width(self):
        return int(self.pixels.shape[1])

    @property
    def height(self):
        return int(self.pixels.shape[0])


@dataclass
class Mesh:
    tris: np.ndarray          # (n, 3, 4) int: per corner (vertindex, normindex, s, t), outward CCW
    skinref: int = 0


@dataclass
class BoneWeights:
    """mstudioboneweight_t per vertex (or normal): up to 4 bones, weights 0..255.
    The engine counts the slots whose bone is not -1 and uses the FIRST that many: used slots come first,
    unused ones are bone -1 / weight 0.  Weights should sum to 255 (the renderer adds any shortfall below 1.0
    to slot 0, an excess is not corrected)."""
    bones: np.ndarray         # (n, 4) int, -1 = unused
    weights: np.ndarray       # (n, 4) int 0..255


@dataclass
class Model:
    name: str
    verts: np.ndarray         # (nv, 3) float, bone space (rigid) / model space at the bind pose (weighted)
    vert_bone: np.ndarray     # (nv,) int (weighted: the main bone, used by the engine for dynamic lights)
    norms: np.ndarray         # (nn, 3) float, bone space / model space (weighted), unit length
    norm_bone: np.ndarray     # (nn,) int
    meshes: List[Mesh] = field(default_factory=list)
    type: int = 0
    vert_weights: Optional[BoneWeights] = None   # smooth skinning (Studio.flags gets STUDIO_HAS_BONEWEIGHTS)
    norm_weights: Optional[BoneWeights] = None   # defaults to the weights of the vertex using each normal

    @property
    def weighted(self):
        return self.vert_weights is not None


@dataclass
class BodyPart:
    name: str
    models: List[Model]
    base: int = 1             # filled by the writer


@dataclass
class Studio:
    name: str                                   # e.g. "pokemon/pikachu.mdl"
    bones: List[Bone]
    sequences: List[Sequence]
    textures: List[Texture]
    bodyparts: List[BodyPart]
    skins: Optional[List[List[int]]] = None     # [family][skinref] -> texture index (default identity)
    controllers: List[BoneController] = field(default_factory=list)
    attachments: List[Attachment] = field(default_factory=list)
    hitboxes: List[Hitbox] = field(default_factory=list)
    eyeposition: tuple = (0.0, 0.0, 0.0)
    min: tuple = (0.0, 0.0, 0.0)
    max: tuple = (0.0, 0.0, 0.0)
    bbmin: tuple = (0.0, 0.0, 0.0)
    bbmax: tuple = (0.0, 0.0, 0.0)
    flags: int = 0
    # smooth skinning: poseToBone (nb, 3, 4) of each bone (default: inverse of the rest bone matrices, so
    # weighted vertices are stored in model space at the rest pose).  Written when a model has weights.
    pose_to_bone: Optional[np.ndarray] = None


# ----------------------------------------------------------------------------------------------
# small helpers
# ----------------------------------------------------------------------------------------------

def _name(s, n):
    b = s.encode("ascii", "replace")
    if len(b) >= n:
        raise MdlError(f"name too long for {n} bytes: {s!r}")
    return b + b"\0" * (n - len(b))


def _cstr(b):
    return b.split(b"\0", 1)[0].decode("ascii", "replace")


def _v3(v):
    v = [float(x) for x in v]
    if len(v) != 3:
        raise MdlError("expected a 3-vector")
    return v


class _Buf:
    """Growing little-endian byte buffer with reservations patched later."""

    def __init__(self):
        self.b = bytearray()

    def align(self, n=4):
        while len(self.b) % n:
            self.b.append(0)

    def reserve(self, size):
        self.align()
        off = len(self.b)
        self.b += bytes(size)
        return off

    def put(self, data):
        self.align()
        off = len(self.b)
        self.b += data
        return off

    def put_unaligned(self, data):
        off = len(self.b)
        self.b += data
        return off

    def patch(self, off, fmt, *vals):
        struct.pack_into("<" + fmt, self.b, off, *vals)


# ----------------------------------------------------------------------------------------------
# animation encoding
# ----------------------------------------------------------------------------------------------

def rle_encode(values, wrap_value=None):
    """Encode an int16 sequence (one channel, one value per frame) as mstudioanimvalue_t shorts.

    Each run: header {valid, total} then `valid` values; frames valid..total-1 repeat the last value.
    A final one-value run (wrap_value, default: first value) is appended so that an interpolation
    reading past the last frame stays inside this channel's data.
    """
    v = [int(x) for x in values]
    n = len(v)
    out = []
    i = 0
    while i < n:
        j = i + 1
        while j < n and j - i < 255 and v[j] != v[j - 1]:
            j += 1
        k = j
        while k < n and k - i < 255 and v[k] == v[j - 1]:
            k += 1
        valid, total = j - i, k - i
        out.append(valid | (total << 8))
        out.extend(v[i:j])
        i = k
    w = v[0] if wrap_value is None else int(wrap_value)
    out.append(1 | (1 << 8))
    out.append(w)
    # header shorts as unsigned, values as signed: pack everything as signed 16-bit
    return [x - 65536 if x > 32767 else x for x in out]


def compute_bone_scales(bones, sequences):
    """Per-bone per-channel scales so every delta (value - default) fits a short."""
    scales = np.zeros((len(bones), 6))
    for b, bone in enumerate(bones):
        defaults = list(bone.pos) + list(bone.rot)
        for c in range(6):
            m = 0.0
            for s in sequences:
                arr = np.asarray(s.pos if c < 3 else s.rot, dtype=np.float64)[:, b, c % 3]
                m = max(m, float(np.max(np.abs(arr - defaults[c]))) if arr.size else 0.0)
            scales[b, c] = m / 32000.0 if m > 1e-9 else 1.0 / 32768.0
    return scales


# ----------------------------------------------------------------------------------------------
# triangle strips
# ----------------------------------------------------------------------------------------------

def stripify(tris_disk):
    """Greedy strips from on-disk-order triangles (n, 3) of hashable corner keys.

    Returns a list of corner-key lists; triangle k of a strip is (v[k], v[k+1], v[k+2]) for even k
    and (v[k+1], v[k], v[k+2]) for odd k (OpenGL GL_TRIANGLE_STRIP).
    """
    n = len(tris_disk)
    edge = {}
    for t, (a, b, c) in enumerate(tris_disk):
        for p, q in ((a, b), (b, c), (c, a)):
            edge.setdefault((p, q), []).append(t)
    used = [False] * n

    def find(p, q):
        for t in edge.get((p, q), ()):
            if not used[t]:
                return t
        return -1

    def third(t, p, q):
        a, b, c = tris_disk[t]
        for x, y, z in ((a, b, c), (b, c, a), (c, a, b)):
            if x == p and y == q:
                return z
        raise AssertionError

    def grow(start, rot):
        a, b, c = tris_disk[start]
        seq = [(a, b, c), (b, c, a), (c, a, b)][rot]
        verts = list(seq)
        taken = [start]
        local = {start}
        while len(verts) < 1000:
            k = len(verts) - 2  # index of next triangle
            p, q = verts[-2], verts[-1]
            if k % 2 == 1:   # next triangle is (v[k+1], v[k], v[k+2]) -> directed edge q->p
                t = -1
                for cand in edge.get((q, p), ()):
                    if not used[cand] and cand not in local:
                        t = cand
                        break
                if t < 0:
                    break
                x = third(t, q, p)
            else:            # next triangle is (v[k], v[k+1], v[k+2]) -> directed edge p->q
                t = -1
                for cand in edge.get((p, q), ()):
                    if not used[cand] and cand not in local:
                        t = cand
                        break
                if t < 0:
                    break
                x = third(t, p, q)
            verts.append(x)
            taken.append(t)
            local.add(t)
        return verts, taken

    strips = []
    for t in range(n):
        if used[t]:
            continue
        best = None
        for rot in range(3):
            v, tk = grow(t, rot)
            if best is None or len(tk) > len(best[1]):
                best = (v, tk)
        for x in best[1]:
            used[x] = True
        strips.append(best[0])
    return strips


# ----------------------------------------------------------------------------------------------
# posing (float, used by the writer for bounding boxes and by the builder)
# ----------------------------------------------------------------------------------------------

def bone_matrices(bones, pos, rot):
    """World 3x4 matrices of all bones for local positions (B, 3) and euler radians (B, 3)."""
    mats = np.empty((len(bones), 3, 4))
    r = xform.euler_matrix(np.asarray(rot, dtype=np.float64))
    for i, bone in enumerate(bones):
        local = np.empty((3, 4))
        local[:, :3] = r[i]
        local[:, 3] = pos[i]
        mats[i] = local if bone.parent < 0 else xform.concat(mats[bone.parent], local)
    return mats


def rest_matrices(bones):
    return bone_matrices(bones, np.array([b.pos for b in bones], float), np.array([b.rot for b in bones], float))


# ----------------------------------------------------------------------------------------------
# writer
# ----------------------------------------------------------------------------------------------

def _check_studio(st):
    nb = len(st.bones)
    if not 1 <= nb <= MAXSTUDIOBONES:
        raise MdlError(f"bone count {nb} out of range")
    names = set()
    for i, b in enumerate(st.bones):
        if not -1 <= b.parent < i:
            raise MdlError(f"bone {b.name}: parent {b.parent} must precede it")
        if b.name in names:
            raise MdlError(f"duplicate bone name {b.name}")
        names.add(b.name)
    if not 1 <= len(st.sequences) <= MAXSTUDIOSEQUENCES:
        raise MdlError("need at least one sequence")
    for s in st.sequences:
        p, r = np.asarray(s.pos), np.asarray(s.rot)
        if p.shape != r.shape or p.ndim != 3 or p.shape[1] != nb or p.shape[2] != 3 or p.shape[0] < 1:
            raise MdlError(f"sequence {s.name}: pos/rot must be (numframes, {nb}, 3)")
        if not (np.all(np.isfinite(p)) and np.all(np.isfinite(r))):
            raise MdlError(f"sequence {s.name}: non-finite values")
    if not st.textures:
        raise MdlError("need at least one texture")
    for t in st.textures:
        if t.pixels.dtype != np.uint8 or t.pixels.ndim != 2:
            raise MdlError(f"texture {t.name}: pixels must be 2-D uint8")
        if np.asarray(t.palette).shape != (256, 3):
            raise MdlError(f"texture {t.name}: palette must be (256, 3)")
    skins = st.skins or [list(range(len(st.textures)))]
    nref = len(skins[0])
    for fam in skins:
        if len(fam) != nref or any(not 0 <= x < len(st.textures) for x in fam):
            raise MdlError("bad skin family table")
    if len(skins) > MAXSTUDIOSKINS:
        raise MdlError("too many skin families")
    if len(st.controllers) > MAXSTUDIOCONTROLLERS:
        raise MdlError("too many bone controllers")
    for c in st.controllers:
        if not 0 <= c.bone < nb or not 0 <= c.index <= 4:
            raise MdlError("bad bone controller")
    for a in st.attachments:
        if not 0 <= a.bone < nb:
            raise MdlError("bad attachment bone")
    for h in st.hitboxes:
        if not 0 <= h.bone < nb:
            raise MdlError("bad hitbox bone")
    for bp in st.bodyparts:
        if not bp.models:
            raise MdlError(f"bodypart {bp.name} has no model")
        for m in bp.models:
            nv, nn = len(m.verts), len(m.norms)
            if nv > XASH_MAXSTUDIOVERTS or nn > XASH_MAXSTUDIOVERTS:
                raise MdlError(f"model {m.name}: {nv} verts / {nn} normals exceed {XASH_MAXSTUDIOVERTS}")
            if len(m.vert_bone) != nv or len(m.norm_bone) != nn:
                raise MdlError(f"model {m.name}: bone info length mismatch")
            for what, bw, cnt in (("vertex", m.vert_weights, nv), ("normal", m.norm_weights, nn)):
                if bw is not None:
                    _check_weights(f"model {m.name} {what}", bw, cnt, nb)
            if m.norm_weights is not None and m.vert_weights is None:
                raise MdlError(f"model {m.name}: normal weights without vertex weights")
            if nv and (np.min(m.vert_bone) < 0 or np.max(m.vert_bone) >= nb):
                raise MdlError(f"model {m.name}: vertex bone out of range")
            if nn and (np.min(m.norm_bone) < 0 or np.max(m.norm_bone) >= nb):
                raise MdlError(f"model {m.name}: normal bone out of range")
            for me in m.meshes:
                tr = np.asarray(me.tris)
                if tr.ndim != 3 or tr.shape[1:] != (3, 4):
                    raise MdlError(f"model {m.name}: mesh tris must be (n, 3, 4)")
                if not 0 <= me.skinref < nref:
                    raise MdlError(f"model {m.name}: skinref {me.skinref} out of range")
                if len(tr) and (tr[..., 0].min() < 0 or tr[..., 0].max() >= nv or
                                tr[..., 1].min() < 0 or tr[..., 1].max() >= nn):
                    raise MdlError(f"model {m.name}: vertex/normal index out of range")
                if len(tr) and (np.abs(tr[..., 2:]).max() > 32767):
                    raise MdlError(f"model {m.name}: s/t out of short range")
    if st.pose_to_bone is not None and np.asarray(st.pose_to_bone).shape != (nb, 3, 4):
        raise MdlError(f"pose_to_bone must be ({nb}, 3, 4)")
    return skins


def _check_weights(what, bw, count, nb):
    b = np.asarray(bw.bones)
    w = np.asarray(bw.weights)
    if b.shape != (count, 4) or w.shape != (count, 4):
        raise MdlError(f"{what} weights must be ({count}, 4)")
    if count == 0:
        return
    if b.min() < -1 or b.max() >= min(nb, 128):
        raise MdlError(f"{what} weight bone out of range")
    if w.min() < 0 or w.max() > 255:
        raise MdlError(f"{what} weight value outside 0..255")
    used = b >= 0
    if not used[:, 0].all():
        raise MdlError(f"{what}: slot 0 must hold a bone")
    if np.any(~used[:, :-1] & used[:, 1:]):
        raise MdlError(f"{what}: used weight slots must come first")
    if np.any(w[~used] != 0):
        raise MdlError(f"{what}: unused weight slots must have weight 0")
    tot = np.where(used, w, 0).sum(1)
    if tot.max() > 255 or tot.min() < 1:
        raise MdlError(f"{what}: weights must sum to 1..255 (got {tot.min()}..{tot.max()})")


def is_weighted(st):
    return any(m.vert_weights is not None for bp in st.bodyparts for m in bp.models)


def default_pose_to_bone(bones):
    """poseToBone = inverse rest bone matrices: weighted vertices stored in model space (rest pose)."""
    return np.array([xform.invert(m) for m in rest_matrices(bones)])


def _norm_weights_from_verts(m: Model):
    """Weights per normal from the vertices that use it (first use wins)."""
    nn = len(m.norms)
    bones = np.full((nn, 4), -1, np.int64)
    wts = np.zeros((nn, 4), np.int64)
    bones[:, 0] = np.asarray(m.norm_bone)
    wts[:, 0] = 255
    seen = np.zeros(nn, bool)
    for me in m.meshes:
        tr = np.asarray(me.tris).reshape(-1, 4)
        for vi, ni in zip(tr[:, 0], tr[:, 1]):
            if not seen[ni]:
                seen[ni] = True
                bones[ni] = m.vert_weights.bones[vi]
                wts[ni] = m.vert_weights.weights[vi]
    return BoneWeights(bones=bones, weights=wts)


def _i32(x):
    """Header flags as a signed 32-bit int (STUDIO_HAS_BONEWEIGHTS is bit 31)."""
    x = int(x) & 0xFFFFFFFF
    return x - (1 << 32) if x >= (1 << 31) else x


def write(st: Studio) -> bytes:
    """Serialise a Studio into MDL v10 bytes (deterministic)."""
    skins = _check_studio(st)
    nb = len(st.bones)
    buf = _Buf()
    buf.reserve(SZ_HDR)

    # scales and controller links
    scales = compute_bone_scales(st.bones, st.sequences)
    ctrl_of = [[-1] * 6 for _ in range(nb)]
    for ci, c in enumerate(st.controllers):
        typ = c.type & STUDIO_TYPES
        chan = {STUDIO_X: 0, STUDIO_Y: 1, STUDIO_Z: 2, STUDIO_XR: 3, STUDIO_YR: 4, STUDIO_ZR: 5}.get(typ)
        if chan is None:
            raise MdlError("bone controller type must be one of STUDIO_X..STUDIO_ZR")
        ctrl_of[c.bone][chan] = ci

    # bones
    weighted = is_weighted(st)
    flags = int(st.flags) & ~(STUDIO_HAS_BONEINFO | STUDIO_HAS_BONEWEIGHTS)
    boneindex = buf.reserve(SZ_BONE * nb)
    for i, b in enumerate(st.bones):
        vals = _v3(b.pos) + _v3(b.rot)
        struct.pack_into("<32sii6i6f6f", buf.b, boneindex + i * SZ_BONE, _name(b.name, 32), b.parent, b.flags,
                         *ctrl_of[i], *vals, *[float(x) for x in scales[i]])
    if weighted:
        # mstudioboneinfo_t[numbones] immediately after the bones (the renderer finds them there)
        flags |= STUDIO_HAS_BONEINFO | STUDIO_HAS_BONEWEIGHTS
        p2b = default_pose_to_bone(st.bones) if st.pose_to_bone is None else np.asarray(st.pose_to_bone, float)
        infoindex = buf.reserve(SZ_BONEINFO * nb)
        assert infoindex == boneindex + SZ_BONE * nb
        for i, b in enumerate(st.bones):
            q = xform.angle_quaternion(_v3(b.rot))
            struct.pack_into("<12f4fii4f10i", buf.b, infoindex + i * SZ_BONEINFO, *[float(x) for x in p2b[i].reshape(-1)],
                             0.0, 0.0, 0.0, 1.0, 0, 0, *[float(x) for x in q], *([0] * 10))

    ctrlindex = buf.reserve(SZ_CTRL * len(st.controllers))
    for i, c in enumerate(st.controllers):
        struct.pack_into("<iiffii", buf.b, ctrlindex + i * SZ_CTRL, c.bone, c.type, c.start, c.end, c.rest, c.index)

    hitindex = buf.reserve(SZ_BBOX * len(st.hitboxes))
    for i, h in enumerate(st.hitboxes):
        struct.pack_into("<ii3f3f", buf.b, hitindex + i * SZ_BBOX, h.bone, h.group, *_v3(h.bbmin), *_v3(h.bbmax))

    # sequence groups (one, data in this file)
    seqgroupindex = buf.reserve(SZ_SEQGROUP)
    struct.pack_into("<32s64sii", buf.b, seqgroupindex, _name("default", 32), _name("", 64), 0, 0)

    # sequences
    seqindex = buf.reserve(SZ_SEQ * len(st.sequences))
    for si, s in enumerate(st.sequences):
        nf = s.numframes
        eventindex = buf.reserve(SZ_EVENT * len(s.events))
        for ei, e in enumerate(sorted(s.events, key=lambda e: (e.frame, e.event))):
            struct.pack_into("<iii64s", buf.b, eventindex + ei * SZ_EVENT, e.frame, e.event, e.type, _name(e.options, 64))
        # animation: anim structs then channel data
        animindex = buf.reserve(SZ_ANIM * nb)
        offsets = np.zeros((nb, 6), dtype=np.int64)
        loop = bool(s.flags & STUDIO_LOOPING)
        for b in range(nb):
            defaults = list(st.bones[b].pos) + list(st.bones[b].rot)
            for c in range(6):
                arr = np.asarray(s.pos if c < 3 else s.rot, dtype=np.float64)[:, b, c % 3]
                q = np.clip(np.round((arr - defaults[c]) / scales[b, c]), -32767, 32767).astype(np.int64)
                if not np.any(q):
                    continue
                shorts = rle_encode(q, wrap_value=(q[0] if loop else q[-1]))
                off = buf.put_unaligned(struct.pack("<%dh" % len(shorts), *shorts))
                rel = off - (animindex + b * SZ_ANIM)
                if rel >= 65536:
                    raise MdlError(f"sequence {s.name}: animation data too large for 16-bit offsets")
                offsets[b, c] = rel
        for b in range(nb):
            struct.pack_into("<6H", buf.b, animindex + b * SZ_ANIM, *[int(x) for x in offsets[b]])
        struct.pack_into(
            "<32sfiiiiiiiiii3fii3f3fii2i2f2fiiiiii", buf.b, seqindex + si * SZ_SEQ,
            _name(s.name, 32), float(s.fps), s.flags, s.activity, s.actweight, len(s.events), eventindex,
            nf, 0, 0, s.motiontype, s.motionbone, *_v3(s.linearmovement), 0, 0,
            *_v3(s.bbmin), *_v3(s.bbmax), 1, animindex, 0, 0, 0.0, 0.0, 1.0, 0.0, 0, 0,
            s.entrynode, s.exitnode, s.nodeflags, s.nextseq)

    # bodyparts / models / meshes
    bodypartindex = buf.reserve(SZ_BODYPART * len(st.bodyparts))
    base = 1
    for bi, bp in enumerate(st.bodyparts):
        modelindex = buf.reserve(SZ_MODEL * len(bp.models))
        struct.pack_into("<64siii", buf.b, bodypartindex + bi * SZ_BODYPART, _name(bp.name, 64), len(bp.models), base,
                         modelindex)
        bp.base = base
        base *= len(bp.models)
        for mi, m in enumerate(bp.models):
            _write_model(buf, modelindex + mi * SZ_MODEL, m)

    attachmentindex = buf.reserve(SZ_ATTACH * len(st.attachments))
    for i, a in enumerate(st.attachments):
        vec = [float(x) for v in a.vectors for x in v]
        struct.pack_into("<32sii3f9f", buf.b, attachmentindex + i * SZ_ATTACH, _name(a.name, 32), a.type, a.bone,
                         *_v3(a.org), *vec)

    transitionindex = len(buf.b)

    # textures, skin table, texture data
    textureindex = buf.reserve(SZ_TEXTURE * len(st.textures))
    skinindex = buf.put(struct.pack("<%dh" % (len(skins) * len(skins[0])), *[x for fam in skins for x in fam]))
    texturedataindex = None
    for i, t in enumerate(st.textures):
        data = np.ascontiguousarray(t.pixels, dtype=np.uint8).tobytes() + \
            np.ascontiguousarray(t.palette, dtype=np.uint8).tobytes()
        off = buf.put(data)
        if texturedataindex is None:
            texturedataindex = off
        struct.pack_into("<64siiii", buf.b, textureindex + i * SZ_TEXTURE, _name(t.name, 64), t.flags, t.width,
                         t.height, off)
    buf.align()
    length = len(buf.b)

    struct.pack_into(
        "<ii64si3f3f3f3f3fi" + "i" * 26, buf.b, 0,
        IDST, VERSION, _name(st.name, 64), length,
        *_v3(st.eyeposition), *_v3(st.min), *_v3(st.max), *_v3(st.bbmin), *_v3(st.bbmax), _i32(flags),
        nb, boneindex, len(st.controllers), ctrlindex, len(st.hitboxes), hitindex,
        len(st.sequences), seqindex, 1, seqgroupindex,
        len(st.textures), textureindex, texturedataindex,
        len(skins[0]), len(skins), skinindex,
        len(st.bodyparts), bodypartindex, len(st.attachments), attachmentindex,
        0, 0, 0, 0, 0, transitionindex)
    return bytes(buf.b)


def _write_model(buf, model_off, m: Model):
    """Write one model's arrays; normals are regrouped per mesh as the engine requires."""
    verts = np.asarray(m.verts, dtype=np.float64).reshape(-1, 3)
    norms = np.asarray(m.norms, dtype=np.float64).reshape(-1, 3)
    # regroup normals so that each mesh owns a contiguous range (lighting is computed per mesh range)
    nw = None
    if m.vert_weights is not None:
        nw = m.norm_weights if m.norm_weights is not None else _norm_weights_from_verts(m)
    new_norms, new_nbone, new_nw, mesh_ranges, mesh_tris = [], [], [], [], []
    for me in m.meshes:
        tr = np.asarray(me.tris, dtype=np.int64).copy()
        start = len(new_norms)
        remap = {}
        for ni in tr[..., 1].reshape(-1):
            ni = int(ni)
            if ni not in remap:
                remap[ni] = len(new_norms)
                new_norms.append(norms[ni])
                new_nbone.append(int(m.norm_bone[ni]))
                if nw is not None:
                    new_nw.append(ni)
        if len(tr):
            tr[..., 1] = np.vectorize(remap.get, otypes=[np.int64])(tr[..., 1])
        mesh_ranges.append((start, len(new_norms) - start))
        mesh_tris.append(tr)
    nn = len(new_norms)
    if nn > XASH_MAXSTUDIOVERTS:
        raise MdlError(f"model {m.name}: {nn} normals after per-mesh grouping exceed {XASH_MAXSTUDIOVERTS}")

    vertinfoindex = buf.put(bytes(int(x) for x in m.vert_bone))
    norminfoindex = buf.put(bytes(new_nbone))
    vertindex = buf.put(verts.astype("<f4").tobytes())
    normindex = buf.put(np.asarray(new_norms, dtype="<f4").reshape(-1, 3).tobytes())
    blendvert = blendnorm = 0
    if nw is not None:
        sel = np.array(new_nw, dtype=np.int64)
        blendvert = buf.put(_pack_weights(m.vert_weights.bones, m.vert_weights.weights))
        blendnorm = buf.put(_pack_weights(np.asarray(nw.bones)[sel].reshape(-1, 4),
                                          np.asarray(nw.weights)[sel].reshape(-1, 4)))
    meshindex = buf.reserve(SZ_MESH * len(m.meshes))
    corners = 0
    for j, me in enumerate(m.meshes):
        tr = mesh_tris[j]
        disk = [tuple(tuple(int(x) for x in corner) for corner in (t[0], t[2], t[1])) for t in tr]  # flip winding
        cmds = []
        for strip in stripify(disk):
            cmds.append(len(strip))
            corners += len(strip)
            for corner in strip:
                cmds.extend(corner)
        cmds.append(0)
        if corners > XASH_MAXARRAYVERTS:
            raise MdlError(f"model {m.name}: {corners} strip corners exceed the renderer's {XASH_MAXARRAYVERTS} "
                           f"array vertices per submodel (split it into bodyparts)")
        triindex = buf.put(struct.pack("<%dh" % len(cmds), *cmds))
        start, cnt = mesh_ranges[j]
        struct.pack_into("<iiiii", buf.b, meshindex + j * SZ_MESH, len(tr), triindex, me.skinref, cnt,
                         normindex + start * 12)
    radius = float(np.max(np.linalg.norm(verts, axis=1))) if len(verts) else 0.0
    struct.pack_into("<64sifiiiiiiiiii", buf.b, model_off, _name(m.name, 64), m.type, radius,
                     len(m.meshes), meshindex, len(verts), vertinfoindex, vertindex, nn, norminfoindex, normindex,
                     blendvert, blendnorm)


def _pack_weights(bones, weights):
    b = np.asarray(bones, dtype=np.int64).reshape(-1, 4)
    w = np.asarray(weights, dtype=np.int64).reshape(-1, 4)
    rec = np.zeros((len(b), 8), dtype=np.uint8)
    rec[:, :4] = w.astype(np.uint8)
    rec[:, 4:] = b.astype(np.int8).view(np.uint8)
    return rec.tobytes()


# ----------------------------------------------------------------------------------------------
# reader / validator
# ----------------------------------------------------------------------------------------------

class ParsedModel:
    """Result of read(): plain attributes mirroring the file, plus `data` (the bytes)."""

    def __repr__(self):
        return (f"<ParsedModel {self.name!r}: {len(self.bones)} bones, {len(self.sequences)} seqs, "
                f"{len(self.textures)} textures, {len(self.bodyparts)} bodyparts>")


class _Reader:
    def __init__(self, data):
        self.d = bytes(data)
        self.n = len(self.d)
        self.errors = []
        self.ranges = []  # (start, end, what)

    def err(self, msg):
        self.errors.append(msg)

    def need(self, off, size, what, align=1):
        if off < 0 or size < 0 or off + size > self.n:
            self.err(f"{what}: [{off}, {off + size}) outside file of {self.n} bytes")
            return False
        if align > 1 and off % align:
            self.err(f"{what}: offset {off} not aligned to {align}")
        if size:
            self.ranges.append((off, off + size, what))
        return True

    def unpack(self, fmt, off):
        return struct.unpack_from("<" + fmt, self.d, off)


def read(data, strict=True) -> ParsedModel:
    """Parse MDL bytes, check every offset/count/size; raise MdlError (strict) or collect `errors`."""
    r = _Reader(data)
    pm = ParsedModel()
    pm.data = r.d
    if r.n < SZ_HDR:
        raise MdlError("file shorter than the header")
    h = r.unpack("ii64si3f3f3f3f3fi" + "i" * 26, 0)
    ident, version, name, length = h[0], h[1], h[2], h[3]
    if ident != IDST or version != VERSION:
        raise MdlError(f"not an MDL v10 (ident {ident:#x}, version {version})")
    if length != r.n:
        r.err(f"header length {length} != file size {r.n}")
    pm.name = _cstr(name)
    pm.length = length
    pm.eyeposition, pm.min, pm.max, pm.bbmin, pm.bbmax = (tuple(h[4 + 3 * i:7 + 3 * i]) for i in range(5))
    pm.flags = h[19] & 0xFFFFFFFF
    (numbones, boneindex, numctrl, ctrlindex, numhit, hitindex, numseq, seqindex, numgroups, groupindex,
     numtex, texindex, texdataindex, numskinref, numskinfam, skinindex, numbp, bpindex, numatt, attindex,
     soundtable, soundindex, soundgroups, soundgroupindex, numtrans, transindex) = h[20:46]
    if soundtable != 0:
        r.err("soundtable must be 0 (Xash3D reads it as studiohdr2index)")
    r.ranges.append((0, SZ_HDR, "header"))

    if not 1 <= numbones <= MAXSTUDIOBONES:
        r.err(f"numbones {numbones} out of range")
    pm.bones = []
    if r.need(boneindex, numbones * SZ_BONE, "bones", 4):
        for i in range(numbones):
            v = r.unpack("32sii6i6f6f", boneindex + i * SZ_BONE)
            b = Bone(name=_cstr(v[0]), parent=v[1], flags=v[2], pos=tuple(v[9:12]), rot=tuple(v[12:15]),
                     controller=list(v[3:9]), scale=list(v[15:21]))
            if not -1 <= b.parent < i:
                r.err(f"bone {i} {b.name}: parent {b.parent} invalid")
            for c in b.controller:
                if c != -1 and not 0 <= c < numctrl:
                    r.err(f"bone {b.name}: controller {c} invalid")
            pm.bones.append(b)

    pm.pose_to_bone = None
    weighted = bool(pm.flags & STUDIO_HAS_BONEWEIGHTS)
    if weighted and not pm.flags & STUDIO_HAS_BONEINFO:
        r.err("STUDIO_HAS_BONEWEIGHTS without STUDIO_HAS_BONEINFO (the renderer would skin with stale matrices)")
    if pm.flags & STUDIO_HAS_BONEINFO and 1 <= numbones <= MAXSTUDIOBONES:
        infoindex = boneindex + numbones * SZ_BONE
        if r.need(infoindex, numbones * SZ_BONEINFO, "boneinfo", 4):
            pm.pose_to_bone = np.array([r.unpack("12f", infoindex + i * SZ_BONEINFO) for i in range(numbones)],
                                       dtype=np.float64).reshape(numbones, 3, 4)
            if not np.all(np.isfinite(pm.pose_to_bone)):
                r.err("boneinfo: non-finite poseToBone")

    pm.controllers = []
    if r.need(ctrlindex, numctrl * SZ_CTRL, "bonecontrollers", 4):
        for i in range(numctrl):
            v = r.unpack("iiffii", ctrlindex + i * SZ_CTRL)
            c = BoneController(bone=v[0], type=v[1], start=v[2], end=v[3], rest=v[4], index=v[5])
            if not 0 <= c.bone < numbones or not 0 <= c.index <= 4:
                r.err(f"controller {i} invalid")
            pm.controllers.append(c)

    pm.hitboxes = []
    if r.need(hitindex, numhit * SZ_BBOX, "hitboxes", 4):
        for i in range(numhit):
            v = r.unpack("ii3f3f", hitindex + i * SZ_BBOX)
            hb = Hitbox(bone=v[0], group=v[1], bbmin=tuple(v[2:5]), bbmax=tuple(v[5:8]))
            if not 0 <= hb.bone < numbones:
                r.err(f"hitbox {i} bone invalid")
            if any(hb.bbmin[k] > hb.bbmax[k] for k in range(3)):
                r.err(f"hitbox {i} min > max")
            pm.hitboxes.append(hb)

    pm.seqgroups = []
    if numgroups < 1:
        r.err("needs at least one sequence group")
    if r.need(groupindex, numgroups * SZ_SEQGROUP, "seqgroups", 4):
        for i in range(numgroups):
            v = r.unpack("32s64sii", groupindex + i * SZ_SEQGROUP)
            pm.seqgroups.append({"label": _cstr(v[0]), "name": _cstr(v[1]), "data": v[3]})

    pm.sequences = []
    if r.need(seqindex, numseq * SZ_SEQ, "sequences", 4):
        for i in range(numseq):
            v = r.unpack("32sfiiiiiiiiii3fii3f3fii2i2f2fiiiiii", seqindex + i * SZ_SEQ)
            s = {"name": _cstr(v[0]), "fps": v[1], "flags": v[2], "activity": v[3], "actweight": v[4],
                 "numevents": v[5], "eventindex": v[6], "numframes": v[7], "numpivots": v[8], "pivotindex": v[9],
                 "motiontype": v[10], "motionbone": v[11], "linearmovement": tuple(v[12:15]),
                 "bbmin": tuple(v[17:20]), "bbmax": tuple(v[20:23]), "numblends": v[23], "animindex": v[24],
                 "seqgroup": v[32], "entrynode": v[33], "exitnode": v[34], "nodeflags": v[35], "nextseq": v[36]}
            if s["numframes"] < 1:
                r.err(f"sequence {s['name']}: numframes {s['numframes']}")
            if s["fps"] <= 0:
                r.err(f"sequence {s['name']}: fps {s['fps']}")
            if s["seqgroup"] != 0:
                r.err(f"sequence {s['name']}: seqgroup {s['seqgroup']} (only group 0 supported here)")
            if s["numblends"] < 1:
                r.err(f"sequence {s['name']}: numblends {s['numblends']}")
            s["events"] = []
            if r.need(s["eventindex"], s["numevents"] * SZ_EVENT, f"events of {s['name']}", 4):
                for e in range(s["numevents"]):
                    ev = r.unpack("iii64s", s["eventindex"] + e * SZ_EVENT)
                    s["events"].append(Event(frame=ev[0], event=ev[1], type=ev[2], options=_cstr(ev[3])))
            if s["numpivots"]:
                r.need(s["pivotindex"], s["numpivots"] * SZ_PIVOT, f"pivots of {s['name']}", 4)
            nbl = s["numblends"] if 1 <= s["numblends"] <= 16 else 0
            if not nbl or not 1 <= s["numframes"] <= 65535:
                r.err(f"sequence {s['name']}: numblends {s['numblends']} / numframes {s['numframes']} unusable")
            s["anim_offsets"] = np.zeros((max(1, nbl), max(0, min(numbones, MAXSTUDIOBONES)), 6), dtype=np.int64)
            if nbl and 1 <= s["numframes"] <= 65535 and r.need(s["animindex"], SZ_ANIM * numbones * nbl,
                                                              f"anims of {s['name']}", 2):
                for bl in range(nbl):
                    for b in range(numbones):
                        base = s["animindex"] + (bl * numbones + b) * SZ_ANIM
                        offs = r.unpack("6H", base)
                        s["anim_offsets"][bl, b] = offs
                        for c in range(6):
                            if offs[c]:
                                end = _walk_channel(r, base + offs[c], s["numframes"],
                                                    f"{s['name']} bone {b} channel {c}")
                                if end is not None:
                                    r.ranges.append((base + offs[c], end, f"animvalues {s['name']}"))
            pm.sequences.append(s)

    pm.textures = []
    if r.need(texindex, numtex * SZ_TEXTURE, "textures", 4):
        for i in range(numtex):
            v = r.unpack("64siiii", texindex + i * SZ_TEXTURE)
            t = {"name": _cstr(v[0]), "flags": v[1], "width": v[2], "height": v[3], "index": v[4]}
            if t["width"] <= 0 or t["height"] <= 0 or t["width"] > 4096 or t["height"] > 4096:
                r.err(f"texture {t['name']}: bad size {t['width']}x{t['height']}")
            elif r.need(t["index"], t["width"] * t["height"] + 768, f"texture data {t['name']}"):
                o = t["index"]
                sz = t["width"] * t["height"]
                tex = Texture(name=t["name"], flags=t["flags"],
                              pixels=np.frombuffer(r.d, np.uint8, sz, o).reshape(t["height"], t["width"]).copy(),
                              palette=np.frombuffer(r.d, np.uint8, 768, o + sz).reshape(256, 3).copy())
                tex.index = o
                pm.textures.append(tex)
        if numtex and texdataindex > min((t.index for t in pm.textures), default=texdataindex):
            r.err("texturedataindex after texture data start")

    pm.skins = np.zeros((0, 0), dtype=np.int64)
    if numskinfam < 1 or numskinref < 1:
        r.err("skin table empty")
    elif r.need(skinindex, numskinfam * numskinref * 2, "skin table", 2):
        pm.skins = np.array(r.unpack("%dh" % (numskinfam * numskinref), skinindex),
                            dtype=np.int64).reshape(numskinfam, numskinref)
        if pm.skins.min() < 0 or pm.skins.max() >= numtex:
            r.err("skin table references a missing texture")

    pm.bodyparts = []
    if r.need(bpindex, numbp * SZ_BODYPART, "bodyparts", 4):
        expect_base = 1
        for i in range(numbp):
            v = r.unpack("64siii", bpindex + i * SZ_BODYPART)
            bp = BodyPart(name=_cstr(v[0]), models=[], base=v[2])
            if v[1] < 1 or bp.base != expect_base:
                r.err(f"bodypart {bp.name}: nummodels {v[1]} base {bp.base} (expected {expect_base})")
            expect_base *= max(1, v[1])
            if r.need(v[3], v[1] * SZ_MODEL, f"models of {bp.name}", 4):
                for mi in range(v[1]):
                    bp.models.append(_read_model(r, v[3] + mi * SZ_MODEL, numbones, numskinref, pm.textures,
                                                 pm.skins, weighted))
            pm.bodyparts.append(bp)

    pm.attachments = []
    if r.need(attindex, numatt * SZ_ATTACH, "attachments", 4):
        for i in range(numatt):
            v = r.unpack("32sii3f9f", attindex + i * SZ_ATTACH)
            a = Attachment(name=_cstr(v[0]), type=v[1], bone=v[2], org=tuple(v[3:6]),
                           vectors=(tuple(v[6:9]), tuple(v[9:12]), tuple(v[12:15])))
            if not 0 <= a.bone < numbones:
                r.err(f"attachment {i} bone invalid")
            pm.attachments.append(a)

    if numtrans:
        r.need(transindex, numtrans * numtrans, "transitions")

    # overlapping regions
    rs = sorted(r.ranges)
    for (a0, a1, wa), (b0, b1, wb) in zip(rs, rs[1:]):
        if b0 < a1:
            r.err(f"overlap: {wa} [{a0},{a1}) and {wb} [{b0},{b1})")

    pm.errors = r.errors
    if strict and r.errors:
        raise MdlError("invalid MDL:\n  " + "\n  ".join(r.errors[:40]))
    return pm


def _walk_channel(r, off, numframes, what):
    """Follow the RLE runs of one channel; return the end offset (bytes) or None on error."""
    covered = 0
    o = off
    while covered < numframes:
        if o + 2 > r.n:
            r.err(f"{what}: runs leave the file")
            return None
        valid, total = r.d[o], r.d[o + 1]
        if total == 0 or valid == 0 or valid > total:
            r.err(f"{what}: bad run header valid={valid} total={total}")
            return None
        o += 2 + 2 * valid
        covered += total
    if o > r.n:
        r.err(f"{what}: values leave the file")
        return None
    # our writer appends a one-value wrap run, include it if present
    if o + 4 <= r.n and r.d[o] == 1 and r.d[o + 1] == 1:
        o += 4
    return o


def _read_weights(r, off, count, numbones, what):
    if not r.need(off, count * SZ_BONEWEIGHT, what, 4):
        return None
    rec = np.frombuffer(r.d, np.uint8, count * SZ_BONEWEIGHT, off).reshape(count, 8)
    bw = BoneWeights(bones=rec[:, 4:].view(np.int8).astype(np.int64), weights=rec[:, :4].astype(np.int64))
    try:
        _check_weights(what, bw, count, numbones)
    except MdlError as e:
        r.err(str(e))
    return bw


def _read_model(r, off, numbones, numskinref, textures, skins, weighted=False):
    v = r.unpack("64sifiiiiiiiiii", off)
    (name, mtype, radius, nummesh, meshindex, numverts, vertinfoindex, vertindex, numnorms, norminfoindex,
     normindex, blendvertinfoindex, blendnorminfoindex) = v
    name = _cstr(name)
    m = Model(name=name, verts=np.zeros((0, 3)), vert_bone=np.zeros(0, np.int64), norms=np.zeros((0, 3)),
              norm_bone=np.zeros(0, np.int64), meshes=[], type=mtype)
    m.boundingradius = radius
    if numverts > XASH_MAXSTUDIOVERTS or numnorms > XASH_MAXSTUDIOVERTS:
        r.err(f"model {name}: {numverts} verts / {numnorms} norms over {XASH_MAXSTUDIOVERTS}")
    if r.need(vertinfoindex, numverts, f"vertinfo {name}") and r.need(vertindex, numverts * 12, f"verts {name}", 4):
        m.vert_bone = np.frombuffer(r.d, np.uint8, numverts, vertinfoindex).astype(np.int64)
        m.verts = np.frombuffer(r.d, "<f4", numverts * 3, vertindex).reshape(-1, 3).astype(np.float64)
        if numverts and m.vert_bone.max() >= numbones:
            r.err(f"model {name}: vertex bone out of range")
    if r.need(norminfoindex, numnorms, f"norminfo {name}") and r.need(normindex, numnorms * 12, f"norms {name}", 4):
        m.norm_bone = np.frombuffer(r.d, np.uint8, numnorms, norminfoindex).astype(np.int64)
        m.norms = np.frombuffer(r.d, "<f4", numnorms * 3, normindex).reshape(-1, 3).astype(np.float64)
        if numnorms and m.norm_bone.max() >= numbones:
            r.err(f"model {name}: normal bone out of range")
    if weighted:
        if bool(blendvertinfoindex) != bool(blendnorminfoindex):
            r.err(f"model {name}: only one of blendvertinfoindex / blendnorminfoindex set")
        elif blendvertinfoindex:
            m.vert_weights = _read_weights(r, blendvertinfoindex, numverts, numbones, f"blendvertinfo {name}")
            m.norm_weights = _read_weights(r, blendnorminfoindex, numnorms, numbones, f"blendnorminfo {name}")
            if m.vert_weights is None or m.norm_weights is None:
                m.vert_weights = m.norm_weights = None
    elif blendvertinfoindex or blendnorminfoindex:
        r.err(f"model {name}: blend weight offsets without STUDIO_HAS_BONEWEIGHTS (numgroups/groupindex unsupported)")
    normsum = 0
    corners = 0
    if r.need(meshindex, nummesh * SZ_MESH, f"meshes {name}", 4):
        for j in range(nummesh):
            numtris, triindex, skinref, mnumnorms, mnormindex = r.unpack("iiiii", meshindex + j * SZ_MESH)
            if not 0 <= skinref < max(1, numskinref):
                r.err(f"model {name} mesh {j}: skinref {skinref} out of range")
            tris, cmds, end = _read_tricmds(r, triindex, f"tricmds {name}/{j}")
            corners += sum(len(vs) for _, vs in cmds)
            if end is not None:
                r.ranges.append((triindex, end, f"tricmds {name}/{j}"))
            if len(tris) != numtris:
                r.err(f"model {name} mesh {j}: numtris {numtris} but commands hold {len(tris)}")
            if len(tris):
                if tris[..., 0].max() >= numverts or tris[..., 0].min() < 0:
                    r.err(f"model {name} mesh {j}: vertex index out of range")
                lo, hi = normsum, normsum + mnumnorms
                if tris[..., 1].min() < lo or tris[..., 1].max() >= hi:
                    r.err(f"model {name} mesh {j}: normal index outside the mesh's normal range [{lo},{hi})")
                if skins is not None and skins.size and 0 <= skinref < skins.shape[1]:
                    for fam in range(skins.shape[0]):
                        ti = skins[fam, skinref]
                        if 0 <= ti < len(textures):
                            t = textures[ti]
                            # studio textures repeat (GL_REPEAT): a triangle may cross one edge
                            if (tris[..., 2].min() < 0 or tris[..., 3].min() < 0 or tris[..., 2].max() > 2 * t.width
                                    or tris[..., 3].max() > 2 * t.height):
                                r.err(f"model {name} mesh {j}: s/t outside texture {t.name} (and its first repeat)")
            normsum += mnumnorms
            mesh = Mesh(tris=tris[:, [0, 2, 1]] if len(tris) else tris, skinref=skinref)  # back to outward CCW
            mesh.cmds = cmds
            mesh.numnorms = mnumnorms
            m.meshes.append(mesh)
    if normsum != numnorms:
        r.err(f"model {name}: meshes cover {normsum} normals, model has {numnorms}")
    if corners > XASH_MAXARRAYVERTS:
        r.err(f"model {name}: {corners} strip corners overflow the renderer's {XASH_MAXARRAYVERTS} array vertices")
    return m


def _read_tricmds(r, off, what):
    """Decode strip/fan commands into on-disk-order triangles (n, 3, 4)."""
    tris = []
    cmds = []
    o = off
    while True:
        if o + 2 > r.n:
            r.err(f"{what}: runs past the end of file")
            return np.zeros((0, 3, 4), np.int64), cmds, None
        (cnt,) = struct.unpack_from("<h", r.d, o)
        o += 2
        if cnt == 0:
            break
        fan = cnt < 0
        cnt = abs(cnt)
        if cnt < 3 or o + cnt * 8 > r.n:
            r.err(f"{what}: bad command count {cnt}")
            return np.zeros((0, 3, 4), np.int64), cmds, None
        vs = np.frombuffer(r.d, "<i2", cnt * 4, o).reshape(cnt, 4).astype(np.int64)
        o += cnt * 8
        cmds.append(("fan" if fan else "strip", vs))
        for k in range(cnt - 2):
            if fan:
                tris.append((vs[0], vs[k + 1], vs[k + 2]))
            elif k % 2 == 0:
                tris.append((vs[k], vs[k + 1], vs[k + 2]))
            else:
                tris.append((vs[k + 1], vs[k], vs[k + 2]))
    arr = np.array(tris, dtype=np.int64).reshape(-1, 3, 4)
    return arr, cmds, o


# ----------------------------------------------------------------------------------------------
# exact animation decoding (as cl_dll/StudioModelRenderer.cpp)
# ----------------------------------------------------------------------------------------------

def _value(d, o):
    return struct.unpack_from("<h", d, o)[0]


def _decode_rot_channel(d, p, frame):
    """angle1, angle2 raw values for StudioCalcBoneQuaterion (p = byte offset of the first run)."""
    k = frame
    if d[p + 1] < d[p]:
        k = 0
    while d[p + 1] <= k:
        k -= d[p + 1]
        p += (d[p] + 1) * 2
        if d[p + 1] < d[p]:
            k = 0
    valid, total = d[p], d[p + 1]
    if valid > k:
        a1 = _value(d, p + (k + 1) * 2)
        if valid > k + 1:
            a2 = _value(d, p + (k + 2) * 2)
        elif total > k + 1:
            a2 = a1
        else:
            a2 = _value(d, p + (valid + 2) * 2)
    else:
        a1 = _value(d, p + valid * 2)
        if total > k + 1:
            a2 = a1
        else:
            a2 = _value(d, p + (valid + 2) * 2)
    return a1, a2


def _decode_pos_channel(d, p, frame, s):
    """Interpolated raw value for StudioCalcBonePosition (without scale)."""
    k = frame
    if d[p + 1] < d[p]:
        k = 0
    while d[p + 1] <= k:
        k -= d[p + 1]
        p += (d[p] + 1) * 2
        if d[p + 1] < d[p]:
            k = 0
    valid, total = d[p], d[p + 1]
    if valid > k:
        if valid > k + 1:
            return _value(d, p + (k + 1) * 2) * (1.0 - s) + s * _value(d, p + (k + 2) * 2)
        return float(_value(d, p + (k + 1) * 2))
    if total <= k + 1:
        return _value(d, p + valid * 2) * (1.0 - s) + s * _value(d, p + (valid + 2) * 2)
    return float(_value(d, p + valid * 2))


def controller_adj(pm, controller_bytes=None):
    """StudioCalcBoneAdj without interpolation: controller byte values (index 0..3) -> adj per controller."""
    adj = [0.0] * max(MAXSTUDIOCONTROLLERS, len(pm.controllers))
    for j, c in enumerate(pm.controllers):
        i = c.index
        if i > 3:
            value = 0.0  # mouth closed
            value = (1.0 - value) * c.start + value * c.end
        else:
            byte = controller_bytes[i] if controller_bytes is not None and i < len(controller_bytes) else c.rest
            if c.type & STUDIO_RLOOP:
                value = byte * (360.0 / 256.0) + c.start
            else:
                value = min(max(byte / 255.0, 0.0), 1.0)
                value = (1.0 - value) * c.start + value * c.end
        typ = c.type & STUDIO_TYPES
        adj[j] = value * (math.pi / 180.0) if typ in (STUDIO_XR, STUDIO_YR, STUDIO_ZR) else value
    return adj


def calc_rotations(pm, seq_index, f, controllers=None):
    """StudioCalcRotations: (pos (B, 3), quaternions (B, 4)) for sequence seq_index at frame f (float)."""
    s = pm.sequences[seq_index]
    nf = s["numframes"]
    if f > nf - 1:
        f = 0.0
    elif f < -0.01:
        f = -0.01
    frame = int(f)
    sfrac = f - frame
    adj = controller_adj(pm, controllers)
    d = pm.data
    nb = len(pm.bones)
    pos = np.zeros((nb, 3))
    q = np.zeros((nb, 4))
    for b, bone in enumerate(pm.bones):
        base = s["animindex"] + b * SZ_ANIM
        offs = s["anim_offsets"][0, b]
        a1 = [0.0] * 3
        a2 = [0.0] * 3
        for j in range(3):
            if offs[j + 3] == 0:
                a1[j] = a2[j] = bone.rot[j]
            else:
                r1, r2 = _decode_rot_channel(d, base + int(offs[j + 3]), frame)
                a1[j] = bone.rot[j] + r1 * bone.scale[j + 3]
                a2[j] = bone.rot[j] + r2 * bone.scale[j + 3]
            ci = bone.controller[j + 3]
            if ci != -1:
                a1[j] += adj[ci]
                a2[j] += adj[ci]
        if a1 != a2:
            q[b] = xform.quaternion_slerp(xform.angle_quaternion(a1), xform.angle_quaternion(a2), sfrac)
        else:
            q[b] = xform.angle_quaternion(a1)
        for j in range(3):
            v = bone.pos[j]
            if offs[j]:
                v += _decode_pos_channel(d, base + int(offs[j]), frame, sfrac) * bone.scale[j]
            ci = bone.controller[j]
            if ci != -1:
                v += adj[ci]
            pos[b, j] = v
    mt = s["motiontype"]
    mb = s["motionbone"]
    for j, flag in enumerate((STUDIO_X, STUDIO_Y, STUDIO_Z)):
        if mt & flag:
            pos[mb, j] = 0.0
    return pos, q


def setup_bones(pm, pos, q, root=None):
    """StudioSetupBones: world 3x4 matrices from local positions and quaternions."""
    nb = len(pm.bones)
    mats = np.empty((nb, 3, 4))
    rm = xform.quaternion_matrix(q)
    for b, bone in enumerate(pm.bones):
        local = np.empty((3, 4))
        local[:, :3] = rm[b]
        local[:, 3] = pos[b]
        if bone.parent == -1:
            mats[b] = local if root is None else xform.concat(root, local)
        else:
            mats[b] = xform.concat(mats[bone.parent], local)
    return mats


def pose(pm, seq_index, frame, controllers=None):
    """Bone matrices for a sequence frame, decoded exactly as the engine does."""
    pos, q = calc_rotations(pm, seq_index, frame, controllers)
    return setup_bones(pm, pos, q)


def skin_transforms(pm, bone_mats):
    """The renderer's worldtransform: bonetransform * poseToBone (weighted models), else the bone matrices."""
    if pm.pose_to_bone is None:
        return bone_mats
    out = np.empty_like(bone_mats)
    out[:, :, :3] = bone_mats[:, :, :3] @ pm.pose_to_bone[:, :, :3]
    out[:, :, 3] = np.einsum("bij,bj->bi", bone_mats[:, :, :3], pm.pose_to_bone[:, :, 3]) + bone_mats[:, :, 3]
    return out


def _blend_matrices(world, bw):
    """R_StudioComputeSkinMatrix for every entry: weighted sum of the used slots' matrices (weights / 255,
    shortfall below 1 added to slot 0)."""
    b = np.asarray(bw.bones)
    w = np.where(b >= 0, np.asarray(bw.weights), 0).astype(np.float64) / 255.0
    tot = w.sum(1)
    w[:, 0] += np.where(tot < 1.0, 1.0 - tot, 0.0)
    single = (b[:, 1] < 0)
    w[single] = 0.0
    w[single, 0] = 1.0   # one bone: the matrix is copied as is
    return np.einsum("nk,nkij->nij", w, world[np.maximum(b, 0)])


def posed_model(pm, m, bone_mats):
    """(verts (nv, 3), norms (nn, 3)) of model m in the space of bone_mats, exactly as the GL renderer
    computes them: rigid per-bone transforms, or the blended skin matrices of weighted models (normals
    rotated by the blended matrix and not renormalised, as the engine lights them)."""
    if m.vert_weights is not None and pm.flags & STUDIO_HAS_BONEWEIGHTS and pm.pose_to_bone is not None:
        world = skin_transforms(pm, bone_mats)
        Mv = _blend_matrices(world, m.vert_weights)
        v = np.einsum("nij,nj->ni", Mv[:, :, :3], m.verts) + Mv[:, :, 3]
        Mn = _blend_matrices(world, m.norm_weights)
        n = np.einsum("nij,nj->ni", Mn[:, :, :3], m.norms)
        return v, n
    Wv = bone_mats[m.vert_bone]
    v = np.einsum("nij,nj->ni", Wv[:, :, :3], m.verts) + Wv[:, :, 3]
    Wn = bone_mats[m.norm_bone]
    n = np.einsum("nij,nj->ni", Wn[:, :, :3], m.norms)
    return v, n


def decode_sequence(pm, seq_index):
    """All integer frames of a sequence as (pos (F, B, 3), rot euler (F, B, 3)) - for tests/inspection."""
    s = pm.sequences[seq_index]
    nf = s["numframes"]
    P = np.zeros((nf, len(pm.bones), 3))
    R = np.zeros((nf, len(pm.bones), 3))
    for fr in range(nf):
        pos, q = calc_rotations(pm, seq_index, float(fr) if fr < nf - 1 else nf - 1.0)
        P[fr] = pos
        for b in range(len(pm.bones)):
            R[fr, b] = xform.matrix_euler(xform.quaternion_matrix(q[b]))
    return P, R


def summary(pm):
    """Human-readable one-screen summary of a parsed model."""
    lines = [repr(pm)]
    lines.append("  bones: " + ", ".join(f"{i}:{b.name}<{b.parent}" for i, b in enumerate(pm.bones)))
    for i, s in enumerate(pm.sequences):
        lines.append(f"  seq {i} {s['name']}: {s['numframes']} frames @ {s['fps']:g} fps, flags {s['flags']}, "
                     f"act {s['activity']}, move {tuple(round(x, 2) for x in s['linearmovement'])}, "
                     f"events {len(s['events'])}")
    for t in pm.textures:
        lines.append(f"  texture {t.name}: {t.width}x{t.height} flags {t.flags:#x}")
    lines.append(f"  skins: {pm.skins.tolist()}")
    ntri = 0
    for bp in pm.bodyparts:
        for m in bp.models:
            nt = sum(len(me.tris) for me in m.meshes)
            ntri += nt
            lines.append(f"  bodypart {bp.name} / model {m.name}: {len(m.verts)} verts, {len(m.norms)} norms, "
                         f"{nt} tris, {len(m.meshes)} meshes" + (", bone weights" if m.vert_weights is not None else ""))
    lines.append(f"  triangles total: {ntri}; hitboxes {len(pm.hitboxes)}; attachments {len(pm.attachments)}")
    return "\n".join(lines)
