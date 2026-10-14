# Snapshots of the machine

A Windows game spends 20 to 60 s reaching its menu under Orthros, 92 % of it its own start-up code: streaming the game
files faster cannot shorten that. A snapshot of the whole emulated machine taken at the menu, restored by a later
session, would let the game go on from there. Stage 1 (this document) proves it can be done exactly, in Node; stages 2
and 3 (a player's own snapshot kept in the browser, then one shared by the server) build on it.

## What a snapshot is

- **Guest memory**: every 4 KiB page holding anything (zero pages implied), the JIT's tables left out (`JIT_RANGES`:
  the restored machine translates again).
- **The emulator's JavaScript state**: everything reachable from the Vm (processes, threads, handles, heaps, windows,
  COM objects, Direct3D devices and resources, sound buffers, registry, files...), one record per object, references by
  index, typed arrays' bytes apart (`src/core/snapshot.js`).

It is taken at a **quiet point** only: between two time slices, no thread inside a dispatch loop or a callback, no nested
wait, no file read in flight; the COM calls the JIT queued are run first (`notQuiet`, `captureVm` in
`src/core/vm-snapshot.js`). A snapshot is restored in a **fresh Vm built like the captured one** (same game, files,
host, kind of clock) whose process was not created (`restoreVm`).

## Nothing left out silently

The point of the design: Orthros changes every day, and a snapshot that misses one field goes on with a machine that is
subtly wrong. So:

1. **In by default.** Every field of every reachable object is in the snapshot. A class says which of its fields are
   transient (caches, links to the host, diagnostics) and how to rebuild them (`skip`, `init`).
2. **Refused loudly.** The walk refuses what it cannot rebuild — a function, an object of a class nobody registered, an
   accessor, a view on a buffer it does not know — and names the path (`a function (hook) at
   vm.proc.threads[0].hook`). A capture that meets one fails; with a list (`captureVm(vm, meta, problems)`) it gives
   every refusal at once: the work a new kind of state needs. In production the game then starts the usual way.
3. **Known objects keep their identity.** What every Vm builds alike — the Vm itself, its memory and the memory's views,
   its API registry, its clock, its file system's mounts, the whole graph its modules leave on it once constructed
   (`SnapRegistry.knowGraph`), the containers a module keeps in its closure (`snapKnown(vm, name, container)`) — is
   referred to by name and its contents restored in place, so the closures holding it stay valid. A function in a known
   object is code: the restored Vm's own, checked to be there.
4. **Hidden state is linted.** A variable a module keeps at its top level or in a closure that takes the Vm is invisible
   to the walk. `tests/snapshot-lint.test.js` fails on every such declaration that may hold state (a `let` starting from
   a value of its own, a `const` bound to a container) unless it is handed over (`snapKnown`) or says why it is not
   state (`// snapshot: constant`, `cache`, `diagnostics`, `scratch`...). Names in capitals are constant tables by the
   sources' convention. It found, among others: process ids and window class atoms counted at the module level (shared
   by every Vm of the page), Direct3D resource and shader ids, MCI devices, GDI+ objects, kernel32's named objects and
   mutex slots.
5. **An oracle checks the result.** A machine and its restored copy, run alike, must stay the same — guest memory and
   every object of the state (`snapshotsDiffer`). `tests/snapshot.test.js` does it on the test programs (threads,
   synchronization, priorities, timers, DirectX, MCI) in `make test`; `tools/snapshot-check.mjs` on games. A field a
   change adds and the restore misses makes them differ: the DirectSound counter of logged buffers, believed to be mere
   diagnostics, was caught that way.

## Special cases

- **Parked threads.** A thread blocked in an API call at top level is parked with closures the call made (its wake
  condition, what it claims on wake-up), its call rolled back to the thunk. At a restore the call is executed again as at
  its first try to make them again, then the snapshot's state is put back over what that changed (`decodeGraph`'s
  `reimpose`) and the wait keeps its deadline. No blocking API needs code of its own, present or future.
- **API thunks.** The registry is restored by name: which DLL function each slot holds, the handlers the restored Vm's
  own. Handlers a module defines as the game reaches them (COM methods) are defined again by name (`ApiRegistry.lazyDefs`).
- **Open files** are opened again by their path, at the same position (`FileHandle`). In-memory mounts (files the game
  wrote outside its profile) are kept with their contents; the others are the host's: the game's files, and the
  player's profile — a **persistent mount** (`MemBackend.seen`), see below.
- **The host's side** of the machine's objects is not in a snapshot: what a backend keeps on a Direct3D resource (the
  WebGL backend's texture record, the recorder's mirror record — its shader and declaration ids live in its own
  `WeakMap`), the sound mixer's voice table and slots, the recorder's marks on state tables. A restored resource is one
  no backend has seen: created and uploaded whole at its first use. What the host showed comes back through `resume`
  hooks (`snapshotClass(cls, { resume })`, run once the machine is whole): the window manager sets the display mode,
  title and cursor again.
- **CPU states** are views on the guest memory (rebuilt by address); a PE image's file bytes, only read while it was
  mapped, are not kept.
- **Time** goes on from where it was: a virtual clock's state, a real clock's origin moved. Everything the guest can
  observe reads the guest's clock, never the host's: the time stamp counter (RDTSC: it read `performance.now()`, which
  made BFME2's copy compute other values from the same state), kernel32's Sleep(0) storms — the same on a real clock,
  continuous across a snapshot, deterministic on a virtual one.
- **The JIT** starts empty in the restored machine. `Vm.resetJit()` gives the original an empty one too, so both
  translate alike: the oracle then compares them at the JIT's speed.

## Results (stage 1, Node, virtual clock)

`node tools/snapshot-check.mjs <manifest> --games-dir /srv/orthros/data_games [--at <s> | --input <scenario> --at-mark
<label>] [--jit] [--input-after <scenario>] [--then <slices>] [--every <slices>]`

| game, capture | objects | guest memory | snapshot (raw) | restore | then |
|---|---|---|---|---|---|
| Vice City, menu (130 s) | 3 792 | 25 MiB (6 395 pages) | 28.5 MiB | 0.09 s | a new game started, the city loaded, driven: identical for 200 000 slices (87 s of game, 7.5 M API calls) |
| BFME2 1.09, 120 s (first-launch benchmark) | 35 368 | 112 MiB (28 575 pages) | 119.6 MiB | 0.37 s | identical for 3 000 slices |
| BFME2 1.09, 180 s (drawing, 8 threads) | 35 609 | 119 MiB (30 498 pages) | 127.2 MiB | 0.4-0.8 s | identical for 120 000 slices (30 s of game) |

Compressed sizes (study of 2026-10-14): Vice City ~15 MB, BFME2 ~39 MB at zstd -19. Under Node with an empty profile
BFME2 spends its first 130 s of game time in its first-launch benchmark; its 3D menu was not reached there with the
harness's startup scenario (18 draws per frame where the scenario waits for 150): the skirmish comparison is still to do.

## In the page: a player's own snapshot (stages 1b and 2)

A session takes one **once the game settled**: no file opened for 4 s while it went on presenting frames (a loading
step over), at the next quiet point (`src/host/snapshot-watch.js`, the worker's `snapshotAutoStep`) — then again at each
later settled stretch after more files were opened, until the player's first click or key: an intro that streams its
video from a file already open settles too, the menu after it is a later point. A session restored from a snapshot goes
on the same way. A capture refused — a movie playing, a kind of state not supported yet — is tried again after the next
settled stretch, four times at most. The page keeps it in OPFS
(`orthros-snapshot-<manifest>/machine.bin`, then `machine.json` with its key, written last; the data manager counts it
with the game's cache and clears it with it) once the session went on for 20 s more **with the profile still as the
snapshot's machine saw it** — the next start would refuse it otherwise: a game often writes its settings as it reaches
its menu, just after a screen where it settled first; that snapshot is dropped and another taken at the next settled
stretch. The capture stalls the game once, for 0.6 s in Vice City (most of it reading the 2 GB of guest memory for its
pages: a WebAssembly SIMD scan, bounded by the page faults of the untouched pages). The next start of the game goes on
from it when:

1. **its key is the same** (the page): Orthros' **state-owning sources** — the modules the emulator worker loads,
   followed from `src/core/vm.js` and `src/host/web/worker.js` through their imports, but for the JIT's translator and
   the GPU backends, which a restore rebuilds anyway (`/api/snapshot-sources`, `src/host/snapshot-sources.js`: a
   deployed change to the JIT or the WebGL backend keeps snapshots, one to an API module or the machine does not;
   `tests/snapshot-lint.test.js` fails if a module left out registers snapshot state) — the game version's manifest and
   file tree (sizes, dates), the language and the options that change the machine (`?timescale`, `?interp`, `?dbg`...);
2. **its machine's start is this session's** (the worker, before anything changes: `snapshotStale`): the registry the
   process starts with (seeded from the manifest, the player's settings), and every path of the player's profile the
   game had seen — its existence and size (`stat`), its listing (`readdir`), its bytes (`open`) — is as it saw it. The
   profile is never the snapshot's: it stays the player's, kept by the browser; saves made after the snapshot in a
   folder the game had not listed leave it valid, a changed setting or a new save where the game had listed its saves
   gives a usual start (and a new snapshot, the old one deleted).

A restore that fails midway (not refused beforehand) leaves a machine in pieces: the page deletes the snapshot and
starts again. `?snapshot=0`: none; headless runs: none unless `?snapshot=auto`. `window.orthros.snapshot()` takes one
now, `saveSnapshot()` keeps it as the automatic one.

`tools/with-browser-slot.sh node tools/snapshot-browser-check.mjs <manifest> --games-dir /srv/orthros/data_games`: a
session with automatic snapshots until it kept one, then the page opened again (`--manual --at <s>`: asked for at that
time).

| game | snapshot | taken in (graph, pages, encoding) | restored in |
|---|---|---|---|
| Vice City, menu | 28.5 MiB | 0.6 s (20, 580, 36 ms) — 3.2 s with the earlier JavaScript page scan | 67-90 ms |

## Shared by the server (stage 3)

A player with no profile of a game yet (a first launch in this browser) and no snapshot of its key asks the server
for its **shared snapshot** (`/api/snapshot/<manifest>?key=&lang=`, `src/host/snapshot-store.js`): the one a new
player's session took on the server itself. When there is none, the server (`--snapshot-jobs`) opens the game in a
headless browser as a new player would — the same page and worker, the shared first-launch profile — with
`?snapshot=publish`: each snapshot that session keeps is posted back with the job's token, the later ones replacing the
first, until its loading is over (`tools/snapshot-publish.mjs`, one session at a time, through the browser slot
guard). Made in a browser rather than in Node: the machine sees the same host as a player's (text measured by the
browser's fonts, the audio worklet, the display). It carries the profile as its game had it at the capture (the folders
and settings it wrote while starting): a new player's profile — nothing of their own, at most the shared first-launch
files the session started from too — is made so before the worker's checks, which then pass as for a player's own
snapshot; nothing of a player is ever replaced. Another first-launch profile learned since makes it stale (the server
then makes a new one). Kept with the learned data (`<learn>/snapshots/`), gzip- and
brotli-compressed, the two most recent keys per game version and language. Not downloaded when it would take longer
than 60 s at the connection's last measured rate; kept as the player's own once it applied.

A sandboxed server (the production service: a dynamic user, no home, its own /tmp) does not start browsers: with
`--snapshot-queue` it only queues the request with its token (`<learn>/snapshots/queue.json`), and
`tools/snapshot-jobs.mjs --queue <file> --server <url>`, run outside the sandbox (the `orthros-snapshot-jobs` service),
runs the sessions through the browser slot guard. `node tools/snapshot-shared-check.mjs <manifest> [--queue]`: the whole
path on a private server — a first new player, the server's session, a second new player who must start from it.
