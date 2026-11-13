# The guest address space

Orthros gives a process one flat 2 GiB guest space (`src/cpu/memory.js`, D002): guest address == offset in one
`WebAssembly.Memory`. What the program can allocate ends at `JIT_HASH_BASE` (0x7eb00000); above it are the JIT's hash
table, the API thunks (0x7fb00000, `kernel32.dll!WaitForSingleObject` and friends live there) and the emulator's
private region (thread states, SMC map, TEBs, PEB). `src/win32/vmem.js` hands out the space below at page granularity
with 64 KiB allocation granules, as Windows does: bottom-up by default, top-down for `MEM_TOP_DOWN`, thread stacks
(other than the main thread's) and the manifest `patches` code caves.

A large-address-aware game (BFME2, RotWK and Age of the Ring's `game.dat`) gets up to 4 GiB on 64-bit Windows; here it
gets 2 GiB. A guest access at or past 0x80000000 is outside the WebAssembly memory: in translated code it traps, and
the trap is imprecise (`Jit.run`: the registers are those of the last return to the dispatcher, EIP the last region
entered) and ends the process — Windows would raise an access violation the program's SEH might handle. Writes into
the null page and the last 64 KiB are made precise (docs/null-page.md); reads past 2 GiB are not (a check per load
costs 4-8 % of guest time).

`--log vmem` (harness) logs the address space every 30 s: reserved and free MiB, the largest free run, the
reservations by tag, and the resource heap (below). `VMem.summary()` is the same line; failed allocations that cannot
be returned to the program include it. In Node, `tools/bench/startbench.mjs --mem <s>` prints the same as `[vmem]` lines, with the
count of allocations that found no room — Age of the Ring's long-play measurements are in docs/aotr-play.md.

## Resource memory (`src/win32/res-mem.js`)

The memory Orthros allocates on the program's behalf — Direct3D surfaces (texture levels, standalone surfaces, the
render worker's copy-on-write copies), volumes, vertex and index buffers, `ID3DXBuffer`s — goes through
`resAlloc` / `resFree`. Allocations under 64 KiB share one guest heap (`heap.js`, tag `heap:resources`, 1 MiB
chunks), as the Direct3D runtime keeps resources' system-memory copies in a heap; larger ones keep a reservation of
their own. Every address is 16-byte aligned.

Before (2026-11-10) each level of each texture and each buffer took a reservation of its own, a 64 KiB granule at
least: a 64x64 DXT1 texture's 7 levels (2.7 KiB of texels) took 448 KiB. Measured on Age of the Ring (aotr-10, the
start of a skirmish on Harlindon, headless): 7,301 resources under 64 KiB, 60.6 MiB of data, in 84 MiB of heap
chunks — 456 MiB as one reservation each. The process's whole reservation was 1,106 MiB with the heap, about 1,480 MiB
without; at the main menu, 442 blocks in 3 MiB instead of 28 MiB.

### A lock that finds no memory

Surface memory is allocated at its first use (a lock, a D3DX load, a copy). When the address space has no room left,
`LockRect` / `LockBox` now fail with `E_OUTOFMEMORY` (the first failures logged with the address space); other paths,
which cannot return a failure, stop the process with an `out of guest address space` error. Before, the lock
succeeded with `pBits = 0`.

## The Age of the Ring crash of 2026-11-10

The owner's session (data/proof/aotr-crash-2026-11-10/report.txt, and the session's telemetry) stopped after 38
minutes of skirmish with `fault memory access out of bounds (imprecise: WASM trap inside a JIT region)` in Miles'
mixer thread at `mss32.dll+0x2e8f0`. That was the last link of a chain:

1. 17 ms earlier the main thread took an access violation writing 0xfc00 at `game.dat+0xeeda9`: a loop converting
   texels to A1R5G5B5 into a texture it had just created (`D3DXCreateTexture`, `GetSurfaceLevel`, `LockRect`), rows
   written downwards from `pBits + pitch * (row)`. `edi` = 0xfc00 there means `pBits` was 0: `ensureMem` found no hole
   for the level (`vmem.alloc` returned 0) and the lock reported success. The rows above had already been written over
   0x10000-0x200000: the process heap (`heap:process` at 0x10000) and the bottom of the main stack. The game's handler
   then walked its stack (the `ReadProcessMemory` / `IsBadCodePtr` loop of the report).
2. Miles' service thread (`mss32+0x14d0` → timer callback `mss32+0x1390` → `call [eax+4]` = `mss32+0x2e8f0`) runs its
   timers from structures in that heap (its driver at 0x1a7e0, its mutex 0x103d0): the dump shows them full of 16-bit
   texels. A pointer read from them (`[edi+0x7c]`, the `[ecx+0xc]` → `[edx+4]` chain at `+0x2e950`) was past
   0x80000000, and the load trapped. `ebx`/`esi`/`edi` in the report (0x7fb03750...) are not data: they are the
   thunks of `ReleaseMutex`, `WaitForMultipleObjects` and `WaitForSingleObject` the thread loop keeps in registers,
   flushed at its last API call.

The address space ran out because every small resource took 64 KiB (above): a long session with texture streaming
crossed 2 GiB where the same data needs a few hundred MiB less. The fix is the resource heap; the failed lock is no
longer silent. Not changed: the 2 GiB ceiling itself (a 4 GiB guest memory for large-address-aware programs would move
the private region and touch every address computation that assumes 31 bits), and the imprecise trap of a read past
2 GiB.
