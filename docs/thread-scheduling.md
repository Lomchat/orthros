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

## Debug switches (`?dbg=NAME=1,...` in the browser, globals in Node)

| switch | what |
|---|---|
| `ORTHROS_SCHED_ROUND_ROBIN` | ignore thread priorities (the old scheduler) |
| `ORTHROS_QUANTUM_INSNS=n` | the quantum in guest instructions (0: rotation at every slice, as before 2026-10-04) |
| `ORTHROS_STARVE_INSNS=n`, `ORTHROS_STARVE_PICKS=n` | starvation thresholds |
| `ORTHROS_NULL_READS` | reads of the null page fault too (docs/null-page.md; writes always do) |
| `ORTHROS_NULL_PAGE_OPEN` | the null page readable and writable (the behaviour before 2026-10-04) |
| `ORTHROS_API_TAIL=n` | the main thread's last n API calls with arguments and results, in crash reports |
| `ORTHROS_SLICE_INSNS=n` | time slice in instructions (default 100 000) — smaller slices widen race windows |
| `ORTHROS_NULL_WATCH` | report (crash report, all threads) the first guest writes to the 64 KB null page (now a fault anyway: docs/null-page.md) |
| `ORTHROS_HEAP_PROV` | record which call allocated / freed each heap block; crash reports show the provenance of blocks registers point into |
| `ORTHROS_RELEASE_WATCH` | released virtual memory and COM objects are quarantined (not reused), so a use after release is reported |
| `ORTHROS_WRITE_CHECK` | bulk writes by API handlers (file reads, surfaces, fills, copies) checked: into a quarantined region, or past the end of their allocation |
| `ORTHROS_TRACE_EIP=<hex>[;<hex>]` + `ORTHROS_INTERP_RANGES` | each arrival at those addresses (inside the interpreted ranges) recorded with thread, return addresses and first argument; the last 256 shown in crash reports (the ranges are kept out of prewarm) |
| `ORTHROS_READ_DEST_CHECK` | warn when a parked read's destination buffer changes while the read waits |
| `ORTHROS_GDI_BITMAP_FONTS` | GDI text with the built-in bitmap font only |

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
