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
| `tools/goldsrc/` | `lock.json` (pinned upstream sources and artifacts, SHA-256), `install-engine.py`, `build-server.sh`, `build-modules.sh` with `patches/` (`hl-arsenal/`: the mod) and `cmake/` (game modules from source), `bot-nav.mjs` (bots' navigation meshes), `server.mjs` (dedicated server), `orthros-goldsrc@.service`, `check.mjs` (browser check) | yes |
| `data_games/<game>/` | `manifest.json`, `cover.svg`, `base/` (the original files), `versions/<version>/` | no |
| `data_engines/<release>/` | installed engines: `xash3d-web-1.2.2` (browser), `xash3d-web-1.2.2-cs16-15278ca-r2` and `…-arsenal-r4` (the same engine with Counter-Strike modules built from source), `xash3d-dedicated-e0ece3d` (native dedicated server) | no |
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

`src/ports/goldsrc/play.html` looks as the Windows games' page (`src/host/web/player.css`, shared with `index.html`):
the header (brand, game, frame rate with its last minute and slowest frames, full screen, back to the games), and the
loading screen over the game's blurred cover — first the nickname and "Play", then the start's steps (engine, game
files, the game's first images) with their progress, and tips.

- **The game's own main menu.** No mode to choose before the start: the engine starts on the game's menu, where the
  player picks single player (Half-Life's new game; Counter-Strike's multiplayer, create game) or multiplayer. The
  manifest's `solo.commands` run at the start (bots, game settings): a game the menu creates gets them; `solo.map` is
  only `check.mjs`'s. The nickname is remembered by the page, and is never the games' default "Player", which their
  multiplayer menus refuse.
- **Orthros' server in the LAN games.** With `multiplayer`, the page opens the relay (`/api/udp/<manifest>`) as the
  engine starts and sends it every packet the engine sends, whatever its address: the menu's LAN search (a broadcast)
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
- **The menu module.** Counter-Strike's manifests name none: the engine's (`engine/libmenu.wasm`) shows the game's own
  title screens and takes the mouse; cs16-client's `mainui_cpp` (still built, `modules.builds`) wants the images of its
  `cs16client-extras` package and gets no mouse position from this engine.
- "Back to the games" saves the profile and quits the engine once the player confirmed (`check.mjs --reload` accepts).

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
`mainui_cpp` (the menu), `ReGameDLL_CS` (the game server). Each of `modules.builds` is a release of its own, its patches
on these sources: `xash3d-web-1.2.2-cs16-15278ca-r2` (Counter-Strike as its sources give it) and
`xash3d-web-1.2.2-cs16-15278ca-arsenal-r4` (the Half-Life Arsenal, below). A release holds the engine files of
`xash3d-web-1.2.2` (checked against the lock) and under `counterstrike/cstrike/` the three WebAssembly modules,
`dlls/cs.so` (the same server compiled natively for the 32-bit dedicated server: `multiplayer.gameLibrary`) and
`orthros-bots.pk3` (`goldsrc.extras`).

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

## Half-Life Arsenal

`counter-strike-hl-arsenal`: Counter-Strike 1.6 with the fourteen Half-Life weapons bought beside its own — the two
Half-Life tabs of its buy menu (below), or the console aliases of the table. Both teams, every map, anywhere and at any
time of a round (`mp_buy_anywhere 1`, `mp_buytime -1`: the mod's defaults), Counter-Strike's economy (`$800` to start,
its rewards; `mp_startmoney` among the manifest's commands changes it). Their ammo is bought as any gun's (`,`/`.`):
the 9mm handgun and the MP5 share Counter-Strike's 9mm, the shotgun its buckshot.

| Weapon (alias) | Menu, slot | Price | Damage | Notes |
| --- | --- | --- | --- | --- |
| Crowbar (`crowbar`) | 1, knife | $300 | 25 a hit, 0.35 s | beside the knife |
| 9mm Handgun (`9mmhandgun`) | 1, pistol | $400 | 22, 17 rounds | secondary: quicker, wilder |
| .357 Magnum (`python`) | 1, pistol | $900 | 65, 6 rounds | zoom |
| MP5 (`9mmar`) | 2, primary | $1800 | 21, 50 rounds, 10 a second | M203 contact grenade (`argrenade`): 100 blast, $300, 2 at most |
| Shotgun (`shotgun`) | 2, primary | $2000 | 6 pellets of 18 | secondary: both barrels |
| Crossbow (`crossbow`) | 2, primary | $3000 | bolt 50, then a 40 blast | zoom: an instant 100 |
| Hornet Gun (`hgun`) | 3, primary | $2500 | 15 a hornet | 8 that grow back; homing, or straight darts |
| Gauss (`gauss`) | 3, primary | $4000 | 20 | charged up to 200: through walls, pushes its shooter |
| RPG (`rpg`) | 3, primary | $4500 | 120 blast | follows its laser spot; 3 spare rockets at most |
| Egon (`egon`) | 3, primary | $5500 | 12 every 0.1 s | a continuous beam |
| Hand Grenade (`handgrenade`) | 4, grenade | $300 | 100 blast | cooks from the pin, 3 s; 1 at most |
| Satchel Charge (`satchel`) | 4, grenade | $600 | 150 blast | thrown, set off by its radio (secondary); 2 at most; gone with its owner |
| Tripmine (`tripmine`) | 4, grenade | $500 | 150 blast | on a wall; its beam is set off by enemies only, the mine by shots; 2 at most |
| Snarks (`snark`) | 4, grenade | $500 the 3 | 10 a bite, a growing pop | hunt the nearest enemy for 15 s; 6 at most |

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

### Its own menus

The mod's client draws its team, appearance and buy menus itself (`cl_dll/arsenal_ui.cpp`), in the page's look: the
original game's are VGUI panels of a library not available in WebAssembly, the text menus their fallback.

- **Team**: the two sides, a player model of each turning in its card (their looks in turn), how many play in each;
  auto-select, spectate, cancel when allowed. **Appearance**: the side's looks, each turning with its name.
- **Buy**: eight tabs (pistols, shotguns, SMGs, rifles, machine gun, equipment, the Half-Life guns, the Half-Life heavy
  weapons and explosives), the items the player's team may buy with their price (red when too dear, "owned"), and the
  hovered one turning in 3D (drag to turn it) with its figures: damage (pellets), fire rate, armor piercing, range
  (damage kept at 1000 units), mobility (speed), magazine, a line on its use. Click buys (the server's buy aliases);
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
`\n#<piece>`); entries of other files or older versions are deleted at the start. The settings' device tab and the account's online copies handle the Windows games' profiles
only: a port's saves stay in this browser.

## Multiplayer servers

One native dedicated server per version, `orthros-goldsrc@<manifest>` (systemd, `DynamicUser`, its state in
`/var/lib/private/orthros-goldsrc/<manifest>`), runs `tools/goldsrc/server.mjs`: it links the version's files into
`$STATE_DIRECTORY/game` (the engine reads one directory) and starts the dedicated server on 127.0.0.1 only.
Half-Life uses UDP 28015, Counter-Strike 28016, Counter-Strike (rebuilt) 28017, Half-Life Arsenal 28018.

```sh
python3 tools/goldsrc/install-engine.py          # browser engine release -> data_engines/
sh tools/goldsrc/build-server.sh                 # dedicated server -> data_engines/ (gcc, 32-bit libraries)
sh tools/goldsrc/build-modules.sh                # Counter-Strike modules from source -> data_engines/ (Docker, g++ -m32, the game's files)
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
- The game files are the games' own, never modified; their provenance is recorded in each manifest's `installedFrom`.
