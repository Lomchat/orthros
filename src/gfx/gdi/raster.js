// Software rasterization primitives over Surface (all coordinates in surface space, with an
// inclusive-exclusive clip rectangle {l,t,r,b}).

export function clipRect(a, b) {
  return { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) };
}
export function rectEmpty(r) { return r.r <= r.l || r.b <= r.t; }

/** Fill a rectangle with a solid color. */
export function fillRect(surf, clip, l, t, r, b, color) {
  const c = clipRect(clip, { l, t, r, b });
  const cc = clipRect(c, { l: 0, t: 0, r: surf.width, b: surf.height });
  if (rectEmpty(cc)) return;
  surf.generation++;
  if (surf.is32) {
    const u = surf.u32; const v = color & 0xffffff;
    for (let y = cc.t; y < cc.b; y++) { const base = surf.base32 + y * surf.stride32; u.fill(v, base + cc.l, base + cc.r); }
  } else {
    for (let y = cc.t; y < cc.b; y++) for (let x = cc.l; x < cc.r; x++) surf.setPixel(x, y, color);
  }
}

/** Apply a raster op to a rectangle without a source (PATBLT-like). fn(dst) -> new. */
export function opRect(surf, clip, l, t, r, b, fn) {
  const cc = clipRect(clipRect(clip, { l, t, r, b }), { l: 0, t: 0, r: surf.width, b: surf.height });
  if (rectEmpty(cc)) return;
  surf.generation++;
  const row = new Uint32Array(cc.r - cc.l);
  for (let y = cc.t; y < cc.b; y++) {
    surf.readRow(y, cc.l, row.length, row);
    for (let i = 0; i < row.length; i++) row[i] = fn(row[i]) & 0xffffff;
    surf.writeRow(y, cc.l, row.length, row);
  }
}

// Ternary raster ops we support (the common ones). Functions of (src, dst, pat).
export const ROPS = {
  0x00cc0020: (s) => s, // SRCCOPY
  0x00ee0086: (s, d) => s | d, // SRCPAINT
  0x008800c6: (s, d) => s & d, // SRCAND
  0x00660046: (s, d) => s ^ d, // SRCINVERT
  0x00440328: (s, d) => s & ~d, // SRCERASE
  0x00330008: (s) => ~s, // NOTSRCCOPY
  0x001100a6: (s, d) => ~(s | d), // NOTSRCERASE
  0x00c000ca: (s, d, p) => s & p, // MERGECOPY
  0x00bb0226: (s, d) => ~s | d, // MERGEPAINT
  0x00f00021: (s, d, p) => p, // PATCOPY
  0x00fb0a09: (s, d, p) => p | ~s, // PATPAINT
  0x005a0049: (s, d, p) => p ^ d, // PATINVERT
  0x00550009: (s, d) => ~d, // DSTINVERT
  0x00000042: () => 0, // BLACKNESS
  0x00ff0062: () => 0xffffff, // WHITENESS
  0x00aa0029: (s, d) => d, // NOP (D)
};

/**
 * Blit src rect (sx,sy,w,h) to dst at (dx,dy) with a raster op. Handles overlapping surfaces.
 * @param {number} rop ternary rop code
 * @param {number} pat pattern color (for pattern rops)
 */
export function blit(dst, clip, dx, dy, w, h, src, sx, sy, rop = 0x00cc0020, pat = 0) {
  // clip destination
  let l = dx, t = dy, r = dx + w, b = dy + h;
  const cc = clipRect(clipRect(clip, { l, t, r, b }), { l: 0, t: 0, r: dst.width, b: dst.height });
  if (rectEmpty(cc)) return;
  sx += cc.l - dx; sy += cc.t - dy;
  w = cc.r - cc.l; h = cc.b - cc.t;
  // clip source
  if (src) {
    if (sx < 0) { w += sx; cc.l -= sx; sx = 0; }
    if (sy < 0) { h += sy; cc.t -= sy; sy = 0; }
    if (sx + w > src.width) w = src.width - sx;
    if (sy + h > src.height) h = src.height - sy;
    if (w <= 0 || h <= 0) return;
  }
  const fn = ROPS[rop >>> 0] ?? ROPS[0x00cc0020];
  dst.generation++;
  const simple = rop >>> 0 === 0x00cc0020;
  if (simple && src && src.is32 && dst.is32) {
    const su = src.u32, du = dst.u32;
    const down = src === dst && sy < cc.t; // overlapping copy downward: iterate bottom-up
    for (let i = 0; i < h; i++) {
      const y = down ? h - 1 - i : i;
      const sb = src.base32 + (sy + y) * src.stride32 + sx;
      const db = dst.base32 + (cc.t + y) * dst.stride32 + cc.l;
      if (src === dst && sb < db && sb + w > db) { for (let x = w - 1; x >= 0; x--) du[db + x] = su[sb + x]; }
      else du.copyWithin(db, sb, sb + w);
    }
    return;
  }
  const srow = new Uint32Array(w), drow = new Uint32Array(w);
  const down = src === dst && sy < cc.t;
  for (let i = 0; i < h; i++) {
    const y = down ? h - 1 - i : i;
    if (src) src.readRow(sy + y, sx, w, srow);
    dst.readRow(cc.t + y, cc.l, w, drow);
    for (let x = 0; x < w; x++) drow[x] = fn(srow[x], drow[x], pat) & 0xffffff;
    dst.writeRow(cc.t + y, cc.l, w, drow);
  }
}

/** Stretch blit (nearest neighbour), SRCCOPY only + color key optional. */
export function stretchBlit(dst, clip, dx, dy, dw, dh, src, sx, sy, sw, sh, rop = 0x00cc0020) {
  if (dw === sw && dh === sh) return blit(dst, clip, dx, dy, dw, dh, src, sx, sy, rop);
  const flipX = dw < 0, flipY = dh < 0;
  if (flipX) { dx += dw; dw = -dw; }
  if (flipY) { dy += dh; dh = -dh; }
  if (sw < 0) { sx += sw; sw = -sw; }
  if (sh < 0) { sy += sh; sh = -sh; }
  if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
  const cc = clipRect(clipRect(clip, { l: dx, t: dy, r: dx + dw, b: dy + dh }), { l: 0, t: 0, r: dst.width, b: dst.height });
  if (rectEmpty(cc)) return;
  const fn = ROPS[rop >>> 0] ?? ROPS[0x00cc0020];
  dst.generation++;
  const w = cc.r - cc.l;
  const srow = new Uint32Array(sw), drow = new Uint32Array(w);
  let lastSy = -1;
  for (let y = cc.t; y < cc.b; y++) {
    let ry = Math.floor(((y - dy) * sh) / dh);
    if (flipY) ry = sh - 1 - ry;
    const syy = sy + ry;
    if (syy < 0 || syy >= src.height) continue;
    if (syy !== lastSy) { src.readRow(syy, Math.max(sx, 0), Math.min(sw, src.width - sx), srow); lastSy = syy; }
    if (rop >>> 0 !== 0x00cc0020) dst.readRow(y, cc.l, w, drow);
    for (let i = 0; i < w; i++) {
      let rx = Math.floor(((cc.l + i - dx) * sw) / dw);
      if (flipX) rx = sw - 1 - rx;
      const s = srow[rx];
      drow[i] = (rop >>> 0 === 0x00cc0020 ? s : fn(s, drow[i], 0)) & 0xffffff;
    }
    dst.writeRow(y, cc.l, w, drow);
  }
}

/** Bresenham line (excludes the last point, like GDI). */
export function line(surf, clip, x0, y0, x1, y1, color, width = 1) {
  const inClip = (x, y) => x >= clip.l && x < clip.r && y >= clip.t && y < clip.b && x >= 0 && y >= 0 && x < surf.width && y < surf.height;
  const plot = width <= 1 ? (x, y) => { if (inClip(x, y)) surf.setPixel(x, y, color); }
    : (x, y) => { const h = width >> 1; for (let yy = y - h; yy < y - h + width; yy++) for (let xx = x - h; xx < x - h + width; xx++) if (inClip(xx, yy)) surf.setPixel(xx, yy, color); };
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0, y = y0;
  for (let guard = 0; guard < 1000000; guard++) {
    if (x === x1 && y === y1) break;
    plot(x, y);
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/** Filled ellipse inside the rectangle (l,t,r,b), plus outline. */
export function ellipse(surf, clip, l, t, r, b, fill, outline) {
  const cx = (l + r) / 2, cy = (t + b) / 2, rx = (r - l) / 2, ry = (b - t) / 2;
  if (rx <= 0 || ry <= 0) return;
  for (let y = Math.max(t, clip.t, 0); y < Math.min(b, clip.b, surf.height); y++) {
    const dy = (y + 0.5 - cy) / ry;
    const k = 1 - dy * dy;
    if (k < 0) continue;
    const half = rx * Math.sqrt(k);
    const x0 = Math.round(cx - half), x1 = Math.round(cx + half);
    if (fill !== null) fillRect(surf, clip, x0, y, x1, y + 1, fill);
    if (outline !== null) { if (x0 >= clip.l && x0 < clip.r) surf.setPixel(x0, y, outline); if (x1 - 1 >= clip.l && x1 - 1 < clip.r) surf.setPixel(x1 - 1, y, outline); }
  }
  if (outline !== null) {
    // top/bottom rows
    for (let x = Math.max(l, clip.l); x < Math.min(r, clip.r); x++) {
      const dx = (x + 0.5 - cx) / rx; const k = 1 - dx * dx; if (k < 0) continue;
      const half = ry * Math.sqrt(k);
      const y0 = Math.round(cy - half), y1 = Math.round(cy + half) - 1;
      if (y0 >= clip.t && y0 < clip.b) surf.setPixel(x, y0, outline);
      if (y1 >= clip.t && y1 < clip.b) surf.setPixel(x, y1, outline);
    }
  }
}

/** Scanline polygon fill (even-odd). pts: [{x,y}]. */
export function polygon(surf, clip, pts, fill, outline) {
  if (pts.length < 2) return;
  if (fill !== null && pts.length >= 3) {
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    for (let y = Math.max(minY, clip.t, 0); y < Math.min(maxY, clip.b, surf.height); y++) {
      const xs = [];
      const yc = y + 0.5;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) xs.push(a.x + ((yc - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) fillRect(surf, clip, Math.round(xs[i]), y, Math.round(xs[i + 1]), y + 1, fill);
    }
  }
  if (outline !== null) for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; line(surf, clip, a.x, a.y, b.x, b.y, outline); }
}
