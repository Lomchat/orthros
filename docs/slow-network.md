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
  requests of the link's size (`readAheadParts`, 2 s of the link ahead) — until it is read whole: see the next item.
- **A file read whole takes whole blocks on any link** (2026-10-27, `readAheadParts` `whole`): not a media file, its
  reader at `STREAM_READS` (16) reads in sequence or more, and its run past `STREAM_BYTES` (1 MiB) from the file's start
  or past `WHOLE_RUN` (4 MiB) from anywhere (an engine reading its master file from start to end: OpenMW's ESMs; a run
  of an archive's adjacent entries — a .big, .img, .bsa, .pak — rarely starts at offset 0 or lasts 4 MiB). The
  read-ahead then asks each block past its reader's as the whole block — one request, the server's block unit (brotli
  11 over 1 MiB: ~10 % fewer bytes than its sixteen piece units, ~25 % fewer than pieces compressed on the fly;
  Morrowind.esm 28.2 MB as 77 block units against ~30.7 MB as piece units) — even where `wholeBlockFits()` is false (a
  thin link, a block slower than 1.25 s, a load). The blocks are counted from the first past the reader's position's
  block — a read that ends on a block boundary (the data worker's reads end where the bytes here end) makes the next
  block the reader's own —: that one and `WHOLE_AHEAD_BLOCKS` (2) more, one during a load. Bounds on the speculation:
  - one whole block waits for its turn at a time (a 1 MiB request starts on a link that is not fast only when the link
    is free, `NetLink.mayStart`; a second one queued would hold every later background request behind it, `kick()`'s
    strict priority): in practice one on the link, one queued;
  - a queued one is dropped once its reader moved away (`HttpBackend.reader`: a read of another file, or elsewhere in
    this one, or past that block), so a run that ends leaves at most the block already on the link (kept: only a
    synchronous read of the same bytes aborts it — an abort throws its bytes away);
  - a block already on its way whole (`fetchBlocksAhead` of a moment when the link was fast, a missed block's, the block
    fill's `bgCur`) is counted, never asked again.
  The rest of the block the reader is inside goes by pieces as before, and so does a block with a piece here or on its
  way (its missing pieces). The background prefetch (`missingRun`) is unchanged. Against the load's two-round-trip
  requests (`requestBytes()`, "The gate" below), the reader of a file read whole wins: it reads that block next, and
  another read of the load queues behind one block at most (~4 s at 85 KB/s, ~0.8 s at 500 KB/s) — the price of the
  smaller bytes. Residual: the server learns these blocks as the game's reads (`a=1`), the unread rest of a block whose
  reader stopped inside it included. `stats.wholeAheads` counts the blocks asked so where the earlier rule would have
  asked pieces. Measured (2026-10-27, `tools/data-matrix.mjs --links 85k:150,500k:90 --only
  morrowind-goty-vanilla-plus-fr`, page language en, main a9aae1b against this tree, the same frozen copy of the live
  learned state and units — every Morrowind.esm block unit there, 202 of its piece units; the engine's lean package is
  rule 2 on main and rule 3 here, docs/openmw.md, so the engine's bytes are counted apart; up to the menu shown; one run
  at 85 KB/s, two at 500 KB/s):

  | | 85 KB/s before → after | 500 KB/s run 1 | 500 KB/s run 2 |
  |---|---|---|---|
  | menu shown (s) | 998.8 → 684.6 | 172.2 → 146.9 | 203.5 → 187.6 |
  | Morrowind.esm on the link (s from navigation) | 191–793 → 147–503 | 44–143 → 36–104 | |
  | Morrowind.esm wire (MB), requests | 33.95, 1219 → 28.31, 152 | 32.49, 529 → 28.71, 174 | 33.23, 1054 → 28.58, 182 |
  | its 1 MiB whole-block requests | 0 → 73 | 13 → 66 | 10 → 67 |
  | Bloodmoon.esm / Tribunal.esm wire (MB) | 3.10 / 1.16 → 2.91 / 1.04 | 3.01 / 1.12 → 2.95 / 1.11 | 3.10 / 1.16 → 2.93 / 1.18 |
  | game data wire (MB), requests | 47.51, 1835 → 41.49, 621 | 49.95, 1053 → 46.11, 852 | 51.42, 1876 → 46.31, 677 |
  | `X-Orthros-Unit: hit` share of those requests | 23 % → 56 % | 29 % → 59 % | 27 % → 56 % |
  | engine wire (MB, rule 2 → 3) | 13.55 → 9.83 | 13.55 → 9.83 | 13.55 → 9.83 |
  | demand wait (s) | 32.2 → 32.2 | 5.0 → 7.6 | 6.5 → 5.3 |

  At 85 KB/s the master file reaches the browser in 356 s instead of 602 s: −5.6 MB (whole-block units, ~17 % smaller
  than the pieces mostly compressed on the fly) and ~1 070 fewer round trips, the link busier (76 KB/s average to the
  menu instead of 62). Of the −314 s to the menu, the lean rule 3 engine accounts for ~44–67 s (its bytes; its download
  ended 67 s earlier), the rest is this rule. The demand wait (the game's own reads) is unchanged at 85 KB/s and within
  the runs' spread at 500 KB/s (the gate's two-round-trip requests queue behind one block at most). bfme2 (archives) was
  not measured; neither `stats.wholeAheads` nor `net.silenced()` during the ESM read (the data worker's, not the
  runner's page stats): the proxy log's 1 MiB block-aligned `a=1` requests stand for the former.
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
  A texture whose level 0 overlaps one already taken (sorted by level 0's offset: a directory listing the same lump
  twice, or pointing into another's bytes) is left as it is (2026-10-28): each texture redrawn once, and the copy's
  reader, which finds the textures a range touches by a binary search over their level 0, sees them sorted and
  disjoint — any range of the copy then reads the same bytes. None of the 45 WADs installed (GoldSrc games and engines)
  has such an entry; a guard for the archives the runtime has not seen (`tests/light-copies.test.js`).
  A BSP v30 map (GoldSrc's) has none, although its texture lump holds the same miptex (tried 2026-10-28, per 1 MiB block
  at brotli 9: c1a0 1.37 → 1.10 MB, de_dust2 1.00 → 0.75, de_airstrip 3.86 → 2.82; 85 KB/s, c1a0: its waits 16.9 →
  12.7 s, one run a side) and dropped: with more than one player the engine checksums the map's lumps from the planes
  on, the textures' among them (Xash3D `CRC32_MapFile`), and a client whose map differs from its server's is
  disconnected ("Your map differs from the server's") — a native dedicated server reads the real map; a page's own
  server and client open it each on its own, the copy each read following the link and the store (the real map arriving
  between the two opens).
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
  (`prefetch: 'startup'` behaves as `'start'` after the startup set). An engine that downloads itself first
  (`'first-read'`: OpenMW) starts it at its first read — or earlier, when its own download is over and its init leaves
  the link idle, with `GameData.prefetchNow()`, only on a cold store — less than half the launch set here (docs/openmw.md
  "The link after the engine's package"). Until 2026-10-21 it never did for the GoldSrc and
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
  `launchSummary`; null until a session marked it; made again in the background — "Off the home's request" below):
  `bytes`
  the launch set's learned pieces on a fast link, `lightBytes` with light copies (a link not fast), the `wire` bytes
  those of the precompressed units already made (`brCache.size`; a unit brotli could not shrink: its range's bytes),
  else 0.75 of the bytes; `langs: { <code>: … }` each game language's own (`launchFor`: the card's language's); `engine`
  and `engineFiles` a browser port's engine release (its wire bytes and URLs: 8.0 MB for Half-Life, 4.2 MB for Vice
  City, measured, none of it in the launch set — 80 of the 105 s a first French Half-Life launch took at 100 KB/s). The
  card says "Playable
  after 80 MB, about 10 min at your link (100 KB/s)" (`launchStatus` in `src/host/web/download.js`, the rate
  `linkRate`; the size only while none was measured), above the whole download's line, hidden once the whole game is
  here or downloading. An engine that reloads in place (`reloads`) is said by its light set on every link, and
  prepared in two stages: "The light launch set of an engine that reloads in place" below.
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

### Off the home's request (2026-10-27)

The launch summaries cost the server's single thread: each one walks a version × language's launch set and asks the
br-cache the wire size of every unit (`brCache.size`: real path, sha1 key). Until 2026-10-27 `/api/manifests` made them
again on its request once ten minutes old (30 s after a player's read): the first home after an idle stretch waited for
all of them, and so did every request meanwhile — a `/gamez` read, the page's logo, `/api/account`. The Caddy log of
orthros.chalco.website, 2026-10-21 to 10-27 (322 calls): median 0.087 s when the previous call was under 60 s before
(74 of 236 still over 0.3 s: the 30 s stale mark while players were in a game), 0.67 s after 600-3600 s (n 19, up to
3.2 s), 0.41 s after more than an hour (n 26); after any gap over 600 s, 0.45 s (n 45). The rules now
(`src/host/server.js` `ownLaunchOf`):

- **Stale-while-revalidate.** A summary kept is always answered at once; one past its age — ten minutes
  (`launchRefreshMs`), 30 s after a session's read (`launchStaleMs`), at once after a playable mark (`learnSave`), or of
  another tree of the game — is queued and made again after the answer.
- **One version × language per turn of the event loop** (`launchStep`, `setImmediate`): a request arriving meanwhile
  waits for one summary at most, not for all of them.
- **No scheduler of its own.** What reads the summaries queues them: a home's `/api/manifests` and the br-cache seeder's
  pass (its `sources`, at the start and hourly), which used to make them on its own turn too.
- **Made on the request only when there is none**, or when the kept one is null and the version was marked since (a
  version just marked playable, or a new language's first mark, shows its figure at the next home, not one refresh
  later). The seeder's pass also queues, in the same background turns, every summary the home will ask for that none is
  kept of — each marked language's and the required versions' (`queueLaunches`) —: the first home after a restart finds
  them made (the "cold (start)" 1.23 s below was measured before this; `tests/launch-set.test.js` checks it, not
  measured again on the live state: a home within the seeder's first pass still makes those not reached yet).

The figure can lag one refresh behind the learned order, as before. Measured (scratch server, copies of the learned
files and of the live br-cache — 19 490 units, 2.2 GB, frozen —, Date.now moved 601 s ahead before each "expired" call,
a `/gamez` 64 KiB read loop beside it, 5 rounds; a scratch script, 2026-10-27, load average ~20):

| | cold (start) | warm | expired | next call | worst `/gamez` read during the expired call |
|---|---|---|---|---|---|
| before | 1.24-1.34 s | 38-148 ms | 0.31-1.13 s | 34-96 ms | = the call (0.31-1.13 s) |
| after | 1.23 s (none kept: made) | 34-50 ms | **32-57 ms** | 55-64 ms | 93-178 ms (one summary: the largest slice) |

The work is the same, spread: a `/gamez` read waits for one summary (BFME's launch sets, up to ~175 ms) instead of all
of them.

Measured again on the final code (with `queueLaunches`; same scratch script, fresh copies of the learned files and of
the live br-cache — 19 490 units —, 5 rounds, before = main at 948fb9f and after = this change run alternately,
2026-10-27 19:04-19:35, load average 3-22 except one "after" run at 49). "Cold" is a home in the first second after
the start, before the br-cache has loaded; "after the seeder's start" waits for the seeder's first pass plus 5 s:

| | cold (start) | first home after the seeder's start | warm | expired | worst `/gamez` read during it | next call |
|---|---|---|---|---|---|---|
| before (2 runs + 1) | 1.22-1.24 s | 193 ms | 34-63 ms | 312-711 ms | = the call (313-708 ms) | 37-81 ms |
| after (2 runs + 1) | 1.38-1.73 s (none kept: made) | 142 ms | 38-45 ms | **35-44 ms** | 119-162 ms | 31-34 ms |

A home in the server's first seconds still makes every summary on its request (1.2-1.7 s, as before: none kept yet,
the br-cache still loading); one after the seeder's first pass finds them made. Production, before the deploy (Caddy,
2026-10-21 to 10-27 19:00, 327 calls): p50 0.107 s, p90 0.707 s, max 3.21 s; after any gap over 600 s median 0.437 s
(n 46, 30 over 0.3 s), under 60 s median 0.087 s (74 of 240 over 0.3 s). After the deploy: not measured yet — the same
query from the deploy's day (median after gaps over 600 s, the count over 0.3 s under 60 s) once a few days of homes
are logged.

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

## Files of a required version (2026-10-27)

A port that requires another version (`requires`: Vice City on reVC and Vice City — Orthros Edition over the Windows
Vice City, a Vanilla+ Morrowind over GOTY of its language, Half-Life Arsenal over Counter-Strike) sees the required
version's files as underlays in its own tree. Each version kept its own store (`orthros-files-<manifest>`) and fetched
through `/gamez/<manifest>/`: a player of both editions downloaded and stored the shared files twice — the owner's
`/gamez` requests from 2026-10-20 to 10-27 held 122 MB of cross-manifest repeats, all `vice-city-revc` →
`vice-city-orthros` (sfx.RAW 54.8 MB, gta3.img 27.3, City.mp3 16.2, Water.mp3 16.0, …). The server already shared the
units (`br-cache.js` keys them by the file), not the browser. The Windows games' `extraMounts` already stored a
required version under its own name. Now every runtime does it the same way:

- **The server marks the owner** (`listGameTree(manifest, seen, ownerOf)` in `src/host/game-files.js`, from
  `manifest.underlayOwners` — `game-catalog.js`, the version each underlay folder is the folder of, the deepest one for a
  chain): a file of the tree is `owner: <id>` when `/gamez/<id>/<path>` serves that very file — the required version's
  own path resolved (`resolveGameFile`: through its overlays, data mounts and version folder) is the same device and
  inode, so the same size and time, the browsers' block keys agreeing. That covers a file the tree takes from the
  required version's folders and a hard link of one in the version's own folder (`goty-vanilla-plus-fr` keeps
  `goty-fr`'s archives, `Sound/`, `Video/`… as hard links: 6,465 files, 845 MB). It is not marked when that version
  serves another file there: its overlays hide it (an re3 engine's files), its data mount, or its own version folder
  overriding a base the two versions share (two versions of one game folder: `requires` allows it); nor when it has a
  light copy and that version does not serve light copies (`lightCopies`, e.g. the Windows Vice City's few large TGAs:
  they stay the port's own). A required version's manifest that changes lists the tree again (`refreshCatalog`), and so
  does a folder its paths were resolved in (`seen`). `/api/manifests` tells a version's `owners` (ids),
  `/api/manifest` too (its folders stripped: `underlayOwners`). Win32 trees carry no marks (their required
  versions are `extraMounts`, mounted elsewhere in the machine).
  Measured on the live catalog: `vice-city-orthros` and `vice-city-revc` 1,568 MB marked
  `vice-city-1.1-elamigos-2014` (14 MB their own: the engine's files), `counter-strike-hl-arsenal-en` 743 MB
  `counter-strike-rebuilt-en`, `morrowind-goty-vanilla-plus-fr` 1,250 MB `morrowind-goty-fr` (2,696 MB its own; 286 MB
  before the hard links counted), `-en` 1,246 MB `morrowind-goty-en`. Listing cost: 0.4 s for Vanilla+ FR's 42,000 files.
- **The client reads them under the owner** (`openVersion` in `src/vfs/game-data.js`, one place for the data worker,
  Prepare / the download and the probe): each part's tree is split (`splitOwners`, `game-tree.js`); its reader
  (`files`) holds its own files only (`files.tree`, `total`); the files of an owner go to that owner's part — one opened
  already (a Windows dependency), else a **shared part** (`shared: true`, its tree those files only, its store
  `orthros-files-<owner>` and `/gamez/<owner>/` URLs, no session: the owner's learned order is its own players', and
  a session's `s=` would teach it another game's reads). `part.tree` stays the tree as the game sees it (the page's
  `trees` only for the versions it opened; a shared part is not one).
- **Reads route by path** (`partOf(version, name, path)`, remembered per path): the data worker's reads, announced and
  place lists, whole-file wants, upgrades of light copies (`.light/<path>`: its file's owner), copies handed over —
  the page still names the version it opened. The engine's uses are reported under that version (`used`): it learns
  them as its own reads, the server's learned order unchanged.
- **Learned orders follow the owner** (`learnedOrders(version, lang)`): each opened version's order fetched, its
  entries of an owner's files moved to the owner's part's list in their order (the startup set, the whole order's
  background loading, Prepare's launch set and the probe count them there); a shared part fetches no order of its
  own. The server's launch summary is unchanged (same files, same sizes, the same precompressed units).
- **Light copies** of a marked file: its owner serves them (the mark requires it), `.light/<path>` under the owner's
  part and store.
- **Locks and contexts**: a page opens its stores one after the other, each under its own Web Lock for the open only
  (`openStore`), never two at once; `storeLocks` takes several (the probe) in one order, by name, whoever asks — so a
  page of one edition, a probe and a page of the other cannot each hold one the other waits for. The owner's store
  is also the owner game's own (the Windows Vice City, Counter-Strike, GOTY): while another tab's game holds it (that
  game, or the other edition), OPFS lets one context only — the shared part then keeps its files in the version's own
  store, as before the owners (`UnderStore` with no top: read and written there, not fetched again at each launch);
  Prepare does the same instead of failing; the probe counts the version's own share and does not leave the card
  unknown.
- **Migration: moved as read** (`UnderStore`, a shared part's store: the owner's over the stores of the parts that read
  its files). The blocks an edition's store kept of the owner's files before (every edition's store before this
  change) count as here — the probe, Prepare and the whole download skip them, nothing is fetched again — and each one
  the game reads there is put into the owner's store and dropped from the edition's. Chosen over a re-download (the
  player who has both editions is the one who would pay twice: 122 MB at 85 KB/s is 24 minutes) and over a copy of
  every block at the open (a first version did that: an offline copy is 1.5 GB read, checksummed and written before the
  page was ready, and a device short of space failed the owner's store midway — for the session, and again at each
  launch). Owner store failed (full device): reads go on from the edition's store, new blocks go there. A moved
  block's bytes stay in the edition's data file (the store appends only) until its cache is cleared: a block read
  once is on disk twice until then. The probe reads nothing (counts both); a version whose own store does not exist
  is probed when one of its owners' (`/api/manifest` `owners`) does — "missing" only when none does.
- **"My data"** (`data-manager.js`): a store is listed under the version it belongs to (the owner's under the owner,
  e.g. the Windows Vice City); clearing a version's cache deletes its own store only — another version's blocks are
  never deleted with it —, the owner's row says which versions read its files too (`sharedWith`), and a reader's row
  that its copies of them move under the owner as read, clearing it freeing them (`keptUnder`). A port's row
  counts its OPFS store and its earlier database together, and clearing it clears both (it cleared the database only).
- Measured (2026-10-27, one fresh persistent Chromium profile per pair behind `tools/net-proxy.mjs` 1.8 MB/s + 90 ms,
  scratch server on copies of the learned directory and the br-cache (frozen), main = the branch's base `dbac797`;
  `tools/re3/check.mjs <v> --new-game --guest --profile --insecure`, `vice-city-revc` then `vice-city-orthros`, two
  pairs per variant, all checks passed). The second edition's `/gamez`:

  | second edition | main r1 | main r2 | change r1 | change r2 |
  |---|---|---|---|---|
  | wire bytes | 117.0 MB (129 s) | 107.7 MB (84 s) | 79.9 MB (63 s) | 87.6 MB (107 s) |
  | of it under `vice-city-1.1-elamigos-2014` | 0 | 0 | 78.8 MB | 86.5 MB |
  | ranges the first edition had fetched already | **32.9 MB** | **32.5 MB** | **3.2 MB** | **1.1 MB** |

  Main's repeats: gta3.img 14.3-14.8, sfx.RAW 11.2, ped.ifp 1.3, FLASH.adf 1.1 MB, Water.mp3 0-1.4; the change's:
  small files (generic.txd, particle.txd, the .gxt) and once a VROCK.adf block 2.1 MB. The total wire bytes are not
  the measure: most of them are the learned order's background, bound by the link × the run's length (both variants
  fill the 1.8 MB/s while the game runs); the gain is the ~30 MB a new game of the second edition no longer fetches
  again (~17 s at 1.8 MB/s, ~6 min at 85 KB/s), stored once. Its demand reads were 0 in every run (the new game's
  launch set is covered by the boot prefetch either way): transfer and storage, not waiting.
  Migration: main's pair-2 profile (both editions' own stores filled), `vice-city-orthros` on this change: passed in
  47 s, 51.0 MB of `/gamez`; of what its own store held 1.0 MB fetched again, but 23.9 MB (Water.mp3 8.5, FLASH.adf 7.5…)
  that only `vice-city-revc`'s own store held were fetched again — `UnderStore` falls back to the opening edition's own
  store only, so a sibling edition's pre-change blocks are fetched once more (no worse than main, which fetched 32.5 MB).
  Morrowind: not run in a browser (`tools/openmw/check.mjs` has no persistent profile, `morrowind-goty-fr` has no
  learned order yet); offline, `morrowind-goty-vanilla-plus-fr`'s learned order (2,164 entries) is 276 MB raw in
  `morrowind-goty-fr`'s files (Morrowind.esm 81, Morrowind.bsa 71, mw_intro.bik 26…) against 552 MB of its own; `-en`
  209 MB vs 413 MB: the upper bound of what a GOTY player starting Vanilla+ no longer fetches. Arsenal over
  Counter-Strike (all its files now under `counter-strike-rebuilt-en`): `tools/goldsrc/check.mjs
  counter-strike-hl-arsenal-en solo --guest --no-save` passed (8 players, moved 234 units).

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
- **The misses during the first pass, and across restarts** (2026-10-28). Rules:
  1. While the first (pinned) pass of the launch sets runs, **one live miss is made every `WANT_EVERY` (8) launch-set
     units** (`nextJob`, the most asked first); once the pass is over, the misses all go before the second pass, as
     before. The first pass was meant to take hours; live it took days — paused under load (213 pauses since 10-20,
     the 1-minute load ≥ 24 in 9-14 % of the samples), its launch sets growing with each deploy (content-keyed engine
     files, the lean package), started again at each restart and each hourly reseed — and the misses waited behind all
     of it: of the owner's 10-22 BFME1 1.08 misses, 291 of 451 blocks and 110 of 153 pieces still had no unit on 10-27.
     The cost: a new thin-link player's launch-set units come ~1/9 later while misses are queued.
  2. **The miss queue survives a restart**: `<dir>/wanted.json` (written 5 s after a change through a file renamed
     over it, at `close()` and at the server's SIGTERM — `flush()`), read back at start: a miss whose file changed
     (size, mtime; a light copy of another shape) or whose unit exists is dropped, the counts kept. The service
     restarted 51 times since 10-20 (once per deploy), each restart threw the queue away. A frozen copy
     (`--br-cache-frozen`, a measurement's) writes nothing. Nothing is written before the kept queue is read back
     (`wantedLoaded`): the index loads in ~4-5 s on the live cache, and a player's miss in those seconds (or a SIGTERM)
     would have written a file of that miss alone over it. The misses asked meanwhile — every unit looks missing before
     the index is loaded — are checked again once it is, and the counts merge (a miss asked during the read back adds
     to the kept one's count). `nextJob` drops a queued miss whose unit exists by then (made by the walk) instead of
     spending the live-miss slot on it.
  3. **A launch set's blocks learned by pieces are made whole too, first in the second pass** (`whole` of a source:
     server.js `brWholeUnits`) — after the pinned pass and the live misses, unpinned: the shape a fast link asks for
     them (`/api/netstats?launch=1`: `fast.madeBytes` against `fast.bytes`), never at the expense of a thin link's
     pinned launch set. The rest of an order's blocks learned by pieces stay pieces (three times the brotli work).
  Measured: unit level (`tests/br-cache.test.js`): a miss queued while a 24-unit first pass runs is made within the
  first 9 units, even behind a queued miss the walk made meanwhile (without the check: the 17th); three misses queued
  by a paused process are made by the next one, the changed file's dropped; a miss and a flush before the next
  process's index is loaded leave the kept file as it was, the queue then kept + new, counts added. Scratch server
  (2026-10-28, an empty cache, 300 piece misses of Morrowind.bsa, SIGTERM, start again, `/api/netstats` 10 s later):
  before, 292 queued at the SIGTERM, 0 after the restart (no file); after, 291 queued, `wanted.json` 42 KB, after the
  restart 218 queued + 71 made in those 10 s (289 of 291: the other two made before the exit). Not measured yet (live,
  after the deploy): `brCache.wanted` across a real restart, `?launch=1` fast.madeBytes approaching fast.bytes
  (pinnedBytes ≤ pinCap, evicted 0), and the owner-miss-URL against the unit files cross-check after 2-3 days
  (target ≥ 90 % made).
- **The lean OpenMW package and a range** (2026-10-28, server.js `sendLean`): a request carrying `Range` that takes br
  gets the brotli body whole (a 200 is a valid answer to a range), as one without; before, it went down the decoding
  way — 204,615,322 bytes from the origin for a `Range: bytes=0-0` (two curl probes, Caddy log 10-27) where the body is
  7,852,937. Without br: the decoded package, a 200, as before. Nothing in the tree asks it a range. Measured
  (2026-10-28, scratch servers on a copy of the lean packages, `curl -r 0-0 -H 'Accept-Encoding: br'`): lean2 204,615,322
  bytes in 1.1 s before, 7,852,937 (Content-Encoding br) in 0.02 s after; lean3 204,615,322 → 4,132,827; without br
  204,615,322 both (unchanged by design).

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
  `BG_SECONDS` —, and `HttpBackend.wholeBlockFits()` is false (a parked read never waits for a whole block on its way —
  but for the reader of a file read whole, whose next block is one whole request, it and one more during a load: see "A
  file read whole takes whole blocks on any link").
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
  entry read in a few pieces: the bytes past it are other entries the load may not read), two of a longer one (for a
  file read whole, its next block and one whole block past it, one of them waiting for its turn at most). The
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
fetched): on a link that is not fast its light copy, whole (a texture is read whole; never the file itself there) —
unless that copy keeps the file's layout (`sameLayout`: its size is the file's, a WAD3's), then the same range of it. A
range past a file's start is announced as what the file's current load reads (`nextPick` with a position: `pick`
chooses only at a read at the start; a texture inside an archive the engine keeps open). Bytes already in the page are
not announced. One batch per call, numbered. `GameData.want(entries, { wait: false })`: a list the engine waits for
through its own reads, never `wantWait` (an engine that cannot be told to wait — GoldSrc's map loads,
docs/browser-ports.md "Map loads announced"): posted at once, no batch number (the worker counts it in `ctrl[13]` and
`ctrl[14]` only), the link's choice pinned, never a big load; the worker's list holds neither the link (`NetLink.wait`)
nor the learned read-ahead (`wantList` `wait: false`). `GameData.peek(h, off, len)`: bytes the page holds, nothing
fetched (a file's, or its same-layout light copy's) — what the engine read already, for a page that parses it.

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
  silent, stage 1; none for a `wait: false` list); counted as `announced` in `NetLink.bgBy`, `stats.want*` in the backend.

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
on it. While a list is missing, nothing is fetched ahead from the learned order either (`pumpAhead`): the engine said
what its load reads; the order's guesses go once it is here. Not for a list announced with `wait: false` (counted in
`wantLoose`, still a load under way for `loadUnderWay`): it holds files read late in the load too, and the order's next
entries — what the engine's announce cannot predict — would each wait a round trip until its last unit came. On an
HTTP/1.x origin (`NetLink.h1`: the browser's `nextHopProtocol` for this context's requests — a local server, `make
serve`; the production front speaks HTTP/2) such a list's units are `WANT_REQUESTS_H1_LOOSE` (4) in flight at most, not
the window's 32: the browser runs six requests to the host at once and queues the rest in their order, so 32 announced
units put the engine's own reads and the learned read-ahead behind them (Half-Life's c1a0, taught, at 8 MB/s and 85 ms:
every request's first byte 400-690 ms instead of 90 during the announce); a parked read's unit still goes at once.

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
  once for all. `GameData.reloaded()` counts the reloads done. Each file is told with its bytes in the page
  (`realInPage`, by default; the page's `?realinpage=0`: as they come): fetched from the worker in the background first,
  at most `REAL_FETCHES` (8) files and 1/8 of the page's bytes under way, and none started while the engine's reloads
  told and not done yet (`realBacklog`, the page's: OpenMW's streamfs.js `reloadBacklog`) and those under way make 8 —
  an engine's reload then reads it without the page's thread waiting (OpenMW's reloads waited for the worker through
  `fetchSync`: ~90% of their time; docs/openmw.md "Light copies sharpened without hitches"). A file no reload reads (an
  engine that does not reload in place, yet; the file loaded itself since) is told as it comes, nothing fetched.
- **Counted** (`GameData.snapshot()`, OpenMW's `window.__streamfsStats`): `bigLoads`, `bigFiles`, `bigBytes` (the real
  bytes left for later), `reloaded`, `realFetches` / `realFetchMs` (the files brought into the page before their reload), `realMissed` / `realRaced` (a
  reload's read that waited all the same: its bytes left the page before it; the file loaded anew while its fetch was
  under way); the upgrades' bytes in `net.bgBy.upgrade`.

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

## A sound bank read sample by sample (2026-10-27)

reVC read its whole effects bank at the audio's start (`cSampleManager::Initialise` → `LoadSampleBank(SFX_BANK_0)`: one
`fread` of 15 MB of `Audio/sfx.RAW`), before its menu: 15.07 of the 19.1 MB of Vice City reVC's learned launch set, 6.61
of its 10.44 MB on the wire (the audio units above), ~78 s of the ~123 s a new device waited at 85 KB/s. The engine
releases `revc-web-e312f97-r3` and `-plus-r3` (`tools/re3/patches/revc-lazy-sfx.patch`, under `__EMSCRIPTEN__` without
Opus banks: docs/browser-ports.md "The engine, built from source") read it as the game plays it — the rule for every
engine that runs in the page and holds a bank of sounds it plays at random (an engine's glue, nothing about a game):

- **The bank's memory, not its bytes, at the start**: the allocation stays (the engine's addresses are unchanged);
  `LoadSampleBank` reads nothing, clears a bitmap of the samples read (`gSampleHere`, one bit per bank-0 sample) and
  says the bank loaded.
- **A sample on its first play** (`EnsureSample`, from `InitialiseChannel` — where a bank-0 sample's bytes are used —
  and from the player's gear change): read if its bytes are in the page (`OrthrosFileReady`, the non-blocking ask the
  ped comments and the CD image's streaming already use; `pread` of exactly its range — stdio's buffer would read past
  it, a wait for bytes nobody asked for), else asked for and **that play skipped**, never waited for on the game's
  thread. What a skip must not do (the callers did not expect a bank-0 sample to fail before):
  - keep the audio manager's slot as playing — a loop (`m_nLoopCount` 0: engines, road noise, rain, sirens) is never
    checked against its channel, so it would stay silent while the game asks for it: `ServiceSoundEffects` frees the
    slot instead, the next frame's request tries again and the loop starts once its bytes are here;
  - leave the channel with its last sample — the police radio starts its channel whatever `InitialiseChannel` said:
    the skipped channel is emptied (`Reset`), its word is not said rather than the previous one re-pitched;
  - move the player's gear — the gear change moved the gear before its sample's play, then again each frame until the
    cruise: it waits for its sample first.

  A one-shot sound asked for once (a first shot, a pickup) is lost, not delayed, on a link where the round trip is
  longer than the sound; one the game asks for again (a loop, a sound held for its frames) starts late.
- **The front end's sounds asked for with the bank** (the menu's highlight, select, back, error and noise bursts, 148 KB,
  and the info chime): fetched while the engine boots, so the menu's first clicks are heard.
- **The rest in the background, as before**: the file is still one the engine reads at random (`OrthrosFileComplete`):
  on a link that is not thin the page loads it whole after what the game reads first; on a thin link (no `wantWhole`
  fill) the samples come as they are played, and from the learned order once the launch set is in (its blocks keep
  their early time and pieces: the first entries after the launch set).

**Launch set after an engine change.** The learned launch set is what the marking sessions read before playable
(`pre`, "Playable after" above): the sessions of the older release flagged the 15 blocks of the bank (19 of 19 marks for
vice-city-revc, 4 of 4 for vice-city-orthros), and the new release's sessions would take ~20 marks to outvote them —
meanwhile every new device still waits for the whole bank before the game starts (the startup set the page waits for).
So an engine release that stops reading a file before playable comes with its entries unflagged:
`tools/learn-unflag.mjs <learn dir> --only <manifest>... --path <game file>... [--write]` takes the `pre` counts (and their
per-language counts) off that file's entries — out of the launch set at once — and moves them to the end of the order
(their time past every other entry's, their phases gone), keeping their counts, masks and the version's marks. Kept at
their early times (the first version of the tool), the bank was still the first thing the learned order fetched after
the launch set: at 1.8 MB/s its 11-12 MB went down during the menu, ahead of the new game's `gta3.img` blocks, and in 2
of 3 runs the new game made ~20 more serial demand reads of them (4.6 s waited against 1.2-2.5 s; the new game's own
phase median 30.2 -> 37.8 s, time to in play unchanged at a 56.1 s median: the menu's 7 s gain spent again). The new
release's sessions flag again what they really read before playable (the front end's
samples' block once half the marks say so). A dry run by default; `--write` keeps `<file>.bak-<time>`. The server holds
the orders in memory and writes them back every 20 s: on the live state only with the service stopped, after a
snapshot. For this change (at the deploy of the r3 releases, once the manifests name them):

```
tools/backup.sh snapshot -m "before unflagging sfx.RAW for the reVC r3 engines"
systemctl stop orthros.service
node tools/learn-unflag.mjs /var/lib/orthros2/learn --only vice-city-revc --only vice-city-orthros --path Audio/sfx.RAW --write
systemctl start orthros.service
```

(dry run first without `--write`: 15 entries flagged of 19 / of 4 marks, 14.38 MB each.)

Measured with the tool as it is (entries at the end of the order; data-matrix, vice-city-revc, new device, 1.8 MB/s and
90 ms, a frozen copy of the units, 3 runs each interleaved, load 20-29): playable 14.1 -> 6.7 s (medians), New Game
clicked 25.9 -> 18.5 s, in play 50.2 -> 45.8 s (means 57.7 -> 45.3 s), the new game's own phase 24.3 -> 27.3 s
(means 31.9 -> 26.8 s: within the noise); the menu window carries 3.55 MB of the bank (blocks read ahead of the first
samples) and 12.1-12.5 MB of the rest, as before. At 85 KB/s (one run): playable ~30 s (195 s before). Left: in 2 of 3
runs ~5 MB of the bank still arrive during the end of the new game's load (31-39 s), not yet explained.

Measured (2026-10-27, scratch servers of this tree, copies of the live learned state of the day — the reset applied to
one — and of its precompressed units, frozen; the same units copy for both sides): the home's launch set for
vice-city-revc (`/api/manifests` `launch`) 33 entries, 18.30 MB, 13.45 MB on the wire as the frozen copy knows its units
(the live server, same day: 10.44 MB) → 18 entries, 3.23 MB, 1.82 MB on the wire after the reset (vice-city-orthros the
same set); the page's startup set (`startupBytes`) 3.23 MB. `tools/re3/check.mjs --new-game` with the final r3 builds
(SwiftShader, fast link): menu and new game, both editions passed; OpenAL buffers started / heard (not silent)
vice-city-revc 320 / 318, vice-city-orthros 324 / 322, bank-0 samples read / skipped 6 / 1 each, 14 heard buffers the
length of a sample read (`Module.orthrosSamples`; a first patch, before the skipped plays' fixes above — slot, channel,
gear —, counted 105 / 103 and 309 / 307 without telling the bank's samples from the streams'). Time to playable on a new
device (`tools/data-matrix.mjs --only vice-city-revc --links 85k:90,1.8m:90 --lang en`, two runs per side, interleaved,
SwiftShader on a machine loaded 9-37 by other projects; before: the live engine r2 and the learned state as it was;
after: the final r3 and the reset copy):

| link | playable, before → after | wire to playable | in play (new game running) |
|---|---|---|---|
| 85 KB/s, 90 ms | 194.6, 195.3 → 27.2, 27.2 s | 16.07 → 2.56 MB | 675, 643 → 491, 560 s |
| 1.8 MB/s, 90 ms | 15.1, 14.7 → 5.2, 5.1 s | 16.75, 16.23 → 6.05 MB (the background order's too) | 48, 56 → 54, 75 s |

At 85 KB/s the playable mark comes 168 s earlier on this units copy; against the live server's units the launch set was
~10.4 MB (~123 s at 85 KB/s), so the live gain is smaller (estimated ~80 s from the live wire sizes, not measured). At 1.8 MB/s ~10 s earlier.
The time in play (the new game running, after the menu's clicks) is not better at 1.8 MB/s (noise of the loaded
machine, or the bank's samples now read during the new game: not settled). Not measured: the owner's real link, sounds
lost on a thin link in play (one-shot sounds before their bytes; a skipped loop heard once its bytes arrive), the French
launch set, vice-city-orthros' times.

## A radio tuned at its position (2026-10-27)

reVC streams its radio stations and ambiences (`Audio/*.adf`, `Audio/*.mp3`: 128 kbps CBR MP3, no Xing header) through
mpg123, opened with `MPG123_SEEKBUFFER | MPG123_GAPLESS` only (`src/audio/oal/stream.cpp`, `CMP3File` and `CADFFile`).
Without `MPG123_FUZZY` and without a frame index past the first frames, mpg123 1.26.2 seeks by **reading every frame
from the file's start up to the target** (`frame_index_find` → offset 0, `stream_seek_frame` → `read_frame` in a loop).
A station starts at its new-game timer plus the time played (`MusicManager.cpp` `GetTrackStartPos`): 7-57 MB into a
65-75 MB file, about 31 MB on average; an ambience at a random position. The stream runs on the game's thread in the
browser (`MULTITHREADED_AUDIO` off under `__EMSCRIPTEN__`) and each missing byte suspends the engine (JSPI `fd_read`):
the game shows no frame until the scan reaches the position. Seen in production: the owner's Orthros Edition session of
2026-10-21 read `VROCK.adf` from 0 to 63 MB in 35 s (Caddy, 130 requests); the learned orders carry the scan's
signature — `Water.mp3` blocks 0-8 counted 31, 27, 22, 21, 16, 13, 8, 7, 4 times by 31 sessions (~4.8 MB a session, in
the new game's load), `VROCK.adf` blocks 0-57 once in 36 s, `FLASH.adf` blocks 0-7 (its 7.2 MB start).

The rule, for every engine that runs in the page and streams compressed audio from a game file (an engine's glue,
nothing about a game): **a seek in a stream reads the bytes at its position, not the file up to it.** For reVC the
engine releases `revc-web-e312f97-r4` and `-plus-r4` (`tools/re3/patches/revc-fuzzy-stream-seek.patch`, under
`__EMSCRIPTEN__`) open both decoders with `MPG123_FUZZY`: a seek past the frame index jumps to `audio_start + mean frame
size x frame` (exact within a frame for CBR — `silent_resync` takes the leftover bytes —; a Xing table's entry for a VBR
file with one; a VBR file without one lands near, not at, its time). What it costs: `mpg123_tell` becomes approximate
(within a frame for CBR: the radio position a save keeps). A tuned station then reads the block at its position (and
the file's first frames and tail at its open, as before).

**The learned order after the change.** The older releases' sessions taught the scan's blocks as entries of the order,
read after playable (no `pre` count: never flagged), with early times — `Water.mp3` blocks 1-8 at 6.8-9.4 s, before the
intro cutscene's `int_a.mp3`, so every new device fetches them during the new game's load. An engine release that no
longer reads a file's blocks moves them to the end of the order: `tools/learn-unflag.mjs` takes blocks of a file
(`--path 'Audio/Water.mp3#1-8'`, `#a-b`, `#a-` to the end) and `--tail` moves the entries named to the order's end even
when no session counted them before playable (counts and masks kept; a session of the new release that reads one early
teaches its time again). Block 0 (the header read at the open) and the tail block (the open's ID3 check) stay.

**How long the move lasts.** The server keeps a block's earliest time over every session (`learnRead`: `e.t =
Math.min(e.t, t)`) and `prefetchList` sorts by that time alone — its count never weighs in (only the 8192 cap). So the
move lasts only for blocks the new release no longer reads early: the stations' prefixes (`FLASH.adf`, `VROCK.adf`:
a station starts at its fixed new-game timer, `NewGameRadioTimers`, so after r4 the prefix before it is not read).
`Water.mp3` and `City.mp3` are ambiences started at a random position in every new game (`MusicManager.cpp`
`SetStartingTrackPositions`, `(pos * m_anRandomTable[i % 5]) % m_nLength` from the clock): an r4 session still reads
the block at its target, at ~7 s, a legitimate read that brings that block back to its early time — each of blocks 1-8
about once in 10 sessions, so after a few dozen sessions the move of their blocks is undone and on a fast link (where
media entries are not sent to the tail: `http-backend.js`, `tail` only when `!net.fast()`) a new device fetches the
whole of `Water.mp3`/`City.mp3` in the new game's load again (at 1.8 MB/s nothing changes: media go to the tail there;
the gain is the engine's). Resetting their counts or dropping the entries would not keep them late either: one read's
time wins the minimum. A lasting order needs low-count media blocks out of its early part (time weighed by the count,
or a media block with a count far under the sessions' left out of the early order) — a follow-up, not part of this
change; until then the move of the ambiences' blocks is temporary (measure the fast-link order again a few days after
the deploy). At the deploy of the r4 releases, once the manifests name them:

```
tools/backup.sh snapshot -m "before moving the radio scan's blocks to the order's end for the reVC r4 engines"
systemctl stop orthros.service
node tools/learn-unflag.mjs /var/lib/orthros2/learn --only vice-city-revc --only vice-city-orthros --tail \
  --path 'Audio/Water.mp3#1-8' --path 'Audio/City.mp3#1-8' --path 'Audio/FLASH.adf#1-53' --path 'Audio/VROCK.adf#1-69' --write
systemctl start orthros.service
```

(dry run without `--write` on a copy of the 2026-10-27 orders: 24 entries to the end for vice-city-revc, 81 for
vice-city-orthros, none counted before playable.)

**Seen in production.** The ports' perf records now say which file a session's data waits were for (`tot.data.files`,
`tot.data.blocked` — docs/real-machine-bench.md "What the data waits were for"): a station's scan shows as one
`Audio/*.adf` holding most of the session's blocked time; after the r4 deploy no `Audio/*.adf` should lead it, and a
check must tell a scan from a single seek: in Caddy, a tuned `Audio/*.adf` or ambience shows its open's ranges (the
first frames, the tail) and then single ranges at a random offset — expected —, no sequential run from byte 0 up to
it; in the learned order, per new session `Water.mp3` gains about one random block plus blocks 0 and 9 (blocks 1-8
keep growing slowly, about 1/10 of a vote a session each, roughly evenly), no longer a 0..k run with counts falling
from block 1 on (31, 27, 22, … before r4). Counts past block 0 that keep growing are not a regression.

**Measured (2026-10-28).** Scratch servers of this tree, the same copy of the learned state and a frozen copy of the
precompressed units on both sides, only the engine differing (r3 / r4, `vice-city-revc`), a new browser each run, the
runs interleaved. A station tuned: `tools/re3/perf.mjs`'s new game, the Sabre Turbo (`--car GETTHEREFAST`, Flash FM),
then one press of Insert 3 s into the measure — K-Chat, about 39 MB into its file in a new game (a scratch variant of
perf.mjs that presses it and reads the session's `orthrosBlocked` and the frame gaps over 1 s; Chrome's network
emulation, 50 ms round trip). The station file's blocked time / the longest frame gap, 2 runs a side:

| link | r3 (before) | r4 (after) |
| --- | --- | --- |
| 1.8 MB/s (`--net 1800`) | `KCHAT.adf` 14.1 s / 14.2 s — 14.1 s / 14.2 s | 0.36 s / 0.25 s — 0.26 s / 0.27 s (a third run, `--report`: 0.27 s / 0.25 s) |
| 6 MB/s (`--net 6000`, owner-like) | 5.3 s / 5.4 s — 6.6 s / 6.7 s | 0.11 s / 0.13 s — 0.19 s / 0.25 s |
| localhost, no limit | 0.76 s / 0.85 s — 0.45 s / 0.50 s | 0.02 s / 0.13 s — 0.03 s / 0.12 s |
| 85 KB/s from the measure on (`--net-after 85`, 60 s, 1 run) | frozen from the press to the window's end (≥ 54 s: 1.4 frames shown a second, the data meter shown 55 s) | 8.5 s blocked in 3 stops (2.5, 5.4, 2.8 s; longest gap 4.6 s), 15.2 frames shown a second |

No frame gap over 1 s after r4 on the three faster links (one of 14.2 s, 5.4-6.7 s before). At 85 KB/s the seek is
one stop where the scan never ended, but a few seconds, not the expected 1-2: the reads at the position are whole
block units of the data system at the thin link's speed (a station's first seconds are several of them).

The new game's load, `tools/data-matrix.mjs --only vice-city-revc` behind the player's-link proxy (90 ms), the AFTER
side's learned copy with the order move above applied: in play (s), and from the proxy's log before it, `Water.mp3`
then the `Audio/*.adf` (MB on the wire, seconds with a request of that file in flight), every `/gamez` byte:

| link | r3 | r4 + moved order |
| --- | --- | --- |
| 1.8 MB/s (2 runs) | in play 42.1 / 50.3; Water 5.3 MB 5.3 s / 7.4 MB 7.8 s; adf 9.3 / 9.3 MB; 56.0 / 69.0 MB | in play 46.5 / 41.3; Water 1.1 MB 1.6 s / 0.15 MB 0.8 s; adf 1.9 / 1.9 MB; 60.6 / 52.5 MB |
| 85 KB/s (1 run each, ~9 min) | in play 530 s; Water 9.9 MB, 139 s in flight; 39.5 MB | in play 431 s; Water 0.34 MB, 8 s; 32.2 MB |

At 1.8 MB/s the bytes leave the load (Water -4 to -7 MB, the stations' scans -7.4 MB) but in play does not move
beyond its run-to-run spread (±5 s: media go to the tail there and were not the critical path); at 85 KB/s in play is
99 s earlier (one run a side: the order of magnitude, not a precise gain). `tools/re3/check.mjs --new-game --guest`
passes on both editions with the r4 engines (vice-city-revc: new game in 41 s, 304 of 306 buffers heard;
vice-city-orthros: 36 s, 306 of 308), no page error (the checks do not keep the page's console: mpg123's warnings
after a seek not checked). A `--report` run's final
`perf` record (scratch telemetry) carries the new totals: `tot.data` `{n: 361, ms: 16811, files: [[models/gta3.img,
12239, 191], [anim/cuts.img, 1327, 5], [Audio/Water.mp3, 1316, 8]], blocked: {n: 330, ms: 16727, max: 640, top: …},
bg: {pf1, ahead, want, readAhead, mediaAhead, …}}`, accepted by the server's sanitizer. Not measured: the seek heard
by a person (no glitch is audible in a headless run; the CBR position is within a frame by construction), VBR files,
the fast-link order a few days after the deploy.

## A port's own archives as game data (2026-10-27)

Half Strike and Counter-Strike rebuilt fetched Orthros' own archives whole before their menu, as engine files
(`goldsrc.extras`): `orthros-bots.pk3` (4.94 MB: 25 navigation meshes, 14.2 MB raw, one read per map load and none
before the menu) in both, and `orthros-pokemon.pk3` (6.48 MB: models, sounds and sprites the game's server precaches
at a map's start) in Half Strike — 4.94 / 11.41 MB of the 8.47 / 15.04 MB engine figure. Already deflated, brotli did
nothing for them; served by pieces (2026-10-22, "The page, the engines and the covers") nothing was saved either:
the engine reads every member's local header at the mount (xash3d-fwgs `filesystem/zip.c` FS_LoadZip), touching nearly
every piece of the archive before its menu. The rules now (generic: the release says which files are game data, no
game named in the code — docs/browser-ports.md "The release's own game files"):

- **The files a release builds for its game are loose game files**, in the release's `gamefiles/<game folder>/`
  (`tools/goldsrc/release-gamefiles.py`, from the build's archives), laid over the version's files by the catalog for
  GoldSrc as for re3 (`releaseGameFiles`). They go through the game data system as the game's own: the tree,
  `/gamez` ranges and precompressed units, the OPFS store, the learned order and its launch set, Prepare, the whole
  download, light copies by format. No archive scan: a file is read when the game reads it.
- **Only the engine's own archive stays an engine file** (`engine/valve/extras.pk3`: the engine's menus and
  shaders, read before the menu anyway).
- **Not in the launch set** (the menu reads none of them): the card's engine figure and its launch set fall by the
  archives, and a first session fetches none of them before its menu. Once the learned order holds them, its
  background run (`prefetch: 'startup'`: from the engine's start, `gameData.start()`, after the launch set) may fetch
  some before the menu on a fast link — background bytes, not the launch path: data-matrix tells them apart (demand /
  background).
- **At a map's load** its mesh (`maps/<map>.nav`, 62-520 KB deflated, 151 KB for de_dust2) is announced with the
  map's other files when the page runs the server; what the game's server precaches without the map naming it is
  declared by the release (`release.json` `mapPrecache`, Half Strike's 72 Pokémon files) and announced after the map's
  own files: fetched in parallel at a first session's first map, not a demand read each.
- **A rebuild** changes only the files whose bytes changed (one mesh between two builds, not a 4.9 MB archive): a
  loose file's time is drawn from its bytes, not its archive's (the store's keys hold path, size and time). Only the
  builds that say `"gameFiles": true` in the lock have loose files: an older id rebuilds as pinned.

Measured (2026-10-28, tools/data-matrix.mjs, new device, 2 runs per variant interleaved, the same pristine state for
both — a copy of the live learned directory, a frozen br-cache copy, covers —; before = main 93391eb with `…-r2` /
`…-arsenal-r12`, after = this change with `…-r3` / `…-arsenal-r13`; menu = the playable mark, first map = in play, the
matrix enters the map 2 s after the menu; "map wait" = the demand-wait seconds from the `map` command to in play):

| version, link | menu (s) | first map (s) | wire before the menu (MB; engine) | map wait (s) |
|---|---|---|---|---|
| Half Strike, 85k:150 | 296.3 / 300.0 → 156.9 / 162.5 | 755.6 / 746.0 → 670.7 / 662.5 | 21.85 / 22.25 (15.05) → 10.31 / 10.59 (3.63) | 233 / 234 → 304 / 300 |
| CS rebuilt, 85k:150 | 174.5 / 176.0 → 113.1 / 139.6 | 581.2 / 579.0 → 518.6 / 528.3 | 12.66 / 12.71 (8.47) → 7.60 / 8.68 (3.53) | 93 / 92 → 94 / 91 |
| Half Strike, 1.8m:90 | 37.6 / 37.3 → 25.0 / 26.5 | 65.3 / 64.6 → 62.8 / 59.5 | 38.39 / 37.75 (15.05) → 17.99 / 20.33 (3.63) | 1.9 / 2.4 → 2.2 / 2.0 |
| CS rebuilt, 1.8m:90 | 33.8 / 35.9 → 31.4 / 23.3 | 54.7 / 55.4 → 53.0 / 48.6 | 31.93 / 34.46 (8.47) → 27.68 / 15.38 (3.53) | 0.8 / 0.8 → 0.9 / 0.9 |

- **The menu**: -138 s for Half Strike and -49 s for CS rebuilt at 85 KB/s (-46 % / -28 %), -11.7 s and -7.5 s at
  1.8 MB/s (the rebuilt pair noisy: 31.4 and 23.3 s). The engine bytes fall by the archives, 11.4 and 4.9 MB; at
  1.8 MB/s the rest of the bytes before the menu is the learned order's background run, which varies run to run.
- **The first map**: -84 s and -57 s at 85 KB/s, -3.8 s and -4.3 s at 1.8 MB/s. Half Strike's map load itself grows
  (456 / 443 → 510 / 496 s at 85 KB/s, its demand wait +70 s): it now fetches the Pokémon files — announced (`w=1`
  1.04 → 7.48 MB), not one demand read each — that the menu used to wait for. CS rebuilt's map load does not change
  (de_dust2's mesh, 0.12 MB, rides with the map's files).
- **Conservative for the map**: the frozen br-cache predates the loose files, so they went as live misses (gzip on the
  fly: 57 Pokémon/build reads, 4.35 MB); a live server makes their brotli units as it meets them.
- **A second session** (the order taught by one session of each, the three check.mjs solo runs, then the same matrix,
  1 run): Half Strike 158.6 s to the menu and 662.2 s to the map at 85 KB/s, 25.2 / 58.4 s at 1.8 MB/s; CS rebuilt
  114.8 / 564.7 s and 23.5 / 45.8 s — the same as a first session. The taught entries sit at the end of the order
  (positions 1130-1204 of 1210, one session's weight against the order's), and the matrix leaves no menu dwell: 28 of
  them (1.2 MB) came in the background before the map at 1.8 MB/s, 11 (0.25 MB) at 85 KB/s. A player who stays in the
  menu gets more of them; not measured.
- Checks against the scratch server (this change, r3 / r13): `check.mjs` half-life-original-en solo,
  counter-strike-hl-arsenal-en solo `--guest --no-save`, counter-strike-rebuilt-en solo `--no-save` and
  counter-strike-hl-arsenal-en multiplayer `--join-keys "{n},1"` (a scratch dedicated server, `tools/goldsrc/server.mjs
  --engines-dir`, its meshes linked from the release's `gamefiles/`) pass.

## The light launch set of an engine that reloads in place (2026-10-28)

Since "Big loads light first", an engine that reloads in place (its release.json `exports` lists
`orthros_file_updated`: OpenMW's builds) reads the light copies of a new game's big load even on a fast link, its files
coming after as upgrades. Yet the card, the in-page way to playable and "Prepare" still counted the fast link's launch
set — the files themselves: Morrowind Vanilla+ FR said "playable after 378 MB" (184.5 MB of wire) on a fast link for a
game that plays after 137 MB (54.2 MB of wire). One rule now (`src/vfs/launch-set.js` `lightLaunch(fast, reloads)`):

- **The server says it** (`src/host/server.js` `engineReloads`, `launchOf`): /api/manifests `launch.reloads` (and each
  language's) when the version's engine release exports `RELOAD_EXPORT` (`engine-content.js` `exports(release)`, read
  again when its release.json changes). Generic: an engine release's word, no runtime or game named.
- **The card** (`download.js` `launchStatus`): `lightBytes` / `lightWire` for "Playable after" and its time on every
  link when `reloads`; the files' figures otherwise on a fast link, as before.
- **"Prepare" in two stages** (`download-worker.js` `download`, `reloads` from the card's launch): the light set first
  (`launchSet(..., false)`), "Ready" once it is here; then, on a fast link only (where the old Prepare fetched them), the
  files themselves of the fast link's set as a second stage (`upgrade: { bytes, total }` in the progress, said in the
  card's tooltip), stopped like the first (Play, another download), its end or a failure leaving the card ready. A player
  who plays between the stages gets the light copies and their in-place upgrades — what a big load does anyway.
- **The probe** (`probe`, `countStores`, the item's `reloads`): the light set on every link — a light copy or its file
  whole (forLink) —, so a store filled light on a thin link is ready on a fast one.
- **The page's cold-store test** (`data-worker.js` `prefetchNow`; `GameData.reloads` tells the worker): judged on the
  light set once the page knows its engine reloads, so a store "Prepare" left at its first stage (Play pressed on
  "Ready", which ends the second) is warm and the boot is not shared with a paced prefetch. The order the page fetches
  ahead (`launchFirst`, `prefetchAll`) and its pill (`launchWatch`, counted on that same set) are unchanged: a long
  menu dwell on a fast link still ends with the full files here (no pop-in, no reloads), and the pill never counts
  light copies nothing fetches.

Tests: `tests/launch-set.test.js` (the card at 7 MB/s with `reloads`; the server's `reloads` from a release.json's
exports), `tests/download-worker.test.js` (the two stages; the probe of a light store on a fast link).

Measured (2026-10-28, a scratch server on copies of the live learned state and units — frozen —, before: `main` a5aff0d).
/api/manifests: the OpenMW versions now say `reloads: true`, no other version changed; Vanilla+ FR on a
fast link "Playable after" 377.6 MB → 136.9 MB (Vanilla+ EN 218.5 → 118.1 MB, GOTY 161.0 → 150.8 MB). "Prepare"
(`tools/prepare-bench.mjs --only morrowind-goty-vanilla-plus-fr --known-bw`, behind the player's-link proxy, 80 ms; the
engine's 20.6 MB included — the release's own package, no lean one in the frozen copy; three runs a side, all identical
to 0.3 s but one 4 MB/s "after" run, 49.0 s / 96.7 s, made while a browser run shared the machine):

| link | before: "Ready" (wire) | after: "Ready" (wire) | after: second stage over (wire in all) |
|---|---|---|---|
| 7 MB/s | 36.1 s (199.4 MB) | 22.6 s (76.4 MB) | 42.7 s (208.1 MB) |
| 4 MB/s | 54.7 s (199.4 MB) | 28.5 s (76.4 MB) | 62.1 s (208.1 MB) |

"Ready" 1.6-1.9x sooner, 2.6x fewer bytes before it; the whole of the two stages ~8.7 MB more (the light copies) and
6-7 s longer. The light set's requests are small (1422 in all against 1120): at 7 MB/s its 76 MB came at ~3.4 MB/s, the
round trips its bound. Not measured: the page's way to playable in a browser, the owner's real link.

## Whole files in order (2026-10-28)

`HttpBackend.wantWhole` queues every missing block of a file in the background fill's `later` queue; the fill used to
take them in insertion order, so reVC's effects bank (`sfx.RAW`, wanted whole at the audio's start, 292 MB of wire) went
entirely before the streaming archive (`models/gta3.img`, wanted whole at `CGame::Initialise` after New Game, 149 MB)
whose random reads the game waits on in free roam (the owner's sessions: 5-15 gta3.img demand reads per session behind
the bank's fill). The rule (`HttpBackend.laterNext`, generic: what the game waited on, never a file name):

- `later` is filled **file by file, each file's blocks in their order**: first the file the game **waited on latest**
  this session (`noteWait`: a read the game is **blocked** on that went to the network — a synchronous one,
  `fetchRange`; a held one, `HttpFile.prepare(..., held)`; a page's data-worker ask once the engine waits for it,
  `waited` —, never a read it went on past: an ask ahead, `readable()`, reVC's bank sample skipped while missing; the
  latest `WAITED_FILES` (256) files remembered), else the file **wanted whole latest** (`wholeAt`). A bank's missing
  sample is skipped (a silence), an archive's missing model is a wait or pop-in: the archive goes first.
- No hold added during loads: on a link that is not fast the `later` queue is already held while the game loads
  (`net.silenced()`), and NetLink's strict priority puts the learned order before it.

Test: `tests/http-backend-whole.test.js` (two files wanted whole, a parked read on the first, a synchronous one on the
second, a third waited on before it was wanted whole).

Measured (2026-10-28, `tools/data-matrix.mjs --only vice-city-revc --links 1.8m:90 --parallel 1`, before: `main`
a5aff0d, each side's tree copied into scratch; frozen copies of the live learned state and units; the runner kept 330 s
in play after "in play" — a scratch-only `MATRIX_LINGER`, the player standing — for the fill's end; runs interleaved,
loaded machine, load average 21-33. A second "before" run's page stopped receiving at ~280 s, replaced by a third;
figures from the proxy's log, seconds from the navigation, gta3.img 327.5 MB decoded):

| | before (2 runs) | after (2 runs) |
|---|---|---|
| in play | 63.5 / 41.1 s | 42.0 / 40.6 s |
| gta3.img fetched at 180 s | 199.3 / 201.7 MB | 212.5 / 205.4 MB |
| gta3.img fetched at 300 s | 254.0 / 267.1 MB | 266.8 / 264.7 MB |
| gta3.img at 90 % / whole | never / never (stops at 275.1 / 274.0 MB, end 395 / 373 s) | 362 / 371 s; whole 377 s / 299 MB at the end (373 s) |
| sfx.RAW fetched at the end | 98.6 / 102.8 MB | 50.3 / 47.2 MB |
| gta3.img demand reads after in play (their time in flight) | 84 (13.4 s) / 72 (11.9 s) | 88 (14.0 s) / 89 (14.1 s) |

The order shows at the queue's tail: before, from ~5 min the fill went to the effects bank (38 MB of sfx.RAW in the 7th
minute, 2 of gta3.img) with 52 MB of the archive still missing; after, the archive is finished first (whole at 377 s in
one run, 90 % at 371 s in the other), the bank after. Up to ~4 min both sides fetch the same (the learned order brings
most of gta3.img, `p=1`): time to in play is unchanged (63.5 s was a loaded run), and the demand reads after in play —
a standing player, while the archive is still ≤ 270 MB on both sides — are as many. Not measured: a moving player
(where the archive's missing tail is a wait), the owner's link.

## Read-ahead by the link's bandwidth-delay product (2026-10-28)

The learned pieces fetched ahead of the game (`HttpBackend.pumpAhead`, "What a load needs") kept `AHEAD_REQUESTS` (3)
requests in flight on a fast link and on a thin one, `AHEAD_REQUESTS_MID` (8) between: an 8 MB/s link kept fewer than a
2.9 MB/s one. A GoldSrc map's first load reads ~750 learned entries (Half Strike's de_dust2: 756, 65 MB raw, 578 of them
64 KB or less — the game module's player and weapon models and sounds, which the map does not name, so they are not
announced), each a round trip: behind the player's-link proxy (HTTP/2, `tools/goldsrc/maps.mjs --proxy 8m:85`) that
load took 16.9-17.2 s, the engine waiting 15.2-15.5 s in 814 waits (19 ms each, a quarter of the round trip), ~60
requests a second of ~90 ms each, 0.2-0.9 MB/s on the wire of the 8 MB/s link.

- **The budget** (`NetLink.aheadBudget`, by the link only): a thin link `AHEAD_REQUESTS`; between thin and fast, or not
  measured yet, `AHEAD_REQUESTS_MID`; a fast link measured over HTTP/2 or 3 with its round trip known, up to
  `AHEAD_REQUESTS_MAX` (24) requests. The memory bound: the first `AHEAD_REQUESTS` (3) requests go whatever their size
  (a learned block whose pieces are all read goes as one request: up to three whole 1 MiB blocks, 3 MiB in flight, as
  before); beyond them a request starts only while the file bytes in flight (`L.inBytes`) stay under `AHEAD_BDP` (2)
  bandwidth-delay products, `AHEAD_BYTES_MIN` (8 pieces of 64 KiB) at least (8 MB/s × 85 ms: ~1.4 MB on the wire, ~24
  requests of 64 KiB); a demand read that misses the order waits behind about two round trips, a block more at most.
  The fast whole-block pass's own requests (`prefetchList`, `FAST_PREFETCH_PARTS`) are outside this budget, as before
  the change. A fast link over HTTP/1.x (six connections, the game's reads' too) or a fixed one not measured keeps
  `AHEAD_REQUESTS`. The entries looked at past the game's position: `AHEAD_WINDOW` (32), twice the budget's requests
  when more.
- **One request for the same bytes** (`prefetchList`, `pumpAhead`): the learned order's whole-block pass on a fast link
  registers its blocks as on their way (`blockFlights`, as a sequential reader's read-ahead): a parked read or an
  announced list joins that request (and promotes it) rather than asking its bytes again — the blocks then go to memory
  too, not only to the store (full or failed, it drops them: the read would ask again) —; the pieces ahead skip a
  started one, and take the blocks of one still waiting for its turn (`job.drop`: given up, the pass picks the block
  again once those pieces came — queued behind the game's reads, it would hold the load's next blocks back, a parked
  read waiting for its 1-2 MiB rather than a piece). Before, both walked the same order at the same place: Half Strike's first map at 8 MB/s asked 441
  ranges twice at once (8.7 MB), Half-Life's c1a0 153 (1.9 MB), a game read sometimes beside the pass's request for
  the same block.
- Every runtime reads through it (Win32, GoldSrc, re3, OpenMW): BFME's learned entries are whole 1 MiB blocks, bounded
  by the bytes past `AHEAD_REQUESTS` (three at 8 MB/s and 85 ms, as before).
- Measured (2026-10-28, `tools/goldsrc/maps.mjs --proxy`, new browser, scratch servers on copies of the learned
  directory and of the unit cache, frozen; before = main 5aa05be, after = this code; sides alternated, machine load
  17-34), load seconds (engine waits):
  - Half Strike, `wait 5,map de_dust2`, 8 MB/s and 85 ms: before 15.4, 17.2 (13.8, 15.5 s; 435-443 ranges asked twice,
    8.2-8.6 MB); after 4.4, 3.9 (2.9, 2.1 s; 4-5 ranges twice, < 0.04 MB) — the same 813 waits, 3-4 ms each instead of
    17-19. A first series on an earlier state of the code gave the same picture: before 16.9, 17.2, 14.6; the registered
    blocks alone 10.8, 10.2; both 4.3, 4.1, 4.7.
  - Half-Life c1a0, 8 MB/s: before 4.7, 3.3 (4.2, 2.7 s; 57-115 ranges twice, 2.0-3.0 MB); after 2.6, 2.4 (2.2, 2.0 s;
    24 twice, 0.6 MB). Its changelevel c1a0d (not taught, its reads not in the order): 4.0, 3.9 before, 4.0, 3.8 after
    — unchanged.
  - 3.5 MB/s (fast), Half Strike's de_dust2: before 30.4 (28.6 s), after 8.8 (3.9 s) — one run a side, the after run
    at a machine load of 70.
  - 1.8 MB/s (a link between thin and fast: the budget does not change there): Half-Life c1a0 5.1, 5.7 before, 4.9, 6.9
    after, c1a0d 5.6, 5.5 / 5.6, 5.7; Half Strike's cs_assault (untaught) 35.4, 33.1 / 33.0, 33.0 — within the noise.
  - BFME1 (`bfme1-103`, `tools/data-matrix.mjs --links 8m:85 --win32-seconds 240`, the same pristine copies, 3 runs a
    side interleaved a b b a a b): first frame 33.2, 34.2, 29.2 s after, 34.2, 32.2, 29.2 before; ~248 MB on the wire to
    the run's end on both sides (247-253), the page's waits 16 (2.3-2.5 s) after against 29-35 (2.9-3.7 s) before; no
    run reached the worker's playable mark (SwiftShader's menu under 20 fps, both sides: "timeout"). No crash in the
    six. The renderer's resident memory peaked at 2456, 2825, 2455 MB after and 2515, 2399, 2430 MB before. The GPU
    process's resident memory grew roughly linearly over each run, to 4.2-6.6 GB by its end (500-584 s), on both sides
    alike (after 6.6, 6.1, 5.2 GB; before 6.1, 6.1, 4.2 GB): not caused by this change (its cause not looked into). A crash seen once earlier in this work ("Page crashed", an after run) was the host's out-of-memory killer:
    the kernel's global OOM at the run's very second killed the page's renderer (oom_score_adj 300, its usual 2.3 GB)
    while two Python processes outside the run held 17.8 and 29.3 GB, swap empty — not this code.
  - OpenMW (`morrowind-goty-en`, data-matrix at 8 MB/s and 85 ms, one run a side): the playable mark as the proxy saw
    it (the matrix's `markS`) 36.7 s before, 30.8 after (the runner's own `playable` 39.6 / 33.9 s; first frame 24.9 /
    18.2 s; 206 / 184 MB to the mark) — no worse; one run a side is within OpenMW's noise. Neither run got into play:
    both ended "timeout before play".
  Not measured: the owner's own link and machine (a real HTTP/2 front over the Internet), an re3 port, a fast link with
  the store full or failing (the joined blocks kept in memory: covered by a unit test), more than two runs a side on
  the GoldSrc rows.

## Opened early (2026-10-28)

The ports' pages opened their game data after their engine: GoldSrc and re3 created the data worker once
`engine.init()` / `createEngine()` returned (after the account's saves, the engine's download and its compile), OpenMW's
streaming at the engine's first mount (its preRun, once `mwdata-mods.json` was read). Then the worker opened the
version one wait after another: its modules, `/api/manifest`, `/api/tree`, the OPFS store (its index replayed), each
required version's tree and store, and only then the page's reads and the learned order. In the Caddy log of the
Morrowind starts (10-26/27, 30 runs) the worker's script to its `/api/tree` is 0.5-0.9 s, the gateway's lists to the
first engine `/gamez` 1.1-1.6 s, while the link sat idle during the engine's compile; GoldSrc and re3 asked
`/api/prefetch` 0.35-0.7 s after the worker's script, at `startup()`.

The rules, the same for every port (one mechanism: `src/ports/port-files.js`, `src/vfs/data-client.js`,
`src/vfs/data-worker.js`, `src/vfs/game-data.js`):
- **A page opens its game data as soon as it knows its version**, beside the engine's download, not after it: GoldSrc
  and re3 at the top of `start()`, before the account's saves (`openPortData`: the GameData at once, its `ready` later),
  their files mounted once the engine's file system exists and the data is ready (`mountPortFiles`: the earlier
  IndexedDB copy handed over, then `mountFiles`); OpenMW's `streamfs.js` when its shared modules load (`open`), long
  before the engine's first mount.
- **What the page holds is not asked again**: GoldSrc and re3 fetched `/api/manifest` and `/api/tree` themselves; both go
  to the worker (`GameData` `manifest`, `tree` → `openVersion`).
- **One wait, not a chain**: `openVersion` asks the manifest, the version's tree and its store at once, then every
  required version's tree and store at once; a failure closes the stores that opened.
- **The learned order's list at the open, not its bytes** (`orderAtOpen`): the list is in the worker before
  `startup()` (GoldSrc, re3) or the engine's first read (OpenMW, `prefetch: 'first-read'`) asks for it. When bytes
  move is unchanged: the startup set at `startup()`, after the mount; OpenMW's learned order at the package's end on a
  cold store (`prefetchNow`) or at the first read. Opening early fetches no game bytes.
- **What the engine's use decides stays at its use**: the session's start (`GameData.start`: the reads learned from
  there, the marks timed from there, the offline copy started), OpenMW's run hold (`holdRun`, at the first `need()`:
  before the engine's script ran there is no run dependency to add, and a read before the worker answered would never
  be answered — 8300c5f), its page-side cache budget (the tier the engine page's preRun sets, `__omwLruDefault`, read
  again then), the progress to the page around it, `StreamFS.data()` / `stats()` (null / empty before).
- **The store's Web Lock** is still held only while the store opens (`openStore`); the store itself is the page's from
  its start instead of from its engine's: a home probe after Play-then-back finds it held a little longer, and counts it
  as held (as before).
- **Times**: `GameData.times` / `snapshot()` `openMs`, `readyMs`, `mountedMs` (the page's clock from its navigation):
  the open, the worker's answer, the mount — GoldSrc's and re3's `session.startup`, OpenMW's `__streamfsStats`.

Measured (2026-10-28, before = main a5aff0d, after = this change; 2 runs each, behind `tools/net-proxy.mjs` 1.8 MB/s
90 ms, headless Chromium + SwiftShader, scratch origins on copies of the learned state and a frozen brcache copy; seconds
from the page's own request in the proxy log, the menu / first frame on the page's clock; OpenMW:
`tools/openmw/place-load.mjs morrowind-goty-vanilla-plus-fr --mode save`, the warm profile built once by main's code and
copied for every run; GoldSrc `half-life-original-en`, re3 `vice-city-revc`: the page opened directly, guest, warm = the
same persistent profile after one 60 s start, new = an empty profile):

| runtime, store | data-worker.js | first engine `/gamez` | menu / running | first frame |
|---|---|---|---|---|
| OpenMW, warm | 3.33, 3.08 → 1.98, 2.54 | 8.56, 8.24 → 8.50, 8.52 | menu 8.9, 8.8 → 9.1, 9.0 | 7.5, 7.2 → 7.4, 7.6 |
| OpenMW, new | 8.14, 8.06 → 2.21, 2.17 | 9.97, 9.77 → 8.51, 8.42 | menu 49.7, 50.4 → 48.9, 47.9 | 44.3, 44.6 → 43.2, 42.2 |
| GoldSrc, warm | 3.35, 3.69 → 0.94, 0.93 | none (all in the store) | running 13.3, 11.9 → 13.6, 12.7 | = running |
| GoldSrc, new | 3.64, 3.62 → 1.03, 0.79 | 4.68, 4.43 → 3.55, 2.48 | running 16.7, 15.7 → 15.0, 14.2 | = running |
| re3, warm | 1.83, 1.86 → 0.92, 0.86 | 2.86, 2.64 → 2.17, 1.91 | running 2.86, 2.65 → 2.17, 1.90 | 6.23, 5.65 → 5.31, 5.49 |
| re3, new | 1.99, 1.99 → 1.00, 0.71 | 3.00, 2.77 → 2.20, 1.77 | running 3.87, 3.52 → 3.08, 2.54 | 6.82, 6.57 → 6.67, 6.06 |

After, `session.startup`: GoldSrc `openMs` 0.8-1.0 s, `readyMs` 1.3-2.3 s, `mountedMs` 2.5-3.6 s (the data ready
before the engine's file system every time); re3 `openMs` 0.7-1.0, `readyMs` 1.2-1.9, `mountedMs` 1.8-2.0 s. The
worker's `/api/prefetch` (the learned order's list) moved from 4.1-4.4 s to 1.3-1.9 s (GoldSrc), 2.5-2.7 to 1.2-1.9 s
(re3). What it gives: a new device starts 1.6 s sooner on OpenMW (menu) and GoldSrc, 0.9 s on re3; re3 on a warm store
0.7 s. **Nothing on a warm store for OpenMW (the owner's Morrowind saves) or GoldSrc**: the data is open 0.8-1.4 s
sooner, but the engine's own boot (OpenMW: its main reaching the first read at ~8.5 s; GoldSrc: its modules and
init, ~12-13 s) is what the start waits for; the menu came 0.1-0.2 s later on OpenMW and GoldSrc's running 0.5 s later
on average, within their run-to-run spread (0.3 / 1.4 s) — no contention shown, none excluded at that size. Not
measured: the owner's laptop (real GPU) and the 85 KB/s link.

## Content files light before the menu (2026-10-28)

A new OpenMW player read Morrowind.esm, Bloodmoon.esm and Tribunal.esm whole before the menu: 95 MB of the 137 MB thin
launch set (Vanilla+ FR), 34.6 MB of wire for Morrowind.esm alone at 85 KB/s. The engine's content load
(`World::loadData`) reads every record of them, but not all of each: `ESM::Land::load` skips a LAND record's normals,
heights, colours and texture indices (`skipHSub`: read when a cell loads, `Land::loadData`), and
`ESMStore::countAllCellRefsAndMarkKeys` reads a cell reference's number, object, key and deleted flag only. Those
bytes are 38 MB (LAND) and ~9 MB (references' details) of Morrowind.esm's 80 MB.

- **The light copy** (`src/host/light-copies.js` `lightEsm`, `esmZeroRanges`, by format: a file named as a content file
  — `isLightContent` in `src/vfs/game-tree.js`: .esm, .esp, .omwaddon, .omwgame — with a TES3 header, from
  `ESM_LIGHT_FROM` = 1 MiB): **the file's size and every offset**, every record and subrecord header kept, zeroed: a
  LAND record's VNML, VHGT, VCLR, VTEX payloads (INTV, DATA, WNAM kept — the global map reads WNAM); in a CELL record,
  from its first reference on (its own header kept), each reference's subrecord payloads but FRMR, NAME, KNAM, DELE; a
  moved reference's group (MVRF, its target, the FRMR group after them) kept whole — `Store<Cell>::handleMovedCellRefs`
  loads it all at the content load (none in the installed masters; one in Patch for Purists). Its map made from the file
  at its first read (`esmZeroMap`: the file read asynchronously, its records walked 1 MiB at a time between turns of the
  event loop — done synchronously it held every game's requests ~130 ms per master —; kept with the copy, a failure
  not kept and returned to the read, never thrown), not at the tree's listing (16 bytes there). Its units are a format of their own (`lightFormat` `ESM_FORMAT` 'tes3-1' in
  br-cache.js's key: another rule, other units), a unit's job carrying only its range's zeroed spans (`zeroWithin`).
  Per 1 MiB block at brotli 9: Morrowind.esm EN 31.79 → 4.94 MB, FR 31.94 → 5.11 MB, Bloodmoon 2.81 → 0.80 MB, Tribunal
  0.99 → 0.79 MB; the references the content load counts (number, object, key, deleted) identical in all three
  (316 116, 26 473, 15 103 references).
- **Only for an engine that says it**: the tree marks a content file's light copy only when the version's engine
  release exports `CONTENT_EXPORT` (`orthros_content_light`, `src/vfs/launch-set.js`; `src/host/server.js`
  `engineContentLight` → `listGameTree(..., { contentLight })`, and `resolveLightFile`: served under `.light/` and seeded
  as units only then). Any other engine (a release before orthros-r13) sees no light copy: nothing listed, served,
  seeded, learned or fetched light — its versions' real units seeded as before.
- **The page** (`src/vfs/data-client.js` `contentFile`, `contentPick`): a content file is read light **only while the
  engine says its content load runs** — `globalThis.orthrosContentLoading()` at `World::loadData`'s start, then
  `orthrosContentLoaded()` at its end (orthros-r13.patch, `VFS::orthrosContentLoad`; `src/ports/openmw/streamfs.js`) —,
  on every link (the copy is what that load reads, a fast link included), unless the file is here whole (`?contentlight=0`
  on the engine's page or the play page: the files all along — pictures compared; the learned order still brings the
  copies). From the end on,
  **every read of every handle is the file's**, for good — not chosen per load at the file's start: the engine keeps up
  to 100 readers open (`ESM::ReadersCache`), each sought again before it reads (libc++'s filebuf and musl's FILE drop
  their buffers at a seek). An engine that says nothing reads the files. The copy is never fetched whole after (no
  `light` message: no `HttpBackend.upgrade`, no reload in place); a check of a range (`readable`, r12's terrain chunks
  waiting for their LAND: `orthrosRangeReady`) answers for **the file's own bytes**, never for the copy in the page;
  an announce after the load asks the file's ranges (`nextPick`), never makes a big load (`bigBatch` leaves content
  files out), and `peek` never takes the copy's bytes for the file's.
- **Reads of ids only** (orthros-r13.patch `CellStore::listRefs`, `VFS::orthrosContentIds`; `GameData.contentIds`): a
  cell's references listed by their ids — what the content load read, kept in the copy — are read from the copy after
  the content load too. `WorldModel::getPtrByRefId` / `getExteriorPtrs` (a script naming an object in no loaded cell)
  list every cell not loaded yet, one after another on the main thread: from the file, each a synchronous fetch of its
  references (many MB at 85 KB/s, the frame frozen for minutes); from the copy, what the content load brought.
- **A store an older engine filled** (`data-worker.js` `contentHere`; `launch-set.js` `setBytes`): a read of the copy
  where the file's own pieces are here (memory or store) is served from them — a superset of the copy's bytes, every
  offset the same. A returning r12 player (Morrowind.esm here but its LAND, not whole) reads its store at the content
  load instead of fetching the copy, and the home's probe counts those pieces as the copy's.
- **The learned order** (`launch-set.js` `forLink`, `contentLight`): the content load is learned under the copy's path
  (the page reads it; a file here whole read as itself then is learned as the copy's read too, `GameData.read`). A
  content file's entry under the file's path read before playable (or in an order without flags — orders learned before
  the copy read the file there, by the same pieces) stands for its light copy **on every link** — unless the sessions
  whose engine reads the copy read it as the file before playable (`CONTENT_REAL`, flags bit 1: their first cells' land
  and references, read after the content load; `server.js` counts them apart — a session's real reads of a content file
  `creal`, `cpre` per entry at its mark, `cmarks` per version, kept in the learned files — so the blocks an older engine's
  content load read, learned under the file's path too, do not keep the whole file in the launch set): those stay the
  file's, in the launch set beside the copy. Entries read in play stay the file's, fetched in the background as any. The
  units seeded (`brSeedUnits`): a same-size copy's pieces of the entry (what a link that is not fast asks) and, when all
  its pieces were read, its block (what a link that asks blocks reads); a content file's pre-playable entry its copy's
  only, unless `CONTENT_REAL`.
- **The engine reads the rest by place** (orthros-r13.patch): the ranges a cell is read from once the content is
  loaded (`MWRender::orthrosCellRanges`: each content file's CELL context — its references —, an exterior's LAND
  context, 8 KiB more for the stream's read-ahead) are announced with the place's reads and waited for once:
  - a cell change (`Scene::changeCellGrid`: the grid's cells not active yet, `meshes:<x,y>`; `changeToInteriorCell`:
    the interior's, `meshes:<id>`) before the cells' references load (`getExterior` / `getInterior` load them);
  - the synchronous terrain preload (`QuadTreeWorld::orthrosReadAhead`: every chunk's cells and the ring around them —
    land and paged objects' references, `terrain:<x,y>`) before the chunks' files are listed;
  - a saved game's load (`StateManager::loadGame`: one pass over the save's record headers, each CSTA's cell — their
    references load one after another — `cells:save`, not learned as a place);
  - between frames, put off until their ranges are in the page (fetched in the background): an exterior grid cell's or a
    door destination's preload (`Scene::orthrosCellReady`), an object paging chunk's model list (`chunkReady`), r12's
    terrain chunks (their LAND, as before).
  Announced places are learned (`/api/places`), so a predicted save's place brings its cells' ranges while the player
  sits in the menu (docs/openmw.md "Anticipated places").

Tests: `tests/light-copies.test.js` (a synthetic TES3 file: offsets, zeroed payloads, kept headers and references, a
moved reference's group, any range; the size threshold and the tree's mark), `tests/br-cache.test.js` (its units),
`tests/launch-set.test.js` (forLink on every link, an order without flags, the file here whole), `tests/game-data.test.js`
(the page: light during the content load on a fast link, the file after for every read, readiness on the file, no
upgrade; announces and big loads; the server's mark by the release's exports; reads of ids only; a store's real pieces;
`CONTENT_REAL` learned and kept), `tests/openmw-streamfs.test.js` (the
hooks), `tests/openmw-builds.test.js` (the patch).

Measured (2026-10-28, a new device, the same pristine state for both — a copy of the live learned directory, a frozen
br-cache copy, covers —; before = the branch's base fc5fcd7 with the live orthros-r12, after = this change with the
dev build orthros-r13dev2 (engine 71c3364eba86, its brotli siblings made as a release's) under r12's name; the light
units not in the frozen copy, so the copies went brotli 5 on the fly). `tools/data-matrix.mjs`, 2 runs per variant at
1 MB/s, 1 at 85 KB/s (a run takes 12-25 min); menu = the runner's `shown`, playable = the in-world mark; "masters" =
the wire of the content files (real or `.light/`) up to the menu:

| version, link | menu (s) | playable (s) | wire to the menu (MB) | masters to the menu (MB) | menu → playable (s) |
|---|---|---|---|---|---|
| GOTY EN, 1m:60 | 72.3 / 72.2 → 45.8 / 49.1 | 87.1 / 86.1 → 70.6 / 74.3 | 61.0 / 60.7 → 37.6 / 38.4 | 33.1 / 33.0 → 6.9 / 7.1 | 14.8 / 13.9 → 24.8 / 25.2 |
| Vanilla+ FR, 1m:60 | 72.4 / 71.9 → 43.4 / 42.8 | 81.6 / 84.1 → 65.0 / 64.7 | 59.4 / 58.0 → 31.9 / 31.0 | 33.9 / 33.8 → 7.9 / 7.9 | 9.2 / 12.2 → 21.6 / 21.9 |
| GOTY EN, 85k:150 | 698 → 384 | 793 → 531 | 53.7 → 28.6 | 32.7 → 7.0 | 95 → 147 |
| Vanilla+ FR, 85k:150 | 663 → 368 | 755 → 497 | 51.4 → 27.6 | 32.6 → 7.8 | 92 → 129 |

- **The menu**: -25 / -29 s at 1 MB/s (-35 / -40 %), -314 / -295 s at 85 KB/s (-45 %); -23 to -28 MB on the wire
  before it, the masters' 33 MB down to 7-8 MB. The engine's first frame moves as much (69 → 43-47 s at 1 MB/s): the
  masters no longer share the link with the engine's own files.
- **The first cell is paid after the menu**: the New Game's load (menu → playable) grows by 10-13 s at 1 MB/s and
  37-52 s at 85 KB/s — the first cells' land and references, 3.3-4.8 MB of the real masters read after the content
  load (announced or on demand: the demand-wait seconds from the menu to playable 1.7-2.5 → 12.3-12.5 s at 1 MB/s, 27 → 81 s
  for EN at 85 KB/s), which the launch set no longer holds. Playable still comes 12-19 s and 258-262 s sooner.
  The learned order will carry those blocks as the file's (`CONTENT_REAL`) once r13 sessions mark playable; the
  pristine order had only r12 sessions in it.
- **`place-load.mjs`** (GOTY EN, 1.8 MB/s and 90 ms, 2 runs each; frozen = the longest gap between frames):
  - save (scenario S, new device): the engine's menu 43 / 44 → 25.7 / 25.8 s (wire to the menu 60.3 / 61.7 → 36.2 /
    34.5 MB); the save's load frozen 12.6 / 12.3 → 12.8 / 12.9 s (+0.2-0.6 s), its announced ranges 11.5 / 11.9 →
    12.2 / 12.1 MB (the CSTA cells' references and land, `cells:save`), demand reads 4 → 8 (0.15 MB of wire, 0.72 MB
    decoded: none of them light).
  - COE to -2,6 (scenario C), new device: in the world 62 / 61 → 45 / 45 s; the frozen load 6.3 / 6.2 → 7.3 / 7.6 s
    (+1.0-1.4 s), announced 9.2 / 8.8 → 9.8 / 9.9 MB, plus 0.84 MB of the real Morrowind.esm in the read-ahead
    (`upgrade` in the tool's categories) — ~1.5-1.8 MB more in the frozen frame, ~1 s at that rate: the growth is the
    land and references' bytes, not serial reads (demand 4 → 4-5).
  - COE, warm profile (each variant's own warm-up): frozen 1.67 / 1.65 → 1.93 / 1.82 s, 0 → 1-2 demand reads.
- **Pictures** (`frame-compare.mjs morrowind-goty-en`, r13dev2, `?contentlight=0` against the default): the open
  exterior 1,-4 the same as the repeat (mean difference 13.48 against the repeat's 13.49: the sky and its light change
  between captures; terrain, trees and rocks in place), Arrille's Tradehouse 0.46 against 0.56; the content load told
  (`content` "done", light from 2.8-2.9 s, loaded at 5.6-5.7 s, 113 requests of the copies). `check.mjs
  morrowind-goty-en` EN and `--lang fr`: ok.
- Not measured: r12 against r13 pictures (only the light copy against the file on r13), a script searching every cell
  (`listRefs` from the copy), a view-grow run, the owner's real link.

## Unannounced serial reads (2026-10-29)

The owner's session (Vanilla+ FR, warm store, ~2 MB/s, the `mid` tier): Chrome's "page unresponsive" through ~430
serial demand reads that no announce covered — the Lua scripts, localisation and quest data of mods added since the
last visit, read one by one at the boot and again at the save's load, and the distant chunks a raised view distance or
a script's ray built in one frame. The two fixes (docs/openmw.md "Serial reads the announces did not cover"):
- the OpenMW page announces at the boot, in one `wait: false` list, every script, localisation, YAML and shader file
  its engine's VFS resolves (`src/ports/openmw/boot-reads.js`, `streamfs.js` `announceBoot`; `?bootreads=0`);
- the engine (`orthros-r14.patch`, dev build) puts off a distant chunk a frame's cull or a script's ray would build
  while its files are not in the page, as r5/r12 do for the sliced preload — built once they are here, or after 10 s
  and two of the page's turns (`window.orthrosTurns`: nothing a put-off asks can arrive inside the task that asked it).

Measured (2026-10-29, `place-load.mjs morrowind-goty-vanilla-plus-fr --query tier=mid --after 75`, the proxy at 2 MB/s
and 85 ms, headless Chromium + SwiftShader; before = `main` 2e7044a with r13, after = this change with the dev build
r14dev; the learned state of before the owner's session — restic 4e0b7ce7 — and a frozen br-cache copy; reads and
blocks from the page's own trace — every synchronous read with its engine stack, a 50 ms timer probe for the blocks —;
"net" = a read that waited ≥ 30 ms. Load average 15-24 during the runs):

| scenario | | before | after |
|---|---|---|---|
| save from the menu, new device (the owner analogue: the new mods not learned) | menu | 36.5 / 35.1 s | 30.1 / 31.4 / 29.9 s |
| | boot → menu: serial reads (their wait) | 161 / 153 (19.6 / 18.1 s) | 82 / 103 / 86 (13.5 / 14.2 / 13.1 s), no Lua among them |
| | the load (key → in world) | 41.8 / 42.2 s | 16.3 / 16.6 / 16.1 s |
| | its frozen frame | 37.4 / 37.8 s | 12.7 / 12.9 / 12.5 s |
| | its serial reads | 299 / 303 (27.6 / 27.8 s) | 16 / 15 / 14 (1.4 s) |
| | after the load (view 8192 → 12288): serial reads, longest block | 100 / 99 (11.9 / 11.4 s), 10.3 / 10.4 s | 8 / 9 / 7 (1.0-1.6 s), 1.3 / 1.4 / 1.3 s |
| save from the menu, warm profile | menu; the load; frozen | 11.6 / 11.7 s; 11.7 / 12.0 s; 9.3 / 9.5 s | 13.0 / 11.6 s; 11.6 / 12.0 s; 9.3 / 9.4 s |
| | serial reads boot / load | 6, 7 / 3, 4 | 6, 5 / 2, 3 |
| | after the load: serial reads, longest block | 27 / 28 (2.9 / 3.0 s), 3.2 / 3.2 s | 2 / 1 (0.2 s), 1.0 / 1.0 s; final build 0 / 0, 0.95 / 0.91 s |
| COE Seyda Neen → -2,6, warm profile (the same profile both sides) | frozen | 4.9 / 4.3 s | 4.2 / 4.0 s |
| | serial reads in the world (their wait) | 35 / 59 (3.5 / 6.1 s) | 5 / 5 (0.5 s) |
| | longest block in the world | 9.2 / 4.4 s | 4.3 / 4.3 s |

The save runs' after column is the first dev build (wall-clock limit only) unless marked "final build" (with the turns);
the COE's is the final build. The first build on a warm profile that missed more of those files (its warm-up 55 s
shorter) froze the COE 13.7 / 14.0 s with 128 serial reads: entries put off inside the COE's one long task, built
there once their 10 s had passed, their files unable to arrive — the turns' rule; the final build on that profile
5.3 / 4.3 s, 12 / 7 serial reads (on `?cullwait=0`, as before r14: 4.1 s, 30). In 3 of 4 final COE runs some entries
were still built after their limit (~23 s put off, their files never ready in the page's answer): not explained yet,
their reads few (≤ 12 in the world). The boot's remaining serial reads are the engine's common assets, the content
files' first records and the water's textures (none announced; the learned order has them). Not measured: the
owner's real GPU and link, the 85 KB/s link, a headed Chrome's hang dialog.

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
