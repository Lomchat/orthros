# Browser ports: games whose engine runs as browser code

Orthros runs games in the Win32 emulator and browser ports. All are declared by `data_games/<game>/manifest.json`, listed on the same home,
served by the same server (`src/host/server.js`, `orthros.service`) on the same origin. The version's `runtime` says
which kind it is:

- **`win32`** (the default): the unmodified Windows game in Orthros' own emulator (`src/cpu`, `src/loader`, `src/win32`,
  `src/gfx`, ...), written from scratch.
- **`goldsrc`**: a browser port. The game's original files run on a pinned third-party GoldSrc engine, Xash3D FWGS
  compiled to WebAssembly, with the game's client/server/menu modules compiled to WebAssembly too. Its page is
  `src/ports/goldsrc/`; it never loads the Win32 runtime, and the Win32 runtime never imports it.
- **`re3`**: a browser port. The game's original files run on a decompiled engine of the re3 family (reVC: Grand Theft
  Auto: Vice City's) compiled to WebAssembly, single player. Its page is `src/ports/re3/`; see "re3 ports" below.

Nothing in the code names a game: engine release, game directory, modules, maps and server ports come from the manifest.

OpenMW ports use `runtime: "openmw"`, their own page and a pinned OpenMW-Web engine. Their
multiplayer uses a native world gateway and simulation peers, proxied on the same origin.
See [OpenMW installation, pending data and validation](openmw.md). Several mods of the Vanilla+ profile are still
missing. A modded OpenMW game is a game of its own on the home (`modified`: its "Modified" tag), its version holding
only its mod stack: `requires` puts the original game's version's files beneath it, as for the ports below. Every game page — Windows games and ports — has the same frame (header, loading screen, account, saves):
[docs/game-frame.md](game-frame.md).

## Where things are

| Path | Content | In Git |
| --- | --- | --- |
| `src/host/goldsrc.js` | manifest checks, engine availability, multiplayer relay, linked game tree of the dedicated server | yes |
| `src/ports/goldsrc/` | the port's page (`play.html`, `play.js`, `storage.js`, `style.css`) | yes |
| `src/host/re3.js`, `src/ports/re3/` | the re3 ports' manifest checks and engine availability; their page (`play.html`, `play.js`, `profile.js`, `ini.js`, `style.css`) | yes |
| `tools/re3/` | `lock.json` (the engine's pinned sources — Orthros' fork —, image, Emscripten ports and digests), `build.sh` (the engine from source), `check.mjs` (browser check), `perf.mjs` (frame cost) | yes |
| `tools/goldsrc/` | `lock.json` (pinned upstream sources and artifacts, SHA-256), `install-engine.py`, `build-server.sh`, `build-modules.sh` with `patches/` (`hl-arsenal/`: the mod) and `cmake/` (game modules from source), `bot-nav.mjs` (bots' navigation meshes), `server.mjs` (dedicated server), `orthros-goldsrc@.service`, `check.mjs` (browser check), `perf.mjs` (frame cost) | yes |
| `tools/port-perf.mjs` | the ports' shared frame measurement (below, "Measuring a port") | yes |
| `data_games/<game>/` | `manifest.json`, its cover (`coverFile`), `base/` (the original files), `versions/<version>/` | no |
| `data_engines/<release>/` | installed engines: `xash3d-web-1.2.2` (browser), `xash3d-web-1.2.2-cs16-15278ca-r2` and `…-arsenal-r12` (the same engine with Counter-Strike modules built from source), `xash3d-dedicated-e0ece3d` (native dedicated server), `revc-web-e312f97-r1` (reVC built from source) and `revc-web-e312f97-plus-r1` (with Orthros' additions) | no |
| `data_engines/src/` | upstream checkouts at their pinned commits: `xash3d-fwgs` (builds the dedicated server), `cs16-client` with its submodules (builds the Counter-Strike modules), `webxash3d-fwgs-cstrike` and `hlsdk-portable` (reference for later work), `reVC` (Orthros' fork) with its submodules, `emscripten-4.0.23-cache` (Emscripten's SDL2 and mpg123 ports, for builds without network) | no |

The engines stay out of Git like the games: the repository is public, the engine, wrapper and SDK-derived modules
carry their own licenses (notices below), and the browser game modules were recovered from a deployed build whose
sources no longer exist. `lock.json` and the install scripts reproduce them while their sources remain available;
treat `data_engines/` like `data_games/` (the only copy of the recovered modules).

### Measuring a port

`tools/re3/perf.mjs` and `tools/goldsrc/perf.mjs` share `tools/port-perf.mjs`: the browser's flags for a rendering
mode, a probe in the page before its scripts and its summary — the engine's work a browser frame (from its first
callback to the engine's request for the next), the gaps between frames shown, the WebGL calls a frame by kind with
the synchronous ones apart (getError, checkFramebufferStatus, readPixels, shader and program queries… — each one waits
for the GPU process; `--stacks getError` keeps their callers), the WebGL renderer (the checks print it too) — and a CPU
profile's summary (`--profile`: self time, the longest busy stretches). The page's telemetry and learning posts stay
off the server unless `--report`. Headless Chromium here always renders with SwiftShader: ANGLE's null backend
(`--use-angle=null`) is ignored — the renderer stays SwiftShader's with every flag combination (checked 2026-10-21), so
`--gl null` is refused. `--gl discard` (the default) keeps RASTERIZER_DISCARD on: every call validated and sent, the
vertex work done, no pixel drawn — the closest to the engine's own CPU cost a frame here, an upper bound
(SwiftShader's vertex threads still compete with the page: report the machine's load, several runs). `--gl swiftshader`
draws (the GPU's share on the CPU); `--gl gpu` adds no flag (a machine's own GPU).

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
same as for Windows games: version files replace same-named base files, whatever their case. Optional fields:

- `requires` (on the version, without `mount`): other ports' versions whose files lie beneath this version's own, in
  order — a game over another's files, as the two Counter-Strike games below over `counter-strike`'s, without a copy.
  In the page's tree, the files served and the dedicated server's linked tree alike (`gameLayers`, game-files.js).
- `goldsrc.extras`: the release's archives mounted in the game folder (`engine/valve/extras.pk3` by default, the page
  only); declared, the dedicated server gets them too (linked into its game folder).
- `goldsrc.solo.commands` / `goldsrc.multiplayer.commands`: console commands before the map, one per entry (the page;
  `+command` arguments of the dedicated server) — `maxplayers 10` and `deathmatch 1` make a solo game a listen server
  with Counter-Strike's round rules and bots (with one player the game installs its training rules: no team, no bot).
- `multiplayer.gameLibrary`: a native game library in the `engine` release that the dedicated server loads instead of
  the one the game's `liblist.gam` names (`-dll`): the server side of modules built from source.

The page starts the engine with `-dll` set to the name the engine's wrapper preloads the server module under
(`DEFAULT_SERVER_LIBRARY` of its `constants.js`): the engine otherwise opens the library the game's `liblist.gam` names
(`dlls/cs_emscripten_wasm32.wasm` for Counter-Strike), finds no such module and runs no local server — what kept
Counter-Strike at its title screen in single player, whichever server module.

## The page

`src/ports/goldsrc/play.html` has the frame of every Orthros game page (`src/host/web/shell.js`, docs/game-frame.md):
the header (game, mouse captured or free, saves, frame rate, the online games, settings, full screen, back to the
games) and the loading screen over the game's blurred cover — who plays (the Orthros account, or a warning), the
online games, the start's steps (engine, game files, the game's first images) with their progress, and tips. The game
starts at once.

- **The game's own main menu.** No mode to choose before the start: the engine starts on the game's menu, where the
  player picks single player (Half-Life's new game; Counter-Strike's multiplayer, create game) or multiplayer. The
  manifest's `solo.commands` run at the start (bots, game settings): a game the menu creates gets them; `solo.map` is
  only `check.mjs`'s. The player's name in the game is the Orthros account's (a player not signed in is `GuestNNN`,
  without multiplayer).
- **Orthros' server in the LAN games.** With `multiplayer` and a signed-in player (the server refuses the relay and
  room creation otherwise), the page opens the relay (`/api/udp/<manifest>`) as the engine starts and sends it every
  packet the engine sends, whatever its address: the menu's LAN search (a broadcast)
  reaches the version's dedicated server, whose answer comes as `127.0.0.1:8080` and lists it, with its map and players;
  joining it connects there. The server closes an idle relay after two minutes: the next packet opens a new one.

- **The game fills the window** under the header (the whole screen in full screen). SDL sizes the game's screen to the
  canvas' size on the page: the game renders at the size it is shown, without bars, whatever the window's shape, and a
  mouse position maps one to one. The page tells SDL when that size changes without the window's (the header hidden).
- **The mouse.** The engine captures it itself when the game takes it (SDL's relative mode: pointer lock at the next
  input event) and frees it in its menus and console, where its cursor shows (the canvas' CSS cursor). A click on the
  game captures it again only while the game wants it (after Esc released it in the game), never in a menu — the page
  used to lock it at every click, which left the menus without a cursor. Full screen captures it at once in the game.
  (Emscripten gives SDL positions relative to the canvas already: the page must not shift them — a version that did put
  clicks 44 pixels above the cursor, outside full screen.)
- **Large screens.** The engine's `hud_scale` (read at its start: the width of a virtual screen the HUD is drawn on) is
  set from the largest size the game takes (the screen's, full screen): none up to about 1920 × 1080, then by half steps, 1.5 at 2560 × 1440 and 2.5 at
  3840 × 2160 — the HUD, its texts and the mods' menus keep their size instead of shrinking.
- **Telemetry.** A few reports a session to `/api/telemetry` (`port: "goldsrc"`, `event`: `start`, `error` — a page
  error or an unhandled rejection —, `crash` with the end of the engine's log, `end` with the frame rate). After a crash
  the profile is saved and "Restart the game" reloads the page (an engine that stopped cannot start again in it).- **The frame rate** counts the engine's main loop iterations that drew (`postMainLoop`, draw calls seen).
- **The renderer's error checks** (`gl_check_errors`, on by default in the engine) are off unless `?debug`: the
  renderer called `glGetError` after its passes (10 a frame in Half-Life and Counter-Strike) and after each texture
  upload, and each one waits for the browser's GPU process (71-77 µs on an idle context here; on a real GPU, the CPU and
  GPU stop working in parallel). Measured (2026-10-21, `tools/goldsrc/perf.mjs --gl discard`, Half Strike de_dust2 with
  bots, walking, 20 s, three runs each, medians, machine load 18-33): the engine's work a frame 8.5 → 4.9 ms (p90 12.2
  → 7.7, p99 25.3 → 17.9), synchronous calls 10 → 0 a frame.
- **The world from buffers** (`gl_vbo 1`, off by default in the engine, "known to be glitchy" upstream; `?vbo=0` or a
  manifest's commands turn it off): without it the renderer's GLES shim sends the world a polygon at a time — its own
  buffer upload, attribute setup and vertex array switch each time, about 15 WebGL calls a draw. With it the map's
  surfaces go to buffers once at its load. Measured the same way (three runs each, medians, load 15-33): draws a frame
  718 → 86, WebGL calls 10,439 → 1,876, the engine's work a frame 4.9 → 1.7 ms (p90 7.7 → 2.7, p99 17.9 → 4.5); drawn
  by SwiftShader, the same view 19 → 55 frames a second. Checked on screenshots (SwiftShader, with and without): de_dust2,
  the same view with bullet decals — identical; Half-Life c1a0 (lightmaps, see-through grates, models; the tram's view
  turned differently) — the same rendering. Dynamic lights over the world were not compared on purpose.
  (Measured too, not changed: `getParameter` after each vertex array switch in Emscripten's glue, 70 ns; a buffer
  upload 0.6 µs either way — a rebuilt shim streaming into one buffer would win little once the world is in buffers.)
- **The menu module.** Counter-Strike's manifests name none: the engine's (`engine/libmenu.wasm`) shows the game's own
  title screens and takes the mouse; cs16-client's `mainui_cpp` (still built, `modules.builds`) wants the images of its
  `cs16client-extras` package and gets no mouse position from this engine.
- "Back to the games" writes the game's settings, saves the profile here and on the account once the player confirmed;
  the engine is not asked to quit (this release's quit can stop on a double free of its own; the page goes anyway).

## Server routes

- `/api/manifests`: every version, with `runtime`; a port also has `launchUrl` and `modes`, and is `available` only
  when its files, its engine release and the modules it names are installed. The home starts a port by opening its
  `launchUrl` (`src/host/web/main.js`); the Windows pre-download row is for `win32` versions only.
- `/ports/goldsrc/<manifest>/`, `/ports/re3/<manifest>/`: the port's page.
- `/engines/<release>/<path>`: engine files, only of releases a manifest names, cached as immutable.
- `/gamez/<manifest>/...?r=<start>-<end>`: the game's files, compressed when that saves bytes, as for Windows games
  (see "Streamed files" below). Native binaries (`.exe`, `.dll`, `.so`) are not part of the engine's tree.
- `/api/prefetch/<manifest>`: GET the learned list (files and pieces in the order sessions first read them); POST
  `{ session, reads: [[path, start, end, t]] }`, the reads a page served, `t` in ms since its engine started.
- `/api/udp/<manifest>` (WebSocket): the multiplayer relay. Each player gets one UDP socket to the version's dedicated
  server on `127.0.0.1:<multiplayer.port>`, never another destination; same-origin pages only, 64 players at once,
  idle connections closed after two minutes. With `?rooms` (the page's): one socket per room, each message carrying
  its room in its first byte (255: every room — the game's LAN search).
- `/api/rooms/<manifest>`: the lobby. GET: the version's games (its permanent server and the rooms players created:
  name, map, players with the bots, humans, size, bots), the maps and the limits, from its server manager, with the
  manifest's options (without their commands) and map groups (`multiplayer.mapGroups`). POST
  `{ name, map, maxPlayers, bots }`: a room created (the page's origin; one creation in flight per address, 30 a minute in all), answered once its
  server answers, with the room's secret `key`. `DELETE /api/rooms/<manifest>/<index>` `{ key }` (the page's origin):
  that room closed — its server stopped, its players back to the menu; room 0 never. The lobby keeps the keys of the
  rooms its browser created (`localStorage`, `orthros-rooms:<manifest>`) and shows those a Close button.

## Streamed files

The page does not download a game before starting it: its files are the game data every Orthros game reads
(CLAUDE.md "Standardization", docs/slow-network.md) — `src/ports/port-files.js` opens it (`src/vfs/data-client.js`)
and mounts the version's tree in the engine's file system (`src/vfs/emscripten-files.js`: names and sizes at once, a
file's bytes at its first read). The bytes come from the data worker (`src/vfs/data-worker.js`), the Windows games'
reader in a worker of its own: the server's compressed ranges (`/gamez`), the link's measure and its regimes, the
browser's OPFS block store (`orthros-files-<manifest>`, the same the home screen's whole download fills), the learned
order fetched ahead from the game's position.

- **Startup set.** The server's learned order (`/api/prefetch`): what earlier sessions read before their game was
  playable (the page marks it where its loading screen hides, `GameData.mark('playable')`; docs/slow-network.md
  "Playable after"), else up to its first pause of 2 s — loaded before the engine starts. The home card says its size
  and time at the visitor's link, and "Prepare" downloads it ahead.
- **The rest in the background.** Once the engine runs: the learned order from the game's position, then what the
  reader's policies add (blocks around a miss, a file read in order ahead of its reader).
- **Reads not there yet.** A read of bytes not in the page waits for the worker on shared memory (the page's thread
  waits — GoldSrc), or suspends the engine (JSPI — re3); the worker answers with what was asked and as much of the file
  as it has here already.
- **Learning.** The worker reports the pieces the engine used (path, range, time since its start) to `/api/prefetch`.
- **Light copies.** On a link that is not fast, a large texture's load reads its light copy first (the texture
  without its finest levels), the file itself following in the background for its next load (docs/slow-network.md
  "Light copies"; `lightCopies: false` in a version turns them off).
- **Earlier copies.** The IndexedDB copy an earlier page kept (`content`) is handed to the block store at the next
  start, then removed.
- **What the player sees.** Every game's indicators (`src/host/web/data-meter.js`, `shell.setData`): over the page,
  "Loading the game data" with the MB received, the rate, the step's percentage when the learned order tells its size —
  drawn by a worker, so it moves while the page's thread waits (GoldSrc) and shows once the engine's reads have waited
  1.5 s (re3: the page goes on painting) —; in the header, a pill while the learned order or the whole game loads in
  the background. The home screen's "download first" and the settings' offline copy (`offlineCopy`, kept in this
  browser for every game) fill the same store.

## Game modules built from source

The browser release's game modules were recovered from a deployed build whose sources no longer exist.
`tools/goldsrc/build-modules.sh` builds Counter-Strike's from public sources instead, pinned in `lock.json` "modules":
`Velaron/cs16-client` at `15278ca` (the commit the recovered build started from) with its submodules — the client,
`mainui_cpp` (the menu), `ReGameDLL_CS` (the game server). Each of `modules.builds` is a release of its own, its patches
on these sources: `xash3d-web-1.2.2-cs16-15278ca-r2` (Counter-Strike as its sources give it) and
`xash3d-web-1.2.2-cs16-15278ca-arsenal-r12` (the Half-Life Arsenal, below). A release holds the engine files of
`xash3d-web-1.2.2` (checked against the lock) and under `counterstrike/cstrike/` the three WebAssembly modules,
`dlls/cs.so` (the same server compiled natively for the 32-bit dedicated server: `multiplayer.gameLibrary`) and
`orthros-bots.pk3` (`goldsrc.extras`); a build's `assets` add archives of their own (Half Strike:
`orthros-pokemon.pk3`, below).

- **Sources.** `data_engines/src/cs16-client` stays at the pinned commits (checked, clean); a build works on a copy in
  scratch, where its patches (`tools/goldsrc/patches/`) are applied. The common ones: a few one-line portability fixes
  (Emscripten is neither Linux nor Apple for these sources), the client's engine version check accepting the build
  number `-1` the WebAssembly engine reports, options to skip the YaPB bots and the downloaded bot graphs,
  `SOURCE_DATE_EPOCH` for ReGameDLL's build date, and `-bots`: bots on a dedicated server too (ReGameDLL decides it at
  load, before `bot_enable` can be set).
- **WebAssembly.** In the pinned image `emscripten/emsdk:4.0.23` (the engine's Emscripten), without network.
  `cmake/emscripten-side-modules.cmake` makes each shared library a side module (`-sSIDE_MODULE=1`), as the engine's
  own build does; `cmake/hidden-visibility.cmake` compiles the server with hidden visibility, as the recovered one was:
  Emscripten's dynamic linker has one symbol table for every module, where the client's same-named weapon and entity
  symbols would otherwise bind in place of the server's. The menu renders fonts with stb_truetype (no FreeType).
- **Bots.** Counter-Strike 1.6 ships no bot data: `orthros-bots.pk3` holds the profiles of cs16-client's extras
  (`BotProfile.db`; not `BotChatter.db`, whose loading crashes the dedicated server) and a navigation mesh per official
  map, `maps/<map>.nav`, learned by the build's native server (`tools/goldsrc/bot-nav.mjs`: one bot on a map without a
  mesh learns it, 15 to 90 s a map, four at once) on the files of `modules.bots.game`. The bots read it through the
  engine's file system, archives included. (A map without a mesh would be learned by the game itself, into its
  writable `maps/` folder: not checked.)
- **Reproducible.** The pinned commit's time is the build time the sources record: two builds give the same
  WebAssembly modules, and the script refuses one whose SHA-256 differs from the lock's. The meshes nearly so (between
  two builds one of the 25 differed, `de_torn`, by 0.03 %): the bots' archive (sorted entries, a fixed date) is not
  pinned, nor the native library, which depends on the host's g++; their digests are in the release's `release.json`.
- **Checked** (2026-10-14, headless Chromium, `check.mjs` and a probe): the rebuilt modules behave as the recovered ones —
  same exports for the server (216), every entry point of the client and menu; two players on the dedicated server,
  first with Valve's `cs.so`, then with the native ReGameDLL, move, see each other and get the same score. Single player
  on a listen server (`solo.commands`): team menu, rounds, bots that play.

## Half Strike (the Half-Life Arsenal mod)

`counter-strike-hl-arsenal` ("Half Strike" since 2026-10-15; its ids unchanged): Counter-Strike 1.6 with the fourteen Half-Life weapons bought beside its own — the two
Half-Life tabs of its buy menu (below), or the console aliases of the table. Both teams, every map, anywhere and at any
time of a round (`mp_buy_anywhere 1`, `mp_buytime -1`: the mod's defaults), Counter-Strike's economy (`$800` to start,
its rewards; `mp_startmoney` among the manifest's commands changes it). Their ammo is bought as any gun's (`,`/`.`):
the 9mm handgun and the MP5 share Counter-Strike's 9mm, the shotgun its buckshot.

| Weapon (alias) | Menu, slot | Price | Damage | Notes |
| --- | --- | --- | --- | --- |
| Crowbar (`crowbar`) | 1, knife | $200 | 25 a hit, 0.35 s | beside the knife |
| 9mm Handgun (`9mmhandgun`) | 1, pistol | $300 | 22, 17 rounds | secondary: quicker, wilder |
| .357 Magnum (`python`) | 1, pistol | $700 | 65, 6 rounds | zoom |
| MP5 (`9mmar`) | 2, primary | $1450 | 21, 50 rounds, 10 a second | M203 contact grenade (`argrenade`): 100 blast, $250, 2 at most |
| Shotgun (`shotgun`) | 2, primary | $1600 | 6 pellets of 18 | secondary: both barrels |
| Crossbow (`crossbow`) | 2, primary | $2400 | bolt 50, then a 40 blast | zoom: an instant 100 |
| Hornet Gun (`hgun`) | 3, primary | $2000 | 15 a hornet | 8 that grow back; homing, or straight darts |
| Gauss (`gauss`) | 3, primary | $3200 | 20 | charged up to 200: through walls, pushes its shooter |
| RPG (`rpg`) | 3, primary | $3600 | 120 blast | follows its laser spot; 3 spare rockets at most |
| Egon (`egon`) | 3, primary | $4400 | 12 every 0.1 s | a continuous beam |
| Hand Grenade (`handgrenade`) | 4, grenade | $250 | 100 blast | cooks from the pin, 3 s; 1 at most |
| Satchel Charge (`satchel`) | 4, grenade | $450 | 150 blast | click: thrown, then set off by its radio; right click: another thrown; 2 at most; gone with its owner |
| Tripmine (`tripmine`) | 4, grenade | $400 | 150 blast | on a wall; its beam is set off by enemies only, the mine by shots; 2 at most |
| Snarks (`snark`) | 4, grenade | $400 the 3 | 10 a bite, a growing pop | hunt the nearest enemy for 15 s; 6 at most |

Prices since r5 about a fifth below their Counter-Strike counterparts'; a gun comes with its spare ammo, as at each spawn
(`mp_refill_bpammo_weapons 2`, the mod's default). The appearance menu has Half-Life's player models too (keys 5 to 9,
0 at random): on the Terrorists' side Black Mesa's enemies (HECU marine and recon, G-Man, zombie, robo), on the
Counter-Terrorists' its defenders (Barney, Gordon Freeman with and without his helmet, Gina, a scientist); a look follows
its player to the other side at the same rank, and gives way to the VIP's model. Bots and auto-join pick one at random
among all. These models have Half-Life's sequences, not Counter-Strike's (`ref_aim_ak47`, `crouch_shoot_c4`, the
`ACT_DIE*` activities): the server takes the nearest it has — the extension of the weapon's kind (bare hand: `crowbar`,
`onehanded`; pistol: `onehanded`, `python`; long gun: `mp5`, `shotgun`), then the plain action — and for a death,
Half-Life's (`ACT_DIESIMPLE`, `ACT_DIEBACKWARD`…, else `die_simple`), so they fall instead of standing in the first
sequence. No shield with them (no hitbox for it), nor with Half-Life's pistols (no shield animations): the buy menu shows
these greyed, the server refuses them.

Balance is Counter-Strike's scale, not Half-Life's (a player has 100 health and usually kevlar): the guns' damage as
their nearest Counter-Strike counterparts', their armor penetration as these (the crowbar the knife's, the .357 the
Desert Eagle's, the zoomed crossbow the Scout's, the Gauss and Egon the Desert Eagle's), the explosives the HE
grenade's 100 for a grenade, the C4's role for none.

The `hl-arsenal` patches port the Half-Life SDK's weapons (`crowbar.cpp`, `glock.cpp`, `python.cpp`, `mp5.cpp`,
`shotgun.cpp`, `crossbow.cpp`, `hornetgun.cpp` and `hornet.cpp`, `rpg.cpp`, `gauss.cpp`, `egon.cpp`, `handgrenade.cpp`,
`satchel.cpp`, `tripmine.cpp`, `squeakgrenade.cpp`) onto ReGameDLL's weapon classes (`dlls/wpn_shared/wpn_hl.cpp`,
`dlls/hl_weapons.h`) and their client events (`cl_dll/events/event_hl.cpp`, from `ev_hldm.cpp`). The models, sounds,
sprites and event scripts are the Half-Life ones already in the game's `valve` folder; nothing of the game's is copied
or changed.

- **Ids past 32.** Counter-Strike's ids fill the 32 bits of a player's `weapons` field: these are 32 to 45
  (`MAX_WEAPONS` 64 on both sides, the engine predicts 64). The client learns which a player owns from the `HLWeapons`
  message (its own bits), for the weapon menu and the HUD. Their ammo types follow Counter-Strike's (`AmmoType`).
- **Not predicted.** The current weapon id the client predicts from has 5 bits (`delta.lst`): while a Half-Life weapon
  is held, the server sends 0 and the client predicts nothing. Its animations come from the server (sent even to a
  predicting client), its fire effects from its events, which reach the shooter too.
- **HUD and kill icons.** Half-Life's `sprites/weapon_*.txt` name sprite sheets (`640hud1.spr`, …) whose names
  Counter-Strike's own shadow: the client loads them, for these weapons only, from `valve/sprites/` of the game tree
  (its root is a search path of the engine; its file names lowercase). The death notice icons (`d_*`) of the Half-Life
  `hud.txt` join Counter-Strike's: `d_hl_*` where Counter-Strike has one of the same name (`hl_grenade`, the hand and MP5
  grenades, shows `d_hl_grenade`); a bolt's kill is `bolt` as in Half-Life. The MP5's grenades are counted left of its
  clip.
- **Counter-Strike's rules.** One primary, one pistol: buying one drops the other of its slot; the crowbar beside the
  knife, the explosives in the grenade slot (bought again: one more, up to their limit; not dropped). Weights as
  Counter-Strike's, so a bought gun is drawn. Dropped and dead players' guns fall with their Half-Life world model.
  The freeze period stops the attacks that fire, the secondary ones too. Bots neither buy nor pick them up (their logic
  knows Counter-Strike's weapons only).
- **Teams.** Hornets and snarks hunt enemies only (in free for all, anyone but their owner); a tripmine lets its owner's
  team through. Explosions hurt as a grenade's (`DMG_EXPLOSION`: Counter-Strike counts the kill, which a bomb's
  `DMG_BLAST` would not), through no wall but through bodies, and not the attacker's teammates without friendly fire;
  their owner, yes.
- **Rounds.** A round restart removes what the weapons left in the map (grenades, charges, mines, snarks, hornets,
  rockets, bolts).
- **Effects.** The Egon's beams are the server's for every player, its shooter included (the Half-Life client's own
  beams follow a predicted aim this client does not have). Explosions are Half-Life's (Counter-Strike's grenade
  explosion is the flashbang's).

### Poké Balls (r7, official models r8)

Three more items of the grenade slot (`pikachu` $1000, `charizard` $1400, `blastoise` $1300; ids 46 to 48, after the
snarks; one ball carried and one Pokémon out at a time; bots do not buy them). Thrown like the hand grenade, the ball
bounces, wobbles at rest and opens (lid away from the thrower, a flash): the Pokémon comes out beside it
(`monster_pokemon`, `wpn_shared/wpn_pokemon.cpp`). It follows its owner (the bots' navigation mesh, else straight
steering; back beside the owner past 1500 units or stuck), and as soon as the owner fires (the enemy nearest to their
aim) or the owner or the Pokémon is hurt (the attacker) it charges and attacks within 400 units (10 m since r9) with line of
sight, until the target dies, hides 6 s or runs away; then it follows again, after a short victory when its own hit
killed. Teammates are never hurt (friendly fire: only its target); kills are credited to the owner, weapon `pokemon`.

| Pokémon | Health | Speed | Attack |
|---|---|---|---|
| Pikachu | 90 | 300 | Thunderbolt: 22 every 1.1 s, a beam from its cheeks, the target at half speed 0.4 s |
| Charizard | 160 | 240 | Flamethrower: 1 s stream, 7 every 0.15 s in a 25° cone, then 2 s cooldown; burning 2 every 0.5 s for 2 s |
| Blastoise | 220 | 210 | Hydro Pump: 34 every 1.9 s from both cannons, pushed back 380 units/s |

It flinches when hurt, dies (falls, stays 3 s, fades), goes back to its ball (a red flash) when its owner dies,
disconnects or changes side; a round restart removes Pokémon and balls. Health goes to the clients in the `PokeHP`
message (entity, percent, species, team, owner), at each change and after each HUD reset: the client draws a bar
above each visible Pokémon (name · owner; green for one's own with a gold frame, red for enemies', a trail of the lost
health; fading with distance, hidden behind walls) and keeps Pokémon models lit at least as a dim room would (32/64)
— otherwise near black in the maps' shade. The buy menu's ninth tab shows the three, turning, with their figures.
`pk_test <species> [spawn|enemy]`, `pk_test info|clear` (with `sv_cheats 1`) give a ball, spawn one, arm an enemy bot.

**Assets from our own code.** `tools/goldsrc/assets/` (Python 3, numpy and Pillow) writes `orthros-pokemon.pk3`
deterministically at the release build: a GoldSrc studio model writer and reader (MDL 10, checked by `test_mdl.py`),
signed distance field modelling meshed and decimated per rigid part, painted and baked textures quantised to 256
colours, keyframed and procedural animations (gaits matched to the server's speeds), sprites (IDSP 2), synthesised
sounds and HUD icons, and an offline renderer that draws a model's sequences to PNG (`render.py`) — how the models were
judged before the engine. Models: `models/pokemon/{pikachu,charizard,blastoise}.mdl` (sequences idle, walk, run,
attack, flinch, die, spawn, victory), `w_`/`p_`/`v_pokeball.mdl` (the view model: a gloved hand; the ball neutral, the
same classic one for the three); sprites `zap`, `fire`, `water`, `flash` (additive: black only where the palette entry
is exactly 0, the engine's texture gamma lifting the rest), `hud`, `d_pokemon`; 19 sounds.

**Official models (r8, the owner's choice: personal use).** When `$POKEMON_OFFICIAL_DIR` holds them
(`data_installers/pokemon-official/`, outside Git; the release build checks them against `lock.json` "sources"), the
three Pokémon are the games' own models, converted by our code (`gltf.py`: a glTF 2.0 reader; `official.py`: axes,
scale, the rig pruned to what vertices and animations use, four bone weights a vertex, textures quantised to 256
colours each, animations resampled): Xash3D draws smooth skinning (`STUDIO_HAS_BONEWEIGHTS` with
`STUDIO_HAS_BONEINFO`, up to 4 weights, 128 bones). Pikachu (its rig, its Thunderbolt; the rest animated on its
bones, with expression decals), Charizard (Scarlet/Violet's file with the full official animation set, its shiny
textures recoloured to the normal colouring measured on the X/Y model's), Blastoise (its rig, every sequence animated
on its bones). Without the sources the generated models are built instead. Converted files exist only in the
release's archive in `data_engines/`, never in Git.

### Le M (r9)

The owner's brother, at his request, in the buy menu's tenth tab, "Others" (key `0` among the categories): `lem`,
$1500, a companion like the Pokémon (one companion at a time, Pokémon or Le M). It comes as a laptop (weapon 49,
`models/others/v_laptop.mdl`: the gloved hands typing; its screen's code is one of 24 skins the client turns while it
types). Firing types for about 1.2 s, Enter, and Le M is summoned where the owner looks, within 400 units and in their
sight: Matrix code rain (`sprites/others/coderain.spr`), his green lattice hologram (skin 1 of `models/others/lem.mdl`),
then his body, solid after 1.5 s. Health 150, run 250; "Hack": 18 every 1.2 s, a green code beam from his hand, and the
victim's screen scrambled for about 0.6 s (`LemHack` message: green blocks, hex and binary, shifted slices). He
dissolves into pixels when he dies or goes back; kills `lem` (icon `d_lem`). `pk_test lem [spawn|enemy [distance]]`,
`pk_test hurt [n]` (cheats).

His model comes from his photos: identity-preserving full-body references (fal `nano-banana-pro/edit`), a multi-view
reconstruction (`meshy/v7/multi-image-to-3d`, chosen over Tripo and Rodin for the face and glasses) rigged with
animations (`meshy/rigging/multi-animation`), kept in `data_installers/le-m/` (outside Git, pinned in `lock.json`
"sources", `$LEM_DIR`), converted by `pokemon/lem.py` (decimated to 7200 triangles with UV seams and weights kept,
4 bone weights, the clips mapped and trimmed, the attack, flinch and spawn authored on his rig); without them a
stand-in. The fal key lives in `/root/.config/orthros/fal.key`, never in Git.

### Bricks and building (r11)

Fortnite-style building, on or off per room (`mp_build`, the lobby's "Building"; on in solo), with one resource:
bricks (`mp_build_bricks`, the lobby's "Starting bricks": each player's count at every new round, 999 at most).

- **Bricks.** A bullet impact on the map or a brush entity (not a player, a Pokémon nor a built piece) drops a pile of
  5 bricks below it, a little towards the shooter — once per shot and surface (a shotgun blast: once per surface) —,
  an explosion near a wall one pile. Piles merge within 48 units (250 at most), vanish after 60 s, 120 at most (the
  oldest goes); walking over one picks it up (`Bricks` message, the HUD's count, a "+n").
- **Building.** F (the flashlight's key) toggles build mode: the weapon holstered, a blueprint tablet in hand
  (`models/build/v_build.mdl`), the build bar (wall, floor, ramp, roof; 1–4 or the wheel; R turns the piece), and the
  blueprint — the piece's model, additive, blue where it may be built, red where not (the reason beside the bar) — on
  a 128-unit grid at the aim. Fire builds it for 10 bricks; it grows in 0.4 s from a third of its 300 health. The
  grid is `wpn_shared/build_grid.h`, shared by the server (which recomputes the spot from its own view of the player
  and checks reach, the world, players and Pokémon, the slot, caps and bricks) and the client's blueprint; a slot that
  cuts into the map gives way to the one a tile nearer (walls: up to three). Walls and floors are boxes; ramps and
  roofs collide as invisible 16-unit steps (the engine's collisions are axis-aligned boxes), climbed as a ramp.
  60 pieces a player, 400 in all, entity margins kept.
- **Destruction.** Everything that damages hurts pieces (explosions twice): bullets, knife, grenades and the Half-Life
  explosives, Pokémon and Le M; a teammate's only with friendly fire, a builder's own always. Two crack skins, then
  brick debris (`TE_BREAKMODEL`) and a sound; whatever rested on it falls. Every piece and pile goes at a new round.
- `build_give <n>` (cheats), `build_info`, `build_debug 1` (why the blueprint is refused). Models, sprites and sounds:
  `pokemon/bricks.py`.

### Languages (r12)

The mod's own texts — its team, look and buy panels, the build bar, the Pokémon's and Le M's, its refusals and centre
messages — come in English and French. The client's cvar `ars_lang` (`en` by default, `fr`; archived and in the user
info, so the server answers each player in theirs) picks them, the change seen at the next frame; the manifest's
`goldsrc.languages.<code>.commands` set it for the language chosen on the home page. Counter-Strike's own messages
(the game's resource files) stay as the game has them.

### Its own menus

The mod's client draws its team, appearance and buy menus itself (`cl_dll/arsenal_ui.cpp`), in the page's look: the
original game's are VGUI panels of a library not available in WebAssembly, the text menus their fallback.

- **Team**: the two sides, a player model of each turning in its card (their looks in turn), how many play in each;
  auto-select, spectate, cancel when allowed. **Appearance**: the side's looks, each turning with its name.
- **Buy**: eight tabs (pistols, shotguns, SMGs, rifles, machine gun, equipment, the Half-Life guns, the Half-Life heavy
  weapons and explosives), the items the player's team may buy with their price (red when too dear, "owned"), and the
  hovered one turning in 3D (drag to turn it) with its figures: damage (pellets), fire rate, armor piercing, range
  (damage kept at 1000 units), mobility (speed), magazine, a line on its use. Its price is the server's (Kevlar + Helmet:
the helmet alone, $350, over a full vest), what it would refuse greyed (a full vest again, a shield with a Half-Life
pistol or look, a Half-Life pistol with a shield). A model lies along its longest axis on the screen (a principal axes fit of its
vertices where its first frame's bones put them: the files' own orientations are arbitrary, their animation lays them),
heavier end down, and fills the frame by its vertices — measured again, before being drawn, swaying in the
perspective of a frame away from the screen's middle, where its nearer end grows; the player models stand in their idle
sequence, their blends and controllers neutral. Click buys (the server's buy aliases);
  keys: a tab's number then an item's, `0` back, the wheel or arrows change tab, `,`/`.` ammo, `B` or Esc closes.
- **Other text menus** (radio, the server's): a panel of the same look. The radio menus were not shown at all: the
  client replaced them with touch-screen configurations.
- **How.** The client announces its menus with the user info `_ars_ui 1`: the server then sends its VGUI menus
  (`VGUIMenu`, as to a client with VGUI) instead of text ones, and the client draws them. The page's `_vgui_menus 0`
  still holds for the other games. The models are entities of the frame, placed close in front of the view at the
  panel's place (their transform and light set in `StudioModelRenderer`), over backdrops drawn in the world just behind
  them; the HUD (but the chat and the kills) and the weapon in hand hide while a panel is open.
- **The mouse.** This engine sends the client no mouse moves (`IN_ClientLookEvent` is never called): while a panel is
  open the client turns the engine's touch "client only" mode on, in which the engine shows the mouse's cursor (the
  page frees it, as in a menu) and a client button over the screen gives its presses (`+ars_click`), the engine
  its position (`GetMousePosition`).
- **Cost** (headless Chromium, SwiftShader, 1280×756, the same view): 44 frames a second in the game, 22 with the team
  or appearance menu, 20 with the buy menu, 38 with the radio menu. In the buy menu, per frame: about 12 ms for its
  shapes (one draw call: pixels blended, SwiftShader's CPU rasterizer), 14 ms for its texts (the engine draws each of
  its ~550 characters by itself), 5 ms for the model and its backdrop. Not measured on a GPU.

## Browser storage

IndexedDB database `orthros-port:<game>:<version folder>` (the installation; unchanged since the first release):
`profile` holds the engine's writable tree (saves, configuration), written every 10 s, when the page is hidden and on
quit; `content` holds the game files fetched, whole (`<path>\n<size>\n<mtime>`) or as 64 KiB pieces (the same key and
`\n#<piece>`); entries of other files or older versions are deleted at the start. A signed-in player's profile is
also on the account (`src/host/web/cloud-sync.js`: the game's writable tree less logs, screenshots, bots' navigation
meshes and the decals' cache): restored before the engine starts when the account's is newer, sent every minute when it
changed and when leaving; a profile replaced so is kept aside in `profile` under `aside-<date>`.

## Multiplayer servers

One server manager per version, `orthros-goldsrc@<manifest>` (systemd, `DynamicUser`, its state in
`/var/lib/private/orthros-goldsrc/<manifest>`), runs `tools/goldsrc/server.mjs`: it links the version's files into
`$STATE_DIRECTORY/game` (the engine reads one directory) and runs native dedicated servers on 127.0.0.1 only — its
permanent one (room 0: `multiplayer.port`, `multiplayer.map`, the game's map rotation, started again if it stops) and,
with `multiplayer.rooms`, those players create.

- **Rooms.** A room is a dedicated server of its own on a port of `rooms.ports`, with the name players gave it (its
  `hostname`), the map they chose (from `multiplayer.maps`, else every map of the game folder; it stays on it), its size
  and bots (`rooms.bots`: its commands with `{n}`, its command-line `args` — ReGameDLL's `-bots`). It writes to
  `rooms/<index>/`. A room without a human player for 5 minutes stops (the engine's `info` counts its human clients;
  the bots are the room's own number). The manager answers on 127.0.0.1:`multiplayer.port` over TCP (the same number
  as its UDP port): GET and POST `/rooms`, DELETE `/rooms/<index>` with the room's key (compared in constant time), for
  the Orthros server only. The unit allows 1.6 GB, 3 cores and 192 tasks
  (a server takes about 150 MB).
- **The lobby** (`src/ports/goldsrc/lobby.js`): in the page's loading screen and over the game (the header's "Online
  games"), the version's games with their map and players, joined in a click — the engine started first if it is not —
  and the form that creates one: a name, a map picked on its picture, a size and bots (− and + buttons), the version's
  options as buttons side by side (`rooms.options`: Counter-Strike's bots' team, `bot_join_team`, and starting money,
  `mp_startmoney`); beside them, the chosen map large with the game's name over it and a summary of the game (its size,
  bots, options and places), which follows the form as it scrolls; its buttons stay at the bottom of the box. Escape
  closes the form (over the game, a first Escape the form, a second the overlay); an error on a field (the name) marks
  and focuses it. The maps come by group when the version names
  `multiplayer.mapGroups` (Counter-Strike's classic modes: bomb defusal `de_`, hostage rescue `cs_`, VIP assassination
  `as_`): each group a title above its cards, a filter above the maps and a badge on its cards (`short`, `icon`), its
  `description` under the chosen map's picture; a map goes to the first group naming it (`maps`), else to the first
  with one of its `prefix`es, the others last ("Other maps"). Nothing in the page names a group: they come with
  `GET /api/rooms` (`mapGroups`). A map's picture is the game's own overview (`multiplayer.mapImage`, `/api/map-image/<manifest>/<map>`,
  compressed once by the server), drawn smaller by the page with its keyed pure green turned into the panel's dark, and
  loaded when its card comes into view; a map without one gets its name on a pattern. Each room is also in the game's own LAN list, under its
  name: the relay sends the LAN search to every room, room i answers as 10.87.0.<i+1>:27015 (127.0.0.1:8080 too for
  room 0). The home's cards tell how many games are online and how many play.
- **Ports.** Half-Life: UDP 28015, rooms 28100-28103; Counter-Strike (rebuilt): 28017, rooms 28120-28123; Half
  Strike: 28018, rooms 28130-28133 (28016 and 28110-28113 were the recovered Counter-Strike's, removed on 2026-10-18).
  The catalog refuses a port two versions take.

```sh
python3 tools/goldsrc/install-engine.py          # browser engine release -> data_engines/
sh tools/goldsrc/build-server.sh                 # dedicated server -> data_engines/ (gcc, 32-bit libraries)
sh tools/goldsrc/build-modules.sh                # Counter-Strike modules from source -> data_engines/ (Docker, g++ -m32, the game's files)
install -m 644 tools/goldsrc/orthros-goldsrc@.service /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now orthros-goldsrc@half-life-original-en orthros-goldsrc@counter-strike-rebuilt-en orthros-goldsrc@counter-strike-hl-arsenal-en
tools/with-browser-slot.sh node tools/goldsrc/check.mjs half-life-original-en solo --url https://orthros.chalco.website --reload
tools/with-browser-slot.sh node tools/goldsrc/check.mjs counter-strike-hl-arsenal-en multiplayer --url https://orthros.chalco.website --join-keys "{n},1"
```

Each page has 180 s to start its game (engine, account saves, files); `--boot-timeout <s>` gives it more (a cold
cache, a slow link).

## Same origin

The ports share the Win32 runtime's origin (the owner's choice): their engine code can read this origin's browser
storage and call the account's online-save API with the visitor's session. Account changes still require the password.
The engine files are pinned by SHA-256 in `lock.json` and served only from releases a manifest names.

## Languages (2026-10-18)

A version offers French when its manifest says so: `"languages": ["en", "fr"]` and, in `goldsrc.languages.fr`, the
engine's arguments (`-language french`: the menu's strings in `resource/*_french.txt`) and the folders laid over the
game's (`overlays`: `{ "valve_french": "valve", "cstrike_french": "cstrike" }`). The page mounts each file of such a
folder where the file it translates is (`languageFiles`, src/vfs/game-tree.js), and hides the language folders
otherwise; the player's choice comes from the home card (`?gameLang=`).

The French files are Valve's own, from the Steam depots of 2004-2009 kept on archive.org (Half-Life 72, Counter-Strike
12, Blue Shift 131 for the newer shared menu strings; provenance and hashes in `data_installers/goldsrc-fr/provenance/`):
Half-Life's subtitles and HUD texts (`titles.txt`), menus, chapter titles, loading pictures and its French voices
(1,136 clips; 18 sentence clips exist in no French release), Counter-Strike's HUD, menus and messages, its text
menus, map briefings (all 25) and radio voices. `cstrike_french.txt` and six briefings are Valve's 2015 SteamPipe files
(archive.org item `cs-1.6-language`: only the files dated by Valve's build, every other one byte-identical to the depots'):
1,370 of 1,373 keys — the scoreboard's Money, HP and D. Kit came in English after 2015, never translated. Orthros adds
what the engine's own menu needs: its strings (`tools/goldsrc/l10n/mainui-fr.py` → `mainui_french.txt`), its banner
titles in the style of the English ones (`tools/goldsrc/l10n/banners.py` → `gfx/shell/head_*.tga`) and, in the
French folders, the engine's conversion of the game's `liblist.gam` (`fs_make_gameinfo`) with
`render_picbutton_text 1` — the main menu's buttons drawn as the official French words instead of the English
pictures. `python3 -I tools/goldsrc/install-l10n.py data_installers/goldsrc-fr --apply` puts it all into
`data_games/<game>/base/` (never replacing a different file). Counter-Strike's old text menus have no accents in
Valve's French either (« Choisir une equipe »).

## The recovered Counter-Strike removed (2026-10-18)

The owner removed the game `counter-strike` (its recovered browser modules, kept to compare). Its original files
(`cstrike/`, `valve/` from the HLDS release) are now the base of `counter-strike-rebuilt`, which Half Strike requires;
its manifest went to `data_installers/removed-2026-10-18/` with the free OpenMW example's.

## State (2026-10-14)

Checked in headless Chromium (SwiftShader) with `tools/goldsrc/check.mjs`, from the home card: Half-Life single
player (moves, saves, loads, quits and finds its save again); Half-Life and the three Counter-Strike games in
multiplayer (two players on the dedicated server see each other, move, and both receive the score when one dies);
`counter-strike-rebuilt` and `counter-strike-hl-arsenal` in single player (`--no-save`: the team menu, moving, eight
players with the bots). With a probe, in the Arsenal: each of the five weapons bought (menu and aliases, money
taken), drawn with its Half-Life model and HUD icon, fired (bullets, bolts — in flight and zoomed, stuck in the wall —
rockets following the spot, the Gauss's beams and charged blast, the Egon's beam), its ammo bought, dropped; the
Gauss and RPG on the multiplayer server too. Blast damage checked on the shooter; hits on other players go through
the same calls as Counter-Strike's weapons, not checked by aiming at one. Not checked: a whole campaign, long
sessions, voice chat, `counter-strike`'s single player (its manifest offers none: it keeps the recovered modules, to
compare). Known upstream messages: Half-Life's optional `ReqState` voice message has no handler; Counter-Strike warns
about its HUD sprite count.

## re3 ports

A version whose `runtime` is `re3` runs the game's original files on a decompiled engine of the re3 family compiled to
WebAssembly (owner's decision D099, 2026-10-19): reVC for Grand Theft Auto: Vice City, the first — a game of its own
on the home (`vice-city-revc`, "Grand Theft Auto: Vice City — reVC"), over the files of the Windows game's card
(`vice-city`), without a copy of them. A second card, `vice-city-orthros` ("Grand Theft Auto: Vice City — Orthros
Edition"), runs the same engine built with Orthros' additions (the HELP cheat, a free mode: below, "Orthros' modified
Vice City"), the first left as reVC is. Single player only for now; nothing in it prevents a multiplayer later. The engine release is built by
`tools/re3/build.sh` into `data_engines/<release>/`, outside Git like the GoldSrc engines. Nothing in the server or the
page names a game: release, arguments, environment and settings come from the manifest, the module's name from the
release.

### Manifest

```json
{
  "schemaVersion": 1, "id": "vice-city-revc", "name": "Grand Theft Auto: Vice City — reVC", "defaultVersion": "vice-city-revc",
  "defaults": { "runtime": "re3", "coverFile": "cover.jpg" },
  "versions": [{
    "id": "vice-city-revc", "dir": "1.1-revc", "version": "1.1 · reVC", "languages": ["en", "fr"], "profileSeed": true,
    "requires": [{ "game": "vice-city", "version": "vice-city-1.1-elamigos-2014" }],
    "re3": {
      "engine": "revc-web-e312f97-r1",
      "defaults": { "reVC.ini": { "Display": { "Subtitles": "1" } } },
      "languages": {
        "en": { "env": { "LANG": "en_US.UTF-8" }, "ini": { "reVC.ini": { "General": { "Language": "0" } } } },
        "fr": { "env": { "LANG": "fr_FR.UTF-8" }, "ini": { "reVC.ini": { "General": { "Language": "1" } } } }
      }
    }
  }]
}
```

(Vice City's `data_games/vice-city-revc/`: an empty `base/` and `versions/1.1-revc/`, its cover; the game's files are
the Windows card's, by `requires`. reVC takes its language from its ini file, else from the locale; `0` is American
English, `1` French.)

`src/host/re3.js` (`re3Problem`) checks it; the contract is in `game-manifest.schema.json`. No `exe`. `requires` (no
`mount`): versions of other games, of any runtime, whose files lie beneath this version's own, in order (`underlays`,
as a GoldSrc mod's over its game) — the engine's own files over all; a Windows dependency's own requires are not
followed (they are drives of its emulated machine). The saved profile's key is the installation's,
`orthros-port:<game>:<version folder>`, as the other ports'.

- `engine` (required): the release, `/^[a-z0-9][a-z0-9._-]*$/`.
- `module`: the engine's ES module, a relative path of the release (`/`-separated printable ASCII, 128 characters at
  most, no empty part, none starting with `.`, no `\`). By default the release's only `engine/<name>.mjs` with its
  `engine/<name>.wasm` beside it (a worker's module has none): the code never names the engine's files.
- `args`: the game's command line (`callMain`), each `/^[-+]?[A-Za-z0-9_.=]{1,64}$/`, 32 at most.
- `languages.<code>`, for the language the player chose on the home card among the version's `languages` (16
  languages at most): `env`, the engine's environment variables (set in `Module.ENV` by a `preRun` hook, before the
  runtime starts: its C library copies the environment once, as its constructors run; 32 at most, names
  `/^[A-Z_][A-Z0-9_]{0,31}$/`, printable ASCII values of 64 characters at most); `ini`, settings put in the profile's
  ini files before the start (`{ <file>: { <section>: { <key>: <value> } } }`, printable ASCII: 8 files, 16 sections a
  file and 1 to 32 keys a section at most). A file is a path relative to the game root, with `module`'s rules; a
  section 1 to 64 characters, no `[` or `]`; a key 1 to 64 characters, no `=`, `[` or `]`, not starting with `;` or
  `#`; a value 128 characters at most. Sections, keys and values have no space at either end (an ini reader trims
  them). The schema's patterns say the same; `tests/re3.test.js` checks they agree.
- `defaults`: settings a profile gets once (`{ <file>: { <section>: { <key>: <value> } } }`, `ini`'s rules; a section
  without `=`, not starting with `;` or `#`), the player's own choice afterwards (below, "The profile").
- `modes`: the ways to play the version, when the engine has them as command-line options (1 to 4,
  `/^[a-z][a-z0-9-]{0,15}$/`, in the page's order), each `args` (8 at most, `args`' rules) put after `args`. With more
  than one, the loading screen asks (a button each, its note under them, the last one chosen first; `?mode=<mode>`
  chooses at once), and the home card names them (`story`: Story, `free`: Free mode). Without, a single game (`solo`).
  (Orthros' modified Vice City has its free mode in the game's own menu instead: none.)
- `solo`: reserved.

### Engine release

`data_engines/<release>/`: `release.json` (present once installed), the Emscripten ES module and its WebAssembly
(`engine/revc.mjs`, `engine/revc.wasm`: `MODULARIZE` + `EXPORT_ES6`, `export default function (overrides)` returning a
promise of the Module, which exposes `FS`, `ENV` and `callMain`), and `gamefiles/`, the engine's own extra game files
(its text files, its textures). The page passes `canvas`, `print`, `printErr`, `locateFile` (the module's folder in
the release), `noInitialRun: true`, `onAbort`, `onExit`, `orthrosFrame`, which the engine calls after each frame it
displays, and `orthrosMouse(relative)`, which it calls when the game takes the mouse (relative motion) or frees it (its
menus). The engine uses JSPI (Chrome): `callMain(args)` starts the game and returns a promise that settles when its
`main()` returns — the player quit the game from its menu. Input and rendering are SDL2's (Emscripten port) on the
canvas, WebGL 2; audio OpenAL on WebAudio. The engine reads the game's files relative to its current directory,
whatever their case (it lists folders itself), and writes its own there: its `userfiles/` folder (saves, settings), an
ini file at the root, maybe caches.

### The engine's files over the version's

The release's `gamefiles/` is the top layer of the version's game tree: over `versions/<dir>/` and `base/`, its files
replacing same-named ones whatever their case, as a version's replace the base's. The catalog puts it in the manifest's
`overlays` (`gameLayers`, `src/host/game-files.js`), from the server's engines folder (`--engines-dir`): `/api/tree`,
`/game/`, `/gamez/` and the learned reads (`/api/prefetch`) see one tree. A release not installed adds no layer. The
server lists a tree once, and again when the catalog is read (`/api/manifests`) or when a folder laid over it changed
(its inode, change or modification time: a release installed, removed or rebuilt while the server runs), so
`/api/tree` follows the release as `/game/` does. The other runtimes' trees are unchanged.

### Server routes

- `/api/manifests`: `runtime: "re3"`, `modes: ["solo"]`, `launchUrl` `/ports/re3/<manifest>/`; `available` when the
  game's files are there and the release is installed (`release.json`, the module and its WebAssembly, `re3Installed`).
- `/api/manifest/<manifest>`: `re3.module`, the module the page imports (the manifest's, else the release's; `null`
  when there is none or several).
- `/ports/re3/<manifest>/`: the page. `/engines/<release>/...`: the release's files, for a release an re3 version names
  (`gamefiles/` included), cached as immutable.

### The page

`src/ports/re3/play.js` is the GoldSrc page without what is GoldSrc's own (lobby, relay, console commands, HUD scale):
the same frame (`createShell`: header, loading screen with the steps engine, files, game, tips; English or French),
the account's saves pulled before the start (a conflict settled by the player), the same mouse (the engine captures
it in SDL's relative mode — pointer lock at the next click — and says so, `Module.orthrosMouse`: the game draws its
own cursor in its menus over a hidden one, so the canvas' CSS cursor, GoldSrc's sign, would have the page lock the
mouse there and leave the menus' cursor in a corner; a click captures it again only while the game wants it; the
header's indicator; full screen with the keyboard locked), the same canvas
sizing (the stage under the header; a window `resize` event when it changes without the window's), the same sound
handling (contexts resumed at the next gesture, the "sound off" button, a level meter for the session's report), the
same telemetry (`port: "re3"`; `start`, `error`, `crash`, `end` with the frame rate).

- **Start.** The module imported from the release, the Module created; the game's root `/game` made, the version's
  tree mounted there from the game data (`src/ports/port-files.js`, as GoldSrc: the learned startup set loaded first,
  the rest in the background), with two options GoldSrc has not: `asyncReads` — a read of bytes not here suspends the
  engine (JSPI) while they come instead of holding the page (the engine's `fd_read` / `fd_pread`, `src/skel/orthros_fs.js`
  in the fork, ask the file's node, `orthrosStreamed`: missing, ensure, complete — a file the engine reads at random
  wanted whole in the background); `rewritable` — a game file the engine writes anew becomes a file of the profile.
- **Frames.** Counted by `Module.orthrosFrame`: the header's frame rate; the loading screen hides after the first ten.
- **Shared first-launch profile** (the manifest's `profileSeed`, as the Windows games'; `?profileseed=0` turns it off):
  an empty profile gets, before the engine starts, the small files first sessions of the version wrote identical
  (`/api/profile-seed/<manifest>?lang=`, the server's quorum); else the session reports its own, taken at the player's
  first input and sent once it has gone on playing (`SeedWatch`). The ini files the languages and the defaults name stay
  out of it: the player's settings, the screen's size among them.
- **Saves.** Every 10 s in this browser when the engine wrote since (its file system's writes, renames and deletions
  mark the profile changed: an unchanged profile is neither walked again nor written), every minute on the account
  when changed, when the page is hidden, when leaving by "Games". At the game's end, an error or "Games", a save in flight is waited for and a new snapshot taken
  (the engine may have written since that save's).
- **The game ends** (`callMain`'s promise settles, or `onExit`): the profile saved here and on the account, then the
  loading screen says "The game has ended", with "Restart the game" (the page reloaded once that save is done: an
  engine that ended cannot start again in it) and "Back to the games".
- **Errors.** An abort or a failed start: the loading screen with the error and "Restart the game"; an engine that ran
  has its profile saved first (the restart waits for it).
- **The account's save chosen from the header** while the game runs (a conflict the player settles there): the
  engine's files are not replaced under it. The running game's are kept aside in IndexedDB, its saves stop, the
  account's files take the profile's place and the page reloads to start on them. The game over, they wait for its
  restart.
- **Shared world** (a version with `mmo`, docs/mmo.md): `Module.orthrosNet` is the shared link
  (`src/host/web/mmo-link.js`, the same for any runtime: WebSocket `/api/mmo/<version>/ws`, whole messages queued for
  the engine's `drain`, reconnection with backoff and the LINK_RESET pseudo-record, PING every 15 s, AWAY when the tab
  is hidden, closed when the page goes) with what only the page knows: `user()`, `signIn()` (the account window, a
  modal over the game — full screen too —, closed once signed in; a sign-in, sign-out or another account closes the
  link, and the engine opens it again as the account now signed in), `testing` (`?mmotest`), `testCommands`, `debug`.
  The link opens only when the engine asks. While a world is joined the header's saves say "Saved by the world".
  `window.orthrosMmo` (`link`, the engine's last debug `state`, `command(text)`) is what `tools/re3/mmo-check.mjs` — two
  players in one Chromium, `tools/with-browser-slot.sh node tools/re3/mmo-check.mjs --url <server> --scenario all` —
  drives.

### The engine, built from source

The engine is Orthros' public fork of reVC, `github.com/Lomchat/reVC`, branch `orthros` (forked from
`mrxenginner/reVC` at `a26fff4`, the owner's choice — D099), with its librw submodule from `github.com/Lomchat/librw`,
branch `orthros`: the browser build is defined there (`src/CMakeLists.txt`, `cmake/EmscriptenDeps.cmake`,
`src/skel/orthros_*`; the fork's README, "Browser build"). `tools/re3/build.sh` builds it from the commit pinned in
`tools/re3/lock.json` (`d0f8957`, its submodules too) in the pinned image `emscripten/emsdk:4.0.23`, without network.
Emscripten's SDL2 and mpg123 ports come from a cache made once (`data_engines/src/emscripten-4.0.23-cache`, the
archives checked against the lock). Two builds give the same `revc.mjs` and `revc.wasm` (the pinned commit's time is
the build time; checked 2026-10-19 and 2026-10-20): the script refuses one that differs from the lock. A release holds
`engine/revc.mjs` and `engine/revc.wasm` (3.8 MiB), `gamefiles/` (the sources' own game files: updated `TEXT/*.gxt` with
the strings of reVC's new menu options, controller button textures, `neo/` tables, `data/freeroam_miami.scm`,
`gamecontrollerdb.txt`), `notices/` and `release.json`.

The fork's commits make the desktop build a browser one, nothing about a game (all under `__EMSCRIPTEN__`):

- **One thread, the browser's turn**: the game's main loop is kept as it is; with JSPI its
  WebAssembly stack is suspended once per iteration until the browser's next frame (`OrthrosFrameYield`,
  `src/skel/orthros_web.cpp`), and during long loads every 50 ms at most (`OrthrosLoadingYield`, in `LoadingScreen`) —
  events, painting and fetches go on meanwhile. Streamed audio files are read on the game's thread
  (`MULTITHREADED_AUDIO`, `FLUSHABLE_STREAMING` off).
- **Streaming that never stops the game** (`CdStream_posix.cpp`, `OrthrosFileReady` / `OrthrosFileWait` /
  `OrthrosFileComplete` in `orthros_web.cpp`): with no streaming thread, a model's read is done at once when its bytes
  are here; else the page fetches them in the background and the game goes on — `CdStreamGetStatus` reports the read
  under way and does it once they are here, as the original's thread would have; only `CdStreamSync` (the game
  needing a model now: a loading screen, a cutscene) waits. The CD images and the sound bank are named to the page as
  files read at random (loaded whole in the background). A pedestrian's comment whose bytes are not here is not said
  that time (`LoadPedComment`), rather than waiting for them; a mission's audio still waits.
- **Frames on the browser's frames**: the frame limiter at 60 frames a second (the original's 30 judders on a 60 Hz
  screen: a frame shown twice, then once), meeting its period at the browser's frame — the game's timer counts whole
  milliseconds, and a period met a millisecond late waited a whole browser frame more (20 to 30 frames a second
  instead of a steady 30 before). The menu's "Frame limiter" off: every browser frame.
- **The clock**: `psTimer` uses `emscripten_get_now()` — the browser has no `CLOCK_MONOTONIC_RAW`, whose
  `clock_gettime` failed and left the game's time standing still (a black menu: its fade-in never progressed).
- **The window**: always the windowed video mode, the canvas' box on the page, never an exclusive one (the screen's
  size: `CameraSize` then took the game's screen for the monitor's — the 3D view's aspect ratio and the menus' hit
  areas off by the header's height, a click on "Start game" missing it); SDL's size changes
  (`SDL_WINDOWEVENT_SIZE_CHANGED`) resize it (`resizeCB`), full screen being the page's.
- **No `models/txd.img`** (`USE_TXD_CDIMAGE` off): on OpenGL the game takes the card for one without DXT and converts
  every texture of the CD image into that file at its first new game ("Converting textures to optimal format…"), a
  file the browser would hold in memory, put in the player's profile and make again each session (and ~250 MB more
  read); the textures load from the CD image as the original's, WebGL taking their DXT as it is.
- **Its folders**: `userfiles/` (saves, `gta_vc.set`) is created even where `realpath` leaves its buffer empty for a
  folder not there yet — musl's, the browser's C library (glibc fills it): saves could not be written.
- **The mouse**: the game's switches between relative motion and its menus' cursor are told to the page
  (`Module.orthrosMouse`). The game binds the mouse's buttons only if it sees a mouse at its start
  (`GetMouseSetUp`: a cursor position not 0); SDL in the browser knows no position before the first move, so no
  button was bound — no fire, no punch on the left button — and these bindings were saved in `reVC.ini`. A mouse is
  taken as there, and bindings without any mouse button (an earlier build's) get the mouse's defaults back, the keys
  as they are.
- **Memory**: the streaming budget of a 256 MB machine (the browser tells no free memory; `sysinfo` is absent).
- **Sound**: the browser's OpenAL enumerates no device: its default one is described without being opened (a probe
  would leave an AudioContext running — Emscripten's `alcDestroyContext` does not close its own); no EFX lookup.
- **WebGL 2** (librw's fork): a vertex array object per mesh (`RW_GL_USE_VAOS`: a draw binds it instead of enabling,
  pointing and disabling each attribute; librw deleted them as buffers, fixed), immediate draws (HUD, sprites,
  effects) uploaded with one exact-size `bufferData` (WebGL zero-fills a buffer allocated without data: 10,000
  vertices' worth cleared for each draw before), an OpenGL ES 3.0 context and GLSL ES 3.00 shaders (`#version 300 es`; librw knew
  ES 2.0 and 3.1), S3TC through `WEBGL_compressed_texture_s3tc` (the game's DXT textures stay compressed), compressed
  textures defined by their levels' uploads (WebGL refuses `texImage2D` with a compressed format), no swap interval
  (the browser's frame), `Module.orthrosFrame()` after each frame shown.
- **Reads without holding the page** (`src/skel/orthros_fs.js`, an Emscripten JS library linked in): `fd_read` and
  `fd_pread` are asynchronous imports (JSPI): a read of bytes the page has not got yet returns the page's promise, the
  engine suspended until they are here; else it reads at once, as Emscripten's own. Before, a game read over a thin
  link held the page for seconds in a synchronous request: the page unresponsive, the link shared with the background
  loads (18 KB/s of an 85 KB/s link for a new game's first scene), and the headless browser stopping on an internal
  check during such loads.
- **Callbacks' types**: librw's `Atomic::RenderCB` returns the atomic, as RenderWare's: the game's render callbacks
  (`RpAtomic *(*)(RpAtomic *)`) were called through a `void` type — harmless on x86, a trap in WebAssembly ("function
  signature mismatch", the first frame of a new game).

Measured (headless Chromium, SwiftShader, 1280 × 720; `tools/re3/perf.mjs`): the menu at 60 frames a second; in the
city the engine's own WebAssembly takes 1.4 ms a frame (CPU profile: the rest is SwiftShader's rendering — a GPU
decides the frame rate), WebGL calls 4.2 a draw (1,865 for 446 draws a frame) instead of 7.2 (3,397 for 471) before the
VAOs and single uploads, 18 % more frames a second under SwiftShader. Link-time optimisation and WebAssembly SIMD were
not kept: at 1.4 ms of engine work a frame, too little to win.
2026-10-21 (`perf.mjs --drive --warm 10 --seconds 30 --profile`, `revc-web-e312f97-r1`, load 20-30, one run each — the
player on foot in a street with police about): with `--gl discard`, 35 browser frames a second, the engine's work a
frame p50 8.7 ms, p99 38, max 64; no frame gap over 100 ms; its WebAssembly 1.2 ms a frame (4 % of the time); no
synchronous WebGL call a frame; the four longest busy stretches (139-238 ms) 92-95 % native time (the GPU process,
SwiftShader's vertex work), none in the engine's code; the game waited 68 ms in all for its files. With `--gl
swiftshader` (drawn): 3.5 frames a second, stretches of 0.3-5.7 s — SwiftShader's drawing. Nothing in the engine to
fix for its hitches here; a real GPU decides them.
First start of a new browser, the learned list made by sessions with the shared first-launch profile (below): 19 MB
on the wire before the menu (the sound bank `Audio/sfx.raw`, the menu's textures and fonts, the engine), about 20 MB
more for a new game's first scene (`models/gta3.img`). With Chrome's network emulation, 50 ms round trip: 85 KB/s, the
menu after 234 s and the first scene 235 s after "New game" (the link used at ~82 KB/s); 1 MB/s, the menu after 26 s
and the first scene 25 s after "New game". The rest of the learned list then loads in the background, and the
browser keeps everything: later starts read its copy.
Playing in a part of the city the browser has not got yet (2026-10-20: `perf.mjs --drive --warm 25 --seconds 45
--net 1024`, a new browser, 1 MB/s, the intro's last loading screen out of the measure; the same server and machine):
with the streaming that waited (`revc-web-ecc4c10-r1`), 11 gaps over 250 ms between frames shown in 45 s, the
longest 5.6 s, the engine's longest frame 2.2 s; with the streaming that goes on (`revc-web-6f038e2-r1`), the game
waited for no file (0 ms), 2 gaps over 250 ms (317 ms the longest — SwiftShader's rendering in the GPU process, no
JavaScript or WebAssembly running), the longest frame 245 ms, 50 MB loaded in the background meanwhile. In the
measure that kept the loading screen, the game waited 0.2 to 0.4 s in all, for that screen's own files.

The shared first-launch profile (`profileSeed` in the manifest, `src/host/profile-seed.js`) matters here: the game's
first start reads the header of each of its ~1,200 audio files to build `Audio/sound.cache` (a few KiB each, a 64 KiB
piece each on the wire: ~80 MB). Once two sessions reported the same cache, a new player's empty profile gets it and
the game reads none of them.

### Orthros' modified Vice City

`vice-city-orthros` ("Grand Theft Auto: Vice City — Orthros Edition", `1.1 · Orthros`, over the Windows card's files
as reVC's; `"modified": true`: the "Modified" tag on its card and among the library's filters)
runs the release `revc-web-e312f97-plus-r1`: the same fork commit as reVC's `revc-web-e312f97-r1`, built with
`-DREVC_ORTHROS_EXTRAS=ON` (lock.json: a build's own `cmake`). That option compiles `src/extras/orthros_extras.cpp` in
and its hooks (all under `ORTHROS_EXTRAS`: the reVC card's build has none of them). Everything is in the game itself:
the page starts it as any re3 version (no `modes`).

- **HELP**, a cheat code like the game's (typed while playing, story or free mode): the game pauses under a list of
  its 62 cheats — the original's and reVC's own (`KANGAROO`, `CARSAREHELI`, `SPIDERCAR`; not its debugging ones) — by
  kind (weapons and health, police, vehicles, traffic and driving, weather and time, pedestrians, Tommy, other),
  sorted, each with what it does, in English or French as the game (the French accents at the codes the game's French
  text uses). The game's fonts and colours: the menu's pink title, the HUD's blue for the kinds, the codes in white,
  their effect in the menus' pink; two or three columns and a size to fit the screen. The mouse is free over it (the
  system's cursor, the page's pointer lock released): the code under it has the menus' green selection behind it, and
  a click closes the list and gives the code's letters to the cheats' reader as if typed (HELP's own line only closes
  the list); that click is not the game's until released, and the mouse's moves over the list do not turn the camera.
  HELP again, Enter, Backspace or Esc close it — at the key, whatever the frame rate, and that Esc does not open the
  pause menu.
- **The free mode**, a game of its own in the main menu: "Free Mode" ("Mode libre") between "Start Game" and
  "Options", its page as the start page is the story's (`MENUPAGE_FREE_MODE`, defined as the game's own pages are):
  "Continue" (its most recent save; the first time, the game completed at 100 %), "New Free Game" (the game completed
  at 100 %, `orthros/freemode.b` from the version folder, loaded as it is — checksum and level read as a slot's), "Load
  Game" and "Delete Game" (the game's own pages, on its saves, back to its page), "Back". The game completed at 100 %:
  the whole city open, every property bought with its income, everything unlocked (200 health and armour, the rewards
  at the mansion). Its saves are files of their own, `userfiles/GTAVCfree<n>.b` (the story's stay `GTAVCsf<n>.b`, in
  the same profile); back on the story's start page, the lists are the story's again. A game started from them is a
  free one: its pause menu has "Save Game" (the game's own text, `GMSAVE`; not in a story game): a safe house's save
  screen anywhere, except during a mission (greyed out: its script would be saved half way), without the six hours a
  safe house's save lets pass; a safe house's save and a mission's quick save (retry) go to its files too. The texts
  the game's files lack ("Free Mode", "Continue", "New Free Game", in English and French) come from the engine
  (`CText::Get`, keys `ORT_*`).
- The version folder's `orthros/freemode.b` is a 100 % save of the PC game (retail Windows script) from GTA Save N
  Play (`gtasnp.com/Go49AJ`, unmodified: "Keep your Friends Close…", 100 %, $654,319, 200/200 health and armour),
  201,828 bytes, sha256 `99106509…ef7c9b35` (the manifest's `installedFrom`). It loads in reVC as it is: Tommy in his
  mansion on Starfish Island. Its site's checklist has all 109 items done (story, assets, Phil Cassidy, side
  missions, packages, rampages, jumps); what the game leaves open after 100 % stays (Sunshine Autos' races, the
  stadium, the shooting range, RC vans, ice cream sales, the Boatyard's runs: the owner's choice, 2026-10-20). Its
  player had left five of the cell phone's calls unanswered — story conversations, the phone ringing for them every
  20 to 60 s (`main.scm`'s CELL thread: a call rings until answered). A free game loaded has them marked made
  (`OrthrosExtras::GameLoaded`: `$1139`, `$1140`, `$1158`, `$1162`, `$1164`, for the PC script whose main part is
  204,596 bytes). Found by replaying that thread on the save's variables (its every condition evaluated, the player
  answering): only these five, wherever Tommy is; none once they are made. All of GTA Save N Play's 100 % saves of
  the PC script have the same pending state.
- Its learned prefetch list and shared first-launch profile started as the reVC card's (2026-10-20, the server
  stopped meanwhile: it keeps both in memory): the same game files, the same `Audio/sound.cache`. Learned from its own
  first sessions, before any seed, the list put the ~1,200 audio files the game reads to build that cache first —
  1,238 files and 103 MB loaded before the start, instead of 20 files and 19 MB.
- **The multiplayer** ("Multiplayer" / "Multijoueur" in the main menu, after the free mode; the version's `mmo`:
  `{ "maxCharacters": 8, "maxPlayers": 16, "records": [[256, 267]] }`): a shared, persistent Vice City for the
  signed-in accounts of the Orthros server — characters (pseudo, appearance, money, weapons, place), the free mode's
  100 % world, missions and activities off, the others seen with their pseudo and wanted stars, traffic, pedestrians
  and police shared, PvP, chat on T, `teleport`, cheats for the server's administrators only, garages kept by the
  server. The whole design, the wire protocol and how it was checked: [docs/mmo.md](mmo.md) (DECISIONS.md D102). The
  server's hub is generic (`src/host/mmo.js`); everything Vice City is in the engine (`src/extras/mmo/`).

Checked 2026-10-20 in headless Chromium (SwiftShader), the engine's state read from a trace of a development build
(menu, page, option, fade, the game's kind): the main menu's "Mode libre", its page, "Continuer" on the game completed
at 100 % then — a second session — on the save made since, the pause menu's "Sauvegarder partie" through the save
screen to "Sauvegarde terminée" (`GTAVCfree3.b` written), HELP in English and French at 1280 × 720, 1024 × 768 and
800 × 480; on the server, `tools/re3/check.mjs --keys ArrowDown,Enter,Enter` (the city through the main menu; with
`--reload`, the same profile on another browser signed in to the account) and `--new-game`. Under SwiftShader the
mansion draws under a frame a second (the page's thread idle 93 % of the time: the GPU process's rendering), and the
game lets its pause menu open only once its screen has faded in after the load — minutes there, a second or two at
60 frames a second.

### The profile

The engine writes among the mounted game files, so the profile is every regular file under `/game` that is not a
mounted game file — created by the engine, or a game file it replaced (`src/ports/re3/profile.js`; the game files'
nodes are skipped, never read). Kept as `{ path relative to the root, data }`: IndexedDB `orthros-port:<game>:<version
folder>` (`profile` / `files`, `content` for the game files fetched, as GoldSrc's), and on the account without logs and
screenshots. Put back before `callMain`, each file in place of a game file of the same path. The mounted game files
are read-only, except that a game file the engine opens to write anew (`O_TRUNC`, fopen's `"w"`) is replaced by an
empty file of its own, which joins the profile (`StreamedFiles`' `rewritable` option, off for GoldSrc; opened to be
changed in place, a game file stays read-only).

Every ini file a language names (in any of `re3.languages`) is set up in the profile before the start, with the
player's language's settings, if it has any. The file used is the profile's own of that name, found whatever its case.
Failing that, a copy of the game's own is made, even when it already has these settings: the engine writes its
settings there. Failing that, a new file is created in the folders that are there, whatever their case.
`src/ports/re3/ini.js` sets keys in place, adds missing ones to their section and missing sections at the end, and
keeps the rest byte for byte. The same settings set again change nothing.

A version's `re3.defaults` (`{ <file>: { <section>: { <key>: <value> } } }`, the same rules) are settings a profile gets
once, the player's own choice afterwards: a key takes its default when the file has not had it yet, and the file
records it in a section of its own, `[OrthrosDefaults]` (`<section>.<key>=<value>` each — the engine keeps it, as any
section of its file it reads and writes back whole); a default the manifest changes is set once more. Vice City reVC:
`{ "reVC.ini": { "Display": { "Subtitles": "1" } } }` — the cutscenes' subtitles, off in the engine's defaults, on for
new profiles and, once, for the profiles that already had them off (checked in headless Chromium 2026-10-20: a new
profile, one with `Subtitles = 0`, one turned off again after its default). The files a version's defaults name stay
out of the shared first-launch profile, as the languages' do.

### State (2026-10-20)

Vice City's `vice-city-revc` ("Grand Theft Auto: Vice City — reVC", `1.1 · reVC`) is a card of its own on the home,
release `revc-web-d0f8957-r1` (the same engine as `6f038e2`'s, of a later commit whose additions it leaves out).
Checked in headless
Chromium (SwiftShader) with `tools/re3/check.mjs --new-game --reload` from the server: the home lists it available,
the page starts it on the game's menu (60 frames a second, the mouse free there), sound on after the first gesture, a
new game's first scene, back to the games saving here and on the account, the same profile found by another browser
context signed in to that account. With the bench page (the engine alone): the intro cutscene, free play on foot and
in a car (Flash FM playing, a crash into a shop front, bailing out), the keyboard, the mouse look (relative motion),
French menus (`?gameLang=fr`), 1280 × 720 and 1280 × 756 screens. The shared first-launch profile: two sessions
reported the same `Audio/sound.cache` (English and French), a third empty profile got it. The mouse's bindings
(2026-10-20): fire on the left button in a new profile's `reVC.ini`, and in one an earlier build had saved without it.
Every game page (2026-10-20): in full screen the keys of the browser's shortcuts are the game's (Keyboard Lock);
out of it, leaving with Ctrl or ⌘ held while a game runs asks first (`src/host/web/shell.js`): checked in the re3
page (Ctrl held after a click, its `beforeunload` cancelled); the browser's dialog itself and the keyboard lock are not
(headless Chromium shows neither).

Not checked: a save at a safe house and its load (no automated way there yet: the profile mechanism that carries
`userfiles/GTAVCsf*.b` is checked with the ini and the cache), a whole mission, long sessions, a real GPU (the frame
rate on the owner's Iris Xe), Firefox/Safari (JSPI: Chrome only). Four times in about forty runs on 2026-10-19 the
headless browser process stopped on an internal check (`trap int3` in `chrome-headless-shell`; five such stops the day
before in other Orthros runs), each during a load made of synchronous reads (a cold new game, a thin link). With
asynchronous reads, several times on 2026-10-20, the same place in the browser process's code each time (offset
`0x5a35a88` of build 1243): every time in the free mode's city a minute or so after it loads, with or without the
page's IndexedDB writes or audio output; Chromium itself (Playwright's `channel: 'chromium'`, its new headless mode)
never stopped there, and `tools/re3/check.mjs` uses it — a fault of the headless shell, the cause not established. No multiplayer (reVC has none).

## Third-party components

- Xash3D FWGS WebAssembly package `xash3d-fwgs` 1.2.2 (npm) and its wrapper `sealdev224/webxash3d-fwgs-cstrike`
  (MIT, copyright 2025 yohimik): `data_engines/xash3d-web-1.2.2/engine/`.
- Game modules compiled to WebAssembly (client, server, menu), recovered from the deployed `x8bitrain/webXash` build;
  their exact sources were unavailable on 2026-10-13: `halflife/`, `counterstrike/` of the same release.
- Xash3D FWGS native engine `FWGS/xash3d-fwgs` at `e0ece3d` with libbacktrace, mbedTLS and miniz (their notices are in
  the checkout): the dedicated server.
- `FWGS/hlsdk-portable` at `6c168fc`: reference sources only, not the source of the recovered modules.
- `Velaron/cs16-client` at `15278ca` (GPL 2 or later, with the Half-Life engine exception) and its submodules
  `Velaron/ReGameDLL_CS` (MIT), `Velaron/mainui_cpp` (GPL 2 or later), `FWGS/MiniUTL`: the modules of the
  `xash3d-web-1.2.2-cs16-15278ca-*` releases, built by `build-modules.sh`; their notices are in the checkout. The
  Half-Life Arsenal's weapons and events are ported from the Half-Life SDK (`FWGS/hlsdk-portable`): its licence allows
  non-commercial enhancements to Valve's products only.
- reVC (`github.com/mrxenginner/reVC` at `a26fff4`, the owner's choice — D099: a decompilation of Grand Theft Auto:
  Vice City, MIT with a "proof of usage" condition, see the release's `notices/reVC-LICENSE.md` and
  `notices/reVC-PROOF_OF_USAGE.md`) with its submodule librw (aap, MIT, `notices/librw-LICENSE`), as Orthros' public
  forks `Lomchat/reVC` and `Lomchat/librw` (branch `orthros`, the browser build): the engine of the `revc-web-*`
  releases, built by `tools/re3/build.sh`; OpenAL Soft's headers from reVC's `vendor/` (LGPL 2), Emscripten's
  ports SDL2 2.32.8 (zlib) and mpg123 (LGPL 2.1) linked in.
- A saved game of Vice City completed at 100 %, from GTA Save N Play (`gtasnp.com/Go49AJ`, a player's upload,
  downloaded unmodified on 2026-10-20 at the owner's request): the free mode's game completed at 100 %, `orthros/freemode.b` in the
  `vice-city-orthros` version folder, outside Git; its source and digest in that manifest's `installedFrom`.
- The game files are the games' own, never modified; their provenance is recorded in each manifest's `installedFrom`.
