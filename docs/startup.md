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
  content) with the sessions that reported each. A set is offered only once `--profile-seed-quorum` distinct sessions
  (default 2) reported it identical — the most reported one wins. Identical files from independent sessions are the
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
- The cache key is a hash of the translator's own sources — the import closure of `bg-translate.js`, `jit.js` and
  `runtime.js`, fetched by the worker like the modules themselves — plus the translation options: any change to the
  translator or its options empties the cache. Instrumented translations (profiling, block counters) are not kept.
- Append-only records (~6 KiB per region: 27 000 BFME2 regions take ~165 MiB), a cut tail dropped at load, at most 256 MiB per game; only an index stays in memory, a record is read back on a hit; one tab at a time (the OPFS file is
  opened for exclusive synchronous access: another tab runs without it).
- **Off:** `?codecache=0`; harness runs use it only with a persistent browser profile (`--opfs`), `--code-cache 0`.

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

**Translated code cache** (later launch: copies of one persistent browser profile, `--opfs`; A `--code-cache 0`):

| game | background worker A → B | translating A → B | learned code installed by A → B | menu A / B | frames > 100 ms, first minute A / B |
|---|---|---|---|---|---|
| BFME2 | 14.1, 14.5 → 6.2, 6.2 s | 9.3, 9.6 → 0.17, 0.20 s | t = 16.1, 16.4 → 10.2, 10.5 s | 51, 51 / 50, 50 | 0, 0 / 0, 0 |
| BFME1 | 13.2, 13.1 → 5.1, 5.1 s | 8.7, 8.7 → 0.11, 0.17 s | t = 15.0, 15.1 → 8.8, 8.8 s | 54, 55 / 52, 52 | 0, 0 / 0, 0 |
| RotWK 2.02 | 17.8, 15.0 → 9.7, 8.9 s | 11.7, 9.9 → 3.0, 2.7 s | t = 19.7, 16.9 → 13.2, 12.4 s | 55, 52 / 54, 51 | 3, 4 / 3, 4 |

~99 % of the lookups hit (the rest: regions new to this session). The time to the menu and the first minute's
hitches do not move on this machine: the background translation runs on a core of its own and was already finished
before the game needed it; the saving is ~8-9 s of a core at each launch (what a client with few cores shares with
the game, the GPU process and the DXT helpers). Cache file: 206-256 MiB per game (BFME1 reached the 256 MiB bound: what comes after is not kept), its index read in 0.6-0.85 s before the first batch.
