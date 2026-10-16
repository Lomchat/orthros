"""Half Strike: the laptop's HUD sprites (Le M's summoning weapon) and the kill icon of Le M.

  sprites/others/hud_lem.spr  weapon selection icons (additive, 512x64 sheet: inactive 170x45 at x = 0,
                              active at x = 172, ammo icon 24x24 at x = 344), in the Poke Balls' 640 HUD
                              look (fx.py: the dark scanlined panel, a centred silhouette, no text): an open
                              laptop seen from the front left, a prompt ">_" and lines of code on its screen;
                              grey, the engine tints them.
  sprites/others/d_lem.spr    death notice icon (additive, 48x16, the whole frame is the icon): a small open
                              laptop with its prompt, a spark of code flying off it.
  sprites/weapon_lem_laptop.txt  the HUD definition of weapon_lem_laptop (320 and 640 lines).
"""
import numpy as np

from .. import icons
from . import fx

SHEET_W, SHEET_H = 512, 64
ICON_W, ICON_H = fx.ICON_W, fx.ICON_H
INACTIVE_X, ACTIVE_X = 0, 172
AMMO_RECT = (344, 0, 24, 24)


def _laptop(c, cx, by, w, h, grey, line=1.0, code=True):
    """Open laptop: the base (keyboard) a flat parallelogram with its bottom edge centred at (cx, by), width w;
    the lid rising from its back edge, leaning back a little, height h.  grey: 0..255 level."""
    g = int(grey)
    body = (g, g, g, 255)
    rim = (min(255, int(g * 1.25)), min(255, int(g * 1.25)), min(255, int(g * 1.25)), 255)
    dark = (int(g * 0.22), int(g * 0.22), int(g * 0.22), 255)
    keys = (int(g * 0.55), int(g * 0.55), int(g * 0.55), 255)
    depth = w * 0.20                     # the base seen in perspective: its back edge higher and narrower
    skew = w * 0.10
    bl, br = (cx - w / 2, by), (cx + w / 2, by)
    tl, tr = (cx - w / 2 + skew, by - depth), (cx + w / 2 - skew * 0.4, by - depth)
    c.polygon([bl, br, tr, tl], fill=body)
    c.line([bl, br], rim, width=line)
    # keyboard rows and the touchpad
    for k in range(3):
        f = 0.22 + 0.22 * k
        y = by - depth * (1 - f)
        x0 = bl[0] + (tl[0] - bl[0]) * (1 - f) + w * 0.08
        x1 = br[0] + (tr[0] - br[0]) * (1 - f) - w * 0.08
        c.line([(x0, y), (x1, y)], keys, width=max(0.7, line * 0.8), round_caps=False)
    pad_w = w * 0.16
    c.rect(cx - pad_w / 2, by - depth * 0.18, cx + pad_w / 2, by - depth * 0.02, fill=keys)
    # the lid, leaning back from the base's back edge; its screen dark inside a bezel
    lean = h * 0.10
    lid = [tl, tr, (tr[0] + lean, tr[1] - h), (tl[0] + lean, tl[1] - h)]
    c.polygon(lid, fill=body)
    c.line(lid + [lid[0]], rim, width=line * 0.9)
    bz = max(1.0, h * 0.10)
    scr = [(tl[0] + bz * 1.1, tl[1] - bz * 0.8), (tr[0] - bz * 1.1, tr[1] - bz * 0.8),
           (tr[0] + lean - bz * 1.1, tr[1] - h + bz), (tl[0] + lean + bz * 1.1, tl[1] - h + bz)]
    c.polygon(scr, fill=dark)
    if not code:
        return scr
    # the prompt ">_" at the top left of the screen, then lines of code under it
    sx0, sy0 = scr[3]
    sx1 = scr[2][0]
    sh = scr[0][1] - sy0
    gh = sh * 0.26
    px, py = sx0 + bz * 0.9, sy0 + sh * 0.14
    glyph = (min(255, int(g * 1.35)),) * 3 + (255,)
    c.line([(px, py), (px + gh * 0.55, py + gh * 0.5), (px, py + gh)], glyph, width=max(0.8, line * 1.1))
    c.line([(px + gh * 0.8, py + gh), (px + gh * 1.6, py + gh)], glyph, width=max(0.8, line * 1.1))
    if sh > 10:
        rows = int(sh // (gh * 0.85)) - 1
        lens = (0.62, 0.40, 0.75, 0.30, 0.55)
        for k in range(min(rows, len(lens))):
            y = py + gh * (1.7 + 0.95 * k)
            if y > scr[0][1] - bz * 0.6:
                break
            ind = (k % 2) * gh * 0.9
            x0 = px + ind
            x1 = min(sx1 - bz, x0 + (sx1 - sx0) * lens[k])
            c.line([(x0, y), (x1, y)], keys, width=max(0.7, line * 0.8), round_caps=False)
    return scr


def weapon_icon(active):
    ss = 4
    c = icons.Canvas(ICON_W, ICON_H, ss=ss)
    fx._panel(c)
    level = 1.0 if active else 0.75
    if active:
        c.rounded_rect(0.5, 0.5, ICON_W - 0.5, ICON_H - 0.5, 3.5, outline=(115, 115, 115, 255), width=1.0)
    art = icons.Canvas(ICON_W, ICON_H, ss=ss)
    _laptop(art, ICON_W / 2 - 3, 40.5, 62, 23, 200 * level, line=1.2)
    art.img = fx._scanlines(art.img, 0.12, ss)
    c.paste(art, 0, 0)
    return fx._premultiplied(c)


def ammo_icon():
    ss = 4
    c = icons.Canvas(24, 24, ss=ss)
    _laptop(c, 11.5, 20.5, 19, 11, 215, line=0.9, code=True)
    return fx._premultiplied(c)


def death_icon():
    """48x16: an open laptop with its prompt, bits of code flying off to the right."""
    ss = 4
    c = icons.Canvas(48, 16, ss=ss)
    _laptop(c, 14.0, 15.0, 22, 10.5, 225, line=0.9)
    for (x, y, l, a) in ((30, 4.5, 4, 200), (36, 4.5, 2, 150), (31, 8.0, 6, 170), (39.5, 8.0, 3, 120),
                         (30, 11.5, 3, 140), (35, 11.5, 5, 110)):
        c.rect(x, y - 0.8, x + l, y + 0.8, fill=(225, 225, 225, a))
    c.star(44.5, 4.0, 2.3, 0.65, points=4, rotation=-90, fill=(255, 255, 255, 255))
    return fx._premultiplied(c)


def make_hud():
    sheet = np.zeros((SHEET_H, SHEET_W, 3))
    sheet[0:ICON_H, INACTIVE_X:INACTIVE_X + ICON_W] = weapon_icon(False)
    sheet[0:ICON_H, ACTIVE_X:ACTIVE_X + ICON_W] = weapon_icon(True)
    ax, ay, aw, ah = AMMO_RECT
    sheet[ay:ay + ah, ax:ax + aw] = ammo_icon()
    return sheet


def weapon_txt():
    ax, ay, aw, ah = AMMO_RECT
    lines = []
    for res in (320, 640):
        lines.append(f"weapon\t\t{res} others/hud_lem\t{INACTIVE_X}\t0\t{ICON_W}\t{ICON_H}")
        lines.append(f"weapon_s\t{res} others/hud_lem\t{ACTIVE_X}\t0\t{ICON_W}\t{ICON_H}")
        lines.append(f"ammo\t\t{res} others/hud_lem\t{ax}\t{ay}\t{aw}\t{ah}")
    return (f"{len(lines)}\n" + "\n".join(lines) + "\n").encode("ascii")


def build(out):
    out["sprites/others/hud_lem.spr"] = fx._additive_sprite([make_hud()], origins=[(0, 0)])
    out["sprites/others/d_lem.spr"] = fx._additive_sprite([death_icon()], origins=[(0, 0)])
    out["sprites/weapon_lem_laptop.txt"] = weapon_txt()
