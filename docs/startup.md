# Start-up and first use

What Orthros does so that a game reaches its menu sooner and does not stall the first time it uses something. All
of it is generic (nothing names a game) and each part can be switched off.

## Shared first-launch profile (`src/host/profile-seed.js`)

Some games do a long piece of work on their very first launch only — while no settings file exists in the user
profile they measure the machine, build caches, choose detail levels — and skip it at every later launch (BFME2 and
RotWK: ~70 s of computation before the first frame under Orthros). A player's browser starts with an empty emulated
profile (`C:\Users\Player`), so every new player paid it.

- **Learning.** A session whose profile was empty at start watches it. At the first click that finds files in the
  profile (the game reached a screen the player acts on, its first-launch work written), or at the first character
  typed (whatever is there then), it takes a snapshot of the profile's small files: not under `Temp`, ≤ 64 KiB each,
  ≤ 128 KiB and 32 files in all (saves, previews and caches stay out). The snapshot is taken as the input arrives,
  before the game sees it: nothing the player types is in it. Once the session has gone on (600 more frames over at
  least a minute: not a launch that failed), it is posted to `POST /api/profile-seed/<manifest>` with the game
  language and the session id.
- **Consensus.** The server keeps, per manifest and game language, the distinct sets reported (identified by
  content) with the sessions that reported each. A set is offered only once `--profile-seed-quorum` distinct reporters
  (default 2) reported it identical — the most reported one wins. A reporter is a client address (behind the reverse
  proxy the first `X-Forwarded-For` hop, kept hashed): one client cannot make up the quorum with invented session
  ids; on a loopback connection without a proxy header (harness, local server) it is the session id. Identical files from independent sessions are the
  game's defaults, not one player's data. Bounded: 16 sets per manifest (least recently reported out), 32 session
  ids per set. Stored in `<learn dir>/profileseed-<manifest>.json`; a server without this feature ignores the file,
  and the page asks for it only when `/api/config` says `profileSeed: true` (old pages and servers keep working).
- **Canonical sets** (`tools/profile-seed-make.mjs`, `<learn dir>/seedcanon-<manifest>.json`). What a first-launch
  benchmark writes depends on the emulated machine's speed (the load of the machine running it, the instrumentation:
  two runs wrote `AudioLOD = High` and `Low`), so independent players rarely report identical sets and the quorum
  rarely forms (live data, 2026-10-21: one reporter per set after weeks, nothing served). An operator therefore makes,
  per version and game language, one set the server offers first, with no reporter and whatever sessions report since
  (a report only adds a candidate to the learned sets). The tool iterates the catalog (no game named): `plan` lists every
  Win32 version × declared language and what the learn directory holds; `make` runs `--runs` first launches with an
  empty profile through the browser slot guard (`headless.mjs --profile-seed 0 --profile-dir`), compares their seed
  files and writes them when they agree (`--accept first`: the first run's); `put` takes a profile directory (a run's,
  possibly edited by hand: the settings it carries become every new player's default), `promote` a learned set,
  `show` / `remove`. The server reads the file again when it changes (no restart). The snapshot key's seed part is
  the served set's key: shared snapshots made with another seed are made again.
- **Use.** A session whose profile is empty (first launch in this browser) asks
  `GET /api/profile-seed/<manifest>?lang=<game language>` (3 s at most) and writes the files before the game starts;
  they are then saved to OPFS like the game's own. It does not learn (only unseeded first launches teach).
- **Off:** manifest compat flag `"profileSeed": false` (nothing offered nor learned for that game), `?profileseed=0`
  (page), `--profile-seed 0` (harness).

The files are the game's own output under Orthros (e.g. its options file with the detail level its first-launch
benchmark chose on the emulated machine); a player can change them in the game's options as usual.

## Translated code kept across sessions (`src/cpu/jit/code-cache.js`)

The regions earlier sessions translated (the server's learned list, D056) are translated again at every launch by
the background translator (D058): ~27 000 regions, ~10 s of a core at each BFME2 start (~1.2 s of it compiling).
The background translator now keeps its translations in an OPFS file per game (`orthros-jitcache/<manifest>.bin`)
and reuses them at later launches:

- An entry is one region's WebAssembly body with what it was a function of. Before reuse the background worker runs
  the discovery pass on the code in memory now and requires the same entry and x87 mode asked, the same extent
  (blocks), the same code bytes there (compared byte for byte) and the same import slots holding the same fast-API
  thunks for the calls it runs inline. Its table index is the only other input: the body's one reference to it (the
  load of its next x87-mode version's slot, always a 5-byte LEB) is rewritten (`patchAltSlot`). The emulator's
  install then checks the bytes against memory as for any background translation.
- Code heat (`docs/jit-code-shape.md`: regions cut at cold exits, visit flags) is a translation input that varies by
  session and grows during one. It reaches a translation through two things only: the extent discovery finds (the
  cold edges cut — compared like any extent) and the blocks given a visit flag (those the heat does not know to have
  run). An entry is reused when it flags every block of it the heat of now does not know (`missHeat` otherwise);
  a block it flags that the heat learned since has its flag store sent to a byte never harvested (a "sink"), so
  the session reports the same blocks as a fresh translation would. (Until 2026-10-04 every heat answer the
  translation got was recorded and compared — branch sources included, which only matter through the extent: most
  "other heat" misses were entries that served.) Its visit flags are moved to the session's own flag bytes
  (`patchVisitSlots`, like the table index); a translation made when the flag area ran out is not kept. Batches
  translated under in-session options (`Jit.switchOpts`) are neither looked up nor kept. The learned entries skipped
  as blocks of an earlier region are those of the regions as cut by the heat of now: an entry a cut region no longer
  holds is translated on its own (a server that forgot it as covered relearns it at its next miss).
- One shape per code: the learned heat only grows, so an entry whose code is in memory now (its own extent compared
  byte for byte) but whose shape the heat of now no longer gives (another extent, or a block it leaves unflagged that
  the heat does not know) would not serve again — the translation added for that region supersedes it (its record
  marked unused in place). Other code at the same address (another program loaded there) keeps up to 4 variants.
- Shapes brought up to the heat of the session's end (`bg-translate.js` refresh). The heat grows during a session
  (visit flags harvested every 10 s): a region translated at the session's start would get another extent at the
  next launch, under the heat this session taught, and be translated again while that launch starts. Once the heat
  grew and no batch came for a second (the learned regions in place), the background worker discovers again the
  regions it answered in the session — only those whose blocks or branch successors gained heat since — and keeps a
  translation of those whose shape changed (not installed; it supersedes the earlier shape): the next launch finds
  the shape its heat gives. Passes in 10 ms slices with as long a pause after each (half a core at most; batches
  answered between them), again each time the heat grew, 20 s apart at the soonest; their translations' visit flags
  point at the sink byte (relocated at reuse).
- Measured with heat (2026-10-04, `integ-1004`, phase scenarios, one persistent browser profile and learn directory
  per game reused across runs): RotWK 2.02 run 1 (no heat yet) 12 991 entries added; run 2 (heat of run 1: 24 887
  ranges) 2 665 reused, 5 830 other extent, 3 609 other heat, the cache full and stale, emptied and refilled; run 3
  (heat 27 122 ranges) 8 122 reused, 312 other extent, 240 other heat (the rest new entries). BFME2 run 2 (heat
  24 887 ranges): 1 714 reused, 5 299 other extent, 2 413 other heat, emptied as well — a first BFME2 session alone
  writes 198 MiB of the 256 MiB, so the second one fills it (review re-run: 1 713 reused, 5 272 other extent, 2 404
  other heat, same rendering in play). While the learned heat still grows the cache mostly missed; it served again
  once the heat settled. See "Translated code cache over a game's first sessions" below for the build that followed (B there).
- The cache key is a hash of the translator's own sources — the import closure of `bg-translate.js`, `jit.js` and
  `runtime.js`, fetched by the worker like the modules themselves — plus the translation options and the defaults they complete (`JIT_DEFAULTS`: layout, cold exits, region sizes...): any change to the
  translator or its options empties the cache. Instrumented translations (profiling, block counters) are not kept.
- Records appended (~7 KiB per region, 70 % of it WebAssembly: 30 000 BFME2 regions take ~205 MiB), a cut tail
  dropped at load; each record starts with a binary index (entry, x87 mode, extent, inline-API slots) — the only part
  read at load; its meta JSON is parsed at a hit — and holds the number of the last session that added or reused
  it. 256 MiB per game: an addition past it (up to 9/8 of it) asks for room at the next idle moment of the background
  worker (3 s without a batch: the learned regions in place), so that no batch waits for it; past 9/8 the room is made
  at once. Making room: the entries of earlier sessions no session used for longest are evicted down to 3/4 of the
  bound (never this session's: a session whose own entries fill the file stops adding), then the file is compacted in
  place (the live records moved over the unused ones, in file order; the header says a compaction is under way until
  it is done — one cut short, the tab closed, starts the cache over at the next load). A game update (other code at
  the same addresses) is handled the same way: its old entries stop being used and are evicted first. Only the index
  stays in memory, a record is read back on a hit; one tab at a time (the OPFS file is opened for exclusive
  synchronous access: another tab runs without it).
- **Off:** `?codecache=0`; harness runs use it only with a persistent browser profile (`--opfs`), `--code-cache 0`.

### Translated code cache over a game's first sessions (measured 2026-10-04)

A = `main` at 5d528a8 (heat answers per entry, emptied when full and stale), B = the build above (one shape per
code, refresh under the grown heat, LRU eviction and compaction, binary index). Per game, consecutive sessions
sharing one learn directory (a copy of the live one) and one browser profile (`--opfs`, the first-launch profile
copied), A and B series side by side on the shared server, started in alternated order (run 1: A first, 4 sessions;
run 2: B first, 6 sessions); startup scenarios (`bfme2-startup.txt`, `rotwk-startup.txt`, 200 s;
`vicecity-drive.txt`, 110 s) with a mark at 60 s. "Reused" = cache hits / lookups of the learned regions translated
at startup; "bg" = the background worker's time until the learned regions are installed (of which translating);
"installed" = when the learned code is all installed (s from the page start); "index" = the cache's index read at
load; "> 100 ms" = frames over 100 ms in the first minute. Two values: run 1, run 2.

| game, session | reused A | reused B | bg A (translating) | bg B (translating) | installed A | installed B | index A | index B | > 100 ms A | > 100 ms B |
|---|---|---|---|---|---|---|---|---|---|---|
| BFME2 2 | 7 %, 7 % | 91 %, 91 % | 11.8 (6.6), 12.4 (6.9) | 7.3 (1.2), 6.7 (1.2) | 14.9, 15.6 | 10.7, 9.9 | 754, 769 ms | 227, 243 ms | 109, 101 | 103, 91 |
| BFME2 3 | 58 %, 57 % | 97 %, 97 % | 8.0 (3.0), 8.9 (3.3) | 5.5 (0.4), 6.2 (0.5) | 10.8, 11.7 | 8.8, 9.2 | 351, 370 | 246, 254 | 92, 99 | 99, 100 |
| BFME2 4 | 97 %, 97 % | 98 %, 98 % | 5.7 (0.5), 6.0 (0.6) | 6.2 (0.3), 7.7 (0.4) | 9.3, 9.3 | 9.5, 11.2 | 636, 655 | 264, 298 | 97, 99 | 100, 89 |
| RotWK 2 | 13 %, 13 % | 82 %, 82 % | 10.9 (5.9), 9.7 (5.2) | 5.5 (1.4), 5.9 (1.5) | 14.9, 13.6 | 9.3, 9.9 | 701, 605 | 158, 165 | 67, 65 | 74, 70 |
| RotWK 3 | 25 %, 23 % | 95 %, 95 % | 8.7 (4.5), 9.9 (5.0) | 4.7 (0.5), 5.5 (0.6) | 11.8, 13.1 | 8.4, 9.3 | 148, 142 | 225, 236 | 71, 67 | 69, 77 |
| RotWK 4 | 91 %, 90 % | 98 %, 98 % | 5.6 (1.1), 6.1 (1.3) | 6.1 (0.4), 6.0 (0.4) | 9.6, 9.9 | 10.0, 9.7 | 549, 556 | 262, 294 | 69, 75 | 71, 67 |
| Vice City 2 | 18 %, 18 % | 73 %, 71 % | 4.2 (2.4), 4.2 (2.4) | 2.8 (1.1), 3.0 (1.2) | 11.0, 10.9 | 10.9, 11.0 | 194, 186 | 83, 76 | 25, 22 | 22, 23 |
| Vice City 3 | 79 %, 74 % | 91 %, 95 % | 2.8 (1.0), 2.7 (1.0) | 2.8 (0.7), 2.2 (0.4) | 10.9, 10.8 | 11.0, 11.0 | 394, 412 | 143, 127 | 21, 19 | 20, 24 |
| Vice City 4 | 81 %, 86 % | 96 %, 96 % | 2.8 (1.0), 2.6 (0.8) | 2.2 (0.3), 2.2 (0.3) | 11.0, 10.9 | 11.0, 11.0 | 454, 425 | 133, 128 | 20, 22 | 22, 19 |

- The first session (no cache yet) is alike: BFME2 26 400-26 600 regions added (189-198 MiB), installed at 18.6-24.6 s
  in both builds (load-dependent); B's refresh passes then discover again the touched regions and keep the shapes the
  grown heat gives (BFME2 21 000-22 000 shapes, 18-20 s of the background worker over the 200 s, at most half a core;
  RotWK ~16 000, 12-13 s; Vice City ~4 000, 4.4 s), frames > 100 ms in the first minute 76, 65 (A) / 83, 62 (B) for
  BFME2, 63, 61 / 63, 57 for RotWK, 31, 40 / 30, 37 for Vice City.
- The second session reuses 71-91 % instead of 7-18 %: the background worker's translating time is divided by 4-6
  (BFME2 6.6-6.9 → 1.2 s, RotWK 5.2-5.9 → 1.4-1.5 s) and the learned code is installed 4-5 s earlier for BFME2 and
  RotWK (14.9-15.6 → 9.9-10.7 s, 13.6-14.9 → 9.3-9.9 s); A reaches B's level only at its fourth session. Vice City's
  learned code is installed at ~11 s in both (its install waits for other startup work, not for the translations).
- Index read at load 2.5-5 times faster (binary index; meta JSON at a hit): 130-300 ms instead of 350-770 ms for
  200-250 MiB files.
- Frames over 100 ms in the first minute: no difference beyond the runs' spread (the startup stalls are elsewhere).
- Size: A's second session empties the file (full and stale: BFME2 85 MiB and RotWK 13-17 MiB left after it); B never
  empties it. At the bound (BFME2 run 2 session 4, RotWK run 2 session 6) 3 369 and 1 249 entries of earlier sessions
  were evicted and the file compacted at an idle moment of the background worker (950 ms and 1 010 ms there, at most
  ~1 s per compaction in all runs), back to ~195 MiB; the next sessions still reused 99-100 % (BFME2 sessions 5, 6:
  25 417 / 25 608 and 25 548 / 25 668). Vice City's run 2 compacted at session 4 without evicting (superseded shapes
  only: 238 → 131 MiB, 679 ms), 96-98 % reused after.
- Rendering: the same screenshots in play (pause menu over the skirmish map) for A and B sessions 3.

## What a phase will use, prepared ahead (learned lists, D056/D058)

The server learns per manifest, in the order sessions first needed them (time since the page started, the earliest
over sessions — so menu, then map load, then play), the game file blocks read (`/api/prefetch`), the GL programs
built at a draw (`/api/programs`) and the entries of the regions translated at a miss (`/api/regions`). A new session
downloads the blocks in the background while the network is idle (the game's own reads first), compiles the programs
a few per frame without waiting for them, and has the background worker translate the regions on another core: what
a later phase needs is ready when that phase comes, without taking the game's thread. A game's dependencies (a game
mounted beside it, e.g. an expansion's base game) have lists of their own, learned from the reads of every game
mounting them.

- **Learned entries that are blocks of an earlier learned region** (`bg-translate.js`, `Jit.bgInstallNow`). The JIT
  enters a region at any of its blocks (block hash), so a learned entry that is a block of a region installed before
  it was always dropped at install — after being translated (and, with the cache, stored). Sessions that reach code
  at different points learn such entries in numbers: 45 % of RotWK's and 42 % of Vice City's learned lists. The
  background worker now skips an entry that is a block of a region it translated before in the session (no
  translation, nothing cached); an entry whose covering region the emulator did not install (its code changed, or it
  was translated on the game thread first) is asked again once; and the worker reports the skipped entries to the
  server, which forgets them (`covered` in the POST; older servers ignore it, the file format is unchanged): their
  room in the 40 000 entries served goes to regions of later phases.

## Measurements (2026-10-02, headless Chromium, `--gl-discard`, shared 48-core server under load)

Scenarios `tools/scenarios/{bfme2,rotwk,bfme}-first.txt` (the settings a first launch writes), one private server for
all runs (`--server-port`), A/B runs alternated or run side by side. "Menu" = the harness's `mark menu` (the menu
frames detected, intro videos skipped by Escape), seconds from the page start.

**Shared first-launch profile** (first launch, empty profile; `--memprefetch`; A `--profile-seed 0`, B seeded):

| game | first frame A → B | menu A | menu B | map load A / B | frames > 100 ms, first minute of play A / B |
|---|---|---|---|---|---|
| BFME2 | 103-105 → 32-34 s | 129, ~121 (1) | 59, 57 | 17 / 15, 14 s | 0 / 0, 0 |
| RotWK 2.02 | 114-133 → 34-36 s | 139, 157 | 59, 61 | (2) / 16, 14 s | (2) / 2, 2 |
| BFME1 | 111-118 → 33-35 s | 142, 135 | 60, 58 | 23, 32 / 22, 19 s | 0, 0 / 0, 0 |

(1) that run's first-launch benchmark chose 1024x768 3D settings (load-dependent), menu taken from its draws.
(2) the unseeded RotWK runs chose other settings than the scenario's clicks expect; their menu time stands.
Vice City: menu at 23 s on a first launch, nothing written to the profile before the first input: nothing shared.
The learned files: BFME2/RotWK/BFME1 `Options.ini` (detail level and resolution the benchmark chose, `TimesInGame =
1`), identical across sessions under the same conditions; a set chosen under another load (RotWK at 1024x768
"Medium") stayed below the quorum — the consensus rule at work.

**Translated code cache** (later launch: copies of one persistent browser profile per game made by a first session
of the same build, `--opfs`, the learned lists of the template's start; scenarios `*-startup.txt`; A `--code-cache 0`,
B the cache; runs of two games side by side, order alternated; 2026-10-03, build `aa2ebcc`):

| game | background worker A → B | translating A → B | learned code installed by A → B | menu A / B | map load A / B | frames > 100 ms, first minute A / B |
|---|---|---|---|---|---|---|
| BFME2 | 10.8, 11.1 → 4.5, 4.7 s | 7.1, 7.3 → 0.11, 0.11 s | t = 12.3, 12.6 → 7.3, 8.0 s | 48, 48 / 46, 48 s | 20.5, 19.5 / 17.1, 23.5 s | 5, 1 / 3, 0 |
| RotWK 2.02 | 10.6, 9.8 → 4.1, 4.5 s | 6.9, 6.3 → 0.13, 0.16 s | t = 14.5, 13.5 → 9.6, 9.9 s | 54, 52 / 50, 51 s | 13.2, 16.3 / 13.2, 19.3 s | 2, 3 / 0, 1 |
| BFME1 | 11.9, 12.8 → 5.2, 5.0 s | 7.9, 8.3 → 0.11, 0.12 s | t = 13.5, 14.5 → 8.9, 8.6 s | 49, 50 / 51, 49 s | 65.3, 64.1 / 65.3, 63.5 s | 0, 0 / 0, 0 |
| Vice City | 3.6, 3.1 → 1.3, 1.5 s | 2.4, 2.1 → 0.04, 0.05 s | t = 11.1, 11.0 → 10.9, 11.0 s | 20, 20 / 20, 20 s | 10.1, 10.1 / 10.1, 10.1 s | 3, 4 / 3, 4 |

99-99.6 % of the lookups hit (the rest: regions new to the session). Cache files 88-201 MiB, index read in 0.15-0.6 s
before the first batch. The saving is the background worker's time, ~6-8 s of a core at each launch of the BFME games
(~2 s for Vice City); the learned code is in place ~5 s earlier. Time to the menu, map load and the first minute's
hitches do not move beyond the run-to-run spread on this 48-core machine: the background translation has a core of its
own and finished long before the menu (map load and hitches are the game's own work: guest code, GL program builds
under SwiftShader). It matters on a client with few cores, where that core is shared with the game, the GPU process
and the DXT helpers. (An earlier measurement, before the skipped blocks above: BFME2 14.1-14.5 → 6.2 s, RotWK
15.0-17.8 → 8.9-9.7 s of the background worker; RotWK's cache then reached the 256 MiB bound with entries never
installed.)

**Skipped blocks of learned regions** (first launch in a fresh browser, `--memprefetch`, learned lists of a warm
server; A the build before, B skipping; alternated):

| game | background worker A → B | translating A → B | entries translated then dropped A → B | learned code installed by A → B |
|---|---|---|---|---|
| RotWK 2.02 | 20.6, 18.8 → 10.6, 10.8 s | 13.5, 12.4 → 6.8, 7.0 s | 19 395, 19 416 → 389, 360 | t = 24.9, 23.3 → 16.4, 16.9 s |
| Vice City | 5.2, 5.8 → 3.2, 3.2 s | 3.6, 4.0 → 2.2, 2.2 s | 4 214, 4 227 → 347, 351 | t = 11.1, 11.3 → 11.0, 11.0 s |

Nearly the same regions are installed (23 459 / 23 337; the build measured did not yet ask again the entries whose
covering region was not installed — with that, 23 358). After one RotWK session the server's list went from 39 630 to 28 650 entries (16 000 forgotten,
new ones of the session learned).

**Learned lists at a first launch in a fresh browser** (no block store, no code cache: `--memprefetch`; A the lists
of a server that had not seen these phases — no Vice City lists at all, RotWK's lists without its map loads and an
80-block list for the BFME2 1.06 it mounts — B the lists after one session went through them; build `aa2ebcc`, RotWK
B also `4bedb51`):

| game | first frame A / B | menu A / B | map load A / B | frames > 100 ms, first minute A / B |
|---|---|---|---|---|
| Vice City | 11, 11 / 11, 11 s | 23, 23 / 20, 20 s | 13.1, 13.1 / 10.1, 10.1 s | 6, 5 / 3, 5 |
| RotWK 2.02 | 28, 29 / 34, 33 s | 53, 54 / 59, 58 s | 33.1, 32.3 / 13.2, 13.2 s | 6, 2 / 2, 2 |

Vice City: its file reads at start-up and map load come from the prefetched blocks (8 MiB read on demand instead of
61 MiB, ioWait at start-up 6.6 → 2.7 s) and 33 of its 43 GL programs are compiled ahead. RotWK: the map load waited
~9 s for reads of the BFME2 1.06 archives it mounts (250 reads at ~50 ms each, one after the other: no learned order
for them); with that list learned they are prefetched. With the fuller lists RotWK's first frame and menu come 4-5 s
later (its background worker translates 23 000 regions instead of 12 000, 42 programs are compiled ahead instead of
19, 137 MB are prefetched instead of 96 MB; `late` 2.8-3.1 → 5.1-5.5 s in that phase). Each list turned off in turn,
with B's lists (menu / map load, two runs each): all 58, 60 / 13.2, 16.0 s; `--regions 0` 57, 55 / 19.8, 17.9 s;
`--prefetch 0` 58, 58 / 26.4, 27.2 s; `--programs 0` 57, 57 / 14.2, 13.2 s — the regions translated ahead cost the
start-up 1-5 s on this loaded machine (within the spread) and save 4-6 s of the map load; the prefetch saves 11-14 s
of it.

**Shared first-launch profile, final build** (`aa2ebcc`; RotWK, first launch, empty profile, the server's seed file
of the earlier measurement — old format, session ids — read as is): first frame 107 → 32 s, menu 132 → 57 s.

**Observations left open.** A game read of data not prefetched takes ~55 ms in these runs (p50 over 259 RotWK map-load
reads, the server separate from the harness: `--server-port`), while the server answers such a range in 3-12 ms
(curl): the rest is on the client side (headless Chromium on a loaded machine; not measured further) — learned lists
make these reads rare. Two failures seen once each and not reproduced in later runs of the same journeys (with or
without these changes): Vice City stopped presenting frames 1 s into a first session with a persistent profile (its
threads polling, ~900 API calls/s, no guest instruction retired), and BFME1 ended with exit code 666 after a menu
click in a first session with a persistent profile (an access violation calling address 0 at `lotrbfme.exe+0x1885e0`,
then the game's own error dialog); in that run the code cache only added entries (nothing reused).

## Game file reads on the network: short slices, block store index log (2026-10-06)

**Short slices while a read is in flight** (`src/host/web/worker.js` pump, `Vm.runFor`). A ReadFile of data still on
the network parks its thread while the others run; the fetch then needs several event-loop tasks of the worker (the
response, its body, the promise chain), and each waited behind a 12 ms pump slice of the other threads. While
`vm.readsInFlight > 0` the pump now asks for 2 ms slices, and `runFor` ends a slice once a read went in flight during
it and 2 ms have passed (`vm.readSliceMs`; `?dbg=ORTHROS_READ_SLICE_MS=12` restores the earlier behaviour, also
switchable within a session). This was the "~55 ms per read on the client side" left open above.

**Block store index log** (`src/vfs/opfs-store.js`). The JSON index was rewritten whole and synced, with the data
file, every 16 blocks: 55-59 times over a BFME2 first launch, 2.5-2.9 s of the game thread. The index is now an
append-only binary log (`index.bin`, format 3: fixed fields + key + record checksum), appended and flushed every 2 s
or 256 blocks and when forced (prefetch end, stop); a v2 `index.json` is read once and rewritten as a log. Most of the
old cost was the data file's flush (write-back of every block since the last one, ~4 ms per MiB at any
cadence): the data file is now flushed only at close — a block a crash lost fails its checksum at read and is fetched
again, as a damaged one already was.

Measured A = `main` (cab0b4c), B = this build, concurrent pairs on the shared server (other sessions' browsers
running), order alternated, fresh copy of the live learn dir per run, `--games-dir`, no block store (fresh browser):
RotWK 2.02 with `rotwk-startup.txt` and the `rotwk-202` profile, `--net-log`. "Parked" = fetch time of the reads that
parked their thread (`[net]` lines, ~570 per run); "ioWait" = the `ioWait` category of the load and loadscreen phases;
"match drawn" = the first second after the loadscreen mark whose frames carry > 150 draws (the loading screen draws
60-110). The scenario's `waitfps:12` (play mark) is unusable on this loaded server: the match runs at 9-14 fps in
both builds, so the play mark came 20-170 s after the match in either build at random.

| pair (first) | parked p50 / p90 ms | ioWait s | first frame s | menu s | load click → match drawn s | page start → match drawn s |
|---|---|---|---|---|---|---|
| 1 (A) | 56 / 66 → 14 / 27 | 11.9 → 3.1 | 32 → 29 | 57 → 54 | 27 → 19 | 114 → 105 |
| 2 (B) | 56 / 66 → 15 / 27 | 11.8 → 3.1 | 31 → 27 | 57 → 51 | 26 → 28 | 114 → 107 |
| 3 (A) | 56 / 66 → 15 / 29 | 12.1 → 3.5 | 31 → 28 | 57 → 52 | 30 → 28 | 117 → 109 |
| 4 (B) | 56 / 65 → 14 / 27 | 11.9 → 3.3 | 31 → 28 | 57 → 52 | 28 → 23 | 115 → 102 |
| `--net 40:100` (A) | 84 / 116 → 59 / 93 | 23.3 → 17.4 | 41 → 40 | 66 → 66 | 34 → 33 | 131 → 129 |

- The parked reads are 4 times faster and the idle time waiting for them drops by 8.5 s per run, but most of the gain
  is before the map: the first frame comes 3-4 s and the menu 5-6 s earlier (the start-up's own parked reads). The map
  load itself (click → match drawn) gains −8, +2, −2, −5 s (and −1 s at 40 ms RTT): after an earlier menu the click
  comes while more of the background work (code translated ahead, prefetch) is still pending. From page start to the
  drawn match: 7-13 s earlier in every pair, 2 s at 40 ms RTT (where the round trip itself dominates the read).
- Vice City (`vicecity-drive.txt`, 4 pairs, 2 with `--net-log`): frames > 40 ms per minute in the drive 100 → 109,
  187 → 218, 79 → 81, 128 → 78 (A → B; mean 124 → 122), 29.8-29.9 fps and 0.2 ms host per frame in both builds; 1-3
  network reads during the drive (~1 470 parked reads per run, p50 5-6 ms in both builds: answered within a slice).

Block store, BFME2 first launch, `--opfs` (fresh browser profiles), 50 s, 2 pairs (A first, B first), then a second
launch on each profile (40 s):

| pair | store writes ms (index syncs, of which ms) A | B | second launch |
|---|---|---|---|
| 3 (A first) | 3 482 (55, 2 477) | 1 141 (15, 59) | 818 / 818 blocks read back, no store emptied |
| 4 (B first) | 3 573 (59, 2 928) | 1 260 (15, 122) | 818 / 813 blocks read back, no store emptied |

An intermediate build that kept the data file's flush at each sync point: 3 218 and 3 287 ms (15 syncs, 2 153-2 167 ms)
against 3 558 and 3 846 ms for A — the syncs' cost was the data file's write-back, not the JSON. The remaining ~1.2 s is
the 1 MiB block writes themselves. No Direct3D frame came within the 50 s of a BFME2 first launch in any run (its
first-launch work), so first-frame and `late` times were not comparable there.

## A version that exits 2 s after its start: BFME2 1.06 (traced 2026-10-21)

`bfme2-106` runs `base/game.dat` (the original 1.06 executable; `versions/1.06-vanilla` is empty) and calls
`ExitProcess(0)` 2 s after its start, before any Direct3D call, in Node (`startbench`) as in the browser (and in the
publishing session of its shared snapshot). Orthros' trace (`ORTHROS_TRACE_API=2`, `--log crash,warn,file,seh,api`)
and the code around the calls:

- After its splash screen, `WinMain` (`game.dat` VA `0x4030b0`) calls a check at `0x632bed`: `CreateMutexA(0, 0,
  name)`, `GetLastError() == ERROR_ALREADY_EXISTS (0xb7)`, `CloseHandle`. Only when the mutex **already existed** does
  it go on, to `0x632c1f`: `OpenEventA(EVENT_MODIFY_STATE)` retried (`Sleep(0)`) for 60 s at most (`timeGetTime`),
  `SetEvent`, then `PeekMessageA` for 10 s at most for a thread message `0xBEEF` whose parameter is a file-mapping
  handle it maps (`MapViewOfFileEx`, `FILE_MAP_ALL_ACCESS`, kept at `0xdfe724`). Otherwise it frees what it made and returns from `WinMain` (`profile-high.csv` written in the
  game folder at exit — refused: read-only — then the C runtime's `ExitProcess(0)`).
- That is the hand-shake of the game's launcher (`lotrbfme2.exe`, in `base/`): it creates the mutex, starts `game.dat`
  and posts it the mapping. Run alone on Windows, `game.dat` 1.06 exits the same way: the emulation is faithful
  (`WinVerifyTrust`'s "certificate table past the end of the file", logged just before, is answered the same in 1.09
  and plays no part).
- `bfme2` (1.09) runs its own `versions/1.09-v3.01/game.dat`, whose same check is patched out (`0x402c75`:
  `je` / `jmp` to the same continuation, no `jne`): it starts without the launcher.
- Started through `lotrbfme2.exe` (a copy of the manifest with `"exe": "lotrbfme2.exe"`, scratch games dir), the
  launcher reads `lotrbfme2.lcf` and `game2.dat`, then `CreateProcess(game.dat)` is refused: the Win32 runtime runs one
  process (no child processes), and the launcher gives up (`ShellExecute(errors.txt)`).

So the cure is not in the emulator's fidelity: either the runtime learns to run a child process in its own address
space (a large piece of work: a second 2 GB guest, handles and window messages across processes), or the version's
folder gets a 1.06 `game.dat` that starts without its launcher, as the 1.09 one does (a data change for the owner).
