# The frame around every game

Every game page of Orthros — the Windows games' (`src/web/index.html`, `main.js`), the GoldSrc ports'
(`src/ports/goldsrc/`), the re3 ports' (`src/ports/re3/`) and the OpenMW ports' (`src/ports/openmw/`) — has the same
frame, built by
`src/web/shell.js` (styles: `src/web/player.css`). A page gives it the game's title, version, language,
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
| display problem | "Signaler un problème d'affichage": a 2-second recording of what the game draws and what the screen shows, sent once (below); Ctrl+Shift+F too | ✓ (with telemetry) | — | — | — |
| settings | the data window (`data-manager.js`): online saves and account; launch options and this browser's storage — the Windows games' OPFS folders and the ports' IndexedDB databases, exported or cleaned — on the Windows games' page | ✓ | ✓ | ✓ | ✓ |
| full screen, games | full screen (mouse captured, Esc held to leave); back to the list, asked first while a game runs, the progress saved first | ✓ | ✓ | ✓ | ✓ |

Narrow windows keep the indicators' icons; their words go (their titles still say them).

**Escape and the mouse** (`src/web/escape.js`, every runtime; the owner's rule, 2026-10-20): the first Escape goes
to the game, the next one frees the mouse — a game's own Escape (its menu, closing a window) must not cost the mouse. In
full screen the keyboard is locked, so the page decides: the first press passes to the game with the mouse still
captured, the next is kept from the game and frees it (a press with the mouse free goes to the game; holding Escape
leaves full screen as before). Out of full screen Chrome frees the mouse at the first press and keeps the key from the
page — no page can change that (checked with real key presses, Chrome 153: no keydown reaches the page, and capturing
again needs a click): the game is sent that Escape all the same (a synthesized press and release), a click captures the
mouse again. Nothing is sent when the page or the game freed the mouse itself, the window lost the focus, the tab was
left or full screen was left. `tools/check/escape-check.mjs` replays these cases with real key presses (xdotool, a headed
Chrome under Xvfb).

## The loading screen

The game's cover blurred behind, then in one box: the game, **who plays** (the Orthros account, or a warning that
nothing will be saved on an account with sign-in / create-account buttons), the runtime's choices (GoldSrc: the online
games; OpenMW: the game's language, solo or with friends, the engine's licence), the steps of the start with their
figures, a tip, the launch log. Windows, GoldSrc and re3 games start at once; OpenMW waits for solo / with friends.
When an re3 game ends (quit from its own menu), the loading screen comes back: "The game has ended", restart or back
to the games.

**Ready signal** (shell.js, every runtime): a first launch can take minutes on a slow link, and the player goes to
another tab. When the game reaches its first images (`shell.hideLoader()` without `now`: the Win32 page at Direct3D's
first frame, a few GDI frames or a movie's first picture; GoldSrc/re3 at their 10th image; OpenMW when the world is
drawn) while the tab is hidden, the tab's title gets a prefix (`▶ Prêt — <game> · Orthros`) until the tab is shown
again, and a system notification says it when the player allowed notifications for the site. The permission is asked
only from the loading screen's link "Me prévenir quand le jeu est prêt" (shown while the browser has no answer for the
site), never automatically. `shell.ready` = `{ hidden, notified }`; the Win32 page sends it as a `ready` telemetry event
with the seconds from the loading screen to the first images.

## Report a display problem (Windows games, 2026-11-18)

The header's screen icon ("Signaler un problème d'affichage" / "Report a display problem") and **Ctrl+Shift+F** — the
header is hidden in full screen; the keys are kept from the game, key up included — record 2 seconds of the display
and send them once, as one telemetry record (shown only when the server keeps telemetry; one report per session a
minute, on the page and on the server). Nothing is drawn over the game while it records (an overlay changes how the
page is composited: the button pulses instead), then a passing message says it is sent: "Merci, envoyé".
What it records (`src/shared/display-report.js`), at the same time:
- **the back buffers** (`src/gfx/frame-report.js`, in the renderer — the render worker, or the emulator's worker with
  `?glworker=0`): every presented back buffer downscaled on the GPU (halving blits, then ≤ 320x180, read back through
  pixel buffers and fences: no stall), its device frame, present time, the framebuffer blitted to the canvas, the
  back-buffer surface, the gamma pass, the frame's command signature and its values record (`vsig`: a hash of the color
  values the draws read — TEXTUREFACTOR, material, ambient, alpha reference, fog —, `tf`: the draws whose
  TEXTUREFACTOR changed since the previous frame; `d3d8-webgl.js` valDraw: under one command signature, a picture that
  changes with the values is the game's, one that changes without them is GL's). The page asks for it through the worker debug
  global `ORTHROS_FLICKER_REPORT=<id>` (the worker's `dbg` message, forwarded to the render worker): `src/web/worker.js`,
  a snapshot source, is unchanged;
- **the screen** (`src/web/screen-report.js`, in the page): at every requestAnimationFrame, the visible game canvases
  drawn bottom to top into a small atlas (no readback until the end), with each canvas's size, box, z-index,
  visibility, display, opacity and the frame's transform (which canvas is visible, which is on top); the bitmaps the
  page received (layer, size, device frame when the render worker names it) and its events (resize, visibility, focus,
  full screen, pointer lock, overlays). What a canvas holds is what the page gives the compositor: a fault past that
  (the compositor, the display) is not in the record.
Each strip keeps each distinct picture once and is cut to 480 KB (JPEG quality, then half size, then its last
pictures); both are analysed (change per frame, still A-B-A, A-B-B-A). `node tools/dev/flicker-report.mjs
<telemetry .jsonl> [--session <id>] --out <dir>` writes the two filmstrips as contact sheets, aligns them (with the
render worker by the device frame each bitmap carries, else by the pictures and their times: which back buffer each
screen picture shows; a screen picture no back buffer had, or one closer to an older back buffer, is marked) and prints
the figures. The renderer's window starts when the emulator's thread passes the request on (late when it is busy): the
page records until that window's end too. `window.orthros.reportDisplay()` does the same from the console or a harness.
`tools/with-browser-slot.sh node tools/check/display-report-check.mjs` checks both halves and the tool without a game
(a square drawn every other frame, a red picture and a stale one shown on purpose: both must be found, and nothing else).
Its automatic companion, without any click: the **draw probe** (`src/gfx/draw-probe.js`, docs/aotr-play.md "The draw
probe"): on a still screen that stays, or a flicker under the same commands, a few seconds of what each of the frame's
last draws did to the picture and the values it was drawn with, sent once per session (`tools/dev/draw-probe.mjs`).

## Another window: the game keeps playing (Windows games, 2026-11-17)

The page losing the focus (another window, another tab) is not an event of the game's desktop: like a virtual machine's
window, the Win32 page (`main.js`) only releases what it holds — a key up for each key down, a button up for each
button down — and the game stays the active application: no `WM_ACTIVATEAPP 0`, no lost fullscreen device, no Reset on
the way back (the owner's "application deactivated: device lost" at each window switch, AotR 2026-11-17, and a switch
back to a mode that failed on that lost device: docs/sage-display-mode-confirm.md). The "paused" banner is not shown.
The game keeps running and rendering in the background (the worker and its OffscreenCanvas are not throttled with
the page). `?bg=pause`, or `localStorage['orthros.bg'] = 'pause'`, restores the former behaviour, the
game deactivated on blur (D052) — the harness's `--bg pause`; the emulator's deactivation path is unchanged.

### At full speed in a hidden tab (every runtime, 2026-11-18)

Running is not enough: Chrome lowers the priority of a renderer process whose pages are all hidden — every thread of
it, the emulator's worker and the render worker included (Windows: a lower priority class and EcoQoS, slower cores at
a low clock). The owner's sessions (2026-11-08..18, RTX 4050 laptop, Chrome 157): the tab hidden and silent ran the
guest 2.5-4 times slower at once — AotR's boot 1 600-1 900 MIPS visible, 200-750 hidden, the worker busy all the time
(a boot of 55-73 s visible, 132 s mostly hidden); RotWK in play, the same scene, 16 → 60 ms of guest work a frame
(28 → 14 fps) — and at full speed while hidden with the game's own music playing. Chrome keeps a process in the
foreground when one of its frames is *audible*: an output stream at or over -72.25 dBFS (services/audio/output_stream.cc,
measured 15 times a second; content/browser/media/audio_stream_monitor.cc `kPlayingAudibleAudioStream`).

`src/web/background-play.js` (created by the shell for every runtime; each page says when its game works — `working`:
the Windows games while they load and run, the browser ports during their load only, their engines stopping with the
page's animation frames) plays, while the page is hidden and the game works, a constant offset of 1/512 (-54 dBFS) on
an AudioContext of its own, faded in and out over 0.5 s and suspended while the page is visible: a constant moves a
loudspeaker's cone by 0.2 % of its travel and keeps it there, nothing is heard; Chrome shows the tab as playing sound.
Checked in Chromium here, without automation attached to the page (`tools/with-browser-slot.sh xvfb-run -a node
tools/check/hidden-tab/check.mjs`: Chromium started directly, a tiny extension hides the tab and reads Chrome's own
`audible`): hidden and silent, the page's renderer goes to nice 5 (Linux's form of the lowered priority) and the tab is
not audible; with the offset Chrome calls the tab audible and the renderer comes back to nice 0 within a second
(2026-11-18, Chromium of Playwright 1.63); a constant of -68 dBFS and over is audible, -74 and -80 are not. Its cost:
the browser's processes on an idle hidden page 1.5 → 2.5 % of one core (8 s, one run each). Not reproducible here: Windows' slower cores — the owner's next sessions
say it (below). Playwright starts Chromium with `--disable-renderer-backgrounding` (and no occluded-window or timer
backgrounding): the harness and the benches never see this slowdown.

Not when the player pauses the game in the background (`?bg=pause`), nor with `?awake=0` / `localStorage['orthros.awake']
= '0'` (the A/B of this mitigation), and not past 30 minutes hidden in one go: an audible tab keeps Windows from going to
sleep, a game forgotten in a hidden tab must not keep the computer awake for ever. The telemetry says when it was on:
the Windows games' samples carry `aw` while hidden (1 kept in the foreground, 0 not), their summaries `awake` ({ hid, on,
st } seconds of the window), the passive records of every runtime `aw` (seconds hidden and kept); `node
tools/dev/telemetry-report.mjs` prints per session the MIPS while the worker is busy and the work a frame in play,
visible / hidden kept awake / hidden.

## One identity: the Orthros account

- **Saves** (`src/web/cloud-sync.js`, `CloudSave`): before a game starts, the account's copy is put in place when
  it is newer; while the game runs, the profile is sent after it changed (Windows: 45 s after the worker wrote it;
  GoldSrc and re3: every minute when changed; OpenMW: after each engine sync, `cloud.js`); when leaving by « Games », sent
  first. What this browser knows of the account's copy: `localStorage orthros.sync.<user>.<game>` (`parent`: the
  account's hash last in step, `local`: the profile's content hash then). Both moved: a conflict, never settled
  silently — the player chooses the account's copy or this browser's (the other stays in the account's history,
  20 versions; over the account's 512 MB the oldest versions go first, never a game's latest). A browser profile last
  in step with another account is put aside, not sent. Signing in while a game runs: sent, or — when the account
  already has another copy — the player restarts with the account's or sends this browser's.
- **Multiplayer** is for signed-in players on a server with accounts: the Windows games' virtual LAN refuses others
  (`src/server/lan.js`) and names the emulated machine after the account (the games' default player name, `gethostname`);
  the GoldSrc relay and room creation refuse them (`src/server/ports/goldsrc.js`), the player's name in the game is the
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
  All server side (`src/server/google-signin.js`: OpenID Connect code flow with PKCE, the flow bound to its browser by a
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
