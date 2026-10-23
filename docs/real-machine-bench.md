# Real-machine measurements: telemetry summaries, bench links, report

This server has no GPU (headless Chromium renders with SwiftShader): what a player's machine does with Orthros — its
GPU time per frame, the frame pacing of its browser, the cost of the render worker on a laptop — can only be measured
there. This kit lets the owner (or any player) produce those measurements by opening one link, and lets us read them
from the server's telemetry.

Three parts, all generic (no game-specific code; the only per-game artifacts are the scenario files):

1. **Telemetry** of every normal session (when the server runs with `--telemetry <dir>`, as the live server does):
   the machine, the options, and every ~20 s a frame summary (`src/host/perf-summary.js`); and in every runtime
   (Win32, GoldSrc, re3, OpenMW) the passive session record, every 2 min and at the end (below, "Passive session
   records"; `telemetry-report.mjs --perf`).
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
| BFME II 1.06 | <https://orthros.chalco.website/?bench=bfme2-skirmish&manifest=bfme2-106> | the same on version 1.06, started by its launcher `lotrbfme2.exe` (docs/processes.md; the manifest's exe once switched) | ~4 min |
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

## The bench suite: every game from one link

**<https://orthros.chalco.website/?benchsuite=all>** — open it in Chrome, click **Start the measurement**, then leave
the tab in front and visible, without touching the mouse or the keyboard, until the summary appears (about 15 minutes —
14.6 here, a first launch on a fast link, below —; longer on a first launch over a slower link: each game's files
download first). The summary lists every
game's phases and says whether the results reached the server (**Send again** if not, **Copy the results** besides).

| # | game (version) | bench | what it plays | phases |
|---|---|---|---|---|
| 1 | BFME 1.08, French (`bfme1-108`) | `bfme1-108-short` | `bfme1-108-quick`'s menu steps, a skirmish, 40 s of play | start, menu, setup, load, play, end |
| 2 | BFME II (`bfme2`) | `bfme2-short` | `bfme2-quick`'s menu steps, a skirmish, 40 s of play | start, menu, load, loadscreen, play, end |
| 3 | Rise of the Witch-king 2.02 (`rotwk-202`) | `rotwk-short` | `rotwk-quick`'s steps up to 44 s of play, 50 s | start, menu, load, loadscreen, play, end |
| 4 | Vice City on reVC (`vice-city-revc`) | `revc-drive` | the game's menu, a new game, its intro (cutscenes skipped with Space), 10 s on foot, the vehicle cheat's car driven 30 s | start, menu, load, intro, foot, drive, end |
| 5 | Morrowind Vanilla+, French (`morrowind-goty-vanilla-plus-fr`) | `morrowind-glide` | the engine page straight into Seyda Neen as a new character (`?start=-2,-9`), 10 s standing, 45 s carried north at 300 units/s, 5000 high (the engine's debug teleport, as `tools/openmw/perf.mjs --glide`) | start, world, glide, end |
| 6 | Half-Life (`half-life-original-en`) | `halflife-c1a0` | the menu, `map c1a0` from the console, 45 s walking in the tram (console movement commands) | start, menu, load, walk, end |
| 7 | Counter-Strike rebuilt (`counter-strike-rebuilt-en`) | `cs-bots` | the menu, the version's solo map (`de_dust2`, its bots), the counter-terrorists joined, 50 s walking while the bots play | start, menu, load, play, end |

`?benchsuite=<bench>[,<bench>...]` runs some of them (`?benchsuite=revc-drive`; `&manifest=` picks the version of a
single one); `?bench=<a port's bench>` opens it the same way. `&gldiscard=1` reaches every game (this server's software
GPU without its drawing: the Win32 page's `?gldiscard=1`, the ports' rasterizer discarded by the meter); `&benchauto=1`
starts without the click. The suites are in `tools/scenarios/bench/index.json` (`suites`: the benches in order, each
with its version and game language), the ports' benches there too (`runtime`: `re3`, `goldsrc`, `openmw`; `page`: the
port page's address under the version's launch address, e.g. OpenMW's engine page with `?start=`).

How it runs (`src/host/web/bench-suite.js`): the suite page (the Orthros page, `main.js` `?benchsuite=`) opens each game
in a full-window frame of its own, the game's page as a player opens it, with the game's normal profile in this browser,
and shows its banner above it ("3/7 Vice City (reVC) · 0:40 · phase drive · 54 fps", a progress bar, **Skip this
game**, **Stop everything**). Before the next game, the page is left as a player leaves it (the shell's save — the
runtime's `onQuit`, `shell.save()` — then the frame emptied).
- **A Win32 game**: its page in bench mode (`/?bench=<name>&benchauto=1&benchrun=<run>…`): its own BenchRun plays the
  scenario and measures its worker's frames, without its banner or summary (the suite's), and sends its record.
- **A browser port**: its page in the frame; the suite runs the BenchRun (the same class), the port's frames measured
  from outside its page (`src/host/web/page-meter.js`: installed into the frame's window once it is there — the
  engine's WebGL draw calls counted on the context prototypes, a frame = a browser frame in which it drew, its work from
  the frame's first callback to its request for the next one or the port's own count, those frames fed to the frame
  accounting every runtime uses, `FrameStats`, and to the scenario player as the Win32 worker's stats messages; GPU time
  with the Win32 runtime's probe, `gpu-probe.js`, on the engine's context; its renderer string) and its input given as
  DOM events of its own window (`src/host/web/dom-input.js`: keys with their `code` / `keyCode` and a `keypress` for
  characters, typed text one key at a time, the mouse at the canvas' place) or through the page's hooks — the GoldSrc
  console (`cmd:` steps, `portSession.command`), OpenMW's debug teleport (`glide:` steps, `window.orthrosBenchHooks`
  set by `src/ports/openmw/frame-meter.js` when the page has `?benchrun=`). Data waits: the game data's reads that
  waited (`data-client.js` stats: `portSession.files`, OpenMW's streamfs).
- **A game that fails** (its page's error, its exit, a scenario that never reaches its screen — the bench's
  `maxSeconds`, 480-900 s, then 90 s of grace without a record) is recorded with its outcome (`crashed`, `exited`,
  `timeout`, `skipped`, `aborted`, `failed`, `lost`) and the next one starts.
- **The scenario language** gained `nudge:vk,every` (the key pressed every `every` seconds while the next wait holds:
  intros skipped however many there are) and, for the ports, `cmd:<command>`, `look:dx,dy[,n,ms]`,
  `glide:x0,y0,vx,vy,z` / `glide` (stop); a `;` separates steps, so a `cmd` holds one command.

**Records**: each game's `bench` record has the same fields whatever the runtime (`runtime`, `manifest`, `outcome`,
`marks`, `anchors`, `phases` — per phase `fps`, `dt` p50 / p90 / p99 / max, `work` p50 / p90 / p99, `slow40` / `per40`
(frames > 40 ms), `gpu` (EXT_disjoint_timer_query_webgl2 when the browser has it), `drawsPerFrame`, `dataWaitMs` —,
`hostTiming` (the timing probe), `renderer` (the WebGL renderer the game drew with), `env`, `interrupted`) and
`suite: { run, name, index, of }`; the suite's own `bench-suite` record holds every game's compact result
(`compactResult`), the machine and the counts. The batches of every bench page carry `bench` (the suite run, or the
bench's name) — their sessions are told apart from the players' (`telemetry-report.mjs --players` leaves them out); the
ports' own session reports and every page's passive session records (`bench` of their header, `--perf --players`
leaves them out) carry it too. A port's frames are measured as its passive records measure them: `page-meter.js` and
`PerfSession.watchFrames` share `perf-page.js` `watchEngineFrames` (and `timerContext`, WebGL 1's GPU timer).

**Read it**: `node tools/telemetry-report.mjs /var/lib/private/orthros2/telemetry --suite` (every run; `--suite <run>`
one, `--json`): per run the machine and build, per game its outcome, renderer and phases (fps, frame p50 / p90 / p99,
frames > 40 ms per minute, work p50 / p99, GPU p50 / p99, data waits, draws per frame) and the host's timers. A game
whose own record never came is shown from the suite's record.

**Check it here** (headless Chromium, fresh profile: every game's first launch, through the browser slots):

```
tools/with-browser-slot.sh node tools/bench-suite-check.mjs --url http://127.0.0.1:<port> --suite all --gl-discard \
  --minutes 45 --shots 20 --out /tmp/orthros-scratch/<task>/suite
node tools/telemetry-report.mjs <the server's --telemetry dir> --suite
```

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
| `hostWait` | the emulator's host waits (`src/core/host-wait.js`, docs/thread-scheduling.md "Host wake-up overshoot"): `waits` measured, `overMean` how late they woke on average (ms), `lateMsPerFrame` the part of it that lengthened frames (the frame accounting's `late`), `spinMsPerFrame` the spin that made a frame limiter's last waits precise, `est` / `timerEst` the measured overshoot of Atomics.wait / of the pump's timer |
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
mean time by category, slow frames' excess shares, hitches, the 3 worst frames, `hostWait` — the phase's host waits:
`overMean` / `overMax` / `hist` how late they woke (ms; histogram bounds 0.1, 0.25, 0.5, 1, 2, 4, 8, 16), `lateMsPerFrame`,
`spins` / `spinMsPerFrame`, `est`, `timerEst`, `injected` (an injected timer), `adaptive`) with, from the stats of the phase,
draws per frame, GL calls per frame, GPU time, render worker waits, busy and visible shares. Phases: `start` (launch to
the first mark: downloads, start-up, intro), then the scenario's marks; the scenario's last mark `end` closes the last
phase.

**Host-timing probe** (`hostTiming` of the bench record, `src/host/web/timing-probe.js`): at the start and at each
mark, a small worker of the page (the timer resolution is the process's: the emulator's worker sees the same) measures
how late this browser wakes it up — `atomicsWait1` (Atomics.wait(1 ms), as the emulator's own short waits),
`atomicsWait1Timer` (the same while a 4 ms setTimeout is pending: Chrome may raise the timer resolution for it),
`setTimeout0` / `setTimeout1` (chained from their own callbacks), `messageHop` (a MessageChannel round) — each `{ n,
mean, p50, p90, max }` in ms past the time asked (24 samples), plus `battery` (`{ charging, level }` from
navigator.getBattery, null without it), `label` / `at` (the phase it opens, seconds from the launch) and `injected`
(`?dbg=ORTHROS_HOST_TIMER_Q`: the probe then applies that timer too — a check of the path). On a Windows machine with
the default timer, Atomics.wait(1) reads ~+14 ms; with a 1 ms resolution ~+1 ms; Linux ~+0.06 ms. The summary panel
shows one line per probe and, per phase, the host waits' lateness per frame and the spin (`wake-ups late ms/frame
(spin)`); `telemetry-report.mjs --bench` prints both.

What to read in the next BFME1 run on the owner's machine: `atomicsWait1` p50 (coarse ~14 ms, or ~1 ms) and the battery
(the resolution may change with it during the run); per phase `lateMsPerFrame` (before 2026-10-22 that lateness hid in
`wait`) and `spinMsPerFrame`; menu frame p90 back to ~35 ms (it was 46.8, three 15.625 ms ticks).

Volume: the 0.5 s samples (~0.3 kB each) as before, plus ~2 kB per summary (every 20 s) and ~5 kB per bench record.

## Passive session records

The owner (and most players) will not run benchmarks: what a game does on a player's machine is learned from their
normal play sessions, passively. Every runtime's page — the Windows games' (`src/host/web/main.js`), the GoldSrc and re3
ports' (`src/ports/*/play.js`) and the OpenMW engine's page (`src/ports/openmw/frame-meter.js`, put in by the server) —
sends the same compact record, `event: "perf"`, built by one shared module: `src/host/perf-record.js` (the recording
and the server's validation, no DOM) and `src/host/web/perf-page.js` (the page side: clock, frame meter, GPU timer,
timing probe, sending). Only when the server keeps telemetry (`/api/config` `telemetry`; the Win32 page also not with
`?headless=1`). There is no opt-out in Orthros today (none existed for the other telemetry either); the record holds
nothing beyond what the telemetry already held (the browser's user agent, cores, memory, screen, WebGL renderer).

**When**: one record every 2 minutes of the session that has new entries (a hidden tab sends none), and one at its end
(`final: true`: the game exited or crashed, the port's end, the page's `pagehide`) — sendBeacon, else a keepalive
fetch. At most 150 records a session (5 hours), 12 entries a record, 24 KiB a record (the page trims the totals'
histogram then the oldest entries; the server refuses larger ones with 413). Each record is ~2-5 kB.

**What** (one entry per minute of the session; a phase change starts a new entry once the current one holds 5 s):

| field | what |
|---|---|
| `session`, `game`, `runtime`, `version`, `build`, `tier`, `bench` | the page's telemetry session id, the manifest, `win32` / `goldsrc` / `openmw` / `re3`, the manifest's version label, the served build (`/api/config`), the engine's quality tier (OpenMW: `orthrosTierChoice`), the bench name when the page runs one |
| `seq`, `final`, `len`, `vis`, `hid`, `dropped` | record number, the end's record, session seconds so far, of them visible / hidden, entries dropped over the cap |
| `env` | `gpu` / `gpuVendor` (WebGL unmasked renderer), `gpuClass` (gpu-class.js: integrated, discrete, software), `cores`, `memGB`, `ua`, `screen` |
| `probe` | the host timing probe (timing-probe.js), once after a minute of visible play: `atomicsWait1`, `atomicsWait1Timer`, `setTimeout0`, `setTimeout1`, `messageHop` as `[p50, p90, max]` ms late, `battery`; in the first record after it and in the end's |
| `mins[]` | entries: `t` (start, s from the session's start), `ph` (phase: Win32 the page's status, the ports' session state, OpenMW `loading` / `menu` / `world`), `s` / `hid` (visible / hidden seconds), `n` frames, `fps` (over the visible time), `p50` `p90` `p99` `max` (frame ms, frame-acct.js histogram: 1 ms buckets below 100 ms), `f40` `f100` (frames over 40 / 100 ms), `work` / `wait` (ms per frame), `cats` (Win32: mean ms per frame by frame-accounting category), `slow` (the slow frames' time by cause, ms summed), `gpu` (`{ n, mean, p50, p90, p99 }` timed frames — `lost`: queries whose result never came —, or `{ state }`), `data` (`{ n, ms }` game data waits) |
| `tot` | the same over the whole session so far (visible play only), with its frame-time histogram `h` (sparse: sessions merge) |

**Hidden tabs**: the time is counted (`hid`), the frames are not (a hidden tab's frames and the first gap after it).

**Frames, work and wait, per runtime**:
- Win32: the worker's stats intervals (~0.5 s, frame-acct.js `takeInterval`): frames, histogram, slow counts, mean work
  (frame accounting minus `wait` / `sleep`) and categories; `slow` = the categories of the frames over 33.4 ms (the
  frame accounting's own slow frames). GPU: the Direct3D device's timer probe (gpu-probe.js, render worker). Data waits:
  the game's synchronous file reads over the network (the worker's `netMs` / `netReq`).
- Ports: a frame is a browser frame in which the engine drew (GoldSrc, OpenMW: the GL draw counter they already had)
  or one it displayed (re3: `Module.orthrosFrame`); its time from one shown frame's start to the next (animation frame
  timestamps). The engine's work: from the browser frame's start to the engine's request of its next animation frame
  made in it (`requestAnimationFrame` wrapped: its iteration's end, an asynchronous main loop's too); `wait` = the
  frame's time minus that. `slow` for frames over 40 ms: `data` (the game data's waits in that frame — the shared
  counters of `src/vfs/data-client.js` `GameData.stats`), `work` (the engine's other work), `other` (the browser, the
  GPU, the compositor, or the page's thread held outside the engine's frame iteration — a synchronous load), `unknown` without a work measure. GPU: the same `GpuProbe` on the engine's context
  (`EXT_disjoint_timer_query_webgl2`, or `EXT_disjoint_timer_query` on WebGL1 through an adapter), windows of 120
  frames every 10 s; `{ state: 'unavailable' }` without the extension.

**The report**:

```
node tools/telemetry-report.mjs /var/lib/private/orthros2/telemetry --perf                     # every game × GPU
node tools/telemetry-report.mjs /var/lib/private/orthros2/telemetry --perf --game bfme1-108 --gpu Iris
node tools/telemetry-report.mjs /var/lib/private/orthros2/telemetry --perf --json
```

Per game × GPU (the renderer's short name, e.g. `Intel Iris Xe Graphics`; `--gpu` matches a part of it or of the
renderer string): sessions and minutes of visible play; the medians over the sessions (fps, frame p50 / p90 / p99,
frames > 40 / > 100 ms per minute, work / wait per frame, GPU ms per frame, data waits per minute, visible share); the
percentiles of all their frames merged; the slow frames' time by cause (%); the three worst minutes (most frames over
40 ms per minute, then p99; at least 20 s of play); the host timing (median Atomics.wait(1) lateness, sessions on
battery); one line per session (machine, build, tier, whether its end record arrived). `--from`, `--to`, `--session`,
`--min-seconds` (60 s of visible play) apply.

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
| `vicecity-drive` (no canonical set) | 10 s | 20 s | 29 s | 89 s | 29.9, 12.1-13.9 / 33-34 ms, 17-21 |

Found while checking: `rotwk-skirmish` / `rotwk-quick` anchored RotWK 2.01's play only after minutes (its play draws
~140 per frame against the former threshold of 150: now 120), and `bfme1-skirmish` never left the menu on 1.03 (its
canonical profile's 2D menu draws ~100 per frame, between the former ranges 20-60 and 150+: now 20 and more).
`bfme2-skirmish` / `bfme2-quick` on `bfme2-106` cannot run: its game.dat exits after ~1 s when the named mutex its
launcher creates is absent (CreateMutexA then GetLastError != ERROR_ALREADY_EXISTS), as under Windows.
Since 2026-10-22 (docs/processes.md) 1.06 runs through its launcher, which starts game.dat as a child process:
`bfme2-skirmish` with a manifest whose 1.06 `exe` is `lotrbfme2.exe` (headless, SwiftShader, load ~30) reached the menu
at 139 s, the skirmish's play at 213 s and ran its minute (8.4 fps, render-bound). A first run with a fresh profile left
the menu by an exit instead (the game quit with code 0 after the scenario's last click; its 2D first-launch menu took
164 s to come, the clicks fell elsewhere).

## Checks made (2026-10-22 evening: the quick benches in headless Chromium with the banner, bfme-vanilla re-measured)

The three quick links played as the owner plays them: `tools/with-browser-slot.sh node tools/headless.mjs <manifest>
--games-dir data_games --learn <copy of the live learned data> --ui --bench <name> --gl-discard` — a fresh browser (no
profile: the first launch, the files downloaded from the harness's server, the canonical first-launch set offered), the
banner's start button clicked, the scenario played by the page, the summary panel at the end (screenshot). SwiftShader,
load 25-37, sometimes two of these browsers at once:

| bench (manifest) | outcome | menu / play from / end | play: fps, frame p50 / p90 / p99 ms, > 40 ms per minute |
|---|---|---|---|
| `rotwk-quick` (rotwk-202) | `done` after 235 s | 63 / 115 / 235 s | 26.6, 33.3 / 38.6 / 113.3, 135 |
| `bfme2-quick` (bfme2) | `done` after 251 s | 62 / 131 / 251 s | 30.1, 33.0 / 35.8 / 40.4, 22 (a first run beside another browser: 10.9 fps, guest 46 ms per frame — the machine) |
| `bfme1-108-quick` (bfme1-108) | `done` after 278 s | 55 / 158 / 278 s | 30.1, 33.1 / 35.7 / 40.5, 21 |

Every link runs to its end and shows its summary; the timings are this loaded server's software rendering, not a
player's machine. Found on the way: on a first launch the page's "every thread waits" reports (at most 20 per session)
were all used in the first seconds by the main thread's parked game file reads (RotWK: 20 by t = 3 s), whose 60 s bound
is only a safety net; the report now skips the moments when a file read is in flight (worker.js).

**bfme-vanilla's first launch** (the 91 s to the menu of the table above, measured at load 50-64): Node, seeded profile,
`--bench bfme1-skirmish`, load ~30: first Direct3D frame at 14.4 s, menu anchor at 40 s (the scenario's 20 s after the first frame
included) — like 1.03 (36 s) and 1.08 (34 s). The 91 s was the machine's load. Its menu itself is heavy: 21 fps in Node,
28 M guest instructions per frame in the main thread (the 2.22 mod's menu at the canonical High LOD settings), the
emulator's speed per instruction as elsewhere (1.5 ns); nothing of the emulator's own stands out there (no Sleep(0)
spin: 45 per frame, 491 scheduling decisions per frame).

## Checks made (2026-10-23: the bench suite in headless Chromium, every game's first launch)

`tools/bench-suite-check.mjs --suite all --gl-discard` on a server of this branch (`--games-dir` a scratch catalog
linking the live games, `--learn` a copy of the live learned data, `--telemetry`): a fresh browser, the intro's button
clicked, nothing else. SwiftShader with the rasterizer discarded, load 17-60 (other projects). Second run, all fixes in:
**7/7 `done` in 875 s** (14.6 min), 8 records written (7 games, the suite's), `telemetry-report.mjs --suite` reads them:

| game | outcome, time | measured phase: fps, frame p50 / p90 / p99 ms, > 40 ms /min, work p50 / p99 ms, data waits |
|---|---|---|
| BFME 1.08 fr | done, 189 s (menu at 45 s, play from 149 s) | play 40 s: 30.0, 33.1 / 36.4 / 41.1, 30, 15 / 27, 0 ms |
| BFME II | done, 158 s | play 40 s: 29.4, 33.0 / 36.9 / 53.0, 58, 15.9 / 46, 277 ms |
| RotWK 2.02 | done, 145 s | play 50 s: 29.8, 33.1 / 36.4 / 48.5, 48, 18 / 48.5, 12 ms |
| Vice City reVC | done, 122 s | drive 30 s: 19.1, 50 / 100 / 100, 930, 3.3 / 6.1, 41 ms (GPU-bound here: GPU p50 53 ms) |
| Morrowind Vanilla+ fr | done, 85 s (world at 27 s) | glide 45 s: 32.1, 33.3 / 33.3 / 66.7, 121, 11.9 / 25.6, 288 ms |
| Half-Life | done, 69 s | walk 45 s: 59.6, 16.7 / 16.7 / 16.7, 0, 1.2 / 3.4, 6 ms |
| Counter-Strike rebuilt | done, 85 s | play 50 s: 59.5, 16.7 / 16.7 / 16.7, 4, 1.8 / 5.2, 11 ms |

(Numbers of this loaded server's software GPU, not a player's machine; the ports' frame times are the browser's
animation-frame timestamps, on the display's 16.7 ms grid.) The first full run (before the game's frame was given the
focus) had BFME 1.08 `timeout` after 900 s — waiting for the skirmish setup screen, its profile dialog left open — and
went on with the next game as designed (6/7 done, the summary and the 8 records sent); BFME 1.08 alone in the suite
then played to its end (190 s), as at the top level (`headless.mjs --ui --bench bfme1-108-short --game-lang fr`: 237 s).
Without `--gl-discard` (SwiftShader drawing), the port pages showed their scenarios: reVC's menu, new game, intro
scenes, Tommy free near the Ocean View, "Cheat activated" for the typed GETTHEREFAST (at 2-4 fps here a key held
100 ms can fall between two frames: the presses are held longer, the text one key at a time); Morrowind at Seyda Neen
then carried over the Bitter Coast (at 3000 high the player once died against the hills and the main menu came up:
5000 now); Counter-Strike's counter-terrorist spawn with the bots; Half-Life's tram. The Win32 pages there stall the
page's thread for minutes under SwiftShader (as noted on 2026-10-05): use `--gl-discard` for them.

## Tests

`tests/perf-record.test.js` (passive session records: minutes, phases, hidden time, counters, bounds, the server's
check and route, the page side with a fake window, the WebGL1 timer adapter, `--perf`), `tests/bench-kit.test.js` (histogram, interval counts, scenario parsing and the player's timing anchors, pointer
scaling, summaries, GPU / GL call probe with a timer-query double, the bench definitions), `tests/telemetry-report.test.js`
(sessions, date filters, merged summaries, bench comparison, the command line), `tests/bench-suite.test.js` (the nudge
and the ports' steps, the suites' definitions, the page meter on a stand-in window — frames, work, data waits, discard
—, the hooks, the DOM input, virtual keys as DOM keys, the games' addresses, the suite's records, `--suite` and
`--players`).
