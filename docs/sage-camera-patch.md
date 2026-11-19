# The farther camera of BFME II / RotWK / Age of the Ring and the Create-a-Hero camera

The manifests of BFME II, RotWK and Age of the Ring carry a `patches` entry (D112, `docs/game-manifest.schema.json`,
`src/win32/process.js` `applyPatches`) that multiplies every map's `cameraMaxHeight` by 1.5 when the map is loaded.
The owner asked for it so the camera can be pulled back farther in a match. It also has an effect nobody wanted: it
breaks the Create-a-Hero screens (*My Heroes* in RotWK, *My Captains* in Age of the Ring), because their camera is also
derived from the map's maximum height. This note records what was found (2026-11-10) and the second patch that undoes
the effect on those screens only; the sections after it, the two other limits the farther camera ran into: the far
clip plane (2026-11-17) and the shadow map's depth (2026-11-19).

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

## Shadows missing at the top of the screen: the shadow map's depth (2026-11-19)

### Symptom

With shadow maps on (StaticGameLOD High and up: docs/aotr-play.md "Shadows at StaticGameLOD High") and the camera near
the farthest D112 zoom, objects near the top edge of the screen have no shadow. A building that scrolls up past a line
loses its shadow, cut straight along that line, and gets it back when it scrolls down again; objects lower on the screen
keep theirs (the owner's video of 2026-11-19, Age of the Ring in 16:9: the line about 10 % down the screen). Reproduced
in headless Chromium (Age of the Ring 10.0.2, the Harlindon start, 1024x768): the ground of rows 0-132 of 768 lies
outside the shadow map, and a side triangle down to row 323 as well (21 % of the screen); the start's fortress, scrolled
up across row 133, has its shadow cut there. RotWK 2.02 at 800x600: rows 0-134 of 600.

### What it is

Not a rendering bug. The frame capture shows the game's own state rendered as asked: the shadow map is an R32F
1024x1024 target (viewport 0,0,1024,1024, cleared to 1.0), its sampler in `terrain.fxo` is CLAMP / POINT (Orthros
renders CLAMP exactly; the BORDER and MIRRORONCE it approaches with CLAMP are not used here), and the receivers' matrix
is the light's view-projection with the texture bias. Ground outside the map reads its clamped edge, 1.0: lit. The
region the map covers is the game's choice:

- `game.dat` 0x47c276 (RotWK 2.01 / 2.02, BFME II 1.09, AotR; run after every camera update: 0x48ba87 -> 0x47d37d, and
  when the light turns) fits an orthographic box, in a light space of fixed orientation, around the view frustum from
  the near plane to the depth `min(far, MaxViewDistance)` (0x47c63d: `movss xmm0,[ebp-0x4c]; comiss
  xmm0,[0xd99530]; ...`), its lower edges cut by a ground plane. That box is the 1024 x 1024 texels.
- MaxViewDistance is the INI `ShadowMap` block's (`MapSize`, `MaxViewDistance`, `MinShadowedTerrainHeight`: parse
  table 0xbdcac8, values at 0xd9952c-0xd99534, defaults 1024, 1000.0, 0.0); `data/ini/environment.ini` sets 1500.0
  in Age of the Ring, RotWK and BFME II, and a map's `map.ini` may set its own. Nothing else enters: not the camera's
  height, not the far plane once it passes 1 500 (the far-plane patch above changes nothing here), not the map's
  `cameraMaxHeight`.
- The camera looks down 37.5 degrees: the ground at the top edge of the screen lies at a view depth of about 2.5 times
  the camera's height over it in 16:9, 3 times in 4:3. At the game's own farthest zoom (540 over the ground at the
  Harlindon start) that is 1 348 in 16:9, inside 1 500 (in 4:3, 1 630: the game itself leaves the top 20-22 rows of 768
  unshadowed there). D112's camera, 810 over the ground, puts it at 2 022 (16:9) and 2 444 (4:3): the top of the screen
  falls outside the map. Casters there are culled from the shadow pass by the box's planes, receivers there read the
  lit edge, and a caster across the edge has its shadow cut along it.

### The fix: a fourth patch, the depth grows with the camera beyond the map's own maximum height

The 27 bytes from `movss xmm0,[ebp-0x4c]` to `fld dword [eax]` (the min and the following `mov ecx,[edi+4]`, moved
into the code) become a call to code that computes

`used = min(far, MaxViewDistance x max(1, 1.5 x h / hmax))`

with h the view's current height over the ground (TheTacticalView+0x50, the value its camera is built from; NaN for the
first frames of a match, which makes the factor 1) and hmax the map's maximum height as the D112 patch stored it
(x 1.5; the camera limits at TheTacticalView+0x24c8, maximum at +8). Up to the map's own maximum height
(h <= hmax / 1.5) the factor is 1: the game's region exactly, at every zoom it allowed before D112. Above, the depth
grows with the height; at the D112 farthest zoom it is 1.5 x MaxViewDistance (2 250). The camera's height, the view
depths and the light box then are the game's own design at its own farthest zoom, scaled by 1.5: the same part of the
screen covered, and shadow texels as large on the screen as there.

```
mov ecx,[edi+4]                ; (moved)
fld dword [MaxViewDistance]
mov eax,[TheTacticalView]
test eax,eax
jz cap
fld dword [eax+0x50]           ; h
fdiv dword [eax+0x24d0]        ; h / hmax
fld st0; fld1; fadd st0,st0; fdivp; faddp   ; r -> 1.5 r (x87 only, no constant, as the D112 patch)
fld1; fxch st1
fcomi st0,st1
fcmovbe st0,st1                ; max(1.5 r, 1); NaN -> 1
fstp st1
fmulp                          ; MaxViewDistance x factor
cap:
fld dword [ebp-0x4c]           ; far
fcomi st0,st1
fcmovnb st0,st1                ; min(far, depth); a NaN far stays far, as the original's comiss/ja
fstp st1
ret
```

The x87 stack is empty there (the call just before, `Get_Clip_Planes` 0x5337f0, moves integers only; the replaced code
leaves one value, which the `fstp` after it stores), the code uses 4 registers at most and leaves the result in st0
where `fld [eax]` left it. eax, xmm0 and the flags the original left are dead: the next reads write them first
(`Set_Clip_Planes` 0x5337c0 loads xmm0 from its arguments, 0x533b70 loads eax, the function then reloads both). No jump
enters the replaced bytes except their own `ja`.

```
{ "module": "<module>", "rva": "<rva>",
  "from": "f30f1045b40f2f05<MVD>b8<MVD>77038d45b48b4f04d900",
  "call": "8b4f04d905<MVD>a1<VIEW>85c0741fd94050d8b0d0240000d9c0d9e8d8c0def9dec1d9e8d9c9dbf1dad1ddd9dec9d945b4dbf1dbc1ddd9c3",
  "why": "ombres : la profondeur couverte par la carte d'ombres ... (docs/sage-camera-patch.md)" }
```

| Executable (manifest version) | rva | MaxViewDistance (`<MVD>`) | TheTacticalView pointer (`<VIEW>`) |
| --- | --- | --- | --- |
| AotR `game.dat` (aotr-10; md5 77f03434…) | 0x7c63d | 0xd99530 (`3095d900`) | 0xde447c (`7c44de00`) |
| RotWK 2.01 `game.dat` (rotwk-201; daed3668…) | 0x7c63d | 0xd99530 | 0xde447c |
| RotWK 2.02 `lotrbfme2ep1.exe` (rotwk-202; 7a4068f8…) | 0x7c63d | 0xd99530 | 0xde447c |
| BFME II 1.09 `game.dat` (bfme2; bb8df929…) | 0x7c63d | 0xd99530 | 0xde447c |
| BFME II 1.06 `game.dat` (bfme2-106; 34391b25…) | 0x7cc75 | 0xdb4480 (`8044db00`) | 0xdfea3c (`3ceadf00`) |

The 27 bytes of `from` (with MaxViewDistance's address twice) occur once in each executable. In the first four, the
shadow function, the view's constructor and vtable (0xbdd490: +0x150 returns +0x50), the camera update, D112's limits
setter and the code that stores TheTacticalView (0x69ef6b) are byte for byte the same; in 1.06 the shadow function
(0x47c8ae) differs only by relocated addresses, the view has the same layout (vtable 0xbc7568, the same getter, limits
at +0x24c8) and TheTacticalView is stored at 0x69e516. BFME (`lotrbfme.exe`) has no shadow maps (no `ShadowMap` block,
no `_CreateShadowMap`): nothing to patch there. As the others, the entry goes in the manifests outside Git
(`data/games/*/manifest.json`), after each version's far-plane patch.

### Checked, and what it costs

In Node (no rendering; a preload reading guest memory where the code passes the depth to `Set_Clip_Planes`, 0x47c668),
Age of the Ring 10.0.2 from a new StaticGameLOD High profile, the Harlindon start, the wheel out, in over the whole
range and out again (422 updates of the region): the depth is 1 500 at every height up to 540 over the ground, and the
light box is then the one the unpatched game computes at that height (942 x 1 416 units at 501, 926 x 1 416 at 376);
above, 1 500 x 1.5 h / 810 (2 005 at 722, 2 169 at 781); 2 250 at the farthest zoom (810), the box 1 407 x 2 125
instead of 980 x 1 416. In the first frames of the match, the height still NaN: 1 500. BFME II 1.06 (bfme2-106, its
own addresses; `bfme2-skirmish`'s steps, the wheel out and in): the skirmish map's maximum 300 is stored 450, the depth
is 1 500 up to 300 over the ground, 2 110 at 422, 2 250 at 450; on the 3D main menu's shell map (camera 40 over the
ground, stored maximum 300) 1 500. Both runs went on to the end of their scenario.

The coverage this gives, from the measured rule (the map's far edges at the top corners of the frustum at the depth
used; Harlindon's sun), in rows of 768 left wholly unshadowed at the top:

| height over the ground | 4:3 before | 4:3 after | 16:9 before | 16:9 after |
| --- | --- | --- | --- | --- |
| 540 (the game's own farthest) | 22 | 22 | 0 | 0 |
| 700 | 93 | 22 | 56 | 0 |
| 810 (D112 farthest) | 133 (21 % of the screen) | 22 (2.9 %) | 108 (16.7 %) | 0 |

At every height beyond the map's own maximum the screen is covered as the game covered it at that maximum: fully in
16:9, in 4:3 all but the 22 rows the game itself leaves (at the D112 farthest zoom a depth of about 2 450 would cover
them too, for texels 9 % larger still; not done: that band is the game's own design).

Headless Chromium (SwiftShader, 1024x768, through the browser slots), the same steps in each run: the Harlindon start
at the farthest zoom (20 s measured), 18 notches in (about 376 over the ground, 20 s measured), the farthest zoom again
and the camera scrolled south in steps of one second of the down arrow, a screenshot after each (the screenshots and
before/after crops are in `data/proof/sage-shadow-depth-2026-11-19/fix/`; the independent check's in `verify/`, the
two frames of the owner's video in `owner-video/`):

| Age of the Ring 10.0.2, Harlindon start | draws per frame | fps | render ms per frame |
| --- | --- | --- | --- |
| farthest zoom, live manifest | 1 180 | 3.4 | 249 |
| farthest zoom, + this patch (two runs) | 1 355 / 1 346 | 3.4 / 3.1 | 272 / 305 |
| mid zoom, live manifest | 392 | 6.0 | 113 |
| mid zoom, + this patch (two runs) | 383 / 390 | 5.5 / 6.2 | 76 / 87 |

- Farthest zoom: the buildings, ruins, rocks and the hill's trees in the top rows have no shadow with the live manifest
  and have it with the patch; the start's fortress scrolled up to rows 38-100 keeps its whole shadow (with the live
  manifest it is cut at row 133 and gone above).
- Mid zoom: the same shadows to the pixel (the same texel steps along their edges); the differences between the two
  screenshots are swaying foliage. Draws and fps there are the same within the runs' spread.
- The cost is at the zooms beyond the map's own maximum only: the shadow pass draws the casters of the added part of
  the screen (+14-15 % draws per frame at the farthest zoom, render +9-23 % on SwiftShader), and the shadow texels are
  1.5 times larger in world units than the live D112's (2.07 instead of 1.38 units along the light's Y on 1 024 texels):
  the same size on the screen as at the game's own farthest zoom, the detail the game was designed with. A 2048 map
  (the game's own rule at StaticGameLOD UltraHigh: `MapSize` at least 2048 when the shadow LOD is 4; its comparisons at
  rva 0x7b2dc and 0x7b6c2 of the first four executables, `cmp ...,4` -> 3, would give it at High — sites found by their
  bytes, not run) is therefore not part of the fix; it would cost 4 times the memory of the shadow targets (R32F, its
  post-process copy and a D24S8 depth: 12 -> 48 MiB) and 4 times their fill at every zoom.

RotWK 2.02 (rotwk-202, StaticGameLOD High, 800x600, `rotwk-first`'s skirmish, 30 notches out, then scrolled south):
the trees and rocks in the top rows have their shadows (with the live manifest the top 134 rows of 600 had none, the
castle there without its shadow); 573 draws per frame, 4.8 fps at the farthest zoom. RotWK 2.01 and BFME II 1.09 run
the same bytes and were not run.

Caveat: a map without `cameraMaxHeight` in its WorldInfo keeps the INI's default maximum (the D112 patch only scales a
value the map gives); there the factor reaches 1.5 at the map's own maximum height, a deeper (coarser) region than the
game's at the top third of its zoom range, never less coverage.

Installed in the five manifests on 2026-11-19 (restic snapshot a02611ea taken first). An independent review disassembled
the five sites again and confirmed `from` (unique in each file), the moved `mov ecx,[edi+4]`, the x87 depth (4 at most,
one register left as the original `fld`), dead `eax` / `xmm0` / flags after the site, no outside jump into the replaced
range, and the reads of TheTacticalView and its +0x50 / +0x24d0 fields. A second independent browser check confirmed
the farthest zoom (top rows shadowed with the patch, not without, same position) and the mid zoom (same shadow edges,
draws 389.4 / 389.5 per frame). Not checked in a browser: the closest zoom (the factor is 1 there by construction,
`used` = 1500 measured in Node at every height up to the map's own maximum), 16:9, continuous scrolling at the farthest
zoom, RotWK 2.01, BFME II 1.09 and 1.06.
