// Built-in bitmap font (5x7 glyphs on an 8x12 cell, drawn from scratch) for text output when no
// host font rasterizer is available (Node tests, fallback in the browser).

const G = {
  ' ': '     |     |     |     |     |     |     ',
  '!': '  #  |  #  |  #  |  #  |  #  |     |  #  ',
  '"': ' # # | # # |     |     |     |     |     ',
  '#': ' # # | # # |#####| # # |#####| # # | # # ',
  '$': '  #  | ####|# #  | ### |  # #|#### |  #  ',
  '%': '##   |##  #|   # |  #  | #   |#  ##|   ##',
  '&': ' ##  |#  # |#  # | ##  |# # #|#  # | ## #',
  "'": '  #  |  #  |     |     |     |     |     ',
  '(': '   # |  #  | #   | #   | #   |  #  |   # ',
  ')': ' #   |  #  |   # |   # |   # |  #  | #   ',
  '*': '     | # # |  #  |#####|  #  | # # |     ',
  '+': '     |  #  |  #  |#####|  #  |  #  |     ',
  ',': '     |     |     |     |  ## |  #  | #   ',
  '-': '     |     |     |#####|     |     |     ',
  '.': '     |     |     |     |     |  ## |  ## ',
  '/': '     |    #|   # |  #  | #   |#    |     ',
  '0': ' ### |#   #|#  ##|# # #|##  #|#   #| ### ',
  '1': '  #  | ##  |  #  |  #  |  #  |  #  | ### ',
  '2': ' ### |#   #|    #|   # |  #  | #   |#####',
  '3': '#####|   # |  #  |   # |    #|#   #| ### ',
  '4': '   # |  ## | # # |#  # |#####|   # |   # ',
  '5': '#####|#    |#### |    #|    #|#   #| ### ',
  '6': '  ## | #   |#    |#### |#   #|#   #| ### ',
  '7': '#####|    #|   # |  #  | #   | #   | #   ',
  '8': ' ### |#   #|#   #| ### |#   #|#   #| ### ',
  '9': ' ### |#   #|#   #| ####|    #|   # | ##  ',
  ':': '     |  ## |  ## |     |  ## |  ## |     ',
  ';': '     |  ## |  ## |     |  ## |  #  | #   ',
  '<': '   # |  #  | #   |#    | #   |  #  |   # ',
  '=': '     |     |#####|     |#####|     |     ',
  '>': ' #   |  #  |   # |    #|   # |  #  | #   ',
  '?': ' ### |#   #|    #|   # |  #  |     |  #  ',
  '@': ' ### |#   #|# ###|# # #|# ###|#    | ### ',
  A: ' ### |#   #|#   #|#####|#   #|#   #|#   #',
  B: '#### |#   #|#   #|#### |#   #|#   #|#### ',
  C: ' ### |#   #|#    |#    |#    |#   #| ### ',
  D: '#### |#   #|#   #|#   #|#   #|#   #|#### ',
  E: '#####|#    |#    |#### |#    |#    |#####',
  F: '#####|#    |#    |#### |#    |#    |#    ',
  G: ' ### |#   #|#    |# ###|#   #|#   #| ####',
  H: '#   #|#   #|#   #|#####|#   #|#   #|#   #',
  I: ' ### |  #  |  #  |  #  |  #  |  #  | ### ',
  J: '  ###|   # |   # |   # |   # |#  # | ##  ',
  K: '#   #|#  # |# #  |##   |# #  |#  # |#   #',
  L: '#    |#    |#    |#    |#    |#    |#####',
  M: '#   #|## ##|# # #|# # #|#   #|#   #|#   #',
  N: '#   #|##  #|# # #|#  ##|#   #|#   #|#   #',
  O: ' ### |#   #|#   #|#   #|#   #|#   #| ### ',
  P: '#### |#   #|#   #|#### |#    |#    |#    ',
  Q: ' ### |#   #|#   #|#   #|# # #|#  # | ## #',
  R: '#### |#   #|#   #|#### |# #  |#  # |#   #',
  S: ' ####|#    |#    | ### |    #|    #|#### ',
  T: '#####|  #  |  #  |  #  |  #  |  #  |  #  ',
  U: '#   #|#   #|#   #|#   #|#   #|#   #| ### ',
  V: '#   #|#   #|#   #|#   #|#   #| # # |  #  ',
  W: '#   #|#   #|#   #|# # #|# # #|## ##|#   #',
  X: '#   #|#   #| # # |  #  | # # |#   #|#   #',
  Y: '#   #|#   #| # # |  #  |  #  |  #  |  #  ',
  Z: '#####|    #|   # |  #  | #   |#    |#####',
  '[': ' ### | #   | #   | #   | #   | #   | ### ',
  '\\': '     |#    | #   |  #  |   # |    #|     ',
  ']': ' ### |   # |   # |   # |   # |   # | ### ',
  '^': '  #  | # # |#   #|     |     |     |     ',
  _: '     |     |     |     |     |     |#####',
  '`': ' #   |  #  |     |     |     |     |     ',
  a: '     |     | ### |    #| ####|#   #| ####',
  b: '#    |#    |# ## |##  #|#   #|#   #|#### ',
  c: '     |     | ### |#    |#    |#   #| ### ',
  d: '    #|    #| ## #|#  ##|#   #|#   #| ####',
  e: '     |     | ### |#   #|#####|#    | ### ',
  f: '  ## | #  #| #   |###  | #   | #   | #   ',
  g: '     |     | ####|#   #| ####|    #| ### ',
  h: '#    |#    |# ## |##  #|#   #|#   #|#   #',
  i: '  #  |     | ##  |  #  |  #  |  #  | ### ',
  j: '   # |     |  ## |   # |   # |#  # | ##  ',
  k: '#    |#    |#  # |# #  |##   |# #  |#  # ',
  l: ' ##  |  #  |  #  |  #  |  #  |  #  | ### ',
  m: '     |     |## # |# # #|# # #|#   #|#   #',
  n: '     |     |# ## |##  #|#   #|#   #|#   #',
  o: '     |     | ### |#   #|#   #|#   #| ### ',
  p: '     |     |#### |#   #|#### |#    |#    ',
  q: '     |     | ####|#   #| ####|    #|    #',
  r: '     |     |# ## |##  #|#    |#    |#    ',
  s: '     |     | ####|#    | ### |    #|#### ',
  t: ' #   | #   |###  | #   | #   | #  #|  ## ',
  u: '     |     |#   #|#   #|#   #|#  ##| ## #',
  v: '     |     |#   #|#   #|#   #| # # |  #  ',
  w: '     |     |#   #|#   #|# # #|# # #| # # ',
  x: '     |     |#   #| # # |  #  | # # |#   #',
  y: '     |     |#   #|#   #| ####|    #| ### ',
  z: '     |     |#####|   # |  #  | #   |#####',
  '{': '   ##|  #  |  #  |##   |  #  |  #  |   ##',
  '|': '  #  |  #  |  #  |  #  |  #  |  #  |  #  ',
  '}': '##   |  #  |  #  |   ##|  #  |  #  |##   ',
  '~': '     |     | #  #|# # #|#  # |     |     ',
};

export const GLYPH_W = 5, GLYPH_H = 7;
export const CELL_W = 8, CELL_H = 12; // advance / line height at scale 1

/** @type {Map<number, Uint8Array>} char code -> 7 row bitmasks (bit 4 = leftmost) */
const glyphs = new Map();
for (const [ch, rows] of Object.entries(G)) {
  const r = rows.split('|');
  const bits = new Uint8Array(GLYPH_H);
  for (let y = 0; y < GLYPH_H; y++) { let m = 0; for (let x = 0; x < GLYPH_W; x++) if (r[y][x] === '#') m |= 16 >> x; bits[y] = m; }
  glyphs.set(ch.charCodeAt(0), bits);
}
const BOX = new Uint8Array([31, 17, 17, 17, 17, 17, 31]);

export function glyph(code) { return glyphs.get(code) ?? BOX; }

/**
 * Draw text with the builtin font. scale: integer magnification (font height ~ 12*scale).
 * @param {import('./surface.js').Surface} surf
 */
export function drawText(surf, clip, x, y, text, color, scale = 1, bg = null) {
  const sc = Math.max(1, scale | 0);
  for (let i = 0; i < text.length; i++) {
    const g = glyph(text.charCodeAt(i));
    const x0 = x + i * CELL_W * sc;
    if (bg !== null) for (let yy = 0; yy < CELL_H * sc; yy++) for (let xx = 0; xx < CELL_W * sc; xx++) { const px = x0 + xx, py = y + yy; if (px >= clip.l && px < clip.r && py >= clip.t && py < clip.b) surf.setPixel(px, py, bg); }
    for (let gy = 0; gy < GLYPH_H; gy++) {
      const m = g[gy];
      if (!m) continue;
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (!(m & (16 >> gx))) continue;
        for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) {
          const px = x0 + (gx + 1) * sc + dx, py = y + (gy + 2) * sc + dy;
          if (px >= clip.l && px < clip.r && py >= clip.t && py < clip.b) surf.setPixel(px, py, color);
        }
      }
    }
  }
}

export function textWidth(text, scale = 1) { return text.length * CELL_W * Math.max(1, scale | 0); }
export function textHeight(scale = 1) { return CELL_H * Math.max(1, scale | 0); }
