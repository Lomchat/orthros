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
