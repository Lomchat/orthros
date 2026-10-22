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
`WHOLE_AFTER_MISSES` (3) distinct blocks — not a media file, not a stream — is wanted whole (`wantWhole`: its other
blocks in the background fill's `later` queue, after the blocks the game touched and those near them, the link quiet
for NEAR_QUIET_MS). Only on a fast link and with a block store (OPFS, or the harness's memory store): the blocks stay
for the next sessions. Generic: the data system of every runtime (the ports' streamed files already asked it).

Measured (the same run beside the former tree, at the same time): reads on the network in play 37 → 13 (2.8 → 0.7
MB; the rest: the music stream's next bytes, files first read late), the game's own requests over the session 124 →
68; the cost, the bytes downloaded over the session 414 → 820 MB (W3D.big, Audio.big and others whole, in the
background; kept in the store).
tests/http-backend-whole.test.js.

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
  none without `--learn`, `off` for none), at most `--br-cache-bytes` (1.5 GiB): `<k[0:2]>/<k>/` per file version, `k`
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
- **Covers**: `/api/cover/<version>` sends a light copy once made (`src/host/light-covers.js`: 960 px wide at most,
  WebP, made by ffmpeg in the background, one at a time, niced, kept in `--covers <dir>`, default
  `<learn>/../covers`; `?full` the image itself; without ffmpeg the covers go as they are): the home's nine covers
  1737 → 388 KB.
- **Mask-less learned orders**: `tools/learn-prune.mjs <learn dir>` lists each order's mask-less entries (learned
  before masks: whole blocks — a thin link's learned pass skips them, a between link fetches them whole) and, with
  `--write`, drops them from the orders that have enough masked entries (a backup kept; the server stopped meanwhile:
  it writes its orders back). Live orders: bfme-vanilla 663 of 698 entries (663 MB of whole blocks, 18 MB masked),
  bfme2 636 of 860 (76 MB masked), none elsewhere.

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
