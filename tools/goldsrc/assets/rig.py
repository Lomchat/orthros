"""Skeletons, poses, inverse kinematics and animation helpers.

Bones are declared by their REST head position in model space (+x forward, +y left, +z up, origin on
the ground).  Rest rotations are identity, so every bone's local axes are the model axes in the rest
pose: rotating bone "head" by y=+20 pitches it nose-down, z=+20 turns it to its left, x=+20 rolls
its left side up (engine euler order, degrees in this module).

    rig = Rig()
    rig.add("root", None, (0, 0, 0))
    rig.add("pelvis", "root", (0, 0, 12))
    rig.add("spine", "pelvis", (0, 0, 16))
    rig.add("head", "spine", (1, 0, 24), tail=(1, 0, 32))
    rig.add("thigh_l", "pelvis", (0, 4, 11)); rig.add("shin_l", "thigh_l", (1, 4, 6)); rig.add("foot_l", "shin_l", (0, 4, 1.5))

    def idle(t):                    # t in [0, 1]
        p = Pose()
        p.rot("spine", y=2 * wave(t))          # breathing
        p.move("pelvis", z=0.3 * wave(t, phase=0.25))
        return p

    seq = make_sequence(rig, "idle", idle, frames=30, fps=15, loop=True, activity=mdl.ACT["IDLE"])
"""
import math

import numpy as np

from . import mdl, xform


class RigBone:
    def __init__(self, name, parent, head, tail):
        self.name = name
        self.parent = parent
        self.head = np.asarray(head, dtype=np.float64)
        self.tail = None if tail is None else np.asarray(tail, dtype=np.float64)


class Rig:
    def __init__(self):
        self.bones = []
        self._index = {}

    def add(self, name, parent, head, tail=None):
        if name in self._index:
            raise ValueError(f"duplicate bone {name}")
        if len(name) >= 32:
            raise ValueError("bone names are limited to 31 characters")
        pi = -1 if parent is None else self.index(parent)
        self._index[name] = len(self.bones)
        self.bones.append(RigBone(name, pi, head, tail))
        return name

    def index(self, name):
        if isinstance(name, (int, np.integer)):
            return int(name)
        try:
            return self._index[name]
        except KeyError:
            raise KeyError(f"unknown bone {name!r}") from None

    def __len__(self):
        return len(self.bones)

    def names(self):
        return [b.name for b in self.bones]

    def children(self, name):
        i = self.index(name)
        return [b.name for b in self.bones if b.parent == i]

    def head(self, name):
        return self.bones[self.index(name)].head.copy()

    def tail(self, name):
        """Explicit tail, else the mean of the children's heads, else the head itself."""
        b = self.bones[self.index(name)]
        if b.tail is not None:
            return b.tail.copy()
        ch = [c.head for c in self.bones if c.parent == self.index(name)]
        if ch:
            return np.mean(ch, axis=0)
        return b.head.copy()

    def rest_local(self):
        pos = np.zeros((len(self.bones), 3))
        for i, b in enumerate(self.bones):
            pos[i] = b.head - (self.bones[b.parent].head if b.parent >= 0 else 0.0)
        return pos

    def mdl_bones(self):
        pos = self.rest_local()
        return [mdl.Bone(name=b.name, parent=b.parent, pos=tuple(pos[i]), rot=(0.0, 0.0, 0.0))
                for i, b in enumerate(self.bones)]

    def rest_world(self):
        """Rest matrices: identity rotations translated to the heads."""
        m = np.zeros((len(self.bones), 3, 4))
        m[:, :, :3] = np.eye(3)
        m[:, :, 3] = [b.head for b in self.bones]
        return m

    def local_arrays(self, pose):
        """Pose -> (pos (B, 3), rot radians (B, 3)) local values as stored in sequences."""
        pos = self.rest_local()
        rot = np.zeros((len(self.bones), 3))
        if pose:
            for name, v in pose.items():
                i = self.index(name)
                rot[i] = np.radians(v[:3])
                pos[i] = pos[i] + v[3:]
        return pos, rot

    def world(self, pose=None):
        """World 3x4 matrices of a pose."""
        pos, rot = self.local_arrays(pose)
        return mdl.bone_matrices(self.mdl_bones(), pos, rot)

    def skin_matrices(self, pose=None):
        """world(pose) @ inverse(rest): maps rest model-space points to posed model space."""
        w = self.world(pose)
        out = np.empty_like(w)
        for i, b in enumerate(self.bones):
            out[i, :, :3] = w[i, :, :3]
            out[i, :, 3] = w[i, :, 3] - w[i, :, :3] @ b.head
        return out

    # inverse kinematics -----------------------------------------------------------------------
    def solve_two_bone(self, pose, upper, lower, end, target, pole=(1.0, 0.0, 0.0), end_world_rot=None):
        """Set rotations of `upper` and `lower` so that `end`'s head reaches `target` (model space).

        pole: model-space direction the middle joint (knee/elbow) bends toward.
        end_world_rot: optional 3x3 world rotation for `end` (e.g. np.eye(3) keeps a foot flat).
        Existing rotations of `upper` / `lower` / `end` in the pose are replaced.
        """
        iu, il, ie = self.index(upper), self.index(lower), self.index(end)
        for n in (upper, lower, end):
            pose.set_rot(n, 0, 0, 0)
        W = self.world(pose)
        parent = self.bones[iu].parent
        Rp = W[parent][:, :3] if parent >= 0 else np.eye(3)
        A = W[iu][:, 3]
        local = self.rest_local()
        off1 = local[il] + pose.get_pos(lower)
        off2 = local[ie] + pose.get_pos(end)
        L1, L2 = np.linalg.norm(off1), np.linalg.norm(off2)
        T = np.asarray(target, dtype=np.float64)
        d = T - A
        D = np.linalg.norm(d)
        D = min(max(D, abs(L1 - L2) + 1e-4), L1 + L2 - 1e-4)
        dn = d / max(np.linalg.norm(d), 1e-9)
        T = A + dn * D
        p = np.asarray(pole, dtype=np.float64)
        p = p - dn * (p @ dn)
        if np.linalg.norm(p) < 1e-6:
            p = np.cross(dn, [0.0, 1.0, 0.0])
        p = p / np.linalg.norm(p)
        cos_a = (L1 * L1 + D * D - L2 * L2) / (2 * L1 * D)
        alpha = math.acos(max(-1.0, min(1.0, cos_a)))
        knee = A + L1 * (math.cos(alpha) * dn + math.sin(alpha) * p)
        R1 = _align(off1, Rp.T @ (knee - A))
        W1 = Rp @ R1
        R2 = _align(off2, W1.T @ (T - knee))
        pose.set_rot(upper, *np.degrees(xform.matrix_euler(R1)))
        pose.set_rot(lower, *np.degrees(xform.matrix_euler(R2)))
        if end_world_rot is not None:
            R3 = (W1 @ R2).T @ np.asarray(end_world_rot, dtype=np.float64)
            pose.set_rot(end, *np.degrees(xform.matrix_euler(R3)))
        return pose

    def aim(self, pose, bone, direction, axis=(1.0, 0.0, 0.0)):
        """Rotate `bone` so that its local `axis` points along model-space `direction`."""
        i = self.index(bone)
        pose.set_rot(bone, 0, 0, 0)
        W = self.world(pose)
        parent = self.bones[i].parent
        Rp = W[parent][:, :3] if parent >= 0 else np.eye(3)
        R = _align(np.asarray(axis, float), Rp.T @ np.asarray(direction, float))
        pose.set_rot(bone, *np.degrees(xform.matrix_euler(R)))
        return pose


def _align(a, b):
    """Minimal rotation matrix taking direction a to direction b."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(a @ b)
    s = np.linalg.norm(v)
    if s < 1e-9:
        if c > 0:
            return np.eye(3)
        perp = np.cross(a, [1.0, 0.0, 0.0])
        if np.linalg.norm(perp) < 1e-6:
            perp = np.cross(a, [0.0, 1.0, 0.0])
        return xform.axis_angle_matrix(perp, 180.0)
    return xform.axis_angle_matrix(v, math.degrees(math.atan2(s, c)))


class Pose(dict):
    """bone name -> np.array([rx, ry, rz (degrees), dx, dy, dz (offset from rest)])."""

    def _get(self, bone):
        if bone not in self:
            self[bone] = np.zeros(6)
        return self[bone]

    def rot(self, bone, x=0.0, y=0.0, z=0.0):
        """Add euler degrees to a bone's rotation."""
        v = self._get(bone)
        v[0] += x
        v[1] += y
        v[2] += z
        return self

    def set_rot(self, bone, x=0.0, y=0.0, z=0.0):
        v = self._get(bone)
        v[:3] = (x, y, z)
        return self

    def move(self, bone, x=0.0, y=0.0, z=0.0):
        """Add an offset (model units, in the parent's frame) to a bone's position."""
        v = self._get(bone)
        v[3] += x
        v[4] += y
        v[5] += z
        return self

    def get_rot(self, bone):
        return self[bone][:3].copy() if bone in self else np.zeros(3)

    def get_pos(self, bone):
        return self[bone][3:].copy() if bone in self else np.zeros(3)

    def copy(self):
        p = Pose()
        for k, v in self.items():
            p[k] = v.copy()
        return p

    def scaled(self, w):
        p = Pose()
        for k, v in self.items():
            p[k] = v * w
        return p

    def __add__(self, other):
        p = self.copy()
        for k, v in other.items():
            p[k] = p[k] + v if k in p else v.copy()
        return p


def blend(a, b, w):
    """Linear blend of two poses (w = 0 -> a, 1 -> b)."""
    keys = sorted(set(a) | set(b))
    p = Pose()
    for k in keys:
        va = a[k] if k in a else np.zeros(6)
        vb = b[k] if k in b else np.zeros(6)
        p[k] = va * (1 - w) + vb * w
    return p


# ---------------------------------------------------------------------------------------------
# easing, waves, keyframes
# ---------------------------------------------------------------------------------------------

def clamp01(x):
    return min(1.0, max(0.0, x))


def smoothstep(x):
    x = clamp01(x)
    return x * x * (3 - 2 * x)


def ease_in(x):
    x = clamp01(x)
    return x * x * x


def ease_out(x):
    x = 1 - clamp01(x)
    return 1 - x * x * x


def ease_in_out(x):
    x = clamp01(x)
    return 4 * x * x * x if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def ease_out_back(x, s=1.70158):
    x = clamp01(x) - 1
    return x * x * ((s + 1) * x + s) + 1


def ease_out_elastic(x):
    x = clamp01(x)
    if x in (0.0, 1.0):
        return x
    return 2 ** (-10 * x) * math.sin((x * 10 - 0.75) * (2 * math.pi / 3)) + 1


def ease_out_bounce(x):
    x = clamp01(x)
    n1, d1 = 7.5625, 2.75
    if x < 1 / d1:
        return n1 * x * x
    if x < 2 / d1:
        x -= 1.5 / d1
        return n1 * x * x + 0.75
    if x < 2.5 / d1:
        x -= 2.25 / d1
        return n1 * x * x + 0.9375
    x -= 2.625 / d1
    return n1 * x * x + 0.984375


def wave(t, freq=1.0, phase=0.0):
    """sin(2 pi (freq t + phase)): loops for integer freq over t in [0, 1]."""
    return math.sin(2 * math.pi * (freq * t + phase))


def window(t, t0, t1, ease=smoothstep):
    """0 before t0, 1 after t1, eased in between."""
    if t1 <= t0:
        return 1.0 if t >= t1 else 0.0
    return ease((t - t0) / (t1 - t0))


def pulse(t, t0, t1, t2, t3, ease=smoothstep):
    """0 -> 1 between t0 and t1, holds, 1 -> 0 between t2 and t3."""
    return window(t, t0, t1, ease) * (1 - window(t, t2, t3, ease))


def keys(t, keyframes, interp="cubic", loop=False, period=1.0):
    """Interpolate keyframes [(time, value), ...] at t.  Values: scalars or sequences.

    interp: "linear", "smooth" (eases in/out at every key), "cubic" (Catmull-Rom), "step".
    loop: wrap t into [0, period) and interpolate the last key back to the first.
    """
    ks = sorted(keyframes, key=lambda k: k[0])
    times = [float(k[0]) for k in ks]
    vals = [np.asarray(k[1], dtype=np.float64) for k in ks]
    scalar = vals[0].ndim == 0
    n = len(ks)
    if n == 1:
        return float(vals[0]) if scalar else vals[0].copy()
    if loop:
        t = t % period
        times_ext = [times[-1] - period] + times + [times[0] + period]
        vals_ext = [vals[-1]] + vals + [vals[0]]
    else:
        if t <= times[0]:
            return float(vals[0]) if scalar else vals[0].copy()
        if t >= times[-1]:
            return float(vals[-1]) if scalar else vals[-1].copy()
        times_ext = [times[0] - (times[1] - times[0])] + times + [times[-1] + (times[-1] - times[-2])]
        vals_ext = [vals[0]] + vals + [vals[-1]]
    i = 1
    while i < len(times_ext) - 2 and times_ext[i + 1] <= t:
        i += 1
    t0, t1 = times_ext[i], times_ext[i + 1]
    u = 0.0 if t1 <= t0 else (t - t0) / (t1 - t0)
    p0, p1, p2, p3 = vals_ext[i - 1], vals_ext[i], vals_ext[i + 1], vals_ext[min(i + 2, len(vals_ext) - 1)]
    if interp == "step":
        r = p1
    elif interp == "linear":
        r = p1 + (p2 - p1) * u
    elif interp == "smooth":
        r = p1 + (p2 - p1) * (u * u * (3 - 2 * u))
    else:
        tm0, tm3 = times_ext[i - 1], times_ext[min(i + 2, len(times_ext) - 1)]
        m1 = (p2 - p0) / max(t1 - tm0, 1e-9) * (t1 - t0)
        m2 = (p3 - p1) / max(tm3 - t0, 1e-9) * (t1 - t0)
        u2, u3 = u * u, u * u * u
        r = (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2
    return float(r) if scalar else np.asarray(r)


# ---------------------------------------------------------------------------------------------
# procedural cycles
# ---------------------------------------------------------------------------------------------

def foot_cycle(t, stride, lift, duty=0.6, phase=0.0):
    """Foot offset (dx forward, dz up) relative to its neutral position for gait phase t in [0, 1).

    Stance (fraction `duty`): planted, slides from +stride/2 to -stride/2 (the body moves over it).
    Swing: travels back to +stride/2 with an eased arc of height `lift`.
    The matching linearmovement per cycle is stride / duty.
    """
    u = (t + phase) % 1.0
    if u < duty:
        s = u / duty
        return stride * (0.5 - s), 0.0
    s = (u - duty) / (1 - duty)
    e = smoothstep(s)
    return stride * (-0.5 + e), lift * math.sin(math.pi * s) ** 0.8


def gait_linear_movement(stride, duty=0.6):
    """Distance covered per gait cycle so that planted feet do not slide."""
    return stride / duty


def walk_legs(rig, pose, t, legs, stride, lift, duty=0.6, phases=None, pole=(1.0, 0.0, 0.0),
              flat_feet=True, foot_pitch=0.0):
    """Drive leg chains with IK along foot_cycle paths.

    legs: [(upper, lower, end), ...]; their rest end positions are the neutral foot positions.
    phases: per-leg phase offsets (default biped [0, 0.5]; quadruped walk e.g. [0, 0.5, 0.25, 0.75]).
    Call it after setting body motion (bob, sway) in the pose, so the IK compensates for it.
    foot_pitch: extra toe-off pitch in degrees applied during swing (0 = keep flat).
    """
    if phases is None:
        phases = [i / len(legs) for i in range(len(legs))]
    for (upper, lower, end), ph in zip(legs, phases):
        dx, dz = foot_cycle(t, stride, lift, duty, ph)
        target = rig.head(end) + np.array([dx, 0.0, dz])
        rot = None
        if flat_feet:
            u = (t + ph) % 1.0
            pitch = 0.0
            if foot_pitch and u >= duty:
                pitch = foot_pitch * math.sin(math.pi * (u - duty) / (1 - duty))
            rot = xform.rot_deg(0, pitch, 0)
        rig.solve_two_bone(pose, upper, lower, end, target, pole=pole, end_world_rot=rot)
    return pose


def chain_wave(t, n, amp, lag=0.12, decay=1.0, freq=1.0, phase=0.0):
    """Angles for an n-bone chain (tail, ears, antenna): a travelling wave delayed along the chain.
    Loops over t in [0, 1] for integer freq.  Bone i gets amp * decay**i * sin(2 pi (freq t - i lag))."""
    return [amp * decay ** i * math.sin(2 * math.pi * (freq * t + phase - i * lag)) for i in range(n)]


def spring_follow(signal, fps, freq=3.0, damping=0.5, loop=False):
    """Damped-spring follower of a sampled signal (F,) or (F, k): secondary motion with lag/overshoot.
    loop=True runs two passes so that the result is periodic."""
    x = np.asarray(signal, dtype=np.float64)
    shape = x.shape
    x = x.reshape(len(x), -1)
    dt = 1.0 / fps
    w = 2 * math.pi * freq
    y = x[0].copy()
    v = np.zeros_like(y)
    out = np.zeros_like(x)
    passes = 2 if loop else 1
    for p in range(passes):
        for i in range(len(x)):
            for _ in range(4):  # substeps for stability
                a = w * w * (x[i] - y) - 2 * damping * w * v
                v += a * dt / 4
                y += v * dt / 4
            out[i] = y
    return out.reshape(shape)


def breathe(t, amp=1.0, freq=1.0):
    """Smooth breathing curve in [-amp, amp] (slower exhale)."""
    u = (freq * t) % 1.0
    return amp * math.sin(2 * math.pi * (u + 0.08 * math.sin(2 * math.pi * u)))


# ---------------------------------------------------------------------------------------------
# sequence assembly
# ---------------------------------------------------------------------------------------------

def make_sequence(rig, name, pose_fn, frames, fps, loop=False, activity=0, actweight=1, linear=None,
                  events=(), flags=0, motiontype=None):
    """Sample pose_fn(t) into an mdl.Sequence.

    loop=True: `frames` distinct frames; t = i / frames, plus a final frame equal to the first
    (numframes = frames + 1, the engine loops over numframes - 1 intervals).
    loop=False: numframes = frames, t = i / (frames - 1) from 0 to 1 inclusive.
    linear: distance covered per cycle along x (float) or a 3-vector -> linearmovement, STUDIO_LX.
    events: [(frame, event, options), ...] or mdl.Event objects.
    """
    nb = len(rig)
    if loop:
        ts = [i / frames for i in range(frames)]
    else:
        ts = [i / max(frames - 1, 1) for i in range(frames)]
    P = np.zeros((len(ts) + (1 if loop else 0), nb, 3))
    R = np.zeros_like(P)
    for i, t in enumerate(ts):
        P[i], R[i] = rig.local_arrays(pose_fn(t))
    if loop:
        P[-1], R[-1] = P[0], R[0]
    lm = (0.0, 0.0, 0.0)
    mt = 0
    if linear is not None:
        lm = (float(linear), 0.0, 0.0) if np.isscalar(linear) else tuple(float(x) for x in linear)
        mt = _linear_flags(lm)
    if motiontype is not None:
        mt = motiontype
    evs = []
    for e in events:
        if isinstance(e, mdl.Event):
            evs.append(e)
        else:
            evs.append(mdl.Event(frame=int(e[0]), event=int(e[1]), options=str(e[2]) if len(e) > 2 else ""))
    return mdl.Sequence(name=name, pos=P, rot=R, fps=float(fps),
                        flags=(mdl.STUDIO_LOOPING if loop else 0) | flags, activity=activity,
                        actweight=actweight if activity else 0, events=evs, motiontype=mt, linearmovement=lm)


def _linear_flags(lm):
    f = 0
    if lm[0]:
        f |= mdl.STUDIO_LX
    if lm[1]:
        f |= mdl.STUDIO_LY
    if lm[2]:
        f |= mdl.STUDIO_LZ
    return f
