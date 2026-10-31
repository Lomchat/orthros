# OpenMW browser port

The owner authorized an OpenMW port with faithful visual mods and multiplayer on 2026-10-15.
This extends the third-party engine exception of D069. It does not change the Win32 runtime.
The engine release, source archive and native simulation image are pinned by
`tools/openmw/lock.json` (OpenMW-Web v1.5.3). No third-party source is committed here.

## Current installation

- Browser engine, corresponding source and native simulation image remain pinned to v1.5.3.
  The freely licensed example card (`openmw-example-1.5.3`) was removed by the owner on 2026-10-18 (its manifest in
  `backups/manual/removed-2026-10-18/`).
- On 2026-10-18 the user's two encrypted RAR volumes were successfully extracted. Their
  multilingual ISO installer was run in a disposable, network-isolated filesystem to recover
  the English GOTY data. Only its `Data Files` directory was copied into an empty
  `data/games/morrowind/base/`: 7,372 files, 1,126,510,640 bytes. Installers remain outside
  `data/games`, in `data/installers/openmw/`; an import receipt records the master/archive hashes.
- The original profile `morrowind-goty-en` shares that base, declares no mods, and uses the
  gateway on localhost port 28101 (`orthros-openmw@morrowind-goty-en`, enabled). The full
  `morrowind-goty-vanilla-plus-en` profile keeps its original id and now contains all seven mods.
  Its enabled gateway uses localhost port 28100. Saves/worlds stay separate from the original profiles.
- Two games on the home since 2026-10-21 (D103), as Vice City's recompiled and modified cards:
  `data/games/morrowind` ("The Elder Scrolls III: Morrowind", the original profiles `morrowind-goty-en` / `-fr`, tagged
  "Recompiled") holds the game's files; `data/games/morrowind-vanilla-plus` ("… — Vanilla+", `modified`, tagged
  "Modified") holds only the Vanilla+ profiles' version folders (their mods; the French one its hardlinked
  localized files too) and an empty `base/`. Each Vanilla+ profile `requires` the original profile of its language,
  whose files lie beneath its own (`gameLayers`: the page's tree and the gateway's linked tree alike). Their version ids,
  ports, services, native state and cloud saves are unchanged; `formerGame: "morrowind"` keeps their browser saves'
  key (`orthros-port:morrowind:<dir>`).
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
  Archives, SHA-256 hashes, source selections and receipts are in `data/installers/openmw/`.
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
  reference metadata remain in `data/installers/openmw/`.
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
  small proofs and pinned source receipts remain under `data/proof/openmw-full-mods-20261018/`.
- A complete campaign and GPU performance on the player's machine remain unvalidated.
  Do not activate Atlas/MOP compatibility patches in the original profiles on their own.

The GOTY edition is available from [GOG](https://www.gog.com/en/game/the_elder_scrolls_iii_morrowind_goty_edition)
and [Steam](https://store.steampowered.com/app/22320/). OpenMW is free; the retail game is not
included. Keep installers and downloaded mod archives in `data/installers/openmw/`.

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
kept in `data/proof/openmw-ui-20261018/`; original archives and the pre-install manifest are
kept in `data/installers/openmw/`.

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
`data/installers/openmw/`. The four addons themselves total 404,344 uncompressed bytes.
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
in `data/proof/openmw-qol-20261018/`. Original packaged engine Lua hashes match the native
image; the source archive's `fsroot` copies differ and must not be used as a patch base.

### Inventory, alchemy and dialogue mods; French texts (2026-10-29)

The owner asked for a less dated inventory and dialogue, in English and in French by the language the game is launched
in. Prepared and tested in scratch (solo EN/FR, two-client multiplayer, an old world resumed, performance), then installed
in both Vanilla+ versions by one script (`install-all.sh`; archives with receipts and Orthros' sources in
`data/installers/openmw/vanilla-plus-mods-20261029/`; the manifest before in `backups/manual/`):
- **UI Toolkit** 1.4.8 (EnderWiggin, commit 334f9be), a library; **Inventory Extender Redone** 0.0.8 (8356f48): the
  inventory, container, barter and companion windows replaced (sortable table, categories, search, favourites);
  **Inventory Camera** 3.1 (f86c468): the character framed when the inventory opens; **Alchemy Redone** 2.0.3 (aaafb09).
  Their gameplay scripts (GLOBAL, CONTAINER, item types) run on the native simulation too; their MENU/PLAYER scripts are
  guarded there (`inventory-ui-compat`, `guard-client-ui.mjs mod:MENU,PLAYER --id`). Never regenerate that root after
  release: its wrappers are numbered and the mods' save data is stored under their paths.
- Dialogue content: FR — *Dialogues étoffés de Django* 1.44, *Salutations génériques variées* 2.0, *Expansion des réponses
  de persuasion* 4.0 (la Confrérie des Traducteurs); EN — *Greetings for No Lore* 2.0 and *Persuasion Response Expansion*
  4.0 (cleaned: 72 GMSTs and two records undoing Patch for Purists' fixes removed). Django's English original is on Nexus
  only: not in the EN version.
- Overlays (Orthros data roots loaded after the mods; the authors' files untouched): `orthros-overlay-all` — UI Toolkit
  without `table.maxn` (absent from the engine's Lua 5.4: a window stayed on screen after a container closed), Inventory
  Camera's depth-of-field shader made valid for WebGL2 (it blanked the frame) and off by default (the web engine's
  post-processing depth is empty: everything blurred), Alchemy Redone leaving the time scale alone in multiplayer,
  English keys missing upstream; `orthros-overlay-fr` — the French masters' prison cells for IER, Alchemy's tab label
  (`sMagicEffects`: `sEffects` is the sound-effects volume in French).
- `orthros-l10n-fr` (FR only, last): fr.yaml for every mod with texts (the new ones, UI Modes, Questman, Advanced World
  Map, RUN!, Smart Ammo, QuickSelect, Take All); no « » (the game font lacks them).
- The engine page now sets `[General] preferred locales` from the version's language (`fr,en` / `en`) and
  `[GUI] color topic enable = true` (every OpenMW version) — before, OpenMW's own menus and every Lua mod showed in
  English in the French game (`withSettingsDefaults`, `src/host/openmw.js`).
- Checked in production: the three cards boot (`check.mjs`), the French inventory opens in French, no Lua error.

Open: Take All and IER's use key both default to R in a container (one Lua error a press, nothing lost); Alchemy Redone's
apparatus hint ray makes the engine build every view-distance terrain chunk at the start of play (+4.4 s to the world
measured on localhost; a generic engine fix belongs in `QuadTreeWorld::accept` for intersection visitors); the
multiplayer engine watches a container 15 s only after it opens (an item moved later is lost on reopening — not from
these mods); Advanced World Map's `format` error and QuickSelect's "Layer already exists" predate them.

### Recommended settings and player defaults (2026-10-29)

The owner asked for every OpenMW option recommended for a modern feel, on, in Vanilla+ only: the original Morrowind cards
keep the engine's own rules. They are defaults: a player's own saved choice wins.

**A version's settings** (manifest `openmw.settings`: `{ section: { key: value } }`, OpenMW's `settings-default.cfg`
names; `openmwProblem` accepts only names of letters, digits and spaces, and values that are a boolean, a number or plain
text, so nothing else reaches the settings file or the page's script). Two places read them:
- the engine page: appended after Orthros' own defaults (`withSettingsDefaults`, the version's last: a key of both is the
  version's) to `/settings.cfg`, the engine's additional defaults. The player's `settings.cfg`, written by the Options
  menu (its Best attack and Subtitles switches among them), still wins.
- the native simulation peers of the version's multiplayer gateway: `tools/openmw/server.mjs` writes them to
  `<state>/sim-settings.cfg` at each start and mounts it, read-only, at `/usr/local/etc/openmw/settings.cfg`
  (`OPENMW_SIM_SETTINGS`): the image's global config dir (its `defaults.bin`, no `settings.cfg` of its own), the first of a
  peer's two config dirs. OpenMW reads a `settings.cfg` in every config dir but the last as additional defaults. The last
  is the world's `peer-config/`: the gateway rewrites its `settings.cfg` (frame pacing, shadows and water off…) at every
  world start, and its keys still win. The AI and combat rules computed on the peer (followers, collisions, NPC movement,
  hand-to-hand) are therefore the same as on the players' pages. Checked in the gateway container started by `server.mjs`:
  the peer binary logs `Loading settings file: /usr/local/etc/openmw/settings.cfg` between `defaults.bin` and its
  `peer-config` file, and an out-of-range value there stops it (`Invalid int [Game] show owned setting value`).
  Interface settings are inert on a peer that draws nothing.

An unknown key in additional defaults is silently ignored, and an out-of-range value stops both the browser engine and
the peer. `tests/openmw-settings.test.js` therefore checks every installed manifest's `openmw.settings`: each key must
exist in the engine source's `settings-default.cfg`, with a value of the same type. Vanilla+ (EN and FR) declares
these keys, all verified in production engine r13's `defaults.bin` and in the gateway image's:

| Section | Key | Value | Feel |
| --- | --- | --- | --- |
| GUI | `subtitles` | true | Subtitles for voiced lines |
| Map | `allow zooming` | true | Zoom on the local and world maps |
| Game | `best attack` | true | Always the best attack type (chop, slash, thrust) |
| Game | `show owned` | 3 | Owned objects tinted: tooltip and crosshair |
| Game | `show effect duration` | true | Remaining time of magic effects and lights |
| Game | `show enchant chance` | true | Success chance when self-enchanting |
| Game | `show melee info` | true | Weapon reach and speed |
| Game | `show projectile damage` | true | Arrow and bolt damage bonus |
| Game | `smooth movement` | true | Smoother movement of the player and NPCs |
| Game | `turn to movement direction` | true | Lower body turns with diagonal movement |
| Game | `smooth animation transitions` | true | Blended animation changes |
| Game | `swim upward correction` | true | Swimming slightly upward from the view line |
| Game | `followers attack on sight` | true | Companions join a fight at once (rule) |
| Game | `NPCs avoid collisions` | true | Actors walk around each other (rule) |
| Game | `trainers training skills based on base skill` | true | Trainers offer their real skills (rule) |
| Game | `rebalance soul gem values` | true | Filled soul gems valued by their soul (MCP formula; rule) |
| Game | `strength influences hand to hand` | 2 | Strength scales fists (MCP formula), werewolves excepted (rule) |

`strength influences hand to hand` is 2 rather than 1, because werewolf claws already carry `WerewolfClawMult` and a
werewolf's high Strength would multiply them again. `[Game] uncapped damage fatigue` stays **off**: it removes the cap
on Damage Fatigue, so a cheap spell drives fatigue far below zero and keeps any actor knocked down. That makes it a
stun-lock that breaks combat balance and is not a modern-feel option.

**The player's Lua settings** (Options → Scripts: OMWControls, OMWCamera) live in the player's storage
(`player_storage.bin`, in the player's profile), not in `settings.cfg`. The engine's MENU scripts register them with
their defaults before any game starts. `tools/openmw/player-defaults.mjs <game> <version> <defaults.json>` generates
an Orthros data root (`orthros-player-defaults`) whose PLAYER script, on a browser client only (it returns at once on
a simulation peer, `openmw.mp.isSystem()`), gives each entry once per player profile. It sets the value only when the
current one is still the registered default (or unset), then records the entry in the `OrthrosPlayerDefaults` storage
section. A later choice of the player's, or a value already moved off the default, is never overwritten. Each entry has
its own record, so a later root may add entries. Never remove the root: its records name its entries. The earlier input
defaults (`qol-client-ui-compat`, `OrthrosQoLInputDefaults`) are unchanged. Vanilla+ gives `SettingsOMWControls`
`alwaysRun` and `toggleSneak`, and `SettingsOMWCameraThirdPerson` `viewOverShoulder`, `autoSwitchShoulder`, `move360`,
`slowViewChange` (smooth view change) and `previewIfStandStill`, all `false` by default in the engine's
`scripts/omw/input/settings.lua` and `camera/settings.lua`. The engine writes the player's storage when the Options
window closes, or when it exits. A value set before that and never saved is given again at the next session. Once the
window has closed after a player's choice, that choice is kept.

A second root, `orthros-player-defaults-perf` (`--id`, 2026-10-29), turned off two post-processing passes by default:
RUN!'s `SettingsRUN` `doBlurShader` and The Combat Juice's `SettingsCombatJuiceFlash` `FlashOn` (`Never`). Both entries
were withdrawn with the engine release carrying `fxprograms.patch` (2026-10-30, `player-defaults.mjs --withdraw`; see
"Post-processing chain changes without recompiles"): RUN!'s blur had never compiled on WebGL2 (its "artifacts" were
the whole frame drawn flat by the canvas' fallback program) and compiles from an overlay, and a chain change no longer
recompiles the chain. A profile whose record says the value was given and still holds it gets the
author's default back once (`OrthrosPlayerDefaultsPerfRestored`). The root, generated before records said `given` or
`kept`, recorded `true` in both cases, so a player who had chosen `doBlurShader = false` or `FlashOn = Never` before
the root first ran gets the author's default back once as well; Options → Scripts turns it off again, and that choice
is kept. Roots generated since record `given` or `kept`, and a withdrawal touches only `given`.

Per-frame HUD Lua without redundant work (2026-10-29, the owner: constant 60 fps, nothing he sees changed). Measured
first (`perf.mjs --discard --profile`, Seyda Neen running; scratch A/B dropping content): the five Nexus HUD packs
cost ~4.7 ms of the frame, `Element:update()` re-applying whole widget trees ~1.9 ms of it. Behaviour-identical overlays
(each written, reviewed through two lenses — on-screen identity, Lua 5.4/API — and fixed): props applied and
`:update()` called only when they changed, hidden elements touched only on the visible→hidden transition, constant
settings cached and refreshed by the storage section's `subscribe` (it runs synchronously in `set`/`setAll`):
Quest Markers Plus' `skyrim_compass/compass.lua` and `hud.lua` (`orthros-overlay-fr-nexus`, `orthros-overlay-all-nexus`),
Surefire's `victim.lua` (`orthros-overlay-all-nexus`), Combat Juice's `hitmarkers.lua` (`orthros-overlay-all-pack`;
also updates on a HUD layer resize, which re-centres the root), and a new root `orthros-overlay-all-perf`: HUDMarkers'
`HUDM_p.lua`, the proximityTool main menu as Quest Markers Plus ships it (an identical rebuild skipped), Surefire's
`player.lua`. Measured running (camera always moving, the least favourable case): LuaUi `updateWidget` 2.19 → 1.43
ms/frame, Lua total ~6.3 → ~5.4, work p50 16.0 → 15.1 ms (single runs, ±1 ms noise). No Lua error in the log.

Checked in scratch (2026-10-29): unit tests (`tests/openmw-settings.test.js`, `tests/openmw-player-defaults.test.js`);
the generated script run under Lua 5.4 against a mock storage (registered defaults given, a later choice kept,
a value already moved off its default kept, nothing on a simulation peer); and Vanilla+ EN booted in Chromium through a
scratch gateway and a scratch server. The engine's `/settings.cfg` held the block, and the engine log showed
`[orthros] player defaults given: SettingsOMWControls/alwaysRun, …` with no error. A two-client multiplayer session with
a simulation peer was not run.

In play, solo EN and FR (2026-10-29: Chromium with SwiftShader, the engine page of a scratch catalog through scratch
gateways; the player's Lua console, `luap`, read the engine's own values back):
- `/settings.cfg` ended with the version's block (`preferred locales = fr,en` in FR). Options → Prefs showed Always Use
  Best Attack and Subtitles on. Options → Scripts → OpenMW Controls and OpenMW Camera showed the seven given values as
  Yes (Oui), in French in the FR version.
- Show owned: looking at Arrille's Common Robe (Robe ordinaire) turned the crosshair red and the tooltip box red.
  Show effect duration: the HUD icon of a Fortify Strength potion read `… 10 pts Duration: 20 s` (`Durée : 21 sec`),
  counting down.
- Always run: `self.controls.run` set on every sampled frame with W held, peak speed 288 units/s against a walk speed of
  128. Toggle sneak: one tap of Ctrl kept `self.controls.sneak` on after the key was released. Third person (Tab): the
  focal offset was the shoulder's (30, −10), auto-switched to (−30, −10) beside a wall. It was centred (0, 15) only while
  a weapon (fists) was drawn, as the engine's `third_person.lua` does. Preview when standing still (mode Preview) and
  360° movement were active too.
- A player's later choice: Toggle Sneak set to No in Options, the window closed, the page reloaded with the same
  browser profile. It was still No, and no `player defaults given` line was logged again.

### Combat, stealth and magicka mods (2026-10-29)

The owner asked for these mods in Vanilla+ (EN and FR), together with the settings above. Each is pinned to a commit,
because none of the GitHub repositories has a release or a tag. Its receipt lists every installed file with its SHA-256,
and so does the commit archive. The receipts, archives and Orthros' sources (`install-all.sh`, `check-catalog.mjs`, the
roots below, the declarations) are kept in `data/installers/openmw/vanilla-plus-pack-20261029/`.

| Mod | Version, commit | Installed | Role |
| --- | --- | --- | --- |
| [Max Yari's Script Services](https://github.com/MaxYari/MaxYarisScriptServicesOpenMW) | 2, `a543aad` | the repository minus the author's `.nexusignore` | Library of the two below (`I.MSS`: combat targets, damage listeners, interaction ray) |
| [State-Based Magicka Regen](https://gitlab.com/modding-openmw/state-based-magicka-regen) | 1.3.8, `78eebcc` (MIT) | `00 Core` (the author's `pkg.sh`) | Magicka regenerates over time for every actor (Willpower, Intelligence, fatigue, encumbrance; waiting and resting) |
| [The Combat Juice](https://github.com/MaxYari/TheCombatJuiceOpenMW) | 1.2, `a5a8ae1` | minus `.nexusignore` | Hit markers and sounds, camera shake, impact and enchanted-hit lights, kill slow motion, kill flash |
| [Sneak!](https://github.com/MaxYari/SneakIsGoodNowOpenMW) | 2.0, `78023c4` | minus `.nexusignore` and the unused SVG sources | Gradual detection shown by an eye and markers, leaning, NPC wander pacing; its `.omwaddon` sets 3 GMSTs |

The roots are installed in this order: Script Services first, because the others call its interface from their actors'
scripts. LuaPhysics and OpenMW Impact Effects, both optional for The Combat Juice, are not installed. Without them no gear
is knocked loose (it stays on the corpse) and there are no sparks. Sneak! needs OMWControls' Toggle Sneak, which
`orthros-player-defaults` gives (above). None of the four uses `table.maxn`, `setfenv` or another LuaJIT-only call.
SuperSlider6's `math.log10` exists since engine r9.

**Multiplayer.** The world rules are the simulation peer's. Each mod's gameplay scripts run there as shipped: Script
Services whole, SBMR's GLOBAL and the CUSTOM actor script it attaches, and The Combat Juice's and Sneak!'s NPC/CREATURE and
GLOBAL scripts. Their MENU and PLAYER entry points are guarded (`combat-ui-compat`, `guard-client-ui.mjs mod:MENU,PLAYER
--id combat-ui-compat`). Sneak!'s `.omwaddon` stays enabled in its own root, so every peer loads the same GMSTs. Sneak!'s
detection runs on each player's own client: it ends the player's sneak once an NPC has noticed, and from then on the
engine's own detection decides.

The Combat Juice's global script changes the simulation time scale (its kill slow motion). It also creates and moves
light objects for its impact flashes, and those objects are saved in the world. In a shared world, where
`openmw.mp.isEnabled()` is true on a joined client and on the peer, `orthros-overlay-all-pack` (a copy of `global.lua`
loaded after the author's) does neither. On a client the slow motion would only desynchronise that player from the
world. Solo is unchanged. The kill flash, the markers and the camera shake are local to the client, so they stay on.

**French.** `orthros-overlay-fr-pack` (FR only) routes the hard-coded English of The Combat Juice's settings renderers,
Sneak!'s select items and slider labels, and Sneak!'s tutorial window through the mods' l10n contexts, with the English
text as the key. `orthros-l10n-fr-pack` (FR only, the last root) holds `fr.yaml` for `SBMR`, `CombatJuice` and
`SneakIsGoodNow`, in the French masters' terms. Script Services has no texts.

`guard-client-ui.mjs` now accepts declarations written with the author's separators (`\`) and spaces, as in
`scripts\MaxYari\combat juice\player.lua`. The wrapper requires them by module name, so a path with any other dot is
refused. With a type selection, a selected mod's content files (`.esp`, `.omwaddon`) stay enabled in its own root.

Checked in scratch: `check-catalog.mjs` passed on real copies of both games after `install-all.sh`. It checks the
manifest rules, that nothing else changed, every installed file against its receipt, the overlays and their originals,
each guard line, the settings against `settings-default.cfg`, and `luac -p` on every Lua file. Solo EN and FR booted in
Chromium through scratch gateways, with no Lua error. The kill-flash shader sits in the post-processing chain from the
start, and the frame stays drawn on WebGL2. Toggle sneak opened Sneak!'s tutorial, in French in the FR version. A boot
with `OPENMW_MP_SYSTEM` set in the browser engine ran only the scripts kept for the peer, with no error, in Seyda Neen.
The overlay was run under Lua 5.4 with stubs. In solo it gives the author's time-scale dips and lights; in a shared
world it gives neither.

In play, solo EN and FR (2026-10-29, as in "Recommended settings" above):
- State-Based Magicka Regen: after a failed cast (50 → 37.2 magicka), magicka rose steadily to 39.6 over 31 s
  (929 game seconds). Vanilla Morrowind regenerates none outside rest.
- The Combat Juice: dagger blows on a mudcrab, then on an NPC in FR. The hit-marker textures loaded at the first blow,
  and the camera's extra pitch, yaw and roll moved (its shake, up to 0.0072 rad). A kill that ended a fight of more than
  20 s brought the long slow motion: the simulation time scale read 0.200 for about 2 s. During it, the frame showed the
  `cj_flash` exposure blur and the red kill marker, on WebGL2. A quick kill with other mudcrabs still fighting brought
  none, because the encounter had not ended and the short slow motion has a 25% chance.
- Sneak!: the eye meter around the crosshair and the detection markers showed while sneaking. A guard or Arrille in
  view detected the player within a second or two, and Sneak! then ended the sneak (`SneakPlayer.lua`, by design).
  Its tutorial (`Rester inaperçu` in FR) and its settings pages were in French in the FR version, as were the pages of
  SBMR (`Régénération de Magie selon l'état`) and The Combat Juice.
- Engine log: no Lua error from the four mods or the player defaults, EN and FR. Warnings from them: `No language files
  for the preferred languages found in "l10n/SneakIsGoodNow"` (EN: Sneak! ships no `l10n` folder; its texts are the
  English keys), and `Scaling image … from (576,216) to (512,256)` for Sneak!'s eye atlas and detection markers and The
  Combat Juice's 28×28 hit markers. The ten `Warning generated while parsing layouts of a(n) unnamed LuaWidget` at
  each boot were already in the live Vanilla+ clients' logs before the pack.
- Seen while testing, outside this pack: Advanced World Map's `widgets/markers.lua:177` calls
  `string.format("%s_%s_%d_%d", …)` with non-integer coordinates. Lua 5.4 refuses that (`bad argument #4 to 'format'
  (number has no integer representation)`), each time its map updates its markers.

Frame cost (`perf.mjs` 60 s, `--discard`, `--query tier=mid`, SwiftShader, Seyda Neen walk; rasterization skipped, so
these are the engine's and browser's CPU):

| Catalog | fps | work p50 / p90 / p99 (ms) | frames over 50 ms of work | Lua (ms/frame) |
| --- | --- | --- | --- | --- |
| EN before the pack (live manifest), 2 runs | 21.07 / 21.01 | 11.2 / 15.1–16.1 / 31.9–39.1 | 8–9 | 0.52–0.62 |
| EN, the four mods and player defaults, no `openmw.settings` | 19.44 | 11.9 / 16.8 / 38.9 | 8 | 1.18 |
| EN with the pack and `openmw.settings`, 2 runs | 19.54 / 16.04 | 11.6–12.6 / 17.2–19.4 / 58.2–60.3 | 16–18 | 0.50–1.01 |
| FR before | 20.93 | 11.0 / 14.9 / 28.4 | 8 | 0.62 |
| FR with the pack | 18.76 | 11.9 / 19.8 / 70.0 | 26 | 0.78 |

The mods cost about 0.7 ms of work per frame (−1.5 fps here) and leave the long frames as they were. The long frames
doubled only in the runs with `openmw.settings`: 16–26 against 8–9, in four runs against four. A profiled run with the
pack (`--profile`: 20.0 fps, 19 frames over 50 ms) found its longest frames (200–240 ms) inside OSG's draw
(`RenderStage::draw` → `RenderLeaf::render` → `osg::State::apply` and its WebGL calls), not in Lua or in the AI and
mechanics phases. None of the settings is a rendering one. `[Map] allow zooming` widens the local map's grid only
above a one-cell view distance, and Orthros' boot value is 8192 units. Each run is also a new game whose weather is
drawn at random, and rain adds drawing work that a discarded raster still pays on the CPU. So the cause is not
established. Single runs vary as well (the second EN run with the pack: 16 fps). Measure on a real GPU, with the
settings in halves, before changing them.

Not checked: a real multiplayer session with the native peer, and the GPU cost of the flash shader's two passes, which
run every frame while "Kill Flash On" is not "Never".

**Wanted, not installed: Surefire and Quest Markers Plus.** Both are on Nexus Mods only. No GitHub or GitLab copy by
their authors exists, and modding-openmw.com links only to Nexus. Surefire
([59646](https://www.nexusmods.com/morrowind/mods/59646), CattoStar): Files tab, MAIN file "Surefire" version 2
(2026-08-16, 30 KB); not the OSSC patch or the "(Broken)" PureMultiMark patch. It needs nothing else: Lua only, OpenMW
0.51+; GLOBAL, NPC/CREATURE, PLAYER and MENU scripts. Quest Markers Plus
([58701](https://www.nexusmods.com/morrowind/mods/58701), RPGKing117): MAIN file "Quest Markers Plus - English" 11.0.5
(2026-05-30, 5.8 MB). It bundles a modified copy of Quest Guider Lite's scripts and quest data, and two replacement
proximityTool scripts (`hudmHandler.lua`, `ui/mainMenu.lua`), and must load last. Its requirements are proximityTool
([57286](https://www.nexusmods.com/morrowind/mods/57286), 1.3.1; also [GitHub](https://github.com/Diject/proximityTool)),
Advanced World Map ([57881](https://www.nexusmods.com/morrowind/mods/57881), already in Vanilla+), Advanced World Map -
Tracking ([58324](https://www.nexusmods.com/morrowind/mods/58324), 1.1.0; also
[GitHub](https://github.com/Diject/advWMap-tracking)) and HUDMarkers - Detect spells
([57112](https://www.nexusmods.com/morrowind/mods/57112), 3.6, Nexus only). The Quest Guider Lite it modifies is
[57285](https://www.nexusmods.com/morrowind/mods/57285) (1.6.1 now; also [GitHub](https://github.com/Diject/quest_guider_lite)).
Its bundled Quest Guider Lite matches QGL about v1.3.1 (March 2026) and its two proximityTool files about v1.2.0; QGL's
author calls it incompatible with current Quest Guider Lite and its newest quest data: never install both. Its quest data
comes from the English masters (French masters: to be rebuilt with the author's Quest Data Builder).

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
node tools/openmw/guard-client-ui.mjs data/games/morrowind-vanilla-plus morrowind-goty-vanilla-plus-fr \
  ui-modes questman advanced-world-map
```

Run this only after installing all selected UI addons. It preserves every original addon file,
moves the enabled plugin selections into the generated root, and refuses an existing patch or
unsupported declarations before changing the manifest. It must never be used to disable
gameplay or quest scripts on the simulation peer.

A mod that has gameplay scripts beside its interface is named `<mod-id>:MENU,PLAYER`: only the declarations whose
targets are all among those types get a wrapper; the others (`GLOBAL`, `CONTAINER`, item types…) stay in the generated
plugin exactly as shipped, so they still run on the simulation peer, and the manifest lists them (`unguardedEntries`).
A declaration mixing both kinds (`PLAYER, GLOBAL: …`) is refused. Addons installed after an existing compatibility root
get their own with `--id <compat-id>`: its wrappers go to `scripts/orthros_<id without -compat>/` (the first root's stay
`scripts/orthros_client_ui/`), and a wrapper folder another root of the version already holds is refused.

```sh
node tools/openmw/guard-client-ui.mjs data/games/morrowind-vanilla-plus morrowind-goty-vanilla-plus-fr --id inventory-ui-compat \
  ui-toolkit inventory-extender-redone:MENU,PLAYER inventory-camera alchemy-redone:MENU,PLAYER
```

## Installation and completion

Use Node 24+ (`/usr/local/bin/node` on this server). All browser checks must use the shared slot wrapper.

```sh
python3 tools/openmw/install-engine.py --server
node tools/openmw/install-game.mjs
node tools/openmw/install-game.mjs --data-files '/path/to/Morrowind/Data Files'
```

The last command requires the six GOTY master/archive files. It copies into an **empty**
`data/games/morrowind/base/` and refuses to overwrite an existing installation. It also prepares the modded game
(`tools/openmw/manifest-vanilla-plus.json`: `data/games/morrowind-vanilla-plus`, an empty base, its mods over the
original's files by `requires`). A GOG offline
installer may first be extracted with the tooling `innoextract` into the task's scratch directory.
The manifest currently selects the English release, matching the recommended English plugins;
do not import a translated installation under that version id.

Mods go in separate data roots in the version folder; never overwrite `base/`. Extract the
author's archive into task scratch, inspect its installation instructions, and select the
applicable parts and plugins explicitly:

```sh
node tools/openmw/install-mod.mjs data/games/morrowind-vanilla-plus morrowind-goty-vanilla-plus-en \
  project-atlas /path/to/extracted/Project-Atlas \
  --part '00 Core' --part '01 Textures - MET' \
  --part '06 Glow in the Dahrk Patch' --part '07 Graphic Herbalism Patch' \
  --sha256 364c5896a4b181def2420e1b30f54043b3c0ef35812db24b53fe79f1aa1a92f5
```

That command has already been run for Atlas. It refuses a second installation. For other
mods use their declared id from the manifest and their actual data-root names. Enable required
plugins with `--plugin 'Name.esm'` (repeat for each). It discovers archive **names**, never parses
game formats, records the selected roots and verifies a sentinel before advertising availability (an asset, a plugin,
or for a root of Lua scripts, shaders or l10n texts only — an Orthros overlay of a mod's file, a translation — a
`.lua`, `.omwfx` or `.yaml` file).
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
list under `/var/lib/orthros-openmw/<manifest>/gamedata` (`OPENMW_STATE_DIR`, src/host/openmw.js), then starts the pinned native gateway in Docker.
Only `127.0.0.1:28100` is published. Limits: two CPU cores, 4 GiB, 256 tasks; worlds have a
3 GiB memory budget plus 256 MiB gateway reserve. Worlds start on demand and idle out. Accounts,
worlds and saves persist under `/var/lib/orthros-openmw/<manifest>/`, separate from the original game files
(beside the other services' state; under `build/` until 2026-10-26, where `make clean` would have erased it). The
nightly restic snapshot keeps it (docs/backups.md). Do not delete it when updating the engine.

### The gateway's image: its Node.js replaced (2026-10-23)

The pinned upstream image (`lock.json` `serverImage`) runs its gateway and world servers on the Node.js its Dockerfile
installed from NodeSource, `/usr/bin/node` v22.23.3, vulnerable to CVE-2026-111497. The gateway runs instead an image
derived from it (`lock.json` `serverBuild`, `tools/openmw/server-node.Dockerfile`): the official nodejs.org release
v22.23.4 linux-x64 (its SHA-256 from nodejs.org's `SHASUMS256.txt`, pinned, checked again in the build) in place of
`/usr/bin/node`, npm and corepack (`/usr/lib/node_modules`, their `/usr/bin` links unchanged) and the headers; the
rest is the upstream image's (OpenMW binary, `/app` bundle and `node_modules`, entrypoint, user, env, healthcheck).
Same major version, same module ABI (127): the only native addon, `@node-rs/argon2` (N-API), loads unchanged — the
build hashes with it. `sh tools/openmw/build-server-image.sh` (also run by `install-engine.py --server`) builds it
without network, timestamps fixed: the same inputs give the same ID, compared with the lock's `image` (the manifest's
digest in Docker's containerd store; `config`, its config's digest, in a classic store). `server.mjs` runs that ID for
every release on that upstream image (`openmwGatewayImage`, `src/host/openmw.js`) and refuses to start if it is not
built — never the vulnerable base then. `server.mjs --port <n>` starts a scratch gateway beside the live one (its own
container name), with `--state-dir` in scratch.

Checked before the switch: a scratch gateway (port 28191, scratch state) answered `/healthz`, its operator API created
an operator and a player (argon2), and a Chromium client of a worktree server whose copied manifest pointed at it
signed in through the account bridge, started a private world (`dist/server.mjs` and the native simulation peer) and
reached `Joined`, `simReady=1`; every node process in the container ran v22.23.4.

Deploy: after the merge, build the image (`sh tools/openmw/build-server-image.sh`), then restart the units one by one
(`systemctl restart orthros-openmw@<manifest>`); each container: `docker exec orthros-openmw-<manifest> node --version`
→ v22.23.4, `docker inspect --format '{{.Image}}' orthros-openmw-<manifest>` → the lock's `image`, `curl
127.0.0.1:<port>/healthz`. Rollback: revert the merge and restart the units (the base image stays in Docker).

For the currently installed original profile, the active unit is
`orthros-openmw@morrowind-goty-en` (port 28101) and the public entry point is
`https://orthros.chalco.website/ports/openmw/morrowind-goty-en/`. The complete Vanilla+ profile
is now enabled too, with its French language target on port 28103. Accounts and saves belong
to each profile separately. The owner's two requested player accounts are provisioned on the original
profile; their generated credentials are in `/var/lib/orthros-openmw/morrowind-goty-en/player-access.json`
(mode 0600, outside Git). Their public usernames are already set, with local placeholder email
addresses; no Nexus credential is reused or stored.

Password servers have no self-service registration in the pinned upstream version. Create a
player through the local operator API, with the password supplied on stdin:

```sh
node tools/openmw/create-account.mjs morrowind-goty-vanilla-plus-en Alice --password-stdin
```

Finish stdin with EOF after entering the password, or redirect a private file. The first run
creates a random local operator credential in `/var/lib/orthros-openmw/<manifest>/operator.json` (0600).
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

The engine's package without what a game of its own never reads (2026-10-21; rules 2 and 3 and content keying 2026-10-27,
`src/host/openmw-lean.js`). The release's `openmw.data` (204 MB, 33.4 MB in brotli) holds the engine's resources
(3.3 MB), ICU's data twice (`/icu/icudt68l.dat` and `/icudt68l.dat`, 28,566,176 bytes each, byte-identical, 28.5 MB
apart — beyond brotli's 16 MB window, so each costs ~7.1 MB of brotli) and the free example world the page boots with
`?nomw` (`/gamedata/`, 144 MB: 22 MB of the brotli). Every data path of the engine page for a game of its own (hosted,
local folder, locker) writes an `openmw.cfg` without `data=/gamedata`, yet a new Morrowind player downloaded it before
the menu (4-5 min at 85 KB/s). The server makes the same package with the unread bytes zeroed — same size and offsets,
so the metadata inside `openmw.js` stays as it is — at brotli quality 11 (a niced child, `openmw-lean-worker.js`, 207 s
on the loaded test machine). Its rules (`LEAN_RULE`, in its URL and file: a new rule is a new immutable address):
1. the example world, `/gamedata/` (lean1: 14,929,087 bytes for every release r1..r11);
2. ICU's root copy, `/icudt68l.dat`, by name and only when the package has `/icu/icudt68l.dat`: the engine opens that
   one only — `u_setDataDirectory("/icu")` in `apps/openmw/main.cpp` (`data/engines/src/openmw-web-v1.5.3/…:241`),
   set in-process before any ICU use because, its comment says, `ENV.ICU_DATA` does not work in this build (the page's
   `ENV.ICU_DATA='/'` is dead). Measured 2026-10-27 on orthros-r11 (scratch servers of main and of this change on
   the same copied br-cache and learned state): lean2 7,852,937 bytes (lean1 14,929,087), made in 107 s, the decoded
   package equal to the original byte for byte but `/gamedata/*` and `/icudt68l.dat` zeroed (`/icu/icudt68l.dat`
   intact); the home's engine (`/api/manifests` `launch.engine`) 20,649,625 → 13,573,475 bytes (the live server said
   20,649,625 too); a warm-up boot to the menu through 1.8 MB/s and 90 ms fetches 20,630,708 → 13,554,558 bytes of
   `/engines` (menu at 53.2 → 50.0 s, one run each). `tools/openmw/check.mjs` (2 runs per variant): Morrowind GOTY EN
   and Vanilla+ `--lang fr` reach the menu on both; on this change both open the Options window (a copy of the tool that
   clicks it), its ICU-formatted values drawn ("Difficulté (0)", "Difficulty (0)", "Actors Processing Range (3584)").
3. inside the opened copy, `/icu/icudt68l.dat`, the ICU feature trees the engine never opens (`ICU_DROPPED`: `brkitr`,
   `coll`, `rbnf`, `translit`, `unit`, `zone`), `leanIcuData`: the common data's table of contents rewritten with the
   kept entries only (still sorted: ICU finds an item by binary search), the freed slots, the dropped names and the
   dropped items' bytes zeroed — the same length, every kept item at its offset (a kept item's length as ICU computes
   it, to the next entry, may grow over zeros: a resource bundle is bounded by its own indexes). Removing entries, not
   zeroing items in place (an entry would point at no valid header). Whole trees only, their `res_index.res` with them
   (OpenMW's own build filters the same way, `extern/icufilters.json`; the upstream web build's note in
   `wasm-build/link-openmw.sh` found that dropping LOCALES breaks the boot — the root's locale index still lists them —
   and dropping feature groups does not). Chosen from what the engine calls (its sources, `data/engines/src/openmw-web-
   v1.5.3/…`): `icu::MessageFormat` (l10n: number skeletons `::.00` and `:: group-off`, `plural`; no date, time,
   spellout, ordinal or duration argument in the engine's or the installed mods' l10n) and `Locale::getDisplayName`
   (the Options' Language list), nothing else (`grep` of `apps/` and `components/` for Collator, BreakIterator,
   Transliterator, DateFormat, Calendar, TimeZone, MeasureFormat, RuleBasedNumberFormat, toTitle: none). Kept: every
   locale and every root item (converters, normalization, supplemental data, `plurals.res`, `numberingSystems.res`);
   `lang/` and `region/` (getDisplayName: a Vanilla+ mod ships `zh-cn`, "Chinese (China)"); `curr/` —
   `DecimalFormatSymbols::initialize` opens it with the caller's status (ICU 68 `i18n/dcfmtsym.cpp:469`: without it
   every number format fails). Measured 2026-10-27 on orthros-r11 (package `e659ce68…`): one ICU copy 7,094,292 →
   3,371,725 bytes of brotli 11 (2,566 of 3,823 items kept); lean3 4,132,827 bytes (lean2 7,852,937: −3.72 MB, ~44 s
   at 85 KB/s), made in 71 s at nice 19, its decoded package equal to lean2's but the ICU copy, which is
   `leanIcuData(original)`; the home's engine (`launch.engine`) 13,573,475 → 9,853,365. A scratch server of this change
   (rule 3) and one of main (rule 2) on the same copied br-cache and learned state, Vanilla+ `--lang fr` through a copy
   of `tools/openmw/check.mjs` that opens Options: Préfs ("Difficulté (0)", "Actors Processing Range (3584)": `::
   group-off`), Vidéo ("Field of View (60.00)", "Correction Gamma (1.20)": `::.00`), Language with its list open
   (German … "Chinese", "Chinese (China)") — the three screenshots identical between rule 2 and rule 3 over the
   window (0 pixels differing), no ICU or l10n error in the engine's log; Morrowind GOTY EN reaches the menu
   (`check.mjs`) and draws its Options' values ("Field of View (60.00)"). Then (2026-10-27): Vanilla+ on rule 3 makes a
   save (F5 at -2,6) and loads it from the menu (`tools/openmw/place-load.mjs --mode save --profile new`, 7 MB/s: in the
   world 57 s after the key, cell -2 6, frames flowing), and in a new game its Lua HUD (the quick bar) draws over the
   chargen name dialog (`tools/data-matrix.mjs`, 500 KB/s). A new player at 85 KB/s (the same matrix, main against this
   tree, which also has the whole-block reads of docs/slow-network.md): the engine's lean package 13.55 → 9.83 MB on the
   wire, downloaded 67 s earlier (173 → 106 s from navigation).

Keyed by the package's content (since rule 2): `<br-cache>/engines/_c/<sha256 of openmw.data>/lean<rule>/openmw.data.br`,
served immutable as `/engines/_c/<sha256>/lean<rule>/openmw.data`. The sha256 is the one the server's engine files by
content hash (`engine-content.js`, the same instance: once by file, size and mtime, `release.json`
`engineFiles['openmw.data']` only checked against it, a mismatch logged; the made file is checked against it by the
child). The OpenMW releases built here change the wasm and keep the package (the same
`e659ce68…` from orthros-r1 to r11), so a returning player keeps it across releases and fetches only `openmw.wasm`/`.js`
(measured 2026-10-27: a profile warmed to the menu on r11, then a copy of r11 under a new release id, to the menu
behind 1.8 MB/s and 90 ms, 2 runs a variant: `/engines` 20,630,708 → 5,701,421 bytes — `openmw.js` and `.wasm` only,
the package not asked —, everything through the link 34.4/33.8 → 18.7/19.2 MB, the menu at 18.5/17.4 → 10.1/11.3 s), and the server makes it once for all of them. The engine page of a version that is not the example
(`withLeanPackage`) has `locateFile` give that address for `openmw.data` unless it boots `?nomw`, answered as brotli
without `Content-Length` like the release's own (`sendBrotli`). The release-keyed addresses of earlier servers
(`/engines/<release>/lean<n>/<build>/openmw.data`) keep answering for the pages still open with them — their own file
while it is kept, else the content's (the same package for them: only unread bytes differ). The server starts making it
at its start for every installed game of its own (else the first card or page asking for it does); until it is made
(about 100 s at nice 19 on an idle machine), or for the rest of the run when its making failed, pages are given the
newest lean package already on disk for that package (an earlier rule's under `_c/<sha256>/`, else an earlier server's
release-keyed `<release>/lean<n>/<build>/`: right after the switch to rule 2, the 14.9 MB lean1), and the card lists
that one for Prepare. With none on disk pages load the release's own package (33 MB of brotli), and the card's engine
files (`launch.engineFiles`, what Prepare caches) leave the package out (`pending`: a Prepare meanwhile would cache a URL
the page stops asking for once the lean one is there). The
home's engine size counts it once made (`engineOf`); a Prepare whose engine files are no longer the card's (`engineFiles`
kept with its progress) shows as not ready, its engine to fetch again (once at the switch to the content address, then
only for a release's new wasm/js). Follow-ups: `tools/openmw/build.sh` (131-132) still stages ICU twice — a future
release could ship `/icu/icudt68l.dat` only (it changes that release's package hash: to do with the release chain's
owner); the release-keyed lean1 files of the live br-cache (`<br-cache>/engines/<release>/lean1/`, ~15 MB each) can go
once no page opened before the switch remains. Since the next step (docs/browser-ports.md "Engine files by content"), `openmw.js`, `openmw.wasm` and
the release's own `openmw.data` (the example world's, `?nomw`) are given by their content too (`withEngineUrls`):
a release that changes only the wasm costs a returning player the wasm alone.

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
Morrowind multiplayer or gameplay success claim. `--lang <code>` picks the game language on the card (its flag) before
Play: the version that language runs is the one checked (`morrowind-goty-en --lang fr` checks `morrowind-goty-fr`'s
page, its saves and start cell). (Until 2026-10-18 it ran on the free example.)

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

### Frame time: engine orthros-r2, quality tier, cloud bridge (2026-10-21)

Engine release `openmw-web-v1.5.3-orthros-r2` (`tools/openmw/build.sh`, patches `orthros-r1.patch` +
`orthros-r2.patch`, files pinned in `lock.json`; 18 min to compile here, plus the brotli siblings). Installed, no
manifest switched. What r2 changes:
- the local map's two leftover diagnostics are no longer installed (`localmap.cpp`): `MapDrawDiagnostic` read pixels
  back (`glReadPixels`, a whole GPU pipeline drain) at each new map camera's first draw, i.e. at every cell crossing;
  `MapCullDiagnostic` walked the camera's bin. The other readback at a cell change is upstream OpenMW's own (the global
  map's CPU copy of each explored cell, `GlobalMap::requestOverlayTextureUpdate(cpuCopy)`, what saves keep): left.
- the GLES rewriting of shaders (`adjustSourceForGLES`, about 40 `std::regex` constructions and passes over each merged
  source, and the `$link` regex) is plain scans (`components/shader/glesrewrite.hpp`). Byte for byte the regexes'
  output: `python3 tools/openmw/gles-rewrite-check.py --engines-dir <data/engines>` compiles both natively and compares
  them over the engine's 76 shaders (whole, as vertex and fragment, merged as `$link` makes them), 200,000 generated
  sources and 200,000 `$link` statements (0 differences; a one-character mutation of the scans is caught); natively
  11.4 ms → 0.095 ms per merged source (5.8 KB mean). No persisted cache of rewritten sources: nothing left to save.
- a sound played once (not a loop) whose file is not in the page yet is skipped instead of the page's thread waiting
  for it (`SoundBufferPool::loadSfx(sfx, waitForData)`): the engine asks `globalThis.orthrosFileReady(name)`
  (`streamfs.js`: the mounted file whose path ends with the VFS name), which answers through `GameData.readable(h)`
  (`src/vfs/data-client.js`, every engine's: false, and the bytes fetched in the background — not counted among the
  engine's waits —, then true). Its next play loads it; it is learned then too. Loops (ambient, fire) still wait: a
  skipped loop would stay silent.

Not done, with the reason: VAOs (already forced on by the upstream OSG patch, `State::State()`; the attribute calls
left are dynamic geometry — upstream's A/B, engine.cpp F48), KHR_parallel_shader_compile (headless shows 11-15 ms
`getShaderParameter` stalls only; worth it only if a real GPU trace shows compile hitches), cell loading off the frame
(the threaded WorkQueue was reverted upstream for main-thread freezes: a lock audit, not a setting), wasm32 vs wasm64
(the JS glue's memory64 share measured about 1.7 %: an A/B costs a second full build for little).

The quality tier (`src/ports/openmw/tier.js`, `withQualityTier`): from the GPU (`src/host/web/gpu-class.js`, WebGL's
renderer string: software → low, integrated → mid, discrete → high; deviceMemory ≤ 4 still low; unknown GPU: the
page's own deviceMemory rule), and a minute in the world whose frame-meter p99 median is over 50 ms starts the next
session a tier lower on the same GPU (`localStorage['orthros.openmw.tier']`). `?tier=` and the player's Options win.
The owner's 8 GB+ Iris Xe laptop was 'high' (Chrome caps deviceMemory at 8): now 'mid'. Headless SwiftShader: 'low'.

The cloud bridge (`cloud.js`): each file's size, date and base64 kept; a sync that changed nothing reads, encodes and
hashes nothing (`tools/openmw/cloud-bench.mjs`, Node: 1 MB of saves 74-88 → 0.03-0.05 ms per idle sync; 20 × 2 MB
2.9-3.7 s → 0.11-0.15 ms).

2026-10-23: `perf.mjs` reads its probe as `window.__omwPerfProbe` (the engine page's `window.orthrosPerf`, the passive
session record, replaced the tool's and every run ended in a TypeError since then), prints the canvas (drawing buffer,
pixel ratio, antialias, samples) and runs Chromium itself by default as the bench suite does (`--channel shell`: the
headless shell, 47-50 frames a second on the glide where Chromium and the suite measure 31 — docs/browser-ports.md
"Measuring a port"). Where the frames' time goes outside the engine there: the GPU process executing the draws
(SwiftShader's vertex work, rasterizer discarded or not) — at Seyda Neen, 690 draws a frame: 17.7 frames a second, the
engine's work 22.5 ms; the draws made no-ops, 60 and 11.8 ms. A real GPU's matter of a few milliseconds.

In-world measurement: `tools/openmw/perf.mjs` (Seyda Neen `?start=-2,-9`, running for 60 s across one cell boundary,
`--discard` forces rasterizer discard so SwiftShader rasterizes nothing: CPU-side upper bounds; engine work = time in
`Module._omw_pump_frame`). On the shared test machine (load 22-37, `?tier=high`, morrowind-goty-en, medians; r1: 5
runs, r2: 3; runs at load 50-70 discarded): drawn frames 19.4 → 24.4 fps, gap p99 217 → 117 ms, gaps over 100 ms
52 → 24, engine work p50 15.9 → 15.7 ms, p99 51.9 → 29.1 ms, frames over 50 ms of work 13 → 8, readPixels 0.003 →
0.002 a frame (the global map's copy stays), 9-10 first plays of sounds skipped instead of waited for. The longest frame
did not move (440-980 ms, both): the inline cell load at the boundary. SwiftShader drawing (no discard, 40 s, r2, 2
runs each): `?tier=high` 1.47-1.55 fps, gap p99 3.5-6.5 s; the tier chosen now ('low') 2.12-2.22 fps, 2.4-3.3 s.
`tools/openmw/check.mjs` passes on r2. Not validated: a real GPU (the owner's laptop), the local map screen after r2
(the change removes callbacks only), a throttled link for the skipped sounds.

### r2 checked on the public site (2026-10-21, wave 2)

Headless Chromium (SwiftShader), the live server, scratch harnesses (not kept):
- **Multiplayer, two real clients** (two Orthros accounts registered, the port page's « with friends », QA
  `?start=-2,-9` character creation, friend request/accept, `joinfriend`): `morrowind-goty-en` — both `Joined`,
  `simReady=1`, the guest in the host's world after 116 s, each in the other's roster, the host's W key moved its
  puppet on the guest 59 units; `morrowind-goty-vanilla-plus-fr` — the same (12 content files, no
  `orthros.omwscripts`), together after 117 s, puppet moved 21 units. No `BAD_CONTENT`, no page error. Playable marks
  recorded (`playable-<manifest>.json`: 0 → 3 for each, the guest's page counting twice: its reload into the host's
  world is a new session). Test accounts deleted (login 401 afterwards), native players erased through the gateway's
  operator API (`accounts/delete`: account and character).
- **Maps**: the local map (Seyda Neen, the menu's map window and the HUD's) and the world map draw on r2, in both the
  original and Vanilla+ (`M`). The local map's explored part looks pale/whitish in SwiftShader; r1 on the same spot
  (a local server on the r1 release) draws it the same (mean pixel difference 2.5/255): not an r2 change.
- **Quality tier**: SwiftShader → 'low' (`software`); a renderer string faked as Intel Iris Xe → 'mid'
  (`integrated`); a minute in the world at a frame p99 of ~180 ms stored `{ gpu, tier: 'low' }` and the reload started
  at 'low' (`orthrosTierChoice.saved`, the engine's `__omwTier` 'low').
- **Throttled 1 MB/s** (a proxy in front of the live server, a fresh browser, `vanilla-plus-fr`, in the world ~105 s
  after the page): at 'low' (SwiftShader) the view does not grow — by design, the tier's distance is the boot one
  (8192); at 'mid' (Iris Xe faked) 8192 → 12288 within 34 s of the world. Light copies reloaded in place
  (`orthros_file_updated`): 334 in 10 min ('low'), 381 in 12 min ('mid'), the first ~2 min after the world. First
  plays of sounds skipped (footsteps, creatures, wind): 35 files ('low') / 37 ('mid'), of which 24 / 32 were played
  again later and found loaded.
- Found and fixed: the header's data pills never hid (`#topbar .pill { display: flex }` beat `[hidden]`): « Preloading
  100 % » and « Ready to play » stayed in the world, every runtime (`tests/player-css-hidden.test.js`).

### Cell crossings off the frame: engine orthros-r3 (2026-10-22)

Engine release `openmw-web-v1.5.3-orthros-r3` (patches r1 + r2 + `orthros-r3.patch`, files pinned in `lock.json`).
Installed in `data/engines/`, no manifest switched. What a crossing cost on r2, from CPU profiles
(`perf.mjs --profile`, discard mode): the inline cell load (`Scene::changeCellGrid` → `insertCell`: NIF parsing,
templates, creatures' animations) 100-430 ms, the terrain/object-paging preload of the predicted position run inline
(`TerrainPreloadItem`, every 128 units walked) up to 120-200 ms, and above all the global map's CPU copy of the
explored cell (`osg::Image` on a pre-render camera → `glReadPixels`, drawn three times) 0.2-1 s: a readback waits for
the whole GPU queue, which at a crossing holds the new cell's uploads. What r3 changes:
- **Cooperative WorkQueue** (`components/sceneutil/workqueue.cpp`, the web default): still no worker thread — so none
  of the main-thread futex waits that made upstream revert its threaded mode —, but the items are queued and run on
  the main thread after each frame, 4 ms a frame (`OPENMW_WORKQUEUE_BUDGET_MS`, `?wqbudget=`), at least one step.
  Long items run in slices (`WorkItem::doWorkSlice`): a cell preload one mesh at a time, a terrain preload a chunk at a
  time (`Terrain::World::preloadSlice`, `QuadTreeWorld`). The threaded contract holds (asynchronous;
  `waitTillDone()` finishes an item still queued, on the caller; `syncTerrainLoad` does so before waiting on its
  reporter). `?wq=inline` restores the old mode, `?wq=threaded` the 2 workers.
- **The exterior grid is preloaded again** (`preload exterior grid = true` in the page; doors stay off): the next cells'
  meshes, shapes and terrain are loaded in slices ahead of the player, so the crossing frame finds them cached.
- **No global-map readback while playing** (`mwrender/globalmap.cpp`): an explored cell paints the overlay texture
  only; the CPU copy (`mOverlayImage`, what saves keep) is read from that texture once, when a save needs it
  (`syncCpuCopy`: a framebuffer of its own, bindings restored). The map's cameras are drawn once instead of three times.
  Checked: a quicksave after r3 holds the same map overlay as r2's (954×864, the explored cell's 18×18 = 324 pixels
  painted, both).

Measured (`perf.mjs --discard --glide 0,1,300,3000`: the player carried north from Seyda Neen at 300 units/s for
150 s, 6 cells, 5 crossings; `?tier=high`; load 25-35; medians, r2: 4 runs, r3: 3): longest frame of engine work
1249 → 223 ms, longest gap between drawn frames 2033 → 433 ms, gaps over 250 ms 14 → 10, over 100 ms 97 → 67, frames
over 100 ms of work 23 → 13, work p50 11.6 → 10.8 ms, p99 70 → 56 ms, drawn fps 22.4 → 24.2, readPixels 0.0045 → 0 a
frame. Walking as before (`--run`, 150 s, one crossing; r2: 2 runs, r3: 1 at load 22-26, a second at load 52
discarded): longest work 971 → 142 ms, longest gap 1417 → 350 ms, work p50 14.8 → 13.5 ms, p99 23 → 22 ms.
Left in r3's longest frames (profile, 110-220 ms): one object-paging chunk built in a terrain-preload slice (a
chunk cannot be split), most of it the data streaming's synchronous fetch of a mesh not yet in the page (`fetchSync`:
170 of the longest 221 ms; 0.6-0.8 s of such waits a run, r2 and r3 alike) — the next step is a preload that asks
`orthrosFileReady` first and comes back to a mesh whose bytes are still on their way, as sounds do since r2.
`tools/openmw/check.mjs` passes on r3.

### The global map fixed: engine orthros-r4 (2026-10-22)

Engine release `openmw-web-v1.5.3-orthros-r4` (patches r1 + r2 + r3 + `orthros-r4.patch`, files pinned in `lock.json`;
17 min to compile here; `openmw.js` and `openmw.data` identical to r3's, only `openmw.wasm` and the page differ).
Installed in `data/engines/`, no manifest switched. Two defects of r3's global map (`mwrender/globalmap.cpp`):
- **A save whose world map has another size lost its explored map.** r3 zeroes a map camera's node mask after its first
  draw, before `copyResult()`; OSG's update traversal skips a node whose mask is 0, so a camera with a CPU copy pending
  — `GlobalMap::read()`'s resize path (the save's map of another size: another `global map cell size`, other content
  bounds) — was never updated again: the image never copied into `mOverlayImage`, the camera never removed. The map
  showed it (the texture was drawn) but the next save wrote an empty map (unless a cell was explored since, which reads
  the whole texture back). r4: the web build's resize path draws onto the overlay texture without a CPU copy and marks
  the copy stale (`syncCpuCopy` reads it back when a save needs it), and the mask is zeroed early only for a camera
  with no copy pending (`hasPendingCopy`).
- **`syncCpuCopy` checked only the image's width and height** before `readPixels` writes `width × height × 4` bytes of
  RGBA8 into it; after `read()`'s equal-size shortcut `mOverlayImage` is the save's decoded PNG, whose format was not
  checked (an RGB or 16-bit PNG). r4: the copy refuses an image not in the copy's layout (`isCpuCopyLayout`: size,
  RGBA, unsigned bytes, rows unpadded; a warning, the copy left stale) and `read()` takes the shortcut only for such an
  image — any other goes through the resize path.
- The page takes `?mapcellsize=N` (QA): the world map's pixels per cell (`[Map] global map cell size`, default 18).

Checked (headless SwiftShader, a scratch server whose manifests point at r4): a new character at -2,-9, three cells
explored (`omw_debug_coe`), into an interior (console `coc`), F5; the page loaded again with a world map cell size of
12 (written to the player's `settings.cfg`, which any release reads; `?mapcellsize=12` on r4 for Vanilla+), F9 (the
save's 954×864 map loaded into a 636×576 one: the resize path), the overlay texture read back from WebGL, F5, F9, F5
— the saves' GMAP records decoded:

| release | overlay after the load | save after the load | save after loading it again |
|---|---|---|---|
| r2 | 432 px painted | 636×576, 432 px | 636×576, 432 px |
| r3 | 432 px | 636×576, **0 px** (the map lost) | 0 px |
| r4 (Morrowind; Vanilla+ the same) | 432 px | 636×576, 432 px | 636×576, 432 px (identical) |

(432 = 3 cells × 12²; the first save, 972 = 3 × 18².) F5 / F9 in an exterior at the same size on r4: 972 px kept
through two loads. Crossing cells (`perf.mjs --discard --glide 0,1,300,3000 --seconds 150 --query tier=high`, 6
cells, load 15-27, 2 runs each, r2 and r4 interleaved): longest frame of engine work 1203 / 1062 → 282 / 291 ms,
longest gap between drawn frames 1967 / 1683 → 433 / 450 ms, gaps over 250 ms 16 / 15 → 4 / 5, readPixels 18 → 0
(r3's gain kept). `tools/openmw/check.mjs` passes on r4 for both games, in English and in French (`--lang fr`; one
of three Vanilla+ French runs failed, its output lost, the next two passed). Not checked: a PNG of another pixel
format in a save (no engine writes one; the guard is read, not run), a real GPU.

Switch (after a merge and a server restart): set `"engine": "openmw-web-v1.5.3-orthros-r4"` in the `openmw` object of
each version of `data/games/morrowind/manifest.json` and `data/games/morrowind-vanilla-plus/manifest.json`.

### Preloads that wait for the network, and the frames' synchronous WebGL calls: engines orthros-r5, r6, r7 (2026-10-22)

- **r5** (`orthros-r5.patch`): a preload between frames asks the page before it reads (`globalThis.orthrosRangeReady`,
  `src/ports/openmw/streamfs.js`: a loose file whole, a BSA member's own bytes) whether the bytes are there; when they
  are not, the page fetches them in the background and the preload puts that work off — a cell preload's mesh, a
  terrain preload's entry (its distant-object chunk: every mesh it may use and the textures their NIFs name) — and
  goes on with the next, for up to 3 s (`?preloadwait=N`, 0: as before; 60 s by default since
  `OPENMW_ORTHROS_PRELOADPATIENT`, round 6 below — `=0` gives back 3 s); the cooperative queue runs the other items
  meanwhile (`WorkItem::setWaitingForData`). Finishing now (`waitTillDone`, the loading screen) puts nothing off.
- **r6** (`orthros-r6.patch`): the composite maps' FBO status (`CompositeMapRenderer::compile`) asked until found
  complete, then no more — every composite map is a texture of the same size and format, and WebGL's
  `checkFramebufferStatus` is a synchronous round trip to the GPU process (100-400 ms frames when that process is
  busy). A ray (an intersection visitor: the focus object's, every frame, a script's) builds no distant-object chunk
  (`getChunkForRay`): it uses those built already, a node with one missing not kept — the focus ray built them in the
  frame's update for its own view, network reads included.
- **r7** (`orthros-r7.patch`, the first that reaches OSG's sources: the build applies it at the tree's root,
  `deps/src/osg` beside `openmw/`): a ray builds no terrain chunk outside the active grid either (its composite map
  read and drawn), and OSG's camera setup (`RenderStage::runCameraSetUp`) asks an FBO's status once per kind of
  attachments (their targets, formats and samples) found complete — a cell crossing creates new render-to-texture
  cameras (the local map's), each one asked before.

The scratch servers that measure a release: a version needs its `multiplayer` object (the gateway's
`mwdata-manifest.json`, the engine page's list of the installation's files, comes through it — without it the page
stays on "no manifest (HTTP 404)"), and two versions cannot share a gateway port: one scratch server per release,
each with its own copied manifest (a first r5 measurement that never reached the world was this, not the engine).

Measured (`perf.mjs --discard --glide 0,1,300,3000 --seconds 150 --query tier=high`, 6 cells, `--profile` on the runs
marked p; load 25-40 — one r6 run at load 80, discarded; the longest frames' contents from the CPU profile, the engine
frames of 100 ms or more):

| release, run | fps | engine work p99 / max | frames ≥ 100 ms | gap max, > 250 ms | data stalls (sync fetches) | put off |
|---|---|---|---|---|---|---|
| r4 a (p) | 18.6 | 49 / 305 ms | 10 | 683 ms, 16 | 966 ms (205) | — |
| r4 b | 24.3 | 53 / 240 | 10 | 383, 7 | 809 (207) | — |
| r5 a (p) | 18.1 | 55 / 233 | 8 | 450, 13 | 316 (94) | 359 |
| r5 b | 24.5 | 44 / 169 | 7 | 400, 5 | 170 (49) | 377 |
| r5 c (p) | 22.7 | 85 / 184 | 25 | 300, 2 | 178 (46) | 558 |
| r6 a (p) | 22.2 | 41 / 197 | 6 | 417, 6 | 187 (47) | 420 |
| r6 c (p) | 21.5 | 40 / 183 | 7 | 433, 4 | 226 (84) | 344 |
| r7 a (p) | 20.4 | 39 / 162 | 5 | 350, 9 | 198 (49) | 354 |
| r7 b (p) | 21.0 | 34 / 164 | 3 | 467, 11 | 168 (48) | 425 |

What the long frames ran: r4 — five of six a distant-object chunk built inside a terrain preload slice, its meshes
read synchronously; r5 — none of those: the focus ray building a chunk (162 ms), cell crossings' object insertion
(160 ms), and above all `checkFramebufferStatus` (r5 c: most of its 21 frames over 100 ms, 50-140 ms of each, from
the composite maps' compile and from new cameras' setup); r6 — no composite-map check left, the focus ray's distant
chunks gone; left: a new camera's setup check inside cell crossings (3 frames), the focus ray building a distant
*terrain* chunk with its textures' reads (one, 137 ms) — r7's two changes; r7 — five frames over 100 ms in its two
profiles, all cell crossings (`Scene::changeCellGrid`: the new cells' objects inserted, a mesh read synchronously
now and then, an active-grid chunk built for the focus ray — 101-133 ms); no `checkFramebufferStatus`, no terrain
chunk built for a ray. Longest engine frame 305 / 240 ms (r4) → 162 / 164 ms (r7), engine frames over 100 ms 10 / 10 →
5 / 3, data stalls 966 / 809 → 198 / 168 ms. The gaps between drawn frames do not follow (r7: 350 / 467 ms, 9 / 11
over 250 ms, within the runs' spread): SwiftShader's compositing and drawing decide them here (the same as in the re3
measures, docs/browser-ports.md).

Checked on r5, r6 and r7 (scratch servers, one per release): `tools/openmw/check.mjs morrowind-goty-en` in English
and with `--lang fr` (morrowind-goty-fr) pass; quicksave and reload (a new character at -2,-9 carried to -3,-7, F5,
carried back, F9: -3,-7 again; the page loaded again in the same browser profile, F9 from the menu: -3,-7) pass. The
one fault every run reports, "Pointer is already locked.", is the headless browser's pointer lock (r4 the same).
Vanilla+ (`morrowind-goty-vanilla-plus-en`) on r7: 2 of 5 check runs pass; the others fail on the header's state read
3 s after the engine page's loading screen hides (its frame rate not shown yet, or the Orthros loader not hidden yet
— the version's files still loading in a server with nothing learned). r4 the same, interleaved on the same machine
(1 of 2 each way): the check's timing, not the release. In the world (r7, drawn by SwiftShader, Seyda Neen and two
cells north): terrain, objects, sky, water, shadows and the local map as before.

Switch (after a merge and a server restart): set `"engine": "openmw-web-v1.5.3-orthros-r7"` in the `openmw` object of
each version of `data/games/morrowind/manifest.json` and `data/games/morrowind-vanilla-plus/manifest.json`.

### Review fixes of r6 and r7: engine orthros-r8 (2026-10-23)

- **r8** (`orthros-r8.patch`, on r7): only the focus object's ray takes the cached-only path of r6/r7
  (`getChunkForRay`): `RenderingManager::castCameraToViewportRay(..., focusRay)` marks its visitor
  (`orthrosFocusRay` user value, reset in `getIntersectionVisitor`), `World::getFocusObject` passes it, and
  `QuadTreeWorld::accept` gives the partial node only to that visitor. Every other ray (a script's
  `nearby.castRenderingRay`, from anywhere — its view data split around another point than the camera's, whose chunks
  nothing draws) builds its terrain and object-paging chunks as before r6, instead of missing distant statics.
  RenderStage's FBO completeness cache (r7) keys each attachment on its size, mip level, cube face, array and 3D layer
  too, and on the GL context; an attachment of zero size, or an FBO without attachments, is never cached — an FBO
  whose allocation failed (zero-sized, beyond the context's limits) is asked and takes OSG's fallback as before r7.

Measured against r7 (two scratch servers, the same copied learned order, runs alternated; `perf.mjs morrowind-goty-en
--discard --glide 0,1,300,3000 --seconds 150 --query tier=high`, load 18-22, 6 cells):

| release, run | fps | engine work p99 / max | frames ≥ 100 ms | gap max, > 100 ms | data stalls |
|---|---|---|---|---|---|
| r7 a | 26.8 | 28.6 / 152 ms | 4 | 283, 30 | 166 ms |
| r7 b | 26.6 | 26.6 / 158 | 2 | 283, 23 | 176 |
| r8 a | 26.0 | 29.8 / 139 | 2 | 233, 17 | 98 |
| r8 b | 29.0 | 26.0 / 156 | 1 | 183, 20 | 95 |

The focus ray keeps r7's frames (its cost was the only per-frame ray's); r8 within the runs' spread or better.
Checked on r8 (scratch server): `check.mjs morrowind-goty-en` and `--lang fr`, `morrowind-goty-vanilla-plus-en` and
`--lang fr` pass; in the world (a new character at -2,-9): Arrille's Tradehouse door activated with Space (the focus
ray), Space on Arrille opens his dialogue, F5, carried to -3,-7, F9 back inside; the page loaded again in the same
browser profile, F9: inside again. Only fault: the headless "Pointer is already locked.".

Switch (after a merge and a server restart): set `"engine": "openmw-web-v1.5.3-orthros-r8"` in the `openmw` object of
each version of `data/games/morrowind/manifest.json` and `data/games/morrowind-vanilla-plus/manifest.json`.

### Space jumps, E activates; Lua's math, OpenAL's frame cost: engine orthros-r9 (2026-10-26)

The owner (2026-10-26): "still lags on Morrowind", and Space should jump and E activate, for everyone — the reverse of
Morrowind's own defaults, which OpenMW keeps. What the owner's session said (passive record, Vanilla+ FR solo, Iris Xe,
Chrome 155, a 1826×1271 window, tier `mid`, r8): in the world 39-50 frames a second, frames of 16.7 ms and 33 ms (one
in six missed a vsync), 30-46 over 40 ms and 4-13 over 100 ms a minute, the engine's work 19.9-22.4 ms a frame
(averages), its GPU time 10.7-15 ms. Before that, loading the game took 57 s without a frame, 55 s of it the engine
waiting for game data (906 reads not yet in the browser's copy). And the gateway's client log had the same Lua error
at every frame of a dialogue, `scripts/uimodes/npc.lua:13: attempt to call a nil value (field 'atan2')` (UI Modes'
NPC turning to the player): 135 lines that day, 4,154 in one session on 2026-10-20.

A profile of the engine at the owner's tier (`perf.mjs morrowind-goty-vanilla-plus-fr --query tier=mid --discard
--profile`, Seyda Neen, 60 s walking; names from `openmw.js.symbols`): of the engine's busy time, OSG's draw ~39 %
(applying uniforms and state sets: `PerContextProgram::apply(Uniform)` alone 8 %), the cull ~19 % (the shadowed
scene, the light lists), Lua 7 % (the addons' handlers), **the OpenAL listener 5 %** and the music stream's buffers
3.5 % (`alBufferData` 2 %); the wasm64 JS glue's checks (`growMemViews`, `bigintToI53Checked`, the memory's `buffer`
getter) ~5 % across every GL call.

What r9 changes (`orthros-r9.patch`, on r8):
- **Key defaults** (`mwinput/bindingsmanager.cpp`): Activate on E, Jump on Space (keyboard only: controllers keep their
  buttons). A new player gets them, and Options → Controls → reset too. A player's saved bindings (`input_v3.xml` in
  the engine's user config, written when the Options window closes, kept in IDBFS and on the account) are swapped by
  the page, once, when they hold the old pair exactly — Activate on Space and Jump on E —: `src/ports/openmw/input-keys.js`,
  loaded before the engine and called once the user files are in place (the account's copy and IDBFS restored), by
  `withInputKeys` (`src/host/openmw.js`). A marker beside them (`orthros-input.json`) records that the file was looked
  at: the old pair chosen again later stays, any other layout is never touched, and with no file yet nothing is
  recorded (a file the engine writes later is looked at then). The swap edits only the two `key` attributes.
- **Lua's math** (`wasm-build/build-deps.sh`): the browser engine runs PUC Lua 5.4, desktop OpenMW LuaJIT, and mods
  call LuaJIT's `math.atan2`, `pow`, `cosh`, `sinh`, `tanh`, `frexp`, `ldexp`, `log10`. Lua is compiled with
  `LUA_COMPAT_MATHLIB`, its own C versions of them (5.4's `atan2` is `math.atan(y, x)`); only `lmathlib.c` reads the
  macro. A generic fidelity fix: UI Modes' NPCs turn to the player in dialogue again, without an error a frame.
- **OpenAL** (`wasm-build/orthros-openal.js`, a `--js-library` linked after Emscripten's): every `alListener*` call
  (OpenMW sets the position and the orientation each frame) re-placed every source's panner, reading six AudioParams
  of each; a source in world coordinates does not move with the listener — only its Doppler shift depends on it, and
  that is all it now gets (computed as before); listener-relative sources as before. `alBufferData` read the heap
  through `growMemViews()` at every sample: the view is taken once a call (and indexed by division, not `>>`, which
  wraps a pointer past 2 GiB under MEMORY64).

- **The water's refraction on the discrete GPUs' tier only** (no engine change: `tierSettings`,
  `src/ports/openmw/tier.js`, written into the page's settings by `withQualityTier`): refraction draws the scene a
  second time each frame water is in view (a render-to-texture camera: the whole cull and draw again, and its GPU
  pass). OpenMW's own default is off (`settings-default.cfg`); the engine page had it on for every tier. Now `low` and
  `mid` (software and integrated GPUs) leave it off, `high` keeps it; `?norefr=1` / `?refr=1` force it, and a value
  saved from the player's Options wins as every setting does.

Measured (two scratch servers on this branch's code, one serving r8 and the old tier, one r9 and the new — an engines
dir whose `openmw-web-v1.5.3-orthros-r8` links to the release under test —, the same copied learned order, runs
alternated; `perf.mjs morrowind-goty-vanilla-plus-fr --query tier=mid --discard --seconds 60`, Seyda Neen walking,
load 10-15; one run at load 64 discarded):

| run | fps | engine work p50 / p90 / p99 | frames over 50 ms of work | gaps over 100 ms |
|---|---|---|---|---|
| before (r8, refraction) a | 17.0 | 20.1 / 24.8 / 42.6 ms | 8 | 9 |
| before b | 16.4 | 21.1 / 26.8 / 47.0 | 9 | 12 |
| before c | 15.6 | 20.5 / 26.2 / 43.4 | 7 | 14 |
| after (r9, mid without refraction) b | 20.9 | 16.2 / 20.0 / 34.1 | 7 | 9 |
| after c | 20.8 | 17.2 / 21.5 / 34.7 | 7 | 5 |

Apart (same tier, refraction on both sides, profiled runs): the OpenAL listener 5.8 % of the engine's busy time on r8,
1.2-1.3 % on r9 (with `AL.orthrosSourceDoppler` 0.6 %), `alBufferData` 1.8 % -> 0.2-0.3 %, the stream refills 3.4 % ->
1.8-2.2 % — about 1.3 ms a frame; refraction alone on r9: work p50 18.2-19.2 -> 16.7-16.8 ms, 17.2-17.4 -> 20.4-20.6
fps. These are the CPU's (SwiftShader rasterizes nothing); on a real GPU the refraction's pass is saved as well. Left:
OSG's draw (applying uniforms and state sets) and cull, now ~60 % of the engine's busy time; the addons' Lua ~5 %.
In r9's profiles: OSG applying uniforms 14-16 % (`State::applyUniformList` → `PerContextProgram::apply(Uniform)`, of
which the `glUniform*` calls themselves ~5 %: the rest its lookups), the shadowed scene's cull 15 %, the light lists 13-14 %
(`LightManagerCullCallback`, every object every frame), Lua 5.5 %, mechanics 4.4 %. A frame at Seyda Neen (mid, no
refraction, counted on every WebGL call): ~5,800 calls for ~650 draws — 1,680 uniform uploads (`uniform4fv` 565,
`uniformMatrix4fv` 448, `uniformMatrix3fv` 351), 1,050 vertex attribute set-ups (`vertexAttribPointer` 537,
`enableVertexAttribArray` 513) though VAOs are bound 390 times, 624 `bindTexture`, 390 `getParameter`. RUN!'s sprint
on Left Alt checked there too (the binding Orthros' input defaults give, SDL scancode 226; its action on while held).
Not changed here: the 57 s load of the owner's session was the game data's synchronous reads (the shared game data's
work, docs/slow-network.md).

The keys in the engine: `tools/openmw/keys-check.mjs <manifest> --url <origin> [--seed-old]` (a new character at
-2,-9; the player's Lua console samples `input.isActionPressed` for Jump and Activate and the player's height while
Space, then E, is held — reported through the engine's log; `--seed-old` first saves the old pair in the page's
persistent user files and loads the page again). On r8 it reports Space → Activate, E → Jump (a 78-unit rise). On r9 it reports Space → Jump (a 73-unit rise), E → Activate, a
new player and a seeded one alike (`morrowind-goty-en`, `morrowind-goty-vanilla-plus-fr`); with `--seed-old` on r8 too
— the page's swap alone is enough for a saved file. Lua in the player's console: on r9 `math.atan2(1, 1)` 0.7854,
`math.pow(2, 10)` 1024, `math.log10(1000)` 3, `math.ldexp(1, 4)` 16; on r8 `atan2` is nil. A dialogue in Vanilla+ FR
(`Module._omw_debug_activate()`, the nearest NPC): 156 `atan2` Lua errors in 8 s on r8, none on r9. `check.mjs`
passes on r9 for `morrowind-goty-en`, `--lang fr`, `morrowind-goty-vanilla-plus-en` and `--lang fr`; the settings the
page wrote: `refraction = false` at `low` and `mid`, `true` at `high` and with `?refr=1`.

Switch (after a merge and a server restart — the page's swap comes with the server's code): set `"engine":
"openmw-web-v1.5.3-orthros-r9"` in the `openmw` object of each version of `data/games/morrowind/manifest.json` and
`data/games/morrowind-vanilla-plus/manifest.json`.

### Development builds: kept tree, switches, pictures compared (2026-10-26)

A change to the engine costs a whole `build.sh` (18-25 min) per try; development builds do it in minutes:
- `sh tools/openmw/build.sh <dev id> --keep --dest <scratch>` once (a `lock.json` build entry of the patches so far, not
  committed): the tree stays in `/tmp/orthros-scratch/openmw-build/<dev id>/root`, configured and compiled (2.6 GB).
- `sh tools/openmw/dev-build.sh <kept root> <base release> <release dir> [--check] --patch <file>...`: the previous run's
  patches reverted, these applied in order; `--check` compiles only the `.cpp` files they touch and reverts them
  (seconds); otherwise OSG (its ninja), OpenMW (ninja) and the link (~7 min when no header changed, more after an OSG
  header), installed as a release beside the base one (its other files hard-linked, never written through). One run at
  a time on a tree (a lock): parallel agents queue.
- `sh tools/openmw/dev-serve.sh <release dir> <port>`: a scratch server of this code tree whose OpenMW pages run that
  release under the engine names the live manifests give (links in a scratch engines directory), the live games
  read-only, a frozen copy of the learned orders.
- Switches: `orthros-r11.patch` lets the page set the engine's `OPENMW_ORTHROS_*` environment from the address
  (`?omwenv=NAME=0[,NAME2=0]`); each r11 frame-cost change reads its own once at start (absent: on; `0`: the previous
  code path), so one build gives every A/B.
- `tools/openmw/frame-compare.mjs <manifest> --url … --variant <query>…`: the same views (day and night at Seyda Neen,
  Arrille's Tradehouse inside) for each variant, each started in its cell (`?start=`), AI and clock held (`tai`,
  `set timescale to 0`), overlays hidden, 4 captures averaged (interior lights flicker with real time); the reference
  captured twice — its difference is the noise. Measured on r11dev with a variant that changes nothing (goty-en):
  day 0.007 / 0.003 mean absolute difference, night 0.38 / 0.40, interior 0.21 / 3.19 (one capture each, before the
  averaging: the flicker).
- `perf.mjs --glcalls`: every WebGL call of the measured seconds counted by name, per drawn frame.
- `perf.mjs` also gives the engine's work per frame over 16.7 and 33 ms (`work.over16`, `work.over33`) and every frame's
  work in order (`workRaw`, in `perf.json` only). `--console`: the engine's log lines that say error, fail, traceback,
  abort or warn, and the switch lines (`OPENMW_ORTHROS_*`, `Orthros: ...`), from the page's load on (`log`, `logCount`).
  `--workers` (with `--profile`): every worker profiled too (the engine's pthreads — Lua, NIF, physics, navigation, work
  queue — and the data worker), one `perf-worker-<n>.cpuprofile` each (`workers` in the JSON: title, busy ms), through
  Chromium's debugging socket on a free local port. Each profiler costs its thread a little: compare runs made with
  the same flags.
- `python3 -I tools/openmw/frame-attr.py <out>/perf.cpuprofile --symbols <release>/e/<hash>/openmw.js.symbols
  [--hitches 25] [--top 30] [--callers <text>] [--callees <text>] [--json <file>]`: the busy ms per frame by bucket
  (osg-draw+GL, osg-cull, osg-update, lua-update, lua-sync, lua-ui, read-sync, wait, physics, mechanics, sound, gui,
  engine-other, other; each sample to the first bucket walking from its leaf up, a synchronous read anywhere first —
  the rules in its header); `--hitches N`: every busy stretch over N ms with its top functions and one cause (its
  outermost specific frame), then a table by cause. A worker's profile reads the same way (its waits apart: `wait`).
  The frame count comes from `perf.json` beside the profile (`--frames` otherwise); the symbols must be the measured
  release's (a dev build's own).

### The frame's draw and cull bookkeeping: engine orthros-r11 (2026-10-26)

The owner: "can the engine's drawing be improved, how, for what gain and how much work" — then all of it. Five changes
in `orthros-r11.patch` (on r10), each behind its switch (`?omwenv=<switch>=0`: the previous code, for an A/B in one
build), each written, reviewed adversarially and revised by its own agent, compiled, integrated, then checked by
pictures and an adversarial judge:
- **A, uniforms** (`OPENMW_ORTHROS_UNIFORMS`; OSG `include/osg/{State,Program}`, `State.cpp`, `Program.cpp`). r9 spent
  14-16 % of the engine's busy time applying uniforms, 10.7-12.3 % of it bookkeeping: `State::applyUniformList` walked
  the whole string-keyed `_uniformMap` and merged the leaf's list by string at every state change, and
  `PerContextProgram::apply(Uniform)` made up to four map descents per uniform. Now flat tables indexed by the uniform's
  name ID: the program's own active names only, each picked as the walk picked it (the leaf's, unless the stack's is
  OVERRIDE and the leaf's not PROTECTED), applied through a slot per location (pointer and modified count compared as
  before). The same `glUniform*` calls, in another order (distinct locations). A StateSet listing a uniform under
  another name than its own (no OSG API does) falls back to the map walk, logged once. Checked off the engine: 400
  random sequences of 4,000 operations (pushes, pops, OVERRIDE/PROTECTED, relinks, resets…), the same GL calls.
- **B, the GL glue** (`OPENMW_ORTHROS_GLGLUE`; `wasm-build/orthros-gl.js`, a `--js-library` over the hottest entry
  points, the originals kept for the switch): one heap view a call instead of `growMemViews()` at every element; and
  Emscripten's `glBindVertexArray` asked `getParameter(ELEMENT_ARRAY_BUFFER_BINDING)` at every VAO bind (~390 a
  frame, a WebGL getter each) — the glue now keeps each VAO's element buffer itself.
- **C, light lists** (`OPENMW_ORTHROS_LIGHTCACHE`; `components/sceneutil/lightmanager.*`): the light-list StateSets
  and their two uniforms were built anew every frame for every distinct list; they are kept between frames (two per
  list, one per update's parity), their elements rewritten in place. The same lights, the same values. (My first
  estimate counted the whole scene's cull under `LightManagerCullCallback` — 13-14 % inclusive; the lists themselves
  were ~1.5 %.)
- **D, buffers and the GUI's arrays** (`OPENMW_ORTHROS_VAO`; OSG `BufferObject`, `myguirendermanager.cpp`):
  `GLBufferObjectManager::flushDeletedGLObjects` walked every buffer set ever made, each frame — one per profile
  (target, usage, exact size), never removed, so the walk grew with the session (1.0 % of busy time at the start of a
  minute, 2.1 % at its end): now only the sets given an orphan since their last flush. MyGUI enabled its three vertex
  arrays again for every batch (~260 `enableVertexAttribArray` a frame): once per draw.
- **E, light buffers sized** (`OPENMW_ORTHROS_LIGHTUBO`; `lightmanager.cpp`): each list's `LightBuffer` uniform holds
  its lights instead of `max lights` (16) matrices. Small. The uniform buffer the name promised is not possible here:
  OSG binds uniform blocks from GL 3.1 only (WebGL2 reports ES 3.0), clustered lighting needs GLSL 4.30, and a buffer
  per object would need as many calls.

Pictures (`frame-compare.mjs morrowind-goty-en`, each switch off against all on, and all off against all on; day,
night, interior, 4 captures averaged; the reference's own repeat as the noise): every view within the noise, no pixel
off by more than 24 in a channel, judged equivalent by an adversarial judge looking at the pictures (the interior's
differences are its lights' flicker, the day's an NPC or the first capture still settling — present in the repeats
too). Smoke: `check.mjs` goty-en and Vanilla+ FR, `keys-check.mjs`, all switches off in the world. WebGL calls a frame
(Seyda Neen, mid): 5,027 → 4,507 — no `getParameter` (403), no `enableVertexAttribArray` (263).

Measured (dev build of r1-r9 + r11, scratch server, `perf.mjs morrowind-goty-vanilla-plus-fr --query tier=mid
--discard --seconds 60`, all on and all off alternated, load 9-33):

| run | fps | engine work p50 / p90 / p99 | draw phase | gaps over 100 ms |
|---|---|---|---|---|
| all off 1 / 2 / 3 | 22.4 / 21.2 / 22.4 | 14.1 / 17.3 / 15.0 — 20.0 / 21.0 / 19.6 — 30.5 / 34.8 / 27.5 ms | 9.5 / 8.9 / 6.4 ms | 6 / 5 / 4 |
| all on 1 / 2 / 3 | 21.4 / 22.0 / 21.9 | 12.9 / 11.5 / 11.5 — 16.8 / 16.8 / 16.1 — 28.1 / 26.4 / 30.5 | 3.5 / 2.5 / 2.8 | 5 / 4 / 6 |

Profiled pair (the same series): the engine's busy time 20.1 → 15.6 ms a frame (−22 %): uniforms 3.0 → 1.0 ms
(A), the buffer flush 0.38 → 0.06 ms (D), `growMemViews` 0.4 ms → negligible and `bigintToI53Checked` halved (B),
`pushLightState` 0.30 → 0.14 ms (C). One switch off at a time (single runs): A off 13.8 ms p50, C 11.6, D 11.9, E 13.2
(load 13: noise); B's run fell in a load of 78 and does not count. The fps does not move here: in this headless
SwiftShader set-up the frames are paced by the GPU process's own work (SwiftShader's vertex processing, rasterization
discarded or not — "Frame time" above), not by the engine; on a real GPU the engine's work is what decides 60 Hz against 30 (the owner's laptop: ~20 ms of work on
r8, so ~16.7 is the line). Left: the cull (~22 % of the busy time), Lua's addons (~7 %), the draw's GL calls
themselves.

The release `openmw-web-v1.5.3-orthros-r11` (r1-r10 + r11, `build.sh`, files pinned in `lock.json`; engine
`fb15db671fdf`) checked on a scratch server (`dev-serve.sh`) before the switch: `check.mjs` goty-en and Vanilla+ FR,
`keys-check.mjs`, pictures all off against all on (day 3.62 against a noise of 3.62 — the first reference capture
settling —, night 0.03 / 0.82, interior 0.57 / 0.96), Vanilla+ FR mid with r10's announced reads: engine work p50 / p90
/ p99 16.8 / 21.5 / 27.6 ms all off, 12.3 / 17.0 / 24.0 all on. Switched on 2026-10-26 (restic snapshot before): set
`"engine": "openmw-web-v1.5.3-orthros-r11"` in the `openmw` object of each version of `data/games/morrowind/manifest.json`
and `data/games/morrowind-vanilla-plus/manifest.json`. Back to r10 the same way; one change off for everyone without a
rebuild: not provided (the switches are for measuring, from the address).

### Announced reads (2026-10-26)

A cell load was 340 serial synchronous reads, one round trip each (37 s at 1.8 MB/s, 90 ms). The page's side of the
fix is in `src/ports/openmw/streamfs.js`: `window.orthrosWillRead(list, label)` (records `enginePath\x1Foffset\x1Fsize`
separated by `\x1E`, label `meshes|textures|terrain:<x,y | interior id>`) hands what the engine is about to read to
the game data (`GameData.want`: fetched in parallel, light copies on a link that is not fast), and
`window.orthrosReadWait(timeoutMs)` waits once for all of it. The engine side (its scene changes announce the cells'
models and land textures, wait, then the textures the models name) is a patch of its own. Contract and rules:
docs/slow-network.md "Announced reads (2026-10-26)".
A big announced load (its textures more than 2 s of the link) reads their light copies first on a fast link too, the
files after the load, made sharp in place (`orthros_file_updated`, paced); `?lightfirst=0` on the play or engine page
turns it off: docs/slow-network.md "Big loads light first (2026-10-27)".

### Anticipated places (2026-10-26)

Announced reads leave the load's own download (Ald'ruhn from a save: ~4.5 s of 8.3 s at 1.8 MB/s; everything for a
player on a new device). The page fetches that place before the click, while the engine boots and the player sits in
the menu:
- **Learning** (`streamfs.js` `learnPlace`): each announced batch with a place (`meshes|textures|terrain:<place>`) is
  posted to `POST /api/places/<manifest>` as `{ session, place, kind, records: [[treePath, start, end), …] }` — the
  files themselves (never `.light/`: each player's link picks), archives by their member's range. The server keeps a
  place's set (the engine's own computation, exact, unlike demand reads) and `GET /api/places/<manifest>?place=<key>`
  lists it (`[[path, start, end]]`, or `{ path, start, end }`; bare or under `list`); the page asks 256 MiB of the
  files' own bytes at most (8192 entries). Multiplayer loads are learned too.
- **Prediction** (`src/ports/openmw/save-place.js`, no engine): the saves of `/userdata/saves/<character>/` and
  `/userdata/data-home/openmw/saves/<character>/` parsed — TES3 `FORM`, `SAVE` (player, `TIME` played, the cell's
  display name: no key), then `PLAY`'s cell just before `LKEP`: format > 26 a `NAME` RefId (tag 6 exterior `x,y`,
  tag 2 the interior id), up to 26 `SPAC`/`CIDX`. The key is the engine's label's place: `x,y` (the grid centre
  `changeCellGrid` announces for — the player's cell), the interior id ASCII-lowercased (`Misc::StringUtils::lowerCase`);
  Ald'ruhn's real save gives `-2,6`, parsed in under 1 ms. A save is read in place (`FS.open`/`FS.read`): its records'
  16-byte headers, the `TES3`, `SAVE` (without its `SCRN` screenshot) and `PLAY` bodies — not the whole file (the cells'
  records come before `PLAY` from format 33). The save chosen (`chooseSave`): the remembered place
  (`localStorage['orthros.place.<manifest>']` = `{ place, at }`: the session's first announced load that is not terrain
  — the game started from the menu, not the cells walked through after it nor a terrain read-ahead (the view point's
  cell) —, and each save the engine writes at its date — the saves folders looked at every 5 s) when a save is there
  and no save is newer than the hint (a save written since, in another tab or on another device, says more); else the
  newest by date, else the most time played when the account's restore came without dates. The account's copy keeps
  each file's date (`cloud.js`: `mtime` per file, `FS.utime` on restore; `window.orthrosProfileRestored` only when a
  file came back without one — a copy uploaded by an earlier page). Not in multiplayer (`window.__omwMPEnabled`: the
  server decides where the player spawns; neither the prefetch nor the hint).
- **Prefetch** (`streamfs.js` `anticipate`): once `window.__idbfsReady` resolves (IDBFS populated, and the account's
  restore: `cloud.js` answers the populate after it), the engine's first frame drawn and the game data ready, the saves
  parsed, `GET /api/places`, then
  `GameData.want(entries, { prio: 'place' })` → the data worker's `wantPlace` → `HttpBackend.wantList(…, { prio:
  'place' })`: the same units and deduplication as announced reads (a second call is cheap), but background turns of
  `PRIO.place` — after the game's reads, a load's, the learned launch set (and a startup set), before the rest of the
  learned order (`PRIO.learned`: other places' reads) —, never urgent nor `forLoad` (a load's silence holds them),
  `PLACE_REQUESTS` (8, 2 thin) at once and only while no announced unit waits for its request, `p=1` (not learned), no
  wait of the link's, outside the engine's wait window (no batch number). A load of that place takes them over: a unit
  still queued becomes an announced one (the announced queue in the list's order, under its window — not all of a
  place's queued units at once past it), one waiting for its turn on the link a load's own (`NetLink.forLoad`: past the
  silence by the link's rules, not urgent); a parked read promotes as any. A save loaded elsewhere loses nothing — its
  load announces its own.
  `StreamFS.place()`: `{ place, why: 'hint'|'newest'|'time', save, listed, asked, atMs }`; counters `placeWants`
  (`GameData.snapshot()`), `stats.place*` and `NetLink.bgBy.place`.
- **After the boot**: the saves are read, the set asked of the server and handed to the data system only once the
  engine draws its first frame (`Module.__omwRunning` defined; 180 s at most). Asked while the engine booted, its requests delayed
  the engine's first read by 1.7 s (warm store) and 4.5 s (new device) on an otherwise free link — the page's and its
  worker's time — and the menu came that much later; after the first frame, the boot is unchanged.

**Measured** (`tools/openmw/place-load.mjs --mode save`, Ald'ruhn `-2,6` from the menu with F9 after 10 s, 1.8 MB/s,
90 ms, dev engine r10dev3 with its brotli siblings, `--teach 1`: one earlier session loaded the place — which also
teaches the learned order those files; stage 2 = commit b582377, same tool and engine):

| profile | code | boot → menu | place bytes before the key | key → in world | frozen | announced waits | serial reads |
|---|---|---|---|---|---|---|---|
| warm store | stage 2 (2 runs) | 20.6 / 19.7 s | — (learned order: 6.3-6.5 MB in the menu) | 5.8 / 5.9 s | 4.8 / 5.0 s | 3, 930 ms (65 units, 1.5 MB) | 1 / 0 |
| warm store | stage 3 (2 runs) | 21.4 / 20.4 s | 8.9 MB, done 3-4 s into the menu | 5.1 / 4.8 s | 4.2 / 3.8 s | 3, 5-6 ms (0 units) | 0 / 1 |
| new device | stage 2 | 55.7 s | — | 13.3 s | 12.3 s | 3, 5308 ms (407 units, 9.1 MB) | 5 |
| new device | stage 3 | 55.4 s | 19.6 MB (12.3 in the menu), 8 in flight at the key | 8.7 s | 7.6 s | 3, 2331 ms (0 new units) | 3 |
| warm store | stage 3 final (hardened, 1 run) | 20.1 s | 8.9 MB, done 6.1 s before the key | 4.9 s | 4.0 s | 3, 7 ms (0 units) | 0 |
| new device | stage 3 final (hardened, 1 run) | 54.8 s | 20.0 MB (12.6 in the menu), 8 in flight at the key | 8.6 s | 7.6 s | 3, 2140 ms (139 units taken over from the place's queue, 3.3 MB) | 2 |

Untaught (the teach runs: nobody loaded the place before), both stages load in 9.5-9.6 s warm and 12.2-13.9 s on a new
device. With a warm store the place is in about 4 s after the menu appears (5.5 s after the first frame); on a new device
5.8 MB of it were still to come at the key (the menu's link ran at 1.3 MB/s): a menu of about 15 s. The engine's list
varies between loads (NPCs' equipment: ~30 weapon textures, 0.5 MB, not in the taught set once), which the union of the
next sessions' lists absorbs.

### In play: crossings and doors (2026-10-28)

The network's part in play, measured first (engine r11, no engine change), then led from the page where it pays.

**Measuring** (`tools/openmw/place-load.mjs`, two in-play scenarios beside `coe` and `save`, both on a warm profile of
their start cell through the player's-link proxy):
- `--mode glide` (G): perf.mjs's glide (`--glide dx,dy[,speed[,z]]`, default north at 300 u/s, a run; `--seconds`
  150) from `--start`'s centre; each cell entered (view.lua's report) is a crossing: its frame gaps (longest, over
  250 ms), the game data's counters over it (`stallMs`, `syncFetches`, `wantWaits`, `wantWaitMs`: the probe samples
  `__streamfsStats` twice a second), its network reads (demand, read-ahead, announced: count, MB, the files) and how
  much of them the learned places named (`inPlaceMB`: the sets of the entered cell and of the next one, keys `x,y` —
  the engine announces a cell's key as it enters it, but its preload fetched that row ~4 s before, in the window
  before; `inAnyMB`: any place's; a read touching a learned record counts whole — the data system fetches blocks
  larger than the engine's records).
- `--mode door` (D): the console's `coc "<--interior>"` from `--start` (default Balmora `-3,-2` and its cornerclub,
  the one interior the live learned places know) — a door's own path, `ActionTeleport` into `changeToInteriorCell` —,
  timed from its Enter to frames flowing inside; `--lead s`: the interior's learned set (meshes and terrain, as the
  page's guesses) asked at the place's priority that long before the Enter — the upper bound of a lead. `--interior`
  is lowered as the engine lowers its keys (`engineLower`: ASCII only, an accented capital kept).
- `--query name=value`: added to the engine page of the measured runs, not the taught ones (`--query lead=1`: the A/B
  below — both arms taught the same way); `--teach-query name=value`: added to the taught ones (what a session with
  the switch teaches the next ones).

**Measured** (2026-10-28, `morrowind-goty-en`, r11, warm profile — 120 s in the world at the start cell at 1.8 MB/s —,
the live learned state and br-cache copied, 2 runs each; SwiftShader, so frame gaps over 250 ms also count the
software rasterizer — `stallMs` and `wantWaitMs` are the data's part):

| scenario | link | frozen / longest gap | data stall | announced waits | network reads | learned covered |
|---|---|---|---|---|---|---|
| glide Seyda Neen → -2,-4 (5 crossings, 150 s) | 300 KB/s | 1.2 / 0.7 s | 3.1 / 2.5 s (≤ 1.6 s a crossing) | 0.4 s | 6.1 / 5.6 MB | 0 (no exterior learned for this version) |
| same | 85 KB/s | 6.5 / 6.3 s | 24.1 / 19.2 s (town edge 6.8-11.6 s, wilderness 0.5-10.9 s) | 2.2 s | 8.0 / 6.7 MB | 0 |
| door, Balmora cornerclub, no lead | 1.8 MB/s | 1.47 / 1.47 s (steady 6.0 / 5.6 s) | 0.1 s | 0.61 s | 4.3 MB | — |
| same, set asked 5 s before | 1.8 MB/s | 1.48 / 1.57 s (5.7 / 5.7 s) | 0.1 s | 0.32 s | 3.3 MB (0.35 MB ahead) | — |
| door, no lead | 300 KB/s | 2.68 / 2.73 s (steady 7.0 / 7.7 s) | 0.1 s | 2.50 / 2.70 s | 2.0 MB | — |
| same, set asked 10 s before | 300 KB/s | 1.60 / 1.35 s (5.3 / 5.0 s) | 0.1 s | 1.20 s | 1.05 MB (0.35 MB ahead) | — |

Reading: at 1.8 MB/s neither costs the player anything the network could save (a door's frozen frame is the engine's
CPU; its 0.6 s of waits overlap it). At 300 KB/s a crossing waits ≤ 1.6 s and a new interior ~2.6 s, of which a
right guess 10 s ahead saves ~1.2 s frozen and ~2 s to steady for 0.35 MB (the town's meshes are mostly stored
already). At 85 KB/s crossings cost 19-24 s of stalls in 150 s, frames held up to 6.5 s. The files read are
`Morrowind.bsa` ranges and the engine's own `_engine/openmw-web-assets.bsa` (1.3-1.6 MB a crossing). The learned places
covered none of it: the live learned state holds one interior and no exterior of this version (six exteriors of
Vanilla+ fr) — every crossing announced and posted teaches its row, so coverage grows with play.

**The lead — built, measured, off by default** (`src/ports/openmw/place-lead.js`, `streamfs.js` `leadInPlay`; no
engine change; `?lead=1` on the engine or play page turns it on):
- **Next row**: a crossing from a cell into its neighbour (view.lua's `orthros.cell`) guesses the cell after it, the
  same way (`nextRow`): the grid centre the engine will announce next, a whole cell's walk ahead (~27 s at a run)
  where the engine's own preload starts ~4 s before the crossing. A step that is no neighbour's (a teleport, a door,
  a load) guesses nothing.
- **No door guess**: a door read from the player's surroundings (view.lua: the nearest teleport door's destination
  within ~256 units, `iMaxActivateDist` being 192) gives 0.2-1 s of warning at a walk or a run, where the door runs
  show a guess needs ~10 s at 300 KB/s to save anything (nothing at 1.8 MB/s) — and every door passed in a street
  would spend the session's bounds (`LEAD.places`, `LEAD.sessionBytes`) the row guesses need. Tried, then removed; a
  door lead needs a warning of seconds (the player's heading toward a door from afar), measured first with
  `--mode door --lead`.
- **Fetch**: `GET /api/places/<manifest>?place=<key>`, then `GameData.want(…, { prio: 'place' })` — the link's idle
  time only, below the game's reads, a load's and the launch set; a load of that place takes the queued units over.
- **Rules (thin links: no waste)**: a guess takes its set's **meshes and terrain only, never textures** (`LEAD.kinds`:
  a wrong guess on Vanilla+ textures costs tens of MB; the load reads its textures, light first on a link that is not
  fast); at most `LEAD.bytes` (8 MiB of the files' own) a guess, each place once a session, `LEAD.places` (64) guesses
  and `LEAD.sessionBytes` (64 MiB) in all; a place never learned costs one small GET. Polled every 500 ms once the
  player is in the world; not in multiplayer (no Orthros script there: no reports). `StreamFS.leads()` →
  `{ guessed, bytes, last }`.

**Measured, the row lead** (glide at 85 KB/s as above, `--teach 1`: one earlier session — lead off, the arm's own code —
crossed the same rows, which teaches the places and the learned order; then the measured runs. Final A/B, 2026-10-28:
the arms interleaved A, B, A, B, then C, one pristine learned state and one warm profile for all; each A and B run had
a teaching session of its own, C's two runs followed one teaching session together (one invocation, `--runs 2`: the
same setup, not two independent ones); A is the code before this change, 5aa05be; B this change, lead off; C this
change with `--query lead=1`. B and C ran before `place-lead.js` became lazy-loaded (`streamfs.js` changed after the
last run): B's page loaded the module and left it unused; the shipped page, lead off, does strictly less — it does not
load it. The server was loaded, so the warm boot to the world took ~80 s in every arm. These are SwiftShader runs too):

| arm | data stall (whole run, 150 s; `streamfs.toEnd.stallMs`) | first crossing -2,-8 out of Seyda Neen | the 4 other crossings | longest gap | network reads in crossings |
|---|---|---|---|---|---|
| untaught (the session that teaches: A, B, C) | 28.3-41.4 s (A 28.3 / 41.4 / 34.4, B 40.9 / 35.5, C 37.1; its five crossings 27.3-37.5 s of it) | 5.5-13.3 s | 21-26 s | 7.9-11.3 s | 9.5-11.4 MB |
| A, before (\*\*) | 13.9 / 6.1 / 13.7 s | 12.9 / 4.8 / 13.6 s | 1.0 / 1.3 / 0.1 s | 11.3 / 1.5 / 3.6 s | 3.2 / 3.3 / 3.3 MB |
| B, this change, lead off (\*) | 11.5 / 7.1 s | 11.3 / 7.0 s | 0.1 / 0.1 s | 4.2 / 2.9 s | 4.3 / 4.3 MB |
| C, this change, lead on | 13.1 / 6.6 s | 10.3 / 4.9 s | 2.9 / 1.7 s | 4.2 / 3.0 s | 3.6 / 3.3 MB |

(\*) before `place-lead.js` was lazy-loaded (see above): what ships with the lead off does strictly less.
(\*\*) the third A run is from an earlier session interrupted in the middle, with the same setup. B's 1 MB more is
`_engine/openmw-web-assets.bsa` at the first crossing (1.51 MB against 0.46). It came in both B runs, each taught by
its own session, but not in C's two (taught by one session), whose page is the same up to that crossing (the lead
guesses only after it). Likely a difference in what the teaching session left rather than code — not established.
Its stall is not above A's.

A first, smaller pair of runs (same setup, earlier that day) gave a taught stall of 3.0 / 3.3 s with the lead off and
1.9 / 2.0 s with it on. Once a session had taught the rows with the lead on (and with the page still guessing doors),
the stall was 11.0 / 9.3 s (longest gap 14.0 / 12.9 s). That last run was made with an earlier version of the tool and
was not reproduced (`--teach-query lead=1`: arm D, not run). In this final A/B the first crossing dominates and swings
between 4.8 and 13.6 s in every arm, so a 1 s difference between arms is noise.

**Conclusion:** the measuring tools ship (`place-load.mjs --mode glide|door`, `--query`, `--teach-query`), and so does
the lead's code, **off by default**:
- **The default changes nothing for players.** With the lead off (B), the page asks for nothing more: no
  `/api/places` GET, no `want`, so nothing extra to learn. `place-lead.js` is not even loaded unless `?lead=1` (tests:
  `openmw-streamfs.test.js`, no calls and `leads()` null without it) — made so after the A/B, which ran B with the
  module loaded and unused: strictly less than what was measured. View.lua is unchanged: the door report was tried
  and then removed. B measures as A within noise.
- **The lead has nothing to win once one session has crossed the rows.** The learned order (`/api/prefetch`, fetched
  in the background after the launch set) brings the rows before the player gets there: the 4 later crossings stall
  0.1-1.3 s in all with the lead off. What remains is the first crossing out of Seyda Neen, which no direction predicts.
  With the lead on (C), those 4 crossings stalled more, not less (1.7-2.9 s: at 85 KB/s the guess for -2,-7 shares the
  link with the end of the first crossing's reads). Untaught, there is no learned set to fetch.
- **The door lead:** its upper bound (a right guess 10 s ahead) saves ~1.2 s frozen at 300 KB/s and nothing at
  1.8 MB/s. A player at a door gives under a second of warning.
- **When to look again:** when the learned order no longer covers the world (a server with many players' places
  rather than one path). Before that, reproduce the lead-on teach row (arm D). Then run the A/B again:
  `place-load.mjs --mode glide --teach 1 --query lead=1`, with and without `--teach-query lead=1`, and
  `--mode door --lead 0|5|10`.

### The boot's idle time: the gateway's lists, the link after the engine's package (2026-10-27)

Two waits before the engine's first game read, neither the link's:
- **The gateway's lists.** The gateway builds `mwdata-manifest.json` (a walk of its game tree, 7392 files, 466 KB) and
  `mwdata-mods.json` (a walk per mod, 764 KB) on the first request after it starts, then keeps them in memory until
  those folders change (`mwdata-routes.ts`, `manifest_built` in its journal). The first player after each restart (every
  deploy restarts the gateways) paid 1.5-2.8 s each, in series (owner, 10-20: 1.86 + 1.50 s; 10-26: 2.83 + 2.80 s);
  warm, 0.02-0.10 s. Rules:
  - `tools/openmw/server.mjs` builds them as the gateway starts (`warmGatewayLists`, src/host/openmw.js): the manifest
    polled every 500 ms on its localhost port until it answers — 200, or a final 404 (a gateway that does not serve the
    data: its `deliveryModel`), not retried —, refused connections and 5xx waited for, given up after 120 s or once the
    container exits; then the mods' list (404: no mods). One `openmw.lists_warm ...` line in the unit's journal with
    both times. The same walk as a player's request, once, at the start: nothing else changes in the gateway.
  - The engine page asks both lists together (`withModsListEarly`, applied by `openmwWebText`): `mwdata-mods.json`
    fetched beside `mwdata-manifest.json`, its answer (`window.__orthrosModsList`) taken once by `mountServerMods` —
    which asked it only after mounting the manifest's files. Not with `?nomods=1`, and only on a page that has both
    fetches (else nothing would take the answer). The early request is marked handled when made (a no-op `catch`): a
    network failure before `mountServerMods` awaits it (seconds later, or never: no manifest) is not an unhandled
    rejection — the page's handler would log it as an error, ship it with the client log and open the log with `?hud=1`
    —; `mountServerMods`' own `try` still turns it into "no mods", as before.
- **The link after the engine's package.** The game data opens while the engine's package downloads (the manifest's
  fetch, `StreamFS.init`), and the data worker is ready 20-25 s before the package ends at 500 KB/s; then the engine's
  main() initialises for 5-8 s before its first read, the link idle (500 KB/s, 90 ms: package end 35.0 s, first `/gamez`
  43.9 s; 85 KB/s, 150 ms: 5.2 s). What the way to the menu reads first is the head of the learned order (Morrowind.esm,
  the expansions, the archives' headers: ~48 MB of wire for Vanilla+). Rules:
  - `GameData.prefetchNow()` (src/vfs/data-client.js, shared: any page whose engine goes quiet on the link before its
    first read) asks the data worker to load the learned order now (`prefetchNow` in data-worker.js) — only on a cold
    store: less than half (`LAUNCH_COLD`) of the launch set's bytes here (every part's `launchSet` as this link reads
    it, `setBytes`): a new device, a cleared store, an updated version (its files' mtimes changed). A warm store waits
    for the first read as before (`prefetch: 'first-read'` kept) even when it misses part of the set — the server's
    set is a majority vote that holds the first place most sessions reach (not this player's save), it grows between
    visits, and a light copy or the file is listed by the link's speed, so a returning store rarely holds all of it:
    requests beside the boot delayed the engine's first read by 1.7 s (warm store) and 4.5 s (new device) —
    "Anticipated places". A version with no
    learned order: nothing. With `'start'`/`'startup'` (the pass already runs): nothing.
  - The page calls it when the engine's package is in: `onPackageLoaded(Module, fn)` (src/vfs/emscripten-files.js,
    shared) wraps `Module.removeRunDependency` — an accessor, so it holds whether installed before or after the engine's
    script sets that function — and calls `fn(name)` when a file_packager dependency `datafile_<name>` is removed (its
    download and unpacking over). `streamfs.js` installs it once its shared modules are loaded (a few KB, long before the
    package's MBs); a package in before the game data opened (a fast link) asks at the open.
  - While the pass runs before the engine's first read (`W.boot`), its progress (`ahead`, `launch`) is told to the page
    every 5 s (`BOOT_TELL_MS`) instead of every 1-2 s: each post is a task on the page's thread (and the parent page's,
    the header's pill) the boot shares. The first read ends it.

**Measured** (2026-10-28, before = 93391eb, this change's base, after = the change; same pristine learned order and
frozen precompressed units, `--lang fr`, the OpenMW lean2 package; a machine at load 20-30, one run at 115):
- Gateway lists, a scratch gateway (`tools/openmw/server.mjs morrowind-goty-vanilla-plus-fr --port 28190`, scratch
  state; the live `orthros-openmw@` units untouched), curl 25 s after the start: before, the first request built them —
  0.51 s (manifest) and 0.76 s (mods), `manifest_built` logged at that request —, the second 2.7 / 5.0 ms; after,
  `openmw.lists_warm manifest 200 in 555 ms, mods 200 in 850 ms (2425 ms after the start)`, the first curl 4.1 / 4.8 ms.
  The scratch cold times are below production's 1.5-2.8 s (its files in the page cache of the live gateways); the
  production check is the first `mwdata-*.json` in Caddy after each restart.
- New device (`tools/data-matrix.mjs`, the proxy's log; times from the navigation):

| link | code | package end | first `/gamez` | engine's first read | idle link | `/gamez` before it | first frame | shown | playable | demand wait |
|---|---|---|---|---|---|---|---|---|---|---|
| 500k:90 | before (2 runs) | 32.8 / 32.9 s | 41.2 / 39.8 s | 40.8 / 39.5 s | 8.4 / 6.9 s | 0 | 177.9 / 175.1 s | 183.0 / 181.2 s | 203.2 / 198.6 s | 12.2 / 11.7 s |
| 500k:90 | after (3 runs) | 32.9 / 32.8 / 32.8 s | 33.5 / 33.4 / 33.4 s | 39.0 / 40.3 / 39.7 s | 0.6 s | 2.0 / 2.4 / 2.2 MB | 210.0 / 163.3 / 163.9 s | 230.8 / 168.5 / 168.3 s | 255.3 / 190.6 / 188.3 s | 7.8 / 10.6 / 11.2 s |
| 7m:75 | before (3 runs) | 6.4-6.8 s | 8.1-8.6 s | 7.8-8.3 s | 1.6-1.8 s | 0 | 42.9 / 41.2 / 47.7 s | 49.3 / 46.6 / 57.6 s | 60.8 / 55.8 / 68.8 s | 2.9 / 2.3 / 2.6 s |
| 7m:75 | after (4 runs) | 6.6-6.8 s | 8.1-8.3 s | 8.1-8.4 s | 1.4-1.7 s | 0-4 KB | 49.9 / 47.5 / 48.4 / 47.2 s | 57.2 / 53.0 / 58.2 / 51.5 s | 69.1 / 64.9 / 68.3 / 63.2 s | 2.7 / 2.7 / 2.6 / 2.3 s |

  At 500 KB/s the pass starts 0.2 s after the package (its `/api/prefetch` at 33.0-33.1 s instead of 39.5-40.8 s) and
  the link stays busy through main(): 2.0-2.5 MB of the order in before the engine's first read, which comes at the
  same time (6.1-7.5 s after the package, before 6.6-8.0 s: no boot contention on a new device). First frame and
  shown 11-15 s earlier in two of three runs, more than the ~4-5 s of link the 2.2 MB stand for (the rest is the
  machine's noise); the third (210 s) is the slowest of all, the machine's load at the time (its demand wait the
  lowest, 7.8 s). Read as: the idle 7-8 s filled, a gain of a few seconds to the menu, not yet resolved from the noise. At 7 MB/s the engine reads 1.3-1.8 s after its package, as the order arrives:
  nothing to fill (`/gamez` before the first read 0-4 KB); the first three pairs (before then after) put the after
  runs 5-7 s behind, the fourth, its order reversed, 47.2 against 47.7 s — the order of the runs, not the code. One
  before run at 500 KB/s (the base tree) got no game (the engine's download failed, "network error"), one at 7 MB/s
  ran at load 115 (first frame 120.7 s): both left out.
- Warm store (`tools/openmw/place-load.mjs --mode save --profile warm --runs 2`, 1.8 MB/s, 90 ms, the engine from the
  HTTP cache, Ald'ruhn by F9 after 10 s in the menu): menu 9.4 / 9.6 s before, 9.6 / 10.0 s after; first frame
  7.7 / 8.3 against 8.2 / 8.5 s; the engine's first read 5.8 / 6.4 against 6.4 / 6.8 s, in both 2.8-3.8 s after the
  manifest's fetch (which itself moves 2.9-3.6 s with the page's CPU); no `/gamez` before it (the store warm: no pass),
  only the `/api/prefetch` request 0.6-1.2 s earlier; key → in world 8.8 s in all four, frozen 7.7-7.9 s. The menu is
  faster than the 20 s of "Anticipated places" (the engine from the HTTP cache, the page's boot cut since).
- The lists asked together: on the warm runs `mwdata-mods.json` leaves with the manifest (before: 0.6 s after it).
- `tools/openmw/check.mjs morrowind-goty-vanilla-plus-en --lang fr` on a scratch server of the change: ok, 1653 draws.
  Not measured: 85 KB/s (a run is 15-30 min on this machine's load).

### A loop over the engine's frame: engine orthros-r12 (2026-10-28)

The owner: "are more engine improvements possible? Find them and make them, in a loop." A workflow looped: profiles of
four scenarios on the current release (Vanilla+ FR walking at Seyda Neen, gliding across six cells, Balmora's streets,
goty-en in Balmora's South Wall Cornerclub; `tools/cpuprofile-report.py`: wasm frames named, self/inclusive time,
callers and callees, ms a frame), five finders with their own lens (cull, draw, non-render CPU, long frames, the page),
a selection challenged by a skeptic, then for each pick a patch behind its switch, an adversarial review and a revision,
a compile check, the build, pictures with an adversarial judge, and a profiled measure. A fault of the loop's script
(the integration's ids compared as text) left its first three rounds unverified; the ten patches of rounds 2 and 3
(round 3 re-did round 1's picks) were then integrated, verified and measured together, and a skeptic kept seven.

`orthros-r12.patch` (on r11), each change behind its switch (`?omwenv=<switch>=0`: the previous code):
- **`OPENMW_ORTHROS_REFATOMIC`** (OSG `Referenced`): OSG's reference counts took a pthread mutex per object (OSG's
  configure found no atomics for the build): atomic counts instead. Mutex functions 0.39 → 0.02 ms a frame.
- **`OPENMW_ORTHROS_UNIFORMVALUES`** (OSG `Program`): r11's per-location slots remember the value last uploaded; a
  `glUniform*` whose value did not change is skipped (733 of ~1,630 uniform calls a frame were). 0.82 → 0.66 ms.
- **`OPENMW_ORTHROS_SHADERLOG`** (OSG `Shader`, `Program`): a shader's or program's info log read only after a
  failed compile or link (it was read every time: a synchronous WebGL call in the frames that build shaders).
- **`OPENMW_ORTHROS_GUIBATCHES`, `OPENMW_ORTHROS_GUIUPLOAD`** (`myguirendermanager.cpp`): MyGUI's batches rewritten in
  place instead of cleared and copied, and an unchanged vertex buffer not uploaded again. 0.58 → 0.49 ms.
- **`OPENMW_ORTHROS_ALCACHE`** (`wasm-build/orthros-openal.js`): no listener AudioParam written with the value it has,
  the Doppler work skipped when nothing it reads changed. 0.50 → 0.26 ms.
- **`OPENMW_ORTHROS_IDLECALLS`** (`scriptscontainer.cpp`, `mwgui/layout.cpp`): the Lua scripts' timer pass not entered
  when no timer is due, a window title not re-captioned to the same text. 0.33 → 0.11 ms.
- **`OPENMW_ORTHROS_TERRAINREADY`** (terrain `ChunkManager`/`QuadTreeWorld`, `esmterrain::Storage`, `LandManager`,
  `TextureManager`): a terrain preload's chunk is put off, as r5 does for meshes, until its zone's LAND records (a ring of
  cells: normals and blend maps read the neighbours) and its layers' textures are in the page; before, the chunk read them
  synchronously inside the preload slice. Crossing six cells: longest engine frame 655-729 → 183-231 ms, engine frames
  over 100 ms 9-11 → 3-5, the data's waits 2.2-2.3 s → 0.15-0.25 s (that pair also had three of the dropped switches
  off).

Left out: `STATEGRAPHS` (OSG's StateGraph pruned one cull later: never compared by pictures — the verifier got no
browser), `PRELOADREADY` (a cell preload waiting for the `.kf` and collision files: no gain of its own measured),
`CELLREADS` (a cell's CELL records read in one batch: no gain of its own, the highest risk of the ten). Still to look
at, found by the loop and not yet done: StateGraph clean/prune together, the clock glue (`emscripten_get_now`'s BigInt),
tooltips re-laid out while the crosshair rests, music decoded on the page's thread (FFmpeg MP3, 0.14-0.30 ms),
`KHR_parallel_shader_compile`.

Measured on the development build of r1-r11 + the ten (scratch server, `perf.mjs morrowind-goty-vanilla-plus-fr --query
tier=mid --discard --seconds 60`, alternated, runs over load 24 thrown away and run again): all on against all off,
engine work p50 10.5 / 10.2 / 11.6 against 12.0 / 12.2 / 12.1 ms (−1.3 ms), p90 14.4 against 16.2 ms (means), p99
within the spread; the profiled runs' busy time 11.7-12.2 ms a frame. The announced reads of r10 (`place-load.mjs
--mode save`, Ald'ruhn at 1.8 MB/s and 90 ms, against r1-r11): no timeout, and the one read in series in either build a
region weather sound, as before.

### The masters light before the menu: engine orthros-r13 (2026-10-28)

The boot read Morrowind.esm, Bloodmoon.esm and Tribunal.esm whole before the menu (95 MB of the 137 MB thin launch
set). `orthros-r13.patch` (on r12) lets the page serve them light while the engine loads its content: their LAND
payloads and cell references' details zeroed in a copy of the same size and offsets (docs/slow-network.md "Content files
light before the menu" for the copy, the page's rules and the learned order), the files themselves read from the end of
the content load on, by the ranges each cell needs:
- `World::loadData` tells the page when it starts and ends (`VFS::orthrosContentLoad` → `globalThis.
  orthrosContentLoading` / `orthrosContentLoaded`, `src/ports/openmw/streamfs.js`); the release exports
  `orthros_content_light` (launch-set.js `CONTENT_EXPORT`: the server marks its versions' masters light only then — an
  r12 release reads them as before).
- A cell's ranges (`MWRender::orthrosCellRanges`: each content file's CELL context — its references —, an exterior's
  LAND context) are announced and waited for once before the loads that read them: a cell change (the grid's cells not
  active yet, an interior: `meshes:<place>`), the synchronous terrain preload (every chunk's cells and their ring:
  `terrain:<place>`), a saved game's load (its CSTA records' cells: `cells:save`, not learned); and between frames the
  loads that would read them are put off until they are in the page (an exterior grid cell's or a door destination's
  preload, an object paging chunk's list of models; r12's terrain chunks already wait for their LAND), as r5 does for
  meshes. `VFS::orthrosWillReadRanges` announces raw ranges of any engine file (`Manager::orthrosWillRead` goes through
  it).
- r12's terrain readiness (`TerrainStorage::orthrosLandReady`, its LAND range through `orthrosLandRange`) is answered by
  the page for the file's own bytes, never for the light copy in the page (`GameData.readable`).
- A cell's references listed by their ids only (`CellStore::listRefs`: `WorldModel::getPtrByRefId` / `getExteriorPtrs`
  go through every cell not loaded when a script names an object in none of them) are read from the light copies after
  the content load too (`VFS::orthrosContentIds` → `globalThis.orthrosContentIds(1|0)` around it, main thread only;
  `GameData.contentIds`): what the content load brought, instead of every cell's references fetched from the file one
  by one with the frame frozen.

Development build only so far (scratch; r12 now in `main`, the lock entry `orthros-r13` = r12's patches +
`orthros-r13.patch`, exports r12's + `orthros_content_light`, its files pinned once the release is built). Checked on it (`tools/openmw/dev-serve.sh`, local
link, `frame-compare.mjs morrowind-goty-en` against `?contentlight=0` — the masters read as they are all along —, which
now also reports each run's content mode and its requests of content files' light copies): the content load told
(light from ~3 s, loaded at ~6 s; 88-116 light requests), Seyda Neen's exterior, an open exterior (1,-4: terrain,
trees, rocks) and Arrille's Tradehouse the same pictures (mean differences 0.06 / weather only / 0.39-0.76 against the
repeat's 1.08 / weather / 0.28-0.58, no pixel over 24 apart from the open view's sky). Measured (2026-10-28, dev build
r13dev2 against r12, a new device, docs/slow-network.md "Content files light before the menu"): the menu -25 to -29 s
at 1 MB/s and -295 to -314 s at 85 KB/s (the masters 33 → 7-8 MB of wire), the New Game's first load +10-13 s / +37-52
s (its cells' land and references now read after the menu), playable still 12-19 s / ~260 s sooner; at 1.8 MB/s a
save's load frozen +0.2-0.6 s and a COE +1.0-1.4 s (the cells' bytes, no serial reads), the pictures the same.

### Serial reads the announces did not cover: scripts at the boot, distant chunks in play (2026-10-29)

Shipped: the scripts announced at the boot (page side, every engine). The distant-chunk put-off (an engine patch of the
dev build `r14dev`, numbered `orthros-r14.patch` in its scratch tree — **not** the `orthros-r14.patch` released on `main`,
"Lua beside the frame" below, which has no terrain code; called "the put-off patch" here) is **not shipped**: revised
for the first JSPI build (r20 now), then measured with its suspending reads (below, "Waits that yield to the browser": no better
than those alone, the page held longer) and dropped from `orthros-r20.patch`.

The owner's session of 2026-10-29 (Vanilla+ FR, warm store, Iris Xe — the `mid` tier —, ~2 MB/s; Caddy log): Chrome's
"page unresponsive" through ~200 serial demand reads ~80 ms apart before the menu and in the save's load (the Lua
scripts, localisation and quest data of mods added since the owner's last visit), then ~230 more ~10-30 s after the
announced load (meshes and light textures of distant objects). Attributed by engine stack (symbolized SYNCTRACE of
`place-load.mjs`, its owner analogue: a new device with the learned order of before that session, `?tier=mid`):
- **Scripts** (`LuaManager::initConfiguration`/`initPostLoad`, `loadScriptAndCache` and its `require` chains,
  `L10n::MessageBundles::load`, a script's `YAML::LoadAll`): ~70 reads at the boot, ~280 in the save's load
  (`StateManager::loadGame` → `ScriptsContainer::addScript`: every object's scripts loaded anew), 30 more in play.
  No announce covers them; the learned order has a new mod's files only after a session read them.
- **Distant chunks**: view-grow's raise to the tier's distance (10240 → 12288) — `CullVisitor` → `QuadTreeWorld::accept`
  → `loadRenderingNode` → `ObjectPaging::createChunk` / `ChunkManager::createChunk` — built tens of chunks in one
  frame, each mesh and texture a synchronous read (93 reads, a 10 s block); a script's ray (`nearby.castRenderingRay`,
  `World::castRenderingRay` → `IntersectionVisitor` → the same path) built them the same way (27 reads in a COE's load).
  r5's and r12's put-offs are asked by the sliced preload only; the cull and the rays never asked.

The fixes, closest to each cause:
- **The page announces the scripts at the boot** (`src/ports/openmw/boot-reads.js`, `streamfs.js` `announceBoot`):
  once the engine page's mounts are over (`window.__serverMods` set, or at the latest the engine's content load,
  `orthrosContentLoading`), every file the engine's VFS resolves — a later data folder's file wins over an earlier one
  of the same name — whose kind is `.lua`, `.omwscripts`, `.yaml`/`.yml` or `.omwfx`, at most 8 MiB each, 32 MiB and
  4096 files in all, the smallest first, goes to the game data in one list (`GameData.want` `wait: false`: fetched at
  once in parallel, what the page or the store holds left out, the engine's reads joining their requests; label
  `boot:scripts`, not learned as a place). Vanilla+ FR: 636 files, 13.2 MB of files (three quest data YAML of 1-4 MB
  each, ~2.5 MB of wire in all). A warm store asks nothing; a mod added since asks its files only. `?bootreads=0` on the
  engine or play page: the engine's reads alone. `StreamFS.boot()`: `{ files, bytes, asked, atMs }`.
  Not covered: a Lua UI's images (`.png`: Advanced World Map's 28 MB of map tiles are read only when shown).
- **The put-off patch** (`r14dev`'s, on r13, never shipped; `components/terrain/quadtreeworld.{cpp,hpp}`, `play/index.html`): a traversal — a
  frame's cull, a ray's intersection other than the focus ray's (r6/r8: it builds nothing) — about to build an entry
  outside the active grid asks `chunksReady` first (r5/r12's question: the chunk managers' meshes, textures, lands —
  missing ones then fetched in the background, `orthrosRangeReady`); not ready, the entry is put off
  (`QuadTreeWorld::orthrosPutOff`): drawn (or hit) with the chunks of the managers ready before the first one that is
  not — the terrain alone, never objects standing on a missing land —, its node not kept, asked again at the next
  traversal, built once its files are here or after `OPENMW_ORTHROS_CULLWAIT_MS` (10000 ms; `?cullwait=N` or
  `?omwenv=OPENMW_ORTHROS_CULLWAIT_MS=N`, 0: as before) **and two of the page's turns since** — then its reads wait
  as before. The turns (`window.orthrosTurns`, counted by `streamfs.js` every 50 ms the page's thread is free) matter:
  the files a put-off asks reach the page between its tasks only, and a COE's load with its loading-screen frames and
  one frame's script rays runs in one task for 10 s and more; on wall time alone the first dev build built every entry
  put off in that task once its 10 s had passed, one round trip a file (a COE on a store missing those files: frozen
  4.3 → 13.7 s, 123 serial reads). The active grid is built as
  before (loaded and waited for with the cell change: never a hole under the player); the water's culling skips an
  entry without a node. A script's ray misses a distant paged object whose files are not here for that long (r8 had
  those rays build them; their files now come in the background first).

Development build only (`openmw-web-v1.5.3-orthros-r14dev` in scratch: the kept r13 tree + the put-off patch; never in
`lock.json`, and the number r14 went to the release below). Measured: docs/slow-network.md "Unannounced serial reads
(2026-10-29)".

### Lua beside the frame, LuaUi updates diffed: engine orthros-r14 (2026-10-29)

The owner: a constant 60 fps in Vanilla+ with every mod and option kept ("optimise à mort", weeks of work accepted).
Attributed first (`perf.mjs --discard --profile`, Seyda Neen running; Vanilla+ FR work p50 16.6 ms against 9.7 for
the mod-less base): Lua 5.7 ms/frame, of which `LuaManager::update` 2.6 (the web build ran it inline after the
drawing: `mwlua/worker.cpp` compiled its thread out) and LuaUi `Element::update` ~1.9 (the whole widget tree
re-applied on each `:update()`). Four changes in `orthros-r14.patch`, each behind its switch (`?omwenv=<switch>=0`),
written, reviewed through two lenses (threads/web platform, identical behaviour) and fixed by agents, then built
once and measured alternately (4 runs all off / all on, 3 per switch alone off; load 17-21 from other projects):
- `OPENMW_ORTHROS_LUATHREAD`: `LuaManager::update()` on its own pthread between `allowUpdate` and `finishUpdate`, as
  on desktop; off in a multiplayer session (`OPENMW_MP_URL`) and with `[Lua] lua num threads = 0`. What Lua reaches
  that is main-thread-only goes through a private FIFO (`mwlua/mainthread.hpp`) run only inside `finishUpdate`,
  where the inline update ran it: void sound calls and the messageBox posted, queries and `postprocessing.load`
  synchronous; an exception in the thread's update is rethrown on the main thread. On this host the main thread's
  `update()` (2.2-2.5 ms) moves out and `luawait` is ~0, but its other work grows ~1.9 ms (draw, cull, posts,
  futex wait): net busy -0.3 ms. Shipped on to be judged on real CPUs by the players' telemetry; `=0` restores the
  previous path.
- `OPENMW_ORTHROS_LUAUIDIFF`: `Element::update` skips the setters whose parsed value equals the applied one and the
  child rebuilds of unchanged content; layer resizes, templates, events still re-applied. `updateWidget` 1.38 → 0.88
  ms/frame.
- `OPENMW_ORTHROS_CLOCK` (`wasm-build/orthros-clock.js`: the clock glue without BigInt round trips; `_clock_time_get`
  0.18 → 0.08 ms/frame) and `OPENMW_ORTHROS_GAMMA` (the post-processing gamma uniform set only when it changes;
  0.04 ms/frame).

Checked: no Lua error or fault in any run; keys (Space jumps, E activates); `frame-compare.mjs` day, night and
interior (`--interior "Seyda Nihyn, auberge d'Arrile"` in French) within noise. `morrowind` and `morrowind-vanilla-plus`
manifests moved to r14 (backups `backups/manual/*-manifest-before-r14-20261029.json`).

### The hitches, by cause: engine orthros-r15 (2026-10-30)

The visible drops are hitches (50-950 ms frames), not the mean. Rounds 2-4 classified every busy stretch over 25 ms
(SwiftShader `--discard` profiles, the pthread workers profiled too) and fixed causes one by one, each written,
reviewed through two lenses and measured A/B; page-side fixes shipped at once (light copies below, wasm code cache),
the engine's kept for one release. `orthros-r15.patch` (r14 + six, each behind its switch):
- `OPENMW_ORTHROS_ACTORPRELOAD`: the exterior cell preload also lists the actor models insertion used to load in the
  crossing frame (a 182 ms data wait at a crossing gone).
- `OPENMW_ORTHROS_STATEGRAPHS`: OSG's StateGraph prune keeps a leafless graph a few frames (prune 0.12 → 0.06 ms/frame).
- `OPENMW_ORTHROS_PRECOMPILE`: the live programs compiled under the loading screen (one frame's budget each, a last
  pass when it ends; not for a save load; multiview programs skipped: not GLSL ES); fresh-load compile hitches 4 → 0.
- `OPENMW_ORTHROS_LUAGCINC` and `OPENMW_ORTHROS_FXPROGRAMS`, `OPENMW_ORTHROS_GUIONEBUFFER`: the sections below.
Rejected on their numbers: deadline-paced cooperative work, a faster Lua minor collection, asynchronous shader status,
redundant WebGL state setters, the late unload and null pair cache at crossings, and the first light-copy pacing
(textures blurry 45-90 s). Measured all on against the r14 stack (3 runs each, work p99): running 34.8 → 29-30 ms,
gliding across cells 44 → 38, fresh load 42 → 35; frames over 100 ms 2-4 → 0-2.5 per 30 s. Live after the release,
Vanilla+ FR fresh load: work p99 36.9 ms (79 before round 1), 11 synchronous fetches, no error.

With it, Vanilla+ gets RUN!'s radial blur and Combat Juice's kill flash back: `orthros-overlay-all` carries a GLSL ES
valid `shaders/radial-blur.omwfx` (the author's did not compile in WebGL2: the frame one flat colour while sprinting),
`orthros-overlay-all-pack` a Combat Juice `player.lua` whose flash is in the chain only while it runs, and
`orthros-player-defaults-perf` is withdrawn (`player-defaults.mjs --withdraw`: the author's default back once where
this root had given its value). Manifests: backups `backups/manual/*-manifest-before-r15-20261030.json`.

### Light copies sharpened without hitches (2026-10-29)

The round-2 hunt (Vanilla+ FR, `perf.mjs --discard --profile`, 8 profiles) found half of all hitch time, 30-490 ms
stretches in the first 15-20 s in the world, in the light copies' reload (`EmscriptenLoop::reloadUpdated` →
`ImageManager::reloadImage`). Its profile: ~90% `fetchSync` — the file whole in the data worker, not in the page, its
read waiting for the worker's answer —; decoding, the translucency scan and the page's copy ~10%. A first fix
(reloads paced by the frame's time, a file read only once its bytes are in the page) removed the hitches but left the
textures blurry 45-90 s instead of < 20 s (one file a frame at the 2-3 fps SwiftShader draws at): rejected. Now:
- The page (`GameData.realInPage`, src/vfs/data-client.js; `?realinpage=0`: the previous path) tells the engine a file
  only once its bytes are in the page, fetched in the background first (docs/slow-network.md "Reloads paced"); only the
  files a reload will read (the engine reloads in place, the file's last load read light), and no new fetch while the
  engine's reloads told and not done (`__orthrosTexReloads.pending`, plus the files told since its last report:
  streamfs.js `reloadBacklog`) and the fetches under way make 8 — their bytes stay in the page until the engine reads
  them. The engine's read waits for nothing; the pace the page tells files at (2 per 100 ms) is unchanged. A reload's
  read that waited all the same is counted (`__streamfsStats.realMissed`: its bytes left the page first;
  `realRaced`: the file loaded anew while its fetch was under way, read through `fetchSync` as before).
- The engine (`OPENMW_ORTHROS_TEXRELOADPACE`, `engine.cpp`/`imagemanager.cpp`; `=0`: 4 MB a frame, copied): a frame
  starts no new reload past max(1.5 ms, 10% of the frames' time — the time between ticks averaged, a fifth of the way at
  each; a gap over 1 s, a loading screen or a hidden tab, changes nothing) nor 4 MB, at least one file; the decoded data
  handed to the cached image instead of copied (only when nothing else holds the decoded image: else copied). Over 20
  fps the engine's cap stays above the page's pace (at least one file a frame: more than the 20 files a second the page
  tells), so the page, not the engine, sets how fast the light copies sharpen, as before; slower, it is 10% of the
  frames' time (in the runs below, at 2-3 fps, they sharpened at least as fast in the day view).

Measured (one build of r14 + the round-2 patches + this, before the backlog, the counters and the averaged frame time
above; 2 runs each, 30 s, load 23-48 from other projects; old = `?realinpage=0&omwenv=OPENMW_ORTHROS_TEXRELOADPACE=0`):
main-thread reload time per run 0.89-1.11 s → 0.12-0.15 s, its `fetchSync` 0.77-0.97 s → 0; its longest stretch
48-127 ms → 8-10 ms; work p99 run 60.3/61.5 → 34.1/45.1 ms, glide 63.7/63.3 → 45.1/45.9; frames over 50 ms run 14/13 →
4/4, glide 14/15 → 6/8; data stalls 809-1033 → 104-280 ms. `frame-compare.mjs` (day, old path the reference): at the
default 20 s settle the same picture (mean abs 0.05, 0% over 24); at 8 s the new path is the closer one to the settled
picture (mean abs 0.40 against 0.65 and 1.62 for the old path's two captures). Night and interior views not run.

Open: every measure above is SwiftShader's 2-3 fps (a frame's reload cap ~30-50 ms). At 60 fps the cap is 1.5 ms with
a floor of one file, so each file told still costs one whole decode (not measured alone: the longest reload stretch,
8-10 ms at 2-3 fps, may hold several files) plus its re-upload at the next apply (not in these profiles: SwiftShader's upload is not the GPU's),
in one frame, up to 20 times a second while light copies sharpen (the first minute, moving through exteriors). The
distribution of reload time per frame (frames over 4 and 8 ms) was not taken — the runs' profiles were discarded — and
the Iris Xe check at 60 fps is to do: the hitches are much smaller, not shown gone at 60 fps.

### Light copies' textures uploaded at their reload: `OPENMW_ORTHROS_TEXAHEAD` (round 5, 2026-10-30, `texahead.patch`)

Scope: only while light copies are replaced in place (a first session, or a link that is not fast, until each file
is in the OPFS store: docs/slow-network.md). With a fast link or cached data nothing is reloaded and this changes
nothing. The incremental compile's own misses stay open (about 11 first uploads, ~7 ms, in the local map's first
render of a cell; ~1 ms in the main view).

Cause: a texture whose image `ImageManager::reloadImage` updated in place uploads again at its next apply. A camera
that first shows many such textures uploads them all in one draw. In every glide that is the HUD minimap's first
render of a cell (about 10.3 s in): 23 compressed textures, 25-36 MB, 12 of them reloads (125 ms on SwiftShader). The
incremental compile cannot catch those: the texture already has a GL object. Now (osg `Texture2D.cpp`: a registry
image -> its live Texture2Ds; `imagemanager.cpp`: a callback at the end of `reloadImage`; `renderingmanager.cpp`): each
live Texture2D of the reloaded image that has a GL object, an older modified count and no subload callback is applied
at once. That happens between frames on the GL thread (`EmscriptenLoop::tick` calls `reloadUpdated` before
`viewer->advance`/`frame`; keep that order), and then the State's binding on the active unit is marked unknown. A tick
spends at most 8 ms on these uploads. After that the tick's other textures upload at their next draw, the previous
path, and the reloads' pace is unchanged. Textures never uploaded are left to the incremental compile or their first
draw. A texture still alive but never drawn again is uploaded too, once, within the cap. Counters:
`__orthrosTexAhead` {textures, bytes, deferred, ms, max, maxTick}. `=0`: no registry, no callback.

Measured (one build, the r15 stack + this, Vanilla+ FR, `perf.mjs --discard --profile`, 30 s, load 3-18; off =
`?omwenv=OPENMW_ORTHROS_TEXAHEAD=0`):
- Glide 8000,0, two runs each: the ~10.5 s stretch with `tex-upload` 103-104 ms (161-200 ms) was in both off runs and
  in neither on run.
- Glide work p99: off 44.4 and 71.1 ms, on 51.4 and 32.8.
- Glide max: both off runs and one on run had an unrelated ~1 s `fetchSync` data stall at 12.8 s.
- Ahead: 236-242 textures and 155-159 MB uploaded, 72-83 ms in all, max tick 5.3-8.8 ms.
- `--run` (walk with mouse turns), fresh, two runs each: work p99 off 33.6/36.2 ms, on 37.4/39.5; over 33 ms off 7/12,
  on 9/15.
- In the run, ahead spent 111-127 ms on 239 textures, and its max tick was 19.6/40 ms: a single upload can pass the
  cap, which is checked before each upload. One 41 ms `tex-upload` stretch appeared in one on run.

So the glide's burst is gone. In the run, the uploads are spread out but not removed, and some may be textures that
would not have been drawn again.

`frame-compare.mjs morrowind-goty-en` (day, interior; reference = on): off against on 0.001/0.855 mean abs, 0% over
24, within the noise (0.002/1.338). Open: the Iris Xe check at 60 fps (SwiftShader uploads are not the GPU's).

### Lua's collector beside the frame: `OPENMW_ORTHROS_LUAGCPACE` (round 2, 2026-10-29)

(Not shipped: `luagc.patch` is in no release — no measured gain in round 3's 30 s windows. Superseded by
`OPENMW_ORTHROS_LUAGCINC` below, the same idea made smaller; the finalizer and weak-table remarks here hold for it too.
The `__omwPhase` fields and the log lines below do not exist in any release.)

With the Lua thread (`OPENMW_ORTHROS_LUATHREAD`), Lua's collector is the incremental one (upstream's mode), its
automatic steps stopped: the Lua thread steps it after `update()`, while the main thread still culls and draws
(`LuaManager::orthrosGcStep`), instead of the generational collector's 16-108 ms collections inside `update()` and
inside the main thread's own Lua calls. A cycle starts once the heap doubled since the last one (Lua's pause; re-based
when a game is loaded or started, so the first cycle does not follow the emptied heap of `clear()`); behind Lua's own
pacing with no drawing time left, at most 1 ms of 1 KB steps per frame, 4 ms past twice the heap the cycle began with,
everything owed past three times it or 3/4 of `[Lua] memory limit`. `[Lua] gc steps per frame` is ignored (logged).
`?perfstats=1` adds to `window.__omwPhase`: `luagc` (the steps' ms, apart from `luaupdate`; with the switch off they
are inside `luaupdate`, so compare `luaupdate + luagc`, or `luawait`), `luaheapkb`, `luapeakkb`, `luagccyclepeakkb`,
`luagccycles`, `luagccapped`, `luagcforced`, `luagcmaxcatchup`, `luagcmaxwait`; the log has a line at each cycle's
beginning and end (heap, threshold, wall time, the main thread's longest wait during it).
What is collected is the same, but not when: finalizers (`__gc`) and weak tables' entries now go once per full cycle
(about every 1.5-3 min at the heap's doubling, against young collections every ~5 s before) — C++ resources held by
Lua userdata (an unclosed `vfs.open` handle) live longer, and a mod that saves a weak table's contents in `onSave` or
relies on `__gc` timing can see more entries. Peak heap is ~2x live with ≥ 2 ms of drawing time per frame (native
simulation against the tree's Lua 5.4.7), up to ~3.5-7x with none under heavy churn. `=0` restores the previous
collector and its per-frame step.

### Lua's incremental collector again, short steps: `OPENMW_ORTHROS_LUAGCINC` (round 4, 2026-10-30)

Attributed with the Lua thread profiled beside the page's thread (`perfw.mjs`, a CDP profile of every worker; Vanilla+
FR, glide `8000,0` and fresh `--warm 0 --run`, dev-stack r14 + stategraphs + hitch2): the page's longest
`waitForThreadUpdate` of every run (107-143 ms) was not script work but one `luaC_step` of Lua's *generational*
collector — F41's mode on the web (`components/lua/luastate.cpp`, "not a measured win yet", written when Lua still ran
inline). A major collection is a stop-the-world mark of the whole heap (`atomic2gen`, 128-147 ms in one
`LuaManager::update`); every minor one runs a whole atomic phase (20-36 ms). (The round-3 hitch list's "inside
`changeCellGrid`" for these was `hitches.py` merging the crossing frame's work, draw and futex wait into one stretch.)
`OPENMW_ORTHROS_LUAGCINC` (`luastate.cpp`, `mwlua/luamanagerimp.cpp` `orthrosGcStep`; `=0`: exactly the previous code,
`OPENMW_LUA_GC_INCREMENTAL=1` included); it replaces the unshipped `OPENMW_ORTHROS_LUAGCPACE` above:
- Lua 5.4's incremental collector (upstream's mode, the desktop build's), its step 1 KB (Lua's default 8 KB); pause and
  step multiplier unchanged.
- The collector is stopped, and `LuaManager::update` alone pays its work, keeping Lua's own pacing by hand: the heap's
  net growth since the previous frame (every thread's allocations) plus upstream's `[Lua] gc steps per frame` (100 KB)
  are owed; between cycles nothing runs until the owed KB reach the heap left by the last cycle (Lua's 200 % pause);
  during a cycle they are paid as `LUA_GCSTEP(1)` calls (1 KB of debt each) until the cycle ends or 2 ms have gone
  (12 ms once the heap is 4× the last cycle's), the rest carried to the next frame. So no allocation ever steps the
  collector: not the Lua thread's, and above all not the page's thread's (`synchronizedUpdate`'s userdata, UI layers,
  UI and input callbacks). A first version that left the collector running with capped forced steps put 36-89 ms of
  `luaC_step` per 30 s on the page's thread (stretches of 18-25 ms in the frame) and +1 ms on the work p50: rejected.
- The time cap is checked after each step: a cycle's atomic step is indivisible (15-25 ms, on the Lua thread, beside the
  draw). With `OPENMW_ORTHROS_LUATHREAD=0` (or multiplayer) `update()` runs on the page's thread after the drawing, so
  the steps (2 ms a frame at most, but for the atomic one) land there.
- Scripts see the same things but for when `__gc` finalizers and weak-table entries go (Lua leaves it unspecified).
  The log says `Orthros: Lua's collector incremental, stopped, its debt paid in short steps by LuaManager::update`
  once, and `Orthros: Lua's heap at N MB` at each peak 25 % above the previous one (from 16 MB; both arms).

Measured (one build, `try-luacross` = dev-stack + this patch; alternated on / `=0`, 30 s each, `--discard --profile`,
load 13-23 from other projects; work = the page's frame work p50/p99 ms; page GC = `luaC_step` on the page's thread
outside the wait, total/longest ms; Lua GC = the Lua thread's, total/longest; wait = the page's `waitForThreadUpdate`,
total/longest ms and the count over 16 ms):

| run | work p50 / p99 | page GC | Lua GC | wait | waits > 16 ms |
|---|---|---|---|---|---|
| glide on 1 / 2 / 3 | 8.8 / 64.1*, 9.7 / 41.3, 10.5 / 38.0 | 0, 0, 0 | 179/29, 178/27, 164/30 | 203/94, 200/96, 160/88 | 3, 3, 3 |
| glide off 1 / 2 / 3 | 10.7 / 45.5, 8.4 / 38.5, 10.9 / 48.8 | 26/26, 0, 0 | 195/115, 251/124, 219/113 | 321/114, 361/111, 329/114 | 6, 6, 6 |
| fresh on 1 / 2 | 12.9 / 32.9, 11.2 / 31.2 | 0, 0 | 187/24, 221/39 | 38/18, 44/28 | 1, 1 |
| fresh off 1 / 2 | 13.0 / 40.3, 10.7 / 33.9 | 0, 0 | 158/93, 167/107 | 127/91, 164/106 | 2, 3 |

(* a 1.7 s `fetchSync` data stall at t=12.9 s, not Lua.) Work p50 within the runs' noise both ways (on 8.8-12.9, off
8.4-13.0), the page's thread runs no collector step, the longest GC stretch drops from 93-124 ms to 24-39 ms, waits
over 16 ms halve (glide 6/min against 12/min; fresh 2/min against 4-6/min). Lua's heap peak (40 s glide, the log):
97 MB on, 90 MB off.

What remains: at a crossing the wait is still 88-96 ms on the glide — the scripts' own work in the crossing frame's
`update()`: `addAutoStartedScripts` → `ensureLoaded` → `addScript` (20-65 ms, of which 7-19 ms is `lua_load` undumping
each script's cached bytecode again for each object: `loadScriptAndCache`), the queued events (`callEventHandlers`,
~30 ms), `onActive` (`callEngineHandlers<GObject>`, ~22 ms), `onUpdate` and timers. Each cycle still ends in one atomic
step (15-25 ms; up to 39 ms with the steps before it in the same `update()`), more than a 60 fps frame: hidden only
when the page's thread has that much drawing left, which on Iris Xe at 60 fps it may not. Not checked on Iris Xe. The
GC hitch is shortened, not shown gone at 60 fps.

### Scripts met again instantiated, not re-read: `OPENMW_ORTHROS_LUACHUNKS` (round 5, 2026-10-30, `luachunks.patch`)

The crossing's Lua work, attributed (Vanilla+ FR, glide `8000,0`, SwiftShader `--discard`; `perfw.mjs` profiles of
both threads, and `OPENMW_ORTHROS_LUATIMES=1`, a diagnostic in `luatimes.patch`, below). The exterior crossing at ~17 s spans two Lua
updates; the page's thread waits for them in `waitForThreadUpdate` (86-108 ms in the 0.5 s around the crossing on r15,
two waits of 35-53 ms). Crossing frame 1 (68 ms, 114 objects whose scripts start, 661 objects becoming active):
- `onObjectActive` of four global scripts, 661 calls each: proximityTool 10 ms, Advanced World Map - Tracking 9 ms,
  Quest Guider Lite 3 ms, Advanced World Map 2-2.5 ms. Proximity Tool and Advanced World Map - Tracking each send an event
  and `addScript` for every supported object. `onInactive` of the cells left: 5-6 ms.
- Scripts started (`addAutoStartedScripts`, 28 ms): Take All's container script on 92 containers 9 ms, Inventory Extender
  Redone's container script 3 ms, the two `objectLocal.lua` above on 126 objects 7 ms, and nine actors' six scripts each.
- `lua_load` re-reading cached bytecode (an undump per script and per `require`, per object): 9-12 ms. This was the only
  engine-side cost of note. Script compiling from source: 0 (every path was compiled at load).
Crossing frame 2 (38 ms): events. Advanced World Map's `AdvWMap:cellChanged` took 16 ms; its door bindings load a
destination cell's references (`CellStore::load`) from the ESM through proxied `fd_read` > `fetchSync` (13-28 ms of
data wait in a fresh browser profile). The tracking events took 4.4 + 3.7 + 2.9 + 2.3 ms.
Everything else is the mods' own Lua and their bindings (`serialize` of event payloads 10-16 ms, one `pcall`ed
error 4-7 ms). Changing that would change what the mods do.

`OPENMW_ORTHROS_LUACHUNKS` (`components/lua/luastate.{hpp,cpp}`; `=0`: the bytecode re-read, as before). At the first
load of a path, the source is compiled as itself, as before: its errors are a main chunk's, its bytecode is cached, and
that first instance is that main chunk. Right after, still at that first load, the source is compiled once more as a
factory: `local _ENV = ...; return function(...) <source>\nend`, with the source's first line kept on line 1. Each later
load (a second object, or a second sandbox's `require`) calls the factory, which makes a new closure with its own `_ENV`
upvalue, starting at the globals as `lua_load` sets it; the closures it creates share that upvalue, as with a main chunk
loaded again. `sol::set_environment` then finds the upvalue by its name, as before. The sandbox has no `debug` library and
no `load`, so a script cannot see the difference. Two differences remain, neither visible to the player, saves or script
logic: a C++ `debugTraceback()` line in the log reads "function <path:1>" instead of "main chunk" from the second
instance on; and the instances share their prototypes, which lowers the Lua heap and its allocation rate, so `__gc`
finalizers and weak-table entries may go at other times (unspecified by Lua, as already accepted for `luagcinc`). If the
factory does not compile (a source that is valid only alone), that path keeps the bytecode re-read, with a warning. The
factory runs on the main Lua state with room checked (`lua_checkstack`, else the undump); a memory error or the
instruction watchdog firing in its few instructions fails the script's start with the same "Lua error" as before.

Where the factory compile lands: at a path's first load, where its plain compile already lands, so later instances never
compile, whichever thread they start on (a crossing's objects on the Lua thread, a `require` from a page-thread Lua
context: `synchronizedUpdate`, UI or input callbacks). In the measured runs every path was first loaded at the game's
load. The cost: one more compile per path at its first load, so scripts used once (global, player, menu) are compiled
twice at the game's load (not measured; that is the load screen, not a frame). A script type first met at a crossing pays
both compiles in that crossing's frame (before: one compile and an undump per further instance); if it is met there on a
single object, that second compile is a new cost. Not measured: in the glide, no path was first met at a crossing.

The diagnostic `OPENMW_ORTHROS_LUATIMES=1` is in its own patch, `luatimes.patch`, applied after `luachunks.patch` only to a
diagnostic build; it is not in the production stack. With `OPENMW_ORTHROS_LUATIMES_MS` (default 16), it logs any
`LuaManager::update` longer than that: the update's phases and, per script, the inclusive time of its start, `onInit`,
engine handlers, events, timers and chunk loads. Its times map is not locked, so it is valid only while Lua runs on one
thread at a time. Its log line, written from the Lua thread, is proxied to the page's thread, which serves it while it
waits in `waitForThreadUpdate`: the waits measured with it on include that write (the times it logs do not).

Measured (dev build r15 stack + the first version of `luachunks.patch`, whose factory was compiled at a path's second
load rather than its first; alternated `=0`/on, 30 s glide, 3 runs each, load average 19-30). The gain is 5-10 ms of
Lua-thread work per crossing:
- `loadScriptAndCache` on the Lua thread: 9.2/11.2/10.8 ms down to 1.1/1.1/0.6 ms (`lua_load` 0).
- With LUATIMES: crossing frame 1 went from 68 to 62.6 ms, and `autoStartedScripts` from 28.1 to 21.4 ms.
- `addScript`: 36-39 ms down to 28-33 ms.
- Work p50: 9.1-9.4 ms in both.
- The per-run `waitForThreadUpdate` totals (145/141/173 ms off, 107/119/125 ms on) fell by several times what the removed
  `lua_load` explains: that is mostly noise at this load average, not the gain. The longest wait did not reliably
  improve (39/43/53 ms off, 34/46/39 ms on).
Both arms ran the same calls in the same order (114 objects, 661× `onObjectActive`, 92× Take All) and logged no
errors. The on runs' largest frames (246-378 ms) were first texture uploads in the draw, not Lua.
The crossing hitch is trimmed, not removed: two waits of 35-46 ms per crossing remain, so 60 fps is still missed there.
The rest is the mods' own Lua. The next engine-side lever the attribution shows is not Lua: Advanced World Map's door
bindings load cells (`CellStore::load`) whose ESM reads go through proxied `fd_read` > `fetchSync` (13-28 ms of data wait
fresh). That belongs to the data system (prefetch and learned order of the ESM's ranges), not to this patch.

### The exterior crossing decomposed; preloads patient on slow links: `OPENMW_ORTHROS_PRELOADPATIENT` (round 6, 2026-10-30, engine orthros-r17)

The exterior crossing frame on r16, measured with `perf.mjs --discard --profile --workers --glide 8000,0` (Vanilla+ FR,
SwiftShader, the crossing at about 17 s; `tools/openmw/frame-attr.py`, the Lua thread's own profile beside it):
- **(a) The data wait is gone on a fast link.** `Scene::orthrosReadAhead` costs 2-5 ms of the frame, its
  `orthrosReadWait` 0.3-1 ms (4 glides, local server). The data wait moved out of the crossing: at 1.5 MB/s
  (`--net-after 1500`) the next row's preload, started about 4 s before the crossing, waits for its files and, after
  `WorkItem::dataWaitLimit()` (3 s), reads them anyway, synchronously: a 2.5 s and a 28 s frame on two glides
  (`PreloadItem` / `TerrainPreloadItem::doWorkSlice` > `getTemplate` > `fetchSync`), 3.1 s and 32 s of data stall in
  30 s.
- **(b) The Lua thread's update**: 78 ms on the Lua thread in the crossing's frame (`addAutoStartedScripts`: the new
  objects' scripts instantiated, 41 ms, their `onActive` handlers, 27 ms), then 28 ms of event handlers in the next
  one. The page's thread waits for it in `finishUpdate`: 62-105 ms of the crossing's frame. On a slow link it also
  serves the Lua thread's reads of scripts not in the page yet (70-95 ms of `fetchSync` inside that wait).
- **(c) `changeCellGrid`'s own work**: 39-63 ms — `loadCell` 22-30 (`insertCell`'s `addObject`, many small inserts:
  containers, levelled creatures, mechanics, Lua's `objectAddedToScene`), `unloadCell` 9-18 (`PhysicsSystem::remove`
  3-7), the read-ahead 2-5, the synchronous terrain preload 0-4; and the first cull of the new cells (20-35 ms of the
  crossing's stretch).

Crossing frame on r16: 106, 129, 147, 151 ms (4 glides), then 35-60 ms.

`OPENMW_ORTHROS_PRELOADPATIENT` (`preloadpatient.patch`: `components/sceneutil/workqueue.{hpp,cpp}`,
`apps/openmw/mwworld/cellpreloader.cpp`, `components/terrain/quadtreeworld.cpp`; no r17 file):
- a preload put off for its files waits up to 60 s for them, not 3 s, before reading them synchronously
  (`?preloadwait=N` still sets it). Whoever needs the work now does not wait for the limit: `waitTillDone` finishes an
  item at once, and a cell change aborts its cell's preload and loads the cell itself, its files fetched together
  first. A file whose fetch failed answers ready (`readable()`), so its read happens once and reports the failure:
  nothing waits 60 s on a dead file.
- the waiting entries' readiness checks (`meshReady`, `chunksReady`) stop at the slice's deadline, like the rest of
  the slice. The entries asked go to the back of the list, so the next frame starts with the others (round robin).
  A list waiting 60 s can be long; its checks no longer grow the frame.
- a terrain preload holds the one terrain slot until it is done (`CellPreloader::setTerrainPreloadPositions`). One
  that has waited 3 s for its files (the cadence the old limit gave, when its reads were forced) at positions the
  player has since left is aborted and restarted at the new positions. The abort is immediate: its slices return
  on the abort and read nothing. The fetches it started go on, and the chunks it built stay cached. Without this,
  a 60 s wait would keep stale positions, so the next crossing would build its terrain synchronously and leave far
  chunks to the cull.
- `=0`: all as before (3 s, the full scans, no restart). The switch is read once, at `WorkQueue::start` on the main
  thread, and logged there.

Measured at 1.5 MB/s (`--net-after 1500`), 2 runs per arm, r16 against r16 `?preloadwait=60000`: in the 3 s arm, the
multi-second synchronous preload reads come back (2.5 s and 28 s). The patient arm has no such read, and its worst
frame is 208 ms:

| | work p99 | max | frames > 100 ms | data stall | preload slices on the page's thread |
|---|---|---|---|---|---|
| r16 (3 s) | 191.6 / 81.9 | 28101 / 2510 | 7 / 5 | 32381 / 3137 ms | 32040 / 3269 ms |
| r16 `?preloadwait=60000` | 51.7 / 43.4 | 208 / 158.5 | 5 / 3 | 562 / 454 ms | 847 / 781 ms |

The shipped patch (try build r16 + `preloadpatient.patch`), on against `=0` on the same build, `--discard --profile
--warm 0 --seconds 45`, 1 run each. The terrain columns: `Scene::preloadTerrain` (the cell change's synchronous
terrain load) and chunk builds in the cull (`QuadTreeWorld::accept` > `loadRenderingNode`):

| run | arm | work p50 / p90 / p99 / max | > 100 ms | preload sync reads | sync terrain load | cull chunk builds | readiness checks |
|---|---|---|---|---|---|---|---|
| glide 8000,0, 1.5 MB/s | on | 9.4 / 17.4 / 68.9 / 194 | 9 | 4.7 ms | 0 | 89.7 ms | 486 ms |
| glide 8000,0, 1.5 MB/s | off | 9.2 / 17.2 / 84.4 / 2510 | 10 | 2409 ms | 0 | 86.1 ms | 286 ms |
| walk + turns (`--run`), 1.5 MB/s | on | 11.7 / 17.8 / 33.6 / 377 | 2 | 0 | 0 | 12.3 ms | 142 ms |
| walk + turns (`--run`), 1.5 MB/s | off | 12.2 / 18.8 / 32.6 / 121 | 1 | 0 | 0 | 20.1 ms | 156 ms |
| walk + turns (`--run`), 500 KB/s | on | 10.5 / 15.9 / 26.2 / 114 | 4 | 0 | 0 | 16.5 ms | 152 ms |
| walk + turns (`--run`), 500 KB/s | off | 11.7 / 17.9 / 29.7 / 129 | 5 | 0 | 0 | 15.0 ms | 143 ms |

What the table shows:
- On the glide, the 2.5 s frame is the forced read, and it is gone with the switch on.
- With the switch on, no run has a synchronous terrain load at the crossing, and the cull builds no more chunks
  than with it off. Nothing is drawn later.
- The walk-on run's 377 ms frame is a sound's synchronous file read (`SoundManager::playSound` >
  `FFmpegDecoder::open`), not a preload.
- On the glide, the readiness checks cost more with the switch on (486 against 286 ms in 45 s): more entries wait,
  the checks now bounded per slice. The steady p50/p90 stay within noise, at 1.5 MB/s and at 500 KB/s.

The walk crosses a single cell boundary in 45 s, so a terrain restart (positions left after 3 s of waiting) was
possible there but is not counted: its log line is at Verbose. Load on the host was 5-17 during these runs. Fast
link: no difference (the limit is not reached). Ship `preloadpatient.patch` alone, not `crossing6.patch`.

A known risk, not measured: the page's piece cache evicts by insertion and use (`data-client.js`). A readiness
check (`readable()`) does not refresh a piece. On a low-memory tier with much data in flight, a deferred mesh's early
pieces could be evicted before its last texture arrives. They would be fetched again, and the item would wait
longer, up to 60 s, before the same synchronous read as before. Watch `evictions` and the bytes fetched in a
low-tier slow-link run. The fix would belong to the data system (`src/vfs/`), shared by every port.

Measured and not shipped (`crossing6.patch`, same build, A/B by `?omwenv=`):
- `OPENMW_ORTHROS_LUALATE` (`mwlua/worker.cpp`; `engine.cpp`'s loop and exports — the r17 files): a Lua update still
  running when the frame is drawn is waited for at the start of the next tick (and first in any export called from
  the page), the tick's end (clock, work queue) after it — the frame shown first, nothing computed differently. Glide
  with the teleport done inside the timed pump (so the wait is counted as a tick's would be): crossing frame 92 / 94 ms
  on, 106 / 108 off (r16: 129 / 147); the following frames take the rest (42 + 61, 22 on; 39, 52 off). It splits
  the hitch, it does not remove it: the Lua thread's 78 ms of script work stays serial. Revisit with r17 (JSPI).
  Before any revisit: while the update is left running, the page's thread runs C++ the exports' settle does not
  cover — every Emscripten callback registered into the engine (html5 / SDL event handlers: resize, visibility,
  pointer lock, `webglcontextlost`, input; any `EM_JS` handler that reaches the world, the window manager or the
  input manager) — so each must settle first or only enqueue; and the Lua thread's proxied main-thread calls (file
  reads, `fetchSync`) are still served only at the settle or in the browser's yield, serially as before.
- `OPENMW_ORTHROS_PRELOADLEAD` (`mwworld/scene.cpp`): the exterior grid's next cells preloaded when the position 6 s
  ahead (at most one cell) comes within the preload distance. Read-ahead in the crossing at 1.5 MB/s: 3.2 ms on,
  23.3 ms off (1 run each), 2.5 / 4.2 ms on r16 with 60 s patience: within the noise. Not shown to gain.

Left for later: the crossing's Lua work (scripts of the new row's objects, from the mods) can only shrink or move
by changing when those scripts start (not done: a global event sent to an object whose scripts start later would be
lost); the slow link's script reads could be announced with the row's read-ahead (each object's local scripts from
the Lua configuration); `insertCell`'s inserts spread over frames would need object paging to keep a cell drawn
until its objects are in.

### Post-processing chain changes without recompiles (2026-10-30, `fxprograms.patch`, engine orthros-r15)

Lua mods change the post-processing chain while playing: RUN! enables its radial blur at each sprint's start and
disables it at its end. Each change (`PostProcessor::dirtyTechniques`) gave every pass of every technique a new
`osg::Program`, so the whole chain was compiled and linked again at the next draw, with WebGL's synchronous status
reads. `OPENMW_ORTHROS_FXPROGRAMS` (`?omwenv=OPENMW_ORTHROS_FXPROGRAMS=0` restores the previous path):
- `Fx::Pass::getProgram` keeps the program built from the pass' sources (same shaders, name and bindings) until the
  technique is recompiled (new `Pass` objects) or `Pass::dirty()`.
- A technique a Lua script loads (`postprocessing.load`, normally from the scripts' load under the loading screen) has
  its programs handed to the incremental compile operation (`PostProcessor::orthrosPrecompile`). Its first enable
  then links nothing.

Measured (`fxshot.mjs`, Vanilla+ EN, SwiftShader, 1280x800, numpad-driven enable/disable of `radial-blur` from a scratch
Lua root, load 23-27 from other projects). Without rasterizer discard, the frame of the first enable went from 1503 ms
(18 shaders compiled, 9 programs linked) to 49.5 ms (0), and the second from 1339 ms to 18 ms. With discard: 358 ms to
48-50 ms, then 232 ms to 13-17 ms. The steady frame's p50 is 12-13 ms. The first enable's remaining ~35 ms is the
program's first draw, the driver's lazy work. At load, the precompile adds 18 compiles and 9 links. A sibling change
(skipping `createObjectsForFrame` and the render targets' new storage when nothing they depend on changed) showed no
difference in the toggle frames, even at 2560x1440 (enable 44/14/16 ms on, 40/13/16.5 ms off), so it was left out.

Data overlays installed with that release (each file has the same original hash in EN and FR):
`orthros-overlay-all` `shaders/radial-blur.omwfx` (RUN!: GLSL ES 3.00 has no implicit int-to-float conversion, so
`float(uSamples - 1.0)` and `col /= uSamples` are written `float(uSamples - 1)` and `col /= float(uSamples)`: same
values; with the author's file the pass did not link, and the canvas drew the frame flat with its fallback program
while sprinting), and `orthros-overlay-all-pack` `scripts/MaxYari/combat juice/player.lua` (`cj_flash` built and warmed
as the author does, then in the chain only while a flash runs, enabled in the frame that sets its first non-zero
strength, at the place the author's flow gives it; at strength 0 both its passes leave the frame unchanged). Measured
with discard, same build, 3-4 flashes per run: the frames where a flash starts and ends cost 8-18 ms, like their
neighbours. The windows' slowest frames fall mid-flash, with or without the overlay (maxima 17-37 ms with it, 14-31 ms
with the author's file; idle p99 24-28 ms). Between flashes the
frame is ~4 ms cheaper on SwiftShader (8 against 12-13 ms; the always-on shader's copy and mipmapped bright pass). The
Combat Juice overlay needs `OPENMW_ORTHROS_FXPROGRAMS`: with it at 0, every flash start and end recompiles the chain
the old way, a hitch the author's always-on file never had. For a true old-path comparison, set the switch to 0 and
load the author's `player.lua` (a mods list without that overlay file). Install the overlays and the defaults'
withdrawal (`player-defaults.mjs --withdraw`) only in the manifest change that moves the versions to the release
carrying the patch.

### LuaUi layouts without redundant passes: engine orthros-r17 (2026-10-30)

`orthros-r17.patch` (r16 + two changes, each behind its switch): `OPENMW_ORTHROS_PRELOADPATIENT` (above) and, in
`components/lua_ui`, `OPENMW_ORTHROS_LUAUILAYOUT` (a Flex's second layout pass skipped when its first changed no child's
size or position) with `OPENMW_ORTHROS_LUAUITEXTSIZE` (a TextEdit's text height kept per width and text). Each has a
`check` mode (`=check`: on, and the skipped pass or kept height computed anyway and compared): over 30 s of a fresh
load, 1.16 M Flex second passes left out and 524 k heights kept, 0 different. Measured on r16 + them (SwiftShader
`--discard`, 3 alternated runs each): LuaUi 0.62-0.74 → 0.46-0.50 ms/frame; fresh load work p99 35.0 → 32.4 ms, max 116
→ 77; the `LuaFlex::updateCoord` hitches (up to 156 ms) gone. `OPENMW_ORTHROS_UITEXAHEAD` (image sizes read ahead) is in
the patch but off unless `=1`: one promising run, the thin link not measured. Left out on their numbers: the chunk
slicing/threading (no gain, a day-view difference unexplained) and the Lua profiler (diagnostic). Live, Vanilla+ FR fresh
load: work p99 31.8 ms, max 74, no frame over 100 ms, no error. Evidence: `data/proof/openmw-perf/round6/`.

### Two clients: a remote player's copy thrown far off after a jump: engine orthros-r18 (2026-10-31)

`orthros-r18.patch` (r17 + one change, no engine source: the client's MWMP script and its Lua test). Every failed run of
the two-client check (`mp-check.mjs`, on r16, r17 and the JSPI development release alike) failed the same way. After one
of the debug teleport's 300-424-unit moves, the watcher's copy of the mover stood 15,607-35,173 units off (567,898 after
the 8,800-unit move into the next cell). It stayed there for the check's 90 s, until the mover's next move fixed it.
Players reported the same: after a friend's recall, intervention or any jump, the friend's figure stayed far away until
they moved again.

The cause is the client engine's MWMP script `scripts/mp/interp.lua` (openmw-web's, packed into `openmw.data`). The check,
the page's WebSocket glue and the native gateway were ruled out. A pose's time is its arrival time, smoothed only when the
gap to the previous pose is 5-500 ms. Two poses handled a few ms apart (two batches bunched by a slow frame or by the
link, routed in one frame) keep their 1-5 ms gap. The extrapolation past the newest pose divides the last step by that
gap: EXTRAP_S (0.09 s) / 0.002 s carries a 300-unit teleport 45 times, to 13,500 units. The server relays a pose only when
it changes, so nothing came to correct it. Measured with the script alone: 13,500, 6,750, 5,510, 4,500 and 1,350 units off
for arrival gaps of 2, 4, 4.9, 6 and 20 ms, and 409 units after an ordinary 66 ms gap.

The fix (interp.lua `sample`): the step's time is at least the stream's mean gap (33 ms before one is known). A step faster
than 2,000 units/s (a teleport, a cell change, a snap) counts as a jump and is never extrapolated. An ordinary step still
is. The engine's own `wasm-build/lua-tests/run.lua` gets the case: before the fix its three new checks give 2 failures
(13,500 and 409 units off), after it 0 units at every gap. The existing interpolation and late-pose checks are unchanged
(Lua 5.4.7 built from the tree's sources, with Lua 5.1 shims for `loadstring`/`setfenv`). The two-client check with the
fix (built in the JSPI development release `r18dev`): 4 of 4 passed, the copies within 0-38 units after each move and 0-36
in the next cell. The live r17 passed 1 of 3 (12,456 and 229,908 units off in the failures). Because r18 changes
`interp.lua` inside `openmw.data`, the package gets a new content hash, and the server builds its lean package once
(~70 s) at the first boot.

Built 2026-10-31 (`tools/openmw/build.sh`, compiled in 893 s; release `e/a2808b8cf12a/`): openmw.js `3769b921…`,
openmw.wasm `7aae70d3…`, openmw.data `2c6b8e83…` (204,616,507 bytes, 33,446,823 in brotli), pinned in lock.json.
Its lean package (rule 3) was made ahead of the switch with `openmw-lean-worker.js` in 66 s: 4,133,415 bytes
(r17's: 4,132,827).

**Validation against the live r17 (2026-10-31): SHIP.** The installed release, served by scratch servers of this
branch's code (`--games-dir` a scratch overlay whose four Morrowind versions run r18, `--engines-dir data/engines`), each
on its own fresh copy of the live learned state and a frozen copy of the live br-cache (r18's pre-built lean package in
it), against the live r17 served by main's code (30ff5ec) the same way; interleaved, one browser at a time. Results and
scripts: `tools/openmw/results/r18-release-2026-10-31/validation/`.

- Two clients (`mp-check.mjs` of the r17 results, `morrowind-goty-en`): **r18 3 of 4, r17 1 of 3.** r18's passes left
  the watcher's copy 3-43 units from the mover after each 244-491-unit move. Its one failure (r18-5) was A's third move:
  the copy stayed 58 units off for 90 s, against the check's 48. That is a small rest offset, not the jump, and r18dev-d
  had one like it (57). r17's two failures were the jump bug, 14,618, 15,564 and 26,351 units off. A first r18 run was
  lost before it started (the gateway found no `data/` in the worktree) and was run again.
- `check.mjs morrowind-goty-vanilla-plus-en`, EN and `--lang fr` (ran `-fr`): passed, 34,626 and 30,885 draws.
  `overlay-check.mjs --engine …-r18` for both games: every overlay agrees with its original.
- In play (`perf.mjs --query tier=mid --discard --seconds 60 --warm 0`, `morrowind-goty-en`), 8 runs a side over three
  rounds. The third round crossed engine and page code: r17's engine with this branch's page, 16.6-19.3, and r18's
  with main's page, 19.1-21.2, so neither part carries a steady cost. **Parity within the machine's noise** (load
  average 10-25 during the runs):

  | | fps | work p50 | work p99 | frames' work over 16.7 / 33 ms | gap p99 | longest gap | data stall ms |
  |---|---|---|---|---|---|---|---|
  | r17 (8) | 23.9-25.6 (median 25.1) | 8.0-9.2 | 17.7-20.9 (median 19.2) | 17-49 / 3-6 | 66.7 | 200-350 | 227-359 |
  | r18 (8) | 24.0-27.5 (median 24.4) | 7.1-9.8 | 16.6-23.8 (median 20.4) | 15-45 / 3-6 | 66.7 | 200-367 | 202-345 |

  In the first two rounds, three r18 runs were above r17's highest work p99 (21.4, 22.3, 23.8). In the third round,
  r18 had the lowest work p99 (16.6) and the highest fps.
- Save loaded from the menu (`place-load.mjs --mode save`, save at -2,6, warm profiles), 2 a side:
  - 1.8 MB/s: r18 in the world 4.8 / 4.9 s after the key (frozen 4,700 / 4,733 ms), r17 5.0 / 5.0 s (4,883 / 4,850).
    The background during the frozen frame was 2.21 / 2.37 MB for r18, against 3.77 / 3.49 MB for r17.
  - 85 KB/s (`--rate 85k`): r18 27.4 / 27.4 s (frozen 27,349 / 27,266 ms), r17 27.8 / 27.7 s (27,566 / 27,582). Menu
    10.3-10.6 s on both.
- Lean package (`validation/lean-engine-files.txt`): the r18 warm-up fetched `…923d/lean3/openmw.data` (4.13 MB) and
  never the full 33 MB package. Warm runs fetched no engine file.
- The shared page code (this branch's `http-backend.js`) on the other runtimes:
  - GoldSrc: `goldsrc/check.mjs half-life-original-en solo` passed.
  - re3: `re3/check.mjs vice-city-revc --new-game` passed (306 buffers heard, 14 read samples heard).
  - Win32: `headless.mjs bfme1-108 --seconds 60` running with no crash, still on its splash screen at 60 s.
  - Thin link: `bfme1-108` behind `net-proxy.mjs --rate 85k --rtt 50`, 300 s, main against this branch. Both runs were
    the same: 395 game reads, 20.5 MB; 460 other requests, 2.9 MB; 3 frames. Neither had a read-ahead or reached the
    menu's music in 300 s, so streamed audio could not be compared there. re3's streams were heard on this branch.
- `make test`: 1689 passed, 0 failed (1 skipped).

### Lua UI textures fetched when declared: measured, kept off (round 7, 2026-10-30)

The commonest remaining hitch is a LuaUi image's first show: `LuaImage::updateProperties` > MyGUI `getTextureSize` >
`OSGTexture::loadFromFile` reads the whole texture synchronously (a `fetchSync` when its bytes are not in the page). r17
carries a fix behind `OPENMW_ORTHROS_UITEXAHEAD`, off unless `=1`: a path's first `ui.texture` registration asks the
page for its bytes (`orthrosRangeReady`, on the page's thread through `mainThreadPost`); the image read later is the
same. Vanilla+ FR declares 556 textures, 525 not in the page yet (~22 MB). A/B on r17 (`perf.mjs --discard --profile`,
default against `?omwenv=OPENMW_ORTHROS_UITEXAHEAD=1`, alternated; work in ms over the whole run, loading included;
counts are frames):

| scenario (runs off / on) | p50 off / on | p99 off / on | max off / on | over 16.7 off / on | over 33 off / on | fps off / on |
|---|---|---|---|---|---|---|
| fresh, `--warm 0 --run` 30 s (3 / 3) | 10.9 11.1 10.6 / 11.3 12.1 10.9 | 31.3 29.6 25.7 / 26.2 33.5 25.1 | 59 50 36 / 39 42 80 | 77 79 66 / 87 101 62 | 4 5 4 / 2 8 2 | 25.9 26.9 27.9 / 26.1 24.1 26.5 |
| `--net-after 1500` (2 / 2) | 10.5 12.4 / 11.4 12.3 | 32.0 32.9 / 27.5 29.9 | 134 95 / 37 57 | 57 98 / 83 132 | 8 6 / 2 5 | 26.7 24.2 / 25.3 23.3 |
| 1500 KB/s from the page's load, 20 s (3 / 3) | 12.8 (37.1) 13.5 / 12.6 13.9 12.8 | 111 (523) 158 / 33 29 29 | 626 (990) 268 / 241 264 240 | 73 (202) 92 / 80 98 64 | 5 (131) 5 / 4 3 2 | 23.0 (9.9) 23.8 / 24.4 24.3 24.3 |

In parentheses: `off-thin2`, a degraded outlier (fps 9.9, 131 frames over 33 ms), left out of the comparisons below.

What it gains: the image's synchronous reads leave the frames (`getTextureSize` 66-84 ms per fresh run off, 22-38 on;
the data stall roughly halved on the local link and on the link thin from the load, ~10× smaller after the link is thinned), and on the thin links the long
frames go (over 100 ms: 5 / 5 off, 2 2 2 on; the `LuaImage` read-sync hitches up to 675 ms gone). On the local link it is
*not* a frame gain: over 33 ms 13 off / 12 on, the worst frame 80 ms on against 58 off.

What it costs, and why it stays off: more frames miss 16.7 ms where the link is fast enough for the fetches to land
during play — over 16.7 ms 222 → 250 fresh, 155 → 215 after the link is thinned (+39 %), p50 up in 4 of those 5 pairs,
fps lower in 4 — the fetches' completion (decompression, block store writes) on the page's thread: a big hitch spread
into many medium frames, which a 60 fps target does not accept. And on a link thin from the page's load the world shows
up later: 85.6 / 86.3 s off against 92.2 / 89.1 / 89.4 s on (every on run 2.8-6.6 s slower than every normal off run;
`off-thin2`, 102.4 s, is the outlier) — the fetches have no priority below the world's announced reads. Not checked: a
frame-compare on the thin link (pop-in of the world while they take the link) and one frame-compare load that never
reached the world within 900 s, which arm unknown (no console kept). `frame-compare.mjs` on the local link, day view:
the interface areas identical.

So `uitexahead.patch` (the default flipped) is not shipped; the switch stays off unless `=1`. Its next form, if taken
up: the declared paths queued and released a few per frame, held while the loading screen is up or the world's
announced reads are pending, then over 16.7 ms, p50, over 33 and the time to the world measured again (≥ 5 alternated
pairs per scenario) before any default changes. Evidence: `data/proof/openmw-perf/round7/`.

### The draw thread (off by default) and screenshots on WebGL2: engine orthros-r19 (2026-10-31)

`orthros-r19.patch` (r18 + two changes):
- **Screenshots** (`deps/src/osg/src/osg/Image.cpp`, `#ifdef __EMSCRIPTEN__` in `osg::Image::readPixels`): F12 read
  `GL_RGB`/`GL_UNSIGNED_BYTE` (the window has no alpha), which WebGL2 refuses — the PNG was the image's uninitialised
  allocation (black, or noise). An `RGB`/`BGR`/`BGRA`/`RED`/`ALPHA`/`RG` read of unsigned bytes is now done as `RGBA` and
  converted into the image's own format and row padding; every image is zeroed before its read, so a refused read is
  black, never garbage. Checked: F12 writes the real picture (HUD included, the right way up); save thumbnails and the
  global map unchanged.
- **The draw thread** (`OPENMW_ORTHROS_DRAWTHREAD`, **off** unless `1`; `discard` for `perf.mjs --discard`; QA values
  `crash`, `lose`, `fail`, `refuse`, `mismatch`): OSG's own default threading (DrawThreadPerContext, as desktop OpenMW)
  instead of the web build's forced SingleThreaded. The GL draw runs on a pthread owning an OffscreenCanvas whose WebGL2
  context is made in `preRun` (`wasm-build/orthros-gl.js`, before `main()`); the draw thread is event-driven — it returns to
  its event loop after each frame, each frame a task proxied to it — because Chrome frees a transferred ImageBitmap only
  through a task on the worker that made it (a blocking draw loop leaked ~4 MB of GPU memory a frame: rounds 8-9, repro in
  `data/proof/openmw-perf/round9/leak/`). Frames reach the page as ImageBitmaps on an opaque `bitmaprenderer` layer
  (newest frame wins); GL work the page thread needs (texture uploads ahead, the global map read) runs as draw-thread
  jobs; a crash or a lost context shows the page's notices and syncs saves. Measured on this GPU-less server (rounds 8-10,
  `data/proof/openmw-perf/round10/validate/`): page work p50 −22-27 %, frames over 16.7 ms −40-67 %, GPU memory flat over
  300 s (walk, menu with real drawing), pictures/GUI/F12/thumbnails/map within noise; but the page's frame-gap tail is
  worse (p99 +6-12 ms, the first second in the world 225 vs 93 ms), 0.3-1.8 % of frames take two vsyncs, and real
  SwiftShader drawing is 10 % slower — the GPU process's software swaps, not the engine, set the pace here. So it ships
  off; `?omwenv=OPENMW_ORTHROS_DRAWTHREAD=1` tries it on a real GPU. With r20's JSPI its boot can use the yield point
  (`data/proof/openmw-perf/round8/r18-boot-yield-note.md`). Tools: `tools/openmw/dtprobe.mjs` (latency, screenshots,
  saves, crash checks), `perf.mjs --trace` and the frame timeline (`OPENMW_ORTHROS_DTTIMELINE=1`).

### The steady frame attributed; overlays of the engine's own scripts checked at each release (round 6, 2026-10-30)

Reference r16, Vanilla+ FR, `perf.mjs --run --profile --discard`, 30 s: busy 11.05 ms/frame (osg-draw+GL 3.02,
osg-cull 1.68, engine-other 1.46, lua-sync 1.12, other 0.72, mechanics 0.73, osg-update 0.68, gui 0.66, sound 0.45,
lua-ui 0.34). `synchronizedUpdate` is 1.62 ms/frame inclusive: the player's and the menu's onFrame handlers 0.80,
`applyDelayedActions` 0.60 (LuaUi `Element::update` 0.54), the input actions' update 0.17-0.30. The Lua there is
interpreter time: no engine API reached from Lua costs over 0.013 ms/frame. Per script, through the opt-in diagnostic
`luaprof.patch` (`OPENMW_ORTHROS_LUAPROF=1`, below): Skyrim compass 0.27, playercontrols 0.10, HUDMarkers 0.09, camera
0.07, Combat Juice and SneakPlayer 0.05 each, the rest under 0.03; one UI element queued from the Lua thread ~2.6 ms
about 3 times a second (0.23 ms/frame, rebuilding its content; not yet named), the compass's marker updates 0.16 (real
position changes, already diffed).

Micro-savings, not counted toward the p99 target (whole-frame p50/p99 moved within noise):
- `orthros-overlay-all-perf` `scripts/omw/input/smoothmovement.lua`, an overlay of the engine's **built-in** script
  (`of: "openmw built-in"`): the five binding callbacks (SmoothMove ×4, Run) re-read the controller's two axes,
  `isOnGround` and `isSwimming` in the same input-actions pass. Those reads are kept for the pass (nothing in Lua can
  change them during it: the input state of the frame and the physics state, which Lua changes only through delayed
  actions), cleared by the script's onFrame after the pass. What an action handler running inside the pass can change
  synchronously — `controls.sneak`, the walk and run speeds (encumbrance through `activeEffects:modify`) — is still
  read at every call, in the original order. Checked under Lua 5.4 with stubs against the original: identical action
  values over 3 × 3000 random frames with handlers flipping sneak and speeds between bindings, 64 % fewer engine
  calls. About 0.035 ms/frame.
- `src/host/perf-record.js`: the session record's data summary compacted when a record is taken, no longer at every
  1 s clock tick (it sorted every file the session ever waited for: ~1-1.5 ms a second, only where the server keeps
  telemetry — not in `dev-serve.sh` measurements).

An overlay of a built-in script depends on the engine release: a new release that changed the original would have it
silently brought back. **At every engine release change** of an OpenMW game, before its manifest names the new release:
`node tools/openmw/overlay-check.mjs data/games/<game>/manifest.json --engine <new release id>` — it hashes the
release's packed original (`e/<build>/openmw.data`, through `openmw.js`'s package list) against each built-in overlay's
`originalSha256`, and every installed overlay file against its `sha256`. On a mismatch, regenerate the overlay from the
new original (and re-measure) or withdraw it. When a mod is added to Vanilla+, read its `registerActionHandler`
bodies: one that changed the player's ground or water state synchronously would void the smoothmovement overlay's
invariant (none can through the current API).

`luaprof.patch` is a measuring tool, never part of a production stack: opt-in (absent = off, unlike the
`OPENMW_ORTHROS_<NAME>` switches), one cached static test per call when off. On, it sums the page thread's Lua time by
script, handler, binding and delayed action, with the Lua line that queued each action — taken on whichever thread
queued it, only while that thread runs Lua (inside `protectedCall`, `LuaManager::update` or `synchronizedUpdate`),
followed into the running coroutine, kept in the action and summed on the page thread.

### Chrome's code cache off the main thread (2026-10-29)

The hitch hunt's "(program)" stretches (main thread busy with no script frame: 3.8/min in steady play, 78 ms mean, up to
203 ms, 10.8 % of the hitch time) were traced (CDP Tracing, `v8.wasm` + `toplevel` + `devtools.timeline`, one session
from the page's load). Not V8's lazy compilation: it is on (`wasm.CompileLazy`, Liftoff on the calling thread — 12,700
functions, 1.2 s on the main thread), but 95 % of it falls in the loading; in play 10-18 ms over 40 s, never a burst
over ~17 ms. Not tier-up: TurboFan compiles on thread-pool threads. One share of them is Chrome's WebAssembly code
cache. The glue streams the module from its fetched answer (`instantiateStreaming`, `application/wasm`, immutable
content URL: eligible), and Chrome then works the cache on the thread that compiled: each time V8 has ~1 MB of new
optimized code, the whole module is serialized again (`wasm.SerializeModule`, 20-55 ms on a thread-pool thread) and
its 18-25 MB copy handed to the cache by a main-thread task without script (`OnMoreFunctionsCanBeSerialized`,
v8_wasm_response_extensions.cc: 21-57 ms here, growing with the cache): 14 of them in a first visit's first minute (8
in the loading, 6 in the first 30 s of play), 2 on a later visit (one of them in play), and a cache hit's
`wasm.Deserialize` 270-320 ms on the main thread at the boot. Measured on dev-perf (SwiftShader `--discard --glide
8000,0`, a persistent profile, Playwright's request routing off — it disables the HTTP cache, so every measurement
so far was a first visit). These commits (21-57 ms) are not the hunt's longest stretches (123 and 203 ms): the rest of
"(program)" is V8's major GC finalization (47-64 ms ~8 s after the world's entry in every run, JS GC), Oilpan sweeps
(14-35 ms), a data-client message whose continuation copies 16-31 ms (the data reads'), and the profiler itself
(`CpuProfiler::StartProfiling`, 160 ms at a profile's start).

`src/ports/openmw/wasm-code-cache.js` (put in the engine page's head ahead of its `Module` literal and glue,
`withWasmStream`) gives the glue `Module.instantiateWasm`: the module compiled by `compileStreaming` in a worker
(`wasm-compile-worker.js`, started as the script runs, so its script and isolate are ready while the glue downloads;
kept for the page's life) from the same URL, posted to the page and instantiated there (the pthreads get it from the
page as before: one module, its code and tier-up shared). Chrome's cache is then read and written on the worker's
thread. A worker that fails: the module streamed in the page as before; an instantiation that fails, or no module
anywhere: `Module.onAbort` (the page's fatal overlay), as the glue's own abort. `?omwenv=OPENMW_ORTHROS_WASMWORKER=0`:
the glue's own path. Measured (40 s from the world's entry, same profile): main-thread code-cache commit tasks in play
6 (cold) / 1-2 (warm) → 0, both in the worker; a later visit still hits the cache (deserialized in the worker in 44 ms,
11,744 functions optimized from the start; main-thread lazy compile 143 ms against 1,155 cold), early frames as with
the cache in the page. What this takes off the main thread: the commits, ~50 ms once or twice in a returning
session's play, six in the first 30 s of play after each new release, and the cache hit's deserialization at the
boot — a small part of the hunt's "(program)" time, not its 10.8 %; the hunt's metric ("(program)" stretches over
25 ms a minute, long frames in play) was not measured again before/after. A cache written by the page's compile is
not read by the worker's (another key): the first visit after this change is a cold one, so it ships with the next
engine release (its new content URL makes that visit cold anyway). Chrome's cache could also be refused outright (the
module streamed from a `Response` the page builds: no URL, no cache): 0 commits, but every visit cold (+1.1 s
main-thread Liftoff in the loading, ~3 s more TurboFan in the first 40 s, first 10 s of play p50 12.0 / p90 23.2 ms
against 9.8 / 15.0) — not kept.

### Waits that yield to the browser: engine orthros-r20 (2026-10-29)

The owner (2026-10-29): Vanilla+ slow, and Chrome keeps saying the page is not responding. After the boot's scripts
announced (above), what still held the page's thread was the engine waiting for its files on it: every read of bytes not
in the page spun on shared memory (`data-client.js` `fetchSync`) — a save's load blocked the page 9 s, a mouse move
answered after 250 ms. `orthros-r20.patch` (on r18; written and measured on r14 as `r15dev*`, before `main`'s r15
and r16 existed, then renumbered and its context regenerated on r16 as `orthros-r17.patch` — the measures below compare
it with r14, then with the live r16 —, renumbered r18 once `main`'s own r17 (patient preloads, LuaUi layouts, above)
shipped first: regenerated on r1..r17, the two patches touching no file in common; its only change then this play page's
`?preloadwait` comment, which now says r17's 60 s. Below, "r20" names this release in every measure, including those
made before the renumberings; the dev builds keep the names they were built under, `r17dev*`, and their results stay in
`tools/openmw/results/r17-2026-10-30/`; then renumbered r19 on 2026-10-31, when its MWMP `interp.lua` fix ("Two clients",
above) left it for a release of its own, r18: the former `orthros-r18.patch` without the `interp.lua` and `run.lua`
hunks, applied on r1..r18 — together they make the same tree —; the dev builds and their results keep their names,
`r18dev*` and `tools/openmw/results/r18-2026-10-30/`; then renumbered r20 the same day, when `main`'s own r19 (screenshots
as RGBA, the draw thread off by default: "The draw thread", above) shipped first: `orthros-r20.patch` regenerated on
r1..r19 — the two touch `engine.cpp` and `loadingscreen.cpp` in different places, merged without a conflict —, the lock
entry r20 = r19's patches + `orthros-r20.patch`, r19's exports + `orthros_jspi`. Below, "r20" names this release in every
measure, whatever its name then (r17, r18 or r19); the dev builds `r19dev-a`, `r19x-a.patch` and the results
`tools/openmw/results/r19-2026-10-31/` keep theirs; "the live r18" or "r17" is the live release of that day) makes those
waits yield:

- **JSPI** (`wasm-build/orthros-jspi.js`, linked `-sJSPI` with `omw_pump_frame` and `main` promising exports): a read
  (`orthros_fd_read_async`) or an announced wait (`orthros_read_wait`, `VFS::orthrosReadWait`) under the frame or the boot
  asks the page first — `orthrosStreamed.soon`, `orthrosReadWaitSoon` (docs/slow-network.md "Waits that yield to the
  browser": up to 10 ms on the page's thread, the browser's copy answers most reads that fast) — and suspends the
  engine only on the promise the page returns, the page's thread free meanwhile (input, its indicator, the frames
  presented); the read itself then runs as before, from the page's pieces. One suspension at a time, only under those
  two exports (`orthros_jspi_enter` / `orthros_jspi_leave` around them, engine.cpp, main.cpp); anything else that enters
  the engine reads synchronously, as before. The page schedules the next frame once the frame's promise settled
  (`play/index.html` `pumpFrame` / `pumpDone`), never during a suspension.
- **A frame of play is plain** (since 2026-10-30, below "The renderer crash"): the page pumps `omw_pump_frame_plain` —
  the same frame, a plain export on the page's own stack, nothing suspends under it (`orthros_jspi_plain`) — and the
  promising `omw_pump_frame` only for a load: a save's load, a new game or the debug COE asked in a plain frame is put
  off to the next frame by the engine (`orthros_jspi_defer`: `StateManager::update`, the save dialog's load now asked
  as the quick load and the menu script ask it, `orthrosRunDebugAsks`), which the page then pumps promising; a frame
  that starts with a loading screen on is promising too. A load that starts by itself in a frame of play — a door, an
  exterior crossing — runs there synchronously, as r16's. `?jspiplain=0` (`OPENMW_ORTHROS_JSPI_PLAIN=0`): every frame
  promising, as r20's first builds; `Module.orthrosFrames` `{ plain, promising }` counts them (`StreamFS.jspi().frames`).
- **The suspending imports only when the engine may**: V8 throws `SuspendError` when a `WebAssembly.Suspending` import
  is called outside a promising export, even when it returns a value at once (measured in Node 24 and seen in Chrome:
  the first plain frame's post-processing shader read). So the C library's `read`, `fsync` and `sleep` are linked
  `--wrap`'d (`link-openmw.sh`; `engine.cpp` `__wrap___wasi_fd_read`, `__wrap___wasi_fd_sync`,
  `__wrap_emscripten_sleep`): the suspending import (`orthros_fd_read_async`, `orthros_fd_sync_async` — Emscripten's
  JSPI fsync, which persists IDBFS and waits —, `emscripten_sleep`) when `orthros_jspi_may()` says the engine is under
  a promising export and not suspended, else the plain one, as a build without JSPI (`fd_read`, `fd_sync` without
  IDBFS' persist, a sleep that spins); the loading screen's present / breathe / settle and the announced wait ask the
  same (`orthrosReadWait` then the page's `orthrosReadWait` as before).
- **The GPU's queue in a load's frame**: WebGL's `checkFramebufferStatus` waits for the GPU process to run every
  command before it, and the world's first draw after a save's load held the page's thread there 1-2 s in SwiftShader
  (the CPU profile of the load: 1.1 s in `checkFramebufferStatus`, 0.76 s native). `glCheckFramebufferStatus` is
  linked `--wrap`'d: in a load's frame — the boot, a loading screen on, and the rest of the frame after it
  (`loadFrame`: the world's first draw) — the engine first suspends until a fence says the GPU ran its queue
  (`orthros_gl_settle`, at most every 50 ms of its time, 300 ms at most since 2026-10-30 — 2 s before, which put the
  world 1.0-1.2 s later: below, "(B) The warm F9 to the world" —; `?jspiglmax=N`; `?jspigl=N`, 0: never), then asks; the reads of
  that rest of the frame suspend as a load's. The outermost loading screen's end waits for the GPU's queue the same way
  (`orthros_jspi_settle`, `?jspisettle=N`; measured ~1 ms: the queue was already empty there).
- **Worker threads' reads** (r14's Lua update on its own thread: its `require`, its localisation): proxied to the
  page's thread, they are the plain `fd_read`, answered at once, synchronously — never a pending promise: the
  page's thread serves them inside `Worker::finishUpdate`'s futex wait for that very thread, where no promise could
  settle (a pending one there is a deadlock). Their bytes missing, they wait on the page's thread as before r20
  (`Module.orthrosBlocked.proxied` / `proxiedMs` / `proxiedMax`: the reads that took 1 ms or more).
- **Worker threads on their own stacks** (since `r19dev-a`, 2026-10-31): Emscripten under `-sJSPI` starts every pthread
  through `WebAssembly.promising`; `orthros-jspi.js` replaces its `$invokeEntryPoint` with the plain one — no worker
  thread may suspend (the suspending imports are the page's thread's), a worker's `emscripten_sleep` sleeps on its futex
  (`emscripten_thread_sleep`) — so a worker's import calls cost what they did before r20 (15 ns against 5 on a JSPI
  stack, measured in Chromium 153) and its samples are attributed again by the CPU profiler (on a JSPI stack: `(program)`).
- **Nothing else enters the engine's state during a suspension**: the page's calls (`Module._omw_*`, `Module._orthros_*`
  but the marks, `Module.ccall` whole — its strings live on the stack for the call alone —, `cwrap`'s functions) and
  the engine's own WebSocket events (multiplayer: MWMP's "callbacks never interleave with a frame") are put off, in
  order, to a microtask after the frame's or the boot's end — before any other task —, 0 returned to the caller
  meanwhile (`Module.orthrosEngineBusy()`, `Module.orthrosAfterEngine(fn)`). Input events reach SDL's queue at once
  (html5 callbacks answer synchronously): the next frame reads them. Not put off: an `emscripten_async_call` timer
  (the settings window's deferred save), the page's own WebSockets, and `omw_save_settings` (it reads no game file, and
  the page's leaving — `__omwSync` on pagehide, its own reload — persists the settings file right after it: put off,
  the options changed since the last save were lost). A WebSocket event put off is dropped when, by its turn, its
  socket was deleted or its handler replaced (`emscripten_websocket_delete` nulls the handlers, which no longer cancels
  a queued event: MWMP's `WebSocket::close` then `NetManager::connect` reuse the same object, which would get the old
  socket's close or message).
- **The debug COE and teleport** (`omw_debug_coe`, `omw_debug_teleport`: `place-load.mjs --mode coe`, `perf.mjs
  --glide`) run at the next frame's start, inside it, as a console COE or a door — up to r14 in the export's own call,
  where no read can suspend (the COE row then measured the page's thread held whatever the build) —: the last of each
  asked since the previous frame, a COE dropping a teleport asked before it; each one's time told to the page,
  `globalThis.orthrosDebugRan[kind] = [start, end]` (`place-load.mjs`: `coeSyncMs` the call to that end, `coeInFrame`,
  `coeWaitMs` the call to its start).
- **A pump while a frame is in flight runs nothing** (`play/index.html` `pumping`): the stale rAF after a hide and
  show during a suspension would otherwise count a 0 ms frame and start a second chain of empty pumps until the
  suspended frame's end (`__fps`, `__frameMs`, the bench's `work`).
- **The frame's time is the whole frame's**: `frame-meter.js` `orthrosFrameTimer` (the bench hooks, `tools/openmw/
  perf.mjs`) times a frame that returned a promise until it settles — `work` as before, the suspensions included —,
  and reports the part suspended (`Module.orthrosSuspendedMs`: perf.mjs `workEngine`, `suspendedMs`).
- **The release's mark**: the export `orthros_jspi` (returns 1; in the lock entry's exports, as
  `orthros_content_light`); in the page `StreamFS.jspi()` → `{ on, suspendedMs, blocked, soonSpins, soonSpinMs,
  soonSuspends, soonWaits }` (`on`: the release suspends). `place-load.mjs` rows carry it in `jspiProbe` with the
  page's longest block (a 20 ms timer's lateness) and the input delays (a mouse moved every 250 ms) over the load, and
  in `jspiAfter` over the `--after` stretch — the view raise `view-grow.js` makes once the load is quiet —, its reads
  over the network beside it (`afterReads`).
- **A data worker that died** while the engine is suspended on a read it was asked by message: rejected after 30 s
  without its heartbeat (`GameData.watchAsks`), the read then tried again synchronously and failing as before r20 —
  never a frame suspended for ever, silently.
- **Switches**: `?jspi=0` (`OPENMW_ORTHROS_JSPI=0`): never suspends, every read as before r20; `?jspispin=N`
  (`OPENMW_ORTHROS_JSPI_SPIN_MS`): the page's wait before a suspension in the boot and under a loading screen (0: at
  once — the spike's behaviour); `?jspiplay=N` (`OPENMW_ORTHROS_JSPI_PLAY_SPIN_MS`): suspends in play too, after N ms
  (by default never: below, "r16dev-c"); `?jspipresent=N` (`OPENMW_ORTHROS_JSPI_PRESENT_MS`, 200; 0: never): a loading
  screen's frame shown at most every N ms; `?jspibreath=N` (`OPENMW_ORTHROS_JSPI_BREATH_MS`, 100; 0: never): in a load,
  a read gives the page's thread a turn when it had none for N ms. The page's: `?wholeloads=0`, `?heldreal=0`
  (docs/slow-network.md).
- **In a load only** (`wasm-build/orthros-jspi.js` `orthrosMaySuspend`, `orthrosSpinMs`; `mwgui/loadingscreen.cpp` tells
  `orthros_jspi_loading(1/0)`, `main()` and the frame `orthros_jspi_enter(boot)`): in the boot and while the loading
  screen is on, 10 ms before a suspension; in play — the menu included — never: every read waits on the page's thread
  as r16's (first 100 ms then a suspension, until r16dev-c: below). `Module.orthrosLoading()`; `Module.orthrosBlocked.play`
  / `playMs`: the suspensions in play (0 by default).
- **The loading screen shown, the page given turns** (r16dev-c): `LoadingScreen::draw` calls `orthros_jspi_present()`
  after its frame — the engine suspended until the browser's next rendering update ran (a task posted from
  `requestAnimationFrame`: it resumes after the update, never inside it; 100 ms at most on a hidden page), at most every
  200 ms —, and in a load a read that finds the page's thread held 100 ms since the engine's last suspension first
  suspends for one posted message's round (`orthrosBreath`: input and the page's timers run). A load whose reads the
  browser's copy answers within the short wait otherwise suspends nothing: r16's loading screen was drawn and never
  shown, a COE one frozen picture. `Module.orthrosBlocked.presents` / `presentMs`, `breaths` / `breathMs`.
- **No put-off of distant chunks.** The first r20 build carried `r14dev`'s put-off patch (above) revised — the frame's cull
  alone putting off a distant chunk whose files were not in the page, its wait counted from the page's turns
  (`window.orthrosTurns`) and the link's last bytes (`window.orthrosReceived`), `?cullwait=N` —; measured against
  `?cullwait=0` on that build (the first measure below) it added nothing to JSPI's suspensions — the same frame gaps and
  serial reads at a view raise, the page's longest block 0.8-1.0 s with it against 0.13-0.17 s without — and it was
  dropped: the terrain is r14's, a chunk the cull builds reads its files in that frame, the frame suspending meanwhile.

- **The engine's WebSocket handlers**: a handler the library wrapped is current for its socket while it is the one the
  library's setter last set (a `WeakMap`), not while the socket's getter returns it: a script that wraps the same
  setters (the first two-client check's own counter did) made the getter answer its function, and every event of the
  engine was dropped — the session stuck at "Connecting", the world closing it ("SessionHello not received in time").
  `tests/openmw-builds.test.js` runs the patch's wrappers on a stand-in `WebSocket`, with and without another script's
  wrappers of the same setters: events delivered at once, put off while suspended and delivered in order after, a
  replaced handler's or a deleted socket's queued event dropped, the page's own sockets untouched — and the getter-based
  check, put back, drops every event there.

Development build only (`openmw-web-v1.5.3-orthros-r15dev-c` in scratch, engine `4df4af25df31`, the fourth measure's —
`r15dev-d`, `78f27515a025`, measured beside it and not kept, adds a budget of the frame's waits in play —; `r15dev-b`,
`62f844e4a4ba`, the third measure's, 10 ms everywhere: the kept r13 tree +
the released `orthros-r14.patch` of `main` — Lua's thread, LuaUi diffing, clock, gamma; the file `lock.json`'s r14
entry pins — + `orthros-r20.patch`; `r15dev`, `960119b9a7ab`, the second measure's, differs only by the WebSocket
handlers above; the lock entry `openmw-web-v1.5.3-orthros-r20` — r17's patches and exports + `orthros-r20.patch` and
`orthros_jspi`, its files `{}` until the release is built (tools/openmw/build.sh). The measures below ran this patch on
r14 (`r15dev*`): `main`'s r15 and r16 came after them, and are not in any of them. `openmw-web-v1.5.3-orthros-r17dev`
(scratch, engine `f2ca81fc07a4`): the kept r13 tree + `main`'s `orthros-r14.patch`, `orthros-r15.patch`,
`orthros-r16.patch` + `orthros-r20.patch` — r15's `PRECOMPILE` and this patch's load hooks both in
`mwgui/loadingscreen.cpp` (no textual overlap); r16's Lua chunks, texture queue and NIF thread beside them (its NIF
bytes read whole on the page's thread: suspended reads in the boot like the others) — smoke-checked only (2026-10-30,
load 11-13): `check.mjs morrowind-goty-vanilla-plus-en --lang fr` passed on a scratch server (1,740 draws, the menu in
23 s); JSPI on (`orthros_jspi` 1), 199 suspensions in the boot (4.1 s, none in play), `window.__omwPrecompile.lateOld`
0. Not measured on r17dev: loads, play, multiplayer, the 85 KB/s link.

First measure, the build with the put-off (2026-10-29, `place-load.mjs morrowind-goty-vanilla-plus-fr --query tier=mid --rate 2m --rtt 85 --after 75`,
save scenario through `--entry engine` — the play page does not pass `?tier=` on —; before = the r14 release on
`main`'s code, after = r15dev on this tree's code, each side its own warm profile made by its own engine and code, the
same frozen copy of the learned state and br-cache; SwiftShader, load 14-22; times in s, blocks in ms; "after" = the
75 s after the load's steady frames, the view raise `view-grow.js` makes in it):

| scenario (runs) | release | to menu / in world | load: page's longest block | load: input delay p50 / p95 | view raise: page's longest block | view raise: longest frame gap | view raise: serial reads |
| --- | --- | --- | --- | --- | --- | --- | --- |
| save, warm (4) | r14 | 10.8-11.3 / 10.8-11.1 after F9 | 8856-9175 | 223-417 / 544-687 (5 inputs a load: the probe's own moves held) | 3363-3463 | 3117-3150 | 33-39 |
| save, warm (4) | r20 | 10.6-11.8 / 9.0-11.1 | 1795-3021 | 4-16 / 971-1936 | 814-1006 | 3150-3733 | 33-38 |
| save, warm (4) | r20 `?cullwait=0` | 10.8-13.1 / 9.6-10.0 | 2000-2115 | 8-18 / 1014-1162 | 133-172 | 750-3533 | 5-41 |
| save, new device (2) | r14 | 35.1, 36.3 / 14.3, 14.2 | 11802, 11968 | 144-271 / 379-473 | 6815, 7048 | 6533, 6750 | 74, 75 |
| save, new device (2) | r20 | 32.0, 29.9 / 13.1, 12.2 | 1039, 1223 | 6-12 / 799-933 | 740, 925 | 3833, 3833 | 74, 81 |
| COE, warm (2) | r14 | boot in world 19.5, 20.4; COE 4295, 4328 ms (the call) | 4314, 4353 | 4045, 4078 (p95) | 3216, 3239 | — | 36, 37 |
| COE, warm (2) | r20 | boot in world 16.0, 15.9; COE 5680, 4498 ms (294, 341 ms to its frame) | 337, 364 | 425, 441 (p95) | 130, 190 | 700, 733 | 9, 9 |
| COE, warm (2) | r20 `?cullwait=0` | boot in world 17.7, 15.7; COE 5246, 5140 ms | 470, 1195 | 449, 470 (p95) | 114, 119 | 750, 867 | 6, 10 |
| COE, new device (2) | r14 | boot in world 55.6, 52.3; COE 4923, 5079 ms | 4941, 5130 | 4671, 4829 (p95) | 3355, 3399 | 3083, 3333 | 32, 38 |
| COE, new device (2) | r20 | boot in world 45.0, 44.6; COE 5221, 5246 ms | 250, 560 | 443, 499 (p95) | 729, 953 | 1750, 2167 | 35, 37 |
| save, warm, **85 KB/s** (1) | r14 | 15.1 / 77.8 | **76053** | 99 / 552 | 11828 | 11533 | 35 |
| save, warm, **85 KB/s** (1) | r20 | 18.6 / 80.6 | **2834** | 9 / 26 | 806 | 12066 | 41 |

- **The page's thread**: the longest block of a save's load 8.9-9.2 s → 1.8-3.0 s (warm), 11.8-12.0 → 1.0-1.2 s (new
  device), 76 s → 2.8 s at 85 KB/s; a COE's 4.3-5.1 s → 0.25-0.56 s. What still blocks is the engine's own work (the
  load's CPU, SwiftShader's), not a wait: 40-52 reads suspended a warm save's load (6.2-7.1 s suspended), 170-236 a new
  device's (26-34 s). Inputs: half of them answered in 4-16 ms during a save's load (r14 delivered 5 in the whole load,
  its probe's own moves held); the p95 is still the engine's CPU stretches (0.8-1.9 s; 26 ms at 85 KB/s, where the
  load is mostly waits).
- **Times**: boot to menu unchanged (the spike's +2 s gone: 1,500-2,500 reads a session answered in the 10 ms wait,
  0.7-1.5 s of the page's time in all); a save's key to the world equal or 1-2 s shorter; a warm `?start=` boot in the
  world 4 s sooner (16 against 20 s), a new device's 8-10 s sooner (45 against 52-56 s). At 85 KB/s (one run a side)
  r20's menu came 3.5 s later and its world 2.8 s later: its warm profile (made by its own warm-up) read 2 files on
  demand before the menu that r14's had — not settled whether the engine or the profile.
- **The first frame of a `?start=` boot** (the multiplayer and QA boot, `--skip-menu`) seemed later — 10.4-11.9 s
  (warm) and 38.2-38.6 s (new device) against r14's 3.4 s and 7.7-8.9 s —: a fault of the probe, not of r20. It dated
  a frame by the argument of the `requestAnimationFrame` callback that first saw draws — the frame's begin —, and a
  callback that waited keeps the begin from before its wait. In a diagnostic warm `?start=` boot of r14 (Vanilla+ FR):
  the first draw at 18.5 s, and the first callback that saw draws dated 3.5 s, though it ran after that draw and before
  the next callback, dated 19.9 s — a date 15 s stale —; the page's 20 ms timer did not run from 3.5 to 29.0 s (not
  one task: animation-frame callbacks ran in that stretch, dated 19.9 and 29.1 s; the timers starved), and the engine's
  `firstFrame` mark (its first frame's end) came at 28.9 s. Dated by the page's clock in that callback (the earliest the browser can show the draws, `place-load.mjs`
  `firstFrameS`; the old date kept as `firstFrameRafS`), the second measure below: r20's first frame as early as r14's.
- **The view raise** (the 75 s after the load): with the put-off on (r20's default), the page's longest block 0.8-1.0 s
  against r14's 3.4 s (warm save), the picture's longest gap unchanged (3.1-3.7 s against 3.1 s) and as many reads (33-38
  against 33-39) — the 100 serial reads → 8 of the first measure is not seen here. With `?cullwait=0` (JSPI alone, the
  cull's reads suspending its frame) the page's longest block 0.13-0.17 s, no frame gap longer (0.75-3.5 s), the same
  reads: **the put-off measures no better than JSPI alone, and holds the page 0.7 s more** (COE warm: 130-190 against
  114-119 ms, gaps 0.70-0.73 against 0.75-0.87 s). At 85 KB/s the picture stopped 12 s at the view raise in both
  releases (r20 with the put-off; `?cullwait=0` not run there).
- **Worker threads' reads** (r14's Lua thread, on in these solo runs): 0-4 a run answered on the page's thread, the
  longest 1-17 ms warm, 132-134 ms on a new device; no deadlock in any run (19 r20 sessions of place-load, 4 of
  perf, 3 checks, 17 page loads of frame-compare).
- **In play** (`perf.mjs --query tier=mid --discard --seconds 60`, 2 runs a variant, load 17-22): r14 19.1-20.4 fps,
  work p50 10.9-11.1 / p99 46.8-53.3 ms (its data stalls 0.9-1.1 s a minute); r20 20.1-20.6 fps, p50 11.6 / p99
  39.9-40.2 ms (the engine's own 34-36 ms, 21-123 ms suspended a minute, stalls 0.09-0.2 s); r20 `?jspi=0` 19.8-20.8 fps,
  p50 11-12 / p99 35.7-36.1. No regression.
- **Checks**: `check.mjs` `morrowind-goty-en`, `--lang fr` and `morrowind-goty-vanilla-plus-en --lang fr` pass on r15dev.
  `frame-compare.mjs morrowind-goty-en` (day, night, interior): r20 against r14 a mean difference of 0.01-1.3 /255 and no
  pixel over 24, within the captures' own noise (0.02-1.4); `?jspi=0&cullwait=0` the same picture. One renderer crash
  ("Target crashed") during the first r20 frame-compare's interior reload, not repeated in the second run nor in any
  other page load — not reproduced since either (second measure: 3 more runs, 27 page loads, 9 of them the interior).

Second measure, the put-off dropped (2026-10-29/30, the same options and scenarios; a new frozen copy of the live learned
state and br-cache, new warm profiles — r14's warm-up 55 s to the world, 808 MB stored; r20's 43 s, 673 MB —; r20 =
`r15dev`; 2 runs a cell, r20's COE warm 4; load 11-24; the first frame by the page's clock; "first engine frame" = the
page's `firstFrame` mark, the end of the engine's first frame — under JSPI that frame suspends, view.lua's report of
the world comes during it; that mark is missing in 3 of r20's 8 rows — both runs of the first r20 COE-warm pair and
the second warm save —, so r20's COE-warm "17.9, 18.0" is the second pair's alone and its warm save's first-frame end
one run's, 12.9 s. The rows read the mark when the world or the menu is reported, which under JSPI can precede the
first frame's end; the read at the run's end (`P.firstTick`) is the fallback, and those three rows came before it — an
inference, not a record: every later row of that build has it, and the mark is set at every frame's end):

| scenario | release | first frame drawn (`firstFrameRafS`) | first engine frame ends / in world | load: page's longest block | load: input p50 / p95 | load: longest frame gap | view raise: page's longest block / longest frame gap / serial reads |
| --- | --- | --- | --- | --- | --- | --- | --- |
| COE, warm | r14 | 12.0, 11.9 (3.2, 3.4) | 19.4, 19.7 / 19.5, 19.7 | 4981, 4482 | 470-1208 / 4295-4701 | 4550, 4616 | 138-3195 / 383-2800 / 10-34 |
| COE, warm | r20 | 11.9-12.4 (5.6-12.1) | 17.9, 18.0 / 14.9-15.9 | 210-1068 | 4-14 / 280-548 | 5133-6433 | 123-176 / 683-917 / 6-9 |
| COE, new device | r14 | 41.4, 41.3 (7.8, 7.8) | 52.7, 53.4 / 52.8, 53.5 | 5087, 5012 | 215, 480 / 4813, 4730 | 5066, 4966 | 3806, 3418 / 3517, 3100 / 34, 38 |
| COE, new device | r20 | 42.3, 39.2 (41.6, 38.8) | 58.2, 52.3 / 48.7, 44.1 | 374, 335 | 16, 12 / 407, 289 | 4866, 4666 | 949, 151 / 3700, 3417 / 32, 34 |
| save, warm (menu; F9 to the world) | r14 | 11.2, 10.8 (9.7, 9.5) | menu 11.2, 10.8; world 11.0, 10.9 s after F9 | 9072, 8976 | 322, 309 / 534, 507 | 8983, 8916 | 3408, 3427 / 3067, 3083 / 34, 34 |
| save, warm (menu; F9 to the world) | r20 | 12.6, 12.6 (11.4, 11.4) | menu 12.6, 12.6; world 9.0, 8.7 s after F9 | 1972, 2017 | 16, 8 / 947, 921 | 5300, 5133 | 137, 138 / 3483, 3483 / 32, 33 |

- **The first frame**: as early as r14's — warm 11.9-12.4 s against 11.9-12.0, new device 39.2-42.3 against
  41.3-41.4. The world comes sooner on a warm boot (view.lua's report 14.9-15.9 s against 19.5-19.7; the first engine
  frame's end 17.9-18.0 against 19.4-19.7); on a new device the report 4-9 s sooner, the first frame's end as r14's
  (52.3-58.2 against 52.7-53.4: the boot's steps from the new game to the music played 22.9-25.3 s on r20, 23.7-24.2 on
  r14 — the same work, its spread run to run).
- **The menu** (save boot): 12.6 s against 10.8-11.2 — r20's warm profile fetched 4.1 MB before the menu against r14's
  2.3 MB (the first measure: unchanged, 10.6-11.8 against 10.8-11.3); not settled whether the engine or the profile.
- **Loads**: a warm save's F9 to the world 8.7-9.0 s against 10.9-11.0, the page's longest block 2.0 s against 9.0 s;
  the COE's page block 0.2-1.1 s against 4.5-5.1 s, its picture still 4.7-6.4 s without a new frame (one frame
  suspended through the COE's load) against 4.5-5.1.
- **The view raise without the put-off**: the page's longest block 123-176 ms warm (r14 138-3427), 151-949 ms on a new
  device (r14 3.4-3.8 s); the picture's longest gap 0.7-0.9 s after a COE (r14 0.4-2.8 s), 3.5 s after a save's load as
  r14's 3.1 s, 3.4-3.7 s on a new device as r14's 3.1-3.5 s; as many serial reads.
- **In play** (`perf.mjs --query tier=mid --discard --seconds 60`, 2 runs a release, interleaved, load 11-20): r14 19.3,
  19.6 fps, work p50 10.8-11.3 / p99 51.1-52.8 ms, data stalls 1.0-1.1 s, 206-217 synchronous fetches; r20 20.0, 20.4
  fps, p50 11.6-11.7 / p99 34.7-40.8 ms (84-119 ms suspended in the minute), stalls 0.33-0.34 s, 2 synchronous
  fetches; longest frame gap 167-183 ms (r14) against 300-317 ms (r20: a frame that waited suspended rather than
  stalled). No page error.

Third measure, on the code r20 would ship with (2026-10-30): the two measures above ran r20's page code before `main`'s
e584802 (light copies fetched into the page before the engine is told, the module compiled in a worker — it changes
`data-client.js` and `streamfs.js` too), and r14 on `main` d5546f6. This tree merged with `main` e584802, then the same
`place-load.mjs` options (2 MB/s, 85 ms, `tier=mid`, `--after 75`), a new frozen copy of the live learned state and
br-cache, new warm profiles (r14's warm-up 58 s to the world, 673 MB stored; r20's 45 s, 539 MB), one save made once for both; r14 = the
r14 release on `main` e584802, r20 = `r15dev-b` on this merged tree; 2 runs a cell; load 19-25; COE and save warm only
(no new-device run):

| scenario | release | first frame (`firstFrameRafS`) | first engine frame ends / in world | load: page's longest block | load: input p50 / p95 | load: longest frame gap | view raise: page's longest block / longest frame gap / serial reads |
| --- | --- | --- | --- | --- | --- | --- | --- |
| COE, warm | r14 | 12.4, 12.0 (3.2, 3.0) | 19.9, 18.9 / 19.9, 18.9 | 4101, 4129 | 500, 401 / 3838, 3890 | 4283, 4033 | 3175, 3270 / 2850, 2800 / 34, 33 |
| COE, warm | r20 | 14.2, 13.5 (12.5, 11.8) | 22.4, 21.6 / 18.5, 17.3 | 300, 196 | 11, 8 / 261, 315 | 6366, 6366 | 194, 161 / 767, 767 / 11, 10 |
| save, warm (menu; F9 to the world) | r14 | 11.4, 12.0 (9.8, 10.4) | menu 11.4, 12.0; world 11.2, 11.3 s after F9 | 9098, 9317 | 249, 564 / 352, 565 | 9050, 9266 | 3465, 3476 / 3150, 3183 / 32, 39 |
| save, warm (menu; F9 to the world) | r20 | 11.8, 12.6 (10.4, 11.4) | menu 11.8, 12.6; world 10.5, 9.4 s after F9 | 2351, 1986 | 16, 12 / 1425, 1025 | 5433, 4800 | 169, 161 / 3450, 3400 / 35, 34 |

- Every row has its `firstTickS` this time (the end-of-run read).
- **The page's thread**: as before — a COE's longest block 0.2-0.3 s against 4.1 s, a save's load 2.0-2.4 s against
  9.1-9.3 s, the view raise 0.16-0.19 s against 3.2-3.5 s; input p50 8-16 ms against 0.25-0.56 s.
- **Worse on r20 here**: a warm `?start=` boot's first frame 13.5-14.2 s against 12.0-12.4, and the first engine
  frame's end 21.6-22.4 s against 18.9-19.9 (the second measure had r20 at 17.9-18.0, ahead of r14); view.lua's report
  of the world 17.3-18.5 against 18.9-19.9, ~1-2 s sooner instead of 4 s. The COE's picture is held longer, 6.4 s
  against 4.0-4.3 (54-55 serial reads while it is held, against 2-27): the page is free, the picture is not. Not
  attributed: whether the merge (e584802's page side under JSPI) or the run's conditions; the second measure saw r20's
  COE picture at 5.1-6.4 s too.
- **The menu** (save boot): 11.8-12.6 s against 11.4-12.0 — r20's warm profile again fetched more before the menu
  (4.6 MB against 2.5 MB). A warm save's F9 to the world 9.4-10.5 s against 11.2-11.3.
- **In play** (`perf.mjs --query tier=mid --discard --seconds 60`, 2 runs a release interleaved, servers of the merged
  tree and of `main`, load 18-24): e584802 brought r14 to r20's level — r14 20.6, 20.7 fps, work p50 8.6-11.3 / p99
  32.4-33.9 ms, data stalls 95-112 ms, 33-35 synchronous fetches, longest frame gap 167-233 ms; r20 20.5, 20.6 fps, p50
  11.0-11.6 / p99 30.3-31.7 ms (92-140 ms suspended in the minute), stalls 304-394 ms, 2 synchronous fetches, longest
  gap 283-400 ms. On the merged code r20 shows **no in-play gain** over r14 beyond noise, and **more data-stall time**
  (0.3-0.4 s against 0.1 s a minute) and longer frame gaps: its frames wait suspended where r14's few reads are
  answered fast. No page error.
- Multiplayer on the merged tree: `r15-4` below (passed).

- **Frame-compare, 3 runs** (`frame-compare.mjs morrowind-goty-en`, r20 `''` against `?jspi=0`, day / night / interior):
  each view the same picture (0.006-2.1 /255 against the captures' own noise 0.001-1.4, no pixel over 24) but one day capture (3.2 /255,
  5.5 % of pixels over 24: a post's texture — its light copy in one capture, its full file in the other: the data's
  timing, not the engine's drawing); no renderer crash in the 27 page loads.
- **Multiplayer, two real clients** (a scratch native gateway — `server.mjs --port 28951 --state-dir <scratch>`, the
  cached image —, a scratch Orthros server of this tree with its own accounts and `openmw.json`, `morrowind-goty-en`'s
  gateway port moved in a scratch games folder; one Chromium, two isolated contexts, each a new Orthros account,
  `/api/openmw/<id>/launch`, the upstream launcher's new character with QA's `?start=-2,-9`): both joined their worlds
  (`Joined`, `simReady=1`), A's world switched to Party, a friend request and its acceptance, B's `joinfriend` into A's
  world, each in the other's roster with the other's copy; each carried 3 times by the debug teleport (250-425 units),
  the other's copy of it following to where it stands; both carried into the next cell (-1,-9), each copy then where
  the other stands. Runs (`mp-check.mjs`, scratch): **r14** 3 — `r14-1` FAILED (an older version of the script: "A
  walks" ok, "B walks, A sees its puppet move" failed, the copy moving 7 units; no teleport nor next-cell checks),
  `r14-2` passed (no next-cell check yet: the copies within 0-25 units after the teleports), `r14-3` passed (0-28
  units; next cell 0 and 40) —; **r20** 4 — `r15-1` (`r15dev`) stuck at "Connecting" (the WebSocket handler bug, below),
  `r15-2` (`r15dev-b`) FAILED "A moves 3 times": one copy stayed 22,416 units off for 90 s after a teleport, the next
  move healing it (B's moves within 0-28 units) —, `r15-3` (`r15dev-b`, the page code before the merge with
  e584802) passed: the copies within 0-1 unit after each teleport, next cell 0 and 6; `r15-4` (`r15dev-b`, this
  tree merged with `main` e584802) passed: within 0-1 unit, next cell 0 and 9. So the follow figures are from the
  passing runs alone — r14 0-28 (two runs), next cell 0-40 (one run); r20 0-1 (two runs), next cell 0-9 (two runs) —,
  and of r20's 3 runs on `r15dev-b` one failed. On `r15-3`: 83 of the 14,766 messages and both connections' `open`
  reached the page while the engine was suspended or its put-off calls not run yet (runs of up to 37 messages),
  delivered after the frame, no error, no reconnection, no page error; on `r15-4` 94 of 17,638 messages (runs up to 45)
  and one of the two `open`s, the same. The 22,416-unit copy of `r15-2` is not
  explained: its look is MWMP's puppet extrapolation (the last two positions processed in one frame, 5 ms apart,
  extrapolated ×18), which slow frames can feed in r14 too, but it was seen on r20 only (1 run of 3), so r20 is not
  ruled out.
  The evidence that each client sees the other is the engine's state (rosters, puppet ids, the copies' coordinates
  in `result.json`). The pictures: `r15-3`'s show the onboarding panel ("You are in the world") over the inventory, not
  the other player; `r15-4` closed the panels, put B 160 units from A and turned each camera to the other's copy —
  B's picture shows A's copy in front of it; A's does not show B (B had landed in water ~630 units below A's level
  view).
  The first two-client run on `r15dev` stuck at "Connecting": the test's own counter wrapped the WebSocket handler
  setters, and the library then dropped every event (its handler compared through the getter) — fixed (above), the
  test's counter made a listener of its own.

#### In play: what r20 made worse, and the fix (2026-10-30)

The third measure had r20 worse in play than r14 on the merged code (data stalls 0.3-0.4 s a minute against 0.1, longest
frame gap 283-400 ms against 167-233) and its warm `?start=` first frame 1.5 s later. Controls on the same build
(`r15dev-b`), `perf.mjs`'s scenario with hooks of a scratch script (every `soon` that suspended or waited, with its
engine stack by `openmw.js.symbols`; every frame's pump, end and next pump; every file load; the view distance and the
page's frame meter every 250 ms), local link, `tier=mid --discard`, 60 s:

| run | data stalls (ms/min) | longest gap (ms) |
| --- | --- | --- |
| r14, new profile (6) | 72-165 | 167-217 |
| r15dev-b, new profile (3) | 435-482 | 400-483 |
| r15dev-b `?jspi=0`, new profile (1) | 67 | 167 |
| r14, warm profile (2) | 44-75 | 167-183 |
| r15dev-b, warm profile (2) | 214-249 | 317-383 |

What it was — not the suspensions' mechanics (a suspended frame's next pump came 1.1 ms after its end, p50, 22 ms at
most: the frame is scheduled at once; no suspension while a light copy's full file was fetched, `realInPage`, 0 of 7-12
a run):
- **The view raise in the measured minute.** `view-grow.js` raises the view only while the frames are as usual — the
  median of the frame meter's p99 over 30 s. Every half second of the boot without a frame counted 0: a boot that holds
  the page's thread (r14) gives that look no turn, one that yields (JSPI) gives it sixty, and the usual frame stayed 0
  for 30 s, every 66 ms frame of a 20 fps machine a long one. The raise to 12,288 came 20.8-21.1 s after the world
  against r14's 8.0-8.4 s — inside the minute measured from 10 s —, with its load: 92 files, 28 textures (53 MB) in one
  frame of 356-380 ms, a 330 ms frame after it, 40-64 reads waited for. Fixed (`view-grow.js`: the frames of play only,
  in the world and drawn): the raise at 9.2-9.4 s, the next two runs 92-104 ms of stalls, longest gap 167-183 ms.
- **In play, a read suspended after 10 ms.** A frame that suspends presents nothing more; the suspension only cost it the
  10 ms spun first and a round of the page (4-12 suspensions and 53-93 short waits a minute). Now 100 ms in play
  (`?jspiplay`), 10 ms kept in the boot and under the loading screen (above, "Short in a load, longer in play"):
  warm profile, `r15dev-c` 44-54 ms of stalls, longest gap 167-200 (2 runs), 0 suspensions in play; `?jspiplay=10` on
  the same build 155 / 317.
- **The boot's light copies.** With the page's thread free during the boot, the worker's word on the files the
  background had just brought whole reached the page in the middle of the boot's big load, which then read them as the
  files themselves (no big load: `bigLoads` 0 against r14's 2, 268 MB of light copies' files read in full on a new
  device). Held through the engine's loads now (`GameData` `inLoad`, docs/slow-network.md): `bigLoads` 2 and ~300
  reloads, as r14. Its own share of the in-play numbers was not separated (the runs with it alone still had the raise).
- **An image's growing reads.** A 21 MB texture read real in play waited 7 times (256 KB, then the run's length): now
  asked for to its end at its first missing piece (docs/slow-network.md "A whole image at its first missing piece"):
  the image waits 44-56 → 26 a minute, their time the same on the local link.
- **The warm `?start=` first frame**: `?jspi=0` on the fixed build 13.0, 15.1 s against 11.4-12.6 s default and r14's
  13.5-14.1 — not JSPI; with the fixes r20's first frame is no later than r14's (table below).

**Fourth measure** (2026-10-30, merged code, the same options as the third; new frozen copies of the live learned state
and br-cache, new warm profiles — r14's 54 s to the world, 673 MB; `r15dev-c`'s 46 s, 539 MB —, one save for all; r14 =
the r14 release on `main` e584802, r20 = `r15dev-c` on this tree (r15dev-d: the same plus a budget of the frame's waits
in play, 100 ms in all between two turns of the page); runs interleaved r14 / r20, load 8-33; in play `perf.mjs --query
tier=mid --discard --seconds 60`, new profile, each side its own server):

| | r14 | r15dev-c | r15dev-d |
| --- | --- | --- | --- |
| in play: fps | 19.3-21.2 (6) | 18.6, 19.4, 20.9 | 19.2, 20.4, 19.2 |
| in play: work p50 / p99 (ms) | 10.3-13.5 / 29.6-34.3 | 11.6-12.0 / 32.4-41.6 | 11.4-12.3 / 32.8-43.6 |
| in play: data stalls (ms/min) | 72-165 | 501, 106, 100 | 485, 108, 775 |
| in play: longest gap (ms) | 167-217 | 500, 200, 200 | 417, 233, 900 |
| in play: suspended (ms/min) | — | 0, 0, 0 | 87, 0, 203 |
| COE warm: first frame (s) | 13.5-14.1 (4) | 11.4, 12.6, 12.2 | 12.6, 12.5, 14.1 |
| COE warm: page's longest block (ms) | 4082-5120 | 973, 1074, 1334 | 286, 970, 349 |
| COE warm: input p50 / p95 (ms) | 420-1015 / 3809-4852 | 28-49 / 747-837 | 11-16 / 478-704 |
| COE warm: view raise, page block / gap (ms) | 1211-3392 / 1067-3083 | 128-1233 / 650-1317 | 372-1314 / 717-967 |
| save warm: menu (s) | 12.7-15.1 (4) | 13.4, 14.3 (2) | 14.5, 14.1, 12.6 |
| save warm: F9 to the world (s) | 10.3-10.9 | 9.5, 9.6 | 8.7, 9.3, 8.8 |
| save warm: page's longest block (ms) | 8371-8545 | 2566, 2421 | 1848, 2186, 1851 |
| save warm: input p50 / p95 (ms) | 179-358 / 319-572 | 12-22 / 963-1183 | 8-17 / 992-1222 |

- **Loads**: r20 keeps the page free — a COE's page block 0.3-1.3 s against 4.1-5.1 s, a save's 1.8-2.6 s against
  8.4-8.5 s, input p50 8-49 ms against 0.2-1.0 s; F9 to the world 8.7-9.6 s against 10.3-10.9. The first frame of a
  warm `?start=` boot no longer later (11.4-14.1 s against 13.5-14.1).
- **In play**: one r15dev-c run in three (500 ms gap, 0.5 s of stalls) and two r15dev-d runs in three (417 and 900 ms,
  0.5 and 0.8 s, 87-203 ms suspended in them) were still worse; r14 none in six. The steady minute alone (`--warm 30`, one run a side) was
  even: r15dev-c 76 ms of stalls, longest gap 167 ms, fps 21.3, work p99 28.2 against r14's 106, 150, 21.2, 27.5; so
  is the warm profile's (above). What the bad runs' frames read was not instrumented (the official `perf.mjs`).
- **The budget (r15dev-d)** brought a COE's page block back to 0.3-1.0 s from r15dev-c's 1.0-1.3 (a place loaded in
  play over a slow link, each read answered within 100 ms, never yielding) but put suspensions back in play: not kept.
- **A renderer crash** ("Target crashed") in one of 9 r15dev-c place-load sessions, at the menu just after the music
  started (a save boot; no page error before it); none in the 6 r15dev-d sessions nor in r14's 8 runs.
- Not re-run on r15dev-c: `frame-compare.mjs`, the multiplayer two-client check, a new device, the 85 KB/s link.

#### The renderer crash, plain frames and the GPU's queue (2026-10-30)

The fourth measure left two things open: a renderer crash ("Target crashed") in one of 9 r15dev-c sessions, at the
menu, and in-play numbers no better than r14's. Rebuilt on `main`'s r16 (`r17dev`, the patch above), measured against
the live r16 on the same merged page code (`place-load.mjs`, `perf.mjs`; each server its own copy of the learned state
and a frozen br-cache copy; runs interleaved r16 / r20; one browser at a time; load 5-22).

**The crash: Chromium's native stack walker on a JSPI stack.** The kernel's log has three renderer segfaults since
2026-10-29 at the same instruction of Chromium 153 (Playwright's `chromium-1243`, offset `0x38b7d1f` of its executable
segment) — 2026-10-29 22:14 and 2026-10-30 04:14 (r15dev, every frame promising) and 13:00 (`r17dev-g2`, during a save's
load) —, each a read fault ~15 KB above the stack pointer, at a page boundary, on the renderer's main thread (its
`comm` "chrome": Chromium names its other threads). The instruction is in `base::debug::TraceStackFramePointers` /
`ScanStackForNextFrame` (the 8 KB scan and the 100,000-byte frame bound of `base/debug/stack_trace.cc`), reached from a
virtual allocation-sampling observer that asks for 255 frames (the heap profiler's). On a JSPI stack the walk follows
the frame pointers to that stack's first frame, whose caller is on the page's own stack far away, takes the chain for
broken and scans 8 KB upward for a frame — past the end of the JSPI stack. It happens when the browser profiles that
renderer's heap (a share of renderers, at random) and an allocation is sampled while the engine runs on a JSPI stack.
Reproduced at will with the heap profiler on for every renderer (`--memlog=all-renderers --memlog-sampling-rate=100000
--memlog-stack-mode=native`, through `ORTHROS_CHROME_ARGS`): `r17dev-g2` crashed in 2 sessions of 2 (a save boot, a
COE boot), r16 in none (1 session); kernel lines kept with the results.

**The fixes** (`orthros-r20.patch`, above "A frame of play is plain", "The suspending imports only when the engine may",
"The GPU's queue in a load's frame"):
- **Plain frames in play** — the engine on the page's own stack outside the boot and loads: no exposure in play nor at
  the menu (where the r15dev-c crash was), and no JSPI cost in play.
- **A deep stack under each promising export** (`engine.cpp` `orthros_jspi_deep`: `main()` and the load's frame run
  under 1,024 plain wasm frames): the walker stops at 255 frames and never reaches the stack's end. With the heap
  profiler forced on: `r17dev-d` 0 crashes in 4 sessions (a save boot and load twice, a COE boot and load, a fresh boot
  and 30 s of play), where `r17dev-g2` crashed at every boot.
- `?jspiplain=0`, `?jspigl=0`, `?jspisettle=0`: the earlier behaviours, for A/B (`?jspiglmax=2000`: the GPU wait as
  long as it was before 2026-10-30).

**What it measures** (`r17dev-d`, its own warm profile; r16 the live release; 3 runs a side interleaved for loads, 4
for play):

| | r16 | r20 (`r17dev-d`) |
| --- | --- | --- |
| save, warm: menu (s) | 7.1-7.3 | 7.0-8.0 |
| save, warm: F9 to the world (s) | 4.8-4.9 | 4.9-5.7 |
| save: page's longest block (ms) | 4739-4835 | 231-317 |
| save: input p50 / p95 (ms) | 471-609 / 587-644 | 11-14 / 484-626 |
| save: longest frame gap, the visible freeze (ms) | 4683-4783 | 1800-1983 |
| COE, warm: page's longest block (ms) | 1727-1793 | 209-451 |
| COE: input p50 / p95 (ms) | 479-1231 / 1462-1644 | 45-108 / 358-700 |
| COE: longest frame gap (ms) | 1550-2050 | 1617-1633 |
| after the load (30 s, the view raise): longest gap (ms), save / COE | 267-283 / 317-500 | 283-300 / 350-517 |
| in play (`perf.mjs tier=mid --discard --warm 0`, 60 s, the raise inside): fps | 24.29-25.40 | 24.28-26.45 |
| in play: longest frame gap (ms) | 233-267 | 217-283 |
| in play: data stalls (ms a minute) | 199-254 | 159-246 |
| in play: work p50 / p99 (ms) | 8.3-10.6 / 18.5-22.7 | 8.5-11.0 / 19.3-21.9 |
| `__omwPrecompile.lateOld` after a fresh load | 0 | 0 |

The same comparison on `r17dev-g2` (plain frames and the GPU's queue, without the deep stack; 4 runs a side): in play
25.57-25.99 against 24.98-26.33 fps, longest gap 167-250 against 183-233 ms, stalls 153-253 against 177-234, work p99
16.9-20.3 against 17.4-18.8; its menu came 3-4 s later only because its warm profile was `r17dev`'s (the new engine's 6
MB fetched before the menu over the 1.8 MB/s link). On `r17dev` (every frame promising, before these fixes): a save's
page block 2.4-2.6 s and its input p95 2.2-2.5 s, the COE's freeze 1.67-2.07 s against r16's 1.55-1.75.

- **What held the page 2.4 s after a save's load** (a CPU profile of the load, `ORTHROS_PLACE_PROFILE=1`): the world's
  first draw, in the load's own frame — 1.1 s in WebGL's `checkFramebufferStatus` (the GPU process running the load's
  queue), 0.76 s native, 0.25 s spinning on reads. The GPU-queue wait (`orthros_gl_settle`, 2 suspensions, 1.2 s) and
  the rest of the load's frame counted as a load (its reads suspend) brought the page's block to 0.2-0.3 s; the
  picture's freeze is the same time (the engine still draws that frame), now with the page answering.
- **New device and the 85 KB/s link** (one save run a side on a new profile, two a side at 85 KB/s): a new device's menu
  25.8 s against r16's 23.7, F9 to the world 12.2 against 12.7 s, the page's block 0.2 against 12.6 s, the picture's
  freeze 7.6 against 12.5 s; at 85 KB/s the menu 10.6-10.9 against 10.6-11.0 s, but **F9 to the world 38.8-39.1 s
  against 26.7-26.8** (freeze 30.2-30.5 against 26.5-26.6 s; the page's block 0.2 against 26.6 s): the load's announced
  wait timed out once (15 s) in both r20 runs, none in r16's, and 1.4 MB went to the game's own reads asked ahead
  (`a=1`, one 1 MB `Morrowind.bsa` range taking 16.5 s) against r16's 0.19 MB — reads served while the engine stood
  suspended on its announced wait, which r16's held page did not serve until the wait was over (most likely a worker
  thread's proxied read: the page's thread is free during a suspension). **Open**: on a thin link r20's save load is
  12 s slower; not fixed here.
- **Pictures** (`frame-compare.mjs morrowind-goty-en`, `r17dev-d` `''` against `?jspi=0`): day 3.59 against the
  captures' own noise 3.60 /255 (1.8 % over 24 in both), night 0.78 against 0.88, interior 0.63 against 0.30 (no pixel
  over 24): the same pictures.
- **Not fixed**: a load that a frame of play starts by itself — a door, an exterior crossing — runs synchronously, as
  r16's (only the save's load, a new game and the debug COE are put off to a promising frame). A JSPI stack is still
  exposed to any other native code of the browser that walks it; the walker above is the only one seen.
- **Crashes**: none in the 24 ordinary page sessions of `r17dev-d` (a warm-up, 6 measured loads, a new device, 2 at
  85 KB/s, 4 in play, frame-compare's 9 page loads) nor the 4 with the heap profiler forced on; `r17dev-g2` crashed once in 13
  ordinary sessions (a save's load) and 2 of 2 forced. Results: `tools/openmw/results/r17-2026-10-30/` (place-load rows,
  perf.json, frame-compare, the crashed sessions' console logs, the kernel's segfault lines).
- **Not run on these builds**: the two-client multiplayer check (its scratch script, `mp-check.mjs`, was lost with
  /tmp at the 2026-10-30 reboot; rebuilt for the validation below).

#### Full validation against the live r16, and the verdict (2026-10-30)

The build measured is `r17dev-e` (scratch, engine `3caae330a30b`): `r17dev-d`'s kept tree with the difference between
`r17dev-d`'s sources and this `orthros-r20.patch` applied over it. That difference is only a comment in
`orthros-jspi.js` and one local renamed in `statemanagerimp.cpp` (kept as `r17dev-e-over-r17dev-d.patch`), so its code is
the patch's. r16 is the live release `openmw-web-v1.5.3-orthros-r16`. Both run on this tree's page code (`main`
8f82f61 and the r20 page changes). Every server had its own fresh copy of the live learned state, all copied at one
moment (15:10), and a frozen br-cache copy (`--br-cache-frozen`): place-load made a new copy for each run; `perf.mjs`
started a new server for each run. Each side used its own warm profile, made by its own engine. The runs were interleaved
r16 / r20, one browser at a time through `tools/with-browser-slot.sh`, the load at their start 7.7-23.7, and at least 35
GB of memory available throughout. Results: `tools/openmw/results/r17-2026-10-30/validation/` (the place-load rows, each
`perf.json`, the frame comparisons, the two-client runs' `result.json` and logs, the job logs gzipped, each run's start
with its load and memory, the memory and load every 30 s).

| | r16 | r20 (`r17dev-e`) |
| --- | --- | --- |
| in play (`perf.mjs tier=mid --discard --warm 0`, 60 s, the view raise inside; 4 a side): fps | 24.60-25.23 (median 24.87) | 24.16-25.95 (24.63) |
| in play: longest frame gap (ms) | 283-350 | 267-300 |
| in play: data stalls (ms a minute) | 304-335 | 231-271 |
| in play: work p50 / p99 (ms) | 8.2-9.9 / 18.8-22.8 | 7.9-9.1 / 17.1-19.5 |
| in play: suspensions | — | 0 (`play` 0 in every run) |
| save, warm (3 a side): menu (s) | 7.0-7.5 | 7.3 |
| save, warm: F9 to the world (s) | 4.8-5.2 | **5.4-6.2** |
| save, warm: page's longest block (ms) | 4674-5124 | 215-354 |
| save, warm: input p50 / p95 (ms) | 370-474 / 765-876 | 15-40 / 599-666 |
| save, warm: the visible freeze (frameGapMaxMs) | 4633-5083 | 1867-1917 |
| COE, warm (3 a side): first frame (s) | 6.9-8.5 | 7.8-8.1 |
| COE: page's longest block (ms) | 1716-1759 | 216-470 |
| COE: input p50 / p95 (ms) | 562-695 / 1457-1486 | 48-110 / 597-795 |
| COE: the visible freeze (ms) | 1733-1800 | 1583-1617 |
| after the load (30 s, the view raise): longest gap (ms), save / COE | 283-300 / 283-317 | 250-350 / 300-417 |
| new device, save (3 a side): menu (s) | 25.3-27.5 | 25.7-26.8 |
| new device: F9 to the world (s) | 11.2-12.1 | **12.1-12.5** |
| new device: page's block / the visible freeze (s) | 11.1-12.0 / 11.1-12.2 | 0.2 / 7.4-8.6 |
| 85 KB/s, save (1 a side): menu (s) | 10.2 | 10.4 |
| 85 KB/s: F9 to the world (s) | 30.3 | **38.5** (an announced wait timed out once) |
| 85 KB/s: page's block / the visible freeze (s) | 30.2 / 30.1 | 0.3 / 28.9 |
| `__omwPrecompile.lateOld` after the load | 0 (every run) | 0 (every run, 12 loads, the 2 forced ones among them) |

- **Pictures**: `frame-compare.mjs morrowind-goty-en` on r20, `''` against `?jspi=0`: day 1.49 /255 against the
  captures' own noise of 1.59, night 1.10 against 0.26, interior 0.65 against 0.25, no pixel over 24 in any of them.
  r16's references were also captured on an r16 server and set against r20's (`xcmp.py`, the 4 frames of each averaged):
  day 0.011, night 0.24, interior 0.74 /255, no pixel over 24. Each is within the noise of one side or the other (r20's
  day 1.59, r16's interior 1.40). The pictures are the same.
- **check.mjs**: `morrowind-goty-en` passed (41,499 draws) and so did `--lang fr` (`morrowind-goty-fr`, 45,327 draws), on
  a server whose OpenMW releases all point to `r17dev-e` (its log: `e/3caae330a30b/openmw.wasm` served).
- **Two clients** (`mp-check.mjs`, kept with the results: rebuilt from the session's record of the lost script, its
  paths made options): r20 passed 1 run of 5 and r16 passed 2 of 4 (interleaved: r20, r20, r16, r20, r16, r16,
  r20, r16, r20). In every run on both sides both clients joined (`Joined`, `simReady=1`), the friend request and the
  acceptance went through, B joined A's world, each saw the other in its roster with a copy, and there was no page error and
  no reconnection. Every failure was the same: after one of the debug teleport's 300-unit moves, the watcher's copy of
  the mover went far off and stayed there for the check's 90 s. On r20 that was 15,607-35,173 units, on r16
  19,933 and 567,898 units (r16-2: on the move into the next cell). That is MWMP's puppet extrapolation, seen in r15dev-b
  before. It happens on the live r16 as well, so it is not r20's. No WebSocket event reached either page while its
  engine was suspended or its put-off calls were pending (`busy` 0 in all 18 pages): r20's frames of play are plain.
  The difference in rate (1/5 against 2/4) is within what so few runs can show.
- **Crashes**: none. r20 had 36 page sessions: 11 place-load sessions (a warm-up, 6 warm loads, 3 new devices, 1 at
  85 KB/s), 4 in play, frame-compare's 9 page loads, the 2 checks and the 10 pages of the 5 two-client runs. r16 had 29
  (11 place-load, 4 in play, 6 frame-compare, the 8 pages of 4 two-client runs). Every tool exited 0, no log has
  "crash", and the kernel's log has no chrome segfault between 15:00 and 17:30. The earlier crash's trigger was exercised
  on `r17dev-e` with Chromium's heap profiler forced on every renderer (`--memlog=all-renderers
  --memlog-sampling-rate=100000 --memlog-stack-mode=native`): a save boot and its load, and a COE boot and its load,
  with 0 crashes (`r17dev-g2`, without the deep stack, crashed in both of its 2 forced boots).

**Verdict: NO-SHIP**, by criterion:
1. **Crashes: met.** The cause is explained (Chromium's frame-pointer walker on a JSPI stack) and fixed. There were 0
   crashes in 36 r20 page sessions and 0 in 29 on r16, and 0 in the 2 forced-profiler sessions (`r17dev-g2` crashed in both
   of its 2).
2. **In play: met.** fps median 24.63 against 24.87; the 0.24 difference is under r16's own spread of 0.63, and r20's
   lowest run (24.16) is 0.44 under r16's lowest. The longest gap (267-300 against 283-350 ms), the stalls (231-271
   against 304-335) and work p99 (17.1-19.5 against 18.8-22.8) are each no worse, and better.
3. **Loads: met.** For the page's longest block and input p95, every r20 run beats every r16 run: save 215-354 against
   4674-5124 ms and 599-666 against 765-876; COE 216-470 against 1716-1759 and 597-795 against 1457-1486. The visible
   freeze is shorter: save 1.87-1.92 against 4.63-5.08 s, COE 1.58-1.62 against 1.73-1.80. Outside the criterion:
   **F9 to the world is 0.6 s later** (5.4-6.2 against 4.8-5.2: the load put off one frame, then the GPU's queue waited
   for), and the 30 s after a COE has longer gaps (300-417 against 283-317 ms).
4. **Not met**, on three points:
   - At **85 KB/s a save load is 8.2 s slower** (38.5 against 30.3 s; the previous measure had 38.8-39.1 against
     26.7-26.8). The announced wait times out once, as before.
   - On a **new device the save load is a little slower**: F9 to the world 12.1-12.5 against 11.2-12.1 s, r20's
     fastest equal to r16's slowest. The menu is even (25.7-26.8 against 25.3-27.5 s).
   - The **two-client check passed once in 5**, not twice. The same check fails on the live r16 too (2 of 4 passed),
     for the same reason (MWMP's puppet extrapolation after a teleport), so it does not single out r20. Still, it
     has not passed twice.

   Met in (4): the pictures, `__omwPrecompile.lateOld` 0, check.mjs EN and FR, `make test` (1,697 pass, 0 fail, on
   this tree after the runs).

#### Renumbered on `main`'s r17 (r18 then, r20 since 2026-10-31): the dev build and its smoke (2026-10-30)

`main`'s own orthros-r17 (patient preloads, LuaUi layouts) shipped first, so this release became r20 (above).
`openmw-web-v1.5.3-orthros-r18dev` (scratch, engine `32bbece2c037`) is the kept `r17dev` tree with three patches
applied over it by `tools/openmw/dev-build.sh`: the old r16-based patch reverted (`unbase-old-r17.patch`), then
`main`'s `orthros-r17.patch`, then the JSPI patch (then named `orthros-r18.patch`: today's r18 and r20 together). That
gives r1..r17 + r18 + r20, the lock entry's set, and it built in
425 s; memory available never fell under 44 GB. Smoke only: `check.mjs morrowind-goty-vanilla-plus-en --lang fr` passed
on a `dev-serve.sh` server (1,566 draws, `morrowind-goty-vanilla-plus-fr` ran, r17's `LUAUILAYOUT` on in its log).
`make test`: 1,700 pass, 0 fail. Not measured on r18dev yet: loads, play, the 85 KB/s link, two clients, and the two
blocking paths left under JSPI, r17's forced read past `dataWaitLimit` (60 s) and the cell change's load (`waitTillDone` /
abort + load). Results: `tools/openmw/results/r18-2026-10-30/`.

#### r20: the thin link, the warm F9 delay, the two-client teleport desync, the blocking paths (2026-10-30)

The renumbered r20 (`r18dev`, above) measured against the live r17 (`openmw-web-v1.5.3-orthros-r17`) on this tree's page
code, then fixed and rebuilt: `r18dev-b` (the teleport fix, the engine's marks), `r18dev-c` (and the next frame after a
load at once, the GPU wait's cap as a switch), `r18dev-d` (the cap's default: the build measured in the validation
below). Every server had its own copy of the live learned state (copied at 17:53) and the frozen br-cache copy; each
side its own warm profile made by its own engine; one browser at a time; results in
`tools/openmw/results/r18-2026-10-30/` (`diag/`: the diagnosis' place-load rows and, per run, its read trace, proxy log,
console and CPU profiles; `mp-diag/`, `lua/`, `bench/`, `an/`: the scripts that read them).

**A read trace for every load** (`place-load.mjs --read-trace`, `tools/openmw/read-trace.py`): the page's requests to
its game data worker (data-client.js `GameData.trace`, when a harness sets `globalThis.__orthrosReadTrace`: each
`sync` — fetchSync, the page's thread held —, `spin` / `late` — fetchSpin answered within its short wait or given up to
a message, the engine suspended —, `async` / `bg` — fetchAsync's, a background fetch with its caller's stack —, `want`
— an announced batch, its entries and bytes —, `wwait` — a wait for the announced batches, its time and outcome), the
worker's own reads (`wread`) and its read-ahead requests (`ahead`: the reader's position, its run, whole or not), the
engine's frames, loads and suspensions (`jspi`: orthros-jspi.js `orthrosNote` — enter, leave, plain, defer, loading,
and each suspension's kind, start and length) and the page's long animation frames (`loaf`), all on the page's clock,
next to the proxy's log of the link. `read-trace.py <run folder>` prints the load's waits (serial or overlapped), its
announced batches and waits, the background asks while the engine stood suspended, the link's bytes by kind and the
engine's suspensions; `--list` every entry.

##### (A) The thin link: a boot's read-ahead in the middle of the load

At 85 KB/s (`--rate 85k`, a warm profile, F9 at the menu) the save's load took r17 24.3-24.5 s and r20 36.8-37.6 s
(2 runs a side, `diag/rows/pl-r1?-save85k.jsonl`). The traces refute the suspects named before: r20's engine asked the
worker for the same bytes in the same order as r17's (234-236 `spin` reads answered within the short wait, 10-13 `late`
— the ten serial `Morrowind.esm` reads of the cell's references, 0.1-1.2 s each, as r17's ten `sync` ones —; the same
seven announced batches, 7 + 409/396 + 361/374 + … entries; no read asked one at a time where r17 batched; nothing asked
in the background while the engine stood suspended: one `bg` read, a sound's, after the load). What differed is the
link: the second wait for the announced textures timed out (15 s), the load's batches sharing the link with `ahead`
requests (`a=1`) nobody was reading — a 1 MiB block of `Morrowind.bsa` at 279.97 MB on the link from 11.4 to 29.7 s,
the end of `Tribunal.esm`, another 1 MiB block from before the key to 2.6 s. The worker's own trace says where they came
from: the boot's reads, 11-13 s before the key (`ahead`, `run` 1.3-2.1 MB, the reader then long gone), asked as the
read-ahead of a reader whose pieces of 256 KB - 1 MB were answered from the store, queued behind the boot's own
requests on a link that was not fast, and started whenever the link was free — in the middle of the next load. r17's
warm store had those blocks (its warm-up's background had fetched them at 125-141 s of its session), so its boot asked
none; r20's had not.

The fix (src/vfs/http-backend.js `readAheadParts`, every game): any read-ahead but a media stream's — not only the
whole blocks of a file read whole — is dropped while it waits for its turn once its reader moved away, unless a read
waits for it (`w.urgent`); `stats.aheadsDropped` (docs/slow-network.md). With it (`diag/rows/diag-r1?-save85k-fixA.jsonl`)
r20 25.9 s (no `ahead` block during the load, no time-out), r17 23.4 s. The rest of the gap there is the warm store: r20's
announced batches fetched six more pieces (`Morrowind.bsa` 157.35-157.55, 273.48-273.61, 280.89 MB: 1.68 MB on the
wire against 1.43 MB) that r17's warm-up had fetched in the background in the last 30 s of its session — which pieces a
120 s warm-up reaches is the session's timing, not the engine's (both warm-ups fetched 426 MB raw).

##### (B) The warm F9 to the world: where r20's extra time went

Warm save, local link (`diag/rows/`): r17 4.6-4.9 s, r20 (`r18dev-b`) 5.4-6.1 s. The read trace with the engine's marks
splits it (`read-trace.py --list`):
- **Not the put-off frame**: the load starts 11-25 ms after the key (`defer` then `enter`).
- **Not the reads' short waits nor the resumes**: 234 reads answered within the 10 ms wait totalled 0.35-0.47 s against
  r17's 0.47 s of synchronous waits for the same reads; the ten serial `Morrowind.esm` reads waited 0.1 s each on both;
  the announced waits 1.2-1.25 s against 1.15-1.17 s.
- **The warm store, ~0.4 s**: r17 on a copy of r20's warm profile (`diag-r17-on-r18store`) 5.0, 5.1 s against 4.55-4.7 s
  on its own — the announced batches fetched more (as in A).
- **An idle frame after the load, 0.4-0.8 s**: the load's frame ended, and the next frame — where the world's scripts
  report the player in the world — waited for the next animation frame, which the browser holds until the GPU process
  has drawn the load's first picture of the world (0.8 s in SwiftShader; the page's thread idle meanwhile: 605 ms
  `(idle)` of 750 in the CPU profile, `diag/runs/r18b-save-prof*`). After r17's load (the page's thread held) the next
  frame ran at once, its own GPU wait after that work. Fix (play/index.html, `orthros-r20.patch`): after a load's frame (a
  promising one that lasted 100 ms or more) the next frame is pumped at once (the MessageChannel hop, input first), not
  at the next animation frame — `r18dev-bx` (the page only) 5.1, 5.5 s against 5.7, 5.7 s, the next frame 0.05 s after
  the load's instead of 0.36-0.8 s.
- **The GPU wait in the load's frame, ~1.1 s**: the world's first draw in the load's frame waits for the GPU's queue at
  each framebuffer status (`orthros_gl_settle`: a fence, the engine suspended, 2 s at most): 1.2-1.25 s in all, where
  the call itself (`?jspigl=0`) waits only for the GPU process to have read the commands, not for SwiftShader to have
  drawn them all — `?jspigl=0` 4.0-4.5 s, but the page's thread held 430-490 ms there and input p95 1.3-1.6 s. The wait
  is now capped (`?jspiglmax=N`, `OPENMW_ORTHROS_JSPI_GL_MAX_MS`), the status then asked as is: cap 2000 (the old
  behaviour) 5.5-5.7 s, input p95 571-722 ms; 1000 5.4, 5.5 s, p95 543-688 ms; 600 5.4, 5.5 s, p95 511-569 ms but the
  page held 525-563 ms; 300 4.4-4.5 s, p95 1134-1250 ms; 100 4.5-4.6 s, p95 1325-1336 ms — the page's longest block
  204-226 ms at 100, 300, 1000 and 2000 (`diag-r18c-eng-*`, 2 runs each, `--entry engine`). The p95 that rises is the
  mouse moves' (Chrome dispatches them with the animation frames, which wait for the GPU): what the GPU's queue costs,
  in the world's time or the input's. Default 300 (`r18dev-d`): through the engine's page alone the world's report and
  its first picture ~1 s sooner (the first picture of the world at 4.3-4.4 s against 5.3-5.4 s, frames flowing 6.9-7.0 s
  against 7.1-7.3), the GPU's rest then waited by the next frames (the 30 s after the load: longest gap 483-583 ms
  against 283) and by the mouse moves of that second; through the play page (the validation below) 5.1-5.2 s against
  r17's 4.8-4.9, the page held 0.58-0.72 s by the status call after the cap.
- **Not the loading screen's frames, nor the suspensions themselves**: the loading screen drew 38 ms in all
  (`LoadingScreen::draw`, symbolised profile); a suspension costs 2-5 µs at 1,024 frames deep and a call to an import
  from a promising export 17 ns against 7 (`bench/`, Node 24's V8); no rendering ran in any of the load's long animation
  frames (`loaf`: render 0). The page's native time (`(program)`) is 0.98 s in r20's load against 0.11 s in r17's — the
  rest of the difference, not attributed further; turning the breaths and presents off (`?jspipresent=0&jspibreath=0`)
  gained 0.1-0.3 s (5.2, 5.3 against 5.4-5.6) for a longer block (273-423 ms): not changed.

##### (C) Two clients: a copy thrown far off after a teleport — the engine's puppet extrapolation, fixed

Every failed run of the two-client check, on r16, r17 and r20 alike (the validation above: r20 1 pass in 5, r16 2 in
4), was the same: after one of the debug teleport's 300-424-unit moves the watcher's copy of the mover stood 15,607-
35,173 units off (567,898 after the 8,800-unit move into the next cell) for the check's 90 s, the next move healing it.
Not the check (it reads the mover's pose and the copy's after the move settled, up to 90 s), not the page's WebSocket
glue (`busy` 0: no message reached a page while its engine was suspended), not the native gateway (it relays the poses):
the client engine's MWMP script `scripts/mp/interp.lua` (openmw-web's, packed into openmw.data). A pose's time is its
arrival's, smoothed only when the gap to the previous one is 5-500 ms; two poses handled a few ms apart — two batches
bunched by a slow frame or the link, routed in one frame — keep their 1-5 ms, and the extrapolation past the newest
pose divides the last step by that time: EXTRAP_S (0.09) / 0.002 = 45× a 300-unit teleport, 13,500 units; and the server
relays a pose only when it changes, so nothing came to correct it. `lua/interp-before.txt`: 13,500, 6,750, 5,510,
4,500, 1,350 units for arrival gaps of 2, 4, 4.9, 6, 20 ms, 409 after an ordinary 66 ms. Fix (written in this patch,
then moved to its own release, `orthros-r18.patch`, "Two clients" above; interp.lua `sample`): the step's time is
at least the stream's mean gap (33 ms before one is known) and a step faster
than 2,000 units a second — a teleport, a cell change, a snap — is a jump, never carried on; an ordinary step still is
(the engine's own `wasm-build/lua-tests/run.lua` gets the case; `lua/interp-after.txt`: 0 units at every gap, the
existing interpolation and late-pose cases unchanged, 20 of 20 under Lua 5.4.7 built from the tree's sources). A player
saw the same: after a friend's recall, intervention or any jump, their figure far away until they moved again. The
check (`results/r17-2026-10-30/mp-check.mjs`) stays as it was: it measures what a player sees (the copy where the other
stands). Runs: `r18dev-b` 2 of 2 passed (copies within 0-38 units after each move, next cell 0-36) and `r18dev-d` 2 of 2
in the validation below — 4 of 4 —; the live r17 1 of 3 (`mp-diag/r17-1` passed; the validation's `r17-1` failed on
the move into the next cell, its copy 229,908 units off, `r17-2` on a 300-unit move, 12,456 units off).

##### (D) The two blocking paths r17 left, under r20

- **A preload's forced read past `dataWaitLimit`** (`?preloadwait=1000`, glide north from -2,-9 at 85 KB/s for 90 s,
  `diag/rows/d-r1?-glide85k.jsonl`): on both, the exterior preload asked a 3.28 MB `Morrowind.bsa` entry in the
  background (`orthrosRangeReady`, `bg`) and 1.5 s later read it synchronously (`sync`, the page's thread held): 42.2 s
  (r17), 32.4 s (r20), the page's longest block 42.3 / 32.5 s. r20 does not suspend there — a frame of play is plain, 0
  suspensions after the trigger —: it blocks as r17 does. With r17's default limit (60 s) the same read comes after 60 s
  of waiting.
- **A door's load** (`--mode door`, Balmora's south wall cornerclub, local link): r20's loading screen on 0.1-1.3 s after
  the Enter, 0 suspensions (the load runs in the frame of play that started it, synchronously): the page's longest block
  1,157 ms against r17's 1,356, the visible freeze 1,367 ms on both (one run a side).
Both paths are unchanged by r20: suspending them needs the load put off to a promising frame (as a save's, a new game's
and the debug COE are), not done here.

##### The validation of `r18dev-d` against the live r17, and the verdict (2026-10-30)

`r18dev-d` (engine `67ba0ec0e388`, scratch: r1..r17 + this `orthros-r20.patch`) against `openmw-web-v1.5.3-orthros-r17`, both on
this tree's page code (the read-ahead drop of (A) included); new warm profiles, each made by its own engine (both
warm-ups 41-42 s to the world, 538 MB stored, 190-192 MB on the wire); runs interleaved r17 / r20, one browser at a
time, the load at their start 8-20, never under 44 GB of memory available (`validation/logs/`). Results:
`tools/openmw/results/r18-2026-10-30/validation/` (place-load rows, each `perf.json`, the two-client runs, the checks,
the frame comparison, the run log; `an/summary.py` prints the table from them).

| | r17 | r20 (`r18dev-d`) |
| --- | --- | --- |
| in play (`perf.mjs tier=mid --discard --warm 0`, 60 s; 4 a side): fps | 24.57-26.13 | 24.62-25.63 |
| in play: longest frame gap (ms) | 233-300 | 200-267 |
| in play: data stalls (ms a minute) | 223-433 | 220-263 |
| in play: work p50 / p99 (ms) | 7.7-8.2 / 17.5-19.7 | 7.7-9.0 / **19.1-22.6** |
| save, warm (3 a side): menu (s) | 6.8-7.8 | 7.1-7.4 |
| save, warm: F9 to the world (s) | 4.8-4.9 | **5.1-5.2** |
| save, warm: page's longest block (ms) | 4709-4823 | 583-719 |
| save, warm: input p50 / p95 (ms) | 515-612 / 605-699 | 9-20 / **719-820** |
| save, warm: the visible freeze (ms) | 4666-4766 | 1850-1867 |
| COE, warm (3 a side): first frame (s) | 6.2-7.8 | 6.4-7.8 |
| COE: page's longest block (ms) | 1727-2220 | 213-217 |
| COE: input p50 / p95 (ms) | 345-1058 / 1453-1944 | 56-105 / 624-755 |
| COE: the visible freeze (ms) | 1517-2317 | 1717-1767 |
| new device, save (2 a side): menu (s) | 23.5-24.2 | 23.9-25.4 |
| new device: F9 to the world (s) | 11.9-12.7 | **12.6-13.7** |
| new device: page's block / the visible freeze (s) | 11.8-12.5 / 11.8-12.4 | 0.5-0.7 / 7.8-8.4 |
| 85 KB/s, save (2 a side): menu (s) | 10.4 | 10.5-10.6 |
| 85 KB/s: F9 to the world (s) | 27.5-27.7 | 27.4-27.6 (no announced wait timed out) |
| 85 KB/s: page's block / the visible freeze (s) | 27.5-27.6 / 27.4-27.6 | 0.5-0.7 / 21.8-21.9 |
| `__omwPrecompile.lateOld` after the load | 0 (every run) | 0 (every run, 12 loads, the 2 forced ones among them) |
| two clients (`mp-check.mjs`) | 0 of 2 (1 of 3 with `mp-diag/`) | 2 of 2 (4 of 4) |

- **Pictures**: `frame-compare.mjs morrowind-goty-en`, `''` against `?jspi=0`: day 0.079 /255 (noise 0.004), night 0.32
  (0.30), interior 0.16 (0.50), no pixel over 24 in any.
- **check.mjs**: `morrowind-goty-en` passed (47,241 draws), `--lang fr` passed (`morrowind-goty-fr`, 47,154 draws).
- **overlay-check.mjs** against `r18dev-d`: both Morrowind games' overlays agree with their originals (interp.lua is no
  overlay's original).
- **Crashes**: none — 31 r20 page sessions in the validation (place-load 10, `perf.mjs` 4, frame-compare's 9 page
  loads, the 2 checks, the 4 pages of the 2 two-client runs, the 2 forced ones), ~40 more in the diagnosis above; no
  page error but Chromium's pointer-lock message (both sides), the kernel's log has no segfault since 16:50; Chromium's
  heap profiler forced on every renderer (`--memlog=all-renderers --memlog-sampling-rate=100000
  --memlog-stack-mode=native`): a save boot and its load, a COE boot and its load, no crash.
- `make test`: 1,706 tests, 1,703 pass, 0 fail (3 skipped).

**Verdict: NO-SHIP**, by criterion:
1. **Crashes: met** (0 in 31 sessions, 0 in the 2 forced).
2. **In play: not met, narrowly** — fps (24.62-25.63 within r17's 24.57-26.13), the longest gap (200-267 against
   233-300) and the stalls (220-263 against 223-433) are met, but work p99 is 19.1-22.6 ms against 17.5-19.7: three r20
   runs of four above r17's slowest (median 20.8 against 18.6). r20's frames of play are plain (no suspension); not
   attributed here.
3. **Loads: met for the COE, not for the save** — the page's longest block is better on both (save 0.58-0.72 s against
   4.7-4.8 s; COE 0.21 against 1.7-2.2 s), the visible freeze shorter or equal (save 1.85 against 4.7 s; COE 1.72-1.77
   against 1.52-2.32), the COE's input p95 better (624-755 against 1453-1944); but a save's input p95 is 719-820 ms
   against 605-699 and its F9 to the world 5.1-5.2 s against 4.8-4.9 (outside r17's spread by 0.2-0.4 s). The GPU wait's
   cap (300 ms) traded one for the other: through the play page the status call after it held the page 0.58-0.72 s (0.2
   s with `--entry engine`), the mouse moves waiting for the GPU's frames; at 2000 ms the save's F9 was 5.7-6.1 s.
4. **Not met on a new device; met at 85 KB/s and elsewhere** — at 85 KB/s a save loads in 27.4-27.6 s against 27.5-27.7
   (it was 36.8-37.6 against 24.3-24.5 before (A), 38.5 against 30.3 in the r17dev-e validation) with no announced wait
   timing out, the menu even; on a new device F9 to the world is 12.6-13.7 s against 11.9-12.7 and the menu 23.9-25.4
   against 23.5-24.2: r20's load carried 5.95-6.09 MB of background requests (3.55-3.62 MB of archives) against r17's
   4.40-4.88 (1.50-2.58), and 0.3-0.6 MB more of announced ones — not traced in these runs (no `--read-trace` there),
   open. The pictures, the two-client check (2 of 2, and r17 fails it: the engine's extrapolation fixed in (C)),
   `lateOld` 0, check.mjs EN and FR, overlay-check and `make test`: met.

##### The second full validation of `r18dev-d` against the live r17, and the verdict (2026-10-31)

The same build (`r18dev-d`, engine `67ba0ec0e388`, this tree at `388dfce`), validated again from scratch against
`openmw-web-v1.5.3-orthros-r17`. Both sides ran on this tree's page code. Every server had its own copy of the live
learned state, copied at 22:29, and the frozen copy of the live br-cache. Each side had its own warm profile, made by
its own engine. The runs alternated r17 / r20, one browser at a time through `tools/with-browser-slot.sh`, from 22:30 to
01:19. Free memory never went below 38 GB (`logs/memory.log`); each start's load and memory are in
`logs/runs-started.txt`. Results are in `tools/openmw/results/r18-2026-10-30/validation2/`: place-load rows, each run's
console, proxy log and read trace, each `perf.json`, the two-client runs, the checks, the frame comparison, the logs and
the driver scripts. `scripts/summary2.py validation2` prints `summary.txt` from them.

**First round discarded: r20's warm profile lacked the engine's lean package.** The copied br-cache had no lean package
for r20's `openmw.data`: r20 (then with the `interp.lua` fix, now r18's) changes `interp.lua` inside it, so the package has a new content hash. The server built
that package during r20's warm-up (`openmw lean package 2c6b8e83f75b (lean3): 4133415 bytes in 69 s`). Until it was
ready, the warm-up page loaded the release's full package instead (219.7 MB on the wire against 190.4).

As a result, every warm r20 run fetched the 4.13 MB lean package before the menu. The menu came at 8.4-9.2 s against
r17's 7.0-7.8 on the local link, and at 60.5-60.6 s against 10.5-10.7 at 85 KB/s. Those rows are kept in `round1/`
(`round1/summary.txt`) but not used for the verdict. The r20 warm profile was rebuilt once the package existed, and the
warm save, COE and 85 KB/s runs were repeated, both sides interleaved again.

Two consequences for a real deployment:
- Returning players download the new lean package once (4.13 MB, about 50 s at 85 KB/s), as with any release that
  changes the package's content.
- Until the server has built it (about 70 s after the first request), pages load the full 33 MB package.

| | r17 | r20 (`r18dev-d`) |
| --- | --- | --- |
| in play (`perf.mjs tier=mid --discard --warm 0`, 60 s; the 4 required pairs): fps | 25.01-25.94 | 24.55-26.00 |
| in play, 4 pairs: longest frame gap (ms) | 233-267 | 200-250 |
| in play, 4 pairs: data stalls (ms a minute) | 185-240 | 192-223 |
| in play, 4 pairs: work p50 / p99 (ms) | 7.8-8.3 / 17.9-20.0 | 7.9-8.4 / **17.1-21.4** |
| in play, 6 pairs (2 more, run after the 4): fps | 24.81-25.94 | **23.81**-26.00 |
| in play, 6 pairs: longest gap / stalls | 233-317 / 185-336 | 200-300 / 192-276 |
| in play, 6 pairs: work p99, median | 17.9-20.6, 18.6 | **17.1-22.0, 20.0** (3 of 6 above r17's slowest) |
| save, warm (3 a side): menu (s) | 7.1-7.8 | 7.2 |
| save, warm: F9 to the world (s) | 4.8 (each run) | **5.2-5.3** |
| save, warm: page's longest block (ms) | 4746-4783 | 697-753 |
| save, warm: input p50 / p95 (ms) | 469-495 / 657-880 (median 756) | 8-20 / 648-801 (median 689) |
| save, warm: the visible freeze (ms) | 4700-4733 | 1850-1917 |
| COE, warm (3 a side): first frame (s) | 6.5-7.0 | 6.2-6.6 |
| COE: page's longest block (ms) | 1808-2206 | 211-445 |
| COE: input p50 / p95 (ms) | 619-818 / 1534-1933 | 61-87 / 561-723 |
| COE: the visible freeze (ms) | 1650-2033 | 1550-1617 |
| COE: steady in the world (s) | 5.2-5.8 | 5.8-6.4 |
| new device, save (2 a side): menu (s) | 23.3-24.6 | **25.1-25.9** |
| new device: F9 to the world (s) | 12.1-12.6 | 12.4-12.6 |
| new device: page's block / the visible freeze (s) | 12.1-12.4 / 12.3-12.8 | 0.6 / 8.3-8.4 |
| 85 KB/s, save (2 a side): menu (s) | 10.3-10.9 | 10.5-10.6 |
| 85 KB/s: F9 to the world (s) | 27.7-27.8 | 26.2 (no announced wait timed out on either side) |
| 85 KB/s: page's block / the visible freeze (s) | 27.5-27.6 / 27.4-27.5 | 0.76-0.78 / 20.5-20.6 |
| `__omwPrecompile.lateOld` after the load | 0 (every run) | 0 (every run, including the 2 forced ones) |
| two clients (`mp-check.mjs`, 5 a side) | 4 of 5 | 4 of 5 |

- **Two clients.** Both sides passed 4 of 5, but they failed differently:
  - r17's failure (`r17-5`) was the teleport desync that (C) fixes: the copies stood 25,804 and 22,891 units off.
  - r20's failure (`r18-2`) was a 57-unit gap. A's third move brought it back to its starting spot, and B's copy of A
    stayed 57 units from it (25 units higher) for 90 s. B itself stood 36 units from that spot, which is consistent with
    the copy being pushed aside by B's own body. That cause is not established.
  - In the r20 runs that passed, copies ended 0-42 units off; in r17's, 0-28.
- **Pictures** (`frame-compare.mjs`, `''` against `?jspi=0`, mean absolute difference out of 255, the noise in
  parentheses): day 1.707 (1.706), night 0.041 (0.226), interior 0.276 (0.586). No pixel differs by more than 24 in any
  view, so the pictures are unchanged.
- **check.mjs** passed in English (46,545 draws) and with `--lang fr` (45,936 draws).
- **overlay-check.mjs** against `r18dev-d`: both Morrowind games' overlays agree with their originals.
- **`make test`**: 1,706 tests, 1,703 pass, 0 fail (1 skipped, 2 todo).
- **Crashes: none in 53 r20 page sessions.** Those were:
  - 26 place-load sessions (23 measured, the first round's included, plus 3 warm-ups);
  - 6 `perf.mjs` runs;
  - frame-compare's 9 page loads;
  - the 2 checks;
  - the 10 pages of the 5 two-client runs.

  No page showed an error other than Chromium's pointer-lock message, which appears on both sides. The kernel log has no
  segfault since 15:10 on 10-30. With Chromium's heap profiler forced on every renderer
  (`--memlog=all-renderers --memlog-sampling-rate=100000 --memlog-stack-mode=native`), a save boot and its load and a
  COE boot and its load did not crash.

**The two blocking paths (D), again.** Both still block on r20. A play frame is plain, so neither path suspends.
- **The forced read past `dataWaitLimit`** (`?preloadwait=1000`, gliding north from -2,-9 at 85 KB/s for 90 s, 2 runs
  a side). The page's longest block was 12.9 and 16.4 s on r17, against 24.2 and 34.9 s on r20. Read traces:
  - Run 1, r17: the announced wait for the `meshes:-2,-8` batch (3.23 MB) finished in 12.7 s.
  - Run 1, r20: that wait timed out at 15 s. The same 3.28 MB `Morrowind.bsa` entry was then read synchronously inside
    the cell load (8.9 s), so the page was held 24 s.
  - Run 2: the forced synchronous read of that entry took 16.4 s on r17 and 34.8 s on r20.
  - On the link, during r20's run 2, the entry's two 1 MiB blocks were each requested twice at the same time (four
    0.53 MB responses, about 35 s each). In r17's run 2, one block went twice. The forced read does not join a
    background fetch of the same block that is already in flight. That is page code shared by both sides and is still
    open. How long the read takes depends on the link and on what the warm store already holds; one run a side in the
    diagnosis gave the opposite order (42.3 against 32.5 s).
- **A door's load** (`--mode door`, one run a side). The load ran in the play frame that started it (0.17-1.77 s), with
  0 suspensions and 123 synchronous reads totalling 107 ms (r17: 80 ms). The page's longest block was 1,657 ms against
  r17's 1,674, and the visible freeze 1,983 ms against 1,650.

**Verdict: NO-SHIP.** By criterion:
1. **Crashes: met.** 0 in 53 r20 sessions, and 0 in the 2 sessions with the heap profiler forced.
2. **In play: not met.** In the 4 required pairs, r20's longest gap is better (200-250 ms against 233-267) and its
   stalls are within r17's range (192-223 against 185-240). Its first run is outside r17's range on both fps (24.55
   against 25.01-25.94) and work p99 (21.4 against 17.9-20.0). Two more pairs confirm it: work p99 17.1-22.0 ms (median
   20.0) against 17.9-20.6 (median 18.6), with 3 of 6 runs above r17's slowest, and fps down to 23.81. The previous
   validation saw the same (19.1-22.6 against 17.5-19.7).
3. **Loads: met for the COE, not for the save.**
   - Met: the page's longest block is much better on both (save 0.70-0.75 s against 4.75-4.78; COE 0.21-0.45 against
     1.81-2.21).
   - Met: input p95 is better on the COE (561-723 ms against 1534-1933). On the save it is better only narrowly (648-801
     against 657-880; median 689 against 756).
   - Met: the visible freeze is shorter (save 1.85-1.92 s against 4.70-4.73; COE 1.55-1.62 against 1.65-2.03).
   - Not met: the save's F9 to the world is 5.2-5.3 s in all three runs, against 4.8 s in all three of r17's, 0.4-0.5 s
     outside r17's range. The COE's time to a steady world is also 0.6 s later (5.8-6.4 s against 5.2-5.8).
4. **Not met on a new device; met at 85 KB/s and everywhere else.**
   - At 85 KB/s the save reaches the world in 26.2 s against 27.7-27.8, with the menu even (10.5-10.6 against
     10.3-10.9).
   - On a new device, F9 to the world is within r17's range (12.4-12.6 s against 12.1-12.6), but the menu comes 0.5-2.6
     s later (25.1-25.9 s against 23.3-24.6). The previous validation saw the same (23.9-25.4 against 23.5-24.2). Before
     the menu, r20's page waited 3.0-3.2 s on demand reads against r17's 1.3-2.3, with 1.07-1.15 MB of demand traffic
     against 0.33-0.98. The engine download was the same (9.87 MB against 9.86). These runs had no read trace, so the
     cause is still open.
   - Met: the pictures are unchanged, the two-client check passed 4 of 5 on r20 (r17 4 of 5, its failure the desync
     that r20 fixes), `lateOld` is 0, check.mjs passed in EN and FR, overlay-check passed and `make test` is green.

##### Closing the second validation's gaps: `r19dev-a` (2026-10-31)

What the second validation left open, measured again on this tree (`data-r15` from `80d1ffd`) and attributed. The live
r18 release, `r18dev-d` (r20 as validated: r1..r18 + the `orthros-r20.patch` of that validation; "r19d" below) and
`r19dev-a` (engine `515236e0e051`: the kept tree's state rebuilt to r1..r18 + `orthros-r20.patch` + `r19x-a.patch`, now
folded into `orthros-r20.patch`; "r19a"), all on this tree's page code. One browser at a time through
`tools/with-browser-slot.sh`, every run started with at least 44 GB available (`logs/runs-started.txt`, `logs/memory.log`
every 30 s); another session's browser ran beside some of them. Results: `tools/openmw/results/r19-2026-10-31/` (place-load
rows, each run's console, proxy log and read trace in `runs/`, `perf.json` of every in-play run, chosen CPU profiles in
`profiles/`, the micro-benchmark in `bench/`, the driver scripts in `scripts/`).

**(d) The forced read joins the fetch already under way — fixed (shared page code).** A preload's background ask
(`orthrosRangeReady`) and, one wait limit later, the forced read of the same entry both went through the data worker's
`HttpFile.prepare` → `HttpBackend.fetchAhead`, which joined the background's piece and block flights but not another
read's own `fetchForeground`: the same 1 MiB blocks went twice on the link at once (validation2: 5-6 ranges asked again
while on the link, 0.75-1.24 MB more on an 85 KB/s link). `fetchAhead` now registers the pieces it fetches
(`fgFlights`) and a read of them meanwhile waits for that request (`stats.fgJoined`); a request that fails leaves the
joiner to fetch by itself (`tests/http-backend-async.test.js`, which fails without the fix). Glide at 85 KB/s with
`?preloadwait=1000`, one run a side: 1 range asked twice on either side (0.02 MB, a 64 KiB piece by another path),
against 5-6 before; the forced read of the 3.28 MB `Morrowind.bsa` entry 13.7 s (r18) and 14.8 s (r19a) — the two
blocks' 1.08 MB at 85 KB/s is 12.7 s — against 16.4-34.8 s in validation2. The page's longest block there is still that
read (a frame of play is plain: it does not suspend).

**(a) The warm save's F9 to the world: +0.35-0.45 s, the GPU wait after the load and the reads' spin.** With ONE warm
profile for every side, the store is the same — but its HTTP cache holds the compiled module of the engine that made
it: on a profile made by r19d's warm-up, r19d 5.0-5.3 s (5 runs) against r18 5.0-5.3 s (8 runs) looked like parity, and
r19a, not cached, 5.4-5.7 s (5 runs). On a profile made by a fourth engine (r17's warm-up, `load4/`: no side's module
cached) 3 runs a side: r18 5.0-5.2 s, r19d 5.5-5.6 s, r19a 5.4-5.6 s. The gap is real, ~0.4 s, and r19a's change
(below) does not move it. Where it goes (`scripts/saveph.py`, the read traces): the same 9 serial `Morrowind.esm` reads
after the loading screen (1.0 s on every side) split the load in two —
- before them, +0.1-0.3 s (their start 2.78-2.93 s after the key against 2.63-2.71): the key to the last announced wait's end 1.82-1.92 s (r18) against 1.90-2.03 (the load
  starts a frame later: put off to the promising frame); its waits' totals equal (1.27 s); the reads the 10 ms spin
  answered or that suspended after it 394-440 ms against 349-363 ms of synchronous waits (~5 ms more for each of the
  ~11 that suspended: the round to the page and back);
- after them, +0.2-0.4 s: the world's first draw, 1.36-1.43 s on r18 against 1.56-1.76 s — the load frame's GPU waits
  (`orthros_gl_settle`: 3 suspensions, 1 + 300 + 300 ms, the cap twice) then the status calls, which still held the
  page's thread 0.69 s in r19d's profiled load (`checkFramebufferStatus`, against 1.09 s in r18's).
- **The play page's, not the engine's**: the same scenario through the engine's page alone (`--entry engine`, `gl5/`, 2
  runs each, the neutral profile): r19a 4.6, 4.6 s against r18 5.0, 5.0 — r20 0.4 s *ahead*; `?jspiglmax=150` 4.3, 4.4;
  `?jspigl=0` 4.4, 4.6 (the page held 424-509 ms). Through the play page r20 loses 0.9 s, r18 0.1 s. Not attributed
  further here; the candidate: while the engine is suspended the play page's thread is free, and the browser renders
  the play page and its frame (its shell, the data meter) — GPU work in SwiftShader queued before the world's first
  draw, which r18's held thread never let it do. Input p95 through the engine page: r19a 1219-1507 ms against r18's
  548-571 — the mouse moves of that page wait for its animation frames, which wait for the GPU.
- Not the CPU profile's "0.9 s more native time": V8's CPU profiler does not walk a JSPI stack — a sample taken on one
  is `(program)`. Shown on the worker threads (below): r19d's half-busy worker, 476 ms/s of `(program)` and nothing in
  `__pthread_cond_timedwait`; r18's and r19a's (plain entry), 478-487 ms/s in `__pthread_cond_timedwait`, no
  `(program)`. The load's frame runs on a JSPI stack: its wasm is `(program)` there. The earlier comparison of
  r17's `(program)` with r20's was not like for like.

**(c) In play: worker threads off JSPI stacks; the medians within the criterion.** Emscripten under `-sJSPI` starts every
pthread through `WebAssembly.promising` (`libpthread.js` `$invokeEntryPoint`, `makeDynCall(…, ASYNCIFY == 2)`): Lua's
update thread, the NIF parses, the work queue and the physics all ran their whole lives on JSPI stacks, though none of
them may ever suspend (the engine's suspending imports are the page's thread's alone). Measured in Chromium 153
(`bench/`: a hot loop at every stack depth 0-4000, plain export against promising, on the page and in a worker): a wasm
call costs the same on a JSPI stack at every depth (no stack-growth cliff), an import call 15 ns against 5 ns. r19a
(`orthros-jspi.js`): `$invokeEntryPoint` plain, as a build without JSPI; a worker's `emscripten_sleep` sleeps on its
futex (`emscripten_thread_sleep`; engine.cpp `__wrap_emscripten_sleep`); the C library's `fd_read` times a call only
when it is proxied from a worker. In play (`perf.mjs tier=mid --discard --warm 0`, 60 s, 6 a side, the order
alternated, `play1/`): fps median 24.70 (24.40-25.09) against r18's 24.55 (23.99-26.44) — within 0.3; work p99 median
20.3 ms (18.8-23.5) against 19.95 (18.8-20.3) — within 0.5; p50 9.2 against 9.1; longest gap 233-333 against 267-333 ms;
data stalls 208-333 against 239-309 ms a minute. r19a's p99 spread is wider (its first two runs 22.0, 23.5; the other
four 18.8-20.6), so "no worse than r18's spread" is not met on this sample. r19d, 3 runs beside them: 15.7-21.6. One CPU
profile a side of the main thread (`profiles/play-main-*`): r19d's wasm 8.4 ms a frame against 8.0, spread over every
function (the largest, `osg::State::apply`, +0.6 ms/s), nothing r20 adds — not attributed further, and within the run
to run noise of the same measure (r18 8.0-8.3, r20 7.4-10.4 over 4 profiled runs).

**(b) A new device's menu: link scheduling, not reproduced as a gap.** Three pairs with read traces (new profiles, 2 MB/s,
85 ms): the menu r20 27.6 (r19d), 23.6, 25.4 s (r19a) against r18 24.9, 26.5, 25.6 — medians 25.4 against 25.6; F9 to
the world 11.3, 12.9, 12.2 against 12.4, 11.3, 11.5. The first pair (`diag1/`, r19d 2.7 s later) traced
(`scripts/pair.py`, `cover.py`, `conc.py`): the same reads in the same order; r20's boot reached the archive's reads
earlier (`Morrowind.bsa` 213516288 at 16.0 s against 16.2, answered in 0.41 s against 1.33), then waited behind
background requests already on the link — its reads covered by a background request waited 7.55 s in all against
4.74 s, those requests larger when they started outside a run of waits (256-512 KiB against 64 KiB: `NetLink.loading()`
had lapsed) and shared with 9-14 other background requests on average. The total demand wait before the menu 13.8 s
against 11.6. The second and third pairs went the other way. The order in which a 2 MB/s link carries the boot's
bytes moves the menu by ±1.5 s run to run; the 10 ms spin, the boot's announced batch and the suspensions did not show
in any of the traces (the boot's reads and requests the same on both sides).

**(1) Crashes.** 0 renderer crashes in 35 r19a page sessions (the check, 7 `perf.mjs`, 27 place-load) and 17 r19d
sessions; Chromium's heap profiler forced on every renderer: a save boot and its load, a COE boot and its load on r19a,
no crash. The kernel logged one Chrome segfault at 06:06:37: its crash report (`Crash Reports/pending`, written at
06:06:38) is another session's browser (`--user-data-dir=/tmp/orthros-scratch/mw-perf/…`); the r19a page measured then
finished its run (1,511 frames, no fault).

**(3) The COE and the warm save's other measures** (`load2/`, `load3/`, `load4/`; 6-7 a side): the COE's page block
211-234 ms against 2045-2195, input p95 511-932 against 1789-1922 ms, the longest frame gap 1633-1883 against 1733-2067
— met. Its time to a steady world 6.0-7.0 s against 5.3-6.0: the debug COE runs at the next frame's start, and in a
plain frame it is put off once more to the promising one (`coeWaitMs` 415-530 ms). The save: page block 613-767 ms
against 4915-5232, input p95 544-1129 (median 780) against 576-1365 (median 845) — met, narrowly —, the visible freeze 1.87-2.12 s against
4.87-5.82 — met; F9 to the world, (a).

**(4) 85 KB/s** (2 a side, `load2/`): F9 to the world 27.7, 27.8 s against 27.7, 27.6, the page's block 0.77 s against
27.6, input p95 87-89 ms against 434-1272 — met (the menus 80.5-80.8 s on both: neither engine was in that profile's HTTP
cache).

**Where r20 stands against the ship criteria (not a validation: no frame-compare, two-client, check.mjs FR or
overlay-check run on r19a; `make test` below):**
1. Crashes: met (above).
2. In play: medians met (fps +0.15, work p99 +0.35 ms), r19a's p99 spread wider than r18's on this sample — open; needs
   more pairs on a quieter machine.
3. Loads: the COE met; the save's page block, input p95 and visible freeze met, its F9 to the world 0.35-0.45 s later
   than r18's (5.4-5.6 against 5.0-5.2 s, no side's engine cached) — open: the play page's part (above) is the next
   thing to attribute (a CPU and GPU profile of the play page itself over the load; the data meter and the shell's
   rendering held off while the engine is in a load's frame).
4. New device: the menu no worse over 3 pairs (medians 25.4 against 25.6 s), F9 12.2-12.9 against 11.3-11.5 s in the
   two r19a pairs (11.3 against 12.4 in r19d's) — within the link's run-to-run spread; 85 KB/s met; (d) fixed.

`make test` on this tree: 1,708 tests, 1,705 pass, 0 fail (1 skipped, 2 todo). `r19dev-a` is a development build in scratch (engine `515236e0e051`); the release r20 is still to be built from the
lock entry (files `{}`) by `tools/openmw/build.sh`.

##### The third full validation: `r19dev-a` against the live r18, and the verdict (2026-10-31)

`r19dev-a` (engine `515236e0e051`: r1..r18 + `orthros-r20.patch` with `r19x-a.patch` folded in; this tree's page at
`18b5143`) validated from scratch against the live `openmw-web-v1.5.3-orthros-r18` (engine `a2808b8cf12a`, served
read-only from `data/engines`). Both sides ran this tree's page code, so they differ only in the JSPI parts. The live
learned state and br-cache were copied at 08:19. Every server ran on its own copy of that learned state and on the
frozen br-cache copy, which holds the lean package `2c6b8e83` (lean3): both engines' `openmw.data` are the same file, so
one lean package serves both. Each side had its own warm profile, made the same way by its own warm-up (r18 187.7 MB on
the wire, r19a 190.7 MB; menus 7.1-7.5 against 7.0-7.7 s, so neither side fetched a package the other had).

Runs alternated r18 / r19a, with the order swapped every pair, one browser at a time through
`tools/with-browser-slot.sh`, from 08:20 to 10:23. Each start's load and memory are in `logs/runs-started.txt` (59
starts). The slot script held every browser until the load fell under 24. Memory was logged every 30 s
(`logs/memory.log`); available memory never fell below 40 GB. Results are in
`tools/openmw/results/r19-2026-10-31/validation3/`: rows, each run's console, proxy log and read trace, `perf.json` files,
two-client runs, checks, frame comparison, logs and driver scripts. `scripts/summary3.py` prints `summary.txt` from them.

| | r18 (live) | r20 (`r19dev-a`) |
| --- | --- | --- |
| in play (`perf.mjs tier=mid --discard --warm 0`, 60 s, 8 a side): fps | 23.31-25.71, median 24.34 | 23.48-25.78, median 24.65 |
| in play: work p99 (ms) | 18.9-24.5, median 21.45 | 18.2-22.2, median 19.3 |
| in play: work p50 / longest gap (ms) | 8.2-10.3 / 233-333 | 8.1-9.0 / 233-367 |
| in play: data stalls (ms a minute) | 237-342 | 197-344 |
| save, warm (4 a side): menu (s) | 7.1-7.5 | 7.0-7.7 |
| save, warm: F9 to the world (s) | 4.9, 4.8, 4.9, 4.8 | **5.2, 5.3, 5.5, 5.3** |
| save, warm: page's longest block (ms) | 4663-4838 | 659-817 |
| save, warm: input p95 (ms) | 843, 771, 591, 570 (median 681) | **1160, 719, 1017, 702 (median 868)** |
| save, warm: the visible freeze (`frameGapMaxMs`) | 4616-4800 | 1867-1967 |
| COE, warm (4 a side): first frame (s) | 6.5-7.0 | 6.3-8.0 |
| COE: page's longest block (ms) | 2015-2233 | 201-236 |
| COE: input p95 (ms) | 1747-1957 | 548-723 |
| COE: the visible freeze (ms) | 1917-2133 | 1700-1783 |
| COE: steady in the world (s) | 5.3-5.7 | 6.4-6.7 |
| new device, save (4 a side): menu (s) | 25.1-26.6, median 25.75 | 24.3-27.1, median 25.9 |
| new device: F9 to the world (s) | 11.2, 10.9, 10.8, 11.0 | **12.3, 12.3, 13.0, 12.6** |
| new device: page's block / the visible freeze (s) | 10.8-11.2 / 10.7-11.1 | 0.52-0.61 / 7.6-7.9 |
| 85 KB/s, save (2 a side): menu / F9 to the world (s) | 10.7 / 27.7, 27.7 | 10.7-10.8 / 27.2, 27.4 |
| 85 KB/s: page's block / input p95 (ms) | 27441-27490 / 551-770 | 281-330 / 94-163 |
| `__omwPrecompile.lateOld` after the load | 0 (every run) | 0 (every run, including the 2 forced ones) |
| two clients (`mp-check.mjs`) | 2 of 2 | 3 of 4 |

- **Two clients.** r20's failure (`r19a-4`) is the 57-58-unit gap the second validation saw (`r18-2` there), with the
  mover reversed. B's third move ended 5 units from its spot, and A's copy of B stayed 58 units from it, 33 lower, for
  60 s. Every other check of that run passed, including the move to the next cell, where the copies were 0-6 units off.
- **Pictures** (`frame-compare.mjs` on r19a, `''` against `?jspi=0`; mean absolute difference out of 255, the noise in
  parentheses): day 0.063 (1.444), night 0.014 (0.015), interior 0.989 (1.277). No pixel differs by more than 24, so the
  pictures are unchanged.
- **check.mjs** passed on r19a in English (44,022 draws) and with `--lang fr` (`morrowind-goty-fr`, its scratch manifest
  moved to r19dev-a: 47,850 draws).
- **overlay-check.mjs** against `r19dev-a`: both Morrowind games' overlays agree with their originals.
- **`make test`**: 1,708 tests, 1,705 pass, 0 fail (1 skipped, 2 todo).
- **Crashes: none in 45 r19a page sessions.** Those were:
  - 18 place-load sessions (the warm-up included);
  - 8 `perf.mjs` runs;
  - frame-compare's 9 page loads;
  - the 2 checks;
  - the 8 pages of the 4 two-client runs.

  No page showed an error other than Chromium's pointer-lock message, which appears on both sides. The kernel logged no
  segfault after 06:06 (another session's browser, see above). With Chromium's heap profiler forced on every renderer, a
  save boot and its load (F9 to the world 5.1 s) and a COE boot and its load did not crash.
- **A new device's F9, attributed** (`scripts/saveph.py` on the read traces; `summary.txt` lists every run):
  - The 9 serial `Morrowind.esm` reads start 9.8-10.7 s after the key on r19a, against 8.5-8.8 s on r18. From their end
    to the world it is the same on both sides (1.2-1.4 s).
  - **The load starts later on r19a.** Its first announced wait begins 0.47-0.81 s after the key, against 0.02-0.03 s.
    The load is put off to the promising frame, and on a new device that frame comes later.
  - **The reads before the serial ones take longer on r19a.** There are 282-284 of them on r19a against 296-303, but
    they take 751-1126 ms against 139-169 ms: these are the reads that the 10 ms spin answered, or that suspended after
    it.
  - The announced waits are the same length on both sides (about 7.2 s in all).
  - On a warm profile (validation `load4/` above), the same two parts are smaller: +0.1-0.3 s before the serial reads and
    +0.2-0.4 s after them.
- **(d) is not fully closed.** One glide a side at 85 KB/s with `?preloadwait=1000` (`scripts/dups.py`):
  - **What was measured:** 3 ranges were asked twice while already on the link on r19a (1.10 MB more), and 4 on r18
    (1.65 MB). The page's longest block was 26.4 s on r19a against 38.2 s on r18.
  - **Why:** the order was the reverse of the one `80d1ffd` fixed. In both runs a demand read fetched the entry's 1 MiB
    blocks first (r19a at 34.5 s, r18 at 42.0 s). The preload's announced ask (`w=1`) for the same blocks came 6-8 s
    later, and `fetchBackgroundNow` does not join a foreground fetch already in flight. The join (`fgFlights`) is only
    checked by a read, and only `fetchAhead` registers its pieces there.
  - **Also:** two foreground reads of the same 64 KiB piece overlapped by 0.1 s.
  - **Status:** this is shared page code, the same on both sides, and is still open.

**Verdict: NO-SHIP.** By criterion:
1. **Crashes: met.** 0 in 45 r19a sessions, and 0 with the heap profiler forced on a save load and on a COE.
2. **In play: met on this sample.** Over 8 runs a side:
   - fps median 24.65 against 24.34 (+0.31, on the better side);
   - work p99 median 19.3 against 21.45 ms (better);
   - work p99 spread 18.2-22.2 against 18.9-24.5 (no worse);
   - longest gap and stalls within r18's range.

   r18's p99 this time was higher than in `play1/` (median 19.95 ms there), at loads of 11-21. Across the three samples
   (validation2, `play1/`, this one), r20's in-play work is at parity with r18 within the run-to-run noise. It is no
   longer outside it.
3. **Loads: the COE met; the warm save not met on two measures.**
   - COE, met: page block 201-236 ms against 2015-2233; input p95 548-723 ms against 1747-1957; visible freeze 1700-1783
     ms against 1917-2133. Its time to a steady world is still 0.7-1.4 s later (6.4-6.7 s against 5.3-5.7).
   - Save, met: page block 0.66-0.82 s against 4.66-4.84 s; the visible freeze 1.87-1.97 s against 4.62-4.80 s, so
     `frameGapMaxMs` is better.
   - Save, not met: F9 to the world is 5.2-5.5 s against 4.8-4.9 s in every run, 0.3-0.6 s outside r18's spread.
   - Save, not met: input p95 is worse, not better (median 868 ms against 681; 702-1160 against 570-843). The second
     validation's median was 689 against 756, and `load2`-`load4`'s was 780 against 845. Input p95 is about even
     between the two sides; it is not the clear improvement the criterion asks for.
4. **New device: not met for F9; everything else met.**
   - New device, not met: the menu is at parity (medians 25.9 against 25.75 s over 4 pairs, with overlapping ranges),
     but F9 to the world is 12.3-13.0 s against 10.8-11.2, 1.1-1.8 s later in all 4 pairs. This is attributed above:
     the load starts later, and the spun or suspended reads before the serial ones take 0.6-1.0 s more.
   - Met: 85 KB/s (menu 10.7-10.8 against 10.7 s; F9 27.2-27.4 against 27.7 s; page block 0.28-0.33 s against 27.4-27.5
     s).
   - Met: the pictures are unchanged, the two-client check passed 3 of 4, `lateOld` is 0, check.mjs passed in EN and
     FR, overlay-check passed and `make test` is green.

**Next.** What separates r20 from shipping is when a save load starts and how its reads are answered before the serial
esm reads (criteria 3 and 4). A warm profile adds +0.4 s to F9; a new device adds +1.3-1.5 s. The next step is to start
the save's load in the frame that receives the key, instead of the next promising frame, and to time the 10 ms spin's
answers and suspensions per read in that phase. Next comes a CPU and GPU profile of the play page itself over the load
(still open from (a)). Then an announced background ask should join a foreground fetch already in flight (`fgFlights`
in `fetchBackgroundNow`) — the remaining part of (d).

##### Iteration 4: the third validation's gaps attributed and closed, `r20dev-b` and `r20dev-c` against the live r19 (2026-10-31)

Renumbered r20 on `main`'s r19 first (above). Builds over the kept tree (`tools/openmw/dev-build.sh`, r1..r19 +
`orthros-r20.patch` + `r20x-b.patch`, then `r20x-c.patch`; both now folded into `orthros-r20.patch`): `r20dev-b` (engine
`61fc2db2c1f2`), `r20dev-c` (`c99235bfa872`). Measured against the live `openmw-web-v1.5.3-orthros-r19` (`f5eb3ec76d9b`,
read-only from `data/engines`, its draw thread off as shipped), each side its own warm profile made by its own warm-up,
servers on copies of the live learned state and frozen br-cache of the third validation, runs alternated, one browser at
a time through `tools/with-browser-slot.sh` (available memory never under 42 GB, `logs/memory.log`). Evidence:
`tools/openmw/results/jspi-iter4-2026-10-31/` (`diag/`: the attribution runs on `r19dev-a` and r18; `validation/`: the
rows, `perf.json` files, read traces, `summary.txt`; `scripts/`, `patches/`).

**What the third validation's gaps were** (read traces, CPU profiles, browser traces — `place-load.mjs`
`ORTHROS_PLACE_TRACE=1`, new: every process from the key to the load's end —, Linux `perf` on the renderer):
- **A new device's F9: the splash image, not the frame deferral.** The promising frame after the deferring plain one
  came 3-4 ms later (the read traces' `defer`/`enter` marks; the loading screen on 24-47 ms after the key against r18's
  ~20 ms). What took the 0.47-0.81 s before the first announced wait was the loading screen's first read, its random
  splash image (196 KB): on r19a every one of the 4 runs drew one not fetched yet (`late`, 412-757 ms; a second splash
  527 ms more in one run), on r18 every one drew one the learned prefetch had already brought (1-2 ms). r19a's
  background had ~1.5 MB less done at the key (37.8-41.0 MB against 40.9-42.1), and the splash burst of the learned
  order came just after the key, sharing the link with the load's first announced batch (those waits +80-150 ms each).
  The "reads before the serial esm reads" (751-1126 ms against 139-169) were that splash read plus 170-210 ms.
- **A warm save's F9, +0.55 s, in two parts** (phases, `diag/phases.txt`). (1) The loading screen's own work, +0.2 s
  (r18 734-751 ms of engine work besides its waits and reads, r19a 929-996): it stays with every suspension switched off
  (`?jspispin=2000&jspibreath=0&jspipresent=0&jspigl=0&jspisettle=0`: 2675 ms to the serial reads against 2511 with
  `?jspi=0` on the same binary, where the load runs in a plain frame) — the load running on a JSPI stack. Not attributed
  further: V8's profiler shows that stack's wasm and the JS it calls as `(program)`; `perf` (`diag/perf-dso.txt`) shows
  more kernel time on the renderer's thread with JSPI (15 % of its samples against 7 %: page faults, TLB flushes,
  futex wakes) but no single cause. (2) After the serial reads, +0.3 s: the GPU fence waits of the world's first frame.
  The browser trace (`diag/trace-busy.txt`): the GPU process' main thread idle through the loading screen, then 100 %
  busy for 3.25 s from the world's first draw (SwiftShader's work landing in the display compositor's `SwapBuffers`,
  680-860 ms tasks), the same on both sides. A fence there comes only at that queue's end: each wait ran to its 300 ms
  cap, and the status call after it held the page's thread 558-680 ms all the same — the world 0.3-0.4 s later for
  nothing.
- **The warm save's input p95** is set by that GPU burst after the load, the same work on both sides: the mouse moves
  (rAF-aligned in Chrome) wait for a frame the busy GPU process does not produce — 599 and 1,512 ms on r19a, 1,742,
  1,008, 670 and 514 ms on r18 in the traces (`diag/trace-mousemove.txt`). The probe's p95 is over the moves the page
  received: r18 and r19 hold the page's thread for 4.7 s and receive 2-4 of them (coalesced), r20 receives 15-20 — its
  p95 is its slowest one or two, the live release's mostly the one after its block.
- **The play page's own rendering while suspended**: not a cost found. The CPU profile of the play page over the load,
  split by the engine's state (`scripts/profwin.py`): the page's thread idle 1.9 s of 2.8 s suspended, its scripts
  (shell, data meter, frame meter, view-grow) a few ms; presents 3 a load (1.5 ms), breaths 28 (32 ms).

**Changes** (`orthros-r20.patch`, the page; page code shared by both sides):
- **A splash already here** (`mwgui/loadingscreen.cpp`): the dice rolled as before, then the first splash from it whose
  bytes are here — `VFS::Manager::orthrosDataHere`, the page's `globalThis.orthrosRangeHere` (`streamfs.js`),
  `GameData.here` (`data-client.js`): in the page's pieces, or a file with a light copy the worker said is here whole —
  asked only, nothing fetched; none here: the random one.
- **The load in the frame that receives the key**: a key pressed (not a repeat) or a mouse button makes the next frame
  the promising export (`orthros-jspi.js`, `?jspihint=0` off; `Module.orthrosFrames.hinted`), so F9, the save dialog's
  or the menu's click load in that frame; the debug COE asks its own promising frame (`omw_debug_coe` sets the want);
  a load still put off by a plain frame is pumped at once (`Module.orthrosWantsLoad`, `play/index.html`).
- **No GPU fence wait after the loading screen** (`orthros_gl_settle`: only in the boot and under a loading screen).
- Shared page code: `fetchBackgroundNow` joins a read's foreground fetch already bringing the same pieces (the
  converse of `80d1ffd`: `joinForeground`, before any turn on the link; `tests/http-backend-async.test.js`).
- Tools: `place-load.mjs` `ORTHROS_PLACE_TRACE=1` (`port-perf.mjs` `startTrace`/`stopTrace`), `--query` through the play
  page (it hands its `jspi*` switches to the engine frame).

**Numbers** (`validation/summary.txt`; r20b = `r20dev-b`, r20c = `r20dev-c`; the live r19 "r19"):

| | live r19 | r20dev-b | r20dev-c |
| --- | --- | --- | --- |
| warm save: F9 to the world (s) | 4.7-4.9 (7) | 5.3, 5.4, 5.4, 3.9 | **4.1, 4.1, 4.1** |
| warm save: page's longest block (ms) | 4,681-4,831 | 210-1,131 | 928-1,022 |
| warm save: visible freeze (ms) | 4,633-4,783 | 1,733-1,967 | 1,883-1,950 |
| warm save: input p95 (ms) [moves received] | 516-1,038 [2-4] | 1,045-1,139 [18-20] | 2,132-2,285 [15-16] |
| warm save: steady (s) | 6.2-6.9 | 6.7-7.5 | 6.2-6.4 |
| COE: page's block / input p95 (ms) | 2,052-2,227 / 1,778-1,951 | 226-408 / 575-1,313 | — |
| COE: first frame / steady (s) | 6.6-7.0 / 5.4-5.8 | 7.8-8.0 / 5.8-6.4 | — |
| new device: F9 to the world (s) | 11.5, 11.4, 11.8 | 11.5, 11.7, 12.4 | — |
| new device: first announced wait after the key (s) | 0.03-0.05 | 0.04-0.05 | — |
| new device: page's block / freeze (s) | 11.2-11.6 / 11.2-12.1 | 0.63-0.70 / 7.5-8.2 | — |
| 85 KB/s save: F9 (s) / block (ms) | 27.6, 27.3 / 27,227-27,565 | 25.4, 25.4 / 828-933 | — |
| in play (60 s, `tier=mid --discard`): fps | 24.5-28.2, median 25.1 (8) | 23.3-24.8, median 23.9 (6) | 25.6, 26.3 (2) |
| in play: work p99 (ms) | 16.9-21.4, median 19.45 | 20.1-23.2, median 21.4 | 19.1, 17.2 |

- **New device**: the splash read 0-4 ms on every r20 run (`spin`), the load's first announced wait 0.04-0.05 s after the
  key (0.47-0.81 before); F9 at parity (medians 11.7 against 11.5 s; one run 12.4, 0.6 s over the live spread). 85 KB/s:
  1.9-2.2 s sooner.
- **Warm save**: without the fence after the loading screen (`r20dev-c`) the world comes 0.7 s *before* the live
  release's, its steady frames as soon; the status call's wait moved to the frame after the world's first (the block
  ~1 s, against 4.7). Its input p95 is the GPU burst's (above), 2.1-2.3 s, against the live release's 0.5-1.0 s over 2-4
  moves. `r20dev-b`'s one fast run (3.9 s) had no status wait at all after its fence.
- **In play**: `r20dev-b` 1.2 fps under the live release over 6 runs; the same binary with `?jspi=0` 25.3, 24.2 and
  `r20dev-c` (the same frame-of-play code) 25.6, 26.3 in the next rounds, beside the live 28.2, 24.8 — a session's
  spread, not attributed to r20, but not shown at parity by 6 runs a side either.
- **COE**: its first frame 1 s later (7.8-8.0 against 6.6-7.0 s; validation3 6.3-8.0 against 6.5-7.0) — not attributed.
- Not run this iteration: frame-compare, two clients, check.mjs EN/FR, overlay-check, the forced heap profiler, crashes
  counted (no renderer crash in the 28 `r20dev-b`/`r20dev-c` page sessions above — 16 loads, 2 warm-ups, 10 in play —, no segfault in the kernel log). `make test`: 1,711 tests,
  1,708 pass, 0 fail.

**Where r20 stands**: criterion 3's F9 met by `r20dev-c` (4.1 against 4.7-4.9 s), its input p95 not (the probe compares
15-16 moves with 2-4; the live release's own moves after its load wait as long, by the browser trace); criterion 4 at
parity on medians, one run over; criterion 2 to measure again on `r20dev-c` (2 runs at parity); the COE's first frame
and the loading screen's +0.2 s on a JSPI stack open. Next: the full validation of `r20dev-c` (or the release built from
the lock entry) with ≥ 6 in-play runs a side, and an input measure the coalescing does not bias (every move's delay from
the browser trace, or moves counted whether received or not).

### The engine's language and dialogue topic colours (2026-10-28)

OpenMW's `[General] preferred locales` defaults to `en`, and Orthros never set it. In the French games, OpenMW's own
menus (its Options, its Lua settings pages) and every Lua mod's texts (their `l10n/<context>/<lang>.yaml`) stayed in
English, even where the engine ships `fr.yaml` (all eight contexts in the release's package) or the mod does. Only the
strings OpenMW takes from the game's GMSTs were French (`gmst overrides l10n = true`: the `gmst` locale first).

The server now adds the version's settings defaults to the engine page (`withSettingsDefaults`, `src/host/openmw.js`,
from the `/ports/openmw/<id>/app/index.html` route of `src/host/server.js`, whose manifest it knows):
- `[General] preferred locales` = the version's `languages`, then `en` (`openmwLocales`): `fr,en` for a version whose
  `languages` is `["fr"]`, `en` for an English one. The engine reads it once at its start (`engine.cpp`,
  `L10n::Manager::setPreferredLocales`): `gmst fr en`, each context's French file where there is one, English
  otherwise. ICU keeps every locale's data in the lean package, so French plurals and number formats work (see
  "Runtime boundary and validation").
- `[GUI] color topic enable = true` in every OpenMW version: the dialogue window colours a topic that has an answer of the
  speaker's own, and greys one already read, with OpenMW's default colours (`color topic specific` / `exhausted`).
  OpenMW's Options menu has no switch for it; a player's `settings.cfg` can still turn it off.

They are appended to what the page writes to `/settings.cfg` (`settingsCfg`, the page's own block: `[Video]` …
`[General]`, `[Post Processing]`), as a second `[General]` header and a `[GUI]` one. That file is the first of the
engine's config dirs, which OpenMW reads as additional defaults (`components/settings/settings.cpp`:
`loadSettingsFile(…, overrideExisting = true)`). There a section may be opened again and a later key replaces an
earlier one. A duplicate key is an error only in the player's own file, which the server does not touch. That file
(`/userdata/config/openmw/settings.cfg`, the last config dir, per installation and per account) still wins: a language
chosen in Options → Language (the engine asks for a restart) or a saved `color topic enable` stays the player's. The
page's log says `[orthros] settings defaults: [General] preferred locales = fr,en; [GUI] color topic enable = true`.
Every OpenMW release from the upstream `v1.5.3` to `orthros-r13` has the same write
(`FS.writeFile('/settings.cfg', settingsCfg);`).

`tests/openmw-settings.test.js` checks the locale list, the file the page writes, read the way OpenMW's parser reads it
(its defaults, the additional defaults, the player's file over them), the page the server serves for an English and
a French version, and, where the releases are installed, each release's real settings block run as the page runs it,
over the engine's own `settings-default.cfg`. Checked in Chromium (2026-10-28, a scratch server of the change over the
live games read-only, `morrowind-goty-fr` solo on r13, a new browser profile): the engine's log says `Preferred
locales: gmst fr en`, no l10n error. The Options window's OpenMW strings are now French: "Distance de traitement pour
les personnages (3584)" where the French game said "Actors Processing Range (3584)", the tabs "Scripts" and
"Localisation", "Curseur d'émulation de souris". Its Localisation tab shows "Localisation principale : français",
"Localisation secondaire : anglais".

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
`data/proof/openmw-goty-20261018/`; disposable installer copies, browser profiles and test
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
file together with `accounts.sqlite` and native `/var/lib/orthros-openmw/<manifest>/` state in backups (restic keeps all three, docs/backups.md):
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
`data/installers/openmw/import-fr-receipt.json`. The French original profile is
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
active worlds. Evidence is retained in `data/proof/openmw-accounts-fr-20261018/`.
