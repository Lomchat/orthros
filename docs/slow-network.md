# Thin links: game files over a slow connection

The game files are streamed from the server with range requests (`src/vfs/http-backend.js`): the game's own reads
(demand: `&s=<session>`, a synchronous XHR or a parked asynchronous read) and background downloads (`&p=1`: learned
prefetch, pieces fetched ahead, block fill, offline copy; `&a=1`: a sequential reader's next bytes, learned as the
game's reads). Everything fetched is kept in the browser's OPFS block store (`src/vfs/opfs-store.js`): a later launch
reads it locally.

## The incident (2026-10-06)

A player opened `?bench=vicecity-drive` from home (~85 KB/s in total, 40-60 ms round trip). After 15 minutes the game
was still black on the intro of a new game, the page said "loading… 0 MIPS, game files 14 MB". The server's access log
showed ~4-6 MB per minute, most of it background downloads: whole 1 MiB blocks fetched beside each 64 KiB piece the game
read (16 times the bytes), movie and music prefetch, 4 MiB synchronous reads of streamed music (93 s for one read), the
same ranges downloaded twice (a prefetch and a demand read side by side; a background download aborted then started
again from zero). The demand reads waited behind them (single 64 KiB pieces took 3-20 s). Every validation had run on
this server (localhost), where none of this shows.

## The rules (all generic: they depend on the measured link only)

`src/vfs/net-link.js` (`NetLink`, one per page, shared by the game's folder and the games it requires):

- **Bandwidth measured** from the transfers themselves: wire bytes (the encoded body: `Content-Length`) over the time
  the link was busy (concurrent requests count once), from the first byte of each answer to its end; the round trip is
  the shortest time to the first byte of an answer (`firstByte`: when `fetch` resolves, before the body). The rate is
  taken over the answers ended within the last 20 s, up to the first byte of the oldest answer still arriving (it
  shares the link without its bytes counted yet), an answer begun before that horizon counted pro rata — without
  this, a long game read beside small background answers read an 85 KB/s link as 20-35 KB/s. Kept by the page
  (`localStorage['orthros.netBw']`) as the next visit's first estimate. Until measured, the link is treated with care
  (256 KiB requests, two background requests at most).
- **Three regimes** by the measured rate:
  - *thin* (below 384 KB/s, the incident's 85 KB/s): the game's reads alone on the link — a background download waits
    for its turn (`turn(prio, quietMs)`): no game read in flight and the link quiet for the download's own delay;
  - *between* (384 KB/s to 3 MB/s): background requests go beside the game's reads, the bytes in flight (the game's
    and the background's) within about `BG_SECONDS` (0.35 s) of the link — a game read waits at most that much longer,
    and a latency-bound run of small reads (hundreds of sound files at a start) no longer leaves the link idle;
  - *fast* (3 MB/s and more: 5 MB/s with a 50 ms round trip measures ~3.6-3.9 MB/s): the earlier policies (whole blocks,
    block fill, several background requests, aborts on demand) — measured as fast or faster there (round trips cost
    more than bytes).
- **Priorities** of the background downloads (`PRIO` in `http-backend.js`): a sequential reader's next bytes and the
  learned pieces just ahead of the game first (its next reads), then the block fill, the learned prefetch, the blocks
  next to missed ones, the offline copy. A waiting download a parked read now waits for is promoted (it is demand now).
  Together the background requests in flight carry at most `backgroundBytes()` (about `BG_SECONDS` of the link), up to 8.
- **Sizes from the measure**: a background request carries about `BG_SECONDS` of the link (64 KiB at 85 KB/s, ~0.4 MiB
  at 1 MB/s, 4 MiB on a fast link); a demand read rounds up by at most `DEMAND_SECONDS` (0.25 s) of the link past what
  the game asked (a stream's window grows with the stream, within that bound). A file read whole no longer fetches
  1-4 MiB blocks synchronously on a link that is not fast: it goes by pieces, its next bytes come ahead in background
  requests of the link's size (`readAheadParts`, 2 s of the link ahead).
- **No abort waste**: background requests are small enough to finish (a demand read that comes waits at most their
  rest); only those that would hold the game up longer than 1.5 × `BG_SECONDS` are aborted (sized before the link was
  measured, or the link slowed down); a synchronous read aborts the background requests for the same bytes (the worker
  cannot receive their answers while it waits: they would cross the link twice).
- **Only what the game needs on a thin link**: no speculative whole blocks — no block fill for a piece read, no "near"
  blocks, the learned prefetch fetches the learned pieces (the masks: what earlier sessions read) only. On any link that
  is not fast, a file the game opened and closed again (a movie skipped, a file parsed), or reads as a stream (16 reads
  and 256 KiB in sequence: a movie, music), is not fetched ahead from the learned order (earlier sessions that played a
  movie through read all of it; this one may skip it) — a stream's next bytes come ahead of its reader only.
  (2026-10-21, BFME's start replayed in Node through these rules: its archives stay open — one handle each, never
  closed —, Textures.big is flagged a stream once, 11 % of the game's reads; a version where a file that is not a media
  file stays a stream only while it is read did not measurably change BFME's first launch at 1 MB/s — the same 16.3 MB
  of demand reads, +10 MB of background —: not kept. The idle link the audit saw from t=80 to 180 s was the harness
  without a block store: no learned prefetch at all; with `--memprefetch` the link stays busy, 15 MB per 20 s.)
- **Learned order**: the server's prefetch list (`/api/prefetch/<manifest>`: `[path, block, mask, t]`, sorted by the
  time `t` the earliest sessions needed it) drives the pieces fetched ahead of the game's position in it and the
  background pass; `t` also gives the current step's size (`HttpBackend.stepEstimate`: the learned pieces past the
  game's position up to the first 5 s pause in that timeline).
- **Kept**: on a link that is not fast, the pieces themselves go to the OPFS store (keys `path#size#mtime#c<piece>`);
  a block whose pieces are all here is assembled and stored whole (its pieces dropped). A second launch reads them
  locally.

## Light copies (2026-10-20)

On a link that is not fast, a large texture is read light first, the file itself after it (the owner's idea: "on
envoie tout en compressé instantanément, puis en background on charge les grosses textures"):

- **Server** (`src/host/light-copies.js`): a light copy of a DDS texture whose longest side passes `LIGHT_SIDE` (256)
  and which has mip levels: its finest levels left out — the same format, its header telling the smaller size and the
  fewer levels, the remaining levels as they are, two at least (an engine meeting a compressed texture without stored
  levels may turn its mipmapping filter off for good, even once the file replaces it in place; a texture of fewer
  than three levels is not lightened, nor one drawn without levels — a menu's).
  A TGA picture of a screen's size (2026-10-21: uncompressed truecolour or greyscale, its longest side
  `TGA_LIGHT_FROM` = 1024 or more — a loading screen's, a map's; a smaller one may be a menu's picture drawn at its own
  size) has one too: a TGA of its own, its sides halved until the longest is `LIGHT_SIDE`, each pixel the mean of those
  it stands for (none for a strip thinner than one such square — a 1024 × 1 ramp: its rows would be averaged with bytes
  past the picture —; `lightTga`, `tgaLight`; made from the file when read, the last 32 MB of them kept). Morrowind's eleven
  loading screens are 1024 × 1024 × 24-bit, 3 MB each (2.8 MB on the wire): its loading screen shows a new random one
  every 5 s while the game is not started (OpenMW's `LoadingScreen::changeWallpaper`), so at 85 KB/s each new picture
  held the page ~33 s more (8 of them in a New Game's first load: 21 MB of its 28); light, 197 KB each.
  A WAD3 archive (GoldSrc's textures, 2026-10-21: `lightWad`) has a light copy of **its own size and offsets** — the
  same archive, so that an engine reading part of it as one and part as the other still reads a valid archive —, each
  uncompressed texture of 64 × 64 pixels or more with its finest level redrawn from the next one (each pixel of level 1
  twice as wide and high: half the detail on the nearest surfaces, the farther levels as they are), which brotli finds
  again and again: per 1 MiB block at brotli 11, halflife.wad 0.62 → 0.35 of its bytes, Counter-Strike's map WADs
  0.70-0.89 → 0.35-0.43 (chateau.wad 0.82 → 0.38, cs_dust.wad 0.89 → 0.43). Its learned order keeps its pieces
  (`forLink`: a copy of the file's size stands for the same pieces, not for all of it); the units of such a copy are a
  version of their own (`lightFormat` in br-cache.js's key). GoldSrc does not load a file again in place, so the copy
  is read only on a thin link (`readsReal`), and the file replaces it at the next map load once downloaded (the whole
  file, last of all, as any light copy). Measured on the launch sets (thin link, 2026-10-21; each WAD's brotli-11
  ratio over its blocks, applied to its learned bytes): Counter-Strike Arsenal 9.6 MB of WAD pieces, 6.85 → 3.52 MB on
  the wire (−3.3 MB, ~−39 s at 85 KB/s; every texture redrawn there, small ones too — the copy as made leaves those
  under 64 × 64, a little less); Counter-Strike rebuilt 3.3 of its 4.2 MB measured, 2.26 → 1.20 MB; Half-Life 1.0 MB,
  mostly WADs without textures to lighten, ~−0.2 MB. Not measured in a browser at 85 KB/s.
  Derived at each request (a header of its own, then a run of the file: nothing stored, the game files never changed),
  served as `/gamez/<manifest>/.light/<path>` (compressed ranges, read reports learned like the file's). The tree tells
  each such file's light size (`light`). For the browser ports only (`manifest.lightCopies`, the catalog's: `false` in a
  version turns it off): a Windows game reads its files as they are.
- **Page** (`src/vfs/data-client.js` `pick`, `readsReal`): each load of the file (a read at its start, 2 s after its
  last read) chooses: the file itself when it is here whole; else what the page said its loads are for
  (`GameData.prefer`: `'light'` — loads that can do with less for now, as the far ring of a view that grows —,
  `'real'`); else, on a fast link (the worker's ctrl[7]) — or, for an engine that cannot load a file again in place,
  one measured between thin and fast (ctrl[8] measured, ctrl[9] not thin) —, the file unless its light copy is here
  (no wait); else its light copy — zeros past its bytes, up to the file's size (the engine reads what its header
  says). The choice holds for the whole load. The light copy read, the worker is told once.
  A big announced load of an engine that reloads in place reads light on a fast link too ("Big loads light first").
- **Engines that reload in place** (`GameData.reloads(true)`, or the `reloads` option: OpenMW's Orthros build, whose
  `orthros_file_updated` export `src/ports/openmw/streamfs.js` sees): light copies first on every link that is not
  fast, since the file replaces the light copy while it is shown (`onReal`: the page asks the engine to load it again,
  `repick(h)` making that load choose again — the rest of a load under way keeps the light copy, its offsets that
  copy's). Measured on a 1 MB/s link: the between → file rule sent 23 MB of full sky textures before the menu
  (menu 200 s against 126 s). Their upgrades are `soon`: told with the light read, they start once the game has read
  nothing for 1.5 s instead of 8 s (the player sees the benefit at once), the latest first as any.
- **Worker** (`src/vfs/data-worker.js`, `HttpBackend.upgrade`): the files whose light copy the engine read are
  downloaded last of all — after every other background download, once the game has read nothing for 8 s (the player
  in an area already loaded; 1.5 s for an engine that reloads in place), a thin link too (by pieces), the latest
  first —; done, the page is told (`real`) and the next load reads the file. The learned order is read for the link (`forLink`): on a link that is not fast, light
  copies in place of their files (unless here), on a fast one the files themselves.
- **Measured** (Morrowind Vanilla+ FR, fresh browser, 1 MB/s and 60 ms, the same learned order, light copies at 256):
  menu 163 → 126 s; frozen after New Game (240 s window) 228 → 149 s, longest hold 48 → 21 s; the engine's waits
  149 → 85 s; on the wire 368 → 264 MB (textures 199 → 70 MB: 13 MB of light copies, the rest small textures and the
  files upgraded once the game was idle). Over the version: 3746 textures, 2329 MB → 135 MB light.

## Near first, far in the background (2026-10-21)

A page whose engine can draw less far loads its near world first and the far one when the link is free:
`GameData.quiet(ms)` (`src/vfs/data-client.js`) says nothing waits — no read waited for the network for `ms` (the
worker's ctrl[11], ctrl[6]), and the learned order has nothing left for the game's current step (ctrl[10]: it does not
run, is over, or `HttpBackend.stepEstimate` is 0) —, and `GameData.prefer('light')` makes the loads of a step read the
light copies of their textures (upgraded later, as any). The OpenMW port uses it for its view distance
(`src/ports/openmw/view-grow.js`, `docs/openmw.md`): on a link not fast last time the engine boots at 8192 units, then
grows by 2048 while quiet.

## Media files after the rest (2026-10-21)

Movies and music are not what the game waits for to start; on a link that is not fast they come after it:

- **Server** (`src/host/game-files.js` `listGameTree`, the rule `isMediaFile` in `src/vfs/game-tree.js`): a tree file
  is marked `media: true` by its format — `.bik .bk2 .mp3 .ogg .avi .mpg .mpeg .wmv .smk .webm`, and `.wav` from
  512 KB (`MEDIA_WAV_BYTES`: music, speech; smaller ones are sound effects). Every game, every runtime.
- **Learned order** (`src/vfs/launch-set.js` `forLink`): on a link that is not fast, the media files' entries move
  after all the others, in their order (earlier sessions played a movie through; this one may skip it); the startup set
  (`startupHead`) leaves them out.
- **Offline copy** (`HttpBackend.downloadAll`): the media files' blocks after every other block, on every link.
- **Guesses** (`HttpBackend.speculate`): no blocks near a missed one, nor the next blocks of a read, for a media file
  the game is not streaming now (`HttpBackend.streams`); a stream keeps its read-ahead.
- A read of a media file is never answered with made-up bytes: it waits for the network as any other.

## Archives read at random in play: wanted whole (2026-10-22)

The learned order holds what earlier sessions needed, in their order; what a game reads as it plays — a sound bank, the
models and textures of what comes into view — differs from one session to the next. BFME 1.08, ten minutes of play in
headless Chromium (`--memprefetch`, a copy of the live learned lists, `headless --net-trace`): 37-47 reads went to the
network after the loading screen, only 5 of them common to two sessions (Audio.big, W3D.big, _patch108.big, Music.big,
textures: 64 KiB pieces here and there), each a frame waiting (`ioWait`, then `late` while the read's tasks run).

`HttpBackend.noteMiss` → `noteMissAfter`: once the learned prefetch pass is over (`learnedDone`), a file missed in
`WHOLE_AFTER_MISSES` (3) distinct blocks — not a media file, not a stream — is wanted whole (off by default since 2026-10-22: `?dbg=ORTHROS_WHOLE_AFTER_MISSES=1`) (`wantWhole`: its other
blocks in the background fill's `later` queue, after the blocks the game touched and those near them, the link quiet
for NEAR_QUIET_MS). Only on a fast link and with a block store (OPFS, or the harness's memory store): the blocks stay
for the next sessions. Generic: the data system of every runtime (the ports' streamed files already asked it).

Measured (the same run beside the former tree, at the same time): reads on the network in play 37 → 13 (2.8 → 0.7
MB; the rest: the music stream's next bytes, files first read late), the game's own requests over the session 124 →
68; the cost, the bytes downloaded over the session 414 → 820 MB (W3D.big, Audio.big and others whole, in the
background; kept in the store). Frames, `?dbg=ORTHROS_WHOLE_AFTER_MISSES=0` against the default, two runs at the same
time, ten minutes of play (`--gl-discard`): with the browser's block store (`--opfs`, as players have it) frames over 40
ms 29 → 32 per minute, over 100 ms 0.6 → 0.2 per minute, the worst 238 → 204 ms, the game's requests 102 → 56, the
store's writes on the emulator thread 1.5 → 3.2 s in all (~2 ms per block); with the harness's memory store
(`--memprefetch`: 1.1 GB more kept in the worker's memory) frames over 40 ms 29 → 37 per minute (`late` 0.2 → 0.5 ms per
frame: garbage collection and the event loop between slices), over 100 ms 0.7 → 0.3. Fewer stalls of 100 ms and more in
every pair; frames over 40 ms within the noise with the real store, more with the memory store.
tests/http-backend-whole.test.js.

## A fast link far away (2026-10-22)

The owner's BFME 1.08 bench links on his laptop (7-15 MB/s measured, 75 ms round trip, behind Cloudflare): 16.7 s of
game reads waiting for the network before the menu (112 requests, ~150 ms each), 191 MB downloaded before it, the
learned prefetch still running through the skirmish (155 MB of background there), 12 frames held 400-600 ms by `ioWait`
in ten minutes of play. Reproduced here with `tools/net-proxy.mjs` (an HTTP/2 TLS proxy as Cloudflare speaks to Chrome:
one connection, one link of 7 MB/s shared equally by the answers in transfer, a 75 ms round trip, the origin asked with
`Accept-Encoding: gzip, br`; `headless --page-origin https://127.0.0.1:<port>`), a fresh browser profile with a block
store (`--opfs`), the menu bench then the skirmish bench (`--ui --bench`, `--game-lang fr`, `--gl-discard`), a copy of
the live learned files of that day for each run, `--net-log` (every game read that went to the network: file, range,
time, learned rank).

What it showed:

- **The learned prefetch was latency-bound.** On a fast link it fetched one 1-2 MiB request at a time, paused 300 ms
  after each game read and aborted its request at each one: the 7 MB/s link carried 2.3-5 MB/s of it (one round trip
  idle per request), the launch set (297 learned blocks, 145 MB on the wire) was in at ~41 s, the whole learned order
  at ~100 s. A machine whose game reads faster than that (the owner's) waits for the reads itself.
  **Now** (`FAST_PREFETCH_PARTS`): on a measured fast link, 3 requests in flight, 1 while the game reads from the
  network, no pause; and a game read aborts only the background requests whose rest would hold it up long
  (`NetLink.abortLong`, as on the slower links) — an abort threw away bytes mostly arrived for a read that shares the
  link with them a few milliseconds. The link is used at 5-7 MB/s, the launch set in at ~32 s, the order at ~55 s.
- **A file read whole in one call went block by block.** The executable (16 MB, loaded in one read) took 15 synchronous
  1 MiB requests, 2.6 s. **Now** one read covering several whole blocks none of which is here (no piece, nothing on
  its way) fetches them in one request (`missingBlocks`, at most 16): 4 requests, 1.6 s.
- **Before the menu**: the game read 130 MB (decoded) before it looked playable, in 294 blocks — 294 of the launch
  set's 297 (the launch set is right at the block level); a fast link fetches those blocks whole (their learned masks are
  all 16 pieces: the masks are the union of every session's requests, and a fast link's own reads — whole blocks, 4 MiB
  sequential reads, read-ahead — ask whole blocks), ~145 MB on the wire, and then goes on with the rest of the order.
  In these runs the menu waited for the game's computation, not for the link (start phase: 7 s of guest code in its
  worst frame; demand waits 1.9 s, all the executable at t = 2-4 s): the bytes past the launch set (162 → 237 MB before
  the menu with the faster prefetch) did not delay it — the menu at 47.8 / 46.4 / 46.8 s.
- **Play**: every game read that went to the network after the loading screen was one no earlier session had read
  (learned rank none: W3D.big, Audio.big, Textures.big, _patch108.big, lang/FrenchAudio.big, Music.big at random —
  26 and 40 of them in two sessions, almost none in common). Each took one round trip and its bytes, 90-150 ms (the
  background downloads did not slow them: 104-105 ms on average, a 75 ms round trip); a frame held 300-700 ms is a
  chain of 3-5 such reads by the same thread (a model and its textures). Nothing in the learned order could have had
  them; the blocks near a miss (`NEAR_BLOCKS`) caught 1-4 of them (simulated on the logs: ±4 blocks 3-12, ±16 blocks
  10-29), for ~3.6 blocks downloaded per miss (80-120 MB in the skirmish). The archives wanted whole after misses
  (`?dbg=ORTHROS_WHOLE_AFTER_MISSES=1`, off by default) do have them: 19 reads on the network in play, 4 frames over
  100 ms held by `ioWait`, for 427 MB of background in the skirmish instead of 80-122.

| 7 MB/s, 75 ms (one run each) | before | after | after + whole after misses |
|---|---|---|---|
| menu bench: game reads on the network before the menu (requests / s waited) | 17 / 2.8 | 6 / 1.9 | 6 / 1.9 |
| menu at (s), wire bytes by then | 47.8, 162 MB | 46.4, 239 MB | 46.8, 237 MB |
| skirmish load: network reads / s | 4 / 0.4 | 8 / 1.0 | 4 / 0.4 |
| skirmish play (600 s): network reads / s, frames > 100 ms (`ioWait` hitches) | 26 / 2.7, 12 (9) | 40 / 4.2, 14 (12) | 19 / 1.9, 10 (4) |
| skirmish background bytes | 80 MB | 122 MB | 427 MB |

The play rows are each session's own random reads (the "after" session read more new places): what the changes do is
in the first rows. What only a real machine shows: whether its faster game then waits less before the menu (the owner's
112 requests), and the round trips of a real path (the owner's game reads took ~150-170 ms on average against 75 ms
here and ~105 ms in this proxy).

## Playable after (2026-10-21)

The first pause of the learned order (2 s, `STARTUP_GAP_MS`) is not when a game becomes playable: OpenMW's French
order pauses after 1 MB, its main menu comes at 198 MB. So the pages say when it is, and the server learns from it —
every runtime, one implementation (`src/vfs/launch-set.js`):

- **The mark**: `GameData.mark('playable')` (`src/vfs/data-client.js`) when the game first draws in play — GoldSrc and
  re3: where their loading screen hides (`hideLoader`); OpenMW: when the player is first in the world (Orthros'
  PLAYER script, `view.lua`, tells its view from its first poll: after the menu and the load, `streamfs.js`). The data
  worker sends it once per session with every read before it (`{ session, reads, mark: { kind, t } }` to
  `/api/prefetch/<manifest>`). The Windows games (2026-10-21): their page knows nothing of the game's menus, so the
  worker marks when the game first looks playable (`src/vfs/playable-watch.js` `PlayableWatch`, the same for every
  game): the last 10 s — and each half of it — drawn at 20 fps or more, none of its reads waiting for the network, at
  most 96 KB/s of its files read (menu music streamed from an archive) and nothing of a movie, the game pacing itself
  a fifth of the time at least (its threads waiting for their timers, frame-acct.js `wait` / `sleep`: a loading that
  computes draws its splash screen between steps without waiting). Seen on BFME's first start: with 5 s at 10 fps it
  marked its splash screen (69 MB read, two minutes of computation before the menu); the worker's pump time is no
  measure of it (busy all along in the menu too, where the game waits 50-80 % of each frame). The worker's learned
  prefetch takes the launch set first (`launchFirst`, as the data worker), its flags by the game's language. The worker also
  reports every read of the game, as the data worker does (`ReadLog`, every 15 s and with the mark: whatever answered
  it — the server's `/gamez` learning sees only the reads that reach the network, so blocks a session found in its
  copy or got from the learned prefetch were never learned again, nor masked: the mask-less orders below). A session
  started from a snapshot does not report (it skips the start's reads). One session marks each version it mounts
  (the versions it requires too): the server keeps a session's reads per version (`learnMark`).
- **The server** (`learnMark` in `src/host/server.js`): each learned block the marking session had read by then counts
  it (`pre`, the 5th element of a row of `prefetch-<manifest>.json`), the version counts its marking sessions
  (`playable-<manifest>.json`, `{ marks }`). Once one marked, each entry of `/api/prefetch` carries a 5th element, its
  flags: bit 0 (`PRE_PLAYABLE`) when it was read before playable in at least half the marking sessions.
- **Per game language**: a page tells its game's language (`GameData.open({ lang })`, the GoldSrc and re3 pages; the
  mark's `lang`: one of the version's `languages` — another is counted with all the sessions only, `markLang`), the
  server counts the marks and each entry's `pre` per language too (`by`, the 6th element of a row;
  `{ marks, by }`), and `/api/prefetch/<manifest>?lang=<code>` flags by that language's marking sessions (all of them
  while none of that language marked). Measured on the live server (2026-10-21): a French Half-Life start waited for
  its 10 `valve_french/` files (149 KB on the wire, read by French sessions only — one in three marks: below half),
  a French Vice City start for `TEXT/french.gxt` (122 KB) after a full Prepare.
- **The launch set** (`launchSet`: `startupHead(forLink(order))`): the flagged entries as this link reads them (light
  copies on a link not fast, no media there); an order without flags falls back to its first pause. It is the startup
  set the GoldSrc and re3 pages wait for (`startup()` in the data worker). A version that requires others as separate
  parts (`extraMounts`: a Windows game over another's folder; a port's required versions are underlays, in its own
  tree) adds their launch sets, each from its own learned order — the startup set, the card's sizes and Prepare alike.
  Once the engine runs (`start()`), the whole learned order loads in the background from the game's position
  (`prefetch: 'startup'` behaves as `'start'` after the startup set). Until 2026-10-21 it never did for the GoldSrc and
  re3 pages: after the startup set the engine read everything on demand, round trip after round trip (Vice City: ~100
  reads per 10 s, 0.25 MB/s on a 1 MB/s link).
- **Measured (2026-10-21, 1 MB/s + 60 ms RTT shared link, fresh profile, SwiftShader on a loaded machine, one run
  each; seconds from the page's load: loader hidden / in control — re3 a new game's first scene, GoldSrc `map c0a0` in
  play — and the engine's read stalls until control):**

  | policy | Vice City, few flags | Vice City, learned flags (53 MB set) | Half-Life |
  |---|---|---|---|
  | launch set, no background (main before) | 156 / 248, 247 s stalled | 80 / 156, 118 s | 21 / 63, 37 s |
  | first-pause cut, no background (older) | 153 / 254, 252 s | — | 32 / 38, 1 s |
  | launch set, then the learned order (kept) | 92 / 144, 124 s | **75 / 133, 84 s** | **20 / 27, 2 s** |
  | first-pause cut, then the learned order | — | 85 / 127, 104 s | 31 / 36, 0 s |

  Waiting for the whole launch set does not delay the drawing: the link is saturated either way, and the first-pause
  cut fetches what the menu does not need (Half-Life: 18 MB before its menu instead of 2.5 MB, 11 s later). The
  background order is what removes the freezes later.
- **The home card** (`/api/manifests` `launch: { bytes, lightBytes, wire, lightWire, entries }` per version,
  `launchSummary`; null until a session marked it; made again when the order changes, at most every minute): `bytes`
  the launch set's learned pieces on a fast link, `lightBytes` with light copies (a link not fast), the `wire` bytes
  those of the precompressed units already made (`brCache.size`; a unit brotli could not shrink: its range's bytes),
  else 0.75 of the bytes; `langs: { <code>: … }` each game language's own (`launchFor`: the card's language's); `engine`
  and `engineFiles` a browser port's engine release (its wire bytes and URLs: 8.0 MB for Half-Life, 4.2 MB for Vice
  City, measured, none of it in the launch set — 80 of the 105 s a first French Half-Life launch took at 100 KB/s). The
  card says "Playable
  after 80 MB, about 10 min at your link (100 KB/s)" (`launchStatus` in `src/host/web/download.js`, the rate
  `linkRate`; the size only while none was measured), above the whole download's line, hidden once the whole game is
  here or downloading.
- **Prepare** (the line's button): the download worker fetches the launch set only (`{ type: 'launch' }`:
  `HttpBackend.prefetch` with `learnedOnly`, the pieces as the startup set fetches them) into the same OPFS store —
  the card's game language's set, and first the engine release's files into the HTTP cache (immutable URLs: the page's
  first launch finds them there; `only-if-cached` skips those already here); pause and resume (the pieces here are
  skipped; the progress is kept in `localStorage['orthros.launch.<manifest>[.<lang>]']`, the pieces here counted again
  each half second — `setBytes` — with the engine's bytes, `engine`, in wire bytes as the card's size: a brotli answer
  comes decoded, counted in proportion to the sizes its headers say, `X-Orthros-Wire-Length` / `-Decoded-Length`, the
  server's `sendBrotli`; and the engine URLs it cached, `engineFiles`: once the card's differ, it is not ready). Starting
  a game stops it first, as the whole download.
- Not measured yet: the launch sizes on the live server (no session marked before this change), and whether OpenMW's
  in-world mark comes as described (no browser run).
  `HttpBackend.prefetch` with `learnedOnly`, the pieces as the startup set fetches them) into the same OPFS store; pause
  and resume (the pieces here are skipped; the progress is kept in `localStorage['orthros.launch.<manifest>']`, the
  pieces here counted again each half second — `setBytes`). Starting a game stops it first, as the whole download.
- Not measured yet: the launch sizes on the live server (no session marked before this change). OpenMW's in-world mark
  was seen in a browser on 2026-10-21 (the 85 KB/s run below: `playable-<manifest>.json` `{ marks: 1 }`, 446 of the
  French order's 1781 entries flagged).
- **While the player waits** (2026-10-21): the learned order fetched in the background puts its launch set first
  (`launchFirst`: the flagged entries, then the others, each in its order; the media still last on a link not fast) —
  followed from the game's position, a player sitting in the menu gets the rest of the way to playable (a new game's
  first load) before what sessions read later. A position past the launch set (a read of the rest while some of it is
  missing: a random loading picture, a save list) does not send the pass through the rest first: the launch set's
  missing entries come before (`prefetch`'s `first`, the launch set's length — `launchFirst`'s `first`). The data worker tells the page the way left while the game is not
  playable (`launchWatch`: `{ launch: { bytes, here, wireLeft, seconds, done } }` every 2 s — the launch set's bytes,
  those here, the wire bytes left at the link's measured wire/decoded ratio, their time at its measured rate), and the
  header shows it (`shell.setData` kind `launch`: « Prêt à jouer dans ~N min » / "Ready to play in ~N min", the
  learned order's own pill hidden meanwhile; gone once all of it is here or the game is playable). Every runtime whose
  page forwards `GameData.onProgress` (OpenMW's header today). The wire ratio is `WIRE_RATIO` at least: the session's
  own (its master files compress to ~25 %) said "< 1 min" for a load of 86 s.
- **A streamed media file does not move the game's position** (`HttpBackend.noteBlock`, entries marked `tail`): on a link
  that is not fast the media entries are the order's tail; the menu's music, streamed while the player waited, moved the
  position there, and the background pass went on through every movie and track of the tail (measured: 10.5 min in
  Morrowind's menu at 85 KB/s fetched 32.8 MB of intro movies — not played, `&novid` — and 14.6 MB of music, none of the
  launch set's last 6 MB; the pill stayed at "~1 min", the New Game hold 84 s after the wait as without it). Fixed after
  that run; covered by a unit test, not measured in a browser yet.

### Measured at 85 KB/s (2026-10-21)

Morrowind GOTY Vanilla+ FR through a throttling proxy (a scratch tool: one link of 85,000 B/s shared by the answers,
80 ms round trip, Cloudflare's `Accept-Encoding: gzip, br`), fresh Chromium profile (headless, SwiftShader), the live server's learned order and
precompressed units of that morning; New Game clicked 10 s after the menu's music started. "Before" is main at 5dbd24e;
"after" the TGA light copies, the lean engine package and the launch set first (its flags those the "before" session
marked, on the same order).

| | before | after |
|---|---|---|
| Play solo → main menu | 20.5 min (93.5 MB on the wire: engine 39.1 MB, Morrowind.esm 34.6 MB, Splash 4.1 MB) | 16.0 min (70.4 MB: engine 20.6 MB, Splash 0.2 MB) |
| New Game → in the world (the page held in one block) | 359 s (longest hold 349 s), 27.9 MB: 21.2 MB of loading-screen pictures | 96 s (longest 86 s), 7.2 MB: 1.3 MB of light pictures |
| same, after 10.5 min in the menu (second "after" run, before the position fix) | — | 84 s, 6.2 MB |

Unexplained, not network: in the world, with no read waiting (0.3 MB of the game's own reads in 4 min), the page was
held 1-10 s every ~10 s in all three runs (sum 204 s / 240 s before, 133 s after) — SwiftShader on a machine loaded at
24-30, to look at on a real GPU.

## The card from the store, persistent storage (2026-10-27)

Until now the card's "Playable after" and "Whole game" lines knew only what a Prepare or a download of the home had
written (`localStorage['orthros.launch.<manifest>[.<lang>]']`, `['orthros.download.<manifest>']`). A player who played
the game — the game fills the same store — saw "Playable after 137 MB · ~10 min" (Morrowind FR at 85 KB/s) over a store
holding all of it, and nobody uses Prepare (`download-worker.js` fetched 0 times in a month of access logs). And a
best-effort origin's stores may be evicted when the disk runs short: nothing asked for persistence, nothing told it.

- **The probe** (`probe` in `src/host/web/download-worker.js`, `Downloads.probe` / `probed` in `download.js`, started by
  `home.js` `probeStores` 1.5 s after the library is drawn, once a visit): each card's version — the one its game
  language runs — in turn, the resume game first, in the download worker. Rules:
  - a store's directory is looked up first (`storeExists` in `src/vfs/game-data.js`, no `create`): a version never
    played is never opened nor created; a store that does not exist (never played, evicted, cleared) clears the lines'
    progress (`missing`: the full size again);
  - the network first, no store held (manifest, trees, learned orders of the game language, the engine's files checked
    `only-if-cached` — no download), then the stores opened, counted and closed at once: `running` (the worker's) only
    then, so a Play or a Prepare started stops it at once outside that moment and finds the stores closed in it — the
    game never opens a store the probe holds (OPFS: one context at a time). A Play cancels the probe's timer before
    anything is awaited and closes the probes of the page for good (`play()` → `Downloads.forGame`: a timer firing
    while `main.js start()` fetches its manifest, or a port's page navigating, starts no probe after the click);
  - across tabs and workers, the stores' **Web Locks** (`storeLocks` in `game-data.js`, `orthros-store-<manifest>`):
    every `openStore` (the Windows game's worker, the data worker, Prepare / download) takes its store's lock for the
    open only, waiting; the probe takes its version's locks without waiting (`ifAvailable`: a game opening one now →
    unknown) for its open-count-close. A game in another tab started during a probe's count waits that moment out
    instead of running its session without its store;
  - the launch set as this link reads it (`launchSet`: on a thin link a file here whole is listed itself, else its
    light copy; on a fast link the file's pieces — a light copy stored then does not count: the game's startup fetches
    the file's own pieces, `data-worker.js` `startup`); the engine's bytes in proportion of its files cached; "done"
    (the card's **Ready**) when all of the set and all of the engine are here — a store filled on a thin link probed on
    a fast one says "Playable after …" its files' pieces;
  - the whole game by its blocks here whole (`HttpBackend.storedBytes`: what the whole download skips), "N % downloaded";
  - written as the progress Prepare and the download write (`probed: true`), never over a download running in this
    visit; a store another tab's game holds, OPFS unavailable or an error: unknown, nothing written.
- **Persistent storage** (`src/host/web/storage-persist.js`, page side only — `persist()` does not exist in workers):
  `pageStorage().ask()` once a page before its first write of game data — the home's Prepare / download
  (`Downloads.start`), the Windows game's start (`main.js`), the GoldSrc and re3 pages' `start()`, the OpenMW page's
  `enter()` (its `window.orthrosStorage`, which the engine page's perf records take: `frame-meter.js`, the same
  origin — so they report `asked` like the other runtimes). Chrome grants
  or refuses silently (the site's engagement, a bookmark, an installed app), no prompt. The data manager's button stays.
- **Telemetry**: `{ storage: { persisted, usageMB, quotaMB, asked } }` in the env of every runtime — one builder,
  `withStorage`: the Windows page's batches (`flushTelemetry`), the ports' event records (`eventEnv` in perf-page.js,
  GoldSrc and re3), and the perf records of all four runtimes (`PerfSession`, read again after each record; the
  server's check keeps it, `src/host/perf-record.js` `ENV.storage`). MiB, not bytes (a quota to the byte tells the
  disk). Evictions show as a session whose store was found missing for a game played before — not reported yet.
- Measured (2026-10-27, `half-life-original-en`, scratch servers on localhost of main and of this change — each a copy
  of the learned files, `--br-cache off --covers off` —, headless Chromium, one persistent profile per run: the home,
  Play, the game running, the home again, then the home again told 85 KB/s; two runs each, after the review's fixes):

  | the card | main (2 runs) | this change (2 runs) |
  |---|---|---|
  | a fresh profile | "Playable after 3 MB (+ 3 MB of engine)", "Whole game: 430 MB" | the same |
  | after the play | "Playable after 3 MB (+ 3 MB of engine) · ~5 s", "Whole game: 430 MB · ~10-15 s" (20 s watched) | **"Ready: starts without waiting"** 1.51 s after the home was drawn (the probe's delay), "14% downloaded" (63.7 MB of whole blocks the session's prefetch stored) |
  | told 85 KB/s | "· ~30 s", "Whole game: 430 MB · ~1 h 6 min" | "Ready" (kept from the visit's probe), "14% downloaded · ~57 min more" |

  The telemetry's env (this change; main's has no `storage`): `storage: { persisted: false, usageMB: 0, quotaMB: 10240,
  asked: true }` on the game's start, perf and end records, `usageMB: 62, asked: false` on the later home records
  (headless Chromium refuses persist(): no engagement). A Play clicked 0, 1.3, 1.5, 1.55, 1.6, 1.7 and 2.5 s after the
  home was drawn, on a profile holding the store: the game running each time, no console error. Not measured: a real
  player's Chrome (whether persist() is granted), Morrowind's 3.9 GB store (the probe's open and count time), a probe
  recounting on a thin link (the 85 KB/s home kept the visit's result) and a store of light copies probed on a fast
  link in a browser (unit tests only: `tests/download-worker.test.js`, `tests/launch-set.test.js`).

## Precompressed units (2026-10-21)

Every request of `/gamez` used to be compressed on the fly (zstd-3, else gzip-4; 256 MB of encoded ranges kept in
memory). Behind Cloudflare the origin only ever sees `Accept-Encoding: gzip, br` (no zstd): production sent gzip-4,
wire/raw 0.69 over 21,740 requests. Brotli at quality 11 saves far more, but costs 1.7-4.8 s of a core per MiB — never
on the request path. So the server keeps **units** compressed ahead, for every game and runtime
(`src/host/br-cache.js`):

- **A unit** is a whole 1 MiB block of a file version (its tail for the last block) or a single 64 KiB piece, of the
  file or of its light copy (`unitOf` in `src/vfs/http-backend.js`: the shapes the shared reader asks for). Independent
  brotli streams cannot be joined (each has its own header and last meta-block, and a piece compressed alone uses the
  static dictionary where joined pieces would back-reference): one unit is one response, `Content-Encoding: br`,
  decoded by the browser.
- **Served** when a request is exactly a unit, accepts br and has no `pad` (in `sendRangeEncoded`, before the in-memory
  cache; it beats zstd on the fly too); `netStats.brHits` counts them (`/api/netstats`, with the cache's own `brCache`
  stats). A unit brotli makes less than 8 % smaller is kept as an empty `.raw` marker: sent as it is, never made again.
  A request that misses goes the dynamic way — zstd-3 if accepted, else **brotli quality 5** if accepted (~14 % fewer
  bytes than gzip-4 for ~+8 ms per MiB), else gzip-4 — and asks for its unit.
- **Made** by a forked child (`src/host/br-cache-worker.js`) niced to 19, one unit at a time (one core at most),
  pausing while the 1-minute load average is ≥ 24 or the disk is over 85 % full (it evicts meanwhile). Order: first
  the **launch sets** — each manifest's learned order (`/api/prefetch`, its launch set first, then earliest `t` first)
  up to its share of the first half of the budget, pinned (evicted last); the share by the launch set's size when a
  session marked the version (`pinShares`, 2026-10-21: an equal part of 768 MiB each held Morrowind Vanilla+'s ~156 MB
  launch set to 48 MB, evictable, while Half-Life's 2 MB left its part unused — with the live orders Morrowind gets
  220 MB, Half-Life 3.5, Vice City 24, the unmarked versions 44 each), the manifests walked side by side (the one with the fewest bytes made
  next: every head before any tail) —; then the live misses, the most asked first; then more of each order while the
  cache is under its low mark. A block learned whole (or without its pieces' mask) is a block unit, else its learned
  pieces are; a listed texture's light copy first (by pieces: a light copy is read on a link that is not fast). Rebuilt
  at start and every hour from the learned files. (The live misses used to come first: on the live server, 47 minutes
  after a restart, the misses' queue was full — 4044 of its 4096 — and the launch sets had not grown past their first
  6.3 MB; a miss is one session's read, served already, where every new player asks for the launch set.)
- **Kept** in `--br-cache <dir>` (default `<learn>/../brcache`, i.e. `/var/lib/orthros2/brcache` on the live server;
  none without `--learn`, `off` for none), at most `--br-cache-bytes` — unset: 1.5 GiB at least, grown to hold the
  launch sets (their home sizes summed, a version without one at their mean, ×1.25, as the pinned half), 8 GiB at
  most; `/api/netstats` `brCache.pinWant` / `pinCap`. (The fixed 1.5 GiB pinned 0.75 GiB where the catalog's 17
  versions want ~1.3 GB: on 2026-10-22 the live server's cache was full, its launch units evicting each other — 2-5 %
  of the GoldSrc and re3 launch sets made, `/api/netstats?launch=1`.) `<k[0:2]>/<k>/` per file version, `k`
  the sha1 of the file's resolved real path, size and mtime (and the light copy's shape: `LIGHT_SIDE`, size, offset —
  manifests sharing a `base/` file share its units), `meta.json` and `b<block>.br` / `p<piece>.br` files written
  through a temporary file renamed. The index is rebuilt from the disk at start. Over the budget, least recently used
  out (unpinned first) down to 90 % of it. Never stale: a changed size or mtime is another key, the generator checks
  the file before and after reading it, and a sweep (at start, hourly) removes the versions of files gone or changed.
- **Client** (`HttpBackend.fetchBackgroundNow`, `rangeUnits`): a compressed background range that covers several units
  goes as one request per unit, in parallel (HTTP/2 through Cloudflare: ~300 B of headers each), joined — whole blocks
  where they fit, else pieces (runs across a block boundary too), at most 16 parts; the download fails if any part
  does. On a link neither fast nor thin that carries a block in 1.25 s at most (`WHOLE_BLOCK_SECONDS`, `wholeBlockFits`:
  ~1 MB/s and up), a background run that is a whole block — every piece wanted, none here: the learned prefetch's
  pieces of a block learned whole, the pieces fetched ahead (`pumpAhead`), a stream's read-ahead from a block's start,
  the block fill — goes as the block, its unit, though it is more than `backgroundBytes()` (cut at it, the same bytes
  went as pieces, which the block unit made for them never serves). The game's own reads are unchanged: the
  synchronous XHR of a Windows game stays one request (on a slow link it is mostly a single piece already: a unit), and
  so do the parked asynchronous reads (`fetchForeground`).
- **Seen**: every `/gamez` answer of a server with units says `X-Orthros-Unit: hit | raw | miss | none` (none: not a
  unit's shape).
- **Probe**: a backend cuts its ranges only while the server has the units: the parts answered `hit` or `raw`, and a backend cuts its ranges while at least 2/3 of its recent parts hit (a moving share, 0.3 the
  latest request's), else one request in 8 — a probe, whose misses ask the server to make their units. Cut without
  units, a range costs more (pieces compressed alone; BFME2's archives, 384 KiB ranges: brotli-5 0.560 of the raw
  bytes by pieces against 0.533 whole, zstd-3 0.586 against 0.557; a brotli-11 piece 0.519): measured at 1 MB/s on
  BFME1/RotWK/BFME2 (headless, no br-cache, 2026-10-21), +3.9-4.9 % wire for the same files on 7 times the requests. The game's own reads are unchanged: the synchronous XHR of a Windows game stays one request (on a slow link it
  is mostly a single piece already: a unit), and so do the parked asynchronous reads (`fetchForeground`).
- **Measured** (one 1 MiB sample block per file, against gzip-4's bytes): brotli 11 per block 72 % (Morrowind.bsa
  40-69 %, gta3.img 67-68 %, Morrowind.esm 77 %, halflife.wad 86 %), per independent piece 80 %, brotli 5 on the fly
  86 %. Cloudflare passes a unit through unchanged (2026-10-21: `halflife.wad` block 1 through
  orthros.chalco.website, `content-encoding: br`, 594,542 bytes — the unit file's size — decoded to the file's bytes).
- **Measured, shapes** (2026-10-21, fresh profiles through a proxy sending the origin `Accept-Encoding: gzip, br` as
  Cloudflare does): the requests are units already — Morrowind FR at 1 MB/s 2917 of 2919 (150 s), at full speed 1857
  of 1857, Vice City reVC 363 of 363, Half-Life 61 of 61, Vice City (Windows) at 1 MB/s 430 of 439 (the 9 others: its
  synchronous reads of piece runs, 2.4 MB of 34). What missed was **the shape**: the units made from the learned order
  are blocks for blocks learned whole, but a 1 MB/s link asked them as pieces (`backgroundBytes()` 512 KiB): of the
  bytes the Morrowind session asked, 82 % were of blocks made as block units, asked by pieces.
- **Measured, hits** (same script, the cache filled with the two manifests' learned orders first — 3020 units, 300 MB —,
  Morrowind FR, 1 MB/s, 50 ms, 150 s, solo): before, 221 hits of 2934 requests, 6 % of the bytes, 109.2 MB on the wire
  for 180.2 MB (0.606), the world in 88.9 s; after, 885 hits of 1274 requests (+132 kept raw), 72 % of the bytes, 124.4
  MB on the wire for 219.7 MB (0.566), the world in 72.8 s (one run each). Vice City (Windows) at 1 MB/s, 100 s (its
  intro movies: brotli saves nothing there): its 20 synchronous reads 227 ms on average, 601 ms at most before, 227 and
  598 after (measured at the client's end of the link); 465 requests before, 334 after, 26.8 and 26.6 MB on the wire. At
  full speed (no change there) 1566 hits of 1857, 66 % of the bytes; most of the rest, 77 MB, blocks learned by
  pieces that a fast link asks whole — not made ahead (1473 of Morrowind's 1830 learned blocks are known by pieces:
  about three times the brotli work), made from the misses after the launch sets.
- **Measured, generation**: 3020 units (600 MB of file bytes, 300 MB made) in 26.5 minutes of one niced core,
  ~1.4 GB of file bytes an hour; the live server ~76 units a minute while not paused. Brotli 10 instead of 11 (sample
  blocks of Morrowind, GTA, Half-Life data): 2 % more bytes for 0.6× the time — kept at 11.

## Audio units (2026-10-21)

Uncompressed sound (PCM) is what brotli does worst: a waveform has almost no repeated strings (Vice City's
`Audio/sfx.RAW`, 15 MB of its 17.5 MB launch set: brotli 11 per block 0.81 of the bytes). A unit that holds sound has
a second form made beside its brotli one, coded by linear prediction and Rice codes of the residuals — lossless,
written from scratch (`src/vfs/pcm-codec.js`) —, for every game and runtime alike:

- **Which bytes are sound** (`src/host/pcm-units.js`, by format, no file name looked at): every RIFF WAVE sound in a
  file — a `.wav`, or one stored as it is inside an archive (EA's `.big`: BFME's sounds are 16-bit WAVE members) — whose
  format chunk says integer PCM (tag 1, or WAVE_FORMAT_EXTENSIBLE's PCM subtype), 8 or 16 bits, mono or stereo: its data
  chunk (found by one scan of the file per version, kept in the unit directory's `waves.json`). ADPCM, MP3 and the rest
  are left alone. A file with no such sound (a raw bank such as `sfx.RAW`, its rates in another file) is tried as
  16-bit mono, 16-bit stereo and 8-bit mono — the most promising by a quick order-2 estimate, coded only if the estimate
  is under 0.9 of the brotli unit —: the coding is lossless whatever the bytes are, so the only proof asked of "this is
  sound" is that it codes smaller.
- **The codec** (container `OPC1`: segments of bytes as they are and of coded samples, the decoded length and its
  CRC-32): frames of 2048 sample frames, per channel the cheapest of constant, verbatim, fixed polynomial predictors of
  order 0-4 and linear predictors of order 2/4/8/12 (Levinson-Durbin over a windowed autocorrelation, coefficients of 12
  or 14 bits), the residuals Rice-coded in 2^p partitions with an escape to fixed width; stereo as left/right,
  left/side, side/right or mid/side. Higher orders (to 32) gained 0.7 %, 4096-sample frames lost 0.5 %.
- **Made** by the units' generator (`br-cache-worker.js`), after the brotli unit (or alone for a unit made before):
  checked by decoding it, brotli on top (quality 4 — coded samples do not compress —, 11 when a twentieth of the unit or
  more is other bytes: headers, other members), kept as `<unit>.pcm.br` when it is at most 0.95 of the brotli unit's
  wire bytes, else an empty `<unit>.pcm.raw` (never tried again). Not tried when sound is under 15 % of the unit; never
  for a light copy. Cost: ~0.5 s of a core per MiB on top of brotli 11's ~2.9 s.
- **Asked and served**: the shared reader (`HttpBackend`, every runtime's) adds `&pc=1` to its compressed ranges; the
  server answers such a unit-shaped request with the audio form when it has one (`Content-Encoding: br`,
  `X-Orthros-Codec: pcm1`, `X-Orthros-Unit: hit`), else as before — an older page never gets one. The reader decodes it
  (`unitBody`) before the bytes reach its blocks, the store or the game; an answer that does not decode (or whose CRC
  does not match) turns the audio units off for that backend and the range is asked again without. A body of the
  wrong length that starts as a container is decoded too (a proxy that dropped the header). The home's "playable
  after" counts the audio form's bytes (`brCache.size`).
- **Measured** (`tools/audio-units.mjs`, a copy of the live learned orders of 2026-10-21, every container decoded and
  compared; the units the generator keeps, brotli 11 against the audio form): the launch set as a thin link reads it,
  and the whole learned order as a fast one does —

  | version | launch set: audio units' brotli 11 → audio form | learned order |
  |---|---|---|
  | Vice City reVC / Orthros Edition (re3) | 9.01 → 6.61 MB (−2.39 MB, −27 %; sfx.RAW, by trial) | 13.11 → 10.32 MB (−2.79) |
  | Vice City (Windows) | — (no flagged launch set) | 15.65 → 12.67 MB (−2.98) |
  | BFME 1.03 / 1.08 / vanilla (stale, mask-less) | 0.24 → 0.21 / 0.35 → 0.30 / 0.91 → 0.78 MB | 11.71 → 9.38 / 3.69 → 3.17 / 63.16 → 52.58 MB |
  | BFME2, RotWK 2.01 / 2.02 | 0.27 → 0.25, 0.31 → 0.27 / 0.35 → 0.30 MB | 0.76 → 0.59, 0.31 → 0.27 / 0.40 → 0.33 MB |
  | Counter-Strike Arsenal / rebuilt, Half-Life (8-bit WAVs) | 0.11 → 0.10 MB each (the sounds come after) | 2.81 → 2.31 / 1.67 → 1.39 / 1.83 → 1.49 MB |
  | Morrowind GOTY EN / Vanilla+ EN / FR | 0.04 → 0.02 MB | 1.93 → 1.51 / 1.85 → 1.45 / 3.00 → 2.47 MB |

  Vice City reVC's whole launch set through the server (`/gamez` answers of every one of its 41 units, with and
  without `&pc=1`, their bodies decoded and hashed against the file): 12.82 → 10.44 MB on the wire (−18.6 %; 151 →
  123 s at 85 KB/s); the shared reader prefetching it decoded its 14 sfx.RAW blocks in 314 ms (47 MB/s). In Chrome
  (`tools/re3/check.mjs vice-city-revc --new-game` against a server of this tree, its units made first): menu and new
  game as before. Decoding: ~50 MB/s of decoded bytes on one core of this machine under load 25-30 (a MiB unit in
  ~20 ms — 2 % of the second it takes to cross a 1 MB/s link).

## The page, the engines and the covers (2026-10-21)

Measured with headless Chromium on a local server (Playwright, every response's body bytes):

- **The page's own files** (`src/`, no build step: the browser loads the modules as they are; `sendSource` in
  `server.js`): `Cache-Control: no-cache` (a new tree is new code at once), now with an `ETag` (`W/"size-mtime"`)
  and `If-None-Match` / `If-Modified-Since` answered 304; a text file goes brotli 11 once made (in the background at
  its first request, kept in memory by size and mtime: the tree's text is ~4 MB). The Win32 page loads 381 modules
  (150 unique: each worker loads its graph again): 8313 KB of bodies at every visit before; 845 KB on a first visit
  (warm server), 0 on a return (every module a 304). The home: 500 KB, then 164, then 0. (A versioned, immutable
  `/src` would also save the ~380 conditional requests of a return; not done: the absolute `/src/` URLs of the pages
  and workers would load a module twice under two URLs.)
- **Engine releases**: `tools/engine-br.mjs <release>` writes `<file>.br` (brotli 11) beside each compressible file
  (not the archives, not `gamefiles/`, which the server lays over the game's files); the install and build scripts run
  it (`tools/goldsrc/install-engine.py`, `build-modules.sh`, `tools/re3/build.sh`). The server already sends a newer
  `.br` to a browser that takes it and counts it on the card. Card: Half-Life 7.60 → 3.20 MB, the arsenal
  19.70 → 14.35, Counter-Strike rebuilt 13.18 → 8.08, Vice City 4.05 → 1.02. Half-Life shown at 1 MB/s (CDP
  throttle, fresh browser, local server sending the engine as it is): 26.8 / 22.4 s → 14.9 / 14.5 s; the arsenal
  39.9 / 41.5 → 34.5 / 37.2 s. (Behind the reverse proxy the engine went gzip on the fly: the gain there is the
  brotli-11 / gzip difference, 0.4-0.6 MB per engine.) Starting the arsenal's extras (12.9 MB of pk3) beside the
  startup files instead of after them: 43.5 / 43.4 s against 39.9 / 41.5 (no gain on a saturated link): not kept.
  Served as game data read by pieces instead (2026-10-22, the server listing them under `_engine/` of the tree): the
  engine reads its three archives whole before its menu (extras 1.48, bots 4.94, pokemon 6.48 MB, 88 requests), so
  nothing is saved and the first sessions wait for them read by read — 1 MB/s through tools/net-proxy.mjs, a fresh
  browser: menu 50.1 s / 36.4 MB / 11.1 s of demand wait against 42.2 s / 32.9 MB / 5.1 s: not kept.
  The page's game data opened and its startup set loaded beside the engine's download and start, the files mounted
  once the engine's file system exists (the same day, GoldSrc and re3 pages): at 1 MB/s Half Strike's startup set
  began at 4.6 s against 4.2 s and ended at 11.6 against 10.8 (the data worker's own modules wait behind the engine's
  download), so nothing came sooner; the menus (50.3 / 42.2 s) differed by the engine's boot on a loaded machine, the
  learned order filling the link meanwhile (more MB before the menu as it lasts longer): not kept.
- **Covers**: `/api/cover/<version>` sends a light copy once made (`src/host/light-covers.js`: 960 px wide at most,
  WebP, made by ffmpeg in the background, one at a time, niced, kept in `--covers <dir>`, default
  `<learn>/../covers`; `?full` the image itself; without ffmpeg the covers go as they are): the home's nine covers
  1737 → 388 KB.
- **Mask-less learned orders**: `tools/learn-prune.mjs <learn dir>` lists each order's mask-less entries (learned
  before masks: whole blocks — a thin link's learned pass skips them, a between link fetches them whole) and what each
  of its two rules would drop; a dry run unless `--write` (a backup kept; the server stopped meanwhile: it writes its
  orders back; `--list`: each entry's verdict). A mask-less entry is not "a block no recent session read": it is also
  the only record of a phase no recent session reached — the first version of the tool dropped every mask-less entry
  of an order with ≥ 50 masked ones, and the prune of 2026-10-21 took BFME II's map load out of its order
  (docs/startup.md "Why RotWK 2.02 and BFME II waited"; that flag, `--min-masked`, is now refused). An entry goes only
  when proven stale:
  - `masked-duplicate`: the same block (path case-insensitive, `\` = `/`) has a masked entry in the order — learned
    again since masks exist (the dropped entry's earlier time goes with it; the masked one keeps its own).
  - `passed-unread`: at least `--sessions N` (3) of the `--recent K` (10) latest sessions went through the entry's time
    and phase without reading it — the session reached the entry's time, and entered one of its phases (`ph`) or, an
    entry without phases, read half of the order's masked entries learned within `--window` ms (5000) of it, at least
    `--min-neighbors` (3) of them: a phase no recent session reached has no masked neighbours, so it stays. It needs
    per-session reads, `sessions-<manifest>.json` beside the order (`[{ id, reached, phases: [[phase, start]…], read:
    ["path#block"…] }…]`, oldest first). The server keeps none on disk (its sessions' read sets are in memory only;
    `phases-<manifest>.json` counts phase starts, not reads): without that file the rule refuses and drops nothing.

  On a copy of the live orders (2026-10-23): only bfme-vanilla still has mask-less entries (663 of 698): none dropped
  (no duplicates, rule 2 refused). The 2026-10-21 backup of bfme2's order (636 mask-less of 860): 114 entries
  `masked-duplicate` (the same block learned again under another case, e.g. `lang/english.big#0` /
  `lang/English.big#0`), 522 kept — where the first prune dropped all 636.

## Silence during a load (2026-10-26)

The owner's session (Morrowind Vanilla+ FR, ~1.5-2 MB/s through Cloudflare, ~90 ms round trip, warm OPFS store, a save
loaded outside the learned area): one frozen frame of 58 s, 253 serial demand reads (median spacing 205 ms against a
93 ms round trip), 14 MB the game needed — while the background sent 116 MB beside them (full-resolution texture
upgrades, learned blocks of other places, movies never played, full-size loading screens, music). Between thin and fast,
a background turn opened in every gap between two reads of the load (nothing in flight: any request may start, a whole
block included), and each next read shared the link with it. Stage 1: while the game is blocked in a dense run of real
waits, the background carries only what that load needs. Generic: the rules depend on the link and the reads only.

- **Waits, not requests** (`NetLink.wait` / `waitEnd`): fed by the reads the game is blocked on — a Win32 parked read
  (`kernel32-file.js` ReadFile → `HttpFile.prepare(…, true)`), any synchronous read (`HttpBackend.fetchRangeNow`), a
  page's read its engine waits for (`data-worker.js` `waited`: a synchronous one, an asynchronous one while `held`).
  Never a media file's (`isMedia`): a movie's or a track's misses are no load — counted as one, they silenced the
  stream's own read-ahead, which then went a round trip at a time for the whole movie. A demand request is not a wait: `readable()` / `ensure(background)` fetch ahead with nobody waiting (OpenMW's preloads,
  re3's streaming), they must not silence anything.
- **A load** (`NetLink.loading`): a wait in flight, or `LOAD_WAITS` (3) waits begun within `LOAD_WINDOW_MS` (4 s), the
  last one ended less than `loadGap()` ago — `max(LOAD_GAP_MS 500 ms, 4 round trips)`, and `LOAD_HOLD_MS` (2 s) once
  the run has lasted `LOAD_LONG_MS` (4 s): a long load's engine work between two reads (a save parsed, a scene built)
  is no end of it — each such pause released every queued download into the load's next reads. One wait in play
  silences nothing past its own end. `NetLink.silenced()`: a load on a link that is not fast (a fast link keeps its policies).
- **The gate** (`NetLink.mayStart` / `kick`): while silenced, only turns promoted by a parked read (`urgent`: one that
  waits for a request still queued — no deadlock) and turns flagged `forLoad` start; the others stay queued, skipped
  without holding up a `forLoad` one behind them, and the timer (every 250 ms at most) releases them in priority order
  once the load is over. A `forLoad` turn follows the between-link rules (nothing in flight: it starts whatever its
  size — one queued before the load, at a free link's size, would otherwise wait for the load's end with the load's
  smaller ones behind it); those made during a load are small: `NetLink.requestBytes()` — 2 round trips of the link, not
  `BG_SECONDS` —, and `HttpBackend.wholeBlockFits()` is false (a parked read never waits for a whole block on its way).
- **What a load needs** (`forLoad`): the learned pieces ahead of the game (`pumpAhead`) while its position in the learned
  order is followed — `L.tracked` (`HttpBackend.noteBlock`): `TRACK_STEPS` (2) first touches in a row going forward by
  at most `TRACK_WINDOW` (64) ranks, and at least `TRACK_SHARE` (half) of the last `TRACK_SPAN` (8) blocks touched first
  in the order; a first touch at most `TRACK_BACK` (8) ranks behind the position (the engine's threads out of order) is
  neither a step nor a jump; a jump elsewhere in the order, `TRACK_MISSES` (4) blocks in a row outside it (a place
  earlier sessions did not load, a save file), or too few in it, and it is lost; not followed and loading, `pumpAhead`
  sends nothing. An ahead turn's `forLoad` is read when its turn is looked at (a getter), not when it was queued: those
  queued before the position was followed go during the load once it is, those queued while followed wait once it is
  lost.
  Never a media entry at the order's tail (`e.tail`: never ahead at all). The read-ahead of a file read in sequence that
  is not a media file — one request ahead of a reader of fewer than `STREAM_READS` reads in sequence (an archive's
  entry read in a few pieces: the bytes past it are other entries the load may not read), two of a longer one. The
  startup set a page waits for (`prefetch` `learnedOnly`).
- **Not during a load**: the learned order's background pass (tier 1 and 2, the media tail), the block fill (`want`,
  `near`, `later`), the upgrades of light copies, the offline copy, the read-ahead of a media stream. `fillBackground`
  checks `silenced()` before whichever queue is next (so `want` cannot open the way for an upgrade).
- **A media stream's read-ahead** (`readAheadParts`): `MEDIA_AHEAD_SECONDS` (8) of its reader's own rate,
  `MEDIA_AHEAD_MIN` (256 KiB) at least — a 20 KB/s track took 4 MiB (2 s of the link) at once.
- **Pictures** (`isLightPicture` in `src/vfs/game-tree.js`, by format): a TGA's light copy is a picture of a screen's
  size (`light-copies.js` lightens a TGA only from `TGA_LIGHT_FROM`: a loading screen, a map). On a link that is not
  fast, `HttpBackend.upgrade` never fetches its file after it (shown a moment, often never again; OpenMW draws a new
  random splash every 5 s, each upgrade ~3 MB, LIFO so first): it comes with the offline copy, or read itself on a
  fast link. `stats.pictureKept` counts them.
- **The learned list made again** (`HttpBackend.prefetch` `opts.relist`, `data-worker.js` `prefetchAll`): the list
  (`launch-set.js` `launchFirst` / `forLink`: light copies or the files, media at the tail or not) is made for the
  link's class when the pass starts; the rate it starts with is the browser's (`orthros.netBw`, any game's, any page's).
  When `NetLink.fast()` changes from the class it was made for, the pass stops and starts again on a list made for the
  new class (`stats.relists`): at once for a list made before the link was measured, else once the new class has held
  `RELIST_HOLD_MS` (5 s; a rate near `FAST_BPS` goes back and forth), `RELISTS` (2) times at most; the new list keeps
  the game's position, the entries it touched, its tracking and the progress counted.
- **Which producer carried what** (`NetLink.bgBy`, in `NetLink.snapshot()`: the Win32 worker's `net` stats, the data
  worker's `{ net }` message every second → `GameData.snapshot().net` → OpenMW's `window.__streamfsStats.net`): per
  reason — `pf1` / `pf2` (learned pieces / rest of their blocks), `pf` (whole learned blocks, fast link), `ahead`,
  `readAhead`, `mediaAhead`, `miss`, `want`, `near`, `later`, `upgrade`, `offline` — requests, wire and decoded bytes,
  and `inLoad`: the wire bytes of those begun during a load. With `waits` / `waitMs` (the game's real waits) and
  `loading`. No reason in the URL (counters only).

Measured (tools/openmw/place-load.mjs, a returning player's warm store, 1.8 MB/s and 90 ms round trip, two runs
each, the load of Ald'ruhn -2,6 outside the learned order): the frozen load does not change — 37.3-37.5 s for a COE,
40.5-41.5 s for a save loaded from the menu, 340 serial reads 107 ms apart, latency-bound —; the background during it
2.25 → 0.43 MB (save from the menu) and while frames resume 2.0-2.7 → 0.4-0.6 MB. The owner's session (2026-10-26:
116 MB of upgrades, Video/, full Splash pictures and Music during a 58 s save load, reads 205 ms apart against a 93 ms
floor) is not reproduced by these warm profiles: the rules are kept as the guard for it, unmeasured there.

## Announced reads (2026-10-26)

Stage 1 silenced the background, and the load stayed as long (`tools/openmw/place-load.mjs`, a returning player at
1.8 MB/s and 90 ms, COE from Seyda Neen to Ald'ruhn -2,6): one frozen frame of 37.4 s made of 340 serial synchronous
reads (174 .nif, 153 .dds — light copies on that link —, 7 .kf, 6 archive headers), each a round trip (93 ms to the
first byte) plus ~4 ms of the engine's work; 9.4 MB decoded, 5.9 MB on the wire. Fetched in parallel, those bytes take
3-4 s on that link. The engine knows what a load reads before it reads it (the cells' references, their models, the
textures those name): it says so first, the game data fetches all of it in parallel, and the engine waits once.
Stage 2: the transport (any runtime) and the OpenMW page; the engine side is its own patch.

**The contract** (the engine calls, on the page's thread; absent hooks: nothing announced, no wait):
- `globalThis.orthrosWillRead(list, label) → int`: `list` UTF-8 records separated by `\x1E`, each
  `enginePath\x1Foffset\x1Fsize` — the path the engine opens (an archive's for a file in it, with the member's range;
  a loose file's own), size -1: to the end. `label`: `<kind>:<place>`, kind `meshes` | `textures` | `terrain`, place
  `x,y` for an exterior cell or the lowercased interior id (`meshes:-2,6`). Returns how many records are not in the
  page yet (0: nothing to wait for); they are fetched at once.
- `globalThis.orthrosReadWait(timeoutMs) → int`: spins until every record announced since the last wait is in the data
  worker (stored, or failed: the engine's own read then says what failed) — 1 —, or `timeoutMs` passed — 0 (the
  engine reads all the same; what is missing comes by its reads).
- The engine announces in its scene changes before it loads cells (models of the cells' references, their land
  textures), waits (bounded), then announces the textures the now-local models name, and waits again.

**The page** (`src/vfs/data-client.js`): `GameData.want(entries, label)` (`entries` `[{ h, off, len }]`) and
`GameData.wantWait(timeoutMs)`; OpenMW's hooks (`src/ports/openmw/streamfs.js`) map the engine's paths to handles as
`orthrosRangeReady` does (unknown paths left out). A file with a light copy is announced as what its next load reads
(`nextPick`: `pick`'s rules — `readsReal`, `GameData.reloads`, the link's class, `prefer`), and that choice is pinned
for that load (`h.pin`, honoured by `pick` at the load's first read within `PIN_MS`, 60 s, unless the file itself is
here: the announced transfers may push the link's measure across `FAST_BPS` during the wait, and the other copy was not
fetched): on a link that is not fast its light copy, whole (a texture is read whole; never the file itself there). Bytes already in the page are not announced. One batch per call, numbered.

**The worker** (`src/vfs/data-worker.js` `want`) hands each version's entries to its reader,
`HttpBackend.wantList(list, { label })` (`[[path, start, end]]`, end -1: the file's end) — one promise per entry, true
once its bytes are here:
- each range's missing bytes as transport units (`unitOf`): a whole block when the range covers all of a block none of
  which is here (a file under 1 MiB read whole: one request, its unit), else its 64 KiB pieces — every request one
  precompressed unit on the server;
- in the list's order, `WANT_REQUESTS` (32; `WANT_REQUESTS_THIN` 8 on a thin link) requests in flight — the window, not
  the background's count: the engine waits for them next, so their turns are `urgent` (as a parked read's) and
  `forLoad` (they pass a load's silence);
- deduplicated: what is here (memory, the store) is not asked; a learned piece or a block on its way (`flights`,
  `blockFlights`, the fill's block) is joined — and promoted (`NetLink.promote`): a queued background flight that is
  not `forLoad` (prefetch, fill, a learned piece no longer followed) would else wait behind the silence the list's own
  wait makes, until the engine's timeout —, and asked only if that flight failed; every queued unit is registered in
  `flights` at once, so a parked read of the same bytes joins it — and makes it go first, past the window
  (`NetLink.promote` → the unit's `urgent`) — instead of a second request;
- kept like any background bytes (whole blocks and pieces in the store); retried `WANT_RETRIES` (2) times on a network
  failure (`retryWaits`' pauses), an answer refused fails at once;
- while any entry of a list is missing, one `NetLink.wait` (the engine waits for them: the rest of the background stays
  silent, stage 1); counted as `announced` in `NetLink.bgBy`, `stats.want*` in the backend.

**The wait** (shared memory: the page's thread spins, no message reaches it): `ctrl[12]` — the last batch settled, with
every batch of the current window before it (the window: the batches announced since the page's last wait, `from` sent
with each; the page waits for its last number) — so an older batch that timed out or hung holds no later wait —, `ctrl[13]` the entries not settled yet, `ctrl[14]` those
that failed since the start. The page's heartbeat check (`ctrl[3]`, `DEAD_MS`) ends a wait whose worker died (0).
`GameData.snapshot()`: `wants`, `wantWaits`, `wantWaitMs`, `wantTimeouts`.

**The server** (`src/host/server.js` `/gamez`): `&w=1` marks an announced range — not learned (announced is not read:
the learned orders and launch sets stay the reads'), answered from the precompressed units like any unit request,
encoded on the fly in its own queue (`want`, between the game's reads and the background's; a game's read joining one
moves it to the demand queue, an announced one joining a download moves that to `want`), counted in
`/api/netstats` as `want`. `tools/net-proxy.mjs`: kind `want` (`urlKind`, `summarize`, `loadWindow`'s `want` — the
load's own bytes, not background).

The label goes to the worker with each batch (`W.wantLabel`, `stats.wantLabel`): the learned places (stage 3) will key
on it. While a list is missing, nothing is fetched ahead from the learned order either (`pumpAhead`, even for a list
announced with `wait: false`): the engine said what its load reads; the order's guesses go once it is here.

**Measured** (2026-10-26, `place-load.mjs`, the same warm profile, pristine learned order and link — 1.8 MB/s, 90 ms —,
two runs each; the engine `orthros-r10.patch` as a scratch release; C: COE Seyda Neen → Ald'ruhn -2,6, S: a save made
at Ald'ruhn loaded from the menu with F9):

| scenario | frozen frame | serial reads in it (p50 spacing) | announced: waits, wire | background in it |
|---|---|---|---|---|
| C baseline / stage 1 | 37.4 s | 340 (107 ms) | — | 0.03-0.23 MB |
| C stage 2 | 4.8-5.4 s | 0 | 3 waits, 4.4 s; 392 units, 11.6 MB decoded, 7.5 MB wire | 0.9-1.1 MB (read-ahead past archive members) |
| S baseline | 40.7-41.5 s (key → world 42 s) | 340 (108 ms) | — | 2.25 MB |
| S stage 1 | 40.5-40.8 s (41.5 s) | 340 (108 ms) | — | 0.4 MB |
| S stage 2 | 8.3-8.5 s (key → world 9.3-9.6 s) | 0 | 3 waits, 4.5 s; 404 units, 11.7 MB decoded, 7.5 MB wire | 3.2-3.3 MB |

The announced bytes go at ~1.65 MB/s of the link's 1.8 (the gap: the NIF parse between the meshes' wait and the
textures'). More bytes than the serial reads took (11.6 vs 9.4 MB decoded): the distant chunks' and the grid's whole
lists, some never read in this load (not the NPCs' record inventories: listing autoEquip's likely choice per slot type
instead of every item — a merchant's stock — took C from 392 units / 11.64 MB to 390 / 11.59 MB, frozen 5.4 s, S
unchanged at 404 / 11.72 MB, frozen 8.3 s). A first probe without the NPCs' record inventory (an NPC met for the first time
has no inventory yet — its clothing and armor were then read one by one) left 66 serial reads (7.3 s) of body parts and
their textures in a 10.8 s frame. What remains in the frame after the waits is the engine's own work (parsing and
building ~850 files: ~0.4 s in C, ~3 s in S, under SwiftShader). Left: the sequential read-ahead past an archive
member (`a=1`, 0.3 MB of a wait), the learned pieces fetched during the NIF parse between the two waits (`p=1`, 0.3 MB
in S), the textures' upgrades to full size right after (S).

## Places learned from announcements (2026-10-26)

Stage 2 made a save's load wait once for what its engine announced (4.5 s of the 8.3 s frozen at Ald'ruhn, 1.8 MB/s,
a warm store; everything, on a new device). Stage 3 fetches it before the click, while the engine boots and the player
sits in the menu: the page predicts where the save will load (the OpenMW page reads its saves) and asks the server
what that place's load reads. The server learns it from the announcements themselves — the engine's own computation
for that place, exact and complete, unlike the demand reads a session happened to wait for (the learned order keeps a
block once per session; a place loaded second learns nothing of what it shares with the first).

**The route** (`src/host/server.js`, beside `/api/prefetch`, same manifest check — unknown: 404; a POST only for a
runtime whose engine announces, `PLACE_RUNTIMES` — `openmw` —, else 404: no place can be invented for the others):
- `POST /api/places/<manifest>` `{ session, place, kind, lang?, records: [[path, start, end]] }` — one announced batch
  (`kind` `meshes` | `terrain` | `textures`, `place` the label's: `x,y` or the lowercased interior id; `records` tree
  paths after the page's engine-path mapping, end exclusive, -1 to the file's end). Answer `{ kept }` (200); 400 a
  malformed report (no session or one over 40 characters, a place empty, over 64 characters or with a control
  character, another kind, records not a list), 413 a body over 2 MiB, 429 a reporter that made `PLACE_NEW_HOUR` (240)
  places this hour. Each record checked against the version's tree
  (`treeFileSize`): an unknown path, a range out of the file or not integers is dropped (counted). A light copy's path
  (`.light/…`) stands for its file, whole: the page picks light or real by its link when it fetches. A report of
  nothing kept makes no place. `lang`: a language the manifest declares (`markLang`), else none.
- `GET /api/places/<manifest>?place=<key>[&lang=]` → `{ place, lang, sessions, at, bytes, list: [[path, start, end,
  kind]] }`: the meshes, then the terrain, then the textures, each kind the last session's records in their order,
  then what earlier sessions announced and it did not; checked against the tree again (a release's files may change);
  cut at 4 times the version's median place (64 MiB at least, `PLACE_BYTES` at most): a place one client swelled is not
  all fetched by every player predicted there. `sessions`: its reporters.
  The language's own place, else another language's (the most recent: an exterior's files are mostly the same), else
  an empty list. Without `place`: the places known, `[place, lang, sessions, at, records]`, the most recent first.
- Not learned from `/gamez` `w=1` requests (an announced range is not a read, and a page that announces names its
  place): only from these reports.

**Who reports**: the reporter, as for the profile seeds (`seedReporter`: one client network, an IPv6 /64 as one; a
session on localhost by its id) — not the `session` string the page picks, which anyone can vary. A place's
`sessions` counts its reporters; a generation is one reporter's session (its batches of a load, and of a later visit).

**Storage** (`<learn>/places-<manifest>.json`, written by the learned files' timer, `armLearnTimer`, every 20 s at
most, atomically, serialized a slice of 64 places at a time and written asynchronously): per version a list of places
`[lang, place, at, reporters, gen, records, runs, by]`, each record `[kind, path, start, end, gen, rank]` — `gen` the
place's generation count when it was last announced, `rank` its order in that generation's announcements; `runs` the
last 32 runs of one reporter's generations (`[first, last, reporter]`), `by` its last 16 reporters.

**Bounds**: a report's first 8192 records, paths of 512 characters at most; `PLACES_MAX` (2048) places a version,
`PLACES_RECORDS` (200 000) records a version and `PLACES_RECORDS_ALL` (400 000) in all — memory (a record is a few
hundred bytes) and the file each tick writes (~60 B a record) —, a place out when over: the fewest reporters first,
then the least recently announced (a flood of one-report places evicts its own kind before a place several players
taught); a reporter makes `PLACE_NEW_HOUR` (240) places an hour. A place keeps the union of its generations' records
bounded with recency — a record none of its last `PLACE_KEEP` (4) generations announced out (an NPC met once, a
release's old file) once those came from two reporters at least (one network's sessions, however many, do not wipe
what others taught; alone, a player's own union stays, bounded below) —, then past `PLACE_RECORDS` (4096) records or
`PLACE_BYTES` (512 MiB of the files' own bytes) the oldest generations' first (Ald'ruhn loaded from a
save: 790 records, 134 MB of files with Vanilla Plus' textures — 8 MB on the wire at 1.8 MB/s, light copies picked).
`/api/netstats` `places`: `posts`, `records` kept, `dropped`, `gets`, `found`.

**Precompressed**: the units of the `PLACES_SEED` (32) places of a version the most sessions announced are made after
its launch set and before the rest of its learned order (`placeSeedUnits` in the br-cache's `sources`), in the shapes
an announcement asks them (`HttpBackend.wantRange` with nothing here: a block the range covers whole as the block, else
its pieces; a file's light copy first, whole). A version is a source once it has a learned order (as before).

Tests: `tests/places.test.js` (round trip and order, path checks, malformed reports, unknown manifest, union and
recency, bounds, languages, persistence across a restart, the seeded units served as hits, the runtimes that may
report, one network as one reporter, the version's record bound by value, the hourly new places, the served cut).

## Big loads light first (2026-10-27)

The owner's link is fast (4-15 MB/s through Cloudflare, ~80 ms): `NetLink.fast()` (≥ 3 MiB/s), so OpenMW read the
full-resolution textures, and since the announced reads a first visit of a place waits for all of them at once — at
Seyda Neen a new device announced ~96 MB of real files (Vanilla+ textures, 1-4 MB each): ~8-10 s frozen at 12 MB/s,
~19 s at 5 MB/s, against ~14-15 MB with the light copies. An engine that reloads in place loses nothing by reading them
light first: the files replace them a few seconds later. The rules (`src/vfs/data-client.js`, generic: the link, the
batch's sizes and the engine's ability only):

- **A big load** (`GameData.bigBatch`, over a whole wait window): the page's engine reloads in place
  (`GameData.reloads`), the page lets it (`GameData.lightFirst`, on by default; OpenMW's `?lightfirst=0`, on the
  engine page or the play page around it, turns it off) and did not say what its loads are for (`prefer`), and the
  files of the window that have a light copy and whose next load would read the file itself (not here whole, not in the
  page, no load of it under way) would hold the link more than `LOAD_BUDGET_S` (2 s): their bytes times the link's
  wire/file ratio (`NetLink.ratio`, ctrl[15]: the compressed ranges) against its measured rate (`FAST_BPS` before it
  is measured) — 24 MB of wire at 12 MB/s, 10 MB at 5 MB/s. Only those files count — what else the window fetches
  (meshes, archive ranges) is read as is either way and may be in the worker's store already (the page cannot tell).
  Small loads are unchanged (the files themselves on a fast link).
- **One verdict a window**: an engine announces one load in several lists before its one wait (OpenMW: a place's
  textures, then its land's — two `orthrosWillRead` in one expression, their order unspecified), each maybe under the
  budget, together over it. So `want` numbers its batch at once (the wait's window counts it) and returns how many
  entries are in the page as neither copy, but posts it with the window's others (`GameData.wantFlush`): at the wait
  (`wantWait`), or once the page's thread yields (an engine that announces and goes on); the verdict is the whole
  window's, and every batch of it is pinned by it.
- **Light first**: the big batch's files are announced as their light copies, whole, and pinned for their loads
  (`h.pin`, as any announced choice); the big-load state (`GameData.bigLoad`, `bigLoadNow`) makes the loads of that
  moment that were not announced read light too — the engine's preloads (`readable()`) — until `BIG_HOLD_MS` (5 s)
  after the end of the big window's own wait (`wantWait`), `PIN_MS` (60 s) after the announce if it never waits. A
  later announced window has its own verdict (a small one reads the files themselves on a fast link) and its wait does
  not extend the hold: loads less than 5 s apart do not chain it.
  A predicted place (`prio: 'place'`, fetched while the player idles) keeps the link's choice: the files themselves on a
  fast link.
- **The files after the load**: each light copy read tells the worker (`light`, `soon`: `HttpBackend.upgrade`), the
  latest first (LIFO). The upgrades wait for the load's end on every link (`HttpBackend.loadUnderWay`: the game blocked
  on reads — `NetLink.loading` — or an announced list still missing, of any backend sharing the link): on a fast link
  the stage-1 gate does not silence, and an engine spinning on its announced wait reads nothing — the game looked quiet
  1.5 s into the wait and an earlier place's upgrades competed with the batch. Then the game quiet `UPGRADE_SOON_QUIET_MS`
  (1.5 s), one block at a time.
- **Reloads paced**: the files here whole that the page read light (`lightReads`, kept by `pick`) reach the page's
  listeners (`onReal` → OpenMW's `orthros_file_updated`) `REAL_PER_TICK` (2) per 100 ms, the latest first — an engine
  reloads them over frames, not dozens in one. The other files the worker reports whole (the learned order, the whole
  download, a place's files, plain reads: hundreds a minute on a fast link) reload nothing and are not queued — the
  queue never grows past the textures shown light. The page's choice for the next loads (`realHere`) is updated at
  once for all. `GameData.reloaded()` counts the reloads done.
- **Counted** (`GameData.snapshot()`, OpenMW's `window.__streamfsStats`): `bigLoads`, `bigFiles`, `bigBytes` (the real
  bytes left for later), `reloaded`; the upgrades' bytes in `net.bgBy.upgrade`.

Tests: `tests/game-data.test.js` (a big batch light first and pinned, a preload of the moment light, small loads, places,
`prefer`, `lightFirst(false)`, an engine that cannot reload, the hold's end; a window of two lists each under the budget;
the wire ratio; a small load in the hold; the reloads paced, the latest first, only the files read light),
`tests/http-backend-want.test.js` (on a fast link no upgrade during an announced list's wait, then it goes).

Measured (2026-10-27, `tools/openmw/place-load.mjs morrowind-goty-vanilla-plus-fr --profile new --mode coe --rtt 80
--after 60`, COE from Seyda Neen to -2,6 on a new device, pristine learned state and brcache copies, the runs interleaved
before/after; before: `main` bc6163f; SwiftShader headless):

| link | variant | frozen ms | announced wire MB (decoded) | wantWait ms | big loads / files | upgrades in frozen MB | upgrades 60 s after MB | `reloaded` |
|---|---|---|---|---|---|---|---|---|
| 12 MB/s | before | 8383, 8816 | 69.8 (100.7), 71.7 (104.5) | 7129, 7484 | — | 0 | 0 | — |
| 12 MB/s | after | 2383, 2633 | 7.7 (12.1), 7.4 (11.7) | 1490, 1631 | 2 / 220, 216 | 0.11, 0.14 | 23.1, 23.6 | 106, 101 |
| 5 MB/s | before | 19983 | 80.0 (119.8) | 18730 | — | 0 | 0 | — |
| 5 MB/s | after | 3500 | 8.7 (14.1) | 2936 | 2 / 261 | 0.16 (+1.4 MB started in its last 0.3 s) | 40.9 | 97 |

The frozen frame 3.3-3.4x shorter at 12 MB/s, 5.7x at 5 MB/s; the announced bytes ~9x fewer; time to frames flowing
12.9-13.1 s -> 5.7-6.4 s (12 MB/s), 24 -> 7.8 s (5 MB/s). Upgrades: none during the announced waits; one or three
requests started in the frozen frame's last few hundred ms (after the waits, the engine still building the scene: the
gate is the load's lists, not the frame). In the 60 s after, ~23 MB (12 MB/s) / ~41 MB (5 MB/s) of full files and ~100
in-place reloads — about half the big batch's textures, paced. Hitches from the reloads: not measurable here (SwiftShader
draws most frames over 250 ms; `stallsOver250Ms` is dominated by it and no different before/after); to check on a GPU.
Not measured: `?lightfirst=0` (should match before), the owner's real Cloudflare link, scenario S (a save from the menu).

## What the page says

- While the game waits for the network (`net.waiting`: a parked read, the presenting thread blocked on a read, or a
  demand read in flight), the loading screen's line and the waiting box say "Downloading game data — 85 KB/s", the
  bytes received, and "about N min for this step" when the learned order tells the step's size
  (`src/host/web/net-status.js`). On a link below 512 KB/s they suggest the home screen's download.
- The bench banner adds "downloading game data 85 KB/s (14 MB received)"; the bench record carries `network` (measured
  rate, round trip, demand and background bytes and requests, time the demand reads were in flight) and each mark the
  bytes received by then; the result panel shows the connection.
- **Download first** (home screen, each game card): downloads the whole version — and the versions it requires — into
  the same OPFS stores before playing (`src/host/web/download-worker.js`, the learned order first, then every block;
  4 MiB requests), with size, measured rate, time left, progress; pause / resume, and resume on a later visit (the
  stored blocks are skipped; the progress is kept in `localStorage['orthros.download.<manifest>']`). Starting a game
  stops it first (the game's worker opens the same stores). Above it, **Playable after / Prepare** (see "Playable
  after"): the launch set only. The settings' "offline copy" still downloads in the
  background while the game runs (now through the same turns, after everything else).
- **Every runtime the same** (CLAUDE.md "Standardization", 2026-10-20): the browser ports read the same game data
  (`src/vfs/game-data.js` opens a version for the Windows games' worker, the download worker and the ports' data
  worker, `src/vfs/data-worker.js`); the download first and the offline copy (one choice for every game:
  `offlineCopy` in `src/vfs/data-client.js`) fill the same stores; the ports show the same indicator
  (`src/host/web/data-meter.js`) and the header's pill for the loading in the background (`shell.setData`).

## Measuring

`tools/slow-net-check.mjs` plays bench scenarios in a fresh browser profile over a simulated link and prints, per game
and speed, the phase times, the bytes (demand and background) and the measured rate:

```
node tools/slow-net-check.mjs --bench vicecity-drive,bfme2-skirmish --speeds 85k,1m,5m \
  --learn-from <copy of the live server's learn dir> --games-dir /srv/orthros/data/games
```

`tools/net-proxy.mjs` puts a player's connection in front of a harness server as the production front does (HTTP/2
over TLS — no six-requests-per-host queue of a local HTTP/1.1 server —, one shared link, a round trip, `Accept-Encoding:
gzip, br`, a log line per request): `node tools/net-proxy.mjs --upstream http://127.0.0.1:18431 --listen 18443 --rate 7m
--rtt 75 --log proxy.log`, then `headless.mjs ... --port 18431 --page-origin https://127.0.0.1:18443`.
Its log is one JSON line per request (wire bytes, `X-Orthros-Unit`, first byte, total) and one per data report carrying
a `playable` mark; a text answer the origin sends as it is goes gzip on the way, as Cloudflare does.

The data matrix — a new player in a fresh browser, per version × link, through that proxy: `node tools/data-matrix.mjs
--pristine <dir with learn/ brcache/ covers/: copies of the live server's> [--links 85k:150,1m:60,7m:75] [--only a,b]
[--win32-seconds 300]` (each run its own server on a copy of `learn/`, the units frozen — `--br-cache-frozen` —, the
browser through `tools/with-browser-slot.sh`; per run: first frame, menu / playable mark, in play, and up to the mark
the wire bytes by kind, requests, unit hits, demand-wait seconds). Prepare alone (the home's launch-set download) in
Node, no browser: `node tools/prepare-bench.mjs --pristine <dir> [--code <another tree>]`. The launch sets' unit
coverage of a server: `/api/netstats?launch=1`.

The harness itself: `--net <rtt ms>:<Mbit/s>` (85 KB/s: `50:0.68`, 1 MB/s: `50:8`, 5 MB/s: `50:40`; the simulated link
is shared fairly by the answers in flight, `src/host/sim-link.js`), `--net-trace <file>` (one line per range answered:
start, duration, demand/bg, file, range, bytes), and every `mark:` step prints the bytes sent by then.

## Measurements (2026-10-06)

Harness, page mode (`--ui --bench`), a fresh browser profile for each run (as a new player), the server with a copy of
the live server's learned data (`/var/lib/orthros2/learn`: prefetch order, programs, regions), simulated link with a
50 ms round trip. Times in seconds from the launch, from the page's marks: *menu* (the main menu on screen), *in game*
(the scenario's `play` mark: the first frames of play). "before" is main at a031b61 (same harness, same scenario fixes),
"after" this change. One run each unless noted; the shared machine adds noise (runs of the same build at 5 MB/s
varied by up to 40 s: the page sometimes stalls 20-30 s after the menu appears, in both builds — SwiftShader / GPU
process stalls under load).

**Vice City** (`vicecity-drive`, 1.5 GB):

| link | before: menu / in game | after: menu / in game | after: received by then |
|---|---|---|---|
| 85 KB/s | 1427 / 1875 (the 900 s bench limit of the incident: menu not reached; 75 MB sent, 89 % background, demand reads 4.8 s each) | 808 / 1117 (another run: 845 / 1145) | 61 / 84 MB |
| 85 KB/s, second launch (same browser) | — | 57 / 85 | 1.6 / 2.7 MB |
| 1 MB/s | 125 / 168 | 83 / 163 | 70 / 124 MB |
| 5 MB/s (4 pairs run at once) | 50, 50, 51, 50 / 70, 107, 69, 109 | 49, 44, 66, 61 / 105, 100, 111, 103 | 120-157 / 232-251 MB |
| local | 62 / 79 | 61 / 79 | |

Local link, other games (plain 240 s runs, fresh profile, first Direct3D frame, before / after): BFME II 83 / 83 s,
BFME 107 / 104 s, RotWK 102 / 102 s (a first pair gave 102 / 180 s: the game's own first-launch computation, no network
wait in either run — the second pair 102 / 102 s).

**BFME II** (`bfme2-skirmish`, 6.9 GB):

| link | before: menu / in game | after: menu / in game | after: received by then |
|---|---|---|---|
| 85 KB/s | 781 / 1456 (first image 747 s) | 501 / 753 (first image 478 s) | 36 / 56 MB |
| 1 MB/s | 190 / 340 (505 MB sent) | 167 / 297 | 121 / 222 MB |
| 5 MB/s | (the scenario stuck at the profile dialog twice) | 149 / 354 | 379 / 390 MB |

At 85 KB/s the link now carries what the game reads (and what earlier sessions read next) at the link's rate
(measured 80-89 KB/s): Vice City needs ~60 MB to its menu (its first-launch reads: hundreds of mission sound files, the
sound bank, the intro movie it plays) — 12 minutes at that rate is the physical floor, 13.5 reached. The second launch
reads everything locally (pieces and blocks kept in OPFS). At 5 MB/s and on a local link the fast policies apply (as
before). At 5 MB/s the menu comes as soon as before, but every "after" run had the 20-30 s page stall after the menu
(half of the "before" runs did): its time in game is not settled (pairs: +35, −7, +42, −5 s) — to look at again
(what stalls the page's main thread there: the harness's evaluations stop too; coalescing the render worker's frames
on the page did not remove it). The bench's waits read the page's stats, so a stalled page also delays the `load` and
`play` marks: the time in game at 5 MB/s is an upper bound in those runs.

The home screen's "download first" was checked in the page over a simulated 1 MB/s link: progress, measured rate and
time left update every 5 s (~950 KB/s, "about 24 min left" for Vice City's 1.5 GB), a reload shows "1% downloaded (27 MB
of 1.5 GB) · about 24 min more" with Resume, which continues from 27 MB; Pause stops it.
