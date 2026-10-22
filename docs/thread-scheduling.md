# Guest thread scheduling: priorities, slices, races

`src/core/sched.js` (`Scheduler.pickRunnable`, `markReady`), `src/core/vm.js` (`runThread`). Guest threads are green
threads on one worker (DECISIONS D003): a thread runs until it blocks, yields (Sleep, SwitchToThread, a parked wait),
or uses up its time slice (`vm.sliceInsns`, 100 000 instructions by default), then the scheduler picks the next one.

## Priorities (Windows semantics)

Until 2026-10 the pick was pure round robin: `SetThreadPriority` was recorded and ignored. That is not what a Windows
program is written against. On Windows the highest-priority ready thread runs; a `THREAD_PRIORITY_TIME_CRITICAL` thread
(the usual priority of an audio mixer / streaming service thread) that wakes up preempts normal threads and keeps the
processor until it waits again. Programs depend on that, often without knowing it: a short update done by such a thread
is, in practice, never observed half done by a normal-priority thread on a single processor, so the shared structures
it touches are sometimes left without a lock, or with a lock taken in a different order.

With round robin, the time-critical thread was interrupted at the end of its slice in the middle of its update, and
normal threads then ran whole slices against the half-updated structures. A race window that is a few microseconds wide
on Windows became tens of milliseconds wide.

`pickRunnable(except, top)` now:

- takes the runnable thread with the highest `thread.priority` (the value `SetThreadPriority` stored, -15 .. 15);
- among threads of equal priority, rotates (round robin, starting after the last thread picked) — at the end of a
  quantum only (below);
- gives a thread that has been ready while `STARVE_INSNS` guest instructions ran (6 M, ~20 ms here; it was 20 ms of
  clock time until 2026-10-04, see "The quantum") or `STARVE_PICKS` (1 000 picks) the top priority for one pick.
  Windows' balance-set manager also boosts starved threads; without it a program that polls with `Sleep(0)` for a
  lower-priority thread would spin forever. Both counts are needed: threads that only yield execute few instructions.

Known cost (review, 2026-10-04): a raised thread that stays runnable without blocking now gets ~20 ms of slices for
each slice of the lower threads. A test program whose `THREAD_PRIORITY_HIGHEST` thread spins (no API call) until a
normal thread finishes 3 M loop iterations took 492 M guest instructions / 2.5 s of virtual time with priorities, 24 M /
0.12 s with round robin (20x). Orthros reports one processor (`NumberOfProcessors` = 1), and on a uniprocessor Windows
the worker would starve far longer (balance-set boost every few seconds), so this is still within Windows semantics; but
programs tested only on multi-core machines, where that worker ran on another core, may load or stream slower. A
program spinning with `Sleep(0)` / `SwitchToThread` is not affected as much (`STARVE_PICKS`). If such a case shows up,
the lever is `STARVE_INSNS` (or `ORTHROS_SCHED_ROUND_ROBIN=1` to confirm).

## The quantum (2026-10-04)

Windows rotates threads of equal priority at the end of a quantum — about two clock ticks (~31 ms) of processor time on
a client system — and a thread preempted by a higher priority goes back to the head of its queue with what was left of
its quantum. Orthros rotated at the end of every time slice (100 000 instructions, a few hundred microseconds), and
measured starvation in clock time (wall time in the browser): a thread of the game's audio manager, doing short updates
between `Sleep(1)` calls, was interrupted by the main thread — and the main thread by it — hundreds of times more often
than on Windows, at arbitrary instructions; and when the host descheduled the emulator for a few milliseconds (a loaded
machine) the guest clock jumped in the middle of a few instructions and the starvation boost moved a thread at that
point. That is why the failure rate of BFME1 below followed the machine's load.

Now (`sched.js` `QUANTUM_INSNS`, `Vm.sliceEnd` sets `sliceExpired`): when a slice ends on its budget the top-level pick
keeps the same thread while no ready thread has a higher priority (a starved one counts as higher) and its quantum —
6 M guest instructions, `QUANTUM_INSNS` = `STARVE_INSNS`, ~20 ms at this emulator's speed — is not used up; a thread
preempted by a higher priority resumes first among its equals with the instructions it had left. Counting instructions,
not time, makes the points where threads are interrupted independent of the host's load (a quantum is processor time).
Slices stay as they were (100 000 instructions): they are when the scheduler looks for threads to wake and for higher
priorities, which preempt at the next slice end as before. Yields and waits end the quantum. Nested waits (inside a
callback) still rotate at every slice. `?dbg=ORTHROS_QUANTUM_INSNS=0` restores the rotation at every slice;
`ORTHROS_STARVE_INSNS`, `ORTHROS_STARVE_PICKS` set the starvation thresholds.

Tests: `tests/sched-priority.test.js` (the quantum kept, used up, preempted and resumed with what was left, the clock
alone changing nothing); `sync.exe`'s handshake bound raised (its worker runs once main has used its quantum).

SetThreadPriority now rejects values outside -15..15 (`ERROR_INVALID_PARAMETER`) and accepts
`THREAD_MODE_BACKGROUND_BEGIN` / `END` for the calling thread without a level change: before, any value was stored, and
0x10000 would have outranked every thread, starvation boost included.

Preemption is not modelled. Windows preempts the running thread as soon as a higher-priority thread becomes ready;
here threads switch only between slices, at yields and at blocking API calls. One attempt was tried and reverted
(commits 2c630a7 / 4b8f6a7). It capped slices at 20 000 instructions while a higher-priority thread existed and
yielded on wake of a higher-priority thread. It measured no improvement on BFME1 (see below) and cost ~3-4 % frames.

`markReady(t)` stamps `readyTime` / `readyPick` whenever a thread becomes ready (wake, end of slice, yield, ResumeThread,
CreateThread). `?dbg=ORTHROS_SCHED_ROUND_ROBIN=1` (or `vm.sched.roundRobin = true`) restores the old behaviour, for A/B.

Tests: `tests/sched-priority.test.js` (unit test of the pick; `tools/pe/priority.c`: a TIME_CRITICAL thread's work
spanning several slices is never seen half done by a normal spinner — with round robin it is — and an IDLE-priority
thread polled by main with `Sleep(0)` still runs).

## The timer resolution (2026-10-04)

`src/core/timer-res.js`, `Scheduler.wait(..., tick)`. Windows checks timer expirations at its clock interrupt, every
15.625 ms by default and every `p` ms while a program holds `timeBeginPeriod(p)` (the smallest request wins). Orthros
woke threads at the exact millisecond and ran both tick counters in 1 ms steps. Now:

- a guest timeout (Sleep, WaitForSingleObject(Ex), WaitForMultipleObjects(Ex), MsgWaitForMultipleObjects(Ex), blocking
  sockets) ends at the first interrupt at or after it: Sleep(1) lasts one tick (15.6 ms) at the default resolution and 1-2
  ms under `timeBeginPeriod(1)`; a timeout of 0 still polls; the emulator's own short waits (file reads, the Sleep(0)
  storm throttle — whose re-executed call keeps its streak, docs/api-layer.md "Sleep(0)" —, the multimedia timer thread, which keeps the precision timeSetEvent asks for) stay exact;
- GetTickCount(64), the message time (GetMessageTime, MSG.time) and DirectInput's `dwTimeStamp` step by the 15.625 ms
  tick (15 or 16 ms) whatever the resolution; timeGetTime and timeGetSystemTime by the current interrupt period;
- `timeBeginPeriod` / `timeEndPeriod` are counted per period (TIMERR_NOCANDO for 0, or for an end without its begin);
- SetTimer's timers (`WM_TIMER`) fall due at the interrupt too (SetTimer(10) fires every 15.6 ms by default);
- the JIT's fast paths give the same values (GetTickCount has its own id, 28: `env.tickCount`; timeGetTime 19:
  `env.mmTime`).

DirectInput's buffered events carried the clock without GetTickCount's base (`TICK_BASE`): a program comparing an
event's time with GetTickCount saw it 4.6 hours old. They now carry GetTickCount's value.

BFME1, BFME2 and RotWK call `timeBeginPeriod(1)` at startup (1 ms resolution: their Sleep(1) loops now wake after 1-2 ms
instead of exactly 1 ms; their tick counts, read ~1 M times in the skirmish-setup scenario, now step by 15.6 ms); Vice
City does not (default resolution). Frames, Node, same tree, `ORTHROS_TIMER_RES=0` (the old behaviour) / default,
alternated pairs: BFME2 play 3568 / 3562 against 3580 / 3580 frames in 120 s; Vice City startup load 8.1 / 11.3 / 8.2 s
against 8.1 / 10.9 / 8.2 s, play 1749 / 1742 / 1755 against 1742 / 1749 / 1750 frames in 60 s; BFME1 menu (40 runs
each) mean 1524 against 1533 frames in 80 s. `?dbg=ORTHROS_TIMER_RES=<ms>` sets the default resolution (0: no rounding).

Tests: `tests/timer-res.test.js` (requests, ticks, the counters; the scheduler's guest and own waits; the handlers:
GetTickCount, timeGetTime, timeBeginPeriod / timeEndPeriod, Sleep and WaitForSingleObject timeouts, SetTimer),
`tests/jit-fast-time.test.js` (the fast paths' values).

## Nested guest code and the shared call context

An API handler that calls guest code (EnumWindows, a window procedure, a COM callback) may re-read its arguments after
the callback. `runThread` nested inside a handler (`depth > 0`) now saves and restores the shared context
(`ctx.thread`, `cpu`, `sp`, `def`): before, a thread switch inside the nested run left the context pointing at another
thread, and the handler read that thread's arguments. `tools/pe/syncstress.c` / `tests/syncstress.test.js` exercise it
together with critical sections, mutexes (infinite and timed waits), a spin lock and parked file reads, at slice sizes
100 000, 997 and 41.

## Parked file reads

`ioWait` (kernel32-file.js): a ReadFile re-executed after waiting for another thread's parked read of the same file
consumed its recorded wake result and went on, even when a third thread had parked a new read of that file meanwhile.
It now consumes the result and looks at the file's owner again.

## Short sleeps and the browser's timer clamp (2026-10-21)

When every guest thread waits more than 2 ms, `Vm.runFor` returns 'sleep' and the worker arms a timer for the next pump
(src/host/web/worker.js `schedulePump`). The HTML timer nesting clamp makes a `setTimeout` armed from a timer
callback, five deep, last at least 4 ms: a chain of short sleeps (every pump returning 'sleep') overslept by 1-3 ms each.
A pump run by its timer that sleeps again for less than 5 ms now arms the next timer from a message task (one
MessageChannel hop, ~4 µs), where the clamp does not apply. `tools/timer-clamp-check.mjs` (Chromium worker, 200
sleeps each): 1/2/3 ms sleeps re-armed from the timer callback oversleep 3.07/2.07/1.07 ms; through the hop they fire
0.8-0.9 ms early on average (setTimeout truncates the fractional delay; runFor waits the rest), p99 +0.08 ms. BFME1
play is not affected (its pump never returns 'sleep': the 1 ms waits happen inside runFor). `ORTHROS_TIMER_HOP=0`: the
timer armed directly.

## Yields: Sleep(0) and SwitchToThread hand over (2026-10-22)

`Scheduler.yieldFrom`. Sleep(0) gives the rest of the time slice to another ready thread of at least the caller's
priority (a lower one waits, as on Windows); SwitchToThread to any ready thread. Until 2026-10-22 the check "is another
thread ready?" was itself a pick (`pickRunnable(thread)`): it moved the round robin past the thread it found, so the
top-level pick that followed the yield started after that thread, found the yielder first among its equals and took it
again. The ready thread waited until it was starved (STARVE_PICKS = 1 000 picks, ~1 000 of the spinner's Sleep(0)).
BFME 1.08 shows it: its main thread paces frames with Sleep(0) + timeGetTime, and a thread of equal priority that wakes
from its Sleep(1) every millisecond was kept waiting through runs of ~250 Sleep(0) (`startbench --api-seq`: `t2048 Sleep
[+1 fast timer] x249`); the Sleep(0) throttle (docs/api-layer.md) never engaged, since a thread was ready all along.

Now the yield sets `Scheduler.yielder` and the next top-level pick prefers any other ready thread of a priority at least
the yielder's (`yieldAny`, SwitchToThread: of any priority); the yielder goes on only when there is none. The probes that
only ask whether a thread is ready (PeekMessage's idle wait) use `hasRunnable`; the yield and the Sleep(0) throttle use
`hasYieldTarget` (a thread the yield would run: of at least the caller's priority, or starved — since 2026-10-22, see
docs/api-layer.md "Only a lower priority ready"); both change nothing (no round-robin move, no scheduling decision counted). `?dbg=ORTHROS_YIELD_PICK_OLD=1`: the former
pick (read at each yield: in-session A/B).

Measured, BFME 1.08 play in Node (`startbench --input` of the 1.08 scenario with `dbg:ORTHROS_YIELD_PICK_OLD=1` / `=`
alternated every 19 s, ten windows each, two runs at the same time; the vertex buffer lock change below in both arms):
scheduling decisions per frame 1 019-1 088 → 261-263, main thread Sleep(0) per frame 324 → 146 (`--sleeps`), work per
frame p50 14.5-14.8 → 13.7-13.9 ms and p90 19.1-19.7 → 18.0-18.5 ms, emulator thread CPU per frame 14.97-15.28 →
14.50-14.70 ms; frames over 40 ms unchanged (100 / 97 and 90 / 90 in 190 s): those are frames where the main thread itself
runs 3x its usual guest instructions (12.9 M against 4.1 M, `--threads --slow-threads 40`), the game's own heavy frames.
Headless Chromium, the ten minutes of play (`--gl-discard`, run beside the former tree at the same time): scheduling
decisions per frame 1 233 → 272, work p50 14.9 → 14.1 ms, p90 21.5 → 19.7, p99 31.4 → 29.5, frames over 40 ms 22 → 21
per minute.

Tests: `tests/sched-priority.test.js` (every round-robin position: the equal-priority ready thread runs; with
`ORTHROS_YIELD_PICK_OLD` the yielder is taken again; a lower priority waits for Sleep(0), runs for SwitchToThread;
`hasRunnable` changes nothing).

## Host wake-up overshoot: frame pacing on Windows (2026-10-22)

`src/core/host-wait.js` (`HostWaiter`, `hostWaiter`), used by `BrowserHost.waitEvent`, `RealClock.sleep` and the
worker's pump timer (`armTimer`); pacing loops noted by kernel32's `Sleep` (`paceStep` / `paceWoke`).

**What the owner measured.** BFME1 1.08 on a Windows laptop (Chrome 154, Iris Xe, 20 threads): menu 26.8 fps, frame
p50 35.4 / p90 46.8 / p99 52.8 ms, 431 frames > 40 ms per minute, while the work per frame was p50 9.6 / p90 13.5 ms
of a 33 ms budget and the GPU p99 19 ms. Mean ms per frame: wait 27.2, guest 6.4, api 2.2, late 0.5, draw 0.5.

**Where the time goes.** The game's main loop (`lotrbfme.exe` 0x46bf50-0x46bf69, read with Orthros' decoder) is a
frame limiter without catch-up: `do { Sleep(0); t = timeGetTime(); } while (t - last < period); last = t;` — the next
period counts from when the loop ended, so any lateness of its last wake-up lengthens that frame and is never given back.
After 32 back-to-back `Sleep(0)` the throttle (docs/api-layer.md) parks the thread 1 ms; with every other thread
waiting too, `Vm.runFor` (delay ≤ 2 ms: it does not return to the event loop) calls `Scheduler.idle` →
`BrowserHost.waitEvent(≈1 ms)` → `Atomics.wait(1 ms)`. On Linux Chrome that wakes 0.05-0.1 ms late. On Windows it is
a condition-variable wait on the system timer: Chromium rounds the timeout up to whole milliseconds, and the wait ends
at a timer interrupt — every 15.625 ms by default, ~1 ms while some code of the process holds a 1 ms resolution
(Chrome raises it for short pending timers on mains power and drops it on battery). So one `Sleep(0)` park can last
up to ~16 ms, and the park that crosses the limiter's deadline makes the frame up to ~16 ms late: frames at 3 ticks =
46.9 ms whenever the timer is coarse — the owner's p90 46.8 — and ~33-36 ms while it is fine (p50 35.4: the resolution
changed during the run). Mean frame 37.3 ms = 33.3 + ~4 ms of oversleep per frame.

**Why `late` did not show it.** `late` was only measured between two pumps (`gapBegin` / `gapEnd` in worker.js: the
pump's setTimeout came back later than planned). BFME1's pump never returns 'sleep' — its waits are all ≤ 2 ms, done
inside `runFor` by `waitEvent` — and `waitEvent` charged the whole Atomics.wait, oversleep included, to `wait` (pacing).
Now a host wait that ends after its deadline moves the lateness to `late` — except a pacing loop's earlier waits
(`earlyPacingWait`: waking them late only shortens the polling, the frame is not longer; counting them made a precise
Linux host show 2.5-3.3 ms of `late` per frame from ~37 waits × 0.07 ms).

**Reproduced here.** `?dbg=ORTHROS_HOST_TIMER_Q=<ms>` (Node: `--dbg`, or `dbg:` scenario steps) injects such a timer:
every host wait (Atomics.wait in `HostWaiter.hostWait`, the pump's setTimeout) asked for t ms is rounded up to whole
milliseconds and ends at the first multiple of the quantum (performance.now() time base) at or after that. With 15.625
the BFME1 menu went from p50 33 / p90 35 to p50 42.5-45.8 / p90 46.6-48.7 ms (below), the owner's distribution.

**The fix.** `HostWaiter.waitUntil(deadline)`:
- measures the overshoot of its own host waits (`est`: the second largest of the last 16 — a garbage collection does
  not raise it, a coarse timer does at once) and, for a deadline further than that, asks the host for the time left
  minus the estimate, then waits the rest again (free: no spin);
- spins on `performance.now()` only for a pacing loop's last waits — `lastPacingWait`: the wait ends after the loop's
  predicted end minus the estimate — and only within 2 ms of the deadline (`SPIN_MAX_MS`); any other wait the host
  would wake late (a background thread's `Sleep(1)`, the Miles thread's 5 ms waits) is a plain host wait, its lateness
  accepted; an overshoot under 0.25 ms (`TOLERATE_MS`) is always accepted: on a precise host nothing changes;
- pacing loops (kernel32 `paceStep`): a thread's short sleeps — `Sleep(0)`, `Sleep(1)`, `Sleep(2)` — with at most two
  of its own other API calls between the end of one and the next (timeGetTime is often on the JIT's fast path, not
  counted at all) form a loop; it ends where the thread does more (a frame renders: hundreds of calls). The loop's end
  is the wake-up of its last sleep; the next end is the last one plus the period, the second shortest of the last 8
  end-to-end intervals (`pacePredict`; a late frame lengthens one interval, a spurious short loop shortens one; a
  pause over 1 s starts again; no prediction once 4 ms past it). The predicted end goes to `hostWaiter.pace` (host time).
- the pump's timer (`armTimer`) is armed earlier by the timers' measured overshoot when that would make it late
  (`timerArm`); the rest is waited inside the pump.

The guest still wakes at or after its deadline: its clock is `performance.now()`, `Sleep`, `timeGetTime` and
`QueryPerformanceCounter` are untouched; only the host's lateness is taken out of the loop's last wait. On Windows the
game's own loop spins anyway (`Sleep(0)` returns at once there): spinning its last few milliseconds is what native does.

**Measured** (BFME1 1.08 menu, warm profile, 20 s per arm in one session, `dbg:` switches alternated):

Node (`startbench bfme1-108 --bg --input <menu A/B>`; CPU: the emulator thread's CPU time per 20 s):

| arm | fps | frame p50 / p90 / p99 ms | > 40 ms per min | spin ms/frame | thread CPU s |
|---|---|---|---|---|---|
| no injection, adaptive off | 30.2 | 33.0 / 35.8 / 41.1 | 27 | 0 | 7.7 |
| no injection, adaptive on | 30.2 | 33.0 / 35.6 / 40.6 | 21 | 0 | 8.0 |
| 15.625 ms timer, off | 23.7 / 24.1 | 45.6-45.8 / 47.8-48.7 / 52.0-52.2 | 948-987 | 0 | 6.3 / 6.8 |
| 15.625 ms timer, on | 30.3 | 32.9-33.0 / 34.9-35.0 / 37.2 | 0-3 | 7.8-8.0 | 10.7 / 10.8 |
| 1 ms timer, off | 29.9 | 33.5 / 36.9 / 40.8 | 27 | 0 | 7.8 |
| 1 ms timer, on | 30.2 | 32.9 / 35.2 / 38.6 | 15 | 2.1 | 10.1 |

Headless Chromium (`tools/headless.mjs bfme1-108 --gl-discard --profile-dir <warm> --input-file <menu A/B>`):

| arm | fps | frame p50 / p90 / p99 ms | > 40 ms per min | mean `late` ms/frame | spin ms/frame |
|---|---|---|---|---|---|
| no injection, off / on | 30.2 / 30.2 | 33.1 / 35.0 / 37.7 — 33.1 / 34.7 / 36.5 | 18 / 9 | 0.3 / 0.3 | 0 / 0 |
| 15.625 ms timer, off | 25.5 | 42.5 / 46.6 / 48.6 | 774 | 8.7 | 0 |
| 15.625 ms timer, on | 30.2 | 33.0 / 34.3 / 36.1 | 3 | 0.2 | 7.4 |
| 1 ms timer, off | 30.0 | 33.3 / 35.0 / 36.5 | 3 | 1.6 | 0 |
| 1 ms timer, on | 30.3 | 32.9 / 34.5 / 36.2 | 0 | 0.1 | 1.7 |

CPU cost: on a precise host none (no spin). On a 15.625 ms timer the emulator thread's CPU per frame goes from ~13 to
~17.7 ms (0.39 → 0.54 of a core: the limiter's last ~8 ms spun instead of overslept); on a 1 ms timer ~2 ms of spin per
frame. Without the fix that time is not idle anyway on the owner's machine: it is the frame's lateness.

**What only a Windows machine can confirm**: which timer the owner's Chrome gives a worker (the bench's timing probe,
docs/real-machine-bench.md, measures it at the start and at each mark, with the battery state), and that the frame
p90 falls back to ~35 ms there. Loads under the injected 15.625 ms timer also showed 20-60 ms of `late` per frame (the
loader's and the reads' waits, not a pacing loop: not spun); whether the owner's slow LOAD / START phases have part
of their waits there is for the next bench run's `late` to tell.

Tests: `tests/host-wait.test.js` (the quantum, the estimate, the waits on a fake coarse and precise host, the pacing
prediction, the timer arming, the summaries' and phases' fields, the probe; `tools/pe/pacing.c` — a limiter without
catch-up — on an injected 15.625 ms timer: frame p50 46.9 ms adaptive off, 33.3 on). `ORTHROS_PACE_LOG=1` logs each
loop's end against its prediction (`[timer]` lines).

## Debug switches (`?dbg=NAME=1,...` in the browser, globals in Node)

| switch | what |
|---|---|
| `ORTHROS_SCHED_ROUND_ROBIN` | ignore thread priorities (the old scheduler) |
| `ORTHROS_QUANTUM_INSNS=n` | the quantum in guest instructions (0: rotation at every slice, as before 2026-10-04) |
| `ORTHROS_STARVE_INSNS=n`, `ORTHROS_STARVE_PICKS=n` | starvation thresholds |
| `ORTHROS_TIMER_RES=ms` | the default timer resolution (15.625; 0: timeouts and tick counts exact, as before 2026-10-04) |
| `ORTHROS_NULL_READS` | reads of the null page fault too (docs/null-page.md; writes always do) |
| `ORTHROS_NULL_PAGE_OPEN` | the null page readable and writable (the behaviour before 2026-10-04) |
| `ORTHROS_API_TAIL=n` | the main thread's last n API calls with arguments and results, in crash reports |
| `ORTHROS_SLICE_INSNS=n` | time slice in instructions (default 100 000) — smaller slices widen race windows |
| `ORTHROS_NULL_WATCH` | report (crash report, all threads) the first guest writes to the 64 KB null page (now a fault anyway: docs/null-page.md) |
| `ORTHROS_HEAP_PROV` | record which call allocated / freed each heap block; crash reports show the provenance of blocks registers point into |
| `ORTHROS_RELEASE_WATCH` | released virtual memory and COM objects are quarantined (not reused), so a use after release is reported |
| `ORTHROS_WRITE_CHECK` | bulk writes by API handlers (file reads, surfaces, fills, copies) checked: into a quarantined region, or past the end of their allocation |
| `ORTHROS_TRACE_EIP=<hex>[;<hex>]` + `ORTHROS_INTERP_RANGES` | each arrival at those addresses (inside the interpreted ranges) recorded with the guest clock, thread, return addresses and first argument; the last 256 shown in crash reports (the ranges are kept out of prewarm). `<hex>@<reg>[+<off>]` keys the record by a register plus an offset instead of the first argument (a pointer being returned); crash reports list the records of every key the registers and stack hold, `ORTHROS_TRACE_DEPTH=n` of them per key (default 3) |
| `ORTHROS_PEEK=<hex>[:<len>\|:c<n>];...` | in crash reports and at the end of Node bench runs: the instructions before and from (`n`, default 8) an address in a module, or `len` bytes of memory elsewhere (a flag or a function pointer the code around a crash reads) |
| `ORTHROS_READ_DEST_CHECK` | warn when a parked read's destination buffer changes while the read waits |
| `ORTHROS_READ_SLICE_MS=n` | slice length while a file read is on the network (default 2: the pump and `runFor` end slices early so the read completes; 12: the behaviour before 2026-10-06; docs/startup.md) |
| `ORTHROS_GDI_BITMAP_FONTS` | GDI text with the built-in bitmap font only |
| `ORTHROS_SLEEP0_KEEP_STREAK=0` | the Sleep(0) throttle's streak reset by the throttled sleep itself (the behaviour before 2026-10-21) |
| `ORTHROS_SLEEP0_ANY_READY=1` | any ready thread (a lower priority too) keeps the Sleep(0) throttle off, and a Sleep(0) yield reports one (the behaviour before 2026-10-22) |
| `ORTHROS_TIMER_HOP=0` | the worker's short-sleep timer armed from the timer callback (the nesting clamp applies; before 2026-10-21) |
| `ORTHROS_YIELD_PICK_OLD=1` | a yield's check for a ready thread is a pick again, and the yielder may be taken back at once (before 2026-10-22) |
| `ORTHROS_HOST_TIMER_Q=ms` | inject a coarse host timer: every host wait (Atomics.wait, the pump's setTimeout) rounded up to whole ms, then to the next multiple of `ms` (15.625: Windows' default tick; 1: a 1 ms resolution) — "Host wake-up overshoot" |
| `ORTHROS_ADAPTIVE_SLEEP=0` | plain host waits: no early wake-up, no spin for a frame limiter's last waits (before 2026-10-22) |
| `ORTHROS_PACE_LOG=1` | each pacing loop's end logged (`timer` log) against its prediction |

Crash reports also show the instructions before each return address and 128 bytes around each register, with the
region and heap block (and its provenance) it points into.

## The BFME1 investigation (2026-10-03/04)

Symptom: in about 1 run in 5 to 1 in 20 depending on the load, ~150 s after the click opening the skirmish setup, a
call through a null / garbage function pointer on the main thread, or the loader thread spinning while holding a mutex
the main thread waits for. With `ORTHROS_NULL_WATCH`, the first anomaly in every failing run is a write to address 0 by
the main thread, in the program's own small-block allocator, while freeing a block that was already free (a 68-byte
record of audio format data), during the click; later failures cascade from the corrupted allocator. In every failing
run's thread list the program's TIME_CRITICAL audio service thread was READY — preempted at the end of its slice —
inside its audio update. Ruled out along the way (no hit in clean or failing runs): mutex / critical-section /
Interlocked semantics (syncstress), file data (`ORTHROS_VERIFY_READS`), parked-read destinations, released memory and
COM objects, stack overflow, writes by JS outside allocated regions.

Before / after (2026-10-04, headless Chromium, `--glworker 1 --gl-discard --timescale 1.5`, 180 s runs from the warm
profile, skirmish-setup click at ~150 s, `ORTHROS_SLICE_INSNS=20000,ORTHROS_NULL_WATCH=1`, the two arms run at the same
time, side by side, from the same tree):

| arm | runs | failures | first anomaly | mean frames of clean runs |
|---|---|---|---|---|
| `ORTHROS_SCHED_ROUND_ROBIN=1` (old scheduler) | 40 | 6 (3 calls through 0, from +0x1885e0 twice and +0x5c5a31; 1 exception with no stack to dispatch it on; 1 other crash, then the game exits with 666; 1 hang, then the renderer crashes) | every one: the main thread's null-page write at the double free, during the click | 3219 |
| priorities (this change) | 40 | 0 | no null-page write in any run | 3284 |

(Fisher exact test, one-sided: p ≈ 0.012.)

**The fix is partial.** At the default slice (100 000 instructions), with priorities: 2 failures in 50 runs (25 with
and 25 without the render worker). Both have the same signature: the main thread's null-page write at the double
free. In both, the audio thread was blocked in its timed wait, not interrupted mid-work. With the reverted preemption
attempt: 2 failures in 32 runs, same signature, audio thread again blocked. Earlier, with round robin at the default
slice: about 10 failures in ~175 runs (5-10 % depending on the machine load). So at the default slice, no reduction
is measured.

Review re-run (2026-10-04 05:45-06:45, same scenarios — slow / fast click alternated — same tree with priorities, two
runs at a time, load 12-16): at `ORTHROS_SLICE_INSNS=20000` with the render worker, **1 failure in 18 runs** (P-12:
the same null-page write at the double free, then an out-of-bounds fault on the Miles mixer thread; the audio thread
was *blocked* in its event wait at the double free, not cut off mid-work); at the default slice without the render
worker, **2 failures in 16 runs** (D-7, D-13: same null-page write). So the 0/40 above does not hold up: combined with
it, 1/58 with priorities against 6/40 with round robin at 20 000-instruction slices (still a reduction, p ≈ 0.02), and
no reduction at the default slice (4/66 with priorities over both sessions, against ~5-10 % before). The audio thread
being cut off mid-update is not the cause of the remaining failures. bfme2 and rotwk-202 reach their menus with
priorities (one run each).

Priorities remove one way to reach the double free: a high-priority thread cut off mid-update, which short slices make
frequent. Another cause remains, not yet found. Next leads:
- which code freed the 68-byte record first: a trace of the program allocator's free entry, `ORTHROS_TRACE_EIP`. In
  the browser runs so far it recorded nothing; check why;
- whether the main thread's parked ReadFile from msvcr71, ~80 ms just before the click in every run, matters;
- an abandoned mutex (0x9dc, left by an exited Miles thread).

### Follow-up (2026-10-04): the null page, the quantum

**Null-page faults** (docs/null-page.md): stores into the first 64 KiB now raise the access violation Windows raises. The
first anomaly of a failing run is now a fault at that store (`lotrbfme.exe+0x882c67`, the program allocator unlinking a
block whose links are garbage), on which the game's crash handler ends the process (exit through its dialog) — earlier
and clearer than the calls through garbage pointers that followed before.

**Reproduced in Node.** `tools/startbench.mjs bfme-vanilla --input tools/scenarios/bfme-skirmish-setup.txt` from the
warm profile (menu, SOLO PLAY, SKIRMISH) fails like the browser — same faulting store, same stacks — in a few percent of
the runs at the default slice, more on a loaded machine, and in 12-25 % with `ORTHROS_SLICE_INSNS=20000` / `5000`
(amplifiers: more points where threads are interrupted). Tens of runs in parallel, no browser slot.

**What is freed twice.** With `ORTHROS_TRACE_EIP` on the program's `free` wrapper (its address from the crash report's
"code before return address" — the instructions around the crash) and `ORTHROS_INTERP_RANGES` covering it, a failing
run shows the block's history: the main thread freed it through one path (an owner of the block at the time), then,
later, a reference-counted string's destructor on the main thread released it again — the string still pointed at data
whose count had already reached zero (in another failing run the free list held "THRO", the profile name's letters,
written into the freed block). The same string functions run on the main thread, on the game's audio-manager thread
(normal priority, a `Sleep(1)` loop) and on the Miles service thread (TIME_CRITICAL, game callbacks): a count updated
by two threads around a moment where one of them is interrupted. Such a race exists on Windows too; how often it is hit
depends on where and how often threads are interrupted.

**The quantum** (above) made those points Windows-like for threads of equal priority and independent of the host's load.
Node runs of the scenario, the tree before (983ac2e) and after, run side by side:

| slices | before | after |
|---|---|---|
| 20 000 instructions | 2 / 16 | 0 / 16 |
| 5 000 instructions | 4 / 20 | 0 / 20 |
| default (100 000) | 1 / 30 | 1 / 30 |

(amplified: 6/36 against 0/36, one-sided Fisher p = 0.012). At the default slice the rate is too low in Node to tell
the difference. Remaining: the Miles service thread wakes every 5 ms of real time and preempts at any point, as on
Windows, but the emulated game runs several times slower than on the hardware it was written for, so a given window of
the main thread is hit proportionally more often — not something a scheduler can make faithful without slowing time.

Other games with the quantum (Node, same scenarios, before / after): BFME2's play 3569 / 3569 frames in 120 s, guest
3.54 / 3.65 ns per instruction, API time 31.7 / 27.0 s; Vice City's drive 656 / 654 frames, 3.74 / 3.64 ns. RotWK's play
3.57-3.74 ns per instruction in both.

### Follow-up 2 (2026-10-04 evening): what the traces show; what was tried

**Node at the default settings, main against this branch** (`tools/startbench.mjs bfme-vanilla --input
tools/scenarios/bfme-skirmish-setup.txt` from the warm profile, the two trees' runs interleaved six at a time): main
(5d528a8, `ORTHROS_NULL_WATCH=1`) **4 / 40**, this branch **4 / 40** — every failure the same release from the same frame
(`lotrbfme.exe+0x888237 < +0x9fc4e < +0x57d1dd`, the skirmish-setup click). Headless Chromium at the default settings
(`--gl-discard --timescale 1.5`, the render worker, 290 s, the same click, two at a time, alternated main / branch, load
5-30): main (with `ORTHROS_NULL_WATCH=1`) **0 / 35**, this branch **0 / 35** (frames per run: mean 6 386 / 6 606). In the
browser the failure has become rare in both trees since the morning's 4 / 66 with priorities — no difference to measure
there either. The quantum
and the instruction-counted starvation lowered the rate only where slices were made short on purpose (above); at the
default settings neither tree fails less.

**The stale reference.** The program allocator's entry points traced (`ORTHROS_TRACE_EIP` on its free entry, on its two
allocation paths keyed by the block returned, `@ebx+c` / `@esi+4`, and on the reference-count decrement of the release
that faults, keyed by `@eax`; guest clock in every record). In each failing run, the function of the click releases a
reference-counted block that was already freed, through a reference it took from somewhere else:

- a block of a periodically rebuilt object (allocated and freed every 2-3 s on the main thread for minutes) was freed
  by its owner at t = 233 275 ms; the click's object was allocated 39 ms later and released the freed block 110 ms
  after the free — the free list's link inside it already overwritten by the profile name's letters ("THRO");
- in other runs the freed block had been, in between, allocated by an audio path and freed again — by the main
  thread, the game's audio-manager thread or the Miles thread (the block's previous owners vary).

So the click's code copies a reference whose count had already reached zero: a reference held without a count somewhere
in the program. In the runs traced the free and the stale copy happen on the main thread (no other thread involved
between them); the interleaving with other threads only decides which object last reused the memory.

**Tried, no effect, reverted or not kept:**

| experiment (Node, same scenario) | failures |
|---|---|
| 983ac2e (null page, priorities, starvation in wall time), 5 000-instruction slices | 2 / 16, 2 / 16 (traced), 2 / 20 |
| same + a thread holding a critical section not interrupted at the end of its slice (TEB.CountOfOwnedCriticalSections kept by kernel32 and the JIT's inline paths, slice extended by 2 000 instructions up to 100 000) | 1 / 20 |
| this branch, `ORTHROS_QUANTUM_INSNS=0` (rotation at every slice), 5 000-instruction slices | 0 / 12 |
| this branch, default settings, another session (load 23-30) | 0 / 24 |
| this branch, guest clock 3 times faster (`--timescale 3`: sounds, timers and Sleep 3 times shorter against the work done) | 1 / 16 |
| this branch, guest clock at half speed (`--timescale 0.5`: the machine looks twice as fast to the game) | 0 / 18, 2 / 25 |
| this branch, allocator and string code interpreted for tracing | 0 / 18 (wide ranges), 1 / 24 (narrow) |

The rate moves between sessions as much as between variants (this branch: 4 / 40, then 0 / 24): none of these
knobs — slice length, rotation among equals, the guest clock's speed against the work, critical sections held across
slices — changes it beyond that spread. The lock-holder extension (on the multi-core machines a critical section is held for microseconds; a green thread
interrupted inside one keeps it while the others run) did not change the rate: 7 451 of 465 740 slices were extended in
150 s, 1 763 of them reached the bound with a section still held. It was reverted.

### Follow-up 3 (2026-10-04 night): emulator differences looked for

Question: what in the emulator could make the stale block be reused (or freed) where Windows would not. Looked at
through Orthros' own traces only (`startbench --api-hist`, the `timer` log, crash reports); every run below is
`tools/startbench.mjs bfme-vanilla --input tools/scenarios/bfme-skirmish-setup.txt` from the warm profile, eight at a
time, the two arms alternated within each batch; a failure is the main thread's access violation at
`lotrbfme.exe+0x882c67` (the program allocator unlinking a block whose links are garbage), the same signature in every
failing run.

| what | finding / change | runs (A / B) |
|---|---|---|
| timer resolution | Sleep / wait timeouts ended at the exact millisecond, GetTickCount and timeGetTime ran in 1 ms steps; Windows ends them at its clock interrupt (above, "The timer resolution"). BFME1 calls `timeBeginPeriod(1)` (Miles), so its Sleep(1) loops now wake after 1-2 ms instead of 1 ms, and GetTickCount (~0.8 M reads in the scenario, timeGetTime ~1 M) steps by 15.6 ms. Kept: closer to Windows, neutral for performance | default settings, A `ORTHROS_TIMER_RES=0` (old) / B new: **1 / 40** against **0 / 40**; menu frames 1524 / 1533 |
| DirectInput timestamps | buffered events carried the clock without GetTickCount's base: 4.6 hours older than GetTickCount for a program comparing them. Now GetTickCount's value. Kept | (with the line below) |
| the branch against main | timer resolution + DirectInput timestamps + message times | `ORTHROS_SLICE_INSNS=5000` (an amplifier earlier): main **1 / 40**, branch **2 / 40** |
| guest clock against the work | `--timescale 4` (the machine looks 4 times slower: ~4.7 frames per guest second in the menu) against `--timescale 0.25` (4 times faster: the game's frame cap, ~38 frames per guest second) | **0 / 40** against **0 / 40** |
| host stalls | `startbench --stall 50:400:130` (new tool option): the process stops 50 ms at one budget slice end in 400 from 130 s on (~600 stalls, ~30 s, around the click) — the guest clock jumps in the middle of a thread's work, as when the host deschedules the emulator | no stall **1 / 24**, stalls **0 / 24**; a load burst instead (`--stall 5:10:148`: 5 ms after one slice in 10 from 148 s, ~8 500 stalls, the work ~10 times slower around the click): **1 / 24** against **0 / 24** |
| deterministic replay | `--virtual --jitter <seed>` (time advances 0.5 ms per slice and with sleeps, random 1-40 ms jumps), seeds 1-64 | **0 / 64** |
| Win32 heap reuse | the game calls HeapAlloc directly (heap 0x30, HEAP_ZERO_MEMORY, ~0.27 M calls in 60 G instructions, sizes from 88 bytes up, all from lotrbfme.exe); the blocks freed twice are smaller and live in the program's own pool allocator (the fault is in its unlink), whose reuse the program decides. The Windows the game reports to (XP, 5.1.2600) reuses small blocks LIFO too (lookaside lists), as Orthros' heap does. Not changed | — |
| thread priorities | the main thread sets another thread to `THREAD_PRIORITY_BELOW_NORMAL` repeatedly (`SetThreadPriority(0x578, -1)`); Sleep(0) does not hand the processor to it (the pick takes the highest priority; it runs when starved), as on a single processor | — |

The rate on this machine that night was ~3 % (4 failures in 129 runs at the default settings — c1, c5 and c6 without
stalls, one single run —, 3 in 80 at 5 000-instruction slices), lower than the 5-10 % of the days before, and **no variant
changed it measurably**; with ~40 runs per arm only a
large effect (a rate several times higher) could have been seen. Two observations:

- three of the failures (c2A18 main, c2B19 and c2B20 branch) ended within the same two seconds, in the same batch of
  eight concurrent runs, while the 41 other batches had at most one (three of them one): something common to the machine at the time of the
  click (another project's load burst, I/O) rather than the tree. Artificial stalls at slice ends (above: 50 ms ones, or a
  burst slowing the work ten times around the click) did not reproduce it, so if the host matters it is not through the guest clock jumping in the middle of computation — a
  stall elsewhere (during file reads, the parked ReadFile of msvcr71 just before the click, the render/audio paths) is
  not excluded;
- the window is not proportional to the guest time of a frame: at `--timescale 4` a frame lasts ~8 times more guest
  milliseconds than at 0.25 and neither failed in 40 runs (with the window measured in guest milliseconds, ~4 times
  the default rate would have been expected at 4).

Not found: an emulator difference that makes the stale block reused. What remains consistent with every trace: the
program holds an uncounted reference to a block of an object it rebuilds every 2-3 s, and a click landing in a short
window after a rebuild copies it; the timing that opens that window has not been reproduced on purpose. Next leads:
the host stall during a parked file read (`--stall` restricted to the reads); more replay seeds (none of 64 failed: a
failing one would make the window measurable).
