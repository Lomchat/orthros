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

A second root, `orthros-player-defaults-perf` (`--id`, 2026-10-29), turns off two post-processing passes by default:
RUN!'s `SettingsRUN` `doBlurShader` (its radial blur while sprinting showed artifacts on the web engine until the
sprint ended) and The Combat Juice's `SettingsCombatJuiceFlash` `FlashOn` (`Never`; otherwise its `cj_flash` shader
stays in the chain at strength 0 and costs a full-screen pass every frame). Both can be turned back on in Options →
Scripts.

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
  goes on with the next, for up to 3 s (`?preloadwait=N`, 0: as before); the cooperative queue runs the other items
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
