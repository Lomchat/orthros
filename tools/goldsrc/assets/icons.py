"""Antialiased vector painter for HUD icons and sprite frames (Pillow, supersampled).

Coordinates are output pixels (floats); colours are '#rrggbb', (r, g, b) or (r, g, b, a) with
components 0..255 (alpha optional).  Shapes are composited in order with alpha blending.

    c = Canvas(170, 45)
    c.circle(22, 22, 18, fill="#ffffff")
    c.circle(22, 22, 18, outline="#000000", width=3)
    c.rounded_rect(48, 14, 160, 30, 6, fill=(255, 255, 255, 200))
    c.polygon([(50, 40), (60, 30), (70, 40)], fill="#ffcc00")
    rgba = c.rgba()                     # (H, W, 4) uint8
    sheet = Canvas(256, 256); sheet.paste(c, 0, 0)
    data = spr.make([sheet.rgba()], tex_format=spr.ADDITIVE)

HUD weapon/ammo icons are drawn additively by the client and tinted, so paint them as white/grey
shapes on transparent black (use .additive_rgb() to preview what the HUD adds).
"""
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def _col(c):
    if isinstance(c, str):
        c = c.lstrip("#")
        v = [int(c[i:i + 2], 16) for i in (0, 2, 4)]
        if len(c) == 8:
            v.append(int(c[6:8], 16))
        else:
            v.append(255)
        return tuple(v)
    c = tuple(int(round(x)) for x in c)
    return c if len(c) == 4 else c + (255,)


class Canvas:
    def __init__(self, w, h, ss=4, background=(0, 0, 0, 0)):
        self.w, self.h, self.ss = int(w), int(h), int(ss)
        self.img = Image.new("RGBA", (self.w * self.ss, self.h * self.ss), _col(background))

    # internal --------------------------------------------------------------------------------
    def _layer(self):
        return Image.new("RGBA", self.img.size, (0, 0, 0, 0))

    def _put(self, layer, opacity=1.0):
        if opacity < 1.0:
            a = layer.getchannel("A").point(lambda v: int(v * opacity))
            layer.putalpha(a)
        self.img = Image.alpha_composite(self.img, layer)

    def _s(self, *v):
        return [x * self.ss for x in v]

    # shapes ----------------------------------------------------------------------------------
    def ellipse(self, x0, y0, x1, y1, fill=None, outline=None, width=1.0, opacity=1.0):
        layer = self._layer()
        d = ImageDraw.Draw(layer)
        d.ellipse(self._s(x0, y0, x1, y1), fill=_col(fill) if fill else None,
                  outline=_col(outline) if outline else None, width=max(1, int(round(width * self.ss))))
        self._put(layer, opacity)
        return self

    def circle(self, cx, cy, r, **kw):
        return self.ellipse(cx - r, cy - r, cx + r, cy + r, **kw)

    def rect(self, x0, y0, x1, y1, fill=None, outline=None, width=1.0, opacity=1.0):
        layer = self._layer()
        d = ImageDraw.Draw(layer)
        d.rectangle(self._s(x0, y0, x1, y1), fill=_col(fill) if fill else None,
                    outline=_col(outline) if outline else None, width=max(1, int(round(width * self.ss))))
        self._put(layer, opacity)
        return self

    def rounded_rect(self, x0, y0, x1, y1, r, fill=None, outline=None, width=1.0, opacity=1.0):
        layer = self._layer()
        d = ImageDraw.Draw(layer)
        d.rounded_rectangle(self._s(x0, y0, x1, y1), radius=r * self.ss, fill=_col(fill) if fill else None,
                            outline=_col(outline) if outline else None, width=max(1, int(round(width * self.ss))))
        self._put(layer, opacity)
        return self

    def polygon(self, points, fill=None, outline=None, width=1.0, opacity=1.0):
        layer = self._layer()
        d = ImageDraw.Draw(layer)
        pts = [(x * self.ss, y * self.ss) for x, y in points]
        if fill:
            d.polygon(pts, fill=_col(fill))
        if outline:
            d.line(pts + [pts[0]], fill=_col(outline), width=max(1, int(round(width * self.ss))), joint="curve")
        self._put(layer, opacity)
        return self

    def line(self, points, colour, width=1.0, round_caps=True, opacity=1.0):
        layer = self._layer()
        d = ImageDraw.Draw(layer)
        pts = [(x * self.ss, y * self.ss) for x, y in points]
        wpx = max(1, int(round(width * self.ss)))
        d.line(pts, fill=_col(colour), width=wpx, joint="curve")
        if round_caps:
            r = wpx / 2
            for x, y in (pts[0], pts[-1]):
                d.ellipse((x - r, y - r, x + r, y + r), fill=_col(colour))
        self._put(layer, opacity)
        return self

    def arc(self, cx, cy, r, start, end, colour, width=1.0, opacity=1.0):
        """Arc in degrees (0 = +x, clockwise on screen as in Pillow)."""
        layer = self._layer()
        d = ImageDraw.Draw(layer)
        d.arc(self._s(cx - r, cy - r, cx + r, cy + r), start, end, fill=_col(colour),
              width=max(1, int(round(width * self.ss))))
        self._put(layer, opacity)
        return self

    def pie(self, cx, cy, r, start, end, fill, opacity=1.0):
        layer = self._layer()
        ImageDraw.Draw(layer).pieslice(self._s(cx - r, cy - r, cx + r, cy + r), start, end, fill=_col(fill))
        self._put(layer, opacity)
        return self

    def star(self, cx, cy, r_out, r_in, points=5, rotation=-90.0, **kw):
        pts = []
        for i in range(points * 2):
            r = r_out if i % 2 == 0 else r_in
            a = math.radians(rotation + 180.0 * i / points)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        return self.polygon(pts, **kw)

    def bolt(self, x0, y0, x1, y1, width, fill, zigs=2):
        """Lightning-bolt polygon from (x0, y0) to (x1, y1)."""
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy)
        nx, ny = -dy / L, dx / L
        pts_l, pts_r = [], []
        steps = zigs * 2 + 1
        for i in range(steps + 1):
            t = i / steps
            off = (width if i % 2 else -width) * (1 - t * 0.6) if 0 < i < steps else 0
            px, py = x0 + dx * t + nx * off, y0 + dy * t + ny * off
            pts_l.append((px + nx * width * 0.35 * (1 - t), py + ny * width * 0.35 * (1 - t)))
            pts_r.append((px - nx * width * 0.35 * (1 - t), py - ny * width * 0.35 * (1 - t)))
        return self.polygon(pts_l + pts_r[::-1], fill=fill)

    def glow(self, radius=3.0, strength=1.0):
        """Add a blurred copy underneath (soft halo)."""
        blur = self.img.filter(ImageFilter.GaussianBlur(radius * self.ss))
        if strength != 1.0:
            a = blur.getchannel("A").point(lambda v: min(255, int(v * strength)))
            blur.putalpha(a)
        self.img = Image.alpha_composite(blur, self.img)
        return self

    def paste(self, other, x, y):
        """Composite another Canvas at output pixel (x, y)."""
        if other.ss != self.ss:
            src = other.img.resize((other.w * self.ss, other.h * self.ss), Image.LANCZOS)
        else:
            src = other.img
        layer = self._layer()
        layer.paste(src, (int(x * self.ss), int(y * self.ss)))
        self._put(layer)
        return self

    # output ----------------------------------------------------------------------------------
    def image(self):
        """Downsampled RGBA PIL image (premultiplied-correct box filter)."""
        a = np.asarray(self.img).astype(np.float64)
        alpha = a[..., 3:4] / 255.0
        pre = a[..., :3] * alpha
        H, W, s = self.h, self.w, self.ss
        pre = pre.reshape(H, s, W, s, 3).mean(axis=(1, 3))
        al = alpha.reshape(H, s, W, s, 1).mean(axis=(1, 3))
        rgb = np.where(al > 1e-6, pre / np.maximum(al, 1e-6), 0.0)
        out = np.concatenate([rgb, al * 255.0], axis=-1)
        return Image.fromarray(np.clip(np.round(out), 0, 255).astype(np.uint8), "RGBA")

    def rgba(self):
        return np.asarray(self.image())

    def additive_rgb(self):
        """What an additive renderer adds: colour premultiplied by alpha, on black."""
        a = self.rgba().astype(np.float64)
        return np.clip(np.round(a[..., :3] * a[..., 3:4] / 255.0), 0, 255).astype(np.uint8)
