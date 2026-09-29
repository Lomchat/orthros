#!/usr/bin/env python3
"""Extra JPEG fixtures for tests/codecs.test.js (tests/fixtures/codec/x-*.jpg + <name>.rgba.z, PIL's own decode as
zlib-compressed RGBA): the coding variants the decoder's fast paths distinguish -- 4:2:2, restart intervals, quality
100 (large coefficients: long AC codes, sizes beyond the one-lookup table), optimized Huffman tables, progressive 4:2:0,
odd sizes that end MCUs mid-block, CMYK. Synthetic content only. Usage: python3 tools/gen/codec_fixtures.py"""
import os, zlib
import numpy as np
from PIL import Image

out = os.path.join(os.path.dirname(__file__), '../../tests/fixtures/codec')
rng = np.random.default_rng(11)


def picture(w, h):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    img = np.stack([128 + 90 * np.sin(x / 5.0) * np.cos(y / 7.0), 120 + 80 * np.sin((x - y) / 9.0), 100 + 60 * np.cos(x / 3.0)], -1)
    img += rng.normal(0, 20, img.shape)
    img[(x.astype(int) // 8 + y.astype(int) // 5) % 3 == 0] = [250, 10, 30]  # hard edges
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), 'RGB')


cases = [
    ('x-422', picture(97, 61), dict(quality=85, subsampling=1)),
    ('x-rst', picture(97, 61), dict(quality=80, subsampling=2, restart_marker_blocks=3)),
    ('x-rstrows', picture(97, 61), dict(quality=80, subsampling=0, restart_marker_rows=1)),
    ('x-q100', picture(97, 61), dict(quality=100, subsampling=0)),
    ('x-opt', picture(97, 61), dict(quality=70, subsampling=2, optimize=True)),
    ('x-prog420', picture(97, 61), dict(quality=90, subsampling=2, progressive=True, optimize=True)),
    ('x-odd', picture(33, 17), dict(quality=60, subsampling=2)),
    ('x-cmyk', picture(40, 24).convert('CMYK'), dict(quality=90)),
]
for name, img, kw in cases:
    p = os.path.join(out, name + '.jpg')
    img.save(p, **kw)
    with open(os.path.join(out, name + '.rgba.z'), 'wb') as f:
        f.write(zlib.compress(Image.open(p).convert('RGBA').tobytes(), 9))
    print(name, os.path.getsize(p))
