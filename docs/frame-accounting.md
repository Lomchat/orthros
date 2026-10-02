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
  the last one, as `end`, when the run stops) gets a `[frames]` report: frames > 33 / > 40 / > 50 ms (count and per
  minute), frame and work percentiles, mean time by category over all frames and over the slow (> 33.4 ms) ones, the
  slow frames' excess over the phase's median frame by category (% of the total excess) and the count of slow frames
  by their largest excess, the worst frames with their categories, the frames of 150 ms and more counted by their
  largest category (`hitches`: e.g. `ioWait 3, guest 2`), and the APIs that took the most time (estimated from the
  samples). `--phases <file>` writes the reports as JSON. The report also gives the guest instructions executed in the phase (as charged to the executors' budgets, `Vm.guestInsns`) and the `guest` time per million of them (`guestMsPerMInsn`, i.e. ns per guest instruction): the speed of the translated code whatever the scene asks of it — the measure to compare code-generator variants with (`dbg:ORTHROS_JIT_AB=<json>` switches translation options within a session).
- **Slow-frame log lines** (`[slowframe]`): the frame's categories in brackets after its duration.
- **Telemetry** (`--telemetry`): each ~0.5 s sample gains `w` (mean work per frame, ms), `c` (mean ms per frame by
  category), and when frames were slow `sc` (their categories summed, ms) and `wf` (the worst one: [ms, work ms,
  {category: ms}]); the old fields are unchanged. An `options` event gives the options the worker runs with (render
  worker, asynchronous reads, background translation, DXT helpers, ...) and the served build (`version`: commit,
  `+` when `src/` differs from it, newest source modification time), also in `env.version`.

## Phase scenarios (the shared measurement)

`tools/scenarios/*-phases.txt` mark the phases `menu`, `load` (from the click that starts a skirmish), `loadscreen`
and `play` (the last one ends with the run, reported as `end`); `bfme2-acct-ab.txt` alternates the accounting's clock
on and off every 20 s of play (its cost). Run, e.g.:

```
tools/with-browser-slot.sh node tools/headless.mjs bfme2 --seconds 520 --profile-dir <copy of /tmp/orthros-profiles/bfme2> \
  --learn <copy of /tmp/orthros-profiles/learn-live> --phases out.json --input "$(cat tools/scenarios/bfme2-phases.txt)" [--gl-discard]
```

`rotwk-phases.txt` (rotwk-202, 1024x768) needs a rotwk profile; `bfme-phases.txt` (bfme-vanilla, 800x600) a profile
saved by an earlier run (`/tmp/orthros-profiles/bfme-vanilla`). `--gl-discard` measures the CPU side (headless
SwiftShader otherwise makes `draw` — the GPU process behind — dominate every rendered frame of play).
