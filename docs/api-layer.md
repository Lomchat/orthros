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
- **Fixed-function lights, material, FVF that change nothing** (`DEFER_FX_*`): `LightEnable` of lights 0..7, `SetLight` of
  lights 0..7 and `SetMaterial` compared word for word with the structure they point to, Direct3D 9 `SetFVF` — Direct3D 8
  and 9. Engines re-send their lights before every object: BFME1's 3D menu issued ~2 100 `LightEnable` and ~2 100
  `SetLight` per frame (830 draws), 98-100 % of them no-ops, each one queued, copied (26 words) and run in JavaScript.
  The shadow entries are known only for words with which the call is a no-op of its handler (a light's type below 2^24,
  stored in a float; a member compared as a float not a NaN). Test: `jit-defer-filter-fx.test.js` (randomized sequences
  through the JIT against the real Direct3D 8 / 9 devices executing every call: -0 for +0, NaN members, odd types, null
  pointers, lights 8+, odd BOOLs, declarations resetting the FVF, state blocks, Reset, an effect commit setting lights
  and the FVF; the devices agree at every draw, version counters included).
- **Draws from buffers are queued** (`DEFER_DRAWS`: `DrawIndexedPrimitive`, `DrawPrimitive`, Direct3D 8 and 9): they
  always return `D3D_OK`, and what they read changes only through queued calls (run before them) or calls handled in
  JavaScript (which run the queue first: a buffer lock, a texture lock, `Present`, a query's `GetData`...). A frame's
  draws and state setters then reach JavaScript in batches, at the next call handled there, instead of one round trip
  out of the translated code per draw. (The UP draws read the caller's memory at the call: not queued.) Consequences
  for the measurements: a draw's time is now part of the JavaScript call that runs the queue (in the per-API ranking,
  `[apitop]`, `DrawIndexedPrimitive` no longer appears: its time is in `Lock`, `Unlock`, `Present`...). Jit option
  `deferDraws: false` (Node: `ORTHROS_JIT_OPTS`) handles them at the call again.
- **AddRef / Release while bindings are queued** (`REFS_SET`): COM `AddRef` / `Release` stay on the fast path only while no
  queued call may change the object's count. That was "no queued binding at all"; with the draws queued the queue holds
  bindings much longer, and in BFME1's play `IDirect3DTexture9::Release` became a JavaScript call 1.4 M times in 270 s
  (against 0.28 M), each running the queue. A queued Direct3D 9 `SetTexture` / `SetStreamSource` / `SetIndices` whose
  shadow entry was known now records +1 for the object it binds and −1 (a release) for the one it replaces, per object
  (16 entries; any other binding call — Direct3D 8, effects — or more objects: anyone, as before). `AddRef` / `Release`
  then stay on the fast path: the count in memory moves at once, the queued calls move it later, and the value returned
  is the count once both have (the immediate execution's). A `Release` goes to JavaScript (which runs the queue first)
  when the count could reach 0 at the queue's lowest point — all of the object's queued releases before its bindings —
  so that no queued release destroys an object still referenced. Test: `jit-defer-filter.test.js` (randomized bindings,
  `AddRef` / `Release` with counts kept low, and bindings made behind the shadow's back: every result and final count as
  executing every call, and no count reaching 0 on the way).
- The queued COM calls run straight on their object's method (`Com.callQueued`), `dispatch` only for unusual cases.
- Fixed (2026-10-06): a queued call carrying a structure (`SetTransform`, `SetViewport`, `SetLight`, `SetMaterial`, the
  effect `SetVector` / `SetMatrix` / `SetRawValue`) overwrote the local holding its spec with the address of the copy, so
  the spec's `DEFER_STATES` test read a bit of that address (always set: the queue lives at 0x7fdb0000) and switched the
  issued-state filter off until the next call handled in JavaScript. Every redundant state, texture, stream or index set
  after a transform (in practice: after the first object's world matrix of every draw) reached JavaScript.

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
`dbg:ORTHROS_DRAW_OPT_OFF=1` handles the draws at their call again and switches the lights / material / FVF filter off
(`=`: back on, the filter once the queue has run): `Jit.setDrawOpt`. (The fix of the clobbered spec, section 1, has no
switch.)

## Draw submission per draw (2026-10-06)

**Where it went.** BFME1's 3D main menu in Node (`tools/framebench.mjs --gfx recorder`, the render worker's recording
with its commands dropped; 830-890 draws per frame), V8 profile of 300 frames, per frame: the JavaScript API calls 5.0
ms, of which `IDirect3DVertexBuffer9::Unlock` 1.1 ms (all of it the copy of the written ranges into the command ring,
2.5-2.7 MB per frame), `DrawIndexedPrimitive` 0.7 ms (the recorder's `flush` 0.6), the queued calls 1.3 ms (7 000-8 000 per
frame: `LightEnable` 2 100, `SetLight` 2 100, `SetTransform` 750, `SetTextureStageState` 630, `SetRenderState` 420,
`SetIndices` 350...), the dispatcher's own work 0.6 ms (2 700 calls handled in JavaScript per frame: 840 draws, 165 + 145
vertex / index buffer Lock / Unlock pairs, heap calls). Counted per queued method, the calls that changed the device:
`SetLight` 0 of 2 078, `LightEnable` 33 of 2 095, `SetSamplerState` / `SetTextureStageState` / `SetIndices` hundreds that
the filter should have dropped — the clobbered spec of section 1.

**Changes** (section 1): the spec kept (the filter stays on after a queued structure), lights / material / FVF in the
filter, draws queued.

**Measured.**
- Deterministic in-session A/B (Node, `startbench --virtual`: the same guest work in both runs; BFME1 3D main menu, 40 s
  of virtual time in 8 phases of 5 s, `dbg:ORTHROS_DRAW_OPT_OFF` alternated, run A starting on, run B off, both at
  once, the render worker's recording as backend): `api` on − off = −2.63 ms per frame (every phase lower: −1.35 to
  −4.02; api off 6.8-12.9 ms per frame in this slow virtual run); the emulator thread's CPU −0.96 ms per frame with a
  spread of ±5 ms per phase between the runs (warm-up, V8 tiering), host instructions of the thread −6.8 M per frame
  (spread ±15 M): within the noise of whole-thread measures.
- Base against this branch (same deterministic run, both at once, everything included): BFME1 menu phase of
  `bfme-phases.txt` (1 046 frames, 28.13 G guest instructions in both) `api` 6.88 → 5.92 ms per frame, thread CPU 62.6 →
  60.2 ms per frame; Node `framebench` pairs before the queued draws (filter only): `api` 4.38 → 3.97 and 3.66 → 3.45 ms per
  frame, wall per frame −1.4 / +0.7 ms (noise).

**Measured again with every change (2026-10-14; base = the tree before them, both runs at once, launch order alternated,
per frame base → branch).**
- Node, virtual clock (the same guest work in both runs, identical guest instruction counts): BFME1 3D menu `api` 4.34 →
  3.25 ms (two pairs, identical), emulator thread CPU 65.6-67.5 → 62.7-63.7; BFME1 menu `api` 3.58-3.65 → 3.05-3.11, thread
  CPU 37.6-38.2 → 36.3-36.4; BFME2 (`bfme2-startup.txt`, one pair) menu `api` 4.28 → 3.97, play 5.03 → 4.87 (thread CPU
  16.75 → 16.83: within the noise).
- Node, real clock: BFME1 play `api` 2.67 → 2.38 and 3.59 → 3.25 (fps 33.9 → 34.3, 30.4 → 30.8); Vice City drive `api`
  1.96 → 1.45 and 2.23 → 1.72, thread CPU 14.4 → 12.6 and 16.9 → 14.9. BFME2 play: `api` 5.82 → 6.60 and 6.76 → 8.12, but
  not the same work: in both real-clock pairs the branch's runs drew more per frame (46 effect `Begin` / `SetTechnique` per
  frame against 33, +6 % guest instructions), while in the virtual-clock pair (identical work) both run 33 — the game
  renders more when it has the time; per-frame figures do not compare there.
- Browser (`--gl-discard`, three BFME1 pairs, `bfme-phases.txt` with a 3D-menu phase; one pair on a machine at load
  30-40): 3D menu `api` 12.1 → 10.4, 5.7 → 4.4, 5.3 → 4.1 ms, fps 7.7 → 7.8, 18.0 → 18.1, 18.7 → 19.5; menu `api` 4.4 →
  4.1, 4.0 → 3.5, 4.0 → 3.3, fps 22.6 → 22.6, 24.2 → 24.5, 25.1 → 26.1; play `api` 5.9 → 4.9, 2.9 → 2.5, 3.5 → 3.0, fps
  23.8 → 24.7 (loaded), 38.3 → 38.3 twice (the frame pacing's cap); map load (loadscreen) 75.2 → 69.6, 61.9 → 61.6, 62.1
  → 62.1 s. BFME2 (two pairs, `bfme2-startup.txt`): menu `api` 5.2 → 4.3 and 5.2 → 4.6, play 30.2 / 30.1 fps in all four
  runs (`api` 4.7 → 5.0 and 4.9 → 6.0: the same "more drawn" effect as in Node).
- Fidelity: `?glworker=compare-worker` on the branch, BFME1 menu to play (35 frames compared, 0 differing) and Vice City
  drive (220-1 460 frames compared, 0 differing); the randomized suites (`jit-defer-filter*.test.js`) against executing
  every call.

**Measured, not done.** Of the 2.5 MB per frame copied into the ring at `Unlock` in that menu, a whole-buffer lock of a
dynamic vertex buffer without flags (1 per frame, 0.5-0.63 MB) never changes a byte, and the `NOOVERWRITE` / `DISCARD`
ranges change 30-50 % of their bytes but 70-85 % of their 256-byte blocks (a shadow copy compared at each `Unlock`). Sending
only the changed ranges would read twice the bytes it saves writing (the comparison against the shadow, then the shadow
updated); in JavaScript the comparison is slower than the copy (~1-2 GB/s against 5-6 GB/s for a typed-array copy into
shared memory, this machine). Only the unchanged whole-buffer lock would gain, ~0.1-0.2 ms per frame: not done.
