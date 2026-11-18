// The draw probe's record (src/gfx/draw-probe.js makes it in the renderer, the server keeps it in the telemetry,
// tools/dev/draw-probe.mjs reads it): its limits, the analysis both sides make of it, and the server's check.
//
// What it is for: a frame that looks different under the same commands (the owner's RotWK pause menu on his RTX 4050,
// ANGLE D3D11: the darkening layer fainter one frame in three, in bursts — docs/aotr-play.md "The pause menu's veil")
// is either the game's values (its TEXTUREFACTOR, an animation frame), the render worker's replay of them, a value
// Orthros keeps but does not send again (a stale uniform), or what the GPU makes of the same commands and values. The
// probe records, for a few seconds and at the draws themselves, what each of the frame's last draws did to the picture
// and the values it was drawn with:
// - per frame, a grid of GW x GH native pixels of the draw's render target (one NEAREST blit: each grid point is one
//   pixel of the frame, no filtering) copied before and after each of the last draws, and the presented back buffer;
// - per probed draw: the game's TEXTUREFACTOR as the producer set it (the emulator's device: through the command ring
//   when a render worker draws), as the backend reads it (the device mirror), the program's cached copy before its
//   comparison (P.v.sv.tf) and after, the value last sent to its u_tfactor uniform, whether the state group was looked
//   at; the program, vertex array, buffers and offsets, the index buffer, the render target and its depth attachment,
//   the raster state; the texture matrices of the stages that use one.
// The probe's last phase (CONTROL) copies only the presented frames: a defect the copies between the draws hide shows
// there.
//
// A record: { event: 'draw-probe', v, trigger, gl, size, mode, path, stamps, grid: [GW, GH], rects, frames, metas, vals,
//   tms, pics, summary, notes, took }:
// - `rects`: [x, y, w, h] in grid points (rows from the top of the picture), each RECT x RECT points; `rectKinds`: 'var'
//   (where the presented frames varied most), 'fix' (fixed places);
// - a frame: { f (device frame), t (ms since the first), n (draws), sig, vsig, tf (the values record: d3d8-webgl.js
//   valDraw), fb, ctl (1: control phase), odd (ppm of the grid points that went A-B-A: ODD_PPM), away (ppm away from the
//   median picture), mad (mean absolute difference from it), d: [[draw index, meta index, vals index, tms index (-1
//   none), start, count, vertex base, buffer uploads], ...], p: base64 of uint16 little-endian sums of each rect's
//   luminance (0-255 per point, RECT x RECT points): for each probed draw in `d`'s order its before then its after (2 x
//   rects), then the presented frame's (rects); a control frame's only the presented frame's };
// - `metas`: the distinct descriptions of a probed draw that do not move (program, target, buffers, raster state...);
//   `vals`: the distinct value tuples [tfP, tfM, svBefore, svAfter, sent, flags] (flags: 1 the program has u_tfactor, 2
//   its state group was skipped — the program had seen this state version —, 4 the uniform was sent at this draw, 8 its
//   transform group skipped, 16 the producer's value known); `tms`: the distinct texture matrix sets
//   ([[stage, flags, m11, m12, m21, m22, m31, m32, m41, m42], ...]);
// - `pics`: a few grids as base64 luminance (GW x GH, rows from the top): the reference frame's presented picture, the
//   oddest frames', and before / after of the draws that changed most between them.
export const DRAW_PROBE_VERSION = 1;
/** the grid of native pixels copied per snapshot */
export const GW = 64, GH = 48;
/** a rectangle: RECT x RECT grid points */
export const RECT = 4;
/** the frame's last draws probed */
export const LAST_N = 12;
/** the probed phase and the control phase (presented frames only), ms */
export const PROBE_MS = 2000, CONTROL_MS = 1000;
/** frames kept at most (the probed phase's and the control's) */
export const MAX_FRAMES = 150;
/** the record's size at most (JSON characters): under the 256 KB any telemetry record may weigh on a server without its own check */
export const DRAW_PROBE_MAX_BYTES = 230 * 1024;
export const DRAW_PROBE_POST_MAX_BYTES = DRAW_PROBE_MAX_BYTES + 16 * 1024;
/** a grid point changed: luminance apart by more than T (flicker-probe.js's threshold) */
export const T = 24;
/**
 * A frame is odd when this share of its grid points (ppm) went A-B-A: away by more than T from both the frame before
 * and the frame after, which agree there (within T / 2) — a frame that comes back, not an animation or a scene that moves
 */
export const ODD_PPM = 5000;
/** the fixed rectangles' centres (fractions of the picture) */
const FIXED = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]];
/** rectangles chosen where the presented frames varied most */
const VAR_RECTS = 3;

// ---------------------------------------------------------------- grids
/**
 * One snapshot's grid as luminance, rows from the top of the picture: `px` RGBA (GL rows, bottom first) of an atlas
 * `aw` pixels wide, the snapshot at (ox, oy); `upright`: the target's rows go up (a back buffer) — a texture target is
 * drawn y-flipped, its first GL row is its top.
 */
export function gridLum(px, aw, ox, oy, upright, out = new Uint8Array(GW * GH)) {
  for (let y = 0; y < GH; y++) {
    const gy = oy + (upright ? GH - 1 - y : y);
    let o = 4 * (gy * aw + ox), d = y * GW;
    for (let x = 0; x < GW; x++, o += 4) out[d + x] = (77 * px[o] + 150 * px[o + 1] + 29 * px[o + 2] + 128) >> 8;
  }
  return out;
}
/** a rectangle's luminance sum over a grid */
export function rectSum(g, r) {
  let s = 0;
  for (let y = r[1]; y < r[1] + r[3]; y++) for (let x = r[0]; x < r[0] + r[2]; x++) s += g[y * GW + x];
  return s;
}
/** the fixed rectangles (grid points, from the top) */
export function fixedRects() {
  return FIXED.map(([fx, fy]) => [Math.max(0, Math.min(GW - RECT, Math.round(fx * GW - RECT / 2))), Math.max(0, Math.min(GH - RECT, Math.round(fy * GH - RECT / 2))), RECT, RECT]);
}
/** per point, the median of the grids */
export function medianGrid(grids) {
  const n = grids.length, out = new Uint8Array(GW * GH), col = new Uint8Array(n);
  if (!n) return out;
  for (let p = 0; p < GW * GH; p++) { for (let i = 0; i < n; i++) col[i] = grids[i][p]; col.sort(); out[p] = col[n >> 1]; }
  return out;
}
/** ppm of the grid points away from `ref` by more than T, and the mean absolute difference */
export function gridAway(g, ref) {
  let c = 0, s = 0;
  for (let p = 0; p < GW * GH; p++) { const d = Math.abs(g[p] - ref[p]); s += d; if (d > T) c++; }
  return { ppm: Math.round(c / (GW * GH) * 1e6), mad: Math.round(s / (GW * GH) * 100) / 100 };
}
/**
 * The A-B-A of a frame's grid `b` between its neighbours `a` and `c`: ppm of the points away from both by more than T
 * where they agree within T / 2 (null when a neighbour has no picture: not known); `into`: per point, the largest such
 * difference seen (a variation map).
 */
export function gridAba(a, b, c, into = null) {
  if (!a || !c) return null;
  let n = 0;
  for (let p = 0; p < GW * GH; p++) {
    const ab = Math.abs(b[p] - a[p]), cb = Math.abs(b[p] - c[p]);
    if (ab > T && cb > T && Math.abs(a[p] - c[p]) <= T / 2) { n++; if (into) { const d = Math.min(ab, cb); if (d > into[p]) into[p] = d; } }
  }
  return Math.round(n / (GW * GH) * 1e6);
}
/**
 * The rectangles where the grids varied most from `ref` (each point's largest difference over the frames, summed per
 * RECT x RECT block), at least 2 blocks apart, `k` of them; blocks that never varied are left out.
 */
export function varyingRects(grids, ref, k = VAR_RECTS) {
  const v = new Uint8Array(GW * GH);
  for (const g of grids) for (let p = 0; p < GW * GH; p++) { const d = Math.abs(g[p] - ref[p]); if (d > v[p]) v[p] = d; }
  return topRects(v, k);
}
/** the `k` RECT x RECT blocks of a variation map (per point, 0-255) with the largest sums, at least 2 blocks apart */
export function topRects(v, k = VAR_RECTS) {
  const bw = GW / RECT, bh = GH / RECT, blocks = [];
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) { const s = rectSum(v, [bx * RECT, by * RECT, RECT, RECT]); if (s > T * RECT) blocks.push([s, bx, by]); }
  blocks.sort((a, b) => b[0] - a[0]);
  const out = [];
  for (const [, bx, by] of blocks) {
    if (out.length >= k) break;
    if (out.some(([x, y]) => Math.max(Math.abs(x / RECT - bx), Math.abs(y / RECT - by)) < 2)) continue;
    out.push([bx * RECT, by * RECT, RECT, RECT]);
  }
  return out;
}

// ---------------------------------------------------------------- the record's numbers
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
/** uint16 sums as base64 (little-endian) */
export function packSums(a) { const u = new Uint8Array(a.length * 2); for (let i = 0; i < a.length; i++) { u[2 * i] = a[i] & 0xff; u[2 * i + 1] = a[i] >> 8; } return b64(u); }
export function unpackSums(s) { const u = unb64(s), out = new Uint16Array(u.length >> 1); for (let i = 0; i < out.length; i++) out[i] = u[2 * i] | (u[2 * i + 1] << 8); return out; }
export const packGrid = (g) => b64(g);
export const unpackGrid = (s) => unb64(s);

/**
 * A frame's rectangle figures (unpacked `p`): per probed draw (in `d`'s order) { b: [mean luminance per rect], a: [...] },
 * and the presented frame's means.
 */
export function frameRects(fr, nRects) {
  if (!fr.p) return null;
  const s = unpackSums(fr.p), m = (i) => s[i] / (RECT * RECT), draws = [];
  const nd = fr.ctl ? 0 : fr.d.length;
  for (let j = 0; j < nd; j++) draws.push({ b: Array.from({ length: nRects }, (_, r) => m(j * 2 * nRects + r)), a: Array.from({ length: nRects }, (_, r) => m(j * 2 * nRects + nRects + r)) });
  const o = nd * 2 * nRects;
  return { draws, present: Array.from({ length: nRects }, (_, r) => m(o + r)) };
}

/**
 * What a record says (the page's summary of it, the reader's tables). Per probed draw position (counted from the
 * frame's end: 1 the last draw — the same layer in frames of the same commands): per rect its median before and after
 * over the normal frames, its after / before ratio (`ratio`, where the draw changes the rect: ~0.20 under a black layer
 * of alpha 0.80) and how far each frame's ratio went from it (`ratioSpread`); how far the odd frames' before and after
 * went from the normal frames' beyond the normal frames' own spread (`oddBefore`, `oddAfter`, luminance: an animated
 * layer moves in every frame, not only in the odd ones); its values in the normal and the odd frames. The culprit: in
 * drawing order, the first draw whose after moved in the odd frames while its before did not (`moved`). The verdict
 * names what moved with it: the game's own TEXTUREFACTOR (the producer's), the backend's only (the render worker's
 * replay), the program's cached or sent value (Orthros' uniform cache), or nothing (the same commands and values: GL);
 * or that the picture under the probed draws already differed, or that only the control frames went odd.
 */
export function analyse(rec) {
  const R = rec.rects.length, frames = rec.frames.map((f) => ({ ...f, r: frameRects(f, R) }));
  const isOdd = (f) => f.odd >= ODD_PPM, isNormal = (f) => f.odd !== null && f.odd !== undefined && f.odd < ODD_PPM; // (a frame next to one without pictures: neither)
  const odd = frames.filter(isOdd), normal = frames.filter(isNormal);
  const probed = frames.filter((f) => !f.ctl && f.r), oddP = probed.filter(isOdd), oddC = frames.filter((f) => f.ctl && isOdd(f));
  const pos = new Map();
  for (const f of probed) f.d.forEach((e, j) => { const key = f.n - e[0]; let x = pos.get(key); if (!x) pos.set(key, x = { pos: key, rows: [] }); x.rows.push({ f, j, e }); });
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const devs = (rows, side, r, ref) => rows.map(({ f, j }) => Math.abs(f.r.draws[j][side][r] - ref));
  const draws = [];
  for (const x of [...pos.values()].sort((a, b) => a.pos - b.pos)) {
    const rows = x.rows.filter(({ f, j }) => f.r.draws[j]), nrm = rows.filter(({ f }) => isNormal(f)), odr = rows.filter(({ f }) => isOdd(f)), base = nrm.length ? nrm : rows;
    const perRect = Array.from({ length: R }, (_, r) => {
      const mb = median(base.map(({ f, j }) => f.r.draws[j].b[r])), ma = median(base.map(({ f, j }) => f.r.draws[j].a[r]));
      const covered = mb !== null && Math.abs(ma - mb) >= 2, ratio = covered && mb >= 16 ? ma / mb : null;
      const rs = ratio === null ? [] : rows.map(({ f, j }) => { const d = f.r.draws[j]; return d.b[r] >= 16 ? d.a[r] / d.b[r] : null; }).filter((q) => q !== null);
      const noise = (side, ref) => median(devs(nrm, side, r, ref)) ?? 0, oddDev = (side, ref) => median(devs(odr, side, r, ref)) ?? 0;
      return { before: mb, after: ma, covered, ratio, ratioSpread: rs.length ? Math.max(...rs.map((q) => Math.abs(q - ratio))) : 0,
        beforeSpread: Math.max(0, ...devs(rows, 'b', r, mb)), oddBefore: Math.max(0, oddDev('b', mb) - noise('b', mb)), oddAfter: Math.max(0, oddDev('a', ma) - noise('a', ma)) };
    });
    const cov = perRect.filter((p) => p.covered), rts = cov.filter((p) => p.ratio !== null).map((p) => p.ratio);
    const kind = !cov.length ? 'keeps' : rts.length && rts.every((q) => q < 1) ? 'darkens' : cov.every((p) => p.after > p.before) ? 'adds' : 'changes';
    const set = (rs, i) => [...new Set(rs.map((q) => rec.vals[q.e[2]]?.[i]))].sort((a, b) => a - b);
    const tf = (i) => set(rows, i);
    draws.push({ pos: x.pos, n: rows.length, kind, ratio: median(rts), ratioSpread: Math.max(0, ...cov.map((p) => p.ratioSpread)), beforeSpread: Math.max(0, ...perRect.map((p) => p.beforeSpread)),
      oddBefore: Math.max(0, ...perRect.map((p) => p.oddBefore)), oddAfter: Math.max(0, ...perRect.map((p) => p.oddAfter)), perRect,
      metas: new Set(rows.map((q) => q.e[1])).size, tfP: tf(0), tfM: tf(1), svBefore: tf(2), sent: tf(4),
      odd: { tfP: set(odr, 0), tfM: set(odr, 1), sv: set(odr, 2), sent: set(odr, 4) }, normal: { tfP: set(nrm, 0), tfM: set(nrm, 1), sv: set(nrm, 2), sent: set(nrm, 4) } });
  }
  // (in drawing order — the farthest from the end first —: the first draw whose result moved in the odd frames while what it drew over did not)
  const order = [...draws].sort((a, b) => b.pos - a.pos), moved = order.filter((d) => d.perRect.some((p) => p.oddAfter >= 8 && p.oddBefore < 4));
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]), list = (a) => a.map(hex).join(' / ');
  let verdict;
  if (!odd.length) verdict = 'no odd frame: no presented frame went A-B-A between its neighbours (the defect did not happen while the probe ran)';
  else if (!oddP.length && oddC.length) verdict = 'odd frames only in the control phase: the copies between the draws hid the defect (GPU timing, or a hazard the copies break)';
  else if (!oddP.length) verdict = "odd frames, none with its draws' figures (pictures lost): nothing to compare";
  else if (!moved.length) verdict = order.length && order[0].oddBefore >= 4 ? `the picture under the probed draws already differed in the odd frames (by ${order[0].oddBefore.toFixed(0)} in luminance before draw ${order[0].pos} from the end): an earlier draw or the scene` : 'odd frames, but no probed draw changed its result in them: the difference comes after the draws (the present, the page) or from draws not probed';
  else {
    const top = moved[0], o = top.odd, n = top.normal, what = `draw ${top.pos} from the end (${top.kind}${top.ratio !== null ? `, after/before ${top.ratio.toFixed(2)} in normal frames, moving by up to ${top.ratioSpread.toFixed(2)}` : ''}; in the odd frames its result moved by ${top.oddAfter.toFixed(0)} over the same picture)`;
    if (!same(o.tfP, n.tfP)) verdict = `${what}: the game's own TEXTUREFACTOR changed with it (producer ${list(n.tfP)} in normal frames, ${list(o.tfP)} in odd ones) — the game's values`;
    else if (!same(o.tfM, n.tfM)) verdict = `${what}: the producer's TEXTUREFACTOR stayed ${list(n.tfP)} but the backend read ${list(o.tfM)} in the odd frames — the render worker's replay`;
    else if (!same(o.sv, n.sv) || !same(o.sent, n.sent)) verdict = `${what}: same TEXTUREFACTOR (${list(n.tfM)}) but the program's cached / sent value differed in the odd frames (cache ${list(o.sv)}, sent ${list(o.sent)}; normal: ${list(n.sv)}, ${list(n.sent)}) — Orthros' uniform cache`;
    else verdict = `${what} with the same values in every frame (TEXTUREFACTOR ${list(n.tfM)}, producer ${list(n.tfP)}, uniform last sent ${list(n.sent)}, ${top.metas} draw description${top.metas > 1 ? 's' : ''}) — what GL makes of the same commands and values`;
  }
  return { frames: frames.length, probed: probed.length, control: frames.length - probed.length, odd: odd.length, oddProbed: oddP.length, oddControl: oddC.length, normal: normal.length, draws, moved: moved.map((d) => d.pos), verdict };
}
const hex = (v) => (v === null || v === undefined ? '-' : (v >>> 0).toString(16));

/** the record cut to `max` characters: its pictures dropped (last first), then the frames' rect figures from the end */
export function fitDrawProbe(rec, max = DRAW_PROBE_MAX_BYTES) {
  const size = () => JSON.stringify(rec).length;
  rec.cut = rec.cut ?? [];
  while (size() > max && rec.pics?.length) { rec.pics.pop(); if (!rec.cut.includes('pictures')) rec.cut.push('pictures'); }
  let n = 0;
  for (let i = rec.frames.length - 1; i >= 0 && size() > max; i--) if (rec.frames[i].p) { rec.frames[i].p = null; n++; }
  if (n) rec.cut.push(`rect figures of ${n} frames`);
  while (size() > max && rec.frames.length) { rec.frames.pop(); if (!rec.cut.includes('frames')) rec.cut.push('frames'); }
  return rec;
}

// ---------------------------------------------------------------- the server's check
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** A draw probe record as received: its known fields kept, the session and the strings checked. { ok, rec } or { ok: false, error }. */
export function sanitizeDrawProbe(r) {
  if (!r || typeof r !== 'object' || r.event !== 'draw-probe') return { ok: false, error: 'not a draw probe' };
  if (r.v !== DRAW_PROBE_VERSION) return { ok: false, error: 'unknown version' };
  if (typeof r.session !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(r.session)) return { ok: false, error: 'bad session' };
  if (!Array.isArray(r.frames) || r.frames.length > MAX_FRAMES) return { ok: false, error: 'bad frames' };
  if (!r.frames.every((f) => f && typeof f === 'object' && (f.p === null || f.p === undefined || (typeof f.p === 'string' && B64.test(f.p))))) return { ok: false, error: 'bad frame figures' };
  if (r.pics !== undefined && (!Array.isArray(r.pics) || r.pics.length > 16 || !r.pics.every((p) => p && typeof p.img === 'string' && p.img.length <= 8192 && B64.test(p.img)))) return { ok: false, error: 'bad pictures' };
  const rec = { event: 'draw-probe', v: r.v, session: r.session };
  for (const k of ['game', 'build', 'version', 'options', 'page', 'trigger', 'gl', 'size', 'mode', 'path', 'stamps', 'grid', 'lastN', 'rects', 'rectKinds', 'frames', 'metas', 'vals', 'tms', 'pics', 'summary', 'cut', 'notes', 'took']) if (r[k] !== undefined) rec[k] = r[k];
  if (rec.game !== undefined && rec.game !== null) rec.game = String(rec.game).slice(0, 120);
  return { ok: true, rec };
}
