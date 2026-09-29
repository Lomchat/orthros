#!/usr/bin/env python3
"""Synthetic texture-like images for tools/codec-bench.mjs (never game files): smooth gradients, grain and
hard-edged discs, 256/512/1024 squared, saved by PIL (libjpeg / zlib) as JPEG (qualities 50-90, 4:2:0, 4:2:2,
4:4:4, progressive, grayscale) and PNG (RGB, RGBA, palette, smooth RGBA), each with PIL's own decode as a raw RGBA reference
(<file>.rgba). Usage: python3 tools/gen/codec_images.py <out dir> [sizes...]"""
import sys, os
import numpy as np
from PIL import Image

out = sys.argv[1]
sizes = [int(s) for s in sys.argv[2:]] or [256, 512, 1024]
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(7)


def texture(w, h, alpha=False, grain=12):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    r = 128 + 60 * np.sin(x / 37.0) + 40 * np.cos(y / 23.0 + x / 91.0)
    g = 110 + 70 * np.sin((x + y) / 53.0) + 20 * np.sin(x / 7.0) * np.cos(y / 9.0)
    b = 90 + 50 * np.cos(x / 17.0 - y / 29.0)
    img = np.stack([r, g, b], -1)
    img += rng.normal(0, grain, img.shape) if grain else 0  # grain
    for _ in range(40):  # hard-edged discs
        cx, cy, rad = rng.integers(0, w), rng.integers(0, h), rng.integers(4, max(5, w // 8))
        m = (x - cx) ** 2 + (y - cy) ** 2 < rad * rad
        img[m] = img[m] * 0.5 + rng.integers(0, 256, 3) * 0.5
    img = np.clip(img, 0, 255).astype(np.uint8)
    if alpha:
        a = np.clip(128 + 127 * np.sin(x / 41.0) * np.cos(y / 33.0), 0, 255).astype(np.uint8)
        a[(x.astype(int) // 64 + y.astype(int) // 64) % 2 == 0] = 255
        return Image.fromarray(np.dstack([img, a]), 'RGBA')
    return Image.fromarray(img, 'RGB')


files = []
for s in sizes:
    im = texture(s, s)
    for q in (50, 75, 90):
        files.append((f't{s}_q{q}_420.jpg', im, dict(quality=q, subsampling=2)))
    files.append((f't{s}_q90_444.jpg', im, dict(quality=90, subsampling=0)))
    files.append((f't{s}_q85_422.jpg', im, dict(quality=85, subsampling=1)))
    files.append((f't{s}_q85_prog.jpg', im, dict(quality=85, progressive=True)))
    files.append((f't{s}_gray.jpg', im.convert('L'), dict(quality=85)))
    files.append((f't{s}_rgb.png', im, {}))
    files.append((f't{s}_rgba.png', texture(s, s, True), {}))
    files.append((f't{s}_pal.png', im.quantize(256), {}))
    files.append((f't{s}_ui.png', texture(s, s, True, 0), {}))  # (no grain: long matches, like UI art)
for name, img, kw in files:
    p = os.path.join(out, name)
    img.save(p, **kw)
    with open(p + '.rgba', 'wb') as f:
        f.write(Image.open(p).convert('RGBA').tobytes())
print(len(files), 'images in', out)
