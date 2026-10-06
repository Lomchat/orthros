# API layer and draw submission: what keeps them cheap

The JavaScript API layer (Win32 / Direct3D / D3DX handlers) and the Direct3D draw submission are the `api` and `draw`
categories of the frame accounting (docs/frame-accounting.md). This page lists the mechanisms that keep their cost per
frame down, all generic (no game-specific code), and how to switch them off within a session to measure them.

## Calls that never leave the translated code (src/cpu/jit/runtime.js, fastApi)

- **Pure D3DX math** (`fast-d3dx.js`): `D3DXMatrixInverse` and `D3DXVec{2,3,4}CatmullRom` for every `d3dx9_NN.dll`, in
  WASM with the JavaScript handlers' f64 operations in the same order (bit-exact results; only a NaN's sign and payload
  may differ, as they already do between the handler's interpreted and optimized runs). Test: `jit-fast-d3dx.test.js`.
- **`ID3DXEffect::GetParameterDesc`** (`FID_PARAM_DESC`): the handler keeps the 44-byte description of a parameter asked by
  handle in a direct-mapped cache after the effect's handle block; later calls with that handle are a copy. Test:
  `jit-param-desc.test.js`.
- **`ID3DXEffect::SetRawValue`** joins the deferred queue (`DEFER_RAW`): a copy of its bytes (whole words, up to 1 KiB) is
  taken at the call. Test: `jit-defer-raw.test.js`.
- **Bindings that change nothing** (`DEFER_F_TEX / STREAM / IB`): a Direct3D 9 `SetTexture`, `SetStreamSource` or
  `SetIndices` of what is bound already is dropped, as redundant render / stage / sampler states were (BFME2 play: ~17 k such
  calls/s reached JavaScript). The device keeps their shadow entries; an effect's commit list names the textures a
  queued `CommitChanges` may bind. Test: `jit-defer-filter.test.js` (randomized, against executing every call), and
  `d3dx9-effect-commit-list.test.js`.
- The queued COM calls run straight on their object's method (`Com.callQueued`), `dispatch` only for unusual cases.

## Sleep(0): pacing, not work

In play, `Sleep` is the second item of the API time ranking (BFME2: 1.1-1.4 s of API time per 20 s, 30-40 k calls/s).
Those calls are a frame limiter polling the clock with `Sleep(0)` until its next frame (the main thread: millions of
`Sleep(0)`, its other calls `timeGetTime` on the fast path) — pacing that the accounting cannot tell from work. Making the
call cheaper was tried (a `Sleep(0)` with no other thread runnable returning at once without ending the slice): the poll
then ran more often, and the time charged to `Sleep` grew (per 20 s, on vs off in one session: 1438 / 1124 ms, 846 k /
677 k calls) with no frame-time effect; it was reverted. The existing throttle (32 back-to-back `Sleep(0)` with nothing
else to run park the thread 1 ms) is what bounds it.

## PeekMessage polling: pacing that now waits (src/win32/user32.js, peekIdle)

Vice City's `api` time (19.5 ms per frame on the owner's PC, 17-19 ms here, 60 % of the emulator thread) was not
Direct3D work: its frame limiter calls `PeekMessage` (and `QueryPerformanceCounter`, on the WASM fast path) in a loop
until its clock reaches the next frame — ~24 000 empty `PeekMessage` calls per frame, nothing else between them
(`tools/startbench.mjs --api-seq 600@45 --jit-profile`: `PeekMessageA [+1 fast timer] x599`). In Node, per frame of the
drive: `PeekMessageA` 9.6 ms (24 k calls, 0.4 µs each), `DrawIndexedPrimitive` (with the queued setters it runs) 0.6 ms,
everything else < 0.5 ms. The game's state setters reach JavaScript non-redundant (counted over a drive: 120 render /
stage states the filter dropped, 23 of 960 k `SetTexture`, 1 of 660 k `SetIndices` changing nothing): filtering more
would not pay there. Windows would burn a core the same way; here it burns the emulator thread, and the frame
accounting charged it as work.

**Decision.** An empty `PeekMessage` that is part of such polling waits instead of spinning: after 64 empty calls in a
row (each within 50 µs of the previous one, at most one other JavaScript API call of the thread and 4096 guest
instructions between them — Vice City's polling runs 64-127; a loop pumping messages between small chunks of computation
with no API call is work, not polling, and is not slowed down) with no
other thread runnable, the call parks the thread (woken early by a message), and again every 8 calls while the
polling goes on — to the guest, an OS preempting a spinning thread. So that it is never made late: the times at which
the thread's bouts of polling ended (its next frame) give the shortest interval between them; the thread waits (at most
2 ms at a time: the browser worker stays in `Atomics.wait`) until 0.4 ms plus the latest overshoot of its waits before
the expected end, then spins until shortly after it — a limiter polling at a steady rate, relative or absolute
deadline, sees its clock reach the deadline at full speed. Without an estimate, or past it, the waits are 0.25 ms. A
bout that ended right after a wait counts up to the start of that wait (shorter: more spinning, never later); waits
that last longer than asked (a host whose timed waits follow a coarse system timer, as Windows timed waits may, other
threads run after the wake-up) widen the margin by their
overshoot. The time waited is `wait` in the frame accounting (pacing). `?dbg=ORTHROS_PEEK_IDLE_MS=0` (or the harness
input `dbg:ORTHROS_PEEK_IDLE_MS=0`) turns it off; `=<ms>` sets the short waits. Test: `peek-idle.test.js` (a frame
loop on the virtual clock: calls per frame, frames on time once learned, absolute deadlines, a higher rate, waits
rounded to 1 ms and to a 15.625 ms timer, no wait with other calls between or with a message).

Also: `dueTimer` (every `PeekMessage`) reads the clock only when the thread has a timer; DirectSound logs its
diagnostic lines (creation, first plays and unlocks with a scan of the contents) for the first 32 buffers only (Vice
City creates or duplicates a buffer per sound: ~11 log lines, each posted to the page, per frame) and copies 3D
parameters without `structuredClone`.

Measured (2026-10-06, `tools/scenarios/vicecity-drive.txt`, this tree against main, both at once, launch order
alternated, `--gl-discard`; 4 pairs, the 22 s drive and the 38 s after it), per frame: `api` 4.1 / 3.5 ms against 16.4 /
17.5 ms (-75 / -80 %), `guest` 11.2 / 10.1 against 14.8 / 14.4 ms (the polling loop's own code); 29.8 / 30.0 fps both;
frames > 40 ms 49 / 14 per minute against 69 / 24, > 50 ms 12 / 4 against 20 / 7 (fewer in every pair); p99 40-48 ms
against 45-58 ms. Emulator worker CPU over the drive: 10-11 s against 21-22 s of 22 s. With SwiftShader drawing (2 pairs)
the same `api` figures (3.7 / 3.0 against 17.2 / 18.4 ms). Node (`startbench.mjs --input vicecity-drive.txt`, on vs
`dbg:ORTHROS_PEEK_IDLE_MS=0` at once): `api` 1.5 against 11.2 ms per frame, thread CPU 8.0 against 22.0 s, 654 / 656
frames, p50 33.3 both. What remains of `api` in the browser: `DrawIndexedPrimitive` with the setters it runs and the
render-worker recording (~2.4 ms; recording 1.3 ms of it by `ORTHROS_REC_TIME`), `PeekMessage` spinning near the
expected end (~1 ms), buffer locks, DirectSound. BFME2 play (no such polling: no wait taken): unchanged (30.2 fps both,
`api` 4.4 / 4.3 ms).

## Effects (src/win32/d3dx9-effect.js)

- Shader constants are compared per stage: a pass's bindings are compared with the device's registers only when that
  stage's constants changed (`vsConstVersion` / `psConstVersion` on the devices, recorded for the render worker too).
- A pass state (render / stage / sampler state, shader) the device already holds is not sent again, at `BeginPass`
  and at `End`'s restore (the device handler would do nothing).
- A sampler parameter whose states are constants is not compared again at each commit while its register's state
  table is unchanged since they were applied (`StateTable.ver`).
- How a pass state picks its shader is resolved once per pass; a texture parameter set to the texture it holds does
  not take and drop a reference.
- A parameter's version moves only when a setter changed one of its words: BFME2 play sets ~1 600 parameters per frame,
  three in four to the value they hold, and an unmoved version leaves the shader bindings (and preshaders) reading it
  alone. Parameter blocks still record such writes.
- Float constants are moved as raw words: a binding whose components are all float words (or zeros) is gathered from
  the parameter's words and compared with the registers' words in one pass (no copy, no float decode / encode); the
  float setters store the words they are given. Bits are kept (-0, NaN payloads): -0 against +0 counts as a change (one
  upload more), never the other way round. Other bindings (integers or bools in float registers, integer / bool
  registers) go through fillers specialised by output type.
- A shader's sampler binding keeps the register state table it applied its constant states to: while that table is
  unchanged only the texture is compared. Device methods are resolved once per effect (no lookup by name per call);
  parameter handles index a slot array.
- Measured (2026-10-06): `tools/effect-bind-bench.mjs` 1.4-1.8 ms -> 0.65-0.7 ms per frame of 300 objects; BFME2
  play in Node, in-session A/B with `dbg:ORTHROS_FX_BIND_OFF` (5 pairs of 20 s phases, 2 runs): api -0.25 and -0.37 ms
  per frame, every pair lower; RotWK -0.14 / -0.16 ms. Browser (`--gl-discard`), in-session `*-fxbind-ab.txt`: BFME2
  api -0.33 / -0.33 ms per frame (every on phase below the next off one), RotWK -0.27 / -0.27 ms; concurrent BFME2
  phase runs against the previous build: api -0.8 ms per frame (every 20 s phase -0.7 to -1.0) and -0.3 to -1.1 ms in a
  second pair; `BeginPass` (which also runs the queued setters) -0.12 to -0.3 ms. Frame rate and >33 / >40 ms frames:
  no difference beyond the noise (play at 30 fps either way on this server).
- Not kept: register ownership (each register remembering the binding that wrote it, so that a binding left unchanged
  but on a stage changed by others needs no comparison). BFME2 play: 79 % of shader binds find their stage unchanged,
  the bindings of the others changed with their parameters; unchanged bindings on a changed stage were 0.25 % of the
  visits, 3 % of those still owned — less than the bookkeeping cost.

## WebGL backend (src/gfx/d3d8-webgl.js, applyState)

- The depth / stencil / blend / color mask / culling block is skipped while the render state table's version, the target's
  orientation and the GL state cache are those of the previous draw (`StateTable.ver`).
- A stage's sampler object is kept while its sampler (DX8: stage) states and its texture did not change.
- A texture whose levels are all uploaded and clean is not scanned at each bind (`levelsClean`, cleared by
  `Surface.dirty` / `markLocked`); its GL record is kept on the resource (`glOwner` / `glRec` / `glGen`: no lookup by
  id; a context loss or restore moves the backend's `texGen`, a destroyed resource drops it).
- Texture / cube / volume sampler uniform locations are resolved once per program (`P.texU`), not by name per stage
  and draw.
- Vertex and pixel constants are synced per stage only when that stage's constants changed; integer / boolean constant
  and bump-environment uniform locations are cached per program.

Test: `gl-state-cache.test.js` drives random Direct3D 8 / 9 sessions over a GL that tracks its effective state and checks
that every draw sees the same GL state, and every upload the same data, with and without these caches.

## Measuring within a session

Harness inputs (tools/headless.mjs): `dbg:ORTHROS_API_OPT_OFF=1` switches all of the above off (`=` back on);
`dbg:ORTHROS_GL_NOCACHE=1` only the backend's caches; `dbg:ORTHROS_D3DX_FAST_OFF=1` only the JIT fast paths;
`dbg:ORTHROS_FX_BIND_OFF=1` only the effect binding above (raw words, versions, sampler shortcut, resolved methods).
Scenarios `tools/scenarios/{bfme2,rotwk}-apiopt-{ab,ba}.txt` alternate 20 s phases on / off in play (both orders),
`{bfme2,rotwk}-fxbind-ab.txt` the same for the effect binding. Tools: `tools/draw-bench.mjs` (device + backend per draw
over a counting GL), `tools/setter-bench.mjs` (the queued setters), `tools/effect-bind-bench.mjs` (effect setters and
binds, `--base <tree>` against another checkout). Test of the effect binding: `d3dx9-effect-bind.test.js` (random
sessions against the reference path, registers bit for bit).

## Win32 heap (src/win32/heap.js)

`HeapAlloc` was BFME1's costliest API call outside play. In Node (`startbench`, the runs below): 7-16 µs per call in
the menu (100-320 calls per frame), 25-150 µs in the seconds after the skirmish click (`load`: 11-65 ms per frame),
9-57 µs in the map load (`loadscreen`: 4-30 ms per frame); an earlier V8 profile gave `Heap.chunkOf` 10 % of the load
phase.
Counted (instrumented run): the game's own heap (`HeapCreate`, then `HeapAlloc` with `HEAP_ZERO_MEMORY`, 1 MB growth)
holds ~730 chunks in the menu and ~960 after the map load (~200 growths in the 10 s after the click), and `chunkOf`
scanned them one by one (~640 comparisons per call on average) — for every free block an allocation visits
(`freeBlockOk`: 1-4.6 per allocation on average, up to ~620 when a power-of-two class holds many smaller blocks), for
every `HeapFree` and `HeapSize`.

- **Chunk lookup in O(1)**: past 8 chunks, a heap keeps a map of the 64 KB granules of the 32-bit space (a `Uint16Array`
  of 65 536 entries, 128 KiB, only for heaps that large) giving the index + 1 of the chunk covering each granule. Chunks
  come from `VMem` 64 KB aligned and sized, so a granule belongs to one chunk at most; one shared by two chunks all the
  same (`SHARED`) is looked up by the linear scan, as are heaps of fewer chunks. `chunkOf` returns the chunk object the
  scan returns, for any number.
- **The allocation walk** checks each free block inline (`freeBlockOk`'s conditions, in the same order) with aligned
  `Uint32Array` reads instead of a method call and `DataView` reads per word. The walk, its order and its robustness
  checks are unchanged: the same block comes back for every request (which block a game gets back decides its reuse
  patterns, docs/thread-scheduling.md), the same lists are cut (`brokenLists`), the same links ignored (`plausible`).
- **`HEAP_ZERO_MEMORY`** (`zeroFill`): with the lookup fixed, zeroing was 55-85 % of `HeapAlloc`'s remaining time (the game
  zeroes every block: 13-100 MB per 10 s in the menu, ~40 MB per 10 s in the map load). On a shared guest memory (the
  browser with the background translator or the render worker, `startbench --bg`) a typed array's `fill` stores one
  element at a time: through the byte view 2.4 GB/s, through `Uint32Array` 5.3, `Float64Array` 6.6 (8.0-8.4 for all three
  on an unshared buffer); a 256-byte fill 0.197 against 0.056 µs. An 8-aligned range inside the memory is now filled as
  doubles (+0: eight zero bytes), anything else as before — the same bytes. (`GuestMemory.fill` itself, used by many other
  callers, still fills bytes: the same change there is left to a measurement of its own.)
- **Looping free lists**: the randomized test below found programs whose writes into freed blocks turn a free list into
  a loop of valid free blocks too small for the request — the walk never ended (the emulator hung). Brent's cycle
  detection (one comparison per step: a mark moved to the current block after 1, 2, 4... steps) finds the loop, and
  `cutLoop` ends the list at the last block of the loop (each block stays in the list once; `stats.loopedLists`). A
  walk that ends is not affected: nothing is written during a walk, so meeting a visited block again means it would
  repeat forever.

Tests: `heap-lookup.test.js` — `chunkOf` against the linear scan for boundary and random addresses (interleaved heaps,
granules shared by unaligned chunks, after `destroy`), and a differential run of random programs (allocations zeroed or
not, frees, reallocations in place or moved, zeroed or not, double frees, frees of non-blocks, the program's data in its
blocks, writes into freed blocks — links into the other heap, into nothing, unaligned, fake free blocks inside freed
blocks and against the chunk's end sentinel, sizes — and past the end of live blocks) on this heap and on the linear-scan
heap it replaced (old walk, old reallocation, byte fills), each in its own guest memory: same results, same contents read
back from every block handed out, same chunks, same bytes in every chunk, same list heads and counters. Each of 14 single
mutations of the new code (a check dropped or loosened, an off-by-one in the map or in a zeroed range) makes it fail.
`heap-corruption.test.js`: a two-block loop and a self-linked block behind another are cut, their blocks still found (2
more mutations of `cutLoop`).

**Measured (2026-10-06).** Microbenchmark (a heap grown to 900 chunks, alloc / free of mixed sizes, half zeroed;
concurrent pairs, two each): 15.3-15.4 → 0.72-0.79 µs per operation on an unshared memory, 18.3-18.5 → 0.93-1.03 µs on a
shared one; a heap of 22 chunks (small blocks, no zeroing, shared): 0.17-0.19 → 0.12-0.13 µs.

BFME1 in Node (`startbench --bg`, `tools/scenarios/bfme-phases.txt`; base and branch at the same time, launch order
alternated). The server's load average was 23-65 during these runs (other projects): in two pairs neither run reached
the skirmish (clicks timed in wall-clock seconds landing before the menus were ready), so pairs 4-8 used a copy of the
scenario with the menu's step times doubled (menu phase 270 s). Final code (pairs 7 and 8, launched branch first / base
first):

| phase | measure | pair 7 base → branch | pair 8 base → branch |
|---|---|---|---|
| menu (270 s) | `HeapAlloc` µs per call | 9.4 → 1.4 | 9.0 → 1.6 |
| | `HeapFree` µs per call | 2.9 → 1.1 | 3.2 → 1.1 |
| | `api` ms per frame | 3.37 → 2.59 | 3.30 → 2.78 |
| | frames | 6262 → 6404 | 6376 → 6492 |
| load (4-6 s after the click) | `HeapAlloc` µs per call (ms per frame) | 50.0 → 3.4 (23.5 → 1.7) | 77.0 → 2.8 (33.3 → 1.3) |
| loadscreen (map load) | duration | 60.3 → 60.8 s | 66.5 → 62.8 s |
| | `HeapAlloc` µs per call (ms per frame) | 11.3 → 2.0 (6.1 → 1.0) | 8.6 → 2.4 (4.2 → 1.1) |
| | `api` ms per frame | 16.4 → 10.8 | 16.1 → 10.4 |
| play (160 s) | `HeapAlloc` µs per call | 3.6 → 1.7 | 2.7 → 1.1 |

The chunk lookup alone (without the zero fill; pair 2 on the original scenario, pairs 4 and 5 on the slower one, plus
two pairs that only completed the menu): menu `HeapAlloc` 7.2-16.4 → 2.5-6.8 µs, `api` -0.6 to -2.3 ms per frame;
load 27-150 → 4.0-10.7 µs; loadscreen 9.6-56.7 → 5.3-8.6 µs (4.3-30.4 → 2.7-4.5 ms per frame). Across all seven pairs
whose menu phase completed, the branch drew more menu frames in every pair (+0.4 to +2.5 %: the menu is CPU-bound and
`api` is 8-9 % of its frame). The map load's duration did not move beyond its spread (differences +0.6, -2.5, -1.5,
+0.5, -3.7 s on loads of 54-73 s): the time saved in `HeapAlloc` there is 0.1-2 s per load. In a third final pair the
branch's run ended right after the skirmish-setup click: the game exited by itself (no Orthros crash report), as in
the known BFME1 race at that click, where the game's crash handler ends the process (docs/thread-scheduling.md, "The
BFME1 investigation": a few percent of runs, more under load; the load average was 44 then); that pair is not counted.

Browser (headless Chromium, `--gl-discard`, `bfme-phases.txt`, one pair at the same time, branch launched first; final
code), base → branch: boot to the menu (64 s) `HeapAlloc` 7.5 → 2.7 µs per call (1455 → 520 ms in total), `HeapFree`
2.5 → 1.4 µs; menu (134 s) `HeapAlloc` 4.8 → 1.9 µs (1632 → 642 ms), `HeapFree` 2.8 → 1.5 µs (1013 → 549 ms), `api`
5.4 → 4.8 ms per frame, 18.9 → 19.1 fps; load (5.5 s) `HeapAlloc` 45 → 4.9 µs (21.7 → 2.3 ms per frame), `api` 59 →
34 ms per frame; map load 66.2 s in both (its end is polled once a second), `HeapAlloc` 8.1 → 2.1 µs (323 → 79 ms);
play 31.8 → 32.0 fps, `api` 4.0 → 3.8 ms per frame (`HeapFree` 1641 ms, 8.3 µs per call, before; below the 12
costliest calls, under 754 ms, after). A single pair: the per-call figures are far outside any noise, the frame rates are not.

Not done: after a growth, `alloc` walks the size classes again although the first pass found nothing — taking the new
chunk's block directly gives the same block only when the first pass cut no list and the new block's class was empty;
with walks of 1-4.6 blocks on average it is not worth the special case.
