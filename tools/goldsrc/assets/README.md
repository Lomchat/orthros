# GoldSrc asset toolchain (`tools/goldsrc/assets/`)

Python 3 + numpy + Pillow only, written from scratch. Generates studio models (`.mdl`), sprites (`.spr`) and
sounds (`.wav`) for the GoldSrc browser ports, deterministically (same inputs, same bytes).

```
python3 -I tools/goldsrc/assets/build.py out.pk3            # every pokemon/*.py module -> deterministic zip
python3 -I tools/goldsrc/assets/build.py out.pk3 --only pikachu --render /tmp/orthros-scratch/hs7/renders
python3 -I tools/goldsrc/assets/render.py model.mdl out.png --sheet       # contact sheet of all sequences
python3 -I tools/goldsrc/assets/render.py model.mdl out.png --views       # front/3-4/side/back/top
python3 -I tools/goldsrc/assets/render.py v_x.mdl out.png --viewmodel --seq draw --frame 5
python3 -I tools/goldsrc/assets/test_mdl.py                               # tests
python3 -I tools/goldsrc/assets/example.py /tmp/orthros-scratch/hs7/renders/example
```

Modules use relative imports inside the `assets` package (`from .. import builder` in `pokemon/`);
scripts put `tools/goldsrc` on `sys.path` themselves, so `python3 -I` works from any directory.

## Conventions (all modules)

- Units: GoldSrc units (~1 inch). Axes: **+x forward (the model faces +x), +y left, +z up**, origin on the ground
  between the feet.
- Bone euler angles: engine order `(x roll, y pitch, z yaw)`, R = Rz·Ry·Rx. `mdl` uses radians, `rig.Pose` degrees.
  With identity rest rotations (the `rig` convention): `y=+20` pitches nose-down, `z=+20` turns left, `x=+20` rolls
  the left side up.
- Triangles in the API are **outward counter-clockwise**; the writer reverses them on disk (the engine culls
  GL_FRONT, as studiomdl's flipped triangles expect) and the reader reverses them back.
- Looping sequences: the last frame equals the first (the engine loops over `numframes - 1` intervals);
  `rig.make_sequence(loop=True)` does it. `linearmovement` is the distance covered per cycle.
- View models (`v_*.mdl`): the Counter-Strike client mirrors every view model across y while `cl_righthand` is 1
  (its default; `cl_dll/StudioModelRenderer.cpp`, the engine then stops culling it), like the stock CS view models:
  author them left-handed on the left of the view (`pokemon/balls.py` designs right-handed and mirrors).
  `render.py --viewmodel` shows the file as stored (mirrored); fov is horizontal (90 at 4:3 as in game).
- Determinism: no wall clock, no unseeded randomness (`np.random.default_rng(seed)`), sorted iteration.

## build.py — the archive

Each module `pokemon/<name>.py` exposes `build(out)` and fills `out[path] = bytes` with archive paths relative to
the game folder (`models/pokemon/pikachu.mdl`, `sprites/pokemon/zap.spr`, `sound/pokemon/pikachu_cry1.wav`,
`sprites/weapon_pk_pikachu.txt`, ...). `build.py` validates every `.mdl` (full reader), `.spr` and `.wav`
(mono 22050 Hz 8/16-bit), refuses path collisions between modules, writes a zip with sorted entries, fixed
dates (1980-01-01), fixed permissions and deflate level 9, and prints `size sha256 path (description)`.
With no module it writes an archive holding `pokemon_readme.txt`. Options: `--only a,b`, `-j N` (processes),
`--extract DIR`, `--render DIR` (contact sheet per model), `--list`.

```python
# pokemon/pikachu.py
from .. import builder, mdl, rig as R, sdf, texture as T, wav as W

def build(out):
    out["models/pokemon/pikachu.mdl"] = make_model()      # bytes
    out["sound/pokemon/pikachu_cry1.wav"] = W.write(cry())
```

## sdf.py — shapes

`SDF(f, lo, hi)`: callable on points `(N, 3)` -> distances `(N,)` (negative inside) with a conservative box.

| Primitive | |
|---|---|
| `sphere(c, r)`, `ellipsoid(c, radii)` | |
| `capsule(a, b, r)`, `rounded_cone(a, b, ra, rb)`, `tube(points, radii)` | limbs, tails, ears, horns |
| `rounded_box(c, half, radius, rotation=(x, y, z) deg)`, `cylinder(a, b, r, round_r)` | |
| `torus(c, major, minor, axis)`, `halfspace(point, normal)` (inside = behind the normal) | |

Booleans: `a | b`, `a & b`, `a - b`, `union(*s, k=)`, `subtract(a, b, k=)`, `intersect(a, b, k=)`,
`a.smooth_union(b, k)` (k = blend width in units; prefer smooth unions, hard creases mesh worse), `blend(a, b, t)`.
Transforms (return new SDFs): `.translate(v)`, `.rotate(x=, y=, z=, center=)` (deg), `.rotate_axis(axis, deg)`,
`.transform(R, center)`, `.scale(s)`, `.stretch((sx, sy, sz))`, `.mirror(axis=1)` / `.mirror_y()` (symmetric copy),
`.flip(axis)`, `.round(r)`, `.shell(t)`, `.displace(fn, amplitude)`, `.twist(deg_per_unit)`,
`.bend(deg_per_unit, along=0, toward=2, center=)`, `.gradient(P)`, `.normal(P)`.

```python
ear = sdf.rounded_cone((0, 4, 33), (-2, 9, 46), 2.4, 0.5).mirror_y()
head = sdf.sphere((2, 0, 26), 8).smooth_union(sdf.ellipsoid((6, 0, 23), (4, 5, 3)), 2) | ear
```

## mesh.py — meshing

- `mesh_sdf(shape, budget=800, voxel=None, smooth=2) -> TriMesh`: voxel size from the surface area and the budget
  (at least ~8 voxels across the thinnest bound), narrow-band surface nets, projection onto the surface, Taubin
  smoothing, quadric edge-collapse decimation to `budget` triangles, final projection.
- `surface_nets(shape, lo, hi, h)`, `project(m, shape, iters)`, `taubin(m, iters)`, `laplacian(m, iters, mask=)`,
  `decimate(m, target_faces)`, `crease_normals(m, crease_deg) -> (normals, corner_index)`, `weld(m, tol)`,
  `merge(meshes)`.
- `TriMesh(verts, faces)`: `.area()`, `.bounds`, `.face_normals()`, `.normals(crease)`, `.transformed(R, t)`,
  `.compact()`, `.is_closed_manifold()`. Hand-built meshes (flat wing membranes, ...) can be given to `Part(mesh=)`.

## rig.py — skeleton and animation

```python
rig = R.Rig()
rig.add("root", None, (0, 0, 0))
rig.add("pelvis", "root", (0, 0, 12))                    # rest HEAD position in model space
rig.add("spine", "pelvis", (0, 0, 16))
rig.add("head", "spine", (1, 0, 24), tail=(1, 0, 32))   # tail: segment end for nearest-bone skinning
for s, y in (("l", 4), ("r", -4)):
    rig.add(f"thigh_{s}", "pelvis", (0, y, 11)); rig.add(f"shin_{s}", f"thigh_{s}", (1, y, 6))
    rig.add(f"foot_{s}", f"shin_{s}", (0, y, 1.5))
```

- `Pose()`: `.rot(bone, x=, y=, z=)` (adds degrees), `.set_rot(...)`, `.move(bone, x=, y=, z=)` (offset in the
  parent frame), `.copy()`, `+`, `blend(a, b, w)`.
- `rig.world(pose)` (3x4 matrices), `rig.skin_matrices(pose)`, `rig.solve_two_bone(pose, upper, lower, end, target,
  pole=(1, 0, 0), end_world_rot=np.eye(3))` (IK to a model-space target), `rig.aim(pose, bone, direction)`.
- Curves: `wave(t, freq=1, phase=0)`, `breathe(t, amp)`, `keys(t, [(t0, v0), ...], interp="cubic"|"smooth"|
  "linear"|"step", loop=False)`, `window(t, t0, t1)`, `pulse(t, t0, t1, t2, t3)`, easings `smoothstep`,
  `ease_in`, `ease_out`, `ease_in_out`, `ease_out_back`, `ease_out_elastic`, `ease_out_bounce`.
- Gaits: `foot_cycle(t, stride, lift, duty=0.6, phase)`, `walk_legs(rig, pose, t, legs=[(upper, lower, end), ...],
  stride, lift, duty, phases=[0, 0.5])` (IK feet planted during stance; quadruped phases e.g. `[0, .5, .25, .75]`),
  `gait_linear_movement(stride, duty)` = the `linear=` value that keeps the planted feet from sliding.
- Secondary motion: `chain_wave(t, n, amp, lag=0.12, decay=1.0)` (tails, ears; loops), `spring_follow(signal, fps,
  freq, damping, loop)` (lag/overshoot on one-shots).
- `make_sequence(rig, name, pose_fn, frames, fps, loop=False, activity=mdl.ACT["IDLE"], actweight=1,
  linear=None, events=[(frame, event, options)])` -> `mdl.Sequence`. `pose_fn(t)` gets t in [0, 1].

```python
def walk(t):
    p = R.Pose()
    p.move("pelvis", z=-0.6 + 0.5 * R.wave(t, freq=2, phase=0.25))
    p.rot("spine", z=4 * R.wave(t))
    return R.walk_legs(rig, p, t, [("thigh_l", "shin_l", "foot_l"), ("thigh_r", "shin_r", "foot_r")],
                       stride=8, lift=2.5, duty=0.6)
seq = R.make_sequence(rig, "walk", walk, frames=24, fps=24, loop=True, activity=mdl.ACT["WALK"],
                      linear=R.gait_linear_movement(8, 0.6))
```

## texture.py — paint, UVs, palette

Paint functions: `paint(P, N, skin) -> (N, 3)` colours in [0, 1] (or `(colours, alpha)` in a masked group).
`P` are rest-pose model-space surface points, `N` unit normals; everything is analytic in 3D so eyes and
markings are crisp and continuous across parts and UV seams.

- Colours/masks: `rgb("#rrggbb")`, `fill(P, c)`, `mix(a, b, m)`, `layers(P, N, base, [(mask, colour), ...])`,
  `edge(d, soft)`, `spot(P, c, r, soft)`, `ellipse(P, c, radii, R, soft)`, `band(P, dir, lo, hi, soft)`,
  `halfspace(P, point, normal, soft)`, `sdf_mask(shape, P, soft, grow)` (stripes/patches modelled as SDFs),
  `gradient(P, dir, lo, hi, c0, c1)`, `facing(N, dir, lo, hi)`.
- `eye(P, center, direction, radii=(w, h), iris=, pupil=, sclera=, highlight=, look=(u, v), ...) -> (colour, mask)`.
- Baked shading: `ambient_occlusion(shape, P, N, dist=3, steps=5)`, `shade(colour, N, ao=, ao_strength=0.65,
  top=0.18, shadow_tint=, toon_steps=0, light=, light_amount=0)`. The engine adds its own Lambert on top, so keep
  painted lighting soft (AO + a little top light).
- UV/atlas (used by the builder): `box_charts(verts, faces)`, `pack_charts(charts, (W, H), pad=2, method="shelf"|"skyline")`
  (uniform density, per-part `density` weight, integer texel corners as the format stores them; "skyline" packs
  denser and may turn charts 90 degrees: opt in per group with `b.group(..., pack="skyline")`), `raster_texels`, `bake`, `dilate`.
- `quantize(img, 256, transparent=mask, dither=0.0) -> (indices, palette)`: median cut + k-means, deterministic,
  index 255 = transparent when a mask is given; `indexed_to_rgb(indices, palette)`.

## builder.py — complete models

```python
b = builder.ModelBuilder("pokemon/pikachu.mdl", rig, skins=1)
b.group("main", size=(512, 256))                                   # one atlas + one mesh per group
b.group("fx", size=(64, 64), flags=mdl.STUDIO_NF_ADDITIVE | mdl.STUDIO_NF_FULLBRIGHT)
b.add(builder.Part("body", body_sdf, bone="spine", paint=paint_body, budget=900))
b.add(builder.Part("head", head_sdf, bone="head", paint=paint_head, budget=1100, density=1.5, hitgroup=1))
b.add(builder.Part("tail", tail_sdf, bones=["tail1", "tail2", "tail3"], paint=paint_tail, budget=300))
for s in sequences: b.add_sequence(s)
b.attachment("attack", "head", (11, 0, 25))        # model-space rest position
b.controller("head", mdl.STUDIO_ZR, -45, 45, 0)    # optional head yaw controller 0
b.eyeposition = (0, 0, 24); b.hull = ((-12, -12, 0), (12, 12, 32))   # optional, defaults from the bounds
data = b.write()                                   # build + mdl.write + mdl.read validation
```

- `Part(name, shape=None, bone=None | bones=[...], paint=, group="main", budget=600, crease=65, smooth=2,
  density=1.0, hitgroup=0, hitbox=True, voxel=None, mesh=None, charts=None)`
  (`charts`: `box_charts` options for that part, e.g. `{"smooth_iters": 8, "min_dot": 0.2}` = fewer, larger charts). One part = one closed mesh, rigid on `bone`, or
  each vertex on the nearest bone segment of `bones`. **Overlap parts at the joints** (a limb sinks into the
  body) so no crack opens when animated.
- Skins: `skins=n` calls every paint with `skin = 0..n-1`; identical textures are stored once
  (e.g. the ball: only the band colour changes).
- Automatic: UV charts and atlas per group, texture baking + palette per (group, skin), per-mesh normal ranges,
  bodypart split when a model would exceed 2048 vertices/normals, per-sequence `bbmin/bbmax` from posing every frame,
  header bounds/eye position/hull, one hitbox per bone carrying geometry (or `b.hitbox(bone, bbmin, bbmax, group)`).
- `b.report` lists the per-part triangles, chart density and totals (also printed on stderr).

## mdl.py — the format

`Studio(name, bones, sequences, textures, bodyparts, skins, controllers, attachments, hitboxes, eyeposition, min,
max, bbmin, bbmax, flags)` with `Bone(name, parent, pos, rot)`, `BoneController`, `Attachment(bone, org, name)`,
`Hitbox(bone, bbmin, bbmax, group)`, `Event(frame, event, type, options)`, `Sequence(name, pos, rot, fps, flags,
activity, actweight, events, motiontype, motionbone, linearmovement, bbmin, bbmax)`, `Texture(name, pixels,
palette, flags)`, `BodyPart(name, models)`, `Model(name, verts, vert_bone, norms, norm_bone, meshes)`,
`Mesh(tris (n, 3, 4) = (vert, norm, s, t), skinref)`; verts/norms in their bone's rest space.

- `write(studio) -> bytes`: MDL v10, one sequence group, RLE `mstudioanimvalue_t` animations with per-bone
  per-channel scales, greedy triangle strips, normals regrouped per mesh as the engine's lighting loop needs.
- `read(bytes, strict=True) -> ParsedModel`: checks every offset, count, size, alignment, overlap, RLE run,
  strip command, vertex/normal/skin/texture index and s/t range; raises `MdlError` listing the problems.
- Exact engine decoding: `calc_rotations(pm, seq, frame, controllers)`, `setup_bones`, `pose(pm, seq, frame)`,
  `decode_sequence`, `controller_adj`; `summary(pm)`.
- Constants: `ACT["IDLE"|"WALK"|"RUN"|"RANGE_ATTACK1"|"SMALL_FLINCH"|"DIESIMPLE"|"ARM"|"VICTORY_DANCE"...]`,
  `STUDIO_LOOPING`, `STUDIO_LX`, `STUDIO_NF_FLATSHADE|CHROME|FULLBRIGHT|ADDITIVE|MASKED`, `HITGROUP_*`.

## render.py — looking at the result

`render_frame(pm, seq=0, frame=0.0, skin=0, body=0, yaw=35, pitch=15, dist=None, size=(512, 512), ss=2,
bounds=None, ambient=80, shade=120, lightvec=(-0.35, -0.45, -0.82), fov=38, eye=None, target=None, grid=True,
label=None) -> PIL.Image`, `contact_sheet(pm, frames=6, cell=220, skin=0)`, `views_sheet(pm)`.
Poses with the engine's decoding, nearest texture sampling, the engine's ambient + shade light with its
hemispherical Lambert (FLATSHADE/FULLBRIGHT honoured, MASKED index 255 cut, ADDITIVE meshes added), back faces
culled as in game, z-buffer, ground grid (8/32 units, red = +x, green = +y). Chrome is drawn as a plain texture.
Look at every model with `--sheet` and `--views` before handing it over.

## spr.py, icons.py — sprites and HUD icons

- `spr.make(images, type=spr.VP_PARALLEL, tex_format=spr.ADDITIVE, origins=None)` (RGBA arrays or PIL images,
  frames share one palette), `spr.write(frames, palette, ...)`, `spr.from_rgba(...)`, `spr.read(bytes)`,
  `spr.to_rgba(parsed, frame)`. Types `VP_PARALLEL_UPRIGHT, FACING_UPRIGHT, VP_PARALLEL, ORIENTED,
  VP_PARALLEL_ORIENTED`; formats `NORMAL, ADDITIVE` (black = nothing), `INDEXALPHA` (palette[255] colour, index =
  opacity), `ALPHTEST` (index 255 transparent).
- Engine fact for additive effect sprites (xash3d-fwgs `cl_sprite.c` → `#texgamma.pal`): every palette entry goes
  through `texgammatable` = `pow(v, texgamma / gamma)` = `pow(v, 0.8)` at the defaults (2.0 / 2.5), alpha 255, wrap
  repeat. Only an exact (0, 0, 0) entry stays black; a raw level 1 shows as 3, 2 as 5, and stacked puffs then reveal
  each frame's square. `pokemon/fx.py` therefore fades every effect frame to exact palette black (index 255) from
  85 % of the half-size outwards (radial; across u only for the tiling beam), cuts the faint tail with a
  hue-preserving floor (`_black_floor`), and checks the outside is index 255 when it writes the sprite.
- `icons.Canvas(w, h, ss=4)`: `circle`, `ellipse`, `rect`, `rounded_rect`, `polygon`, `line`, `arc`, `pie`, `star`,
  `bolt`, `glow`, `paste(canvas, x, y)`, `image()`, `rgba()`, `additive_rgb()`; colours `"#rrggbb[aa]"` or tuples.
  HUD icons are drawn additively and tinted by the client: paint white/grey shapes on transparent black.
  HL weapon `.txt` files: first line the count, then `name 640 pokemon/hud x y w h` lines
  (`weapon`, `weapon_s`, `ammo`, ...); sprite paths are relative to `sprites/` without extension.

## wav.py — sounds

`write(x, rate=22050, bits=16)`, `read(bytes)`; generators `seconds`, `osc(freq, dur, shape=sine|saw|square|
triangle|pulse|glottal)`, `glide(f0, f1, dur, "exp"|"lin"|"ease")`, `vibrato`, `noise(dur, "white"|"pink"|"brown",
seed)`; envelopes `env_points([(t, v)...], n)`, `env_adsr`, `env_exp`; filters `lowpass`, `highpass`,
`svf(x, cutoff, q, mode)` (per-sample cutoff), `bandpass`, `formants`; `voice(f0, vowels=[(t, "a"|"e"|"i"|"o"|"u"|
"ah"|"er")], breath, vibrato_=(rate, depth), formant_shift, growl)` for creature cries; effects `distort`,
`bitcrush`, `ring`, `tremolo`, `reverb(x, room, damp, wet, tail)`, `echo`, `speed`; assembly `mix((sig, start,
gain), ...)`, `concat`, `silence`, `fade`, `normalize`, `finish`.

```python
f0 = W.concat(W.glide(700, 1300, 0.18), W.glide(1300, 900, 0.3))
cry = W.voice(f0, vowels=[(0, "i"), (0.2, "a"), (0.45, "u")], vibrato_=(7, 0.03), formant_shift=1.4)
data = W.write(W.finish(W.reverb(cry, wet=0.2)))
```
