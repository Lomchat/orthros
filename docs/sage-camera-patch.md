# The farther camera of BFME II / RotWK / Age of the Ring and the Create-a-Hero camera

The manifests of BFME II, RotWK and Age of the Ring carry a `patches` entry (D112, `docs/game-manifest.schema.json`,
`src/win32/process.js` `applyPatches`) that multiplies every map's `cameraMaxHeight` by 1.5 when the map is loaded.
The owner asked for it so the camera can be pulled back farther in a match. It also has an effect nobody wanted: it
breaks the Create-a-Hero screens (*My Heroes* in RotWK, *My Captains* in Age of the Ring), because their camera is also
derived from the map's maximum height. This note records what was found (2026-11-10) and the second patch that undoes
the effect on those screens only.

## Symptoms (Age of the Ring crawl, `data/proof/aotr-crawl-2026-11-10/menus/`)

- The list's 3D preview (*Select hero*, *Appearance* tab) shows scenery only: an arch, a wall with banners, a tent with
  a tiny figure at the bottom, black above. The hero is that tiny figure, partly hidden by the buttons.
- The powers step's round portrait shows a black polygon (the camera sits inside or behind scene geometry) instead of
  the hero's bust.
- The class step (full screen) shows the hero cut off at the bottom of the screen instead of standing in the hall.

## It is not a rendering bug

A frame capture of the list (`capture` in a `--control` session) shows correct Direct3D state. The viewport is the
preview's rectangle (444,180 338x452). The projection matches its aspect: x scale 6.895 = y scale 5.156 x 452/338.
The skinned hero mesh is drawn, at (3324, 668, 40). The camera, though, is at (3324, 439, **90**): 229 units away and 50
above the ground. The same session without the D112 patch (a scratch `--games-dir` whose manifest has no `patches`)
shows the hero filling the preview, the class step's hero standing in the hall, and the portrait's bust. The
camera's height there is **60**.

## Why

- `game.dat` (RotWK 2.01, AotR) 0x5013a6 reads `cameraMaxHeight` from the map's WorldInfo into the view's camera
  limits (TheTacticalView at `ds:0xde447c`, the limits object at view+0x24c8, the maximum at +8). D112 patches the
  `fstp` there: the value is stored x1.5. The Create-a-Hero map (`maps/createahero/createahero.map`) has 300, so it
  becomes 450.
- The Create-a-Hero camera (0x9bfe74, one function for the list preview, the class/appearance steps and the
  portrait) reads the class's `ViewInfo` block from the INI (`Far/Near/CloseUp/Portrait` `Pitch`, `Zoom`, `Floor`,
  `Dist`, `Shift`; parse table at 0xd9ee00, `ViewInfo` at SubClass+0x6c). It builds a camera target
  (constructor 0x489b77) and moves TheTacticalView to it (vtable +0x60, 0x489c32). The target's zoom is the INI value
  (0.2). The view turns a zoom into a height as `zoom x maxHeight`: 0.2 x 450 = 90 instead of 0.2 x 300 = 60. Every
  INI camera of these screens is therefore 1.5 times too high and too far, and the narrow field of view these screens
  use (about 16 degrees horizontally) magnifies the error.
- Found with the harness: `watch:<view+0x30>,32` while selecting a hero showed the writers of the view's zoom fields.
  `ORTHROS_WATCH_STACK=24` (`--dbg`) adds 24 stack words to each writer, enough to reach the caller of the setter.

## The fix: a second manifest patch that divides the Create-a-Hero zoom by 1.5

At the camera target's construction, the zoom is loaded with `fld dword [ebp-0x1c]` (`d9 45 e4`), followed by
`mov [ebp-4], esi` (`89 75 fc`). These 6 bytes become a call to code that loads the zoom, divides it by 1.5 (built
with x87 instructions only, no constant, as in the D112 patch), and then runs the moved `mov`:

```
{ "module": "<module>", "rva": "<rva>", "from": "d945e48975fc",
  "call": "d945e4d9e8d9e8d8c0def9d9e8dec1def98975fcc3",
  "why": "Create-a-Hero camera: its zoom / 1.5 so the D112 x1.5 maxHeight leaves these screens as designed" }
```

`fld [ebp-0x1c]; fld1; fld1; fadd st0,st0; fdivp; fld1; faddp; fdivp; mov [ebp-4],esi; ret`: the stack goes z → 1,z
→ 1,1,z → 2,1,z → 0.5,z → 1,0.5,z → 1.5,z → z/1.5. The x87 stack is empty there, so at most 3 registers are used,
and no flags are live. A match's camera is unchanged: the map patch stays, and only the Create-a-Hero camera function
goes through this site.

| Executable (manifest version) | D112 patch rva | Create-a-Hero patch rva |
| --- | --- | --- |
| AotR `game.dat` (aotr-10, 10.0.2; md5 77f03434…) | 0x1013c6 | 0x5bfffb |
| RotWK 2.01 `game.dat` (rotwk-201) | 0x1013c6 | 0x5bfffb |
| RotWK 2.02 `lotrbfme2ep1.exe` (rotwk-202) | 0x1013c6 | 0x5bfffb |
| BFME II 1.09 `game.dat` (bfme2) | 0x1013c6 | 0x5bfffb |
| BFME II 1.06 `game.dat` (bfme2-106) | 0x101abe | 0x5b11a0 |

The 30-byte sequence starting with the replaced bytes
(`d945e48975fcd95c240cd945e0d95c2408f30f11442404d945dcd91c2450`) occurs exactly once in each of these executables.
The `from` check of `applyPatches` refuses another release.

Verified (Age of the Ring 10.0, headless Chromium, scratch manifest with both patches): the list preview frames the
hero as the unpatched game does, with the camera at height 60 (frame capture). The Gondor hall shows Berethor, the
class step shows the hero standing, and the powers portrait shows the bust. RotWK 2.02 with both patches: the
*My Heroes* list preview frames the hero (Fhaleen in his scene). RotWK and BFME II run the same camera code with the
same D112 patch, so their Create-a-Hero screens have the same defect until the second patch is in their manifests.
That was not checked in a browser. BFME II 1.06's site was found by its bytes but not run.

The manifests are outside Git (`data/games/*/manifest.json`), so this second patch has to be added there, next to
the D112 entry of each version.

## The black band at the top of the screen: the camera's far clip plane (2026-11-17)

### Symptom

At the farthest zoom of the D112 camera the terrain stops on a straight line short of the top of the screen, black
above it; trees, towers and hills behind that line still show their upper parts over the black, and the band stays at
the same height on the screen while the camera scrolls (the owner's video of 2026-11-17, Age of the Ring at 2560x1440,
`data/proof/aotr-owner-2026-11-17/`: about 10 % of the screen height). Reproduced in headless Chromium with the live
manifest (Age of the Ring 10.0.2, the scenarios' start on Harlindon, 1024x768, 30 notches of the wheel): the top
128 rows of 768 (16.7 %) are pure black, the clear color.

### What it is

Not the heightmap's 129-cell draw window (WorldHeightMap+0x120e8; nothing moves its origin in these executables, and
the nearest-chunks budget derived from it, 0x4e3614, is off: the terrain object is built with that flag at 0), not the
shroud (whole-map texture, gray where fogged) and not a missing chunk. A frame capture lists the terrain chunks drawn up
to y = 3860 (the camera at y = 1418, looking north), and a pixel probe (`dbg:ORTHROS_CAPTURE_PROBE=512,60/...`, then
`capture`: the pixel after every draw of the frame) shows that no draw of the frame ever writes the band's pixels. The
band starts where the view depth reaches 1800, and the camera's far plane was 1800:

- The tactical view's camera update (`game.dat` 0x48b7b1 in RotWK 2.01 / BFME II 1.09 / AotR, run at every camera
  change) calls `CameraClass::Set_Clip_Planes` (0x5337c0: near at camera+0xec, far at +0xf0) with
  `10, 1800 x multiplier` — `fld dword [eax+0x950]; fmul dword [1800.0]`, eax = TheGlobalData. The multiplier
  (GameData+0x950, 1.0 by default, no INI field) is set only by the script action `SET_CAMERA_CLIP_DEPTH_MULTIPLIER`
  (action 334), and takes effect at the camera's next move.
- The camera looks down 37.5 degrees, with a horizontal field of view of 50 degrees (camera dump: transform at
  camera+0x18, view plane at +0xd8). At the D112 farthest zoom it stands at z = 910 over ground at z = 100-150: the
  ground at the top edge of a 4:3 screen lies 2 290-2 440 units deep (16:9: 1 900-2 020; over ground at z = 0, 2 750
  and 2 270), beyond 1 800, so the far plane cuts the terrain across the top of the screen (computed edge: row 126-164
  of 768; seen: 128). Tall objects
  beyond the line show over it because their upper parts are nearer in view depth than the ground under them.
- Age of the Ring's skirmish maps (591 of its 657 maps) have a one-shot "Set up camera view" script that sets the
  multiplier to 10 (far 18 000); before it has run and the camera has moved (the first 25-35 s of a SwiftShader
  session), and on its maps without it (its campaign maps, *map mp jatikko*), the far plane is 1 800. The maps of
  RotWK's and BFME II's `Maps.big` use the action only in cinematics, the shell maps and Create-a-Hero, not in a
  skirmish map. Measured in one AotR session: same position and height (910), far 1 800 -> band of 128 rows; once the
  map script had run, far 18 000 -> no band.
- BFME 1.08 (bfme1-108) ran its skirmish with the multiplier at 10 (GameData+0xa28, far 18 000): the black seen at its
  farthest zoom at the start position is the map's own north and west edges (it moves off the screen when the camera
  scrolls south), not this cut.

Without the D112 patch (a scratch `--games-dir` whose manifest has no `patches`), the game's own farthest zoom shows no
band at the same start (camera far 1 800, the screen filled to the top).

### The fix: a third manifest patch that pulls the far plane back by the same 1.5

The 12 bytes `fld dword [eax+0x950]; fmul dword [<1800.0>]` become a call to code that runs them and multiplies the
result by 1.5 (`fld st0; fld1; fadd st0,st0; fdivp; faddp`, as the D112 patch: x87 only, no constant; the x87 stack is
empty there, 3 registers at most). Every distance of the view scales with the camera's height at the same pitch and
field of view, so the far plane times 1.5 keeps the margin the game was designed with at its own maximum height. The
replaced bytes include the constant's absolute address, so `from` refuses another release or a relocated module.

```
{ "module": "<module>", "rva": "<rva>", "from": "<12 bytes>", "call": "<12 bytes>d9c0d9e8d8c0def9dec1c3",
  "why": "far clip plane x1.5 with the D112 x1.5 camera height" }
```

| Executable (manifest version) | rva | `from` (`fld [eax+N]; fmul [1800.0]`) |
| --- | --- | --- |
| AotR `game.dat` (aotr-10; md5 77f03434…) | 0x8b816 | `d98050090000d80d30d7bd00` |
| RotWK 2.01 `game.dat` (rotwk-201; daed3668…) | 0x8b816 | `d98050090000d80d30d7bd00` |
| RotWK 2.02 `lotrbfme2ep1.exe` (rotwk-202; 7a4068f8…) | 0x8b816 | `d98050090000d80d30d7bd00` |
| BFME II 1.09 `game.dat` (bfme2; bb8df929…) | 0x8b816 | `d98050090000d80d30d7bd00` |
| BFME II 1.06 `game.dat` (bfme2-106; 34391b25…) | 0x8bed0 | `d98050090000d80d0878bc00` |
| BFME `lotrbfme.exe` (bfme1 defaults; 34af1cde…) | 0x742422 | `d980280a0000d80d34171201` |

BFME reads its multiplier at GameData+0xa28 and passes the near plane as an immediate (`push 10.0`) but is otherwise
the same code. The 30 bytes from each site occur once in their executable; the constant 1800.0 is read nowhere else.

### Checked, and what it costs

Headless Chromium (SwiftShader), 1024x768, the scenarios' Harlindon start (`learn-aotr-skirmish`'s steps, then 30
wheel notches out, 12 s at the farthest zoom), a camera dump at each capture:

| Age of the Ring 10.0.2 | camera far | black rows at the top | draws per frame | render ms per frame | fps |
| --- | --- | --- | --- | --- | --- |
| no patch (the game's own farthest zoom) | 1 800 | 0 | ~1 370 | 180 | 4.5 |
| D112 as live | 1 800 | 128 of 768 | ~1 090 | 148 | 5.9 |
| D112 + this patch | 2 700 | 0 | ~3 990 | 396 | 2.2 |
| D112 as live, after the map's script (same place, same height) | 18 000 | 0 | ~3 930 | — | 2.8 |

RotWK 2.02 (rotwk-202, `rotwk-skirmish`'s steps, the same zoom-out): far 1 800 -> 179 black rows of 768 at the start
position (284 draws per frame); with this patch far 2 700 (found in guest memory next to the near plane), the cut is
gone and about 340 draws per frame (+20 %). What stays black there is beyond the map's north edge, which the D112
camera reaches from that start: it leaves the screen when the camera scrolls south.

The cost is the part of the map the farther camera shows beyond 1 800 — on the AotR start the forests and props north of
the base, far more draws than the ground they stand on —, and it is what the game draws by itself once its "Set up
camera view" script has run (last row). On Age of the Ring's skirmish maps the patch therefore changes only the first
seconds of a match and the maps without that script; on RotWK and BFME II, whose skirmish maps keep the multiplier at
1, it is the price of seeing the whole screen at the D112 zoom.
