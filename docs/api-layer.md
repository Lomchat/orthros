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
`dbg:ORTHROS_FX_BIND_OFF=1` only the effect binding above (raw words, versions, sampler shortcut, resolved methods).
Scenarios `tools/scenarios/{bfme2,rotwk}-apiopt-{ab,ba}.txt` alternate 20 s phases on / off in play (both orders),
`{bfme2,rotwk}-fxbind-ab.txt` the same for the effect binding. Tools: `tools/draw-bench.mjs` (device + backend per draw
over a counting GL), `tools/setter-bench.mjs` (the queued setters), `tools/effect-bind-bench.mjs` (effect setters and
binds, `--base <tree>` against another checkout). Test of the effect binding: `d3dx9-effect-bind.test.js` (random
sessions against the reference path, registers bit for bit).
