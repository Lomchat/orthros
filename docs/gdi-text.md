# GDI text: fidelity against a GDI reference

The software GDI draws text through `src/gfx/gdi/text.js` (realization of a LOGFONT, TEXTMETRIC, advances, ABC widths,
rasterization through the browser's font engine) and `src/win32/gdi32.js` (the API). This page records how it was
checked against a real GDI and what that changed (2026-11-10, owner's report on Age of the Ring's text).

## The reference program

`tools/pe/fontmetrics.c` (built by `tools/pe/build.sh`, CRT-free like the other test programs):

    fontmetrics.exe <font file, '-' for none> <face name, '_' for ' '> <lfHeight>...

registers the font file (`AddFontResourceExA`, `FR_PRIVATE`; `-`: none, the face as the system maps it), and for each
height and for weights 400 and 700 prints the TEXTMETRIC, `GetTextExtentPoint32W` of "Misty Mountains", "Royaume des
Forêts", "Lothlórien", "Monts Brumeux", the ABC widths of a few characters (`M o ó i ê W` and space),
`GetGlyphIndicesW` with `GGI_MARK_NONEXISTING_GLYPHS` (`A`, `ó`, U+4E00), and the coverage of "Lothlórien" drawn with
`ExtTextOutW` into a 32 bpp DIB section (ASCII art and its sum). At weight 400 a "missing" section follows (below,
"Characters a font lacks"): TEXTMETRICW's first/last/default/break characters; for space, `'`, ’, …, œ, U+0092, U+0085,
U+008E, TAB, DEL and U+4E00 the glyph index with and without `GGI_MARK_NONEXISTING_GLYPHS`, `GetTextExtentPoint32W`,
`GetCharWidth32W` and ABC widths; "l’a", "l\u0092a", "l\u0085a", "l…a" and glyph 0 (`ETO_GLYPH_INDEX`) drawn as ASCII art.
Run it in Wine (a scratch `WINEPREFIX`, `wine fontmetrics.exe 'Z:\...\albertusmt.otf' Albertus_MT -16 -39 -46 -60`)
and in Orthros through the browser host (a folder holding the program, the font and a `manifest.json` with `exe` and
`args`, given to `tools/headless.mjs <folder> --games-dir <an empty folder>`; the program's output is the log's
`[stdout]` lines, one per write; the Node CLI has no outline fonts, only the built-in bitmap font).

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
- **sizes**, two paths (corrected 2026-11-17, second review). An APT text field (EditText: the menus' texts, the
  Create-a-Hero descriptions) asks for its APT size times `min(sx, sy)` and its box is scaled by `sx` (x, width) and `sy`
  (y, height) (`+0xaa3fc`), `sx`/`sy` = screen / APT stage width and height (`+0xa8d44`). The `language.ini` fonts and
  the GameWindow (WND) fonts go through `adjustFontSize` (`+0x1e9bef`): `floor(size * xRes * 0.0009765625)` (the
  constant, 1/1024, at `+0x7e5798`; `ResolutionFontAdjustment` is not read there), called for instance twice at
  `+0x29af79` / `+0x29afae`, each right before `FontLibrary::getFont` (`+0x2186e0`). The skirmish setup's army list
  follows this second path — its measured heights fit it and not the first: size 14 → `floor(14 * W / 1024)` = 14,
  17, 35 at 1024x768, 1280x720, 2560x1440 → substitution 13.25, 15.875, 31.625 → x4 → -53, **-64**, -127, where
  `min(sx, sy)` would give 14 × 0.9375 → -50 at 1280x720 and 14 × 1.875 → -95 at 2560x1440 (-127 measured). -64 at
  1280x720 is the code's floor (the earlier "-65" left it out; derived, not re-measured). `LOGPIXELSY` plays no part;
- `GetTextMetricsA` gives the line height `ceil((tmHeight + tmExternalLeading) / ss)`, and `ceil(tmOverhang / ss)`;
- every glyph is built on demand, one character at a time (`+0x1563f0`): `GetGlyphIndicesW(ch,
  GGI_MARK_NONEXISTING_GLYPHS)` — 0xFFFF sends the character to the Unicode font (`+0x157eb0`), and a character it
  lacks too gets no glyph: no width, nothing drawn (`+0x157fad`, `+0x157fc0`) —, `GetTextExtentPoint32W(ch)` gives
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
  formats 4 and 12) and mark characters the font lacks (0xFFFF with `GGI_MARK_NONEXISTING_GLYPHS`, else the default
  character's glyph) — before, every character "existed" with its code as index, so an application never switched to
  its fallback font. The glyph-index calls (`ExtTextOut` with `ETO_GLYPH_INDEX`, `GetCharABCWidthsI`,
  `GetTextExtentPointI`, `GetGlyphOutline` with `GGO_GLYPH_INDEX`) map indices back to characters (glyph 0: the font's
  .notdef). System faces (host stand-ins, no file) keep code = index.
- **Characters a font lacks** (2026-11-17) draw as GDI's default glyph (the font's `usDefaultChar`, else its glyph 0),
  never as themselves through the browser's fallback fonts; a C1 code point takes its Windows-1252 character when the
  font has it — below.

## Age of the Ring's cut faction names and uneven words: the game's own layout (2026-11-17)

Checked with frame captures of the text quads (every vertex of the text draws: position in Direct3D 9 pixels, texel
range in the tile), the game's code above and Wine as the GDI reference. Neither comes from Orthros' text engine.
Evidence (captures, the stretched quads' list, Wine's output for Albertus MT at -53/-42/-39):
`data/proof/aotr-flicker-text-2026-11-17/text/`.

- **Army column ("Monts Brumeux", "Misty Mountains", "Woodland Realm", "Royaume des Forêts" cut).** The column is EA's:
  RotWK 2.02's skirmish setup has the same Army column (369-476 px at 1024x768), made for its own short names (Nains,
  Gobelins, Isengard; AotR's `MpGameSetup.apt` differs from RotWK's by 15 bytes, two other placements' matrices). Its text
  box is 73 px at 1024x768 (pen at 374.5, clip at 447.5) while the names need, at -53 (size 14 → 13.25 → x4), 96
  ("Monts Brumeux"), 103, 104 and 122 px (sums of `ceil(cx / 4)`, `cx` = Wine's = Orthros'): 24 to 40 % of each name
  does not fit. The box does not scale like the font (W / 1024, above): the column follows `sx` and the list's button
  `sy`, giving 73, 100 and 208 px at 1024x768, 1280x720 and 2560x1440 (x1.37 and x2.85 where the font grows x1.21 and
  x2.40), so wide modes cut less but every mode cuts: 1024x768 "Monts Brum", 1280x720 "Monts Brumeu", 2560x1440 "Misty Mountai" and "Woodland Rea"
  (234 and 240 px for 208: about 12 % missing). Hinted advances cannot close such gaps: Albertus MT is CFF (no `hdmx`,
  no TrueType instructions), so GDI's advances are the rounded linear ones, and one pixel of `cx` moves `ceil(cx / 4)`
  for at most one character in four.
- **Uneven words (some words of a sentence bolder or softer).** The text quads' edges all fall on pixel edges (their
  vertices at x.5 in Direct3D 9 coordinates, whose pixel centres are the integers — Orthros adds the 0.5 that maps them
  to GL's, `src/gfx/d3d8-shaders.js` `D3D_TO_GL_POSITION` and the pre-transformed path) and the tiles' glyphs are
  uniform, but the game rounds each word segment's two ends separately under its field's matrix: 31 of the 193 text
  quads of the Create-a-Hero "Nouvelles caractéristiques" screen at 1024x768 are one pixel wider or narrower than their
  texels (14 of 239 on the skirmish setup), and they are exactly the words that stand out ("nouveaux", "nouvelle", "le",
  "ultime", "nouveau", "pour", "premiers", "niveaux", "vous", "la", "armures"): the game's LINEAR sampler spreads their
  strokes over two pixels. Same vertices and sampler on Windows, same look; at 2560x1440 the description's scale is
  `min(sx, sy)` = 1.875 (its strokes 1.875 times wider) and the paragraphs look even. (The "faint box" noted earlier is
  the panel's gradient.)
- **Mode in use.** Profiles made from the old French first-launch profile (the game's own detection under emulation:
  `IdealStaticGameLOD = VeryLow`, `Resolution = 800 600`) keep 800x600, the smallest text; new players get their
  screen's largest mode since D127 (`newProfileIni`).
- **"Lothlórien".** Albertus MT has ó (glyph 216) and Orthros draws it like Wine; seen in game in the army drop-down
  (fr and en, 1280x720 and 2560x1440).

## Characters a font lacks (2026-11-17)

Question from the Age of the Ring French work: AotR's `.str` files are Windows-1252 and `game.dat` widens them byte by
byte, so ’ (0x92), … (0x85) and œ (0x9C) reach the font library as U+0092, U+0085, U+009C (1336, 177 and 89 of them in
the French `lotr.str`, 61 … in the English one). Chrome drew them as control pictograms ("NEL", "PU2"; an intro
subtitle read "[NEL et maîtriser votre destin]"). What does Windows draw?

- **The game** (above): a character the face's `GetGlyphIndicesW(GGI_MARK_NONEXISTING_GLYPHS)` marks 0xFFFF goes to
  the Unicode font, and one that font marks too is dropped (no width, nothing drawn). `ExtTextOutW` only receives
  characters a `GetGlyphIndicesW` accepted: a box is never drawn by this game; a character missing everywhere vanishes.
- **The fonts.** Albertus MT (AotR's file, OpenType CFF) has cmaps (0,3) and (3,1) format 4 (303 characters) and (1,0)
  Mac Roman format 0 — no (3,0) symbol cmap. Its Unicode cmaps have ’ U+2019 (glyph 8), … U+2026 (121), œ U+0153 (148),
  and of U+0080-U+009F only U+008E and U+009E, mapped to Ž and ž (glyphs 199, 228: the font's own Windows-1252
  compatibility entries) — not U+0092, U+0085, U+009C. OS/2 version 2: `usDefaultChar` = `usBreakChar` = U+0020; glyph 0
  (.notdef) is empty (`endchar`), 333 units wide like the space. Omnia LT Std: the same default character, a drawn
  .notdef. The Unicode font, Arial Unicode MS (a Windows/Office font, not in the game), has no U+0092 either:
  fileformat.info's list of fonts with U+0092 names none of Arial Unicode MS, Arial, Times New Roman, Tahoma, Microsoft
  Sans Serif, Lucida Sans Unicode, all listed for U+2019.
- **Documented GDI.** OpenType `OS/2.usDefaultChar`: "a character that can be used for a default glyph if a requested
  character is not supported in the font. If the value of this field is zero, glyph ID 0 is to be used";
  `GetGlyphIndices` with `GGI_MARK_NONEXISTING_GLYPHS` marks missing characters 0xFFFF. Nothing documents a
  code-page reading of U+0080-U+009F.
- **Wine 11.0** (`fontmetrics.exe`, scratch prefix): Albertus MT at -53 marks U+0092, U+0085, TAB, U+4E00 0xFFFF and
  without the flag gives glyph 1, the space's: they measure 18 px and draw blank ("l\u0092a" is "l a", 56 px against 51
  for "l’a"); glyph 0 draws nothing. "Arial Unicode MS", absent, maps to Liberation Sans (`usDefaultChar` 0): glyph 0,
  a box 40 px wide (1536 units), for the same characters. Wine never reads a C1 code point as Windows-1252.
- **Conclusion.** By the documented rules, as Wine applies them, AotR on Windows would drop every ’ and œ of the French
  text ("larmée", "cur") and every … of the English one. The French translation (La Terre du Milieu) was made and
  played on Windows with its 1336 apostrophes as 0x92 bytes, and AotR's English team kept 0x85 for its ellipses: an
  apostrophe missing from nearly every sentence would not have been released. On Windows these code points therefore
  resolve to the characters meant: a C1 code point a font lacks is read as the ANSI code page's character (0x92 → ’),
  the convention Albertus MT itself follows for Ž and ž. This is inferred from the game's behaviour on Windows, not
  measured there (no Windows machine here; Wine, which is not Windows, does not do it).

Orthros' rule, `src/gfx/gdi/text.js` `resolveChar`, for every font and every game (`GetGlyphIndices`, extents, widths,
ABC widths, `GetGlyphOutline` and the drawing all follow it, so what is measured is what is drawn):

1. the font has the character: its glyph;
2. a C1 code point (U+0080-U+009F) the font lacks, whose Windows-1252 character it has: that character, glyph included
   (`GetGlyphIndices` reports it, the application draws it with this font);
3. otherwise the character is missing (0xFFFF with `GGI_MARK_NONEXISTING_GLYPHS`, else the default character's glyph)
   and draws as the font's default character (`usDefaultChar`), or else as its glyph 0: its `hmtx` advance and its
   outline's box stroked (`glyf` header; a non-empty CFF .notdef is estimated from its side bearings and cap height),
   nothing when it has no outline.

Host stand-ins (system faces, no file at hand) have every character but the C0 and C1 controls and DEL; those follow
rules 2 and 3 with Arial's glyph 0 (a box 0.75 em wide, Liberation Sans' measurements). The browser never draws a
control character itself (its fallback fonts' "NEL"/"PU2" pictograms). Before: Albertus marked U+0085 0xFFFF, the
game asked the "Arial Unicode MS" stand-in, which claimed every character, and `ExtTextOutW(U+0085)` reached Chrome.
Orthros in the browser, same program (after): Albertus MT -53 gives U+0092 glyph 8, cx 13, ABC 1,12,0 (’) and U+0085
glyph 121, cx 53 (…), "l\u0092a" drawn like "l’a"; TAB, DEL, U+4E00 0xFFFF / glyph 1, 18 px, blank (Wine's numbers but
DEL, 26 px in Wine); the "Arial Unicode MS" stand-in: TAB and DEL 0xFFFF, a 40 px box (Wine's Liberation Sans: 40 px).
In game (AotR 10.0.2 in French, the intro's subtitles at 1024x768, headless Chromium, same run before and after):
"ténèbres[NEL]", "[NEL]et maîtriser votre destin", "c[ST]ur", "inédits [SPA] 14 missions" became "ténèbres…",
"[…et maîtriser votre destin]", "cœur", "inédits – 14 missions", in Albertus MT.
