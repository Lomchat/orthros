# BFME 1.03 FR in the browser

Orthros runs the original 32-bit Windows executable on the player's computer. The VPS only serves static/range-addressable game data and relays opaque UDP datagrams used by the virtual LAN; it never renders or simulates the game.

## Player URL

Use a private room name and send the exact same URL to every player:

```text
https://games.chalco.website/bfme?room=changez-moi-par-un-secret
```

There is no installer, file picker, Wine client, remote desktop or native helper. Chrome downloads game regions on demand and stores writable files (options and saves) in browser storage. A first cold boot on the VPS test hardware took about 105–130 seconds; later access benefits from browser caching.

Requirements:

- current desktop Chrome/Chromium with WebGPU enabled and hardware acceleration active;
- HTTPS (or `localhost`) so cross-origin isolation and `SharedArrayBuffer` are available;
- enough free browser storage for cached game data and saves;
- the legal right to use and distribute the supplied game files.

The `room` value is the multiplayer boundary. Use a long unguessable value for a private match. BFME's in-game path remains **Multijoueur → Réseau local**; one player creates the game and the others join it.

## Architecture

```text
Chrome A ── Windows/x86 + D3D9→WebGPU + Miles audio ──┐
                                                       ├── HTTPS/WSS VPS
Chrome B ── Windows/x86 + D3D9→WebGPU + Miles audio ──┘   static WGB + UDP relay
```

- CPU: v86 executes BFME locally in a Web Worker.
- Graphics: the D3D9 fixed-function path is translated to WebGPU. Geometry and uniforms are staged in persistent arenas to reduce queue submissions.
- Audio: Miles samples are mixed by an AudioWorklet. Music is located inside EA `BIG4` archives and fetched by exact range, rather than unpacking the archives.
- Video: BFME's large VP6 tutorial/campaign movies are decoded locally by the bundled FFmpeg/WASM bridge and copied into the game's own D3D9 movie surface; small alpha/menu loops remain on the native game path.
- Storage: the read-only WGB is streamed by HTTP Range into a resumable 2 MiB-chunk OPFS cache; the writable overlay is also persisted in OPFS.
- Network: `WSOCK32` and `WS2_32` share one socket table. BFME UDP is wrapped in binary WebSocket frames, routed by room and virtual `10.42.x.y` addresses, then restored to the guest socket queues.

## Build and run

```bash
cd /srv/bfme/app/orthros
bun install
bun run typecheck
bun test
bun run build

BFME_WGB_PATH=/srv/bfme/data/bfme-1.03-fr.wgb \
ORTHROS_HOST=127.0.0.1 PORT=5173 \
bun deploy/server.ts
```

The production server handles all of the following on one origin:

- `/` and built frontend assets;
- `/apps/bfme.wgb` with `HEAD`, byte ranges and `Accept-Ranges`;
- `/bfme-net` WebSocket upgrades;
- `/bfme-net/health` relay counters.

It also emits `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, which must not be removed by the reverse proxy.

## Caddy and systemd

The checked-in examples are [bfme-orthros.service](../deploy/bfme-orthros.service.example) and [Caddyfile](../deploy/Caddyfile.orthros.example). Copy the service to `/etc/systemd/system/bfme-orthros.service`, adapt paths if necessary, and add the Caddy site block to the active Caddyfile.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bfme-orthros
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Smoke checks:

```bash
curl -fsS https://games.chalco.website/bfme-net/health
curl -fsSI https://games.chalco.website/apps/bfme.wgb
curl -fsS -H 'Range: bytes=0-31' \
  https://games.chalco.website/apps/bfme.wgb | wc -c
```

The last command must print `32`; the response itself must be HTTP `206`.

## Validation performed

- fresh browser profile booted directly from `?game=bfme`, with no manual bundle load;
- French 1.03 main menu rendered through WebGPU;
- solo match reached live simulation and accepted selection, camera and movement orders;
- two independent Chrome profiles discovered each other, joined one LAN lobby, completed the synchronized loading screen and entered the same live match as Rohan and Isengard;
- both simulations advanced and accepted orders with no recorded CPU/GPU fault;
- real Miles MP3 playback confirmed with a running browser media source and an advancing guest-visible cursor;
- a 51.8 MB, 640×480 VP6 combat-school movie was decoded and displayed inside BFME; captures eight seconds apart confirmed advancing video frames;
- `Options.ini` was read from the writable OPFS overlay after a full page reload and `TimesInGame` advanced from 1 to 2;
- relay broadcast retarget and payload preservation verified with two raw WebSocket clients.

On this VPS, two simultaneous headless Chromium instances using SwiftShader measured roughly 3.8–4.4 FPS each; one menu instance measured roughly 25 FPS. Those numbers measure software rendering under VPS CPU contention, not a player's hardware WebGPU performance.

A complete headless skirmish against one easy AI on Dunharrow is now automated
from the main menu through the live 3D simulation. Map construction takes about
three minutes on the VPS CPU and briefly falls to only a few presents per minute;
this is an emulated-CPU benchmark, not an estimate for a player's PC. The run
also exposed a diagnostic-induced bottleneck: BFME's old compact FPS overlay
copied its canvas into a WebGPU texture on every dirty frame. Under SwiftShader,
the same warm scene measured 1.9 FPS with the overlay and 15.8 FPS without it,
while `Present` fell from roughly 412 ms to 0.65 ms. That GPU path and its
resources have now been removed from every renderer. The opt-in replacement
counts real presents centrally, performs an O(1) interval accumulation, and
posts one summary per second for an ordinary DOM badge showing FPS and average
frame time. It creates no canvas, texture upload, render pass or queue sync; the
first interval after activation is discarded so the displayed window contains
only frames measured while enabled. A Chromium run confirmed live reports in
the badge, and unit tests cover disabled inertia, exact rate calculation and
toggle reset. It remains disabled by default; the normal player path then keeps
only one call and boolean check per present, negligible but not literally zero.

A subsequent full Dunharrow skirmish against one easy AI at 1024×768 alternated
the replacement overlay on the same warm simulation. Across seven raw 6–10
second windows per mode, the median was 17.14 FPS with the overlay off and 17.18
FPS with it visible (+0.2%, within run noise). ABBA and BAAB subsets changed
sign as AI load and simulation stalls evolved, so this run shows no measurable
overlay penalty. The badge continued to receive its one-second reports and the
guest fault list stayed empty.

Profiling was then performed separately with the overlay off. A 120-frame window
averaged 71.80 ms/frame (13.9 FPS): 59.08 ms v86, 11.57 ms thunks and only 0.60
ms Present. The latest frame reached 16.6 FPS (54.49 ms v86, 5.38 ms thunks,
0.63 ms Present), putting about 82% of frame time in x86/JIT execution and less
than 1% in presentation. Across 207 profiled presents, the cumulative buckets
recorded 34,580 `WaitForSingleObject` calls / 431.41 ms, 25,675 `ReleaseMutex`
calls / 188.35 ms, 9,013 `Sleep` calls / 163.41 ms, and 26,770 combined surface
LockRect/UnlockRect calls / 229.33 ms. The worst retained frame was 70.32 ms,
including 59.34 ms v86; its 91 instrumented `LeaveCriticalSection` fallbacks
accounted for 7.28 ms.

A separate ten-second Tier-2 trace again showed tiny-block dispatch pressure.
Pages `0x13035`, `0xc87`, `0xcd2` and `0xddb` executed 1,855,580, 912,849,
670,037 and 454,940 times respectively, with only 3.2–8.0 weighted instructions
per block, alongside many one-instruction stub pages. JIT chaining/fusion and
non-blocking synchronization paths remain the next optimization target, not the
overlay, resolution or GPU.

With a fresh Worker and the overlay off, one 800×600 window measured 57.51
ms/frame (17.4 FPS): 46.44 ms v86, 10.18 ms thunks and 0.50 ms `Present`; its
latest frame reached 21.5 FPS. The same temporary Chromium profile was then run
at a real 1024×768 D3D9 backbuffer. The skirmish loaded without faults and two
warm windows measured 15.1 and 16.1 FPS. `Present` remained only 0.61–0.63 ms,
whereas v86 varied between 50.75 and 54.15 ms. The evolving simulation makes
those FPS windows noisy, but the invariant presentation cost confirms that the
extra pixels are not the dominant limiter. Production still defaults to 800×600;
1024×768 is a validated optional resolution, not a forced migration.

The synchronization fast paths were tightened during the same run. A persistent
`CRITICAL_SECTION` semaphore no longer forces `LeaveCriticalSection` through JS
when the scheduler reports no current waiter. Recursive mutex acquire/release
also stays in WASM while the owner still holds the mutex, even if another thread
is queued; only the final release returns to JS to perform the wake. The first
same-scene 800×600 pair moved from 57.51 to 54.75 ms/frame (17.4 to 18.3 FPS),
but later 58.23 and 71.55 ms windows demonstrate enough simulation/SwiftShader
noise that this must be treated as a safe reduction in fallback traffic, not a
guaranteed five-percent desktop gain.

Desktop performance is still experimental. One run on a PC with a high-end GPU measured roughly 7 FPS before the match, 3 FPS while loading and 1 FPS on first entering a live skirmish, with some textures arriving seconds late. A subsequent 60-frame profile improved from roughly 170–196 ms cold frames to 55–75 ms recent frames as resources became warm; the whole window averaged 94.84 ms (10.5 FPS). A representative recent 61.40 ms frame recorded 50.62 ms in v86/x86, 10.65 ms in HLE thunks, 5.24 ms in Present and 0.01 ms in GPU submission. Instrumented categories can overlap, but the result clearly makes emulated CPU work—not GPU submission—the main steady-state target. `kernel32:HeapAlloc` was the hottest sampled HLE operation and needs its inline-slab fallbacks attributed by size/flags/call site.

A powerful GPU alone does not remove the cost of emulating BFME's x86 CPU and Win32 calls in one browser worker. To attribute another slow run, open **⋯ → Profiler**, select **Start Profiling**, leave the skirmish running for 10–15 seconds, then capture the **Frame Analysis** and **Worst Frames** tabs. The streamed-WGB path now keeps a 256 MiB RAM working set and a resumable OPFS copy, completed in the background with retries. A player retest found only a slight improvement and still-unplayable gameplay, confirming that cold resource loading must be evaluated separately from the dominant steady-state emulated-CPU cost.

For a targeted heap capture, open the page console while the skirmish is live and run:

```js
await __BS__.harness.dbgCall("heapAllocDiag", true);
// Play for about ten seconds.
await __BS__.harness.dbgCall("heapAllocDiagReport");
await __BS__.harness.dbgCall("heapSlabReport");
```

This opt-in counter records only `HeapAlloc` calls that escaped the inline x86/WASM slab, grouped by reason, size, flags and guest return address. It is disabled by default and must guide any slab-class expansion instead of increasing the arena blindly.

The first player capture found the initial 4 MiB slab full (`4,194,224 / 4,194,304` bytes) with 302,857 cumulative fallbacks. The dispatcher's final `heapAllocFastPath` was returning directly without calling the geometric slab-growth hook, so the arena could remain full forever. The deployed handler now records that path and invokes `maybeGrowHeapSlab()` for a fallen-through allocation of at most 4 KiB. A new worker boot should therefore show generation 2 (8 MiB) if the live workload keeps exhausting generation 1; the resulting FPS and long-match stability still require a player-machine validation.

The player retest grew through 4, 8 and 16 MiB to an active 32 MiB slab with 61.6% free; only two larger-than-slab JS allocations occurred in the ten-second diagnostic window. A subsequent 120-frame A/B measured 58.38 ms/frame (17.1 FPS) with fastmem writes off and 57.49 ms/frame (17.4 FPS) with them on. The write-map audit was clean (`danger=0`), but the 1.5% frame-time improvement is too small to justify enabling this still-sensitive optimization by default. v86 code generation and hot guest pages remain the primary target.

A local hot-toggle test ruled out `flag locals`: after pausing the worker, enabling it and rebuilding the JIT cache, frame presentation stopped and the guest hit an unhandled write fault at `EIP 0x00c829d1` targeting low address `0x000004ed`. It therefore remains disabled. Tier-2 also filled all 256 tracked pages and rejected 480 additional promotions. Its retained-page cap is now runtime-tunable for diagnostics, but raising it to 512 removed the refusals without improving frame time. Neutralizing the expanded tier-2 budgets also produced no regression, while profile-guided indirect regions were slightly slower. Production therefore keeps the 256-page cap, the existing tier-2 budgets and indirect regions off.

The next profile resolved the hottest thunk page to the shared D3D9 `SetRenderState`/`SetSamplerState` shadow trampoline. It was preserving EFLAGS plus three volatile registers on every stdcall. The optimized emitter now uses only volatile registers and no longer saves `EBX`: weighted guest instructions on that page fell from 5.7 to 4.6 (-19.3%), and the local thunk category fell from 6.84–7.02 ms to 3.61 ms. Total SwiftShader frame time moved only from 33.31 to 33.00 ms (-0.9%), so a desktop-player A/B is still required. A clean reboot then exercised the two trampolines 38,179 times with zero guest-shadow/state-tracker mismatch, zero memory fault and zero C++ exception.

The first post-deployment player capture used
`emulator.worker-ClENwuB-.js`. The D3D9 shadows skipped 7,804,663 redundant
setters with zero mismatches; 8,408,531 writes still reached the write buffer,
so the shadows avoided about 48.1% of the traffic this sample would otherwise
have generated. This is a valid and substantial traffic reduction, but it was
not sufficient for playability: the 120-frame window averaged 79.48 ms / 12.6
FPS, with 66.08 ms in `v86`; its latest frame was 54.14 ms / 18.5 FPS, with
45.33 ms in `v86`. The scene is not known to be identical to the earlier
baseline, so this must not be labeled a regression. The next evidence to collect
is `perfSpikes`, `profilerStats`, and an opt-in Tier-2 page/block trace from the
same stable in-game scene.

That follow-up trace found four dominant ten-second pages: `0x21141` at
1,874,379 block executions, `0x13012` at 1,112,755, `0xcd2` at 725,912 and
`0xc2e` at 577,969. Their execution-weighted blocks contain only 3.5–7.8 guest
instructions, which makes JIT/dispatcher transitions the concrete CPU target.
The five retained worst frames ranged from 66.89 to 118.06 ms; the worst spent
94.47 ms in `v86`, while 274 `LeaveCriticalSection` calls contributed 12.64 ms.
`Present` stayed near 7.4–8.3 ms. Cumulative named buckets also contain more
than one million `WaitForSingleObject`, about 880,000 `ReleaseMutex` and 330,000
`Sleep` calls. This evidence therefore made tiny-block dispatch and the fixed
cost of proven non-blocking synchronization paths the next implementation target,
subject to the headless functional gates before deployment.

That implementation is now present. The `0x13012` page was native MSVCR71
`tolower`, reached once per byte by BFME's case-insensitive fold-33 hash at
`0x0048f3c0`. A byte-exact BFME 1.03 FR descriptor now replaces that whole pure
loop with WASM inner-loop handler 135. Real CRT `tolower`/`toupper` imports also
use trap-free x86 leaves, while preserving EOF, negative integers and values
above 255. D3D9 shadow trampolines now use only volatile registers, directly
index their shadow table without saving EBX, and jump to one shared return tail.
Their per-skip diagnostic write is disabled in production, so `setterShadow` is
intentionally `null`; `shadowDiff` remains available and the latest run reported
zero mismatches for all five shadowed setter families.

Uncontended `EnterCriticalSection`/`LeaveCriticalSection` now run in guest x86 as
well. They read the current thread id from the real guest TEB at `fs:[0x24]` and
fall through to the complete Win32 thunk for contention, invalid ownership or a
real current waiter. In a clean headless run, the game reached a stable D3D9 window
with no memory fault. A 120-frame sample measured 33.08 ms/frame (30.2 FPS):
28.35 ms v86, 4.56 ms thunks and 2.77 ms Present. `LeaveCriticalSection` no longer
appeared among the retained worst-frame thunks. This is a strong runtime gate on
the VPS, but it is not a claim that a fully populated player skirmish already
holds 30 FPS; that final desktop scene still needs one post-deployment retest.

`SetTextureStageState` now uses the same guest-side shadow with a collision-free 512-slot `(stage << 6) | type` key and state-block-aware write-back. In a real headless BFME window it rejected 127,534 of 141,694 calls (90.0%) before they entered the ring. The observed ring handled 144,738 entries instead of the 272,272 it would have handled without this third shadow, a 46.8% traffic reduction for that window. All three shadow tables matched the authoritative D3D9 state, faults stayed empty, and the title screen rendered correctly. The 120-frame local result was 32.99 ms/frame, but it was not a same-scene A/B; desktop FPS still needs a player retest.

`SetTexture` is now shadowed per stage on its raw COM pointer as well, including rollback while recording and synchronization during state-block Apply. A loaded headless window rejected 41,890 of 67,573 calls (62.0%) before the ring, avoiding another 12.3% of entries relative to the 297,826 entries that remained. All four shadow tables matched authoritative state with no fault, while the animated menu remained visible.

The generic emitter also supports scalar setters with one implicit slot, now used by `SetFVF`. Under load it rejected 2,865 of 9,759 calls (29.4%) before the ring, with the FVF shadow matching the tracker and no fault. An additional byte-identity snapshot pins this no-key code path.

The persistent WGB cache now derives its identity from the mounted bundle rather
than the generic development route name. This prevents a temporary bundle used
for a resolution test from reusing production OPFS chunks. Production URLs keep
their existing basename key, and both forms are covered by unit tests.

D3D9 dynamic buffers now remember the union of ranges changed between lock and
unlock and upload only that aligned range to WebGPU. At 1920×1080 on the animated
title, this changed the trace from 27.4 FPS, P99 115.7 ms, 7.2% garbage collection
and 58.5% JavaScript to 30.3 FPS, P99 44.6 ms, 1.6% garbage collection and 31.1%
JavaScript. `Present` fell from about 3.0 to 0.46 ms, and full-buffer
`queue.writeBuffer` copies disappeared from the hot list.

The hot resource calls `VertexBuffer::Lock/Unlock`, `IndexBuffer::Lock/Unlock`,
`GetTransform`, and `Surface::GetDesc` also use direct HLE paths with exact slow
fallbacks for invalid inputs. Their tests cover both success and fallback. The
first partial A/B reduced JavaScript/HLE from 30.0% to 18.3% and the slow port
dispatcher from 6.5% to 1.9%; the final fully warm trace records 11.2% and 1.2%.

v86 now stops calling the Tier-2 execution counter after its 256 retained pages
are saturated. This removed a function that consumed 2.3% of the CPU profile and
moved a controlled local window from 33.80 to 33.34 ms/frame. The Tier-2 cap,
budgets and indirect-region setting remain unchanged because their earlier A/Bs
did not improve frame time. Normal/verbose logging and scheduler restore tracing
are likewise absent from the production hot path unless a diagnostic consumer
explicitly enables them; warnings and errors are still retained.

Resolution runs at 800×600, 1280×720 and 1920×1080 measured approximately 30.3,
30.3 and 30.2 FPS on the same stable title scene. Resolution is therefore no
longer the bottleneck on this headless test, although BFME's 4:3 UI can clip menu
elements at 16:9. Two final 800×600 traces reproduced 33.11 and 33.08 ms/frame
(30.2 FPS), with P99 values of 37.94 and 40.37 ms. `shadowDiff`, after flushing
the deferred write ring, reported zero mismatch across all five shadow families,
and the fault list was empty. This is effectively the engine's nominal 30 FPS
cadence; changing the simulation clock to force a higher number could alter game
speed or multiplayer synchronization.

A complete headless skirmish then exposed the remaining guest-CPU cost. Page
`0xc87` retired 1,468,303 tiny blocks in twelve seconds. Three adjacent
`stringbase<char>` helpers at `0x00c87940`, `0x00c87b60`, and `0x00c87c90`
took the same global lock for every reference release, copy, and assignment.
Exact BFME 1.03 FR entry filters now route only allocation-free cases to WASM:
null/shared release, reference copy, and assignment whose old value does not
need a real free. Unique buffers, invalid state, and every allocator case use the
unaltered guest function. Of 124,175 release entries in the validation window,
only 16,551 still needed the original path (86.7% avoided); observed copy and
assignment calls were almost entirely handled natively. The page fell to 714,941
blocks even though the optimized run produced more frames.

The same skirmish measured 66.94 ms/frame (14.9 FPS) before these helpers, with
55.52 ms in v86, 10.44 ms in thunks, and 0.79 ms in Present. Clean post-patch
windows measured 42.37–43.36 ms/frame (23.1–23.6 FPS): 35.96–38.11 ms v86,
4.64–4.80 ms thunks, and 0.55–0.60 ms Present. One frame reached 32.61 ms / 30.7
FPS, but the 120-frame average is not yet 30 FPS. All five D3D9 shadows still
matched and no memory fault was recorded.

An uncontended-lock hook at `0x00c2c760` was rejected after a hot in-game A/B:
49.04 ms/frame with the hook versus 41.03 ms/frame immediately after unpatching
it. It is not in production. The remaining profile is led by the static x87
helper at `0x00df6e38` and v86 execution.

Two other residual-profile candidates were evaluated and removed from the
retained build. The `stringbase<char>` node lookup at `0x008a0270` and the
`_ftol2_sse` replacement at `0x00df6e38` did not provide enough repeatable gain
to justify their risk. Simplified x87/SSE flag handling was neutral in the
controlled window, while removing the targeted `FWAIT` broke menu navigation.
The original x87 path therefore remains active.

Matrix leaves at `0x00cd2b50`, `0x00cd2b80`, `0x00cd2d10`, `0x00cd2c80`,
`0x00cd2cc0`, and `0x00cd2bb0` now handle the 32-byte matrix push/pop,
six-float affine composition, 24-byte transform push/pop, and component-wise
matrix adjustment in WASM. They snapshot inputs before writing so aliased output
keeps the original semantics. For the pop/adjust leaves that invoke an update
callback, a short guest wrapper calls WASM first and then preserves the exact
callback and return convention.

In the final ten-second trace all six hot entries execute one guest instruction
for roughly 31,600 calls each, and page `0xcd2` falls to 3.0 weighted guest
instructions per block.

The two STLPort eight-byte-class pool helpers at `0x00c2e540` and `0x00c2e5f0`
now pop and push their freelists directly in guest x86. A busy lock or empty
class falls back to the exact original allocator. The scheduler treats this
read/modify/write sequence as a short non-preemptible range; page `0xc2e`, which
previously accounted for 577,969 blocks in the player capture, no longer appears
among the hot Tier-2 pages after activation.

The accepted `stringbase<char>` reference branches are also fully guest-native
now. Shared release, copy, and shared assignment complete in the generated x86
wrapper without `OUT`, JavaScript thunking, or a diagnostic counter write;
unique values that need a real free still run the original function. On clean
boots of the same headless title scene, disabling these three hooks measured
55.44 ms/frame (18.0 FPS: 49.65 ms v86 and 5.21 ms thunks), while the direct
wrappers measured 33.04 ms/frame (30.3 FPS: 32.11 ms v86 and 0.86 ms thunks).
The latest optimized frame was 33.94 ms / 29.5 FPS and the guest fault list was
empty.

The fourteen retained BFME hooks are the fold-33 hash, lowercase helper, three
string-reference operations, two small-pool operations, and six matrix/transform
leaves, plus the STL tree successor described below (`confidence: 168`, none
missing). Headless navigation is deterministic
when each mouse move precedes `clickHold` by roughly 1.2 seconds. Fresh skirmish
runs with all three guest-native string wrappers measured 42.27–43.32 ms/frame
(23.1–23.7 FPS) before the synchronization changes below.

The hot internal MSVCR71 x87 control-word helper at `0x13035c77` was evaluated
and removed: its WASM replacement measured 41.07 ms/frame versus 39.69 and 40.15
ms after hot-unpatching it. The OUT/WASM transition cost more than the native x87
work it replaced.

The retained WASM `LeaveCriticalSection` path now performs a final release when
the persistent semaphore has a valid event mirror with no waiter. Invalid or
stale handles and real contention still fall back to JS. A 360-frame skirmish
window measured 38.71 ms/frame (25.8 FPS), including 36.09 ms v86 and 2.41 ms
thunks; the latest frame reached 31.7 FPS, `LeaveCriticalSection` disappeared from
the leading buckets, and no guest fault was recorded.

The next investigation found a concrete mutex-mirror addressing bug. The mirror
is allocated at a guest address, but its JS writer indexed the raw
`WebAssembly.Memory` buffer without the guest RAM view's byte offset (66 MiB in
the measured process). The table v86 actually read therefore remained all zero
while the JS shadow held 25–36 mutexes. Mirror reads and writes now use
`Process.getCurrentMemory()`, and memory growth no longer restores stale JS
shadow ownership over live WASM/guest mutations. A unit test reproduces a
non-zero guest-memory offset and verifies both the physical write location and
decoded state.

With the corrected mirror, a clean skirmish exposed 35 live mutex entries. Across
360 frames, instrumented `WaitForSingleObject` transitions fell from 32,090 to
5,761 and `ReleaseMutex` from 25,989 to 363 compared with the immediately prior
window. Frame time moved from 41.15 ms / 24.3 FPS to 38.53 ms / 26.0 FPS, with a
latest frame at 28 FPS and no faults. Guest x86 mutex stubs were also tested and
rejected: a same-match hot A/B measured 37.62 ms / 26.6 FPS through the existing
WASM handlers versus 40.68 ms / 24.6 FPS through the longer guest stubs. The
retained design is therefore the fixed mirror plus WASM handlers. Residual time
is still dominated by v86 (35.70 ms in the WASM A/B), real/non-mutex waits,
`Sleep`, and surface LockRect/UnlockRect traffic. Stable 30 FPS on the player's
desktop skirmish remains unproven.

Presentation telemetry now separates guest `Present` calls from frames actually
published by the browser. It exposed a blind spot in the headless fallback: that
path copied every WebGPU framebuffer back to the CPU, removed row padding,
swizzled BGRA to RGBA, and created an asynchronous `ImageBitmap`. A ten-second
window recorded 304 guest Presents but no published frame because one GPU map
remained pending; the FPS badge therefore measured simulation cadence, not this
fallback's visible cadence.

Normal desktop browsers now present directly to the WebGPU swapchain, removing
the full GPU-to-CPU readback from the player path. `HeadlessChrome` automatically
keeps the CPU bridge because forcing direct presentation on SwiftShader stalled
presentation and saturated its renderer. The bridge now has one-second map and
bitmap timeouts, recovers instead of remaining permanently locked, and combines
row compaction with BGRA/RGBA conversion in one 32-bit pass. `d3d9Perf` reports
encoded, dropped, published, failed and timed-out CPU frames, map/bitmap timing,
the current in-flight phase, and direct-presented frames.
The Worker boolean `__d3d9DirectPresent` can still force either path for an A/B;
it is a diagnostic override, not a player-facing compatibility setting.

The direct D3D9 present source is sampled by the post-processing blit and must
therefore be created with `TEXTURE_BINDING` in addition to `COPY_SRC` and
`RENDER_ATTACHMENT`. A regression briefly omitted that usage bit: desktop WebGPU
rejected the bind group and every following command buffer, while headless tests
remained green because their CPU bridge only copied the texture. The usage mask
now comes from a unit-tested presentation-policy helper. Build
`emulator.worker-CEw5d4yf.js` sustained 8,817 direct presents in a normal-UA
Chromium/Xvfb run with zero CPU fallback frames, faults, shadow mismatches or
captured WebGPU validation errors. Its frames contained 34 draws. SwiftShader's
external X11 swapchain remained white and forced readbacks failed, so this run is
a validation/liveness gate for the direct WebGPU path, not a visual substitute
for the player's hardware-GPU retest.

A clean headless boot confirmed the automatic fallback (`directPresentFrames:
0`). SwiftShader published only 2 of 255 cumulative guest Presents, with 11 GPU
map timeouts; `ImageBitmap` conversion consumed just 4.75 ms total, identifying
the GPU readback as the blocked stage. Guest execution nevertheless retained
33.00 ms/frame over 120 frames (30.3 FPS: 31.96 ms v86, 0.96 ms thunks, 0.23 ms
Present). Direct desktop presentation removes that hidden bottleneck, but it has
not yet been measured on the player's real GPU and is not itself proof of stable
30 FPS in a populated skirmish.

The next trace found roughly 1.58 million calls to the generic
`winmm:timeGetTime` stub in ten seconds. A hot patch of the already-audited
trap-free RDTSC leaf measured 250.44 ms wall time, 250.74 ms virtual time and 250
ms from the leaf; its same-match A/B improved from 37.18 to 36.45 ms/frame, about
2%. Import resolution originally skipped the leaf when the v86 execution exports
were not published yet. Bootstrap now correctly uses the architectural TSC's
initial zero in that case. A clean boot no longer executes the generic stub at
`0x210484a0`; a second audit measured 260.82 ms wall time, 260.18 ms virtual time
and 260 ms from the leaf. The optimization is now active for `lotrbfme.exe`, with
`__noInlineTime=true` as its diagnostic kill switch.

After removing that dispatch traffic, `lotrbfme.exe`'s STL tree-successor helper
at `0x00c2b870` became the hottest page: about 32,000 calls/s and 1.43 million
tiny blocks in five seconds. An exact 105-byte signature now routes its
parent/left/right traversal through WASM handler 147, with bounded traversal and
safe fallback for invalid memory or cycles. The same build sends
`SetSoftwareVertexProcessing`—ten calls per rendered frame—through a shadowed
D3D9 write-buffer slot; it no longer appears in profiler buckets.

A same-skirmish hot A/B measured 43.04 ms/frame (23.2 FPS) after unpatching only
the tree hook and 41.67 ms/frame (24.0 FPS) with it active, a 3.2% frame-time
reduction. The active window comprised 40.28 ms v86, 1.30 ms thunks and 0.78 ms
Present, with no guest faults and zero mismatches in all five D3D9 shadows. Its
latest frame reached 25.1 FPS; this SwiftShader skirmish is therefore still below
a stable 30 FPS and does not replace validation on the player's desktop.

The residual native MSVCR71 `sprintf` path was also evaluated. It receives about
2,100 calls/s and its shared `_output` parser generated 4.21 million x86 blocks
per ten seconds. A temporary route through the JavaScript formatter removed those
blocks but added 43,306 thunks in the measured window and regressed the same match
from 41.41 to 43.06 ms/frame (24.1 to 23.2 FPS). That route was removed completely;
`sprintf` remains native until a cheaper guest or WASM path exists.

Dynamic `RET` chaining and local return-target speculation were then isolated on
the same live skirmish. A six-window ABBA measured a 38.40 ms/frame median with
chaining versus 37.15 ms without it, a 3.3% frame-time recovery when disabled.
Only 3,106,849 chain probes hit while 24,005,553 missed (11.5% hit rate), so the
failed lookup dominates its benefit for BFME. With chaining off, speculation was
neutral to slightly slower (36.79 ms active versus 36.47 ms inactive). Both now
default off and remain opt-in diagnostic controls; every measured window had an
empty guest-fault list.

A follow-up prototype moved guest-register writeback after a successful chain
probe, removing the duplicate writeback on the 88.5% miss path. It compiled and
ran correctly, but another six-window ABBA produced the same 34.67 ms/frame
median with chaining on and off, with greater variance while enabled. The
prototype was removed and the original v86 WASM rebuilt.

On a subsequent completely fresh Worker, the live WASM exports reported both
controls at zero. The browser traversed the menu, loading screen, and a new live
skirmish. Its clean 120-frame window measured 35.89 ms/frame (27.9 FPS): 34.00 ms
v86, 1.77 ms thunks, and 0.62 ms Present. All fourteen BFME hooks were present,
all five D3D9 shadows matched, and the guest-fault list was empty. This is the
best clean headless skirmish validation so far, but it is still about 2.6
ms/frame short of a stable 30 FPS average.

The remaining `IDirect3DSurface9::LockRect/UnlockRect` calls now use synchronous
FastPaths backed by the exact same implementation as the ordinary thunk, so the
VP6 movie-frame injection on unlock is preserved. A unit test covers pitch,
partial-rectangle offset, and the memory passed to unlock. A new Chrome process
and skirmish measured 34.35 ms/frame (29.1 FPS): 33.27 ms v86, 1.04 ms thunks,
and 0.56 ms Present; its latest frame reached 32.8 FPS. The previous clean boot
spent 1.77 ms in thunks, and the two Surface buckets that had accumulated about
1.05 ms/frame disappeared from the global hot list. The evolving simulation
makes the 4.3% total frame-time change a non-strict cross-boot comparison, but
the 0.73 ms thunk reduction and vanished buckets directly attribute the retained
gain. Shadows remained exact and the guest-fault list stayed empty.

The retained source was then rebuilt and deployed as
`emulator.worker-Cxnvj1l4.js`. A fresh Chrome profile traversed the menu, full
loading sequence, and a new skirmish with an AI player on that exact worker.
Warm 120-frame windows initially measured 33.63–34.08 ms/frame (29.3–29.7 FPS),
with a recent frame at 32.96 ms / 30.3 FPS. The hot trace was dominated by the
engine clock wait at `0x00505750`, but four of 120 frames still reached as high
as 44.02 ms almost entirely in v86. As the populated simulation evolved, a later
window reached 36.77 ms / 27.2 FPS. The clean deployment therefore reaches the
30 FPS engine ceiling on ordinary warm frames, but does not yet prove a stable
30 FPS throughout an evolving populated match.

Two more reversible guest-code candidates were rejected during that run. The
constant `_level%d` call site at `0x00cc5016` executed only 462 times in ten
seconds and then became cold, so specializing it could not affect steady-state
FPS. The AABB transform at `0x00cd71c0` ran about 4,000 times/s and was temporarily
replaced by a 622-byte SSE2 implementation in an unused code cave. Its first
frame was fast, but the hot window regressed to 38.81 ms / 25.8 FPS. The original
eight entry bytes were restored, the JIT cache was rebuilt, and no guest fault
was observed. Neither experiment is present in the retained source or deployed
bundle.

The current-module `AbsoluteEip` resolver used by every RET and indirect branch
is now emitted directly into generated wasm. It reads the shared
`DISPATCH_META`/`DISPATCH_SLABS` SoA tables instead of crossing back into the
base Rust/WASM module for two loads and comparisons. The inline shape checks the
state flags and table slot together and preserves `u16::MAX` as the unpublished
entry sentinel. Config index 22 remains a live kill switch, exposed as
`dbg.jitInlineDispatch(false)` and kept authoritative across v86 reloads by the
PreemptionManager. Both the v86 fork and Orthros production enable it by
default, so future consumers of the runtime do not require Orthros's
TypeScript manager to receive the optimization.

A deterministic eight-million CALL/RET benchmark checks the arithmetic result,
a cold same-page target absent from the compiled CFG, and a cross-page miss with
the module budget forced to one page. The retained run improved from a 122.10 ms
median to 94.35 ms (+29.4% throughput), while the cross-page case also completed
correctly at 119.81 versus 76.99 ms. The existing one-, two-, and three-page JIT
regression test still passes. A hot-cache BFME configuration screen remained at
the engine's 30.3 FPS ceiling for fifteen seconds after enabling the option and
recompiling, with no guest fault and zero mismatches in all five D3D9 shadows.
That capped screen is a stability check, not a populated-skirmish performance
claim: this fresh headless profile did not progress past setup, while the
SwiftShader CPU readback remained black. A same-skirmish or desktop A/B is still
required to quantify the BFME frame-time gain. The retained build is deployed as
`emulator.worker-CgeHd2Zf.js`; after a complete reload, a fresh Worker reported
the TypeScript authority enabled, `get_jit_config(22) == 1`, and 11,010 emitted
inline sites before any manual diagnostic toggle.

A separate direct `JMP`/`Jcc` cross-module chaining experiment is now retained
as an opt-in v86 facility, not as a BFME default. Config index 4 first tried the
page-local DOD owner and missed about 92% of BFME's candidate exits. The retained
resolver therefore keeps an exact `(virtual EIP, state flags)` open-addressed
index with table-generation invalidation, plus one positive or negative memo per
generated exit site. Positive memos use the global target invalidation epoch;
negative memos retry only when a new exact target is published. The scheduler
guard uses the cycle limit cached at `do_many_cycles_native` entry. Browsers must
support WebAssembly `return_call_indirect`; Orthros probes that opcode before
allowing `dbg.jitBlockChain(true)`. Toggling clears the JIT cache. While disabled,
exact entries are not published, so the normal BFME path does not touch the
large side index.

The deterministic two-page benchmark still gains 73.7% throughput (208.67 to
120.12 ms median for four million iterations), with correct registers, quantum
exits and no exact-index or memo overflow. The populated BFME result is different:
after excluding one obvious AI stall, three OFF windows averaged 33.87 ms/frame
and four ON windows averaged 33.85 ms/frame, only 0.07% in favor of chaining and
therefore pure noise. Instrumentation nevertheless proved the mechanism active:
26.59 million edges chained in fifteen seconds, 3.17 million fell back on a
missing target and only 496 yielded for the scheduler budget. The five D3D9
shadows stayed exact and the guest-fault list remained empty.

Passing all eight x86 registers directly through an expanded JIT-module ABI was
also implemented and tested, then removed. It raised the synthetic gain as high
as 132%, but cross-instance calls with eleven WebAssembly parameters made BFME
2.6% slower (33.92 to 34.80 ms/frame) once the cumulative instruction counter
and budget were carried too. Naive region enlargement was rejected as well:
six pages brought no gain, twelve pages regressed to 37.16–41.46 ms/frame, and
raising the extra-block budget from 250 to 500 or 1,000 was neutral after a
same-match return to 250 (34.08 versus 34.06 ms/frame at the end). Production
therefore keeps three pages, 250 extra blocks and direct chaining disabled. The
next version of this architectural idea would need profile-guided linking of hot
regions into one generated WebAssembly module, rather than more cross-instance
tail calls or a blind increase of existing module budgets.

That profile-guided Tier-2 version is now implemented generically. Modules in
the final quarter of their warm-up reuse the existing 1/256 Tier-2 hotness
sample; only a selected execution records its runtime successor. Each WASM slot
keeps at most eight Misra-Gries candidates and 4,096 samples. At promotion, only
already-compiled targets with matching CPU state and at least 5% share may join
the source module. The union is capped at the existing eight-page Tier-2 budget,
thunk/callback pages are excluded, and edges outside the selected union remain
normal side exits. Slot reuse and self-modifying-code invalidation both discard
stale profiles.

Two more expensive versions were rejected. Recording every eligible exit
produced 1,260,674,954 events during BFME. Sampling at exit still added 11.1%
to a deliberately pathological tiny-module loop. Folding the decision into the
existing hotness sample reduced the incremental armed cost to 0.26%, while a
complete BFME boot/skirmish now records 89,115–198,947 bounded samples instead.

The deterministic generic benchmark alternates between two hot modules while
ten statically reachable cold pages compete for the wider compile budget. The
legacy Tier-2 median is 193.43 ms for four million iterations; the selected
region is 115.00 ms, a 68.2% throughput gain. It is also 57.7% faster than the
181.31 ms no-Tier-2 median, retains exact architectural results, and forms the
region from roughly 723–784 sampled exits. Run it with
`node vendor/v86/tests/jit-tier2-regions-repro.mjs`.

A fresh full BFME skirmish reached 32.98 ms/frame / 30.3 FPS (32.42 ms v86,
0.53 ms thunks, 0.27 ms Present), with 49 regions and 85 seeds, no guest fault,
and zero mismatch across all five D3D9 shadows. A hot same-match A/B measured
32.99 ms / 30.3 FPS with legacy Tier-2 and 33.06 ms / 30.2 FPS after regions
were re-enabled. The 0.2% difference is noise at BFME's engine-clock ceiling:
this is a validated general multi-module win, not extra BFME FPS once the game
already waits for its next 30 Hz frame.

Config index 23 and `dbg.jitTier2Regions(false)` provide an authoritative kill
switch; toggling resets the Tier-2 profile and JIT cache. Regions are enabled by
default in v86 and Orthros. Direct tail-call block chaining remains disabled.

The first source with profile-guided regions was rebuilt and deployed as
`emulator.worker-DHJNUrwY.js`; the later D3D9 presentation correction was
deployed as `emulator.worker-CEw5d4yf.js`. A fresh Chromium process loaded the
latter, completed a BFME skirmish and reported direct chaining disabled, Tier-2
regions active, zero D3D9 mismatch and no guest fault.

The first complete run of that build on the player's actual PC exposed a phase
problem hidden by the final headless rate: the skirmish spent several minutes at
about 2 FPS and then stabilized around only 15 FPS. A fresh old-policy headless
run subsequently showed the 256-page Tier-2 set already full before gameplay;
one later promotion was refused, so startup and menu pages could remain selected
for the entire process even after execution moved into simulation code.

Tier-2 now maintains a bounded adaptive hot set. Once the existing 256-page cap
is full, one sparse maintenance opportunity is armed every 4,000,003 guest
instructions at the outer scheduler boundary. A newly hot module can evict the
least recently sampled retained marking; the cap never grows, existing compiled
modules remain valid, and stale region plans touching an evicted page are
discarded. This is generic v86 phase adaptation and contains no BFME address.
Config index 24 and `dbg.jitTier2Adaptive(false)` provide a live kill switch.
`dbg.tier2Stats()` exposes maintenance samples and page evictions.

The deterministic four-page phase-change benchmark fills a two-page set with
phase A, then permanently transfers execution to two different pages. Seven
independent pairs measured a 1,001.99 ms legacy median against 969.83 ms adaptive
median, a 3.3% throughput improvement, with identical architectural results and
the same hard cap. A deliberately pathological two-instruction cross-module
steady loop bounded the possible sampling cost at about 1.0% in that series;
normal modules do more work per entry. Run the correctness gate with
`node vendor/v86/tests/jit-tier2-adaptive-repro.mjs`.

The cold compiler had a separate global serialization point: `JitState` could
hold only one asynchronous `WebAssembly.instantiate` Promise, so every other hot
page remained interpreted until it settled. It now owns a bounded map of pending
modules. Orthros selects two in flight by default (config index 25); one is the
historical kill-switch and eight is the hard maximum. The generated bytes are
copied while parallel mode is active so the reusable Rust builder can never
alias a pending browser compile. `dbg.jitPendingCompiles(1..8)` changes the live
bound and `dbg.jitCompileStats()` reports started/completed/pending modules,
high-water, cap skips, and browser compilation latency. The generic 64-page
benchmark preserves exact registers and bounds under both release and assertion
builds; two pending modules are consistently faster than one, while four adds
compiler contention and is not the production default. Run it with
`node vendor/v86/tests/jit-parallel-compile-repro.mjs`.

Saturated phase adaptation also used to stop collecting region successors
entirely. Replacement could therefore select new gameplay pages after startup,
but those pages could never acquire a new cross-module region. Saturated normal
entries remain free of profiling; only the existing sparse maintenance admission
(one per roughly four million guest instructions) now retains its successor.
The adaptive phase test records 114 late exits and three candidates where the
old saturated gate recorded none. `dbg.tier2Stats()` additionally reports region
candidates plus target- and budget-rejection counts.

A fresh full BFME run with both changes measured 33.00 ms/frame / 30.3 FPS,
with 32.49 ms in v86, 0.49 ms in thunks and 0.26 ms in Present. It formed 56
regions and 90 seeds versus 47/74 on the preceding run, with 306 candidates,
91 unsafe-target rejections and 125 eight-page-budget rejections. All five D3D9
shadows matched and the guest fault list was empty. This validates additional
late-phase coalescing without a hot-scene regression; it is not yet evidence of
30 FPS during combat on the player's machine.

The complete candidate BFME run then retained the same 30.3 FPS hot average as
the old policy (33.03 versus 33.01 ms/frame) while completing 112 promotions and
77 bounded page evictions with no promotion blocked. The old policy completed
87 promotions, refused one at the full cap and could never replace a retained
page. Both runs had zero guest faults and zero mismatch across the five D3D9
shadows. This validates phase replacement and absence of a hot-FPS regression on
the VPS; the cold-to-warm improvement and populated 15 FPS desktop scene still
require one fresh player-machine run after deployment.

These are headless SwiftShader menu and skirmish results, not proof that a
populated desktop skirmish now sustains 30 FPS. The next meaningful validation is
one fresh desktop-player boot on this worker followed by a stable capture from
the same real skirmish.

### Solo → Skirmish transition profile

The menu-transition stall is now covered by
`tools/examples/bfme-menu-transition-profile.harness.ts`. D3D9 exclusive mode
uses a real 800×600 Win32 desktop, so the deterministic input points are Solo at
`(90,575)` and Skirmish at `(320,575)`. Older centered-window coordinates could
leave the harness on the previous screen and incorrectly report a flat 30 FPS.

On a fresh Chromium/SwiftShader process, the main menu and the first 1.5 seconds
after the Skirmish click remain at 30.3 FPS. The 1.5–4 second construction window
then measured 139.69 ms/frame (7.2 FPS), including one 1.19-second frame, before
the completed screen returned to 30.3 FPS. Presentation stayed around 0.7–1 ms,
so this transient is CPU/resource construction rather than WebGPU presentation.

`ExtTextOutA/W` used to synchronize a selected CreateDIBSection after every
individually spaced glyph and then again at the API boundary. It now renders the
same glyph sequence and performs one guest-visible DIB commit per public call.
The measured `ExtTextOutW` average fell from 9.53 to about 4.99 ms and the
reference transition improved from 7.2 to 8.2 FPS. Later cold runs varied from
7.8 to 8.3 FPS because BFME's file/resource work is not frame-deterministic; the
retained claim is the halved per-call GDI cost, not a stable 8.2-FPS promise.

A targeted Tier-2 trace also exposed roughly one million basic-block executions
inside `kernel32!GetLastError` and `SetLastError` stubs in 2.5 seconds. Newly
generated 16-byte stubs now load/store the existing authoritative hypercall-page
slot directly. This preserves the scheduler's per-thread swap and JS-thunk
updates while avoiding `OUT`; `__noInlineLastError` is the boot-time kill switch.
The transition A/B (8.3 versus 8.2 FPS) did not show a measurable frame-rate gain,
so this is retained as a generic boundary removal rather than advertised as the
menu-stall fix.

Partial-rectangle canvas readback and a dword/reused-buffer copy variant were
tested and removed: `ExtTextOutW` remained at 4.83–4.86 ms and the transition at
7.8–8.2 FPS. Eliminating or safely deferring the roughly 113 synchronous canvas
readbacks during cold font/resource construction remains a possible secondary
target, but the later CPU trace below found a larger cost in MSVCR71.

A later CPU trace localized the dominant residual below GDI. In 2.5 seconds the
MSVCR71 scanner page executed about two million basic blocks across 23,727
`sscanf` calls: roughly 16,416 exact `%d` conversions and 3,786 exact `%f`
conversions, plus complex multi-field formats. A byte-exact MSVCR71 7.10 hook now
admits only the one-output `%d`, `%u`, and `%f` forms into a bounded WASM parser;
all complex formats remain in the original CRT. On a clean transition this cut
the central window from 117.55 ms/frame (8.5 FPS) to 58.27 ms/frame (17.2 FPS),
and the late window reached 40.92 ms/frame (24.4 FPS).

Two adjacent decimal-formatting helpers are guest-native leaves: unsigned
32-bit add-with-carry and a one-bit shift of a 96-bit integer. `_stricmp` uses a
bounded ASCII WASM leaf. The 96-bit leaf alone moved the central transition from
about 125.8 to 117.55 ms/frame before `sscanf` was specialized. All four hooks
require byte-exact signatures from MSVCR71 7.10.

The scope restriction is a correctness boundary, not merely conservative
documentation. A prototype that also parsed literal-separated, multi-output
formats reached 54.77 ms/frame in one short window but later terminated a full
boot with a fault at MSVCR71 `0x13009f65`; it was removed from both classifier
and handler. A generic `strtok` replacement also terminated startup and was
fully removed. Neither experiment is part of production.

With the newer guest-native leaves in place, seven alternating construction
windows measured dynamic RET chaining at a 16.15 FPS median versus 10.5 FPS when
disabled, with no guest fault. This supersedes the older 11.5%-hit skirmish
profile above: RET chaining is enabled by default again, target speculation
remains disabled, and `dbg.jitRetChain(false)` is the diagnostic kill switch.

Use `bfme-menu-transition-measure.harness.ts` for compact early/middle/late
numbers and `bfme-menu-transition-concise.harness.ts` when a short Tier-2 trace
is needed. Always call `stopLogs` first; streaming Worker diagnostics materially
distorts this cold CPU benchmark.

A clean end-to-end run of the retained scalar version loaded Dunharrow and
measured 36.44 ms/frame (27.4 FPS) over the first 120 hot frames, with a recent
frame at 30.81 ms (32.5 FPS). v86 accounted for 35.14 ms, versus 1.25 ms in
thunks and 0.71 ms in Present. All 18 BFME hooks and four MSVCR71 hooks were
present, all five D3D9 shadows matched, and the guest fault list was empty. After
a global-selection/attack-move input and two further minutes of simulation, the
next window reached 33.01 ms/frame (30.3 FPS), with no frame above 40 ms and no
fault. The harness did not visually prove that opposing units actually engaged,
so this is an evolved-simulation stability check rather than definitive combat
evidence.

The cold menu-transition harness no longer assumes that a fixed four-minute VPS
delay means BFME has rendered. It waits in bounded CDP windows for a real
`frameRendered` event before injecting any input; the full Tier-2 benchmark uses
the same gate. This avoids silently measuring clicks sent to Orthros' loading
screen when SwiftShader startup is unusually slow.

A final clean transition run on 27 August measured Main -> Solo at 49.28 ms/frame
(20.3 FPS), including one isolated 652.97 ms cold frame, and the settled Solo
screen at 33.83 ms/frame (29.6 FPS). The Solo -> Skirmish click itself held
32.96 ms/frame (30.3 FPS). The central construction window averaged 47.65
ms/frame (21.0 FPS) but ended at 32.74 ms (30.5 FPS); the settled setup screen
then measured 37.94 ms/frame (26.4 FPS). The comparable earlier main-thread
profile was 127.87 ms/frame (7.8 FPS) with an 867.77 ms worst frame. v86 still
dominates the remaining central window at 45.72 ms, versus 1.88 ms in thunks and
0.45 ms in Present. All five D3D9 shadows matched and no guest fault was recorded.

An attempted exact hook of BFME's ARGB4444 glyph/image loop at `0x00d4159d` was
rejected and removed completely. Once genuinely armed as raw WASM handler 153,
it left startup without a first presentation for more than eight minutes and
recorded a guest fault at `0x00d415a0` reading address `0x9`. No constant,
signature, wrapper, trampoline extension or handler from that experiment remains.

Those cold reruns also exposed a separate Chromium failure: an
`OffscreenCanvas` replaced during a resolution transition can be rejected by
`GPUQueue.copyExternalImageToTexture`. The exception previously aborted the
entire game load around 96%. Orthros now treats that single GDI overlay upload as
recoverable, skips stale overlay composition, and retries on the next dirty
paint, with warning output capped. A unit test forces the Chromium exception and
the subsequent clean cold browser run reached the BFME menus without a fault.

The next retained cold-path work targets BFME's in-memory parser and software
DXT codec. An exact entry filter routes only one-byte reads at `0x00dd1a70` to a
raw WASM handler; larger reads still execute the relocated original. Two
comparable central windows improved from about 82.66 to 53.63/53.24 ms/frame.
Guest-inline and whole-parser variants regressed to 82.22 and 100.58 ms/frame and
were removed.

An exact BC1 colour-block hook at `0x00e679a5` then removed the hottest inner
decoder loop. Its 64-call live shadow validation completed with zero mismatch
using a one-ULP float tolerance for x87 intermediate precision. On the same
instrumented cold harness, the central transition improved from 164.59 to 90.28
ms/frame (6.1 to 11.1 FPS, roughly 45% lower frame time); a repeated warm
transition measured 33.80 ms/frame and the settled screen returned to 30.2 FPS.
The remaining first-run stall is still real: the DXT encoder at `0x00e67124`
accounts for roughly 4,558 calls and the residual page still executes about 2.67
million JIT blocks in the captured window.

A full BC3 decoder was byte/float equivalent over 64 live blocks but regressed a
same-process warm transition from 33.09 to 41.47 ms/frame and was removed. A
fused BFME `timeGetTime` wrapper (34.80 versus 32.97 ms/frame) and a narrowly
allowlisted Tier-2 region for its monomorphic RDTSC leaf (33.03 versus 32.99
ms/frame) were likewise removed. Only the memory reader and BC1 decoder remain.
Warm screens reach the engine's nominal 30 FPS ceiling; the first cold
construction window does not, so native-equivalent smoothness is not yet a
validated claim.

## Operational notes

- Relay state is intentionally ephemeral. Restarting the service drops active matches but does not affect saves.
- The relay accepts at most eight peers per room and rejects virtual-IP collisions.
- Rooms are isolated but not authenticated accounts. A secret room URL is the access token.
- Do not put the WGB inside `dist/`; keep it mounted externally and set `BFME_WGB_PATH`.
- Back up the WGB and application source. Player saves live in each browser profile, not on the VPS.
