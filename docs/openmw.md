# OpenMW browser port

The owner authorized an OpenMW port with faithful visual mods and multiplayer on 2026-10-15.
This extends the third-party engine exception of D069. It does not change the Win32 runtime.
The engine, its corresponding source and native simulation image are pinned by
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
  `morrowind-goty-vanilla-plus-en` profile keeps its original id and remains unavailable until
  every declared mod is installed; its separate service remains disabled.
- Project Atlas is installed from its authors' public repository, commit
  `68a838650fb177afb5e6a63c558dc4ae6bf29b56`, SHA-256
  `364c5896a4b181def2420e1b30f54043b3c0ef35812db24b53fe79f1aa1a92f5`.
  Selected parts: Core, MET textures, Glow in the Dahrk and Graphic Herbalism patches.
- Morrowind Optimization Patch is installed from the authors' `mop-org` repository, commit
  `09951b376ad8e57d8bdca64fca92c83db732a32b`, SHA-256
  `234709b8b0f603430251eb4259eac355b400454413fb6c685b6d58a60738fb7b`.
  Selected parts: Core, Lake Fjalding Anti-Suck, Chuzei Fix, Better Vanilla Textures,
  Graphic Herbalism patch; the two supplied ESPs are enabled in that future stack.
- Glow in the Dahrk 3.3.0 and Graphic Herbalism 1.04 are staged from the French Confrérie
  des Traducteurs packages, translated by Redondepremière. The Glow mirror is linked by the
  original author; Graphic Herbalism permits redistribution with attribution. Only the core
  meshes, textures and documentation were copied; no MWSE scripts or optional plugins.
  Archives, SHA-256 hashes, source selections and receipts are in `data_installers/openmw/`.
  The source pages are [Brille dans le Noyr](https://www.confrerie-des-traducteurs.fr/morrowind/mods/1890/graphisme/environnement/brille_dans_le_noyr)
  and [Récolte réaliste](https://www.confrerie-des-traducteurs.fr/morrowind/mods/1973/jouabilite/recolte_realiste).
  Glow 3.x supports basic OpenMW window glow, but its author recommends 2.11.2: sunrays in
  3.x cannot be toggled and the new MWSE interior-light features are unavailable. The staged
  core remains unvalidated in the complete stack; prefer 2.11.2 when its archive is available.
- Three mods remain missing: [Patch for Purists](https://www.nexusmods.com/morrowind/mods/45096?tab=files),
  [Morrowind Enhanced Textures](https://www.nexusmods.com/morrowind/mods/46221?tab=files) and
  [Familiar Faces](https://www.nexusmods.com/morrowind/mods/50093?tab=files). The MET 6.1 main
  archive is listed as 2.4 GB; the optional MET 6 Atlas textures (279 MB) replace the older MET
  textures shipped with Atlas and should load after it. Current original-asset profiles stay
  available while the Vanilla+ profile remains incomplete. Nexus login previously failed at
  its CAPTCHA before authentication; credentials have not been verified or saved. The public
  GitHub repositories examined do not contain complete releases of these three mods. A fresh
  ordinary Chromium login attempt also left Turnstile unverified; no CAPTCHA bypass tools
  or third-party solvers were installed. Archive integrity and all 323 copied files were
  checked, and the nine OpenMW tests pass. This is staging evidence, not full-stack play validation.
- Neither the complete graphics stack nor a complete campaign has been validated. Do not
  activate Atlas/MOP compatibility patches in the original profile without their dependencies.

The GOTY edition is available from [GOG](https://www.gog.com/en/game/the_elder_scrolls_iii_morrowind_goty_edition)
and [Steam](https://store.steampowered.com/app/22320/). OpenMW is free; the retail game is not
included. Keep installers and downloaded mod archives in `data_installers/openmw/`.

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
systemctl enable --now orthros-openmw@morrowind-goty-vanilla-plus-en
```

The runner refuses an incomplete manifest. It generates a linked read-only game tree and mod
list under `build/openmw/<manifest>/gamedata`, then starts the pinned native gateway in Docker.
Only `127.0.0.1:28100` is published. Limits: two CPU cores, 4 GiB, 256 tasks; worlds have a
3 GiB memory budget plus 256 MiB gateway reserve. Worlds start on demand and idle out. Accounts,
worlds and saves persist under `build/openmw/<manifest>/`, separate from the original game files.
Back up that state directory. Do not delete it when updating the engine.

For the currently installed original profile, the active unit is
`orthros-openmw@morrowind-goty-en` (port 28101) and the public entry point is
`https://orthros.chalco.website/ports/openmw/morrowind-goty-en/`. The full Vanilla+ unit above
must stay disabled while its five downloads are missing. Accounts and saves belong to each
profile separately. The owner's two requested player accounts are provisioned on the original
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

The upstream browser pages are adapted while serving: HTTP paths and world socket paths get
the installation prefix; guest filesystem paths stay intact. The dedicated server is unchanged.
The local portal assets come from the pinned corresponding source. The public router exposes
the gameplay/auth/storage routes and only the portal's static files, not the operator dashboard.
WebSockets require a matching Origin; the bridge fixes the target port from the manifest and
replaces client address headers. Unit tests cover isolation, missing files/mods, ranges, world
paths, cookies, and WebSocket forwarding/origin rejection.

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

The complete visual stack, full combat, long sessions, campaign completion and solo save/load
remain to be checked. The complete Vanilla+ profile must remain unavailable until its missing
archives and compatibility checks are finished. Small screenshots, state receipts and the test
log are retained under `build/proof/openmw-goty-20261018/` for that follow-up; disposable installer
copies, browser profiles and test accounts are removed.

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
histories; friends must select the same language. The full Vanilla+ stack remains unavailable.

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
