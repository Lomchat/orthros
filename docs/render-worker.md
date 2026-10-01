# Render worker — measurements and design (phase 1), implementation (phase 2)

Status: implemented behind `?glworker=1` (section 7); the in-thread backend stays the default until the render
worker is measured faster on every game. Phase 1 added for the measurements: the probes `ORTHROS_GL_TIME` and
`ORTHROS_GL_NULL` and readback / buffer-byte counters (`src/gfx/d3d8-webgl.js`, test `tests/gl-probe.test.js`),
`GL timing` reports forwarded to the telemetry (`src/host/web/main.js`), and `tools/cmdring-bench.mjs`.

**Summary.** On the emulator's thread the WebGL calls themselves cost only 1.3-6.9 % of a frame, and no WebGL call
waits for the GPU in steady state; the backend's translation work (JavaScript that turns Direct3D state into GL
calls) costs about as much to 3 times more. Recording the GL calls for another thread (a "remote GL") would save
1.2-6.3 % net of the recording cost: not worth a second rendering path. Moving the **whole backend** — recording the
Direct3D work as a stream of state changes, resources and draws that a render worker turns into WebGL — removes
8-21 % of the emulator thread's time in skirmishes (its whole backend share minus the recording), in every
Direct3D 8/9 game. That is the design below (section 5), recommended for implementation in steps, with the
in-thread path kept as fallback.

## 1. Today

One dedicated worker (`src/host/web/worker.js`) runs the guest (JIT, green threads), the Win32/Direct3D layer
(`src/win32/d3d8.js`, `d3d9.js`, `d3dx9*.js`) and the WebGL2 backend (`src/gfx/d3d8-webgl.js`) on a worker-owned
`OffscreenCanvas`. At `Present` the backend blits the back-buffer FBO into the default framebuffer and `flush()`es;
the host (`src/host/browser-host.js`) hands `canvasGl.transferToImageBitmap()` to the page (`bitmaprenderer`).

Per draw, on that one thread:

1. Direct3D layer: `Set*` calls update the device's JS state (render/stage/sampler `StateTable`s, transforms, lights,
   constants, streams, textures...) and bump version counters (`stateVersion`, `programVersion`, `constVersion`,
   `lightVersion`, `transformVersion`, `viewportVersion`); the frequent `Set*` calls are recorded by the JIT in the deferred
   queue (D051/D060) and run in a batch before the next non-deferred API call.
2. Backend translation (JavaScript): program selection (`program()`: signature of the states that feed the
   generated GLSL), `applyState()` (GL state cache, uniform groups by version, sampler pool), `bindAttributes()` (VAO
   cache), lazy uploads of dirty textures (`glTexture`/`uploadLevel`, format conversion to RGBA8 here) and buffers
   (`glBuffer`: `bufferSubData` from guest memory).
3. WebGL calls: Blink's validation and Chrome's GLES2 command-buffer client encode each call into memory shared
   with the GPU process. A call whose answer the client does not hold (`readPixels`, `getError`, a program's link
   status before its info is cached, `checkFramebufferStatus`) waits for the GPU process, which first executes
   everything queued before it; any call waits when the command buffer is full (back-pressure).

The GPU process already runs in parallel: frame N's commands execute there while the worker computes frame N+1.
A render worker can only take off the emulator's thread what it does itself: (3), (2) if the backend moves, and the
waits.

## 2. Measurements

### 2.1 Method

- **Per-call timing — `ORTHROS_GL_TIME=<frames>[@<from frame>]`** (worker debug global; harness input
  `dbg:ORTHROS_GL_TIME=150`). For N frames every function of the WebGL context is wrapped (instance properties
  shadowing the prototype) and timed with `performance.now()`; the backend's entry points (what the Direct3D layer
  calls: draws, clear, present, readbacks, blits...) are timed inclusively, `canvas.transferToImageBitmap` too. The
  isolated worker's clock is coarse (5 µs) but jittered, so sums over thousands of calls are unbiased; the probe
  calibrates itself on a wrapped no-op (0.20-0.33 µs per call in total, 0.10-0.14 µs of it inside the timed span) and
  the report subtracts the latter from each call. Below, **backend** = entry points minus the full timer cost of the
  calls inside them; **translation** = backend − WebGL calls.
- **Removal A/B — `ORTHROS_GL_NULL=1`.** The 140 WebGL functions that return nothing (state, uniforms, uploads,
  draws: what would leave the thread) become no-ops; creations and queries stay real. 15 s phases alternate in one
  session (null, restore, normal, null, restore, normal — same browser, so no slot bias between A and B); worker
  thread CPU per frame from `/proc` (harness `mark:`). Leaving null mode recreates textures, buffers, targets, VAOs
  and samplers (their contents were dropped) and keeps the programs; the "restore" phase is not counted.
- **Cross-check:** V8 sampling profile of the worker (`profile:20`) in a skirmish.
- **Conditions.** Headless Chromium + SwiftShader on the shared 48-core server (load 18-34 during the runs). The
  figures of 2.2 are taken with `--gl-discard` (`RASTERIZER_DISCARD`: the GPU process still receives and decodes
  every command and upload, but does not rasterize, so the worker is not blocked by SwiftShader) and
  `--timescale 1.5` (the games' 30 fps cap lifted to 45 fps). Learned data copied from `learn-live`; BFME2 and RotWK
  user profiles from `/tmp/orthros-profiles`; BFME1 without a profile (its first-launch detection chose 800×600 in
  the `--gl-discard` runs, 1024×768 in the plain run). Menu = the main menu's 3D scene; skirmish = a skirmish in
  play, idle camera (`tools/scenarios` sequences; input files in the report).
- **Recording cost:** `tools/cmdring-bench.mjs` (a synthetic frame shaped like the measured ones recorded into a
  `SharedArrayBuffer` ring read by a second thread) and a `memcpy` of BFME1's per-frame buffer data.

### 2.2 Worker-side results (`--gl-discard`)

Per frame of the emulator's thread (worker busy 82-100 % in these phases: 12.3-15.1 s of CPU per 15 s phase).
Two runs per game where available (r1, r2), probes of 150 frames (60-90 in some).

| Game, scene (run) | frame ms | draws | WebGL calls | WebGL ms | WebGL % | backend ms | backend % | translation ms | buffer + texture data |
|---|---|---|---|---|---|---|---|---|---|
| BFME2 menu (r1) | 55.6 | 433 | 3 201 | 1.07 | 1.9 | 4.16 | 7.5 | 3.09 | 98 + 3 KiB |
| BFME2 menu (r2) | 85.5 | 285 | 2 342 | 2.40 | 2.8 | 6.42 | 7.5 | 4.02 | 63 + 3 KiB |
| BFME2 skirmish (r1, 2 probes) | 22.3-22.5 | 154 | 1 461 | 0.72 | 3.2 | 2.52-2.64 | 11.3-11.7 | 1.80-1.92 | 143 + 133 KiB |
| BFME2 skirmish (r2, 2 probes) | 25.1-29.8 | 240 | 2 043 | 0.93-1.11 | 3.7 | 3.86-4.59 | 15.4 | 2.93-3.48 | 143 + 133 KiB |
| BFME1 menu, 800×600 (r1) | 124.6 | 880 | 3 616 | 5.48 | 4.4 | 12.91 | 10.4 | 7.43 | 1 899 + 45 KiB |
| BFME1 menu, 800×600 (r2) | 71.3 | 683 | 3 009 | 1.25 | 1.8 | 4.57 | 6.4 | 3.32 | 1 427 + 11 KiB |
| BFME1 skirmish, 800×600 (r1, 2 probes) | 21.0-24.4 | 380 | 1 935 | 1.16-1.69 | 5.5-6.9 | 4.49-5.52 | 21.4-22.6 | 3.33-3.83 | 419 + 80 KiB |
| BFME1 skirmish, 800×600 (r2, 2 probes) | 19.8-21.6 | 380 | 1 936 | 1.03-1.25 | 5.2-5.8 | 4.19-4.63 | 21.2-21.4 | 3.16-3.38 | 419 + 80 KiB |
| RotWK menu (r1) | 22.0 | 24 | 346 | 0.37 | 1.7 | 0.71 | 3.2 | 0.34 | 5 + 0 KiB |
| RotWK menu (r2) | 22.0 | 24 | 346 | 0.29 | 1.3 | 0.73 | 3.3 | 0.44 | 5 + 0 KiB |
| RotWK skirmish (r2, 2 probes) | 25.1-29.9 | 178-180 | 1 235-1 239 | 0.71-0.81 | 2.7-2.8 | 2.39-2.67 | 8.9-9.5 | 1.68-1.86 | 145 + 76 KiB |

RotWK's menu stays at the 45 fps cap (worker 82-93 % busy), so its percentages are of a capped frame. The two BFME1
menu probes saw different moments of the menu's fly-through (880 and 683 draws).

Removal A/B (worker CPU ms per frame; pairs are consecutive null/normal phases):

| Game, scene | null phases | normal phases | difference | reading |
|---|---|---|---|---|
| BFME2 skirmish r1 | 21.08, 21.70 | 22.24, 22.22 | −1.16, −0.52 (mean −0.84) | matches the probe's 0.72 ms |
| BFME2 skirmish r2 | 27.95, 26.04 | 28.30, 23.58 | −0.35, +2.46 | scene drifts 29.4 → 23.6 ms over the run: inconclusive |
| BFME1 skirmish r1 | 20.92, 19.11 | 19.74, 20.69 | +1.18, −1.58 | inconclusive (±1.5 ms scene noise) |
| BFME1 skirmish r2 | 17.04, 17.75 | 16.80, 19.33 | +0.24, −1.58 | inconclusive (drift 16.3 → 22.3 ms over the run) |
| RotWK skirmish r2 | 23.76, 26.69 | 24.49, 29.21 | −0.73, −2.52 | same sign, but drift 23.5 → 29.2 ms: inconclusive |
| menus (BFME2, BFME1, RotWK) | | | | inconclusive: menu scenes change by 2x within a run (camera fly-throughs); RotWK's menu is capped |

The A/B resolves ~1 ms only in a stable scene; where it does (BFME2 r1) it agrees with the per-call probe. The probe
is the measurement; the V8 profiles of the skirmishes (r2, 20 s) agree: the backend's draw entry points take 15.2 %
of the worker's samples inclusive in BFME2 (probe 15.4 %), 20.8 % in BFME1 (probe 21.2-21.4 %), 10.5 % in RotWK
(probe 8.9-9.5 %). In BFME2: `applyState` 9.8 % inclusive (3.9 % self), `glTexture` 1.9 %, `bindAttributes` 1.6 %,
`program` 0.8 %, `syncConsts` 0.8 %, native WebGL functions ~3-4 % (probe 3.7 %).

Per call (µs, BFME2 skirmish r1): `bufferSubData` 1.5 (2 KiB average), `bindVertexArray` 0.7, `useProgram` 0.7,
`uniform4fv` 0.6, `uniformMatrix4fv` 0.5, `drawElements` 0.45, `bindTexture` 0.35, `bindSampler` 0.3,
`activeTexture` 0.13; `texSubImage2D` 21 (2 per frame), `flush` 9, `transferToImageBitmap` 20-33. BFME1 (more
loaded machine at the time): 1-2.3 µs for the same calls, `bufferSubData` 28 µs (45 KiB each, 1.9 MiB per frame).

**Synchronous calls in steady state: none** (0.0 per frame in every skirmish probe; 1.2-2.9 `getUniformLocation` per
frame in menu probes, answered from Chrome's client-side program cache in 0.56 µs).

**Recording into a ring** (`tools/cmdring-bench.mjs`, this machine): 78-114 ns per call over a plain function call,
data copies included (1 500 calls + 113 KiB: 0.17 ms; 3 100 + 233 KiB: 0.30 ms; 6 600 + 495 KiB: 0.71 ms). Copying
BFME1's 4.5 MiB of per-frame buffer data (1024×768 menu): 0.54 ms. Round trip to the other thread (no GPU work):
median 11-17 µs, p99 15-28 µs.

### 2.3 SwiftShader without `--gl-discard`

| Game, scene | frame ms | WebGL calls | WebGL ms (blocked) | synchronous |
|---|---|---|---|---|
| BFME2 menu | 480.7 | 2 873 | 324.9 (`uniform4fv` 914 µs/call, `uniformMatrix4fv` 206 µs/call) | 1 link status: 2 374 ms (a program built at a draw) |
| BFME1 menu, 1024×768 | 223.4 | 6 643 | 132.6 (`bufferSubData` 1 156 µs/call, 4.6 MiB per frame) | none |

Without `--gl-discard` the worker spends 60-68 % of its time **blocked in WebGL calls**: Chrome's command buffer is
full because the GPU process rasterizes on the CPU of a loaded machine. That time would not move to a render worker
(it would block instead, and the emulator would wait for it at the frames-in-flight limit): headless frame rates are
GPU-bound, and only the `--gl-discard` figures say what a render worker takes off the emulator's thread.

### 2.4 Transfer to a real GPU (the player: Windows Chrome, Intel Iris Xe, ANGLE/D3D11, 20 cores)

- The worker-side cost of a WebGL call (Blink validation + command-buffer client) and the backend's translation are
  the same code on Windows, whatever the GPU, and scale with single-thread CPU speed like the rest of the emulator's
  work: their **shares** transfer (WebGL 1-7 %, backend 3-23 %).
- Blocking should not: the player's telemetry shows `present` at 0.04-0.2 ms and BFME2/RotWK skirmishes at 29.5 fps
  (capped) with the worker 97-100 % busy — CPU-bound, not GPU-bound. The exception is shader compilation: ANGLE
  compiles HLSL in the GPU process, 108-160 ms per program in the player's telemetry (`program built in`) against
  3-21 ms here; the learned, compiled-ahead programs (D056) already take most of it off the frames (BFME2: 164/164
  resolved ahead, 7 built at a draw per session).
- To check on the player's machine without a new build: `?dbg=ORTHROS_GL_TIME=300@6000` (300 frames from the
  device's frame 6000, i.e. a few minutes in) logs the report; `GL timing` lines now reach the telemetry.

## 3. Decision

- **GL-level render worker ("remote GL"): no.** Net gain = WebGL time − recording (~0.09 µs per call + copies) =
  0.3-5 ms per frame, 1.2-6.3 % (table 5.13), for a second path of ~95 GL functions. Below the A/B noise of most
  scenes on this machine.
- **Direct3D-level render worker: yes, in steps.** Net gain = backend time − recording of the Direct3D state changes
  (~0.3-0.5 ms per frame) = 9-14 % of the emulator thread in BFME2 skirmishes, 19-21 % in BFME1's, 8 % in RotWK's,
  3-10 % in menus; more where the game draws more. The backend's own cost also stops competing with the guest for the emulator's
  thread and caches (its allocations and GC move too). It applies to every Direct3D 8/9 game unchanged.
- Independently, the backend translation is worth optimizing in place (`applyState` alone: 9.8 % of the worker in a
  BFME2 skirmish, mostly state reads `rs()`/`tss()`/`samp()` and comparisons): it pays now and keeps paying in the
  render worker (whose frame time it bounds).

## 4. Synchronous dependencies of the emulator on GL

From the backend and the Direct3D layer (every GL call whose result is used, every wait), counted in the runs
(readback counter and log, program statistics, the probe's synchronous kinds).

| # | Dependency | Where (today) | Frequency in the three games |
|---|---|---|---|
| 1 | `readPixels` of a render target / back buffer | `readbackSurface`: `GetRenderTargetData`, `GetFrontBuffer(Data)`, `LockRect` of a non-lockable `D3DPOOL_DEFAULT` render target or depth surface, `GetDC` of a render target or back buffer, D3D8 `CopyRects` from a render target, D3DX `LoadSurfaceFromSurface` from a render target | BFME1: 1 per session (a 256×256 render-target texture at its first frame, 2.3-2.5 ms, both runs); BFME2, RotWK: 0 |
| 2 | Program link status, active uniforms, uniform locations | `resolveProgram` at a program's first draw (`compile`) or when a learned program is taken unresolved (`takePrewarmed`) | per session: BFME2 7 programs built at a draw (21-41 ms here); BFME1 (800×600 settings; 2 of the 134 learned programs matched) 70 (373 ms); RotWK 22 (179 ms; 19 learned programs available); 0 waits on learned programs (all resolved ahead) |
| 3 | Learned programs resolved ahead | `beforeSlice`: `getSyncParameter` on a fence (non-blocking), `COMPLETION_STATUS_KHR` polls, `resolveProgram` once the GPU process has caught up | start-up and first menu (BFME2: 164 programs, 223 ms in 729 slices); 0 afterwards |
| 4 | `getError` | `checkErrors` after each of the first 64 draws; `debugDraw` (first 2 draws: `getParameter`, `getVertexAttrib`, one-pixel `readPixels`) | 66 calls per device, start-up only |
| 5 | `checkFramebufferStatus` | `bindTarget` when an FBO is created (render target, back buffer after `Reset`) | a few per session (BFME2: back buffer + 256×256 targets) |
| 6 | Caps: `getParameter` (renderer, max texture size, texture units), `getExtension` (s3tc, anisotropy, provoking vertex, parallel compile, lose_context) | device creation, context restore | once per device |
| 7 | Canvas size, `drawingBufferWidth/Height` | `reset` (resize), `present`, gamma pass | every present (local values, no round trip) |
| 8 | Present hand-off | `present` (`blitFramebuffer`, `flush`), host `transferToImageBitmap` + `postMessage` | every frame: `transferToImageBitmap` 20-33 µs, `flush` 8-10 µs |
| 9 | Present pacing / vsync | `Present` calls `vm.host.vsyncWait` only if the host defines it: the browser host does not; the games pace themselves on their timers | none |
| 10 | Frame statistics | host `framePresented` (clock), `GetRasterStatus` (clock) | no GL |
| 11 | D3D9 queries | `CreateQuery` EVENT / OCCLUSION answered at once (event done; occlusion = draws since `Issue`), no GL query objects | no GL |
| 12 | Context loss / restore | `webglcontextlost` / `restored` events on the worker's event loop (between slices) → `contextRestored()` | none in these runs (`--lose-context-at` tests it) |
| 13 | `Reset`, lost device (D052) | `reset()` (canvas resize, FBOs dropped); `TestCooperativeLevel` (no GL) | at mode changes |
| 14 | Debug tools | `--capture` (`readPixels` per draw, texture dumps), `--gl-validate` (`getParameter` per check), `glcount`, GL timing | off by default |
| 15 | Back-pressure (implicit) | any call blocks while Chrome's command buffer is full | none with `--gl-discard`; dominant under SwiftShader (2.3); not expected on a real GPU (2.4) |
| 16 | Answers from the backend's own state (no GL call) | `StretchRect`: the backend returns null when the source was never rendered on the GPU (no FBO), and the device then copies on the CPU; `CopyRects`/`LockRect` decide a readback from the surface's usage and memory | per call (rare in these games: 1 blit per frame in BFME2, a GPU blit) |

Steady state has no synchronous dependency at all; the ones that exist are start-up, a program's first use, and
rare readbacks.

## 5. Design: the Direct3D work as a stream, the backend in a render worker

### 5.1 Cut level

The backend (`WebGLDevice`) moves to the render worker **unchanged**: it reads a *device* object and resource
objects and issues GL calls. In the render worker that device is a **mirror** (`DeviceMirror`) with the fields the
backend reads (40 of them: `rs`, `tss`, `samplers` `StateTable`s; `transforms`, `lights`, `lightEnabled`, `material`;
`vsConst`/`psConst` and the I/B constants; `streams`, `indices`, `textures`; `vsObj`/`psObj`/`vertexShader(s)`/
`pixelShader(s)`; `vertexDecl`, `fvf`; `viewport`, `scissor`; `renderTarget`, `backBuffers`, `pp`; `api9`; the six
version counters), kept equal to the emulator's device at each draw by a stream of **state deltas**. The emulator
keeps its device as today (it answers `Get*`, state blocks, effects, validation) and records, instead of calling
the backend:

- each change of a backend-visible field, at the place it changes — not each API call: unchanged `Set*` values
  already return early, and the deferred `Set*` batches (D051) record their effects when they run;
- the six version counters as they are at each draw (one small record, so the mirror needs none of the Direct3D
  layer's rules about which change bumps which counter: it copies them);
- resource lifecycle and data, draws, clears, blits, present, readbacks.

Why not the GL level: section 3 (net 1.2-6.3 %). Why not record API calls and re-run the Direct3D layer in the render
worker: the layer works on guest memory and COM objects and answers the guest synchronously; it must stay with the
guest.

### 5.2 Threads and channels

```
page ── MessagePort ── render worker: OffscreenCanvas + WebGL2, DeviceMirror + WebGLDevice (today's backend)
 │                        ▲  shared: command ring, control block, guest memory (WebAssembly.Memory, shared since D058)
 └── emulator worker: guest, Direct3D layer (records) ──────┘
```

- The page starts the render worker beside the emulator worker and gives each one end of a `MessageChannel` for
  control messages (caps at start, shader bytecode is in the ring, program info, logs, learned/used program lists).
- The render worker owns its `OffscreenCanvas` (as the emulator worker does today) and posts each frame's
  `ImageBitmap` to the page itself; the page's display code does not change.
- The render worker reads guest memory for resource data (5.5) and writes it only for readbacks, while the emulator
  waits.

### 5.3 What is recorded

Hooks on the containers the backend reads, so that no `Set*` handler is edited one by one: `StateTable.set` (render,
stage, sampler states: one class), the device's `transforms`/`lights` maps and constant arrays (a small wrapper
class each), and the few scalar fields (`viewport`, `scissor`, `fvf`, `vertexDecl`, shaders, streams, indices,
textures, render targets) assigned in the handlers (`grep` over `d3d8.js`/`d3d9.js`: ~65 assignment sites, including
`resetState`, `ApplyStateBlock`, `Reset`). A delta names the field, the key and the value (int32 / float32 bits /
object id).

Objects travel as ids: textures, surfaces, buffers, shaders, declarations get an id at creation (`CREATE_*` with
format, size, levels, usage, pool, kind; shader bytecode copied; declaration elements copied) and a `DESTROY_*` when
released; `dev.textures[i]` (guest COM pointers today, resolved by `com.implAt`) becomes the id, and the mirror's
`com.implAt` maps ids to mirror resources.

Resource contents are not recorded, only what changed: `Unlock` and the other write paths (`surfaceUpdated`,
`bufferUpdated`, `volumeUpdated`) record the dirty range or rectangle, so the mirror's resources carry the same
`dirty`/`dirtyRect`/`dirtyLo..Hi` the backend uses today to upload lazily (5.5 says where the bytes come from).
Draw-time arguments the backend reads from guest memory (clear rectangles, `StretchRect`/`CopyRects` rectangles and
points, UP-draw vertex and index data) are copied into the command by the emulator.

### 5.4 Encoding

- One `SharedArrayBuffer` ring of 32-bit words with `Int32Array`/`Float32Array`/`Uint8Array` views. A command:
  header `opcode << 20 | payloadWords`, then arguments: int32, float32 (bit-exact through the float view), ids,
  inline byte payloads padded to words. A `WRAP` command at the end; a command never straddles it.
- Opcodes from one table (name, argument kinds) that generates both the encoder and the replayer (one source of
  truth; the replay test of 5.12 checks them).
- Cost (estimate, to be measured in step 1): ~0.09 µs per record (2.2). A BFME2 skirmish frame changes on the order
  of 3-4 thousand backend-visible values (API calls per frame: ~6.6 k, of which `SetTextureStageState` 880,
  `SetSamplerState` 470, `SetRenderState` 450, effect constants...), so ~0.3-0.5 ms per frame.

### 5.5 Resource data and lifetimes

Direct3D semantics: a draw uses the content a resource has at the draw. Today the backend uploads lazily at the
draw, reading guest memory. In the render worker the draw is replayed later, so the guest may already have changed
the memory. Rules:

- **Reference guest memory, fenced** (textures, static buffers: no copy, no second copy in memory). Each resource
  records `lastUseSeq`, the ring sequence number of the last command that may read its memory. Before the guest
  can write it again — `Lock`/`LockRect`/`LockBox` without `READONLY`, `GetDC`, D3DX fills, `UpdateSurface`/
  `UpdateTexture`/`ColorFill` destinations, `CopyRects` into it — the emulator waits until the render worker's
  `consumedSeq ≥ lastUseSeq` (`Atomics.wait` on the control block; usually already true: the render worker is less
  than a frame behind, and uploads come early in the frame that needs them). Memory release (`free()`) is deferred
  to a list drained when `consumedSeq` passes `lastUseSeq`.
- **Rename on `D3DLOCK_DISCARD`** (dynamic buffers refilled several times per frame): if the buffer is still in use,
  the lock returns a new guest block (the buffer's next block in a small per-buffer pool; old blocks recycled when
  consumed) — exactly the driver behaviour `DISCARD` exists for, and no wait. `NOOVERWRITE` returns the same memory
  without waiting (the application promises not to touch data in use).
- **Copy into the ring** for data with no lock protocol: UP-draw vertices/indices, rectangles, shader bytecode,
  gamma ramps.
- Per frame today the referenced data is 0.15-0.3 MiB (BFME2, RotWK skirmishes) to 0.4-1.9 MiB (BFME1); if the
  fence waits of plain locks show up in `gpuWaitMs`, the next step is copy-on-write for them (a renamed block
  initialized with the current content) — measured first, not assumed.
- Format conversion (`surfaceToRgba`, DXT decode without S3TC) runs in the render worker with the rest of the backend.

Games that write a buffer after `Unlock` without locking again (undefined in Direct3D) behave as on a driver that
renames: the write may or may not reach the pending draw. Today they see it reach the draw; the difference is noted
as a risk.

### 5.6 Ring sizing and back-pressure

- Command ring: 16 MiB. Per frame: a few thousand deltas and draws (~20-60 KiB) plus copied data (UP draws,
  rectangles: small), so the ring holds many times the 2 frames in flight allowed (5.8); a load's burst (resource
  creations) waits for the render worker.
- Control block (one cache line per word, each written by one side): `head`, `framesProduced` (emulator); `tail`,
  `consumedSeq`, `framesShown`, `contextEpoch`, `readbackDone`, `heartbeat` (render worker).
- The emulator publishes `head` (`Atomics.store` + `notify`) at `Present`, before any wait, at the end of each pump
  slice and every 64 KiB; the render worker sleeps in `Atomics.wait(head)` when it has caught up.
- Ring full: the emulator waits on `tail`, counted as `gpuWaitMs`.

### 5.7 Synchronous dependencies (section 4) in the design

| Dependency | Served by |
|---|---|
| readbacks (1) | `READBACK(surface id, guest address, pitch, rect)`; the emulator publishes `head` and waits on `readbackDone`. The render worker executes everything before it (as GL does today), reads pixels, converts (BGRA, flip) straight into guest memory, signals. Extra cost: one round trip (11-28 µs) |
| program link / uniforms (2, 3) | entirely in the render worker (it builds, links, resolves, compiles learned programs ahead in its own idle time); the emulator never waits for a link |
| `getError`, `checkFramebufferStatus`, debug draws (4, 5) | render worker, logged |
| caps (6) | queried by the backend in the render worker; sent in its `ready` message for the logs and the HUD |
| canvas size (7), present (8) | `RESIZE`, `PRESENT` commands; the render worker blits, flushes, transfers and posts the bitmap |
| pacing (9) | 5.8 |
| queries (11) | unchanged (no GL). An honest EVENT query later: answered from `consumedSeq` |
| context loss (12) | the render worker restores its own objects (`contextRestored()` runs there; resources are re-uploaded from guest memory, which the emulator keeps alive as today) and bumps `contextEpoch`; a pending readback is answered (zeros) so the emulator never hangs |
| `Reset` (13) | recorded like any other command; the canvas resize happens in the render worker |
| debug tools (14) | run in the render worker: `--capture` per draw, `--gl-validate`, `glcount`, GL timing; results as log messages |
| backend-state answers (16) | the emulator keeps the one fact it needs per surface — "has been a render target" (set when bound as one at a draw or clear, the rule `fbos.has(id)` encodes today) — and decides GPU blit or CPU copy itself; the blit is a command |

### 5.8 Present and frame pacing

- `Present` records `PRESENT(frameId)`; the render worker draws the frame to its canvas (blit or gamma pass), `flush`,
  `transferToImageBitmap`, posts it to the page, sets `framesShown`.
- At most 2 frames in flight: after `PRESENT(n)` the emulator waits while `framesShown < n − 2`. That is the driver's
  frame queue (Direct3D's default maximum latency is 3): a slower GPU slows the game instead of piling up old
  frames; input-to-display latency is bounded by 2 frames (67 ms at 30 fps; ~1 frame today).
- No vsync is added (the games pace themselves, the browser composites the bitmaps).
- Stats: `gpuWaitMs` on the emulator (ring full, frames in flight, readbacks, fences), `replayMs` per frame in the
  render worker; both in the HUD, the slow-frame lines and the telemetry, so a slow frame says which side was late.

### 5.9 Failure and fallback

- `?glworker=0` (and a manifest compat flag of the same name) keeps today's path: the backend on the emulator's
  thread, called directly. Default on only where it can work: `crossOriginIsolated`, shared guest memory, WebGL2 on
  an `OffscreenCanvas` in a worker.
- Start: no `ready` from the render worker within 5 s → logged, in-thread path.
- The render worker dies (`error` event) or its heartbeat stops for 5 s while commands are pending: the emulator
  stops recording and creates the in-thread backend on its own device (the `?glworker=0` path, which reads the
  device directly); resources are re-uploaded from guest memory, render-target contents are lost once — as after a
  device loss.
- Both paths run the same `WebGLDevice` code, so the fallback is not a second renderer.

### 5.10 Debug and measurement

The GL timing probe, `glcount`, captures and `--gl-validate` run in the render worker. The emulator adds its
recording time and `gpuWaitMs` to the slow-frame lines; the render worker reports `replayMs` and its own slow frames.

### 5.11 Implementation steps (phase 2)

1. Recording layer in-thread: container hooks, ids, deltas, version records — with the replay going straight into a
   `DeviceMirror` and the backend **on the same thread** (`?glworker=inline`). This isolates the fidelity question:
   rendering must be identical to today (screenshots of the three games, the replay test below) before any thread.
2. Ring + render worker + present path + readbacks; fences and renaming (5.5).
3. Context loss, fallback, debug tools, stats; then default on.

### 5.12 Tests

- Mirror equality: a randomized sequence of Direct3D calls (states, transforms, lights, constants, stream changes,
  state blocks, resets, resource creation/destruction, locks) run on a real device; after each draw, the
  `DeviceMirror` built from the recorded deltas must equal the backend-visible state of the device (field by field,
  version counters included).
- Backend equality: the backend run on the device and on the mirror against a recording GL context: identical GL
  call sequences.
- Encoder/replayer round trip of every opcode (generated table).
- Same-scene screenshots, three games, `?glworker=0/inline/1`: identical.
- Fences and renaming: a test PE that locks, draws, re-locks and overwrites (plain, `DISCARD`, `NOOVERWRITE`), reads
  back the render target; a readback test; `--lose-context-at`; a render-worker kill (fallback).
- Performance: alternated A/B `?glworker=0/1`, worker CPU per frame, frame-time p99.

### 5.13 Expected gain

Emulator-thread time per frame saved, from the measurements (recording estimated at 0.09 µs per record: GL level —
one record per WebGL call plus copies; Direct3D level — 0.3-0.5 ms per frame plus copies):

| Game, scene | frame ms | GL level: saved | Direct3D level: saved |
|---|---|---|---|
| BFME2 menu | 55.6-85.5 | 0.8-2.2 ms (1.4-2.6 %) | 3.8-6.0 ms (6.8-7.0 %) |
| BFME2 skirmish | 22.3-29.8 | 0.6-1.0 ms (2.7-3.4 %) | 2.1-4.1 ms (9-14 %) |
| BFME1 menu (800×600) | 71.3-124.6 | 0.8-5.0 ms (1.2-4.0 %) | 4.1-12.3 ms (5.7-9.9 %) |
| BFME1 skirmish (800×600) | 19.8-24.4 | 0.9-1.5 ms (4.4-6.3 %) | 3.7-5.0 ms (19-21 %) |
| RotWK menu | 22.0 | 0.3 ms (1.2-1.5 %) | 0.6 ms (2.7 %) |
| RotWK skirmish | 25.1-29.9 | 0.6-0.7 ms (2.4-2.5 %) | 2.0-2.3 ms (7.6-8.0 %) |

Not gains: GPU-bound frames (SwiftShader) stay GPU-bound; a program's first use still delays its frame (by up to
2 frames less). Possible extras: GPU-process hiccups shorter than 2 frames no longer stall the emulator; the
backend's garbage and GC move off the emulator's thread.

### 5.14 Risks

- Fidelity: the mirror must equal the device at every draw. Mitigated by hooking containers rather than handlers,
  version counters copied rather than recomputed, the in-thread step 1, and the equality tests; a miss is a
  rendering bug, visible in screenshots.
- Memory lifetime: every write path to resource memory needs its fence (5.5); a missed one is a race that shows as a
  wrong frame, rarely. The list of write paths is short and testable; `?glworker=inline` keeps the same fences
  without the thread for debugging.
- Behaviour of games that write buffers without locking (5.5).
- Latency: up to 2 frames in flight instead of ~1.
- Memory: a 16 MiB ring, the render worker's heap (~20-40 MiB), the GL objects moving rather than doubling.
- Deadlock: the emulator waits for the render worker (ring, frames, readbacks, fences), never the reverse; every
  wait is bounded (5 s → log + fallback).
- Debugging across threads: GL errors and captures arrive asynchronously, tagged with frame and draw numbers.

## 6. Also worth doing (same measurements)

- Optimize the backend translation in place (it bounds the render worker's frame time too): `applyState` is 9.8 %
  of the worker inclusive in a BFME2 skirmish (3.9 % self), with `samp()` 1 %; BFME1 spends ~9 µs of translation per
  draw. State reads through `rs()`/`tss()`/`samp()` and per-draw comparisons dominate.
- Measure the player's machine with `?dbg=ORTHROS_GL_TIME=300@6000` before and after.
- Keep compiling programs ahead (D056): it removes the only frequent synchronous wait on a real GPU.

## 7. Implementation (phase 2)

### 7.1 Modules

| File | Role |
|---|---|
| `src/gfx/cmd-ring.js` | the command table (name and argument kinds of every command), `RingWriter` / `RingReader` over a ring of 32-bit words, the control-block layout |
| `src/gfx/d3d-recorder.js` | emulator side: `Recorder` (a device's `gfx` in place of the backend) and `RenderLink` (the ring, ids and slots, fences, renames, deferred releases, waits) |
| `src/gfx/d3d-mirror.js` | replay side: mirror resources (`MSurface`, `MTexture`, `MBuffer`), `DeviceMirror`, `Replayer`; `compareDevice` (mirror == device, field by field) |
| `src/gfx/render-loop.js` | the render worker's loop (replay, publish the words consumed, sleep on the head word, yield to the event loop) |
| `src/gfx/render-worker.js` | the render worker: its `OffscreenCanvas` and WebGL2 context, frames posted to the page, readbacks, learned programs, statistics |
| `src/gfx/render-host.js` | `host.gfx` objects of the modes below, for the emulator worker |

The backend (`WebGLDevice`) is unchanged except for three input shapes: clear and `StretchRect` rectangles and UP-draw
data may be passed as values instead of guest addresses (they are copied at the draw), and `readBackBuffer()` for the
frame comparison.

### 7.2 Modes (`?glworker=`, harness `--glworker`; manifest compat flag `"glWorker"`)

| Mode | What runs where |
|---|---|
| `0` (default) | today's path: the backend on the emulator's thread |
| `1` | the render worker replays and presents; the emulator records |
| `inline` | recorded and replayed on the emulator's thread (at presents, readbacks, fences, a full ring): the recording checked without a thread |
| `check` | `inline`, replayed after every draw and the mirror compared with the device field by field (mismatches logged) |
| `compare` / `compare-worker` | the in-thread backend renders and presents as usual; the recorded work is also replayed (in this thread / in a render worker) into a second context, and both back buffers are read just before the present and compared every 60 frames — the same scene, pixel for pixel (`render compare:` lines) |

### 7.3 What changed from the design (section 5)

- **State**: the state tables tell the recorder of each `set` (a mark per key, one `TSETS` command per draw); the
  stages' textures, streams and indices come from the `gfx.setTexture` / `setStreamSource` / `setIndices` calls every
  setter already makes; transform slots from `touchTransform`; constants from the writers (`constTouched`: the 8
  `Set*ShaderConstant*` handlers and the effect's direct writes); the few other fields (viewport, scissor, FVF,
  declaration, shaders, render target, back buffers, presentation parameters, lights, material) are compared at each
  draw; the 7 version counters are copied. `api9` is a field too (a Direct3D 9 device is a Direct3D 8 one until its
  constructor ends).
- **Resource reads by the render worker** are tracked with an acknowledgement table (64 Ki slots, shared): every
  write path of the emulator stamps the resource with a new *generation*; the render worker writes the generation it
  uploaded (after `glTexture` / `glBuffer`). A write waits only while a not-yet-replayed command may read the
  resource **and** its latest generation is not uploaded yet. Write paths: `Surface.ensureMem` (locks, `GetDC`,
  copies, fills, D3DX loads all go through it), `LockBox`, D3DX volume fills, `Buffer.Lock`.
- **`D3DLOCK_DISCARD`** on a buffer still in use gives it a block from a per-buffer pool (3 at most) — **with the
  buffer's contents copied**: what the application does not rewrite reads as before (undefined after `DISCARD` in
  Direct3D, the old contents in the in-thread path: kept identical).
- **`D3DLOCK_NOOVERWRITE`** waits only when the locked range meets ranges written but not uploaded yet (a pending
  upload takes their union, possibly more than the draws use), or before the buffer's first upload (all of it).
- **Readbacks**: the memory the pixels go to is allocated by the recorder and handed to the mirror surface once the
  pixels are read, as the backend allocates it (a level uploaded meanwhile sees no memory, as in-thread).
- **Back-pressure**: the head is published after every draw (a store, no notification) and notified every 32 draws
  or 16 Ki words when the render worker sleeps; it wakes by itself every 2 ms; frames in flight: 2.
- Found and fixed on the way, for every path: render-target readbacks are packed in the surface's format (16-bit
  formats were written as 32-bit pixels, past the surface), `UpdateTexture` requires equal formats (it copied past
  smaller levels), new vertex/index buffers are zeroed (their contents depended on what the allocator reused), the
  first-draw diagnostics survive a draw without stream 0.

### 7.4 Tests

- `tests/render-worker.test.js`: every command round-trips through the table; `dx.exe`, `dx9.exe`, `d3dlost.exe` issue
  the same WebGL calls (recording context, `tests/fake-gl.js`) in-thread and recorded + replayed; randomized Direct3D
  9 and 8 sessions (`tests/d3d-random.js`: states, transforms, lights, constants, shaders, declarations, textures of
  every kind with locks, buffers with plain / DISCARD / NOOVERWRITE locks, state blocks, render targets, Reset,
  surface copies, fills, readbacks, gamma, UP draws, clears, presents): the mirror equals the device at every draw,
  and the same WebGL calls both replayed at once and replayed late (fences, renames, deferred releases).
- `tests/render-worker-thread.test.js`: the same sessions replayed by the render loop **in a worker thread** (shared
  memory, ring, control words, acknowledgements; also with a slowed worker): the same WebGL calls; a worker that
  stops answering is reported once and the emulator stops waiting.
- `tests/browser.test.js`: `dx9.exe` and `dx.exe` with `?glworker=inline` and `1` in Chromium: same pixels, same
  readbacks, gamma ramp.
- `tools/render-record-bench.mjs`: the recording cost per draw.

## Appendix: how the numbers were taken

Each run: `tools/with-browser-slot.sh node tools/headless.mjs <manifest> --gl-discard --timescale 1.5 --learn <copy of
learn-live> [--profile-dir <copy of the game profile>] --input "<sequence>"`, the sequence being the game's scenario
(`tools/scenarios`: BFME2 menu reached with Escape presses and `waitframe:10,100000`, then `bfme2-skirmish-sync`'s
clicks; `bfme-skirmish-high`'s for BFME1; `rotwk-skirmish`'s for RotWK with its clicks scaled to the profile's
1024×768) with, in the menu and again in the skirmish (`waitframe`/`waitfps` anchors):

```
10:mark:warm;11:dbg:ORTHROS_GL_TIME=150;25:mark:N1;25:dbg:ORTHROS_GL_NULL=1;40:mark:R1;40:dbg:ORTHROS_GL_NULL=0;
55:mark:A1;70:mark:N2;70:dbg:ORTHROS_GL_NULL=1;85:mark:R2;85:dbg:ORTHROS_GL_NULL=0;100:mark:A2;115:mark:end;
116:dbg:ORTHROS_GL_TIME=150;131:profile:20
```

The `[gfx] d3d-webgl: GL timing report` lines give the per-call figures, the `[cpu] phase` lines the A/B, the
`[profile]` lines the V8 cross-check. The SwiftShader rows (2.3): the same without `--gl-discard` and `--timescale`.
