# Frame accounting: where a frame's time goes

`src/core/frame-acct.js`, always on. The metric every frame-drop measurement uses (harness, telemetry, slow-frame log).

## The stopwatch

The emulator worker charges every moment of its time to exactly one category. `acct.enter(cat)` closes the running
segment and opens one of `cat`; `acct.leave(prev)` goes back. Sections nest (a texture upload inside an API call inside
a callback from guest code), so a category's time is exclusive and a frame's categories add up to its duration (the
time between two presents, measured at `BrowserHost.framePresented`).

| category | what |
|---|---|
| `guest` | guest code: translated code, the dispatcher, thread switches |
| `api` | Win32 / Direct3D / D3DX handlers in JavaScript, exclusive of the categories below |
| `draw` | Direct3D draws, clears and StretchRect recorded for the render worker, or (`?glworker=0`) submitted to WebGL (state, constants, vertex data, the GL call); blocks when the GPU process is behind. Sampled with the API calls, all timed while the GPU process is behind (see Cost) |
| `interp` | instructions run by the interpreter (fallbacks of translated code; the JIT's cold tier: new code interpreted while the background worker translates it) |
| `jit` | translation of new code on the game thread (first tier, consolidation) |
| `ahead` | learned regions translated on the game thread while it waits |
| `install` | installing regions translated by the background worker |
| `prog` | GL program builds and resolves (at draws and ahead) |
| `tex` | texture conversions and uploads, waits for the DXT helpers |
| `readback` | GL readbacks on the game thread |
| `io` | game file reads served from memory or the block store |
| `net` | synchronous game file reads over the network |
| `present` | the present and the hand-off of the frame to the page |
| `render` | waits for the render worker (the default; none with `?glworker=0`) |
| `audio` | audio mixing / cursor publication on the game thread |
| `host` | the worker's bookkeeping between slices |
| `wait` | a guest thread waiting inside a nested call (pacing) |
| `sleep` | every guest thread waits: the worker sleeps until the next wake-up (pacing) |
| `ioWait` | waiting for a file read on the network: the worker idle or in a nested wait while the thread presenting frames (the last to call Present) waits for a read, or while a parked read is in flight and no guest timer is due within 50 ms; a nested wait for a read (`file read` / `file busy`, or any wait but a sleep while reads are in flight) |
| `late` | the worker resumed later than planned: timer clamping, garbage collection, other tasks of its event loop |

**Work** of a frame = its duration minus the pacing categories (`wait`, `sleep`). A game that paces itself by polling
the clock (no sleep) shows that polling as `guest`/`api` work: compare slow frames, not fast ones.

## Cost

`performance.now()` costs ~0.25 µs in a cross-origin isolated Chrome worker (measured), so the very frequent sections
are sampled: JS API calls and interpreter fallbacks are timed on a random 1 in ~16 and counted otherwise; a frame's
untimed calls are estimated from its timed ones (ratio estimator) and that time moved from `guest`. An API whose
timed call took 0.5 ms or more of its own time is timed on every call until 1024 of its calls in a row are short
again (rare heavy calls are not left to sampling). `draw` is timed inside a timed API call (the untimed calls' draw
time is estimated with their API time), and every draw is timed from a draw of 0.5 ms or more until 1024 draws in a
row are short again (a GPU process behind: one draw a frame may wait for the whole previous frame, which sampling
would miss). A timed
section may span a frame boundary (a timed Present): the counters are cumulative, so its time stays exact. The phase
report prints the accounting's own clock reads per frame.

## Where it shows

- **Harness** (`tools/headless.mjs`): each `mark:<label>` input starts a phase named `<label>`; the previous phase (and
  the last one, as `end`, when the run stops) gets a `[frames]` report: frames > 33 / > 40 / > 50 / > 100 ms (count
  and per minute; `slowPaced`: the frames > 33 ms whose work fits in 33.4 ms — waiting made them long, e.g. a 30 fps
  game's frame limiter waking 1-2 ms late, as its Sleep granularity does on Windows), frame and work percentiles, mean time by category over all frames and over the slow (> 33.4 ms) ones, the
  slow frames' excess over the phase's median frame by category (% of the total excess) and the count of slow frames
  by their largest excess, the worst frames with their categories, the frames of 150 ms and more counted by their
  largest category (`hitches`: e.g. `ioWait 3, guest 2`), and the APIs that took the most time (estimated from the
  samples). `--phases <file>` writes the reports as JSON. The report also gives the guest instructions executed in the phase (as charged to the executors' budgets, `Vm.guestInsns`) and the `guest` time per million of them (`guestMsPerMInsn`, i.e. ns per guest instruction): the speed of the translated code whatever the scene asks of it — the measure to compare code-generator variants with (`dbg:ORTHROS_JIT_AB=<json>` switches translation options within a session).
- **Node** (`tools/startbench.mjs --input <scenario>`, tools/node-scenario.mjs): each mark gets the same `[frames]`
  report (the page's `FrameStats` over the Direct3D presents); `--gfx recorder` puts the render worker's recording on the
  thread as in the page (`backend`: the in-thread WebGL backend over a no-op context; tools/node-gfx.mjs, shared with
  framebench), `--slow-apis <ms>` adds the APIs' time in the frames longer than that (`[slowapis]`), `--gc <ms>` this
  thread's garbage collections per phase and in those frames (`[gc]`, V8's GCProfiler).
- **Slow-frame log lines** (`[slowframe]`): the frame's categories in brackets after its duration.
- **Telemetry** (`--telemetry`): each ~0.5 s sample gains `w` (mean work per frame, ms), `c` (mean ms per frame by
  category), and when frames were slow `sc` (their categories summed, ms) and `wf` (the worst one: [ms, work ms,
  {category: ms}]); the old fields are unchanged. An `options` event gives the options the worker runs with (render
  worker, asynchronous reads, background translation, DXT helpers, ...) and the served build (`version`: commit,
  `+` when `src/` differs from it, newest source modification time), also in `env.version`. Every ~20 s a `summary`
  record (frame-time percentiles from the intervals' histograms, frames > 33 / 40 / 50 / 100 ms, time by category,
  draws, GL calls and GPU time per frame, render worker waits) and the bench mode's `bench` records: see
  docs/real-machine-bench.md.

## Phase scenarios (the shared measurement)

`tools/scenarios/*-phases.txt` mark the phases `menu`, `load` (from the click that starts a skirmish), `loadscreen`
and `play` (the last one ends with the run, reported as `end`); `bfme2-acct-ab.txt` alternates the accounting's clock
on and off every 20 s of play (its cost). Run, e.g.:

```
tools/with-browser-slot.sh node tools/headless.mjs bfme2 --seconds 520 --profile-dir <copy of /tmp/orthros-profiles/bfme2> \
  --learn <copy of /tmp/orthros-profiles/learn-live> --phases out.json --input "$(cat tools/scenarios/bfme2-phases.txt)" [--gl-discard]
```

`*-startup.txt` are the same journeys with the intro videos skipped where the game allows it (Escape) and a mark
`later` one minute into the match (the `play` phase is then the first minute of play: start-up and first-use
measurements, `--stop-on "mark later:"` ends the run there); `bfme2-first.txt` is BFME2's for the settings a first
launch writes (800x600, 2D menu: no profile, or the shared first-launch profile of src/host/profile-seed.js).

`bfme1-108-phases.txt` is the validation target's criterion: BFME 1.08, menu, a skirmish, ten minutes of play (orders,
camera scrolls; the same steps as the bench `bfme1-108-skirmish`, docs/real-machine-bench.md). Measured 2026-10-22
(warm 800x600 High profile, a copy of the live learned data, headless Chromium `--gl-discard --memprefetch`, load
20-30; the play split in ten 60 s windows): every window 30.0-30.2 fps, frame p99 37.7-40.9 ms, > 33 ms 714-781 per
minute of which 97-99 % paced (work under 33.4 ms: BFME 1.08 paces itself at 30 fps with `Sleep(0)` + `timeGetTime`, the
frame ending up to 1-3 ms past its 33.3 ms), > 40 ms 7-24 per minute, > 50 ms 0-7, > 100 ms 0-1; work p99 22-36 ms.
The slow frames' excess: guest 47-66 %, api 16-25 % (the deferred queue's drain, ~3 ms in a slow frame against 1.2 ms
on average: heavier frames, not a stall), draw 5-8 %, late 2-12 %, host 3-5 %. The worst frames (100-220 ms): a game
file read on the network missing from the learned prefetch (`ioWait` + `late`, 8 reads in 10 min), new code
(`jit` + `interp`), game work (`guest`). Garbage collection of the emulator thread: 0.02 ms per frame (Node
`startbench --gc`), 217 ms in 40 s with none over 10 ms (Chrome trace). In Node (`startbench --gfx recorder --cold`, the
same scenario): 30.0 fps, p99 39.0-42.3 ms, > 40 ms 12-33 per minute, slow frames' excess guest 81 %, api 12 %, draw
4 %. A run during a load spike of the shared machine (load 40-86) showed render-worker waits of 300-500 ms (the GPU
process starved) and 28.4 fps over the ten minutes: measure at a quiet moment.

Wave 3 (2026-10-22, the frames over 40 ms; each change against the tree before it, two runs started together so that
both see the same load — the shared machine's load moved frames over 40 ms between 21 and 41 per minute for the same
tree): what makes a frame over 40 ms in BFME 1.08's play is the game's own heavy frames — its main thread runs 12.9 M
guest instructions in them against 4.1 M on average, the other threads nothing more (`startbench --threads
--slow-threads 40`) — so they follow the speed of the translated code. Fixed meanwhile: a yield that took the yielding
thread back (scheduling decisions per frame ~1 100-1 250 → ~270, `Sleep` calls per frame ~400 → ~190, work p90 −1 to
−2 ms: docs/thread-scheduling.md), refused nested buffer locks and the cost of failure reports (docs/api-layer.md), the
archives read at random after the learned prefetch (docs/slow-network.md: fewer stalls of 100 ms and more). The drain
of the deferred queue was profiled (docs/api-layer.md): the game's Direct3D work, ~0.7 µs per queued call, 14 % of it
the queue itself. Late wake-ups (`late`, 0.2-0.3 ms per frame, 7 % of the slow frames' excess): the slices end every 12
ms and the event loop runs between them; the guest's own 1 ms waits (the Sleep(0) throttle) happen inside `runFor`
(Atomics.wait, precise), and the frames paced by Sleep(0) + timeGetTime end at 33.0-33.1 ms (p50); the large `late`
shares come with network reads (`ioWait`): the read's tasks. Headless Chromium, ten minutes of play, the tree before /
this one, together: frames over 40 ms 22 / 21 per minute (yield and locks), work p50 14.9 / 14.1 ms, p90 21.5 / 19.7, p99
31.4 / 29.5. Node (`startbench`, together): 23 / 24 per minute, `Sleep` 0.30 / 0.15 ms per frame, vertex buffer locks
0.48 / 0.27 ms per frame, the drain 1.59 / 1.57 ms per frame; the guest does more (the game's vertex fills after its
locks now succeed: 83.6 → 108.9 G instructions in ten minutes).

`startbench` options for this kind of work: `--sleeps` (each phase's Sleep pattern per thread: Sleep(0) calls, those
that ran a ready thread, throttled ones, why their streaks ended), `--threads --slow-threads <ms>` (each thread's guest
instructions in the frames over that), `--slow-apis <ms>`, `--cpu-prof <file> --cpu-prof-window <phase>:<from>:<to>` (a
V8 profile of a window of a phase), `--api-seq <n>@<s>` (the next n API calls after s seconds).

`rotwk-phases.txt` (rotwk-202, 1024x768) needs a rotwk profile; `bfme-phases.txt` (bfme-vanilla, 800x600) a profile
saved by an earlier run (`/tmp/orthros-profiles/bfme-vanilla`). `--gl-discard` measures the CPU side (headless
SwiftShader otherwise makes `draw` — the GPU process behind — dominate every rendered frame of play).
