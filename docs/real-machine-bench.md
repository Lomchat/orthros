# Real-machine measurements: telemetry summaries, bench links, report

This server has no GPU (headless Chromium renders with SwiftShader): what a player's machine does with Orthros — its
GPU time per frame, the frame pacing of its browser, the cost of the render worker on a laptop — can only be measured
there. This kit lets the owner (or any player) produce those measurements by opening one link, and lets us read them
from the server's telemetry.

Three parts, all generic (no game-specific code; the only per-game artifacts are the scenario files):

1. **Telemetry** of every normal session (when the server runs with `--telemetry <dir>`, as the live server does):
   the machine, the options, and every ~20 s a frame summary (`src/host/perf-summary.js`).
2. **Bench mode** of the page: `?bench=<name>` plays a scripted scenario (`tools/scenarios/bench/`) in the player's
   browser, shows a banner while it runs and a summary at the end, and sends one `bench` record with the per-phase
   results and the machine (`src/host/web/bench.js`, `src/host/scenario.js`).
3. **Report**: `tools/telemetry-report.mjs` prints per session the machine, game / version, build, options (render
   mode actually used), the stretches of play with their slow-frame categories, the summaries, the bench phases, and a
   comparison of the bench runs.

## The links (what the owner does)

Open the link in Chrome on the machine to measure, click **Start the measurement**, then do not touch the mouse or
the keyboard and keep the tab in front until the summary appears (a few minutes; a first launch in a browser first
downloads the game files and runs the game's own first-launch setup: up to ~10-15 minutes). Nothing else is needed:
the results go to the server, and the summary panel also has a **Copy the results** button.

| game | link | what it plays | usual duration |
|---|---|---|---|
| BFME II | <https://orthros.chalco.website/?bench=bfme2-skirmish> | the intro skipped, the main menu, a skirmish started (the profile name dialog filled), its first minute | ~4 min |
| BFME II 1.06 | <https://orthros.chalco.website/?bench=bfme2-skirmish&manifest=bfme2-106> | the same on version 1.06 | ~4 min |
| Vice City | <https://orthros.chalco.website/?bench=vicecity-drive> | the intro skipped, the main menu, a new game started, a drive of ~25 s | ~2 min |
| Rise of the Witch-king 2.02 | <https://orthros.chalco.website/?bench=rotwk-skirmish> (2.01: `&manifest=rotwk-201`) | the main menu, a skirmish started, its first minute with a few orders | ~4 min |
| BFME | <https://orthros.chalco.website/?bench=bfme1-skirmish> (1.03: `&manifest=bfme1-103`) | the main menu, a skirmish started, its first minute | ~6 min |
| BFME 1.08, menu | <https://orthros.chalco.website/?bench=bfme1-108-menu&gameLang=fr> | the intro skipped, one minute in the main menu, 30 s in the Solo play menu | ~3 min |
| BFME 1.08, skirmish | <https://orthros.chalco.website/?bench=bfme1-108-skirmish&gameLang=fr> | the main menu, a skirmish started, **ten minutes of play** (orders, camera scrolls): the validation target's criterion | ~15 min |
| **BFME 1.08, quick** | <https://orthros.chalco.website/?bench=bfme1-108-quick&gameLang=fr> | the main menu, a skirmish started, **two minutes of play** (orders, camera scrolls) | ~4 min |
| BFME II, quick | <https://orthros.chalco.website/?bench=bfme2-quick> | `bfme2-skirmish`'s menu steps, two minutes of play (orders, camera scrolls) | ~4 min |
| Rise of the Witch-king 2.02, quick | <https://orthros.chalco.website/?bench=rotwk-quick> (2.01: `&manifest=rotwk-201`) | `rotwk-skirmish`'s steps, two minutes of play (orders, camera scrolls) | ~4 min |

**The quick benches** (`*-quick`) are the ones to run often (after an Orthros update, on another browser or machine):
the same menu and skirmish start as the longer ones, then two minutes of play — enough for the play phase's fps, frame
p99, frames over 40 ms per minute and GPU time to compare runs, in about 4 minutes once the game files are in the
browser. `bfme1-108-quick` also shortens BFME 1.08's menu (the Start click waits for the skirmish setup screen's draws
per frame instead of fixed delays sized for a slow first launch) and reports the setup screen as its own phase
(`setup`). Their play phases are 120 s long; read them like the long ones' (below).

**The BFME 1.08 pair** measures the project's target (CLAUDE.md: a stable 30 fps, p99 frame ≤ 33 ms over 10 min of
play) on the machine that opens them, e.g. the owner's Iris Xe laptop: open the menu link first (short: checks the
setup, the first launch's downloads land here), then the skirmish link in the same browser. `&gameLang=fr` plays the
French game (drop it for English; the clicks are the same). The `play` phase of the skirmish record is the criterion:
its `fps`, `dt.p99`, `per33` / `per40`, its slow frames' categories, and the GPU time per frame (`gpu`). BFME 1.08
paces its frames at 30 per second (a frame every 33.3 ms), so a frame "> 33.4 ms" is often a present that slipped by a
fraction of a millisecond: read `per40` (a missed frame slot) next to `per33`, and `dt.p99` against 34-35 ms. The same
scenario runs here headless (`tools/scenarios/bfme1-108-phases.txt`, kept equal by `tests/bench-kit.test.js`):

```
tools/with-browser-slot.sh node tools/headless.mjs bfme1-108 --games-dir <catalog with bfme1> --profile-dir <copy of a warm profile> \
  --learn <copy of the live learned data> --gl-discard --memprefetch --seconds 1100 --stop-on "mark end:" \
  --phases out.json --input-file tools/scenarios/bfme1-108-phases.txt
node tools/startbench.mjs bfme1-108 --games-dir <catalog> --save <copy of a warm profile> --input tools/scenarios/bfme1-108-phases.txt \
  --cold --regions <learn>/regions-bfme1-108.json --heat <learn>/heat-bfme1-108.json --gfx recorder --until-api NONE --limit 1300
```

(Node: `--gfx recorder` puts the render worker's recording on the emulator thread as in the page, and the phase
reports are the page's `[frames]` reports: slow frames by category.)

Any bench runs in Node as the page plays it: `startbench --bench <name>` takes its file from `index.json` and scales
its pointer coordinates from its `coords` to the game's display (the Direct3D device's back buffer) with the page's
own `ScenarioPlayer.scale`; `--coords W,H` does the same for an `--input` file. With a profile directory seeded from
the server's canonical first-launch set (`<learn>/seedcanon-<manifest>.json`, the files of the player's language
written under `--save`) it is the page's first launch without downloads:

```
node tools/startbench.mjs bfme1-108 --games-dir <catalog> --save <seeded profile dir> --bench bfme1-108-quick --cold \
  --regions <learn>/regions-bfme1-108.json --heat <learn>/heat-bfme1-108.json --gfx recorder --until-api NONE --limit 600
```

A measurement is most useful repeated: the first one in a fresh browser (first launch: downloads, the game's setup,
nothing learned), then the same link again (files in the browser, code and shaders cached). Each run is one record.
Laptop on mains power, other heavy tabs closed; the summary flags a run during which the tab was hidden or lost the
focus (those phases are not representative).

Other options of the page still apply: `&glworker=0` (in-thread rendering instead of the render worker) makes an A/B
of the render worker on that machine; `&gameLang=fr` the game's language.

## What is measured and sent

**Machine** (`env` of the first telemetry batch, and of each bench record): `navigator.userAgent`,
`hardwareConcurrency`, `deviceMemory`, the WebGL unmasked renderer and vendor (`WEBGL_debug_renderer_info`; the masked
strings when the browser hides them), the WebGPU adapter's vendor / architecture / device / description when the
browser has an adapter (asked once, 2 s at most; `null` without WebGPU), screen size and device pixel ratio, window
size, cross-origin isolation, the served build. The options event gives the render mode chosen and the other
options; each summary gives the rendering actually used (`renderMode`: `worker`, `thread`, ...: the render worker may
fall back to the in-thread backend). Nothing else: no account, no address beyond what the server sees of any request.

**Summaries** (`event: "summary"`, every ~20 s of play, at most 720 per session, besides the existing 0.5 s samples):

| field | what |
|---|---|
| `seconds`, `frames`, `fps` | the window |
| `s33` `s40` `s50` `s100`, `per33` `per50` `per100` | frames longer than 33.4 / 40 / 50 / 100 ms, counts and per minute |
| `dt` | frame-time p50 / p90 / p99 / max (ms): from a histogram of 1 ms buckets below 100 ms (5 ms to 300, 25 ms to 1000, then 250 ms), the bucket's upper bound |
| `h` | that histogram (sparse `[bucket, count, ...]`, `src/core/frame-acct.js` `histBucket`), so windows merge |
| `work`, `cats` | mean work per frame and mean time per frame by category (docs/frame-accounting.md: `guest`, `api`, `draw`, `jit`, `prog`, `tex`, `render`, `wait`, `sleep`, `late`...) |
| `slowCats`, `worst` | the slow frames' categories summed (ms); the worst frame [ms, work ms, categories] |
| `drawsPerFrame`, `d3dFrames` | Direct3D draw calls per presented Direct3D frame |
| `glCalls` | WebGL calls (and GL draw calls) per frame, counted over a window of 30 frames every 20 s in bench runs only (`{state: 'off'}` in ordinary sessions: swapping the context prototype's methods makes V8 drop code optimized against them; `?dbg=ORTHROS_GL_COUNT=1` forces it); `{state: 'unavailable'}` where not measured |
| `gpu` | GPU time per frame: `mean`, `p50`, `p90`, `p99`, `max` (ms), `over33`, `frames` timed, `disjoint` results dropped, `h`; `{state: 'unavailable'}` without `EXT_disjoint_timer_query_webgl2`, `{state: 'none'}` without a Direct3D device (or with the probes off) |
| `render` | render worker: the emulator's waits for it (`waitMs`, `fenceMs`, `frameMs`, `readbackMs`) and its replay time (`replayMs`), ms per frame |
| `busy`, `mips` | share of the time the emulator's worker ran the game, emulated MIPS |
| `visible`, `fullscreen`, `status`, `renderMode` | share of the window the tab was visible / in full screen, the page's state, the rendering used |
| `audio` | the sound output over the window (`src/host/web/sound.js` `AudioStats`): `ctx` the AudioContext's last state (`running`, `suspended` — Chrome's autoplay policy before the player's first click —, `interrupted`, `none`: not set up), `rate` its sample rate, `lat` output + base latency (ms), `run` share of the window it was running, `out` frames/s the AudioWorklet played (~`rate` when it plays, 0 stalled), `mix` (`worklet`: the worklet mixes the DirectSound buffers from guest memory; `worker`: the emulator's worker mixes into the ring), `peak` the mix's highest level (0: silence), `play` / `bufs` the most DirectSound buffers playing / existing, `dec` browser audio decoder (WebCodecs, MP3 of movies) failures, `resumes` resumes tried at gestures and `changes` state changes so far, `err` the output's set-up error. The report prints a verdict per session and per bench: `OK`, `SUSPENDED` (never ran: no click), `STALLED`, `SILENT` (buffers played, zero mix), `QUIET` (no buffer played), `ERROR` |

**GPU time** (`src/gfx/gpu-probe.js`): a `TIME_ELAPSED_EXT` query from one present to the next (the GPU execution time
of the frame's commands, the final blit included), over windows of 120 consecutive frames every 10 s, read at later
presents when available; a disjoint operation discards the results in flight. It runs where the WebGL backend runs (the
render worker by default, the emulator's worker with `?glworker=0`). Absent extension: reported unavailable, never
estimated. Disable with `?dbg=ORTHROS_GL_PROBES=0` (also stops the GL call counting).

**GL calls**: during a 30-frame window every 20 s the context's methods are wrapped by counting closures (calls made
through the context object; the wrapping is removed after the window; it stays away while a frame capture, GL timing or
the GL null mode wraps the methods themselves).

**Bench record** (`event: "bench"`): `bench`, `manifest`, `version` (build), `outcome` (`done`, `timeout`,
`aborted`, `exited`, `crashed`) and `detail`, `seconds`, `firstLaunch`, `display`, `options`, `marks` (each phase's
start, seconds from the launch: the time to the menu, the map load...), `anchors` (when each wait was satisfied),
`interrupted` (seconds hidden, focus losses), `audio` (as in the summaries, over the whole run), `env` (with `audioDecoder` / `audioWorklet`: WebCodecs audio and AudioWorklet available), and per phase: the worker's phase report (frame-acct.js
`FrameStats.phase`: frames, fps, slow frames > 33 / 40 / 50 / 100 ms and per minute (`slowPaced`: those > 33 ms whose
work fits in 33.4 ms; the summary panel shows > 40 ms per minute too), frame and work percentiles,
mean time by category, slow frames' excess shares, hitches, the 3 worst frames) with, from the stats of the phase,
draws per frame, GL calls per frame, GPU time, render worker waits, busy and visible shares. Phases: `start` (launch to
the first mark: downloads, start-up, intro), then the scenario's marks; the scenario's last mark `end` closes the last
phase.

Volume: the 0.5 s samples (~0.3 kB each) as before, plus ~2 kB per summary (every 20 s) and ~5 kB per bench record.

## Bench scenarios

`tools/scenarios/bench/index.json` lists them: `name` (the link's `bench=`), `title`, `manifests` (versions it plays;
the first one by default, `&manifest=` picks another), `file`, `coords` (the display the pointer coordinates were
written for: they are scaled to the game's display, so a profile with another resolution plays the same clicks),
`minutes` (shown in the banner), `maxSeconds` (the bench stops there, outcome `timeout`).

The scenario language is the harness's (`tools/headless.mjs --input`), parsed by `src/host/scenario.js` (shared):
steps `time:kind:args` separated by `;` or new lines, `#` comment lines; times in seconds from the launch, `+N` after
the first Direct3D frame, and after a wait from the moment the wait was satisfied. The page plays `move`, `click`,
`rclick`, `down`, `up`, `key`, `keydown`, `keyup`, `text`, `mark`, `waitfps`, `waitframe` (and skips `shot`, `blur`,
`focus`); `waitframe` takes several `min,max` ranges (any matches: e.g. the 2D menu of a first launch or the 3D menu
of richer settings). A click and a key press hold ~100 ms, as in the harness. While a bench runs the page's own mouse,
keyboard and focus events do not reach the game.

The bench scenarios must work from a player's fresh browser: no learned profile, the game's first launch. Their
waits therefore tolerate the first launch's long start (relative `+N` times after the first frame, waits on the
menu's draws per frame) and the menus a first launch shows.

Check one in the harness (headless Chromium through the browser slots; `--ui` shows the player's page with the banner,
whose start button the harness clicks; `--telemetry <dir>` gives the harness's server a telemetry directory, so the
page sends its records there; the run ends with the bench and prints its phases):

```
tools/with-browser-slot.sh node tools/headless.mjs vice-city-1.1-elamigos-2014 --games-dir /srv/orthros/data_games \
  --ui --bench vicecity-drive --telemetry /tmp/tel --seconds 600 --learn <copy of /tmp/orthros-profiles/learn-live>
node tools/telemetry-report.mjs /tmp/tel --bench
```

`--input-file <file>` plays a scenario file in the harness itself (comments and new lines allowed).

## The report

```
node tools/telemetry-report.mjs /var/lib/private/orthros2/telemetry                 # every session of 60 s and more
node tools/telemetry-report.mjs /var/lib/private/orthros2/telemetry --from 2026-10-05 --to 2026-10-06
node tools/telemetry-report.mjs /var/lib/private/orthros2/telemetry --bench           # bench runs only, and their comparison
node tools/telemetry-report.mjs /var/lib/private/orthros2/telemetry --bench vicecity-drive --json
```

Options: `--from` / `--to` (dates, inclusive: file names and the server's receipt time), `--session <id>`,
`--game <manifest>`, `--min-seconds` (60), `--bench [name]`, `--json`. Per session: machine line (GPU, cores, memory,
screen, Chrome version, OS, cross-origin isolation, WebGPU adapter), build, render mode, options; the stretches of the
0.5 s samples (as before); the summaries merged per stretch (frame-time percentiles from the merged histograms, slow
frames per minute, draws and GL calls per frame, GPU time, render worker waits, the work by category and the slow
frames' shares); the bench runs with their phases. Then per bench: one line per run (date, session, version,
outcome, first launch, machine, build, render mode, display) and its phases side by side (fps, p99, > 33 ms per
minute, GPU p99), and the marks (time to each phase).

## Checks made (2026-10-05, this server: headless Chromium, SwiftShader, shared 48 cores under load 16-32)

- `vicecity-drive`, fresh browser (no profile, `--learn` copy of learn-live), `--ui --telemetry`: banner, scenario and
  summary panel as a player sees them; outcome `done` after 172 s; marks menu 25.8 s, load 45.3 s, play 112 s, end
  172.1 s; the record and 8 summaries written by the harness's server, read back by the report.
- `bfme2-skirmish`, fresh browser (the game's first-launch setup: first frame after ~2 min): outcome `done` after
  354 s, 2D menu at 800x600, skirmish played (play phase screenshot), record written.
- After the waits moved to draws per frame: `bfme2-skirmish` fresh, `--ui --telemetry`: `done` after 266 s (menu
  140 s, load 191 s, loadscreen 197.4 s, play 205.8-266.1 s at 22.8 fps, 133 draws per frame), the summary panel
  over the skirmish, the record sent; `rotwk-skirmish` fresh (headless): `done` after 235 s, play at 305 draws per
  frame (the earlier `waitfps:12` never fired at SwiftShader's 7.6 fps: outcome `timeout` with the waiting step named).
- Warm profiles at 1024x768 (pointer coordinates scaled from 800x600, 3D menus), `--gl-discard`: `bfme2-skirmish`
  `done` (191 s, play 30.1 fps, 239 draws per frame), `rotwk-skirmish` `done` (172 s), `bfme1-skirmish` `done`
  (352 s, play 38.2 fps, 360 draws per frame).
- `bfme2-skirmish` with the warm 1024x768 profile (3D menu; coordinates scaled from 800x600), probes on and
  `?dbg=ORTHROS_GL_PROBES=0` side by side: both ~2.8 fps in the 3D menu (load 32: SwiftShader's GPU process bound,
  replay 338.5 / 338.7 ms per frame); the GPU timer reported 351 ms per frame, matching the render worker's replay and
  waits — the measurement is plausible even on SwiftShader. With the page's compositor on the same saturated GPU
  process, `--ui` runs of 3D scenes stalled the page's main thread for tens of seconds (screenshots time out, the
  scenario's later steps wait): an artifact of software rendering under load; use headless runs (`--gl-discard` to
  check a scenario's flow) here.
- Page cost: `FrameStats.add` with the histogram 0.69-0.86 µs per frame vs 0.42-0.82 before (Node, alternated, noisy
  machine: within the noise; < 0.003 % of a 33 ms frame); the page's summary work 2 µs per 0.5 s stats message.

## Checks made (2026-10-22, Node `startbench --bench`, this server under load 15-60)

Each bench played in Node as the page plays it (`--bench`, pointer coordinates scaled), from a profile seeded with the
server's canonical first-launch set (no downloads), `--cold --regions --heat --gfx recorder` (copies of the live learned
data). Times from the launch; the menu anchor includes the scenario's fixed 20 s after the first frame.

| bench (manifest) | first frame | menu | play from | total | play: fps, work p50 / p99, frames > 40 ms per minute |
|---|---|---|---|---|---|
| `bfme1-108-quick` (bfme1-108) | ~13 s | 34 s | 120 s | 240 s | 30.2, 14.5 / 25.1 ms, 32 |
| `bfme2-quick` (bfme2) | 20 s | 42 s | 107 s | 227 s | 30.2, 17.3 / 29 ms, 21 |
| `rotwk-quick` (rotwk-201) | 13 s | 35 s | 75 s | 195 s | 30.1, 18.1 / 33.1 ms, 27 |
| `rotwk-skirmish` (rotwk-202) | — | 36 s | 77 s | 137 s | 28.2, 20.1 / 64.2 ms, 83 (load 50-60) |
| `bfme1-skirmish` (bfme-vanilla) | — | 91 s | 268 s | 328 s | 38.3, 14.3 / 21 ms, 1 (menu at load 50-64) |
| `bfme1-skirmish` (bfme1-103) | 14 s | 36 s | 226 s | 286 s | 30.2, 14.1 / 25.9 ms, 11 |
| `vicecity-drive` | — | 20 s | 29 s | 89 s | 29.9, 13.9 / 34.1 ms, 21 |

Found while checking: `rotwk-skirmish` / `rotwk-quick` anchored RotWK 2.01's play only after minutes (its play draws
~140 per frame against the former threshold of 150: now 120), and `bfme1-skirmish` never left the menu on 1.03 (its
canonical profile's 2D menu draws ~100 per frame, between the former ranges 20-60 and 150+: now 20 and more).

## Tests

`tests/bench-kit.test.js` (histogram, interval counts, scenario parsing and the player's timing anchors, pointer
scaling, summaries, GPU / GL call probe with a timer-query double, the bench definitions), `tests/telemetry-report.test.js`
(sessions, date filters, merged summaries, bench comparison, the command line).
