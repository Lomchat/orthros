# OpenMW browser port

The owner authorized an OpenMW port with faithful visual mods and multiplayer on 2026-10-15.
This extends the third-party engine exception of D069. It does not change the Win32 runtime.
The engine release, source archive and native simulation image are pinned by
`tools/openmw/lock.json` (OpenMW-Web v1.5.3). No third-party source is committed here.

## Current installation

- Browser engine, corresponding source and native simulation image remain pinned to v1.5.3.
  The freely licensed example card (`openmw-example-1.5.3`) was removed by the owner on 2026-10-18 (its manifest in
  `data_installers/removed-2026-10-18/`).
- On 2026-10-18 the user's two encrypted RAR volumes were successfully extracted. Their
  multilingual ISO installer was run in a disposable, network-isolated filesystem to recover
  the English GOTY data. Only its `Data Files` directory was copied into an empty
  `data_games/morrowind/base/`: 7,372 files, 1,126,510,640 bytes. Installers remain outside
  `data_games`, in `data_installers/openmw/`; an import receipt records the master/archive hashes.
- The original profile `morrowind-goty-en` shares that base, declares no mods, and uses the
  gateway on localhost port 28101 (`orthros-openmw@morrowind-goty-en`, enabled). The full
  `morrowind-goty-vanilla-plus-en` profile keeps its original id and now contains all seven mods.
  Its enabled gateway uses localhost port 28100. Saves/worlds stay separate from the original profiles.
- Project Atlas is installed from its authors' public repository, commit
  `68a838650fb177afb5e6a63c558dc4ae6bf29b56`, SHA-256
  `364c5896a4b181def2420e1b30f54043b3c0ef35812db24b53fe79f1aa1a92f5`.
  Selected parts: Core, MET textures, Glow in the Dahrk and Graphic Herbalism patches.
- Morrowind Optimization Patch is installed from the authors' `mop-org` repository, commit
  `09951b376ad8e57d8bdca64fca92c83db732a32b`, SHA-256
  `234709b8b0f603430251eb4259eac355b400454413fb6c685b6d58a60738fb7b`.
  Selected parts: Core, Lake Fjalding Anti-Suck, Chuzei Fix, Better Vanilla Textures,
  Graphic Herbalism patch; the two supplied ESPs are enabled in the Vanilla+ stack.
- Glow in the Dahrk 3.3.0 and Graphic Herbalism 1.04 are installed from the French Confrérie
  des Traducteurs packages, translated by Redondepremière. The Glow mirror is linked by the
  original author; Graphic Herbalism permits redistribution with attribution. Only the core
  meshes, textures and documentation were copied; no MWSE scripts or optional plugins.
  Archives, SHA-256 hashes, source selections and receipts are in `data_installers/openmw/`.
  The source pages are [Brille dans le Noyr](https://www.confrerie-des-traducteurs.fr/morrowind/mods/1890/graphisme/environnement/brille_dans_le_noyr)
  and [Récolte réaliste](https://www.confrerie-des-traducteurs.fr/morrowind/mods/1973/jouabilite/recolte_realiste).
  Glow 3.x supports basic OpenMW window glow, but its author recommends 2.11.2: sunrays in
  3.x cannot be toggled and the new MWSE interior-light features are unavailable. The staged
  core is included in the startup/party checks below; these do not exercise every window effect.
  Prefer 2.11.2 when its archive is available if the documented 3.x limitations matter.
- Familiar Faces 2.1 is installed from [Portmod's public mirror](https://gitlab.com/portmod-mirrors/openmw/-/raw/master/Familiar_Faces-50093-2-1-1678377705.zip),
  with the optional Redguard female teeth texture fix. Archive size and MD5 match the
  [Portmod package manifest](https://gitlab.com/portmod/openmw-mods/-/raw/master/assets-misc/familiar-faces-by-caleb/Manifest);
  SHA-256 is `650f44032fec42a423a11b06f550b38d878c1b2f92b62ac6d94329287364d162`.
- Patch for Purists 4.0.2 is installed from a [community archive](https://www.mediafire.com/file/xl5qun6xu46uiuz/Patch_for_Purists.zip/file).
  All 67 extracted files match the XXH64 hashes and lengths from Kezyma's independently
  maintained Morrowind Remastered Legacy Wabbajack installation manifest, commit
  `817d04cdd785a1533ebedab682f4a7063a631ec1`. The core `Patch for Purists.esm` is enabled;
  the optional Book Typos and Semi-Purist ESPs are not included. Archive SHA-256:
  `341ec4659d1b0625888623d0a467c2e4c641f4104efa1b40332636319c121dc4`.
- Morrowind Enhanced Textures 4.1 is downloaded from the [SourceForge mirror](https://sourceforge.net/app/morrowind-enhanced-textures/files/windows/MET_4.1-46221-4-1-1587244159.7z/download).
  This deliberately uses an older complete release, rather than pretending the Nexus-only
  6.1 release has been obtained. Archive size: 1,119,672,974 bytes, MD5
  `2f8190b8eb70483438cafd09caba5f87`, recorded in the
  [Portmod package manifest](https://gitlab.com/portmod/openmw-mods/-/raw/master/assets-textures/morrowind-enhanced-textures/Manifest).
  BLAKE3 also matches Portmod; SHA-256 is
  `618f6da234f40749d725858ec8307c56f44e2528bd1d0f3c0d268afa71adba93`.
  Atlas retains its bundled MET atlases; the separate optional MET 6 Atlas update is not installed.
  Load order follows Atlas's authors: PfP, MOP, GitD, GH, MET, Atlas, then Familiar Faces.
- These mirror downloads do not require a Nexus session. No CAPTCHA solvers or third-party
  account services were installed, and no Nexus password is stored. SHA-256 receipts and
  reference metadata remain in `data_installers/openmw/`.
- The hidden `morrowind-goty-vanilla-plus-fr` profile is the French language target of the
  Vanilla+ launcher. It uses the French masters/voices and six visual mods: MOP core/textures/GH
  meshes, GitD, GH, MET, Atlas and Familiar Faces. No English PfP master or MOP ESP is enabled.
  Localized data and identical mod assets are hardlinked into its version overlay; original files
  are unchanged and the native containers mount game data read-only. Its enabled gateway uses
  localhost port 28103 and the existing Orthros account bridge, with coordinate start cell `-2,-9`.
  The original EN/FR profiles keep their ids, language routes, saves and native worlds.
  The two graphical language profiles have separate saves/worlds too; friends choose the same
  language. English includes the additional gameplay bug-fix plugins. English mod data totals
  2,674,097,631 bytes, above the 1,126,510,640-byte GOTY base.
- Validation of the complete English stack: two fresh Orthros accounts entered the same
  Party through public HTTPS; the native roster confirmed both connected, both clients had
  the other player's puppet and 41/62 mirrored actors. The browser requested 855 mod asset
  URLs and raised no page errors. Character creation was advanced with QA hooks; this is
  a startup/social/simulation check, not a manual tutorial or full campaign test.
  The same two Orthros accounts then repeated the party check with the French graphics
  profile: both players present, reciprocal puppets, 41/61 mirrored actors and 850 mod asset
  URLs, with no page errors. Both clients were closed between language-profile tests.
  Four characters were then retrieved through their Orthros sessions after both browsers
  closed. The English graphical solo profile booted from its home card (6,585 observed draws).
  A returning French character was selected with a normal pointer click after fixing the
  covering loader, and reached `Joined` with `simReady=1`. The complete test suite passes:
  1,094 passed, zero failed, three pre-existing TODOs. QA worlds and accounts were removed;
  small proofs and pinned source receipts remain under `build/proof/openmw-full-mods-20261018/`.
- A complete campaign and GPU performance on the player's machine remain unvalidated.
  Do not activate Atlas/MOP compatibility patches in the original profiles on their own.

The GOTY edition is available from [GOG](https://www.gog.com/en/game/the_elder_scrolls_iii_morrowind_goty_edition)
and [Steam](https://store.steampowered.com/app/22320/). OpenMW is free; the retail game is not
included. Keep installers and downloaded mod archives in `data_installers/openmw/`.

## Interface addons

The graphical English and French profiles also use these pinned, script-only UI addons:

- [UI Modes](https://gitlab.com/modding-openmw/ui-modes), version 1.2,
  commit `0ab8a8ea270b3ed354ab021ba766780a596e0bc7`. The author's package-registry
  archive matches its published SHA-256
  `1ac662d42e997313e1e083966729ee784f1100f867420536d9358bb767e611ed`.
- [Questman](https://github.com/fixer-m/morrowind-questman), commit
  `d96b75a5892ca9eea9eb282483506541e69b2ee8` (the source includes the 1.5 changes).
  Its `src/` directory is the data root. This includes the French/German quest-detection
  correction, absent from the older 1.3 GitHub release. Quest names, entries, NPC names and
  faction names come from the loaded game data; the addon itself currently supplies English,
  Russian and Polish labels, so French game text does not imply French addon buttons.
- [Advanced World Map](https://github.com/Diject/openmw_advanced_world_map), commit
  `951c05e92541630f108c94b9af290dddb1b8092d`. Install the repository's data root, including
  its bundled world-map textures. The optional full local-map texture packages are separate.

The engine already loads the MysticCards, DemonicLetters and DejaVuLGC Sans Mono TrueType
fonts; no older font bundle is required. Quest Markers Plus is **not installed**: the Nexus
archive requires authenticated download access; a normal sign-in submission failed its CAPTCHA,
and no complete public source was found.
Its downloaded dependencies alone must not be advertised as the compass addon.

The addons are activated in both live Vanilla+ profiles; the original profiles stay unchanged.
UI Modes opens the journal with `X` and the classic map with `M`. Advanced World Map has its
own configurable map hotkey under Options → Scripts → Advanced World Map. Its default can
also become `M`, so choose a free key such as `N` there if both map menus react. In its key
widget, the first click clears an existing binding; click again to record a replacement.

Validation on 2026-10-18: two real Chromium clients joined the same French Party, reached
`Joined` / `simReady=1`, and listed each other, with no JavaScript or Lua errors. Questman
visibly displayed “Rapport à Caius Cosadès”. One English client also joined successfully and
registered all three addon settings pages. This validates startup and the French journal;
it does not validate an entire campaign or every map feature. The full unit suite passed
1,096 tests, zero failures, with three existing TODOs. Sanitized receipts and screenshots are
kept in `build/proof/openmw-ui-20261018/`; original archives and the pre-install manifest are
kept in `data_installers/openmw/`.

### Additional quality-of-life addons

The Vanilla+ language profiles also include four author-source packages, pinned on 2026-10-18:

| Addon | Revision | Purpose |
| --- | --- | --- |
| [QuickSelect](https://github.com/voshond/openmw-quick-select) 1.0.28 | `cf36cf7b50b38a1cc2a5d8880164e18cd0992cbf` | Visible hotbars for items and spells; configurable assignments and counts |
| [Take All](https://github.com/voshond/openmw-takeall) | `7ad8a014917898951e80dfb6d2150a12189efd4a` | One-key container/book pickup |
| [Smart Ammo](https://gitlab.com/modding-openmw/smart-ammo) | `f7ed77ad8001b98ba37e8ae89a3bf22be466ae3b` | Automatically equips compatible ammunition and replaces an exhausted stack |
| [RUN!](https://gitlab.com/modding-openmw/RUN) | `b09f87c35187aa203ef31c05587857d6b3aa361c` | Configurable sprinting that drains fatigue |

Only the authors' release data roots are installed, excluding presentation content, videos,
websites and developer tools. QuickSelect's generated `build_info.lua` follows its packaging
script and identifies version 1.0.28. Source archives and SHA-256 receipts are kept in
`data_installers/openmw/`. The four addons themselves total 404,344 uncompressed bytes.
The original game data and original unmodded profiles remain unchanged.

QuickSelect's `QuickKeys` window registration raises a Lua error on the headless simulation
player. A separate `qol-client-ui-compat` root guards its six UI entry points with the same
`openmw.mp.isSystem()` check as the earlier UI layer, using a distinct wrapper namespace.
Take All's GLOBAL/CONTAINER declarations and Smart Ammo's GLOBAL declaration remain exactly
as shipped; RUN's original player controller remains enabled. All clients and simulation peers
use the same plugin bytes and content hashes.

A separate player script supplies missing input bindings once: `R` for Take All, and Left Alt
for RUN. It skips simulation peers, preserves an existing binding and records each migration
so later player edits, including clearing a key, stay intact. Both are adjustable in Options →
Scripts. QuickSelect opens its assignment window through the game's quick-key menu (`F1`);
its hotbars use the number row, with Shift/Ctrl for the additional bars.

Validation: QuickSelect's assignment window renders in French, Take All transfers a local
container item, and Smart Ammo changes the equipped ammunition stack. Two isolated Chrome
clients with the four addons joined the same French Party and exposed reciprocal player IDs.
The final two-client check also loaded an experimental container overlay; it is **not** part of
the installed pack. RUN loads and its binding is configured, but sustained sprinting has not
been functionally confirmed. This does not validate a full campaign or every addon action.
The full `make test` suite passes: 1,097 successful tests, no failures and three existing TODOs.

Known limitation in the pinned multiplayer engine: its container watcher expires after
15 seconds even while the container window remains open. A late local transfer can leave the
server's contents stale. An experimental UI lease overlay passed a stubbed regression but did
not establish a successful browser fix; it remains undeployed. Avoid leaving a shared loot
window open for a long time. Diagnostic sources and receipts, marked NOT DEPLOYED, are kept
in `build/proof/openmw-qol-20261018/`. Original packaged engine Lua hashes match the native
image; the source archive's `fsroot` copies differ and must not be used as a patch base.

### Headless simulation compatibility

The pinned engine identifies its native simulation peers through `openmw.mp.isSystem()`.
Unadapted UI scripts can reach graphics APIs on these peers and crash before `simReady`.
`tools/openmw/guard-client-ui.mjs` accepts explicitly selected UI-only mods and adds a final
`client-ui-compat` data root. It replaces their script configuration entry points with tiny
wrappers: native simulation peers return an empty handler table, while browser clients
execute the author's original module in the same context. Both sides load identical plugin
bytes; no content-manifest exception or authentication bypass is introduced.
Explicitly attached `CUSTOM` scripts retain their original registered filenames, so addon
calls to `addScript`, `hasScript` and `removeScript` continue to resolve them.

```sh
node tools/openmw/guard-client-ui.mjs data_games/morrowind morrowind-goty-vanilla-plus-fr \
  ui-modes questman advanced-world-map
```

Run this only after installing all selected UI addons. It preserves every original addon file,
moves the enabled plugin selections into the generated root, and refuses an existing patch or
unsupported declarations before changing the manifest. It must never be used to disable
gameplay or quest scripts on the simulation peer.

## Installation and completion

Use Node 24+ (`/usr/local/bin/node` on this server). All browser checks must use the shared slot wrapper.

```sh
python3 tools/openmw/install-engine.py --server
node tools/openmw/install-game.mjs
node tools/openmw/install-game.mjs --data-files '/path/to/Morrowind/Data Files'
```

The last command requires the six GOTY master/archive files. It copies into an **empty**
`data_games/morrowind/base/` and refuses to overwrite an existing installation. A GOG offline
installer may first be extracted with the tooling `innoextract` into the task's scratch directory.
The manifest currently selects the English release, matching the recommended English plugins;
do not import a translated installation under that version id.

Mods go in separate data roots in the version folder; never overwrite `base/`. Extract the
author's archive into task scratch, inspect its installation instructions, and select the
applicable parts and plugins explicitly:

```sh
node tools/openmw/install-mod.mjs data_games/morrowind morrowind-goty-vanilla-plus-en \
  project-atlas /path/to/extracted/Project-Atlas \
  --part '00 Core' --part '01 Textures - MET' \
  --part '06 Glow in the Dahrk Patch' --part '07 Graphic Herbalism Patch' \
  --sha256 364c5896a4b181def2420e1b30f54043b3c0ef35812db24b53fe79f1aa1a92f5
```

That command has already been run for Atlas. It refuses a second installation. For other
mods use their declared id from the manifest and their actual data-root names. Enable required
plugins with `--plugin 'Name.esm'` (repeat for each). It discovers archive **names**, never parses
game formats, records the selected roots and verifies a sentinel before advertising availability.
The manifest array determines order. The native peer and the browser receive that same stack
through OpenMW-Web's own `modlist.json` format. Do not install MCP, MWSE or MGE XE.

After importing the real game and all mods:

```sh
install -m 644 tools/openmw/orthros-openmw@.service /etc/systemd/system/
# /etc/orthros-openmw.env: ORTHROS_ORIGIN=https://orthros.chalco.website
systemctl daemon-reload
systemctl enable --now orthros-openmw@morrowind-goty-vanilla-plus-en orthros-openmw@morrowind-goty-vanilla-plus-fr
```

The runner refuses an incomplete manifest. It generates a linked read-only game tree and mod
list under `build/openmw/<manifest>/gamedata`, then starts the pinned native gateway in Docker.
Only `127.0.0.1:28100` is published. Limits: two CPU cores, 4 GiB, 256 tasks; worlds have a
3 GiB memory budget plus 256 MiB gateway reserve. Worlds start on demand and idle out. Accounts,
worlds and saves persist under `build/openmw/<manifest>/`, separate from the original game files.
Back up that state directory. Do not delete it when updating the engine.

For the currently installed original profile, the active unit is
`orthros-openmw@morrowind-goty-en` (port 28101) and the public entry point is
`https://orthros.chalco.website/ports/openmw/morrowind-goty-en/`. The complete Vanilla+ profile
is now enabled too, with its French language target on port 28103. Accounts and saves belong
to each profile separately. The owner's two requested player accounts are provisioned on the original
profile; their generated credentials are in `build/openmw/morrowind-goty-en/player-access.json`
(mode 0600, outside Git). Their public usernames are already set, with local placeholder email
addresses; no Nexus credential is reused or stored.

Password servers have no self-service registration in the pinned upstream version. Create a
player through the local operator API, with the password supplied on stdin:

```sh
node tools/openmw/create-account.mjs morrowind-goty-vanilla-plus-en Alice --password-stdin
```

Finish stdin with EOF after entering the password, or redirect a private file. The first run
creates a random local operator credential in `build/openmw/<manifest>/operator.json` (0600).
Players have no administration role. The public proxy never forwards operator API requests.
This tool remains available for local diagnostics. Normal players use their Orthros account
on the port page; switch the world to Party and add friends. Party visits advance the host's campaign. Multiplayer is experimental.

## Runtime boundary and validation

`runtime: "openmw"` uses `src/ports/openmw/` and `src/host/openmw.js`. The manifest specifies
the engine id, required files, optional example/start cell, mod stack and localhost gateway
port. Every installation has its own URL `/ports/openmw/<manifest>/app/` and its own IDBFS
database (`saveKey`). Pages, browser assets, range requests, auth and WebSockets use the same
Orthros origin; the Win32 emulator never imports the engine.

The common loading screen yields to the upstream launcher when its frame loads: returning
players must be able to click their existing character before an engine can produce frames.
It returns for the initial engine page and hides after rendering begins. A browser regression
uses a real pointer click on a character selector, then checks the loading/rendering transition.

The upstream browser pages are adapted while serving: HTTP paths and world socket paths get
the installation prefix; guest filesystem paths stay intact. The dedicated server is unchanged.
The local portal assets come from the pinned corresponding source. The public router exposes
the gameplay/auth/storage routes and only the portal's static files, not the operator dashboard.
WebSockets require a matching Origin; the bridge fixes the target port from the manifest and
replaces client address headers. Unit tests cover isolation, missing files/mods, ranges, world
paths, cookies, and WebSocket forwarding/origin rejection.

Loading (2026-10-20, after the owner's "stuck at 20 %" and a New Game freeze). The engine build
(`openmw.{js,wasm,data}`, 238 MB) is sent as the release's own brotli siblings when the browser takes
them (39 MB; Orthros' own builds, tools/openmw/build.sh, make them at brotli quality 11: orthros-r1's openmw.data
33 MB, 40 MB at 9; no `Content-Length`, so Emscripten's progress counts against the decoded package size — the
server's `sendBrotli`, which says the sizes in `X-Orthros-Wire-Length` / `X-Orthros-Decoded-Length` instead: Prepare's
download worker counts the decoded body in wire bytes from them, the unit of the card's engine size),
from `/engines/<release>/e/<hash>/` (immutable, one browser copy for every installation:
`withSharedEngine`). The page adaptation drops the upstream `?v=2` from the base game's StreamFS
URLs (with a query the upstream streamfs.js kept none of the pieces it read). The engine reads its
game files synchronously on the page's thread (1–8 KB reads through its own buffers); the page
cannot paint meanwhile and Chrome may offer to close it. The Orthros loading screen shows the
package download (received / size, rate) and switches to "reading the game data" at its end;
`src/host/web/data-meter.js` (every game's; injected with the frame meter) draws an indicator from a worker in an
OffscreenCanvas over the Orthros page — its frames reach the screen while the page's thread is held
(verified in a headed Chrome under Xvfb; headless screenshots cannot show it, they need that thread):
data received (the streaming's shared byte counter), rate, seconds, and "choose Wait" once Chrome
may ask.

The engine's package without the example world (2026-10-21, `src/host/openmw-lean.js`). The release's `openmw.data`
(204 MB, 33.4 MB in brotli) holds the engine's resources (3.3 MB), ICU's data twice (`/icudt68l.dat` and
`/icu/icudt68l.dat`, 28.6 MB each) and the free example world the page boots with `?nomw` (`/gamedata/`, 144 MB:
22 MB of the brotli). Every data path of the engine page for a game of its own (hosted, local folder, locker) writes an
`openmw.cfg` without `data=/gamedata`, yet a new Morrowind player downloaded it before the menu (4-5 min at 85 KB/s).
The server makes, once per release, the same package with the example world's bytes zeroed — same size and offsets, so
the metadata inside `openmw.js` stays as it is — at brotli quality 11 (a niced child, `openmw-lean-worker.js`, 207 s
on the loaded test machine; orthros-r1: 14.9 MB), kept in `<br-cache>/engines/<release>/lean<rule>/<build>/` and
served immutable as `/engines/<release>/lean<rule>/<build>/openmw.data`; the engine page of a version that is not the
example (`withLeanPackage`) has `locateFile` give that address for `openmw.data` unless it boots `?nomw`, answered as
brotli without `Content-Length` like the release's own (`sendBrotli`). The server starts making it at its start for
every installed game of its own (else the first card or page asking for it does); until it is made pages load the
release's own package, and the card's engine files (`launch.engineFiles`, what Prepare caches) leave the package out
(`pending`: a Prepare meanwhile would cache a URL the page stops asking for once the lean one is there). The home's
engine size counts it once made (`engineOf`); a Prepare whose engine files are no longer the card's (`engineFiles` kept
with its progress) shows as not ready, its engine to fetch again. Not done: ICU's second copy (the page sets `ICU_DATA=/`, so `/icu/` looks
unused — another 6-7 MB — not zeroed without a check that nothing reads it).

The engine page's file streaming is the game data every Orthros game reads (CLAUDE.md "Standardization";
docs/slow-network.md): `src/ports/openmw/streamfs.js` keeps the engine page's StreamFS interface (swapped for the
release's by `withStreaming`; `?sfs=upstream` on the port's page keeps the release's) and maps its mounts onto the
version's tree — `mwdata/<file>` → `<file>`, `mwdata/mods/<part>/<file>` → `mods/<part>/<file>`, `moddata/<file>` →
`_engine/<file>` (the release's asset pack: a `dataMounts` entry of the manifest, served by `/api/tree` and `/gamez` with
the game's files, not laid out for the native gateway). The bytes come from the data worker (`src/vfs/data-worker.js`:
the Windows games' reader — compressed ranges, the link's measure and regimes, the learned order fetched ahead from the
game's position, the OPFS block store `orthros-files-<manifest>`, the whole download) through `data-client.js` and
`emscripten-files.js`; the learned order is the server's `/api/prefetch`, fed by the pieces the engine used (reported by
the worker); the player first in the world (`view-grow.js` `inWorld`: alone, `view.lua`'s first report; in multiplayer, which has
no Orthros script, the world joined and simulated — `simReady`) marks the session playable (`GameData.mark`:
the launch set the home card announces, docs/slow-network.md "Playable after"). Files of elsewhere (a signed address, a file the player picked) go through the same worker. The copies the
page kept before (2026-10-20: OPFS `orthros-streamfs-1`, the release's Cache API `mwdata-chunks-v1`) are taken into
the store before each file's first read (`legacy-copies.js`): measured, a second visit after the earlier page fetched
28 MB instead of 166.

Measured with the page's own streaming (before the shared game data, same day) through a 2 MB/s link (tools: a throttling proxy; headless Chromium, SwiftShader):

| vanilla-plus-fr | upstream streaming | Orthros streaming |
|---|---|---|
| new player, launch → menu | 160 s, 328 MB with the New Game's start | 63 s (no list yet: 84 s) |
| new player, first New Game: longest freeze | ~35 s | 6.3 s (no list yet: 25 s) |
| new player, boot + New Game + 2 min | ~410 MB | 174 MB |
| returning player, launch → menu | 15 s | 14 s; New Game 6.9 s, 16 MB |
| upstream cache taken over | — | 16 s to the menu, 33 MB |

With the shared game data (same harness, a learned order of one session): new player 70 s to the menu, first New Game's
longest freeze 7.4 s, 207 MB (148 MB of them fetched ahead in the background, 4 MB the game waited for; the learned
prefetch takes whole blocks beyond the pieces sessions read — to tune in the shared reader, for every game).
Unthrottled the launch takes 16 s (the engine's own work). Not validated: multiplayer and the locker
(signed addresses, a player's own files) with the new streaming; real GPUs.

World-travel replies can also arrive through the engine's WebSocket protocol, with a root
`/w/<world>` destination. The served page scopes same-host WebSocket destinations at its
reboot boundary before building the next boot fragment. HTTP JSON rewriting alone cannot
cover this path. Already scoped URLs and other hosts/ports/protocols are left intact. The game page also scopes
the engine glue’s upstream `omwmp:*` storage accesses through its Storage methods, so the
native resume token and HTML ticket cleanup refer to the same installation-specific key.

```sh
tools/with-browser-slot.sh node tools/openmw/check.mjs morrowind-goty-en \
  --url https://orthros.chalco.website --seconds 3
```

This check is a solo smoke check (the engine draws, the Orthros frame shows its frame rate and the mouse), **not** a
Morrowind multiplayer or gameplay success claim. (Until 2026-10-18 it ran on the free example.)

### The page (2026-10-18)

The port's page has the frame of every Orthros game (`docs/game-frame.md`): the header (game, version · language, mouse,
saves, frame rate, settings, full screen, back to the games) over the engine's page in a frame, and the loading screen
where the player chooses the game's language (its language versions), solo or with friends (an Orthros account
required), with the engine's licence. The engine's pages get `frame-meter.js` (the frame rate and the pointer lock,
told by messages) besides `cloud.js`, whose save states (saving, saved, error, conflict) feed the header's indicator;
leaving by « Games » asks it to send what is not on the account yet (`orthros-flush`), 15 s at most. In multiplayer the
indicator says the world's server keeps the character. The engine's own overlays (the multiplayer onboarding) stay in
English: they are the upstream portal's.
Alone (hosted game), on a link that was not fast last time (`linkRate.fast()`, `src/vfs/data-client.js`: below
`FAST_BPS`, or not measured yet) the page adds `&novid` to the engine page's address: the intro videos (the two logos,
the new game's movie, tens of MB before the menu) are not played, and a toast says so. `?video=1` on the port's page
plays them all the same.
Initial validation: `make test` passed (1,073 passed, 3 skipped, 2 todo); targeted catalog/proxy
checks passed after the final changes. Chromium reached the example's Village from the home
card, drew 8,515 WebGL calls and opened the expected installation-specific IDBFS database.
The published HTTPS site also passed the browser check (7,645 draw calls), with the example
available and the incomplete Morrowind version unavailable.
The real pinned gateway accepted a locally provisioned test player, issued its login credentials
and returned its profile; Chromium followed the namespaced sign-in to the username/profile step
without a page error. Those accounts and worlds were scratch only and were removed afterwards.
Before marking Morrowind ready, verify two real browser clients in the same party: mutual
movement, NPC simulation/combat, quest progression and saves after both clients reconnect.
Also verify solo save/load and the selected visual mods. Measure client GPU performance then.


### View distance: near first, far in the background (2026-10-21)

No engine rebuild: of the engine's settings only the view distance changes while it runs (`camera.setViewDistance`,
`RenderingManager::setViewDistance`); distant terrain and object paging are chosen once per worldspace, so they stay
on as the page's quality tier says (`TIER`), and the boot distance is what changes. The server's rewrite of the engine
page (`withProgressiveView`, `src/host/openmw.js`):
- loads `src/ports/openmw/view-grow.js` in its head (`window.orthrosViewReady`; the engine's `openmw.js` is added once
  it is there);
- its `[Camera] viewing distance` comes from `orthrosViewBoot(TIER.vd)`: on a link not fast last time (`linkRate`, the
  same rule as `&novid`) and with Orthros' file streaming, 8192 (`window.orthrosViewStart`; the tier's,
  `window.orthrosViewTarget`, is reached later); else the tier's. `?vd=N` still fixes it (no growth). Never in
  multiplayer (`window.__omwMPEnabled`) nor in the baked example world (`?nomw`, `__FORCE_NOMW`: no game data over the
  network, no `openmw.cfg` written to start the growth): the tier's distance;
- every single-player `openmw.cfg` the page writes (hosted, local files, locker) gets
  `content=orthros.omwscripts`, its files written into the engine's `/resources/vfs` (a data folder of the engine's
  own) before it starts: `PLAYER: scripts/orthros/view.lua` (source `src/ports/openmw/view.lua`) and
  `orthros/view.txt`. Always, whatever the link: saves list their content files. Not in multiplayer: a world checks
  the client's content list against its own (the native simulation's cfg, ending at `mp.omwscripts`) and refuses an
  extra file (`BAD_CONTENT`). (The example world boots its own cfg: no script there.)

The script, every 0.5 s of real time: reads `orthros/view.txt` (`"<distance> <base>"`, rewritten by the page in
MEMFS; `"0 0"` leaves the camera alone) and sets the camera's view distance while the player's setting
(`camera.getBaseViewDistance()`) is still `<base>` — never Settings, so the engine's save of the settings keeps the
player's own; tells the page `window.omw.state['orthros.view']` = `"<view distance> <setting>"` and
`['orthros.cell']` = `"<gridX> <gridY>"` in an exterior, `""` elsewhere (`openmw.mp.set`, registered alone too; it
never touches `window.omw.queue`, the multiplayer script's).

The page's policy (`view-grow.js` `growStep`, every 0.5 s): in an exterior, the game data quiet
(`GameData.quiet(3000)`, `docs/slow-network.md`) and no frame over 50 ms (p99 of the last half second,
`window.orthrosFrames` from `frame-meter.js`) for 3 s, a step of 2048 (`GameData.prefer('light')`: its textures read
light, their files after them); applied by the script and quiet again for 3 s, the step is loaded (`prefer(null)`),
the next one may come, up to the tier's distance. The player's own setting not the boot value (saved earlier, or changed
in Options): stopped, theirs wins. `window.orthrosViewState()` shows the growth.
Not covered: a move far away once the distance is grown (a fast travel, a teleport) loads the whole view at once; a
player who stays inside never grows it (the first exterior starts from 8192). Not validated in a browser yet: the
release's Lua API was read in its sources (`camerabindings.cpp`, `vfsbindings.cpp`, `mwmp/luabindings.cpp`) and its
binary's strings, not run.

### GOTY completion check, 2026-10-18

`make test` passed: 1,076 passed, zero failed, three skipped and two pre-existing TODOs.
The new world-travel regression exercises the adapted page function with a root WebSocket
URL received from the engine, an already scoped URL, another host/port and both ws/wss.
The fixes are deployed on the public HTTPS origin. A subsequent storage regression check
also passed (all seven OpenMW tests): native-style token writes, HTML cleanup, legacy local
storage cleanup and installation isolation use the same key.

The original GOTY profile was checked with two separate account sessions in isolated Chromium
contexts. Both came through the real password sign-in and character selector. New-game loading
reached the prison ship; QA hooks were used to advance creation for the subsequent network
checks, so this is not a full manual playthrough of the opening. Both characters were restored
on fresh sign-in, became friends, and the guest joined the host's Party world through the
engine's real `JoinFriend` event. Each client saw the other's player and 70 simulated actors.
Real W-key input moved the host 236 units and the guest 143 units; the guest's position differed
from its representation on the host by 6.6 units. A journal entry advanced through the engine
from stage 10 to 20 and reached both clients. Both characters subsequently reconnected and
recovered stage 20. This tests propagation and individual persistence, not the quest’s dialogue
or simultaneous recovery after both clients disconnect.

The native engine wrote its resume token under the installation-specific key in the actual
browser. The pinned Lua client skips direct resume when a character id is explicit; reloads
can therefore recover through a fresh ticket and another load. That recovery restored the
same character and stage 20. Direct resume is not claimed. QA reloads replayed the parked
fragment explicitly because the upstream automatic fragment gate ignores nonempty QA queries.

These are software-rendering checks, not a client GPU benchmark: 640x480 initially, low tier,
shadows/post-processing disabled, 4,096-unit view distance, and a smaller viewport for reconnect
checks. The original browser settings remain available to players. The normal browser loading
path and three GOTY masters/archives were exercised, without editing game files.

Those original-only checks did not exercise the full visual stack; the later modded party
checks are recorded above. Full combat, long sessions, campaign completion and solo save/load
remain to be checked. Small screenshots, state receipts and the original test log remain under
`build/proof/openmw-goty-20261018/`; disposable installer copies, browser profiles and test
accounts are removed.

## Orthros accounts, cloud saves and language selection (2026-10-18)

The multiplayer button requires an Orthros account and offers registration or login in place.
An existing Orthros session enters directly; no separate game password or email is requested.
`POST /api/openmw/<manifest>/launch` provisions an unprivileged native player, completes its
profile, and returns a single-use ticket and locker session. The launch fragment hands them
straight to the pinned launcher. Native login identifiers derive from the immutable Orthros
user id, never from a claim to an existing native username. A shared nickname cannot take over
an older account. Unsupported public password/OIDC entry points are blocked. Locker tokens
are hashed in the accounts database and bound to the Orthros user and installation; cookie
sessions also gate game APIs and new WebSocket connections. Existing connected sockets are
not forcibly disconnected by logout; new requests and reconnects require a valid session.

The host reads `<accountsDir>/openmw.json` (0600, owned by the host service) with a durable
random `secret` and `operators: { "<manifest>": { "name": "...", "password": "..." } }`.
Operator credentials stay server-side; the Orthros password is never forwarded to OpenMW.
The installed configuration covers the original English and French profiles. Preserve this
file together with `accounts.sqlite` and native `build/openmw/<manifest>/` state in backups:
replacing its secret makes the derived native passwords unusable. Original manually prepared
native accounts are independent; they are not automatically adopted by nickname.

Signed-in engine pages use an account-specific IDBFS database and session-storage namespace.
The browser sync wrapper restores `/userdata` from the Orthros account before allowing boot,
and uploads changes after successful IDBFS flushes through the existing versioned cloud API
(20 versions, 64 MiB compressed per copy, 512 MiB per user). Game files, transient logs and screenshots are excluded. Account
scope headers prevent an old tab from uploading into a newly selected account. Optimistic
parent hashes protect other devices; conflicts suspend uploads and retain the local copy.
Failed initial cloud reads or conflicting unsent local data block boot rather than silently
starting from the wrong state. The header reports sync status and warns before closing with
unsent changes. Anonymous solo continues using its prior browser-only save database; those
older anonymous saves are not automatically imported into a signed-in account. Native
multiplayer characters and host worlds persist in the native state directory under the linked
identity, independently of the browser's settings backup. Deleting an Orthros account removes
its cloud copies and token bindings; native state still requires operator cleanup, and cannot
be claimed by re-registering the same Orthros username.

The home cloud window lists OpenMW copies and downloadable history. It opens the port for
automatic restoration instead of writing an OpenMW archive into the Win32 runtime's OPFS tree.

The French payload was recovered from the same user-supplied ISO (`elamigos-french.bin`) by
running its installer with `/LANG=french` in a disposable network-isolated filesystem. Only
files differing from the English base were imported into `versions/goty-fr`: 6,465 files,
844,559,725 bytes. Original base files remain untouched; hashes and provenance are recorded in
`data_installers/openmw/import-fr-receipt.json`. The French original profile is
`morrowind-goty-fr`, port 28102, service `orthros-openmw@morrowind-goty-fr`. It is hidden as a
separate home version and reachable through the original profile's language selector.
`openmw.languageVersions` maps language codes to installation ids from the same game. The
server only advertises installed matching localizations, and supplies `languageLaunchUrls`
to the home and port launchers. The French simulator uses the manifest initial cell `-2,-9` rather than the upstream English
city name: the original localized masters do not contain that English cell name. New native
configs seed `[simPeer].startCell` from `openmw.startCell`.
Different localized masters use separate simulations and save
histories; friends must select the same language. The complete graphical pair is now available
as `morrowind-goty-vanilla-plus-en` / `morrowind-goty-vanilla-plus-fr`, with the same language
routing and account isolation.

Validation includes the account gate, separate identities, token ownership, logout, account
switches, distinct caches, language routing, binary cloud round trips and conflict preservation.
A real Chromium run signed into the native English gateway, uploaded actual engine user files,
and restored a binary marker into a second context with empty browser storage. French launch
and native simulation checks are recorded with the accompanying browser proof. This does not
extend the earlier English two-client gameplay proof into a full French campaign validation.

The final French Chromium check reached `Joined` with `simReady=1`, loaded
`Navire-prison impérial`, and rendered the opening with the native simulator starting from
`-2,-9` in about two seconds. The check used the pinned engine's low-render-cost flags and
skipped the opening video. It verifies the French launch and server handshake. The subsequent two-client check below
extends coverage to a shared French party; full manual character creation remains unverified. The general
suite passed (`make test`: 1,084 passed, zero failures, three TODOs); focused account, cloud
and localization checks passed after the final changes.

The final HTTPS public check registered two independent Orthros accounts, completed character
creation through the pinned QA hooks, moved both clients outside and used friend request/accept
and Party travel. The native gateway reported both human usernames in the same party world.
Both engine mirrors reported `Joined`, `simReady=1`, the same exterior cell, and a puppet for the
other player; their NPC mirrors contained 42 and 61 simulated actors respectively. Each native
account still owned one persistent character after both browsers exited. The first diagnostic
wait incorrectly treated the puppet map as an array; corrected object-map assertions were
run against the captured client states and matched the live gateway roster. This is a party
handshake/travel and persistence check, with QA character creation, not a full campaign proof.
All temporary Orthros/native accounts and worlds were removed; both gateways returned to zero
active worlds. Evidence is retained in `build/proof/openmw-accounts-fr-20261018/`.
