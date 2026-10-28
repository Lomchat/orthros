# Platform health: the server under load, long sessions, first visits

Measured 2026-10-22 (optimisation wave 4, package "platform health"). Each section: the tool, what it measures, the
numbers before/after the changes, what was found clean.

## The server under many players

`tools/server-load.mjs --url <server> --clients 20 --seconds 20 [--pid <server pid>]` — N simulated players at once,
each a first visit of the home (page, config, catalog, covers) then a game's start as the shared reader does it
(manifest, tree, learned order, then the order's demand pieces/blocks 4 in flight and background blocks 2 in flight).
A probe asks `/api/config` every 25 ms: its latency is the event loop's stall. `/api/netstats` now tells the server's
own state (`server`: memory, encoded-range cache, encode queue, src brotli cache, learned sessions, kept listings).

Found (CPU profile under load, production library and learned orders, `gzip, br` as Cloudflare forwards):
- every `/gamez` request listed each folder of its path in every layer (`readdirSync`; a texture folder of thousands of
  files): 5.5 s of the main thread in 30 s → `DirListings` (game-files.js), a listing kept and checked by one stat of
  its folder; a folder changed within 2 s is listed again at each use (the file system's coarse clock: two changes in
  one tick keep one mtime — dirsStamp has the same rule now);
- on-the-fly encodings unbounded: ~120 compressions queued on libuv's 4 threads, each with its range and encoder state
  (RSS 180 MB → 1.6 GB), the game's reads behind the downloads → at most `pool − 2` at once, demand first (a background
  job every third turn), the same range encoded once for every player asking it at once (`joined` in netstats), brotli's
  window sized to the range; the CLI server sets `UV_THREADPOOL_SIZE=8` (unless set);
- `/api/manifests` summed each tree and checked each OpenMW install for every language at every call, and every demand
  read made it summarize the launch sets again → tree sizes kept per tree, install checks once per answer, launch
  summaries reused 30 s after a read (a mark still forgets them at once);
- learned sessions (a key per block read each) were pruned only past 1000 sessions older than 6 h → 256 at most, the
  least recently active out.

20 players, 20 s, median of 3 alternated runs (base = a36cd74's tree):

| | before | after |
|---|---|---|
| /gamez demand p50 / p90 | 94 / 193 ms | 74 / 125 ms |
| /gamez background p90 | 612 ms | 480 ms |
| bytes served | 1.04 GB | 1.47 GB |
| event-loop probe p99 | 138 ms | 54 ms |
| /api/manifests p50 (idle) | 124 ms (63 ms) | 44 ms (30 ms) |
| covers p50 | 47 ms | 9.5 ms |
| server RSS max | 1.50 GB | 0.75 GB |

Left: `/api/manifests` 30 ms idle is now the trees' folder stamps (~12 ms, one stat a folder) and the engines'
release files (~7 ms). The precompressed units' generator (br-cache) had no backlog in production (wanted 0, not
seeding); its hourly reseed holds the thread ~20 ms.

## Long sessions

- Win32 (Node, no rendering): `node tools/startbench.mjs bfme2 --games-dir data/games --cold --input
  tools/scenarios/bfme2-menu-long.txt --limit 2400 --mem 60 --heap-at 300,1500`. BFME2's menu held 40 min: JS heap
  222-241 MB (sawtooth, no trend), translations 14 261 live from minute 11 on (none dropped, none added), heap
  snapshots at 5 and 25 min: +7 400 nodes, +0.2 MB — no leak on the emulator's side.
- re3 driving: `tools/re3/perf.mjs vice-city-revc --gl discard --drive --seconds 600 --mem-every 30`: page heap 7.5 →
  7.6 MB, engine heap 256 MB flat, DOM nodes 198 → 194, listeners 102 flat over 10 min.
- OpenMW in world: `tools/openmw/perf.mjs morrowind-goty-en --discard --seconds 900 --mem-every 30`: event listeners
  climb 110 → 216 between collections (sawtooth) and the JS heap 22 → 31 MB, but after the forced full collection that
  ends the sampling (memSampler's last sample) 110 listeners and 22.4 MB — the start's level: garbage not yet collected
  (the streaming's requests), no leak. DOM nodes 1 308-1 349 flat.
- The players' own telemetry (`mem`, measureUserAgentSpecificMemory): BFME 38 min flat at 2.4 GB; Vice City (Windows)
  ~+30 MB per 10 min over 34 min — the only real-machine trace; not reproduced here (no browser rendering at length).

Not measured: GPU memory (textures, buffers) over a long session in a real Chrome.

## First visits

`tools/page-weight.mjs <page.html>` — a page's module graph as the server sends it (brotli 11), its depth.
`tools/home-check.mjs --url <server> --kbps 85 --rtt 80 --runs 3 --pages /,/ports/re3/<id>/` — a fresh profile on a
throttled link (Chrome's own emulation): first paint, the library drawn, the covers in view, the network quiet, bytes.

Home at 85 KB/s, 80 ms, median of 3:

| | before | after |
|---|---|---|
| first paint | 2.90 s | 2.56 s |
| library drawn | 3.53 s | 3.06 s |
| covers in view shown | 6.33 s | 4.62 s |
| network quiet | 10.2 s | 5.1 s |
| bytes (covers) | 773 KiB (560, 11 covers) | 360 KiB (171, 3 covers) |

Changes: covers of the cards near the viewport only (IntersectionObserver), a backdrop's image set when shown; the
ring constants the page needs in `src/host/host-proto.js` (the host's graph — PNG, frame accounting — not loaded by the
home); `bench.js` loaded in bench mode only. Graph 31 → 26 requests, 143 → 121 KiB, depth 4 → 3.

Tried and dropped: `<link rel="modulepreload">` for every module of a page's graph, injected by the server — home
−0.1 s, the three port pages +0.03 to +0.29 s (the preloads compete with the page's own scripts on a thin link).
Taken back for the home only (2026-10-28, `server.js` sendHome, `src/host/module-graph.js`): that trial measured a
first visit, where bytes are the bottleneck; a returning player's home revalidates each module (no-cache, a 304 each)
and walks its graph — 7 levels by then — a round trip per level. The home now carries a `modulepreload` for each module
of levels 2 and deeper, its ETag its content's. `tools/home-check.mjs --warm` (same profile, second load), median of 5,
against the same tree run with `--no-home-preload`:

| link | /api/config asked | library drawn |
| --- | --- | --- |
| warm, 450 ms RTT | 4.56 → 3.65 s | 5.84 → 4.86 s |
| warm, 200 ms RTT | 2.10 → 1.66 s | 2.66 → 2.58 s |
| first visit, 85 KB/s, 80 ms | 3.58 → 3.43 s | 4.50 → 3.99 s |

(CDP's emulated round trip, a scratch server on localhost.) At 200 ms the library waits for something after
/api/config (−0.44 s there, −0.08 s drawn): not looked into. The port pages keep their HTML as it is. Not checked: the
0.1-0.2 s stagger between modules of one level in the owner's Caddy log (Chrome's revalidations, or Cloudflare), and
the Caddy waterfall of a real returning home after the deploy — the measure step's.
Measured again by the measure step (2026-10-28, same tool, two scratch servers on this tree, preload on vs
`--no-home-preload`, 2 runs of median-of-5 per arm, the arms' order swapped in the second): warm 450 ms /api/config
4.57/4.57 → 3.64/3.64 s, drawn 5.87/5.85 → 4.84/4.84 s; warm 200 ms /api/config 2.09/2.09 → 1.66/1.68 s, drawn
2.64/2.68 → 2.60/2.59 s; first visit 85 KB/s 80 ms /api/config 3.58/3.58 → 3.42/3.42 s, drawn 4.48/4.48 → 4.00/3.98 s,
340 KB both. The −0.5 s bar is met at 450 ms only (−0.93 s); at 200 ms /api/config gains 0.42 s and the drawn library
0.04-0.09 s. Not measured yet: a real returning home behind Cloudflare (Caddy waterfall), a thin-link run on the live
server.

Port pages at 85 KB/s (unchanged): first paint re3 2.2 s, GoldSrc 2.8 s, OpenMW 2.0 s; 64-90 KiB of modules, of which
`data-manager.js` (15 KiB, the settings window) on every page — splitting its window out (loaded at first open) is the
next saving; its stylesheet also styles the page header, so it stays render-blocking.
