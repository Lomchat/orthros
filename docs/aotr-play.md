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
readbacks and captures convert). With it the game creates its 1024x1024 R32F map and renders shadows (tower, trees,
units), stable: on the frames grabbed every frame (ORTHROS_FRAME_GRAB) after a device loss and Reset, a static camera
changes 0.00-0.06 % of the pixels between frames and 0.000-0.001 % flicker (A-B-A), a scroll gives the same A-B-A share
(1.8-1.9 %: perspective motion of textures) as without shadows. Cost: draws per frame in play ~880-950 → ~1 060-1 190
(the shadow casters drawn again into the map, SwiftShader runs, same start position).

The owner's flicker itself (2026-11-17, RTX 4050, ANGLE D3D11, build of 11-13) was not reproduced on SwiftShader with his
settings — static camera, scroll, mouse moves over the map, deactivation / Reset / reactivation: no frame alternates
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

## The owner's flicker of 2026-11-17 afternoon: no frame alternates (2026-11-17)

His evidence (build a5a7614, RTX 4050, ANGLE D3D11, 2560x1440, French; session z4c413il; `data/proof/aotr-owner-2026-11-17/`):
a 16 s screen recording, his screenshots and three flicker-probe samples. Measured on all 488 frames of the recording
(30 frames per second: the game's ~12 fps frames each shown 2-3 times), not only on its 2-per-second contact sheets:

- **Static camera** (recording frames 24-70 and 80-180, ~5 s): no pixel alternates. With the probe's rule (A-B-A:
  |a-b| > 24, |b-c| > 24, |a-c| < 8 on 0-255) 0.000-0.005 % of the pixels per triple of consecutive frames, the mean
  difference between frames 0.1-0.4 levels (the video's compression).
- **The large dark region with a soft curved edge** is fixed to the ground, not to the frames: it enters the screen as
  the camera scrolls south (frames 13-24; the luminance of the lower right goes 73 → 33 step by step with the scroll) and
  leaves as it scrolls back north (71-79, 33 → 74); its edge moves with the rock and the trees beside it frame after
  frame, and at the same camera position it is the same before and after (73-74 north, 33-37 south). Inside it the
  trees still cast their shadows. It is the game's fog of war: the ground outside the sight of the player's units and
  buildings darkened, the soft round edge their sight radius. At the D112 camera height (x1.5) far more of it is in
  view than at the game's own maximum; the contact sheets' 2 frames per second made the camera's back-and-forth look
  like a toggle. The same region appears in SwiftShader at max zoom (below).
- **The probe's samples**: the 2560x1440 one (2.46 % A-B-A, 21.5 % changed) was a scroll — the same rule on his
  recording's consecutive scroll frames gives 2.0-2.8 % A-B-A and 18-29 % changed, spread over the whole terrain, while
  those frames show a clean scroll (textures, shadows and the fog in place from frame to frame). The two 800x600 ones
  (1.25 % and 1.20 %, 13-18 % changed, 24 fps, 2 draws per frame, black bars above and below) were the intro movie.
- **The black band at the top** where the terrain stops (objects beyond it still drawn) follows the camera: the
  terrain's own drawn area at the D112 height, not a flicker (another track). Seen here too: right after a wheel zoom-out
  to the maximum the top 21 % of a 1280x960 frame stays black while the camera does not move, and the first frame of a
  scroll fills it (grabbed frames 1086 → 1087 below).

His report of 11-13 ("everything flickers as soon as I move or build, shadows and all") predates this morning's
2c7d27f: at High the shaders sample the shadow map's stage, which had no texture then (no R32F), and GL sampled whatever
texture an earlier draw had left on that unit — a value that changes with what the camera shows. Plausibly that, not
checked on his GPU; today's recording shows no alternation.

**Reproduction** (SwiftShader, his options: StaticGameLOD High, 1280x960 — a 4:3 mode the scenario's menu clicks fit —,
`learn-aotr-skirmish`'s start, six wheel steps of 3 notches out to the D112 maximum, 15 s static, 6 s scroll south, 15 s
static, 6 s scroll east; 10-14 consecutive frames grabbed in each stretch, `ORTHROS_FLICKER=2`). Render worker
(`?glworker=1`, his path), 41 triples of consecutive frames: 24 static, 0.010-0.125 % changed, 0.001-0.009 % A-B-A,
0.0000-0.0016 % A-B-A with still surroundings (single pixels of swaying foliage); 17 in scrolls, 18-37 % changed,
1.7-2.2 % A-B-A all over the terrain while the camera moves, 0.0000-0.0005 % still — the frames show the scroll and, at the edges of the player's sight, the same soft dark fog,
nothing alternating. The textures the game writes by rectangles while frames that read them are still pending went
through the render worker's copies on write (130-134 per scroll phase) without a wrong frame.

**What changed**: the probe (src/gfx/flicker-probe.js, docs/real-machine-bench.md "Flicker") now counts as flicker an
A-B-A pixel whose surroundings are the same in the first and third frames (12 points at 4-8 pixels, scaled with the
width), and flags, logs and reports that (`still`, `max`, `over1`, `alt`, the logged `mask`); the raw A-B-A stays in the
summary as `aba`. On the frames above: scrolls 1.7-2.8 % → 0.0000-0.0005 %, a 4x4 patch alternating in a still picture
still 16 pixels in its block. The owner's next samples tell a real alternation from a scroll.

**For the owner, an A/B in two URLs** (each a whole session; the probe's summary and samples land in the telemetry):
- `https://orthros.chalco.website/?manifest=aotr-10&glworker=0` — the Direct3D work rendered on the emulator's thread,
  no render worker (`docs/render-worker.md`);
- `https://orthros.chalco.website/?manifest=aotr-10&dbg=ORTHROS_FLOAT_RT=0` — Direct3D 9 without the floating-point
  formats (`floatFormat`, src/win32/d3d8.js: CheckDeviceFormat, CreateTexture and D3DX refuse them, as before 2c7d27f):
  at High no shadow map is made (checked in Node: the survey answers "not available" for formats 111-116 and no 1024x1024
  R32F texture is created). A machine debug flag: such a session takes no shared snapshot made without it.

