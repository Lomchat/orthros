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
- **`ID3DXEffect::SetTechnique`, `Begin` and `End`** join the deferred queue (`DEFER_TECH / DEFER_BEGIN / DEFER_END`).
  An engine calls them around every object it draws, and each call that reached JavaScript first ran the queue: in BFME2
  play (Node, per call) `SetTechnique` took 5.7 µs draining ~32 queued device setters and 1 µs of its own, `Begin`
  9.4 µs draining ~32 effect setters and 0.9 µs of its own — the work of the queue, plus a JavaScript round trip per
  call. The effect keeps two words after its description cache (`FX_SLOTS`): the pass count of its technique as of
  every call issued (written by its handlers, and by a queued `SetTechnique` from the technique handle's word, which
  holds its pass count — 0 at every other handle), and the restore list of its open `Begin` (each shadow entry its
  `End` sets — render and stage states, textures — with the value `Begin` saved; published by `Begin` when it runs). A
  queued `Begin` writes the pass count where its pointer points at once (the record's pointer is cleared: the handler,
  run later, must not write there again) and clears the list (an earlier `Begin`'s). A queued `End` takes the list and
  gives those shadow entries the values the restore will leave — the issued state, so the game's redundant sets of
  them stay filtered; textures are forgotten instead (a texture released meanwhile is not bound again); no list (its
  `Begin` still queued) or a state block recording: the filter off until the queue has run. A first version made `End`
  forget every entry: the redundant sets that followed then reached JavaScript, and the in-session A/B showed no gain
  (api +0.0 to +0.5 ms per frame with the queue on, Node). JavaScript keeps the rest: a technique by name, a parameter's
  handle, a technique without passes, an effect with a state manager. Test: `jit-defer-technique.test.js` (random
  engine-shaped sequences through the JIT against executing every call in order — the results, the pass counts written,
  the device state at every draw and at the end, every shadow entry the filter trusts against the device —, `Begin`
  twice without `End`, a restore list missing a state caught, the switch).
- **Fix** (found with the above): a queued setter carrying a structure (`SetTransform`, `SetMaterial`, `SetLight`,
  `SetViewport`, `SetScissorRect`, an effect's `SetVector` / `SetMatrix` / `SetMatrixTranspose` / `SetRawValue`) copied it
  through the local holding its spec, and the flags read after the copy were the copy's address bits: each such call
  passed as one that changes device states — an effect forgot its commit list, a device (no list) had its issued-state
  filter switched off until the next drain. The copy has a local of its own now.
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

### Per pass and per object (2026-10-06)

Where the time went (BFME2 play in Node, 60 s, base build; frame accounting per API call, the queue's drain measured
apart, and a V8 profile): per object drawn the game calls `SetTechnique`, ~32 parameter setters, `Begin(flags 6)`,
`BeginPass(0)`, ~3.7 x (setters, `CommitChanges`, a draw), `EndPass`, `End` — 33 objects, 38 passes per frame. Of
`BeginPass`'s 15.7 µs (all its own: nothing queued before it), the shader states took 70 % (`bindShader` 45 %, the
array selector picking the vertex shader 7 %), render states 18 %; the time of `SetTechnique` / `Begin` was the queue
(above). `End` restores ~4.5 render states per object that the next `BeginPass` sets again (350 k + 366 k
`SetRenderState` per minute: real changes, the game's own state calls come between them).

- **One shape per record**: parameter nodes (with their handle, version, leaf type, compiled sampler states),
  techniques, passes, shader records and effect objects get every field at creation. Fields added at first use made
  the nodes of different parameters different hidden classes, and the sites reading them in the setters, the bindings
  (`b.top.version`) and the preshaders' input checks megamorphic. `version ?? 0` is gone with it.
- **Pass operations**: the plain device (`plainDev`) taken once per pass applied, not per operation; a state whose value
  is a constant read once at compile time; a shader an expression picks in an array kept per element on the state's
  resolution (no map lookup per commit); the device's shader compared by object (`sh.impl`) instead of through its COM
  record; `BeginPass` lists of all / dynamic operations' functions. The commit list is not rewritten when the same pass is
  begun again on the same device shadow (only `publishCommit` writes it).
- `SetBool` / `SetInt` / `SetFloat` set one number without an array per call.
- **Parameter blocks**: an entry is compared and written only when the version of its top-level parameter moved since
  the block last wrote it (recorded or applied) — any write changing one of its words moves it, through an element, a
  member, the whole array or raw bytes. Test: `d3dx9-effect-bind.test.js` (each way, and a block recorded while
  another is applied).
- Measured (2026-10-06 and 2026-10-14; this tree, with the queued technique calls of the section above, against the
  wave's base ca01ae8 or its pre-rewrite equivalent; base and branch run at the same time, launch order alternated;
  `api` = mean API time per frame of the play phase; Node `startbench --bg`, `bfme2-startup.txt` /
  `rotwk-startup.txt`):
  - `tools/effect-object-bench.mjs` (instructions per frame, `perf stat`, 2 runs each): JavaScript calls 3.75 M ->
    3.19 M (-15 %); `--jit` (guest code, deferred queue) 6.34-6.62 M -> 5.70-5.85 M (-11 %). In that bench the queued
    technique calls themselves are a wash (`--no-defer` 5.68-5.77 M): the gain is the per-object work in JavaScript.
  - Node, BFME2, 5 pairs: api 6.58 -> 6.09, 9.07 -> 8.18, 7.38 -> 8.31, 10.88 -> 9.30, 5.88 -> 5.54 ms per frame
    (-0.3 to -1.6; one pair +0.9 where the branch's guest code also ran 11 % slower: a loaded server); the effect calls
    (`SetTechnique` + `Begin` + `BeginPass` + `End` + `ApplyParameterBlock`, queue drains included) -0.27 to -1.04 ms
    per frame in the four others. RotWK, 4 pairs: api 3.53 -> 2.98, 3.68 -> 2.97, 8.61 -> 7.68, 3.18 -> 2.68 (every
    pair lower, -0.5 to -0.9); effect calls -0.31 to -0.71.
  - Node, BFME2, the queued technique calls alone in session (`dbg:ORTHROS_FX_DEFER_OFF`, 20 s phases, 2 runs in each
    order): every on phase below its off neighbour, api -0.09 to -1.14 ms per frame (median -0.5).
  - Browser (`--gl-discard`), BFME2, 4 pairs: api 4.9 -> 4.4, 4.3 -> 4.0, 5.7 -> 5.5, 4.5 -> 3.8 ms per frame; effect
    calls 1.89 -> 1.34, 1.42 -> 1.15, 2.17 -> 1.57, 1.49 -> 1.04. In session (`bfme2-fxdefer-ab.txt`, one run): effect calls -0.08 to -0.26
    ms per frame, api within the noise (-0.2 / +0.2 / -0.1). Frame rate: 30 fps either way (the game's own cap on
    this server); same draws per frame.
  - Browser, RotWK, 2 pairs: api 4.4 -> 3.9, 3.4 -> 3.1 ms per frame; effect calls 1.21 -> 0.92, 0.74 -> 0.53; fps
    27.3 -> 28.1 (a loaded server) and 29.6 -> 29.7. RotWK's play alternates between two views (~158 draws / 20 passes
    and ~175 draws / 19 passes per frame): either tree lands on either one (the Node pairs had both ways round), so the
    per-call figures of a pair are not always the same scene; the branch had the heavier one in both browser pairs.

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
`dbg:ORTHROS_FX_BIND_OFF=1` only the effect binding above (raw words, versions, sampler shortcut, resolved methods);
`dbg:ORTHROS_FX_DEFER_OFF=1` only the queued `SetTechnique` / `Begin` / `End` (also off with the D3DX fast paths).
Scenarios `tools/scenarios/{bfme2,rotwk}-apiopt-{ab,ba}.txt` alternate 20 s phases on / off in play (both orders),
`{bfme2,rotwk}-fxbind-ab.txt` the same for the effect binding, `{bfme2,rotwk}-fxdefer-ab.txt` for the queued technique
calls. Tools: `tools/draw-bench.mjs` (device + backend per draw over a counting GL), `tools/setter-bench.mjs` (the
queued setters), `tools/effect-bind-bench.mjs` (effect setters and binds, `--base <tree>` against another checkout),
`tools/effect-object-bench.mjs` (the effect calls of an engine drawing objects — technique, ~15 parameters, Begin,
BeginPass, commits, End — over 6 effects with array-selected shaders, preshaders and expression states; `--jit`: as
guest code through the JIT and the deferred queue; `--base <tree>`; best read as instructions under `perf stat -e
instructions:u`, insensitive to the server's load). Test of the effect binding: `d3dx9-effect-bind.test.js` (random
sessions against the reference path, registers bit for bit).
