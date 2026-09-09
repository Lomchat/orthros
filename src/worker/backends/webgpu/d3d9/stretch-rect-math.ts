/**
 * Rectangle arithmetic of IDirect3DDevice9::StretchRect: a NULL rect means the whole
 * surface, both rects are clipped to their surfaces, and the destination keeps the
 * scale implied by the two rects. Returns null when nothing remains to copy.
 */
export interface StretchRects {
    sx: number; sy: number; sw: number; sh: number;
    dx: number; dy: number; dw: number; dh: number;
}

export type Rect = { left: number; top: number; right: number; bottom: number } | null;

export function resolveStretchRects(
    srcW: number, srcH: number, srcRect: Rect,
    dstW: number, dstH: number, dstRect: Rect,
): StretchRects | null {
    const s = srcRect ?? { left: 0, top: 0, right: srcW, bottom: srcH };
    const d = dstRect ?? { left: 0, top: 0, right: dstW, bottom: dstH };
    if (s.right <= s.left || s.bottom <= s.top || d.right <= d.left || d.bottom <= d.top) return null;
    // Clip the source; move the destination edges by the same fraction so the scale holds.
    const scaleX = (d.right - d.left) / (s.right - s.left);
    const scaleY = (d.bottom - d.top) / (s.bottom - s.top);
    let sl = s.left, st = s.top, sr = s.right, sb = s.bottom;
    let dl = d.left, dt = d.top, dr = d.right, db = d.bottom;
    if (sl < 0) { dl -= sl * scaleX; sl = 0; }
    if (st < 0) { dt -= st * scaleY; st = 0; }
    if (sr > srcW) { dr -= (sr - srcW) * scaleX; sr = srcW; }
    if (sb > srcH) { db -= (sb - srcH) * scaleY; sb = srcH; }
    if (dl < 0) { sl -= dl / scaleX; dl = 0; }
    if (dt < 0) { st -= dt / scaleY; dt = 0; }
    if (dr > dstW) { sr -= (dr - dstW) / scaleX; dr = dstW; }
    if (db > dstH) { sb -= (db - dstH) / scaleY; db = dstH; }
    const sw = Math.round(sr - sl), sh = Math.round(sb - st);
    const dw = Math.round(dr - dl), dh = Math.round(db - dt);
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return null;
    return { sx: Math.round(sl), sy: Math.round(st), sw, sh, dx: Math.round(dl), dy: Math.round(dt), dw, dh };
}
