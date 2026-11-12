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
   (the plain kind `orthros run` reads, not a catalog manifest) overrides the guess. An ISO is also mounted as the CD-ROM
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
as symbolic links in the scratch to the read-only `data/` (Chrome's directory input follows them).

RESULTS

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
