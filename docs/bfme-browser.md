# BFME 1.03 FR in the browser

BottleShip runs the original 32-bit Windows executable on the player's computer. The VPS only serves static/range-addressable game data and relays opaque UDP datagrams used by the virtual LAN; it never renders or simulates the game.

## Player URL

Use a private room name and send the exact same URL to every player:

```text
https://bfme.chalco.website/?game=bfme&room=changez-moi-par-un-secret
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
cd /srv/bfme/app/bottleship
bun install
bun run typecheck
bun test
bun run build

BFME_WGB_PATH=/srv/bfme/data/bfme-1.03-fr.wgb \
BOTTLESHIP_HOST=127.0.0.1 PORT=5173 \
bun deploy/server.ts
```

The production server handles all of the following on one origin:

- `/` and built frontend assets;
- `/apps/bfme.wgb` with `HEAD`, byte ranges and `Accept-Ranges`;
- `/bfme-net` WebSocket upgrades;
- `/bfme-net/health` relay counters.

It also emits `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, which must not be removed by the reverse proxy.

## Caddy and systemd

The checked-in examples are [bfme-bottleship.service](../deploy/bfme-bottleship.service.example) and [Caddyfile](../deploy/Caddyfile.bfme.example). Copy the service to `/etc/systemd/system/bfme-bottleship.service`, adapt paths if necessary, and add the Caddy site block to the active Caddyfile.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bfme-bottleship
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Smoke checks:

```bash
curl -fsS https://bfme.chalco.website/bfme-net/health
curl -fsSI https://bfme.chalco.website/apps/bfme.wgb
curl -fsS -H 'Range: bytes=0-31' \
  https://bfme.chalco.website/apps/bfme.wgb | wc -c
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

That residual profile now drives eight additional exact-signature BFME hooks.
The `stringbase<char>` node search at `0x008a0270` walks its chain directly in
WASM. `_ftol2_sse` at `0x00df6e38` uses the corrected generic x87 handler: it
truncates and pops ST(0), returns EDX:EAX, and produces the x87 indefinite
`0x8000000000000000` for NaN/overflow. Standalone Rust tests cover rounding
modes and invalid values, while the TypeScript fallback tests pin both return
halves.

Matrix leaves at `0x00cd2b50`, `0x00cd2b80`, `0x00cd2d10`, `0x00cd2c80`,
`0x00cd2cc0`, and `0x00cd2bb0` now handle the 32-byte matrix push/pop,
six-float affine composition, 24-byte transform push/pop, and component-wise
matrix adjustment in WASM. They snapshot inputs before writing so aliased output
keeps the original semantics. For the pop/adjust leaves that invoke an update
callback, a short guest wrapper calls WASM first and then preserves the exact
callback and return convention.

In the final ten-second trace all six hot entries execute one guest instruction
for roughly 31,600 calls each, and page `0xcd2` falls to 3.0 weighted guest
instructions per block. All thirteen BFME hooks are active (`confidence: 156`,
none missing). A clean final title window measures 33.00 ms/frame (30.3 FPS),
including 32.11 ms v86, 0.82 ms thunks, and 0.24 ms Present, with no guest fault.

These are headless SwiftShader menu and skirmish results, not proof that a
populated desktop skirmish now sustains 30 FPS. The next meaningful validation is
one fresh worker boot followed by a stable capture from the same real player
skirmish.

## Operational notes

- Relay state is intentionally ephemeral. Restarting the service drops active matches but does not affect saves.
- The relay accepts at most eight peers per room and rejects virtual-IP collisions.
- Rooms are isolated but not authenticated accounts. A secret room URL is the access token.
- Do not put the WGB inside `dist/`; keep it mounted externally and set `BFME_WGB_PATH`.
- Back up the WGB and application source. Player saves live in each browser profile, not on the VPS.
