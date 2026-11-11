// The pixel work of D3DX's texture loaders (d3dx9.js) as functions of their inputs: an image's levels converted, a
// level generated from the one above it, RGBA pixels written into a surface's rectangle, a mip chain filtered. The game
// thread runs them (the synchronous path) or a texture helper does (d3dx9-tex-jobs.js, docs/api-layer.md "D3DX texture
// jobs"): the same functions on the same bytes, in guest memory shared with the helper — the same results.
// A level is { mem (guest address, 0: none), bytes, fmt, width, height, pitch } (a Surface, or its description).
import { FMT, surfaceBytes, surfacePitch } from './d3d8.js';
import { toRgba, toRgbaRows, fromRgba, resizeRgba, applyColorKey, isDxt, mipChain, mipChainReady } from './d3dx9-image.js';

/** D3DX_FILTER: low byte = filter kind (1 NONE, 2 POINT, 3 LINEAR, 4 TRIANGLE, 5 BOX) */
export const FILTER_POINT = 2;

/** can `fmt` be written from RGBA (fromRgba gives bytes)? — decided before a job is handed out, as its result would */
export const encodable = (fmt) => fromRgba(fmt, new Uint8Array(4), 1, 1) !== null;

/** level `i` of `im` (face f) converted to `fmt` at w x h x d (null when impossible) */
export function levelData(im, f, i, fmt, w, h, d, filter, colorKey) {
  const src = im.images[f][Math.min(i, im.mips - 1)];
  const sw = Math.max(1, im.width >> Math.min(i, im.mips - 1)), sh = Math.max(1, im.height >> Math.min(i, im.mips - 1)), sd = Math.max(1, im.depth >> Math.min(i, im.mips - 1));
  if (i < im.mips && sw === w && sh === h && sd === d && fmt === im.fmt && !colorKey) return src;
  // (a 2D level with the box filter: decoded, resized and encoded in the kernels' memory — the loop's bytes)
  if (d === 1 && sd === 1 && !colorKey && (filter & 0xff) !== FILTER_POINT && mipChainReady(fmt)) { const r = mipChain(fmt, src, sw, sh, [[w, h]], im.fmt); if (r) return r[0]; }
  // through RGBA8 (slice by slice for volumes)
  const out = new Uint8Array(surfaceBytes(fmt, w, h) * d);
  for (let z = 0; z < d; z++) {
    const sz = Math.min(sd - 1, Math.floor(z * sd / d)), sliceBytes = surfaceBytes(im.fmt, sw, sh);
    let rgba = toRgba(im.fmt, src.subarray(sz * sliceBytes, (sz + 1) * sliceBytes), sw, sh);
    if (colorKey) rgba = applyColorKey(rgba.slice(), colorKey);
    rgba = resizeRgba(rgba, sw, sh, w, h, (filter & 0xff) === FILTER_POINT);
    const enc = fromRgba(fmt, rgba, w, h);
    if (!enc) return null;
    out.set(enc, z * surfaceBytes(fmt, w, h));
  }
  return out;
}

/**
 * The 2D levels of a texture created from an image (D3DXCreateTextureFromFileInMemoryEx...), one chain (`levels`, a
 * texture's or a cube face's): levels the file has converted from it, the others generated from the level above as
 * written (D3DX's mip filter). `fill(i, data)` writes level i. (`w`, `h`: level 0's size.)
 */
export function fillChainFromImage(mem, im, srcFace, fmt, levels, w, h, o, fill) {
  for (let i = 0; i < levels.length; i++) {
    const lw = Math.max(1, w >> i), lh = Math.max(1, h >> i);
    let data = i < im.mips ? levelData(im, srcFace, i, fmt, lw, lh, 1, o.filter, o.colorKey) : null;
    if (!data) {
      const prevW = Math.max(1, w >> (i - 1)), prevH = Math.max(1, h >> (i - 1)), prev = levels[i - 1];
      if (prev && prev.mem) {
        // (from the previous level's data as written: decoded, resized, encoded — in the kernels' memory for a box filter)
        const kernels = (o.mipFilter & 0xff) !== FILTER_POINT && mipChainReady(fmt) ? mipChain(fmt, mem.bytes(prev.mem, prev.bytes), prevW, prevH, [[lw, lh]], fmt) : null;
        data = kernels ? kernels[0] : fromRgba(fmt, resizeRgba(toRgba(fmt, mem.bytes(prev.mem, prev.bytes), prevW, prevH), prevW, prevH, lw, lh, (o.mipFilter & 0xff) === FILTER_POINT), lw, lh);
      } else data = levelData(im, srcFace, Math.min(i, im.mips - 1), fmt, lw, lh, 1, o.filter, o.colorKey);
    }
    if (data) fill(i, data);
  }
}

/**
 * RGBA8 pixels (rw x rh) into `dst` (memory allocated) at rectangle dr (resized to it), converted to its format: only the
 * rectangle's texels (uncompressed) or blocks (a rectangle on whole 4x4 blocks) written, else the whole surface
 * re-encoded. Returns null when the format cannot be written, else { whole, rgba } — whole: the surface was written as
 * a whole (its RGBA8 in `rgba` for a block-compressed format, which D3DXFilterTexture builds the mips from).
 */
export function blitInto(mem, dst, dr, rgba, rw, rh, filter, colorKey) {
  if (colorKey) rgba = applyColorKey(rgba.slice(), colorKey);
  const dw = dr.r - dr.l, dh = dr.b - dr.t;
  const px = resizeRgba(rgba, rw, rh, dw, dh, (filter & 0xff) === FILTER_POINT || (filter & 0xff) === 1);
  const base = dst.mem;
  const full = dr.l === 0 && dr.t === 0 && dw === dst.width && dh === dst.height;
  // (the other texels untouched: decoding and re-encoding the whole surface per tile made terrain loads quadratic)
  const dxt = isDxt(dst.fmt), aligned = !dxt || ((dr.l | dr.t) % 4 === 0 && (dw % 4 === 0 || dr.r === dst.width) && (dh % 4 === 0 || dr.b === dst.height));
  if (!full && aligned) {
    const enc = fromRgba(dst.fmt, px, dw, dh);
    if (enc) {
      const blk = dxt ? 4 : 1, rows = Math.ceil(dh / blk), rowBytes = dxt ? Math.ceil(dw / 4) * (dst.fmt === FMT.DXT1 ? 8 : 16) : surfacePitch(dst.fmt, dw);
      const unitX = dxt ? (dst.fmt === FMT.DXT1 ? 8 : 16) / 4 : surfacePitch(dst.fmt, 1); // (bytes per texel column: a DXT block row covers 4 texels)
      for (let y = 0; y < rows; y++) mem.writeBytes(base + (dr.t / blk + y) * dst.pitch + dr.l * unitX, enc.subarray(y * rowBytes, (y + 1) * rowBytes));
      return { whole: false, rgba: null };
    }
  }
  const cur = full ? null : toRgba(dst.fmt, mem.bytes(base, dst.bytes), dst.width, dst.height);
  let all = px;
  if (!full) { for (let y = 0; y < dh; y++) cur.set(px.subarray(y * dw * 4, (y + 1) * dw * 4), ((dr.t + y) * dst.width + dr.l) * 4); all = cur; }
  const enc = fromRgba(dst.fmt, all, dst.width, dst.height);
  if (!enc) return null;
  mem.writeBytes(base, enc.subarray(0, Math.min(enc.length, dst.bytes)));
  return { whole: true, rgba: isDxt(dst.fmt) ? all : null };
}
/** would blitInto keep the RGBA (a whole write of a block-compressed surface)? (the formats encodable) */
export function blitKeepsRgba(dst, dr) {
  const dw = dr.r - dr.l, dh = dr.b - dr.t, full = dr.l === 0 && dr.t === 0 && dw === dst.width && dh === dst.height;
  if (!isDxt(dst.fmt)) return false;
  const aligned = (dr.l | dr.t) % 4 === 0 && (dw % 4 === 0 || dr.r === dst.width) && (dh % 4 === 0 || dr.b === dst.height);
  return full || !aligned;
}

/** RGBA8 of the rectangle `sr` of an image in guest memory (`fmt`, rows `pitch` bytes apart), read in place */
export function sourceRgba(mem, fmt, addr, sr, pitch, sw, sh) {
  if (isDxt(fmt)) { const bw = Math.ceil(sw / 4), bh = Math.ceil(sh / 4), unit = fmt === FMT.DXT1 ? 8 : 16, raw = new Uint8Array(bw * bh * unit); for (let y = 0; y < bh; y++) raw.set(mem.bytes(addr + ((sr.t >> 2) + y) * pitch + (sr.l >> 2) * unit, bw * unit), y * bw * unit); return toRgba(fmt, raw, sw, sh); }
  const bpp = surfacePitch(fmt, 1);
  return toRgbaRows(fmt, mem.bytes(addr + sr.t * pitch + sr.l * bpp, (sh - 1) * pitch + sw * bpp), sw, sh, pitch);
}
/** the guest bytes sourceRgba reads: [start, length] (a copy of them is all a job needs) */
export function sourceSpan(fmt, sr, pitch, sw, sh) {
  if (isDxt(fmt)) { const unit = fmt === FMT.DXT1 ? 8 : 16, bh = Math.ceil(sh / 4); return [(sr.t >> 2) * pitch + (sr.l >> 2) * unit, (bh - 1) * pitch + Math.ceil(sw / 4) * unit]; }
  const bpp = surfacePitch(fmt, 1);
  return [sr.t * pitch + sr.l * bpp, (sh - 1) * pitch + sw * bpp];
}

/**
 * D3DXFilterTexture's 2D work on one chain of levels: the levels below `src` regenerated from the first one holding data
 * (all at once through the kernels — mipChain — for a box filter and one format; else level after level, each from the
 * RGBA of the one above). `cacheOf(level)`: the RGBA a level was encoded from, when D3DX kept it; `fill(level, data)`
 * writes a level. The levels filled are always lv[first..] (filledFrom), the formats encodable.
 */
export function filterChain(mem, lv, src, point, cacheOf, fill) {
  let first = src + 1;
  while (first < lv.length && !lv[first - 1].mem) first++;
  if (!point && first < lv.length && lv.slice(first - 1).every((s) => s.fmt === lv[first].fmt)) {
    const p = lv[first - 1], sizes = lv.slice(first).map((s) => [s.width, s.height]), cached = cacheOf(p);
    // (the source level's RGBA: kept by the load, else its data unpacked by the kernels, else decoded here)
    const encs = !mipChainReady(p.fmt) ? null : cached ? mipChain(p.fmt, cached, p.width, p.height, sizes)
      : isDxt(p.fmt) ? mipChain(p.fmt, toRgba(p.fmt, mem.bytes(p.mem, p.bytes), p.width, p.height), p.width, p.height, sizes)
        : mipChain(p.fmt, mem.bytes(p.mem, p.bytes), p.width, p.height, sizes, p.fmt);
    if (encs) { for (let i = 0; i < encs.length; i++) fill(lv[first + i], encs[i]); return; }
  }
  let rgba = null; // (the level just filtered, as RGBA: the next one comes from it rather than from its re-encoded form)
  for (let i = src + 1; i < lv.length; i++) {
    const p = lv[i - 1], s = lv[i];
    if (!p.mem) { rgba = null; continue; }
    const from = rgba ?? cacheOf(p) ?? toRgba(p.fmt, mem.bytes(p.mem, p.bytes), p.width, p.height);
    rgba = resizeRgba(from, p.width, p.height, s.width, s.height, point);
    const enc = fromRgba(s.fmt, rgba, s.width, s.height);
    if (enc) fill(s, enc); else rgba = null;
  }
}
/** the first level filterChain writes (every one after it too, the formats encodable) — lv.length: none */
export function filledFrom(lv, src) { let first = src + 1; while (first < lv.length && !(lv[first - 1]._mem ?? lv[first - 1].mem)) first++; return first; } // (_mem: a Surface's, read without waiting for its job)

