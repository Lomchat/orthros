# OpenMW browser ports

The current reference: what the OpenMW ports are, the files involved, how the engine is built and switched, the games
and their mods, the multiplayer gateway and how to check it all. Dated detail is in the journal,
[docs/openmw-history.md](openmw-history.md): every engine release r1..r24 with its measurements, every mod batch, every
validation, kept verbatim. When this page and the journal disagree, this page wins (the journal keeps decisions later
reversed, for example "Quest Markers Plus is not installed" or the r20 renumberings).

## What they are

- A **browser port** (DECISIONS D069; OpenMW authorized by the owner on 2026-10-15, D082): a game's original files run on
  a pinned third-party engine compiled to WebAssembly, in its own page, without the Win32 emulator. A version whose
  `runtime` is `"openmw"` has an `openmw` object in its manifest (`docs/game-manifest.schema.json`) instead of `exe`.
- The engine is **OpenMW-Web v1.5.3** (`github.com/Virtastic/openmw-web`, engine `098857c7cdb0`), pinned by
  `tools/openmw/lock.json` (bundle, source, native server image, build toolchain). Orthros builds its own releases from
  that source with its own patches (`openmw-web-v1.5.3-orthros-rN`). No third-party source is committed here: it lives
  in `data/engines/` (releases) and `data/engines/src/` (pinned sources).
- Confinement: the engine and its glue live in `src/ports/openmw/` (the pages) and `src/server/ports/openmw*.js`
  (server side). The Win32 runtime never imports them and they never import it. Game data, accounts, saves, the
  page's frame and input go through the shared modules (CLAUDE.md "Standardization").
- Multiplayer runs on the upstream **native gateway** (a Docker image: account server, world servers, a native OpenMW
  simulation peer per world) behind the Orthros origin's HTTP/WebSocket bridge. It is experimental (see
  "Multiplayer status").
- The game files are never modified. Mods are separate data roots in the version folder; Orthros' own changes to a
  mod's file are overlays in roots of their own (see "Data overlays").

## Files

| Path | Role |
| --- | --- |
| `src/ports/openmw/play.html`, `play.js`, `style.css` | The port's page `/ports/openmw/<manifest>/`: the Orthros frame (`docs/game-frame.md`), language, solo or with friends, the engine page in a frame |
| `src/ports/openmw/streamfs.js` | The engine page's StreamFS mapped onto the shared game data (`src/vfs/`); announced reads, boot reads, anticipated places, light content, JSPI waits |
| `src/ports/openmw/boot-reads.js`, `save-place.js`, `place-lead.js` | Boot reads announced; where a save will load (read without the engine); in-play guesses of the next place (off unless `?lead=1`) |
| `src/ports/openmw/view-grow.js`, `view.lua` | Solo only: boot at a short view distance on a slow link, grow it in the background |
| `src/ports/openmw/tier.js` | Quality tier from the GPU class (`src/web/gpu-class.js`): view distance, fog, refraction |
| `src/ports/openmw/input-keys.js` | A saved key layout moved once to Orthros' defaults |
| `src/ports/openmw/cloud.js`, `account-bridge.js` | Saves on the Orthros account; native accounts derived from the Orthros user |
| `src/ports/openmw/frame-meter.js`, `ui-l10n.js`, `legacy-copies.js` | Frame rate and pointer lock for the header; page strings; copies kept by earlier pages taken into the store |
| `src/ports/openmw/wasm-code-cache.js`, `wasm-compile-worker.js` | The engine's wasm compiled in a worker (Chrome's code cache off the page's thread) |
| `src/server/ports/openmw.js` | Manifest checks (`openmwProblem`, `openmwInstalled`), the engine page's rewrites (`with*`), settings defaults, the gateway's image and lists, the HTTP/WebSocket proxy (`openmwProxy`) |
| `src/server/ports/openmw-lean.js`, `openmw-lean-worker.js` | The engine's data package without what a game of its own never reads |
| `tools/openmw/lock.json` | Upstream pins, the gateway image build, the toolchain, and `builds[]`: each release's patch list, exports and engine file hashes |
| `tools/openmw/patches/orthros-rN.patch` | One patch per release, applied in order r1..rN on the pinned source (OSG's sources too from r7) |
| `tools/openmw/build.sh` | Builds a release from the lock (Docker, no network for compiling) |
| `tools/openmw/dev-build.sh`, `dev-serve.sh` | Incremental development builds on a kept tree; a scratch server running one |
| `tools/openmw/install-engine.py` | Installs the pinned upstream release and source (`--server`: pulls the native image and builds the gateway image) |
| `tools/openmw/build-server-image.sh`, `server-node.Dockerfile` | The gateway image: the upstream image with its Node.js replaced |
| `tools/openmw/install-game.mjs`, `install-mod.mjs` | Imports a purchased `Data Files` folder; installs selected data roots of an extracted mod |
| `tools/openmw/manifest.json`, `manifest-vanilla-plus.json` | Manifest templates used by `install-game.mjs` |
| `tools/openmw/guard-client-ui.mjs` | Generates a compatibility root that keeps UI-only (or solo-only) entry points off the simulation peer |
| `tools/openmw/player-defaults.mjs` | Generates a root giving the player's Lua settings once (and `--withdraw`) |
| `tools/openmw/overlay-check.mjs` | Checks every overlay against what it replaces, at each engine release change |
| `tools/openmw/server.mjs`, `orthros-openmw@.service` | One gateway (Docker) per manifest; its systemd unit |
| `tools/openmw/create-account.mjs` | Local diagnostics: a password player through the operator API |
| `tools/openmw/check.mjs`, `perf.mjs`, `keys-check.mjs`, `frame-compare.mjs`, `place-load.mjs`, `dtprobe.mjs` | Browser checks and measurements (see "Checking") |
| `tools/openmw/frame-attr.py`, `read-trace.py`, `gles-rewrite-check.py`, `cloud-bench.mjs` | Profile attribution by cause, read traces, the r2 GLES rewrite's equivalence check, the cloud bridge's bench |
| `tests/openmw*.test.js` | Unit tests (manifests and server, settings, lean package, builds, streamfs, keys, overlays, guards, defaults...) |

## Games and versions

Two games on the home (D103), each with an English version and a hidden French one reached through the card's
language flag (`openmw.languageVersions`; the server advertises only installed localizations and gives the launchers
`languageLaunchUrls`):

| Game folder | Card | Versions (`id`, folder, gateway port) |
| --- | --- | --- |
| `data/games/morrowind` | "The Elder Scrolls III: Morrowind", tagged Recompiled | `morrowind-goty-en` (`goty-en`, 28101), `morrowind-goty-fr` (`goty-fr`, hidden, 28102) |
| `data/games/morrowind-vanilla-plus` | "… — Orthros Edition" (`modified`, tagged Modified) | `morrowind-goty-vanilla-plus-en` (`goty-vanilla-plus-en`, 28100), `morrowind-goty-vanilla-plus-fr` (`goty-vanilla-plus-fr`, hidden, 28103) |

- `morrowind/base/` holds the English GOTY `Data Files` (7,372 files, recovered from the owner's ISO);
  `versions/goty-fr/` the French files that differ (6,465 files). Receipts and installers are in
  `data/installers/openmw/`. The original versions declare no mods.
- The Orthros Edition (named "Vanilla+" in older text; its ids and folders kept) has an empty `base/`. Each of its
  versions `requires` the original version of its language, whose files lie beneath its own (`gameLayers`: the page's
  tree and the gateway's linked tree alike), and holds only its mods (the French one also hardlinked localized files).
  `formerGame: "morrowind"` keeps its browser saves' key (`orthros-port:morrowind:<dir>`).
- Languages are separate worlds: separate masters, saves and native simulations; friends pick the same language. The
  French simulation starts from the coordinate cell `-2,-9` (`openmw.startCell`): the French masters lack the English
  cell name.
- A fresh installation: `python3 tools/openmw/install-engine.py --server`, then `node tools/openmw/install-game.mjs
  --data-files '<Morrowind>/Data Files'` (copies into an empty `morrowind/base/`, never overwrites; also prepares the
  modded game from `manifest-vanilla-plus.json`). Node 24+. Do not import a translated installation under an English
  version id.

## Engine releases

**In use (manifests, 2026-11-09):** the original Morrowind on `openmw-web-v1.5.3-orthros-r23`, the Orthros Edition on
`openmw-web-v1.5.3-orthros-r24` (the `engine` of each version's `openmw` object). Every release r1..r24 is installed
in `data/engines/` beside the upstream `openmw-web-v1.5.3`.

**Build and pin.** A release is an entry of `lock.json` `builds[]`: its id, its patch list (r1..rN, in order), its
exports and its engine files' hashes. `sh tools/openmw/build.sh <build id>` fetches the pinned dependencies once into
`data/engines/src/`, compiles in the pinned Emscripten image without network (one compile at a time for the project,
memory checked: CLAUDE.md "Memory budget"), and installs `data/engines/<id>/` laid out as the upstream release
(`index.html`, `e/<hash>/openmw.{js,wasm,data}` and their brotli siblings, `streamfs.js`, the upstream assets). A build
whose files differ from the lock's `files` is refused (an empty `files` prints them, to be pinned); an installed release
is never overwritten.

**Develop.** `sh tools/openmw/build.sh <dev id> --keep --dest <scratch>` once (a lock entry not committed), then
`sh tools/openmw/dev-build.sh <kept root> <base release> <release dir> [--check] --patch <file>...` (minutes instead of
a whole build; it writes the built files' hashes into the release), then `sh tools/openmw/dev-serve.sh <release dir>
<port>`: a scratch server whose OpenMW pages run that release under the live manifests' engine names. Most engine
changes sit behind a switch `OPENMW_ORTHROS_<NAME>`, set from the page's address (`?omwenv=NAME=0[,NAME2=0]`: `0` gives
the previous code path), so one build gives every A/B. A release that ships is always built by `build.sh`.

**Switch** (after the release is built and pinned, its code merged into `main`, and the live server restarted):
1. `node tools/openmw/overlay-check.mjs data/games/<game>/manifest.json --engine <new release id>` for each OpenMW
   game; a mismatch means regenerating or withdrawing an overlay first (see "Data overlays").
2. `tools/backup.sh snapshot -m "<why>"`, then set `"engine"` in the `openmw` object of each version of
   `data/games/morrowind/manifest.json` and `data/games/morrowind-vanilla-plus/manifest.json`.
3. `tools/with-browser-slot.sh node tools/openmw/check.mjs <manifest> --url https://orthros.chalco.website` for each
   card, with and without `--lang fr`. Back to the previous release the same way.

What each release brought (the journal's sections give the measurements):

| Release | Change |
| --- | --- |
| r1 | First build by Orthros from the pinned source; in-place texture upgrade |
| r2 | No local-map readback; GLES shader rewriting without `std::regex`; a sound's first play never waits for the network |
| r3 | Cooperative WorkQueue (preloads in slices between frames, 4 ms a frame); exterior grid preloaded; no global-map readback while playing |
| r4 | Global map fixes (a save's map of another size, the CPU copy's layout) |
| r5-r8 | Preloads put off what waits for the network; FBO status asked once; only the focus ray takes the cached-only chunk path |
| r9 | Space jumps, E activates; LuaJIT's math functions in PUC Lua 5.4; OpenAL's per-frame cost |
| r10 | Announced reads: the engine names a place's files, the data system fetches them in parallel |
| r11-r12 | Draw and cull bookkeeping (uniforms, GL glue, light lists, buffers, atomic ref counts...); terrain chunks wait for their LAND and textures |
| r13 | The masters read light before the menu (LAND and cell references deferred to the cells that need them) |
| r14 | Lua's update on its own thread (off in multiplayer); LuaUi updates diffed |
| r15 | Hitches by cause: actor preload, programs precompiled under the loading screen, Lua GC in short steps, post-processing programs kept |
| r16 | Lua chunks compiled once per path, textures uploaded ahead, NIFs read whole and parsed on a thread |
| r17 | Preloads patient for their files on slow links; LuaUi layout passes skipped when nothing changed |
| r18 | Multiplayer: a remote player's copy no longer thrown far off after a jump (`interp.lua`) |
| r19 | F12 screenshots on WebGL2; the draw thread (`OPENMW_ORTHROS_DRAWTHREAD`), off by default |
| r20 | JSPI: the engine's waits for data yield to the browser; frames of play plain, loads promising |
| r21 | Exact OSG fast paths; creatures' gear in the cell preload |
| r22 | Lua sandboxes built once, paging chunks' references read once, programs learned in play made at the next boot |
| r23 | Toggle POV on V (Tab free); longer tier view distances |
| r24 | Mods' Lua storage written by the page's flush (settings and first-run screens kept); Run (held) without a default, Always Run on Left Alt |

## The engine's data and page

The server serves the engine page `/ports/openmw/<manifest>/app/` rewritten for Orthros (`openmwWebText` and the
`with*` functions of `src/server/ports/openmw.js`); paths and world sockets get the installation's prefix, guest paths
stay intact, the operator dashboard is not exposed. What the rewrites add:
- **Engine files by content** (`withSharedEngine`, `withEngineUrls`): one immutable browser copy for every
  installation; a release that changes only the wasm costs a returning player the wasm alone. Brotli siblings are sent
  without `Content-Length` (`sendBrotli`, sizes in `X-Orthros-*-Length` headers).
- **The lean package** (`withLeanPackage`, `openmw-lean.js`): `openmw.data` with the unread bytes zeroed (the free
  example world, ICU's second copy, ICU feature trees the engine never opens), same size and offsets, brotli 11 by a
  niced child; served as `/engines/_c/<sha256 of openmw.data>/lean3/openmw.data`, made at the server's start (about
  4.1 MB on the wire instead of 33 MB). Until it is made, the newest lean package on disk, else the release's own.
- **Game data** (`withStreaming`, `streamfs.js`): the engine's mounts mapped onto the version's tree (`mwdata/<file>`,
  `mwdata/mods/<part>/<file>`, `moddata/<file>` → `_engine/<file>`, the release's asset pack as a `dataMounts` entry),
  read through the shared data worker (compressed ranges, learned order, OPFS store `orthros-files-<manifest>`, light
  copies on slow links). With the engine's patches: announced reads (r10), boot reads announced, the masters light
  before the menu (r13), anticipated places (the place a save will load fetched while the player sits in the menu;
  `POST`/`GET /api/places/<manifest>`; not in multiplayer), and JSPI waits (r20). `?sfs=upstream` keeps the release's
  own streaming. Details: docs/slow-network.md and the journal.
- **Quality tier** (`withQualityTier`, `tier.js`): software GPU → `low`, integrated → `mid`, discrete → `high`; a minute
  with a frame p99 over 50 ms starts the next session a tier lower. View distance `low` 8192 (the page's), `mid` 20480,
  `high` 24576, land fog following it; water refraction on `high` only. `?tier=` and the player's Options win.
- **View growth** (`withProgressiveView`, solo only): on a link not fast last time the engine boots at 8192 units and
  `view.lua` (in `orthros.omwscripts`, added to every single-player `openmw.cfg`) grows it in steps of 2048 while the
  data is quiet and frames are short. Never in multiplayer (a world refuses an extra content file).
- **Keys** (`withInputKeys`, `input-keys.js`): Activate on E, Jump on Space (r9), Toggle POV on V (r23), Run (held)
  without a default and Always Run on Left Alt (r24); a saved layout holding the old defaults is moved once, any other
  layout is the player's.
- **Settings defaults** (`withSettingsDefaults`): `[General] preferred locales` from the version's languages (`fr,en`
  or `en`), `[GUI] color topic enable = true`, then the version's `openmw.settings`, appended to `/settings.cfg`
  (additional defaults: the player's own `settings.cfg` wins).
- **Other**: the frame meter (`withFrameMeter`), the wasm compiled in a worker (`withWasmStream`), both gateway lists
  fetched together (`withModsListEarly`). On a link not fast last time the play page adds `&novid` (intro videos
  skipped; `?video=1` plays them).

**Accounts and saves.** Solo saves live in the engine's IDBFS, per installation and per account, and are synced to the
Orthros account by `cloud.js` (the cloud API's versioned copies; conflicts keep the local copy and block uploads; a
failed first read blocks the boot). The multiplayer button needs an Orthros account: `POST
/api/openmw/<manifest>/launch` provisions an unprivileged native player derived from the immutable Orthros user id and
returns a single-use ticket. The host reads `<accountsDir>/openmw.json` (0600: a durable `secret` and the operators'
credentials per manifest); replacing its secret makes the derived native passwords unusable, so it is backed up with
`accounts.sqlite` and the native state. Native characters and worlds persist under `/var/lib/orthros-openmw/<manifest>/`.

## Mods

**Declared in the manifest.** A version's `openmw.mods` is its load order. Each entry has an `id`, its provenance
(`url`, `sha256`, version, licence, `purpose`), `installed`, and `parts`: each a data root `mods/<id>-<n>` of the version
folder with a `sentinel` file, its enabled `plugins` and `archives`, `files` and `bytes`. The gateway gives the browser
and the native peer the same stack (OpenMW-Web's `modlist.json` format), so every peer loads the same plugin bytes.

**Installing one.** Extract the author's archive into task scratch, read its instructions, then
`node tools/openmw/install-mod.mjs <game folder> <version id> <mod id> <extracted folder> --part '<root>' ...
[--plugin 'Name.esp'] [--sha256 <archive sha256>]`. It never parses game formats, refuses a second installation and
empty game assets, and checks a sentinel (an asset, a plugin, or for a script-only root a `.lua`, `.omwfx` or `.yaml`)
before marking the mod installed. Never install MCP, MWSE or MGE XE. A root never holds two names one case apart (the
gateway folds them: one hides the other). Archives and receipts go to `data/installers/` (for example
`data/installers/openmw/`, `data/installers/morrowind-mods-2026-11-08/`); the 2026-11-08 batches are replayed by the
scripts in `data/proof/openmw-mods-2026-11-08/`.

**Live only after the gateway restarts.** The page loads its mod list and file sizes (`mwdata-mods.json`,
`mwdata-manifest.json`) from the version's gateway, which builds them at its start. After any change to a version's
mods: `systemctl restart orthros-openmw@<manifest>`. A staged check needs its own gateway (see "The gateway").

**The simulation peer.** Scripts that draw interface crash a native peer before `simReady`. `guard-client-ui.mjs`
generates a final compatibility root whose wrappers return no handlers on the peer (`openmw.mp.isSystem()`) and run the
author's module on browser clients:
- `<mod>`: a UI-only addon, every entry point guarded;
- `<mod>:MENU,PLAYER`: only the declarations whose targets are all of those types; gameplay ones (`GLOBAL`,
  `CONTAINER`, actors, items) stay as shipped and run on the peer;
- `<mod>:SOLO`: a mod that drives the world from one player's side (Lua Physics, CHIM Climbing): every entry point off in
  a shared world (`openmw.mp.isEnabled()`), solo unchanged;
- `--id <compat-id>`: a further root for mods installed later (`client-ui-compat`, `qol-client-ui-compat`,
  `inventory-ui-compat`, `combat-ui-compat`, `nexus-ui-compat`, `mods2-compat`, `mods3-compat`, `mods4-compat`,
  `hud-compat` today). Never regenerate a released root: its wrappers are numbered and the mods' saved data is stored
  under their paths. Never use it to disable gameplay or quest scripts on the peer.

### Data overlays

Orthros' fixes to a mod's file (or to one of the engine's built-in scripts) are overlay roots loaded after the
original, the author's files untouched: `orthros-overlay-all*` (both languages), `orthros-overlay-fr*` (French only),
`orthros-overlay-<name>` (one concern). Each declares `overlays: [{ of, file, originalSha256, sha256, change }]`
(`of: "openmw built-in"` for an engine script). Typical reasons: WebGL2/GLSL ES or Lua 5.4 incompatibilities, behaviour
in a shared world (no time-scale change, no saved light objects), per-frame Lua cost (behaviour-identical rewrites),
defaults the owner wanted. **At every engine release change**, `overlay-check.mjs --engine <new release>` must pass
(an engine script overlay would otherwise silently bring back an older copy).

### French texts

The French version adds `orthros-l10n-fr*` and `orthros-fr-*` roots: `fr.yaml` for every mod with texts, in the French
masters' terms, without « » (the game font lacks them), and overlays routing hard-coded English through the mods' l10n
contexts. A mod's `.omwaddon` built against the English masters gets a French rebuild where needed (NCGDMW). The page's
`preferred locales` make OpenMW's own menus and the Lua mods French.

### Recommended settings and player defaults

- **A version's settings** (`openmw.settings`: `{ section: { key: value } }`, names of OpenMW's `settings-default.cfg`):
  written into the engine page's additional defaults and, by `server.mjs`, into `<state>/sim-settings.cfg` mounted as the
  native peers' global settings (`OPENMW_SIM_SETTINGS`), so AI and combat rules are the same on the peer. An unknown key
  is ignored silently and an out-of-range value stops the engine: `tests/openmw-settings.test.js` checks every installed
  manifest against the engine source's `settings-default.cfg`. The Orthros Edition sets subtitles, map zooming, best
  attack, `show owned = 3`, effect/enchant/melee/projectile info, smooth movement and animations, turn to movement
  direction, swim upward correction, followers attack on sight, NPCs avoid collisions, trainers by base skill,
  rebalanced soul gems, `strength influences hand to hand = 2` (not 1: werewolf claws), weapon and shield sheathing,
  additional animation sources. `uncapped damage fatigue` stays off (a stun-lock). The original cards keep the engine's
  rules.
- **The player's Lua settings** (Options → Scripts; kept in `player_storage.bin`, out of `settings.cfg`'s reach):
  `node tools/openmw/player-defaults.mjs <game folder> <version id> <defaults.json> [--id <mod id>]` generates a root
  whose PLAYER script, on browser clients only, gives each value once per player profile and only over the registered
  default, then records it; a player's later choice is never overwritten. Entries may be key bindings (given only while
  unset and the key free). `--withdraw` gives the author's default back once where Orthros had given a value. Never
  remove such a root (its records name its entries). Roots today: `orthros-player-defaults` (always run, toggle sneak,
  over-the-shoulder camera...), `-perf` (withdrawn entries), `-ui`, `-mods2`, `-mods3`, `-hud`, and the input roots
  `qol-client-ui-compat` (Take All on R, RUN! binding) and `orthros-sprint-on-shift` (RUN!'s sprint moved once from
  Left Alt to Left Shift).

### Removing a mod

Saves list the plugins they were made with, and loading one whose plugin is gone asks a question the page does not show
(the game stops at the menu). A mod taken out of a version therefore leaves an empty plugin of each of its names
(`orthros-removed-stubs`: Inventory Extender Redone and Inventory Camera, removed 2026-11-08). Its guard wrappers stay
in their compatibility root; restart the gateway afterwards.

### The stack today

The Orthros Edition (EN 85 entries, FR 94, including Orthros' own roots) holds, by kind (the manifest gives the load order): visual fixes and
textures (Patch for Purists — EN only —, Morrowind Optimization Patch, Improved Lights, Dynamic Ambient Visual Effects,
Glow in the Dahrk, Graphic Herbalism, Morrowind Enhanced Textures 4.1, Skies .IV, Project Atlas, Containers Animated,
creature and body replacers, Weapon Sheathing and its additions, Familiar Faces, Better Bodies, New Beast Bodies),
interface (UI Modes, Questman, Advanced World Map and its Tracking, QuickSelect, Take All, Smart Ammo, RUN!, UI Toolkit,
Quest Markers Plus with proximityTool and HUDMarkers, Show Me Everything, Modernized HUD), gameplay (Alchemy Redone,
NCGDMW, Solthas Combat Pack — three modules, every cost 0 —, Max Yari's Script Services, State-Based Magicka Regen,
Impact Effects, Combat Sounds Overhaul, The Combat Juice, Sneak!, Surefire, Lua NPC Schedule, ReAnimation, Lua Physics,
CHIM Climbing, OpenMW Dynamic Actors, Orthros' health regeneration out of combat), dialogue (Greetings for No Lore and
Persuasion Response Expansion; in French, Django's dialogues and the Confrérie's translations). The manifest is the
authority: each entry says its source, version, hash and purpose.

## The gateway

- **Unit**: `orthros-openmw@<manifest>` (`tools/openmw/orthros-openmw@.service`, `Restart=always`), one per version;
  the four are enabled and running. It runs `node tools/openmw/server.mjs <manifest>`; `/etc/orthros-openmw.env` sets
  `ORTHROS_ORIGIN`. Install: `install -m 644 tools/openmw/orthros-openmw@.service /etc/systemd/system/`, `systemctl
  daemon-reload`, `systemctl enable --now orthros-openmw@<manifest>`.
- **What `server.mjs` does**: refuses an incomplete manifest; builds a linked read-only game tree and mod list under
  `/var/lib/orthros-openmw/<manifest>/gamedata` (`OPENMW_STATE_DIR`); writes `sim-settings.cfg`; runs the gateway
  container (`--cpus=2 --memory=4g --pids-limit=256`, published on `127.0.0.1:<port>` only, game data mounted
  read-only); then builds the gateway's two lists at once (`warmGatewayLists`: one `openmw.lists_warm` line in the
  journal) so the first player does not pay for them. Worlds start on demand and idle out.
- **State**: accounts, worlds and saves under `/var/lib/orthros-openmw/<manifest>/` (in the nightly restic snapshot;
  never delete it when updating the engine).
- **Image**: the pinned upstream image (`lock.json` `serverImage`) with its Node.js replaced by the pinned nodejs.org
  release (`serverBuild`, `server-node.Dockerfile`), built reproducibly without network by
  `sh tools/openmw/build-server-image.sh` (also run by `install-engine.py --server`) and compared with the lock's
  `image`. `server.mjs` runs it by its ID and refuses to start if it is not built. Deploy: build the image, restart the
  units one at a time, check `docker exec orthros-openmw-<manifest> node --version` and `curl 127.0.0.1:<port>/healthz`.
- **Restart it after a mod change** (its lists are built at its start) and after an image change.
- **Scratch gateway** (staged mods, a test beside the live one): `node tools/openmw/server.mjs <manifest> --games-dir
  <staging> --state-dir <scratch> --port <n>`, the staged manifest's `multiplayer.port` set to `<n>`. Two versions
  cannot share a port.
- **Operators**: no self-service password registration upstream. `node tools/openmw/create-account.mjs <manifest>
  <user> --password-stdin` creates a player for diagnostics (the operator credential is generated in the state dir,
  0600). The public proxy never forwards operator API requests; normal players use their Orthros account.

## Multiplayer status

Experimental. The play page offers "with friends" (an Orthros account, then Party worlds and friends from the engine's
own interface). Checked: two real clients in the same Party, English and French, original and modded (2026-10-18,
2026-10-21), reciprocal player copies and simulated actors, journal propagation and character persistence; since r18 a
remote player's copy follows jumps and teleports. Not validated: a full campaign, long sessions, full combat, solo
save/load across everything, GPU performance on a player's machine.

Known limits: the upstream container watcher stops after 15 s (an item moved later in a container left open can be
lost); friends must choose the same language; solo-only mods (`:SOLO`) and The Combat Juice's slow motion are off in a
shared world; the page's own helpers stay out of multiplayer (no `orthros.omwscripts`, no view growth, no place
prefetch; r14's Lua thread is off). The engine's multiplayer onboarding stays in English (the upstream portal's).

## Checking

All browser tools go through `tools/with-browser-slot.sh` (CLAUDE.md "Shared server budget").
- `tools/with-browser-slot.sh node tools/openmw/check.mjs <manifest> [--url <origin>] [--seconds N] [--lang fr]`: solo
  smoke check from the home card (the engine draws, the header shows the frame rate and the mouse). Not a gameplay or
  multiplayer validation.
- `tools/openmw/perf.mjs <manifest> --url <origin> [--seconds 60] [--query tier=mid] [--discard] [--run | --glide
  dx,dy[,speed[,z]]] [--profile] [--glcalls] [--console]`: in-world frame measurement (frame gaps, the engine's work per
  frame, synchronous WebGL calls, data stalls). `--discard` makes SwiftShader rasterize nothing (the CPU's share). On
  this GPU-less server SwiftShader paces the frames; compare same-flag runs, alternated, and say what a real GPU would
  change. `frame-attr.py` attributes a profile's time by cause.
- `keys-check.mjs` (the key layout in the engine), `frame-compare.mjs` (pictures between variants), `place-load.mjs
  --mode coe|save|glide|door` (loads through a throttled link), `dtprobe.mjs` (draw thread),
  `overlay-check.mjs` (overlays against a release).
- Unit tests: `node --test tests/openmw*.test.js` (part of `make test`).

## Where the details are (docs/openmw-history.md)

- Installation and mods: sections «Current installation», «Interface addons», «Additional quality-of-life addons»,
  «Inventory, alchemy and dialogue mods; French texts (2026-10-29)», «Recommended settings and player defaults
  (2026-10-29)», «Combat, stealth and magicka mods (2026-10-29)», «The owner's 2026-11-08 mods (Orthros Edition)»,
  «Headless simulation compatibility», «Installation and completion».
- Gateway: «The gateway's image: its Node.js replaced (2026-10-23)», «The boot's idle time: the gateway's lists, the
  link after the engine's package (2026-10-27)».
- Page and data: «Runtime boundary and validation» (loading, the lean package's rules, streaming), «The page
  (2026-10-18)», «View distance: near first, far in the background (2026-10-21)», «Announced reads (2026-10-26)»,
  «Anticipated places (2026-10-26)», «In play: crossings and doors (2026-10-28)», «Serial reads the announces did not
  cover: scripts at the boot, distant chunks in play (2026-10-29)», «Light copies sharpened without hitches
  (2026-10-29)», «Chrome's code cache off the main thread (2026-10-29)», «The engine's language and dialogue topic
  colours (2026-10-28)».
- Engine releases: one section per release, from «Frame time: engine orthros-r2, quality tier, cloud bridge
  (2026-10-21)» to «Rounds 12-14 and engine orthros-r22 (2026-11-01)»; r20 in «Waits that yield to the browser: engine
  orthros-r20 (2026-10-29)» and its validations; r23 in its commit (5974471) and `tier.js`; r24 in «The owner's
  2026-11-08 mods (Orthros Edition)». Development tools: «Development builds: kept tree, switches, pictures compared
  (2026-10-26)», «The steady frame attributed; overlays of the engine's own scripts checked at each release (round 6,
  2026-10-30)».
- Multiplayer and accounts: «r2 checked on the public site (2026-10-21, wave 2)», «Two clients: a remote player's copy
  thrown far off after a jump: engine orthros-r18 (2026-10-31)», «GOTY completion check, 2026-10-18», «Orthros
  accounts, cloud saves and language selection (2026-10-18)».
- Evidence: `data/proof/openmw-*` (measurement results in `data/proof/openmw-results/`, performance rounds in
  `data/proof/openmw-perf/`).
