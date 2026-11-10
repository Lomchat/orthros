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

From `--log apisite` and the disassembly of `game.dat` (RotWK 2.01 engine, used by AotR 10):

- the language's `LocalFontFile`s (AlbertusMT.otf, OmniaLTStd.ttf) are extracted to temporary files and registered with
  `AddFontResourceExA(path, FR_PRIVATE | FR_NOT_ENUM)`;
- each font is created **supersampled**: `CreateFontA(-(int)(3 * size + 0.5), 0, 0, 0, bold ? 700 : 400, 0, 0, 0,
  DEFAULT_CHARSET, 0, 0, ANTIALIASED_QUALITY, 0, face)`, `size` being the INI/APT point size times the resolution factor
  (`ResolutionFontAdjustment`, 1.28 at 1024x768). Heights seen at 1024x768: Albertus MT -39, -46, -53, -60, -67 (400) and
  -44, -50, -57, -63 (700); Omnia LT Std -128; Times New Roman -40/-48/-56; Arial -32 to -80; Courier New -14. Each
  font has a companion "Arial Unicode MS" font of the same height (the language's `UnicodeFontName`);
- `GetTextMetricsA` gives the line height `ceil((tmHeight + tmExternalLeading) / 3)`, `tmExternalLeading / 3` and
  `ceil(tmOverhang / 3)`;
- every glyph is built on demand, one character at a time: `GetGlyphIndicesW(ch, GGI_MARK_NONEXISTING_GLYPHS)` — 0xFFFF
  sends the character to the Unicode font —, `GetTextExtentPoint32W(ch)` gives `cx`, `ExtTextOutW(0, 0, ETO_OPAQUE, ch)`
  into a 64x64 24 bpp DIB (white on black, several passes for larger glyphs), and the DIB is averaged 3x3 (blue >> 4)
  into an A4R4G4B4 glyph `ceil(cx / 3) + floor(size / 8 + 0.5)` pixels wide (the second term is padding; the text
  advances by `ceil(cx / 3)` on screen, measured on the skirmish list: "Erebor" 39 px, "Tester" 36 px at -39).

So the on-screen width of a string is fixed by the single-character `GetTextExtentPoint32W` results.

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

## Not explained by GDI (open)

- **Army column ("Misty Mountains", "Royaume des Forêts", "Monts Brumeux" cut).** The strings' GDI extents equal
  Wine's to the pixel at the heights the game uses, and the game's on-screen width follows from them
  (`ceil(cx / 3)` per character: "Misty Mountains" 102 px for a ~72 px column at 1024x768). With the same GDI answers
  Windows would lay them out identically; the difference, if Windows really fits them, is upstream (the font size the
  game picks: INI/APT size x resolution factor) — not settled here: AotR's `game.dat` does not start under Wine (an
  access violation in its unpacking loop at `game.dat+0x6cac78`), so no Windows-side screenshot was available.
- **Uneven words on the Create-a-Hero "New features" screen.** The same cached glyphs draw every word; the affected
  words ("Create-a-Hero", "build", "dozens", "weapon", ...) carry a faint box of their own size (screen brightness
  +20/255 around the word) and softer edges — a compositing difference (Direct3D side), not glyph data.
- **"Lothlórien".** Albertus MT has ó (glyph 216) and Orthros draws it like Wine; the place where the owner saw it was
  not reached in the harness runs (the army drop-down needs scrolling), so this is not verified in game.
