"""Rotation helpers matching the GoldSrc studio code exactly.

Conventions (as in the engine's mathlib / studio_util):
  * Euler "angles" are (x, y, z) in RADIANS for bones: angles[0] rotates about X (roll),
    angles[1] about Y (pitch), angles[2] about Z (yaw).  The rotation is R = Rz(z) @ Ry(y) @ Rx(x).
  * Quaternions are (x, y, z, w).
  * 3x4 matrices: [:, :3] rotation, [:, 3] translation.
"""
import math

import numpy as np


def angle_quaternion(angles):
    """AngleQuaternion() of the engine. angles: (..., 3) radians -> (..., 4) quaternion (x, y, z, w)."""
    a = np.asarray(angles, dtype=np.float64)
    sy, cy = np.sin(a[..., 2] * 0.5), np.cos(a[..., 2] * 0.5)
    sp, cp = np.sin(a[..., 1] * 0.5), np.cos(a[..., 1] * 0.5)
    sr, cr = np.sin(a[..., 0] * 0.5), np.cos(a[..., 0] * 0.5)
    return np.stack([
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
        cr * cp * cy + sr * sp * sy,
    ], axis=-1)


def quaternion_matrix(q):
    """QuaternionMatrix() of the engine. q: (..., 4) -> (..., 3, 3)."""
    q = np.asarray(q, dtype=np.float64)
    x, y, z, w = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    m = np.empty(q.shape[:-1] + (3, 3))
    m[..., 0, 0] = 1.0 - 2.0 * y * y - 2.0 * z * z
    m[..., 1, 0] = 2.0 * x * y + 2.0 * w * z
    m[..., 2, 0] = 2.0 * x * z - 2.0 * w * y
    m[..., 0, 1] = 2.0 * x * y - 2.0 * w * z
    m[..., 1, 1] = 1.0 - 2.0 * x * x - 2.0 * z * z
    m[..., 2, 1] = 2.0 * y * z + 2.0 * w * x
    m[..., 0, 2] = 2.0 * x * z + 2.0 * w * y
    m[..., 1, 2] = 2.0 * y * z - 2.0 * w * x
    m[..., 2, 2] = 1.0 - 2.0 * x * x - 2.0 * y * y
    return m


def quaternion_slerp(p, q, t):
    """QuaternionSlerp() of the engine for one pair of quaternions (plain floats)."""
    p = [float(v) for v in p]
    q = [float(v) for v in q]
    a = sum((p[i] - q[i]) ** 2 for i in range(4))
    b = sum((p[i] + q[i]) ** 2 for i in range(4))
    if a > b:
        q = [-v for v in q]
    cosom = sum(p[i] * q[i] for i in range(4))
    if (1.0 + cosom) > 0.000001:
        if (1.0 - cosom) > 0.000001:
            omega = math.acos(max(-1.0, min(1.0, cosom)))
            sinom = math.sin(omega)
            sclp = math.sin((1.0 - t) * omega) / sinom
            sclq = math.sin(t * omega) / sinom
        else:
            sclp, sclq = 1.0 - t, t
        return [sclp * p[i] + sclq * q[i] for i in range(4)]
    qt = [-q[1], q[0], -q[3], q[2]]
    sclp = math.sin((1.0 - t) * 0.5 * math.pi)
    sclq = math.sin(t * 0.5 * math.pi)
    return [sclp * p[i] + sclq * qt[i] for i in range(3)] + [qt[3]]


def euler_matrix(angles):
    """Rotation matrix for engine euler angles (radians), (..., 3) -> (..., 3, 3)."""
    return quaternion_matrix(angle_quaternion(angles))


def matrix_euler(m):
    """Inverse of euler_matrix (returns radians (x, y, z)); valid away from gimbal lock."""
    m = np.asarray(m, dtype=np.float64)
    y = math.asin(max(-1.0, min(1.0, -m[2, 0])))
    x = math.atan2(m[2, 1], m[2, 2])
    z = math.atan2(m[1, 0], m[0, 0])
    return np.array([x, y, z])


def make_matrix(rot3, pos):
    """3x4 matrix from a 3x3 rotation and a translation."""
    m = np.zeros((3, 4))
    m[:, :3] = rot3
    m[:, 3] = pos
    return m


def concat(a, b):
    """ConcatTransforms(a, b): 3x4 @ 3x4 (b applied first)."""
    out = np.empty((3, 4))
    out[:, :3] = a[:, :3] @ b[:, :3]
    out[:, 3] = a[:, :3] @ b[:, 3] + a[:, 3]
    return out


def invert(m):
    """Inverse of a rigid 3x4 matrix."""
    out = np.empty((3, 4))
    out[:, :3] = m[:, :3].T
    out[:, 3] = -m[:, :3].T @ m[:, 3]
    return out


def transform_points(m, p):
    """Apply 3x4 matrix to points (N, 3)."""
    p = np.asarray(p, dtype=np.float64)
    return p @ m[:, :3].T + m[:, 3]


def rotate_vectors(m, v):
    """Apply the rotation part of a 3x4 matrix to vectors (N, 3)."""
    return np.asarray(v, dtype=np.float64) @ m[:, :3].T


def axis_angle_matrix(axis, deg):
    """Rotation matrix about an arbitrary axis (degrees, right-handed)."""
    a = np.asarray(axis, dtype=np.float64)
    a = a / np.linalg.norm(a)
    t = math.radians(deg)
    c, s = math.cos(t), math.sin(t)
    x, y, z = a
    return np.array([
        [c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
        [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
        [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)],
    ])


def rot_deg(x=0.0, y=0.0, z=0.0):
    """Rotation matrix from engine euler angles given in DEGREES (roll x, pitch y, yaw z)."""
    return euler_matrix(np.radians([x, y, z]))
