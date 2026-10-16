"""Tiny example creature built through the whole pipeline (not packed into the archive).

A round capsule creature with 3 bones (root, body, head), two feet, ears, eyes and cheeks;
sequences idle (loop) and walk (loop, hops forward with linear movement).

    python3 -I tools/goldsrc/assets/example.py /tmp/orthros-scratch/hs7/renders/example
      -> example.mdl, example.png (contact sheet), example_views.png
"""
import os
import sys

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from assets import builder, mdl, rig as R, sdf, texture as T  # noqa: E402
else:
    from . import builder, mdl, rig as R, sdf, texture as T

BODY = T.rgb("#5fb8e8")
BELLY = T.rgb("#f3ead2")
EAR_TIP = T.rgb("#2b2f55")
CHEEK = T.rgb("#ff6f7d")
FOOT = T.rgb("#3d84b8")


def make_rig():
    rig = R.Rig()
    rig.add("root", None, (0, 0, 0))
    rig.add("body", "root", (0, 0, 7), tail=(0, 0, 16))
    rig.add("head", "body", (0.5, 0, 15), tail=(1, 0, 26))
    return rig


def shapes():
    body = sdf.ellipsoid((0, 0, 10), (6.5, 6.0, 7.0))
    head = sdf.sphere((1.0, 0, 19.5), 6.0)
    ear = sdf.rounded_cone((-0.5, 3.2, 24.0), (-1.5, 6.5, 29.5), 1.6, 0.5).mirror_y()
    head = head.smooth_union(ear, 1.0)
    feet = sdf.ellipsoid((1.5, 3.0, 1.6), (3.0, 2.0, 1.6)).mirror_y()
    return body, head, feet


def build(out_path=None):
    rig = make_rig()
    body, head, feet = shapes()
    whole = sdf.union(body, head, feet, k=1.0)

    def paint_body(P, N, skin):
        c = T.fill(P, BODY)
        belly = T.ellipse(P, (6, 0, 9), (3.0, 4.5, 5.5), soft=0.25)
        c = T.mix(c, BELLY, belly)
        return T.shade(c, N, ao=T.ambient_occlusion(whole, P, N, dist=2.5), shadow_tint="#7070b0")

    def paint_head(P, N, skin):
        c = T.fill(P, BODY)
        c = T.mix(c, EAR_TIP, T.halfspace(P, (0, 0, 27.0), (0, 0, 1), soft=0.3))
        for side in (1, -1):
            col, m = T.eye(P, (5.6, 2.3 * side, 20.5), (1, 0.35 * side, 0), (1.1, 1.5), soft=0.12)
            c = T.mix(c, col, m)
            c = T.mix(c, CHEEK, T.spot(P, (4.6, 4.3 * side, 17.6), 1.3, soft=0.3))
        # a smile: the lower half of a ring extruded along x (so it follows the curved face)
        ring = sdf.torus((6.5, 0, 17.8), 0.8, 0.2, axis=(1, 0, 0)).stretch((30, 1, 1), center=(6.5, 0, 17.8))
        mouth = T.sdf_mask(ring & sdf.halfspace((0, 0, 17.8), (0, 0, 1)), P, soft=0.12) * (P[:, 0] > 4)
        c = T.mix(c, "#3a1820", mouth)
        return T.shade(c, N, ao=T.ambient_occlusion(whole, P, N, dist=2.5), shadow_tint="#7070b0")

    def paint_feet(P, N, skin):
        return T.shade(T.fill(P, FOOT), N, ao=T.ambient_occlusion(whole, P, N, dist=2.0))

    b = builder.ModelBuilder("pokemon/example.mdl", rig)
    b.group("main", size=(256, 256))
    b.add(builder.Part("body", body, bone="body", paint=paint_body, budget=500))
    b.add(builder.Part("head", head, bone="head", paint=paint_head, budget=700, density=1.6, hitgroup=1))
    b.add(builder.Part("feet", feet, bone="root", paint=paint_feet, budget=160))

    def idle(t):
        p = R.Pose()
        br = R.breathe(t)
        p.move("body", z=0.25 * br)
        p.rot("body", y=1.5 * br)
        p.rot("head", z=6 * R.wave(t, phase=0.1), y=-2 * br)
        return p

    def walk(t):
        p = R.Pose()
        hop = abs(R.wave(t, freq=2))
        p.move("body", z=1.6 * hop)
        p.rot("body", x=5 * R.wave(t), y=4)
        p.rot("head", x=-4 * R.wave(t, phase=-0.08), y=-3)
        return p

    b.add_sequence(R.make_sequence(rig, "idle", idle, frames=30, fps=15, loop=True, activity=mdl.ACT["IDLE"]))
    b.add_sequence(R.make_sequence(rig, "walk", walk, frames=20, fps=20, loop=True, activity=mdl.ACT["WALK"],
                                   linear=24.0))
    b.attachment("mouth", "head", (7.0, 0, 18))
    data = b.write(out_path)
    return data


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "/tmp/orthros-scratch/hs7/renders/example"
    os.makedirs(os.path.dirname(base), exist_ok=True)
    data = build(base + ".mdl")
    from assets import render  # noqa: E402
    pm = mdl.read(data)
    print(mdl.summary(pm))
    render.contact_sheet(pm, frames=5, cell=200).save(base + ".png")
    render.views_sheet(pm, cell=260).save(base + "_views.png")
    print(base + ".png", base + "_views.png")


if __name__ == "__main__":
    main()
