"""Half Strike Poke Balls: effect sprites, HUD sprites and every sound of the contract.

Everything is synthesised here (numpy + Pillow through the toolchain), deterministically: every
random draw comes from a seeded generator, so the same code gives the same bytes.

Sprites (sprites/pokemon/):
  zap.spr      beam texture (additive, 8 frames 64x128): a white-hot bolt with a wide core and pale
               yellow glow, built for the engine's ~8:1 stretch (u = the beam's few units of width,
               v = 100 units of length, tiled): low-frequency kinks over most of the width, bright
               nodes along v, fading to black at u = 0 / 1; tileable vertically.  Any start frame
               works on its own.
  fire.spr     flame puff (additive, 12 frames 64x64): a round, billowing fireball that swells to
               ~0.8 of the half-size, cools from yellow-orange to orange and dark red and frays;
               peak ~0.7 per puff, no white core (blue low), so a stream's 3-8 stacked puffs read
               orange-yellow; every frame usable alone (TE_SPRAY particles).
  Every effect frame is exact palette black from 85 % of its half-size out (radial window; zap:
  across the beam only) with a black floor on the faint tail: see _black_floor (engine texgamma).
  water.spr    splash (additive, 8 frames 64x64): dim, desaturated foam mist with droplets thrown up
               in a fan and arcing down; open from frame 0, every frame usable alone.  Played by
               the server as short TE_EXPLOSION puffs (~28 fps, ~0.25 s), never TE_SPRITE (10 fps).
  drops.spr    thrown droplets (additive, 4 frames 32x32): the TE_SPRAY particles of Hydro Pump's
               splash (the engine draws them at scale 1 for 0.3 s: small and short on purpose).
  flash.spr    release / return glow (additive, 8 frames 128x128): a big white bloom (frame 0) that
               collapses into a four-point sparkle, blue-white halo and a thick shock ring.
  hud.spr      weapon selection icons (additive, 512x256 sheet, 170x45 icons, inactive / active)
               in the 640 HUD's look (a centred silhouette: the ball and its species' mark, no text) plus the
               ammo icon (24x24); grey, the engine tints them.
  d_pokemon.spr  death notice icon (additive, 48x16, the whole frame is the icon).
HUD definitions: sprites/weapon_pk_{pikachu,charizard,blastoise}.txt (320 and 640 lines).
Sounds (sound/pokemon/*.wav, 22050 Hz mono 16-bit), levelled by category to a short-term loudness
(LOUDNESS), peaks <= 0.9, voices and buzzes from band-limited sources (no aliasing).
"""
import math

import numpy as np
from PIL import Image

from .. import icons, spr, texture as T, wav as W

SPECIES = ("pikachu", "charizard", "blastoise")

# HUD sheet layout (sprites/pokemon/hud.spr, 512x256): one row per species, inactive icon at x = 0,
# active at x = 172 (2 px gutters so linear filtering never bleeds a neighbour), ammo at (344, 0).
HUD_W, HUD_H = 512, 256
ICON_W, ICON_H = 170, 45
ROW_Y = {"pikachu": 0, "charizard": 47, "blastoise": 94}
ACTIVE_X, INACTIVE_X = 172, 0
AMMO_RECT = (344, 0, 24, 24)

# effect sprites: everything is exactly black from WINDOW_END of the half-size outwards (radially for
# the puffs, across the beam for zap), and below FX_FLOOR (a level after the engine's texgamma)
WINDOW_END = 0.85
FX_FLOOR = 2.5 / 255.0


# ---------------------------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------------------------

def _smooth(e0, e1, x):
    t = np.clip((np.asarray(x, dtype=np.float64) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _ease_out(t, p=2.0):
    return 1.0 - (1.0 - t) ** p


def _grid(n):
    """Pixel-centre coordinates in [-1, 1] with y up: (x, y) arrays (n, n)."""
    c = (np.arange(n) + 0.5) / n * 2 - 1
    x, y = np.meshgrid(c, -c)
    return x, y


class _Noise:
    """Periodic 2D value noise (quintic interpolation) with fBm; deterministic per seed."""

    def __init__(self, seed, size=16, octaves=4):
        rng = np.random.default_rng(seed)
        self.size = size
        self.grids = [rng.random((size, size)) for _ in range(octaves)]

    def _one(self, g, x, y):
        n = self.size
        xi, yi = np.floor(x), np.floor(y)
        fx, fy = x - xi, y - yi
        ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
        uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
        x0, y0 = xi.astype(np.int64) % n, yi.astype(np.int64) % n
        x1, y1 = (x0 + 1) % n, (y0 + 1) % n
        a = g[y0, x0] + (g[y0, x1] - g[y0, x0]) * ux
        b = g[y1, x0] + (g[y1, x1] - g[y1, x0]) * ux
        return a + (b - a) * uy

    def fbm(self, x, y, gain=0.5, lacunarity=2.0, drift=None):
        """Sum of octaves in [0, 1]; drift: optional per-octave (dx, dy) offsets (scrolling)."""
        tot, amp, s, norm = 0.0, 1.0, 1.0, 0.0
        for k, g in enumerate(self.grids):
            dx, dy = drift[k] if drift is not None else (0.0, 0.0)
            tot = tot + amp * self._one(g, x * s + dx + 17.3 * k, y * s + dy + 9.1 * k)
            norm += amp
            amp *= gain
            s *= lacunarity
        return tot / norm


def _ramp(v, stops):
    """Colour ramp: v (any shape) in [0, 1] through [(pos, (r, g, b)), ...]."""
    v = np.clip(np.asarray(v, dtype=np.float64), 0.0, 1.0)
    pos = np.array([p for p, _ in stops])
    cols = np.array([c for _, c in stops], dtype=np.float64)
    return np.stack([np.interp(v, pos, cols[:, k]) for k in range(3)], axis=-1)


def _disc_window(x, y, start=0.55, end=WINDOW_END):
    """Radial window on _grid coordinates: 1 inside `start`, smooth fall to exactly 0 at `end`
    (fractions of the half-size), 0 beyond: the frame's border and corners are pure black."""
    return _smooth(end, start, np.hypot(x, y))


def _black_floor(col, floor=FX_FLOOR):
    """Hue-preserving black floor: the brightest channel m becomes (m - floor) / (1 - floor), so the
    faint tail of a glow reaches exactly 0 (palette black) continuously instead of leaving a haze of
    1-2 level texels.  Needed because the engine loads additive sprite palettes through its texgamma
    table (pow(v, texgamma / gamma) = pow(v, 0.8) by default): a raw level 1 becomes 3, 2 becomes 5,
    and a stack of overlapping puffs shows that haze as a square around each frame."""
    col = np.clip(np.asarray(col, dtype=np.float64), 0.0, 1.0)
    m = col.max(axis=-1, keepdims=True)
    k = np.clip((m - floor) / (1.0 - floor), 0.0, 1.0) / np.maximum(m, 1e-9)
    return col * k


def _additive_sprite(frames, type=spr.VP_PARALLEL, origins=None, dark=None):
    """Additive sprite from premultiplied RGB frames (H, W, 3) float in [0, 1].

    Black must stay exactly black (an additive quad otherwise shows as a faint box): pixels below
    half a level are written as index 255 with palette[255] = (0, 0, 0), the other colours get the
    remaining 255 entries.  dark: optional bool mask (H, W) of texels that must come out as index
    255 in every frame (the window's outside); checked, a SprError otherwise."""
    frames = [np.clip(np.asarray(f, dtype=np.float64), 0.0, 1.0) for f in frames]
    Wm = max(f.shape[1] for f in frames)
    big = np.zeros((sum(f.shape[0] for f in frames), Wm, 3))
    y = 0
    for f in frames:
        big[y:y + f.shape[0], :f.shape[1]] = f
        y += f.shape[0]
    black = big.max(axis=-1) < 0.5 / 255.0
    idx, pal = T.quantize(big, 256, transparent=black)
    pal[255] = (0, 0, 0)
    out, y = [], 0
    for i, f in enumerate(frames):
        out.append(idx[y:y + f.shape[0], :f.shape[1]].copy())
        y += f.shape[0]
        if dark is not None and (out[-1][dark] != 255).any():
            raise spr.SprError(f"frame {i}: {int((out[-1][dark] != 255).sum())} lit texels outside the window")
    return spr.write(out, pal, type=type, tex_format=spr.ADDITIVE, origins=origins)


def _seg_dist(px, py, ax, ay, bx, by):
    """Distance of pixel grids to the segment a-b."""
    vx, vy = bx - ax, by - ay
    L2 = vx * vx + vy * vy
    t = np.clip(((px - ax) * vx + (py - ay) * vy) / max(L2, 1e-12), 0.0, 1.0)
    dx, dy = px - (ax + t * vx), py - (ay + t * vy)
    return np.sqrt(dx * dx + dy * dy)


def _poly_dist(px, py, pts):
    d = np.full(px.shape, 1e9)
    for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
        d = np.minimum(d, _seg_dist(px, py, ax, ay, bx, by))
    return d


# ---------------------------------------------------------------------------------------------
# zap.spr: lightning beam texture
# ---------------------------------------------------------------------------------------------

def _bolt_path(rng, x0, y0, x1, y1, levels, amp, decay=0.55, clamp=None):
    pts = [(x0, y0), (x1, y1)]
    a = amp
    for _ in range(levels):
        new = [pts[0]]
        for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
            mx, my = (ax + bx) / 2, (ay + by) / 2
            L = math.hypot(bx - ax, by - ay)
            nx, ny = -(by - ay) / max(L, 1e-9), (bx - ax) / max(L, 1e-9)
            off = rng.uniform(-1, 1) * a
            mx, my = mx + nx * off, my + ny * off
            if clamp:
                mx = min(max(mx, clamp[0]), clamp[1])
            new += [(mx, my), (bx, by)]
        pts = new
        a *= decay
    return pts


def make_zap(frames=8, w=64, h=128, seed=4101):
    """Frames of a vertical, vertically tileable bolt (u across the beam, v along it).

    Designed for the engine's mapping: u spans the beam's width (a few units) while v repeats
    every 100 units, so a texel is stretched ~8x along the beam.  Hence a wide hot core (the
    middle third of u), a path that wanders over most of the width at low frequency (a few big
    kinks per tile rather than fine jitter that the stretch would flatten), no thin forks (they
    become sub-pixel slivers), and bright "nodes" along v that give the length a rhythm.
    Every frame (any start frame, any tile phase) stands on its own."""
    rng = np.random.default_rng(seed)
    py, px = np.mgrid[0:h, 0:w].astype(np.float64)
    px += 0.5
    py += 0.5
    cx = w / 2.0
    # across-the-beam window: exactly black from 85 % of the half-width out, whatever the bolt does
    # (v tiles, so no window along the beam)
    edge = _smooth(WINDOW_END, 0.50, np.abs(2.0 * px / w - 1.0))
    white = np.array([1.0, 1.0, 1.0])
    pale = np.array([1.0, 0.95, 0.66])
    yellow = np.array([1.0, 0.80, 0.28])
    out = []
    for f in range(frames):
        # the tile's two ends share x (seamless), different per frame
        x_end = cx + rng.uniform(-0.12, 0.12) * w
        main = _bolt_path(rng, x_end, 0.0, x_end, float(h), 3, w * 0.27, 0.5,
                          clamp=(cx - w * 0.26, cx + w * 0.26))
        # tileable: the same path one period above and below
        d = np.full(px.shape, 1e9)
        for dy in (-h, 0, h):
            d = np.minimum(d, _poly_dist(px, py, [(x, y + dy) for x, y in main]))
        core = np.exp(-(d / 4.5) ** 2)
        inner = np.exp(-(d / 9.0) ** 2)
        outer = np.exp(-d / 14.0)
        # nodes: wider glow blobs at some of the kinks (3-4 per tile, periodic in v)
        nodes = np.zeros(px.shape)
        kinks = main[1:-1]
        pick = rng.choice(len(kinks), size=min(len(kinks), 3 + int(rng.integers(0, 2))), replace=False)
        for i in pick:
            nx_, ny_ = kinks[i]
            s, b = rng.uniform(8.0, 12.0), rng.uniform(0.75, 1.0)
            for dy in (-h, 0, h):
                r2 = ((px - nx_) / s) ** 2 + ((py - ny_ - dy) / (s * 1.3)) ** 2
                nodes = np.maximum(nodes, np.exp(-r2) * b)
        # brightness pulse along v (periodic), so the core is not one flat wire
        ph = rng.uniform(0, 1)
        flick = 0.70 + 0.30 * np.sin(2 * np.pi * (py / h * 2 + ph)) ** 2
        col = (core[..., None] * white * 0.85 + inner[..., None] * pale * 0.42 + outer[..., None] * yellow * 0.22
               + nodes[..., None] * (0.75 * white + 0.45 * pale))
        col *= (edge * flick)[..., None]
        # soft clip: the core is white-hot without a flat plateau
        col = 1.0 - np.exp(-col * 1.6)
        out.append(np.clip(_black_floor(col), 0, 1))
    return out


# ---------------------------------------------------------------------------------------------
# fire.spr: flame puff
# ---------------------------------------------------------------------------------------------

# no white end: the hottest core is yellow-orange (blue stays low), so a stack of overlapping puffs
# saturates red then green (yellow), never all three (white)
FIRE_RAMP = [(0.0, (0.0, 0.0, 0.0)), (0.08, (0.13, 0.02, 0.0)), (0.20, (0.35, 0.06, 0.0)),
             (0.36, (0.70, 0.18, 0.01)), (0.52, (0.92, 0.38, 0.04)), (0.68, (0.97, 0.54, 0.08)),
             (0.84, (0.99, 0.67, 0.15)), (0.94, (1.0, 0.76, 0.23)), (1.0, (1.0, 0.81, 0.30))]
FIRE_GAIN = 0.68          # one puff's peak; the stream stacks ~3-8 of them


def make_fire(frames=12, n=64, seed=5203):
    """Flame puff for a flamethrower stream: a roughly round, billowing fireball (domain-warped
    noise gives the tongues and lobes) that swells to fill the frame, so that neighbouring puffs
    along the stream overlap into one continuous jet; it cools from yellow to orange and dark
    red and frays at its rim.  Every frame also stands alone (the engine's TE_SPRAY shows one
    random static frame per particle), so the last ones stay reasonably bright."""
    noise = _Noise(seed, 16, 5)
    lobes = _Noise(seed + 4, 16, 3)
    wx, wy = _Noise(seed + 1, 16, 3), _Noise(seed + 2, 16, 3)
    rng = np.random.default_rng(seed + 3)
    x, y = _grid(n)
    embers = [(rng.uniform(-0.5, 0.5), rng.uniform(-0.2, 0.3), rng.uniform(0.25, 0.5), rng.uniform(0.5, 0.9))
              for _ in range(6)]
    out = []
    for f in range(frames):
        t = f / (frames - 1)
        cy = -0.04 + 0.06 * t
        # the swollen puff stays inside the window (rim ~0.8 of the half-size at the last frame)
        R = 0.50 + 0.24 * _ease_out(t, 2.0)
        up = 1.2 * t + 0.2
        # domain warp, scrolling upward: the same fields over the frames give continuous motion
        ox = wx.fbm(x * 1.7 + 3.1, y * 1.7 - up + 1.7) - 0.5
        oy = wy.fbm(x * 1.7 + 8.3, y * 1.7 - up + 4.2) - 0.5
        warp = 0.32 + 0.22 * t
        xs, ys = x + warp * ox, y + warp * oy
        dy = ys - cy
        # nearly round, a little taller above the centre (hot gas rises)
        stretch = np.where(dy > 0, 1.15, 0.95)
        q = np.sqrt(xs ** 2 + (dy / stretch) ** 2) / R
        # billows: low-frequency lobes on the rim, finer turbulence on top
        lob = lobes.fbm(xs * 1.6 + 2.0, ys * 1.6 - 0.6 * up + 7.0)
        drift = [(0.0, -up * (1.0 + 0.7 * k)) for k in range(5)]
        nz = noise.fbm(xs * 2.6 + 5.0, ys * 2.6 + 2.0, drift=drift)
        d = q + 0.40 * (lob - 0.5) + 0.30 * (nz - 0.5)
        dens = _smooth(1.05, 0.62, d)
        # fraying: the low-noise parts of the rim thin out as it cools (soft, no holes)
        dens = dens * (1.0 - 0.75 * t * _smooth(0.62, 0.30, nz) * _smooth(0.30, 0.80, q))
        core = np.exp(-(q / (0.50 - 0.14 * t)) ** 2)
        ridge = 1.0 - np.abs(2.0 * noise.fbm(xs * 4.6 + 1.0, ys * 3.4 - 2.0 * up + 3.0) - 1.0)
        cool = 1.0 - 0.55 * t ** 0.9
        heat = 0.80 * dens * (0.40 + 0.62 * core) * (0.70 + 0.45 * ridge) * cool
        col = _ramp(heat, FIRE_RAMP)
        col = col * (np.clip(heat * 2.4, 0, 1) ** 0.7)[..., None]
        if t >= 0.3:
            u = (t - 0.3) / 0.7
            for ex, ey, sp, sz in embers:
                px_, py_ = 0.8 * ex * (1 + 0.3 * u), 0.8 * (ey + sp * u) + 0.1
                r = np.hypot(x - px_, (y - py_) * 0.6)
                g = np.exp(-(r / 0.028) ** 2) * (1 - 0.6 * u) * sz * 0.45
                col = col + g[..., None] * np.array([1.0, 0.62, 0.18])
        col = _black_floor(col * FIRE_GAIN * _disc_window(x, y, 0.50)[..., None])
        out.append(np.clip(col, 0, 1))
    return out


# ---------------------------------------------------------------------------------------------
# water.spr: spray burst
# ---------------------------------------------------------------------------------------------

def make_water(frames=8, n=64, seed=6301):
    """Water splash: a ragged, noisy foam mist with droplets thrown up in a fan that arc down
    under gravity (a splash crown seen from the side).  Kept dim and desaturated: additive water
    must read as spray catching the light, not as a light source.  Every frame stands alone
    (TE_SPRAY shows one random static frame per particle): frame 0 is already open (no disc),
    the last one still holds spray."""
    rng = np.random.default_rng(seed)
    noise = _Noise(seed, 16, 4)
    clumps = _Noise(seed + 1, 16, 3)
    x, y = _grid(n)
    ox_, oy_ = 0.0, -0.16                      # burst origin, low so the fan has room to rise and fall
    drops = []
    for _ in range(26):
        a = math.radians(90 + 8 + rng.uniform(-60, 60))          # 120 deg fan, leaning a little left
        drops.append((math.cos(a), math.sin(a), rng.uniform(0.40, 0.98), rng.uniform(0.026, 0.046),
                      rng.uniform(0.5, 1.0)))
    white = np.array([0.60, 0.64, 0.68])
    blue = np.array([0.30, 0.45, 0.60])
    mist_c = np.array([0.20, 0.27, 0.34])
    out = []
    for f in range(frames):
        u = f / (frames - 1)
        t = 0.7 * u
        fade = 1.0 - 0.28 * u ** 1.3
        col = np.zeros(x.shape + (3,))
        # foam mist: a cloud over the impact, broken into clumps, rising and spreading
        my = oy_ + 0.06 + 0.16 * u
        mr = 0.40 + 0.26 * _ease_out(u, 1.8)
        r = np.hypot((x - ox_) / 1.25, (y - my) / 0.95)
        nz = noise.fbm(x * 2.4 + 2.0 + u * 0.6, y * 2.4 + 1.0 - u * 0.8)
        cl = clumps.fbm(x * 4.5 + 5.0 - u * 0.4, y * 4.5 + 3.0 - u * 1.0)
        mist = _smooth(1.0, 0.15, r / mr + 0.8 * (nz - 0.5)) * (0.62 + 0.38 * _smooth(0.30, 0.70, cl)) * fade
        col += mist[..., None] * mist_c * 1.9
        # droplets: thrown in the fan, arcing down, streaked along their motion
        tau = 0.36 + 0.62 * _ease_out(u, 1.5)
        for dx, dy, sp, sz, br in drops:
            def pos(s_):
                return ox_ + dx * sp * s_, oy_ + dy * sp * s_ - 0.55 * s_ * s_
            s0 = max(tau - (0.05 + 0.07 * sp), 0.02)
            hx, hy = pos(tau)
            tx, ty = pos(s0)
            mx, my_ = pos((tau + s0) / 2)
            dd = np.minimum(_seg_dist(x, y, tx, ty, mx, my_), _seg_dist(x, y, mx, my_, hx, hy))
            rad = sz * (1 - 0.3 * u)
            ux, uy = hx - tx, hy - ty
            L = max(math.hypot(ux, uy), 1e-6)
            along = np.clip(((x - tx) * ux + (y - ty) * uy) / (L * L), 0, 1)
            g = np.exp(-(dd / rad) ** 2) * (0.25 + 0.75 * along) * br * fade
            hl = np.exp(-(dd / (rad * 0.5)) ** 2) * along ** 3 * br * fade
            col += g[..., None] * blue * 0.8 + hl[..., None] * white * 0.6
        # soft ceiling: overlapping drops never add up to a white hot spot
        col = 0.75 * (1.0 - np.exp(-col / 0.75))
        out.append(np.clip(_black_floor(col * _disc_window(x, y, 0.55)[..., None]), 0, 1))
    return out


# ---------------------------------------------------------------------------------------------
# drops.spr: thrown droplets (TE_SPRAY particles)
# ---------------------------------------------------------------------------------------------

def make_drops(frames=4, n=32, seed=6407):
    """A few droplets for the engine's TE_SPRAY.  Its particles are drawn at scale 1 (one unit a
    texel) and animate at 10 frames a second for frameMax / 10 s, so this sprite is small (32 units)
    and short (4 frames: 0.3 s).  Mostly black: 7 drops with a short trail, a pale glint and a blue
    body, dimming over the frames, never a cloud."""
    rng = np.random.default_rng(seed)
    x, y = _grid(n)
    drops = []
    for k in range(7):
        # spread over the disc (one per sector), inside the window even after falling
        a, rr = 2 * math.pi * (k + rng.uniform(0.15, 0.85)) / 7, 0.5 * math.sqrt(rng.uniform(0.1, 1.0))
        drops.append((rr * math.cos(a), rr * math.sin(a) + 0.08, rng.uniform(0.07, 0.11), rng.uniform(0.75, 1.0),
                      rng.uniform(-0.25, 0.25)))
    blue = np.array([0.28, 0.46, 0.66])
    white = np.array([0.62, 0.68, 0.74])
    out = []
    for f in range(frames):
        u = f / (frames - 1)
        fade = 1.0 - 0.55 * u
        col = np.zeros(x.shape + (3,))
        for dx, dy, sz, br, lean in drops:
            # the head falls a little over the frames; the trail points back up (a falling streak)
            hx, hy = dx + lean * 0.12 * u, dy - 0.14 * u * u
            tx, ty = hx - lean * 0.10, hy + 0.10 + 0.08 * u
            dd = _seg_dist(x, y, tx, ty, hx, hy)
            L = max(math.hypot(hx - tx, hy - ty), 1e-6)
            along = np.clip(((x - tx) * (hx - tx) + (y - ty) * (hy - ty)) / (L * L), 0, 1)
            rad = sz * (1.0 - 0.25 * u)
            g = np.exp(-(dd / rad) ** 2) * (0.30 + 0.70 * along) * br * fade
            hl = np.exp(-(np.hypot(x - hx, y - hy) / (0.45 * rad)) ** 2) * br * fade
            col += g[..., None] * blue * 1.0 + hl[..., None] * white * 0.75
        col = 0.75 * (1.0 - np.exp(-col / 0.75))
        out.append(np.clip(_black_floor(col * _disc_window(x, y, 0.62)[..., None]), 0, 1))
    return out


# ---------------------------------------------------------------------------------------------
# flash.spr: release / return glow
# ---------------------------------------------------------------------------------------------

def make_flash(frames=8, n=128):
    x, y = _grid(n)
    r = np.hypot(x, y)
    white = np.array([1.0, 1.0, 1.0])
    halo_c = np.array([0.70, 0.86, 1.0])
    out = []
    for f in range(frames):
        t = 0.93 * f / (frames - 1)
        k = (1 - t) ** 1.4
        sig = 0.13 + 0.16 * _ease_out(t, 2)
        glow = np.exp(-(r / sig) ** 2) * k
        halo = np.exp(-r / (0.22 + 0.12 * t)) * 0.45 * k
        # the opening burst: a big soft white bloom on frame 0 that collapses into the sparkle by frame 2
        bloom_k = max(0.0, 1.0 - f / 2.0) ** 1.5
        bloom = np.exp(-(r / 0.30) ** 2) * 2.4 * bloom_k + np.exp(-(r / 0.55) ** 2) * 0.5 * bloom_k
        # four-point sparkle (and four thinner diagonals), turning slightly; long on the first frames
        rays = np.zeros_like(r)
        rot = math.radians(12 * t)
        length = 0.78 if f <= 2 else 0.50 + 0.28 * _ease_out(t, 2)
        for j in range(8):
            a = rot + j * np.pi / 4
            along = x * math.cos(a) + y * math.sin(a)
            perp = np.abs(-x * math.sin(a) + y * math.cos(a))
            L = length * (1.0 if j % 2 == 0 else 0.55)
            width = 0.012 + 0.04 * np.clip(1 - along / L, 0, 1) ** 2
            ray = np.exp(-(perp / width) ** 2) * np.clip(1 - along / L, 0, 1) ** 1.4 * (along > 0)
            rays = np.maximum(rays, ray * (1.0 if j % 2 == 0 else 0.6))
        rays *= (1 - t) ** 1.1 * 1.3
        # shock ring: thick, with a bright inner edge
        ring_r = 0.16 + 0.52 * _ease_out(t, 2.2)
        ring_w = 0.06 + 0.04 * t
        ring = np.exp(-((r - ring_r) / ring_w) ** 2) * 0.55
        ring += np.exp(-((r - (ring_r - 0.5 * ring_w)) / (0.018 + 0.01 * t)) ** 2) * 0.75
        ring *= (1 - t) ** 1.6 * (f > 0)
        col = (glow[..., None] * white + halo[..., None] * halo_c + rays[..., None] * (0.6 * white + 0.4 * halo_c)
               + ring[..., None] * (0.5 * white + 0.5 * halo_c) + bloom[..., None] * white)
        col *= _disc_window(x, y, 0.62)[..., None]
        # soft clip keeps the core white without a flat disc
        col = 1 - np.exp(-col * 1.6)
        out.append(np.clip(_black_floor(col), 0, 1))
    return out


# ---------------------------------------------------------------------------------------------
# HUD: weapon icons, ammo icon, death notice icon
# ---------------------------------------------------------------------------------------------

def _ball_image(size, ss, cx, cy, R, accent, tilt=-18.0, turn=-24.0, level=1.0, top_level=0.40):
    """Shaded Poke Ball (greyscale with a light accent on the band) as an RGBA PIL image at
    ss x the output size; cx, cy, R in output pixels.  turn: yaw of the button (deg, negative =
    towards the viewer's left), tilt: roll of the band (deg).  Lines keep at least ~0.6 px at
    small sizes (ammo / death icons) so the ball stays readable."""
    W, H = size[0] * ss, size[1] * ss
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
    X = ((xx + 0.5) / ss - cx) / R
    Y = -((yy + 0.5) / ss - cy) / R
    r2 = X * X + Y * Y
    Z = np.sqrt(np.clip(1 - r2, 0, 1))
    # view space -> ball space: roll by tilt around the view axis, then yaw by turn around the ball's up
    tr, tu = math.radians(tilt), math.radians(turn)
    ct, st = math.cos(tr), math.sin(tr)
    Xr, up = X * ct + Y * st, -X * st + Y * ct
    Fx = Z * math.cos(tu) - Xr * math.sin(tu)        # cosine to the button direction
    # lighting: key light top-left-front, specular, a little rim on the right
    L = np.array([-0.55, 0.62, 0.56])
    L /= np.linalg.norm(L)
    ndl = np.clip(X * L[0] + Y * L[1] + Z * L[2], 0, 1)
    Hv = L + np.array([0, 0, 1.0])
    Hv /= np.linalg.norm(Hv)
    spec = np.clip(X * Hv[0] + Y * Hv[1] + Z * Hv[2], 0, 1) ** 30
    rim = np.clip(1 - Z, 0, 1) ** 3 * np.clip(X * 0.8 - Y * 0.2, 0, 1)
    small = float(np.clip((14.0 - R) / 7.0, 0.0, 1.0))      # 0 at R >= 14, 1 at R <= 7: flatter, bolder
    shade = (0.74 + 0.34 * ndl) * (1 - small) + (0.86 + 0.18 * ndl) * small
    col = np.where(up > 0, top_level, 1.0)[..., None] * np.ones(3)
    # band: the species' accent between dark edge lines
    ew = max(0.035, 0.45 / R)
    band_half = 0.13 + 0.5 * ew
    aband = np.abs(up)
    in_band = _smooth(band_half + 0.02, band_half - 0.01, aband)
    edge_line = _smooth(ew * 1.4, ew * 0.6, np.abs(aband - band_half))
    col = col * (1 - in_band[..., None]) + np.asarray(accent, dtype=np.float64) * in_band[..., None]
    col = col * (1 - 0.9 * edge_line[..., None])
    # button: dark ring, light button, inner ring line
    ang = np.degrees(np.arccos(np.clip(Fx, -1, 1)))
    grow = 1.0 + 0.35 * small
    ring_o, ring_i, btn = 29.0 * grow, 21.0 * grow, 12.0 * grow
    aa = 57.3 / R / 2  # half a pixel in degrees at the front
    m_ring = _smooth(ring_o + aa, ring_o - aa, ang)
    col = col * (1 - m_ring[..., None]) + 0.10 * m_ring[..., None]
    m_btn = _smooth(ring_i + aa, ring_i - aa, ang)
    col = col * (1 - m_btn[..., None]) + 0.97 * m_btn[..., None]
    m_line = np.exp(-((ang - btn) / max(1.6, aa * 1.2)) ** 2) * (1 - small)
    col = col * (1 - 0.45 * m_line[..., None])
    col = col * shade[..., None] + spec[..., None] * 0.5 * (1 - 0.5 * small) + rim[..., None] * 0.15
    col = np.clip(col * level, 0, 1)
    # antialiased disc and a dark outline just outside it
    rr = np.sqrt(r2)
    disc = _smooth(1.0 + 0.5 / R, 1.0 - 0.5 / R, rr)
    outline = _smooth(1.0 + 1.6 / R, 1.0 + 0.9 / R, rr)
    a = np.maximum(disc, outline * 0.9)
    wgt = (disc / np.maximum(a, 1e-6))[..., None]
    rgb = col * wgt + (1 - wgt) * 0.03
    img = np.dstack([np.clip(rgb, 0, 1) * 255, a * 255])
    return Image.fromarray(np.round(img).astype(np.uint8), "RGBA")


ACCENT = {"pikachu": (1.0, 0.92, 0.52), "charizard": (1.0, 0.74, 0.50), "blastoise": (0.62, 0.80, 1.0)}


def _leaf(x0, y0, x1, y1, w, n=14):
    """Leaf / ear polygon from base (x0, y0) to tip (x1, y1), max half-width w."""
    dx, dy = x1 - x0, y1 - y0
    L = math.hypot(dx, dy)
    ux, uy = dx / L, dy / L
    nx, ny = -uy, ux
    left, right = [], []
    for i in range(n + 1):
        s = i / n
        hw = w * (math.sin(math.pi * s) ** 0.8) * (1 - 0.35 * s)
        px, py = x0 + dx * s, y0 + dy * s
        left.append((px + nx * hw, py + ny * hw))
        right.append((px - nx * hw, py - ny * hw))
    return left + right[::-1]


def _ribbon(points, widths):
    """Polygon of a polyline with per-point widths and sharp (mitred) joints: zigzag tails."""
    P = np.asarray(points, dtype=np.float64)
    n = len(P)
    left, right = [], []
    for i in range(n):
        d0 = P[i] - P[i - 1] if i > 0 else P[1] - P[0]
        d1 = P[i + 1] - P[i] if i < n - 1 else P[i] - P[i - 1]
        n0 = np.array([-d0[1], d0[0]]) / max(np.linalg.norm(d0), 1e-9)
        n1 = np.array([-d1[1], d1[0]]) / max(np.linalg.norm(d1), 1e-9)
        m = n0 + n1
        m /= max(np.linalg.norm(m), 1e-9)
        k = 1.0 / max(float(m @ n1), 0.35)
        h = widths[i] / 2 * k
        left.append(tuple(P[i] + m * h))
        right.append(tuple(P[i] - m * h))
    return left + right[::-1]


def _silhouette(c, species, cx, cy, R, grey):
    """Species hint peeking from behind the ball (drawn before the ball), inside the 170x45 icon."""
    g = grey
    dark = tuple(int(v * 0.30) for v in g[:3]) + (255,)
    light = tuple(min(255, int(v * 1.3)) for v in g[:3]) + (255,)
    if species == "pikachu":
        # long pointed ears with black tips leaning out of the ball's top
        tipc = tuple(int(v * 0.50) for v in g[:3]) + (255,)
        for (bx, by, tx, ty, w) in ((cx - 6, cy - R + 9, cx - 17, cy - R - 6.5, 3.9),
                                    (cx + 6, cy - R + 9, cx + 17, cy - R - 6.5, 3.8)):
            c.polygon(_leaf(bx, by, tx, ty, w), fill=g, outline=light, width=1.0)
            sx, sy = bx + (tx - bx) * 0.64, by + (ty - by) * 0.64
            c.polygon(_leaf(sx, sy, tx, ty, w * 0.64), fill=tipc)
        # the lightning-bolt tail out of the ball's left side, broadening to a flat end
        tail = [(cx - R + 3, cy + 7.5), (cx - R - 8, cy + 9), (cx - R - 11, cy + 1.5), (cx - R - 22, cy + 3),
                (cx - R - 28, cy - 9)]
        c.polygon(_ribbon(tail, [3.0, 4.5, 5.5, 8.0, 11.0]), fill=g)
    elif species == "charizard":
        # a bat wing spread behind the ball (left), scalloped trailing edge, finger struts
        sh = (cx - 6, cy - 5)
        tip = (cx - R - 31, cy - R + 1)
        f1 = (cx - R - 25, cy + 3)
        f2 = (cx - R - 13, cy + 10)
        f3 = (cx - R + 3, cy + 13)
        wing = [sh, (cx - R - 6, cy - R - 3.5), (cx - R - 17, cy - R - 3), tip]
        for a, b in ((tip, f1), (f1, f2), (f2, f3)):
            mx, my = (a[0] + b[0]) / 2 + 3.0, (a[1] + b[1]) / 2 - 3.0
            wing += [(mx, my), b]
        c.polygon(wing, fill=g)
        for p in (tip, f1, f2):
            c.line([sh, p], dark, width=1.2)
        c.line([sh, (cx - R - 6, cy - R - 3.5), (cx - R - 17, cy - R - 3), tip], light, width=1.4)
        # tail out of the ball's lower right with its flame
        c.line([(cx + R - 7, cy + R - 5), (cx + R + 1, cy + R - 6), (cx + R + 6, cy + R - 13)], g, width=4.0)
        fx_, fy = cx + R + 7.5, cy + R - 19
        flame = [(fx_ - 4.5, fy + 5), (fx_ - 5.2, fy - 1), (fx_ - 2.2, fy - 5.5), (fx_ - 1.2, fy - 2.5),
                 (fx_ + 1, fy - 10), (fx_ + 3.2, fy - 3.5), (fx_ + 5.2, fy - 6), (fx_ + 5.6, fy + 1), (fx_ + 3, fy + 6)]
        c.polygon(flame, fill=(250, 250, 250, 255))
        c.polygon([(fx_ - 2.5, fy + 4), (fx_ - 2.2, fy), (fx_ + 0.5, fy - 3.5), (fx_ + 2.6, fy + 0.5),
                   (fx_ + 2.1, fy + 4)], fill=tuple(int(v * 0.8) for v in g[:3]) + (255,))
    else:
        # shell: a solid, darker dome behind and below the ball, split into hexagonal plates,
        # with a light rim; then the two cannons, straight cylinders out of the shoulders
        shell = tuple(int(v * 0.58) for v in g[:3]) + (255,)
        seam = tuple(int(v * 0.30) for v in g[:3]) + (255,)
        sx0, sx1, sy0, sy1 = cx - R - 10, cx + R + 10, cy - R + 2, cy + R + 6
        c.ellipse(sx0, sy0, sx1, sy1, fill=shell)
        ecx, ecy = (sx0 + sx1) / 2, (sy0 + sy1) / 2
        ex_, ey_ = (sx1 - sx0) / 2, (sy1 - sy0) / 2
        c.line([(ecx + (ex_ - 0.6) * math.cos(th), ecy + (ey_ - 0.6) * math.sin(th))
                for th in np.radians(np.linspace(140, 400, 40))], light, width=1.2)
        # plate seams: an inner hexagon ring and spokes to the rim (only the part outside the ball shows)
        hexr = [(ecx + ex_ * 0.72 * math.cos(math.radians(30 + 60 * k)),
                 ecy + ey_ * 0.72 * math.sin(math.radians(30 + 60 * k))) for k in range(6)]
        c.polygon(hexr, outline=seam, width=1.1)
        for k in range(6):
            th = math.radians(30 + 60 * k)
            c.line([hexr[k], (ecx + ex_ * 0.99 * math.cos(th), ecy + ey_ * 0.99 * math.sin(th))], seam, width=1.1)
        for side in (-1, 1):
            a = math.radians(-90 + side * 46)
            nx, ny = math.cos(a), math.sin(a)
            bx, by = cx + nx * (R - 3), cy + ny * (R - 3)
            ex, ey = cx + nx * (R + 12), cy + ny * (R + 12)
            px_, py_ = -ny, nx                     # across the barrel
            hw = 3.4
            body = [(bx + px_ * hw, by + py_ * hw), (ex + px_ * hw, ey + py_ * hw),
                    (ex - px_ * hw, ey - py_ * hw), (bx - px_ * hw, by - py_ * hw)]
            c.polygon(body, fill=g)
            # darker band near the muzzle
            m0x, m0y = bx + (ex - bx) * 0.74, by + (ey - by) * 0.74
            m1x, m1y = bx + (ex - bx) * 0.88, by + (ey - by) * 0.88
            c.polygon([(m0x + px_ * hw, m0y + py_ * hw), (m1x + px_ * hw, m1y + py_ * hw),
                       (m1x - px_ * hw, m1y - py_ * hw), (m0x - px_ * hw, m0y - py_ * hw)], fill=seam)
            # highlight along the lit side
            c.line([(bx + px_ * 1.8, by + py_ * 1.8), (m0x + px_ * 1.8, m0y + py_ * 1.8)], light, width=1.0,
                   round_caps=False)
            # muzzle: the open end (same width as the barrel), dark bore
            for rx, ry, colr in ((hw, 1.5, light), (hw - 1.3, 0.8, dark)):
                pts = [(ex + px_ * rx * math.cos(u) + nx * ry * math.sin(u),
                        ey + py_ * rx * math.cos(u) + ny * ry * math.sin(u))
                       for u in np.linspace(0, 2 * math.pi, 20, endpoint=False)]
                c.polygon(pts, fill=colr)


def _panel(c):
    """The 640 HUD's selection panel: dark rounded box with scanlines (additive grey 21/29)."""
    p = icons.Canvas(ICON_W, ICON_H, ss=c.ss)
    p.rounded_rect(0, 0, ICON_W, ICON_H, 3.5, fill=(25, 25, 25, 255))
    a = np.asarray(p.img).astype(np.float64)
    rows = (np.arange(a.shape[0]) // c.ss) % 2
    lv = np.where(rows == 1, 29.0, 21.0)[:, None]
    a[..., :3] = np.where(a[..., 3:4] > 0, lv[..., None] * np.ones(3), 0)
    p.img = Image.fromarray(np.round(a).astype(np.uint8), "RGBA")
    c.paste(p, 0, 0)


def _scanlines(img, strength=0.12, ss=4):
    """Darken every other output row of a PIL RGBA image (the HUD's printed look)."""
    a = np.asarray(img).astype(np.float64)
    rows = (np.arange(a.shape[0]) // ss) % 2
    k = np.where(rows == 0, 1.0 - strength, 1.0)[:, None, None]
    a[..., :3] *= k
    return Image.fromarray(np.round(a).astype(np.uint8), "RGBA")


ICON_BALL_Y, ICON_BALL_R = 23.0, 14.5


def _icon_layers(species, cx, level):
    """The species mark (scanlined) and the ball of a weapon icon, ball centre at x = cx."""
    ss = 4
    hint = icons.Canvas(ICON_W, ICON_H, ss=ss)
    g = int(round(175 * level))
    _silhouette(hint, species, cx, ICON_BALL_Y, ICON_BALL_R, (g, g, g, 255))
    hint.img = _scanlines(hint.img, 0.18, ss)
    ball = _ball_image((ICON_W, ICON_H), ss, cx, ICON_BALL_Y, ICON_BALL_R, ACCENT[species], level=level)
    return hint, _scanlines(ball, 0.10, ss)


def _icon_ball_x(species):
    """Ball centre x that puts the whole silhouette (ball + species mark) in the middle of the icon,
    as the stock 640 icons are drawn: the mark's extent measured at a trial position."""
    trial = ICON_W / 2.0
    hint, ball = _icon_layers(species, trial, 1.0)
    alpha = np.maximum(np.asarray(hint.img)[..., 3], np.asarray(ball)[..., 3])
    cols = np.nonzero(alpha.max(axis=0) > 8)[0]
    left, right = cols[0] / 4.0, (cols[-1] + 1) / 4.0
    return round((trial + ICON_W / 2.0 - (left + right) / 2.0) * 4.0) / 4.0


def weapon_icon(species, active):
    """170x45 icon (RGBA uint8): panel and a centred silhouette (the ball and its species' mark:
    ears and bolt tail, wing and tail flame, shell and cannons), no text, as the stock 640 icons."""
    ss = 4
    c = icons.Canvas(ICON_W, ICON_H, ss=ss)
    _panel(c)
    level = 1.0 if active else 0.75
    if active:
        c.rounded_rect(0.5, 0.5, ICON_W - 0.5, ICON_H - 0.5, 3.5, outline=(115, 115, 115, 255), width=1.0)
    hint, ball = _icon_layers(species, _icon_ball_x(species), level)
    c.paste(hint, 0, 0)
    c.img = Image.alpha_composite(c.img, ball)
    return _premultiplied(c)


def _premultiplied(c):
    """Canvas -> (H, W, 3) float colour as the additive renderer adds it."""
    return c.additive_rgb().astype(np.float64) / 255.0


def ammo_icon():
    ss = 4
    c = icons.Canvas(24, 24, ss=ss)
    ball = _ball_image((24, 24), ss, 12.0, 12.0, 10.0, (0.85, 0.85, 0.85), tilt=-14, turn=-20, top_level=0.40)
    c.img = Image.alpha_composite(c.img, ball)
    return _premultiplied(c)


def death_icon():
    """48x16 kill icon: a thrown ball with speed lines and a spark."""
    ss = 4
    c = icons.Canvas(48, 16, ss=ss)
    for y, x0, x1, a in ((4.5, 9, 27, 110), (8.0, 3, 26, 150), (11.5, 11, 27, 110)):
        c.line([(x0, y), (x1, y)], (220, 220, 220, a), width=1.0)
    ball = _ball_image((48, 16), ss, 36.0, 8.0, 7.0, (0.8, 0.8, 0.8), tilt=-24, turn=-28, top_level=0.42)
    c.img = Image.alpha_composite(c.img, ball)
    c.star(44.5, 3.4, 2.3, 0.65, points=4, rotation=-90, fill=(255, 255, 255, 255))
    return _premultiplied(c)


def make_hud():
    sheet = np.zeros((HUD_H, HUD_W, 3))
    for s in SPECIES:
        y = ROW_Y[s]
        sheet[y:y + ICON_H, INACTIVE_X:INACTIVE_X + ICON_W] = weapon_icon(s, False)
        sheet[y:y + ICON_H, ACTIVE_X:ACTIVE_X + ICON_W] = weapon_icon(s, True)
    ax, ay, aw, ah = AMMO_RECT
    sheet[ay:ay + ah, ax:ax + aw] = ammo_icon()
    return sheet


def weapon_txt(species):
    y = ROW_Y[species]
    ax, ay, aw, ah = AMMO_RECT
    lines = []
    for res in (320, 640):
        lines.append(f"weapon\t\t{res} pokemon/hud\t{INACTIVE_X}\t{y}\t{ICON_W}\t{ICON_H}")
        lines.append(f"weapon_s\t{res} pokemon/hud\t{ACTIVE_X}\t{y}\t{ICON_W}\t{ICON_H}")
        lines.append(f"ammo\t\t{res} pokemon/hud\t{ax}\t{ay}\t{aw}\t{ah}")
    return (f"{len(lines)}\n" + "\n".join(lines) + "\n").encode("ascii")


# ---------------------------------------------------------------------------------------------
# sounds
# ---------------------------------------------------------------------------------------------

# Band-limited sources.  W.osc's naive saw / square / glottal pulse alias badly at a small
# creature's pitch (harmonic 9 of 1 kHz already folds back below 11 kHz); these are built by
# additive synthesis up to BL_FMAX with a soft roll-off, so no partial ever folds back.
BL_FMAX = 9500.0


def _glottal_coefs(m=64):
    """Fourier coefficients (k = 1..m) of W.osc's glottal pulse (same shape, zero mean, x2)."""
    N = 4096
    ph = np.arange(N) / N
    op, cl = 0.45, 0.15
    g = np.where(ph < op, 0.5 * (1 - np.cos(np.pi * ph / op)),
                 np.where(ph < op + cl, np.cos(0.5 * np.pi * (ph - op) / cl), 0.0))
    g = 2 * (g - g.mean())
    C = np.fft.rfft(g) / N * 2
    return C[1:m + 1]


_GLOTTAL = _glottal_coefs(400)


def _bl(freq, shape="saw", dur=None):
    """Band-limited oscillator (per-sample frequency array or scalar + dur)."""
    if np.isscalar(freq):
        freq = np.full(W._n(dur), float(freq))
    f = np.asarray(freq, dtype=np.float64)
    ph = np.cumsum(f) / W.RATE
    out = np.zeros(len(f))
    kmax = int(BL_FMAX / max(float(f.min()), 20.0)) + 1
    for k in range(1, kmax + 1):
        if shape in ("square", "triangle") and k % 2 == 0:
            continue
        w = _smooth(BL_FMAX, BL_FMAX * 0.8, k * f)
        if not w.any():
            continue
        arg = 2 * np.pi * ((k * ph) % 1.0)
        if shape == "saw":
            out -= w * (2 / np.pi) * np.sin(arg) / k
        elif shape == "square":
            out += w * (4 / np.pi) * np.sin(arg) / k
        elif shape == "triangle":
            out += w * (8 / np.pi ** 2) * np.cos(arg) / (k * k)
        elif shape == "glottal":
            if k > len(_GLOTTAL):
                break
            c = _GLOTTAL[k - 1]
            out += w * (c.real * np.cos(arg) - c.imag * np.sin(arg))
        else:
            raise ValueError(shape)
    return out


def _voice(f0, vowels=((0.0, "a"),), breath=0.08, vibrato_=None, formant_shift=1.0, growl=0.0, seed=1):
    """W.voice with band-limited sources (same formant model, same arguments)."""
    f0 = np.asarray(f0, dtype=np.float64)
    if vibrato_:
        f0 = W.vibrato(f0, *vibrato_)
    n = len(f0)
    src = _bl(f0, "glottal") + 0.35 * _bl(f0, "saw")
    if growl:
        src = src * (1 + growl * W.osc(f0 * 0.5, shape="sine"))
        src += growl * 0.4 * W.noise(n, "pink", seed) * np.abs(W.osc(f0 * 0.5, shape="sine"))
    src += breath * W.noise(n, "white", seed + 7)
    (F1, F2, F3), (G1, G2, G3) = W._vowel_tracks(vowels, n)
    out = (W.svf(src, F1 * formant_shift, 6.0) * G1 + W.svf(src, F2 * formant_shift, 9.0) * G2
           + W.svf(src, F3 * formant_shift, 12.0) * G3)
    return W.normalize(out)


def _burst(dur, lo, hi, seed, decay=None):
    """Band-limited noise burst (consonants, transients)."""
    x = W.noise(dur, "white", seed)
    if hi:
        x = W.lowpass(W.lowpass(x, hi), hi)
    if lo:
        x = W.highpass(W.highpass(x, lo), lo)
    n = len(x)
    env = W.env_exp(n, decay=decay) if decay else W.env_points([(0, 0), (dur * 0.2, 1), (dur, 0)], n)
    return W.normalize(x * env, 1.0)


def _syl(f0, vowels, shift, breath=0.06, vib=(7.0, 0.02), growl=0.0, seed=1, attack=0.012, release=0.05,
         sustain_shape=None):
    v = _voice(f0, vowels=vowels, breath=breath, vibrato_=vib, formant_shift=shift, growl=growl, seed=seed)
    d = len(v) / W.RATE
    pts = sustain_shape or [(0, 0), (attack, 1), (max(d - release, attack), 0.85), (d, 0)]
    return v * W.env_points(pts, len(v))


def _clicks(dur, rate_hz, seed, decay=0.002, lo=1500):
    """Sparse random impulses with short decays: electric / fire crackle."""
    rng = np.random.default_rng(seed)
    n = W._n(dur)
    x = np.zeros(n)
    t = 0.0
    while True:
        t += rng.exponential(1.0 / rate_hz)
        i = int(t * W.RATE)
        if i >= n:
            break
        L = min(int(decay * 8 * W.RATE), n - i)
        k = np.arange(L) / W.RATE
        amp = rng.uniform(0.3, 1.0) * (1 if rng.random() < 0.5 else -1)
        x[i:i + L] += amp * np.exp(-k / decay) * rng.standard_normal(L)
    return W.highpass(x, lo)


def _bell(freq, dur, decay=0.35, partials=((1.0, 1.0), (2.76, 0.45), (5.40, 0.22), (8.93, 0.10))):
    out = np.zeros(W._n(dur))
    for ratio, g in partials:
        f = freq * ratio
        if f >= W.RATE / 2 - 200:
            continue
        out += g * W.osc(f, dur) * W.env_exp(len(out), decay=decay / (1 + 0.5 * (ratio - 1)))
    return out


def snd_pikachu_cry1():
    """"Pi-ka!": bright and rising."""
    shift = 1.45
    p = _burst(0.012, 2500, None, 11, decay=0.003)
    pi = _syl(W.concat(W.glide(540, 610, 0.05), W.glide(610, 590, 0.05)), [(0, "i"), (0.1, "i")], shift,
              seed=12, release=0.025)
    k = _burst(0.018, 1800, 5000, 13, decay=0.005)
    ka = _syl(W.concat(W.glide(600, 740, 0.09), W.glide(740, 760, 0.06), W.glide(760, 640, 0.17)),
              [(0, "e"), (0.04, "a"), (0.25, "a"), (0.32, "ah")], shift, vib=(8.0, 0.025), seed=14, release=0.09)
    x = W.mix((p, 0.0, 0.35), (pi, 0.010), (k, 0.118, 0.45), (ka, 0.135))
    return W.finish(W.reverb(x, room=0.3, wet=0.12, tail=0.15))


def snd_pikachu_cry2():
    """"Pi-chuu!": a short "pi" and a long, sing-song "chuu"."""
    shift = 1.45
    p = _burst(0.012, 2500, None, 21, decay=0.003)
    pi = _syl(W.glide(600, 660, 0.09), [(0, "i")], shift, seed=22, release=0.03)
    ch = _burst(0.07, 3000, None, 23)
    chu = _syl(W.concat(W.glide(620, 760, 0.12), W.glide(760, 730, 0.12), W.glide(730, 560, 0.2)),
               [(0, "i"), (0.05, "u"), (0.44, "u")], shift, vib=(7.5, 0.03), seed=24, release=0.12)
    x = W.mix((p, 0.0, 0.35), (pi, 0.010), (ch, 0.125, 0.35), (chu, 0.175))
    return W.finish(W.reverb(x, room=0.3, wet=0.12, tail=0.15))


def snd_pikachu_hurt():
    shift = 1.5
    p = _burst(0.01, 2500, None, 31, decay=0.003)
    v = _syl(W.concat(W.glide(720, 820, 0.04), W.glide(820, 480, 0.16)), [(0, "i"), (0.08, "e"), (0.2, "a")],
             shift, breath=0.15, vib=(18.0, 0.04), seed=32, release=0.06)
    v = W.distort(v, 1.8)
    return W.finish(W.mix((p, 0, 0.4), (v, 0.008)))


def snd_pikachu_die():
    """"Pi... kaaa...": falling, slowing, fading."""
    shift = 1.42
    pi = _syl(W.glide(560, 480, 0.14), [(0, "i")], shift, seed=41, release=0.05)
    k = _burst(0.02, 1800, 5000, 42, decay=0.006)
    ka = _syl(W.concat(W.glide(500, 520, 0.1), W.glide(520, 260, 0.75)), [(0, "a"), (0.4, "ah"), (0.85, "u")],
              shift, breath=0.12, vib=(5.0, 0.035), seed=43,
              sustain_shape=[(0, 0), (0.015, 1), (0.3, 0.85), (0.85, 0)])
    x = W.mix((pi, 0.0), (k, 0.22, 0.4), (ka, 0.24))
    return W.finish(W.reverb(x, room=0.5, wet=0.2, tail=0.3), fade_out=0.12)


def snd_pikachu_zap():
    """Thunderbolt: a hard crack (0-25 ms at full level), then a tonal, crackling buzz well below
    it (-9 dB falling to -18 dB by 0.4 s) and a short thunder tail (~0.6 s)."""
    dur = 0.6
    n = W._n(dur)
    # the crack: broadband burst plus a falling sine "snap" and a band-passed click
    crack = _burst(0.05, 700, None, 51, decay=0.013)
    snap = W.osc(W.glide(3200, 240, 0.12)) * W.env_exp(W._n(0.12), decay=0.03, attack=0.001)
    click = W.bandpass(W.noise(0.02, "white", 55), 2600, 1.2) * W.env_exp(W._n(0.02), decay=0.004, attack=0.0005)
    head = W.mix((crack, 0, 1.0), (snap, 0, 0.55), (W.normalize(click, 1), 0, 0.5))
    # saturated on its own: a dense, loud crack (low crest factor) rather than one spike
    head = W.distort(W.normalize(head, 1.0), 3.5)
    # the buzz: band-limited saw at 118 Hz and a square at 354 Hz, wobbling, band-passed wide so its
    # harmonic lines stay visible up to ~3 kHz, distorted on its own
    rng = np.random.default_rng(52)
    jitter = np.repeat(rng.uniform(0.45, 1.0, n // 220 + 1), 220)[:n]
    jitter = W.lowpass(jitter, 90)
    f = W.vibrato(np.full(n, 118.0), 23, 0.03)
    buzz = _bl(f, "saw") + 0.45 * _bl(f * 3.0, "square")
    buzz = W.bandpass(buzz, 1100, 0.7) + 0.3 * W.highpass(W.lowpass(buzz, 450), 160)
    buzz = W.distort(W.normalize(buzz, 1.0), 1.2) * jitter
    crackle = W.normalize(_clicks(dur, 120, 53, decay=0.0016, lo=1800), 1.0)
    rumble = W.highpass(W.lowpass(W.lowpass(W.noise(0.6, "pink", 54), 220), 220), 45)
    rumble = W.normalize(rumble, 1.0) * W.env_points([(0, 0), (0.03, 1), (0.6, 0)], W._n(0.6))
    body = W.mix((buzz, 0, 1.0), (crackle, 0, 0.28), (rumble, 0, 0.2))
    # levels relative to the crack's RMS (not its peak: noise and a buzz have different crest factors)
    rms = lambda v: float(np.sqrt(np.mean(v ** 2)))
    body = body / rms(body[W._n(0.02):W._n(0.12)]) * rms(head[:W._n(0.025)])
    db = np.interp(np.arange(len(body)) / W.RATE, [0, 0.025, 0.4, dur], [-9, -9, -18, -40])
    body *= 10 ** (db / 20) * W.env_points([(0, 0), (0.012, 1), (dur, 1)], len(body))
    x = W.mix((head, 0, 1.0), (body, 0.004, 1.0))
    return W.finish(x, fade_out=0.05, trim=False)


def snd_charizard_cry1():
    shift = 0.78
    v = _syl(W.concat(W.glide(210, 320, 0.2), W.glide(320, 290, 0.25), W.glide(290, 190, 0.3)),
             [(0, "ah"), (0.35, "a"), (0.75, "o")], shift, breath=0.12, vib=(6, 0.03), growl=0.55, seed=61,
             attack=0.04, release=0.2)
    v = W.distort(v, 2.0)
    return W.finish(W.reverb(v, room=0.55, wet=0.18, tail=0.3), fade_out=0.1)


def snd_charizard_roar():
    shift = 0.62
    n_dur = 1.35
    f0 = W.concat(W.glide(120, 175, 0.25), W.glide(175, 160, 0.6), W.glide(160, 95, 0.5))
    v = _syl(f0, [(0, "o"), (0.25, "ah"), (0.85, "a"), (1.3, "u")], shift, breath=0.2, vib=(5.5, 0.04),
             growl=0.95, seed=71, attack=0.08, release=0.35)
    rasp = W.bandpass(W.noise(n_dur, "pink", 72), 900, 1.0)
    rasp *= W.env_points([(0, 0), (0.1, 1), (0.9, 0.8), (n_dur, 0)], len(rasp))
    sub = W.osc(W.glide(60, 48, n_dur)) * W.env_points([(0, 0), (0.15, 1), (1.0, 0.6), (n_dur, 0)], W._n(n_dur))
    x = W.mix((W.distort(v, 2.6), 0, 1.0), (W.normalize(rasp, 1), 0, 0.25), (sub, 0, 0.35))
    return W.finish(W.reverb(x, room=0.7, wet=0.22, tail=0.45), fade_out=0.15)


def snd_charizard_flame():
    """Flamethrower: ignition 'fwoomp', a steady roaring body (loop-like) with crackle, ~1.0 s."""
    dur = 1.0
    n = W._n(dur)
    body = W.highpass(0.35 * W.noise(dur, "brown", 81) + 0.65 * W.noise(dur, "pink", 82), 90)
    cut = np.interp(np.arange(n) / W.RATE, [0, 0.06, 0.25, 0.85, 1.0], [300, 2600, 1700, 1500, 700])
    rng = np.random.default_rng(83)
    flutter = W.lowpass(np.repeat(rng.uniform(0.6, 1.0, n // 300 + 1), 300)[:n], 40)
    body = W.svf(body, cut, 1.4, "low") * flutter
    roar = W.svf(W.noise(dur, "pink", 86), cut * 0.6, 2.5, "band") * flutter
    hiss = W.bandpass(W.noise(dur, "white", 84), 3800, 0.8) * flutter
    env = W.env_points([(0, 0), (0.03, 1.0), (0.12, 0.8), (0.85, 0.75), (dur, 0)], n)
    thump = W.osc(W.glide(110, 45, 0.25)) * W.env_exp(W._n(0.25), decay=0.07)
    crackle = _clicks(dur, 90, 85, decay=0.003, lo=1200) * W.env_points([(0, 0.4), (0.2, 1), (dur, 0.5)], n)
    x = W.mix((W.normalize(body, 1) * env, 0, 1.0), (W.normalize(roar, 1) * env, 0, 0.6), (W.normalize(hiss, 1) * env, 0, 0.3), (thump, 0, 0.55),
              (W.normalize(crackle, 1), 0, 0.28))
    return W.finish(W.distort(x, 1.3), fade_out=0.08, trim=False)


def snd_charizard_hurt():
    v = _syl(W.concat(W.glide(300, 360, 0.05), W.glide(360, 200, 0.3)), [(0, "ah"), (0.2, "er")], 0.75,
             breath=0.18, growl=0.6, vib=(14, 0.04), seed=91, attack=0.01, release=0.12)
    return W.finish(W.reverb(W.distort(v, 2.2), room=0.4, wet=0.12, tail=0.2))


def snd_charizard_die():
    f0 = W.concat(W.glide(230, 260, 0.15), W.glide(260, 75, 1.35))
    v = _syl(f0, [(0, "a"), (0.6, "ah"), (1.1, "o"), (1.5, "u")], 0.66, breath=0.22, vib=(4.5, 0.05),
             growl=0.9, seed=101, attack=0.05,
             sustain_shape=[(0, 0), (0.05, 1), (0.6, 0.85), (1.5, 0)])
    return W.finish(W.reverb(W.distort(v, 2.2), room=0.75, wet=0.25, tail=0.5), fade_out=0.2)


def _fry(x, rate=34.0, depth=0.6, seed=0):
    """Gravel: amplitude pulses at a vocal-fry rate with random jitter."""
    n = len(x)
    rng = np.random.default_rng(seed)
    f = W.vibrato(np.full(n, rate), 3.0, 0.15) * (1 + 0.15 * W.lowpass(rng.standard_normal(n), 30))
    pulses = np.clip(W.osc(f, shape="sine"), 0, 1) ** 3
    return x * (1 - depth + depth * pulses)


def snd_blastoise_cry1():
    f0 = W.concat(W.glide(105, 140, 0.2), W.glide(140, 128, 0.35), W.glide(128, 90, 0.35))
    v = _syl(f0, [(0, "o"), (0.4, "ah"), (0.9, "u")], 0.6, breath=0.15, vib=(5, 0.03), growl=1.0, seed=111,
             attack=0.05, release=0.25)
    v = _fry(v, 36, 0.55, seed=112)
    sub = W.osc(W.glide(52, 45, 0.9)) * W.env_points([(0, 0), (0.1, 1), (0.9, 0)], W._n(0.9))
    x = W.mix((W.distort(v, 2.4), 0, 1.0), (sub, 0, 0.3))
    return W.finish(W.reverb(x, room=0.6, wet=0.18, tail=0.35), fade_out=0.12)


def snd_blastoise_hydro():
    """Hydro Pump: a pressurised blast (thump + hiss onset), a hissing jet body, gurgles (~0.95 s)."""
    dur = 0.95
    n = W._n(dur)
    rng = np.random.default_rng(121)
    thump = W.osc(W.glide(95, 40, 0.3)) * W.env_exp(W._n(0.3), decay=0.08)
    blast = _burst(0.12, 400, None, 122, decay=0.04)
    jet = W.noise(dur, "white", 123)
    centre = np.interp(np.arange(n) / W.RATE, [0, 0.05, 0.5, dur], [4800, 3000, 2400, 1800])
    flutter = W.lowpass(np.repeat(rng.uniform(0.7, 1.0, n // 150 + 1), 150)[:n], 60)
    jet = W.svf(jet, centre, 0.9, "band") * flutter
    jet_lo = W.svf(W.noise(dur, "pink", 124), 700, 0.8, "band") * flutter
    env = W.env_points([(0, 0), (0.015, 1.0), (0.1, 0.8), (0.7, 0.65), (dur, 0)], n)
    # gurgles: short rising sine chirps
    gur = np.zeros(n)
    for _ in range(14):
        t0 = rng.uniform(0.15, dur - 0.08)
        L = rng.uniform(0.02, 0.05)
        f0 = rng.uniform(280, 650)
        ch = W.osc(W.glide(f0, f0 * rng.uniform(1.6, 2.4), L)) * np.hanning(W._n(L))
        i = W._n(t0)
        gur[i:i + len(ch)] += ch[:max(0, n - i)] * rng.uniform(0.4, 1.0)
    x = W.mix((thump, 0, 0.7), (blast, 0, 0.6), (W.normalize(jet, 1) * env, 0.005, 0.8),
              (W.normalize(jet_lo, 1) * env, 0.005, 0.45), (gur, 0, 0.18))
    return W.finish(W.distort(x, 1.25), fade_out=0.1, trim=False)


def snd_blastoise_hurt():
    v = _syl(W.concat(W.glide(150, 175, 0.05), W.glide(175, 105, 0.3)), [(0, "ah"), (0.25, "o")], 0.62,
             breath=0.15, growl=0.9, vib=(12, 0.04), seed=131, attack=0.01, release=0.12)
    return W.finish(W.reverb(W.distort(_fry(v, 32, 0.5, 132), 2.3), room=0.4, wet=0.12, tail=0.2))


def snd_blastoise_die():
    f0 = W.concat(W.glide(130, 140, 0.15), W.glide(140, 58, 1.4))
    v = _syl(f0, [(0, "ah"), (0.7, "o"), (1.5, "u")], 0.58, breath=0.2, vib=(4, 0.05), growl=1.0, seed=141,
             attack=0.06, sustain_shape=[(0, 0), (0.06, 1), (0.7, 0.8), (1.55, 0)])
    v = _fry(v, 30, 0.6, 142)
    return W.finish(W.reverb(W.distort(v, 2.2), room=0.75, wet=0.25, tail=0.5), fade_out=0.2)


def snd_ball_throw():
    dur = 0.42
    n = W._n(dur)
    x = W.noise(dur, "pink", 151)
    centre = np.interp(np.arange(n) / W.RATE, [0, 0.16, 0.42], [500, 1900, 700])
    x = W.svf(x, centre, 2.0, "band")
    x *= W.env_points([(0, 0), (0.14, 1), (0.22, 0.8), (dur, 0)], n)
    return W.finish(x, fade_out=0.04)


def snd_ball_bounce():
    dur = 0.13
    n = W._n(dur)
    tock = (W.osc(1850.0, dur) * W.env_exp(n, decay=0.018) + 0.6 * W.osc(3150.0, dur) * W.env_exp(n, decay=0.010)
            + 0.35 * W.osc(620.0, dur) * W.env_exp(n, decay=0.03))
    click = _burst(0.006, 2000, None, 161, decay=0.0015)
    return W.finish(W.mix((tock, 0, 1.0), (click, 0, 0.7)), fade_out=0.02, trim=False)


def snd_ball_open():
    """Pop, a rising 'shwing' and a sparkle of bell pings (~0.9 s)."""
    rng = np.random.default_rng(171)
    pop = W.osc(W.glide(260, 70, 0.08)) * W.env_exp(W._n(0.08), decay=0.025)
    burst = _burst(0.05, 600, 5000, 172, decay=0.012)
    swing = _bl(W.glide(700, 2600, 0.3, "ease"), "triangle") * W.env_points(
        [(0, 0), (0.05, 1), (0.3, 0)], W._n(0.3))
    shimmer = W.bandpass(W.noise(0.6, "white", 173), 5000, 3.0) * W.env_points(
        [(0, 0), (0.1, 1), (0.6, 0)], W._n(0.6))
    parts = [(pop, 0, 1.0), (burst, 0, 0.6), (swing, 0.04, 0.3), (W.normalize(shimmer, 1), 0.08, 0.12)]
    notes = [2093.0, 2637.0, 3136.0, 4186.0, 3520.0, 5274.0]
    for i, f in enumerate(notes):
        parts.append((_bell(f * rng.uniform(0.995, 1.005), 0.35, 0.18), 0.09 + 0.055 * i, 0.22))
    x = W.mix(*parts)
    return W.finish(W.reverb(x, room=0.5, wet=0.2, tail=0.25), fade_out=0.1)


def snd_ball_return():
    """Energy drawn back in (falling sweep with tremolo), then a two-note chime (~0.95 s)."""
    sw = W.osc(W.glide(2200, 500, 0.35, "ease"), shape="sine")
    sw = W.tremolo(sw, 28, 0.6) * W.env_points([(0, 0), (0.04, 1), (0.35, 0.2)], len(sw))
    hiss = W.bandpass(W.noise(0.35, "white", 181), 3000, 1.5) * W.env_points([(0, 0.6), (0.35, 0)], W._n(0.35))
    c1 = _bell(1318.5, 0.5, 0.3)
    c2 = _bell(1975.5, 0.6, 0.35)
    x = W.mix((sw, 0, 0.5), (W.normalize(hiss, 1), 0, 0.12), (c1, 0.3, 0.55), (c2, 0.42, 0.6))
    return W.finish(W.reverb(x, room=0.5, wet=0.2, tail=0.25), fade_out=0.1)


def snd_pk_step():
    """A soft footfall that suits a small and a heavy Pokemon alike (the server pitches it):
    a low thud, a short 200-400 Hz body and a little scuff; no DC."""
    dur = 0.13
    n = W._n(dur)
    thud = W.osc(W.glide(90, 55, dur)) * W.env_exp(n, decay=0.035, attack=0.002)
    body = W.bandpass(W.noise(dur, "pink", 191), 300, 1.4) * W.env_exp(n, decay=0.022, attack=0.002)
    scuff = W.bandpass(W.noise(dur, "white", 192), 1800, 1.5) * W.env_points([(0, 0), (0.006, 1), (0.045, 0)], n)
    x = W.mix((thud, 0, 0.8), (W.normalize(body, 1), 0, 0.55), (W.normalize(scuff, 1), 0, 0.15))
    x = W.highpass(W.highpass(x, 35), 35)
    return W.finish(x, fade_out=0.03, trim=False)


SOUNDS = {
    "pikachu_cry1": snd_pikachu_cry1, "pikachu_cry2": snd_pikachu_cry2, "pikachu_zap": snd_pikachu_zap,
    "pikachu_hurt": snd_pikachu_hurt, "pikachu_die": snd_pikachu_die,
    "charizard_cry1": snd_charizard_cry1, "charizard_roar": snd_charizard_roar,
    "charizard_flame": snd_charizard_flame, "charizard_hurt": snd_charizard_hurt,
    "charizard_die": snd_charizard_die,
    "blastoise_cry1": snd_blastoise_cry1, "blastoise_hydro": snd_blastoise_hydro,
    "blastoise_hurt": snd_blastoise_hurt, "blastoise_die": snd_blastoise_die,
    "ball_throw": snd_ball_throw, "ball_bounce": snd_ball_bounce, "ball_open": snd_ball_open,
    "ball_return": snd_ball_return, "pk_step": snd_pk_step,
}


# Loudness: every sound is levelled to a short-term loudness (the loudest 50 ms RMS, dBFS) by
# category instead of to a peak, so an attack is louder than a yelp and a footstep stays in the
# background.  Peaks are held at or below 0.9 by a smooth look-ahead limiter.
LOUDNESS = {"attack": -7.0, "cry": -8.0, "hurt": -10.0, "die": -9.0, "ball": -12.0, "step": -16.0}
PEAK = 0.9


def _category(name):
    if name in ("pikachu_zap", "charizard_flame", "blastoise_hydro"):
        return "attack"
    if name.endswith("_hurt"):
        return "hurt"
    if name.endswith("_die"):
        return "die"
    if name.startswith("ball_"):
        return "ball"
    if name == "pk_step":
        return "step"
    return "cry"


def _st50(x):
    k = W._n(0.05)
    if len(x) <= k:
        return float(np.sqrt(np.mean(x ** 2)))
    c = np.concatenate([[0.0], np.cumsum(x * x)])
    return float(np.sqrt(np.max(c[k:] - c[:-k]) / k))


def _limit(x, peak=PEAK, look=0.002, release=0.04):
    """Gain that keeps |x| <= peak: computed on a look-ahead window, eased back up."""
    a = np.abs(x)
    L = W._n(look)
    pad = np.concatenate([np.zeros(L), a, np.zeros(L)])
    win = np.lib.stride_tricks.sliding_window_view(pad, 2 * L + 1).max(axis=1)
    g = np.minimum(1.0, peak / np.maximum(win, 1e-9))
    # release: the gain climbs back slowly (one-pole on the way up only), forward then backward
    k = 1.0 - math.exp(-1.0 / (release * W.RATE))
    for seq in (range(len(g)), range(len(g) - 1, -1, -1)):
        prev = 1.0
        for i in seq:
            prev = g[i] if g[i] < prev else prev + k * (g[i] - prev)
            g[i] = prev
    return x * g


def _level(x, target_db, fade_in=0.0015, max_limit_db=8.0):
    """Scale to the target short-term loudness, limit the peaks (at most max_limit_db), then a
    1.5 ms fade-in so no file starts on a step."""
    x = np.asarray(x, dtype=np.float64)
    x = x - np.mean(x)
    target = 10 ** (target_db / 20)
    gain = target / max(_st50(x), 1e-9)
    cap = PEAK / max(np.max(np.abs(x)), 1e-9) * 10 ** (max_limit_db / 20)
    gain = min(gain, cap)
    y = x * gain
    for _ in range(3):
        y = _limit(x * gain)
        st = _st50(y)
        if abs(20 * math.log10(max(st, 1e-9) / target)) < 0.3:
            break
        gain = min(gain * target / max(st, 1e-9), cap)
    y = np.clip(y, -PEAK, PEAK)
    return W.fade(y, fade_in, 0.0)


# ---------------------------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------------------------

def _outside(w, h=None, across=False):
    """Texels whose centre lies at or beyond WINDOW_END of the half-size (radially, or across u only)."""
    h = h or w
    u = np.abs((np.arange(w) + 0.5) / w * 2 - 1)
    if across:
        return np.broadcast_to(u >= WINDOW_END, (h, w))
    v = np.abs((np.arange(h) + 0.5) / h * 2 - 1)
    return np.hypot(u[None, :], v[:, None]) >= WINDOW_END


def sprites():
    """path -> bytes of every sprite and HUD text file."""
    out = {}
    out["sprites/pokemon/zap.spr"] = _additive_sprite(make_zap(), dark=_outside(64, 128, across=True))
    out["sprites/pokemon/fire.spr"] = _additive_sprite(make_fire(), dark=_outside(64))
    out["sprites/pokemon/water.spr"] = _additive_sprite(make_water(), dark=_outside(64))
    out["sprites/pokemon/drops.spr"] = _additive_sprite(make_drops(), dark=_outside(32))
    out["sprites/pokemon/flash.spr"] = _additive_sprite(make_flash(), dark=_outside(128))
    out["sprites/pokemon/hud.spr"] = _additive_sprite([make_hud()], origins=[(0, 0)])
    out["sprites/pokemon/d_pokemon.spr"] = _additive_sprite([death_icon()], origins=[(0, 0)])
    for s in SPECIES:
        out[f"sprites/weapon_pk_{s}.txt"] = weapon_txt(s)
    return out


def sounds():
    out = {}
    for k, fn in SOUNDS.items():
        cat = _category(k)
        # attacks may squash their opening transient harder (a crack, a blast) to stay punchy
        x = _level(fn(), LOUDNESS[cat], max_limit_db=12.0 if cat == "attack" else 8.0)
        out[f"sound/pokemon/{k}.wav"] = W.write(x, W.RATE, 16)
    return out


def build(out):
    out.update(sprites())
    out.update(sounds())
