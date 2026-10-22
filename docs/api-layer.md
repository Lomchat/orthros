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
  call. The effect keeps a 16-byte block after its description cache (`FX_SLOTS`, `FX_SLOT_BYTES`): two words, then at
  +8 the effect's own COM object (`FX_OWNER`, see the stale-pointer fix below). The two words: the pass count of its technique as of
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
- **`IDirect3DSurface8/9::GetDesc`** (`FID_SURF_DESC`): a surface's description never changes; its COM object carries
  the 32 bytes the handler writes right after itself (`Com.create`'s `extra` bytes, address at +12, written by
  `Surface.ptrOf`), and the call is a copy. Map loads that write textures texel by texel ask it ~130 k times per load
  (BFME2), with a `LockRect` / `UnlockRect` pair each. A null output, a released object (marker cleared) or an object
  without a description go to JavaScript. Switched with the D3DX fast paths (`ORTHROS_D3DX_FAST_OFF`). Test:
  `jit-surface-desc.test.js` (every kind of surface, D3D8 and D3D9, against the handler).
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

**The throttled sleep keeps the streak (2026-10-21).** The streak was measured from the end of the previous call: the
throttled call's re-execution after its 1 ms park found 1 ms since the previous `Sleep(0)` and reset it, so every
throttle was followed by 32 more unthrottled turns (BFME1 play: one throttle per ~62 `Sleep(0)`, 700-800 `Sleep` and
~1 900 scheduling decisions per frame). The re-executed call now completes the sleep and the streak goes on from the
wake-up: a throttled spin parks 1 ms at each `Sleep(0)` until work or other calls come between — the same 1 ms pacing
step as before. `tools/sleepspin-bench.mjs` (tools/pe/sleepspin.c: per 16 ms frame some work, then `Sleep(0)` +
`timeGetTime` until the next frame, beside a `Sleep(1)` thread; 5 runs): `Sleep(0)` per frame 483 → 48, scheduling
decisions 1 008 → 137, process CPU per frame 1.35-1.48 → 1.07 ms (medians), frame interval mean 15.98 ms both, p99
16.76 → 16.46 ms. `?dbg=ORTHROS_SLEEP0_KEEP_STREAK=0` restores the former behaviour (read at each call: in-session A/B,
tools/scenarios/bfme-sleep0-ab.txt). tests/sleep-throttle.test.js.
BFME1 play in Node (`startbench bfme-vanilla --bg --input tools/scenarios/bfme-sleep0-ab.txt`, warm profile at 800x600 —
the scenario's clicks are 800x600 coordinates —, four 30 s rounds on / off in one session, load 20-30): `Sleep` calls
per frame 712-757 → 356-395, scheduling decisions per frame 1 645-1 774 → 972-1 085, `Sleep`'s API time 0.30-0.36 →
0.17-0.19 ms per frame; frames identical (p50 26.0-26.1 ms, p99 29.0-30.2 on / 29.3-31.1 off); emulator thread CPU per
30 s 12.8-13.6 s on / 12.8-15.0 s off (medians 13.2 / 13.6: within the noise of the loaded machine). The remaining
`Sleep(0)` are probably turns where another thread was runnable (a yield, not a throttle) or the streak was not yet
built (not verified).

**On a coarse host timer (2026-10-22).** The throttle's 1 ms park is a host wait: on Windows it can last up to a timer
tick (15.625 ms), and the park crossing a frame limiter's deadline then lengthens the frame by that much (BFME1 on the
owner's laptop: frame p90 46.8 ms). The waits of a pacing loop's end are now spun to their deadline when the host is
measured coarse; docs/thread-scheduling.md "Host wake-up overshoot".

**The deferred queue's drain has its own accounting entry.** The calls the JIT queued (Direct3D state setters, D3DX
parameter setters) run in JavaScript before the next call handled there (`Vm.drainDeferred`); the drain ran inside that
call's timed window, so whichever call followed a batch (`IDirect3DTexture9::Release`, `GetTransform`...) carried the
batch's cost in the per-API table. `Vm.dispatchThunk` now drains first, timed on a sample like an API call of its own
(`Vm.drainAcctIdx`, named `(deferred queue drain)` in the `[apitop]` / phase reports through `Vm.acctApiName`); the
order of the calls is unchanged. tests/drain-acct.test.js. BFME1 in Node: the drain is the largest API entry, 0.66-0.75 ms
per frame for 148 drains per frame in play (5 µs each), 0.86 ms per frame (172 drains) in the menu — time the per-API
table used to spread over the calls that followed the batches. Dispatch cost unchanged (tools/apicall-bench.mjs, 2×7
runs alternated: 278 / 269 ns before, 279 / 277 ns after).

**The drain, profiled (2026-10-22).** BFME 1.08 play, Node (`startbench --cpu-prof <file> --cpu-prof-window
play:60:120`: a V8 sampling profile of one minute of play): the drain is 1.6-1.7 ms per frame by the accounting, 152
drains of ~15 calls (~2 200 queued calls per frame reach JavaScript: state sets that change something — the issued-state
filter drops the others on the fast path — and draws), ~0.7 µs per call. Inside it: the queue loop itself (records,
`Ctx` binding, `Com.callQueued`) 14 %, the recorder's work for the draws (buffer bytes copied into the ring 13 %, `flush`
6 %, the vertex ranges a draw reads 6.5 %, textures and streams 5.5 %), the state handlers (SetRenderState 6 %,
SetTexture 6 %, SetTextureStageState 5 %, the state-use report's `noteState` 3 %, the state tables 2.5 %, the
bindings 5 %). No single waste: the Direct3D work of the game itself. Slow frames (> 40 ms) drain 2.2-2.5 ms against 1.65
on average: more draws, not a stall. What the profile did find was outside the queue:

- **Refused buffer locks.** ~290 `IDirect3DVertexBuffer9::Lock` per frame failed with D3DERR_INVALIDCALL: the game locks
  one dynamic vertex buffer once with DISCARD, never unlocks it, then locks it again ~290 times per frame with
  NOOVERWRITE (never unlocked either; nothing is drawn from it). Direct3D 8/9 buffer locks nest (each Unlock ends one;
  surface locks do not): `Buffer.Lock` now accepts a buffer already locked — the earlier locks wait under the latest
  (`lockStack`, past 16 the oldest two merge into one wider range: bounded for a program that never unlocks), each Unlock
  ends the latest and writes its range back. Lock 1.2-1.4 → 0.6-0.8 µs per call. The game now does what follows a
  successful lock — it fills those vertices — so this fidelity fix costs it guest time: ten minutes of play in Node
  (the whole branch against the tree before, run at the same time) 83.6 → 108.9 G guest instructions, guest 12.4 → 13.8 ms
  per frame, API 2.33 → 1.94 ms per frame; frames over 40 ms 23 → 24 per minute. tests/d3d-buffer-lock-nest.test.js.
- **Failure reports.** Every failed COM call built its report key (`Interface::Method=code`, a string) to look it up:
  0.23 ms per frame for those locks alone. `Com.failed` first looks the code up in a per-method set (`failedSeen`,
  transient): 490 → 51 ns per failing call (tools: a dispatch loop of one failing method, 5 alternated runs).
  tests/com-object-refs.test.js.

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
`BeginPass(0)`, ~3.7 x (setters, `CommitChanges`, a draw), `EndPass`, `End` — 33 objects, 38 passes per frame in that
profile's scene (the play phase of the later measurements draws 25-29 objects of one pass each per frame, below). Of
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
    this server). The draws per frame of these pairs were not kept: BFME2's play lands on a light view (~134
    `DrawIndexedPrimitive` per frame) or, in other runs, a heavier one (~210), and a pair compares only when both sides
    land on the same one (an outside review saw the branch on the heavy view with api +0.1 under a load of 40-57, and
    -1.0 ms per frame on a heavy / heavy pair).
  - Browser, RotWK, 2 pairs: api 4.4 -> 3.9, 3.4 -> 3.1 ms per frame; effect calls 1.21 -> 0.92, 0.74 -> 0.53; fps
    27.3 -> 28.1 (a loaded server) and 29.6 -> 29.7. RotWK's play alternates between two views (~158 draws / 20 passes
    and ~175 draws / 19 passes per frame): either tree lands on either one (the Node pairs had both ways round), so the
    per-call figures of a pair are not always the same scene; the branch had the heavier one in both browser pairs.
  - Re-measured 2026-10-14 after the review (this tree with the review fixes against a fresh ca01ae8 worktree, run at
    the same time, launch order alternated; no warm profile: the scenarios create the profile; load average 8-16;
    draws = `DrawIndexedPrimitive` per frame of the play phase, passes = `BeginPass` per frame):
    - Browser (`--gl-discard`), BFME2, 3 pairs, all on the light view (134 / 134 draws): api 4.1 -> 3.8, 3.6 -> 3.2,
      4.1 -> 3.7 ms per frame (-0.3 to -0.4); calls reaching JavaScript 5143-5304 -> 4334-4398 per frame; guest
      12.0-12.6 -> 12.2-12.8 ms; 30.1 fps either way.
    - Browser, RotWK, 4 pairs: same view in two — 233 / 235 draws: api 4.4 -> 3.6; 235 / 234: 4.0 -> 3.7 —; in the
      two others the views differed (274 base / 235 branch: 4.0 -> 3.7; 234 base / 275 branch: 4.0 -> 3.5, lower with
      the heavier view); calls reaching JavaScript 5931-6265 -> 4945-5236 per frame; 29.7-29.8 fps either way.
    - Node (`startbench --bg`), BFME2, 2 pairs (134 draws per frame each side; "29 passes per frame" was first written
      here, a figure no log of these runs keeps; later Node runs counted 25 or 29, the browser 25-28.5): api 5.23 -> 4.70, 5.30 ->
      4.82 ms per frame; effect calls (`SetTechnique`, `Begin`, `BeginPass`, `EndPass`, `End`, `CommitChanges`,
      `ApplyParameterBlock`, queue drains included) 1.07 -> 0.72, 1.06 -> 0.76. RotWK, 2 pairs (234-236 draws, 23
      passes): api 3.27 -> 2.68, 2.82 -> 2.32; effect calls 0.96 -> 0.62, 0.78 -> 0.51. Guest time within ±0.4 ms.
    - The BFME2 heavy view did not occur in these runs.
  - Re-measured 2026-10-14 after merging main (fd93b77: queued draws, light / material / FVF filter, snapshots) and the
    stale-pointer fix below, against a fd93b77 worktree; run at the same time, launch order alternated; warm profiles
    (copies); load average 14-30 (one spike to 87, the run it hit discarded). Passes = `BeginPass` calls per frame of the
    play phase ([apitop] in Node, the phase's call counts in the browser); objects = `SetTechnique` per frame:
    - Node (`startbench --bg`), BFME2, 2 pairs, 25 objects / 25 passes per frame each side: api 6.17 -> 5.48, 6.09 -> 5.60
      ms per frame (-0.69, -0.49); effect calls (`SetTechnique`, `Begin`, `BeginPass`, `End`, `ApplyParameterBlock`,
      queue drains included) 1.79 -> 1.19, 1.76 -> 1.29. These two pairs are the high end: a review reproduced -0.30 and
      -0.36 in its like-for-like pairs, and a further 5 pairs (after the review fixes, 1-minute load 2-27) gave, passes
      per frame base / branch in brackets: 4.46 -> 4.07 and 4.46 -> 4.11 (29 / 29: -0.39, -0.35, the only like-for-like
      ones; effect calls 1.34 -> 0.98, 1.37 -> 0.96), 4.82 -> 4.58, 5.40 -> 5.15, 4.27 -> 4.07 (25 / 29: -0.24, -0.25,
      -0.20, the branch drawing 4 more passes per frame). The gain in BFME2 Node play is therefore about -0.3 to -0.4 ms
      per frame like for like, -0.5 to -0.7 at most. Passes per frame in Node are 25 or 29 (not always 25), and the two
      sides of one pair can differ: a pair is compared like for like only when both sides have the same count. RotWK, 4 pairs, 22 objects / 23 passes per frame each side: api
      3.90 -> 3.23, 3.84 -> 4.40, 3.86 -> 3.32, 3.09 -> 2.71 (-0.67, +0.56, -0.54, -0.38); effect calls 1.94 -> 1.30,
      1.95 -> 2.17, 1.91 -> 1.25, 1.65 -> 1.07. The +0.56 pair: the branch's `BeginPass` (which runs the queue: the setters
      and draws queued before it) took 82 µs per call against 36-45 in every other run of either tree, the same guest
      instructions per frame within 3 %; not reproduced in the two pairs run after it.
    - Browser (`--gl-discard`), BFME2, 3 pairs, all 134-135 draws per frame: api 5.4 -> 4.5, 4.3 -> 3.9, 4.2 -> 3.8 ms per
      frame (-0.9, -0.4, -0.4); fps 27.5 -> 28.0 (the loaded pair), 29.8 -> 30.0, 30.0 / 30.0. Objects (= passes) per
      frame 28.5 base / 25.0 branch in the first pair, 25.1 / 25.1 in the third: the number of objects the game draws for
      the same 134 draws varies between runs — the "25-29" seen across these documents.
    - Browser, RotWK, 4 pairs: one on the same view (235 / 234 draws): api 3.9 -> 3.5; in the three others the base landed
      on the heavy view (275 draws) and the branch on the light one (229-235): 3.8 -> 3.5, 4.4 -> 3.8, 4.2 -> 4.2 — not a
      like-for-like comparison. That the branch was on the light view in all three was checked for a fidelity effect: a
      branch run of `rotwk-fxdefer-ab.txt` (the queued technique calls switched off and on every 20 s) stayed on the heavy
      view (274-283 draws per frame) in every on and off phase alike.
    - Snapshot oracle (`snapshot-check.mjs bfme2 --at 180 --then 30000 --jit`): identical after 30 000 slices.
- **Release**: an effect frees its process-heap blocks when its last reference goes (the handle block with its
  description cache and technique slots, the commit list, the restore lists of its techniques, the empty list of
  `D3DXFX_DONOTSAVESTATE`); the queue has run by then (every call handled in JavaScript drains it first). Before, every
  effect released kept them, a few hundred bytes to a few KiB per effect created. Test: `d3dx9-effect-bind.test.js`.
- **A pointer kept after the Release** (fixed after a review of the above): `Effect.destroy` freed the handle block, the
  commit list and the restore lists, but the object's +12 / +20 words still pointed at them, and the queued effect
  calls' guard (`DEFER_HANDLE` / `DEFER_OBJ`) checked only that +12 was non-zero — not `COM_MARKER`: a call through a
  stale pointer (undefined behaviour on Windows, but no reason for Orthros to write into memory the heap has handed to
  someone else) made the fast path write the technique slots, the pass count, the restore list's and the commit list's
  shadow entries into reused memory. Now: `Com.dispose` clears +12 and +20 of every released object (after its
  `destroy`); the queued effect calls and `GetParameterDesc` require a live object (`COM_MARKER`) whose handle block
  names it back (`FX_OWNER`, written by `createEffect`, cleared by `destroy`); the device's state shadow names its device
  too (`SHADOW_OWNER`, +4 of the block); `IDirect3DSurface::GetDesc` requires its description right after the object
  (+12 == this + 24). A live object of another kind at a stale pointer's address therefore never passes for an effect,
  a device or a surface either: the call goes to JavaScript, which reports the unknown object (E_POINTER) or calls the
  object found there by method name. The other fast paths reading COM words already checked the marker (AddRef /
  Release, the issued-state filter, the surface description). Tests: `jit-defer-technique.test.js` (a released effect
  with its stale words and freed blocks reused: every call to JavaScript, nothing written — failed before the fix: all
  six calls on the fast path; run three ways: the stale words alone, with the COM marker put back too so that
  `FX_OWNER` is the only guard left, and with the handle block naming the object again so that `COM_MARKER` is — each
  guard removed on its own makes its variant fail), `jit-param-desc.test.js` (`GetParameterDesc` with the marker
  cleared, then with the block not naming the object: JavaScript each time), `com-object-refs.test.js`, `jit-defer-filter.test.js`, `jit-surface-desc.test.js`.
- **Spec bits** (merge with the draw work): the technique-call flags moved to bits 14, 15 and 31 (`DEFER_FX_*` uses 27-29);
  a spec's structure-words field is 6 bits (`DEFER_WORDS`, the largest structure a light's 26 words; `deferSpecs`
  rejects a field out of range).
- Test of the shaders picked in an array (the per-element cache, the device's shader compared by object):
  `d3dx9-effect-bind.test.js` — passes indexing a shader array by `round(Sel)` and `round(Sel + 1)` with indexes out of
  range (clamped, ±1e9 included), the device's shader set directly between commits (to none or another element),
  against the reference path after every call.

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

## D3DX image work during map loads (src/win32/d3dx9-image.js, d3dx9-image-wasm.js)

BFME2's map load loads ~1 225 textures with `D3DXLoadSurfaceFromMemory` (X8R8G8B8 256 x 256 into DXT1) and builds their
mip chains with `D3DXFilterTexture` (DXT1 from the RGBA the load keeps, A1R5G5B5 from the level the game wrote with
locks); RotWK's creates ~270 textures with `D3DXCreateTextureFromFileInMemoryEx` from DDS files, converting DXT levels
through RGBA (decoded, resized, re-encoded). Before this work these were the most expensive APIs of the load screens
(browser, BFME2: FilterTexture 1.3 s and LoadSurfaceFromMemory 1.0 s of its ~21 s; RotWK: CreateTexture 1.0 s), the
DXT encoder (`colorBlock`) alone 17 % of the BFME2 load screen's Node profile.

- **WebAssembly SIMD kernels written here** (`d3dx9-image-wasm.js`, built with the JIT's module builder, one module):
  the DXT1/3/5 block encoder and decoder, the 32-bit red/blue swizzle (A8R8G8B8 / X8R8G8B8 <-> RGBA8), the 2:1 mip box
  filter, and unpack / pack of the 16-bit formats (R5G6B5, X1R5G5B5, A1R5G5B5, A4R4G4B4, X4R4G4B4). **Bit-exact** with the
  JavaScript they replace: the DXT encoder takes every decision on the same values computed the same way — integer
  luminance for the endpoints, the palette and each texel's projection on the endpoint axis in f64 with the same
  operations in the same order (two texels per f64x2 lane pair), the same thresholds; DXT5 alpha levels and distances
  in f64 with the same strict "nearer than every earlier level" scan; no fused multiply-add. The decoder builds each
  block's palette with the same truncating integer divisions and gathers a row's texels with `i8x16.swizzle`. 16-bit
  expansion uses tables made by the JavaScript expression (`i8x16.swizzle`), quantization the exact integer form of
  `Math.round(v * m / 255)` (`floor((v m + 127) / 255)`, checked for every value). Small images (< 1024 texels,
  `WASM_MIN_TEXELS`) stay in JavaScript for the swizzle, the 16-bit unpack / pack, the DXT decoder and the 2:1 filter;
  the DXT encoder (`encodeDxt` / `encodeDxtRows`) and `mipChain` use the kernels at every size, down to 1 x 1 levels
  (the same bytes: the exactness tests cover every size from 1 x 1). Single thread, Node, interleaved with the base (`d3dx-image-bench.mjs --vs`, loaded server): X8R8G8B8
  256 x 256 -> DXT1 load 2.1-3.4 -> 0.5-1.3 ms, DXT1 mip chain from 256 0.80-0.97 -> 0.20-0.23 ms, A1R5G5B5 chain from
  its level 0.36-0.77 -> 0.11-0.20 ms, DXT1 / DXT5 decode 0.80 / 1.13 -> 0.19 / 0.30 ms, TGA image information 0.5-0.9 ms
  -> 2 µs; the same bytes from both trees.
- The kernels run on a private memory of the emulator thread (grown to the largest image met, never shrunk; the
  largest user is `mipChain`, which reserves two RGBA regions of the largest level plus every encoded level: from a
  2048 x 2048 source ~35 MiB for a DXT1 chain, up to ~53 MiB for a 32-bit chain that includes its top level) — and in the DXT helper workers (D062), which now share one `WebAssembly.Memory` (shared)
  with the emulator thread and encode their block rows in place (the JavaScript encoder where SIMD is missing). With a
  4x faster encoder the hand-off pays only for larger images: the pool now takes images from 2048 blocks (was 1024).
  Measured in Node with 4 helper threads on the loaded server (`DxtPool` against the local encoder, interleaved): 128 x
  128 92 µs through the pool against 77-84 µs alone, 256 x 128 155 µs both, 256 x 256 274-329 against 314-441 µs, 512 x
  512 787 against 1 248 µs.
- **`D3DXFilterTexture` builds the whole chain at once** (`mipChain`): the source level's RGBA (kept by the load) or its
  own data (16/32-bit: unpacked by the kernels) is copied in once, each level filtered and encoded inside the kernel
  memory, the encoded levels copied out together; large DXT levels still go to the helpers. Formats without kernels, the
  point filter and missing source data take the level-by-level loop as before.
- `D3DXGetImageInfoFromFileInMemory` no longer copies the file nor decodes TGA / BMP pixels to report their header (the
  same fields and the same rejections as the parsers: tested on generated headers of every type, depth, color map and
  truncation); a DDS file is parsed in place (its levels are views of the guest's buffer, read before the call returns;
  the guest memory never moves) instead of being copied whole; a surface filled whole by D3DX is not zero-filled first; `QueryInterface` keeps the strings of the GUIDs
  it met by their four words and the normalized IIDs of each object (it formatted a GUID string per call: 3.1 -> 0.4 µs
  per call in Node); `LockRect` no longer builds a `--watch-tex` key string per call.
- Exactness tests: `d3dx9-image-exact.test.js` compares everything with `tests/fixtures/d3dx9-image-base.js` (the file
  before this work, verbatim): DXT1-5 of random images of every size and alpha pattern (both encoders, block rows
  apart, the helper pool with the encoder switched per job), mip chains (box / point, odd sizes, general resize steps),
  every 16-bit value and channel value with tails, pitches and alignments, random DXT blocks decoded, image information;
  `d3dx9-filter-texture.test.js` drives `D3DXLoadSurfaceFromMemory` + `D3DXFilterTexture` and
  `D3DXCreateTextureFromFileInMemoryEx` (DDS levels as is, converted to a smaller size, generated, color key, another
  format; the file's buffer overwritten afterwards) on Direct3D 9 textures against the base computation.
- Switch: `?dbg=ORTHROS_DXT_WASM=0` (harness input `dbg:ORTHROS_DXT_WASM=0`) puts every conversion back on the
  JavaScript code (the same bytes). Tools: `tools/d3dx-image-bench.mjs --vs <base tree>/src/win32` times both trees'
  kernels interleaved in one process and checks they give the same bytes; `tools/startbench.mjs --d3dx-prof` prints the
  D3DX work by kind of operation and the surface lock patterns at each scenario mark.

Measured (2026-10-06, this server heavily loaded by other sessions — 1-minute load 25-65 —, base `bc34f7b` and this
work run at the same time, launch order alternated; "load + loadscreen" is the time from the click that starts the map
to the first playable frame, the two phases added because their boundary moves with the timing):

| Run (pair, first launched) | load + loadscreen | API time | per call |
| --- | --- | --- | --- |
| Browser BFME2 (`--gl-discard`), pair 1, base first | 35.2 -> 32.8 s | 6 413 -> 4 172 ms | FilterTexture 1 665 -> 600 ms, LoadSurfaceFromMemory 1 231 -> 652 ms |
| Browser BFME2, earlier build (`dbb1319`: pool from 1 024 blocks, no DXT decoder), base first | 41.3 -> 34.3 s | 7 467 -> 4 208 ms | FilterTexture 1 788 -> 591, LoadSurfaceFromMemory 1 364 -> 696 |
| Browser BFME2, `dbb1319`, variant first | 27.3 -> 22.8 s | 5 440 -> 3 331 ms | FilterTexture 1 432 -> 425, LoadSurfaceFromMemory 1 059 -> 489 |
| Browser RotWK, pair 1, base first | 32.4 -> 28.0 s | 3 398 -> 2 399 ms | CreateTextureFromFileInMemoryEx 3.5 -> 2.0 ms per call |
| Browser RotWK, `dbb1319` (before the DXT decoder and the fused level conversions), base first | 28.9 -> 31.1 s | 3 218 -> 2 986 ms | CreateTextureFromFileInMemoryEx 998 -> 958 ms in all: no gain until the decoder |
| Browser BFME1 (map load: guest-bound, no D3DX images), base first | 72.1 -> 72.5 s | 2 813 -> 2 882 ms | GetDesc 157 -> 0 ms (fast path); no difference beyond the noise |
| Node BFME2 (`startbench`, bfme2-startup), base first | 25.5 -> 21.9 s | 6.46 -> 3.24 s | LoadSurfaceFromMemory 2.07 -> 0.67 ms, FilterTexture 0.71 -> 0.21 ms; thread CPU 24.1 -> 20.6 s |
| Node BFME2, variant first | 22.8 -> 19.2 s | 6.01 -> 2.57 s | 1.93 -> 0.59 ms, 0.65 -> 0.18 ms; thread CPU 22.4 -> 18.9 s |
| Node RotWK (rotwk-startup), base first | 19.2 -> 17.3 s | 2.32 -> 1.34 s | CreateTextureFromFileInMemoryEx 2.85 -> 1.72 ms; thread CPU 18.6 -> 16.8 s |
| Node RotWK, variant first | 27.3 -> 25.3 s | 3.38 -> 2.28 s | 3.68 -> 2.18 ms; thread CPU 25.0 -> 23.1 s |

In the BFME2 load the API calls of the map's texture writes stay: `LockRect` / `UnlockRect` ~130 k each (the game writes
textures texel by texel), 0.4-0.6 s of the browser's load; `GetDesc` (as many) is gone from JavaScript, `QueryInterface`
(31 k) 0.2-0.3 s -> 0.03-0.06 s, `D3DXGetImageInfoFromFileInMemory` 0.11-0.15 s -> 0. In the browser the emulator then
waits more for the render worker during the BFME2 load screen (`render` 2.4 -> 2.8 s in pair 1; the textures are
uploaded there), which takes back part of the gain in time to play. The helper pool's work in the BFME2 load: 2 465 jobs,
608 ms waited for the helpers (base) -> 1 233 jobs (256 x 256 loads only), 383 ms waited.

Re-measured (2026-10-14, after the rebase: base `ca01ae8` and this branch at the same time in two browser slots,
`--gl-discard`, launch order alternated, 1-minute load 20-56; "API" is the API time of the load + loadscreen phases,
"per frame" that time over their frames):

| Run (pair, first launched) | load + loadscreen | API time (per frame) | FilterTexture / LoadSurfaceFromMemory |
| --- | --- | --- | --- |
| BFME2 bfme2-startup, base first | 33.1 -> 30.3 s | 6 520 -> 3 879 ms (28.3 -> 16.3) | 1 624 -> 535 / 1 201 -> 593 ms |
| BFME2, variant first (no learned GL programs on either side) | 31.6 -> 27.1 s | 5 504 -> 3 164 ms (24.7 -> 15.9) | 1 403 -> 521 / 1 062 -> 548 ms |
| RotWK rotwk-startup, variant first | 37.0 -> 33.0 s | 4 167 -> 2 914 ms (16.7 -> 13.7) | LoadSurfaceFromMemory 125 -> 43 ms |
| RotWK, base first | 32.3 -> 31.8 s | 3 730 -> 2 786 ms (21.3 -> 13.9) | 112 -> 42 ms |
| RotWK, base first (no learned GL programs on either side) | 28.0 -> 35.4 s (variant: I/O wait 2.8 -> 8.8 s) | 3 034 -> 2 291 ms (15.8 -> 12.3) | 382 -> 148 / 528 -> 246 ms |
| BFME1 bfme-phases (map load), base first | 72.7 -> 73.5 s | 2 627 -> 2 686 ms | (none; GetDesc 158 -> 0 ms) |
| BFME1, variant first | 68.1 -> 71.2 s | 2 444 -> 2 454 ms | (none; GetDesc 141 -> 0 ms) |

The API time of the BFME2 and RotWK load screens drops by 25-45 % in every pair (the spread between pairs is smaller
than the gain); the time to play follows in four pairs of five (the fifth lost on I/O wait, not API time). BFME1's map
load is guest-bound and uses no D3DX image work: the same time within the spread (the `GetDesc` fast path removes
~150 ms of API time, lost in the noise). Runs not counted: one BFME2 pair and one BFME1 pair where the menu was too
slow under the server's load for the scenario's clicks to start the map (both sides), and a BFME1 variant that hit the
intermittent access violation in the game's heap code during the menu, which base `main` also shows (the race under
investigation in the green-thread scheduler; no D3DX image call there).

Re-measured after review (2026-10-14, code unchanged — only tests and this text —, Node `startbench` with a fresh
profile each side, base `ca01ae8` and this branch at the same time, launch order alternated, 1-minute load 17-25; "API"
is the API time of the load + loadscreen phases):

| Run (pair, first launched) | load + loadscreen | API time | FilterTexture / LoadSurfaceFromMemory | thread CPU |
| --- | --- | --- | --- | --- |
| BFME2 bfme2-startup, base first | 21.8 -> 17.7 s | 5 237 -> 2 201 ms (-58 %) | 1 471 -> 393 / 2 097 -> 619 ms | 21.7 -> 17.6 s |
| BFME2, variant first | 22.3 -> 18.7 s | 5 593 -> 2 326 ms (-58 %) | 1 571 -> 450 / 2 301 -> 616 ms | 22.1 -> 18.6 s |
| RotWK rotwk-startup, base first | 21.1 -> 19.2 s | 3 193 -> 2 082 ms (-35 %) | 560 -> 618 / 1 174 -> 308 ms | 20.4 -> 18.7 s |
| RotWK, variant first | 17.7 -> 15.6 s | 2 838 -> 1 126 ms (-60 %) | 517 -> 126 / 1 058 -> 273 ms | 17.0 -> 15.0 s |
| RotWK, base first | 20.1 -> 18.2 s | 3 012 -> 1 305 ms (-57 %) | 543 -> 91 / 1 093 -> 302 ms | 19.5 -> 17.5 s |

Every pair gains in time to play (2-4 s) and API time; the gain is well beyond the spread between pairs. One outlier:
in the first RotWK pair the variant's `D3DXFilterTexture` took 618 ms for its 592 calls (91-126 ms in the two other
variant runs) — a stall of one run (the large DXT levels go to the helper pool, which waits for helpers on a loaded
server), not reproduced.

The 16-bit decode alone (`toRgba` of an R5G6B5 / A4R4G4B4 256 x 256 image, `d3dx-image-bench.mjs`) is the one operation
where the kernels barely help: it is a table lookup per texel in JavaScript already, and the kernel adds a copy in and
a copy out. A verification run on the loaded server (1-minute load 30-59, 9 runs) found it slower than the base (A/B
1.10-2.02 for R5G6B5, 1.07-1.39 for A4R4G4B4, +0.03-0.5 ms per image); re-run at load 17-22 with 15 runs it was faster
in each of 6 runs (A/B 0.62-0.86 and 0.60-0.89), and in-process against the same tree's JavaScript path
(`ORTHROS_DXT_WASM=0` toggled, 200 interleaved calls) 0.18-0.23 against 0.20-0.27 ms (R5G6B5, one run of three slower
by 6 %) and 0.10 against 0.14-0.15 ms (A4R4G4B4). Within the noise of a loaded server, so kept: the same kernel feeds
the in-memory mip chains of 16-bit sources (A1R5G5B5 chain 0.35 -> 0.12 ms), and no game run shows a 16-bit decode on
its own among the costly calls.

## Measuring within a session

Harness inputs (tools/headless.mjs): `dbg:ORTHROS_API_OPT_OFF=1` switches all of the above off (`=` back on) except
the D3DX image work: of that section, `ORTHROS_API_OPT_OFF` and `ORTHROS_D3DX_FAST_OFF` cover only the surface `GetDesc`
fast path, `dbg:ORTHROS_DXT_WASM=0` puts the image kernels (and the helpers' encoder) back on JavaScript, and the GUID
string cache, the header-only TGA / BMP information, DDS files read in place and the lighter `LockRect` have no switch;
`dbg:ORTHROS_GL_NOCACHE=1` only the backend's caches; `dbg:ORTHROS_D3DX_FAST_OFF=1` only the JIT fast paths;
`dbg:ORTHROS_FX_BIND_OFF=1` only the effect binding above (raw words, versions, sampler shortcut, resolved methods);
`dbg:ORTHROS_FX_DEFER_OFF=1` only the queued `SetTechnique` / `Begin` / `End` (also off with the D3DX fast paths).
Scenarios `tools/scenarios/{bfme2,rotwk}-apiopt-{ab,ba}.txt` alternate 20 s phases on / off in play (both orders),
`{bfme2,rotwk}-fxbind-ab.txt` the same for the effect binding, `{bfme2,rotwk}-fxdefer-{ab,ba}.txt` for the queued
technique calls (both orders). Tools: `tools/draw-bench.mjs` (device + backend per draw over a counting GL), `tools/setter-bench.mjs` (the
queued setters), `tools/effect-bind-bench.mjs` (effect setters and binds, `--base <tree>` against another checkout),
`tools/effect-object-bench.mjs` (the effect calls of an engine drawing objects — technique, ~15 parameters, Begin,
BeginPass, commits, End — over 6 effects with array-selected shaders, preshaders and expression states; `--jit`: as
guest code through the JIT and the deferred queue; `--base <tree>`; best read as instructions under `perf stat -e
instructions:u`, insensitive to the server's load). Test of the effect binding: `d3dx9-effect-bind.test.js` (random
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

Not done: after a growth, `alloc` walks the size classes again although the first pass found nothing. Taking the new
chunk's block directly would return the same block in every case: the first pass only cut lists (broken or looping
ones, the rest of every list it walked holds blocks too small), and `grow` links the new block at the head of its class,
which is at least `classIndex(size)`, so the second pass reaches it after classes that still hold nothing large enough.
The lists could differ only in a forged corner case: `link` writes the back link of the old head of the new block's
class, and when the program built a fake free block whose header is that word, the second walk cuts the list holding
it. Growth happens once per new chunk (1 MB or more), so the saved walk is not measurable; left as it is.

The crash / hang report of `vm.js` lists every heap with overwritten boundary tags, broken free lists or looping free
lists (`stats.badTags`, `brokenLists`, `loopedLists`).
