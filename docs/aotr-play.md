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
