# The frame around every game

Every game page of Orthros — the Windows games' (`src/host/web/index.html`, `main.js`), the GoldSrc ports'
(`src/ports/goldsrc/`) and the OpenMW ports' (`src/ports/openmw/`) — has the same frame, built by
`src/host/web/shell.js` (styles: `src/host/web/player.css`). A page gives it the game's title, version, language,
cover, the steps of its start and its own indicators; it never names a game.

## The header (always shown, hidden in full screen only)

From left to right:

| Part | What it says | Windows games | GoldSrc | OpenMW |
|---|---|---|---|---|
| Orthros, game, version · language | which installation runs | ✓ | ✓ | ✓ |
| runtime indicators | the runtime's own | background preload, players of the game's LAN | online games (the lobby) | — |
| mouse | **captured** by the game (pointer lock) or **free**; a click gives it to the game | ✓ | ✓ | ✓ (told by `frame-meter.js` in the engine's page) |
| saves | where the progress goes: not saved (no account: a warning), saving, saved at hh:mm, not sent, conflict, too large, saved by the world (OpenMW multiplayer) | ✓ | ✓ | ✓ |
| frame rate | fps, p99 and the slowest frame, the last minute's graph | ✓ (+ details panel) | ✓ | ✓ (`frame-meter.js`) |
| settings | the data window (`data-manager.js`): online saves and account; launch options and this browser's storage — the Windows games' OPFS folders and the ports' IndexedDB databases, exported or cleaned — on the Windows games' page | ✓ | ✓ | ✓ |
| full screen, games | full screen (mouse captured, Esc held to leave); back to the list, asked first while a game runs, the progress saved first | ✓ | ✓ | ✓ |

Narrow windows keep the indicators' icons; their words go (their titles still say them).

## The loading screen

The game's cover blurred behind, then in one box: the game, **who plays** (the Orthros account, or a warning that
nothing will be saved on an account with sign-in / create-account buttons), the runtime's choices (GoldSrc: the online
games; OpenMW: the game's language, solo or with friends, the engine's licence), the steps of the start with their
figures, a tip, the launch log. Windows and GoldSrc games start at once; OpenMW waits for solo / with friends.

## One identity: the Orthros account

- **Saves** (`src/host/web/cloud-sync.js`, `CloudSave`): before a game starts, the account's copy is put in place when
  it is newer; while the game runs, the profile is sent after it changed (Windows: 45 s after the worker wrote it;
  GoldSrc: every minute when changed; OpenMW: after each engine sync, `cloud.js`); when leaving by « Games », sent
  first. What this browser knows of the account's copy: `localStorage orthros.sync.<user>.<game>` (`parent`: the
  account's hash last in step, `local`: the profile's content hash then). Both moved: a conflict, never settled
  silently — the player chooses the account's copy or this browser's (the other stays in the account's history,
  20 versions; over the account's 512 MB the oldest versions go first, never a game's latest). A browser profile last
  in step with another account is put aside, not sent. Signing in while a game runs: sent, or — when the account
  already has another copy — the player restarts with the account's or sends this browser's.
- **Multiplayer** is for signed-in players on a server with accounts: the Windows games' virtual LAN refuses others
  (`src/host/lan.js`) and names the emulated machine after the account (the games' default player name, `gethostname`);
  the GoldSrc relay and room creation refuse them (`src/host/goldsrc.js`), the player's name in the game is the
  account's; OpenMW's worlds already required it (`src/ports/openmw/account-bridge.js`).
- Without an account, games run and their progress stays in this browser; the home screen, the loading screen and
  the header say so.

## Languages

Pages in English or French (`lang.js`: the visitor's choice on the home screen, else the browser's). The game's own
language is chosen on its home card among the version's (`languages`), shown in the header's tag:
Windows games through their registry (`languageRegistryKey`, also on a required game's key — an expansion and its
base game speak the same language; a translation patch's own files, `languageFiles`, hidden in the other languages as
its launcher would not install them; files read under another name, `languageFileAliases`), OpenMW through its language versions, GoldSrc through
`goldsrc.languages.<code>` (`args`, `commands`, `extras` of the engine release, `overlays`: the language's folders over
the game's — docs/browser-ports.md, "Languages").
OpenMW's own engine interface (its loading screen, multiplayer tour, social panel, chat, messages, the character
choice) follows the Orthros page's language: `src/ports/openmw/ui-l10n.js`, put into the engine's pages with
`frame-meter.js`, replaces the engine's known English phrases (exact phrase, or a phrase's start when it ends with a
name), never a script or the game.

Harness runs: `tools/headless.mjs --account <name>:<password>` signs the page in first (created if needed); without
`--ui` the page then uses the account's saves too (`?cloud=1`): restored before the game, sent while it runs.
