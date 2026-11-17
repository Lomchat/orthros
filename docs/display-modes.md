# Display modes

One list answers every API that enumerates display modes, `src/win32/display-modes.js` (`displayModes(display)`):

- `EnumDisplaySettings[Ex]` (user32), DirectDraw `EnumDisplayModes`, `IDirect3D8::GetAdapterModeCount/EnumAdapterModes`
  and `IDirect3D9` (same core as D3D8) all build their lists from it. Before 2026-11-10 each had its own table
  (user32 offered seven 16/32-bit modes, D3D8/DirectDraw an 18-mode table up to 2560x1440 regardless of the screen).
- The list is what a Windows PC with a normal monitor reports: the common 4:3, 5:4, 16:10 and 16:9 modes
  (640x480 ... 3840x2160), capped by the **player's screen in physical pixels** (`screen.width * devicePixelRatio`,
  sent by the page in the worker's `start` message, `host.display.screenSize`), ascending.
- It always contains the mode in use (`display.width/height`, changed by `ChangeDisplaySettings` or a fullscreen
  device) and the game's own display from the manifest (`display.nominal`), even when they are not common modes
  or exceed the screen: a game's options list can then show its current value.
- `GetSystemMetrics(SM_CXSCREEN)`, `GetAdapterDisplayMode` and the DEVMODE of `ENUM_CURRENT_SETTINGS` answer the mode in use.
- Choosing another mode (`ChangeDisplaySettings`, or `Reset`/`CreateDevice` with other back buffer sizes) goes through
  `WindowManager.setDisplayMode` -> `BrowserDisplay.setMode` -> a `mode` message: the page resizes its canvases and
  rescales the frame (`resizeTo`/`fit` in `src/web/main.js`).
- Without a known screen (Node harness), modes up to 1920x1200 are listed.

A game may still filter the list it shows (the game's own logic, e.g. only some aspect ratios).

## The largest mode: a new player's resolution (2026-11-17)

`largestMode(display)` is the mode of that list with the most pixels (the wider one on a tie): the highest resolution
a game's options offer the player. A manifest's `newProfileIni` (src/vfs/profile-ini.js, docs/profiles.md "A new
player's settings") may name it as `{modeWidth}` / `{modeHeight}` — BFME, BFME II, RotWK and Age of the Ring set
`Resolution` in `Options.ini` with it. The page computes it (`main.js`, from the manifest's display and the screen) and
gives it to the worker as `opts.displayMode` and to the snapshot key (docs/snapshot.md "Per display mode"); `?screen=WxH`
replaces the browser's screen (a publishing session's, the harness's `--screen`). A headless page without `?screen=`
leaves such settings out: the harness's scenarios keep the resolution they were written for.

The page keeps the game's frame at its mode's size (`#frame { flex: none }`) and scales it to the window (`fit`). Before
2026-11-17 a mode wider than the window (CSS pixels: a 1920x1080 mode on a laptop at 125 % is 1536 CSS pixels wide) let
the stage's flex layout shrink the frame's box: the scaled picture sat off-centre, shifted right by s·(w − W)/2 and its
right edge cut (seen at 2560x1440 in a 1280-pixel window: the left half of the picture only). The pointer was right (it
reads the canvas's own rectangle).

## A mode the player chooses: kept once the game confirms it (2026-11-17)

Changing the resolution in a game's options is the game's business: it writes its own settings. The SAGE games (BFME,
BFME II, RotWK, Age of the Ring) save it only when the player answers Yes to "keep the current display mode?", a
dialog whose 10 s ran out in Orthros while the menus were rebuilt at the new mode (30 s headless, 24-41 s on the
owner's laptop): the mode was reverted, or played but never saved. A manifest patch per version gives it 127 s
(`patches`, installed in the manifests together with this page): docs/sage-display-mode-confirm.md.
