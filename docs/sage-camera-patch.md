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
| AotR `game.dat` (aotr-10; md5 5213811d…) | 0x1013c6 | 0x5bfffb |
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
