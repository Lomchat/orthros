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
  it stands for (`lightTga`, `tgaLight`; made from the file when read, the last 32 MB of them kept). Morrowind's eleven
  loading screens are 1024 × 1024 × 24-bit, 3 MB each (2.8 MB on the wire): its loading screen shows a new random one
  every 5 s while the game is not started (OpenMW's `LoadingScreen::changeWallpaper`), so at 85 KB/s each new picture
  held the page ~33 s more (8 of them in a New Game's first load: 21 MB of its 28); light, 197 KB each.
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

## Playable after (2026-10-21)

The first pause of the learned order (2 s, `STARTUP_GAP_MS`) is not when a game becomes playable: OpenMW's French
order pauses after 1 MB, its main menu comes at 198 MB. So the pages say when it is, and the server learns from it —
every runtime, one implementation (`src/vfs/launch-set.js`):

- **The mark**: `GameData.mark('playable')` (`src/vfs/data-client.js`) when the game first draws in play — GoldSrc and
  re3: where their loading screen hides (`hideLoader`); OpenMW: when the player is first in the world (Orthros'
  PLAYER script, `view.lua`, tells its view from its first poll: after the menu and the load, `streamfs.js`). The data
  worker sends it once per session with every read before it (`{ session, reads, mark: { kind, t } }` to
  `/api/prefetch/<manifest>`). The Windows games do not mark yet.
- **The server** (`learnMark` in `src/host/server.js`): each learned block the marking session had read by then counts
  it (`pre`, the 5th element of a row of `prefetch-<manifest>.json`), the version counts its marking sessions
  (`playable-<manifest>.json`, `{ marks }`). Once one marked, each entry of `/api/prefetch` carries a 5th element, its
  flags: bit 0 (`PRE_PLAYABLE`) when it was read before playable in at least half the marking sessions.
- **The launch set** (`launchSet`: `startupHead(forLink(order))`): the flagged entries as this link reads them (light
  copies on a link not fast, no media there); an order without flags falls back to its first pause. It is the startup
  set the GoldSrc and re3 pages wait for (`startup()` in the data worker). A version that requires others as separate
  parts (`extraMounts`: a Windows game over another's folder; a port's required versions are underlays, in its own
  tree) adds their launch sets, each from its own learned order — the startup set, the card's sizes and Prepare alike.
- **The home card** (`/api/manifests` `launch: { bytes, lightBytes, wire, lightWire, entries }` per version,
  `launchSummary`; null until a session marked it; made again when the order changes, at most every minute): `bytes`
  the launch set's learned pieces on a fast link, `lightBytes` with light copies (a link not fast), the `wire` bytes
  those of the precompressed units already made (`brCache.size`; a unit brotli could not shrink: its range's bytes),
  else 0.75 of the bytes. The card says "Playable
  after 80 MB, about 10 min at your link (100 KB/s)" (`launchStatus` in `src/host/web/download.js`, the rate
  `linkRate`; the size only while none was measured), above the whole download's line, hidden once the whole game is
  here or downloading.
- **Prepare** (the line's button): the download worker fetches the launch set only (`{ type: 'launch' }`:
  `HttpBackend.prefetch` with `learnedOnly`, the pieces as the startup set fetches them) into the same OPFS store; pause
  and resume (the pieces here are skipped; the progress is kept in `localStorage['orthros.launch.<manifest>']`, the
  pieces here counted again each half second — `setBytes`). Starting a game stops it first, as the whole download.
- Not measured yet: the launch sizes on the live server (no session marked before this change). OpenMW's in-world mark
  was seen in a browser on 2026-10-21 (the 85 KB/s run below: `playable-<manifest>.json` `{ marks: 1 }`, 446 of the
  French order's 1781 entries flagged).
- **While the player waits** (2026-10-21): the learned order fetched in the background puts its launch set first
  (`launchFirst`: the flagged entries, then the others, each in its order; the media still last on a link not fast) —
  followed from the game's position, a player sitting in the menu gets the rest of the way to playable (a new game's
  first load) before what sessions read later. The data worker tells the page the way left while the game is not
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
  pausing while the 1-minute load average is ≥ 24 or the disk is over 85 % full (it evicts meanwhile). Order: the live
  misses, the most asked first; then each manifest's learned order (`/api/prefetch`, earliest `t` first), the browser
  ports' manifests first — a block learned whole (or without its pieces' mask) as a block unit, else its learned pieces;
  a listed texture's light copy first (by pieces: a light copy is read on a link that is not fast). The first half of
  the budget, shared between the manifests, is their **launch set**: pinned (evicted last). More of each order is made
  while the cache is under its low mark. Rebuilt at start and every hour from the learned files.
- **Kept** in `--br-cache <dir>` (default `<learn>/../brcache`, i.e. `/var/lib/orthros2/brcache` on the live server;
  none without `--learn`, `off` for none), at most `--br-cache-bytes` (1.5 GiB): `<k[0:2]>/<k>/` per file version, `k`
  the sha1 of the file's resolved real path, size and mtime (and the light copy's shape: `LIGHT_SIDE`, size, offset —
  manifests sharing a `base/` file share its units), `meta.json` and `b<block>.br` / `p<piece>.br` files written
  through a temporary file renamed. The index is rebuilt from the disk at start. Over the budget, least recently used
  out (unpinned first) down to 90 % of it. Never stale: a changed size or mtime is another key, the generator checks
  the file before and after reading it, and a sweep (at start, hourly) removes the versions of files gone or changed.
- **Client** (`HttpBackend.fetchBackgroundNow`, `rangeUnits`): a compressed background range that covers several units
  goes as one request per unit, in parallel (HTTP/2 through Cloudflare: ~300 B of headers each), joined — whole blocks
  where they fit, else pieces (runs across a block boundary too), at most 16 parts; the download fails if any part
  does. The game's own reads are unchanged: the synchronous XHR of a Windows game stays one request (on a slow link it
  is mostly a single piece already: a unit), and so do the parked asynchronous reads (`fetchForeground`).
- **Measured** (one 1 MiB sample block per file, against gzip-4's bytes): brotli 11 per block 72 % (Morrowind.bsa
  40-69 %, gta3.img 67-68 %, Morrowind.esm 77 %, halflife.wad 86 %), per independent piece 80 %, brotli 5 on the fly
  86 %. Not measured yet: the hit rate and the bytes saved on the live server; Cloudflare passing an origin's
  `Content-Encoding: br` through unchanged was seen for gzip only (to check:
  `curl -D - -H 'Accept-Encoding: gzip, br' 'https://orthros.chalco.website/gamez/<manifest>/<path>?r=0-65536&p=1'`).

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
  --learn-from <copy of the live server's learn dir> --games-dir /srv/orthros/data_games
```

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
