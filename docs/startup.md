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
  session and grows during one: it is not in the key but recorded per entry — every answer the translation got from
  the heat (discovery's cold edges: whether a branch ran, whether its successor did; which blocks get a visit flag) —
  and an entry is reused only where the session's heat gives the same answers (`missHeat` otherwise; a heat that cuts
  the region elsewhere already gives another extent). Its visit flags are moved to the session's own flag bytes
  (`patchVisitSlots`, like the table index); a translation made when the flag area ran out is not kept. Batches
  translated under in-session options (`Jit.switchOpts`) are neither looked up nor kept. The learned entries skipped
  as blocks of an earlier region are those of the regions as cut by the heat of now: an entry a cut region no longer
  holds is translated on its own (a server that forgot it as covered relearns it at its next miss).
- Measured with heat (2026-10-04, `integ-1004`, phase scenarios, one persistent browser profile and learn directory
  per game reused across runs): RotWK 2.02 run 1 (no heat yet) 12 991 entries added; run 2 (heat of run 1: 24 887
  ranges) 1 714 reused, 5 299 other extent, 2 413 other heat, the cache full and stale, emptied and refilled; run 3
  (heat 27 122 ranges) 8 122 reused, 312 other extent, 240 other heat (the rest new entries). BFME2 run 2: 2 665
  reused, 5 830 other extent, 3 609 other heat. While the learned heat still grows the cache mostly misses; it serves
  again once the heat settles.
- The cache key is a hash of the translator's own sources — the import closure of `bg-translate.js`, `jit.js` and
  `runtime.js`, fetched by the worker like the modules themselves — plus the translation options and the defaults they complete (`JIT_DEFAULTS`: layout, cold exits, region sizes...): any change to the
  translator or its options empties the cache. Instrumented translations (profiling, block counters) are not kept.
- Append-only records (~6 KiB per region: 27 000 BFME2 regions take ~165 MiB), a cut tail dropped at load, at most 256 MiB per game (full, it stays as it is while its entries serve; when the entries read at load mostly miss — ≥ 2 000 misses, over 4 per hit: the game's code changed — it is emptied and refilled); only an index stays in memory, a record is read back on a hit; one tab at a time (the OPFS file is
  opened for exclusive synchronous access: another tab runs without it).
- **Off:** `?codecache=0`; harness runs use it only with a persistent browser profile (`--opfs`), `--code-cache 0`.

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
