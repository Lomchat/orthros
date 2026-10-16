"""Le M's laptop (Half Strike r9): models/others/v_laptop.mdl, p_laptop.mdl, w_laptop.mdl, the Matrix effect
sprites and every sound of the laptop and of Le M.  All generated here, deterministically.

The laptop: a thin dark graphite machine, a backlit keyboard (green legends, a green glow between the keys and
around the keyboard's edge), a ">_" mark on the lid.  The view model holds it open in front, both gloved hands
(the Poke Ball view model's hands, sleeves and paint, balls.py) on the home row.

v_laptop sequences (30 fps): 0 idle (2 s loop, lazy taps), 1 draw (comes up closed, the lid springs open, the
hands land on the keys), 2 type (1.2 s loop, both hands typing fast), 3 deploy (the right hand lifts and slams
Enter at frame 8, the screen flashes white-green, a "COMPILING LE M" panel fills its progress bar, "LE M ONLINE"),
4 holster.  idle, type and deploy start on the same rest pose, so idle -> type -> deploy never jumps.

The screen (green code on black) animates by SKINS, the client cycling them at 12 Hz while the laptop is in hand
(cl_dll, DEVIATIONS.md): SCREEN_SKINS skins differ only by two small screen textures, the line being typed at the
bottom of the code (two lines typed character by character, then cleared) and a Matrix code-rain panel on the
right (columns of falling mirrored katakana and digits, periodic over the cycle).  The rest of the screen (title
bar, the code, line numbers, status bar) is one shared texture, every other texture is shared by all skins (the
builder stores identical textures once).  The Enter flash and the compiling panel are bone-driven quads in the
deploy sequence, hidden inside the lid otherwise (no client code involved).

Effects (sprites/others/): coderain.spr (falling code columns, upright, 64x256, 12 frames played once),
codebeam.spr (Hack beam: glyph lanes along the beam, tileable, 64x256, 8 frames), pixels.spr (square pixel bits,
32x32, 8 frames, each stands alone), glitch.spr (glitch flicker: shifted slices and RGB blocks, 64x64, 8 frames).
holo_paint(): the hologram grid paint the Le M model may use for its wireframe skin.
Sounds (sound/others/): laptop_type, laptop_enter, lem_materialize, lem_glitch, lem_hack, lem_hurt, lem_die.
"""
import math
import re

import numpy as np

from .. import builder, mdl, mesh as M, rig as R, sdf, spr, texture as T, wav as W, xform
from . import _glyphs as G
from . import balls as B
from . import fx as FX

# ---------------------------------------------------------------------------------------------
# palette
# ---------------------------------------------------------------------------------------------

GRAPHITE = T.rgb("#2b2e33")
GRAPHITE_DARK = T.rgb("#1d1f23")
GRAPHITE_EDGE = T.rgb("#4a4f57")
KEYCAP = T.rgb("#17181b")
BEZEL = T.rgb("#0e0f11")
GLASS = T.rgb("#040605")
GREEN = np.array([0.20, 1.00, 0.42])
GREEN_HOT = np.array([0.80, 1.00, 0.86])

SCREEN_SKINS = 24          # code frames, cycled by the client at 12 Hz (a 2 s loop)
FPS = 30


def _sstep(e0, e1, x):
    return T._sstep(e0, e1, x)


# ---------------------------------------------------------------------------------------------
# text: pixel-font images
# ---------------------------------------------------------------------------------------------

CELL_W, CELL_H = 6, 10     # character cell in glyph pixels (5x8 glyph, 1 px and 2 px gaps)

KEYWORDS = {"import", "from", "as", "def", "for", "in", "return", "if", "not", "and", "or", "True", "None"}
COL_KW = np.array([0.62, 1.00, 0.74])
COL_ID = np.array([0.16, 0.92, 0.36])
COL_STR = np.array([0.50, 1.00, 0.46])
COL_NUM = np.array([0.36, 1.00, 0.58])
COL_PUN = np.array([0.10, 0.62, 0.26])
COL_COM = np.array([0.07, 0.42, 0.18])
COL_DIM = np.array([0.06, 0.34, 0.14])


def highlight(line):
    """Per-character colours of a line of Python-like code (keywords, identifiers, strings, numbers, comments)."""
    cols = [COL_ID] * len(line)
    for m in re.finditer(r"#.*$|'[^']*'|\"[^\"]*\"|\b\d+\b|\b[A-Za-z_]\w*\b|[^\sA-Za-z_0-9]", line):
        s = m.group(0)
        if s.startswith("#"):
            c = COL_COM
        elif s[0] in "'\"":
            c = COL_STR
        elif s[0].isdigit():
            c = COL_NUM
        elif s in KEYWORDS:
            c = COL_KW
        elif s[0].isalpha() or s[0] == "_":
            c = COL_ID if not s.isupper() else COL_NUM
        else:
            c = COL_PUN
        for i in range(m.start(), m.end()):
            cols[i] = c
    return cols


def draw_text(img, x, y, text, colour, scale=1):
    """Draw text into an (H, W, 3) glyph-pixel image (additive max), top-left of the first cell at (x, y)."""
    H, Wd = img.shape[:2]
    cols = colour if isinstance(colour, list) else [np.asarray(colour)] * len(text)
    for i, ch in enumerate(text):
        g = G.glyph(ch)
        if scale != 1:
            g = np.repeat(np.repeat(g, scale, 0), scale, 1)
        gx = x + i * CELL_W * scale
        ys, xs = np.nonzero(g)
        ys, xs = ys + y, xs + gx
        ok = (ys >= 0) & (ys < H) & (xs >= 0) & (xs < Wd)
        img[ys[ok], xs[ok]] = np.maximum(img[ys[ok], xs[ok]], cols[i])


def _blur(img, sigma):
    """Separable Gaussian blur of an (H, W[, C]) array, zero outside."""
    r = max(1, int(math.ceil(sigma * 3)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    out = img.astype(np.float64)
    for ax in (0, 1):
        pad = [(0, 0)] * out.ndim
        pad[ax] = (r, r)
        p = np.pad(out, pad)
        acc = np.zeros_like(out)
        for i, w in enumerate(k):
            sl = [slice(None)] * out.ndim
            sl[ax] = slice(i, i + out.shape[ax])
            acc += w * p[tuple(sl)]
        out = acc
    return out


SUB = 4   # sub-pixels per glyph pixel in the sampled screen images


def soften(img, glow=0.28):
    """Glyph-pixel image -> sub-pixel image: crisp pixels with a hint of anti-aliasing and a soft phosphor glow."""
    up = np.repeat(np.repeat(img, SUB, 0), SUB, 1)
    sharp = _blur(up, 0.55)
    halo = _blur(up, 1.3 * SUB)
    return np.clip(sharp + glow * halo, 0, 1)


def sample(img, u, v, px):
    """Bilinear sample of a sub-pixel image at physical coords (u right, v down, units), px units per glyph pixel."""
    H, Wd = img.shape[:2]
    x = u / px * SUB - 0.5
    y = v / px * SUB - 0.5
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]

    def at(yy, xx):
        ok = (xx >= 0) & (xx < Wd) & (yy >= 0) & (yy < H)
        out = np.zeros((len(u), img.shape[2]))
        out[ok] = img[yy[ok], xx[ok]]
        return out

    return ((1 - fx) * (1 - fy) * at(y0, x0) + fx * (1 - fy) * at(y0, x0 + 1) + (1 - fx) * fy * at(y0 + 1, x0)
            + fx * fy * at(y0 + 1, x0 + 1))


# ---------------------------------------------------------------------------------------------
# the laptop, in its frames:
#   K (base): origin on the deck's top surface centre, kx towards the hinge, ky left, kz up out of the deck;
#   Lf (lid): origin on the hinge axis, lx along the lid towards its top edge, ly left, lz out of the screen.
# ---------------------------------------------------------------------------------------------

DECK_X, DECK_Y, DECK_T = 4.0, 6.0, 0.46        # half depth, half width, thickness
LID_L, LID_Y, LID_T = 7.7, 6.0, 0.26           # length, half width, thickness
PIVOT_K = np.array([DECK_X - 0.15, 0.0, 0.14])  # hinge axis (the closed lid's screen face rests just above the keys)
LID_OPEN_DEG = 62.0                             # lid direction in K (from kx towards kz): 118 deg from the deck
KEY_PITCH = 0.72
KEY_TOP = 0.09
KB_TOP_X = 3.30                                 # keyboard's far edge (kx)

# display area on the lid face (Lf): lx from the bottom chin up, ly across
DISP_LX0, DISP_LX1 = 0.80, 7.30
DISP_HY = 5.60
DISP_W, DISP_H = 2 * DISP_HY, DISP_LX1 - DISP_LX0
GP = 0.05                                       # glyph pixel on the screen (units)


def lid_frame(open_deg=LID_OPEN_DEG):
    """Lf -> K rotation (columns lx, ly, lz) for a lid direction open_deg (deg from kx towards kz)."""
    a = math.radians(open_deg)
    lx = np.array([math.cos(a), 0.0, math.sin(a)])
    lz = np.array([-math.sin(a), 0.0, math.cos(a)])
    return np.stack([lx, np.array([0.0, 1.0, 0.0]), lz], axis=1)


def keyboard_layout():
    """[(label, kx centre, ky centre, width, depth)] of every key (K frame)."""
    P = KEY_PITCH
    rows = [
        (0.55, [("esc", 1)] + [(f"f{i}", 1) for i in range(1, 13)] + [("del", 1.5)]),
        (1.0, [(c, 1) for c in "`1234567890-="] + [("bksp", 2)]),
        (1.0, [("tab", 1.5)] + [(c, 1) for c in "qwertyuiop[]"] + [("\\", 1.5)]),
        (1.0, [("caps", 1.75)] + [(c, 1) for c in "asdfghjkl;'"] + [("enter", 2.25)]),
        (1.0, [("shift", 2.25)] + [(c, 1) for c in "zxcvbnm,./"] + [("shift", 2.75)]),
        (1.0, [("ctrl", 1.25), ("fn", 1), (">_", 1), ("alt", 1.25), ("", 5.5), ("alt", 1), ("ctrl", 1),
               ("<", 1), ("v", 1), (">", 1)]),
    ]
    out = []
    x = KB_TOP_X
    for h, keys in rows:
        cx = x - h * P / 2
        total = sum(w for _, w in keys)
        y = total * P / 2
        for label, w in keys:
            out.append((label, cx, y - w * P / 2, w * P - 0.12, h * P - 0.12))
            y -= w * P
        x -= h * P
    return out


KEYS = keyboard_layout()


def key_center(label, nth=0):
    found = [k for k in KEYS if k[0] == label]
    k = found[nth]
    return np.array([k[1], k[2], KEY_TOP])


KB_BOUNDS = (min(k[1] - k[4] / 2 for k in KEYS), max(k[1] + k[4] / 2 for k in KEYS),
             min(k[2] - k[3] / 2 for k in KEYS), max(k[2] + k[3] / 2 for k in KEYS))
PAD_RECT = (-3.55, -1.35, -1.9, 1.9)           # touchpad (kx0, kx1, ky0, ky1)


def frustum_box(cx, cy, w, d, z0, z1, inset):
    """Key cap: a box from z0 to z1 whose top is inset (outward CCW faces, no bottom)."""
    hw, hd = w / 2, d / 2
    b = [(cx - hd, cy - hw, z0), (cx + hd, cy - hw, z0), (cx + hd, cy + hw, z0), (cx - hd, cy + hw, z0)]
    t = [(cx - hd + inset, cy - hw + inset, z1), (cx + hd - inset, cy - hw + inset, z1),
         (cx + hd - inset, cy + hw - inset, z1), (cx - hd + inset, cy + hw - inset, z1)]
    v = np.array(b + t)
    f = [(4, 5, 6), (4, 6, 7)]                 # top (normal +z: counter-clockwise seen from above)
    for i in range(4):
        j = (i + 1) % 4
        f += [(i, j, 4 + j), (i, 4 + j, 4 + i)]
    m = M.TriMesh(v, np.array(f))
    # orient the sides outward (centroid test)
    c = v.mean(0)
    fn = m.face_normals()
    fc = v[m.faces].mean(1)
    flip = np.einsum("ij,ij->i", fn, fc - c) < 0
    m.faces[flip] = m.faces[flip][:, ::-1]
    return m


def bevel_box(center, half, bevel):
    """Box with chamfered edges and corners (closed, outward CCW): 24 vertices, crisp flat faces."""
    c = np.asarray(center, dtype=np.float64)
    h = np.asarray(half, dtype=np.float64)
    corners = [(sx, sy, sz) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    vid = {}
    verts = []
    for cs in corners:
        for a in range(3):
            p = [cs[i] * (h[i] if i == a else h[i] - bevel) for i in range(3)]
            vid[(cs, a)] = len(verts)
            verts.append(p)
    faces = []

    def quad_ids(q):
        faces.append((q[0], q[1], q[2]))
        faces.append((q[0], q[2], q[3]))

    for a in range(3):
        b1, b2 = [i for i in range(3) if i != a]
        for s in (-1, 1):
            ring = []
            for u, v in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                cs = [0, 0, 0]
                cs[a], cs[b1], cs[b2] = s, u, v
                ring.append(vid[(tuple(cs), a)])
            quad_ids(ring)
    for a3 in range(3):
        a1, a2 = [i for i in range(3) if i != a3]
        for s1 in (-1, 1):
            for s2 in (-1, 1):
                ids = []
                for s3, a in ((-1, a1), (1, a1), (1, a2), (-1, a2)):
                    cs = [0, 0, 0]
                    cs[a1], cs[a2], cs[a3] = s1, s2, s3
                    ids.append(vid[(tuple(cs), a)])
                quad_ids(ids)
    for cs in corners:
        faces.append((vid[(cs, 0)], vid[(cs, 1)], vid[(cs, 2)]))
    V = np.array(verts) + c
    F = np.array(faces)
    m = M.TriMesh(V, F)
    fn = m.face_normals()
    fc = V[F].mean(1)
    flip = np.einsum("ij,ij->i", fn, fc - c) < 0
    m.faces[flip] = m.faces[flip][:, ::-1]
    return m


def quad(p0, du, dv):
    """Flat quad with corners p0, p0 + du, p0 + du + dv, p0 + dv; front face along du x dv."""
    p0, du, dv = (np.asarray(a, dtype=np.float64) for a in (p0, du, dv))
    v = np.array([p0, p0 + du, p0 + du + dv, p0 + dv])
    return M.TriMesh(v, np.array([(0, 1, 2), (0, 2, 3)]))


class LaptopGeom:
    """Shapes and meshes of the laptop placed in a target frame: K -> target by (Rk, ck); open_deg: lid angle."""

    def __init__(self, Rk, ck, open_deg=LID_OPEN_DEG):
        self.Rk = np.asarray(Rk, dtype=np.float64)
        self.ck = np.asarray(ck, dtype=np.float64)
        self.RL = self.Rk @ lid_frame(open_deg)          # Lf -> target
        self.cl = self.k2t(PIVOT_K)                       # Lf origin in the target frame

    # frame helpers
    def k2t(self, p):
        return self.Rk @ np.asarray(p, dtype=np.float64) + self.ck

    def l2t(self, p):
        return self.RL @ np.asarray(p, dtype=np.float64) + self.cl

    def t2k(self, P):
        return (np.asarray(P) - self.ck) @ self.Rk

    def t2l(self, P):
        return (np.asarray(P) - self.cl) @ self.RL

    def sdf_k(self, s):
        return s.transform(self.Rk).translate(self.ck)

    def sdf_l(self, s):
        return s.transform(self.RL).translate(self.cl)

    def mesh_k(self, m):
        return m.transformed(self.Rk, self.ck)

    def mesh_l(self, m):
        return m.transformed(self.RL, self.cl)

    # shapes
    def base_sdf(self):
        b = sdf.rounded_box((0, 0, -DECK_T / 2), (DECK_X, DECK_Y, DECK_T / 2), 0.13)
        return self.sdf_k(b)

    def base_mesh(self):
        return self.mesh_k(bevel_box((0, 0, -DECK_T / 2), (DECK_X, DECK_Y, DECK_T / 2), 0.09))

    def lid_mesh(self):
        return self.mesh_l(bevel_box((LID_L / 2, 0, -LID_T / 2), (LID_L / 2, LID_Y, LID_T / 2), 0.07))

    def lid_sdf(self):
        s = sdf.rounded_box((LID_L / 2, 0, -LID_T / 2), (LID_L / 2, LID_Y, LID_T / 2), 0.10)
        return self.sdf_l(s)

    def keys_mesh(self):
        ms = [frustum_box(cx, cy, w, d, -0.03, KEY_TOP, 0.045) for _, cx, cy, w, d in KEYS]
        return self.mesh_k(M.merge(ms))

    def legends_mesh(self):
        ms = []
        for label, cx, cy, w, d in KEYS:
            if not label:
                continue
            hw, hd = w / 2 - 0.05, d / 2 - 0.05
            ms.append(quad((cx - hd, cy - hw, KEY_TOP + 0.006), (2 * hd, 0, 0), (0, 2 * hw, 0)))
        return self.mesh_k(M.merge(ms))

    def backlight_mesh(self):
        x0, x1, y0, y1 = KB_BOUNDS
        e = 0.16
        return self.mesh_k(quad((x0 - e, y0 - e, 0.004), (x1 - x0 + 2 * e, 0, 0), (0, y1 - y0 + 2 * e, 0)))

    def display_quad(self, lx0, lx1, ly0, ly1, lz):
        """Quad on the lid face (Lf ranges), facing out of the screen."""
        return self.mesh_l(quad((lx0, ly1, lz), (0, ly0 - ly1, 0), (lx1 - lx0, 0, 0)))

    def disp_uv(self, P):
        """Target-frame points -> display coordinates (u right from the display's left edge, v down from its top)."""
        q = self.t2l(P)
        return DISP_HY - q[:, 1], DISP_LX1 - q[:, 0]


# --- paint of the laptop ----------------------------------------------------------------------------

def _brushed(P, scale=1.0):
    """Fine brushed-metal streaks (deterministic sums of sines along one direction)."""
    x = P[:, 0] * 0.0 + P[:, 1] * 37.0 * scale
    return (np.sin(x * 1.0 + np.sin(P[:, 0] * 3.1) * 2.0) * 0.5 + np.sin(x * 2.7 + 1.3) * 0.3
            + np.sin(x * 6.1 + P[:, 2] * 5.0) * 0.2)


class LaptopPaint:
    def __init__(self, geom, occ=None, rim=True, level=1.0):
        self.g = geom
        self.occ = occ
        self.rim = rim
        self.level = level      # brighter metal for the models seen from afar

    def _finish(self, c, P, N, ao_dist=0.5, gloss=0.25, top=0.14):
        c = np.clip(c * self.level, 0, 1)
        if self.occ is not None:
            ao = T.ambient_occlusion(self.occ, P, N, dist=ao_dist, steps=4)
            out = T.shade(c, N, ao=ao, ao_strength=0.6, top=top, shadow_tint="#6a7488")
        else:
            out = T.shade(c, N, top=top)
        if self.rim:
            vd = P / np.maximum(np.linalg.norm(P, axis=1, keepdims=True), 1e-9)
            f = (1 - np.abs(np.einsum("ij,ij->i", N, vd))) ** 3
            out = np.clip(out + 0.10 * f[:, None] * np.array([0.92, 1.0, 1.08]), 0, 1)
        if gloss:
            L = np.array([0.35, 0.45, 0.82])
            hl = np.clip(N @ (L / np.linalg.norm(L)), 0, 1) ** 16 * gloss
            out = np.clip(out + hl[:, None] * 0.5, 0, 1)
        return out

    def base(self, P, N, skin):
        k = self.g.t2k(P)
        nk = N @ self.g.Rk
        c = np.tile(GRAPHITE, (len(P), 1)) * (1 + 0.035 * _brushed(k))[:, None]
        top = nk[:, 2] > 0.7
        # keyboard well, a little darker; touchpad with its fine border
        x0, x1, y0, y1 = KB_BOUNDS
        well = (_sstep(x0 - 0.12, x0 - 0.05, k[:, 0]) * (1 - _sstep(x1 + 0.05, x1 + 0.12, k[:, 0]))
                * _sstep(y0 - 0.12, y0 - 0.05, k[:, 1]) * (1 - _sstep(y1 + 0.05, y1 + 0.12, k[:, 1])))
        c = T.mix(c, GRAPHITE_DARK * 0.8, well * top)
        px0, px1, py0, py1 = PAD_RECT
        dpad = np.maximum(np.maximum(px0 - k[:, 0], k[:, 0] - px1), np.maximum(py0 - k[:, 1], k[:, 1] - py1))
        pad = T.edge(dpad, 0.015) * top
        c = T.mix(c, GRAPHITE * 1.12, pad)
        c = T.mix(c, GRAPHITE_EDGE * 1.1, np.exp(-(dpad / 0.025) ** 2) * top * 0.9)
        # bright chamfer on the top edge, darker underside
        edge = (1 - _sstep(0.55, 0.9, nk[:, 2])) * (nk[:, 2] > -0.2)
        c = T.mix(c, GRAPHITE_EDGE * 1.25, edge * 0.85)
        c = np.where((nk[:, 2] < -0.5)[:, None], GRAPHITE_DARK * 0.8, c)
        return self._finish(c, P, N)

    def keycap(self, P, N, skin):
        k = self.g.t2k(P)
        nk = N @ self.g.Rk
        c = np.tile(KEYCAP, (len(P), 1))
        side = 1 - _sstep(0.6, 0.9, nk[:, 2])
        c = T.mix(c, KEYCAP * 1.6, side * 0.4)
        # the green light leaking at the bottom of the caps' sides
        leak = side * np.exp(-((k[:, 2] + 0.01) / 0.035) ** 2)
        c = np.clip(c + leak[:, None] * GREEN * 0.35, 0, 1)
        return self._finish(c, P, N, ao_dist=0.2, gloss=0.12, top=0.1)

    def lid(self, P, N, skin):
        q = self.g.t2l(P)
        nl = N @ self.g.RL
        front = nl[:, 2] > 0.7
        back = nl[:, 2] < -0.7
        c = np.tile(GRAPHITE, (len(P), 1)) * (1 + 0.035 * _brushed(q[:, [1, 0, 2]]))[:, None]
        # back: the mark, a green ">_" (prompt) centred on the lid
        mark_c, mark = _mark(q[:, 1], q[:, 0] - LID_L * 0.52, 1.5)
        c = T.mix(c, mark_c, mark * back)
        # front: bezel and black glass
        bez = np.tile(BEZEL, (len(P), 1))
        dd = np.maximum(np.maximum(DISP_LX0 - q[:, 0], q[:, 0] - DISP_LX1), np.abs(q[:, 1]) - DISP_HY)
        glass = T.edge(dd, 0.01)
        bez = T.mix(bez, GLASS, glass)
        cam = np.hypot(q[:, 0] - (LID_L - 0.22), q[:, 1])
        bez = T.mix(bez, T.rgb("#202a30"), T.edge(cam - 0.06, 0.01))
        c = np.where(front[:, None], bez, c)
        edge = (np.abs(nl[:, 2]) < 0.75)
        c = np.where(edge[:, None], GRAPHITE_EDGE * 1.15, c)
        out = self._finish(c, P, N, gloss=0.18)
        return np.where((front & (glass > 0.5))[:, None], np.clip(c * 0.9 + 0.012, 0, 1), out)


def _mark(x, y, s):
    """The lid mark ">_" (prompt) at 2D coords (x left-right, y up), size s: (colour, mask)."""
    # turned so that it reads ">_" from the opening edge (the user's side when it is closed in front of them)
    gx = -x / (0.42 * s)
    gy = -y / (0.42 * s)
    # '>': the point on the right (gx = -0.1), the arms open to the left
    chev = np.minimum(np.abs(gy + (-0.1 - gx) * 0.9), np.abs(gy - (-0.1 - gx) * 0.9))
    chev = np.where((gx > -1.2) & (gx < -0.1), chev, 9.0)
    under = np.where((gx > 0.25) & (gx < 1.45), np.abs(gy + 1.0), 9.0)
    d = np.minimum(chev, under) * 0.42 * s
    m = T.edge(d - 0.055 * s, 0.035)
    col = np.tile(GREEN * 0.85, (len(x), 1))
    return col, m


# ---------------------------------------------------------------------------------------------
# the screen's content (display coordinates: u right, v down, units; images in glyph pixels)
# ---------------------------------------------------------------------------------------------

CODE = [
    "import matrix as mx",
    "from world import *",
    "",
    "def compile_lem(aim):",
    "  m = mx.load('le_m')",
    "  m.cap.rotate(180)",
    "  m.glasses = 'round'",
    "  for v in m.voxels:",
    "    v.render(GREEN)",
]
TYPED = ["  m.compile(fps=30)", "  return spawn(m,aim)"]
TITLE = "le_m.py - ~/matrix"
STATUS = "-- INSERT --   py  utf-8"

DPX_W, DPX_H = int(round(DISP_W / GP)), int(round(DISP_H / GP))     # 224 x 130 glyph pixels
CODE_X, CODE_Y = 17, 12                                             # first code cell (px)
TYPE_ROW = len(CODE)                                                 # the typed lines' first row
RAIN_X0, RAIN_X1 = 152, 221
RAIN_Y0, RAIN_Y1 = 12, 122
SEP_X = 149
# animated regions (display units): the typed lines' strip and the rain panel
TYPE_RECT = (CODE_X * GP - 0.05, SEP_X * GP - 0.08, (CODE_Y + TYPE_ROW * CELL_H) * GP - 0.06,
             (CODE_Y + (TYPE_ROW + 2) * CELL_H) * GP - 0.02)       # u0, u1, v0, v1
RAIN_RECT = (RAIN_X0 * GP, RAIN_X1 * GP, RAIN_Y0 * GP, RAIN_Y1 * GP)


def _typed_count(f, n=SCREEN_SKINS):
    """Characters of TYPED shown at skin frame f: the leading indents appear at once, the rest is typed in
    bursts over the first ~85 % of the cycle, then a short hold."""
    a, b = TYPED
    na, nb = len(a.strip()), len(b.strip())
    ia, ib = len(a) - len(a.lstrip()), len(b) - len(b.lstrip())
    # frames 0..9: line a, 10: newline, 11..20: line b, 21..23 hold
    fa = n * 10 // 24
    fb0, fb1 = n * 11 // 24, n * 21 // 24
    if f < fa:
        return min(na, int(round((f + 1) * na / fa))), 0
    if f < fb0:
        return na, 0
    if f < fb1:
        return na, min(nb, int(round((f - fb0 + 1) * nb / (fb1 - fb0))))
    return na, nb


def screen_static():
    img = np.zeros((DPX_H, DPX_W, 3))
    # title bar
    img[0:9, :] = np.array([0.03, 0.16, 0.06])
    draw_text(img, 3, 1, TITLE, np.array([0.55, 1.0, 0.65]))
    for i in range(3):
        cx = DPX_W - 6 - 7 * i
        img[3:6, cx - 1:cx + 2] = np.array([0.25, 0.9, 0.4]) * (1.0 - 0.25 * i)
    # gutter: line numbers
    for r in range(TYPE_ROW + 2):
        s = f"{r + 1:2d}"
        draw_text(img, 2, CODE_Y + r * CELL_H + 1, s, COL_DIM)
    img[CODE_Y:CODE_Y + (TYPE_ROW + 2) * CELL_H, 15] = COL_DIM * 0.7
    # the code
    for r, line in enumerate(CODE):
        draw_text(img, CODE_X, CODE_Y + r * CELL_H + 1, line, highlight(line))
    # separator and the rain panel's frame
    img[CODE_Y - 2:RAIN_Y1 + 1, SEP_X] = COL_DIM
    # status bar
    img[DPX_H - 8:DPX_H, :] = np.array([0.02, 0.10, 0.04])
    draw_text(img, 3, DPX_H - 8, STATUS, np.array([0.35, 0.95, 0.5]))
    return img


def screen_typed(f):
    img = np.zeros((DPX_H, DPX_W, 3))
    ca, cb = _typed_count(f)
    a, b = TYPED
    ia, ib = len(a) - len(a.lstrip()), len(b) - len(b.lstrip())
    sa = a[:ia + ca]
    sb = b[:ib + cb] if f >= SCREEN_SKINS * 10 // 24 else ""
    y0 = CODE_Y + TYPE_ROW * CELL_H + 1
    draw_text(img, CODE_X, y0, sa, highlight(a)[:len(sa)])
    if sb:
        draw_text(img, CODE_X, y0 + CELL_H, sb, highlight(b)[:len(sb)])
    # cursor (blinks once the typing is done)
    row, col = (0, len(sa)) if not sb and f < SCREEN_SKINS * 10 // 24 else (1, len(sb) if sb else ib)
    blink_on = f < SCREEN_SKINS * 21 // 24 or (f // 2) % 2 == 0
    if blink_on:
        draw_text(img, CODE_X + col * CELL_W, y0 + row * CELL_H, G.CURSOR, np.array([0.5, 1.0, 0.62]))
    return img


class Rain:
    """Matrix code rain in a panel of columns x rows cells (6x8 glyph pixels), periodic over `frames`."""

    def __init__(self, cols, rows, frames, seed, speeds=((2 / 3, 16), (0.75, 18), (1.0, 24), (4 / 3, 16)), tails=(7, 13),
                 per_col=2):
        rng = np.random.default_rng(seed)
        self.alpha = G.rain_glyphs()
        self.cols, self.rows, self.frames = cols, rows, frames
        # (column, speed rows/frame, period rows, phase, tail, brightness): every column carries `per_col` drops
        # spread over its period, so the panel stays full (periods close to the panel's height)
        self.drops = []
        for c in range(cols):
            s, P = speeds[int(rng.integers(0, len(speeds)))]
            assert abs(s * frames / P - round(s * frames / P)) < 1e-9
            ph = rng.uniform(0, P)
            for k in range(per_col):
                self.drops.append((c, s, P, (ph + k * P / per_col + rng.uniform(-1.5, 1.5)) % P,
                                   int(rng.integers(tails[0], tails[1] + 1)), rng.uniform(0.85, 1.0)))
        nmax = max(P for _, P in speeds) + rows
        self.glyph_ids = rng.integers(0, len(self.alpha), size=(cols, nmax))
        self.flicker = rng.integers(0, len(self.alpha), size=(frames, cols, nmax))
        self.flick_on = rng.random((frames, cols, nmax)) < 0.18

    def cells(self, f):
        """[(col, row, glyph array, brightness, is_head)] visible at frame f."""
        out = []
        for c, s, P, ph, L, br in self.drops:
            # the head runs over rows 0 .. P-1 (P >= rows: off the panel's bottom for P - rows rows, while the
            # tail drains out); wrapped tail cells above row 0 are never drawn
            head = int(math.floor(ph + s * f)) % P
            for k in range(L + 1):
                r = head - k
                if not (0 <= r < self.rows):
                    continue
                gi = self.flicker[f, c, r] if self.flick_on[f, c, r] else self.glyph_ids[c, r]
                b = br * (0.28 + 0.72 * (1.0 - k / (L + 1)) ** 1.1)
                out.append((c, r, self.alpha[gi], b, k == 0))
        return out


RAIN_COLS = (RAIN_X1 - RAIN_X0) // CELL_W
RAIN_ROWS = (RAIN_Y1 - RAIN_Y0) // 8
_RAIN = None


def screen_rain(f):
    global _RAIN
    if _RAIN is None:
        _RAIN = Rain(RAIN_COLS, RAIN_ROWS, SCREEN_SKINS, seed=9101)
    img = np.zeros((DPX_H, DPX_W, 3))
    x0 = RAIN_X0 + ((RAIN_X1 - RAIN_X0) - RAIN_COLS * CELL_W) // 2 + 1
    for c, r, g, b, head in _RAIN.cells(f):
        col = np.array([0.93, 1.0, 0.95]) / b if head else GREEN * np.array([0.6, 1.0, 0.75])
        ys, xs = np.nonzero(g[:7])
        img[RAIN_Y0 + 1 + r * 8 + ys, x0 + c * CELL_W + xs] = np.maximum(
            img[RAIN_Y0 + 1 + r * 8 + ys, x0 + c * CELL_W + xs], col * b)
    return img


class ScreenImages:
    """Softened sub-pixel images of the screen, cached (static, typed[f], rain[f], panel)."""

    def __init__(self):
        self.cache = {}

    def get(self, key):
        if key not in self.cache:
            if key == "static":
                im = screen_static()
            elif key == "panel":
                im = screen_panel()
            elif key == "online":
                im = screen_online()
            elif key[0] == "typed":
                im = screen_typed(key[1])
            elif key[0] == "rain":
                im = screen_rain(key[1])
            else:
                raise KeyError(key)
            self.cache[key] = soften(im)
        return self.cache[key]


# deploy's panel (display px): centred box with the command, the title and the progress bar's frame
PANEL_PX = (22, 202, 28, 106)       # x0, x1, y0, y1
BAR_PX = (40, 184, 70, 80)          # the bar's inside
BAR_SEGMENTS = 10


def screen_panel():
    img = np.zeros((DPX_H, DPX_W, 3))
    x0, x1, y0, y1 = PANEL_PX
    c = np.array([0.25, 0.95, 0.42])
    img[y0, x0:x1] = c
    img[y1 - 1, x0:x1] = c
    img[y0:y1, x0] = c
    img[y0:y1, x1 - 1] = c
    img[y0 + 2:y0 + 12, x0 + 2:x1 - 2] = np.array([0.05, 0.28, 0.10])
    draw_text(img, x0 + 5, y0 + 3, "> compile_lem(aim)", np.array([0.7, 1.0, 0.78]))
    draw_text(img, x0 + 6, y0 + 19, "COMPILING LE M", np.array([0.85, 1.0, 0.88]), scale=2)
    bx0, bx1, by0, by1 = BAR_PX
    img[by0 - 2, bx0 - 2:bx1 + 2] = c
    img[by1 + 1, bx0 - 2:bx1 + 2] = c
    img[by0 - 2:by1 + 2, bx0 - 2] = c
    img[by0 - 2:by1 + 2, bx1 + 1] = c
    return img


def screen_online():
    img = np.zeros((DPX_H, DPX_W, 3))
    draw_text(img, ONLINE_PX[0] + 2, BAR_PX[3] + 7, "> LE M ONLINE" + G.CURSOR, np.array([0.85, 1.0, 0.88]))
    return img


ONLINE_PX = ((PANEL_PX[0] + PANEL_PX[1]) // 2 - 7 * CELL_W - 2, (PANEL_PX[0] + PANEL_PX[1]) // 2 + 7 * CELL_W + 2,
             BAR_PX[3] + 5, BAR_PX[3] + 17)


# ---------------------------------------------------------------------------------------------
# the typing hands (balls.py's glove and sleeve), in the hand frame H: origin at the wrist, +x along
# the hand towards the middle finger, +y towards the thumb, +z out of the back of the hand
# ---------------------------------------------------------------------------------------------

FLEX = {"index": (20, 50, 24), "middle": (19, 50, 24), "ring": (18, 48, 22), "pinky": (16, 44, 20)}


def _rot(axis, deg):
    return xform.axis_angle_matrix(axis, deg)


def typing_layout():
    """Joints of a relaxed typing hand in H (fingers curled down onto the keys, the thumb over the space bar)."""
    out = {}
    z = np.array([0.0, 0.0, 1.0])
    for name, mcp, splay, lens, rads in B.FINGERS:
        d = _rot(z, splay * 1.15) @ np.array([1.0, 0.0, 0.0])
        p = np.asarray(mcp, dtype=np.float64)
        joints = [p.copy()]
        for L, fl in zip(lens, FLEX[name]):
            ax = np.cross(z, d)
            ax /= np.linalg.norm(ax)
            d = _rot(ax, fl) @ d
            p = p + L * d
            joints.append(p.copy())
        out[name] = joints
    d1 = np.array([0.72, 0.40, -0.56])
    d2 = np.array([0.80, 0.18, -0.58])
    mcp = np.asarray(B.THUMB_MCP, dtype=np.float64)
    ip = mcp + B.THUMB_LEN[0] * d1 / np.linalg.norm(d1)
    tip = ip + B.THUMB_LEN[1] * d2 / np.linalg.norm(d2)
    out["thumb"] = [np.asarray(B.THUMB_CMC, dtype=np.float64), mcp, ip, tip]
    return out


class HandLayout:
    """The right typing hand placed in view space (design space: +x forward, +y left, +z up, eye at 0).
    Same attributes as balls.VLayout (Q: H -> view, W wrist, u forearm direction, E elbow, A arm frame, lay
    joints in H, ball_c a point the palm faces), so balls.ArmPaint and balls.sleeve_sdf apply as they are."""

    def __init__(self, Q, W, u, forearm_len=11.5):
        self.Q = np.asarray(Q, dtype=np.float64)
        self.W = np.asarray(W, dtype=np.float64)
        self.lay = typing_layout()
        u = np.asarray(u, dtype=np.float64)
        self.u = u / np.linalg.norm(u)
        self.E = self.W - forearm_len * self.u
        yA = self.Q @ np.array([0.0, 1.0, 0.0])
        yA = yA - self.u * (yA @ self.u)
        yA /= np.linalg.norm(yA)
        self.A = np.stack([self.u, yA, np.cross(self.u, yA)], axis=1)
        self.ball_c = self.to_view((2.4, 0.2, -2.8))

    def to_view(self, pH):
        return self.Q @ np.asarray(pH, dtype=np.float64) + self.W

    def sdf_h(self, shape):
        return shape.transform(self.Q).translate(self.W)

    def sdf_a(self, shape):
        return shape.transform(self.A).translate(self.E)


FINGER_NAMES = [f[0] for f in B.FINGERS]
HAND_BONES = ["arm", "hand"] + [n + s for n in FINGER_NAMES + ["thumb"] for s in ("1", "2")]


class Hand:
    """One typing hand in design space: its shapes, paint, rig bones (prefixed) and flexion axes."""

    def __init__(self, L, prefix, mirror=False):
        self.L = L
        self.prefix = prefix
        self.mirror = mirror
        self.joints = {k: [L.to_view(p) for p in v] for k, v in L.lay.items()}
        z = L.Q @ np.array([0.0, 0.0, 1.0])
        self.flex = {}
        for name in FINGER_NAMES:
            j = self.joints[name]
            self.flex[name] = [self._lat(z, j[1] - j[0]), self._lat(z, j[2] - j[1])]
        tj = self.joints["thumb"]
        self.flex["thumb"] = [self._lat(z, tj[2] - tj[1]), self._lat(z, tj[3] - tj[2])]

    @staticmethod
    def _lat(z, d):
        a = np.cross(z, d)
        return a / np.linalg.norm(a)

    def n(self, bone):
        return self.prefix + bone

    def add_bones(self, rig, parent):
        J = self.joints
        rig.add(self.n("arm"), parent, self.L.E, tail=self.L.W)
        rig.add(self.n("hand"), self.n("arm"), self.L.W, tail=J["middle"][0])
        for name in FINGER_NAMES:
            j = J[name]
            rig.add(self.n(name + "1"), self.n("hand"), j[0], tail=j[1])
            rig.add(self.n(name + "2"), self.n(name + "1"), j[1], tail=j[3])
        tj = J["thumb"]
        rig.add(self.n("thumb1"), self.n("hand"), tj[1], tail=tj[2])
        rig.add(self.n("thumb2"), self.n("thumb1"), tj[2], tail=tj[3])

    def shapes(self):
        L = self.L
        lay = L.lay
        rads = {n: r for n, _, _, _, r in B.FINGERS}
        out = {
            "palm": L.sdf_h(B.palm_sdf(lay)),
            "guard": L.sdf_h(B.knuckle_guard_sdf(lay)),
            "thumb": L.sdf_h(B.finger_sdf(lay["thumb"][1:], B.THUMB_RAD + (0.40,))),
            "sleeve": L.sdf_a(B.sleeve_sdf(L)),
            "gcuff": L.sdf_a(B.glove_cuff_sdf(L)),
        }
        for n in FINGER_NAMES:
            out[n] = L.sdf_h(B.finger_sdf(lay[n], rads[n]))
        return out

    def pose(self, p, k):
        """Add this hand's bones to Pose p from key k (missing = rest):
        dW: view-space offset of the whole arm; arm_rot: (axis, deg) about the elbow; wrist: (axis, deg) about the
        wrist (view-space axis); f_<finger>: (MCP flex, PIP flex) offsets in degrees (+ = curl); thumb: (a, b)."""
        Rarm = np.eye(3)
        if k.get("arm_rot"):
            Rarm = _rot(*k["arm_rot"])
        p.set_rot(self.n("arm"), *np.degrees(xform.matrix_euler(Rarm)))
        dW = np.asarray(k.get("dW", (0.0, 0.0, 0.0)), dtype=np.float64)
        p.move(self.n("arm"), *dW)
        if k.get("wrist"):
            Rw = _rot(*k["wrist"])
            p.set_rot(self.n("hand"), *np.degrees(xform.matrix_euler(Rw)))
        for name in FINGER_NAMES + ["thumb"]:
            a, b_ = k.get("f_" + name, (0.0, 0.0))
            g = k.get("grip", 0.0)
            a, b_ = a + g, b_ + g * 0.8
            ax1, ax2 = self.flex[name]
            if a:
                p.set_rot(self.n(name + "1"), *np.degrees(xform.matrix_euler(_rot(ax1, a))))
            if b_:
                p.set_rot(self.n(name + "2"), *np.degrees(xform.matrix_euler(_rot(ax2, b_))))
        return p


# ---------------------------------------------------------------------------------------------
# v_laptop: placement in the view (design space; mirrored for the file like v_pokeball)
# ---------------------------------------------------------------------------------------------

DECK_PITCH = 22.0                      # the deck rises away from the eye
HINGE_VIEW = np.array([22.0, 0.0, -9.6])


def v_laptop_geom():
    Rk = xform.rot_deg(0, -DECK_PITCH, 0)
    ck = HINGE_VIEW - Rk @ PIVOT_K
    return LaptopGeom(Rk, ck)


def right_hand_layout(g):
    """The right hand on the home row: middle fingertip on 'k', fingers towards the hinge turned a little inwards,
    the hand rolled thumb-up, the forearm coming from the lower right."""
    Rk = g.Rk
    yaw, roll = 13.0, 16.0
    hxK = np.array([math.cos(math.radians(yaw)), math.sin(math.radians(yaw)), 0.0])
    zK = np.array([0.0, -math.sin(math.radians(roll)), math.cos(math.radians(roll))])
    Q = B.frame_from(Rk @ hxK, Rk @ zK)
    lay = typing_layout()
    tip = lay["middle"][3] - np.array([0.0, 0.0, B.FINGERS[1][4][3]])
    target = g.k2t(key_center("k") + np.array([0.06, -0.95, 0.01]))
    Wv = target - Q @ tip
    uK = np.array([0.90, 0.30, 0.30])
    return HandLayout(Q, Wv, Rk @ uK)


def mirror_layout(L):
    """The left hand: the right one mirrored across y (a left hand, its H frame left-handed)."""
    F = np.diag([1.0, -1.0, 1.0])
    out = HandLayout.__new__(HandLayout)
    out.Q = F @ L.Q
    out.W = F @ L.W
    out.lay = L.lay
    out.u = F @ L.u
    out.E = F @ L.E
    out.A = F @ L.A
    out.ball_c = F @ L.ball_c
    return out


def mirror_key(k):
    """A right-hand key for the mirrored (left) hand: offsets mirrored, rotation axes as pseudovectors."""
    F = np.array([1.0, -1.0, 1.0])
    out = dict(k)
    if "dW" in k:
        out["dW"] = np.asarray(k["dW"], dtype=np.float64) * F
    for name in ("arm_rot", "wrist"):
        if k.get(name):
            ax, deg = k[name]
            out[name] = (-np.asarray(ax, dtype=np.float64) * F, deg)
    return out


def _memo(fn):
    """Cache a paint function's result per point set (every skin repaints every group; only the screen's differ)."""
    cache = {}

    def g(P, N, skin):
        key = (P.shape, P.tobytes(), N.tobytes())
        if key not in cache:
            cache[key] = fn(P, N, 0)
        return cache[key]
    return g


OVERLAYS = ["panel"] + [f"bar{i}" for i in range(BAR_SEGMENTS)] + ["online", "flash0", "flash1", "flash2"]
HIDE = 0.20             # overlays parked this far behind the screen face (inside the lid)
FLASH_LEVEL = {"flash0": 1.0, "flash1": 0.50, "flash2": 0.22}


class VLaptop:
    """Everything of the view model in design space and its rig."""

    def __init__(self):
        self.g = v_laptop_geom()
        g = self.g
        self.Lr = right_hand_layout(g)
        self.Ll = mirror_layout(self.Lr)
        self.right = Hand(self.Lr, "r_")
        self.left = Hand(self.Ll, "l_")
        rig = R.Rig()
        rig.add("root", None, (0, 0, 0))
        rig.add("laptop", "root", g.ck, tail=g.k2t((DECK_X, 0, 0)))
        rig.add("lid", "laptop", g.cl, tail=g.l2t((LID_L, 0, 0)))
        for name in OVERLAYS:
            rig.add(name, "lid", g.l2t((DISP_LX0 + DISP_LX1) / 2 * np.array([1, 0, 0])), tail=None)
        self.right.add_bones(rig, "root")
        self.left.add_bones(rig, "root")
        self.rig = rig
        self.lz = g.RL[:, 2]
        self.normal = g.Rk[:, 2]

    def mirrored_rig(self):
        rig = R.Rig()
        for b in self.rig.bones:
            h = b.head * np.array([1, -1, 1])
            t = None if b.tail is None else b.tail * np.array([1, -1, 1])
            rig.add(b.name, None if b.parent < 0 else self.rig.bones[b.parent].name, h, tail=t)
        return rig

    def pose(self, st):
        """Pose from a state dict: laptop_dW, laptop_rot (axis, deg about its head), open (lid 0 closed .. 1 open,
        may overshoot), show (set of visible overlays), right / left (Hand keys, the left one in its own mirrored
        terms: give mirror_key(...) of a right-hand key), root_dW."""
        p = R.Pose()
        if st.get("root_dW") is not None:
            p.move("root", *st["root_dW"])
        Rl = _rot(*st["laptop_rot"]) if st.get("laptop_rot") else np.eye(3)
        p.set_rot("laptop", *np.degrees(xform.matrix_euler(Rl)))
        p.move("laptop", *np.asarray(st.get("laptop_dW", (0, 0, 0)), dtype=np.float64))
        op = st.get("open", 1.0)
        p.set_rot("lid", 0.0, -(180.0 - LID_OPEN_DEG) * (1.0 - op), 0.0)      # closed: lid down on the keys
        show = st.get("show", set())
        for name in OVERLAYS:
            if name not in show:
                p.move(name, *(-HIDE * self.lz))
        self.right.pose(p, st.get("right", {}))
        self.left.pose(p, st.get("left", {}))
        return p


# --- typing motion ---------------------------------------------------------------------------------

def _bump(x, w):
    return math.exp(-(x / w) ** 2)


class Typist:
    """Finger strikes of one hand: a deterministic schedule of (time s, finger) over a loop of `period` s."""

    WEIGHTS = {"index": 0.36, "middle": 0.26, "ring": 0.18, "pinky": 0.10, "thumb": 0.10}

    def __init__(self, period, rate, seed, margin=0.10, drift=0.25):
        rng = np.random.default_rng(seed)
        n = max(1, int(round(period * rate)))
        names = list(self.WEIGHTS)
        w = np.array([self.WEIGHTS[k] for k in names])
        times = np.sort(rng.uniform(margin, period - margin, n))
        # no finger strikes twice within 0.12 s
        self.strikes = []
        last = {k: -9.0 for k in names}
        for t in times:
            for _ in range(8):
                f = names[int(rng.choice(len(names), p=w / w.sum()))]
                if t - last[f] > 0.12:
                    break
            last[f] = t
            self.strikes.append((float(t), f))
        self.period = period
        self.margin = margin
        self.drift = drift
        self.ph = rng.uniform(0, 2 * math.pi, 4)

    def key(self, s, normal, across):
        """Hand key at time s (seconds): finger flexes, the hand's small drift and bob, the wrist's roll."""
        k = {}
        press_total = 0.0
        for name in list(self.WEIGHTS):
            a = b_ = 0.0
            for ts, f in self.strikes:
                if f != name:
                    continue
                lift = _bump(s - (ts - 0.07), 0.045)
                press = _bump(s - ts, 0.028)
                if name == "thumb":
                    a += -9.0 * lift + 8.0 * press
                    b_ += -4.0 * lift + 4.0 * press
                else:
                    a += -17.0 * lift + 7.0 * press
                    b_ += -9.0 * lift + 6.0 * press
                press_total += press
            k["f_" + name] = (a, b_)
        T_ = self.period
        env = math.sin(math.pi * min(max(s / T_, 0.0), 1.0)) ** 2
        u = 2 * math.pi * s / T_
        dy = self.drift * (math.sin(u + self.ph[0]) + 0.5 * math.sin(2 * u + self.ph[1])) * env
        dx = 0.6 * self.drift * (math.sin(u + self.ph[2]) * 0.8 + 0.4 * math.sin(3 * u + self.ph[3])) * env
        k["dW"] = across * dy + np.cross(normal, across) * dx - normal * 0.05 * min(press_total, 1.0)
        k["wrist"] = (np.cross(normal, across), 2.5 * math.sin(2 * u + self.ph[1]) * env)
        return k


def _lerp_dict(a, b, w):
    """Blend two hand keys (vectors and (a, b) tuples; rotations as their axis-angle vector)."""
    out = {}
    for n in sorted(set(a) | set(b)):
        va, vb = a.get(n), b.get(n)
        if n in ("arm_rot", "wrist"):
            ra = np.zeros(3) if not va else np.asarray(va[0], dtype=np.float64) / np.linalg.norm(va[0]) * va[1]
            rb = np.zeros(3) if not vb else np.asarray(vb[0], dtype=np.float64) / np.linalg.norm(vb[0]) * vb[1]
            r = ra + (rb - ra) * w
            nr = float(np.linalg.norm(r))
            out[n] = (r / nr, nr) if nr > 1e-9 else None
            continue
        za = np.zeros(3) if n == "dW" else (0.0, 0.0)
        va = np.asarray(za if va is None else va, dtype=np.float64)
        vb = np.asarray(za if vb is None else vb, dtype=np.float64)
        v = va + (vb - va) * w
        out[n] = v if n == "dW" else (float(v[0]), float(v[1]))
    return out


def _track(t, track, ease="smooth"):
    """Hand key along [(t, key), ...] (piecewise, eased between neighbours)."""
    if t <= track[0][0]:
        return dict(track[0][1])
    for (t0, k0), (t1, k1) in zip(track[:-1], track[1:]):
        if t <= t1:
            w = (t - t0) / max(t1 - t0, 1e-9)
            if ease == "smooth":
                w = w * w * (3 - 2 * w)
            return _lerp_dict(k0, k1, w)
    return dict(track[-1][1])


def v_sequences(vm):
    """[(name, pose_fn(t), frames, fps, loop)] in design space."""
    g = vm.g
    nrm = vm.normal                      # deck normal (view)
    across = g.Rk[:, 1]                  # along the keyboard rows (view +y)
    toward = g.Rk[:, 0]                  # towards the hinge
    up = np.array([0.0, 0.0, 1.0])

    # idle: 2 s, lazy taps and breathing
    tr_idle = Typist(2.0, 2.2, seed=301, margin=0.15, drift=0.12)
    tl_idle = Typist(2.0, 1.6, seed=302, margin=0.15, drift=0.10)

    # type: 1.2 s, fast
    tr = Typist(1.2, 8.5, seed=311, margin=0.09, drift=0.30)
    tl = Typist(1.2, 7.5, seed=312, margin=0.09, drift=0.26)
    Fy = np.array([1.0, -1.0, 1.0])

    def left_key(typ, s):
        # computed in the right hand's terms (mirrored space), then mirrored
        return typ.key(s, nrm * Fy, across * Fy)

    def type_(t):
        s = t * 1.2
        st = {"right": tr.key(s, nrm, across), "left": mirror_key(left_key(tl, s))}
        st["root_dW"] = up * 0.05 * math.sin(2 * math.pi * t * 3) * math.sin(math.pi * t) ** 2
        return vm.pose(st)

    def idle(t):
        s = t * 2.0
        st = {"right": tr_idle.key(s, nrm, across), "left": mirror_key(left_key(tl_idle, s))}
        st["root_dW"] = up * 0.10 * R.breathe(t) + np.array([0.04, 0, 0]) * R.wave(t, phase=0.3)
        return vm.pose(st)

    # deploy (31 frames, 1.0 s): lift over Enter (f0-6), slam (f8), flash (f8-10), panel + bar (f8-27), ONLINE (f27)
    D_FR = 31
    SLAM = 8
    p_rest = vm.pose({})
    Wm = vm.rig.world(p_rest)
    # the right middle fingertip's rest position and the Enter key's top
    slam_fingers = {"f_index": (-14.0, -22.0), "f_middle": (-12.0, -20.0), "f_ring": (6.0, 10.0),
                    "f_pinky": (10.0, 14.0), "f_thumb": (6.0, 4.0)}
    wrist_ax = np.cross(nrm, across)
    k_slam = dict(slam_fingers, wrist=(wrist_ax, 12.0))
    p_s = vm.pose({"right": k_slam})
    Ws = vm.rig.world(p_s)
    hand = vm.right
    jm = vm.rig.index("r_middle2")
    tip_rest = hand.joints["middle"][3]
    tip_s = Ws[jm][:, :3] @ (tip_rest - vm.rig.head("r_middle2")) + Ws[jm][:, 3]
    enter = g.k2t(key_center("enter") + np.array([0.0, 0.25, 0.0])) + nrm * (0.30 - 0.06)
    dW_slam = enter - tip_s
    k_hit = dict(k_slam, dW=dW_slam)
    k_lift = dict(k_slam, dW=dW_slam + nrm * 2.6 - toward * 0.6, wrist=(wrist_ax, -16.0),
                  f_index=(-20.0, -25.0), f_middle=(-18.0, -24.0))
    k_bounce = dict(k_slam, dW=dW_slam + nrm * 0.35, wrist=(wrist_ax, 6.0))
    left_off = {"f_index": (-12.0, -8.0), "f_middle": (-10.0, -6.0), "f_ring": (-6.0, -4.0),
                "f_pinky": (-4.0, -2.0), "dW": nrm * Fy * 0.5}

    def deploy(t):
        f = t * (D_FR - 1)
        kr = _track(f, [(0, {}), (3.5, _lerp_dict({}, k_lift, 0.7)), (6.0, k_lift), (SLAM, k_hit),
                        (9.5, k_hit), (11.5, k_bounce), (20.0, {}), (D_FR - 1, {})])
        kl = _track(f, [(0, {}), (SLAM - 1, {}), (SLAM + 1, left_off), (16.0, {}), (D_FR - 1, {})])
        st = {"right": kr, "left": mirror_key(kl)}
        # the laptop takes the hit
        hit = _bump(f - (SLAM + 0.8), 1.1)
        st["laptop_dW"] = -nrm * 0.22 * hit
        st["laptop_rot"] = (across, 1.2 * hit)
        show = set()
        if f >= SLAM - 0.01:
            show.add("panel")
            fl = int(round(f)) - SLAM
            if 0 <= fl <= 2:
                show.add(f"flash{fl}")
            nb = int(np.clip(math.floor((f - (SLAM + 3)) / 1.5) + 1, 0, BAR_SEGMENTS))
            for i in range(nb):
                show.add(f"bar{i}")
            if f >= 27 - 0.01:
                show.add("online")
        st["show"] = show
        return vm.pose(st)

    # draw (28 frames, 0.9 s): the closed laptop comes up, the lid springs open, the hands land on the keys
    DR = 28
    low_hand = {"dW": np.array([-4.0, -3.0, -13.0]), "arm_rot": (np.array([0.0, 1.0, 0.0]), 18.0),
                "f_index": (-15.0, -15.0), "f_middle": (-15.0, -15.0), "f_ring": (-14.0, -14.0),
                "f_pinky": (-12.0, -12.0), "f_thumb": (-8.0, -6.0)}
    settle = {"dW": nrm * 0.6, "f_index": (-6.0, -8.0), "f_middle": (-6.0, -8.0), "f_ring": (-5.0, -6.0),
              "f_pinky": (-4.0, -4.0)}

    def draw(t):
        f = t * (DR - 1)
        rise = R.ease_out_back(min(max(f / 13.0, 0.0), 1.0)) if f > 0 else 0.0
        st = {"laptop_dW": np.array([-3.0, 0.0, -16.0]) * (1 - rise),
              "laptop_rot": (np.array([0.0, 1.0, 0.0]), 28.0 * (1 - rise))}
        op = 0.0 if f < 8 else R.ease_out_back(min((f - 8) / 10.0, 1.0)) * 1.0
        st["open"] = op
        kr = _track(f, [(0, low_hand), (9, low_hand), (19, settle), (24, {}), (DR - 1, {})])
        kl = _track(f, [(0, low_hand), (11, low_hand), (21, settle), (25.5, {}), (DR - 1, {})])
        st["right"] = kr
        st["left"] = mirror_key(kl)
        return vm.pose(st)

    # holster (16 frames, 0.5 s)
    HL = 16

    def holster(t):
        f = t * (HL - 1)
        kr = _track(f, [(0, {}), (3, settle), (11, low_hand), (HL - 1, low_hand)])
        kl = _track(f, [(0, {}), (2, settle), (10, low_hand), (HL - 1, low_hand)])
        op = 1.0 - R.smoothstep(min(max((f - 3) / 6.0, 0.0), 1.0))
        drop = R.smoothstep(min(max((f - 7) / 8.0, 0.0), 1.0))
        st = {"right": kr, "left": mirror_key(kl), "open": op,
              "laptop_dW": np.array([-3.0, 0.0, -16.0]) * drop,
              "laptop_rot": (np.array([0.0, 1.0, 0.0]), 28.0 * drop)}
        return vm.pose(st)

    return [("idle", idle, 60, FPS, True),
            ("draw", draw, DR, FPS, False),
            ("type", type_, 36, FPS, True),
            ("deploy", deploy, D_FR, FPS, False),
            ("holster", holster, HL, FPS, False)]


def build_v(mirror=B.V_MIRROR, skins=SCREEN_SKINS, name="others/v_laptop.mdl", seqs=None):
    vm = VLaptop()
    g = vm.g
    rig = vm.mirrored_rig() if mirror else vm.rig
    flipv = np.array([1.0, -1.0, 1.0])

    def shape(s):
        return s.flip(1) if mirror else s

    def unmirror(fn):
        if not mirror:
            return fn

        def h(P, N, skin):
            return fn(P * flipv, N * flipv, skin)
        return h

    def mesh(m):
        return B.flip_mesh(m) if mirror else m

    # --- shapes (design space)
    base = g.base_sdf()
    lid = g.lid_sdf()
    hr, hl = vm.right.shapes(), vm.left.shapes()
    hand_occ = sdf.union(*[hr[k] for k in ("palm", "thumb", "gcuff", "sleeve")], *[hr[n] for n in FINGER_NAMES],
                         *[hl[k] for k in ("palm", "thumb", "gcuff", "sleeve")], *[hl[n] for n in FINGER_NAMES])
    occ = sdf.union(base, lid, hand_occ)
    lp = LaptopPaint(g, occ=sdf.union(base, lid))
    apr = B.ArmPaint(vm.Lr, occ, vm.right.joints, vm.right.joints["thumb"][1:])
    apl = B.ArmPaint(vm.Ll, occ, vm.left.joints, vm.left.joints["thumb"][1:])
    imgs = ScreenImages()

    b = builder.ModelBuilder(name, rig, skins=skins, verbose=False)
    b.group("laptop", size=(512, 512), pack="skyline")
    b.group("arm", size=(512, 512), pack="skyline")
    add = mdl.STUDIO_NF_ADDITIVE | mdl.STUDIO_NF_FULLBRIGHT
    b.group("glow", size=(256, 256), flags=add, pack="skyline")
    b.group("screen", size=(512, 256), flags=add, pack="skyline")
    b.group("typed", size=(256, 64), flags=add, pack="skyline")
    b.group("rain", size=(128, 256), flags=add, pack="skyline")
    b.group("panel", size=(256, 128), flags=add, pack="skyline")
    # the Enter flash: its own palette (a smooth white-green gradient, no banding against the panel's greens)
    b.group("flash", size=(128, 128), flags=add, pack="skyline")

    def P_(n, shp=None, m=None, **kw):
        paint = kw.pop("paint")
        if not kw.pop("animated", False):
            paint = _memo(paint)
        if m is not None:
            b.add(builder.Part(n, mesh=mesh(m), paint=unmirror(paint), **kw))
        else:
            b.add(builder.Part(n, shape(shp), paint=unmirror(paint), **kw))

    P_("base", m=g.base_mesh(), bone="laptop", paint=lp.base, group="laptop", density=0.9, crease=30)
    P_("lid", m=g.lid_mesh(), bone="lid", paint=lp.lid, group="laptop", density=0.7, crease=30)
    P_("keys", m=g.keys_mesh(), bone="laptop", paint=lp.keycap, group="laptop", density=0.8, crease=40,
       hitbox=False)
    for side, hs, ap in (("r_", hr, apr), ("l_", hl, apl)):
        P_(side + "sleeve", hs["sleeve"], bone=side + "arm", paint=ap.sleeve, group="arm", budget=620, density=0.55)
        P_(side + "gcuff", hs["gcuff"], bone=side + "arm", paint=ap.cuff, group="arm", budget=200, density=0.6)
        P_(side + "palm", hs["palm"], bone=side + "hand", paint=ap.palm, group="arm", budget=600, density=1.3)
        P_(side + "guard", hs["guard"], bone=side + "hand", paint=ap.guard, group="arm", budget=140, density=1.1)
        for n in FINGER_NAMES:
            P_(side + n, hs[n], bones=[side + n + "1", side + n + "2"], paint=ap.finger(n), group="arm",
               budget=170, density=1.3)
        P_(side + "thumb", hs["thumb"], bones=[side + "thumb1", side + "thumb2"], paint=ap.thumb, group="arm",
           budget=170, density=1.3)

    # glow: key legends and the keyboard's backlight
    def legends(P, N, skin):
        k = g.t2k(P)
        out = np.zeros((len(P), 3))
        for label, cx, cy, w, d in KEYS:
            if not label:
                continue
            sel = (np.abs(k[:, 0] - cx) < d / 2) & (np.abs(k[:, 1] - cy) < w / 2)
            if not sel.any():
                continue
            out[sel] = _legend_colour(label, k[sel, 0] - cx, k[sel, 1] - cy, w, d)
        return out

    def backlight(P, N, skin):
        k = g.t2k(P)
        x0, x1, y0, y1 = KB_BOUNDS
        d = np.maximum(np.maximum(x0 - k[:, 0], k[:, 0] - x1), np.maximum(y0 - k[:, 1], k[:, 1] - y1))
        rim = np.exp(-((d + 0.03) / 0.05) ** 2) * 0.9 + np.exp(-np.maximum(d, 0) / 0.08) * (d > 0) * 0.25
        # light between the keys
        gap = np.zeros(len(P))
        for label, cx, cy, w, dd in KEYS:
            e = np.maximum(np.abs(k[:, 0] - cx) - dd / 2, np.abs(k[:, 1] - cy) - w / 2)
            gap = np.maximum(gap, np.exp(-(np.maximum(e, 0) / 0.04) ** 2) * (e > -0.02))
        col = GREEN[None, :] * (rim + 0.35 * gap * (d < 0))[:, None]
        return FX._black_floor(np.clip(col, 0, 1))

    P_("legends", m=g.legends_mesh(), bone="laptop", paint=legends, group="glow", density=1.0, hitbox=False)
    P_("backlight", m=g.backlight_mesh(), bone="laptop", paint=backlight, group="glow", density=0.45,
       hitbox=False)

    # the screen: static layer, typed strip and rain panel (per skin)
    def disp(u0, u1, v0, v1, lz):
        return g.display_quad(DISP_LX1 - v1, DISP_LX1 - v0, DISP_HY - u1, DISP_HY - u0, lz)

    def screen_paint(key_fn):
        def paint(P, N, skin):
            u, v = g.disp_uv(P)
            return sample(imgs.get(key_fn(skin)), u, v, GP)
        return paint

    P_("screen", m=disp(0, DISP_W, 0, DISP_H, 0.010), bone="lid", paint=screen_paint(lambda s: "static"),
       group="screen", hitbox=False)
    tu0, tu1, tv0, tv1 = TYPE_RECT
    P_("typed", m=disp(tu0, tu1, tv0, tv1, 0.016), bone="lid", paint=screen_paint(lambda s: ("typed", s)),
       group="typed", hitbox=False, animated=True)
    ru0, ru1, rv0, rv1 = RAIN_RECT
    P_("rain", m=disp(ru0, ru1, rv0, rv1, 0.016), bone="lid", paint=screen_paint(lambda s: ("rain", s)),
       group="rain", hitbox=False, animated=True)

    # deploy overlays: opaque panel, its text, the bar's segments, ONLINE, three flash levels
    x0, x1, y0, y1 = (v * GP for v in PANEL_PX)
    P_("panel_bg", m=disp(x0, x1, y0, y1, 0.022), bone="panel",
       paint=lambda P, N, s: np.tile(np.array([0.004, 0.018, 0.008]), (len(P), 1)), group="laptop", density=0.05,
       hitbox=False)
    P_("panel_text", m=disp(x0, x1, y0, y1, 0.028), bone="panel", paint=screen_paint(lambda s: "panel"),
       group="panel", hitbox=False)
    bx0, bx1, by0, by1 = BAR_PX
    seg = (bx1 - bx0) / BAR_SEGMENTS
    for i in range(BAR_SEGMENTS):
        u0 = (bx0 + i * seg + 0.5) * GP
        u1 = (bx0 + (i + 1) * seg - 0.5) * GP

        def bar_paint(P, N, s, i=i):
            u, v = g.disp_uv(P)
            k = (v - by0 * GP) / ((by1 - by0) * GP)
            c = T.mix(np.tile(np.array([0.30, 1.0, 0.48]), (len(P), 1)), GREEN_HOT, np.clip(1 - k, 0, 1) * 0.5)
            return c
        P_(f"bar{i}", m=disp(u0, u1, by0 * GP, by1 * GP, 0.034), bone=f"bar{i}", paint=bar_paint, group="panel",
           density=0.3, hitbox=False)
    ox0, ox1, oy0, oy1 = (v * GP for v in ONLINE_PX)
    P_("online", m=disp(ox0, ox1, oy0, oy1, 0.034), bone="online", paint=screen_paint(lambda s: "online"),
       group="panel", hitbox=False)
    for k, name in enumerate(("flash0", "flash1", "flash2")):
        lvl = FLASH_LEVEL[name]

        def flash_paint(P, N, s, lvl=lvl):
            # one soft glow: brightest in the middle, feathered to black at the quad's edges (additive: no rim)
            u, v = g.disp_uv(P)
            r = np.hypot((u - DISP_W / 2) / (DISP_W / 2), (v - DISP_H / 2) / (DISP_H / 2))
            feather = (_sstep(0.0, 1.6, np.minimum(u, DISP_W - u)) * _sstep(0.0, 1.2, np.minimum(v, DISP_H - v)))
            a = lvl * (1.0 - 0.45 * np.clip(r, 0, 1.4) ** 2) * feather
            return np.clip(np.array([0.78, 1.0, 0.82])[None, :] * np.clip(a, 0, 1)[:, None], 0, 1)
        P_(name, m=disp(0.02, DISP_W - 0.02, 0.02, DISP_H - 0.02, 0.040 + 0.004 * k), bone=name, paint=flash_paint,
           group="flash", density=0.08, hitbox=False)

    for s_name, fn, frames, fps, loop in (seqs or v_sequences)(vm):
        pf = (lambda f: (lambda t: B.mirror_pose(f(t))))(fn) if mirror else fn
        b.add_sequence(R.make_sequence(rig, s_name, pf, frames=frames, fps=fps, loop=loop))
    b.eyeposition = (0, 0, 0)
    data = b.write()
    return data, b


LEGEND = {"esc": "esc", "del": "del", "bksp": "<-", "tab": "tab", "caps": "caps", "enter": "enter", "shift": "shift",
          "ctrl": "ctrl", "fn": "fn", "alt": "alt"}


def _legend_colour(label, dx, dy, w, d):
    """Additive legend of a key at offsets (dx towards the hinge, dy left) from its centre."""
    text = LEGEND.get(label, label.upper() if len(label) == 1 else label)
    px = 0.034 if len(text) > 1 else 0.042
    tw = len(text) * CELL_W * px - px
    th = 7 * px
    # text reads left to right (+y to -y) and bottom to top along kx
    if len(text) > 1:
        x0 = w / 2 - 0.07                     # top-left corner of wide keys' text
        u = x0 - dy
        v = (d / 2 - 0.07) - dx
    else:
        u = tw / 2 - dy
        v = th / 2 - dx + 0.02
    ci = np.floor(u / (CELL_W * px)).astype(np.int64)
    gx = np.floor((u - ci * CELL_W * px) / px).astype(np.int64)
    gy = np.floor(v / px).astype(np.int64)
    on = np.zeros(len(dx), dtype=bool)
    for i, ch in enumerate(text):
        gl = G.glyph(ch)
        sel = (ci == i) & (gx >= 0) & (gx < 5) & (gy >= 0) & (gy < 8)
        on[sel] = gl[gy[sel], gx[sel]]
    col = np.zeros((len(dx), 3))
    col[on] = GREEN * 0.95
    return col


# ---------------------------------------------------------------------------------------------
# p_laptop / w_laptop: the closed laptop (lid down), one bone
# ---------------------------------------------------------------------------------------------

def closed_builder(name, g, bone, rig, tex=256):
    base, lid = g.base_sdf(), g.lid_sdf()
    lp = LaptopPaint(g, occ=sdf.union(base, lid), rim=False, level=1.35)
    b = builder.ModelBuilder(name, rig, skins=1, verbose=False)
    b.group("laptop", size=(tex, tex), pack="skyline")
    b.group("glow", size=(128, 128), flags=mdl.STUDIO_NF_ADDITIVE | mdl.STUDIO_NF_FULLBRIGHT, pack="skyline")
    b.add(builder.Part("base", mesh=g.base_mesh(), bone=bone, paint=lp.base, group="laptop", crease=30))
    b.add(builder.Part("lid", mesh=g.lid_mesh(), bone=bone, paint=lp.lid, group="laptop", crease=30))
    # the lid's mark, glowing (additive, just off the lid's back)
    mk = g.mesh_l(quad((LID_L * 0.52 - 1.3, -1.5, -LID_T - 0.006), (2.6, 0, 0), (0, 3.0, 0)))

    def mark_paint(P, N, s):
        q = g.t2l(P)
        col, m = _mark(q[:, 1], q[:, 0] - LID_L * 0.52, 1.5)
        return np.clip(col * m[:, None] * 1.1, 0, 1)
    b.add(builder.Part("mark", mesh=mk, bone=bone, paint=mark_paint, group="glow", hitbox=False))
    # a green status light along the front edge (reads in dark corners)
    led = quad((-DECK_X - 0.004, 1.2, -0.30), (0, -2.4, 0), (0, 0, 0.12))
    led = g.mesh_k(led)

    def led_paint(P, N, s):
        k = g.t2k(P)
        a = np.clip(1 - np.abs(k[:, 1]) / 1.2, 0, 1) ** 0.5 * np.clip(1 - np.abs(k[:, 2] + 0.24) / 0.06, 0, 1)
        return GREEN[None, :] * a[:, None]
    b.add(builder.Part("led", mesh=led, bone=bone, paint=led_paint, group="glow", hitbox=False))
    return b


def build_w():
    """On the ground, the opening edge facing +x, origin on the floor under its centre."""
    Rk = xform.rot_deg(0, 0, 180)
    g = LaptopGeom(Rk, (0.0, 0.0, DECK_T), open_deg=180.0)
    rig = R.Rig()
    rig.add("laptop", None, (0, 0, 0), tail=(0, 0, DECK_T))
    b = closed_builder("others/w_laptop.mdl", g, "laptop", rig)
    b.add_sequence(R.make_sequence(rig, "idle", lambda t: R.Pose(), frames=1, fps=10, loop=True,
                                   activity=mdl.ACT["IDLE"]))
    b.hull = ((-DECK_X, -DECK_Y, 0.0), (DECK_X, DECK_Y, DECK_T + 0.4))
    b.eyeposition = (0, 0, 1)
    return b.write()


# Carried hanging from the fist by its short edge, in the player models' right hand bone frame.  Measured in game
# (chase cam, the "grenade" pose these weapons use, with axis sticks on the bone): +x along the hand (towards the
# fingers) points up and forward, +z (back of the hand) up and back, +y across the hand towards the body, so
# e_up = (x + z) / sqrt 2 is about vertical and e_fwd = (x - z) / sqrt 2 points ahead of the player.  The slab's
# long side (ky) runs along e_up, its depth (kx) across the hand (y), the lid (kz) facing ahead; its top edge sits
# in the fist and the rest hangs below, just in front of the palm.  Checked from the back, side and front on a CT.
P_SCALE = 0.9
P_CENTER = (0.67, 0.8, -4.27)
_R2 = math.sqrt(0.5)
P_AXES = ((0.0, 1.0, 0.0), (_R2, 0.0, _R2), (_R2, 0.0, -_R2))


def build_p(center=None, scale=None, axes=None):
    s = P_SCALE if scale is None else scale
    Rk = np.stack([np.asarray(a, dtype=np.float64) for a in (axes or P_AXES)], axis=1)
    P_center = P_CENTER if center is None else center
    # K origin so that the closed slab's middle (kz ~ 0.0) lies at the centre (geometry scaled about it below)
    g = LaptopGeom(Rk * 1.0, (0.0, 0.0, 0.0), open_deg=180.0)
    rig = R.Rig()
    rig.add(B.P_BONE, None, (0, 0, 0), tail=P_center)
    b = closed_builder("others/p_laptop.mdl", g, B.P_BONE, rig, tex=128)
    c = np.asarray(P_center, dtype=np.float64)
    for part in b.parts:
        # scale and place the parts' geometry (meshes, or SDFs meshed first)
        if part.mesh is None:
            part.mesh = M.mesh_sdf(part.shape, budget=part.budget)
            part.shape = None
        m = part.mesh
        part.mesh = M.TriMesh(m.verts * s + c, m.faces)
        fn = part.paint
        part.paint = (lambda f: (lambda P, N, sk: f((P - c) / s, N, sk)))(fn)
    b.add_sequence(R.make_sequence(rig, "idle", lambda t: R.Pose(), frames=1, fps=10, loop=True,
                                   activity=mdl.ACT["IDLE"]))
    return b.write()


def build(out):
    out["models/others/v_laptop.mdl"] = build_v()[0]
    out["models/others/p_laptop.mdl"] = build_p()
    out["models/others/w_laptop.mdl"] = build_w()
    out.update(sprites())
    out.update(sounds())


# ---------------------------------------------------------------------------------------------
# effect sprites (sprites/others/): additive, exact palette black outside their window (fx.py's rule)
# ---------------------------------------------------------------------------------------------

def _glyph_into(img, g, x, y, col, px=2, rows=7):
    """Stamp a glyph (rows x 5, px texels per glyph pixel) into img (H, W, 3) at (x, y), additive max."""
    H, Wd = img.shape[:2]
    for gy in range(rows):
        for gx in range(5):
            if g[gy, gx]:
                y0, x0 = y + gy * px, x + gx * px
                if 0 <= y0 and y0 + px <= H and 0 <= x0 and x0 + px <= Wd:
                    img[y0:y0 + px, x0:x0 + px] = np.maximum(img[y0:y0 + px, x0:x0 + px], col)


def make_coderain(frames=12, w=64, h=256, seed=7101):
    """Falling code columns for one TE_EXPLOSION (played once, ~12 fps): four columns of mirrored katakana and
    digits; each column's drop enters from the top (staggered), falls 2.4-3.4 rows a frame (a second drop follows) with a white-green head
    and a fading green tail, and has left (or faded) by the last frame.  Black outside x 8..56 and in the top and
    bottom 6 % (the window)."""
    rng = np.random.default_rng(seed)
    alpha = G.rain_glyphs()
    cw, ch = 12, 16                     # cell (2 texels per glyph pixel)
    cols = 4
    x0 = (w - cols * cw) // 2
    rows = h // ch
    drops = []
    for c in range(cols):
        first = rng.uniform(-4, 4)
        for k in range(2):
            drops.append((c, first - k * rng.uniform(9, 15), rng.uniform(2.4, 3.4),
                          int(rng.integers(6, 12)), rng.uniform(0.7, 1.0)))
    ids = rng.integers(0, len(alpha), size=(cols, rows))
    flick = rng.random((frames, cols, rows)) < 0.25
    fl_ids = rng.integers(0, len(alpha), size=(frames, cols, rows))
    yy = (np.arange(h) + 0.5) / h
    win_v = FX._smooth(0.0, 0.10, yy) * FX._smooth(1.0, 0.88, yy)
    out = []
    for f in range(frames):
        img = np.zeros((h, w, 3))
        fade = min(1.0, (f + 1) / 2.0) * min(1.0, (frames - f) / 3.0)
        for c, start, speed, tail, br in drops:
            head = int(math.floor(start + speed * f))
            for k in range(tail + 1):
                r = head - k
                if not (0 <= r < rows):
                    continue
                gi = fl_ids[f, c, r] if flick[f, c, r] else ids[c, r]
                b = br * (1.0 - k / (tail + 1)) ** 1.3 * fade
                col = (np.array([0.85, 1.0, 0.88]) if k == 0 else GREEN * np.array([0.55, 1.0, 0.70])) * b
                _glyph_into(img, alpha[gi], x0 + c * cw + 1, r * ch + 1, col)
        img = np.clip(img + _blur(img, 2.0) * 0.45, 0, 1) * win_v[:, None, None]
        img[:4] = 0
        img[h - 4:] = 0
        img[:, :x0 - 4] = 0
        img[:, w - x0 + 4:] = 0
        out.append(FX._black_floor(img))
    return out


def make_codebeam(frames=8, w=64, h=256, seed=7201):
    """Hack beam texture (u across the beam, v along it, tileable along v): a green core with a white-hot spine
    and five lanes of data bits (dashes of 1-6 texels' runs, brighter "packets") in bands across u, as a stream
    of code seen stretched along the beam.  Black from 85 % of the half-width out (across u only)."""
    rng = np.random.default_rng(seed)
    u = (np.arange(w) + 0.5) / w * 2 - 1
    edge = FX._smooth(FX.WINDOW_END, 0.55, np.abs(u))
    lanes = [(-0.50, 0.10, 0.55), (-0.25, 0.10, 0.85), (0.0, 0.12, 1.0), (0.25, 0.10, 0.85), (0.50, 0.10, 0.55)]
    out = []
    for f in range(frames):
        img = np.zeros((h, w, 3))
        core = np.exp(-(u / 0.20) ** 2)
        spine = np.exp(-(u / 0.06) ** 2)
        img += core[None, :, None] * GREEN * 0.45 + spine[None, :, None] * np.array([0.8, 1.0, 0.85]) * 0.55
        for lc, lw, lb in lanes:
            band = np.exp(-((u - lc) / (lw * 0.5)) ** 2)
            bits = np.zeros(h)
            y = int(rng.integers(0, 4))
            while y < h:
                run = int(rng.integers(1, 7))
                if rng.random() < 0.55:
                    bits[y:y + run] = rng.uniform(0.5, 1.0)
                y += run + int(rng.integers(1, 4))
            # bright packets
            for _ in range(3):
                y0 = int(rng.integers(0, h))
                L = int(rng.integers(6, 16))
                idx = np.arange(y0, y0 + L) % h
                bits[idx] = np.maximum(bits[idx], 1.2)
            img += bits[:, None, None] * band[None, :, None] * GREEN * lb * 0.9
        img = 1.0 - np.exp(-img * 1.5)
        img *= edge[None, :, None]
        out.append(FX._black_floor(np.clip(img, 0, 1)))
    return out


def make_pixels(frames=8, n=32, seed=7301):
    """Square pixel bits (TE_SPRAY particles: one random static frame each): 3-6 hard-edged squares of 2-5 whole
    texels that never touch each other, green with one white-green, a faint glow around them (never over a
    square); every frame stands alone, a little sparser further on.  Black in the outer 4 texels."""
    rng = np.random.default_rng(seed)
    m = 5                                   # squares stay inside [m, n - m)
    out = []
    for f in range(frames):
        sq = np.zeros((n, n, 3))
        used = np.zeros((n, n), dtype=bool)  # squares plus a 1-texel gap around them
        k = int(rng.integers(3, 7)) - (1 if f >= 5 else 0)
        placed = 0
        for _ in range(200):
            if placed == k:
                break
            sz = int(rng.integers(2, 6))
            cx, cy = (int(v) for v in rng.integers(m, n - m - sz + 1, 2))
            if np.hypot(cx + sz / 2 - n / 2, cy + sz / 2 - n / 2) > n * 0.36:
                continue
            if used[max(cy - 1, 0):cy + sz + 1, max(cx - 1, 0):cx + sz + 1].any():
                continue
            col = np.array([0.82, 1.0, 0.86]) if placed == 0 else GREEN * rng.uniform(0.6, 1.0)
            sq[cy:cy + sz, cx:cx + sz] = col
            used[cy:cy + sz, cx:cx + sz] = True
            placed += 1
        glow = _blur(sq, 1.4) * 0.30
        img = np.where(used[..., None], sq, np.maximum(sq, glow))
        img[:m - 1] = 0
        img[n - m + 1:] = 0
        img[:, :m - 1] = 0
        img[:, n - m + 1:] = 0
        out.append(FX._black_floor(np.clip(img, 0, 1)))
    return out


def make_glitch(frames=8, n=64, seed=7401):
    """Glitch flicker: horizontal slices of code and blocks shifted sideways, green with cyan / magenta
    fringes (a chromatic split), scanlines; a different tear each frame.  Rectangular: every slice ends at
    its own ragged left / right edge (no round fade); black in the outer 3 texels."""
    rng = np.random.default_rng(seed)
    alpha = G.rain_glyphs()
    mg = 3
    out = []
    for f in range(frames):
        base = np.zeros((n, n))
        for r in range(0, n, 9):
            for c in range(0, n, 6):
                if rng.random() < 0.55:
                    g = alpha[int(rng.integers(0, len(alpha)))]
                    base[r:r + 7, c:c + 5] = np.maximum(base[r:r + 7, c:c + 5], g[:7, :5][:n - r, :n - c])
        # blocks
        for _ in range(4):
            bw, bh = rng.integers(8, 30), rng.integers(3, 9)
            bx, by = rng.integers(0, n - bw), rng.integers(0, n - bh)
            base[by:by + bh, bx:bx + bw] = np.maximum(base[by:by + bh, bx:bx + bw], rng.uniform(0.4, 0.9))
        # tear: slices shifted, each cut to its own ragged extent (some slices dropped out)
        sl = np.zeros_like(base)
        xs = np.arange(n)
        yb = 0
        while yb < n:
            hgt = int(rng.integers(2, 10))
            if rng.random() < 0.85:
                a = int(rng.integers(mg, n // 3))
                b = int(rng.integers(2 * n // 3, n - mg + 1))
                keep = ((xs >= a) & (xs < b)).astype(float)
                sl[yb:yb + hgt] = np.roll(base[yb:yb + hgt], int(rng.integers(-12, 13)), axis=1) * keep[None, :]
            yb += hgt
        scan = np.where(np.arange(n) % 2 == 0, 1.0, 0.6)[:, None]
        g = sl * scan
        img = np.zeros((n, n, 3))
        img += g[..., None] * GREEN * 0.9
        right = np.clip(np.roll(g, 2, axis=1) - g, 0, 1)        # the split: cyan fringe on one side,
        left = np.clip(np.roll(g, -2, axis=1) - g, 0, 1)        # magenta on the other
        img[..., 1] += right * 0.5
        img[..., 2] += right * 0.7
        img[..., 0] += left * 0.6
        img[..., 2] += left * 0.5
        img = np.clip(img, 0, 1)
        img[:mg] = 0
        img[n - mg:] = 0
        img[:, :mg] = 0
        img[:, n - mg:] = 0
        out.append(FX._black_floor(img))
    return out


def _rect_dark(n, margin):
    m = np.zeros((n, n), dtype=bool)
    m[:margin] = True
    m[n - margin:] = True
    m[:, :margin] = True
    m[:, n - margin:] = True
    return m


def holo_paint(P, N, skin=0, spacing=2.0, line=0.12, colour=(0.25, 1.0, 0.45)):
    """Hologram / wireframe look for a model's skin (model-space points P): a green grid of horizontal rings
    every `spacing` units and vertical lines by azimuth, on a dim green fill; meant for an additive texture."""
    P = np.asarray(P, dtype=np.float64)
    z = P[:, 2] / spacing
    az = np.arctan2(P[:, 1], P[:, 0]) * 12 / np.pi
    dz = np.abs(z - np.round(z)) * spacing
    da = np.abs(az - np.round(az)) * spacing
    ln = np.maximum(T.edge(dz - line, 0.04), T.edge(da - line, 0.04))
    c = np.asarray(colour)
    return np.clip(c[None, :] * (0.18 + 0.82 * ln)[:, None], 0, 1)


def _vdark(w, h, margin):
    m = np.zeros((h, w), dtype=bool)
    m[:, :margin] = True
    m[:, w - margin:] = True
    m[:3] = True
    m[h - 3:] = True
    return m


def sprites():
    out = {}
    out["sprites/others/coderain.spr"] = FX._additive_sprite(make_coderain(), type=spr.VP_PARALLEL_UPRIGHT,
                                                             dark=_vdark(64, 256, 3))
    out["sprites/others/codebeam.spr"] = FX._additive_sprite(make_codebeam(), dark=FX._outside(64, 256, across=True))
    out["sprites/others/pixels.spr"] = FX._additive_sprite(make_pixels(), dark=_rect_dark(32, 4))
    out["sprites/others/glitch.spr"] = FX._additive_sprite(make_glitch(), dark=_rect_dark(64, 3))
    return out


# ---------------------------------------------------------------------------------------------
# sounds (sound/others/, 22050 Hz mono 16-bit)
# ---------------------------------------------------------------------------------------------

def _key_click(seed, heavy=0.0):
    """One key: a bright plastic tick (bottoming out), a short low 'thock', a release tick."""
    rng = np.random.default_rng(seed)
    dur = 0.07
    n = W._n(dur)
    tick = FX._burst(0.012, 2200, 7500, seed, decay=0.0025)
    f = rng.uniform(260, 380) * (1 - 0.3 * heavy)
    thock = W.osc(W.glide(f * 1.25, f, 0.05)) * W.env_exp(W._n(0.05), decay=0.012 + 0.01 * heavy, attack=0.0008)
    body = W.bandpass(W.noise(0.04, "pink", seed + 1), rng.uniform(900, 1500), 2.0) * W.env_exp(W._n(0.04), 0.008)
    rel = FX._burst(0.008, 3000, 8000, seed + 2, decay=0.0018)
    x = W.mix((tick, 0, 0.9), (thock, 0.001, 0.55 + 0.3 * heavy), (W.normalize(body, 1), 0, 0.25),
              (rel, rng.uniform(0.045, 0.06), 0.25))
    return x[:n] if len(x) > n else x


def snd_laptop_type():
    """~1.2 s of fast typing on a laptop keyboard: 15 keys a second in bursts, a space bar now and then."""
    rng = np.random.default_rng(8101)
    parts = []
    t = 0.02
    i = 0
    while t < 1.12:
        heavy = 1.0 if rng.random() < 0.12 else 0.0
        parts.append((_key_click(8200 + i, heavy), t, rng.uniform(0.55, 1.0) * (1.25 if heavy else 1.0)))
        gap = rng.uniform(0.035, 0.085)
        if rng.random() < 0.10:
            gap += rng.uniform(0.05, 0.12)            # a pause between words
        t += gap
        i += 1
    x = W.mix(*parts, (W.silence(1.2), 0, 0))
    return W.finish(W.reverb(x, room=0.15, wet=0.06, tail=0.08), fade_out=0.02, trim=False)[:W._n(1.2)]


def snd_laptop_enter():
    """The Enter slam: a heavy clack with a rattle, then a short two-note digital 'run' chirp."""
    clack = _key_click(8301, heavy=1.0)
    slam = W.osc(W.glide(160, 70, 0.08)) * W.env_exp(W._n(0.08), decay=0.025)
    rattle = FX._clicks(0.05, 300, 8302, decay=0.0012, lo=2500)
    bip1 = FX._bl(np.full(W._n(0.05), 1318.5), "square") * W.env_points([(0, 0), (0.003, 1), (0.05, 0)], W._n(0.05))
    bip2 = FX._bl(np.full(W._n(0.08), 1975.5), "square") * W.env_points([(0, 0), (0.003, 1), (0.08, 0)], W._n(0.08))
    x = W.mix((clack, 0, 1.0), (slam, 0, 0.9), (W.normalize(rattle, 1), 0.01, 0.2),
              (W.lowpass(bip1, 5000), 0.09, 0.18), (W.lowpass(bip2, 5000), 0.15, 0.2))
    return W.finish(W.reverb(x, room=0.25, wet=0.1, tail=0.12), fade_out=0.04)


def _chirps(dur, rate, lo, hi, seed, scale=(0, 3, 5, 7, 10), base=880.0, length=(0.02, 0.05)):
    """Data chirps: short square/sine blips at random times on a pentatonic grid between lo and hi Hz."""
    rng = np.random.default_rng(seed)
    n = W._n(dur)
    out = np.zeros(n)
    t = 0.0
    notes = [base * 2 ** ((o * 12 + s) / 12) for o in range(-2, 4) for s in scale]
    notes = [f for f in notes if lo <= f <= hi]
    while True:
        t += rng.exponential(1.0 / rate)
        if t >= dur:
            break
        f = notes[int(rng.integers(0, len(notes)))]
        L = rng.uniform(*length)
        m = W._n(L)
        src = FX._bl(np.full(m, f), "square") * 0.6 + W.osc(f, L) * 0.4
        e = W.env_points([(0, 0), (0.002, 1), (L * 0.6, 0.6), (L, 0)], m)
        i = W._n(t)
        k = min(m, n - i)
        out[i:i + k] += (src * e)[:k] * rng.uniform(0.4, 1.0)
    return out


def snd_lem_materialize():
    """~1.5 s: a rising, opening synth (two detuned band-limited saws gliding 110 -> 660 Hz through a sweeping
    filter), data chirps getting denser and higher, a bit-crushed noise riser, then a bright chime and a soft
    low thump as the body 'compiles'."""
    dur = 1.45
    n = W._n(dur)
    f0 = W.glide(110, 660, 1.2, "ease")
    f0 = np.concatenate([f0, np.full(n - len(f0), 660.0)])
    synth = FX._bl(f0, "saw") + FX._bl(f0 * 1.007, "saw") + 0.5 * FX._bl(f0 * 0.5, "square")
    cut = np.interp(np.arange(n) / W.RATE, [0, 1.1, 1.25, dur], [300, 4200, 5200, 2500])
    synth = W.svf(synth, cut, 2.2, "low")
    synth *= W.env_points([(0, 0), (0.25, 0.6), (1.18, 1.0), (1.3, 0.6), (dur, 0)], n)
    synth = W.tremolo(synth, 16, 0.25)
    ch1 = _chirps(1.15, 9, 700, 2600, 8401)
    ch2 = _chirps(0.85, 20, 1500, 5000, 8402)
    riser = W.bitcrush(W.noise(1.15, "white", 8403), bits=4, hold=6)
    riser = W.svf(riser, np.linspace(800, 6000, W._n(1.15)), 1.5, "band") * np.linspace(0, 1, W._n(1.15)) ** 2
    chime = FX._bell(1567.98, 0.6, 0.35) + 0.7 * FX._bell(2349.3, 0.6, 0.3)
    thump = W.osc(W.glide(90, 45, 0.25)) * W.env_exp(W._n(0.25), decay=0.07)
    x = W.mix((W.normalize(synth, 1), 0, 0.55), (W.normalize(ch1, 1), 0.05, 0.22), (W.normalize(ch2, 1), 0.35, 0.18),
              (W.normalize(riser, 1), 0.05, 0.16), (chime, 1.18, 0.35), (thump, 1.19, 0.45))
    return W.finish(W.reverb(x, room=0.5, wet=0.2, tail=0.25), fade_out=0.15)


def _stutter(x, seed, slice_=0.022, prob=0.45):
    """Digital stutter: some slices repeat the previous one (a buffer glitch), some jump an octave."""
    rng = np.random.default_rng(seed)
    m = W._n(slice_)
    out = x.copy()
    for i in range(m, len(x) - m, m):
        r = rng.random()
        if r < prob:
            out[i:i + m] = out[i - m:i]
        elif r < prob + 0.15:
            seg = x[i:i + 2 * m]
            out[i:i + m] = W.speed(seg, 2.0)[:m] if len(seg) >= 2 * m else out[i:i + m]
    return out


def snd_lem_glitch():
    """~0.4 s glitch: a bit-crushed square tone hopping between pitches, stuttered, with static ticks."""
    rng = np.random.default_rng(8501)
    seg = []
    for k in range(8):
        f = rng.choice([220, 330, 440, 660, 880, 1320])
        seg.append(FX._bl(np.full(W._n(0.05), float(f)), "square"))
    tone = np.concatenate(seg)
    tone = W.bitcrush(tone * 0.8, bits=3, hold=3)
    st = _stutter(tone, 8502)
    ticks = FX._clicks(0.4, 60, 8503, decay=0.0008, lo=3000)
    x = W.mix((W.lowpass(st, 6000), 0, 0.6), (W.normalize(ticks, 1), 0, 0.3))
    x *= W.env_points([(0, 0), (0.005, 1), (0.3, 0.8), (0.4, 0)], len(x))
    return W.finish(x, fade_out=0.03)


def snd_lem_hack():
    """Hack: a digital zap (a fast falling FM sweep), a burst of random data bits (sample-and-hold square at
    ~2 kHz), crackle and a short bit-crushed tail (~0.55 s)."""
    rng = np.random.default_rng(8601)
    dur = 0.55
    n = W._n(dur)
    car = W.glide(2400, 300, 0.25, "exp")
    mod = W.osc(np.asarray(car) * 1.5) * 600
    sweep = W.osc(np.asarray(car) + mod) * W.env_exp(len(car), decay=0.09, attack=0.001)
    bits = np.repeat(rng.choice([-1.0, 1.0], size=n // 11 + 1), 11)[:n]
    bits = W.bandpass(bits, 2000, 1.2) * W.env_points([(0, 0), (0.01, 1), (0.3, 0.5), (dur, 0)], n)
    crack = FX._burst(0.04, 800, None, 8602, decay=0.01)
    tail = W.bitcrush(W.osc(W.glide(600, 120, 0.3)) * W.env_exp(W._n(0.3), decay=0.1), bits=4, hold=4)
    x = W.mix((sweep, 0, 0.8), (W.normalize(bits, 1), 0, 0.4), (crack, 0, 0.7), (tail, 0.2, 0.35))
    return W.finish(W.distort(x, 1.4), fade_out=0.05)


def snd_lem_hurt():
    """Hurt 'glitch': a short stuttered, distorted falling blip (no voice)."""
    f = W.glide(900, 260, 0.22, "exp")
    x = FX._bl(f, "square") * W.env_points([(0, 0), (0.004, 1), (0.22, 0)], len(f))
    x = _stutter(W.bitcrush(x * 0.8, bits=4, hold=2), 8701, slice_=0.018, prob=0.5)
    noise = FX._burst(0.05, 2000, None, 8702, decay=0.015)
    return W.finish(W.distort(W.mix((W.lowpass(x, 6500), 0, 0.8), (noise, 0, 0.4)), 1.6), fade_out=0.03)


def snd_lem_die():
    """De-rezz (~1.3 s): a falling chord crushed to fewer and fewer bits and a dropping sample rate, falling
    data chirps scattering away, a fading static wash."""
    dur = 1.3
    n = W._n(dur)
    f = W.glide(880, 110, dur, "exp")
    chord = FX._bl(f, "saw") + 0.6 * FX._bl(np.asarray(f) * 1.5, "square") + 0.4 * FX._bl(np.asarray(f) * 2.01, "saw")
    chord = W.normalize(W.lowpass(chord, 6000), 1) * W.env_points([(0, 0), (0.02, 1), (0.30, 0.55), (0.85, 0.22), (dur, 0)], n)
    out = np.zeros(n)
    k = W._n(0.1)
    for i in range(0, n, k):
        prog = i / n
        bits = int(round(8 - 6 * prog))
        hold = int(1 + 10 * prog)
        out[i:i + k] = W.bitcrush(chord[i:i + k], bits=max(bits, 2), hold=hold)[:len(out[i:i + k])]
    ch = _chirps(1.0, 18, 400, 4000, 8801)
    ch = ch * np.linspace(1, 0, len(ch)) ** 1.5
    wash = W.bandpass(W.noise(dur, "white", 8802), 3500, 0.8) * W.env_points([(0, 0), (0.1, 0.7), (dur, 0)], n)
    x = W.mix((W.lowpass(out, 7000), 0, 0.6), (W.normalize(ch, 1), 0.05, 0.25), (W.normalize(wash, 1), 0, 0.15))
    return W.finish(W.reverb(x, room=0.5, wet=0.2, tail=0.3), fade_out=0.15)


SOUNDS = {"laptop_type": (snd_laptop_type, -13.0), "laptop_enter": (snd_laptop_enter, -10.0),
          "lem_materialize": (snd_lem_materialize, -9.0), "lem_glitch": (snd_lem_glitch, -11.0),
          "lem_hack": (snd_lem_hack, -7.0), "lem_hurt": (snd_lem_hurt, -10.0), "lem_die": (snd_lem_die, -11.0)}


def sounds():
    out = {}
    for k, (fn, db) in SOUNDS.items():
        x = FX._level(fn(), db, max_limit_db=10.0)
        out[f"sound/others/{k}.wav"] = W.write(x, W.RATE, 16)
    return out
