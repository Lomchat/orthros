"""Signed distance fields for modelling: primitives, smooth booleans and domain transforms.

An SDF is a callable on points (N, 3) -> distances (N,), negative inside, carrying a conservative
axis-aligned bounding box (lo, hi) used by the mesher.  Units are GoldSrc units (~1 inch);
+x forward, +y left, +z up.

    body = ellipsoid((0, 0, 14), (9, 8, 11))
    head = sphere((2, 0, 27), 8).smooth_union(body, 3)
    ear = rounded_cone((0, 4, 33), (0, 9, 44), 2.2, 0.6)
    shape = head | ear.mirror_y()            # union (| is a hard union, see smooth_union)
    shape = shape - sphere((9, 0, 27), 1.5)  # subtract

Combinators: union(a, b, ..., k=0), subtract(a, b, k=0), intersect(a, b, k=0), and the operators
a | b, a & b, a - b.  k > 0 blends smoothly over about k units.
Transforms: .translate(v), .rotate(x=, y=, z=) (degrees, engine euler order), .rotate_axis(axis, deg),
.scale(s) (uniform), .stretch((sx, sy, sz)) (approximate), .mirror_y() (symmetric copy across y=0),
.mirror(axis), .round(r), .shell(t), .displace(fn, amplitude), .twist(deg_per_unit, axis),
.bend(deg_per_unit, ...).
"""
import math

import numpy as np

from . import xform


class SDF:
    def __init__(self, f, lo, hi):
        self.f = f
        self.lo = np.asarray(lo, dtype=np.float64)
        self.hi = np.asarray(hi, dtype=np.float64)

    def __call__(self, p):
        p = np.asarray(p, dtype=np.float64)
        if p.ndim == 1:
            return self.f(p[None])[0]
        return self.f(p)

    # booleans -------------------------------------------------------------------------------
    def __or__(self, other):
        return union(self, other)

    def __and__(self, other):
        return intersect(self, other)

    def __sub__(self, other):
        return subtract(self, other)

    def smooth_union(self, other, k):
        return union(self, other, k=k)

    def smooth_subtract(self, other, k):
        return subtract(self, other, k=k)

    def smooth_intersect(self, other, k):
        return intersect(self, other, k=k)

    # transforms ----------------------------------------------------------------------------
    def translate(self, v):
        v = np.asarray(v, dtype=np.float64)
        f = self.f
        return SDF(lambda p: f(p - v), self.lo + v, self.hi + v)

    def rotate(self, x=0.0, y=0.0, z=0.0, center=(0.0, 0.0, 0.0)):
        """Rotate by engine euler angles in degrees about `center`."""
        return self.transform(xform.rot_deg(x, y, z), center)

    def rotate_axis(self, axis, deg, center=(0.0, 0.0, 0.0)):
        return self.transform(xform.axis_angle_matrix(axis, deg), center)

    def transform(self, R, center=(0.0, 0.0, 0.0)):
        """Apply rotation matrix R about center (shape point x maps to R (x - c) + c)."""
        R = np.asarray(R, dtype=np.float64)
        c = np.asarray(center, dtype=np.float64)
        f = self.f
        corners = _corners(self.lo, self.hi)
        moved = (corners - c) @ R.T + c
        return SDF(lambda p: f((p - c) @ R + c), moved.min(0), moved.max(0))

    def scale(self, s, center=(0.0, 0.0, 0.0)):
        c = np.asarray(center, dtype=np.float64)
        f = self.f
        lo, hi = (self.lo - c) * s + c, (self.hi - c) * s + c
        return SDF(lambda p: f((p - c) / s + c) * s, np.minimum(lo, hi), np.maximum(lo, hi))

    def stretch(self, factors, center=(0.0, 0.0, 0.0)):
        """Non-uniform scale (distance is approximate: scaled by the smallest factor)."""
        fa = np.asarray(factors, dtype=np.float64)
        c = np.asarray(center, dtype=np.float64)
        f = self.f
        m = float(np.min(np.abs(fa)))
        lo, hi = (self.lo - c) * fa + c, (self.hi - c) * fa + c
        return SDF(lambda p: f((p - c) / fa + c) * m, np.minimum(lo, hi), np.maximum(lo, hi))

    def mirror(self, axis=1, keep_original=True):
        """Symmetric copy across the plane axis = 0 (|p[axis]| folding), the usual left/right mirror."""
        f = self.f

        def g(p):
            if keep_original:
                return np.minimum(f(p), f(_flip(p, axis)))
            q = p.copy()
            q[:, axis] = np.abs(q[:, axis])
            return f(q)

        lo, hi = self.lo.copy(), self.hi.copy()
        m = max(abs(lo[axis]), abs(hi[axis]))
        lo2, hi2 = lo.copy(), hi.copy()
        lo2[axis], hi2[axis] = -hi[axis], -lo[axis]
        return SDF(g, np.minimum(lo, lo2), np.maximum(hi, hi2))

    def mirror_y(self):
        return self.mirror(1)

    def flip(self, axis=1):
        """Mirror image only (p[axis] -> -p[axis])."""
        f = self.f
        lo, hi = self.lo.copy(), self.hi.copy()
        lo[axis], hi[axis] = -self.hi[axis], -self.lo[axis]
        return SDF(lambda p: f(_flip(p, axis)), lo, hi)

    def round(self, r):
        f = self.f
        return SDF(lambda p: f(p) - r, self.lo - r, self.hi + r)

    def shell(self, t):
        f = self.f
        return SDF(lambda p: np.abs(f(p)) - t, self.lo - t, self.hi + t)

    def displace(self, fn, amplitude):
        """Add fn(p) (bounded by |amplitude|) to the distance: bumps, scales, ridges."""
        f = self.f
        a = abs(float(amplitude))
        return SDF(lambda p: f(p) + fn(p), self.lo - a, self.hi + a)

    def twist(self, deg_per_unit, axis=2, center=(0.0, 0.0, 0.0)):
        f = self.f
        c = np.asarray(center, dtype=np.float64)
        ax = axis

        def g(p):
            q = p - c
            ang = np.radians(deg_per_unit) * q[:, ax]
            i, j = [k for k in range(3) if k != ax]
            cs, sn = np.cos(-ang), np.sin(-ang)
            r = q.copy()
            r[:, i] = cs * q[:, i] - sn * q[:, j]
            r[:, j] = sn * q[:, i] + cs * q[:, j]
            return f(r + c) * 0.9

        rad = np.max(np.abs(np.concatenate([self.lo - c, self.hi - c])))
        lo, hi = self.lo.copy(), self.hi.copy()
        for k in range(3):
            if k != ax:
                lo[k], hi[k] = c[k] - rad, c[k] + rad
        return SDF(g, lo, hi)

    def bend(self, deg_per_unit, along=0, toward=2, center=(0.0, 0.0, 0.0), margin=None):
        """Bend the shape: points at distance d along `along` are rotated by d * deg_per_unit in the
        (along, toward) plane about `center` (approximate distance)."""
        f = self.f
        c = np.asarray(center, dtype=np.float64)

        def g(p):
            q = p - c
            ang = -np.radians(deg_per_unit) * q[:, along]
            cs, sn = np.cos(ang), np.sin(ang)
            r = q.copy()
            r[:, along] = cs * q[:, along] - sn * q[:, toward]
            r[:, toward] = sn * q[:, along] + cs * q[:, toward]
            return f(r + c) * 0.8

        ext = np.max(np.abs(np.concatenate([self.lo - c, self.hi - c])))
        m = ext if margin is None else margin
        return SDF(g, np.minimum(self.lo, c - m), np.maximum(self.hi, c + m))

    def with_bounds(self, lo, hi):
        return SDF(self.f, lo, hi)

    def gradient(self, p, eps=1e-3):
        """Numerical gradient (N, 3)."""
        p = np.asarray(p, dtype=np.float64)
        g = np.empty_like(p)
        for k in range(3):
            d = np.zeros(3)
            d[k] = eps
            g[:, k] = (self.f(p + d) - self.f(p - d)) / (2 * eps)
        return g

    def normal(self, p, eps=1e-3):
        g = self.gradient(p, eps)
        n = np.linalg.norm(g, axis=1, keepdims=True)
        return g / np.maximum(n, 1e-12)


def _flip(p, axis):
    q = p.copy()
    q[:, axis] = -q[:, axis]
    return q


def _corners(lo, hi):
    return np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])


def _length(v):
    return np.sqrt(np.sum(v * v, axis=-1))


# ---------------------------------------------------------------------------------------------
# primitives
# ---------------------------------------------------------------------------------------------

def sphere(center, r):
    c = np.asarray(center, dtype=np.float64)
    return SDF(lambda p: _length(p - c) - r, c - r, c + r)


def ellipsoid(center, radii):
    """Ellipsoid with semi-axes radii (approximate but well-behaved distance)."""
    c = np.asarray(center, dtype=np.float64)
    r = np.asarray(radii, dtype=np.float64)

    def f(p):
        q = p - c
        k0 = _length(q / r)
        k1 = _length(q / (r * r))
        return np.where(k1 > 1e-12, k0 * (k0 - 1.0) / np.maximum(k1, 1e-12), -np.min(r))

    return SDF(f, c - r, c + r)


def capsule(a, b, r):
    return rounded_cone(a, b, r, r)


def rounded_cone(a, b, ra, rb):
    """Exact distance to the convex hull of sphere(a, ra) and sphere(b, rb)."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    ba = b - a
    l2 = float(ba @ ba)
    if l2 < 1e-12:
        return sphere(a, max(ra, rb))
    rr = ra - rb
    a2 = l2 - rr * rr
    if a2 <= 1e-9:  # one sphere contains the other
        return sphere(a, ra) if ra >= rb else sphere(b, rb)
    il2 = 1.0 / l2

    def f(p):
        pa = p - a
        y = pa @ ba
        z = y - l2
        xv = pa * l2 - np.outer(y, ba)
        x2 = np.sum(xv * xv, axis=1)
        y2 = y * y * l2
        z2 = z * z * l2
        k = math.copysign(1.0, rr) * rr * rr * x2
        out = np.empty(len(p))
        m1 = (np.sign(z) * a2 * z2) > k
        m2 = (~m1) & ((np.sign(y) * a2 * y2) < k)
        m3 = ~(m1 | m2)
        out[m1] = np.sqrt(x2[m1] + z2[m1]) * il2 - rb
        out[m2] = np.sqrt(x2[m2] + y2[m2]) * il2 - ra
        out[m3] = (np.sqrt(x2[m3] * a2 * il2) + y[m3] * rr) * il2 - ra
        return out

    lo = np.minimum(a - ra, b - rb)
    hi = np.maximum(a + ra, b + rb)
    return SDF(f, lo, hi)


def rounded_box(center, half, radius=0.0, rotation=(0.0, 0.0, 0.0)):
    """Box of half-extents `half` with rounded edges (radius inside the half extents)."""
    c = np.asarray(center, dtype=np.float64)
    h = np.asarray(half, dtype=np.float64) - radius

    def f(p):
        q = np.abs(p) - h
        return _length(np.maximum(q, 0.0)) + np.minimum(np.max(q, axis=1), 0.0) - radius

    s = SDF(f, -(h + radius), h + radius)
    if any(rotation):
        s = s.rotate(*rotation)
    return s.translate(c)


def torus(center, major, minor, axis=(0.0, 0.0, 1.0)):
    """Torus around `axis` through `center`."""
    c = np.asarray(center, dtype=np.float64)
    ax = np.asarray(axis, dtype=np.float64)
    ax = ax / np.linalg.norm(ax)

    def f(p):
        q = p - c
        h = q @ ax
        radial = _length(q - np.outer(h, ax))
        return np.sqrt((radial - major) ** 2 + h * h) - minor

    e = major + minor
    return SDF(f, c - e, c + e)


def cylinder(a, b, r, round_r=0.0):
    """Capped cylinder between points a and b (optionally rounded edges)."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    ba = b - a
    L = float(np.linalg.norm(ba))
    ax = ba / L
    mid = (a + b) / 2
    rr = r - round_r
    hh = L / 2 - round_r

    def f(p):
        q = p - mid
        h = q @ ax
        radial = _length(q - np.outer(h, ax))
        d = np.stack([radial - rr, np.abs(h) - hh], axis=1)
        return np.minimum(np.max(d, axis=1), 0.0) + _length(np.maximum(d, 0.0)) - round_r

    e = r + L / 2
    return SDF(f, mid - e, mid + e)


def halfspace(point, normal, extent=200.0):
    """Everything behind the plane (normal points outside). Use with intersect / subtract."""
    p0 = np.asarray(point, dtype=np.float64)
    n = np.asarray(normal, dtype=np.float64)
    n = n / np.linalg.norm(n)
    return SDF(lambda p: (p - p0) @ n, p0 - extent, p0 + extent)


def tube(points, radii):
    """Smooth chain of rounded cones through points with per-point radii (tails, necks, horns)."""
    parts = [rounded_cone(points[i], points[i + 1], radii[i], radii[i + 1]) for i in range(len(points) - 1)]
    return union(*parts)


# ---------------------------------------------------------------------------------------------
# booleans
# ---------------------------------------------------------------------------------------------

def _smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def _smax(a, b, k):
    return -_smin(-a, -b, k)


def union(*sdfs, k=0.0):
    sdfs = [s for s in sdfs if s is not None]
    if len(sdfs) == 1:
        return sdfs[0]
    fs = [s.f for s in sdfs]

    def f(p):
        d = fs[0](p)
        for g in fs[1:]:
            d = _smin(d, g(p), k)
        return d

    lo = np.min([s.lo for s in sdfs], axis=0) - k * 0.25
    hi = np.max([s.hi for s in sdfs], axis=0) + k * 0.25
    return SDF(f, lo, hi)


def subtract(a, b, k=0.0):
    fa, fb = a.f, b.f
    return SDF(lambda p: _smax(fa(p), -fb(p), k), a.lo, a.hi)


def intersect(a, b, k=0.0):
    fa, fb = a.f, b.f
    return SDF(lambda p: _smax(fa(p), fb(p), k), np.maximum(a.lo, b.lo), np.minimum(a.hi, b.hi))


def blend(a, b, t):
    """Linear morph between two SDFs."""
    fa, fb = a.f, b.f
    return SDF(lambda p: fa(p) * (1 - t) + fb(p) * t, np.minimum(a.lo, b.lo), np.maximum(a.hi, b.hi))
