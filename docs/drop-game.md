# Drop your game (prototype, `?dropgame=1`)

A player runs a Windows game **they have on their own machine**: the home's discreet "Lancer mon jeu" entry (under the
library's heading, only with `?dropgame=1` until validated) takes a game folder already installed (Chrome's
`showDirectoryPicker`, else an `<input webkitdirectory>`) or a CD image (`.iso`). Nothing of the game goes to the server.

## How it works

One system for every game's data (CLAUDE.md "Standardization"): a dropped game is a version like the server's, read by
the same reader from the same OPFS block store.

1. **Listing** (`src/vfs/local-games.js`): the folder's files (`filesOfHandle` / `filesOfList`), or an ISO 9660 image's
   (`filesOfIso`: its Joliet names when it has them; each file a `Blob.slice` of the image — nothing read but its
   directories). Its tree is built as `/api/tree` lists a version (`folderTree`: size, date in ms).
2. **Manifest**: synthesized by the rules of `orthros run <folder>` — one module, `src/shared/folder-manifest.js`
   (`pickExeFrom`, `withDefaults`), which `src/server/manifest.js` now uses too. A `manifest.json` at the folder's top
   (the plain kind `orthros run` reads, not a catalog manifest) overrides the guess — only the Win32 options of
   `LOCAL_KEYS` (`local-games.js` `localOptions`: exe, args, cwd, env, dllOverrides, display, cdrom, registry, keys,
   language files, patches, profile moves/settings); `launchUrl` (a `javascript:` URL would run on Orthros' origin — a
   booby-trapped folder), a port runtime, `extraMounts`/`parts`/`ownerLegacy` are dropped, and a description saved by an
   earlier page is filtered again when loaded (security fix at integration, 2026-11-13). A block missing from the copy
   fails its read without a request (`HttpBackend.offline`): the folder's name and paths never reach the server. An ISO is also mounted as the CD-ROM
   drive D: under its volume label (manifest `cdrom`). The id, `local-<folder>-<8 hex>`, hashes the folder's name and
   listing: the same folder dropped again is the same game (same store, same saves).
3. **Copy**: the whole-game download's worker (`src/web/download-worker.js`, message `import`) copies every file into
   the version's store `orthros-files-local-…`, block by block under the reader's own keys (`http-backend.js
   storeKey`). Blocks already there are skipped: an interrupted copy resumes. The game's description (manifest, tree,
   `complete`) is kept beside the blocks (`local.json`); removing the game's cache (data manager) removes the game.
4. **Run**: `main.js start('local-…')` takes manifest and tree from the browser instead of `/api/manifest`,
   `/api/tree`; the worker opens it with `openVersion` like any version (`local`: a store miss fails at once, never
   retried against a server that does not have the game). Off for a local game: learned prefetch, compressed ranges,
   learned GL programs / code regions / heat, the shared first-launch profile, snapshots, the virtual LAN, telemetry,
   the account's save sync. On: the persistent translated-code cache, the OPFS profile (saves under the game's id).

`tests/local-games.test.js` guards the one thing that would break it silently: a folder copied by `copyIntoStore` is read
back by `openVersion` / `PartsBackend` with no request at all (a key-format drift between the copy and the reader fails
it), the copy resumes, and the exe chosen is the game's, not its installer.

## Gate (BFME 1.08, headless)

`tools/headless.mjs <label> --drop <folder> --opfs <profile> --games-dir <empty catalog>` gives the folder to the home's
input (as a player's pick), waits for the copy, then plays it; `?dbg=ORTHROS_READ_SUMMARY=1` logs the game's reads
(files, reads, bytes, a digest of the files in the order of their first read) to compare with the same folder served
over HTTP (`tools/headless.mjs <folder>`: the server's synthesized manifest, the same one).

The folder: BFME1 `base/` with `versions/1.08-complete-v1.6/` over it (case-insensitive, the base's directory case kept),
copied (read-only) into the scratch, 3.8 GB, 361 files — Chrome's directory input skips symbolic links: a folder of links
to `data/` lists no file at all.

Measured 2026-11-12 (headless Chromium, SwiftShader, 4 cores; shared 48-core host at load 24-37 — the fps are noisy),
the same synthesized manifest in both arms (`lotrbfme.exe`), translated-code cache off (`--code-cache 0`), fresh profiles
unless said:

| run | copy into the browser | first Direct3D frame | game's reads at the menu (files, reads, MiB, first-read digest) | fps, t = 115-241 s (menu shell) |
|---|---|---|---|---|
| HTTP, same folder (`headless.mjs <folder>`) | — (176 MB sent, 392 MB read by the server) | 88 s | 116, 790, 119.2, `bec5c71a` | 3.58 |
| dropped, first (fresh profile, run 120 s) | 30.4 s for 3882 MiB (128 MiB/s; 36.5 s with the listing) | 73 s | 116, 774, 119.0, `bec5c71a` | — |
| dropped, again (same folder: the copy resumed — nothing to copy) | 0.0 s (1.1 s with the listing) | 14 s (*) | 116, 796, 119.3, `bec5c71a` | 4.30 |

(*) its profile kept the files the game's first launch wrote (the run before): the game skips its first-launch work, as a
player's second launch does. Both arms reach the main menu's shell map (Barad-dûr and the title; 48 vertex arrays, 22
GL programs, ~45 draws per frame); the reads are the same files in the same first-read order (the read counts differ by
the timing of the game's streaming threads), and no request for a game file was made by the dropped runs (io 0 MB, no
`/game` or `/gamez` request: the store answered every read).

The first run picked `worldbuilder.exe` (the map editor, the folder's largest executable: the folder's name `bfme1-108`
matches neither) and exited on its dialogs: the shared rules now leave editors and dedicated servers out
(`NOT_THE_GAME`: editor, worldbuilder, worldedit, mapedit, leveledit, modtool, dedicated), and the drop entry lists the
candidate executables of a dropped game, the guess selected, to change it.

## Limits

- **The whole folder is copied before the game starts** (a second copy of the game in the browser's storage: a 4 GB game
  takes 4 GB of OPFS quota). Streaming the reads from the picked files while the copy goes on (the reader fed from
  `File.slice` through `FileReaderSync` on a miss) is the next step; a persisted directory handle (IndexedDB) could also
  avoid the copy at the cost of a permission prompt per visit.
- **No compat flags**: the synthesized manifest knows nothing of the game (no registry seed, no `languageFiles`, no
  patches, no `profileMoves`). A game whose catalog manifest needs them may behave differently (BFME 1.08: both its
  English and French patch archives visible; no `UserDataLeafName` registry value). A dropped folder recognised as a
  catalog version (by its executable's size and hash) could take that version's manifest: not done.
- No learned data (the server never sees the game): no learned prefetch (not needed: every block is local), no learned
  GL programs or code regions (the first launch compiles them as a new game's does), no snapshot.
- Saves stay in this browser (not synced to the account).
- ISO: ISO 9660 / Joliet only (no UDF-only images, no multi-extent files); the image's files are the game folder — an
  installer disc is not installed (run the installer on Windows, then drop the installed folder).
- A block the store loses (checksum mismatch, storage cleared) cannot be fetched again: drop the folder again (only the
  missing blocks are copied).
- Chrome only (OPFS sync handles in a dedicated worker); `showDirectoryPicker` is Chromium's (the `<input
  webkitdirectory>` fallback elsewhere).
