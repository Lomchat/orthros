"""GoldSrc sprite (.spr, "IDSP" version 2) writer and reader.

Layout: dsprite_t header (40 bytes), short palette size (256) + 256 * RGB, then per frame:
int frametype (0 = single), dspriteframe_t {origin x, origin y, width, height}, width * height indices.

    frames, palette = from_rgba([img0, img1], tex_format=ADDITIVE)
    data = write(frames, palette, type=VP_PARALLEL, tex_format=ADDITIVE)
    data = make([img0, img1], tex_format=ADDITIVE)        # same in one call

Images are (H, W, 4) RGBA arrays (float [0, 1] or uint8) or PIL images.
Texture formats: NORMAL (opaque), ADDITIVE (colour added; black = nothing, used by the HUD and
effects), INDEXALPHA (one colour = palette[255], index = opacity: decals / smoke), ALPHTEST (index
255 transparent).
"""
import struct

import numpy as np

from . import texture

IDSP = 0x50534449
VERSION = 2

# orientation types
VP_PARALLEL_UPRIGHT, FACING_UPRIGHT, VP_PARALLEL, ORIENTED, VP_PARALLEL_ORIENTED = 0, 1, 2, 3, 4
# texture formats
NORMAL, ADDITIVE, INDEXALPHA, ALPHTEST = 0, 1, 2, 3
# sync types
SYNC, RAND = 0, 1


class SprError(ValueError):
    pass


def write(frames, palette, type=VP_PARALLEL, tex_format=ADDITIVE, origins=None, synctype=SYNC, beamlength=0.0):
    """frames: list of (H, W) uint8 palette indices; palette (256, 3) uint8.
    origins: per-frame (x, y) of the top-left corner relative to the sprite centre
    (default centred: (-W/2, H/2), HL convention with y up)."""
    if not frames:
        raise SprError("a sprite needs at least one frame")
    pal = np.asarray(palette, dtype=np.uint8)
    if pal.shape != (256, 3):
        raise SprError("palette must be (256, 3)")
    W = max(f.shape[1] for f in frames)
    H = max(f.shape[0] for f in frames)
    radius = float(np.sqrt((W / 2.0) ** 2 + (H / 2.0) ** 2))
    out = bytearray(struct.pack("<iiiifiiifi", IDSP, VERSION, type, tex_format, radius, W, H, len(frames),
                                float(beamlength), synctype))
    out += struct.pack("<h", 256) + pal.tobytes()
    for i, f in enumerate(frames):
        f = np.ascontiguousarray(f, dtype=np.uint8)
        h, w = f.shape
        ox, oy = (origins[i] if origins is not None else (-(w // 2), h // 2))
        out += struct.pack("<iiiii", 0, int(ox), int(oy), w, h)
        out += f.tobytes()
    return bytes(out)


def read(data):
    """Parse and validate; returns dict(type, tex_format, width, height, palette, frames=[{origin, pixels}])."""
    d = bytes(data)
    if len(d) < 40 + 2:
        raise SprError("file too short")
    ident, version, typ, fmt, radius, W, H, n, beam, sync = struct.unpack_from("<iiiifiiifi", d, 0)
    if ident != IDSP or version != VERSION:
        raise SprError("not an IDSP v2 sprite")
    if not 0 <= typ <= 4 or not 0 <= fmt <= 3 or n < 1:
        raise SprError(f"bad header type={typ} format={fmt} frames={n}")
    (ncol,) = struct.unpack_from("<h", d, 40)
    if not 1 <= ncol <= 256:
        raise SprError(f"bad palette size {ncol}")
    o = 42
    pal = np.frombuffer(d, np.uint8, ncol * 3, o).reshape(ncol, 3)
    o += ncol * 3
    frames = []
    for i in range(n):
        if o + 20 > len(d):
            raise SprError(f"frame {i} header past the end")
        ft, ox, oy, w, h = struct.unpack_from("<iiiii", d, o)
        if ft != 0:
            raise SprError(f"frame {i}: only single frames are supported (type {ft})")
        if w <= 0 or h <= 0 or w > W or h > H:
            raise SprError(f"frame {i}: bad size {w}x{h} (sprite {W}x{H})")
        o += 20
        if o + w * h > len(d):
            raise SprError(f"frame {i} pixels past the end")
        frames.append({"origin": (ox, oy), "pixels": np.frombuffer(d, np.uint8, w * h, o).reshape(h, w)})
        o += w * h
    if o != len(d):
        raise SprError(f"{len(d) - o} trailing bytes")
    return {"type": typ, "tex_format": fmt, "radius": radius, "width": W, "height": H, "palette": pal,
            "frames": frames, "synctype": sync, "beamlength": beam}


def _as_rgba(img):
    a = np.asarray(img)
    if a.dtype == np.uint8:
        a = a.astype(np.float64) / 255.0
    if a.ndim == 2:
        a = np.stack([a, a, a, np.ones_like(a)], axis=-1)
    if a.shape[-1] == 3:
        a = np.concatenate([a, np.ones(a.shape[:2] + (1,))], axis=-1)
    return a


def from_rgba(images, tex_format=ADDITIVE, colour=None, dither=0.0):
    """Quantise RGBA images to frames sharing one palette.

    ADDITIVE: colour premultiplied by alpha (transparent = black).  NORMAL: alpha ignored.
    ALPHTEST: alpha < 0.5 -> index 255.  INDEXALPHA: index = alpha * 255, palette[255] = colour
    (default: mean colour of opaque texels), palette ramps from black to it."""
    imgs = [_as_rgba(i) for i in images]
    shapes = [i.shape[:2] for i in imgs]
    if tex_format == INDEXALPHA:
        if colour is None:
            allp = np.concatenate([i.reshape(-1, 4) for i in imgs])
            w = allp[:, 3]
            colour = (allp[:, :3] * w[:, None]).sum(0) / max(w.sum(), 1e-9)
        c = texture.rgb(colour) if isinstance(colour, str) else np.asarray(colour, dtype=np.float64)
        pal = np.clip(np.round(np.outer(np.arange(256) / 255.0, c) * 255), 0, 255).astype(np.uint8)
        pal[255] = np.clip(np.round(c * 255), 0, 255)
        frames = [np.clip(np.round(i[..., 3] * 255), 0, 255).astype(np.uint8) for i in imgs]
        return frames, pal
    # stack all frames vertically to share one palette
    if tex_format == ADDITIVE:
        rgbs = [i[..., :3] * i[..., 3:4] for i in imgs]
    else:
        rgbs = [i[..., :3] for i in imgs]
    Wm = max(s[1] for s in shapes)
    big = np.zeros((sum(s[0] for s in shapes), Wm, 3))
    trans = np.zeros(big.shape[:2], dtype=bool)
    y = 0
    for r, i in zip(rgbs, imgs):
        h, w = r.shape[:2]
        big[y:y + h, :w] = r
        trans[y:y + h, w:] = True
        if tex_format == ALPHTEST:
            trans[y:y + h, :w] = i[..., 3] < 0.5
        y += h
    if tex_format == ALPHTEST:
        idx, pal = texture.quantize(big, 256, transparent=trans, dither=dither)
    else:
        idx, pal = texture.quantize(big, 256, dither=dither)
    frames = []
    y = 0
    for s in shapes:
        frames.append(idx[y:y + s[0], :s[1]].copy())
        y += s[0]
    return frames, pal


def make(images, type=VP_PARALLEL, tex_format=ADDITIVE, origins=None, synctype=SYNC, colour=None, dither=0.0):
    """RGBA images -> sprite bytes."""
    frames, pal = from_rgba(images, tex_format, colour, dither)
    return write(frames, pal, type=type, tex_format=tex_format, origins=origins, synctype=synctype)


def to_rgba(sprite, frame=0):
    """Decoded frame of a parsed sprite as an RGBA uint8 array (for previews)."""
    f = sprite["frames"][frame]["pixels"]
    pal = sprite["palette"]
    rgb = pal[f]
    fmt = sprite["tex_format"]
    if fmt == ADDITIVE:
        a = np.full(f.shape, 255, np.uint8)
    elif fmt == ALPHTEST:
        a = np.where(f == 255, 0, 255).astype(np.uint8)
    elif fmt == INDEXALPHA:
        rgb = np.broadcast_to(pal[255], f.shape + (3,))
        a = f
    else:
        a = np.full(f.shape, 255, np.uint8)
    return np.dstack([rgb, a]).astype(np.uint8)
