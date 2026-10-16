"""Poke Balls: models/pokemon/w_pokeball.mdl (world / thrown), p_pokeball.mdl (third person, merged on the
player's right hand) and v_pokeball.mdl (first person: gloved hand and sleeved forearm holding the ball).

Skins (all three models): 0 Pikachu (yellow), 1 Charizard (orange), 2 Blastoise (blue): the stripe in the
black band, the button's glow and the emblem on the top cap (bolt, flame, drop) change; the rest is shared.

The ball is made of surfaces of revolution (exact spheres, crisp band step and button rings), the hand and
the sleeve of smooth SDF shapes.  The view model is authored LEFT-handed on the left of the view, because the
Counter-Strike client mirrors every view model across y while cl_righthand is 1 (its default,
cl_dll/StudioModelRenderer.cpp), like the stock CS view models; it appears right-handed in game.
"""
import math

import numpy as np

from .. import builder, mdl, mesh as M, rig as R, sdf, texture as T, xform

# ---------------------------------------------------------------------------------------------
# palette
# ---------------------------------------------------------------------------------------------

RED = T.rgb("#d0202a")
RED_DARK = T.rgb("#7c0d16")
WHITE = T.rgb("#eeeeea")
WHITE_SHADOW = T.rgb("#a9adb8")
BAND = T.rgb("#151518")
RING = T.rgb("#1b1b1f")
INSIDE = T.rgb("#d9d6cc")

# per skin: (name, main colour, light colour, dark outline)
SPECIES = [
    ("pikachu", T.rgb("#ffd21a"), T.rgb("#fff3a0"), T.rgb("#5a3a00")),
    ("charizard", T.rgb("#ff7417"), T.rgb("#ffd36a"), T.rgb("#4a1300")),
    ("blastoise", T.rgb("#2f8dff"), T.rgb("#a9e2ff"), T.rgb("#06214a")),
]


# ---------------------------------------------------------------------------------------------
# geometry helpers
# ---------------------------------------------------------------------------------------------

def lathe(profile, n, R_=None, t=None):
    """Surface of revolution about +z: profile [(rho, z), ...] walking the cross-section boundary with the
    solid on its right (down the outer side).  An end on the axis (rho 0) closes with a pole fan, else the
    surface stays open there (a cup's inner surface can be a separate part).  Returns a TriMesh with outward
    counter-clockwise faces, rotated by R_ and translated by t."""
    prof = [(float(r), float(z)) for r, z in profile]
    pole0, pole1 = prof[0][0] == 0.0, prof[-1][0] == 0.0
    rings = prof[(1 if pole0 else 0):(len(prof) - 1 if pole1 else len(prof))]
    phi = np.arange(n) * 2 * math.pi / n
    nr = len(rings)
    off = 1 if pole0 else 0
    verts = [(0.0, 0.0, prof[0][1])] if pole0 else []
    for r, z in rings:
        verts.extend(np.stack([r * np.cos(phi), r * np.sin(phi), np.full(n, z)], 1).tolist())
    if pole1:
        verts.append((0.0, 0.0, prof[-1][1]))
    faces = []

    def vid(i, j):
        return off + i * n + (j % n)

    if pole0:
        for j in range(n):
            faces.append((0, vid(0, j), vid(0, j + 1)))
    for i in range(nr - 1):
        for j in range(n):
            a, b, c, d = vid(i, j), vid(i + 1, j), vid(i, j + 1), vid(i + 1, j + 1)
            faces.append((a, b, c))
            faces.append((b, d, c))
    if pole1:
        last = off + nr * n
        for j in range(n):
            faces.append((vid(nr - 1, j), last, vid(nr - 1, j + 1)))
    m = M.TriMesh(np.array(verts), np.array(faces))
    if R_ is not None or t is not None:
        m = m.transformed(R_, t)
    return m


def arc(r, a0, a1, steps, z0=0.0):
    """Points (rho, z) on a circle of radius r centred on the axis at z0, angles from the +z axis (deg)."""
    return [(r * math.sin(math.radians(a)), z0 + r * math.cos(math.radians(a)))
            for a in np.linspace(a0, a1, steps + 1)]


def frame_to(d):
    """Rotation whose +z goes to direction d."""
    d = np.asarray(d, dtype=np.float64)
    d = d / np.linalg.norm(d)
    return R._align((0.0, 0.0, 1.0), d)


def frame_from(x, other, z_is_second=True):
    """Rotation with +x along x and +z along `other` made orthogonal to it (columns x, y, z)."""
    x = np.asarray(x, dtype=np.float64)
    x = x / np.linalg.norm(x)
    z = np.asarray(other, dtype=np.float64)
    z = z - x * (z @ x)
    z = z / np.linalg.norm(z)
    return np.stack([x, np.cross(z, x), z], axis=1)


def flip_mesh(m, axis=1):
    """Mirror image of a mesh (winding fixed so faces stay outward)."""
    v = m.verts.copy()
    v[:, axis] = -v[:, axis]
    return M.TriMesh(v, m.faces[:, ::-1].copy())


def split_annuli(m, r):
    """(rest, rings): the flat rings of a ball-frame lathe (the band's steps and the cups' lips, normal along
    the axis, far from it) apart from the rest.  A ring's box chart is a whole disc of empty atlas around a
    thin line, so the rings get their own low-density part."""
    v = m.verts[m.faces]
    n = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    rho = np.linalg.norm(v.mean(axis=1)[:, :2], axis=1)
    ring = (np.abs(n[:, 2]) > 0.9) & (rho > 0.6 * r)
    return M.TriMesh(m.verts, m.faces[~ring]).compact(), M.TriMesh(m.verts, m.faces[ring]).compact()


def signed_volume(m):
    v = m.verts[m.faces]
    return float(np.einsum("ij,ij->i", v[:, 0], np.cross(v[:, 1], v[:, 2])).sum() / 6.0)


# ---------------------------------------------------------------------------------------------
# the ball, in its own frame: centre at the origin, +z up (top cap), +x the button, hinge at -x
# ---------------------------------------------------------------------------------------------

class BallSpec:
    """Proportions of a ball of radius r (shared by the three models)."""

    def __init__(self, r, n=32, arc_steps=9):
        self.r = r
        self.n = n
        self.arc_steps = arc_steps
        self.g = 0.10 * r             # half height of the black band
        self.rb = r - 0.035 * r       # band radius (recessed step)
        self.ri = r - 0.11 * r        # inner surface radius (cups)
        self.ring_r = 0.30 * r        # black ring around the button (on the sphere)
        self.btn_r = 0.185 * r        # white button
        self.btn_h = 0.075 * r        # ring protrusion above the sphere
        self.btn_dome = 0.05 * r      # dome of the white button above the ring

    def solid(self):
        """Closed ball (held models): red cap, recessed black band, white bottom."""
        r, g, rb = self.r, self.g, self.rb
        a_band = math.degrees(math.acos(g / r))
        prof = arc(r, 0, a_band, self.arc_steps)
        prof += [(rb, g), (rb, -g)]
        prof += arc(r, 180 - a_band, 180, self.arc_steps)
        prof[-1] = (0.0, -r)
        return lathe(prof, self.n)

    def cups(self, inner_steps=4):
        """Two hollow halves (world model, opens) meeting at z = 0: (top outer, top inner, bottom outer,
        bottom inner) surfaces; each outer/inner pair shares its lip ring (no crack, two texture densities)."""
        r, g, rb, ri = self.r, self.g, self.rb, self.ri
        a_band = math.degrees(math.acos(g / r))
        lip = 0.004 * r
        a_in = math.degrees(math.acos(lip / ri))
        top = arc(r, 0, a_band, self.arc_steps) + [(rb, g), (rb, lip), (ri * math.sin(math.radians(a_in)), lip)]
        top_in = arc(ri, a_in, 0, inner_steps)
        top_in[-1] = (0.0, ri)
        bot_in = arc(ri, 180, 180 - a_in, inner_steps)
        bot_in[0] = (0.0, -ri)
        bot = [bot_in[-1], (rb, -lip), (rb, -g)] + arc(r, 180 - a_band, 180, self.arc_steps)
        bot[-1] = (0.0, -r)
        return lathe(top, self.n), lathe(top_in, self.n), lathe(bot, self.n), lathe(bot_in, self.n)

    def button(self, n=20):
        """Button on +x: black ring (sunk into the sphere) carrying the white domed button."""
        r = self.r
        h_ring = self.btn_h
        rr = self.ring_r * 0.92
        br = self.btn_r
        rr_base = math.sqrt(max(r * r - rr * rr, 0.0))
        e = 0.18 * h_ring
        prof = [(0.0, r + h_ring + self.btn_dome)]
        prof += [(br * math.sin(math.radians(a)), r + h_ring + self.btn_dome * math.cos(math.radians(a)))
                 for a in (30, 60, 90)][:-1]
        prof += [(br, r + h_ring + 0.01 * r), (br * 1.06, r + h_ring - 0.02 * r), (rr - e, r + h_ring),
                 (rr, r + h_ring - e), (rr, rr_base - 0.12 * r), (0.0, rr_base - 0.12 * r)]
        return lathe(prof, n, R_=frame_to((1, 0, 0)))

    def glow_disc(self, z, radius, thick, n=24, up=True):
        """Thin lens (additive light) lying in the plane z."""
        s = 1 if up else -1
        prof = [(0.0, z + s * thick)] + [(radius * math.sin(math.radians(a)), z + s * thick * math.cos(math.radians(a)))
                                         for a in (35, 70)]
        prof += [(radius, z), (0.0, z - s * 0.0001)]
        if not up:
            prof = [(0.0, z + 0.0001)] + [(radius, z)] + [(radius * math.sin(math.radians(a)),
                                                           z - thick * math.cos(math.radians(a))) for a in (70, 35)]
            prof += [(0.0, z - thick)]
        return lathe(prof, n)

    def button_glow(self, n=16):
        """Additive cap just over the white button (species glow)."""
        r = self.r
        z0 = r + self.btn_h + 0.012 * r
        br = self.btn_r * 0.98
        prof = [(0.0, z0 + self.btn_dome + 0.004 * r)]
        prof += [(br * math.sin(math.radians(a)), z0 + self.btn_dome * math.cos(math.radians(a))) for a in (35, 65)]
        prof += [(br, z0), (0.0, z0 - 0.001)]
        return lathe(prof, n, R_=frame_to((1, 0, 0)))

    def ao_shape(self):
        r, g, rb = self.r, self.g, self.rb
        groove = sdf.cylinder((0, 0, -g), (0, 0, g), r * 1.2) - sdf.cylinder((0, 0, -2 * g), (0, 0, 2 * g), rb)
        ball = sdf.subtract(sdf.sphere((0, 0, 0), r), groove)
        btn = sdf.cylinder((r - 0.2 * r, 0, 0), (r + self.btn_h, 0, 0), self.ring_r * 0.92, 0.02 * r)
        return ball | btn


# --- emblems (2D, in units of the ball radius; a = emblem right, b = emblem up) ------------------------

def _poly_sdf2(Q, poly):
    """Signed distance (negative inside) from 2D points Q (N, 2) to a closed polygon (M, 2)."""
    poly = np.asarray(poly, dtype=np.float64)
    A = poly
    B = np.roll(poly, -1, axis=0)
    d = np.full(len(Q), np.inf)
    inside = np.zeros(len(Q), dtype=bool)
    for a, b in zip(A, B):
        e = b - a
        w = Q - a
        t = np.clip((w @ e) / max(e @ e, 1e-12), 0, 1)
        dist = np.linalg.norm(w - np.outer(t, e), axis=1)
        d = np.minimum(d, dist)
        cond = ((a[1] > Q[:, 1]) != (b[1] > Q[:, 1]))
        xint = a[0] + (Q[:, 1] - a[1]) * (b[0] - a[0]) / np.where(abs(b[1] - a[1]) < 1e-12, 1e-12, b[1] - a[1])
        inside ^= cond & (Q[:, 0] < xint)
    return np.where(inside, -d, d)


def _teardrop(n=48, sway=0.0, width=0.62, m=1.2):
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    y = np.cos(t)
    x = width * np.sin(t) * np.abs(np.sin(t / 2)) ** m
    x = x + sway * ((1 + y) / 2) ** 2.2
    return np.stack([x, -y * 0.9 + 0.1], 1)[::-1] * np.array([1, -1])


BOLT = np.array([(0.12, 1.0), (0.56, 1.0), (0.14, 0.16), (0.46, 0.16), (-0.36, -1.0), (-0.08, -0.12),
                 (-0.42, -0.12)])
FLAME_TONGUES = [  # (teardrop points, scale, rotation deg (positive leans left), offset)
    (_teardrop(sway=-0.22, width=0.66), 1.0, 0.0, (0.06, 0.0)),
    (_teardrop(n=36, sway=0.18, width=0.62), 0.56, 28.0, (-0.34, -0.30)),
    (_teardrop(n=36, sway=-0.15, width=0.62), 0.50, -30.0, (0.40, -0.36)),
]
FLAME_IN = (_teardrop(n=40, sway=-0.12, width=0.62), 0.46, 0.0, (0.05, -0.42))


def _tongue_sdf(Q, tongue):
    pts, sc, rot, off = tongue
    a = math.radians(rot)
    c, s_ = math.cos(a), math.sin(a)
    q = (Q - np.asarray(off)) @ np.array([[c, -s_], [s_, c]]) / sc
    return _poly_sdf2(q, pts) * sc
DROP = _teardrop(width=0.7, m=1.45)


def emblem_masks(Q, skin):
    """Q (N, 2) emblem coordinates (units of the emblem half size) -> (fill colour (N, 3), fill, outline)."""
    name, col, light, dark = SPECIES[skin]
    if name == "pikachu":
        d = _poly_sdf2(Q, BOLT)
        inner = None
    elif name == "charizard":
        d = np.min([_tongue_sdf(Q, tg) for tg in FLAME_TONGUES], axis=0)
        inner = _tongue_sdf(Q, FLAME_IN)
    else:
        d = _poly_sdf2(Q, DROP)
        inner = None
    fill_c = np.tile(col, (len(Q), 1))
    if inner is not None:
        fill_c = T.mix(fill_c, light, T.edge(inner, 0.08))
    if name == "blastoise":  # a highlight in the drop
        hl = np.linalg.norm((Q - np.array([-0.18, -0.15])) / np.array([0.13, 0.26]), axis=1) - 1.0
        fill_c = T.mix(fill_c, light, T.edge(hl * 0.13, 0.05))
    if name == "pikachu":
        fill_c = T.mix(fill_c, light, T.edge(_poly_sdf2(Q, BOLT * 0.55 + np.array([0.03, 0.02])), 0.06) * 0.6)
    return fill_c, d


# --- paint of the ball ----------------------------------------------------------------------------------

class BallPaint:
    """Paint functions for a ball placed in model space by (Rm, c) and optionally mirrored in y.

    local = Rm^T (P' - c) with P' = P mirrored back when the model is authored mirrored."""

    def __init__(self, spec, Rm=np.eye(3), c=(0, 0, 0), mirror=False, emblem_size=0.42, light=(0.45, 0.35, 0.82),
                 seam=False, emblem_lat=50.0, gloss=0.55, sheen=0.10):
        """gloss / sheen: painted specular highlight (fixed in ball space: keep it low on balls that spin)."""
        self.seam = seam
        self.gloss, self.sheen = gloss, sheen
        lat = math.radians(emblem_lat)
        self.e_dir = np.array([math.cos(lat), 0.0, math.sin(lat)])     # emblem centre, above the button
        self.e_up = np.array([-math.sin(lat), 0.0, math.cos(lat)])     # towards the pole
        self.e_right = np.array([0.0, 1.0, 0.0])                        # seen from the front
        self.s = spec
        self.Rm = np.asarray(Rm, dtype=np.float64)
        self.c = np.asarray(c, dtype=np.float64)
        self.mirror = mirror
        self.emblem_size = emblem_size
        L = np.asarray(light, dtype=np.float64)
        self.light = L / np.linalg.norm(L)
        self.ao = spec.ao_shape()

    def local(self, P, N):
        P = np.asarray(P, dtype=np.float64).copy()
        N = np.asarray(N, dtype=np.float64).copy()
        if self.mirror:
            P[:, 1] *= -1
            N[:, 1] *= -1
        return (P - self.c) @ self.Rm, N @ self.Rm

    def _gloss(self, N, c, power=36.0, amount=0.55, sheen=0.12):
        h = np.clip(N @ self.light, 0, 1)
        spec = amount * h ** power + sheen * h ** 5
        return np.clip(c + spec[:, None] * (1.0 - c * 0.35), 0, 1)

    def shell(self, P, N, skin, inside=None):
        p, n = self.local(P, N)
        s = self.s
        r = s.r
        z = p[:, 2] / r
        rho = np.linalg.norm(p[:, :2], axis=1)
        # base colours: red cap with a soft gradient, white bottom
        red = T.mix(RED_DARK, RED, np.clip((z - 0.05) / 0.55, 0, 1) ** 0.6)
        red = T.mix(red, T.rgb("#ff4a4a"), np.clip((z - 0.75) / 0.25, 0, 1) * 0.25)
        white = T.mix(WHITE_SHADOW, WHITE, np.clip((z + 0.95) / 0.85, 0, 1) ** 0.7)
        c = np.where((p[:, 2] > 0)[:, None], red, white)
        # the band (recessed part) and its species stripe
        band = np.abs(p[:, 2]) < s.g + 0.004 * r
        on_sphere = ~band
        name, col, light, dark = SPECIES[skin]
        az = np.abs(p[:, 2]) / s.g
        stripe = T.edge((az - 0.42) * s.g, 0.12 * s.g)
        bandc = T.mix(np.tile(BAND, (len(p), 1)), col, stripe)
        bandc = T.mix(bandc, light, stripe * np.clip(1 - az / 0.3, 0, 1) * 0.5)
        if self.seam:  # the two cups meet at z = 0: a fine dark line
            bandc = T.mix(bandc, BAND, T.edge(np.abs(p[:, 2]) - 0.012 * r, 0.012 * r) * 0.8)
        c = np.where(band[:, None], bandc, c)
        # thin dark edge where the caps meet the band
        lip = T.edge(np.abs(np.abs(p[:, 2]) - s.g) - 0.02 * r, 0.025 * r) * on_sphere
        c = T.mix(c, BAND * 1.4, lip * 0.75)
        # black ring around the button
        ang = np.degrees(np.arccos(np.clip(p[:, 0] / np.maximum(np.linalg.norm(p, axis=1), 1e-9), -1, 1)))
        ring_a = math.degrees(math.asin(s.ring_r / r))
        ring = T.edge((ang - ring_a) * math.pi / 180 * r, 0.035 * r)
        c = T.mix(c, RING, ring)
        # emblem on the red cap above the button, upright for someone facing the button
        if self.emblem_size:
            Q = np.stack([p @ self.e_right, p @ self.e_up], 1) / (self.emblem_size * r)
            fill_c, d = emblem_masks(Q, skin)
            top = np.clip((n @ self.e_dir - 0.45) / 0.2, 0, 1) * (p[:, 2] > 0.12 * r)
            c = T.mix(c, dark * 0.6, T.edge(d - 0.20, 0.05) * top)
            c = T.mix(c, np.tile(WHITE, (len(p), 1)), T.edge(d - 0.12, 0.05) * top)
            c = T.mix(c, fill_c, T.edge(d, 0.05) * top)
        # inside of the cups (seen when open): pale, lit by the light
        if inside is not None:
            ins = (np.linalg.norm(p, axis=1) < (s.ri + s.rb) / 2) & (np.abs(p[:, 2]) > 0.006 * r)
            glow = T.mix(INSIDE, light, 0.35)
            glow = T.mix(glow, np.ones(3), np.clip(1 - np.abs(p[:, 2]) / s.ri, 0, 1) ** 2 * 0.5)
            c = np.where(ins[:, None], glow, c)
        # shading painted in: AO, a little top light, gloss on the outside
        ao = T.ambient_occlusion(self.ao, p, n, dist=0.25 * r, steps=4)
        ao = np.where(band, np.maximum(ao, 0.8), ao)
        out = T.shade(c, n, ao=ao, ao_strength=0.5, top=0.10)
        gl = self._gloss(n, out, amount=self.gloss, sheen=self.sheen)
        gl_band = self._gloss(n, out, power=24, amount=self.gloss * 0.64, sheen=self.sheen * 0.5)
        out = np.where(band[:, None], gl_band, gl)
        if inside is not None:
            out = np.where(ins[:, None], T.shade(c, n, top=0.05), out)
        return out

    def shell_open(self, P, N, skin):
        return self.shell(P, N, skin, inside=True)

    def button(self, P, N, skin):
        p, n = self.local(P, N)
        s = self.s
        r = s.r
        name, col, light, dark = SPECIES[skin]
        rad = np.linalg.norm(p[:, 1:], axis=1)
        face = (p[:, 0] > r + s.btn_h + 0.004 * r) & (rad < s.btn_r * 1.02)
        c = np.tile(RING, (len(p), 1))
        # ring: a slightly lighter bevel catches the light
        c = T.mix(c, T.rgb("#34343a"), T.edge(np.abs(rad - s.ring_r * 0.80) - 0.035 * r, 0.03 * r) * 0.8)
        wc = T.mix(T.rgb("#c9ccd2"), WHITE, np.clip((p[:, 0] - (r + s.btn_h)) / s.btn_dome, 0, 1))
        wc = T.mix(wc, col, T.edge(np.abs(rad - s.btn_r * 0.72) - 0.05 * r, 0.03 * r) * 0.85)
        c = np.where(face[:, None], wc, c)
        out = T.shade(c, n, top=0.1)
        return self._gloss(n, out, power=30, amount=max(self.gloss * 0.9, 0.3))

    def glow(self, P, N, skin):
        """Additive light: white-hot centre fading to the species colour, black (nothing) at the rim."""
        p, n = self.local(P, N)
        name, col, light, dark = SPECIES[skin]
        rad = np.linalg.norm(p[:, :2], axis=1) / (self.s.ri)
        k = np.clip(1 - rad, 0, 1)
        c = T.mix(col * 0.6, np.array([1.0, 1.0, 0.92]), k ** 1.5)
        return c * np.clip(k * 2.2, 0, 1)[:, None] ** 0.8

    def button_glow(self, P, N, skin):
        p, n = self.local(P, N)
        name, col, light, dark = SPECIES[skin]
        rad = np.linalg.norm(p[:, 1:], axis=1) / self.s.btn_r
        ring = np.exp(-((rad - 0.72) / 0.16) ** 2)
        centre = np.clip(1 - rad / 0.5, 0, 1) ** 2
        return np.clip(col[None, :] * (0.9 * ring + 0.06)[:, None] + light * (0.18 * centre)[:, None], 0, 1)

    def band_glow(self, P, N, skin):
        """Additive line over the band's species stripe (the thrown ball stays readable in a dark map)."""
        p, n = self.local(P, N)
        name, col, light, dark = SPECIES[skin]
        az = np.abs(p[:, 2]) / self.s.g
        k = np.clip(1 - az / 0.34, 0, 1) ** 0.7
        return np.clip(col[None, :] * (0.42 * k)[:, None], 0, 1)

    def emblem_charts(self, mirror=False):
        """Part.charts options putting one box chart square on the emblem (not split across charts)."""
        e = self.Rm @ self.e_dir
        up = self.Rm @ self.e_up
        if mirror:
            e, up = e * np.array([1.0, -1.0, 1.0]), up * np.array([1.0, -1.0, 1.0])
        return {"frame": frame_from(e, up)}


def ball_parts(spec, paint, bone, prefix="", fx_group="fx", main_group="ball", button=True, glow_btn=True,
               mesh_xf=None, mirror=False, density=1.0):
    """Closed ball parts (held models) on one bone; mesh_xf(m) places a ball-frame mesh in model space."""
    xf = mesh_xf or (lambda m: m)
    shell, rings = split_annuli(spec.solid(), spec.r)
    parts = [builder.Part(prefix + "ball", mesh=xf(shell), bone=bone, paint=paint.shell, group=main_group,
                          crease=40, density=density, charts=paint.emblem_charts(mirror)),
             builder.Part(prefix + "steps", mesh=xf(rings), bone=bone, paint=paint.shell, group=main_group,
                          crease=40, density=0.15 * density, hitbox=False)]
    if button:
        parts.append(builder.Part(prefix + "button", mesh=xf(spec.button()), bone=bone, paint=paint.button,
                                  group=main_group, crease=50, density=1.6 * density, hitbox=False))
    if glow_btn:
        parts.append(builder.Part(prefix + "btnglow", mesh=xf(spec.button_glow()), bone=bone, paint=paint.button_glow,
                                  group=fx_group, crease=80, hitbox=False))
    return parts


def band_rings(spec, z0, z1, n=32):
    """Open band (additive overlay) just outside the recessed band, between heights z0 < z1."""
    rho = spec.rb + 0.012 * spec.r
    return lathe([(rho, z1), (rho, z0)], n)


# ---------------------------------------------------------------------------------------------
# w_pokeball: world model (thrown, dropped, lying on the ground), button facing +x, hinge at the back (-x).
# Origin on the floor under the ball for the grounded sequences idle / wobble / open (dropped weaponboxes,
# a ball at rest), at the ball's centre for "fly" (tumbles about its centre in the air).
# ---------------------------------------------------------------------------------------------

W_R = 4.0
W_SEQS = ("idle", "wobble", "open", "fly")


def build_w():
    spec = BallSpec(W_R, n=24, arc_steps=7)
    rig = R.Rig()
    rig.add("ball", None, (0, 0, 0), tail=(0, 0, -W_R))
    hinge = (-W_R - 0.02, 0, 0.0)
    rig.add("top", "ball", hinge, tail=(0, 0, W_R))
    paint = BallPaint(spec, seam=True, gloss=0.25, sheen=0.06)
    top, top_in, bottom, bottom_in = spec.cups(inner_steps=3)
    b = builder.ModelBuilder("pokemon/w_pokeball.mdl", rig, skins=3, verbose=False)
    b.group("ball", size=(256, 256), pack="skyline")
    b.group("fx", size=(128, 128), flags=mdl.STUDIO_NF_ADDITIVE | mdl.STUDIO_NF_FULLBRIGHT, pack="skyline")
    top, top_rings = split_annuli(top, W_R)
    bottom, bottom_rings = split_annuli(bottom, W_R)
    b.add(builder.Part("top", mesh=top, bone="top", paint=paint.shell_open, group="ball", crease=40, density=1.6,
                       charts=paint.emblem_charts()))
    b.add(builder.Part("bottom", mesh=bottom, bone="ball", paint=paint.shell_open, group="ball", crease=40,
                       density=1.0))
    b.add(builder.Part("top_rings", mesh=top_rings, bone="top", paint=paint.shell_open, group="ball", crease=40,
                       density=0.15, hitbox=False))
    b.add(builder.Part("bottom_rings", mesh=bottom_rings, bone="ball", paint=paint.shell_open, group="ball",
                       crease=40, density=0.15, hitbox=False))
    b.add(builder.Part("top_in", mesh=top_in, bone="top", paint=paint.shell_open, group="ball", crease=40,
                       density=0.12, hitbox=False))
    b.add(builder.Part("bottom_in", mesh=bottom_in, bone="ball", paint=paint.shell_open, group="ball", crease=40,
                       density=0.12, hitbox=False))
    b.add(builder.Part("button", mesh=spec.button(n=18), bone="ball", paint=paint.button, group="ball", crease=50,
                       density=1.5, hitbox=False))
    b.add(builder.Part("btnglow", mesh=spec.button_glow(n=14), bone="ball", paint=paint.button_glow, group="fx",
                       crease=80, hitbox=False, density=3.0))
    lip = 0.004 * W_R
    b.add(builder.Part("bandglow_top", mesh=band_rings(spec, lip, 0.34 * spec.g, n=24), bone="top",
                       paint=paint.band_glow, group="fx", crease=80, hitbox=False, density=3.0))
    b.add(builder.Part("bandglow_bottom", mesh=band_rings(spec, -0.34 * spec.g, -lip, n=24), bone="ball",
                       paint=paint.band_glow, group="fx", crease=80, hitbox=False, density=3.0))
    b.add(builder.Part("glow_bottom", mesh=spec.glow_disc(-0.05, spec.ri * 0.97, 0.5, n=20, up=True), bone="ball",
                       paint=paint.glow, group="fx", crease=80, hitbox=False))
    b.add(builder.Part("glow_top", mesh=spec.glow_disc(0.05, spec.ri * 0.97, 0.5, n=20, up=False), bone="top",
                       paint=paint.glow, group="fx", crease=80, hitbox=False))

    def idle(t):
        p = R.Pose()
        p.move("ball", z=W_R)
        return p

    def wobble(t):
        # tilt one way, rock back past the middle, settle, rest: rolls (no sliding) on the ground
        a = R.keys(t, [(0.0, 0.0), (0.10, 0.0), (0.22, 24.0), (0.40, -17.0), (0.54, 7.0), (0.64, -2.5),
                       (0.72, 0.0), (1.0, 0.0)], interp="cubic")
        p = R.Pose()
        p.rot("ball", x=a)
        p.move("ball", y=-math.radians(a) * W_R, z=W_R)
        # the lid chatters a little at the extremes
        lid = 3.0 * R.pulse(t, 0.18, 0.22, 0.24, 0.30) + 2.0 * R.pulse(t, 0.36, 0.40, 0.42, 0.48)
        p.rot("top", y=-lid)
        return p

    def open_(t):
        # 0.6 s: a shiver, the lid springs open at the back hinge (overshoot), the ball hops and settles
        p = R.Pose()
        shiver = 5.0 * math.sin(t * 2 * math.pi * 6) * (1 - R.window(t, 0.0, 0.16)) * R.window(t, 0.0, 0.03)
        p.rot("ball", x=shiver)
        lid = R.keys(t, [(0.0, 0.0), (0.12, 4.0), (0.20, -55.0), (0.32, -104.0), (0.46, -91.0), (0.60, -97.0),
                         (1.0, -95.0)], interp="cubic")
        p.rot("top", y=lid)
        hop = R.keys(t, [(0.0, 0.0), (0.12, -0.25), (0.24, 1.3), (0.40, 0.0), (0.50, 0.25), (0.60, 0.0), (1.0, 0.0)],
                     interp="cubic")
        p.move("ball", z=W_R + max(hop, 0.0))
        p.rot("ball", y=R.keys(t, [(0.0, 0.0), (0.18, 0.0), (0.30, -9.0), (0.48, 3.0), (0.62, -1.5), (1.0, 0.0)],
                               interp="cubic"))
        return p

    b.add_sequence(R.make_sequence(rig, "idle", idle, frames=1, fps=10, loop=True, activity=mdl.ACT["IDLE"]))
    b.add_sequence(R.make_sequence(rig, "wobble", wobble, frames=30, fps=30, loop=True))
    b.add_sequence(R.make_sequence(rig, "open", open_, frames=19, fps=30, loop=False))
    b.add_sequence(R.make_sequence(rig, "fly", lambda t: R.Pose(), frames=1, fps=10, loop=True))
    b.hull = ((-W_R, -W_R, 0.0), (W_R, W_R, 2 * W_R))
    b.eyeposition = (0, 0, W_R)
    return b.write()


# ---------------------------------------------------------------------------------------------
# p_pokeball: one bone named like the player models' right hand, merged by name by the engine
# ---------------------------------------------------------------------------------------------

P_R = 3.3   # held ball radius (the thrown w_ ball is 4: a smaller jump when it leaves the hand)
# Ball centre in the hand bone's frame (Biped convention: +x along the hand towards the fingers, the palm
# and the thumb on the negative y / z sides); the ball sits in the palm, held by the fingers.  Unchecked in
# game: tune it (and the button axis bx below) in chase cam on a T and a CT model.
P_OFFSET = (3.4, -2.16, -1.40)
P_BONE = "Bip01 R Hand"


def build_p():
    spec = BallSpec(P_R, n=18, arc_steps=5)
    rig = R.Rig()
    rig.add(P_BONE, None, (0, 0, 0), tail=P_OFFSET)
    # button facing away from the palm, the top cap along the fingers
    c = np.asarray(P_OFFSET, dtype=np.float64)
    bx = np.array([0.0, c[1], c[2]]) / np.linalg.norm(c[1:])
    bz = np.array([1.0, 0.0, 0.0])
    Rm = np.stack([bx, np.cross(bz, bx), bz], axis=1)
    paint = BallPaint(spec, Rm=Rm, c=c, gloss=0.25, sheen=0.06)
    xf = lambda m: m.transformed(Rm, c)  # noqa: E731
    b = builder.ModelBuilder("pokemon/p_pokeball.mdl", rig, skins=3, verbose=False)
    b.group("ball", size=(128, 128), pack="skyline")
    b.group("fx", size=(32, 32), flags=mdl.STUDIO_NF_ADDITIVE | mdl.STUDIO_NF_FULLBRIGHT, pack="skyline")
    for part in ball_parts(spec, paint, P_BONE, mesh_xf=xf, glow_btn=True):
        if part.name == "button":
            part.mesh = xf(spec.button(n=12))
        if part.name == "btnglow":
            part.mesh = xf(spec.button_glow(n=10))
        b.add(part)
    b.add_sequence(R.make_sequence(rig, "idle", lambda t: R.Pose(), frames=1, fps=10, loop=True,
                                   activity=mdl.ACT["IDLE"]))
    return b.write()




# ---------------------------------------------------------------------------------------------
# the hand holding the ball (view model), first in its own frame H: origin at the wrist, +x along the
# hand towards the middle finger, +y towards the thumb, +z out of the back of the hand (palm towards -z)
# ---------------------------------------------------------------------------------------------

V_R = 1.8   # ball radius in the hand (diameter about 1.15 x the knuckle span)

# fingers: name, knuckle (MCP) position, splay (deg towards +y), segment lengths, radii (knuckle, PIP, DIP, tip)
FINGERS = [
    ("index", (3.55, 1.12, -0.02), 7.0, (1.50, 0.90, 0.76), (0.43, 0.40, 0.36, 0.32)),
    ("middle", (3.72, 0.37, 0.00), 1.0, (1.64, 1.00, 0.80), (0.45, 0.42, 0.37, 0.33)),
    ("ring", (3.58, -0.40, -0.03), -5.0, (1.53, 0.94, 0.77), (0.43, 0.40, 0.355, 0.31)),
    ("pinky", (3.25, -1.12, -0.10), -12.0, (1.22, 0.72, 0.66), (0.38, 0.35, 0.31, 0.28)),
]
THUMB_CMC = np.array([0.55, 0.80, -0.42])
THUMB_MCP = np.array([1.85, 1.78, -0.98])
THUMB_LEN = (1.30, 1.08)
THUMB_RAD = (0.52, 0.47, 0.40)
BALL_H = np.array([2.95, 0.40, -2.42])   # ball centre in H (resting in the fingers, off the palm)


def _rot_about(v, axis, deg):
    return xform.axis_angle_matrix(axis, deg) @ v


def curl_chain(p0, d0, lengths, radii, C, rb, max_flex=(85, 105, 80), gap=-0.06, min_flex=-15, rest_flex=20):
    """Joint positions of a finger wrapping a ball (centre C, radius rb): each segment flexes towards the
    ball the least that brings its end into contact (radius of the finger there + gap)."""
    p = np.asarray(p0, dtype=np.float64)
    d = np.asarray(d0, dtype=np.float64)
    d = d / np.linalg.norm(d)
    joints = [p.copy()]
    for L, r_end, mf in zip(lengths, radii[1:], max_flex):
        a = np.cross(d, C - p)
        a = a / max(np.linalg.norm(a), 1e-9)
        target = rb + r_end + gap
        thetas = np.arange(min_flex, mf + 0.5, 0.5)
        dists = np.array([np.linalg.norm(p + L * _rot_about(d, a, th) - C) for th in thetas])
        ok = np.nonzero(dists <= target)[0]
        th = thetas[ok[0]] if len(ok) else (thetas[np.argmin(dists)] if dists.min() < target + 0.6 else rest_flex)
        d = _rot_about(d, a, th)
        p = p + L * d
        joints.append(p.copy())
    return joints


def hand_layout(ball_c=None, rb=None):
    """Joints of the gripping hand in H: {"index": [MCP, PIP, DIP, tip], ..., "thumb": [CMC, MCP, IP, tip]}."""
    C = np.asarray(BALL_H if ball_c is None else ball_c, dtype=np.float64)
    rb = V_R if rb is None else rb
    out = {}
    for name, mcp, splay, lens, rads in FINGERS:
        d0 = _rot_about(np.array([1.0, 0.0, 0.0]), (0, 0, 1), splay)
        d0 = _rot_about(d0, (0, 1, 0), 8.0)  # the knuckles flex a little at rest
        out[name] = curl_chain(mcp, d0, lens, rads, C, rb)
    d0 = THUMB_MCP - THUMB_CMC
    th = curl_chain(THUMB_MCP, d0 / np.linalg.norm(d0) + np.array([0.15, 0.1, 0.0]), THUMB_LEN, THUMB_RAD, C, rb,
                    max_flex=(60, 70))
    out["thumb"] = [THUMB_CMC] + th
    return out


def finger_sdf(joints, radii, k=0.10):
    segs = [sdf.rounded_cone(joints[i], joints[i + 1], radii[i], radii[i + 1]) for i in range(len(joints) - 1)]
    return sdf.union(*segs, k=k)


def palm_sdf(lay):
    """Back of the hand and palm (with the thumb's metacarpal and the wrist), smooth; the back is arched
    across the knuckles like a real hand's."""
    knuckles = [lay[n][0] for n in ("index", "middle", "ring", "pinky")]
    body = sdf.rounded_box((1.70, 0.02, -0.10), (1.62, 1.42, 0.42), 0.40)
    body = body.bend(-9.0, along=1, toward=2, center=(1.7, 0.0, -1.2))
    body = body.smooth_union(sdf.tube(knuckles, [0.50, 0.53, 0.50, 0.44]), 0.55)
    body = body.smooth_union(sdf.ellipsoid((1.25, -1.05, -0.32), (1.45, 0.55, 0.50)), 0.4)   # hypothenar
    body = body.smooth_union(sdf.ellipsoid((1.30, 0.95, -0.55), (1.15, 0.72, 0.60)), 0.5)    # thenar
    body = body.smooth_union(sdf.rounded_cone(THUMB_CMC, lay["thumb"][1], 0.62, THUMB_RAD[0]), 0.45)
    wrist = sdf.ellipsoid((-0.25, 0.0, -0.10), (1.05, 1.22, 0.76))
    body = body.smooth_union(wrist, 0.8)
    return body


def knuckle_guard_sdf(lay):
    """Moulded protector over the knuckles of a tactical glove."""
    knuckles = [np.asarray(lay[n][0]) for n in ("index", "middle", "ring", "pinky")]
    pts = [k + np.array([-0.30, 0.0, 0.42]) for k in knuckles]
    g = sdf.tube(pts, [0.30, 0.32, 0.30, 0.26]).stretch((1.25, 1.0, 0.62), center=pts[1])
    return g


# ---------------------------------------------------------------------------------------------
# v_pokeball: placement in the view (design space: right hand on the right; mirrored for the file)
# ---------------------------------------------------------------------------------------------

class VLayout:
    """Rest (idle) placement of the hand, forearm and ball in view space (+x forward, +y left, +z up)."""

    # the ball sits about 24 deg off the view axis (perspective stretch of its outline about 1.08), held from
    # its right: palm towards the ball, thumb across its front-top, the back of the hand towards the eye
    def __init__(self, ball=(13.1, -4.0, -3.6), hand_x=(0.6, 0.15, 0.75), palm_n=(0.0, 0.9, 0.35),
                 wrist_ext=24.0, wrist_dev=-6.0, forearm_len=11.5, ball_top=(-0.15, 0.35, 0.9),
                 ball_front=(-0.85, 0.45, -0.05)):
        self.Q = frame_from(hand_x, [-c for c in palm_n], z_is_second=True)   # H -> view
        self.W = np.asarray(ball, dtype=np.float64) - self.Q @ BALL_H
        self.lay = hand_layout()
        # forearm axis (elbow -> wrist) in H: the hand is bent back (extension) and a little sideways
        uH = _rot_about(np.array([1.0, 0.0, 0.0]), (0, 1, 0), wrist_ext)
        uH = _rot_about(uH, (0, 0, 1), wrist_dev)
        self.u = self.Q @ uH
        self.E = self.W - forearm_len * self.u
        # arm frame A: x along the forearm, y the hand's width direction
        yA = self.Q @ np.array([0.0, 1.0, 0.0])
        yA = yA - self.u * (yA @ self.u)
        yA /= np.linalg.norm(yA)
        self.A = np.stack([self.u, yA, np.cross(self.u, yA)], axis=1)   # A -> view
        self.ball_c = self.to_view(BALL_H)
        # ball frame -> view: the top cap towards the camera and up, the button forward and out
        self.ball_R = frame_from(ball_front, ball_top, z_is_second=True)

    def to_view(self, pH):
        return self.Q @ np.asarray(pH, dtype=np.float64) + self.W

    def sdf_h(self, shape):
        """An SDF built in H, placed in view space."""
        return shape.transform(self.Q).translate(self.W)

    def sdf_a(self, shape):
        return shape.transform(self.A).translate(self.E)


def sleeve_sdf(L):
    """Sleeve in the arm frame A (x from the elbow to the wrist), loose fabric with folds and a cuff."""
    Lw = float(np.linalg.norm(L.W - L.E))
    x1 = Lw - 0.85
    body = sdf.rounded_cone((-3.0, 0, 0), (x1, 0, 0), 2.30, 1.70).stretch((1.0, 1.10, 0.96))
    body = body.smooth_union(sdf.ellipsoid((0.2, 0.0, -0.15), (3.2, 2.45, 2.25)), 0.8)   # fuller near the elbow

    def folds(p):
        x = p[:, 0]
        ang = np.arctan2(p[:, 2], p[:, 1])
        w = np.clip((x - 1.0) / (x1 - 1.0), 0, 1)
        f = np.sin(x * 2.3 + 1.3 * np.sin(2 * ang + 0.7) + 0.6 * np.sin(3 * ang)) * (0.05 + 0.11 * w)
        f += 0.05 * np.sin(5 * ang + x * 0.8) * w
        return f

    body = body.displace(folds, 0.17)
    cuff = sdf.rounded_cone((x1 - 1.35, 0, 0), (x1, 0, 0), 1.86, 1.80).stretch((1.0, 1.10, 0.95))
    cuff = sdf.subtract(cuff, sdf.halfspace((x1 - 0.02, 0, 0), (1, 0, 0)), k=0.15)
    cuff = cuff.round(0.06)
    tab = sdf.rounded_box((x1 - 0.65, 0.0, 1.78), (0.62, 0.55, 0.12), 0.1).bend(0.0)
    s = body.smooth_union(cuff, 0.25) | tab
    return s


def glove_cuff_sdf(L):
    """The glove's cuff around the wrist (under the sleeve's end), in A."""
    Lw = float(np.linalg.norm(L.W - L.E))
    c = sdf.rounded_cone((Lw - 2.4, 0, 0), (Lw + 0.35, 0, 0), 1.48, 1.30).stretch((1.0, 1.08, 0.80))
    strap = sdf.rounded_box((Lw - 0.25, 0, 0), (0.42, 1.50, 1.16), 0.35).stretch((1.0, 1.04, 0.95), center=(Lw, 0, 0))
    return c.smooth_union(strap, 0.15)


GLOVE = T.rgb("#61656d")        # synthetic leather, back of the hand and fingers
GLOVE_PANEL = T.rgb("#555961")  # padded panel on the back of the hand
GLOVE_PALM = T.rgb("#4b4741")   # suede palm and finger insides
GLOVE_PAD = T.rgb("#6c7078")    # moulded knuckle guard / finger pads
NEOPRENE = T.rgb("#393a3f")     # cuff
STITCH = T.rgb("#7a7d84")
SLEEVE = T.rgb("#4c5243")       # tactical ripstop, dark olive grey
SLEEVE_CUFF = T.rgb("#3a3f33")
VELCRO = T.rgb("#565c4c")


def _grain(P, scale=7.0, seed=0.0):
    """Cheap deterministic fabric/leather grain in [-1, 1] (sums of sines)."""
    x, y, z = P[:, 0] * scale, P[:, 1] * scale, P[:, 2] * scale
    g = (np.sin(x * 1.7 + y * 0.9 + seed) * np.sin(y * 1.3 - z * 1.9 + 0.5 * seed)
         + 0.6 * np.sin(z * 2.3 + x * 1.1 + 1.7) * np.sin(x * 2.9 - y * 2.1)
         + 0.4 * np.sin((x + y + z) * 3.7 + seed))
    return g / 2.0


class ArmPaint:
    """Paint of the gloved hand and the sleeve (design space)."""

    def __init__(self, L, occ, fingers_joints, thumb_joints):
        self.L = L
        self.occ = occ
        self.fj = fingers_joints
        self.tj = thumb_joints

    def h(self, P, N):
        return (P - self.L.W) @ self.L.Q, N @ self.L.Q

    def a(self, P, N):
        return (P - self.L.E) @ self.L.A, N @ self.L.A

    def _finish(self, c, P, N, ao_dist=0.6, gloss=0.0, top=0.16, rim=0.10):
        ao = T.ambient_occlusion(self.occ, P, N, dist=ao_dist, steps=4)
        out = T.shade(c, N, ao=ao, ao_strength=0.75, top=top, shadow_tint="#70788a")
        if rim:  # a painted rim light (eye at the origin) keeps the silhouette readable against dark walls
            vd = P / np.maximum(np.linalg.norm(P, axis=1, keepdims=True), 1e-9)
            f = (1 - np.abs(np.einsum("ij,ij->i", N, vd))) ** 3
            out = np.clip(out + rim * f[:, None] * np.array([0.95, 1.0, 1.08]), 0, 1)
        if gloss:
            L = np.array([0.35, 0.45, 0.82])
            hl = np.clip(N @ (L / np.linalg.norm(L)), 0, 1) ** 12 * gloss
            out = np.clip(out + hl[:, None] * 0.6, 0, 1)
        return out

    def _palmar(self, P, N):
        """1 on the side facing the ball (palm, insides of the curled fingers)."""
        d = self.L.ball_c - P
        d = d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
        return T._sstep(0.05, 0.35, np.einsum("ij,ij->i", N, d))

    def _leather(self, P, N, base):
        c = np.tile(base, (len(P), 1)) * (1 + 0.05 * _grain(P, 9.0))[:, None]
        pal = self._palmar(P, N)
        suede = np.tile(GLOVE_PALM, (len(P), 1)) * (1 + 0.08 * _grain(P, 14.0, 2.0))[:, None]
        c = T.mix(c, suede, pal)
        seam = np.exp(-((pal - 0.5) / 0.16) ** 2)
        c = T.mix(c, GLOVE_PALM * 0.6, seam * 0.7)
        return c, pal

    def palm(self, P, N, skin):
        pH, nH = self.h(P, N)
        c, pal = self._leather(P, N, GLOVE)
        # padded panel on the back of the hand, with its stitching
        q = (pH[:, :2] - np.array([1.75, 0.0])) / np.array([1.55, 1.30])
        rr = np.linalg.norm(q ** 4, axis=1) ** 0.25
        dorsal = T._sstep(0.25, 0.6, nH[:, 2])
        panel = T.edge((rr - 1.0) * 1.3, 0.08) * dorsal
        c = T.mix(c, GLOVE_PANEL * (1 + 0.04 * _grain(P, 20.0, 1.0))[:, None], panel)
        stitch_band = np.exp(-(((rr - 1.0) * 1.3 + 0.12) / 0.035) ** 2) * dorsal
        dashes = (np.sin((pH[:, 0] + pH[:, 1]) * 22.0) > -0.2).astype(float)
        c = T.mix(c, STITCH, stitch_band * dashes * 0.8)
        # grip patch on the palm
        gp = T.ellipse(pH, (1.6, 0.0, -0.5), (1.3, 1.25, 2.0), soft=0.2) * pal
        c = T.mix(c, GLOVE_PALM * 0.75, gp * (0.5 + 0.5 * (np.sin(pH[:, 0] * 18) * np.sin(pH[:, 1] * 18) > 0)))
        return self._finish(c, P, N)

    def finger(self, name):
        joints = self.fj[name]

        def paint(P, N, skin):
            c, pal = self._leather(P, N, GLOVE)
            # pads on the proximal and middle phalanges (dorsal), a reinforced tip
            for (a, b_), w in ((joints[0], joints[1]), 1.0), ((joints[1], joints[2]), 0.8):
                a, b_ = np.asarray(a), np.asarray(b_)
                ab = b_ - a
                t = np.clip((P - a) @ ab / (ab @ ab), 0, 1)
                pad = T._sstep(0.18, 0.3, t) * (1 - T._sstep(0.72, 0.84, t)) * (1 - pal)
                c = T.mix(c, GLOVE_PAD * 0.85, pad * 0.55 * w)
            tip = np.asarray(joints[3])
            dtip = np.linalg.norm(P - tip, axis=1)
            c = T.mix(c, NEOPRENE, T.edge(dtip - 0.55, 0.15) * 0.8)
            # creases at the joints
            for j in joints[1:3]:
                dj = np.linalg.norm(P - np.asarray(j), axis=1)
                c = c * (1 - 0.25 * np.exp(-((dj - 0.42) / 0.07) ** 2) * pal)[:, None]
            return self._finish(c, P, N, ao_dist=0.45)
        return paint

    def thumb(self, P, N, skin):
        c, pal = self._leather(P, N, GLOVE)
        tip = np.asarray(self.tj[-1])
        c = T.mix(c, NEOPRENE, T.edge(np.linalg.norm(P - tip, axis=1) - 0.6, 0.15) * 0.8)
        return self._finish(c, P, N, ao_dist=0.45)

    def guard(self, P, N, skin):
        c = np.tile(GLOVE_PAD, (len(P), 1)) * (1 + 0.03 * _grain(P, 25.0, 3.0))[:, None]
        return self._finish(c, P, N, ao_dist=0.4, gloss=0.35, top=0.25)

    def cuff(self, P, N, skin):
        pA, nA = self.a(P, N)
        Lw = float(np.linalg.norm(self.L.W - self.L.E))
        c = np.tile(NEOPRENE, (len(P), 1)) * (1 + 0.06 * _grain(P, 16.0, 4.0))[:, None]
        strap = T.edge(np.abs(pA[:, 0] - (Lw - 0.25)) - 0.40, 0.06)
        c = T.mix(c, GLOVE * 0.9, strap)
        for e in (-0.33, 0.33):
            c = T.mix(c, STITCH * 0.8, np.exp(-((pA[:, 0] - (Lw - 0.25) - e) / 0.03) ** 2) * 0.6 *
                      (np.sin(np.arctan2(pA[:, 2], pA[:, 1]) * 40) > 0))
        return self._finish(c, P, N, ao_dist=0.5)

    def sleeve(self, P, N, skin):
        pA, nA = self.a(P, N)
        Lw = float(np.linalg.norm(self.L.W - self.L.E))
        x1 = Lw - 0.85
        ang = np.arctan2(pA[:, 2], pA[:, 1])
        c = np.tile(SLEEVE, (len(P), 1))
        # ripstop grid
        gx = np.abs(((pA[:, 0] / 0.55) % 1.0) - 0.5)   # coarse enough for the sleeve's texel density
        ga = np.abs(((ang * 1.9 / 0.55) % 1.0) - 0.5)
        grid = np.maximum(T._sstep(0.40, 0.48, gx), T._sstep(0.40, 0.48, ga))
        c = c * (1 + 0.04 * grid + 0.03 * _grain(P, 6.0, 5.0))[:, None]
        # cuff band and its velcro tab
        cuff = T._sstep(x1 - 1.42, x1 - 1.30, pA[:, 0])
        c = T.mix(c, SLEEVE_CUFF * (1 + 0.05 * _grain(P, 30.0, 6.0))[:, None], cuff)
        tab = (T.edge(np.abs(pA[:, 0] - (x1 - 0.65)) - 0.62, 0.05) * T.edge(np.abs(pA[:, 1]) - 0.55, 0.05)
               * (pA[:, 2] > 1.5))
        c = T.mix(c, VELCRO * (1 + 0.15 * _grain(P, 40.0, 7.0))[:, None], tab)
        seam = np.exp(-((pA[:, 0] - (x1 - 1.36)) / 0.03) ** 2)
        c = T.mix(c, SLEEVE_CUFF * 0.6, seam * 0.8)
        return self._finish(c, P, N, ao_dist=1.0, top=0.12, rim=0.07)


# set False if the client stops mirroring view models (cl_righthand 1 mirrors them, see the module docstring)
V_MIRROR = True


def mirror_pose(p):
    out = R.Pose()
    for k, v in p.items():
        w = v.copy()
        w[0], w[2], w[4] = -v[0], -v[2], -v[4]
        out[k] = w
    return out


class VModel:
    """Everything of the view model in design space (right hand), and its rig."""

    def __init__(self, layout=None):
        self.L = layout or VLayout()
        L = self.L
        lay = L.lay
        self.joints = {k: [L.to_view(p) for p in v] for k, v in lay.items()}
        rig = R.Rig()
        rig.add("root", None, (0, 0, 0))
        rig.add("arm", "root", L.E, tail=L.W)
        rig.add("hand", "arm", L.W, tail=self.joints["middle"][0])
        for name, *_ in FINGERS:
            j = self.joints[name]
            rig.add(name + "1", "hand", j[1 - 1], tail=j[1])
            rig.add(name + "2", name + "1", j[1], tail=j[3])
        tj = self.joints["thumb"]
        rig.add("thumb1", "hand", tj[1], tail=tj[2])
        rig.add("thumb2", "thumb1", tj[2], tail=tj[3])
        rig.add("ball", "hand", L.ball_c, tail=L.ball_c + np.array([0, 0, V_R]))
        self.rig = rig
        # flexion axes (rest view space) of the finger joints: curling towards the ball
        self.flex = {}
        for name in [f[0] for f in FINGERS] + ["thumb"]:
            j = self.joints[name] if name != "thumb" else self.joints["thumb"][1:]
            axes = []
            for i in range(2):
                d = j[i + 1] - j[i]
                a = np.cross(d, L.ball_c - j[i])
                axes.append(a / np.linalg.norm(a))
            self.flex[name] = axes
        self.hand_axes = L.Q.T  # rows: x_H, y_H, z_H in view space
        self.turn_axis = np.array([0.0, 1.0, 0.0])
        h = np.cross(L.u, (0.0, 0.0, 1.0))
        self.lift_axis = h / np.linalg.norm(h)

    def rest_key(self):
        L = self.L
        return {"W": L.W.copy(), "u": L.u.copy(), "hx": L.Q[:, 0].copy(), "pn": -L.Q[:, 2].copy()}

    def pose(self, k):
        """Pose (design space) from key parameters (dict, missing = rest): W wrist position, u forearm direction
        (elbow -> wrist), hx / pn the hand's finger direction and palm normal (view space), grip finger curl
        offset (deg, - = open), thumb (its curl offset), g_<finger> extra per finger, ball None (in the hand)
        or its view-space position, ball_spin (deg).  The forearm's twist is chosen to leave the wrist
        flexing and bending, not rolling (pronation happens in the forearm)."""
        L = self.L
        rest = self.rest_key()
        W = np.asarray(k.get("W", rest["W"]), dtype=np.float64)
        u = np.asarray(k.get("u", rest["u"]), dtype=np.float64)
        u = u / np.linalg.norm(u)
        Qt = frame_from(k.get("hx", rest["hx"]), -np.asarray(k.get("pn", rest["pn"]), dtype=np.float64))
        Rhand_w = Qt @ L.Q.T
        Ralign = R._align(L.u, u)
        best = None
        for th in np.arange(-180.0, 180.0, 1.0):
            Rarm = xform.axis_angle_matrix(u, th) @ Ralign
            loc = Rarm.T @ Rhand_w
            # cost: rotation of the wrist about the forearm axis (roll) + overall angle
            ang = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(loc) - 1) / 2))))
            if best is None or ang < best[0]:
                best = (ang, Rarm, loc)
        _, Rarm, Rw = best
        move = W - L.E - Rarm @ (L.W - L.E)
        p = R.Pose()
        p.set_rot("arm", *np.degrees(xform.matrix_euler(Rarm)))
        p.move("arm", *move)
        p.set_rot("hand", *np.degrees(xform.matrix_euler(Rw)))
        g = k.get("grip", 0.0)
        for name, mul in (("index", 1.0), ("middle", 0.95), ("ring", 0.9), ("pinky", 0.85), ("thumb", None)):
            gg = k.get("thumb", g * 0.7) if mul is None else g * mul + k.get("g_" + name, 0.0)
            a1, a2 = self.flex[name]
            p.set_rot(name + "1", *np.degrees(xform.matrix_euler(xform.axis_angle_matrix(a1, gg))))
            p.set_rot(name + "2", *np.degrees(xform.matrix_euler(xform.axis_angle_matrix(a2, gg * 0.8))))
        if k.get("ball_turn"):
            p.set_rot("ball", *np.degrees(xform.matrix_euler(xform.axis_angle_matrix(self.turn_axis, k["ball_turn"]))))
        if k.get("ball") is not None or k.get("ball_spin"):
            Wm = self.rig.world(p)
            hand = Wm[self.rig.index("hand")]
            cur = hand[:, :3] @ (L.ball_c - L.W) + hand[:, 3]
            target = cur if k.get("ball") is None else np.asarray(k["ball"], dtype=np.float64)
            p.move("ball", *(hand[:, :3].T @ (target - cur)))
            if k.get("ball_spin"):
                Rs = hand[:, :3].T @ xform.axis_angle_matrix((0, 1, 0), k["ball_spin"]) @ hand[:, :3]
                if k.get("ball_turn"):
                    Rs = Rs @ xform.axis_angle_matrix(self.turn_axis, k["ball_turn"])
                p.set_rot("ball", *np.degrees(xform.matrix_euler(Rs)))
        return p

    def wrist_angle(self, k):
        """Total wrist rotation (deg) a key needs (plausibility check)."""
        p = self.pose(k)
        return float(np.linalg.norm(p["hand"][:3]))

    def mirrored_rig(self):
        rig = R.Rig()
        for b in self.rig.bones:
            h = b.head * np.array([1, -1, 1])
            t = None if b.tail is None else b.tail * np.array([1, -1, 1])
            rig.add(b.name, None if b.parent < 0 else self.rig.bones[b.parent].name, h, tail=t)
        return rig


def build_v(mirror=V_MIRROR, layout=None, name="pokemon/v_pokeball.mdl", sequences=None):
    vm = VModel(layout)
    L = vm.L
    lay = L.lay
    rig_d = vm.rig
    rig = vm.mirrored_rig() if mirror else rig_d
    flipv = np.array([1.0, -1.0, 1.0])

    def shape(s):
        return s.flip(1) if mirror else s

    def unmirror(fn):
        if not mirror:
            return fn

        def g(P, N, skin):
            return fn(P * flipv, N * flipv, skin)
        return g

    def mesh(m):
        return flip_mesh(m) if mirror else m

    # --- shapes (design space)
    palm = L.sdf_h(palm_sdf(lay))
    guard = L.sdf_h(knuckle_guard_sdf(lay))
    fingers = {n: L.sdf_h(finger_sdf(lay[n], rads)) for n, _, _, _, rads in FINGERS}
    thumb = L.sdf_h(finger_sdf(lay["thumb"][1:], THUMB_RAD + (0.40,)))
    sleeve = L.sdf_a(sleeve_sdf(L))
    gcuff = L.sdf_a(glove_cuff_sdf(L))
    hand_all = sdf.union(palm, *fingers.values(), thumb, gcuff, k=0.05)
    ball_ao = sdf.sphere(L.ball_c, V_R)
    occ = sdf.union(hand_all, ball_ao, sleeve)

    ap = ArmPaint(L, occ, vm.joints, vm.joints["thumb"][1:])

    # ball, placed: ball frame -> view
    spec = BallSpec(V_R, n=30, arc_steps=8)
    Rb = L.ball_R
    bpaint = BallPaint(spec, Rm=Rb, c=L.ball_c)

    def xf(m):
        return mesh(m.transformed(Rb, L.ball_c))

    b = builder.ModelBuilder(name, rig, skins=3, verbose=False)
    b.group("arm", size=(512, 256), pack="skyline")
    b.group("ball", size=(256, 256), pack="skyline")
    b.group("fx", size=(32, 32), flags=mdl.STUDIO_NF_ADDITIVE | mdl.STUDIO_NF_FULLBRIGHT, pack="skyline")
    b.add(builder.Part("sleeve", shape(sleeve), bone="arm", paint=unmirror(ap.sleeve), group="arm", budget=680,
                       density=0.65))
    b.add(builder.Part("gcuff", shape(gcuff), bone="arm", paint=unmirror(ap.cuff), group="arm", budget=200,
                       density=0.7))
    b.add(builder.Part("palm", shape(palm), bone="hand", paint=unmirror(ap.palm), group="arm", budget=620,
                       density=1.8))
    b.add(builder.Part("guard", shape(guard), bone="hand", paint=unmirror(ap.guard), group="arm", budget=140,
                       density=1.5))
    for n in fingers:
        b.add(builder.Part(n, shape(fingers[n]), bones=[n + "1", n + "2"], paint=unmirror(ap.finger(n)), group="arm",
                           budget=180, density=1.8))
    b.add(builder.Part("thumb", shape(thumb), bones=["thumb1", "thumb2"], paint=unmirror(ap.thumb), group="arm",
                       budget=180, density=1.8))
    shell, steps = split_annuli(spec.solid(), spec.r)
    b.add(builder.Part("ball", mesh=xf(shell), bone="ball", paint=unmirror(bpaint.shell), group="ball",
                       crease=40, charts=bpaint.emblem_charts(mirror)))
    b.add(builder.Part("steps", mesh=xf(steps), bone="ball", paint=unmirror(bpaint.shell), group="ball",
                       crease=40, density=0.15, hitbox=False))
    b.add(builder.Part("button", mesh=xf(spec.button(n=18)), bone="ball", paint=unmirror(bpaint.button),
                       group="ball", crease=50, density=1.5, hitbox=False))
    b.add(builder.Part("btnglow", mesh=xf(spec.button_glow(n=14)), bone="ball", paint=unmirror(bpaint.button_glow),
                       group="fx", crease=80, hitbox=False))

    seqs = sequences(vm) if sequences else v_sequences(vm)
    for s_name, fn, frames, fps, loop, events in seqs:
        pf = (lambda f: (lambda t: mirror_pose(f(t))))(fn) if mirror else fn
        b.add_sequence(R.make_sequence(rig, s_name, pf, frames=frames, fps=fps, loop=loop, events=events))
    b.eyeposition = (0, 0, 0)
    return b.write()


def _lerp_keys(t, track, interp="cubic"):
    """Interpolate a track [(time, key dict), ...] of VModel.pose keys (vectors and scalars) at t."""
    names = sorted({n for _, k in track for n in k if n != "ball"})
    out = {}
    for n in names:
        pts = []
        for tk, k in track:
            if n in k:
                pts.append((tk, k[n]))
        out[n] = R.keys(t, pts, interp=interp)
    return out


# throw: the server spawns its world ball as the throw starts, at THROW_HANDOFF * W_R / V_R (view space,
# design: +y left; same direction, same apparent size): eye + forward * 34 + right * 10 + up * 1 (with its wall
# trace from the eye).  The client draws entities ex_interp = 0.1 s in the past (xash3d default), while the
# view model plays its throw as soon as the message arrives: on screen the world ball is at its own path's
# P(s - 0.1) at s seconds into the view's throw, and first shows up ~130 ms in, ~0.03 s along its path.
# So the view throw cocks the arm back a little (2 frames), snaps forward and lets go of the ball at
# THROW_HANDOFF at THROW_REL_S = 0.1 s (frame 3), then the view ball flies the world ball's own path scaled
# by V_R / W_R (the same screen spot and size at every instant, P(s - 0.1)) until THROW_VIS_S, overlapping
# the world ball once it shows; then it recedes along its line of sight to sub-pixel and is parked out of
# the view.  The path is the server's for a level aim (Throw(): 10 deg above the view, (90 + 10) * 6 = 600 u/s;
# ball gravity 0.6 * 800); the thrower's own velocity cancels out (the eye moves with it).
THROW_HANDOFF = (15.5, -4.5, 0.5)
THROW_FAR = 1200.0
THROW_SPEED = 600.0          # world units / s
THROW_ELEV = 10.0            # deg above the line of sight
THROW_GRAVITY = 0.6 * 800.0  # world units / s^2
THROW_SPIN = 540.0           # deg / s, rolling forward like the world ball (avelocity.x -540)
THROW_COCK_S = 0.078         # the arm cocks back, then snaps: the held ball at THROW_REL_S
THROW_REL_S = 3.0 / 30.0     # the ball at THROW_HANDOFF, leaving the hand (= the client's ex_interp)
THROW_VIS_S = 6.0 / 30.0     # the view ball flies until frame 6 (200 ms), recedes by frame 7, parked from 8


def v_sequences(vm):
    """idle (loop, subtle sway), draw, pinpull (wind-up, holds), throw (cock, snap, the ball let go at the world ball's spawn spot), holster."""
    rest = vm.rest_key()
    W0, u0, hx0, pn0 = rest["W"], rest["u"], rest["hx"], rest["pn"]
    v = lambda *a: np.array(a, dtype=np.float64)  # noqa: E731
    Lb = vm.L

    def with_rest(k):
        out = dict(rest)
        out.update(k)
        out.setdefault("grip", 0.0)
        out.setdefault("thumb", 0.7 * out["grip"])
        out.setdefault("ball_turn", 0.0)
        return out

    rest = with_rest({})

    def wrist_for(ball, hx, pn):
        """Wrist position putting the ball's centre at `ball` for a hand orientation (hx, pn)."""
        Qt = frame_from(hx, -np.asarray(pn, dtype=np.float64))
        return np.asarray(ball, dtype=np.float64) - Qt @ BALL_H

    # the wind-up: arm raised beside the head, fingers up, palm (and ball) turned towards the middle of the
    # view; the ball stays whole inside 4:3 and 16:9, its face turned towards the eye
    r_hx, r_pn = v(0.30, 0.20, 1.0), v(-0.25, 0.95, -0.05)
    READY = with_rest({"W": wrist_for((11.0, -5.6, 1.4), r_hx, r_pn), "u": v(0.25, 0.30, 1.0), "hx": r_hx,
                       "pn": r_pn, "grip": 3.0})
    Hr = vm.rig.world(vm.pose(READY))[vm.rig.index("hand")][:, :3]
    e_dir = Lb.ball_R @ np.array([math.cos(math.radians(50)), 0.0, math.sin(math.radians(50))])
    face = Hr @ e_dir
    ball_w = Hr @ (Lb.ball_c - Lb.W) + READY["W"]
    want = -ball_w / np.linalg.norm(ball_w)
    ax = np.cross(face, want)
    # the fingers roll the ball a little (at most 35 deg, the button passing between the fingers' tips)
    TURN = min(35.0, math.degrees(math.atan2(np.linalg.norm(ax), face @ want)))
    vm.turn_axis = Hr.T @ (ax / max(np.linalg.norm(ax), 1e-9))
    READY["ball_turn"] = TURN
    LOW = with_rest({"W": W0 + v(-1.5, -3.0, -8.0), "u": u0 + v(0.0, -0.1, -0.35), "hx": hx0 + v(0.0, -0.3, -0.2),
                     "pn": pn0 + v(0.0, -0.3, 0.0), "grip": -10.0})

    def idle(t):
        k = dict(rest)
        k.pop("thumb")
        br = R.breathe(t, freq=1)
        sway = R.wave(t, freq=1, phase=0.3)
        k["W"] = W0 + v(0.05 * sway, 0.10 * R.wave(t, freq=1, phase=0.05), 0.16 * br)
        k["pn"] = pn0 + v(0.03 * R.wave(t, freq=2, phase=0.1), 0.0, 0.025 * sway)
        k["hx"] = hx0 + v(0.0, 0.02 * R.wave(t, freq=1, phase=0.6), 0.0)
        # the fingers re-settle on the ball once per cycle (index first)
        k["grip"] = -5.0 * R.pulse(t, 0.55, 0.62, 0.66, 0.76)
        k["g_index"] = -5.0 * R.pulse(t, 0.50, 0.56, 0.60, 0.70)
        k["thumb"] = -4.0 * R.pulse(t, 0.52, 0.60, 0.64, 0.74)
        return vm.pose(k)

    def draw(t):
        # up from just below the view with a little overshoot, the ball tossed and caught in the hand
        track = [(0.0, with_rest(LOW)),
                 (0.36, with_rest({"W": W0 + v(0.2, 0.15, 0.55), "pn": pn0 + v(0.05, 0.0, 0.0), "grip": -6.0})),
                 (0.58, with_rest({"W": W0 + v(0.0, 0.0, -0.25), "grip": -10.0, "thumb": -12.0})),
                 (0.78, with_rest({"W": W0 + v(0.0, 0.0, 0.08), "grip": 1.5})),
                 (1.0, with_rest({"grip": 0.0}))]
        k = _lerp_keys(t, track, interp="smooth")
        pose = vm.pose(k)
        # the toss: the ball pops out of the hand (up and towards the middle of the view), spins a full turn
        hop = R.pulse(t, 0.38, 0.54, 0.54, 0.72, ease=lambda x: math.sin(x * math.pi / 2))
        if hop > 0:
            k2 = dict(k)
            Wm = vm.rig.world(pose)
            hand = Wm[vm.rig.index("hand")]
            cur = hand[:, :3] @ (Lb.ball_c - Lb.W) + hand[:, 3]
            out = Lb.Q @ np.array([0.0, 0.0, -1.0])  # out of the palm
            k2["ball"] = cur + (hand[:, :3] @ out) * 1.0 * hop + v(0.0, 0.0, 1.3) * hop
            k2["ball_spin"] = 360.0 * R.window(t, 0.40, 0.70)
            pose = vm.pose(k2)
        return pose

    def pinpull(t):
        # dip, then the arm comes up; the grip opens while the fingers roll the ball, and closes again
        track = [(0.0, dict(rest)),
                 (0.16, with_rest({"W": W0 + v(-0.6, 0.3, -0.9), "pn": pn0 + v(0.0, 0.0, 0.1), "grip": 3.0})),
                 (0.40, with_rest({"W": (W0 + READY["W"]) / 2 + v(-0.8, -0.3, 0.6), "u": (u0 + READY["u"]) / 2,
                                   "hx": (hx0 + READY["hx"]) / 2, "pn": (pn0 + READY["pn"]) / 2, "grip": -6.0,
                                   "thumb": -8.0, "ball_turn": TURN * 0.45})),
                 (0.62, with_rest({"W": READY["W"] + v(-0.6, -0.3, 0.4), "u": READY["u"] + v(-0.05, 0.0, 0.0),
                                   "hx": READY["hx"] + v(-0.1, 0.0, 0.0), "pn": READY["pn"],
                                   "grip": -5.0, "thumb": -6.0, "ball_turn": TURN * 0.92})),
                 (0.85, READY), (1.0, READY)]
        return vm.pose(_lerp_keys(t, track, interp="smooth"))

    THROW_S = 0.6
    COCK_T = THROW_COCK_S / THROW_S
    REL_T = THROW_REL_S / THROW_S        # frame 3: the ball still in the hand, at the world ball's spawn spot
    VIS_T = THROW_VIS_S / THROW_S        # last frame on the world ball's path
    FAR_T = VIS_T + 1.0 / 18.0           # next frame: far away on the same line of sight (sub-pixel)
    hand_off = np.asarray(THROW_HANDOFF, dtype=np.float64)
    park = v(0.0, 0.0, -THROW_FAR)
    kv = V_R / W_R
    el = math.radians(THROW_ELEV)
    vel = THROW_SPEED * v(math.cos(el), 0.0, math.sin(el))
    grav = v(0.0, 0.0, -THROW_GRAVITY)

    def flight(s):
        """View-space ball centre s seconds into the view's throw: the world ball's path as the client draws
        it (ex_interp behind), scaled into view space."""
        tau = s - THROW_REL_S
        return hand_off + kv * (vel * tau + 0.5 * grav * tau * tau)

    p_vis = flight(THROW_VIS_S)
    far = p_vis / np.linalg.norm(p_vis) * THROW_FAR
    # the cock: back, a little out and up, the grip tighter
    COCK = with_rest({"W": READY["W"] + v(-0.8, -0.6, 0.45), "u": READY["u"] + v(-0.10, -0.05, 0.08),
                      "hx": READY["hx"] + v(-0.12, 0.0, 0.08), "pn": READY["pn"], "grip": 5.0})
    # the snap and follow-through (times from the snap's start; the held ball passes THROW_HANDOFF 25 ms in)
    SNAP = [(0.07, with_rest({"W": v(13.2, -6.0, 0.6), "u": v(0.55, 0.3, 0.8), "hx": v(0.7, 0.2, 0.7),
                              "pn": v(0.7, 0.05, -0.7), "grip": -8.0})),
            (0.20, with_rest({"W": v(15.0, -3.6, -3.5), "u": v(0.75, 0.3, 0.3), "hx": v(0.9, 0.2, -0.3),
                              "pn": v(0.1, 0.1, -1.0), "grip": -14.0, "thumb": -10.0})),
            (0.42, with_rest({"W": v(12.5, -1.0, -13.0), "u": v(0.65, 0.45, -0.45), "hx": v(0.4, 0.45, -0.8),
                              "pn": v(-0.4, 0.3, -0.85), "grip": -10.0, "thumb": -8.0})),
            (0.70, with_rest({"W": v(9.0, 0.5, -21.0), "u": v(0.3, 0.5, -0.8), "hx": v(0.1, 0.5, -0.85),
                              "pn": v(-0.6, 0.4, -0.6), "grip": -2.0, "thumb": -4.0})),
            (1.0, with_rest({"W": v(8.0, 0.5, -24.0), "u": v(0.3, 0.5, -0.8), "hx": v(0.1, 0.5, -0.85),
                             "pn": v(-0.6, 0.4, -0.6), "grip": 4.0, "thumb": 0.0}))]
    TRACK = [(0.0, READY), (0.5 * COCK_T, COCK), (COCK_T, READY)] + \
        [(COCK_T + ts * (1.0 - COCK_T), k) for ts, k in SNAP]

    def throw_key(t):
        k = _lerp_keys(t, TRACK, interp="cubic")
        k["ball_turn"] = READY["ball_turn"]
        return k

    def throw(t):
        k = throw_key(t)
        if t > REL_T + 1e-6:
            s = t * THROW_S
            if t <= VIS_T + 1e-6:
                k["ball"] = flight(s)
            elif t <= FAR_T + 1e-6:
                k["ball"] = far
            else:
                k["ball"] = park
            k["ball_spin"] = THROW_SPIN * (min(t, FAR_T) * THROW_S - THROW_REL_S)
        return vm.pose(k)

    def holster(t):
        track = [(0.0, dict(rest)),
                 (0.18, with_rest({"W": W0 + v(0.2, 0.1, 0.45), "grip": 2.0})),
                 (1.0, with_rest({"W": W0 + v(-1.5, -3.0, -12.5), "u": u0 + v(0.0, -0.1, -0.35),
                                  "hx": hx0 + v(0.0, -0.3, -0.2), "pn": pn0 + v(0.0, -0.3, 0.0), "grip": -10.0}))]
        k = _lerp_keys(t, track, interp="smooth")
        return vm.pose(k)

    return [("idle", idle, 120, 30, True, ()),
            ("draw", draw, 25, 30, False, ()),
            ("pinpull", pinpull, 14, 30, False, ()),
            ("throw", throw, 19, 30, False, ()),
            ("holster", holster, 16, 30, False, ())]


def build(out):
    out["models/pokemon/w_pokeball.mdl"] = build_w()
    out["models/pokemon/p_pokeball.mdl"] = build_p()
    out["models/pokemon/v_pokeball.mdl"] = build_v()
