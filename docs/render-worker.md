# Render worker — measurements and design (phase 1), implementation (phase 2)

Status: the render worker is the default (section 8.8, 2026-10-04; it was the default from 2026-10-02, then off
again from 2026-10-03 until the measurements of 8.8 — sections 8.5-8.7 were written while it was on). `?glworker=0`
or the manifest flag `"glWorker": 0` / `false` keep the in-thread backend; where a render worker cannot run (no
cross-origin isolation or shared memory) the in-thread backend is used. Implemented in section 7. Phase 1 added for the measurements: the probes `ORTHROS_GL_TIME` and
`ORTHROS_GL_NULL` and readback / buffer-byte counters (`src/gfx/d3d8-webgl.js`, test `tests/gl-probe.test.js`),
`GL timing` reports forwarded to the telemetry (`src/web/main.js`), and `tools/bench/cmdring-bench.mjs`.

**Summary.** On the emulator's thread the WebGL calls themselves cost only 1.3-6.9 % of a frame, and no WebGL call
waits for the GPU in steady state; the backend's translation work (JavaScript that turns Direct3D state into GL
calls) costs about as much to 3 times more. Recording the GL calls for another thread (a "remote GL") would save
1.2-6.3 % net of the recording cost: not worth a second rendering path. Moving the **whole backend** — recording the
Direct3D work as a stream of state changes, resources and draws that a render worker turns into WebGL — removes
8-21 % of the emulator thread's time in skirmishes (its whole backend share minus the recording), in every
Direct3D 8/9 game. That is the design below (section 5), recommended for implementation in steps, with the
in-thread path kept as fallback.

## 1. Today

One dedicated worker (`src/web/worker.js`) runs the guest (JIT, green threads), the Win32/Direct3D layer
(`src/win32/d3d8.js`, `d3d9.js`, `d3dx9*.js`) and the WebGL2 backend (`src/gfx/d3d8-webgl.js`) on a worker-owned
`OffscreenCanvas`. At `Present` the backend blits the back-buffer FBO into the default framebuffer and `flush()`es;
the host (`src/web/browser-host.js`) hands `canvasGl.transferToImageBitmap()` to the page (`bitmaprenderer`).

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
- **Recording cost:** `tools/bench/cmdring-bench.mjs` (a synthetic frame shaped like the measured ones recorded into a
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

**Recording into a ring** (`tools/bench/cmdring-bench.mjs`, this machine): 78-114 ns per call over a plain function call,
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
| 9 | Present pacing / vsync | `Present` (d3d8.js) parks the game's thread on the guest clock when its presentation interval waits for the retrace (no GL, no host call): at most one frame per refresh (60 Hz, a fullscreen mode's rate), a floor since the previous slot — a slower frame is not held | none |
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
- No browser vsync is waited for (the browser composites the bitmaps). The guest's own presentation interval is honoured
  on the guest clock: a Present whose interval waits for the retrace (D3D8 fullscreen DEFAULT/ONE..FOUR or windowed
  COPY_VSYNC, D3D9 DEFAULT/ONE..FOUR) shows at most one frame per refresh, as on Windows (Vice City's menu: 250-360
  frames/s before, 60 after; `?dbg=ORTHROS_VSYNC=0` switches it off).
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
| `0` | the backend on the emulator's thread (the default until section 8) |
| `1` (default) | the render worker replays and presents; the emulator records |
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
  copies, fills, D3DX loads all go through it), `LockBox`, D3DX volume fills, `Buffer.Lock`. A surface of at most
  4 MiB written meanwhile is copied on write instead of waited for (new guest memory with its contents; the old block
  released once the commands reading it are replayed; `ORTHROS_RW_COW=0`: wait).
- **Buffers rewritten while in use: their contents travel in the ring.** A dynamic buffer (`D3DUSAGE_DYNAMIC`) from
  its first use, and any other buffer once a lock had to wait for it, copies its written bytes into the ring when a
  draw reads them (`BUF_DATA`, 1 MiB chunks; its whole contents once when it switches). The mirror buffer keeps its
  own copy and the backend uploads from it, so those buffers' locks never wait and their memory is released at once.
  - `Unlock` only notes the written range (`lazyAdd`: the buffer's pending ranges, where the mirror's copy may differ
    from guest memory). Before each draw (`Recorder.readBuffers`), the pending bytes it reads go into the ring: its
    indices, and for each stream of the current vertex layout the vertices from the lowest to the highest one it
    reads, plus the layout's element extent — for an indexed draw the lowest and highest index **of the index data**
    (cached per first index until the index buffer is written), never the call's `MinIndex` / `NumVertices`, which
    games understate. Anything that cannot be bounded copies the whole buffer. Bytes written again before any draw
    reads them, or never read, never travel. A copy has a cost of its own, so a pending range of at most 16 KiB that a
    draw meets goes whole, and a buffer with at most 32 KiB pending goes whole without bounding the draw (BFME2's
    menu: 358 copies and 245 index scans per frame otherwise, against 36 copies at `Unlock`, for the same 72 KB).
  - Measured (Node framebench `--ab ORTHROS_VB_LAZY=0:25`: blocks of 25 frames alternated within one run, same
    scene): BFME1 menu at 820 draws per frame 2.42 → 1.58 MB per frame copied, api + draw 3.88 → 3.80 ms; at 1 540
    draws 3.30 → 2.01 MB, api + draw 4.77 → 4.31 ms (first version of the policy). BFME2 menu: 72 KB either way,
    api + draw 2.02 → 2.17 ms (noise level). The copy left the emulator thread's `Unlock` for its draws: the gain is
    the bytes that no longer travel, not the calls.
  - Upload calls differ from in-thread (other ranges, other bytes in the never-read parts); what every draw reads
    does not. The tests compare the WebGL draws by the bytes they read (`fakeGl({ reads: true })`), and
    `ORTHROS_VB_LAZY=0` (a worker debug global) copies at `Unlock` again, with the exact-call comparisons.
  - `ORTHROS_VB_CHECK=1` (harness `--dbg`, framebench `--dbg`): after each draw's copies, every index and every byte
    of every vertex the draw reads (each index's vertex) is compared with guest memory through the recorder's own
    copy of what the mirror holds; a difference is a stale read, counted (`stats.vbStale`) and logged
    (`render record: VB check: ...`, a summary every 600 frames). Slow: diagnostics only. (The first implementation renamed them on `DISCARD` and copied the whole
  buffer at every lock still in use: 51 renames, ~32 MiB copied per BFME2 skirmish frame — the emulator thread was
  slower than in-thread.) What the application does not rewrite after `DISCARD` reads as before, as in-thread.
- **`D3DLOCK_NOOVERWRITE`** on another buffer waits only when the locked range meets ranges written but not uploaded
  yet (a pending upload takes their union, possibly more than the draws use), or before the buffer's first upload.
- **Readbacks**: the memory the pixels go to is allocated by the recorder and handed to the mirror surface once the
  pixels are read, as the backend allocates it (a level uploaded meanwhile sees no memory, as in-thread).
- **Back-pressure**: the head is published after every draw (a store, no notification) and notified every 32 draws
  or 16 Ki words when the render worker sleeps; it wakes by itself every 2 ms; frames in flight: 2.
- Found and fixed on the way, for every path: render-target readbacks are packed in the surface's format (16-bit
  formats were written as 32-bit pixels, past the surface), `UpdateTexture` requires equal formats (it copied past
  smaller levels), new vertex/index buffers are zeroed (their contents depended on what the allocator reused), the
  first-draw diagnostics survive a draw without stream 0.

### 7.4 Failure, context loss, debugging

- The render worker answers within 10 s of its start (`ready`, with the renderer's name), else the devices get the
  in-thread backend; the emulator waits for that answer before running the guest (a nested worker's scripts load
  through its parent's thread: an emulator blocked from the start — a readback in the first slice — kept it from ever
  loading). While the emulator waits for it (fences, readbacks, frames, a full ring), no progress (neither
  its heartbeat nor its consumed words) for 30 s, or no answer within 90 s, has the same effect (SwiftShader on the
  loaded server can spend seconds in one GL call: 10 s was reached once in a compare run): logged, the render
  worker terminated, every device given the in-thread backend (`renderInThread` in the worker: resources are
  uploaded again from guest memory on use, render-target contents lost once, as after a lost context). Testing:
  harness `dbg:ORTHROS_RW_STALL=1` stops the render worker's loop.
- `dbg:ORTHROS_RW_NO_PRESENT=1` (measurement): frames rendered but not handed to the page (each bitmap closed) — the
  cost of the hand-off to the page's main thread, in one session. BFME 1.08 play (2026-10-22, harness with a Chrome
  trace, `--gl-discard`): the page's main thread ran ~5 major garbage collections per second (~45 ms of GC per second)
  with and without the hand-off (19 per 4 s either way; its JavaScript calls 62 → 31 per second): the frames are not
  what drives them — still to explain (the harness's own polling and logging are the suspects).
- A command that throws in the render worker is logged (`render worker: <command> failed`) and skipped; presents
  and readbacks are answered even then, so the emulator never waits for a dead command.
- Context loss happens in the render worker (its canvas's events: `contextRestored()` as in-thread, the epoch word
  incremented); harness `--lose-context-at` reaches it through the emulator worker.
- `dbg:` globals, `--capture`, `glcount`, the GL timing probe, `--gl-validate` and `--gl-discard` reach the render
  worker (the globals at its start, `dbg:` messages later); its logs and captured images go to the page directly.
- Statistics: the emulator's waits (`gpuWaitMs`, by kind: fences, frames, readbacks, ring), buffer bytes sent
  through the ring, surface copies on write and their bytes, the render worker's replay time: in the HUD's panel, the slow-frame lines (`render waits`), the `mark:`
  lines of the harness (per phase, with the frame-time percentiles), and the stats message (`gl`).

### 7.5 Tests

- `tests/render-worker.test.js`: every command round-trips through the table; `dx.exe`, `dx9.exe`, `d3dlost.exe` issue
  the same WebGL calls (recording context, `tests/fake-gl.js`) in-thread and recorded + replayed; randomized Direct3D
  9 and 8 sessions (`tests/d3d-random.js`: states, transforms, lights, constants, shaders, declarations, textures of
  every kind with locks, buffers with plain / DISCARD / NOOVERWRITE locks, state blocks, render targets, Reset,
  surface copies, fills, readbacks, gamma, UP draws, clears, presents): the mirror equals the device at every draw,
  and the same WebGL calls both replayed at once and replayed late (fences, buffer contents in the ring, surface
  copies on write, deferred releases).
- `tests/render-worker-thread.test.js`: the same sessions replayed by the render loop **in a worker thread** (shared
  memory, ring, control words, acknowledgements; also with a slowed worker): the same WebGL calls; a worker that
  stops answering is reported once and the emulator stops waiting.
- `tests/render-worker-host.test.js`: the browser render worker (`render-worker.js`) and the emulator side of
  `render-host.js` in a Node worker thread with a shimmed canvas: `dx.exe` and `dx9.exe` draw the same WebGL calls,
  frames are posted, readbacks answered; `?glworker=check` and `compare` on this thread: no mismatch.
- `tests/browser.test.js`: `dx9.exe` and `dx.exe` with `?glworker=inline` and `1` in Chromium: same pixels, same
  readbacks, gamma ramp.
- `tools/bench/render-record-bench.mjs`: the recording cost per draw.

### 7.6 Measurements and decision (default stays `?glworker=0`; revised in section 8)

Conditions as in 2.1 (headless Chromium + SwiftShader on the shared server, load 25-33), `--gl-discard --timescale 1.5`,
learned data copied from `learn-live`, game profiles for BFME2 and RotWK; skirmish in play, idle camera, three
consecutive 15-20 s phases per run (`mark:` lines: worker thread CPU per frame from `/proc`, frame-time
percentiles); runs alternated 0, 1, 0, 1 per game.

**Fidelity** (`?glworker=compare-worker`, no `--gl-discard`: the in-thread backend presents, the recorded work is
replayed in a render worker, both back buffers compared pixel for pixel): BFME2 menu to skirmish 104 frames compared
(every 60), BFME1 menu to skirmish 240, RotWK menu to skirmish 400 (every 10): **0 differing**. `dx.exe`/`dx9.exe`
in Chromium with `?glworker=1` and `inline`: same pixels and readbacks (`tests/browser.test.js`). Context loss in the
render worker (BFME2 skirmish setup, `--lose-context-at`): restored, the screen redrawn correctly (an 11 s
stall while SwiftShader rebuilt the programs; not compared with the in-thread path). Screenshots of `?glworker=1`
without `--gl-discard` (frames shown by the render worker): BFME2 and RotWK skirmish setup and skirmish identical in
content to the in-thread ones of the compare runs.

**Emulator thread CPU per frame (ms) in skirmish, three phases per run:**

| Game | `?glworker=0` | `?glworker=1` | difference of the means |
|---|---|---|---|
| BFME2 | 22.90 23.13 23.86 / 24.97 24.88 26.46 (mean 24.37) | 22.58 23.09 22.03 / 22.52 22.39 24.22 (mean 22.80) | −1.6 ms (−6 %) |
| BFME1 (800×600 runs) | 18.56 18.08 18.62 | 16.09 16.32 15.94 | −2.3 ms (−12 %) |
| BFME1 (1024×768 runs, capped near 58 fps) | 15.60 15.35 14.86 | 14.89 15.15 15.14 | −0.2 ms (noise) |
| RotWK | 25.66 26.35 26.06 / 23.42 24.78 28.22 (mean 25.75) | 23.33 24.53 24.74 / 24.70 27.31 26.94 (mean 25.26) | −0.5 ms (noise: ±2 ms between phases) |

(BFME1's first-launch detection chose a different resolution in two of the four runs: the pairs are compared per
setting, one run each.) The render worker's own CPU: 2.9-4.0 ms per frame (BFME2), 2.6-4.2 (BFME1), 2.6-3.4 (RotWK).
Emulator waits for it in play: 0 ms (no fence, frame or readback wait in any skirmish phase); recording 0.16 ms per
frame (BFME2, `ORTHROS_REC_TIME`); buffer bytes through the ring 140 KiB per frame (BFME2), 220 KiB (RotWK),
300-400 KiB (BFME1).

**Frame time p99 (ms) in skirmish:** BFME2 33.7 34.2 34.0 45.8 38.5 41.0 (off) / 31.9 30.1 30.4 35.5 35.4 46.8 (on);
BFME1 21.8-25.7 (off) / 20.9-22.2 (on); RotWK 56.9 67.1 58.8 46.2 59.1 75.8 (off, mean 60.6) / 49.4 81.3 86.3 59.0
73.6 99.0 (on, mean 74.8).

**Decision: not on by default.** It is exact, and it takes 0-2.3 ms per frame off the emulator thread in BFME1 and
BFME2, but on RotWK the gain is within the noise and the p99 frame time is worse in these runs; the bar (exact *and*
faster on all three games) is not met. The measured gain is also below the 9-21 % of the study (5.13): the backend's
time does leave the thread (the render worker spends 3-4 ms per frame on it), but the emulator thread gains back only
part of it on this machine. To revisit on a machine without SwiftShader competing for cores (the player's), with
`?glworker=1` and the `mark:`/HUD figures above.

## 8. Why RotWK and Vice City gained little; the per-draw work; the render worker by default (2026-10-02)

### 8.1 Where the emulator thread's time goes, by mode

The frame accounting (docs/frame-accounting.md) charges every moment of the emulator thread to a category; `draw` is the
backend's work in the in-thread mode and the recording with `?glworker=1`. Skirmish (BFME2, RotWK) and drive (Vice
City) in play, `--gl-discard --timescale 1.5`, the code before this section's changes, one run per mode (ms per frame;
three 25 s phases, Vice City one 22 s phase):

| Game | mode | guest | api | draw | api + draw | draws / frame | emulator CPU / frame |
|---|---|---|---|---|---|---|---|
| RotWK | 0 | 20.0 | 3.90 | 2.10 | 6.00 | 187 | 26.6 |
| RotWK | 1 | 20.8 | 4.30 | 0.67 | 4.97 | 188 | 26.4 |
| BFME2 | 0 | 18.5 | 5.27 | 3.10 | 8.37 | 154 | 25.7 |
| BFME2 | 1 | 19.6 | 5.70 | 1.20 | 6.90 | 153 | 24.1 |
| Vice City | 0 | 13.1 | 6.40 | 2.90 | 9.30 | 495 | 22.7 |
| Vice City | 1 | 13.4 | 7.40 | 1.30 | 8.70 | 542 | 22.3 |

Why the RotWK and Vice City gains were small:

1. **The backend is a small share of their frame.** RotWK's `draw` is 2.1 ms of 26.5 (8 %); its frames over 33 ms are
   83-92 % guest code (their excess over the median frame), in both modes. A render worker takes the backend's share;
   it cannot shorten those frames.
2. **The recording cost more than estimated**: 0.65 ms per frame in RotWK (3.5 µs per draw; 5.4 estimated 0.3-0.5 ms),
   1.3 ms in Vice City (2.6 µs per draw over ~500 draws). The recording probe (`ORTHROS_REC_TIME`, which now also times
   the recorder's parts) and V8 profiles put it in the re-binding of every stage and stream at each flush, the lights
   compared through views allocated at every material change, generic encodings of the stream, index, light and
   material commands, and the constant copies.
3. **The games take part of the freed time back.** RotWK's `api` grows by 0.3-0.4 ms per frame: 0.1 ms are buffers
   rewritten while in use (their written ranges copied into the ring at Unlock, ~230 KiB per frame; a copy into shared
   memory runs at 2-3 GB/s), the rest is the game — it calls `Sleep` 50 % more often (468 000 against 313 000 calls per
   25 s, ~1.1 µs each) and runs 0-6 % more guest instructions per frame: its frame rate is not bound by its main
   thread's Direct3D work alone. Vice City polls `PeekMessage` 115-140 thousand times per second while it waits for its
   next frame (30 fps cap, 45 with `--timescale 1.5`): its `api` is pacing, more of it when frames are cheaper. BFME2 at
   the cap sleeps likewise (1.16 million `Sleep` calls per 25 s).
4. **Measurement.** The earlier A/B (7.6) compared whole-thread CPU per frame, whose phase-to-phase spread (±2 ms in
   RotWK) exceeds the gain (~1 ms); skirmishes also differ between runs (BFME2 starts at 154 or 239 draws per frame
   depending on the start position; RotWK's guest instructions per frame differ by up to 8 %). The comparable figures
   are the Direct3D work per frame (`api` + `draw`) and per draw.

### 8.2 The per-draw work

**Changes** (all exact; their unit tests in parentheses):

- WebGL backend: a constant write log (`constTouched`, fed by every writer of the device's constant arrays and by the
  mirror's `CONST` records): a program compares only the registers written since its last draw, not all 1 024 floats
  (`tests/gl-const-sync.test.js`); integer and boolean registers sent only when they differ from what the program holds;
  a program's transform uniforms looked up once; fixed-function lights and material compared only when they or the view
  moved, the ambient color with the render states, the enabled-light order rebuilt only when the enabled set can have
  changed (`tests/gl-lights.test.js`); a draw over several streams finds the VAO of its program's last binding without
  building a key (`tests/gl-vao-streams.test.js`); the depth / stencil / blend / cull block derived again only when one
  of the render states it reads changed (`StateTable.watchKeys`, the keys taken from `applyRaster`'s source;
  `tests/gl-state-cache.test.js` catches a key left out).
- Recorder (the emulator thread with the render worker): only the stages and streams that were set are visited, a stream
  set again to the same binding records nothing, the stream / index / light / material commands are encoded in place,
  lights and material compared without allocating, constant runs copied by a loop (a typed-array copy into shared memory
  is slower below ~128 words).
- Replay (render worker): the commands of every draw read straight from the ring words, without the decoded argument
  list or views (`tests/render-replay-fast.test.js`: random commands in every encoding the table allows, the fast path
  equals the general one).
- API dispatch: the thunk table is allocated whole. Internal thunk pages come from the top of the thunk region, so the
  table grew sparse (2 300 entries up to index 65 000) and V8 kept it as a dictionary: every API call — the dispatcher,
  and each call of the JIT's deferred queue, i.e. every Direct3D state setter — paid a hash lookup for its thunk
  (`tests/builtin-modules.test.js`). BFME2 main menu in Node, three alternated pairs: `api` 7.28 → 6.53 ms per frame.

**Synthetic scenes** (`tools/bench/backend-draw-bench.mjs`: a D3D9 shader scene with effect-style constants, a texture and a
stream per draw and a dynamic vertex buffer refilled before every third draw; a D3D8 fixed-function scene with world
matrix, material and two lights per draw). Instructions per draw on top of the Direct3D layer's own (`perf stat`,
difference of two run lengths: insensitive to the machine's load):

| | D3D9 shader scene, before → after | D3D8 fixed-function scene, before → after |
|---|---|---|
| in-thread backend | 22.6k → 10.6k (−53 %) | 16.4k → 12.4k (−25 %) |
| recording (emulator thread, `?glworker=1`) | 10.8k → 8.0k (−26 %) | 12.6k → 7.7k (−39 %) |
| render worker (replay + backend) | 37.5k → 18.2k (−51 %) | 31.5k → 20.1k (−36 %) |

**Real scenes, no browser** (`tools/bench/framebench.mjs`: the game in Node, its Direct3D work to the backend over a no-op
WebGL2 context or to the recorder; the frame accounting of 300-400 frames once frames carry a 3D scene; two runs each,
alternated; before the raster watch and the thunk table):

| Game, scene | draws / frame | backend µs per draw, before → after | recording µs per draw, before → after |
|---|---|---|---|
| BFME2 main menu (D3D9, effects) | 450-530 | 6.89 → 6.26 (−9 %) | 3.02 → 1.92 (−36 %) |
| BFME1 main menu | 977 | 3.93 → 3.65 (−7 %) | 1.30 → 0.98 (−25 %) |
| Vice City in game (D3D8 fixed function) | 217 | 4.21 → 3.82 (−9 %) | 1.73 → 1.59 (−8 %) |

The synthetic scenes overstate the backend's gain: in the real ones most of a draw's backend time derives state that
really changed (program signatures when effects switch shaders, blend and depth state between passes). In the browser
(8.3) the backend costs 8-13 µs per draw, its WebGL calls included, and the recording 1.9-3.7.

### 8.3 Browser measurements after the changes

The code of this section up to the replay's fast paths (the raster watch and the thunk table came later and are
measured in 8.2), alternated runs per game, play phases as in 8.1. **CPU only** (`--gl-discard --timescale
1.5`, cap 45 fps). `D3D work` = `api` + `draw` per frame (the Direct3D layer, the drained state setters, the backend or
the recording); µs per draw = `draw` / draws:

| Game | mode | fps | > 40 ms / min | > 50 ms / min | p99 ms | D3D work ms | draws / frame | µs / draw | emulator CPU / frame | render worker CPU / frame |
|---|---|---|---|---|---|---|---|---|---|---|
| RotWK | 0 | 35.3 / 34.6 | 159 / 214 | 88 / 100 | 80 / 73 | 6.30 / 6.39 | 225 | 9.8 / 10.1 | 27.6 / 28.0 | — |
| RotWK | 1 | 34.0 / 34.9 | 199 / 208 | 92 / 109 | 78 / 82 | 5.54 / 5.00 | 225 | 3.4 / 2.7 | 27.7 / 27.7 | 3.2 / 2.9 |
| BFME2 | 0 | 35.3 / 35.5 | 51 / 24 | 10 / 2 | 54 / 44 | 9.89 / 9.90 | 239 | 12.8 / 12.7 | 27.7 / 27.6 | — |
| BFME2 | 1 | 43.8 / 43.2 | 7 / 9 | 3 / 4 | 36 / 35 | 5.93 / 5.90 | 154 | 3.3 / 3.7 | 21.7 / 22.1 | 2.6 / 2.7 |
| BFME1 | 0 | 52.9 / 53.6 | 1 / 2 | 1 / 1 | 27 / 26 | 6.06 / 5.83 | 356 | 8.1 / 7.8 | 18.2 / 17.9 | — |
| BFME1 | 1 | 55.9 / 56.2 / 56.6 | 3 / 3 / 2 | 2 / 1 / 2 | 26 / 23 / 23 | 4.19 / 4.20 / 4.27 | 356 | 2.2 / 2.3 / 1.9 | 16.3 / 16.2 / 16.0 | 3.6 / 3.5 / 3.2 |
| Vice City | 0 | 43.2 / 42.0 | 25 / 44 | 8 / 14 | 40 / 46 | (pacing) | 516 / 535 | 6.2 / 6.7 | 22.5 / 23.0 | — |
| Vice City | 1 | 44.3 / 41.4 | 11 / 66 | 6 / 26 | 33 / 50 | (pacing) | 550 / 609 | 2.0 / 2.3 | 22.3 / 22.7 | 3.7 / 4.5 |

Per draw the emulator thread does 3-4 times less Direct3D work with the render worker, in every game. BFME1 (the same
scene in every run) costs 1.9 ms less CPU per frame (−10 %, +5 % fps); BFME2's runs started at different places of the
map (239 or 154 draws per frame), so only its per-draw figures compare, and its render-worker runs reached the frame
cap; RotWK's frame figures are within the run-to-run spread (its frames are bound by guest code, 8.1); Vice City runs
at its cap and spends the difference in its own pacing loop.

In-thread (`?glworker=0`), this code against the code before it, concurrent pairs (same slot): RotWK 11.1 → 10.6 and
11.0 → 9.5 µs per draw (D3D work 6.27 → 5.93 and 6.67 → 6.20 ms per frame), BFME1 10.4 → 10.1 and 8.0 → 6.9 (7.56 →
7.36 and 6.23 → 5.37), Vice City 7.0 → 6.9 and 6.6 → 6.4, BFME2 12.7 → 12.4: in the browser most of a draw's backend
time is its 8-10 WebGL calls, so the JavaScript savings of 8.2 show as 2-14 %.

**Rendered** (SwiftShader, `--timescale 1`: the frame rate is the software rasterizer's on this shared machine; the share
of frames over 50 ms rather than their count per minute, which grows with the frame rate when every frame is slow):

| Game | mode | fps | frames over 50 ms | p99 ms | emulator CPU / frame | waits for the render worker, ms / frame |
|---|---|---|---|---|---|---|
| RotWK | 0 | 11.5 / 10.4 | 62 % / 70 % | 1 394 / 468 | 28.9 / 29.6 | — (`draw` 51-57 ms: GL calls blocked) |
| RotWK | 1 | 14.3 / 12.9 | 55 % / 60 % | 361 / 303 | 23.8 / 23.8 | 43.5 / 51.1 (frames in flight) |
| BFME2 | 0 | 5.8 / 5.8 | 62 % / 59 % | 897 / 1 018 | 34.4 / 34.8 | — (`draw` 116-119 ms) |
| BFME2 | 1 | 5.7 / 7.0 | 77 % / 70 % | 701 / 698 | 31.1 / 27.5 | 142 / 114 |
| BFME1 | 0 | 10.2 / 12.7 | 62 % / 64 % | 592 / 424 | 22.1 / 20.3 | — (`draw` 54-70 ms) |
| BFME1 | 1 | 10.2 | 67 % | 388 | 19.2 | 76 |
| Vice City | 0 | 29.8 / 29.9 | 1 % / 1 % | 48 / 49 | 33.2 / 33.1 | — |
| Vice City | 1 | 29.4 / 29.8 | 2 % / 1 % | 56 / 46 | 31.6 / 33.4 | 0.5 / 0 |

(Of the rendered runs, one Vice City run per mode and one BFME1 run with the render worker did not get into the game: the
scripted clicks are timed for CPU-only speed. They are left out.)

With a software rasterizer the render worker turns the emulator's blocked GL calls into waits for frames in flight and
the emulator overlaps the render worker's work: RotWK +12-25 % fps with p99 1 394 / 468 → 361 / 303 ms, BFME2 and BFME1
the same frame rate with a lower p99 (897 / 1 018 → 701 / 698 ms; 592 / 424 → 388 ms), with 1-7 ms less emulator
CPU per frame in the three. Vice City, at its 30 fps cap, is unchanged except in one run with the render worker whose
slow frames came from one fence wait of 179 ms and three frame waits (112 ms): a buffer locked while the render
worker, two to three frames behind SwiftShader, had not uploaded it yet. When the GPU is the bottleneck the render
worker evens the frame times out — fewer very long frames (p99) but, in BFME2, more frames over 50 ms (77 / 70 %
against 62 / 59 %) at the same frame rate.

### 8.4 Fidelity

`?glworker=compare-worker` (no `--gl-discard`: the in-thread backend presents, the recorded work is replayed in a render
worker, both back buffers compared every 10 frames), the code of this section: Vice City drive 220 frames, RotWK menu to
skirmish ~430, BFME2 menu to skirmish in play 640, BFME1 main menu and skirmish setup 980 — **0 differing**. (BFME1's
rendered runs did not always start the skirmish: the scripted clicks are timed for CPU-only speed.) Unit tests: the
mirror equals the device at every draw and the same WebGL calls are issued in-thread and replayed (randomized Direct3D 8
and 9 sessions, replayed at once and late, in a worker thread), plus the tests of 8.2.

BFME1 has intermittent failures at a menu click before the skirmish setup, with either backend: once its main thread
jumped to address 0 (an access violation, then an error dialog — `DialogBoxParam` unsupported — and exit code 666;
in-thread backend; the same jump also ended a first launch of `bfme1-103` before its first frame, with the render
worker), once it stopped presenting while its main thread polled `WaitForSingleObject` / `Sleep` (render worker);
5 other runs with the render worker and 4 without went through. Neither is in the rendering path (no Direct3D call, no
render-worker wait); left to the CPU / Win32 work. Smoke runs of the other versions with `compare-worker`: `rotwk-201`
menu 1 160 frames compared, 0 differing; `bfme2-106` exits by itself 2 s after start (before any Direct3D, as without
the render worker).

### 8.5 Decision: the render worker by default

It is exact on the four games, and it reduces the emulator thread's Direct3D work in every one of them (CPU only: −1 to
−4 ms per frame; per draw 3-4 times less); where the frame rate is bound by the emulator's own work it is faster (BFME1
+5 %, BFME2 at its cap), elsewhere the frames are bound by guest code or the game's pacing and do not change beyond the
run-to-run spread; with a software rasterizer it raises RotWK's frame rate and lowers the p99 frame time of the three
BFME games (Vice City, at its cap, unchanged but for one run, 8.3).
On a real GPU it also takes the WebGL calls (1.3-7 % of a frame, 2.2) and any back-pressure of the GPU process off the
emulator thread, and with them the builds of GL programs at their first draw (108-160 ms each with ANGLE on the
player's machine, 2.4): the render worker absorbs such a stall while the emulator runs on, up to the frames in flight. Hence `?glworker=1` is the default where it can run (cross-origin isolation, shared memory, a worker
with WebGL2 — else the in-thread backend, logged); `?glworker=0` and the manifest compat flag `"glWorker": 0` keep the
in-thread backend. Costs: one more thread (2.6-4.5 ms of CPU per frame here), up to 2 frames in flight (one more frame
of latency than in-thread), the ring (16 MiB) and the mirror's copies of dynamic buffers. A write to a resource the
render worker has not uploaded yet waits for it (a fence: as a driver stalls a `Lock` of a buffer in use); with a GPU
that keeps up the render worker is at most 2 frames behind, so such a wait is short.

### 8.6 End to end against main (2026-10-03)

**Changed after 8.5.** COM objects are one class with the reference count's accessors on the prototype
(`src/win32/com.js`): each object was a literal with its own getter / setter closures, so every object had a map of its
own and the JavaScript AddRef / Release that the Direct3D setters do on what they bind (`bindTexture`,
`SetStreamSource`, `SetIndices`, the effects' textures) were megamorphic. BFME2 main menu in Node (`framebench`,
recorder, three alternated pairs): `api` 4.40 / 4.26 / 4.17 → 3.62 / 3.66 / 3.47 ms per frame (−15 %), same guest
instructions. `framebench --gfx recorder` now also prints the link's counters per frame (BFME1's menu copies 2.4 MB of
dynamic buffer data per frame into the ring, ~1.6 % of the thread in V8 profiles: the ranges the game locks, as large
as it asks; the in-thread backend uploads the same bytes). Tried and reverted: remembering the heap chunk of the last
lookup (`Heap.chunkOf`, 0.6 % of BFME1's menu) — no gain, frees alternate between chunks.

**Method.** `main` (6f9ca0b: in-thread backend by default, none of section 8's changes) against this branch (c8e9d3e:
render worker by default), two runs each, alternated (main, branch, branch, main), the play phase of
`tools/scenarios/{rotwk,bfme2,bfme}-phases.txt` (RotWK and BFME2 skirmishes, BFME1 skirmish) and the drive of
`vicecity-drive.txt`, `--learn` on a copy of learn-live and the game profiles of `/tmp/orthros-profiles`. The machine's
load average was 20-31 throughout (other projects); frame-time counts are per minute of the phase. `D3D work` = `api` +
`draw` of the frame accounting; `emulator busy` = every category but `wait` / `late` / `render` (the emulator thread's
own work per frame); `render` = waits for the render worker.

CPU only (`--gl-discard --timescale 1.5`):

| Game (phase length) | build | fps | > 40 ms / min | > 50 ms / min | p99 ms | draws / frame | D3D work ms | µs / draw | emulator busy ms |
|---|---|---|---|---|---|---|---|---|---|
| RotWK (180 s) | main | 37.7 / 37.3 | 129 / 134 | 61 / 63 | 63.3 / 61.8 | 189 | 5.9 / 6.0 | 31.2 / 31.7 | 25.0 / 25.3 |
| RotWK | branch | 36.5 / 38.8 | 145 / 121 | 70 / 64 | 67.0 / 63.3 | 219 | 4.6 / 4.6 | 21.0 / 21.1 | 25.6 / 24.1 |
| BFME2 (50-90 s) | main | 41.5 / 36.6 | 32 / 43 | 2 / 12 | 40.8 / 44.9 | 125 / 210 | 7.0 / 9.4 | 56.0 / 44.8 | 23.2 / 26.7 |
| BFME2 | branch | 41.1 / 40.9 | 26 / 20 | 13 / 11 | 40.5 / 37.5 | 210 | 7.0 / 7.0 | 33.3 / 33.5 | 23.2 / 23.4 |
| BFME1 (190-200 s) | main | 55.6 / 55.1 | 0 / 1 | 0 / 1 | 23.1 / 23.4 | 356 | 6.1 / 6.1 | 17.1 / 17.1 | 17.0 / 17.2 |
| BFME1 | branch | 57.3 / 56.3 | 0 / 1 | 0 / 1 | 21.5 / 23.5 | 356 | 3.6 / 3.7 | 10.1 / 10.4 | 15.0 / 15.9 |
| Vice City (22 s) | main | 44.2 / 42.7 | 11 / 27 | 3 / 11 | 35.8 / 41.3 | 741 / 526 | 9.5 / 9.4 (`draw` 3.0 / 3.2) | — | 22.0 / 22.7 |
| Vice City | branch | 44.4 / 43.6 | 19 / 36 | 5 / 14 | 38.1 / 43.0 | 551 / 508 | 9.8 / 8.5 (`draw` 0.9 / 0.9) | — | 21.9 / 22.2 |

(Vice City's `api` is its pacing — `PeekMessage` polled until the next frame at its cap — so only its `draw` compares.
BFME2's first main run started where the frames carry 125 draws, the three others 210: compare the 210-draw runs.)

The emulator thread's Direct3D work per draw falls by a third (RotWK 31 → 21 µs, BFME2 45 → 33, BFME1 17 → 10); per
frame by 1.3 ms in RotWK (with 16 % more draws), 2.4 ms in BFME2 (same draws: 9.4 → 7.0), 2.5 ms in BFME1; Vice City's
`draw` 3.1 → 0.9 ms. Where the frame rate is bound by the emulator's own work this shows: BFME2 at the same scene 36.6
→ 40.9-41.1 fps with 43 → 20-26 frames over 40 ms per minute, BFME1 +2-3 % fps. RotWK's and Vice City's frames over
40 ms are guest code (RotWK: 87 % of the slow frames' excess over the median frame is `guest`, section 8.1) and stay
within the run-to-run spread. The in-thread backend of the branch (`--glworker 0`, BFME1, two runs): 14.9 / 14.9 µs
per draw and 5.3 ms of D3D work per frame against main's 17.1 / 6.1 (−13 %).

Guest code costs 5-10 % more per instruction with the render worker in BFME1 (2.92-3.10 ns against 2.67-2.79
in-thread, same instructions per frame, same scene; seven runs of the branch with `--glworker 0 / 1`) but this is the
game's pacing, not a cost of the second thread: BFME1 runs at its frame cap there, and with cheaper frames it calls
`Sleep` more often (688-1 049 calls per frame against 388-648); V8 profiles of the two modes (20 s of play each)
show the difference in the thread-switch path that every `Sleep` takes (`runFor`, the JavaScript-to-WebAssembly entries,
clock reads, `Sleep` and the scheduler's wake-ups: 7.7 % of the samples against 4-5 %; the worker also sleeps more, 10.3 %
of the samples idle against 7.5 %), whose time the frame accounting charges to `guest`. The emulator thread's own work
per frame still falls (busy 15.0-15.9 ms against 16.1-16.3 in-thread on the branch, 17.0-17.2 on main).

Rendered (SwiftShader, `--timescale 1`; with a software rasterizer on a loaded machine every frame is slow, so the
counts mostly measure the rasterizer):

| Game | build | fps | > 50 ms / min | p99 ms | emulator busy ms | waits for the render worker ms |
|---|---|---|---|---|---|---|
| RotWK | main | 12.6 / 12.9 | 572 / 634 | 270 / 229 | 77.8 / 76.0 (`draw` 46.8 / 46.3) | — |
| RotWK | branch | 12.6 / 13.1 | 446 / 483 | 387 / 271 | 26.9 / 24.8 | 49.8 / 48.7 |
| BFME2 | main | 7.4 / 6.1 (126 draws) | 347 / 288 | 678 / 774 | 133.4 / 160.7 | — |
| BFME2 | branch | 5.4 (211 draws) / 7.3 (125) | 235 / 294 | 1 077 / 570 | 45.9 / 25.9 | 135.9 / 109.1 |
| BFME1 | main | 13.0 / 11.5 | 688 / 576 | 222 / 282 | 76.3 / 85.9 | — |
| BFME1 | branch | 11.7 / 11.9 | 509 / 502 | 271 / 280 | 16.9 / 17.0 | 66.5 / 65.0 |
| Vice City | main | 29.6 / 29.8 | 19 / 8 | 58 / 46 | 33.0 / 32.8 | — |
| Vice City | branch | 29.8 / 29.9 | 22 / 14 | 52 / 48 | 32.8 / 32.6 | 0 / 0 |

With SwiftShader the frame rate is the rasterizer's in both builds (RotWK, BFME2 at the same scene and Vice City at its
30 fps cap equal; BFME1 −4 %, within the spread of its in-thread runs: the rasterizer's threads now run beside the
emulator's instead of while it is blocked in GL calls, on a machine with few idle cores). The emulator thread itself
goes from 76-161 ms of work per frame (mostly blocked GL calls) to 17-46 ms: on a GPU that keeps up, that is the time
left for the game.

**Fidelity.** `?glworker=compare-worker` with this branch, every 10th frame: Vice City drive 300 frames, RotWK menu to
skirmish in play 460, BFME2 menu to skirmish 740, BFME1 menu to skirmish setup 1 200 (and 140-560 more per game in
the first, shorter runs) — 0 differing.

**BFME1's intermittent failures** (8.4) are not the render worker's. Of 38 BFME1 runs today past the moment they
happen (~150 s after start: the menu click that opens the skirmish setup, while the game creates its fonts and loads
that screen), 7 failed: 5 of 16 with the render worker, 2 of 18 in-thread, 0 of 4 with the recorder replayed in the
emulator's thread or compared (not a significant difference: one-sided Fisher p = 0.15). In 5 the main thread calls
through a function pointer that holds 0 or garbage — 3 times from the same call site in both modes (return address
`lotrbfme.exe+0x1885e0`, to 0 or 0x1404), once each from two others (to 0, to 0xf056e294) —; in 2 (render worker) the
game's loader thread runs a loop at full speed, no API call, while it
holds the game's audio-manager mutex that the main thread waits for: no frame after. Neither involves the Direct3D path
(no Direct3D call or render-worker wait around them; the font, heap and file calls just before are the same as in the
runs that go through): a race between the game's threads whose outcome Orthros' timing changes (the render worker makes
the main thread's frames cheaper), left to the CPU / Win32 work with these traces. The harness runs that measure BFME1
are retried when it happens.

### 8.7 Re-evaluation with the null page and the scheduler's quantum (2026-10-04)

The tree of the null-page / quantum branch (docs/null-page.md, docs/thread-scheduling.md), main merged. **Fidelity**
(`?glworker=compare-worker`, SwiftShader, every 10th frame compared): Vice City drive 240 frames, BFME1 menu to the
skirmish loading screen 300, BFME2 menu 580, RotWK menu to its loading screen 160 — 0 differing (a loaded machine:
the rendered runs did not reach play in their time; 8.6 covers play). **Work per frame**, CPU only (`--gl-discard
--timescale 1.5`), `--glworker 0` / `1` alternated (0, 1, then 1, 0), the play phase of `tools/scenarios/*-phases.txt`
and the drive of `vicecity-drive.txt`, warm profiles; `busy` and `D3D work` as in 8.6 (ms per frame):

| Game | `--glworker` | fps | p99 ms | emulator busy | D3D work | guest |
|---|---|---|---|---|---|---|
| BFME1 | 0 | 55.7 / 52.6 | 24.8 / 28.8 | 17.0 / 18.2 | 5.6 / 6.2 | 11.1 / 11.7 |
| BFME1 | 1 | 56.3 / 56.5 | 23.7 / 25.0 | 15.9 / 15.7 | 3.9 / 3.8 | 11.9 / 11.8 |
| BFME2 | 0 | 40.7 / 38.1 | 43.1 / 63.5 | 23.5 / 25.5 | 8.0 / 8.7 | 15.1 / 16.2 |
| BFME2 | 1 | 35.7 / 39.2 | 49.2 / 44.5 | 27.2 / 24.4 | 7.6 / 7.4 | 19.3 / 16.8 |
| RotWK | 0 | 36.5 / 38.0 | 66.2 / 60.7 | 25.6 / 24.3 | 5.6 / 5.7 | 19.5 / 18.2 |
| RotWK | 1 | 37.9 / 37.7 | 62.5 / 65.9 | 23.9 / 23.9 | 4.4 / 4.2 | 19.3 / 19.5 |
| Vice City | 0 | 38.9 / 43.9 | 52.6 / 38.1 | 24.8 / 22.2 | 8.4 / 9.5 | 15.9 / 12.5 |
| Vice City | 1 | 44.3 / 43.8 | 38.6 / 38.5 | 22.0 / 22.4 | 9.0 / 8.4 | 12.9 / 13.8 |

The emulator thread's Direct3D work is lower with the render worker in the three BFME games (−1.8 / −0.9 / −1.4 ms per
frame), equal in Vice City (its `api` is its pacing, 8.6); the frame rate is equal or higher but in BFME2's first pair,
whose render-worker run spent 4 ms more per frame in guest code (another scene: guest code does not depend on the
backend; the second pair is the other way round). Exact and not slower: `?glworker=1` stays the default
(`?glworker=0` and the manifest flag `"glWorker": 0` keep the in-thread backend). (In fact the code on main had been
switched back to the in-thread backend on 2026-10-03, pending the BFME1 race and the guest cost per instruction of
8.6; section 8.8 settles both.)

### 8.8 The default decided again: three to four alternated pairs per game (2026-10-04)

**Question.** The render worker had been turned off again on 2026-10-03 for two reasons: an intermittent BFME1
failure (since traced to a stale reference inside the game, same failure rate with both backends: STATUS.md) and a
guest cost per instruction 5-10 % higher with it in BFME1 (8.6). This section measures the two modes again on the
current tree and looks for the cause of the per-instruction difference.

**Method.** The tree of main 0b474c8 plus the measurement additions of this section, `--gl-discard --timescale 1.5`,
warm profiles and a copy of learn-live, the play phases of `tools/scenarios/{bfme,bfme2,rotwk}-phases.txt` (BFME1
140-160 s, BFME2 110 s, RotWK 210 s of play) and the drive of `vicecity-drive.txt` (22 s). Each pair: `--glworker 0`
and `--glworker 1` **at the same time** (same machine load), launch order swapped from one pair to the next. The
machine's load average was 14-45 (other projects). Per frame: `D3D` = `api` + `draw` (Vice City: its `api` is its
pacing loop, `draw` alone compares), `busy` = the emulator thread's own work (every category but the waits),
`render` = waits for the render worker, `ns/insn` = guest category per guest instruction, `picks` = scheduling
decisions per frame (new in the phase report).

| Game, pair | mode | fps | > 33 / > 40 / > 50 ms per min | p99 ms | D3D ms | busy ms | render ms | ns/insn | picks |
|---|---|---|---|---|---|---|---|---|---|
| BFME1 1 | 0 / 1 | 47.0 / 49.2 | 200 125 70 / 140 91 59 | 69.3 / 70.7 | 6.5 / 4.1 | 20.2 / 17.7 | 0 / 0.4 | 3.27 / 3.41 | 703 / 1372 |
| BFME1 2 | 0 / 1 | 49.5 / 52.9 | 9 7 2 / 12 8 6 | 29.0 / 28.4 | 6.0 / 4.0 | 19.8 / 17.8 | 0 / 0 | 3.34 / 3.43 | 183 / 548 |
| BFME1 3 | 0 / 1 | 53.2 / 56.1 | 9 4 2 / 6 4 2 | 26.2 / 23.9 | 6.0 / 3.6 | 18.1 / 15.9 | 0 / 0 | 3.03 / 3.09 | 347 / 1057 |
| BFME2 1 (126 draws) | 0 / 1 | 41.3 / 42.8 | 67 26 10 / 43 19 8 | 40.4 / 35.9 | 6.6 / 5.1 | 22.8 / 21.2 | 0 / 0 | 3.19 / 3.27 | 888 / 1341 |
| BFME2 2 (211 draws, load 30) | 0 / 1 | 28.7 / 28.6 | 791 278 69 / 722 329 123 | 83.3 / 82.6 | 11.7 / 9.5 | 34.2 / 32.5 | 0 / 1.6 | 3.67 / 3.76 | 119 / 137 |
| BFME2 3 (125 draws, load 37) | 0 / 1 | 22.4 / 25.8 | 620 473 290 / 462 372 269 | 291 / 222 | 12.6 / 7.3 | 42.9 / 36.2 | 0 / 0.5 | 4.73 / 4.68 | 469 / 1097 |
| BFME2 4 (210 draws, load 31) | 0 / 1 | 17.4 / 21.6 | 596 439 335 / 375 274 240 | 336 / 389 | 19.2 / 10.3 | 56.0 / 38.5 | 0 / 6.5 | 4.94 / 4.33 | 136 / 252 |
| RotWK 1 | 0 / 1 | 34.3 / 35.7 | 407 209 94 / 362 191 85 | 78.3 / 69.0 | 6.3 / 4.6 | 27.8 / 25.7 | 0 / 0 | 3.25 / 3.29 | 709 / 1067 |
| RotWK 2 | 0 / 1 | 35.2 / 37.4 | 379 179 79 / 275 144 71 | 65.1 / 65.1 | 6.4 / 4.7 | 27.1 / 24.4 | 0 / 0 | 3.30 / 3.30 | 625 / 1172 |
| RotWK 3 | 0 / 1 | 36.7 / 37.3 | 286 145 68 / 276 152 72 | 63.0 / 65.2 | 6.0 / 4.8 | 25.4 / 24.5 | 0 / 0 | 3.04 / 3.02 | 911 / 1321 |
| Vice City 1 | 0 / 1 | 42.7 / 43.7 | 69 19 14 / 63 27 11 | 38.1 / 40.0 | `draw` 3.1 / 1.0 | 22.7 / 22.2 | 0 / 0 | 2.48 / 2.70 | 109 / 152 |
| Vice City 2 | 0 / 1 | 40.7 / 43.7 | 160 80 30 / 61 19 8 | 53.2 / 36.8 | `draw` 3.9 / 1.1 | 23.9 / 22.2 | 0 / 0 | 2.75 / 2.69 | 104 / 152 |
| Vice City 3 | 0 / 1 | 39.3 / 42.0 | 208 118 38 / 123 63 26 | 56.4 / 50.2 | `draw` 3.6 / 1.2 | 24.7 / 22.9 | 0 / 0 | 3.27 / 3.00 | 90 / 129 |
| Vice City 4 | 0 / 1 | 41.3 / 44.1 | 115 74 38 / 52 25 6 | 61.1 / 39.5 | `draw` 3.7 / 1.0 | 23.6 / 22.0 | 0 / 0 | 2.49 / 2.49 | 111 / 173 |

Left out: three BFME2 pairs whose runs started at different places of the map (126 against 210 draws per frame: other
scenes, as in 8.6; the render-worker runs started at the 210-draw place in 5 of 7 pairs, the in-thread ones in 2 — the
game's own random start, which timing changes) and one Vice City pair run at a load average of 44, where both runs fell to 10-14 fps.

**End to end the render worker is equal or better in every comparable pair**: frame rate −0.1 to +4.2 fps (BFME1
+4.7 to +7 %, RotWK +1.6 to +6 %, Vice City +2.3 to +7 %, BFME2 −0.3 to +24 %), the emulator thread's own work 0.5-17.5
ms per frame lower, its Direct3D work 1.2-2.4 ms lower (BFME2 under load 5.3-8.9; Vice City's `draw` 2.1-2.8), slow-frame counts lower or within the
spread. The mixed results are BFME2's pairs 2 and 4, measured at a load average of 30-31: pair 2 the same frame rate, fewer
frames over 33 ms but more over 40 and 50 ms; pair 4 +24 % fps and fewer slow frames but a higher p99 — there the
render worker itself was starved (1.6 and 6.5 ms of waits per frame, one frame waited 850 ms for it: with more busy
threads than idle cores, the second thread is descheduled like any other).
**Start-up**: the first Direct3D frame and the main menu come at the same times (within 1-2 s in every pair).

**The guest cost per instruction.** In the concurrent pairs the guest category costs +2.0 to +4.3 % per instruction
with the render worker in BFME1, −0.7 to +1.2 % in RotWK, −12 to +2.5 % in BFME2 and −8 to +9 % in Vice City (whose
22 s drives differ in scene). Where it shows (BFME1), it is not the render worker's synchronization: the Atomics
stores and notifications, the ring writes and the buffer data copied into the ring are charged to `draw` / `api`,
which fall by 2.4 ms per frame, and the emulator waits for the render worker 0-0.4 ms per frame. Three experiments
looked for the cause:

1. *V8 CPU profiles* of the emulator thread (30 s of BFME1 play in each mode, two concurrent pairs, each sample
   weighted by its real interval): the translated code itself (the `r_*` functions) runs at 2.55 / 2.69 ns per guest
   instruction (in-thread / render worker) in one pair and 2.46 (in-thread with the control thread of 3.) / 2.78
   (render worker) in the other. The extra time is spread over the hot regions (the regions of more than 50 ms: +4.7 %),
   not in a few: the code runs uniformly slower, as under contention for the core, its caches or the memory.
2. *More thread switches?* With the render worker the game's frames are cheaper and its threads poll more: BFME1 makes
   2-3 times as many scheduling decisions and `Sleep` calls per frame. An in-session A/B without a second thread —
   the in-thread backend with its WebGL calls made no-ops (`dbg:ORTHROS_GL_NULL=1`) every other 30 s phase, two
   sessions, six phases each — shows no such effect: per phase 2.66-3.34 ns per instruction, *lower* in the phases with
   more scheduling decisions (585-599 per frame: 2.66-2.73) than in those with fewer (136-247: 3.15-3.34), and the
   spread between phases of one session (±11 %) is larger than the difference between the backends. The polling is a
   consequence of faster frames, not a cost: the earlier reading (8.6) is not confirmed.
3. *Any second busy thread?* A control thread (harness input `spin:25`: a page worker busy streaming through 4 MiB 25 %
   of every 10 ms, about the render worker's share) beside the in-thread backend: guest category +6.3 % per instruction
   against an in-thread run of the same pair (3.23 / 3.04), translated code equal (2.80 / 2.80 ns); against the render
   worker the control run was 6 % faster per instruction (2.87 / 3.06). The noise of a loaded shared machine (the in-thread backend's translated code measured 2.55 and 2.80 ns per
   instruction in two sessions) is of the order of the effect.

Conclusion: the per-instruction difference is small (BFME1 +2-4 %, none measurable in the other games), it is not in
the render worker's protocol, nor in the extra polling; what remains is consistent with a second busy thread sharing
the machine (a core of an SMT pair, L3, memory bandwidth) and the run-to-run noise. Its cost (≤ 0.5 ms per frame in
BFME1) is smaller than what the render worker removes from the emulator thread (2-2.5 ms of Direct3D work per frame),
which is why frame rates rise. On a player's machine with idle cores the contention is lower and the GPU-process
back-pressure and program builds the render worker absorbs (8.5) higher.

**Exactness** (rendered, SwiftShader, `?glworker=compare-worker`, every 10th frame compared): Vice City menu to drive
247 frames, BFME1 menu to the skirmish setup 432, BFME2 menu to play 515, RotWK menu to play 175 (95 of them in play)
— 0 differing. Screenshots with the render worker presenting: Vice City's logo and title movies (video layer) and its
menu identical to the in-thread run's; Vice City's drive frames as in-thread. **Context loss** in the render worker
(BFME2, `--lose-context-at 200` during the intro movie): `context restored, resources recreated on use`, the game went
on to its menu, the skirmish setup and the loading screen, rendered correctly (one 2 s batch while SwiftShader rebuilt
the programs). The unit and browser tests pass with the render worker by default (`tests/browser.test.js`:
`dx.exe`, `dx9.exe`, `window.exe`, `text.exe` by default; `?glworker=0`, `1`, `inline`).

**Decision: the render worker is the default again** (`src/gfx/render-host.js` `renderMode`: the page's `?glworker=`
first, then the manifest's `"glWorker"` — `false` / `0` the in-thread backend —, else the render worker;
`tests/render-mode.test.js`). Risk kept in view: on a machine with fewer idle cores than busy threads the render
worker can be descheduled and the emulator then waits for frames in flight (BFME2 pairs 2 and 4); the HUD's `render` category
and the telemetry's `c.render` show it, and `?glworker=0` is the remedy.

**Measurement additions** (kept): the phase reports give the scheduling decisions and slices per frame; the render
worker logs batches of commands taking 50 ms or more (with the last command) and returns to its loop 50 ms late (the
first 20 of each: what makes the emulator wait for frames); harness input `spin:<percent>` (the control thread of 3.).

## 9. Software rendering: lean shaders (2026-11-09)

Without a usable GPU Chrome rasterizes with SwiftShader (this server; any player's machine whose GPU Chrome blocks).
SwiftShader runs the shaders on the CPU, a SIMD group of pixels or vertices at a time, and runs every statement it is
given for the whole group: a loop is a loop, a branch on a value that differs between lanes runs both sides, an input
the shader reads anywhere is interpolated for every pixel. The GLSL the translators generated was written for GPUs and
paid for that: translated shader models 2-3 (`d3d9-shaders.js`) kept their 32 temporary registers in an array cleared
by a loop, per pixel and per vertex (`vec4 r[32]; for (...) r[i] = vec4(0.0);`), and copied all 8 texture coordinate
inputs into `t#` (all 8 interpolated); the fixed-function vertex shader looped over the lights with a per-vertex branch
on each one's type; the fixed-function pixel shader read the specular color even when nothing used it.

**Lean shaders** (`leanShaders()` in `src/gfx/d3d8-shaders.js`, default on; worker debug global
`ORTHROS_LEAN_SHADERS_OFF=1` — settable mid-session, `dbg:` — gives the earlier GLSL; the backend drops its programs by
key when the switch moves and keeps them by sources, so switching back costs no compile): the same results with less
work — registers as plain variables, declared only when the shader names them (shader models 1-3 address `r#` by
constant indices only); only the `t#` / specular inputs a pixel shader reads; the enabled lights unrolled by the types
the program key already holds (one block per light, constant uniform indices, only its type's code). Pixel-exact:
`tests/shader-compile.test.js` draws lean and earlier programs in SwiftShader with the same random inputs (lights of each
type, registers, co-issue) and compares the pixels. `PROGRAM_GLSL_VERSION` 2: the shader programs learned before are
built again at their first draw (once; fixed-function ones are regenerated from their keys).

**Cost per program** (`tools/bench/shader-cost-bench.mjs`, every program the three games' sessions learned, lean against
earlier, in one SwiftShader page; pixel shaders over 4 layers of a 1024x768 target, vertex shaders over 360 k vertices;
mean ms per program):

| programs | pixel shaders lean / earlier | vertex shaders lean / earlier |
|---|---|---|
| RotWK, 14 shader-model-2 programs | 81 / 386 (x0.21) | 55 / 90 (x0.61) |
| BFME 1.08, 3 shader programs | 100 / 391 (x0.26) | 13 / 49 (x0.27) |
| RotWK, 51 fixed-function | 35 / 34 (x1.02) | 20 / 36 (x0.56) |
| BFME 1.08, 135 fixed-function | 48 / 47 (x1.01) | 25 / 56 (x0.45) |
| Vice City, 60 fixed-function | 34 / 37 (x0.93) | 19 / 42 (x0.45) |

**In game** (headless Chromium, SwiftShader, the shared server loaded 15-38; the switch alternated in one session,
on1/off1/on2/off2/on3/off3 of ~25 s: `tools/scenarios/*-lean-ab.txt`; `render` = the emulator's mean wait for the
render worker per frame, i.e. SwiftShader's time; per pair ON − OFF):

| game, scene | fps ON / OFF (medians) | render ms per frame ON / OFF (medians) | pairs (render) |
|---|---|---|---|
| Vice City, in the street after a new game (640x480) | 10.1 / 9.8 | 28.9 / 36.1 | −7.8, −7.2, −11.0 |
| BFME 1.08, main menu (1024x768), run 1 | 3.0 / 1.9 | 238 / 472 | −254, −265, +39 |
| BFME 1.08, main menu, run 2 | 3.0 / 2.9 | 304 / 314 | −9, −455, −13 |
| RotWK, skirmish (1024x768), run 1 | 3.3 / 2.9 | 203 / 234 | −133, +38, −16 |
| RotWK, skirmish, run 2 | 2.8 / 2.9 | 276 / 266 | −152, +24, +55 |

The loaded machine makes single phases noisy (BFME's menu runs at 2-5 fps, its frames 100-900 ms; RotWK's skirmish
view moves with the game). Render is lower in 11 of the 15 pairs: Vice City 3 of 3, BFME 5 of 6, RotWK 3 of 6 (its
medians +-10 %: no gain shown there, no loss either — its frames are mostly fixed-function pixels and blending). Default
on. The per-program bench, free of the game's variation, shows where the gain comes from: shader-model-2 pixel
shaders 4-5 times cheaper, vertex shaders about twice. Fixed-function pixel shaders cost the same (their texture sampling and blending dominate): a game drawn mostly that way (Vice City)
gains on its vertices. Probes kept for the next steps (worker debug globals, mid-session): `ORTHROS_GL_FLATFS=1` (every
pixel shader a flat color: what pixel shading costs against vertices, depth and blending — Vice City: render 15.6 ms
per frame against 32-33 around it), `ORTHROS_GL_NEAREST=1` (every sampler point-sampled from one level: no measurable
change in any of the three games). Not validated on a real GPU (where none of this was a cost: GPU compilers unroll and
promote the register array themselves).

## 10. Software rendering: adaptive internal resolution (2026-11-09)

Owner's decision: without a GPU, render the Direct3D 8/9 frames at a lower internal resolution when the render is what
holds the frame; never on a real GPU; the game must see exactly the same API results — only the picture's sharpness may
drop. `src/gfx/render-scale.js` (mapping and controller), `src/gfx/d3d8-webgl.js` (scaled storage), tests
`tests/render-scale.test.js`.

**What is scaled.** One factor `s` per device (steps 1, 0.85, 0.75, 0.6, 0.5). GL storage at `round(w·s) × round(h·s)`
for the back buffers (their color and depth-stencil renderbuffers — the backend gives every color target its own
depth-stencil, so the auto depth-stencil follows) and for the render targets whose size is the back buffer's:
render-target surfaces and render-target 2D textures (level 0 scaled, the other levels halved from it, as GL requires).
Smaller targets (shadow maps, reflections, UI caches), cube and volume textures, DXT surfaces and plain surfaces stay
unscaled. The Direct3D side never changes: `GetDesc`, viewport validation, everything the game reads keeps the original
sizes; the recorder and the device do not know.

**Coordinates.** Each target record has its GL size (`w`, `h`) and its Direct3D size (`dw`, `dh`) with the factors
`kx`, `ky`. Viewport and scissor rectangles, Clear rectangles and StretchRect rectangles go through `glRect` /
`glEdgeX` / `glEdgeY`: rows flipped as before, then every edge scaled and rounded (adjacent rectangles stay adjacent).
The `u_viewport` uniform stays in Direct3D pixels, so pre-transformed vertices (XYZRHW / POSITIONT) land on the same
part of the picture through the scaled `gl.viewport` with no shader change (program sources, hence the learned
programs, are unchanged); the half-pixel offset is a fraction of a Direct3D pixel as before. The fixed-function point
size (`u_pointSize`) is multiplied by the target's `kx`. Not scaled: point sizes written by a vertex shader (`oPts`), and
line widths (WebGL draws 1-pixel lines only); no generated shader reads `gl_FragCoord.xy` (only `.z`/`.w` for fog).
StretchRect between two targets of different scales is filtered (linear).

**Readbacks.** `LockRect` on a render target, `GetRenderTargetData`, `GetFrontBuffer(Data)`, CopyRects from a target and
the render-worker frame comparison read a scaled target through a full-size framebuffer (`readTargetPixels`: a nearest
blit up, then `readPixels` at the Direct3D size), so the game reads Direct3D-sized data (its own colors, not blends).
A scaled texture level uploaded from guest memory (after a readback, a context loss) is resampled to its GL size.

**Present.** The back buffer is blitted to the canvas (Direct3D size) with linear filtering (the gamma path samples it
linearly too).

**Changing scale.** Only at a present, after the frame's flush (`applyRenderScale`): every target whose scale changes
gets new storage, its color copied over (linear blit), its depth-stencil cleared; render-target textures get a new GL
texture (levels drawn to are copied, the others uploaded again).

**Controller** (auto mode). Per presented frame: the frame interval and the backend's busy time between two presents —
in the render worker, the replay loop's busy time (`backend.busyMs`, render-loop.js), which includes the GL calls
blocked while SwiftShader's GPU process is behind; in-thread, the time inside the backend's entry points. Down one step
when, over the last 1.5 s (at least 4 frames: menus run at 2-3 fps), the median busy time exceeds the budget, the frame
interval exceeds 1.05 × budget, and busy ≥ 0.75 × interval (the render is what holds the frame). Each step down is then
judged over 3 s: kept if the busy time or the frame interval fell by 8 % or more, otherwise undone, and the next step
down waits 30 s, then 1, 2, 4... up to 10 min (a scene bound by vertices, uploads or the emulator itself does not
oscillate). Up one step when, over 4 s, the busy time times the pixel ratio of the next step stays under 75 % of the
budget. Budget: 1000/30 ms (`ORTHROS_RENDER_BUDGET=<ms>`). A fence after the present was tried first as a measure of
the GPU work left: Chrome updates a sync object's status between tasks of the worker's event loop, which a busy render
worker reaches late — 3.8-4.8 s measured for frames of 100-160 ms; dropped.

**Switches.** Worker debug global `ORTHROS_RENDER_SCALE` (`?dbg=`, harness `--dbg` or `dbg:` mid-session):
`off` (default), `auto` (active only when `gpuClass(renderer)` of `src/web/gpu-class.js` is `software`; not the default: the measurements below show no fps gain on a 4-core GPU-less machine, where the emulator and SwiftShader share the cores), or a number
in (0, 1] (that fixed scale, on any GPU: testing). Both it and `ORTHROS_RENDER_BUDGET` are host-only flags (snapshot
keys unchanged). Statistics: the device's `stats.rscale` (mode, scale, changes, lowest, steps kept / undone, frames
measured, busy and interval sums — measured in every mode on a software GPU), a `mark <label>: render scale ...` line
per harness phase, and `scale` / `scaleChanges` in the perf record's `gpu` part (telemetry).

**Measurements** (2026-11-09; this server, no GPU: headless Chromium + SwiftShader capped at 4 cores by
`tools/with-browser-slot.sh`, the shared machine loaded 11-70; fresh profiles; phases of 25-40 s alternated in one
session with `dbg:ORTHROS_RENDER_SCALE=...`; `render` = the emulator's mean wait for the render worker per frame,
`[frames]` reports):

| game, scene (display) | phase | fps | frame p50 / p99 ms | > 40 ms /min | render ms/frame |
|---|---|---|---|---|---|
| Vice City, street after a new game (640x480), fixed A/B | off ×3 | 9.2 / 8.6 / 9.8 | 99-100 / 291-384 | 444-499 | 43.6 / 51.3 / 30.0 |
| | 0.5 ×2 | 9.4 / 10.2 | 98-99 / 292-302 | 475-499 | 33.4 / 31.0 |
| | 0.75 | 10.0 | 98.5 / 294 | 499 | 32.0 |
| Vice City, same scene, auto (first controller version) | off ×2 | 9.4 / 9.2 | 99 / 303-392 | 459-469 | 39.7 / 49.1 |
| | auto ×2 (0.85 tried, undone) | 8.1 / 10.0 | 98-102 / 387-392 | 425-501 | 62.9 / 34.5 |
| BFME 1.08, main menu (1024x768), run 1 | off ×2 | 2.4 / 1.9 | 420 / 886 | 112-146 | 351 / 399 |
| | auto ×2 (down to 0.75 / no change) | 3.3 / 2.3 | 92-283 / 865-22110 | 95-179 | 281 / 313 |
| | 0.5 ×2 | 3.5 / 3.7 | 212-220 / 906-1525 | 187-197 | 247 / 216 |
| BFME 1.08, main menu, run 2 | off ×2 | 3.6 / 2.0 | 100-110 / 2917-3296 | 93-187 | 209 / 455 |
| | auto ×2 (0.85-0.75, mostly undone) | 2.5 / 3.3 | 106-297 / 1393-1893 | 123-161 | 345 / 261 |
| | 0.5 ×2 | 3.0 / 2.5 | 99-101 / 2296-6803 | 115-156 | 248 / 344 |
| RotWK 2.02, skirmish, idle camera (1024x768) | off ×2 | 5.8 / 5.0 | 117 / 685-884 | 273-316 | 90 / 115 |
| | auto ×2 (0.85 undone twice / down to 0.5-0.6) | 4.0 / 5.3 | 167-197 / 612-873 | 225-298 | 158 / 110 |
| | 0.5 (first 40 s of play) | 5.1 | 100 / 3315 | 259 | 66 |

Reading: a lower resolution lowers the render wait where pixels are a large part of it (Vice City 0.5: −25 to −35 %
against the surrounding `off` phases; BFME's run 1: −30 to −45 %), but on this 4-core-capped, loaded machine the frame
rate barely moves: Vice City's frames stay at a p50 of ~99 ms (the emulator's own work and its late wake-ups, `late`
22-35 ms per frame, dominate), BFME's menu and RotWK's skirmish drift by ±50 % between phases of the same setting (the
menu's camera fly-through, the skirmish's growing scene), more than any setting changes. The controller therefore
mostly tries a step and undoes it for no gain, which is what it is for; where it kept steps (BFME run 1, RotWK auto2)
the phases are within the drift. Two auto phases are below their run's `off` phases (Vice City auto1 8.1 fps against
9.2-9.4, RotWK auto1 4.0 against 5.0-5.8) while two are above (BFME run 1 auto1, Vice City auto2): with the scene drift
of the same size, neither a gain nor a loss is shown. Default `auto` as decided (inactive on real GPUs); when it does
not help it holds the scale at 1 except for a ~3.5 s try at 0.85 after 30 s, 1, 2, 4... min.

**Visual and input check at 0.5** (`dbg:ORTHROS_RENDER_SCALE=0.5`, game layer read from its canvas — the harness's new
`shotgl` step, as screenshots time out on a page starved at 2-5 fps): Vice City's main menu (complete; the item under
the cursor highlighted, the click on "new game" started it) and the opening cutscene (letterbox and subtitles in
place); BFME 1.08's main menu (3D scene and button bar complete); RotWK's menus driven by clicks at 0.5 through Solo,
Skirmish, the profile name and the map list, then a skirmish whose units are selected by clicks (selection circles and
the HUD portrait) — hit-testing unchanged (the game's coordinates never pass through the render). Pictures softer at 0.5,
nothing missing or displaced. (Scenario coordinates written for 800x600 must be scaled to the display by hand in the
harness — the first-launch display here is 1024x768; the bench mode scales them itself.)

Not validated: a real GPU-less PC (the owner's machines have GPUs; the controller never runs there), games that read
back render targets during play at scale (the readback path is unit-tested for size, not seen in these scenes).

## 11. Software rendering: static frames, and where the GPU process's CPU goes (2026-11-11)

Question: on a machine without GPU (SwiftShader), AotR's MY CAPTAINS load took 83-164 s at 4 cores against 39 s at 8,
with the GPU process at 3-4 cores during a LOADING screen. Is that the rasterization of frames that do not change, and
can the render worker skip them without changing a single pixel?

### 11.1 Measurements (headless harness, `tools/with-browser-slot.sh`, default 400 % CPU quota unless said, no `--gl-discard`)

**Frames are not static.** The render worker classifies every presented frame (`ORTHROS_STATIC_REUSE=2`: count only;
`[gfx] render worker: static frames over 10 s` lines with the first reason a frame is not reusable):

| scene | frames presented | equal to the previous one (exact rule) | why not |
|---|---|---|---|
| AotR MY CAPTAINS LOADING screen (clear, 3 quads: background, picture, a 64×64 ring) | 20-27 fps | 0 | the ring's texture is rewritten every frame with other bytes (`LockRect`; the ring glows) |
| AotR main menu (16 draws) | 11-13 fps | 0 | vertex bytes (`BUF_DATA`) differ every frame: animated |
| RotWK 2.02 main menu | 13-15 fps | 0 | vertex bytes differ every frame (the 3D shell map) |
| RotWK 2.02 intro / first screens | 17 fps | 60 of 167 in one 10 s window | the rest: video textures |
| BFME 1.08 main menu | 2-4 fps | 0 | `STRETCH` every frame (render-to-texture shell map) |
| Vice City main menu | 46 fps | 0 | draws over the previous image without a color clear, and moving shapes (`BUF_DATA`) |
| AotR skirmish LOADING screen (pinned 4 cores) | 5-7 fps | 0 | a clear of part of the target (a rectangle or a partial viewport) every frame |

**Where the GPU process's CPU goes.** One session, AotR LOADING screen, 10 s phases switched with `dbg:` (worker
thread = the emulator; GPU process = all its threads):

| phase | GPU process | emulator thread | frames |
|---|---|---|---|
| normal (frames rendered and handed to the page) | 31.1 s CPU (3.1 cores) | 2.9 s | 273 |
| `ORTHROS_GL_NULL=1` + `ORTHROS_RW_NO_PRESENT=1` (no GL call, no frame handed over) | **0.3 s** | **7.8 s** | 286 |
| `ORTHROS_GL_NULL=1` only (blank frames still handed to the page) | 27.4 s | 2.9 s | 241 |
| `ORTHROS_RW_NO_PRESENT=1` only (rendered, not handed over; another session) | 28.7-30.2 s | 2.2-2.9 s | 204-297 |

The GPU process's CPU does not follow the work: 3 quads at 25 fps, an empty canvas handed over at 25 fps, the AotR menu
at 11 fps, the RotWK menu at 13 fps, BFME's at 3 fps all cost ~3.1 cores, and only *no GPU activity at all* frees it.
Its threads (`/proc/<pid>/task/*/comm`) are 16 `Thread<NN>` (SwiftShader's worker pool, sized from the host's 48 cores,
not from the quota), each ~0.2 core. The scope's `cpu.stat` shows why the emulator starves: the 400 % quota is used up
in **every** 100 ms period (100 of 100 periods throttled, AotR skirmish load) — sixteen threads spinning or rasterizing
in parallel exhaust the 400 ms of a period in a few ms of wall time, then CFS bandwidth control stops the whole scope,
the emulator's thread included, until the next period. The emulator gets ~25 % of a core.

**The 4-core model overstates the problem.** The same MY CAPTAINS load with the browser also pinned to 4 cores
(`ORTHROS_BROWSER_CPUS=44-47`, quota unchanged — closer to a real 4-core PC, where nothing can run more than 4 threads
at once): **50-51 s** (emulator thread 58 % of a core, GPU process 2.4 cores), against **188-209 s** with the quota
alone (3 runs). Reuse on or off makes no difference there (50 s / 51 s): the loading frames are not static.

### 11.2 What was built: exact static-frame reuse (`src/gfx/static-frames.js`, `ORTHROS_STATIC_REUSE`)

In the render worker's replayer (render worker only: `onReuse`; not inline/compare modes):
- A frame is *plain* when every command is an absolute state setter (render/stage/sampler states, viewport, scissor,
  shaders, streams, indices, textures by id, transforms, lights, material, constants, buffer bytes carried in the ring),
  a texture level written by the guest (`SURF_DIRTY`: its guest bytes copied as the command is read, compared byte for
  byte; `SURF_MEM` of a copy on write compared by surface only), or a clear / draw / present — and nothing reads what the
  targets held: each target is first cleared whole (color, and depth/stencil before a draw that tests them — a depth test
  that always passes reads nothing), no render-target texture is sampled before being made in the frame. Anything else
  (resource creation or destruction, guest-memory buffer writes, readbacks, StretchRect, gamma, another device, a
  canvas resize) is not plain.
- Two consecutive plain frames with equal commands (version counters, transform slot versions and the frame number set
  aside — they only key the backend's caches) and equal written bytes leave the device state as it was between them
  (absolute setters applied twice give what they give once), so a third equal frame starts from the same state, reads
  the same resources and makes the same image. It is *held*: its commands copied out of the ring and compared word by
  word with the reference as they arrive, not reported consumed to the emulator (`Replayer.tail()`, `publishTail`: the
  emulator's fences still protect the guest memory a held command may read); at its PRESENT the state commands are
  applied (the mirror stays exact), no GL call is made, no frame is handed to the page (it keeps showing the same image)
  and `SHOWN` advances. The first command that differs, an emulator waiting for the render worker (`EMU_WAIT`), or the
  switch turned off releases the held commands, replayed as usual before it. A render-scale change or a context
  restoration ends the streak.
- Switch: `ORTHROS_STATIC_REUSE` (render worker debug global, `dbg:` works mid-session): unset/0 off (the default), 1 on, 2 count only.
  The 10 s log line gives presented / plain / equal / reused / released counts and the reasons.
- Test: `tests/static-frames.test.js` (equal frames reused after two, every kind of difference rendered — commands,
  vertex bytes, texture bytes, drawing over the previous image, a depth test on an uncleared buffer, a resource
  written — and the mirror equal to a replay of every frame).

Tried and removed: replaying a frame whose only difference is a texture's bytes within the rectangle its draws cover
(scissor; the extent from fixed-function positions and flip-chain history). On the LOADING screen it cut the replay to a
68×68 rectangle (4 624 pixels instead of 786 432) in 95 % of the frames, and the GPU process stayed at 3.1 cores
(24.9 s per 8 s against 31.8 s per 10 s off): the cost is not rasterization (11.1).

### 11.3 Results and decision

- AotR MY CAPTAINS load at 400 % (quota): 188 s with reuse (on), 195-209 s in count mode — no frame of that load is
  reusable, the difference is run-to-run noise. Pinned 4 cores: 50 s on, 51 s off.
- Menus (AotR, RotWK, BFME 1.08, Vice City): no reusable frame (table above), GPU process unchanged (RotWK menu
  31.4 s/10 s; Vice City on/off/on 75.2 / 76.4 / 80.4 s per 20 s, fps 46-47 throughout; BFME 1.08 74.7 / 75.5 / 75.9 s).
- Playing skirmish: not reached. Two runs of `learn-aotr-skirmish` (quota alone, then pinned to 4 cores) spent their
  900 s in the skirmish load (5-7 fps loading screen, render worker busy 9.2-10.1 s per 10 s); those frames are not
  plain from their first partial clear, so the switch changes nothing there.
- Images: a reused frame issues no GL call and hands nothing over, so the page keeps the exact image of the previous
  frame, which the unit test shows is the image the reused frame's commands would make; when reuse applies the page's
  image is the previous one by construction.

Decision: **off by default** (`ORTHROS_STATIC_REUSE` unset). It wins on no measured scene: the only reusable frames seen
are part of RotWK's first screens (60 of 167 frames in one 10 s window), and the GPU process's cost does not come from
rasterizing static frames. Kept behind the switch (and its count mode, `=2`, which names why each scene's frames
differ) for games with truly static screens (paused games, still menus, dialog boxes); with the switch off the replayer
calls the replay directly (no copy, no comparison). Not validated: screenshots of a reused frame against a rendered one
(no measured scene reuses long enough; the image is the previous one by construction), a real GPU (none here).

What would help GPU-less machines, from these numbers: fewer GPU-process wake-ups, not fewer pixels (any activity at
10 fps or more keeps SwiftShader's pool hot), and benchmarks that model a 4-core PC by pinning
(`ORTHROS_BROWSER_CPUS`) rather than by a quota alone, which makes the emulator wait out throttled periods that a real
4-core machine does not have.

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

### Early flush (`ORTHROS_GL_FLUSH=<draws>`, measured 2026-11-09, no win, off by default)

A debug global (`dbg:ORTHROS_GL_FLUSH=N` mid-session, `--dbg` at start; 0/unset = off): the WebGL backend calls
`gl.flush()` every N draws (`flushEarly`, `src/gfx/d3d8-webgl.js`), on top of the one at present, so that SwiftShader's
GPU process could start rasterizing while the frame is still being recorded. A/B in one session (alternating
off/16/64/256, 20 s each, two rounds plus a third `off`; `tools/scenarios/{bfme1-108,rotwk,vicecity}-glflush-ab.txt`),
SwiftShader on a loaded shared server (1-minute load 8-33, so absolute fps are low and noisy). Medians over the phases:

| game (scene) | off | 16 | 64 | 256 |
|---|---|---|---|---|
| rotwk-202 (menu): fps / frame p50 ms / p99 ms / render ms | 6.6 / 117 / 507 / 122 | 6.4 / 150 / 406 / 132 | 6.4 / 151 / 400 / 139 | 6.9 / 118 / 398 / 117 |
| vice-city-1.1 (driving): fps / p50 / p99 | 15.3 / 89 / 198 | 14.0 / 92 / 104 | 15.8 / 73 / 108 | 14.8 / 78 / 128 |
| bfme1-108 (menu, 1-3 fps in this run): fps | 1.2 | 2.1 | 0.5 | 2.1 |

Differences are inside the run-to-run drift (the same `off` phases differ more from each other than from the flushed
ones; Vice City's frame time fell steadily across the run whatever the setting). Not better beyond noise on any game,
so the default stays off. The reason is structural: the render worker replays the recorded commands on its own thread
and the emulator only waits for it through the ring's back-pressure, so a flush inside the replay moves no work off
the emulator's critical path; rotwk is bound by the render worker's own 115-140 ms per frame, which one end-of-frame
flush or many does not shorten (SwiftShader rasterizes on the same cores either way). The present path has no other
cheap latency to remove: `getError` runs only for the first 64 draws, there is no `finish`, and the only readbacks are
the guest's own surface reads.
