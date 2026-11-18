# Age of the Ring in play: the scenarios' start position, pacing, long sessions (2026-11-12)

What the Age of the Ring (aotr-10) skirmish scenarios measure, why their play anchor used to wait for minutes, and
what a long skirmish costs in frame time and guest address space on the current build (Node, `tools/bench/startbench.mjs`;
a few checks in headless Chrome).

## The 400-draw anchor and the start position

Every AotR play scenario (tools/scenarios/bench/learn-aotr-skirmish.txt, the warm job's learn session, and the A/B
scenarios built on it: fixes-aotr-play.txt, aotr-hot-ab.txt, aotr-nest-ab.txt, aotr-tier2-ab.txt) starts a skirmish on
the default map (Harlindon, 3 start positions) and waits for `waitframe:400,100000` — the first frames with 400 draws
or more — before its play phase. Until now the player's start position was left to the game, which draws it at random.

Measured (Node, real clock, one run per position, the marker clicked on the map preview after the `setup` mark):

| start position (map preview, 1024x768) | load screen → play anchor | draws per frame at the anchor |
|---|---|---|
| top (508,258) | 15 s | 660 |
| left (500,297) | **344 s** | 530 (after 5.5 min under 400 at ~28 fps) |
| right (542,289) | 13 s | 1 380 |

From the left marker the camera opens on a part of the map that renders fewer than 400 draws per frame: the game runs
normally (28 fps, 80 G guest instructions in the wait) but the anchor waits until something enters the view, minutes
later, and the play phase then measures another game state (10-15 fps, other work per frame). That is the "400-draw
anchor flake" of docs/jit-code-shape.md, docs/miles-mp3.md and docs/render-worker.md: not the emulator, not the build —
the random start position (the research plan's 7 earlier runs: the stalls, ~467 s, all from one position, never
from the two others).

The scenarios now click the right-hand marker (542,289) after the `setup` mark, then PLAY 3 s later than before. Checked:

- Node, learn-aotr-skirmish.txt as committed, 6 runs in a row: play anchor 13-14 s after the load screen in all six
  (1 351-1 602 draws per frame), 0 stalls; their first 20 s of play 23.2-24.5 fps.
- Chrome (headless, SwiftShader): the setup screen shows the player's "1" on the right marker (the tooltip "Start
  Position for player 1"), play anchored 18 s after the load screen at 1 638 draws per frame; the in-game minimap shows
  the camera at the east of the map.

Earlier play numbers of these scenarios mixed the three positions; the right-hand one is a heavier scene (1 350-1 600
draws per frame against 660 from the top), so play measured from now on is not comparable with the old runs' play.
Changing learn-aotr-skirmish.txt changes its content hash: the live server's warm job learns the aotr-skirmish session
again once (src/server/warm-jobs.js).

## Pacing in play: is fps under 30 while the work is under 25 ms?

Node, real clock, the fixed start position, three 15-minute skirmishes (alone against Death March, alone against
Peasant, with a Death March ally against Death March; `--gfx backend` with the 177 learned programs), phases of 5 min
from the play anchor. Work = guest + api + draw + jit (docs/frame-accounting.md; Node has no `late` from timer
clamping and no event-loop `task`: its waits are Atomics, measured as `wait`, their lateness in `[hostwait]`).

| phase (3 runs) | fps | frame p50 / p90 / p99 ms | mean work ms (guest / api / draw / jit) | mean wait ms | late wake-ups ms/frame |
|---|---|---|---|---|---|
| play 0-5 min (bases, first units) | 28.9 / 29.1 / 29.0 | 33.2-33.3 / 36.9-37.8 / 48.6-56.1 | 24.6 / 24.0 / 24.4 (16.3-17.0 / 3.6-3.8 / 3.4-3.5 / 0.4) | 9.8-10.2 | 0.16-0.18 |
| 5-10 min (armies, the first battles) | 26.5 / 27.0 / 25.0 | 34.1-36.1 / 46.9-52.4 / 63.3-74.0 | 34.1 / 32.2 / 36.4 (23.1-26.1 / 5.1-5.9 / 4.0-4.4 / ≤ 0.5) | 3.4-4.6 | 0.10-0.13 |

Answer: no pacing loss. In the first five minutes the mean work is under 25 ms and the game runs at 29 fps, one frame
per second under its own limiter: ~3 200 of the ~4 000 frames over 33 ms are paced (work under 33.4 ms: the limiter's
wait ending at 33.3-34 ms), the rest carry more than 33 ms of work (work p90 30.8-33.6 ms, the first play frame
2.1-2.2 s of guest work and translation); host wake-ups cost 0.16-0.18 ms per frame. Once the armies meet, the work
itself is over 33 ms (p50 30-36 ms) and the frame waits only 3-5 ms: the game is bound by guest work (70-75 % of the
slow frames' excess), not by its pacing. So no pacing change was made (the +10 % gate was not engaged); the lever is
the guest's code (docs/jit-code-shape.md). The owner's one AotR session in the telemetry (2026-11-10, an older
build, RTX 4050) was bound elsewhere: GPU 40 ms per frame, a fence backlog of 45 ms, 21 fps — not reproducible here.

## GPU programs after play starts

Chrome (headless, SwiftShader; a copy of the live learned data): the 177 learned programs are compiled ahead in the
render worker before play; in 150 s of play no program was built at a draw (HUD `prog=0/0ms`), none took 100 ms
(`d3d-webgl: program built in` never logged), the `prog` category 0.1-0.2 ms per frame. Node (`--gfx backend`, the
same learned list): programs built at a draw because no learned one matched, 6-7 in the first 7 min of play, 17-22
by the end of the 13-15-minute skirmishes (the battles' units and effects): the learned list does not cover a long game
yet. A session that builds them sends them to the server (`programCache.learned`), so they are compiled ahead for the
next players once someone has played that far; nothing to change in the code.

## Long play: the guest address space (gate not reached: 60 min)

The owner's session of 2026-11-10 stopped after 38 min of skirmish when the 2 GiB guest space ran out
(docs/address-space.md; D119 moved the small Direct3D resources into a shared heap). Long play was not re-validated
since. `startbench --mem <s>` now prints, every <s> seconds, a `[vmem]` line for the machine the run follows (with
`--child`, the game): reserved MiB, the largest free run, the reservations by tag, the resource heap, and `no room`, the
allocations since the start that found no hole (VirtualAlloc, HeapAlloc, a resource's memory: what the guest sees as
ERROR_NOT_ENOUGH_MEMORY or E_OUTOFMEMORY); the `[mem]` line has the draws per frame since the last line (play 1 000-2 300,
the pause menu and the score screen 98-100) and, with `--gfx backend --programs`, the programs built at a draw.

Eight Node sessions (real clock, the fixed start position; tools/scenarios/aotr-endurance.txt and its earlier forms):

| session | play reached | reserved MiB: play start → max → end | largest free run MiB (min) | no room |
|---|---|---|---|---|
| alone vs Death March | 13 min, then the defeat (score screen) | 1 015 → 1 026 → 1 025 | 955 | 0 |
| alone vs Peasant | 15 min, defeat | 1 015 → 1 031 → 1 026 | 954 | 0 |
| ally Death March vs Death March | 14 min, defeat | 1 015 → 1 024 → 1 024 | 956 | 0 |
| the same, restart from the pause menu at 10 min | 10 + 7 min (two games) | 1 015 → 1 024, 1 013 after the restart → 1 019 | 955 | 0 |
| the same, restart loops (3 runs) | 10-14 min each (the restart failed) | 1 015 → 1 028-1 031 | 954-959 | 0 |

All the play ran with battles from the 5th minute (the armies' units and buildings streamed in: 136-140 G guest
instructions per 5 min against 85 G before). In every session the reservation grows by 9-16 MiB in the first 10 min of
play, while the battles bring new units' models and textures, then stays within ±5 MiB; a restart gives back what the
game had taken (1 024 → 1 013 MiB). Peak 1 031 MiB (the gate: ≤ 1 536), the largest free run never under 954 MiB,
growth ≤ 16 MiB per 10 min (gate ≤ 50), no allocation without room. What is not validated: 60 minutes of continuous play.
A scripted player who does nothing loses his fortress after 13-15 min against any AI (the file reads show the dwarven
fortress's damaged models `dbfortress_d1/_d2`, then `scorescreenmusic.mp3`), and the score screen's button did not answer
a click in Node; the pause menu's RESTART loop (aotr-endurance.txt) restarted the skirmish in one run of four (its
menu runs at 1-3 fps in Node, and a click that comes while it slides in is lost or lands on the next button). The
next step for a 60-minute check is a player who defends (build orders through the command bar), or a browser run on a
machine fast enough to play it.

## Shadows at StaticGameLOD High: R32F shadow maps (2026-11-17)

The owner plays at `StaticGameLOD = High` (his Options.ini: Resolution 800 600, IdealStaticGameLOD VeryLow), whose
entry in Age of the Ring's GameLOD.ini turns `UseShadowMapping` on (Medium, the scenarios' profile build/saves/aotr-10:
off; shadow volumes and decals are off at High). The engine (game.dat, RotWK's) keeps depth in a color render target:
it asks D3DXCreateTexture for R32F render-target textures (game.dat 0x47d419, 1024x1024 here; a second one under a
flag at 0x47d47e), with a D24S8 depth surface; its creation helper (0x51dac0) gives no texture when the format was refused by
the CheckDeviceFormat survey of every format at start-up. The pass writes z/w as color (`_CreateShadowMap`: `mov oC0,
t0.x`), shadow.fxo dilates it (`_ShadowMapPostProcess`, max of 5 taps), and the receivers compare 4 taps against z - 0.002
(terrain.fxo): it needs float precision — 8 bits per channel would show as acne crawling with the camera.

Orthros did not offer R32F (nor D3DX create it): no shadow map was ever made and High rendered without any shadow
(SwiftShader frames of 2026-11-17: no shadow under the tower, the trees, the units). The Direct3D 9 layer now offers the
floating-point formats (R16F, G16R16F, A16B16G16R16F, R32F, G32R32F, A32B32G32R32F) as 2D and cube textures and render
targets, D3DX creates them when asked without image data, and the WebGL backend stores them as RGBA16F / RGBA32F
(EXT_color_buffer_float to render into them; missing channels read 1 as in Direct3D, kept by a write mask; uploads,
readbacks and captures convert — since the same evening with their own channels instead, R32F as GL R32F, the missing
channels' 1s supplied by the programs that sample them: docs/render-worker.md section 12). With it the game creates its 1024x1024 R32F map and renders shadows (tower, trees,
units), stable: on the frames grabbed every frame (ORTHROS_FRAME_GRAB) after a device loss and Reset, a static camera
changes 0.00-0.06 % of the pixels between frames and 0.000-0.001 % flicker (A-B-A), a scroll gives the same A-B-A share
(1.8-1.9 %: perspective motion of textures) as without shadows. Cost: draws per frame in play ~880-950 → ~1 060-1 190
(the shadow casters drawn again into the map, SwiftShader runs, same start position).

The owner's flicker itself (2026-11-17, RTX 4050, ANGLE D3D11, build of 11-13) was not reproduced on SwiftShader with his
settings — static camera, scroll, mouse moves over the map, deactivation / Reset / reactivation (`--bg pause` since
background play, docs/game-frame.md): no frame alternates
(the probe's metric on those frames: 0 % static, 0.11-0.14 % while scrolling, with or without the shadows) — and in
that build no shadow map existed at all. Not reached by the scripted runs: placing a building (the dwarf selected at the
start is no builder; its command bar has Stop and Extinguish Fire only). The frames' flicker and WebGL errors are now
measured on players' GPUs (src/gfx/flicker-probe.js, docs/real-machine-bench.md "Flicker").

Review of the float formats (same day): CheckDeviceFormat answers the `D3DUSAGE_QUERY_*` bits of a float format as
Orthros renders it (no vertex texture fetch, no sRGB; the 32-bit formats neither filtered nor blended — the WebGL
extensions that allow it are not on every player's GPU; a draw that blends into an RGBA32F target without
EXT_float_blend is drawn unblended, WebGL would refuse it); StretchRect between a float and a fixed-point target is a
blit both ways, on the threaded and the render-worker paths alike (before: an error on one, nothing copied on the
other); ColorFill converts the color into the float format; D3DX reads, writes, converts and filters float surfaces
(in floats between float formats); a float level's missing channels are set to 1 by a clear of those channels only, so
texels uploaded before it becomes a target stay. The game's survey asks no QUERY bit (every format number as a
texture, usage 0 and render target): it still takes R32F and creates its 1024x1024 map, the shadows drawn and stable
(frames grabbed at the start position: 0.00-0.04 % of the pixels changed between frames, 0.000-0.002 % A-B-A; the
flicker probe, every sample logged, 0.000-0.005 % on static frames).

Cost of the shadow maps (SwiftShader, the owner's profile, `learn-aotr-skirmish`'s start then 20 s of static camera, a
6 s scroll, 18 s static; one browser at a time through the slot script, main against this branch):

| phase (AotR 10, 800x600) | main (no shadow map) | with the R32F shadow map |
|---|---|---|
| static camera, rendered (2 pairs) | 7.5-7.6 fps, worker 24.8-25.0 ms/frame, 432-433 draws/frame | 5.6-6.1 fps, 33.3-33.9 ms/frame, 646-649 draws/frame |
| scroll, rendered | 4.8-5.1 fps, 40.0-43.2 ms/frame, 817-865 draws/frame | 3.9-4.0 fps, 48.3-50.0 ms/frame, 1 017-1 031 draws/frame |
| static after the scroll, rendered | 4.8-4.9 fps, 32.6-33.7 ms/frame, 879-889 draws/frame | 4.2 fps, 37.7-41.6 ms/frame, 1 061-1 062 draws/frame |
| static camera, `--gl-discard` (1 pair) | 25.5 fps, 22.3 ms/frame | 20.5 fps, 28.2 ms/frame |
| static after the scroll, `--gl-discard` | 14.2 fps, 33.6 ms/frame | 10.5 fps, 44.3 ms/frame |
| RotWK 2.02 at High (its skirmish start, 1 pair): static, rendered | 7.9 fps, 22.5 ms/frame, 199 draws/frame | 6.3 fps, 29.4 ms/frame, 334 draws/frame |
| RotWK 2.02: static after the scroll, rendered | 6.5 fps, 18.8 ms/frame, 304 draws/frame | 5.0 fps, 24.1 ms/frame, 470 draws/frame |

The game's High setting costs what it costs on Windows: the casters drawn a second time into the 1024x1024 map
(+180 to +215 draws per frame, +20 to +50 %; RotWK +135 to +165, +45 to +70 %), so the emulator's worker spends 5-10 ms
more per frame on them (`--gl-discard`: the CPU side alone, one pair, the run with the map under a higher machine load)
and SwiftShader's GPU process 12-28 % more CPU per frame; on a real GPU the depth pass into a 1024x1024 R32F target is
small, the CPU side stays. It is the owner's choice of High (fidelity): Medium or lower has no shadow map.

Position code of the multi-pass techniques (the hypothesis for the owner's flicker: a second pass drawn with another
vertex shader, LESSEQUAL and no depth write — terrain.fxo `Default_M` P1 — z-fighting when the two programs do not
compute the same position bit for bit): `node tools/dev/fx-position-check.mjs <Shaders.big>` lists, for every
technique with several passes, the instructions oPos depends on in each pass's vertex shaders and the GLSL the
translator emits for them. RotWK's and BFME II's Shaders.big (Age of the Ring uses RotWK's): terrain `Default_M` (the
five `VSDefaultM0_Array` shaders of P0 and P1's own), riverwater `Default_L` and normalmapped `Default` (ten shader
variants, rigid and skinned, the same in both passes) — in each, every pass computes the position with the same
instructions (terrain and riverwater: `mad t0, v0.xyzx, K.xxxy, K.yyyx` then four `dp4` with c0-c3, only the register
of the local constant (1, 0) differing — folded exactly: x * 1 + 0 = x, x * 0 + 1 = 1), the translator emits the same
GLSL statements in the same order for them, and every generated vertex shader (Direct3D 9, Direct3D 8, fixed function)
declares `invariant gl_Position`. Nothing to make canonical in the translator; whether ANGLE's D3D11 back end and the driver keep that invariance across two programs
whose other code differs could only be checked on the owner's GPU (the flicker probe's `alt` samples and their blocks
would show it).

## The owner's flicker of 2026-11-17 afternoon: objects that alternate, still open (2026-11-17)

His evidence (build a5a7614, RTX 4050, ANGLE D3D11, 2560x1440, French; session z4c413il; `data/proof/aotr-owner-2026-11-17/`):
a 16 s screen recording (2244x1242, 488 frames at 30 per second), his screenshots and three flicker-probe samples. The
game ran at ~12 fps, so each of its frames shows 2-3 times in the recording: a triple of consecutive recording frames
always holds a duplicate and cannot show an A-B-A; the measure below takes the game's distinct frames (a recording
frame kept when it differs from the last kept one), at full resolution.

- **Real alternation, on this build (after 2c7d27f), not explained yet.** Camera still, recording frames 3-12: the small
  rocks at the foot of the big rock (x 1790-1890, y 895-980) are drawn only every other game frame (the region's
  luminance 77.9, 74.0, 77.8, 73.9, 77.6, 74.0; present in frame 6, absent in 7, present in 9); triples of distinct
  frames 5-6-7 0.14 % of the pixels A-B-A, 7-9-10 0.39 % for 0.50 % changed, 9-10-11 0.18 % — the alternation is most of
  what changes. Frames 34, 36-37 and 43, as the camera comes to rest: shrub shadows (black blobs) appear for a single
  frame (x 420-500, y 720-780: 79.3, 74.5, 79.4 on 42-43-44; 0.25 % A-B-A for 0.35 % changed, ~7 000 pixels in several
  patches). That fits his "everything flickers as soon as I move or build, shadows and all". The first analysis of
  this recording (consecutive recording frames, a 374x207 copy, full resolution on frames 85-180 only) missed it and
  concluded wrongly that no frame alternates. Crops and masks: `data/proof/aotr-owner-2026-11-17/review/` (the
  review's `crop-rock-7.png`, `crop-shrub-42.png`, `aba-7-9-10.png`, `aba-42-43-44.png`, its `out.txt` per frame and
  triple, `aba.py`). Hypotheses still open: the dynamic vertex buffers (DISCARD / NOOVERWRITE) or the render worker's
  copies on write when the GPU keeps up, a stale R32F shadow map target, the reuse of static frames.
- **Calm stretches**: recording frames 45-70 and 86-178 (the camera at rest): no distinct-frame triple over 0.02 % A-B-A
  (most 0.0001-0.0009 %, the video's compression). Frames 26-44 and 82-90 are the end of the camera's moves (0.4-9.6 %
  of the pixels change per frame).
- **The large dark region with a soft curved edge** is fixed to the ground, not to the frames: it enters the screen as
  the camera scrolls south (frames 13-24; the luminance of the lower right goes 73 → 33 step by step with the scroll) and
  leaves as it scrolls back north (71-79, 33 → 74); its edge moves with the rock and the trees beside it frame after
  frame, and at the same camera position it is the same before and after (73-74 north, 33-37 south). Inside it the
  trees still cast their shadows. It is the game's fog of war: the ground outside the sight of the player's units and
  buildings darkened, the soft round edge their sight radius. At the D112 camera height (x1.5) far more of it is in
  view than at the game's own maximum; the contact sheets' 2 frames per second made the camera's back-and-forth look
  like a toggle. The same region appears in SwiftShader at max zoom (below).
- **The probe's samples**: the 2560x1440 one (2.46 % A-B-A, 21.5 % changed) was a scroll — the same rule on his
  recording's scroll frames gives 2.0-2.8 % A-B-A and 18-29 % changed, spread over the whole terrain, a clean scroll
  (textures, shadows and the fog in place from frame to frame). The two 800x600 ones (1.25 % and 1.20 %, 13-18 %
  changed, 24 fps, 2 draws per frame, black bars above and below) were the intro movie. The probe's first version
  counted a scroll's chance A-B-A as flicker; it missed the rocks (a sample every 10 s, 3 frames).
- **The black band at the top** where the terrain stops (objects beyond it still drawn) follows the camera: the
  camera's far clip plane, which the D112 height pushes the top of the screen beyond (docs/sage-camera-patch.md "The
  black band at the top of the screen"), not a flicker. Seen here too: right after a wheel zoom-out to the maximum the top 21 % of a 1280x960
  frame stays black while the camera does not move, and the first frame of a scroll fills it (grabbed frames 1086 →
  1087 below).

His report of 11-13 predates this morning's 2c7d27f: at High the shaders sampled the shadow map's stage, which had no
texture then (no R32F), and GL sampled whatever texture an earlier draw had left on that unit — a value that changes
with what the camera shows. Plausibly part of that report; the alternation above is on the build after it.

**Reproduction attempts** (SwiftShader, his options: StaticGameLOD High, 1280x960 — a 4:3 mode the scenario's menu clicks fit —,
`learn-aotr-skirmish`'s start, six wheel steps of 3 notches out to the D112 maximum, 15 s static, 6 s scroll south, 15 s
static, 6 s scroll east; 10-14 consecutive frames grabbed in each stretch, `ORTHROS_FLICKER=2`). Render worker
(`?glworker=1`, his path), 41 triples of consecutive frames: 24 static, 0.010-0.125 % changed, 0.001-0.009 % A-B-A,
0.0000-0.0016 % A-B-A with still surroundings (single pixels of swaying foliage); 17 in scrolls, 18-37 % changed,
1.7-2.2 % A-B-A all over the terrain while the camera moves, 0.0000-0.0005 % still — the frames show the scroll and,
at the edges of the player's sight, the same soft dark fog, nothing alternating. That run's render worker lagged (the
software rasterizer): the textures the game writes by rectangles while frames that read them were still pending went
through its copies on write (130-134 per scroll phase), without a wrong frame. A render worker that keeps up, as on the
owner's GPU: `?glworker=compare-worker` with `ORTHROS_COMPARE_EVERY=2` and `ORTHROS_RENDER_SCALE=0.25` (a quarter of the
pixels each way: the replay no longer lags, no copy on write needed in any phase) — the in-thread backend presents, the
recorded work is replayed in a render worker, and both back buffers are compared pixel for pixel every second frame:
380 frames from the menu to the end of both scrolls, 0 differing. So neither the timing of the render worker against
the emulator (lagging or caught up) nor its path against the in-thread one changes a pixel here — which does not rule
out an alternation both paths share (the Direct3D 9 layer, the R32F target, dynamic buffers); no building and no such
rocks were in view in these runs; the in-thread frames of
that run (42 triples) give the same picture (static 0.000-0.017 % A-B-A, scrolls up to 1.7 %, still ≤ 0.0013 %; in game
the probe itself, at the 320x240 scaled size: a scroll 1.38 % A-B-A, 0.0000 % flickering).

**What changed**: the probe (src/gfx/flicker-probe.js, docs/real-machine-bench.md "Flicker") now counts as flicker an
A-B-A pixel whose surroundings are the same in the first and third frames (12 points at 4-8 pixels, scaled with the
width), and flags, logs and reports that (`still`, `max`, `over1`, `alt`, the logged `mask`); the raw A-B-A stays in the
summary as `aba`. On the frames above: scrolls 1.7-2.8 % → 0.0000-0.0005 %, a 4x4 patch alternating in a still picture
still 16 pixels in its block. What the still rule cannot see — something alternating while the camera moves a little,
like the shrub shadows above — is counted apart (`abaAlt`: A-B-A anywhere at least half of what changed, a scroll's
being ~10 %) and logged with the blocks where pixels went A-B-A. The owner's next samples tell a real alternation from a
scroll; a sample every 10 s can still miss a short one.

**For the owner, an A/B in two URLs** (each a whole session; the probe's summary and samples land in the telemetry):
- `https://orthros.chalco.website/?manifest=aotr-10&glworker=0` — the Direct3D work rendered on the emulator's thread,
  no render worker (`docs/render-worker.md`);
- `https://orthros.chalco.website/?manifest=aotr-10&dbg=ORTHROS_FLOAT_RT=0` — Direct3D 9 without the floating-point
  formats (`floatFormat`, src/win32/d3d8.js: CheckDeviceFormat, CreateTexture and D3DX refuse them, as before 2c7d27f):
  at High no shadow map is made (checked in Node: the survey answers "not available" for formats 111-116 and no 1024x1024
  R32F texture is created). A machine debug flag: such a session takes no shared snapshot made without it.

**His answer, the same evening** (build 5e73c77): "exactly the same" with both URLs. The probe caught it in that day's
telemetry: session 2r71m0d3 (render worker, ~596 draws per frame) 13.1 % of the pixels flickering, an oval in the
middle of the screen; 6ik891rf (`glworker=0`, ~574 draws) 72 % — nearly the whole frame alternating between two
pictures; c2d62qjh (`ORTHROS_FLOAT_RT=0`, ~465 draws) 0.23 %, perhaps another scene. So the two consecutive frames
differ on his GPU only: something undefined or implementation-dependent in what Orthros asks of WebGL / ANGLE D3D11,
or a per-frame alternation of the game's own rendering (ping-pong targets, every-other-frame updates) that goes wrong
there. **To tell which**: his next session's first strong flicker is captured once (src/gfx/flicker-capture.js,
docs/real-machine-bench.md "Flicker capture"): three consecutive frames as pictures, the GL work of each — passes,
targets, draws with their programs, textures, states, uniforms, GL errors — compared pass by pass, and his WebGL
context. `node tools/dev/flicker-capture.mjs /var/lib/orthros/telemetry/telemetry-<date>.jsonl --session <id> --out <dir>`
reads it: the pass that differs in frames 1-2 and 2-3 but not in 1-3 is the one that alternates.

**When the probe sees nothing** (2026-11-18: the owner's "tons of flicker" in play and in the pause menu while his
samples found the back buffer still, ≤ 0.34 %): the frame's "Signaler un problème d'affichage" button / Ctrl+Shift+F
(docs/game-frame.md "Report a display problem") records 2 s of every presented back buffer and of what the page's
canvases held at every rAF, at the moment he sees it. `tools/dev/flicker-report.mjs` then says whether the back
buffers alternate (an intermittent fault the 10 s samples missed, or another period than A-B-A: A-B-B-A), or the
screen shows what no back buffer had or goes back to an older one (the presentation: the canvas hand-off, the page's
layers, CSS) — or neither (past the page: the compositor or the display).

## Other GL implementations, the pause menu and the frame's work (2026-11-17 evening, still open)

**The owner's evening samples** (build 5e73c77, RTX 4050, ANGLE D3D11, 2560x1440): the two large ones — 13.1 % still
A-B-A in a round patch at the centre (session 2r71m0d3, render worker) and 72 % of the whole frame (6ik891rf,
`glworker=0`) — were both taken **with the pause menu open**, a few seconds after the skirmish loaded: the `lum` picture
shows its dark panel (~800x780 at the centre) and the six buttons, which themselves did not alternate (holes in the
mask). The `ORTHROS_FLOAT_RT=0` session's sample (c2d62qjh, 0.23 %, small patches) was in play, another view: the three
URLs compared different screens, so that A/B neither clears nor convicts the R32F shadow map.

**Other rasterizers than SwiftShader on this server** (no GPU; Mesa 25.2.8 is installed): ANGLE on Vulkan with Mesa's
lavapipe — `tools/headless.mjs --gl vulkan` (`--use-angle=vulkan`, the lavapipe ICD; renderer "ANGLE (Mesa, Vulkan
1.4.318 (llvmpipe (LLVM 20.1.2 256 bits)))") — and ANGLE on OpenGL ES with Mesa's llvmpipe (`--gl gl-egl`; "ANGLE (Mesa,
llvmpipe (LLVM 20.1.2 256 bits), OpenGL ES 3.2)"); `--use-angle=gl` and `--use-gl=egl` fall back to SwiftShader. Runs on
lavapipe (the owner's options, 1600x1200 — 4:3, the scenario's menu clicks fit —, `learn-aotr-skirmish`'s start,
`ORTHROS_FLICKER=2`, consecutive frames grabbed; 1.2-1.8 fps):

| stretch | frames compared | changed between frames | A-B-A |
|---|---|---|---|
| play, camera still, render worker | 3 + 8 | 22-23 % of the pixels differ (units, trees, water) | 0.00-0.03 % |
| pause menu (Escape held 2 s), render worker | 8 | 0.8-2.7 % | 0.00 % |
| the same, the guest clock slowed 20x (`ORTHROS_TIME_SCALE=0.05`, a debug switch of the hunt branch not merged: the game sees ~30 fps, as on the owner's GPU) | 8 | 0.6 % | 0.00 % |
| play, that fast clock | 8 | 19-23 % | 0.00 % |
| pause menu, in-thread backend (`--glworker 0`), slow then fast clock | 4 + 8 | 0.6-2.7 % | 0.00 % |

**The frame's work** (`dbg:ORTHROS_CAPTURE_FRAMES=2` then `capture`: two consecutive frames, in play and in the pause
menu, both paths): the same in every captured frame, pause or play — the R32F shadow map (1024x1024, its own 1024x1024
depth surface) cleared then ~209 draws and four border lines; a 512x512 target (the water reflection, with the main
depth surface) cleared then ~500 draws; the back buffer cleared (color, depth, stencil) then ~390-410 draws; the glow:
256x256 #10 cleared, #12 cleared, 4 draws #10 → #12 and 4 #12 → #10, composited; the portrait (its viewport's depth and
stencil cleared); the interface (stencil cleared). Every target is cleared before it is drawn into or sampled in the
frame, none is sampled while it is the target, nothing reads what an earlier frame left in it — the pause menu draws the
whole scene again every frame (434 effect passes per frame in the API trace), it does not rely on the back buffer's
contents. With every target cleared, a frame's picture is a function of that frame's commands alone.
**Occlusion queries**: the game made no IDirect3DQuery9 call in 13 traced frames; and Orthros' queries never ask GL
(`GetData` answers S_OK at once, an occlusion count of at least 1: always visible), so no answer can depend on when a GPU
finishes. **WebGL errors**: none on the owner's sessions (`glErrors` 0: the probe reads `getError` every 10 s there).

So the alternation the owner sees is either commands that alternate on his machine only (not seen with his frame rate
simulated) or two pictures from the same commands on his GPU. **To tell them apart**, the flicker probe now records each
sampled frame's command signature (src/gfx/d3d8-webgl.js `sigMix`, made for the sampled frames only: every draw's
program, render target and depth surface, primitive type and count, the stages' textures, the vertex streams' and index
buffer's resources, a hash of the raster states, viewport and scissor; every clear and blit — not a draw's start or base
vertex, which SAGE's dynamic vertex ring moves every frame, nor upload sizes or constants) and its log line says
`commands same`, `aba` or `differ` with the three values; the summary counts the `alt` samples whose three signatures
are equal (`altSame`: the same commands as far as the signature sees — the alternation then comes from what it leaves
out, buffer or texture contents and constants, or from the GPU; not a proof of a GPU fault) and those whose commands
went A-B-A too (`altCmdAba`: the game's frames, or Orthros' translation of them). His next pause menu answers it, with
the session's capture (`docs/real-machine-bench.md` "Flicker capture") for the rest.

**The signature checked on still screens** (2026-11-17 night): the first version mixed each draw's start and the
frame's upload sizes in, which change every frame in AotR whatever the picture (its vertex ring advances); the signature
now leaves them out (above). Headless Chromium, SwiftShader, a fresh profile at 1024x768, `--dbg ORTHROS_FLICKER=2`
(every sample logged, one every 10 s), learn-aotr-skirmish.txt's steps:

| screen (path) | samples | commands | pictures |
|---|---|---|---|
| main menu (render worker) | 11 | **same 11/11** (one signature throughout) | changed 0.0000 % in all |
| pause menu, opened by Escape (`key:27`) 30 s into the skirmish (render worker) | 13 | **same 12/12** once it was up; the first, a few seconds after it opened, `differ` (three signatures, the third the steady one) with an unchanged picture | changed 0.0000 % in all |
| play, still camera (render worker; `in-thread`: `--glworker 0`) | 12; 6 | same 9; 3 — the others `differ`, never `aba`: X/Y/Y or X/X/Y, the scene's draws changing once | changed 0.01-0.06 % (animated details) |
| the same three, `dbg:ORTHROS_FAKE_FLICKER=3` (every 3rd draw of every other frame skipped) | 6; 5; 4 | **aba 6/6; 5/5; 4/4** | 39-89 % A-B-A |
| the profile dialog (its text caret blinks) | 7 | `differ` while the caret blinked, same otherwise | 0-0.01 % |

With the fake flicker the session's capture followed each time (240-277 KB after its cuts, frames 1-3 39-90 % A-B-A on
its pictures, `commands aba` in its trigger), made in 5.5-7.4 s after its frames, in 22-33 slices — never in a
present —: in the pause menu (render worker) 145 ms of work in all, the longest slice 17.8 ms (6 of 28 over 8 ms), in
the two play runs (an earlier step of the code: the size check in one task) 23.6-25.8 ms, wall times on this server's
4-core browser slot that SwiftShader keeps busy (330 ms of rendering per frame). Finer steps came after these runs
(the pairing's own loops, 3 ms slices): in Node, unloaded, the longest slice of a record with a 4 000-draw pass is
9 ms, its single steps 6 ms at most. (Escape held 3 s with
`keydown`/`keyup` opened no menu: the samples of that run's "pause" were play.) Reproduce:
`tools/with-browser-slot.sh node tools/headless.mjs aotr-10 --games-dir <catalog> --coords 1024x768 --dbg
ORTHROS_FLICKER=2 --input-file <learn-aotr-skirmish.txt's steps to the play anchor, then 30:key:27> --control <file>`,
then `dbg:ORTHROS_FAKE_FLICKER=3` written to the control file.

**Fixed on the way** (generic, not the cause here — the game clears depth and stencil at the start of each frame): the
back buffers of a flipping chain (D3DSWAPEFFECT_FLIP with two back buffers: AotR's `swap 2` with BackBufferCount 2) each had their own depth-stencil, rotated with their color at every Present; Direct3D 9's depth surface is not part
of the chain — the back buffers now share one (`attachDepth`, tests/d3d-flip-depth.test.js). **Left as it is**: Direct3D
9 rotates `count + 1` buffers (the front buffer is in the queue), Orthros `count` (a single back buffer is never rotated,
two alternate); a game that redraws its frames (AotR does) cannot see it, and changing it would expose games that rely on
a single back buffer keeping its contents. **Not done**: the game's depth surface (`SetDepthStencilSurface`) is still
not what GL attaches — each color target keeps its own; AotR's reflection and glow targets use the main 1600x1200 depth
surface with a smaller viewport, which this happens to reproduce since they clear it first.

## The pause menu's veil: RotWK 2.02, the owner's display report (2026-11-18, cause still open)

**What his report shows** (session t8flwb3q: RotWK 2.02 at 1400x1050, RTX 4050 / ANGLE D3D11, render worker,
`dbg=ORTHROS_FLIP_ROTATE=0`; `node tools/dev/flicker-report.mjs <telemetry> --session t8flwb3q`): 60 back buffers at
30 fps, one command signature for all of them, and the pause menu's darkening fainter in some frames. Measured on the
pictures (each frame's scene pixels against a normal frame, away from the menu's additive disc: the veil multiplies the
scene by 1 - alpha, alpha 0.80 normally): **every third frame, in bursts every 14-17 frames** — frames 1683, 1686, 1689,
1692 | 1697, 1700, 1703 | 1714, 1717, 1720 | 1728, 1731, 1734, 1737 —, alpha falling within a burst (~0.73 → ~0.55 →
~0.32 or ~0.06), the same levels coming back exactly (1686 = 1731, 1689 = 1734, 1700 = 1714). The scene is the same
behind, the UI over it unchanged, the screen shows those back buffers.

**What the veil is** (Node runs and the game's code): a 9 x 5 grid of 45 vertices / 64 triangles covering the screen
(not a disc: the circle is the next layer's additive swirl texture), `XYZ|NORMAL|DIFFUSE`, a MANAGED vertex buffer
(usage WRITEONLY) never locked in the pause menu, vertex alpha 255, lit with a black material; alpha = vertex alpha x
TEXTUREFACTOR (stage 1 MODULATE CURRENT, TFACTOR). The game sets TEXTUREFACTOR = trunc(255 x opacity)
(lotrbfme2ep1.exe 0x5475f7..0x547693, cached at 0xdd3128); the opacity is the render object's +0x90 x +0x94 x +0x2f4
(0x549010), +0x90 copied every frame from its pivot (0x59cd70 → 0x46c695), the pivot's opacity the HLOD animation's
opacity channel at the integer frame (HTree update 0x563310: `fistp` of the float frame, 0 when not below the frame
count; channel lookup 0x563d97). The float frame (Compute_Current_Frame, 0x5a4770) advances by frame rate x (sync time
− last sync) — an unsigned millisecond difference — and, in this animation's mode (4: once, to an end frame), is clamped
at its end frame 30 (31 frames at 30 fps: the fade-in is its first ~16 frames, 0.044 → 0.8). The pause layer has its
own sync time (0x4a8a07..0x4a8a83: base + timeGetTime() − t0, a step outside [0, 100] ms — backwards included — taken as
+100 ms and the base reset; the game's sync times restored after it). Once the fade has ended no time value the game
reads can bring this frame back below 30.

**Not reproduced in Node** (tools/bench/startbench.mjs rotwk-202, rotwk-skirmish.txt's start then Escape, the real clock:
the pause menu paced at 30.2 fps, frame p50 33 ms; a `node --import` hook logging, per pause frame, the layer's draws as
the game made them and as they reach GL through a shadow of the no-op WebGL context):
| run | pause frames | the veil (guest) | the veil (GL) |
|---|---|---|---|
| 1024x768, in-thread backend | 880 | vertex alpha 255 x 45, TEXTUREFACTOR 0xcc000000 in every frame after the fade-in (0x0b 0x28 0x50 0x7b 0xa3 0xc0 0xcc), material unchanged, buffer never locked | same program, uniforms (u_tfactor 0.8), vertex bytes, indices, raster state in every frame (only the FLIP chain's framebuffer rotates) |
| 1400x1050, the render worker's recording replayed in-thread (inline), mouse moved over the menu every 0.4 s | 997 | the same | the same |
| 1024x768, host stalls (95 x 20 ms, frame p99 89 ms) | 798 | the same; animation frame 30 throughout | — |
The two other layer draws (additive swirl, inscription) change only by their texture matrices (a scroll; lost on this
build: the texture-transform padding fix 15f9729 is not on main). The time the game read per frame: timeGetTime 50-85
times and QueryPerformanceCounter 3-5 times on the main thread (their JIT fast paths off for the count), 1 ms steps,
never backwards nor repeated, both from the same clock; the frame limiter's Sleep(0) 50-80 times. So neither the game's
own vertex alpha nor Orthros' uploads (no ring, no stale buffer: nothing is written) move the veil here; the game's
clock cannot either (above). His levels are the opacity channel's own values at earlier animation frames (0.044 at
frame 0, 0.315 near frame 4, 0.756 near 13) — or a TEXTUREFACTOR coming from elsewhere: open.

**To tell them apart on his machine**: the display report now carries, per back buffer, a values record beside the
command signature (d3d8-webgl.js `valDraw`: `vsig`, a hash of the color values the draws read — TEXTUREFACTOR, material,
ambient, alpha reference, fog —, and `tf`, the draws whose TEXTUREFACTOR changed since the previous frame, with both
values; flicker-report.mjs prints them). In his next pause report, a dip frame whose `tf` names the veil's draw
(0xcc000000 → a lower value) is the game's (or the emulator's) value — the animation frame to follow up —; a dip frame
with the same `vsig` is GL's work on the same commands and values. Checked on the game in Node (every frame signed,
1400x1050, in-thread backend): one values signature over 850 still pause frames, and the fade-in's frames named — the
veil's draw (#298 of ~300) 0x0b → 0x28 → 0x50 → 0x7b → 0xa3 → 0xc0 → 0xcc, the two other layers after it. (`tf` compares
draws by index: a frame with another number of draws shows the shifted ones too.)
