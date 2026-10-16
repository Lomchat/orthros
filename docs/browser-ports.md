# Browser ports: games whose engine runs as browser code

Orthros runs games in the Win32 emulator and browser ports. All are declared by `data_games/<game>/manifest.json`, listed on the same home,
served by the same server (`src/host/server.js`, `orthros.service`) on the same origin. The version's `runtime` says
which kind it is:

- **`win32`** (the default): the unmodified Windows game in Orthros' own emulator (`src/cpu`, `src/loader`, `src/win32`,
  `src/gfx`, ...), written from scratch.
- **`goldsrc`**: a browser port. The game's original files run on a pinned third-party GoldSrc engine, Xash3D FWGS
  compiled to WebAssembly, with the game's client/server/menu modules compiled to WebAssembly too. Its page is
  `src/ports/goldsrc/`; it never loads the Win32 runtime, and the Win32 runtime never imports it.

Nothing in the code names a game: engine release, game directory, modules, maps and server ports come from the manifest.

OpenMW ports use `runtime: "openmw"`, their own page and a pinned OpenMW-Web engine. Their
multiplayer uses a native world gateway and simulation peers, proxied on the same origin.
See [OpenMW installation, pending data and validation](openmw.md). The original game files
and several mods are still required; the freely licensed engine example is a separate card.

## Where things are

| Path | Content | In Git |
| --- | --- | --- |
| `src/host/goldsrc.js` | manifest checks, engine availability, multiplayer relay, linked game tree of the dedicated server | yes |
| `src/ports/goldsrc/` | the port's page (`play.html`, `play.js`, `storage.js`, `style.css`) | yes |
| `tools/goldsrc/` | `lock.json` (pinned upstream sources and artifacts, SHA-256), `install-engine.py`, `build-server.sh`, `build-modules.sh` with `patches/` (`hl-arsenal/`: the mod) and `cmake/` (game modules from source), `bot-nav.mjs` (bots' navigation meshes), `server.mjs` (dedicated server), `orthros-goldsrc@.service`, `check.mjs` (browser check) | yes |
| `data_games/<game>/` | `manifest.json`, `cover.svg`, `base/` (the original files), `versions/<version>/` | no |
| `data_engines/<release>/` | installed engines: `xash3d-web-1.2.2` (browser), `xash3d-web-1.2.2-cs16-15278ca-r2` and `…-arsenal-r7` (the same engine with Counter-Strike modules built from source), `xash3d-dedicated-e0ece3d` (native dedicated server) | no |
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
  idle connections closed after two minutes. With `?rooms` (the page's): one socket per room, each message carrying
  its room in its first byte (255: every room — the game's LAN search).
- `/api/rooms/<manifest>`: the lobby. GET: the version's games (its permanent server and the rooms players created:
  name, map, players with the bots, humans, size, bots), the maps and the limits, from its server manager. POST
  `{ name, map, maxPlayers, bots }`: a room created (the page's origin, one a minute per address), answered once its
  server answers.

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
`xash3d-web-1.2.2-cs16-15278ca-arsenal-r7` (the Half-Life Arsenal, below). A release holds the engine files of
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

### Poké Balls (r7)

Three more items of the grenade slot (`pikachu` $1000, `charizard` $1400, `blastoise` $1300; ids 46 to 48, after the
snarks; one ball carried and one Pokémon out at a time; bots do not buy them). Thrown like the hand grenade, the ball
bounces, wobbles at rest and opens (lid away from the thrower, a flash): the Pokémon comes out beside it
(`monster_pokemon`, `wpn_shared/wpn_pokemon.cpp`). It follows its owner (the bots' navigation mesh, else straight
steering; back beside the owner past 1500 units or stuck), and as soon as the owner fires (the enemy nearest to their
aim) or the owner or the Pokémon is hurt (the attacker) it charges and attacks within 200 units (5 m) with line of
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
judged before the engine. Models: `models/pokemon/{pikachu,charizard,blastoise}.mdl` (≈3000 triangles each; sequences
idle, walk, run, attack, flinch, die, spawn, victory), `w_`/`p_`/`v_pokeball.mdl` (the view model: a gloved hand; one
skin per species); sprites `zap`, `fire`, `water`, `flash` (additive: black only where the palette entry is exactly 0,
the engine's texture gamma lifting the rest), `hud`, `d_pokemon`; 19 sounds. No file comes from elsewhere.

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
`\n#<piece>`); entries of other files or older versions are deleted at the start. The settings' device tab and the account's online copies handle the Windows games' profiles
only: a port's saves stay in this browser.

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
  as its UDP port): GET and POST `/rooms`, for the Orthros server only. The unit allows 1.6 GB, 3 cores and 192 tasks
  (a server takes about 150 MB).
- **The lobby** (`src/ports/goldsrc/lobby.js`): in the page's loading screen and over the game (the header's "Online
  games"), the version's games with their map and players, joined in a click — the engine started first if it is not —
  and the form that creates one: a name, a map picked on its picture, a size and bots (− and + buttons), the version's
  options as buttons side by side (`rooms.options`: Counter-Strike's bots' team, `bot_join_team`, and starting money,
  `mp_startmoney`). A map's picture is the game's own overview (`multiplayer.mapImage`, `/api/map-image/<manifest>/<map>`,
  compressed once by the server), drawn smaller by the page with its keyed pure green turned into the panel's dark, and
  loaded when its card comes into view; a map without one gets its name on a pattern. Each room is also in the game's own LAN list, under its
  name: the relay sends the LAN search to every room, room i answers as 10.87.0.<i+1>:27015 (127.0.0.1:8080 too for
  room 0). The home's cards tell how many games are online and how many play.
- **Ports.** Half-Life: UDP 28015, rooms 28100-28103; Counter-Strike: 28016, rooms 28110-28113; Counter-Strike
  (rebuilt): 28017, rooms 28120-28123; Half Strike: 28018, rooms 28130-28133. The catalog refuses a port two versions
  take.

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
