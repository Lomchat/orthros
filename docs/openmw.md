# OpenMW browser port

The owner authorized an OpenMW port with faithful visual mods and multiplayer on 2026-10-15.
This extends the third-party engine exception of D069. It does not change the Win32 runtime.
The engine, its corresponding source and native simulation image are pinned by
`tools/openmw/lock.json` (OpenMW-Web v1.5.3). No third-party source is committed here.

## Current installation

- Browser engine and corresponding source installed in `data_engines/`; native multiplayer
  image pulled by digest. The source link remains visible on the port page.
- The freely licensed engine example has its own game card, `openmw-example-1.5.3`.
- Morrowind GOTY Vanilla+ has a separate manifest, `morrowind-goty-vanilla-plus-en`, and remains
  unavailable until its original game files **and every declared mod** are installed.
- Project Atlas was obtained from its authors' public repository, commit
  `68a838650fb177afb5e6a63c558dc4ae6bf29b56`, archive SHA-256
  `364c5896a4b181def2420e1b30f54043b3c0ef35812db24b53fe79f1aa1a92f5`.
  Installed parts: Core, MET textures, Glow in the Dahrk patch, Graphic Herbalism patch.
- Still required: the user's purchased Morrowind GOTY files, Patch for Purists, Morrowind
  Optimization Patch, Morrowind Enhanced Textures, Glow in the Dahrk, Graphic Herbalism and
  Familiar Faces. Nexus returned HTTP 403 to this server; these downloads are not installed.
- Multiplayer gameplay, NPC simulation, saves and compatibility of the complete mod stack
  cannot be validated without those files. The production gateway is deliberately not started.

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

Password servers have no self-service registration in the pinned upstream version. Create a
player through the local operator API, with the password supplied on stdin:

```sh
node tools/openmw/create-account.mjs morrowind-goty-vanilla-plus-en Alice --password-stdin
```

Finish stdin with EOF after entering the password, or redirect a private file. The first run
creates a random local operator credential in `build/openmw/<manifest>/operator.json` (0600).
Players have no administration role. The public proxy never forwards operator API requests.
Sign in on the port's multiplayer page, create a character, switch the world to Party and add
friends. Party visits advance the host's campaign. Multiplayer is experimental.

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

```sh
tools/with-browser-slot.sh node tools/openmw/check.mjs openmw-example-1.5.3 \
  --url https://orthros.chalco.website --seconds 3
```

This check is explicitly the free example, **not** a Morrowind multiplayer success claim.
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
