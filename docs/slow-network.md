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
  the link was busy (concurrent requests count once), less one round trip per busy stretch (the round trip timed on
  small answers). Kept by the page (`localStorage['orthros.netBw']`) as the next visit's first estimate. Until
  measured, the link is treated with care (256 KiB requests, one background request at a time).
- **Demand first**: a background download waits for its turn (`turn(prio, quietMs)`): no game read in flight, the link
  quiet for the download's own delay, at most `maxBackground()` at once (one per ~4 MB/s of link: one on a thin link).
  Priorities: a sequential reader's next bytes and the learned pieces just ahead of the game first (its next reads),
  then the block fill, the learned prefetch, the blocks next to missed ones, the offline copy. A waiting download a
  parked read now waits for is promoted (it is demand now).
- **Sizes from the measure**: a background request carries about `BG_SECONDS` (0.35 s) of the link (64 KiB at 85 KB/s,
  ~0.5 MiB at 1 MB/s, 4 MiB on a fast link); a demand read rounds up by at most `DEMAND_SECONDS` (0.25 s) of the link
  past what the game asked (a stream's window grows with the stream, within that bound). A file read whole no longer
  fetches 1-4 MiB blocks synchronously on a link that is not fast: it goes by pieces, its next bytes come ahead in
  background requests of the link's size (`readAheadParts`, 2 s of the link ahead).
- **No abort waste**: background requests are small enough to finish (a demand read that comes waits at most their
  rest); only those that would hold the game up longer than 1.5 × `BG_SECONDS` are aborted (sized before the link was
  measured, or the link slowed down); a synchronous read aborts the background requests for the same bytes (the worker
  cannot receive their answers while it waits: they would cross the link twice).
- **Thin link** (below 1.5 MB/s): no speculative whole blocks — no block fill for a piece read, no "near" blocks, the
  learned prefetch fetches the learned pieces (the masks: what earlier sessions read) only. A file the game opened and
  closed again (a movie skipped, a file parsed) is not fetched ahead any more until the game opens it again.
- **Learned order**: the server's prefetch list (`/api/prefetch/<manifest>`: `[path, block, mask, t]`, sorted by the
  time `t` the earliest sessions needed it) drives the pieces fetched ahead of the game's position in it and the
  background pass; `t` also gives the current step's size (`HttpBackend.stepEstimate`: the learned pieces past the
  game's position up to the first 5 s pause in that timeline).
- **Kept**: on a link that is not fast, the pieces themselves go to the OPFS store (keys `path#size#mtime#c<piece>`);
  a block whose pieces are all here is assembled and stored whole (its pieces dropped). A second launch reads them
  locally.

A fast link (measured at 24 MB/s and more: a local network) keeps the earlier policies (whole blocks, block fill,
several background requests, aborts on demand).

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
  stops it first (the game's worker opens the same stores). The settings' "offline copy" still downloads in the
  background while the game runs (now through the same turns, after everything else).

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

## Measurements

See the end of this file (filled in with each change).
