# The frame around every game

Every game page of Orthros — the Windows games' (`src/host/web/index.html`, `main.js`), the GoldSrc ports'
(`src/ports/goldsrc/`), the re3 ports' (`src/ports/re3/`) and the OpenMW ports' (`src/ports/openmw/`) — has the same
frame, built by
`src/host/web/shell.js` (styles: `src/host/web/player.css`). A page gives it the game's title, version, language,
cover, the steps of its start and its own indicators; it never names a game.

## The header (always shown, hidden in full screen only)

From left to right:

| Part | What it says | Windows games | GoldSrc | re3 | OpenMW |
|---|---|---|---|---|---|
| Orthros, game, version · language | which installation runs | ✓ | ✓ | ✓ | ✓ |
| game data | the loading in the background (the learned order, the whole game: `shell.setData`); over the page while the game waits for its data, `data-meter.js` | background preload (its own) | ✓ | ✓ | ✓ |
| runtime indicators | the runtime's own | players of the game's LAN | online games (the lobby) | — | — |
| mouse | **captured** by the game (pointer lock) or **free**; a click gives it to the game | ✓ | ✓ | ✓ | ✓ (told by `frame-meter.js` in the engine's page) |
| saves | where the progress goes: not saved (no account: a warning), saving, saved at hh:mm, not sent, conflict, too large, saved by the world (OpenMW multiplayer) | ✓ | ✓ | ✓ | ✓ |
| frame rate | fps, p99 and the slowest frame, the last minute's graph | ✓ (+ details panel) | ✓ | ✓ (`Module.orthrosFrame`) | ✓ (`frame-meter.js`) |
| settings | the data window (`data-manager.js`): online saves and account; launch options and this browser's storage — the Windows games' OPFS folders and the ports' IndexedDB databases, exported or cleaned — on the Windows games' page | ✓ | ✓ | ✓ | ✓ |
| full screen, games | full screen (mouse captured, Esc held to leave); back to the list, asked first while a game runs, the progress saved first | ✓ | ✓ | ✓ | ✓ |

Narrow windows keep the indicators' icons; their words go (their titles still say them).

**Escape and the mouse** (`src/host/web/escape.js`, every runtime; the owner's rule, 2026-10-20): the first Escape goes
to the game, the next one frees the mouse — a game's own Escape (its menu, closing a window) must not cost the mouse. In
full screen the keyboard is locked, so the page decides: the first press passes to the game with the mouse still
captured, the next is kept from the game and frees it (a press with the mouse free goes to the game; holding Escape
leaves full screen as before). Out of full screen Chrome frees the mouse at the first press and keeps the key from the
page — no page can change that (checked with real key presses, Chrome 153: no keydown reaches the page, and capturing
again needs a click): the game is sent that Escape all the same (a synthesized press and release), a click captures the
mouse again. Nothing is sent when the page or the game freed the mouse itself, the window lost the focus, the tab was
left or full screen was left. `tools/escape-check.mjs` replays these cases with real key presses (xdotool, a headed
Chrome under Xvfb).

## The loading screen

The game's cover blurred behind, then in one box: the game, **who plays** (the Orthros account, or a warning that
nothing will be saved on an account with sign-in / create-account buttons), the runtime's choices (GoldSrc: the online
games; OpenMW: the game's language, solo or with friends, the engine's licence), the steps of the start with their
figures, a tip, the launch log. Windows, GoldSrc and re3 games start at once; OpenMW waits for solo / with friends.
When an re3 game ends (quit from its own menu), the loading screen comes back: "The game has ended", restart or back
to the games.

## One identity: the Orthros account

- **Saves** (`src/host/web/cloud-sync.js`, `CloudSave`): before a game starts, the account's copy is put in place when
  it is newer; while the game runs, the profile is sent after it changed (Windows: 45 s after the worker wrote it;
  GoldSrc and re3: every minute when changed; OpenMW: after each engine sync, `cloud.js`); when leaving by « Games », sent
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
- **Signing in with Google** (when the server has a Google client — `google.json` beside the accounts' database, README):
  « Continue with Google » on the loading screen and in the account window opens a small window; the page keeps running
  and hears the outcome over a `BroadcastChannel` of the origin (the window's opener is cut off by the pages'
  cross-origin isolation), then the window closes (blocked window: the whole page goes and comes back). A new player
  chooses a username there — or gives an existing account's password to link Google to it. The Orthros account stays
  the identity: Google is a way into it (`identities` table), linked or unlinked in the account window; an account
  made with Google has no password until one is set (it is then unlinkable), and is deleted with its name typed again.
  All server side (`src/host/google-signin.js`: OpenID Connect code flow with PKCE, the flow bound to its browser by a
  cookie, the ID token checked — issuer, audience, expiry, nonce — as it comes straight from Google over TLS); no Google
  script in the pages.

## Languages

Pages in English or French (`lang.js`: the visitor's choice on the home screen, else the browser's). The game's own
language is chosen on its home card among the version's (`languages`), shown in the header's tag:
Windows games through their registry (`languageRegistryKey`, also on a required game's key — an expansion and its
base game speak the same language; a translation patch's own files, `languageFiles`, hidden in the other languages as
its launcher would not install them; files read under another name, `languageFileAliases`), OpenMW through its language versions, GoldSrc through
`goldsrc.languages.<code>` (`args`, `commands`, `extras` of the engine release, `overlays`: the language's folders over
the game's — docs/browser-ports.md, "Languages"), re3 through `re3.languages.<code>` (`env`: the engine's environment;
`ini`: settings in the profile's ini files — docs/browser-ports.md, "re3 ports").
OpenMW's own engine interface (its loading screen, multiplayer tour, social panel, chat, messages, the character
choice) follows the Orthros page's language: `src/ports/openmw/ui-l10n.js`, put into the engine's pages with
`frame-meter.js`, replaces the engine's known English phrases (exact phrase, or a phrase's start when it ends with a
name), never a script or the game.

Harness runs: `tools/headless.mjs --account <name>:<password>` signs the page in first (created if needed); without
`--ui` the page then uses the account's saves too (`?cloud=1`): restored before the game, sent while it runs.
