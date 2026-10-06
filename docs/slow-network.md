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
  the link was busy (concurrent requests count once), less one round trip per busy stretch; the round trip is the
  shortest time to the first byte of an answer (`firstByte`: when `fetch` resolves, before the body). Kept by the page
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
(what stalls the page's main thread there: the harness's evaluations stop too).
