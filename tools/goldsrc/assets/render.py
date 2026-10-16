"""Offline software renderer for GoldSrc .mdl files (numpy, vectorised) -> PNG.

Reads the bytes through mdl.read, poses the skeleton with the engine's exact animation decoding,
skins with the 8-bit textures (nearest), lights like GoldSrc's studio renderer (ambient + one
directional "shade" light with its hemispherical Lambert, FLATSHADE / FULLBRIGHT honoured, masked
index 255 cut out, additive meshes added), back-face culls like the engine, z-buffer, ground grid.

CLI:
  python3 -I render.py model.mdl out.png [--seq idle] [--frame 0] [--skin 0] [--yaw 35] [--pitch 15]
                       [--size 512] [--dist auto] [--sheet [--frames 6] [--cell 220]] [--views]

  --sheet: contact sheet, one row per sequence, --frames evenly spaced frames each, labelled.
  --views: reference pose from front, 3/4, side, back and top.

Python:
  img = render_frame(pm, seq=0, frame=0)           # PIL.Image
  sheet = contact_sheet(pm, frames=6)
"""
import argparse
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from assets import mdl, xform  # noqa: E402
else:
    from . import mdl, xform

BG = np.array([38, 39, 43], dtype=np.float64)
GRID_MINOR = np.array([58, 60, 66], dtype=np.float64)
GRID_MAJOR = np.array([80, 83, 92], dtype=np.float64)
SHADE_LAMBERT = 1.4953241


class Camera:
    """Perspective camera orbiting `target` (yaw from +x toward +y, pitch up), or placed at `eye`.
    fov is the HORIZONTAL field of view in degrees (the focal length comes from the image width), like the
    engine's fov at 4:3 (default_fov 90)."""

    def __init__(self, target, yaw, pitch, dist, size, fov=38.0, eye=None):
        self.W, self.H = size
        yr, pr = math.radians(yaw), math.radians(pitch)
        d = np.array([math.cos(pr) * math.cos(yr), math.cos(pr) * math.sin(yr), math.sin(pr)])
        self.target = np.asarray(target, dtype=np.float64)
        if eye is not None:
            self.pos = np.asarray(eye, dtype=np.float64)
            d = self.pos - self.target
            d = d / np.linalg.norm(d)
        else:
            self.pos = self.target + d * dist
        f = -d
        r = np.cross(f, [0.0, 0.0, 1.0])
        if np.linalg.norm(r) < 1e-6:
            r = np.array([0.0, -1.0, 0.0])
        r /= np.linalg.norm(r)
        u = np.cross(r, f)
        self.f, self.r, self.u = f, r, u
        self.focal = (self.W / 2) / math.tan(math.radians(fov) / 2)

    def project(self, p):
        d = p - self.pos
        z = d @ self.f
        zc = np.maximum(z, 1e-3)
        x = self.W / 2 + (d @ self.r) / zc * self.focal
        y = self.H / 2 - (d @ self.u) / zc * self.focal
        return np.stack([x, y, z], axis=-1)


def fit_distance(lo, hi, fov=38.0, margin=1.12):
    r = 0.5 * float(np.linalg.norm(np.asarray(hi) - np.asarray(lo)))
    return max(r, 1.0) / math.sin(math.radians(fov) / 2) * margin


def _engine_light(nw, flags, ambient, shade, lightvec):
    """R_StudioLighting for world-space normals (N, 3) -> light value lv (N,) in [0, 1]."""
    if flags & mdl.STUDIO_NF_FULLBRIGHT:
        return np.ones(len(nw))
    illum = np.full(len(nw), float(ambient))
    if flags & mdl.STUDIO_NF_FLATSHADE:
        illum += shade * 0.8
    else:
        lightcos = np.minimum(nw @ lightvec, 1.0)
        illum += shade
        r = SHADE_LAMBERT
        lc = (lightcos + (r - 1.0)) / r
        illum -= shade * np.maximum(lc, 0.0)
        illum = np.maximum(illum, 0.0)
    illum = np.minimum(illum, 255.0)
    return (illum / 255.0) ** (1 / 1.6)  # approximates LightToTexGamma at default gamma settings


def _raster(scr, W, H):
    """Fragments of screen triangles scr (T, 3, 3) [x, y, depth]: (tri, pix, bary_persp, depth)."""
    x0 = np.clip(np.floor(scr[..., 0].min(1)).astype(np.int64), 0, W - 1)
    x1 = np.clip(np.ceil(scr[..., 0].max(1)).astype(np.int64), 0, W - 1)
    y0 = np.clip(np.floor(scr[..., 1].min(1)).astype(np.int64), 0, H - 1)
    y1 = np.clip(np.ceil(scr[..., 1].max(1)).astype(np.int64), 0, H - 1)
    w = x1 - x0 + 1
    h = y1 - y0 + 1
    cnt = np.where((scr[..., 0].max(1) < 0) | (scr[..., 0].min(1) > W) | (scr[..., 1].max(1) < 0) |
                   (scr[..., 1].min(1) > H), 0, w * h)
    total = int(cnt.sum())
    if total == 0:
        return (np.zeros(0, np.int64),) * 2 + (np.zeros((0, 3)), np.zeros(0))
    tri = np.repeat(np.arange(len(scr)), cnt)
    start = np.repeat(np.cumsum(cnt) - cnt, cnt)
    local = np.arange(total) - start
    px = x0[tri] + local % w[tri]
    py = y0[tri] + local // w[tri]
    cx, cy = px + 0.5, py + 0.5
    a, b, c = scr[tri, 0], scr[tri, 1], scr[tri, 2]
    det = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])
    good = np.abs(det) > 1e-12
    det = np.where(good, det, 1.0)
    l1 = ((cx - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (cy - a[:, 1])) / det
    l2 = ((b[:, 0] - a[:, 0]) * (cy - a[:, 1]) - (cx - a[:, 0]) * (b[:, 1] - a[:, 1])) / det
    l0 = 1 - l1 - l2
    inside = good & (l0 >= -1e-7) & (l1 >= -1e-7) & (l2 >= -1e-7)
    tri, px, py = tri[inside], px[inside], py[inside]
    l = np.stack([l0[inside], l1[inside], l2[inside]], axis=1)
    iz = 1.0 / np.maximum(scr[tri, :, 2], 1e-3)
    wp = l * iz
    depth = 1.0 / wp.sum(1)
    bary = wp * depth[:, None]
    return tri, py * W + px, bary, depth


def _ground(cam, W, H, extent=None):
    """Background with a ground grid on z = 0; returns (rgb (H, W, 3), depth (H, W))."""
    yy, xx = np.mgrid[0:H, 0:W]
    dx = (xx + 0.5 - W / 2) / cam.focal
    dy = -(yy + 0.5 - H / 2) / cam.focal
    dirs = cam.f[None, None, :] + dx[..., None] * cam.r + dy[..., None] * cam.u
    img = np.tile(BG, (H, W, 1))
    depth = np.full((H, W), np.inf)
    dz = dirs[..., 2]
    hit = dz < -1e-6
    t = np.where(hit, -cam.pos[2] / np.where(hit, dz, -1.0), np.inf)
    hit &= t > 0
    gp = cam.pos[None, None, :] + dirs * np.where(hit, t, 0.0)[..., None]
    zc = t  # dirs have unit component along f, so t is the view depth
    depth[hit] = zc[hit]
    px_size = np.where(hit, zc, 1.0) / cam.focal  # world size of a pixel at that depth
    for spacing, col, width in ((8.0, GRID_MINOR, 0.8), (32.0, GRID_MAJOR, 1.1)):
        fx = np.abs((gp[..., 0] / spacing + 0.5) % 1.0 - 0.5) * spacing
        fy = np.abs((gp[..., 1] / spacing + 0.5) % 1.0 - 0.5) * spacing
        dline = np.minimum(fx, fy) / np.maximum(px_size * width, 1e-6)
        a = np.clip(1.0 - dline, 0.0, 1.0)
        fade = np.clip(1.0 - zc / (np.linalg.norm(cam.pos - cam.target) * 4.0), 0.0, 1.0)
        a = np.where(hit, a * fade, 0.0)
        img = img * (1 - a[..., None]) + col * a[..., None]
    # axes: +x red, +y green (short marks from the origin)
    for axis, col in ((0, np.array([200, 70, 60.0])), (1, np.array([70, 170, 80.0]))):
        other = 1 - axis
        along = gp[..., axis]
        a = np.clip(1.0 - np.abs(gp[..., other]) / np.maximum(px_size * 1.2, 1e-6), 0, 1)
        a = np.where(hit & (along > 0) & (along < 12.0), a, 0.0)
        img = img * (1 - a[..., None]) + col * a[..., None]
    return img, depth


def _posed_geometry(pm, seq, frame, body=0, controllers=None):
    """Posed world-space vertices / normals per model of the chosen body combination."""
    bm = mdl.pose(pm, seq, frame, controllers)
    out = []
    for bp in pm.bodyparts:
        mi = (body // bp.base) % len(bp.models)
        m = bp.models[mi]
        if len(m.verts) == 0:
            continue
        Wv = bm[m.vert_bone]
        v = np.einsum("nij,nj->ni", Wv[:, :, :3], m.verts) + Wv[:, :, 3]
        Wn = bm[m.norm_bone]
        n = np.einsum("nij,nj->ni", Wn[:, :, :3], m.norms)
        out.append((m, v, n))
    return out


def render_frame(pm, seq=0, frame=0.0, skin=0, body=0, yaw=35.0, pitch=15.0, dist=None, size=(512, 512), ss=2,
                 target=None, bounds=None, ambient=80.0, shade=120.0, lightvec=(-0.35, -0.45, -0.82), fov=38.0,
                 controllers=None, grid=True, label=None, eye=None):
    """Render one frame to a PIL RGB image.

    Orbit camera around the bounds' centre (yaw, pitch, dist auto-fitted), or eye=(x, y, z) with
    target=(x, y, z) for a fixed camera (view models: eye=(0, 0, 0), target=(1, 0, 0), fov=90 at 4:3, grid=False).
    Light: ambient + shade with lightvec the direction light travels (engine convention)."""
    if isinstance(seq, str):
        seq = [s["name"] for s in pm.sequences].index(seq)
    W, H = size[0] * ss, size[1] * ss
    if bounds is None:
        s = pm.sequences[seq]
        bounds = (np.array(s["bbmin"]), np.array(s["bbmax"]))
    lo, hi = np.asarray(bounds[0], float), np.asarray(bounds[1], float)
    if target is None:
        target = (lo + hi) / 2
    if dist is None:
        dist = fit_distance(lo, hi, fov)
    cam = Camera(target, yaw, pitch, dist, (W, H), fov, eye=eye)
    if grid:
        img, zbuf_bg = _ground(cam, W, H)
    else:
        img, zbuf_bg = np.tile(BG, (H, W, 1)), np.full((H, W), np.inf)
    lv_dir = np.asarray(lightvec, dtype=np.float64)
    lv_dir = lv_dir / np.linalg.norm(lv_dir)
    fam = pm.skins[skin if 0 <= skin < pm.skins.shape[0] else 0]

    opaque, additive = [], []
    for m, v, n in _posed_geometry(pm, seq, frame, body, controllers):
        for me in m.meshes:
            if len(me.tris) == 0:
                continue
            tex = pm.textures[fam[me.skinref]]
            lv = _engine_light(n, tex.flags, ambient, shade, lv_dir)
            t = me.tris
            pts = v[t[..., 0]]                      # (T, 3, 3)
            fn = np.cross(pts[:, 1] - pts[:, 0], pts[:, 2] - pts[:, 0])
            front = np.einsum("ij,ij->i", fn, cam.pos - pts[:, 0]) > 0
            t, pts = t[front], pts[front]
            entry = (pts, lv[t[..., 1]], t[..., 2:4].astype(np.float64), tex)
            (additive if tex.flags & mdl.STUDIO_NF_ADDITIVE else opaque).append(entry)

    zbuf = zbuf_bg.reshape(-1).copy()
    frame_rgb = img.reshape(-1, 3).copy()

    def fragments(entries):
        for pts, lvc, stc, tex in entries:
            scr = cam.project(pts.reshape(-1, 3)).reshape(-1, 3, 3)
            ok = (scr[..., 2] > 1e-2).all(1)
            scr, lvc_, stc_ = scr[ok], lvc[ok], stc[ok]
            tri, pix, bary, depth = _raster(scr, W, H)
            if len(tri) == 0:
                continue
            st = np.einsum("kc,kcd->kd", bary, stc_[tri])
            sx = np.clip(np.floor(st[:, 0]).astype(np.int64), 0, tex.width - 1)
            sy = np.clip(np.floor(st[:, 1]).astype(np.int64), 0, tex.height - 1)
            idx = tex.pixels[sy, sx]
            light = np.einsum("kc,kc->k", bary, lvc_[tri])
            col = tex.palette[idx].astype(np.float64) * light[:, None]
            keep = np.ones(len(tri), dtype=bool)
            if tex.flags & mdl.STUDIO_NF_MASKED:
                keep = idx != 255
            yield pix[keep], depth[keep], col[keep]

    # opaque: z-buffer resolve
    pix_l, dep_l, col_l = [], [], []
    for pix, dep, col in fragments(opaque):
        pix_l.append(pix)
        dep_l.append(dep)
        col_l.append(col)
    if pix_l:
        pix, dep, col = np.concatenate(pix_l), np.concatenate(dep_l), np.concatenate(col_l)
        vis = dep < zbuf[pix]
        pix, dep, col = pix[vis], dep[vis], col[vis]
        order = np.lexsort((dep, pix))
        pix, dep, col = pix[order], dep[order], col[order]
        first = np.ones(len(pix), dtype=bool)
        first[1:] = pix[1:] != pix[:-1]
        zbuf[pix[first]] = dep[first]
        frame_rgb[pix[first]] = col[first]
    # additive: depth-tested against opaque, no depth write, summed
    for pix, dep, col in fragments(additive):
        vis = dep < zbuf[pix]
        np.add.at(frame_rgb, pix[vis], col[vis])
    out = np.clip(frame_rgb, 0, 255).reshape(H, W, 3).astype(np.uint8)
    im = Image.fromarray(out, "RGB")
    if ss > 1:
        im = im.resize(size, Image.LANCZOS)
    if label:
        d = ImageDraw.Draw(im)
        d.text((6, 4), label, fill=(225, 225, 230))
    return im


def all_bounds(pm):
    lo = np.min([s["bbmin"] for s in pm.sequences], axis=0)
    hi = np.max([s["bbmax"] for s in pm.sequences], axis=0)
    return lo, hi


def contact_sheet(pm, frames=6, cell=220, skin=0, body=0, yaw=35.0, pitch=15.0, ss=2, seqs=None):
    """Grid: one row per sequence, `frames` evenly spaced frames, common framing for all cells."""
    seq_ids = list(range(len(pm.sequences))) if seqs is None else seqs
    lo, hi = all_bounds(pm)
    label_w = 150
    header = 26
    sheet = Image.new("RGB", (label_w + frames * cell, header + len(seq_ids) * cell), (24, 24, 27))
    d = ImageDraw.Draw(sheet)
    ntri = sum(len(me.tris) for bp in pm.bodyparts for m in bp.models[:1] for me in m.meshes)
    size = hi - lo
    d.text((8, 7), f"{pm.name}   {ntri} tris   size {size[0]:.0f} x {size[1]:.0f} x {size[2]:.0f}   skin {skin}",
           fill=(230, 230, 235))
    for row, si in enumerate(seq_ids):
        s = pm.sequences[si]
        nf = s["numframes"]
        loop = bool(s["flags"] & mdl.STUDIO_LOOPING)
        last = (nf - 1) if nf > 1 else 0
        if loop:
            fs = [last * i / frames for i in range(frames)]
        else:
            fs = [last * i / max(frames - 1, 1) for i in range(frames)]
        y = header + row * cell
        d.text((8, y + 8), f"{si} {s['name']}", fill=(240, 240, 240))
        d.text((8, y + 24), f"{nf} fr @ {s['fps']:g} fps", fill=(170, 170, 175))
        d.text((8, y + 38), ("loop" if loop else "once") + f"  act {s['activity']}", fill=(170, 170, 175))
        lm = s["linearmovement"]
        if any(lm):
            d.text((8, y + 52), f"move {lm[0]:.1f},{lm[1]:.1f},{lm[2]:.1f}", fill=(170, 170, 175))
        if s["events"]:
            d.text((8, y + 66), "ev " + ",".join(str(e.frame) for e in s["events"][:6]), fill=(170, 170, 175))
        for col, f in enumerate(fs):
            fr = min(f, nf - 1)
            im = render_frame(pm, si, fr, skin=skin, body=body, yaw=yaw, pitch=pitch, size=(cell, cell), ss=ss,
                              bounds=(lo, hi), label=f"f{fr:.1f}")
            sheet.paste(im, (label_w + col * cell, y))
    return sheet


def views_sheet(pm, seq=0, frame=0.0, cell=300, skin=0, ss=2):
    """Reference views of one pose: front, 3/4 front, side, back, 3/4 back, top."""
    lo, hi = all_bounds(pm)
    views = [("front", 0, 8), ("3/4", 35, 15), ("side", 90, 5), ("back", 180, 10), ("3/4 back", 215, 20),
             ("top", 0, 85)]
    sheet = Image.new("RGB", (cell * 3, cell * 2), (24, 24, 27))
    for i, (name, yaw, pitch) in enumerate(views):
        im = render_frame(pm, seq, frame, skin=skin, yaw=yaw, pitch=pitch, size=(cell, cell), ss=ss, bounds=(lo, hi),
                          label=name)
        sheet.paste(im, ((i % 3) * cell, (i // 3) * cell))
    return sheet


def main(argv=None):
    ap = argparse.ArgumentParser(description="Render a GoldSrc .mdl to PNG")
    ap.add_argument("mdl")
    ap.add_argument("out")
    ap.add_argument("--seq", default="0")
    ap.add_argument("--frame", type=float, default=0.0)
    ap.add_argument("--skin", type=int, default=0)
    ap.add_argument("--body", type=int, default=0)
    ap.add_argument("--yaw", type=float, default=35.0)
    ap.add_argument("--pitch", type=float, default=15.0)
    ap.add_argument("--dist", type=float, default=None)
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--ss", type=int, default=2)
    ap.add_argument("--sheet", action="store_true")
    ap.add_argument("--views", action="store_true")
    ap.add_argument("--frames", type=int, default=6)
    ap.add_argument("--cell", type=int, default=220)
    ap.add_argument("--summary", action="store_true", help="print the model summary")
    ap.add_argument("--viewmodel", action="store_true",
                    help="first-person view: camera at the origin looking +x, 4:3, horizontal fov 90 as in game, no grid")
    ap.add_argument("--fov", type=float, default=None)
    a = ap.parse_args(argv)
    with open(a.mdl, "rb") as f:
        pm = mdl.read(f.read())
    if a.summary:
        print(mdl.summary(pm))
    if a.sheet:
        im = contact_sheet(pm, frames=a.frames, cell=a.cell, skin=a.skin, body=a.body, yaw=a.yaw, pitch=a.pitch,
                           ss=a.ss)
    elif a.views:
        im = views_sheet(pm, skin=a.skin, cell=a.cell if a.cell != 220 else 300, ss=a.ss)
    else:
        seq = int(a.seq) if a.seq.isdigit() else a.seq
        if a.viewmodel:
            im = render_frame(pm, seq, a.frame, skin=a.skin, body=a.body, size=(a.size * 4 // 3, a.size), ss=a.ss,
                              eye=(0, 0, 0), target=(1, 0, 0), fov=a.fov or 90.0, grid=False,
                              label=f"{a.seq} f{a.frame:g} (view model)")
            im.save(a.out, optimize=True)
            print(a.out)
            return
        im = render_frame(pm, seq, a.frame, skin=a.skin, body=a.body, yaw=a.yaw, pitch=a.pitch, dist=a.dist,
                          size=(a.size, a.size), ss=a.ss, label=f"{a.seq} f{a.frame:g}", bounds=all_bounds(pm),
                          fov=a.fov or 38.0)
    im.save(a.out, optimize=True)
    print(a.out)


if __name__ == "__main__":
    main()
