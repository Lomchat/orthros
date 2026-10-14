# Browser ports: games whose engine runs as browser code

Orthros runs two kinds of games. Both are declared by `data_games/<game>/manifest.json`, listed on the same home,
served by the same server (`src/host/server.js`, `orthros.service`) on the same origin. The version's `runtime` says
which kind it is:

- **`win32`** (the default): the unmodified Windows game in Orthros' own emulator (`src/cpu`, `src/loader`, `src/win32`,
  `src/gfx`, ...), written from scratch.
- **`goldsrc`**: a browser port. The game's original files run on a pinned third-party GoldSrc engine, Xash3D FWGS
  compiled to WebAssembly, with the game's client/server/menu modules compiled to WebAssembly too. Its page is
  `src/ports/goldsrc/`; it never loads the Win32 runtime, and the Win32 runtime never imports it.

Nothing in the code names a game: engine release, game directory, modules, maps and server ports come from the manifest.

## Where things are

| Path | Content | In Git |
| --- | --- | --- |
| `src/host/goldsrc.js` | manifest checks, engine availability, multiplayer relay, linked game tree of the dedicated server | yes |
| `src/ports/goldsrc/` | the port's page (`play.html`, `play.js`, `storage.js`, `style.css`) | yes |
| `tools/goldsrc/` | `lock.json` (pinned upstream sources and artifacts, SHA-256), `install-engine.py`, `build-server.sh`, `build-modules.sh` with `patches/` and `cmake/` (game modules from source), `server.mjs` (dedicated server), `orthros-goldsrc@.service`, `check.mjs` (browser check) | yes |
| `data_games/<game>/` | `manifest.json`, `cover.svg`, `base/` (the original files), `versions/<version>/` | no |
| `data_engines/<release>/` | installed engines: `xash3d-web-1.2.2` (browser), `xash3d-web-1.2.2-cs16-15278ca` (the same engine with Counter-Strike modules built from source), `xash3d-dedicated-e0ece3d` (native dedicated server) | no |
| `data_engines/src/` | upstream checkouts at their pinned commits: `xash3d-fwgs` (builds the dedicated server), `cs16-client` with its submodules (builds the Counter-Strike modules), `webxash3d-fwgs-cstrike` and `hlsdk-portable` (reference for later work) | no |

The engines stay out of Git like the games: the repository is public, the engine, wrapper and SDK-derived modules
carry their own licenses (notices below), and the browser game modules were recovered from a deployed build whose
sources no longer exist. `lock.json` and the install scripts reproduce them while their sources remain available;
treat `data_engines/` like `data_games/` (the only copy of the recovered modules).

## Manifest

```json
{
  "schemaVersion": 1, "id": "half-life", "name": "Half-Life", "defaultVersion": "half-life-original-en",
  "defaults": { "runtime": "goldsrc", "coverFile": "cover.svg" },
  "versions": [{
    "id": "half-life-original-en", "dir": "original-en", "version": "Original · English", "languages": ["en"],
    "goldsrc": {
      "engine": "xash3d-web-1.2.2", "gameDir": "valve",
      "modules": { "client": "halflife/valve/cl_dlls/client_emscripten_wasm32.wasm",
                   "server": "halflife/valve/dlls/hl_emscripten_wasm32.wasm", "menu": "engine/libmenu.wasm" },
      "solo": { "map": "c0a0" },
      "multiplayer": { "server": "xash3d-dedicated-e0ece3d", "port": 28015, "map": "crossfire", "maxPlayers": 16 }
    }
  }]
}
```

The contract is in `game-manifest.schema.json`. A version offers `solo`, `multiplayer` or both. `coverFile` is an
image beside `manifest.json`, for games whose own files hold none a browser displays. The base/version overlay is the
same as for Windows games: version files replace same-named base files, whatever their case.
`multiplayer.gameLibrary` (optional) is a native game library in the `engine` release that the dedicated server loads
instead of the one the game's `liblist.gam` names (`-dll`): the server side of modules built from source.

The page starts the engine with `-dll` set to the name the engine's wrapper preloads the server module under
(`DEFAULT_SERVER_LIBRARY` of its `constants.js`): the engine otherwise opens the library the game's `liblist.gam` names
(`dlls/cs_emscripten_wasm32.wasm` for Counter-Strike), finds no such module and runs no local server — what kept
Counter-Strike at its title screen in single player, whichever server module.

## Server routes

- `/api/manifests`: every version, with `runtime`; a port also has `launchUrl` and `modes`, and is `available` only
  when its files, its engine release and the modules it names are installed. The home starts a port by opening its
  `launchUrl` (`src/host/web/main.js`); the Windows pre-download row is for `win32` versions only.
- `/ports/goldsrc/<manifest>/`: the port's page.
- `/engines/<release>/<path>`: engine files, only of releases a manifest names, cached as immutable.
- `/gamez/<manifest>/...?r=<start>-<end>`: the game's files, compressed when that saves bytes, as for Windows games
  (see "Streamed files" below). Native binaries (`.exe`, `.dll`, `.so`) are not part of the engine's tree.
- `/api/prefetch/<manifest>`: GET the learned list (files and pieces in the order sessions first read them); POST
  `{ session, reads: [[path, start, end, t]] }`, the reads a page served, `t` in ms since its engine started.
- `/api/udp/<manifest>` (WebSocket): the multiplayer relay. Each player gets one UDP socket to the version's dedicated
  server on `127.0.0.1:<multiplayer.port>`, never another destination; same-origin pages only, 64 players at once,
  idle connections closed after two minutes.

## Streamed files

The page does not download a game before starting it (`src/ports/goldsrc/files.js`). The engine sees the whole tree
at once (names and sizes from `/api/tree`); a file's bytes arrive at its first read:

- **Startup set.** The server's learned list orders the files and 64 KiB pieces sessions read, by the earliest time
  since their engine started. Before starting the engine the page loads its leading part, up to the first pause of
  2 s between two learned reads: what the engine reads from its start to its first idle moment (init, menu, and the
  first map when the page asks for one). Six requests at a time, from the browser's copy when it has them.
- **The rest in the background.** Once the engine runs: the files this browser keeps, then the rest of the learned
  list in its order, three requests at a time. A big file of which sessions read a small part (a map list reading
  headers) comes as those pieces only.
- **Reads not there yet.** The engine is synchronous and runs in the page: a read of bytes not loaded yet fetches them
  at once over a synchronous request (the page waits; mostly during a map load), whole runs of missing pieces per
  request.
- **Learning.** The page reports the pieces the engine read (path, range, time since its start) 30 s after the start,
  every 2 minutes and when it is closed. The first session of a version, without a learned list, starts at once and
  fetches every read; it teaches the next ones.

## Game modules built from source

The browser release's game modules were recovered from a deployed build whose sources no longer exist.
`tools/goldsrc/build-modules.sh` builds Counter-Strike's from public sources instead, pinned in `lock.json` "modules":
`Velaron/cs16-client` at `15278ca` (the commit the recovered build started from) with its submodules — the client,
`mainui_cpp` (the menu), `ReGameDLL_CS` (the game server). The result is a release of its own,
`data_engines/xash3d-web-1.2.2-cs16-15278ca/`: the engine files of `xash3d-web-1.2.2` (checked against the lock) and
under `counterstrike/cstrike/` the three WebAssembly modules and `dlls/cs.so`, the same server compiled natively for the
32-bit dedicated server (`multiplayer.gameLibrary`).

- **Sources.** `data_engines/src/cs16-client` stays at the pinned commits (checked, clean); the build works on a copy in
  scratch, where `tools/goldsrc/patches/` are applied: a few one-line portability fixes (Emscripten is neither Linux nor
  Apple for these sources), the client's engine version check accepting the build number `-1` the WebAssembly engine
  reports, options to skip the YaPB bots and the downloaded bot graphs, and `SOURCE_DATE_EPOCH` for ReGameDLL's build
  date.
- **WebAssembly.** In the pinned image `emscripten/emsdk:4.0.23` (the engine's Emscripten), without network.
  `cmake/emscripten-side-modules.cmake` makes each shared library a side module (`-sSIDE_MODULE=1`), as the engine's
  own build does; `cmake/hidden-visibility.cmake` compiles the server with hidden visibility, as the recovered one was:
  Emscripten's dynamic linker has one symbol table for every module, where the client's same-named weapon and entity
  symbols would otherwise bind in place of the server's. The menu renders fonts with stb_truetype (no FreeType).
- **Reproducible.** The pinned commit's time is the build time the sources record: two builds give the same bytes, and
  the script refuses WebAssembly modules whose SHA-256 differ from the lock's. The native library depends on the host's
  g++ (its digest is in the release's `release.json` only).
- **Checked** (2026-10-14, headless Chromium, `check.mjs` and a probe): the rebuilt modules behave as the recovered ones —
  same exports for the server (216), every entry point of the client and menu; two players on the dedicated server,
  first with Valve's `cs.so`, then with the native ReGameDLL (`multiplayer.gameLibrary`), move, see each other and get
  the same score. In single player both module sets now start the local server (`-dll`, above) on `de_dust2`, up to the
  spectator view and the team menu (`chooseteam`).

## Browser storage

IndexedDB database `orthros-port:<game>:<version folder>` (the installation; unchanged since the first release):
`profile` holds the engine's writable tree (saves, configuration), written every 10 s, when the page is hidden and on
quit; `content` holds the game files fetched, whole (`<path>\n<size>\n<mtime>`) or as 64 KiB pieces (the same key and
`\n#<piece>`); entries of other files or older versions are deleted at the start. The settings' device tab and the account's online copies handle the Windows games' profiles
only: a port's saves stay in this browser.

## Multiplayer servers

One native dedicated server per version, `orthros-goldsrc@<manifest>` (systemd, `DynamicUser`, its state in
`/var/lib/private/orthros-goldsrc/<manifest>`), runs `tools/goldsrc/server.mjs`: it links the version's files into
`$STATE_DIRECTORY/game` (the engine reads one directory) and starts the dedicated server on 127.0.0.1 only.
Half-Life uses UDP 28015, Counter-Strike 28016.

```sh
python3 tools/goldsrc/install-engine.py          # browser engine release -> data_engines/
sh tools/goldsrc/build-server.sh                 # dedicated server -> data_engines/ (gcc, 32-bit libraries)
sh tools/goldsrc/build-modules.sh                # Counter-Strike modules from source -> data_engines/ (Docker, g++ -m32)
install -m 644 tools/goldsrc/orthros-goldsrc@.service /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now orthros-goldsrc@half-life-original-en orthros-goldsrc@counter-strike-original-en
tools/with-browser-slot.sh node tools/goldsrc/check.mjs half-life-original-en solo --url https://orthros.chalco.website --reload
tools/with-browser-slot.sh node tools/goldsrc/check.mjs counter-strike-original-en multiplayer --url https://orthros.chalco.website --join-keys "{n},1"
```

## Same origin

The ports share the Win32 runtime's origin (the owner's choice): their engine code can read this origin's browser
storage and call the account's online-save API with the visitor's session. Account changes still require the password.
The engine files are pinned by SHA-256 in `lock.json` and served only from releases a manifest names.

## State (2026-10-14)

Checked in headless Chromium (SwiftShader) with `tools/goldsrc/check.mjs`, from the home card: Half-Life single
player (moves, saves, loads, quits and finds its save again), Half-Life and Counter-Strike multiplayer (two players on
the dedicated server see each other, move, and both receive the score when one dies). Not checked: a whole campaign,
long sessions, voice chat. Counter-Strike's manifest offers no single-player mode yet: its local server starts since
`-dll` (above), but the team menu does not open by itself at the start and the bots lack their profile database
(`BotProfile.db`, in cs16-client's extras). Known upstream messages: Half-Life's optional `ReqState` voice message has
no handler; Counter-Strike warns about its HUD sprite count.

## Third-party components

- Xash3D FWGS WebAssembly package `xash3d-fwgs` 1.2.2 (npm) and its wrapper `sealdev224/webxash3d-fwgs-cstrike`
  (MIT, copyright 2025 yohimik): `data_engines/xash3d-web-1.2.2/engine/`.
- Game modules compiled to WebAssembly (client, server, menu), recovered from the deployed `x8bitrain/webXash` build;
  their exact sources were unavailable on 2026-10-13: `halflife/`, `counterstrike/` of the same release.
- Xash3D FWGS native engine `FWGS/xash3d-fwgs` at `e0ece3d` with libbacktrace, mbedTLS and miniz (their notices are in
  the checkout): the dedicated server.
- `FWGS/hlsdk-portable` at `6c168fc`: reference sources only, not the source of the recovered modules.
- `Velaron/cs16-client` at `15278ca` (GPL 2 or later, with the Half-Life engine exception) and its submodules
  `Velaron/ReGameDLL_CS` (MIT), `Velaron/mainui_cpp` (GPL 2 or later), `FWGS/MiniUTL`: the modules of
  `xash3d-web-1.2.2-cs16-15278ca`, built by `build-modules.sh`; their notices are in the checkout.
- The game files are the games' own, never modified; their provenance is recorded in each manifest's `installedFrom`.
