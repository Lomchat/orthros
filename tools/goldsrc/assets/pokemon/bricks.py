"""Half Strike r11: bricks and Fortnite-style building.  Every model, sprite and sound of the feature, generated
here deterministically (no external asset).

PIECE CONTRACT (the server's grid and the client's blueprint use exactly these numbers; DEVIATIONS.md repeats them)
  Grid tile 128 x 128 units, levels every 128 units.  Every piece model has ONE bone at its origin and one
  sequence "idle" (0); the growth is the server's (renderamt).  Yaw turns pieces by multiples of 90 degrees.
  models/build/wall.mdl   x -64..64, y -4..4, z 0..128: origin at the bottom middle of the wall, the wall lies
                          along x (on a tile EDGE: origin = edge midpoint at the level's height).
  models/build/floor.mdl  x -64..64, y -64..64, z -4..4: origin at the tile centre ON the level plane (its top 4
                          above the level, like the walls' 8 thickness centred on the edge line).
  models/build/ramp.mdl   x -64..64, y -64..64, z 0..128: origin at the tile centre at the level's height; rises
                          towards +x, eight stairs of 16 x 16 (step i = 0..7: x -64+16i .. -48+16i, top at
                          z = 16(i+1)); the visual underside is the plane z = x + 56 (clipped at 0), so a thin
                          collision box per step (z 16i .. 16(i+1)) matches the visual stairs exactly.
  models/build/roof.mdl   x -64..64, y -64..64, z 0..64: origin at the tile centre at the level's height (on top
                          of the walls below); a pyramid shell, apex (0, 0, 64), faces at 45 degrees, 8 thick
                          (vertically).  Suggested collision steps i = 0..3: half-size 56-16i, z 16i .. 16(i+1).
  Skins (all four pieces): 0 intact, 1 cracked, 2 badly cracked, 3 blueprint (light-blue grid, meant for
  kRenderTransAdd), 4 blueprint blocked (the same grid in red).

OTHER FILES
  models/build/brick_pile.mdl  pickup lying on the ground (origin on the ground, centred): bodypart "pile", body
                          0 small (3 bricks, 17 x 17 x 10), 1 medium (6 bricks, 27 x 23 x 10), 2 large (11 bricks,
                          29 x 31 x 20); sequence 0 idle.  Loose bricks are 14 x 7 x 5.
  models/build/gibs_brick.mdl  debris for TE_BREAKMODEL (BREAK_CONCRETE): one bodypart, 8 submodels (the engine
                          picks body = random 0..7): whole brick, half brick, two chunks, a shard, a mortar lump,
                          a stone frame chunk, two bricks still mortared together.
  models/build/v_build.mdl  first-person builder: both gloved hands (balls.py's hands, sleeves and paint, laptop.py's
                          two-hand rig) hold a small blueprint tablet; sequences 0 idle (2 s loop), 1 draw, 2 place
                          (the right thumb taps the screen, which flashes), 3 holster, 4 rotate (a thumb swipe).
                          Skins 0..3: the screen shows the wall / floor / ramp / roof blueprint (the client may set
                          the view model's skin to the selected piece; skin 0 otherwise).
  sprites/build/hud.spr   one additive frame 512 x 64, grey on black (tinted by the client); rectangles (x y w h):
                          wall 0 0 64 64, floor 64 0 64 64, ramp 128 0 64 64, roof 192 0 64 64, brick 256 0 48 48,
                          brick small 304 0 24 24, slot frame 336 0 64 64, deny 400 0 48 48.
  sound/build/  pickup, place, build_loop (one shot, 0.45 s: the piece growing), hit1..3, break1..2, deny,
                select (piece change), toggle (build mode on/off).
"""
import math

import numpy as np

from .. import builder, mdl, mesh as M, rig as R, spr, texture as T, wav as W

# ---------------------------------------------------------------------------------------------
# the contract
# ---------------------------------------------------------------------------------------------

TILE = 128
WALL_T = 8                     # wall / floor thickness
WALL_BOX = ((-64, -4, 0), (64, 4, 128))
FLOOR_BOX = ((-64, -64, -4), (64, 64, 4))
RAMP_BOX = ((-64, -64, 0), (64, 64, 128))
ROOF_BOX = ((-64, -64, 0), (64, 64, 64))
RAMP_STEPS = 8                 # 16 x 16 stairs
RAMP_UNDER = 56.0              # underside plane z = x + RAMP_UNDER
ROOF_H = 64.0
ROOF_T = 8.0
SKIN_INTACT, SKIN_CRACKED, SKIN_BROKEN, SKIN_BLUEPRINT, SKIN_BLOCKED = range(5)
PIECE_SKINS = 5
PILE_BODIES = ("small", "medium", "large")
GIB_BODIES = ("brick", "half", "chunk_a", "chunk_b", "shard", "mortar", "stone", "pair")

FRAME = 8.0                    # width of the stone frame around the brick infill
INSET = 1.5                    # the infill is recessed this much from the frame's faces (walls, floors)
BL, BH = 16.0, 8.0             # brick pitch (length, course height) including the mortar
MORTAR = 0.65                  # half width of a mortar joint

# ---------------------------------------------------------------------------------------------
# palette
# ---------------------------------------------------------------------------------------------

BRICKS = np.array([T.rgb(c) for c in ("#b2532f", "#c0603a", "#a24829", "#93402a", "#c86f45", "#ad5634",
                                      "#7f3825", "#bb5a35")])
BRICK_W = np.array([0.20, 0.17, 0.16, 0.12, 0.09, 0.14, 0.05, 0.07])
BRICK_CORE = T.rgb("#5a2618")
MORTAR_C = T.rgb("#c4bcaa")
STONE = T.rgb("#9b968c")
STONE_LIGHT = T.rgb("#c2bdb1")
STONE_JOINT = T.rgb("#5d5850")
SOOT = T.rgb("#2a221d")
BP_FILL = np.array([0.035, 0.12, 0.26])
BP_LINE = np.array([0.30, 0.66, 1.00])
BP_EDGE = np.array([0.62, 0.90, 1.00])
RED_FILL = np.array([0.24, 0.025, 0.02])
RED_LINE = np.array([0.95, 0.24, 0.16])
RED_EDGE = np.array([1.00, 0.55, 0.45])


def _sstep(e0, e1, x):
    return T._sstep(e0, e1, x)


# ---------------------------------------------------------------------------------------------
# hashing and noise (deterministic)
# ---------------------------------------------------------------------------------------------

def _hash(*args):
    """Hash of integer arrays (broadcast) to [0, 1)."""
    h = np.uint64(1469598103934665603)
    out = None
    for i, a in enumerate(args):
        a = np.asarray(a).astype(np.int64).astype(np.uint64)
        x = a + np.uint64((0x9E3779B97F4A7C15 * (i + 1)) & 0xFFFFFFFFFFFFFFFF)
        out = x if out is None else out ^ (x + np.uint64(0x9E3779B9) + (out << np.uint64(6)) + (out >> np.uint64(2)))
    x = out if out is not None else h
    x = (x ^ (x >> np.uint64(33))) * np.uint64(0xff51afd7ed558ccd)
    x = (x ^ (x >> np.uint64(33))) * np.uint64(0xc4ceb9fe1a85ec53)
    x = x ^ (x >> np.uint64(33))
    return (x >> np.uint64(40)).astype(np.float64) / float(1 << 24)


def _vnoise3(P, scale, seed=0):
    """Smooth value noise in [-1, 1] over 3D points."""
    Q = np.asarray(P, dtype=np.float64) / scale
    i = np.floor(Q).astype(np.int64)
    f = Q - i
    f = f * f * (3 - 2 * f)
    out = np.zeros(len(Q))
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out += w * _hash(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out * 2 - 1


def _fbm3(P, scale, seed=0, octaves=3):
    out, amp, tot = np.zeros(len(P)), 1.0, 0.0
    for o in range(octaves):
        out += amp * _vnoise3(P, scale / (2 ** o), seed + 17 * o)
        tot += amp
        amp *= 0.5
    return out / tot


# ---------------------------------------------------------------------------------------------
# geometry: closed meshes from boxes and extruded profiles
# ---------------------------------------------------------------------------------------------

def _signed_area(poly):
    p = np.asarray(poly, dtype=np.float64)
    return 0.5 * float(np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]))


def triangulate(poly):
    """Ear clipping of a simple polygon [(a, b), ...] (any orientation); triangles CCW in (a, b)."""
    pts = [tuple(map(float, p)) for p in poly]
    idx = list(range(len(pts)))
    if _signed_area(pts) < 0:
        idx.reverse()

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def inside(p, a, b, c):
        return cross(a, b, p) >= -1e-9 and cross(b, c, p) >= -1e-9 and cross(c, a, p) >= -1e-9

    tris = []
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        n = len(idx)
        best = None
        for k in range(n):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % n]
            a, b, c = pts[i0], pts[i1], pts[i2]
            cr = cross(a, b, c)
            if cr <= 1e-9:
                continue
            if any(inside(pts[j], a, b, c) for j in idx if j not in (i0, i1, i2)
                   and pts[j] not in (a, b, c)):
                continue
            # prefer fat ears (fewer slivers)
            la, lb, lc = math.dist(a, b), math.dist(b, c), math.dist(c, a)
            q = cr / max(la * la + lb * lb + lc * lc, 1e-9)
            if best is None or q > best[0]:
                best = (q, k)
        if best is None:
            raise ValueError("triangulate: no ear (polygon not simple?)")
        k = best[1]
        tris.append((idx[k - 1], idx[k], idx[(k + 1) % n]))
        del idx[k]
    tris.append(tuple(idx))
    return tris


def prism(profile, axis, lo, hi):
    """Closed prism: a simple polygon profile [(a, b), ...] in the plane of the two other axes (in cyclic order:
    axis 1 -> (z, x), axis 0 -> (y, z), axis 2 -> (x, y)), extruded along `axis` from lo to hi."""
    prof = [tuple(map(float, p)) for p in profile]
    if _signed_area(prof) < 0:
        prof = prof[::-1]
    n = len(prof)
    a_ax, b_ax = (axis + 1) % 3, (axis + 2) % 3

    def P(p, t):
        v = [0.0, 0.0, 0.0]
        v[a_ax], v[b_ax], v[axis] = p[0], p[1], t
        return v

    verts = [P(p, lo) for p in prof] + [P(p, hi) for p in prof]
    faces = []
    for i0, i1, i2 in triangulate(prof):
        faces.append((n + i0, n + i1, n + i2))   # CCW in (a, b) = normal +axis: the hi cap
        faces.append((i0, i2, i1))
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j))
        faces.append((i, n + j, n + i))
    m = M.TriMesh(np.array(verts), np.array(faces))
    if _volume(m) < 0:
        m = M.TriMesh(m.verts, m.faces[:, ::-1].copy())
    return m


def box(lo, hi):
    lo, hi = np.asarray(lo, dtype=np.float64), np.asarray(hi, dtype=np.float64)
    return prism([(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])], 2, lo[2], hi[2])


def _volume(m):
    v = m.verts[m.faces]
    return float(np.einsum("ij,ij->i", v[:, 0], np.cross(v[:, 1], v[:, 2])).sum() / 6.0)


def framed_slab(half_u, half_v, t, frame, inset, normal_axis):
    """Frame bars (full thickness t) around a recessed infill panel (thickness t - 2 inset), as closed boxes that
    do not overlap on any visible face.  Built in (u, v, n) = (x, z, y) for normal_axis 1 (walls, z from 0), or
    (x, y, z) for normal_axis 2 (floors, centred).  Returns a list of TriMesh."""
    U, V = half_u, half_v
    h = t / 2.0
    hi_in = h - inset
    bars = [((-U, -V, -h), (U, -V + frame, h)), ((-U, V - frame, -h), (U, V, h)),
            ((-U, -V + frame, -h), (-U + frame, V - frame, h)), ((U - frame, -V + frame, -h), (U, V - frame, h))]
    panel = ((-U + frame - 0.01, -V + frame - 0.01, -hi_in), (U - frame + 0.01, V - frame + 0.01, hi_in))
    out = []
    for lo, hi in bars + [panel]:
        if normal_axis == 1:   # (u, v, n) -> (x, z + V, y)
            out.append(box((lo[0], lo[2], lo[1] + V), (hi[0], hi[2], hi[1] + V)))
        else:
            out.append(box(lo, hi))
    return out


def wall_meshes():
    return framed_slab(64.0, 64.0, WALL_T, FRAME, INSET, 1)


def floor_meshes():
    return framed_slab(64.0, 64.0, WALL_T, FRAME, INSET, 2)


def ramp_profile():
    """The stairs' side profile in (z, x) (prism along y)."""
    pts = [(0.0, -64.0)]
    for i in range(RAMP_STEPS):
        x0 = -64.0 + 16.0 * i
        pts.append((16.0 * (i + 1), x0))
        pts.append((16.0 * (i + 1), x0 + 16.0))
    pts.append((64.0 + RAMP_UNDER, 64.0))      # underside meets the top end face
    pts.append((0.0, -RAMP_UNDER))
    return pts


def ramp_meshes():
    return [prism(ramp_profile(), 1, -64.0, 64.0)]


def roof_meshes():
    """Pyramid shell: outer faces z = H - max(|x|, |y|), inner z = H - T - max(|x|, |y|), a flat ring at z = 0."""
    H, Tt = ROOF_H, ROOF_T
    ri = H - Tt                          # the inner surface reaches z = 0 at |x|, |y| = ri
    ap_o, ap_i = (0.0, 0.0, H), (0.0, 0.0, H - Tt)
    co = [(64, 64), (-64, 64), (-64, -64), (64, -64)]
    ci = [(ri, ri), (-ri, ri), (-ri, -ri), (ri, -ri)]
    verts = [ap_o, ap_i] + [(x, y, 0.0) for x, y in co] + [(x, y, 0.0) for x, y in ci]
    faces = []
    for k in range(4):
        a, b = 2 + k, 2 + (k + 1) % 4          # outer corners (CCW seen from above)
        ia, ib = 6 + k, 6 + (k + 1) % 4
        faces.append((0, a, b))                 # outer face
        faces.append((1, ib, ia))               # inner face (seen from below)
        faces.append((a, ia, ib))               # bottom ring
        faces.append((a, ib, b))
    m = M.TriMesh(np.array(verts, dtype=np.float64), np.array(faces))
    if _volume(m) < 0:
        m = M.TriMesh(m.verts, m.faces[:, ::-1].copy())
    outer = np.array([k % 4 == 0 for k in range(len(m.faces))])
    # the outer faces get more texels than the underside and the ring (density per part)
    return [M.TriMesh(m.verts, m.faces[outer]).compact(), M.TriMesh(m.verts, m.faces[~outer]).compact()]


# ---------------------------------------------------------------------------------------------
# surfaces: where the bricks are, their coordinates, the frame's
# ---------------------------------------------------------------------------------------------

class Surf:
    """Per-point surface description (arrays of len(P)):
    u, v       brick coordinates on the piece's main faces (rows along u), NaN elsewhere
    brick      bool, brick infill (else stone frame)
    along, across  stone coordinates (blocks along `along`)
    edge       distance to the piece's outer silhouette edge on that face (chips, blueprint outline)
    inner      distance to the frame / infill boundary (AO and the blueprint's frame line), large if none
    ao         baked occlusion factor (1 open)
    cu, cv     crack domain coordinates (NaN = no cracks on this face)
    grid       blueprint grid coordinates (2D)
    """

    def __init__(self, n):
        nan = np.full(n, np.nan)
        self.u, self.v = nan.copy(), nan.copy()
        self.brick = np.zeros(n, dtype=bool)
        self.along, self.across = np.zeros(n), np.zeros(n)
        self.edge = np.full(n, 99.0)
        self.inner = np.full(n, 99.0)
        self.ao = np.ones(n)
        self.cu, self.cv = nan.copy(), nan.copy()
        self.gu, self.gv = np.zeros(n), np.zeros(n)


def _slab_surf(P, N, n_ax, u_ax, v_ax, v0):
    """Framed slab (walls: n_ax 1, u x, v z from v0 = 0; floors: n_ax 2, u x, v y from -64)."""
    S = Surf(len(P))
    pn, pu, pv = P[:, n_ax], P[:, u_ax], P[:, v_ax] - v0       # pv in 0..128
    nn = np.abs(N[:, n_ax])
    main = nn > 0.7
    infill = main & (np.abs(pn) < WALL_T / 2 - INSET / 2)
    S.brick = infill
    S.u = np.where(main, pu + 64.0 - FRAME, np.nan)
    S.v = np.where(main, pv - FRAME, np.nan)
    S.cu, S.cv = S.u.copy(), S.v.copy()
    du = 64.0 - np.abs(pu)
    dv = np.minimum(pv, 128.0 - pv)
    S.edge = np.where(main, np.minimum(du, dv), np.minimum(np.minimum(du, dv), WALL_T / 2 - np.abs(pn)))
    S.inner = np.where(infill, np.minimum(du, dv) - FRAME, np.where(main, FRAME - np.minimum(du, dv), 99.0))
    horiz_bar = dv < FRAME + 0.01
    S.along = np.where(horiz_bar, pu + 64.0, pv)
    S.across = np.where(horiz_bar, dv, du)
    # the faces across the slab: blocks along their long side
    side = ~main
    su = np.abs(N[:, u_ax]) > 0.7
    S.along = np.where(side & su, pv, np.where(side, pu + 64.0, S.along))
    S.across = np.where(side, pn + WALL_T / 2, S.across)
    # occlusion: the infill next to the frame, the reveal faces' inner end
    S.ao = np.where(infill, 1.0 - 0.38 * np.exp(-np.maximum(S.inner, 0) / 2.2), 1.0)
    reveal = side & (np.minimum(du, dv) > FRAME - 0.3) & (np.minimum(du, dv) < FRAME + 0.3)
    depth = WALL_T / 2 - np.abs(pn)                          # 0 at the frame face, INSET at the panel
    S.ao = np.where(reveal, 1.0 - 0.35 * np.clip(depth / INSET, 0, 1), S.ao)
    S.gu, S.gv = np.where(main, pu, np.where(su, pv, pu)), np.where(main, pv, pn)
    return S


def wall_surf(P, N):
    return _slab_surf(P, N, 1, 0, 2, 0.0)


def floor_surf(P, N):
    return _slab_surf(P, N, 2, 0, 1, -64.0)


def ramp_surf(P, N):
    S = Surf(len(P))
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    tread = N[:, 2] > 0.7
    riser = N[:, 0] < -0.7
    under = (N[:, 2] < -0.3) & (N[:, 0] > 0.3)
    bottom = N[:, 2] < -0.95
    sides = np.abs(N[:, 1]) > 0.7
    top_end = N[:, 0] > 0.7
    dy = 64.0 - np.abs(y)
    step_x = (x + 64.0) - 16.0 * np.clip(np.floor((x + 64.0) / 16.0 - 1e-6), 0, RAMP_STEPS - 1)
    main = tread | riser | under
    s = x + 64.0 + z                    # monotone along the stairs (treads and risers alike)
    S.u = np.where(main, y + 64.0 - FRAME, np.nan)
    S.v = np.where(tread, x + 64.0, np.where(riser, z, np.where(under, (x + RAMP_UNDER) * math.sqrt(2), np.nan)))
    S.cu = np.where(main, y + 64.0, np.nan)
    S.cv = np.where(main, s, np.nan)          # the underside shows the same cracks, through the slab
    nosing = tread & (step_x < 2.5)
    S.brick = main & (dy > FRAME) & ~nosing
    S.edge = np.where(main, dy, 99.0)
    S.edge = np.where(tread, np.minimum(S.edge, np.minimum(step_x, 16.0 - step_x) + 0.5), S.edge)
    S.inner = np.where(S.brick, dy - FRAME, 99.0)
    S.along = np.where(main, np.where(dy < FRAME, x + z, y + 64.0), 0.0)
    S.across = np.where(main, np.where(dy < FRAME, dy, step_x), 0.0)
    S.along = np.where(sides, (x + z) / math.sqrt(2), S.along)
    S.across = np.where(sides, (z - x) / math.sqrt(2), S.across)
    S.along = np.where(top_end | bottom, y + 64.0, S.along)
    S.across = np.where(top_end, z, np.where(bottom, x, S.across))
    # occlusion: the inner corner at the foot of each riser
    rz = z - 16.0 * np.floor(z / 16.0 + 1e-6)
    S.ao = np.where(riser, 1.0 - 0.30 * np.exp(-rz / 2.5), 1.0)
    S.ao = np.where(tread, 1.0 - 0.30 * np.exp(-(16.0 - step_x) / 2.5), S.ao)
    S.ao = np.where(under, 0.85, S.ao)
    S.gu = np.where(sides, x, y)
    S.gv = np.where(tread, x, np.where(sides, z, z))
    return S


def roof_surf(P, N):
    S = Surf(len(P))
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    ax, ay = np.abs(x), np.abs(y)
    xface = ax >= ay
    outer = N[:, 2] > 0.3
    inner = (N[:, 2] < -0.3) & (N[:, 2] > -0.95)
    ring = N[:, 2] <= -0.95
    slope = outer | inner
    face_id = np.where(xface, np.where(x > 0, 0, 2), np.where(y > 0, 1, 3))
    a_in = np.where(xface, np.sign(x) * y, -np.sign(y) * x)  # across the face (left-right seen from outside)
    hor = np.where(xface, ax, ay)                          # horizontal distance from the apex axis
    base = np.where(outer, 64.0, ROOF_H - ROOF_T)
    sl = (base - hor) * math.sqrt(2)                       # slant distance up from the eave
    hip = (hor - np.minimum(ax, ay)) / math.sqrt(2)        # in-plane distance to the nearest hip line (approx)
    cap = sl > (base * math.sqrt(2) - 9.0)
    S.u = np.where(slope, a_in + 64.0, np.nan)
    S.v = np.where(slope, sl - 6.0, np.nan)
    S.brick = slope & (hip > 5.0) & (sl > 6.0) & ~cap
    S.cu = np.where(outer, a_in + 64.0 + 160.0 * face_id, np.nan)
    S.cv = np.where(outer, sl, np.nan)
    S.edge = np.where(slope, np.minimum(sl, hip), 99.0)
    S.inner = np.where(S.brick, np.minimum(hip - 5.0, sl - 6.0), 99.0)
    S.along = np.where(hip <= 5.0, sl, a_in + 64.0)
    S.across = np.where(hip <= 5.0, hip, sl)
    S.along = np.where(ring, np.where(xface, y, x) + 64.0, S.along)
    S.across = np.where(ring, 64.0 - hor, S.across)
    S.ao = np.where(S.brick, 1.0 - 0.30 * np.exp(-np.maximum(S.inner, 0) / 2.2), 1.0)
    S.ao = np.where(inner, S.ao * 0.80, S.ao)
    S.gu = np.where(slope, a_in, x)
    S.gv = np.where(slope, sl, y)
    return S


# ---------------------------------------------------------------------------------------------
# cracks: stair-step along the mortar, jagged through the stone
# ---------------------------------------------------------------------------------------------

def _row_shift(row):
    return (np.asarray(row) % 2) * (BL / 2)


def crack_paths(seed, domains, n_systems, length, branch=0.35, through=0.18):
    """Polylines [(points (k, 2), width)] in crack-domain coordinates.  domains: [(u0, u1, v0, v1), ...] seeds
    are drawn from (weighted by area).  Each system walks the mortar joints downwards and upwards from its seed
    (bed joint, half a brick, head joint, ...), now and then straight through a brick, and branches."""
    rng = np.random.default_rng(seed)
    areas = np.array([(d[1] - d[0]) * (d[3] - d[2]) for d in domains], dtype=np.float64)
    out = []

    def walk(u, v, direction, steps, width, depth):
        pts = [(u, v)]
        row = int(math.floor(v / BH + 0.5))
        v = row * BH
        pts.append((u + rng.uniform(-0.3, 0.3), v))
        side = 1 if rng.random() < 0.5 else -1
        for k in range(steps):
            nrow = row - 1 if direction < 0 else row
            # head joints of the course crossed: u = j * BL - shift
            sh = float(_row_shift(nrow))
            j = math.floor((u + sh) / BL)
            cands = [j * BL - sh, (j + 1) * BL - sh]
            if rng.random() < 0.75:
                side = side if rng.random() < 0.8 else -side
            hu = cands[1] if side > 0 else cands[0]
            if abs(hu - u) < 1.0:
                hu += side * BL
            if rng.random() < through:
                # straight through the brick, a jagged diagonal
                nv = v + direction * BH
                nu = u + side * rng.uniform(3.0, 9.0)
                mid = ((u + nu) / 2 + rng.uniform(-1.2, 1.2), (v + nv) / 2 + rng.uniform(-1.0, 1.0))
                pts += [mid, (nu, nv)]
                u, v = nu, nv
            else:
                pts.append((hu + rng.uniform(-0.25, 0.25), v + rng.uniform(-0.2, 0.2)))
                v = v + direction * BH
                pts.append((hu + rng.uniform(-0.25, 0.25), v))
                u = hu
            row = int(round(v / BH))
            if depth < 2 and rng.random() < branch / (1 + depth):
                walk(u, v, direction if rng.random() < 0.7 else -direction, max(1, steps // 2 - k // 2),
                     width * 0.65, depth + 1)
        p = np.array(pts)
        k = np.arange(len(p), dtype=np.float64)
        # thickest near the seed, tapering to a hairline at the far end, wavering
        taper = 1.0 - 0.8 * (k / max(len(p) - 1, 1)) ** 1.3
        wv = width * taper * rng.uniform(0.75, 1.15, len(p))
        out.append((p, wv))

    for _ in range(n_systems):
        d = domains[int(rng.choice(len(domains), p=areas / areas.sum()))]
        u0 = rng.uniform(d[0] + 0.15 * (d[1] - d[0]), d[1] - 0.15 * (d[1] - d[0]))
        v0 = rng.uniform(d[2] + 0.2 * (d[3] - d[2]), d[3] - 0.1 * (d[3] - d[2]))
        steps = max(2, int(length * rng.uniform(0.6, 1.2) / BH))
        w = rng.uniform(0.55, 0.85)
        walk(u0, v0, -1, steps, w, 0)
        walk(u0, v0, 1, max(1, steps // 2), w * 0.85, 1)
    return out


def _seg_dist(pu, pv, a, b):
    du, dv = b[0] - a[0], b[1] - a[1]
    L2 = du * du + dv * dv
    t = np.clip(((pu - a[0]) * du + (pv - a[1]) * dv) / max(L2, 1e-9), 0, 1)
    return np.hypot(pu - a[0] - t * du, pv - a[1] - t * dv), t


def crack_field(cu, cv, paths):
    """(distance to the nearest crack minus its half width, that crack's width) per point; +inf off-domain."""
    d = np.full(len(cu), np.inf)
    ok = np.isfinite(cu) & np.isfinite(cv)
    if not ok.any():
        return d
    idx = np.nonzero(ok)[0]
    pu, pv = cu[idx], cv[idx]
    best = np.full(len(idx), np.inf)
    for pts, w in paths:
        lo = pts.min(0) - 4
        hi = pts.max(0) + 4
        sel = (pu > lo[0]) & (pu < hi[0]) & (pv > lo[1]) & (pv < hi[1])
        if not sel.any():
            continue
        su, sv = pu[sel], pv[sel]
        dd = np.full(len(su), np.inf)
        for k in range(len(pts) - 1):
            dk, t = _seg_dist(su, sv, pts[k], pts[k + 1])
            dd = np.minimum(dd, dk - (w[k] + (w[k + 1] - w[k]) * t))
        best[sel] = np.minimum(best[sel], dd)
    d[idx] = best
    return d


# ---------------------------------------------------------------------------------------------
# the paint
# ---------------------------------------------------------------------------------------------

def brick_cells(u, v):
    """Running bond: (row, col, fu, fv) with fu in [0, BL), fv in [0, BH)."""
    row = np.floor(v / BH)
    sh = _row_shift(row.astype(np.int64))
    uu = u + sh
    col = np.floor(uu / BL)
    return row.astype(np.int64), col.astype(np.int64), uu - col * BL, v - row * BH


class PiecePaint:
    def __init__(self, surf, seed, domains, crack_len=(48.0, 80.0), systems=(4, 7), holes=(0, 9)):
        self.surf = surf
        self.seed = seed
        # every domain (a roof's four faces) gets its share of the crack systems
        per = len(domains)
        self.cracks = {lv: sum((crack_paths(seed + lv + 10 * j, [d], max(1, round(systems[lv - 1] / per + 0.3)),
                                            crack_len[lv - 1]) for j, d in enumerate(domains)), [])
                       for lv in (1, 2)}
        # level 2 keeps the level 1 cracks (wider) and adds its own
        self.cracks[1] = [(p, w * 0.85) for p, w in self.cracks[1]]
        self.cracks[2] = [(p, w * 1.6) for p, w in self.cracks[1]] + self.cracks[2]
        rng = np.random.default_rng(seed + 3)
        pts = np.concatenate([p for p, _ in self.cracks[2]])
        pick = rng.choice(len(pts), size=min(holes[1], len(pts)), replace=False)
        self.holes = [(pts[i] + rng.uniform(-2, 2, 2), rng.uniform(2.8, 5.5), rng.uniform(0.6, 1.3, 7))
                      for i in pick]
        p1 = np.concatenate([p for p, _ in self.cracks[1]])
        pick1 = rng.choice(len(p1), size=min(3, len(p1)), replace=False)
        self.chips1 = [(p1[i] + rng.uniform(-1, 1, 2), rng.uniform(1.6, 2.6), rng.uniform(0.6, 1.3, 7)) for i in pick1]

    # bricks and mortar ------------------------------------------------------------------------
    def bricks(self, P, S, sel):
        u, v = S.u[sel], S.v[sel]
        row, col, fu, fv = brick_cells(u, v)
        h1 = _hash(row, col, self.seed)
        h2 = _hash(row, col, self.seed + 7)
        h3 = _hash(row, col, self.seed + 13)
        cdf = np.cumsum(BRICK_W / BRICK_W.sum())
        k = np.searchsorted(cdf, h1).clip(0, len(BRICKS) - 1)
        c = BRICKS[k] * (0.92 + 0.16 * h2)[:, None]
        # a darker, burnt end on some bricks
        burnt = (h3 > 0.72) * np.clip(1 - fu / BL * 1.8, 0, 1) * 0.22
        c = c * (1 - burnt)[:, None]
        sp = _vnoise3(P[sel] * np.array([1.0, 1.0, 1.0]), 0.9, self.seed + 31)
        c = c * (1 + 0.07 * sp)[:, None]
        # painted bevel, light from the top left
        dt, db = (BH - MORTAR) - fv, fv - MORTAR
        dl, dr = fu - MORTAR, (BL - MORTAR) - fu
        f = 1 + 0.20 * np.exp(-np.maximum(dt, 0) / 0.7) + 0.07 * np.exp(-np.maximum(dl, 0) / 0.7) \
            - 0.24 * np.exp(-np.maximum(db, 0) / 0.7) - 0.10 * np.exp(-np.maximum(dr, 0) / 0.7)
        c = c * f[:, None]
        # mortar, slightly recessed (darker against the bricks)
        dm = np.minimum(np.minimum(dt, db), np.minimum(dl, dr))
        mort = dm < 0
        mc = MORTAR_C * (0.80 + 0.20 * np.clip(-dm / MORTAR, 0, 1))[:, None] \
            * (1 + 0.05 * _vnoise3(P[sel], 0.6, self.seed + 41))[:, None]
        c = np.where(mort[:, None], mc, c)
        return c, row, col

    def stone(self, P, S, sel):
        al, ac = S.along[sel], S.across[sel]
        blk = np.floor(al / 32.0)
        fa = al - blk * 32.0
        h = _hash(blk.astype(np.int64), np.floor(ac / 64).astype(np.int64), self.seed + 101)
        c = STONE * (0.93 + 0.12 * h)[:, None]
        c = c * (1 + 0.06 * _fbm3(P[sel], 3.0, self.seed + 103))[:, None]
        c = c * (1 + 0.05 * _vnoise3(P[sel], 0.7, self.seed + 107))[:, None]
        # joints between the blocks and a chamfer along the frame's edges
        dj = np.minimum(fa, 32.0 - fa)
        joint = dj < 0.45
        e = S.edge[sel]
        cham = np.exp(-np.maximum(e, 0) / 0.9)
        c = T.mix(c, STONE_LIGHT, (0.55 * cham)[:, None] * np.ones((1, 3)))
        c = c * (1 - 0.18 * np.exp(-np.maximum(dj - 0.45, 0) / 0.8))[:, None]
        c = np.where(joint[:, None], STONE_JOINT[None, :] * np.ones((len(al), 1)), c)
        return c

    # damage -----------------------------------------------------------------------------------
    def damage(self, P, S, c, level):
        d = crack_field(S.cu, S.cv, self.cracks[level])
        # broken bricks along the worst cracks (level 2): the brick's face gone, its cavity in shadow
        if level >= 2 and S.brick.any():
            b = S.brick & np.isfinite(S.u)
            row, col, fu, fv = brick_cells(S.u[b], S.v[b])
            h = _hash(row, col, self.seed + 501)
            reach = 3.0 + 3.5 * (0.5 + 0.5 * _vnoise3(P[b], 1.6, self.seed + 503))
            gone = (h < 0.16) & (d[b] < reach)
            if gone.any():
                cav = BRICK_CORE * (0.38 + 0.22 * (0.5 + 0.5 * _vnoise3(P[b][gone], 0.7, self.seed + 505)))[:, None]
                # the brick above shadows the cavity's top, its floor catches some light
                k = np.clip(fv[gone] / BH, 0, 1)
                cav = cav * (1.25 - 0.75 * k)[:, None]
                cc = c[b]
                cc[gone] = cav
                c[b] = cc
                dd = d[b]
                dd[gone] = np.minimum(dd[gone], 0.6)       # no crack line drawn inside the cavity
        core = d < 0
        halo = (d >= 0) & (d < 0.8)
        crack_c = np.array([0.09, 0.06, 0.05])
        c = np.where(halo[:, None], c * (0.80 + 0.25 * np.clip(d / 0.8, 0, 1))[:, None], c)
        c = np.where(core[:, None], crack_c * (1 + 0.4 * np.clip(-d, 0, 1))[:, None], c)
        # dust / soot
        dirt = np.clip(_fbm3(P, 18.0, self.seed + 211) * 1.6 - (0.25 if level == 1 else -0.05), 0, 1)
        c = T.mix(c, c * 0.55 + SOOT * 0.25, (dirt * (0.22 if level == 1 else 0.45))[:, None] * np.ones((1, 3)))
        ok = np.isfinite(S.cu)
        for (hc, r, hs) in (self.holes if level >= 2 else self.chips1):
            du = np.where(ok, S.cu - hc[0], 99.0)
            dv = np.where(ok, S.cv - hc[1], 99.0)
            near = (np.abs(du) < r * 1.5 + 2) & (np.abs(dv) < r * 1.5 + 2)
            if not near.any():
                continue
            ang = np.arctan2(dv[near], du[near])
            rr = np.hypot(du[near], dv[near])
            # an angular outline: radii at 7 corners, straight-ish between them
            a7 = (ang + math.pi) / (2 * math.pi) * 7
            i7 = np.floor(a7).astype(np.int64) % 7
            f7 = a7 - np.floor(a7)
            edge_r = r * (hs[i7] * (1 - f7) + hs[(i7 + 1) % 7] * f7)
            inside = rr < edge_r
            rim = (rr >= edge_r) & (rr < edge_r + 0.8)
            cc = c[near]
            core_c = BRICK_CORE * (0.70 + 0.40 * (0.5 + 0.5 * _vnoise3(P[near], 0.8, int(hs[0] * 1000))))[:, None]
            # a chipped crater: lit on its lower inner slope, shadowed under its top edge
            lit = np.clip(-np.sin(ang), 0, 1) * np.clip((rr / edge_r - 0.5) / 0.5, 0, 1)
            shad = np.clip(np.sin(ang), 0, 1) * np.clip((rr / edge_r - 0.4) / 0.6, 0, 1)
            core_c = core_c * (1 + 0.6 * lit - 0.55 * shad)[:, None]
            cc = np.where(inside[:, None], core_c, cc)
            cc = np.where(rim[:, None], cc * 0.75, cc)
            c[near] = cc
        if level >= 2:
            # chipped outer edges of the frame
            chip = (S.edge < 1.5) & (_vnoise3(P, 3.0, self.seed + 307) > 0.42)
            c = np.where(chip[:, None], c * 0.55 + np.array([0.06, 0.05, 0.045]), c)
        return np.clip(c, 0, 1)

    # blueprint --------------------------------------------------------------------------------
    def blueprint(self, P, S, red):
        fill, line, edge = (RED_FILL, RED_LINE, RED_EDGE) if red else (BP_FILL, BP_LINE, BP_EDGE)
        gu = np.abs(((S.gu / 16.0) % 1.0) - 0.5) * 16.0
        gv = np.abs(((S.gv / 16.0) % 1.0) - 0.5) * 16.0
        g = np.maximum(_sstep(7.15, 7.6, gu), _sstep(7.15, 7.6, gv))
        c = fill[None, :] * (1.0 + 0.45 * (~S.brick)[:, None]) + line[None, :] * (0.55 * g)[:, None]
        border = np.exp(-np.maximum(S.edge, 0) / 0.8)
        frame_line = np.exp(-np.abs(S.inner) / 0.6) * (S.inner < 50)
        c = c + edge[None, :] * np.clip(border + 0.6 * frame_line, 0, 1)[:, None]
        return np.clip(c, 0, 1)

    # entry ------------------------------------------------------------------------------------
    def __call__(self, P, N, skin):
        S = self.surf(P, N)
        if skin >= SKIN_BLUEPRINT:
            return self.blueprint(P, S, skin == SKIN_BLOCKED)
        c = np.zeros((len(P), 3))
        b = S.brick
        if b.any():
            c[b] = self.bricks(P, S, b)[0]
        if (~b).any():
            c[~b] = self.stone(P, S, ~b)
        if skin >= 1:
            c = self.damage(P, S, c, skin)
        return T.shade(c, N, ao=S.ao, ao_strength=1.0, top=0.10, shadow_tint="#6c7080", cavity_floor=0.4)


# ---------------------------------------------------------------------------------------------
# piece models
# ---------------------------------------------------------------------------------------------

def _piece_rig():
    rig = R.Rig()
    rig.add("piece", None, (0, 0, 0), tail=(0, 0, 16))
    return rig


def planar_parts(m):
    """Split a mesh into its axis-aligned faces and one group per oblique plane orientation, each with the UV box
    frame that keeps that plane's texels square (box charts project on the model axes: a 45 degree face would
    get 0.7 of the texels across its slope).  Returns [(TriMesh, frame or None)]."""
    v = m.verts[m.faces]
    n = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    axis = np.abs(n).max(axis=1) > 0.98
    out = []
    if axis.any():
        out.append((M.TriMesh(m.verts, m.faces[axis]).compact(), None))
    keys = {}
    for f in np.nonzero(~axis)[0]:
        keys.setdefault(tuple(np.round(n[f], 3)), []).append(f)
    for k in sorted(keys):
        nn = np.asarray(k, dtype=np.float64)
        nn /= np.linalg.norm(nn)
        e2 = np.cross(nn, (0.0, 0.0, 1.0))
        if np.linalg.norm(e2) < 1e-6:
            e2 = np.array([0.0, 1.0, 0.0])
        e2 /= np.linalg.norm(e2)
        e1 = np.cross(e2, nn)
        out.append((M.TriMesh(m.verts, m.faces[keys[k]]).compact(), np.stack([e1, e2, nn], axis=1)))
    return out


def piece_model(name, meshes, surf, seed, domains, box_, size, density=None):
    rig = _piece_rig()
    paint = PiecePaint(surf, seed, domains)
    b = builder.ModelBuilder(name, rig, skins=PIECE_SKINS, verbose=False)
    b.group("brick", size=size, pack="skyline")
    k = 0
    for i, m in enumerate(meshes):
        for sub, frame in planar_parts(m):
            b.add(builder.Part(f"p{k}", mesh=sub, bone="piece", paint=paint, group="brick", crease=20,
                               density=(density[i] if density else 1.0), hitbox=False,
                               charts=({"frame": frame} if frame is not None else None)))
            k += 1
    b.add_sequence(R.make_sequence(rig, "idle", lambda t: R.Pose(), frames=1, fps=10, loop=True,
                                   activity=mdl.ACT["IDLE"]))
    b.hitbox("piece", box_[0], box_[1])
    b.hull = box_
    b.eyeposition = (0, 0, 0)
    data = b.write()
    return data, b


def build_wall():
    return piece_model("build/wall.mdl", wall_meshes(), wall_surf, 1100, [(0, 112, 0, 112)], WALL_BOX, (512, 512))


def build_floor():
    return piece_model("build/floor.mdl", floor_meshes(), floor_surf, 1200, [(0, 112, 0, 112)], FLOOR_BOX,
                       (512, 512))


def build_ramp():
    return piece_model("build/ramp.mdl", ramp_meshes(), ramp_surf, 1300, [(0, 128, 20, 250)], RAMP_BOX, (768, 512))


def build_roof():
    doms = [(160 * k + 20, 160 * k + 108, 10, 60) for k in range(4)]
    return piece_model("build/roof.mdl", roof_meshes(), roof_surf, 1400, doms, ROOF_BOX, (768, 640),
                       density=[1.0, 0.55])


# ---------------------------------------------------------------------------------------------
# loose bricks: convex polyhedra (crisp chamfered bricks, fractured chunks)
# ---------------------------------------------------------------------------------------------

def _box_polys(h):
    hx, hy, hz = h
    c = np.array([[sx * hx, sy * hy, sz * hz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    polys = [c[list(q)] for q in quads]
    return [_outward(p, np.zeros(3)) for p in polys]


def _outward(poly, centre):
    n = np.cross(poly[1] - poly[0], poly[2] - poly[0])
    if n @ (poly.mean(0) - centre) < 0:
        poly = poly[::-1]
    return poly


def clip_convex(polys, n, d):
    """Keep the part of a convex polyhedron (outward CCW polygons) where n . p <= d; caps the cut."""
    n = np.asarray(n, dtype=np.float64)
    n = n / np.linalg.norm(n)
    out, cut = [], []
    for poly in polys:
        sd = poly @ n - d
        if (sd <= 1e-9).all():
            out.append(poly)
            continue
        if (sd >= -1e-9).all():
            continue
        res = []
        k = len(poly)
        for i in range(k):
            a, b = poly[i], poly[(i + 1) % k]
            da, db = sd[i], sd[(i + 1) % k]
            if da <= 0:
                res.append(a)
            if (da < 0 < db) or (db < 0 < da):
                t = da / (da - db)
                q = a + t * (b - a)
                res.append(q)
                cut.append(q)
        if len(res) >= 3:
            out.append(np.array(res))
    if len(cut) >= 3:
        Q = np.array(cut)
        c = Q.mean(0)
        e1 = Q[np.argmax(np.linalg.norm(Q - c, axis=1))] - c
        e1 /= np.linalg.norm(e1)
        e2 = np.cross(n, e1)
        ang = np.arctan2((Q - c) @ e2, (Q - c) @ e1)
        order = np.argsort(ang)
        Q = Q[order]
        keep = [Q[0]]
        for q in Q[1:]:
            if np.linalg.norm(q - keep[-1]) > 1e-6:
                keep.append(q)
        if len(keep) >= 3 and np.linalg.norm(keep[0] - keep[-1]) < 1e-6:
            keep.pop()
        if len(keep) >= 3:
            out.append(np.array(keep))      # CCW about n = outward
    return out


def polys_mesh(polys):
    verts, faces = [], []
    for poly in polys:
        b = len(verts)
        verts.extend(poly.tolist())
        for i in range(1, len(poly) - 1):
            faces.append((b, b + i, b + i + 1))
    m = M.weld(M.TriMesh(np.array(verts), np.array(faces)), tol=1e-5)
    # drop degenerate triangles left by the weld
    v = m.verts[m.faces]
    area = np.linalg.norm(np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0]), axis=1)
    return M.TriMesh(m.verts, m.faces[area > 1e-7]).compact()


def brick_polys(h, chamfer=0.45):
    polys = _box_polys(h)
    hx, hy, hz = h
    for ax in range(3):
        b_, c_ = (ax + 1) % 3, (ax + 2) % 3
        for sb in (-1, 1):
            for sc in (-1, 1):
                n = np.zeros(3)
                n[b_], n[c_] = sb, sc
                d = (h[b_] + h[c_] - chamfer) / math.sqrt(2)
                polys = clip_convex(polys, n / math.sqrt(2), d)
    return polys


BRICK_H = (7.0, 3.5, 2.5)        # loose brick half sizes: 14 x 7 x 5


class LoosePaint:
    """A loose brick (or chunk) in its own frame: brick colour on its original faces, the darker fired core on
    fractures, mortar crumbs on the bed faces (gibs), baked top light."""

    def __init__(self, R_, t, h, colour_k, seed, mortar=0.0, stone=False):
        self.R = np.asarray(R_, dtype=np.float64)
        self.t = np.asarray(t, dtype=np.float64)
        self.h = np.asarray(h, dtype=np.float64)
        self.k = colour_k
        self.seed = seed
        self.mortar = mortar
        self.stone = stone

    def __call__(self, P, N, skin):
        L = (P - self.t) @ self.R
        Ln = N @ self.R
        depth = np.min(self.h[None, :] - np.abs(L), axis=1)
        a = -np.sort(-np.abs(Ln), axis=1)
        aligned = (a[:, 0] > 0.97) | ((np.abs(a[:, 0] - 0.7071) < 0.05) & (np.abs(a[:, 1] - 0.7071) < 0.05))
        frac = (depth > 0.35) | ~aligned
        if self.stone:
            base = STONE * (0.95 + 0.08 * _fbm3(P, 2.0, self.seed))[:, None]
            core = STONE * 0.78 * (1 + 0.10 * _vnoise3(P, 0.6, self.seed + 3))[:, None]
        else:
            base = BRICKS[self.k] * (1 + 0.035 * _vnoise3(P, 1.2, self.seed) + 0.045 * _vnoise3(P, 0.3, self.seed + 1))[:, None]
            core = BRICK_CORE * (1.05 + 0.25 * _vnoise3(P, 0.5, self.seed + 3))[:, None]
        c = np.where(frac[:, None], core, base)
        # chamfer highlight
        edge = np.sort(self.h[None, :] - np.abs(L), axis=1)[:, 1]
        c = c * (1 + 0.18 * np.exp(-np.maximum(edge, 0) / 0.5) * (~frac))[:, None]
        if self.mortar:
            bed = (np.abs(Ln[:, 2]) > 0.7) & ~frac
            crumbs = (_vnoise3(P, 0.7, self.seed + 9) > 0.55 - self.mortar) & bed
            c = np.where(crumbs[:, None], MORTAR_C * (0.85 + 0.15 * _vnoise3(P, 0.5, self.seed + 11))[:, None], c)
        return T.shade(np.clip(c, 0, 1), N, top=0.16, shadow_tint="#6c7080")


def _rotz(deg):
    a = math.radians(deg)
    return np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1.0]])


def _rot(x=0.0, y=0.0, z=0.0):
    from .. import xform
    return xform.rot_deg(x, y, z)


# pile layouts: (x, y, z of the brick's centre above the ground, yaw, pitch, roll) in units / degrees
_HZ = BRICK_H[2]
PILES = {
    "small": [(-2.0, -4.0, _HZ, 8, 0, 0), (1.0, 4.2, _HZ, -5, 0, 0), (0.5, 0.0, 3 * _HZ, 84, 0, 0)],
    "medium": [(-1.0, -7.6, _HZ, 3, 0, 0), (0.5, 0.0, _HZ, -4, 0, 0), (-0.5, 7.6, _HZ, 6, 0, 0),
               (-3.0, -3.8, 3 * _HZ, 88, 0, 0), (4.5, 1.5, 3 * _HZ, 95, 0, 0), (11.5, -4.0, 5.0, -28, -28, 0)],
    "large": [(-4.5, -11.3, _HZ, 0, 0, 0), (-4.5, -3.8, _HZ, 2, 0, 0), (-4.0, 3.8, _HZ, -3, 0, 0),
              (-4.5, 11.3, _HZ, 1, 0, 0), (-4.0, -7.6, 3 * _HZ, 90, 0, 0), (3.5, -7.0, 3 * _HZ, 92, 0, 0),
              (-4.5, 4.5, 3 * _HZ, 88, 0, 0), (-2.0, -3.5, 5 * _HZ, 4, 0, 0), (-2.0, 3.8, 5 * _HZ, -3, 0, 0),
              (-1.0, 0.0, 7 * _HZ, 86, 0, 0), (11.0, 9.0, 5.6, 62, -30, 6)],
}


def _variant_bodypart(b, st, variants, name):
    """Rebuild the built model's geometry as ONE bodypart with a submodel per variant (lists of part names):
    the same atlases and skins, each submodel holding only its parts (the builder's own layout code)."""
    rig = b.rig
    rest_heads = np.array([bo.head for bo in rig.bones])
    group_names = [g for g in b.groups if any(p.group == g for p in b.parts)]
    by_name = {p.name: p for p in b.parts}
    models = []
    for vi, names in enumerate(variants):
        verts, vbone, norms, nbone = [], [], [], []
        mesh_tris = {g: [] for g in group_names}
        for pn in names:
            part = by_name[pn]
            v0 = len(verts)
            verts.extend(part.tri.verts - rest_heads[part.vbone])
            vbone.extend(part.vbone.tolist())
            nkey = {}
            F = part.tri.faces
            tri = np.zeros((len(F), 3, 4), dtype=np.int64)
            for f in range(len(F)):
                for k in range(3):
                    vi_ = int(F[f, k])
                    key = (int(part.corner_n[f, k]), int(part.vbone[vi_]))
                    if key not in nkey:
                        nkey[key] = len(norms)
                        norms.append(part.nrm[key[0]])
                        nbone.append(key[1])
                    tri[f, k] = (v0 + vi_, nkey[key], part.st[f, k, 0], part.st[f, k, 1])
            mesh_tris[part.group].append(tri)
        meshes = [mdl.Mesh(tris=np.concatenate(mesh_tris[g]), skinref=gi)
                  for gi, g in enumerate(group_names) if mesh_tris[g]]
        models.append(mdl.Model(name=f"{name}{vi}", verts=np.array(verts), vert_bone=np.array(vbone),
                                norms=np.array(norms), norm_bone=np.array(nbone), meshes=meshes))
    st.bodyparts = [mdl.BodyPart(name=name, models=models)]
    return st


def build_pile():
    rig = R.Rig()
    rig.add("pile", None, (0, 0, 0), tail=(0, 0, 8))
    b = builder.ModelBuilder("build/brick_pile.mdl", rig, skins=1, verbose=False)
    b.group("brick", size=(256, 256), pack="skyline")
    rng = np.random.default_rng(2101)
    variants = []
    for vname in PILE_BODIES:
        names = []
        # centre each pile on the origin (x, y)
        placed = []
        for x, y, z, yaw, pitch, roll in PILES[vname]:
            Rm = _rotz(yaw) @ _rot(y=pitch) @ _rot(x=roll)
            placed.append((Rm, np.array([x, y, z]), polys_mesh(brick_polys(BRICK_H, 0.55))))
        V = np.concatenate([m.verts @ Rm.T + t for Rm, t, m in placed])
        shift = np.array([-(V[:, 0].min() + V[:, 0].max()) / 2, -(V[:, 1].min() + V[:, 1].max()) / 2, 0.0])
        for i, (Rm, t0, m0) in enumerate(placed):
            t = t0 + shift
            m = m0.transformed(Rm, t)
            k = int(rng.choice(len(BRICKS), p=BRICK_W / BRICK_W.sum()))
            pn = f"{vname}{i}"
            b.add(builder.Part(pn, mesh=m, bone="pile", paint=LoosePaint(Rm, t, BRICK_H, k, 2200 + i), group="brick",
                               crease=30, hitbox=False))
            names.append(pn)
        variants.append(names)
    b.add_sequence(R.make_sequence(rig, "idle", lambda t: R.Pose(), frames=1, fps=10, loop=True,
                                   activity=mdl.ACT["IDLE"]))
    b.hitbox("pile", (-16, -16, 0), (16, 16, 16))
    b.hull = ((-16, -16, 0), (16, 16, 16))
    b.eyeposition = (0, 0, 4)
    st = b.build()
    st = _variant_bodypart(b, st, variants, "pile")
    data = mdl.write(st)
    mdl.read(data)
    return data, b


def _chunk(seed, h, planes):
    """A chamfered brick fractured by `planes` random cuts (each through the body, tilted)."""
    rng = np.random.default_rng(seed)
    polys = brick_polys(h, 0.4)
    for _ in range(planes):
        n = rng.normal(size=3)
        n /= np.linalg.norm(n)
        d = float(rng.uniform(0.15, 0.55)) * float(np.abs(n) @ np.asarray(h))
        polys = clip_convex(polys, n, d)
    m = polys_mesh(polys)
    c = (m.verts.min(0) + m.verts.max(0)) / 2
    return M.TriMesh(m.verts - c, m.faces), -c


def build_gibs():
    rig = R.Rig()
    rig.add("gib", None, (0, 0, 0), tail=(0, 0, 4))
    b = builder.ModelBuilder("build/gibs_brick.mdl", rig, skins=1, verbose=False)
    b.group("brick", size=(256, 256), pack="skyline")
    I3 = np.eye(3)
    items = []
    # whole brick
    items.append(("brick", polys_mesh(brick_polys(BRICK_H, 0.45)), np.zeros(3), BRICK_H, 0, 0.35, False))
    # half brick: the whole one cut across, rough end
    hp = clip_convex(brick_polys(BRICK_H, 0.45), (1, 0.15, 0.1), 0.2)
    m = polys_mesh(hp)
    c = (m.verts.min(0) + m.verts.max(0)) / 2
    items.append(("half", M.TriMesh(m.verts - c, m.faces), -c, BRICK_H, 2, 0.25, False))
    m, off = _chunk(2301, (4.0, 3.5, 2.5), 3)
    items.append(("chunk_a", m, off, (4.0, 3.5, 2.5), 1, 0.2, False))
    m, off = _chunk(2302, (3.2, 2.8, 2.5), 4)
    items.append(("chunk_b", m, off, (3.2, 2.8, 2.5), 3, 0.2, False))
    m, off = _chunk(2303, (2.6, 1.8, 0.8), 2)
    items.append(("shard", m, off, (2.6, 1.8, 0.8), 5, 0.0, False))
    m, off = _chunk(2304, (2.4, 1.9, 1.5), 2)
    items.append(("mortar", m, off, (2.4, 1.9, 1.5), -1, 0.0, False))
    m, off = _chunk(2305, (4.5, 3.5, 3.0), 3)
    items.append(("stone", m, off, (4.5, 3.5, 3.0), 0, 0.0, True))
    variants = []
    for i, (name, m, off, h, k, mort, stone) in enumerate(items):
        if name == "mortar":
            paint = (lambda off_: (lambda P, N, s: T.shade(MORTAR_C[None, :] * (0.85 + 0.15 * _vnoise3(P, 0.5, 2311))
                                                           [:, None], N, top=0.2)))(off)
        else:
            paint = LoosePaint(I3, off, h, max(k, 0), 2400 + i, mortar=mort, stone=stone)
        b.add(builder.Part(name, mesh=m, bone="gib", paint=paint, group="brick", crease=25, hitbox=False))
        variants.append([name])
    # two bricks still mortared together
    names = []
    for j, (z, yaw) in enumerate(((-2.9, 0.0), (2.9, 9.0))):
        Rm = _rotz(yaw)
        t = np.array([0.8 * j, 0.0, z])
        m = polys_mesh(brick_polys(BRICK_H, 0.45)).transformed(Rm, t)
        pn = f"pair{j}"
        b.add(builder.Part(pn, mesh=m, bone="gib", paint=LoosePaint(Rm, t, BRICK_H, 4 * j + 1, 2450 + j, mortar=0.3),
                           group="brick", crease=25, hitbox=False))
        names.append(pn)
    mo = box((-6.4, -3.2, -0.45), (6.9, 3.25, 0.45))
    b.add(builder.Part("pair_m", mesh=mo, bone="gib", group="brick", crease=25, hitbox=False,
                       paint=lambda P, N, s: T.shade(MORTAR_C[None, :] * (0.8 + 0.2 * _vnoise3(P, 0.4, 2460))[:, None],
                                                     N, top=0.1)))
    names.append("pair_m")
    variants.append(names)
    assert [v[0].rstrip("0") for v in variants] == [g if g != "pair" else "pair" for g in GIB_BODIES]
    b.add_sequence(R.make_sequence(rig, "idle", lambda t: R.Pose(), frames=1, fps=10, loop=True,
                                   activity=mdl.ACT["IDLE"]))
    b.hitbox("gib", (-7, -4, -5), (7, 4, 5))
    b.hull = ((-7, -4, -5), (7, 4, 5))
    st = b.build()
    st = _variant_bodypart(b, st, variants, "gibs")
    data = mdl.write(st)
    mdl.read(data)
    return data, b


# ---------------------------------------------------------------------------------------------
# piece pictograms (HUD icons and the tablet's screen): isometric solids
# ---------------------------------------------------------------------------------------------

def _iso(p, cx, cy, k):
    """Isometric projection (unit = one tile edge of 128): +x to the lower right, +y to the lower left, +z up."""
    x, y, z = p
    return (cx + (x - y) * 0.866 * k, cy + ((x + y) * 0.5 - z) * k)


def piece_faces(kind):
    """Visible faces [(polygon 3D points in tile units, shade 0..1, frame_lines)] of a piece, back to front.
    Wall along x on the tile's back edge, ramp rising towards -x (up and to the left on screen)."""
    out = []

    def boxf(lo, hi, top=1.0, left=0.72, right=0.52):
        (x0, y0, z0), (x1, y1, z1) = lo, hi
        out.append(([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], right))    # +x face
        out.append(([(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)], left))     # +y face
        out.append(([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], top))      # top
    if kind == "wall":
        boxf((-0.5, -0.04, 0.0), (0.5, 0.04, 1.0), top=0.95, left=0.80, right=0.55)
    elif kind == "floor":
        boxf((-0.5, -0.5, -0.04), (0.5, 0.5, 0.04), top=0.85, left=0.70, right=0.50)
    elif kind == "ramp":
        n = 4
        side = [(0.5, 0.5, 0.0)]
        for i in range(n):
            x1 = 0.5 - i / n
            side += [(x1, 0.5, (i + 1) / n), (x1 - 1 / n, 0.5, (i + 1) / n)]
        side += [(-0.5, 0.5, 1.0 - 0.16), (0.5 - 0.16, 0.5, 0.0)]
        out.append((side, 0.72))
        for i in reversed(range(n)):
            # stairs rising towards -x: step i from x 0.5 - (i+1)/n to 0.5 - i/n, its top at (i+1)/n
            x0, x1 = 0.5 - (i + 1) / n, 0.5 - i / n
            out.append(([(x1, -0.5, i / n), (x1, 0.5, i / n), (x1, 0.5, (i + 1) / n), (x1, -0.5, (i + 1) / n)], 0.55))
            out.append(([(x0, -0.5, (i + 1) / n), (x1, -0.5, (i + 1) / n), (x1, 0.5, (i + 1) / n),
                         (x0, 0.5, (i + 1) / n)], 0.95))
    elif kind == "roof":
        ap = (0.0, 0.0, 0.5)
        out.append(([(0.5, -0.5, 0), (0.5, 0.5, 0), ap], 0.55))
        out.append(([(-0.5, 0.5, 0), (0.5, 0.5, 0), ap], 0.85))
    return out


def _fit(kind, x0, y0, w, h, margin):
    """(cx, cy, k) placing the pictogram centred in the box (x0, y0, w, h)."""
    pts = np.array([_iso(p, 0.0, 0.0, 1.0) for poly, _ in piece_faces(kind) for p in poly])
    lo, hi = pts.min(0), pts.max(0)
    k = min((w - 2 * margin) / (hi[0] - lo[0]), (h - 2 * margin) / (hi[1] - lo[1]))
    return x0 + w / 2 - (lo[0] + hi[0]) / 2 * k, y0 + h / 2 - (lo[1] + hi[1]) / 2 * k, k


# frame lines drawn inside the main faces (the stone frame around the bricks), as insets of those faces
_FRAME_FACES = {"wall": (1,), "floor": (2,)}


def draw_piece(c, kind, x0, y0, w, h, margin=4.0, grey=230, line=None, outline=1.0, fill=True, frame=0.13,
               frame_line=None):
    """Draw a piece pictogram fitted in the box (x0, y0, w, h) of an icons.Canvas: shaded faces (grey levels),
    crisp darker edges, the frame's inner outline on walls and floors."""
    cx, cy, k = _fit(kind, x0, y0, w, h, margin)
    lc = line if line is not None else (int(grey * 0.32),) * 3 + (255,)
    for fi, (poly, sh) in enumerate(piece_faces(kind)):
        pts = [_iso(p, cx, cy, k) for p in poly]
        g = int(grey * sh)
        if fill:
            c.polygon(pts, fill=(g, g, g, 255))
        c.line(pts + [pts[0]], lc, width=outline)
        if fi in _FRAME_FACES.get(kind, ()):
            P3 = np.array(poly, dtype=np.float64)
            ctr = P3.mean(0)
            span = P3.max(0) - P3.min(0)
            inner = [tuple(ctr + (q - ctr) * np.where(span > 1e-6, 1 - 2 * frame / np.maximum(span, 1e-6), 1))
                     for q in P3]
            ip = [_iso(q, cx, cy, k) for q in inner]
            c.line(ip + [ip[0]], frame_line or lc, width=outline * 0.8)


def _brick_icon(c, cx, cy, s, grey=230):
    """Two stacked bricks, isometric (s = brick length in pixels)."""
    L, Wd, Hh = s, s * 0.5, s * 0.32

    def brick(ox, oy):
        def P(x, y, z):
            return (ox + (x - y) * 0.866, oy + (x + y) * 0.5 - z)
        top = [P(0, 0, Hh), P(L, 0, Hh), P(L, Wd, Hh), P(0, Wd, Hh)]
        front = [P(0, Wd, 0), P(L, Wd, 0), P(L, Wd, Hh), P(0, Wd, Hh)]
        side = [P(L, 0, 0), P(L, Wd, 0), P(L, Wd, Hh), P(L, 0, Hh)]
        dark = (int(grey * 0.30),) * 3 + (255,)
        for poly, sh in ((side, 0.55), (front, 0.78), (top, 1.0)):
            g = int(grey * sh)
            c.polygon(poly, fill=(g, g, g, 255))
            c.line(poly + [poly[0]], dark, width=max(0.8, s / 22))
    # centre the pair: the iso box spans x from -Wd*0.866 to L*0.866, y from -(Hh*2) to (L+Wd)*0.5
    w = (L + Wd) * 0.866
    h = (L + Wd) * 0.5 + 2 * Hh
    ox = cx - w / 2 + Wd * 0.866
    oy = cy - h / 2 + 2 * Hh
    brick(ox, oy + Hh * 0.05)
    brick(ox - s * 0.06, oy - Hh * 1.02)


HUD_W, HUD_H = 512, 64
HUD_RECTS = {"wall": (0, 0, 64, 64), "floor": (64, 0, 64, 64), "ramp": (128, 0, 64, 64), "roof": (192, 0, 64, 64),
             "brick": (256, 0, 48, 48), "brick_small": (304, 0, 24, 24), "slot": (336, 0, 64, 64),
             "deny": (400, 0, 48, 48)}
PIECES = ("wall", "floor", "ramp", "roof")


def make_hud():
    from .. import icons
    sheet = np.zeros((HUD_H, HUD_W, 3), dtype=np.float64)
    for kind in PIECES:
        x, y, w, h = HUD_RECTS[kind]
        c = icons.Canvas(w, h, ss=4, background=(0, 0, 0, 255))
        draw_piece(c, kind, 0, 0, w, h, margin=5.0, grey=235, outline=1.1)
        sheet[y:y + h, x:x + w] = c.additive_rgb()
    for kind, s in (("brick", 27.0), ("brick_small", 13.0)):
        x, y, w, h = HUD_RECTS[kind]
        c = icons.Canvas(w, h, ss=4, background=(0, 0, 0, 255))
        _brick_icon(c, w / 2, h / 2, s)
        sheet[y:y + h, x:x + w] = c.additive_rgb()
    x, y, w, h = HUD_RECTS["slot"]
    c = icons.Canvas(w, h, ss=4, background=(0, 0, 0, 255))
    c.rounded_rect(1.5, 1.5, w - 1.5, h - 1.5, 6, outline=(235, 235, 235, 255), width=2.0)
    c.rounded_rect(4.5, 4.5, w - 4.5, h - 4.5, 4, outline=(90, 90, 90, 255), width=1.0)
    sheet[y:y + h, x:x + w] = c.additive_rgb()
    x, y, w, h = HUD_RECTS["deny"]
    c = icons.Canvas(w, h, ss=4, background=(0, 0, 0, 255))
    c.circle(w / 2, h / 2, w / 2 - 4, outline=(235, 235, 235, 255), width=4.0)
    r = (w / 2 - 4) * 0.707
    c.line([(w / 2 - r, h / 2 + r), (w / 2 + r, h / 2 - r)], (235, 235, 235, 255), width=4.0)
    sheet[y:y + h, x:x + w] = c.additive_rgb()
    img = np.clip(sheet * 255.0 + 0.5, 0, 255).astype(np.uint8) if sheet.max() <= 1.0 else sheet.astype(np.uint8)
    return spr.make([img], type=spr.VP_PARALLEL, tex_format=spr.ADDITIVE), img


# ---------------------------------------------------------------------------------------------
# v_build: both gloved hands holding a blueprint tablet (design space: +x forward, +y left, +z up, eye at 0;
# the right hand on the right, mirrored for the file like every view model, balls.py)
# ---------------------------------------------------------------------------------------------

TAB_HALF = (5.6, 3.7, 0.32)        # tablet half sizes along (tx right, ty up the screen, tz out of the screen)
TAB_CENTER = np.array([14.0, 0.0, -6.2])
TAB_TILT = 42.0                    # the screen leans back (top away from the eye)
SCREEN_HALF = (5.0, 3.15)
V_FPS = 30
TABLET_BODY = T.rgb("#2c3036")
TABLET_EDGE = T.rgb("#4a5058")
BUMPER = T.rgb("#d0682e")


def tablet_frame():
    a = math.radians(TAB_TILT)
    ty = np.array([math.sin(a), 0.0, math.cos(a)])
    tz = np.array([-math.cos(a), 0.0, math.sin(a)])
    tx = np.cross(ty, tz)
    return np.stack([tx, ty, tz], axis=1)          # tablet -> view


def _two_bone(a, target, l1, l2, pole):
    """Middle joint of a two-bone chain from a to target (bending towards pole)."""
    a, target, pole = (np.asarray(v, dtype=np.float64) for v in (a, target, pole))
    d = target - a
    L = float(np.linalg.norm(d))
    L = min(max(L, abs(l1 - l2) + 1e-3), l1 + l2 - 1e-3)
    d = d / np.linalg.norm(d)
    x = (l1 * l1 - l2 * l2 + L * L) / (2 * L)
    hgt = math.sqrt(max(l1 * l1 - x * x, 0.0))
    pp = pole - d * (pole @ d)
    pp = pp / np.linalg.norm(pp)
    return a + d * x + pp * hgt, a + d * L


def grip_layout(Q, W, Tm, Tc):
    """Joints (in H) of the right hand holding the tablet's right edge from behind: fingers flat on the back,
    spread up and inwards, the thumb around the edge onto the bezel."""
    from . import balls as B
    out = {}
    z = np.array([0.0, 0.0, 1.0])
    flex = {"index": (2, 5, 3), "middle": (3, 6, 3), "ring": (4, 7, 4), "pinky": (5, 9, 6)}
    for name, mcp, splay, lens, rads in B.FINGERS:
        d = xform_rot(z, splay * 1.25) @ np.array([1.0, 0.0, 0.0])
        p = np.asarray(mcp, dtype=np.float64)
        joints = [p.copy()]
        for L, fl in zip(lens, flex[name]):
            ax = np.cross(z, d)
            ax /= np.linalg.norm(ax)
            d = xform_rot(ax, fl) @ d
            p = p + L * d
            joints.append(p.copy())
        out[name] = joints
    # the thumb: its tip on the bezel near the right edge, the IP joint just outside the edge, in front
    tx, ty, tz = Tm[:, 0], Tm[:, 1], Tm[:, 2]
    mcp_v = Q @ np.asarray(B.THUMB_MCP) + W
    tip_v = Tc + tx * (TAB_HALF[0] - 1.7) - ty * 0.9 + tz * (TAB_HALF[2] + 0.30)
    ip_v, tip_v = _two_bone(mcp_v, tip_v, B.THUMB_LEN[0], B.THUMB_LEN[1], tx * 0.5 + tz * 2.0)
    out["thumb"] = [np.asarray(B.THUMB_CMC, dtype=np.float64), np.asarray(B.THUMB_MCP, dtype=np.float64),
                    Q.T @ (ip_v - W), Q.T @ (tip_v - W)]
    return out


def xform_rot(axis, deg):
    from .. import xform
    return xform.axis_angle_matrix(axis, deg)


class VBuild:
    """The tablet and both hands in design space, and the rig."""

    def __init__(self):
        from . import balls as B
        from . import laptop as LP
        self.Tm = tablet_frame()
        self.Tc = TAB_CENTER.copy()
        tx, ty, tz = self.Tm[:, 0], self.Tm[:, 1], self.Tm[:, 2]
        x_h = -tx * 0.86 + ty * 0.51
        Q = B.frame_from(x_h, -tz)
        # the palm on the tablet's back, its middle just outside the right edge, low on the edge
        palm_c = np.array([1.7, 0.0, -0.52])
        target = self.Tc + tx * (TAB_HALF[0] - 0.65) - ty * 1.0 - tz * TAB_HALF[2]
        W = target - Q @ palm_c
        u = np.array([0.42, 0.50, 0.76])
        L = LP.HandLayout.__new__(LP.HandLayout)
        L.Q, L.W = Q, W
        L.lay = grip_layout(Q, W, self.Tm, self.Tc)
        L.u = u / np.linalg.norm(u)
        L.E = L.W - 11.5 * L.u
        yA = L.Q @ np.array([0.0, 1.0, 0.0])
        yA = yA - L.u * (yA @ L.u)
        yA /= np.linalg.norm(yA)
        L.A = np.stack([L.u, yA, np.cross(L.u, yA)], axis=1)
        L.ball_c = self.Tc + tz * 1.5        # what the palm faces (palmar paint)
        self.Lr = L
        self.Ll = LP.mirror_layout(L)
        self.right = LP.Hand(self.Lr, "r_")
        self.left = LP.Hand(self.Ll, "l_")
        rig = R.Rig()
        rig.add("root", None, (0, 0, 0))
        rig.add("tablet", "root", self.Tc, tail=self.Tc + ty * 3)
        rig.add("flash", "tablet", self.Tc + tz * 0.2, tail=None)
        self.right.add_bones(rig, "tablet")
        self.left.add_bones(rig, "tablet")
        self.rig = rig

    def mirrored_rig(self):
        rig = R.Rig()
        for b in self.rig.bones:
            h = b.head * np.array([1, -1, 1])
            t = None if b.tail is None else b.tail * np.array([1, -1, 1])
            rig.add(b.name, None if b.parent < 0 else self.rig.bones[b.parent].name, h, tail=t)
        return rig

    def to_tab(self, P):
        return (P - self.Tc) @ self.Tm

    def pose(self, st):
        """st: tablet_dW (view offset), tablet_rot (axis, deg about its centre), flash (bool), right / left
        (laptop.Hand keys; the left one in mirrored terms)."""
        p = R.Pose()
        Rt = xform_rot(*st["tablet_rot"]) if st.get("tablet_rot") else np.eye(3)
        from .. import xform
        p.set_rot("tablet", *np.degrees(xform.matrix_euler(Rt)))
        p.move("tablet", *np.asarray(st.get("tablet_dW", (0, 0, 0)), dtype=np.float64))
        if not st.get("flash"):
            p.move("flash", *(-0.6 * self.Tm[:, 2]))       # parked inside the tablet
        self.right.pose(p, st.get("right", {}))
        self.left.pose(p, st.get("left", {}))
        return p


def tablet_mesh():
    """Rounded slab in the tablet frame (built by clipping a box: chamfered corners and edges)."""
    polys = _box_polys(TAB_HALF)
    hx, hy, hz = TAB_HALF
    for sx in (-1, 1):
        for sy in (-1, 1):
            for cut, w in ((1.0, 0.55), (0.41, 0.98), (2.41, 0.98)):
                # three planes round each corner seen from the front (an octagon-ish rounded corner)
                n = np.array([sx * 1.0, sy * cut, 0.0])
                n /= np.linalg.norm(n)
                corner = np.array([sx * hx, sy * hy, 0.0])
                polys = clip_convex(polys, n, float(n @ corner) - w * 0.62)
    for ax in (0, 1):
        for sa in (-1, 1):
            for sz in (-1, 1):
                n = np.zeros(3)
                n[ax], n[2] = sa, sz
                n /= np.linalg.norm(n)
                c = np.zeros(3)
                c[ax], c[2] = sa * TAB_HALF[ax], sz * hz
                polys = clip_convex(polys, n, float(n @ c) - 0.14)
    return polys_mesh(polys)


def screen_image(kind, red=False, w=320, h=200):
    """The tablet's screen (additive): a blueprint grid, the piece pictogram drawn in light lines, corner marks."""
    from .. import icons
    c = icons.Canvas(w, h, ss=3, background=(6, 18, 40, 255))
    for i in range(0, w + 1, 20):
        c.line([(i, 0), (i, h)], (24, 60, 110, 255), width=1.0)
    for j in range(0, h + 1, 20):
        c.line([(0, j), (w, j)], (24, 60, 110, 255), width=1.0)
    for i in range(0, w + 1, 100):
        c.line([(i, 0), (i, h)], (40, 95, 160, 255), width=1.6)
    draw_piece(c, kind, w * 0.18, h * 0.08, w * 0.64, h * 0.84, margin=6, grey=150, fill=True,
               line=(170, 235, 255, 255), outline=3.0, frame_line=(150, 220, 255, 255))
    # corner brackets
    L_ = 22
    for (x, y, dx, dy) in ((8, 8, 1, 1), (w - 8, 8, -1, 1), (8, h - 8, 1, -1), (w - 8, h - 8, -1, -1)):
        c.line([(x, y + dy * L_), (x, y), (x + dx * L_, y)], (120, 200, 255, 255), width=2.4)
    img = c.rgba()[..., :3].astype(np.float64) / 255.0
    # tint the pictogram's grey faces blue
    g = img.mean(axis=2, keepdims=True)
    blue = np.array([0.30, 0.62, 1.0])[None, None, :]
    img = np.where((np.abs(img - g) < 0.02).all(axis=2, keepdims=True) & (g > 0.2), g * blue * 1.3, img)
    return np.clip(img, 0, 1)


def _sample_img(img, u, v):
    """Bilinear sample of img (H, W, 3) at u, v in [0, 1] (u right, v down)."""
    H, Wd = img.shape[:2]
    x = np.clip(u, 0, 1) * Wd - 0.5
    y = np.clip(v, 0, 1) * H - 0.5
    x0 = np.clip(np.floor(x).astype(np.int64), 0, Wd - 2)
    y0 = np.clip(np.floor(y).astype(np.int64), 0, H - 2)
    fx = np.clip(x - x0, 0, 1)[:, None]
    fy = np.clip(y - y0, 0, 1)[:, None]
    return ((1 - fx) * (1 - fy) * img[y0, x0] + fx * (1 - fy) * img[y0, x0 + 1] + (1 - fx) * fy * img[y0 + 1, x0]
            + fx * fy * img[y0 + 1, x0 + 1])


def v_sequences(vm):
    """[(name, pose_fn(t), frames, fps, loop)], design space."""
    tz = vm.Tm[:, 2]
    yv = np.array([0.0, 1.0, 0.0])
    from . import laptop as LP

    def both(kr, kl=None):
        return {"right": kr, "left": LP.mirror_key(kr if kl is None else kl)}

    def idle(t):
        st = both({"f_thumb": (2.0 * R.wave(t, phase=0.2), 1.5 * R.wave(t, phase=0.3))},
                  {"f_thumb": (2.0 * R.wave(t, phase=0.6), 1.5 * R.wave(t, phase=0.7))})
        st["tablet_dW"] = np.array([0.05 * R.wave(t, phase=0.3), 0.04 * R.wave(t, phase=0.1), 0.14 * R.breathe(t)])
        st["tablet_rot"] = (yv, 0.8 * R.wave(t, phase=0.45))
        return vm.pose(st)

    LOW = np.array([-3.0, 0.0, -15.0])

    def draw(t):
        e = R.ease_out_back(min(max(t / 0.85, 0.0), 1.0)) if t > 0 else 0.0
        st = both({"f_thumb": (-12.0 * (1 - e), -10.0 * (1 - e))})
        st["tablet_dW"] = LOW * (1 - e)
        st["tablet_rot"] = (yv, 32.0 * (1 - e))
        return vm.pose(st)

    def holster(t):
        e = R.smoothstep(t)
        st = both({"f_thumb": (-12.0 * e, -10.0 * e)})
        st["tablet_dW"] = LOW * e
        st["tablet_rot"] = (yv, 32.0 * e)
        return vm.pose(st)

    # place (0.4 s): the right thumb lifts (f0-3), taps the screen (f4), the screen flashes (f4-7), the tablet
    # takes a little push forward and settles
    PL = 12

    def place(t):
        f = t * (PL - 1)
        lift = R.keys(f, [(0, 0.0), (2.5, 1.0), (4.0, -0.35), (6.5, 0.0), (PL - 1, 0.0)], interp="smooth")
        kr = {"f_thumb": (-16.0 * lift, -14.0 * lift), "dW": tz * 0.5 * max(lift, 0)}
        st = both(kr, {"f_thumb": (2.0 * max(-lift, 0), 2.0 * max(-lift, 0))})
        push = R.keys(f, [(0, 0.0), (3.5, 0.0), (5.0, 1.0), (8.0, -0.2), (PL - 1, 0.0)], interp="smooth")
        st["tablet_dW"] = np.array([0.9, 0.0, -0.25]) * push
        st["tablet_rot"] = (yv, -2.0 * push)
        st["flash"] = 4 <= round(f) <= 7
        return vm.pose(st)

    # rotate (0.4 s): the right thumb swipes across the screen's corner, the tablet rolls a little
    RT = 12

    def rotate(t):
        f = t * (RT - 1)
        sw = R.keys(f, [(0, 0.0), (3.0, 1.0), (7.0, -1.0), (RT - 1, 0.0)], interp="smooth")
        lift = R.keys(f, [(0, 0.0), (2.0, 0.6), (3.0, 0.0), (7.0, 0.0), (9.0, 0.5), (RT - 1, 0.0)], interp="smooth")
        kr = {"f_thumb": (-10.0 * lift + 8.0 * sw, -6.0 * lift - 6.0 * sw)}
        st = both(kr)
        st["tablet_rot"] = (vm.Tm[:, 2], 4.0 * R.keys(f, [(0, 0.0), (5.0, 1.0), (RT - 1, 0.0)], interp="smooth"))
        return vm.pose(st)

    return [("idle", idle, 60, V_FPS, True),
            ("draw", draw, 16, V_FPS, False),
            ("place", place, PL, V_FPS, False),
            ("holster", holster, 12, V_FPS, False),
            ("rotate", rotate, RT, V_FPS, False)]


def build_v(mirror=True, name="build/v_build.mdl"):
    from . import balls as B
    from . import laptop as LP
    vm = VBuild()
    rig = vm.mirrored_rig() if mirror else vm.rig
    flipv = np.array([1.0, -1.0, 1.0])

    def shape(s_):
        return s_.flip(1) if mirror else s_

    def unmirror(fn):
        if not mirror:
            return fn

        def h(P, N, skin):
            return fn(P * flipv, N * flipv, skin)
        return h

    def mesh(m):
        return B.flip_mesh(m) if mirror else m

    Tm, Tc = vm.Tm, vm.Tc
    tab_local = tablet_mesh()
    tab = M.TriMesh(tab_local.verts @ Tm.T + Tc, tab_local.faces)
    hr, hl = vm.right.shapes(), vm.left.shapes()
    from .. import sdf
    tab_occ = sdf.SDF(lambda P: _box_sdf((P - Tc) @ Tm, TAB_HALF), Tc - 7, Tc + 7)
    occ = sdf.union(tab_occ, *[hr[k] for k in ("palm", "thumb", "gcuff", "sleeve")],
                    *[hr[n] for n in LP.FINGER_NAMES], *[hl[k] for k in ("palm", "thumb", "gcuff", "sleeve")],
                    *[hl[n] for n in LP.FINGER_NAMES])
    apr = B.ArmPaint(vm.Lr, occ, vm.right.joints, vm.right.joints["thumb"][1:])
    apl = B.ArmPaint(vm.Ll, occ, vm.left.joints, vm.left.joints["thumb"][1:])

    def tablet_paint(P, N, skin):
        q = vm.to_tab(P)
        nq = N @ Tm
        c = np.tile(TABLET_BODY, (len(P), 1)) * (1 + 0.04 * _vnoise3(P, 0.25, 3001))[:, None]
        # bezel front: a thin lighter rim; rubber bumpers on the corners (orange, builder-like)
        front = nq[:, 2] > 0.6
        rim = np.minimum(TAB_HALF[0] - np.abs(q[:, 0]), TAB_HALF[1] - np.abs(q[:, 1]))
        c = T.mix(c, TABLET_EDGE, (np.exp(-np.maximum(rim, 0) / 0.18) * 0.8)[:, None])
        corner = (np.abs(q[:, 0]) > TAB_HALF[0] - 1.25) & (np.abs(q[:, 1]) > TAB_HALF[1] - 1.25)
        c = np.where(corner[:, None], BUMPER * (0.9 + 0.1 * _vnoise3(P, 0.3, 3003))[:, None], c)
        # the back: a raised brick logo panel (orange) in the middle
        back = nq[:, 2] < -0.6
        logo = back & (np.abs(q[:, 0]) < 2.2) & (np.abs(q[:, 1]) < 1.0)
        c = np.where(logo[:, None], BUMPER * 0.8, c)
        c = np.where((front & ~corner)[:, None], c * 0.85, c)
        ao = T.ambient_occlusion(occ, P, N, dist=0.6, steps=3)
        return T.shade(c, N, ao=ao, ao_strength=0.7, top=0.15, shadow_tint="#70788a")

    imgs = {k: screen_image(kind) for k, kind in enumerate(PIECES)}

    def screen_paint(P, N, skin):
        q = vm.to_tab(P)
        u = (q[:, 0] + SCREEN_HALF[0]) / (2 * SCREEN_HALF[0])
        v = (SCREEN_HALF[1] - q[:, 1]) / (2 * SCREEN_HALF[1])
        return _sample_img(imgs[skin], u, v)

    def flash_paint(P, N, skin):
        q = vm.to_tab(P)
        r = np.hypot(q[:, 0] / SCREEN_HALF[0], q[:, 1] / SCREEN_HALF[1])
        a = np.clip(1.0 - 0.55 * r * r, 0, 1) * _sstep(0.0, 0.5, np.minimum(SCREEN_HALF[0] - np.abs(q[:, 0]),
                                                                           SCREEN_HALF[1] - np.abs(q[:, 1])))
        return np.clip(np.array([0.55, 0.85, 1.0])[None, :] * a[:, None], 0, 1)

    def quad_tab(hx, hy, z):
        loc = np.array([[-hx, -hy, z], [hx, -hy, z], [hx, hy, z], [-hx, hy, z]])
        v = loc @ Tm.T + Tc
        return M.TriMesh(v, np.array([[0, 1, 2], [0, 2, 3]]))

    b = builder.ModelBuilder(name, rig, skins=4, verbose=False)
    b.group("tablet", size=(256, 256), pack="skyline")
    b.group("arm", size=(512, 512), pack="skyline")
    add = mdl.STUDIO_NF_ADDITIVE | mdl.STUDIO_NF_FULLBRIGHT
    b.group("screen", size=(256, 160), flags=add, pack="skyline")
    b.group("flash", size=(64, 64), flags=add, pack="skyline")
    memo = LP._memo
    b.add(builder.Part("tablet", mesh=mesh(tab), bone="tablet", paint=unmirror(memo(tablet_paint)), group="tablet",
                       crease=40))
    b.add(builder.Part("screen", mesh=mesh(quad_tab(SCREEN_HALF[0], SCREEN_HALF[1], TAB_HALF[2] + 0.01)), bone="tablet",
                       paint=unmirror(screen_paint), group="screen", hitbox=False))
    b.add(builder.Part("flash", mesh=mesh(quad_tab(SCREEN_HALF[0] - 0.1, SCREEN_HALF[1] - 0.1, TAB_HALF[2] + 0.04)),
                       bone="flash", paint=unmirror(memo(flash_paint)), group="flash", hitbox=False))
    for side, hs, ap in (("r_", hr, apr), ("l_", hl, apl)):
        def P_(n, shp, **kw):
            paint = kw.pop("paint")
            b.add(builder.Part(n, shape(shp), paint=unmirror(memo(paint)), group="arm", **kw))
        P_(side + "sleeve", hs["sleeve"], bone=side + "arm", paint=ap.sleeve, budget=620, density=0.55)
        P_(side + "gcuff", hs["gcuff"], bone=side + "arm", paint=ap.cuff, budget=200, density=0.6)
        P_(side + "palm", hs["palm"], bone=side + "hand", paint=ap.palm, budget=600, density=1.3)
        P_(side + "guard", hs["guard"], bone=side + "hand", paint=ap.guard, budget=140, density=1.1)
        for n in LP.FINGER_NAMES:
            P_(side + n, hs[n], bones=[side + n + "1", side + n + "2"], paint=ap.finger(n), budget=170, density=1.3)
        P_(side + "thumb", hs["thumb"], bones=[side + "thumb1", side + "thumb2"], paint=ap.thumb, budget=170,
           density=1.3)
    for s_name, fn, frames, fps, loop in v_sequences(vm):
        pf = (lambda f: (lambda t: B.mirror_pose(f(t))))(fn) if mirror else fn
        b.add_sequence(R.make_sequence(rig, s_name, pf, frames=frames, fps=fps, loop=loop))
    b.eyeposition = (0, 0, 0)
    data = b.write()
    return data, b


def _box_sdf(q, h):
    d = np.abs(q) - np.asarray(h)
    return np.linalg.norm(np.maximum(d, 0), axis=1) + np.minimum(np.max(d, axis=1), 0)


# ---------------------------------------------------------------------------------------------
# sounds (sound/build/): bricks are fired clay, struck: short noisy attacks over a few damped ceramic modes
# ---------------------------------------------------------------------------------------------

def _clack(rng, pitch=1.0, dur=0.09, bright=1.0):
    """One brick knocking on brick: a noise click and three damped modes (fired clay rings briefly)."""
    n = W._n(dur)
    t = np.arange(n) / W.RATE
    click = W.bandpass(W.noise(dur, "white", int(rng.integers(1 << 30))), 2600 * pitch * bright, q=1.2)
    click = click * np.exp(-t / 0.006)
    modes = np.zeros(n)
    for f, d, g in ((1150, 0.030, 1.0), (2350, 0.020, 0.6), (3900, 0.012, 0.35)):
        ff = f * pitch * rng.uniform(0.93, 1.07)
        modes += g * np.sin(2 * np.pi * ff * t + rng.uniform(0, 6.28)) * np.exp(-t / d)
    return click * 1.2 + modes * 0.55


def _thud(dur=0.25, f0=130.0, f1=55.0, seed=1, gain=1.0):
    n = W._n(dur)
    body = W.osc(W.glide(f0, f1, dur), shape="sine") * W.env_exp(n, decay=dur * 0.28, attack=0.002)
    rumble = W.lowpass(W.noise(dur, "brown", seed), 380) * W.env_exp(n, decay=dur * 0.35, attack=0.003)
    return gain * (body + 0.8 * rumble)


def _grit(dur, seed, density=200.0, lo=900, hi=4200, decay=None):
    """Falling grit and small chips: sparse grains of band-limited noise, thinning out."""
    rng = np.random.default_rng(seed)
    n = W._n(dur)
    out = np.zeros(n)
    times = np.sort(rng.uniform(0, dur, int(density * dur)))
    for tt in times:
        g = W._n(rng.uniform(0.003, 0.012))
        if g < 8:
            continue
        s0 = W._n(tt)
        e = min(n, s0 + g)
        grain = rng.standard_normal(e - s0) * np.hanning(e - s0) * rng.uniform(0.2, 1.0)
        out[s0:e] += grain
    out = W.highpass(W.lowpass(out, hi), lo)
    if decay:
        out *= np.exp(-np.arange(n) / W.RATE / decay)
    return out


def snd_pickup():
    rng = np.random.default_rng(3101)
    parts = [(_clack(rng, 1.0), 0.0, 0.9), (_clack(rng, 1.12), 0.045, 0.75), (_clack(rng, 0.92), 0.085, 0.6)]
    pop = W.osc(W.glide(520, 980, 0.07), shape="sine") * W.env_exp(W._n(0.07), decay=0.03, attack=0.004)
    parts += [(pop, 0.0, 0.35), (_thud(0.12, 160, 90, 3102), 0.0, 0.35)]
    return W.finish(W.reverb(W.mix(*parts), room=0.25, wet=0.12, tail=0.15), peak=0.8)


def snd_place():
    rng = np.random.default_rng(3201)
    parts = [(_thud(0.28, 150, 60, 3202), 0.0, 1.0), (_clack(rng, 0.85, 0.12), 0.0, 0.8),
             (_clack(rng, 1.05), 0.03, 0.5), (_clack(rng, 0.95), 0.07, 0.35)]
    knock = W.osc(W.glide(260, 190, 0.08), shape="triangle") * W.env_exp(W._n(0.08), decay=0.025)
    parts.append((knock, 0.0, 0.5))
    parts.append((_grit(0.25, 3203, density=120, decay=0.08), 0.02, 0.25))
    return W.finish(W.reverb(W.mix(*parts), room=0.35, wet=0.15, tail=0.2), peak=0.88)


def snd_build_loop():
    """The piece growing (0.45 s, one shot): bricks clinking into place faster and higher, a firm last one."""
    rng = np.random.default_rng(3301)
    parts = []
    t = 0.0
    while t < 0.36:
        parts.append((_clack(rng, 0.85 + 0.5 * t / 0.36, 0.06), t, 0.45 + 0.4 * t / 0.36))
        t += 0.045 - 0.022 * t / 0.36 + rng.uniform(-0.004, 0.004)
    parts.append((_clack(rng, 1.0, 0.12), 0.39, 1.0))
    parts.append((_thud(0.12, 170, 100, 3302), 0.39, 0.4))
    parts.append((_grit(0.42, 3303, density=160), 0.0, 0.15))
    return W.finish(W.mix(*parts), peak=0.75, fade_out=0.02)


def snd_hit(i):
    rng = np.random.default_rng(3400 + i)
    pitch = (1.0, 0.9, 1.12)[i]
    burst = W.bandpass(W.noise(0.05, "white", 3410 + i), 2200 * pitch, q=0.9) * W.env_exp(W._n(0.05), decay=0.008)
    parts = [(burst, 0.0, 1.0), (_clack(rng, pitch, 0.1), 0.0, 0.8), (_thud(0.14, 140, 80, 3420 + i), 0.0, 0.35),
             (_grit(0.22, 3430 + i, density=150, decay=0.07), 0.01, 0.35)]
    return W.finish(W.mix(*parts), peak=0.85, fade_out=0.04)


def snd_break(i):
    rng = np.random.default_rng(3500 + i)
    dur = (1.25, 1.1)[i]
    parts = [(_thud(0.55, 110 - 15 * i, 40, 3510 + i, 1.0), 0.0, 1.0),
             (W.bandpass(W.noise(0.08, "white", 3515 + i), 1800, q=0.8) * W.env_exp(W._n(0.08), decay=0.015), 0.0, 0.9),
             (_grit(dur, 3520 + i, density=380, lo=600, hi=5200, decay=dur * 0.35), 0.02, 0.6)]
    # bricks tumbling down: clacks thinning out, quieter and lower as they settle
    t = 0.04
    while t < dur - 0.15:
        g = math.exp(-t / (dur * 0.4))
        parts.append((_clack(rng, rng.uniform(0.7, 1.15), 0.09), t, 0.75 * g + 0.08))
        t += rng.uniform(0.018, 0.05) / max(g, 0.25)
    parts.append((_thud(0.3, 90, 45, 3530 + i, 0.6), 0.32 + 0.1 * i, 0.5))
    return W.finish(W.reverb(W.mix(*parts), room=0.5, wet=0.18, tail=0.35), peak=0.9, fade_out=0.15)


def snd_deny():
    beep = W.lowpass(W.osc(185, 0.09, shape="square"), 1400) * W.env_points([(0, 0), (0.006, 1), (0.07, 0.8), (0.09, 0)],
                                                                            W._n(0.09))
    return W.finish(W.mix((beep, 0.0, 1.0), (beep, 0.13, 0.9)), peak=0.6, fade_out=0.01)


def snd_select():
    n = W._n(0.05)
    tick = W.osc(1900, 0.05, shape="sine") * W.env_exp(n, decay=0.008, attack=0.001)
    tick += 0.5 * W.osc(3800, 0.05, shape="sine") * W.env_exp(n, decay=0.004, attack=0.001)
    return W.finish(tick, peak=0.45, fade_out=0.005)


def snd_toggle():
    a = W.osc(W.glide(700, 1100, 0.07), shape="triangle") * W.env_exp(W._n(0.07), decay=0.04, attack=0.003)
    b = W.osc(W.glide(1100, 1500, 0.09), shape="triangle") * W.env_exp(W._n(0.09), decay=0.05, attack=0.003)
    return W.finish(W.reverb(W.mix((a, 0.0, 0.8), (b, 0.06, 0.8)), room=0.2, wet=0.15, tail=0.1), peak=0.5)


def sounds():
    out = {"sound/build/pickup.wav": snd_pickup(), "sound/build/place.wav": snd_place(),
           "sound/build/build_loop.wav": snd_build_loop(), "sound/build/deny.wav": snd_deny(),
           "sound/build/select.wav": snd_select(), "sound/build/toggle.wav": snd_toggle()}
    for i in range(3):
        out[f"sound/build/hit{i + 1}.wav"] = snd_hit(i)
    for i in range(2):
        out[f"sound/build/break{i + 1}.wav"] = snd_break(i)
    return {k: W.write(v) for k, v in out.items()}


def build(out):
    out["models/build/wall.mdl"] = build_wall()[0]
    out["models/build/floor.mdl"] = build_floor()[0]
    out["models/build/ramp.mdl"] = build_ramp()[0]
    out["models/build/roof.mdl"] = build_roof()[0]
    out["models/build/brick_pile.mdl"] = build_pile()[0]
    out["models/build/gibs_brick.mdl"] = build_gibs()[0]
    out["models/build/v_build.mdl"] = build_v()[0]
    out["sprites/build/hud.spr"] = make_hud()[0]
    out.update(sounds())
