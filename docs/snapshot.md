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
   synchronization, priorities, timers, DirectX, MCI) in `make test`; `tools/check/snapshot-check.mjs` on games. A field a
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
- **Several processes** (a game started by its launcher, docs/processes.md): the whole group is captured, at a point
  where every process is quiet and no ended one waits to be released. Each machine's guest memory is kept (`procs`
  after the first one's pages), and one state graph covers them all: one registry over the machines'
  (`groupSnapRegistry`, `mergedRegistry`: the k-th machine's known names prefixed `k:`, an object shared by the
  processes — the kernel-object namespace, an inherited event, a paging-file mapping and its views — one record), with
  the group itself known as `group`. Each object records the machine it belongs to when not the first (a process or a
  thread names its own; a class defined in one machine's closure is that machine's; else its parent's): its class,
  `init` and `load` hooks are that machine's at the restore (a thread's CPU state on its own memory). `restoreVm` builds
  the group and its machines again in the snapshot's order (each child as `CreateProcess` builds it, with its parent),
  then puts everything back as for one machine; the page follows the foreground process as after a `CreateProcess`.
  `tests/snapshot.test.js` restores `multiproc.exe` with its child in the middle of their handshake and runs both copies
  alike to the end. Until 2026-11-11 such a machine was never captured (`notQuiet`: "several processes"): Age of the
  Ring and BFME II 1.06, both started by their launcher, never got a snapshot — the warm jobs' publishing sessions ran
  their 1 200 s and ended "0 kept, 0 published" (the live runner's journal, 2026-11-10/11, every 6 h).
- **CPU states** are views on the guest memory (rebuilt by address); a PE image's file bytes, only read while it was
  mapped, are not kept.
- **Time** goes on from where it was: a virtual clock's state, a real clock's origin moved. Everything the guest can
  observe reads the guest's clock, never the host's: the time stamp counter (RDTSC: it read `performance.now()`, which
  made BFME2's copy compute other values from the same state), kernel32's Sleep(0) storms — the same on a real clock,
  continuous across a snapshot, deterministic on a virtual one.
- **The JIT** starts empty in the restored machine. `Vm.resetJit()` gives the original an empty one too, so both
  translate alike: the oracle then compares them at the JIT's speed.

## Results (stage 1, Node, virtual clock)

`node tools/check/snapshot-check.mjs <manifest> --games-dir /srv/orthros/data/games [--at <s> | --input <scenario> --at-mark
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
step over), at the next quiet point (`src/web/snapshot-watch.js`, the worker's `snapshotAutoStep`) — then again at each
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
   followed from `src/core/vm.js` and `src/web/worker.js` through their imports, but for the JIT's translator and
   the GPU backends, which a restore rebuilds anyway, and the game data's transport (`/api/snapshot-sources`,
   `src/server/snapshot-sources.js`: a deployed change to the JIT or the WebGL backend keeps snapshots, one to an API
   module or the machine does not; `tests/snapshot-lint.test.js` fails if a module left out registers snapshot state).
   **Rules for the data modules** (since 2026-10-28, `DATA_TRANSPORT`): how the game's bytes come and when —
   `src/vfs/game-data.js`, `http-backend.js`, `net-link.js`, `opfs-store.js`, `launch-set.js`, `playable-watch.js`
   (and what only they import, `pcm-codec.js`) — and when a snapshot is taken (`src/web/snapshot-watch.js`) are out:
   the mounts are host objects (`state: false`, `src/core/vm-snapshot.js`), a file is reopened by its path. Which files
   the guest sees and their sizes stay in through the version's tree itself; `src/vfs/game-tree.js` (`KEPT`) holds the
   tree's helpers, and since 2026-11-09 how the guest's stat/readdir/open are answered from the tree (`treeLookup`,
   `treeStat`, `treeReaddir`: case folding, directories listed before files, a directory's date 0 — `HttpBackend` and
   the Windows games' `PartsBackend` both answer through them), still pinned by `tests/snapshot-lint.test.js`. Which part
   serves a file (`game-data.js`'s `partOf`, `PartsBackend.open`: a version's own files, its game's shared base, a
   required version's) is out: the owner holds the same bytes. Where a file is kept (the tree's `owner` and `op` marks,
   the manifest's `owners`, `ownerLegacy`, `baseOwner`) is left out of the key (`src/web/snapshot-key.js`). Before: 48 of the 246 key changes of October were data-only commits (all 4 of 10-27's), each a cold
   start of 35-50 s to the menu for a returning BFME1 player instead of a ~0.6 s restore. A comment-only edit of
   `http-backend.js` or `game-data.js` now keeps the hash (`c707f1…` → `823bb2…` before, unchanged after); one of
   `game-tree.js` still changes it. Over October's commits, 272 → 226 change the key. Measured again 2026-10-28
   (`snapshotSourcesHash` on copies of the main tree and this one, a comment appended): main 106 modules, `cfc369…` →
   `25a966…` after `http-backend.js` + `game-data.js`; now 98 modules, `27706d…` → `27706d…` (kept), → `2918d5…` after
   `game-tree.js`. Not measured: a browser restore across a data-module edit (`tools/check/snapshot-browser-check.mjs`), and
   the live gain — no Win32 session in the telemetry since 10-23. — The game version's manifest and
   file tree (sizes, dates), the language and the options that change the machine (`?timescale`, `?interp`, `?dbg`...;
   `src/web/snapshot-key.js`). The debug flags that only measure the host's GL side are not among them
   (`HOST_ONLY_DBG` in `src/gfx/gpu-probe.js`: `ORTHROS_GL_COUNT`, `ORTHROS_GL_PROBES`, `ORTHROS_GL_TIME`; a flag joins
   the list only if it changes neither what the guest sees nor when): a `?bench` page adds `ORTHROS_GL_COUNT`, and until
   2026-10-27 that alone gave it a key of its own — the shared-snapshot jobs its 404s queued could never be published
   (the publishing session is a plain page: "this session's key is X, the server was asked for Y"), which is why no
   BFME1 1.08 or BFME II shared snapshot existed. The bench/plain key equality is covered by
   `tests/snapshot-key.test.js` only (a bench page and a plain page get the same key; no browser run checked a `?bench`
   page against a plain publisher). Separately, `tools/check/snapshot-shared-check.mjs bfme1-108 --lang fr --queue` on a
   private server (2026-10-27; plain pages only, which shared their key before as well) proves the BFME1 1.08
   publish/restore chain: published at 252 s of its session (310.6 MiB, 93 MB brotli), a second new player restored it
   in 623 ms — PASSED;
2. **its machine's start is this session's** (the worker, before anything changes: `snapshotStale`): the registry the
   process starts with (seeded from the manifest, the player's settings), and every path of the player's profile (as
   the manifest's `profileMoves` left it, docs/startup.md: moved before anything is recorded) the game had seen — its existence and size (`stat`), its listing (`readdir`), its bytes (`open`) — is as it saw it. The
   profile is never the snapshot's: it stays the player's, kept by the browser; saves made after the snapshot in a
   folder the game had not listed leave it valid, a changed setting or a new save where the game had listed its saves
   gives a usual start (and a new snapshot, the old one deleted). Since 2026-11-09 the profile is the game's, shared by
   its versions (docs/profiles.md) while snapshots stay per version: another version that wrote the profile since
   makes this version's snapshot stale the same way (a usual start, then a new one) — expected, never wrong. A player
   who played another version of the game has a profile, so gets no shared snapshot (stage 3) for this one.

A restore that fails midway (not refused beforehand) leaves a machine in pieces: the page deletes the snapshot and
starts again. `?snapshot=0`: none (a bench that measures a cold start passes it; `?benchsuite=...&snapshot=0` passes it on to
every game); headless runs: none unless `?snapshot=auto`. A headed `?bench` page restores like a returning player — its
own snapshot, else the server's shared one, under the players' key since 2026-10-27 — and its record says which
(`snapshot`: `own`, `shared`, `failed` or null). `window.orthros.snapshot()` takes one
now, `saveSnapshot()` keeps it as the automatic one.

`tools/with-browser-slot.sh node tools/check/snapshot-browser-check.mjs <manifest> --games-dir /srv/orthros/data/games`: a
session with automatic snapshots until it kept one, then the page opened again (`--manual --at <s>`: asked for at that
time).

| game | snapshot | taken in (graph, pages, encoding) | restored in |
|---|---|---|---|
| Vice City, menu | 28.5 MiB | 0.6 s (20, 580, 36 ms) — 3.2 s with the earlier JavaScript page scan | 67-90 ms |

### A key from the state's shape: measured, not done (2026-11-12, NO-GO)

The idea: key snapshots on the *shape* of the machine state (registered classes, their fields, `skip`/`init`, plus a
schema version bumped by hand when a change alters what state means) instead of the state-owning sources, so that a
deploy changing only behaviour keeps every player's snapshot. Gate: at least half of the deploys that change today's
key would have kept the shape key. `node tools/dev/snapshot-key-replay.mjs --reflog <since> | --range a..b` replays
history with today's closure definition and three candidate keys: comment-free sources, and a static shape (per file or
merged over the closure: the property names the code writes — `.x =`, `{ x: }` — and the registration calls' text).

| 2026-10-28 16:21 → 2026-11-12 20:46 | transitions | change today's key | of those, kept by: comment-free | shape per file | shape merged |
|---|---|---|---|---|---|
| updates of main served live (main's reflog; the live server hashes the files on disk, so each one is a deploy) | 71 | 15 | 0 | 1 | 2 (13 %) |
| commits (first parent) | 158 | 31 | 1 | 12 | 14 (45 %) |

The unit a player meets is the update of main (a merge brings several commits; one changed shape is enough): 2 of 15.
The 56 updates that already keep today's key (79 %) touched no closure module. Read by hand, the 15 updates: those
that truly changed the state or its meaning — new fields in user32's input state (key remap), `Process.patches`,
`vm.xformPending`, the Direct3D resource heap in guest memory (`res-mem.js`), `TextEngine`'s cmaps, the locale and
screen-size start conditions, process-group snapshots, `vm.images`/`libScope`, the MP3 kernels' process state — are 9
to 10; even a perfect judge would have kept 5 or 6 (37 %: the OpenMW and shared-base `game-tree.js` work, the src/host
reorganisation, the render-scale controller in the worker, `CpuState`'s NEST slots in unused bytes). Below the gate
whatever the key, and the part a static shape misses (a guest-memory layout like `res-mem.js`, a field whose meaning
changes) would rest on a hand-bumped version — the silent incoherence the "Nothing left out silently" rules exist to
prevent. The source key stays. What would help returning players more is a shorter gap after a key change (the warm
jobs republish the shared snapshot, but a player with a profile does not take it: stage 3).

## Shared by the server (stage 3)

A player with no profile of a game yet (a first launch in this browser) and no snapshot of its key asks the server
for its **shared snapshot** (`/api/snapshot/<manifest>?key=&lang=`, `src/server/snapshot-store.js`): the one a new
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

The page keeps a snapshot by writing it to OPFS in 16 MiB pieces, and the publishing session posts it once kept, from
the stored file (a disk-backed body). Until 2026-10-21 the whole buffer went to one OPFS write and, at the same time,
to the POST as a body of the bytes: copies of a few hundred MiB beside the 2 GB guest, and the publishing sessions of
the BFME games ended in "Target crashed" (RotWK 2.01 / 2.02 on the live server, 129 and 200 s, each after one
248 MB snapshot had reached the server). Measured on BFME1 1.08
fr (seeded first launch, 303.7 MiB snapshot, renderer RSS sampled every 2 s, one run each): before, the RSS climbed
from 2.0 to 4.39 GB after the keep and the page crashed at 127 s before the store finished; after, 2.47 GB at most,
kept at 73 s, published at 99 s (318 MB raw, 107 MB gzip, 94 MB brotli), and a new player's session restored it in
610 ms. `tools/snapshot-publish.mjs` prints the session's snapshot lines as they come (a session that ends badly has
said how far it got) and waits for a post in flight.

A sandboxed server (the production service: a dynamic user, no home, its own /tmp) does not start browsers: with
`--snapshot-queue` it only queues the request with its token (`<learn>/snapshots/queue.json`), and
`tools/snapshot-jobs.mjs --queue <file> --server <url>`, run outside the sandbox (the `orthros-snapshot-jobs` service),
runs the sessions through the browser slot guard. `node tools/check/snapshot-shared-check.mjs <manifest> [--queue]`: the whole
path on a private server — a first new player, the server's session, a second new player who must start from it.

## Warm jobs: snapshots and learned lists made ahead (`src/server/warm-jobs.js`)

Until now a shared snapshot was queued only by a new player's 404, so that player (the first one after every deploy that
changes the key) started cold; BFME1 1.08, BFME II and Age of the Ring had none. With `--warm-jobs` (together with
`--snapshot-queue` or `--snapshot-jobs`) the server looks, 20 s after it starts (`--warm-delay`) and every 10 minutes
(`--warm-every`), at every installed, visible Win32 version in **each language its players use** (below: "Languages")
and queues **one job at a time**:

- a **publish** job when the version's current key has no shared snapshot (or one made from another first-launch
  profile). The key is computed by the server as a page computes it (`plainKey`: the sources' hash, the version's
  `/api/manifest` and `/api/tree` as sent, the machine options of a page with no URL parameter) — the publishing session
  still refuses to post if its own key differs, so a wrong guess costs a failed job, not a wrong snapshot;
- a **learn** job when the snapshot exists but the server holds no learned prefetch list for the version (`prefetch-<m>.json`),
  or the version has learn scenarios not played on this server yet: the runner starts `tools/warm-learn.mjs`, which plays
  `tools/headless.mjs <m> --server-port <port>` against the server for each of the version's **learn scenarios**
  (`tools/scenarios/bench/index.json` `learn`: the loads a new player meets first, e.g. Age of the Ring's MY CAPTAINS and a
  skirmish start; each on a fresh browser, at most its `maxSeconds` (1 800 s), ended 20 s after its last step; those played already skipped), else for the shortest bench
  scenario that lists the version (at most 300 s), else boots it for 150 s — so the reads, heat and GL programs of those
  loads are learned. The scenarios played to their end (every wait met) are told to the server with the job's token
  (`POST /api/warm-learned/<m>`) and kept by name and content hash (`<learn>/snapshots/learned-scenarios.json`): an edited
  scenario is played again; one that did not reach its end (a screen never shown) is told too and given up after two
  tries (`LEARN_TRIES`), so a broken scenario does not take a browser every 6 h. Learn scenarios listed (2026-11-11):
  Age of the Ring MY CAPTAINS and a skirmish start (`learn-aotr-*.txt`, written and checked on 10.0), RotWK 2.02
  MY HEROES (`learn-rotwk-heroes.txt`, the docs/slow-network.md clicks, not run as a learn job), and the bench suite's
  skirmish starts of RotWK, BFME II and BFME (their `*-short.txt` / `bfme1-skirmish.txt`, 800x600 coordinates scaled by
  `--coords`; not run as learn jobs). BFME II's Create-a-Hero is not listed (its menu coordinates not known). (A publish session teaches the boot's lists as well, so a version without snapshot gets its
  learn job after the publish.)

The next job is queued when the previous one reached its goal or after two hours (a failed key is not tried again for 6 h:
the queue's usual dedup). While a job runs the server looks every minute (`--warm-poll`, 60 s) instead of every 10: the
next job starts as soon as the previous one is done (until 2026-11-12 every job took at least one 10-minute look: a
6-minute publish left the browser idle 4 minutes). `--warm-only a,b` restricts the versions (tests, a first deploy done
step by step).

### Languages (2026-11-12)

Until 2026-11-12 the jobs made only the default language (`en`), while the players of BFME 1.08 (all 5 of its playable
marks) and some of Age of the Ring and RotWK 2.01 play in French: each deploy changed the key, and the first French player
after it started cold, the French snapshot made only after their 404 (aotr-10 `fr`: 20 min of job each time; RotWK's
French snapshots dated from 2026-10-18). Now each version's languages are `warmLanguages(manifest, use, prefer)`
(src/server/warm-jobs.js), of those the version declares:

1. those of `--warm-langs <l,...>` in that order (the operator's: `--warm-langs fr` for this server's French audience);
2. those its players used, most used first — the server counts each language's playable marks (`playable-<m>.json`
   `by`) and first-launch profile reports (`profileseed-<m>.json` sessions);
3. its default language (what a plain page, the harness and tests start in).

A language nobody uses and nobody asked for is not made. The plan ranks the jobs: **every version's first language**
(its snapshot, else its learn job) **before any version's second language** (its snapshot only), so after a deploy the
players' own language comes first everywhere. The **learn job plays in the version's first language**
(`warm-learn.mjs --lang`, `headless.mjs --game-lang`): the reads, GL programs and launch set (`launch.langs`) learned are
the players'. Another language still gets its snapshot on a player's 404.

**The wave per deploy** (every source change changes every key). Live runner, 2026-11-12, `en` only, 8 versions (one
publish each, the 10-minute looks): 20:48 → 22:04, **76 min** (aotr-10 9.5 min, bfme-vanilla 6, bfme1-108 5.6, bfme2-106
9.9, bfme2 8.6, rotwk-201 7.5, rotwk-202 7.6, vice-city 6.6: 61 min of sessions, the rest waiting for the next look; the
two other waves of that day 76 and 77 min). With the one-minute poll a wave is its sessions plus ≤ 1 min each: the same 8
in ~70 min. With the live usage (no `--warm-langs`) French is added for bfme1-108 (first), aotr-10 and rotwk-201
(second): 11 sessions, ~95 min, BFME 1.08's French snapshot ~15 min after the deploy (third in catalog order). With
`--warm-langs fr`: 16 sessions (French for all 8 first, ~70 min, then English), ~140 min. Learn jobs come on top only when a version's
lists or learn scenarios are new (once, not per deploy). One browser at a time through
the slot guard, as before; a deploy every few hours keeps at most one wave running (a wave's next job is queued only when
the previous one is done).

### BFME 1.08's learn scenario (2026-11-12)

`bfme1-108-skirmish-learn` failed twice on the live runner (2026-11-11 and 12: "1/3 waits met", 4 frames/s at its
1 500 s limit, given up). Reproduced on a private server (fresh browser, `bfme1-108-short.txt`, the job's arguments): the
1.08 menu is drawn at 1-4 frames/s by the software GPU (render 74.5 ms per frame, present interval 118 ms) and its
screens slide in over a fixed number of frames; the harness's steps, late while the page is busy, ran the exit box's NO
and the Solo click in the same second, then Skirmish 11 s later while the Solo screen was still coming: the session
stayed on the Solo screen (CAMPAIGN / SKIRMISH / LOAD / BACK) until its limit. bfme1-108-short's 10 s gaps are written
for a machine like the owner's (30 frames/s) and stay as they are (the bench suite's). The learn entry now plays
`learn-bfme1-108-skirmish.txt`: the same steps spaced as the original release's learn scenario (25 s between menu clicks,
which passed on the runner), the Start click sent twice (the second lands on the loading screen).

**Measured 2026-11-12** (private server on a copy of the live learn directory without its snapshots, `--games-dir
/srv/orthros/data/games`, the browser slots' 4-core cap, load 20-50 from the other sessions; one browser at a time):
- *Learn scenario*: `bfme1-108-short.txt` in English (the old entry, the job's arguments): Solo screen still shown at the
  300 s limit, as on the runner. `learn-bfme1-108-skirmish.txt` in French: menu at 42 s, setup screen at 145 s (234
  draws per frame), play at 212 s (464), ended at 253 s: **3/3 waits met** (the old one: 1/3 after 1 500 s).
- *Publish in French*: `--warm-jobs --warm-only bfme1-108` queued `publish of bfme1-108 (fr)` first (its marks are French);
  the session ran as a French new player, published at 117 s (298.3 MiB, 93 MB brotli), "done: 1 kept, 1 published" at
  327 s — the English one's sessions on the runner: 122 s, 328-333 s.
- *A new French player* (fresh browser profile, `?gameLang=fr`, `warm-menu-bfme.txt`):

  | BFME 1.08, French | first Direct3D frame | main menu (anchor) |
  |---|---|---|
  | no French shared snapshot (2 runs) | 18 s, 19 s | 42 s, 35 s |
  | the French shared snapshot made by the warm job (2 runs) | 4 s, 4 s | 20 s, 20 s |

  `snapshot-browser-check.mjs --once --expect-restored --query gameLang=fr`: "shared snapshot of this game: 88.7 MB to
  download", **restored from a snapshot of 298.3 MiB in 713 ms**. (Local server: the download at the owner's link — 88.7
  MB at 0.085-3.9 MB/s — is not measured here; docs/slow-network.md.)
- *Age of the Ring in French*, `--warm-langs fr` (its marks are mostly English: the operator's order put French first):
  `publish of aotr-10 (fr)` queued first; published at 358 s (440.7 MiB), "done: 3 kept, 2 published" at 744 s. A fresh
  French player: 51.8 MB to download, **restored from a snapshot of 461.1 MiB in 1 103 ms**. Its time to the menu before /
  after was not measured (startup.md: ~100 s without a snapshot).
- *A bug found on the way*: that session's second post answered HTTP 500 — the first was still being compressed and both
  wrote the same temporary files (the live runner: 3 such 500s in 5 days; the record removed first, a key could be left
  with none, not queued again for 6 h). `SnapshotStore.put` now runs the puts of one key one after the other.

**Deployment** (the lead): add `--warm-jobs` to `orthros.service`'s `ExecStart` (`... --snapshot-queue --warm-jobs`) and
restart `orthros.service` then `orthros-snapshot-jobs.service` (the runner must be the new code: it now also runs `learn`
jobs, through the slot guard like the publish ones). Nothing else: the queue file is the same. To turn it off, remove the flag.

Measured 2026-11-09 (private servers, `--warm-jobs --warm-only`, fresh browser profile, `tools/scenarios/warm-menu-*.txt`; one run
each; "menu" = the scenario's waitframe anchor, which cannot come before the first Direct3D frame + 14 s for BFME, + 13 s for VC):

| game | no snapshot, empty learn dir | shared snapshot made by the warm job + its lists |
|---|---|---|
| BFME 1.08 | first frame 97 s, menu 137 s (load average 72 at that moment) | first frame 3 s, menu 20 s (at the floor; load ~22) |
| Vice City 1.1 | first frame 10 s, menu 23 s | first frame 1 s, menu 13 s (at the floor) |

The publish jobs found the page's key (the session refused nothing: "running, key ..."); BFME 1.08 published at 186 s
(302 MiB), Vice City at ~6 min of session. The publish session also left `prefetch-`, `heat-`, `programs2-` and `regions-` files, so the
learn job only matters for a version whose snapshot exists but whose lists do not: tested on BFME 1.08 (snapshot copied
into an empty learn directory: the server queued `learn`, the runner's headless run created the four files). Not
measured: lists without snapshot (the slots were busy), repeated runs. The baseline's load differs from the warm runs'.

**Age of the Ring, 2026-11-11** (a launcher and its game: "Several processes" above; private servers on copies, the
browser slots' default 4-core cap for the jobs, one run each):
- *Publish*: the live runner's sessions of `aotr-10` (and `bfme2-106`) had ended "time is up: 0 kept, 0 published" after
  1 203 s, every 6 h since 2026-11-10 — no capture was ever tried (the group). With the group captured: first snapshot
  at 177 s (384.7 MiB, taken in 2.7 s), kept at 207 s, published at 242 s; a later one replaced it (405.5 MiB, 55 MB
  brotli); "done: 2 kept, 2 published" at 624 s. A new player (fresh browser, `snapshot-browser-check.mjs --once
  --expect-restored`) downloaded 52.4 MB and restored it in 1.9 s, at the main menu (SOLO PLAY … MY CAPTAINS).
- *Learn* (the snapshot copied into an empty learn directory, `--warm-jobs`): the server queued `learn`; `aotr-captains`
  reached the menu at 193 s and the Create-a-Hero screen at 397 s (played: recorded); `aotr-skirmish` reached the
  skirmish's loading screen at 261 s and was still on it at its 900 s limit (4 of 5 waits: not recorded; cause not
  found — its limit is 1 500 s since). The first-launch profile those sessions taught then made the snapshot stale
  ("made from another first-launch profile"): the server published again (367 MiB, published at 177 s, "3 kept, 3
  published" in 745 s), then queued `learn` once more, which played only `aotr-skirmish` ("1 played already"): menu
  at 133 s, loading screen 193-216 s, play at 216 s, recorded, 277 s in all.
- *MY CAPTAINS first visit at the owner's link* (`--net 50:10`, fresh browser, no snapshot, `learn-aotr-captains.txt`,
  the click 4 s after the menu; browser cap raised to 8 cores for both runs):

  | learn directory | first frame | menu | click → Create-a-Hero screen | game reads in that load |
  |---|---|---|---|---|
  | empty | 531 s | 555 s | 259 s | 1 819 requests, 96.8 MB |
  | made by the learn job (its two sessions) | 449 s | 473 s | 264 s | 1 787 requests, 95.7 MB |

  The learned lists brought the menu 82 s earlier, but not the first visit of MY CAPTAINS: the load still waited for
  nearly every read (the learned read-ahead fetched 36 MB in the background during it, as many reads went to the
  network as without lists). With the click a few seconds after the menu nothing could be fetched before the load;
  why the read-ahead does not follow this load on a 1.25 MB/s link is not found yet (docs/slow-network.md "A load of
  loose files"). Not measured: a player who stays in the menu before the click, repeated runs.
