# GDI text: fidelity against a GDI reference

The software GDI draws text through `src/gfx/gdi/text.js` (realization of a LOGFONT, TEXTMETRIC, advances, ABC widths,
rasterization through the browser's font engine) and `src/win32/gdi32.js` (the API). This page records how it was
checked against a real GDI and what that changed (2026-11-10, owner's report on Age of the Ring's text).

## The reference program

`tools/pe/fontmetrics.c` (built by `tools/pe/build.sh`, CRT-free like the other test programs):

    fontmetrics.exe <font file> <face name, '_' for ' '> <lfHeight>...

registers the font file (`AddFontResourceExA`, `FR_PRIVATE`), and for each height and for weights 400 and 700 prints
the TEXTMETRIC, `GetTextExtentPoint32W` of "Misty Mountains", "Royaume des Forêts", "Lothlórien", "Monts Brumeux",
the ABC widths of a few characters (`M o ó i ê W` and space), `GetGlyphIndicesW` with `GGI_MARK_NONEXISTING_GLYPHS`
(`A`, `ó`, U+4E00), and the coverage of "Lothlórien" drawn with `ExtTextOutW` into a 32 bpp DIB section (ASCII art and
its sum). Run it in Wine (a scratch `WINEPREFIX`, `wine fontmetrics.exe 'Z:\...\albertusmt.otf' Albertus_MT -16 -39 -46 -60`)
and in Orthros through the browser host (a manifest whose folder holds the program and the font, as
`tests/fixtures/manifests/test-text.json`; the Node CLI has no outline fonts, only the built-in bitmap font).

## How Age of the Ring (SAGE) uses GDI for its text

From `--log apisite`, `ORTHROS_TRACE_EIP` on the font library and the disassembly of `rotwk/game.dat` (RotWK 2.01
engine, used by AotR 10; addresses are `game.dat+` offsets, image base 0x400000). Corrected 2026-11-17: the first
version of this section had the supersampling factor (3) and the size rule (`ResolutionFontAdjustment`) wrong.

- the language's `LocalFontFile`s (AlbertusMT.otf — CFF outlines, no `hdmx` —, OmniaLTStd.ttf) are extracted to
  temporary files (`Temp/{70FF…}/lrf1.tmp`, `lrf2.tmp`) and registered with `AddFontResourceExA(path, FR_PRIVATE |
  FR_NOT_ENUM)` (`+0x1e9f0e`);
- a font is asked for as (face, size, bold) (`FontLibrary::getFont`, `+0x2186e0`). The size goes first through the face's
  `FontSubstitution` of `fontsubstitution.ini` (linear between its points, `+0x218185`; AotR: Albertus MT 8 → 8, 40 → 36,
  so 14 → 13.25) and is quantized to 1/`ss`. `ss`, the **supersampling factor**, is 4 for an antialiased face and 1
  otherwise (`fontsettings.ini` `FontDefaultSettings <face> Antialiased`, default yes: Albertus MT, Times New Roman,
  Arial x4; Courier New, FixedSys x1);
- the GDI font (`+0x153fd0`): `CreateFontA(-floor(ss * size + 0.5), 0, 0, 0, bold ? 700 : 400, 0, 0, 0, DEFAULT_CHARSET,
  0, 0, ANTIALIASED_QUALITY, 0, face)` ("Generals" becomes "Arial"). Seen: Times New Roman 12 → -48, Courier New 14 bold
  → -14, Albertus MT 14 → -53, 16 → -60, 18 → -67, 10 → -39; each face has an "Arial Unicode MS" companion of the same
  height (the language's `UnicodeFontName`);
- **sizes**: an APT text field (EditText: the menus) asks for its APT size times `min(sx, sy)` and its box is scaled by
  `sx` and `sy` (`+0xaa3fc`), `sx`/`sy` = screen / APT stage width and height (`+0xa8d44`); measured, the font scale is
  W / 1024 at 1024x768, 1280x720 and 2560x1440 (the skirmish army list: APT 14 → -53, -65, -127). The `language.ini`
  fonts (not APT) use `floor(size * displayWidth / 1024)` (`+0x1e9bef`). `LOGPIXELSY` plays no part;
- `GetTextMetricsA` gives the line height `ceil((tmHeight + tmExternalLeading) / ss)`, and `ceil(tmOverhang / ss)`;
- every glyph is built on demand, one character at a time (`+0x1563f0`): `GetGlyphIndicesW(ch,
  GGI_MARK_NONEXISTING_GLYPHS)` — 0xFFFF sends the character to the Unicode font —, `GetTextExtentPoint32W(ch)` gives
  `cx`, `ExtTextOutW(0, 0, ETO_OPAQUE, ch)` into a 64x64 24 bpp DIB (white on black, 64 / ss cells per pass), averaged
  ss x ss into an A4 coverage `ceil(cx / ss) + pad` pixels wide (`pad` = `floor(size / 8 + 0.5)` clamped to 0..4); the
  pen advances by `ceil(cx / ss)` (cell - pad - overhang);
- the menus' text is then laid out per field into 64x64 A8R8G8B8 tiles (one line cut into 64-pixel rows, alpha in steps
  of 16), drawn as one quad per word segment with the field's matrix, clipped on the CPU to the field's box, the shadow
  1 pixel down-right first, with a LINEAR sampler.

So the on-screen width of a string is fixed by the single-character `GetTextExtentPoint32W` results, and the size by the
game's data (APT size, `fontsubstitution.ini`, `fontsettings.ini`) and the display mode.

## Measurements (Albertus MT, AotR's file)

| lfHeight / weight | value | Wine (FreeType GDI) | Orthros before | Orthros after |
|---|---|---|---|---|
| -39 / 400 | "Misty Mountains" cx | 282 | 282 | 282 |
| -39 / 400 | "Royaume des Forêts" / "Lothlórien" / "Monts Brumeux" | 330 / 171 / 263 | same | same |
| -46 / 400 | tmHeight / tmAscent / tmDescent | 56 / 44 / 12 | same | same |
| -46 / 400 | tmMaxCharWidth | 65 | 43 | 65 |
| -46 / 700 | "Misty Mountains" cx | 344 | 329 | 344 |
| -16 / 700 | "Misty Mountains" cx, tmAve, tmMax | 130, 10, 23 | 115, 9, 15 | 130, 10, 23 |
| any | `GetGlyphIndicesW` A / ó / U+4E00 | 34 / 216 / 0xFFFF | 0x41 / 0xF3 / 0x4E00 | 34 / 216 / 0xFFFF |
| Omnia LT Std -40 | tmInternalLeading | -7 | 0 | -7 |
| -53 / 400 (the army list at 1024x768) | "Misty Mountains" / "Royaume des Forêts" / "Monts Brumeux" cx | 381 / 454 / 358 (the rounded `hmtx` advances) | same | same |

Regular-weight extents, ascent/descent and ABC widths already matched to the pixel at every height measured (-12 to -60),
and the glyphs' shapes match (ó included: the ASCII art of "Lothlórien" is the same in both). The coverage sums differ
by about 6 % (Orthros 441 054 vs Wine 465 161 at -46): the browser's antialiasing is slightly lighter than FreeType's.

## What changed (generic, every application drawing GDI text)

- **Simulated bold.** A weight >= 600 asked of a registered family that has no bold face is GDI's emboldened regular
  outline: every advance one pixel wider (GetTextExtent, GetCharWidth, ABC, TextOut positions), tmAveCharWidth and
  tmMaxCharWidth + 1, no overhang. Orthros had the browser's synthetic bold with the regular advances: bold text was
  narrower than on Windows (15 px over "Misty Mountains" at -16) and its widened ink ran past each glyph's cell.
- **tmMaxCharWidth** of a registered font is its bounding box width (`head.xMax - head.xMin`) at the em size, not the
  widest of 'W'/'M'.
- **tmInternalLeading** may be negative (cell smaller than the em: Omnia LT Std's usWin metrics are 824/1000 em).
- **Glyph indices.** `GetGlyphIndicesW/A` answer from the registered font's character map (`ttf.js parseCmap`, cmap
  formats 4 and 12) and mark characters the font lacks (0xFFFF with `GGI_MARK_NONEXISTING_GLYPHS`, else 0) — before,
  every character "existed" with its code as index, so an application never switched to its fallback font. The
  glyph-index calls (`ExtTextOut` with `ETO_GLYPH_INDEX`, `GetCharABCWidthsI`, `GetTextExtentPointI`,
  `GetGlyphOutline` with `GGO_GLYPH_INDEX`) map indices back to characters. System faces (host stand-ins, no file)
  keep code = index.

## Age of the Ring's cut faction names and uneven words: the game's own layout (2026-11-17)

Checked with frame captures of the text quads (every vertex of the text draws: position in Direct3D 9 pixels, texel
range in the tile), the game's code above and Wine as the GDI reference. Neither comes from Orthros' text engine.

- **Army column ("Monts Brumeux", "Misty Mountains", "Woodland Realm", "Royaume des Forêts" cut).** The column is EA's:
  RotWK 2.02's skirmish setup has the same Army column (369-476 px at 1024x768), made for its own short names (Nains,
  Gobelins, Isengard; AotR's `MpGameSetup.apt` differs from RotWK's by 15 bytes, two other placements' matrices). Its text
  box shows 71 px at 1024x768 (pen at 374.5, clip at 447.5) while the names need, at -53 (APT 14 → 13.25 → x4), 96
  ("Monts Brumeux"), 103, 104 and 122 px (sums of `ceil(cx / 4)`, `cx` = Wine's = Orthros'). Fonts and boxes both
  scale with the screen width (above), so the names are cut at every mode: 1024x768 "Monts Brum", 1280x720 "Monts
  Brumeu" (box 100 px), 2560x1440 "Misty Mountai" and "Woodland Rea" (box 208 px for 234 and 240 px). Small modes cut a
  little more (the substitution's +1). Hinted advances cannot close a 10 % gap: Albertus MT is CFF (no `hdmx`, no
  TrueType instructions), so GDI's advances are the rounded linear ones, and one pixel of `cx` moves `ceil(cx / 4)` for
  at most one character in four.
- **Uneven words (some words of a sentence bolder or softer).** The text quads all sit on pixel centres and the tiles'
  glyphs are uniform, but the game rounds each word segment's two ends separately under its field's matrix: 31 of the
  193 text quads of the Create-a-Hero "Nouvelles caractéristiques" screen at 1024x768 are one pixel wider or narrower
  than their texels (14 of 239 on the skirmish setup), and they are exactly the words that stand out ("nouveaux",
  "nouvelle", "le", "ultime", "nouveau", "pour", "premiers", "niveaux", "vous", "la", "armures"): the game's LINEAR
  sampler spreads their strokes over two pixels. Same vertices and sampler on Windows, same look; at 2560x1440 the
  strokes are 2.5 times wider and the paragraphs look even. (The "faint box" noted earlier is the panel's gradient.)
- **Mode in use.** Profiles made from the old French first-launch profile (the game's own detection under emulation:
  `IdealStaticGameLOD = VeryLow`, `Resolution = 800 600`) keep 800x600, the smallest text; new players get their
  screen's largest mode since D127 (`newProfileIni`).
- **"Lothlórien".** Albertus MT has ó (glyph 216) and Orthros draws it like Wine; seen in game in the army drop-down
  (fr and en, 1280x720 and 2560x1440).
