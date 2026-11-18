# Frozen builds: one version of the code per session (2026-11-18)

## Why

The pages have no build step: the browser loads `src/` as it is. Until 2026-11-18 the server served the live tree at
`/src/...` with `Cache-Control: no-cache`, and the live tree is also where merges land (`/srv/orthros`, served by
`orthros.service`). A deploy during a session could therefore mix two versions in one page: the page and `main.js` of
build A, then — when the player starts a game — the emulator's worker, its ~100 modules, the render worker and every
lazy module of build B. `main.js` only noticed when the worker failed to load at all (`staleCode`: one reload). Measured
on a scratch server (home loaded, the tree changed and the server restarted, then a game started from that page —
"Measured", below): the page ran `main.js` of A and the worker `worker.js` of B (464 module requests after the
deploy, all from the new tree).

## How

- **A build** is the live tree's `src/` but `src/server/` (the server's own code, which no page loads: a server-only
  change makes no new build, so no player downloads the page's code again for it). Its id is the start (16 hex
  digits) of the SHA-256 of its files' paths and content hashes (`src/server/build-store.js`).
- **The store** (`--builds <dir>`, default `<learn>/../builds`: `/var/lib/orthros/builds` for `orthros.service`; none
  without `--learn`, or with `--builds off`) keeps each file's bytes once, by content (`blobs/<sha>`), and each build as
  a tree of hard links to them (`<id>/src/...`, `<id>/build.json`: its version and files). A new build costs its changed
  files and ~260 links (the first one 5.6 MB).
- **Cut**: at start, then when a page is picked and the live tree changed (one stat a file, at most every 2 s) and is
  quiet (no file written in the last 1.5 s, or the same changes seen 1.5 s ago — a merge being written serves the build
  before meanwhile).
- **Served immutable**: `/b/<id>/src/...` with `Cache-Control: public, max-age=31536000, immutable` and a strong ETag
  (the content hash), brotli 11 made once per content (shared by every build holding those bytes). A build no longer
  kept answers **410** — never another version's file.
- **Pages pick their build at their load**: the home (`/`, with its modulepreloads), the ports' pages
  (`/ports/<runtime>/<manifest>/`), the legal pages, and the OpenMW engine page (from the Orthros page around it:
  `?b=<id>`, `play.js`). The server moves the page's `/src/` addresses into the build (`pageInBuild`: `src=`, `href=`,
  `import('…')`, `from '…'`). The pages stay `no-cache` (each load picks the current build).
- **Relative addresses only**: a module names its workers, worklets and lazy modules from `import.meta.url`
  (`new Worker(new URL('./worker.js', import.meta.url))`), a classic script from `document.currentScript.src`, so
  everything a page loads comes from its build. `tests/build-store.test.js` fails on an absolute `/src/` string in the
  page code. A `/src/` request whose `Referer` is a build's module is redirected (307) into that build.
- **Kept** while it is the live build, the server's start's or the stable one, or used (a page picked it, a file of it served) within 7 days;
  at most 300; pruned hourly (then the blobs no build links). A tab open for over a week on a pruned build gets 410: the
  Win32 page reloads once (`staleCode`) and picks the current build.
- **What depends on the build** follows the page's: `/api/snapshot-sources?build=<id>` is that build's state-owning
  sources' hash (the snapshot key keeps its meaning: the code the session runs; a build not kept: 410, no snapshot),
  `/api/config?build=<id>` its version (`<commit>@<time>/<id>`, the telemetry's `build`). `src/shared/build-path.js`
  `withBuild` adds the page's build. The warm jobs key snapshots with the build players get. Learned data (prefetch
  orders, GL programs, code regions, the JIT's code cache) is keyed by content, not by address: unchanged.
- Without builds (a development server: no `--learn`) the pages load `/src/` as before.

## Channels

`<store>/channel.json`, written by `node tools/ops/build-channel.mjs <command>` (the server reads it at its next page,
no restart; `status` shows the channel, what a page gets and the builds kept):

- **auto** (the default): players get the live tree's latest build — every deploy, a merge into the live tree or a
  restart, reaches the next page loaded, as before builds; running sessions keep theirs.
- **restart**: the build of the tree as it was when the server started — a merge reaches players at the next restart
  (`orthros.service`: 1-5 restarts a day against 8-24 commits of page code, 2026-11-11..18).
- **stable**: `promote` pins the live tree's current build (`promote <id>`: any build kept — a rollback) until the next
  promotion, whatever the live tree does.

Whatever the channel, a page opened with `?channel=main` (kept in a cookie; `?channel=stable` to leave it) gets the live
tree's latest build — to try main before promoting it. A pinned build only freezes the page's code: the server's (its
routes, the shared modules it imports, e.g. the learned GL programs' ids) is the live one — promote at least at each
change of what the pages and the server say to each other.

## Measured (scratch servers, headless Chromium through tools/with-browser-slot.sh, 2026-11-18)

- **A session across a deploy** (home loaded; `worker.js`, `shell.js`, `kernel32.js` changed and the server restarted;
  then a game started from that page — main.js makes the emulator's worker): before, the page ran `main.js` of the
  first tree and the worker the changed `worker.js` (464 module requests after the deploy, from the new tree); with
  builds, all 464 came from the page's build (the worker's `worker.js` without the change) and a page loaded then got
  the new build. The ports' pages (Half-Life, Vice City reVC, Morrowind) and the OpenMW engine page's classic scripts:
  every module and worker (data worker, data meter, wasm compile worker) from the page's build, no error.
- **A returning player's home** (`tools/check/home-check.mjs --warm`, median of 3): at 80 ms round trip, first paint
  1075 → 333 ms, `/api/config` asked 871 → 144 ms, library drawn 1479 → 398 ms; at 85 KB/s and 80 ms, drawn
  1510 → 461 ms. 51 module revalidations (304) → 0 (52 from the browser's cache), 24.2 → 3.2 KiB.
- **A first visit** (85 KB/s, 80 ms): the same, 343 → 347 KiB (`build-path.js`), library drawn 5.53 → 5.54 s.
- **The cost — a new build is new addresses**: a returning player who meets a new build downloads the page's code
  again, its unchanged modules too: the Win32 session's code (the page's and its workers' graphs) is 198 files, 1229 KB
  of brotli, where a revalidating player downloaded the changed files only — 397 KB after 9 h of commits, 439 KB after
  a day, 554 KB after 5 days. +0.7-0.8 MB at the first load after a new build: ~+9 s at 85 KB/s, ~+0.2 s at 3.9 MB/s;
  the home alone is 292 KB of brotli (its first visit above: 5.5 s at 85 KB/s). The `restart` and `stable` channels
  make new builds rarer; reusing the unchanged files across builds would need a service worker serving the page's code
  by content (not done).
- **Server**: the first cut 0.2 s (5.6 MB written), a restart 56 ms (the tree hashed again), a look at the live tree
  4.8 ms (at most every 2 s, at a page picked), a new build ~0.3 MB of the store.
