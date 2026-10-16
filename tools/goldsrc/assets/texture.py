"""Texturing: analytic 3D paint helpers, baked shading (AO from the SDF, top light, toon steps),
automatic UV charts (box projection) packed into an atlas, rasterising paint into the atlas, and
256-colour palette quantisation.

A paint function receives model-space REST positions P (N, 3), unit normals N (N, 3) and the skin
index, and returns colours (N, 3) in [0, 1] (optionally (colours, alpha) for masked textures):

    YELLOW, RED = rgb("#f7d02c"), rgb("#e0412b")
    def paint(P, N, skin):
        c = np.tile(YELLOW, (len(P), 1))
        c = mix(c, RED, spot(P, (6, 5.5, 25), 2.0, soft=0.2) + spot(P, (6, -5.5, 25), 2.0, soft=0.2))
        return shade(c, N, ao=ambient_occlusion(shape, P, N))

Everything is evaluated in 3D, so eyes and markings stay crisp across UV seams.
"""
import math

import numpy as np

# ---------------------------------------------------------------------------------------------
# colours and masks
# ---------------------------------------------------------------------------------------------


def rgb(c):
    """'#rrggbb', (r, g, b) in 0..255 or floats in 0..1 -> np.array float (3,) in [0, 1]."""
    if isinstance(c, str):
        c = c.lstrip("#")
        return np.array([int(c[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float64) / 255.0
    a = np.asarray(c, dtype=np.float64)
    return a / 255.0 if a.max() > 1.0 else a


def fill(P, colour):
    return np.tile(rgb(colour), (len(P), 1))


def mix(a, b, m):
    """a * (1 - m) + b * m with broadcasting; m (N,) or scalar, a/b colours (N, 3) or (3,)."""
    m = np.clip(np.asarray(m, dtype=np.float64), 0.0, 1.0)
    if m.ndim == 1:
        m = m[:, None]
    a = rgb(a) if isinstance(a, str) else np.asarray(a, dtype=np.float64)
    b = rgb(b) if isinstance(b, str) else np.asarray(b, dtype=np.float64)
    return a * (1 - m) + b * m


def _sstep(e0, e1, x):
    t = np.clip((x - e0) / np.maximum(e1 - e0, 1e-12), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def edge(d, soft=0.1):
    """Mask from a signed distance d (negative inside): 1 inside, antialiased over `soft` units."""
    return 1.0 - _sstep(-soft * 0.5, soft * 0.5, np.asarray(d, dtype=np.float64))


def spot(P, center, radius, soft=0.15):
    """Round spot: 1 within `radius` of center (3D distance)."""
    d = np.linalg.norm(np.asarray(P) - np.asarray(center, dtype=np.float64), axis=1) - radius
    return edge(d, soft)


def ellipse(P, center, radii, R=None, soft=0.15):
    """Ellipsoidal spot with semi-axes radii, optionally rotated by matrix R (local -> model)."""
    q = np.asarray(P) - np.asarray(center, dtype=np.float64)
    if R is not None:
        q = q @ np.asarray(R)
    r = np.asarray(radii, dtype=np.float64)
    k = np.linalg.norm(q / r, axis=1)
    d = (k - 1.0) * np.min(r)
    return edge(d, soft)


def band(P, direction, lo, hi, soft=0.15):
    """1 where lo <= P . direction <= hi (direction normalised)."""
    d = np.asarray(direction, dtype=np.float64)
    d = d / np.linalg.norm(d)
    x = np.asarray(P) @ d
    return edge(np.maximum(lo - x, x - hi), soft)


def halfspace(P, point, normal, soft=0.15):
    """1 on the side of the plane the normal points to."""
    n = np.asarray(normal, dtype=np.float64)
    n = n / np.linalg.norm(n)
    return edge(-(np.asarray(P) - np.asarray(point, dtype=np.float64)) @ n, soft)


def sdf_mask(shape, P, soft=0.15, grow=0.0):
    """1 inside an SDF (e.g. stripes or patches modelled as capsules/ellipsoids)."""
    return edge(shape(np.asarray(P)) - grow, soft)


def layers(P, N, base, rules):
    """Material regions as ordered layers: base colour, then for each (mask, colour) mix it on top.
    mask: array (N,) or callable(P, N) -> (N,); colour: colour, (N, 3) array or callable(P, N).
    Example: layers(P, N, "#f7d02c", [(lambda P, N: band(P, (0, 0, 1), 30, 40), "#202020")])"""
    c = np.tile(rgb(base), (len(P), 1)) if not callable(base) else np.asarray(base(P, N), dtype=np.float64)
    for mask, colour in rules:
        m = mask(P, N) if callable(mask) else mask
        col = colour(P, N) if callable(colour) else (rgb(colour) if isinstance(colour, (str, tuple, list)) else colour)
        c = mix(c, col, m)
    return c


def gradient(P, direction, lo, hi, c0, c1, ease=True):
    """Colour ramp along a direction from c0 (at lo) to c1 (at hi)."""
    d = np.asarray(direction, dtype=np.float64)
    d = d / np.linalg.norm(d)
    t = np.clip((np.asarray(P) @ d - lo) / (hi - lo), 0.0, 1.0)
    if ease:
        t = t * t * (3 - 2 * t)
    return mix(rgb(c0), rgb(c1), t)


def facing(N, direction, lo=0.0, hi=1.0):
    """0..1 ramp of N . direction between lo and hi (e.g. belly on the front)."""
    d = np.asarray(direction, dtype=np.float64)
    d = d / np.linalg.norm(d)
    return _sstep(lo, hi, np.asarray(N) @ d)


def eye(P, center, direction, radii, up=(0.0, 0.0, 1.0), iris=None, iris_radius=0.6, pupil="#111111",
        pupil_radius=0.45, sclera=None, outline="#151010", outline_width=0.12, highlight="#ffffff",
        highlight_pos=(0.3, 0.38), highlight_radius=0.26, look=(0.0, 0.0), soft=0.08, depth=None):
    """Paint a cartoon eye on a surface.  Coordinates are in the plane facing `direction` through
    `center`: radii = (half width, half height) in units; iris/pupil/highlight sizes are fractions of
    the half height; look shifts iris+pupil (fractions).  Returns (colour (N, 3), mask (N,)).

    Pikachu-like: sclera=None, iris=None (all pupil-coloured) with a big highlight.
    Charizard-like: sclera="#f4f4f0", iris="#2d8fb7", pupil black.
    """
    P = np.asarray(P, dtype=np.float64)
    c = np.asarray(center, dtype=np.float64)
    fwd = np.asarray(direction, dtype=np.float64)
    fwd = fwd / np.linalg.norm(fwd)
    upv = np.asarray(up, dtype=np.float64)
    upv = upv - fwd * (upv @ fwd)
    upv = upv / np.linalg.norm(upv)
    right = np.cross(fwd, upv)  # viewer's right when looking at the eye is -right... keep consistent
    q = P - c
    u = q @ right
    v = q @ upv
    w = q @ fwd
    rw, rh = radii
    depth = max(rw, rh) * 1.5 if depth is None else depth
    front = edge(-(w + depth), soft)
    k = np.sqrt((u / rw) ** 2 + (v / rh) ** 2)
    d_eye = (k - 1.0) * min(rw, rh)
    mask = edge(d_eye, soft) * front
    col = np.tile(rgb(pupil), (len(P), 1))
    if sclera is not None:
        col = np.tile(rgb(sclera), (len(P), 1))
    lu, lv = look[0] * rh, look[1] * rh
    if iris is not None:
        di = np.sqrt((u - lu) ** 2 + (v - lv) ** 2) - iris_radius * rh
        col = mix(col, rgb(iris), edge(di, soft))
        dp = np.sqrt((u - lu) ** 2 + (v - lv) ** 2) - pupil_radius * rh
        col = mix(col, rgb(pupil), edge(dp, soft))
    elif sclera is not None:
        dp = np.sqrt((u - lu) ** 2 + (v - lv) ** 2) - pupil_radius * rh
        col = mix(col, rgb(pupil), edge(dp, soft))
    if highlight is not None:
        hu, hv = highlight_pos
        dh = np.sqrt((u - (lu + hu * rh)) ** 2 + (v - (lv + hv * rh)) ** 2) - highlight_radius * rh
        col = mix(col, rgb(highlight), edge(dh, soft))
    if outline is not None and outline_width > 0:
        col = mix(col, rgb(outline), edge(-(d_eye + outline_width), soft) * (d_eye > -outline_width * 2))
    return col, mask


# ---------------------------------------------------------------------------------------------
# baked shading
# ---------------------------------------------------------------------------------------------

def ambient_occlusion(shape, P, N, dist=3.0, steps=5, strength=1.0):
    """SDF ambient occlusion in [0, 1] (1 = open): samples along the normal."""
    P = np.asarray(P, dtype=np.float64)
    N = np.asarray(N, dtype=np.float64)
    occ = np.zeros(len(P))
    w = 1.0
    d0 = shape(P)  # baseline: the mesh lies slightly off the exact surface (chord error)
    for i in range(1, steps + 1):
        h = dist * i / steps
        d = shape(P + N * h) - d0
        occ += w * np.maximum(h - d, 0.0) / dist
        w *= 0.6
    return np.clip(1.0 - strength * occ * 1.6, 0.0, 1.0)


def shade(colour, N, ao=None, ao_strength=0.65, top=0.18, shadow_tint=None, toon_steps=0, light=(0.3, 0.2, 1.0),
          light_amount=0.0, cavity_floor=0.35):
    """Paint lighting into the albedo (the engine adds its own Lambert on top).

    top: brighten upward faces / darken downward ones by this fraction.
    ao: occlusion values (from ambient_occlusion), mixed in with ao_strength (never below cavity_floor).
    shadow_tint: colour multiplied into the shaded side (cool shadows), e.g. "#8080b0".
    light/light_amount: an extra painted key light direction; toon_steps > 0 quantises it.
    """
    c = np.asarray(colour, dtype=np.float64).copy()
    N = np.asarray(N, dtype=np.float64)
    f = 1.0 + top * N[:, 2]
    if light_amount:
        L = np.asarray(light, dtype=np.float64)
        L = L / np.linalg.norm(L)
        lam = np.clip(N @ L, 0.0, 1.0)
        if toon_steps:
            lam = np.floor(lam * toon_steps + 0.5) / toon_steps
        f = f * (1 - light_amount + light_amount * (0.55 + 0.45 * lam) / 0.775)
    if ao is not None:
        a = np.maximum(cavity_floor, 1.0 - ao_strength * (1.0 - np.asarray(ao)))
        f = f * a
    c = c * f[:, None]
    if shadow_tint is not None:
        down = np.clip(-N[:, 2], 0.0, 1.0) * 0.5
        if ao is not None:
            down = np.maximum(down, (1.0 - np.asarray(ao)) * 0.6)
        c = mix(c, c * rgb(shadow_tint) / max(rgb(shadow_tint).max(), 1e-6), down)
    return np.clip(c, 0.0, 1.0)


# ---------------------------------------------------------------------------------------------
# UV charts and atlas packing
# ---------------------------------------------------------------------------------------------

_DIRS = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], dtype=np.float64)
# (u axis, v axis) per direction; v is negated z so that "up" is up in the image
_PROJ = {0: (1, 2), 1: (1, 2), 2: (0, 2), 3: (0, 2), 4: (0, 1), 5: (0, 1)}


def face_adjacency(faces):
    """(F, 3) neighbour face across each edge (-1 when none or non-manifold)."""
    F = np.asarray(faces)
    nf = len(F)
    e = {}
    for fi in range(nf):
        for k in range(3):
            a, b = int(F[fi, k]), int(F[fi, (k + 1) % 3])
            e.setdefault((min(a, b), max(a, b)), []).append((fi, k))
    adj = -np.ones((nf, 3), dtype=np.int64)
    for lst in e.values():
        if len(lst) == 2:
            (f0, k0), (f1, k1) = lst
            adj[f0, k0] = f1
            adj[f1, k1] = f0
    return adj


def box_charts(verts, faces, smooth_iters=3, min_dot=0.3, frame=None):
    """Split a mesh into charts by dominant normal axis; returns list of dicts
    {"faces": (k,) face ids, "uv": (k, 3, 2) unit coordinates, "dir": axis id}.
    frame: optional 3x3 rotation whose columns are the box axes in model space (default the model
    axes), e.g. to centre one chart on a decal so that it is not split across charts."""
    V = np.asarray(verts, dtype=np.float64)
    if frame is not None:
        V = V @ np.asarray(frame, dtype=np.float64)
    F = np.asarray(faces, dtype=np.int64)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    fn = fn / np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    dots = fn @ _DIRS.T
    label = np.argmax(dots, axis=1)
    adj = face_adjacency(F)
    for _ in range(smooth_iters):
        nl = label[np.where(adj >= 0, adj, np.arange(len(F))[:, None])]
        new = label.copy()
        for k in range(3):
            cand = nl[:, k]
            agree = (nl == cand[:, None]).sum(1) >= 2
            ok = agree & (dots[np.arange(len(F)), cand] >= min_dot) & (cand != label)
            new[ok] = cand[ok]
        label = new
    # connected components with the same label
    comp = -np.ones(len(F), dtype=np.int64)
    charts = []
    for start in range(len(F)):
        if comp[start] >= 0:
            continue
        cid = len(charts)
        stack = [start]
        comp[start] = cid
        members = []
        while stack:
            f = stack.pop()
            members.append(f)
            for g in adj[f]:
                if g >= 0 and comp[g] < 0 and label[g] == label[start]:
                    comp[g] = cid
                    stack.append(g)
        members = np.array(sorted(members), dtype=np.int64)
        d = int(label[start])
        ua, va = _PROJ[d]
        P = V[F[members]]  # (k, 3, 3)
        u = P[..., ua] * (1 if d in (1, 2, 4) else -1)
        v = -P[..., va] if d < 4 else P[..., va] * (1 if d == 4 else -1)
        charts.append({"faces": members, "uv": np.stack([u, v], axis=-1), "dir": d})
    return charts


def _min_area_orientation(uv, steps=36):
    """Rotate chart coordinates (k, 3, 2) in their plane so that their bounding box is smallest."""
    pts = uv.reshape(-1, 2)
    best, best_a = None, 0.0
    for i in range(steps):
        a = math.pi / 2 * i / steps
        c, s_ = math.cos(a), math.sin(a)
        q = pts @ np.array([[c, -s_], [s_, c]])
        ext = q.max(0) - q.min(0)
        area = float((ext[0] + 0.5) * (ext[1] + 0.5))
        if best is None or area < best - 1e-9:
            best, best_a = area, a
    c, s_ = math.cos(best_a), math.sin(best_a)
    return uv @ np.array([[c, -s_], [s_, c]])


def _skyline_place(sizes, order, W, H, pad):
    """Bottom-left skyline packing of rectangles sizes[i] = (w, h) (padding included), each placed
    as is or turned 90 degrees, whichever ends lower.  Returns {i: (x, y, turned)} or None."""
    sky = [[0, 0, W]]  # contiguous segments [x, y, width] covering [0, W)
    pos = {}
    for i in order:
        bw, bh = sizes[i]
        best = None
        for turned in (False, True):
            w, h = (bh, bw) if turned else (bw, bh)
            if w > W or h > H:
                continue
            for j in range(len(sky)):
                x = sky[j][0]
                if x + w > W:
                    break
                y, rem, k = 0, w, j
                while rem > 0:
                    y = max(y, sky[k][1])
                    rem -= sky[k][2]
                    k += 1
                if y + h > H:
                    continue
                key = (y + h, x, turned)
                if best is None or key < best[0]:
                    best = (key, x, y, w, h, turned)
        if best is None:
            return None
        _, x, y, w, h, turned = best
        pos[i] = (x + pad, y + pad, turned)
        # raise the skyline over [x, x + w)
        new = []
        for sx, sy, sw in sky:
            e = sx + sw
            if e <= x or sx >= x + w:
                new.append([sx, sy, sw])
                continue
            if sx < x:
                new.append([sx, sy, x - sx])
            if e > x + w:
                new.append([x + w, sy, e - (x + w)])
        new.append([x, y + h, w])
        new.sort()
        merged = []
        for seg in new:
            if merged and merged[-1][1] == seg[1] and merged[-1][0] + merged[-1][2] == seg[0]:
                merged[-1][2] += seg[2]
            else:
                merged.append(seg)
        sky = merged
    return pos


def pack_charts(chart_list, size, pad=2, method="shelf"):
    """Pack charts (each {"uv": (k, 3, 2) units, "density": scale factor}) into size=(W, H).

    method "shelf" (rows by decreasing height) or "skyline" (bottom-left skyline, charts may be
    turned 90 degrees: denser, especially with a few large charts).
    Finds the largest uniform texel density that fits, sets chart["st"] (k, 3, 2) integer pixel
    coordinates and returns the density (pixels per unit)."""
    W, H = size
    if method == "skyline":
        for c in chart_list:  # turn each chart in its plane to its smallest bounding box
            c["uv"] = _min_area_orientation(c["uv"])
    boxes = []
    for c in chart_list:
        uv = c["uv"].reshape(-1, 2)
        lo, hi = uv.min(0), uv.max(0)
        boxes.append((lo, hi - lo, c.get("density", 1.0)))
    order = sorted(range(len(boxes)), key=lambda i: (-(boxes[i][1][1] * boxes[i][2]), i))
    if method == "skyline":
        order = sorted(range(len(boxes)), key=lambda i: (-(max(boxes[i][1]) * boxes[i][2]),
                                                         -(min(boxes[i][1]) * boxes[i][2]), i))

    def place_skyline(s):
        sizes = [(int(math.ceil(b[1][0] * s * b[2])) + 1 + 2 * pad, int(math.ceil(b[1][1] * s * b[2])) + 1 + 2 * pad)
                 for b in boxes]
        return _skyline_place(sizes, order, W, H, pad)

    def place(s):
        if method == "skyline":
            return place_skyline(s)
        x = y = row_h = 0
        pos = {}
        for i in order:
            w = int(math.ceil(boxes[i][1][0] * s * boxes[i][2])) + 1 + 2 * pad
            h = int(math.ceil(boxes[i][1][1] * s * boxes[i][2])) + 1 + 2 * pad
            if w > W:
                return None
            if x + w > W:
                x, y = 0, y + row_h
                row_h = 0
            if y + h > H:
                return None
            pos[i] = (x + pad, y + pad)
            x += w
            row_h = max(row_h, h)
        return pos

    area = sum(b[1][0] * b[1][1] * b[2] ** 2 for b in boxes) + 1e-9
    hi_s = math.sqrt(W * H / area) * 1.2
    lo_s = 0.0
    best = None
    for _ in range(30):
        mid = (lo_s + hi_s) / 2
        p = place(mid)
        if p is None:
            hi_s = mid
        else:
            lo_s, best = mid, p
    if best is None:
        raise ValueError("charts do not fit in the atlas")
    s = lo_s
    for i, c in enumerate(chart_list):
        lo = boxes[i][0]
        ox, oy = best[i][:2]
        uv = c["uv"] - lo
        if len(best[i]) > 2 and best[i][2]:
            uv = uv[..., ::-1]  # turned chart: swap the axes (a mirror image is fine for baked paint)
        st = uv * s * boxes[i][2] + np.array([ox, oy])
        c["st"] = np.clip(np.round(st), 0, [W, H]).astype(np.int64)
    return s


# ---------------------------------------------------------------------------------------------
# rasterising paint into the atlas
# ---------------------------------------------------------------------------------------------

def raster_texels(st, size):
    """Texel centres covered by triangles with pixel coordinates st (T, 3, 2).

    Returns (tri index (K,), x (K,), y (K,), barycentrics (K, 3))."""
    W, H = size
    st = np.asarray(st, dtype=np.float64)
    x0 = np.clip(np.floor(st[..., 0].min(1)).astype(np.int64), 0, W - 1)
    x1 = np.clip(np.ceil(st[..., 0].max(1)).astype(np.int64), 0, W - 1)
    y0 = np.clip(np.floor(st[..., 1].min(1)).astype(np.int64), 0, H - 1)
    y1 = np.clip(np.ceil(st[..., 1].max(1)).astype(np.int64), 0, H - 1)
    w = x1 - x0 + 1
    h = y1 - y0 + 1
    cnt = w * h
    tri = np.repeat(np.arange(len(st)), cnt)
    start = np.repeat(np.cumsum(cnt) - cnt, cnt)
    local = np.arange(int(cnt.sum())) - start
    px = x0[tri] + local % w[tri]
    py = y0[tri] + local // w[tri]
    cx, cy = px + 0.5, py + 0.5
    a, b, c = st[tri, 0], st[tri, 1], st[tri, 2]
    det = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])
    good = np.abs(det) > 1e-9
    det = np.where(good, det, 1.0)
    l1 = ((cx - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (cy - a[:, 1])) / det
    l2 = ((b[:, 0] - a[:, 0]) * (cy - a[:, 1]) - (cx - a[:, 0]) * (b[:, 1] - a[:, 1])) / det
    l0 = 1 - l1 - l2
    eps = -1e-6
    inside = good & (l0 >= eps) & (l1 >= eps) & (l2 >= eps)
    return tri[inside], px[inside], py[inside], np.stack([l0, l1, l2], axis=1)[inside]


def dilate(img, mask, iters=16):
    """Grow covered texels into empty ones (gutters) by averaging covered neighbours."""
    img = img.copy()
    m = mask.copy()
    H, W = m.shape
    for _ in range(iters):
        if m.all():
            break
        acc = np.zeros_like(img)
        cnt = np.zeros((H, W))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == dy == 0:
                    continue
                sm = np.zeros((H, W), dtype=bool)
                si = np.zeros_like(img)
                ys = slice(max(dy, 0), H + min(dy, 0))
                yd = slice(max(-dy, 0), H + min(-dy, 0))
                xs = slice(max(dx, 0), W + min(dx, 0))
                xd = slice(max(-dx, 0), W + min(-dx, 0))
                sm[yd, xd] = m[ys, xs]
                si[yd, xd] = img[ys, xs]
                acc += si * sm[..., None]
                cnt += sm
        grow = (~m) & (cnt > 0)
        img[grow] = acc[grow] / cnt[grow][:, None]
        m = m | grow
    if not m.all():
        fillc = img[m].mean(0) if m.any() else np.zeros(img.shape[-1])
        img[~m] = fillc
    return img


def bake(size, st, pos, nrm, paint, skin=0, extra=None):
    """Rasterise a paint function into an RGB(A) float image.

    st (T, 3, 2) pixel corners, pos (T, 3, 3) model-space corner positions, nrm (T, 3, 3) corner normals.
    paint(P, N, skin) -> colours (K, 3) or (colours, alpha).  extra: optional (T,) int array passed as
    paint.ctx["tri_tag"] (e.g. the part index) when paint accepts a 4th argument.
    Returns (rgb (H, W, 3), alpha (H, W) or None, covered mask (H, W))."""
    W, H = size
    tri, px, py, bary = raster_texels(st, size)
    P = np.einsum("kc,kcd->kd", bary, pos[tri])
    N = np.einsum("kc,kcd->kd", bary, nrm[tri])
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
    if extra is not None:
        out = paint(P, N, skin, extra[tri])
    else:
        out = paint(P, N, skin)
    alpha = None
    if isinstance(out, tuple):
        col, a = out
        alpha = np.ones((H, W))
        alpha[py, px] = np.asarray(a, dtype=np.float64)
    else:
        col = out
    img = np.zeros((H, W, 3))
    covered = np.zeros((H, W), dtype=bool)
    img[py, px] = np.clip(np.asarray(col, dtype=np.float64), 0.0, 1.0)
    covered[py, px] = True
    img = dilate(img, covered)
    if alpha is not None:
        alpha = dilate(alpha[..., None], covered)[..., 0]
    return img, alpha, covered


# ---------------------------------------------------------------------------------------------
# palette quantisation
# ---------------------------------------------------------------------------------------------

def _median_cut(colors, weights, n):
    boxes = [np.arange(len(colors))]
    while len(boxes) < n:
        best, best_score = -1, 0.0
        for i, b in enumerate(boxes):
            if len(b) < 2:
                continue
            c = colors[b]
            rng = c.max(0) - c.min(0)
            score = float(rng.max()) * math.sqrt(float(weights[b].sum()))
            if score > best_score:
                best, best_score = i, score
        if best < 0:
            break
        b = boxes.pop(best)
        c = colors[b]
        axis = int(np.argmax(c.max(0) - c.min(0)))
        order = b[np.argsort(c[:, axis], kind="stable")]
        cw = np.cumsum(weights[order])
        cut = int(np.searchsorted(cw, cw[-1] / 2))
        cut = min(max(cut, 1), len(order) - 1)
        boxes.append(order[:cut])
        boxes.append(order[cut:])
    pal = np.array([np.average(colors[b], axis=0, weights=weights[b]) for b in boxes])
    return pal


def _nearest(colors, pal, chunk=8192):
    out = np.empty(len(colors), dtype=np.int64)
    p2 = np.sum(pal * pal, axis=1)
    for i in range(0, len(colors), chunk):
        c = colors[i:i + chunk]
        d = p2[None, :] - 2 * c @ pal.T
        out[i:i + chunk] = np.argmin(d, axis=1)
    return out


_BAYER4 = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], dtype=np.float64) / 16 - 0.47


def quantize(img, ncolors=256, transparent=None, dither=0.0, kmeans_iters=6):
    """Quantise an RGB image ((H, W, 3) float [0, 1] or uint8) to an indexed image and a palette.

    transparent: optional bool mask (H, W); those pixels get index 255 (palette[255] = 0,0,255) and
    the other colours use at most 255 entries (for STUDIO_NF_MASKED / alpha-tested sprites).
    dither: 0 (off: flat toon areas stay flat) or an ordered-dither amplitude in palette steps (~1).
    Returns (indices (H, W) uint8, palette (256, 3) uint8)."""
    a = np.asarray(img)
    if a.dtype != np.uint8:
        a = np.clip(np.round(a * 255.0), 0, 255).astype(np.uint8)
    H, W = a.shape[:2]
    flat = a.reshape(-1, 3)
    valid = np.ones(H * W, dtype=bool) if transparent is None else ~np.asarray(transparent).reshape(-1)
    n = ncolors - (1 if transparent is not None else 0)
    n = min(n, 256 - (1 if transparent is not None else 0))
    src = flat[valid] if valid.any() else flat[:1]
    uniq, inv, counts = np.unique(src, axis=0, return_inverse=True, return_counts=True)
    uf = uniq.astype(np.float64)
    w = counts.astype(np.float64)
    if len(uniq) <= n:
        pal = uf
    else:
        pal = _median_cut(uf, w, n)
        for _ in range(kmeans_iters):
            lab = _nearest(uf, pal)
            sums = np.zeros_like(pal)
            np.add.at(sums, lab, uf * w[:, None])
            tot = np.bincount(lab, weights=w, minlength=len(pal))
            nz = tot > 0
            pal[nz] = sums[nz] / tot[nz][:, None]
    pal_u8 = np.clip(np.round(pal), 0, 255).astype(np.uint8)
    # deterministic order: sort palette by luminance
    lum = pal_u8.astype(np.float64) @ np.array([0.299, 0.587, 0.114])
    order = np.lexsort((pal_u8[:, 2], pal_u8[:, 1], pal_u8[:, 0], lum))
    pal_u8 = pal_u8[order]
    palette = np.zeros((256, 3), dtype=np.uint8)
    palette[:len(pal_u8)] = pal_u8
    pf = pal_u8.astype(np.float64)
    if dither:
        yy, xx = np.mgrid[0:H, 0:W]
        thr = _BAYER4[yy % 4, xx % 4].reshape(-1, 1)
        step = 255.0 / max(len(pal_u8) ** (1 / 3), 1.0)
        target = flat.astype(np.float64) + thr * step * dither
        idx = _nearest(target, pf)
    else:
        idx = np.zeros(H * W, dtype=np.int64)
        u2, inv2 = np.unique(flat, axis=0, return_inverse=True)
        idx = _nearest(u2.astype(np.float64), pf)[inv2.reshape(-1)]
    if transparent is not None:
        idx[~valid] = 255
        palette[255] = (0, 0, 255)
    return idx.reshape(H, W).astype(np.uint8), palette


def indexed_to_rgb(indices, palette):
    return np.asarray(palette)[np.asarray(indices)]
