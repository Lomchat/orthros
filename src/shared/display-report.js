// A player's display report (the frame's "Signaler un problème d'affichage" / "Report a display problem", Ctrl+Shift+F:
// src/web/shell.js) — what was drawn and what was shown during REPORT_MS, sent once per click as one telemetry record:
// - `bb`, the back-buffer strip (src/gfx/frame-report.js, in the renderer: the render worker, or the emulator's worker
//   with ?glworker=0): every presented back buffer downscaled, its device frame, present time, the framebuffer and
//   back-buffer surface it was blitted from, the frame's command signature (d3d8-webgl.js sigMix);
// - `screen`, the screen strip (src/web/screen-report.js, in the page): what the page's game canvases held at every
//   requestAnimationFrame — the visible ones drawn in their order —, which canvas was visible / on top with its size and
//   CSS, the frames the page received (layer, size, device frame when the render worker says it) and the page's events.
// This module: the record's limits, a strip's pictures cut to fit (fitStrip), a strip's analysis (frame-to-frame
// change, A-B-A and A-B-B-A pixels: stripSteps), the two strips aligned by time (alignStrips: which back buffer each
// screen picture shows, whether the screen showed something no back buffer had or went back to an older one) and the
// server's check (sanitizeDisplayReport). tools/dev/flicker-report.mjs reads the records.
//
// A record: { event: 'display-report', v, id, session, game, build, options, page, at (server), bb, screen, notes }; a
// strip: { t0 (epoch ms: performance.timeOrigin + now() of its thread), size: [w, h] (the frames'), img: [w, h] (its
// pictures'), q, frames: [{ t (ms since t0), img (index into images; -1: picture dropped by the cuts), ... }], images:
// [base64 JPEG] (each distinct picture once: frames showing the same pixels share it), analysis, cut, notes, took }.
export const DISPLAY_REPORT_VERSION = 1;
/** the recording window (ms) */
export const REPORT_MS = 2000;
/** the pictures' size at most (the frame's aspect kept) */
export const REPORT_IMG_W = 320, REPORT_IMG_H = 180;
/** frames per strip at most: 2 s of a 120 fps game; 2 s of rAFs on a 150 Hz screen (a faster one: the window shortened) */
export const BB_MAX_FRAMES = 240, SCREEN_MAX_FRAMES = 300;
/** each strip's size at most once its pictures are encoded (JSON characters); the record's, with the page's fields */
export const STRIP_MAX_BYTES = 480 * 1024, REPORT_MAX_BYTES = 2 * STRIP_MAX_BYTES + 48 * 1024;
/** what the server takes for one report POST */
export const REPORT_POST_MAX_BYTES = REPORT_MAX_BYTES + 16 * 1024;
/** one report per session in this time (ms): the page's button and the server both keep it */
export const REPORT_GAP_MS = 60_000;
/** a pixel changed between two pictures: its luminance moved by more than T (0-255; flicker-probe.js's threshold) */
export const T = 24;

// ---------------------------------------------------------------- pictures
/** RGBA pixels' luminance (0-255, Rec. 601 weights) */
export function lumOf(px, w, h) {
  const n = w * h, l = new Uint8Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) l[i] = (77 * px[o] + 150 * px[o + 1] + 29 * px[o + 2] + 128) >> 8;
  return l;
}
/** RGBA pixels at half size (2 x 2 boxes; an odd last row / column alone) */
export function halve(px, w, h) {
  const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1), out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const x0 = 2 * x, y0 = 2 * y, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), o = 4 * (y * W + x);
    for (let c = 0; c < 4; c++) out[o + c] = (px[4 * (y0 * w + x0) + c] + px[4 * (y0 * w + x1) + c] + px[4 * (y1 * w + x0) + c] + px[4 * (y1 * w + x1) + c] + 2) >> 2;
  }
  return { px: out, w: W, h: H };
}
/** a byte array's words (its own buffer when aligned, else a copy) */
const words = (px) => ((px.byteOffset & 3) === 0 ? new Int32Array(px.buffer, px.byteOffset, px.byteLength >> 2) : new Int32Array(new Uint8Array(px).buffer, 0, px.byteLength >> 2));
/** a 32-bit hash of bytes (FNV-style over words): pictures told apart before a compare */
export function hashPixels(px) {
  let h = 0x811c9dc5 ^ px.length;
  const w = words(px);
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 0x01000193);
  for (let k = w.length << 2; k < px.length; k++) h = Math.imul(h ^ px[k], 0x01000193);
  return h >>> 0;
}
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  const x = words(a), y = words(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  for (let k = x.length << 2; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}
/** Distinct pictures: `add(px)` returns the index of an equal picture kept before, or keeps this one (`list`). */
export function pictureSet() {
  const list = [], byHash = new Map();
  return {
    list,
    add(px) {
      const h = hashPixels(px), same = byHash.get(h);
      if (same) for (const i of same) if (sameBytes(list[i], px)) return i;
      list.push(px); if (same) same.push(list.length - 1); else byHash.set(h, [list.length - 1]);
      return list.length - 1;
    },
  };
}

/** the sizes a strip's pictures are tried at: JPEG qualities, then half size, then fewer pictures */
const FIT_STEPS = [[0.7, 1], [0.55, 1], [0.4, 1], [0.3, 1], [0.5, 0.5], [0.35, 0.5]];
const sizeOf = (x) => JSON.stringify(x).length;
/**
 * The strip's distinct pictures (`pics`: RGBA, `w` x `h`) encoded into `strip.images` until the strip fits `max`
 * characters: JPEG quality 0.7 down to 0.3, then half size; still over, the last pictures (by first use) dropped — the
 * frames that showed them keep their figures, `img` -1 —, each step named in `strip.cut`. `encode(pics, w, h, q)`
 * resolves to base64 strings (flicker-capture.js encodeJpegs in a browser).
 */
export async function fitStrip(strip, pics, w, h, encode, max = STRIP_MAX_BYTES) {
  strip.cut = strip.cut ?? [];
  let half = null;
  for (const [q, s] of FIT_STEPS) {
    if (s < 1 && !half) half = pics.map((p) => halve(p, w, h));
    const imgs = s < 1 ? half.map((x) => x.px) : pics, iw = s < 1 ? half[0]?.w ?? w : w, ih = s < 1 ? half[0]?.h ?? h : h;
    strip.images = await encode(imgs, iw, ih, q); strip.q = q; strip.img = [iw, ih];
    if (sizeOf(strip) <= max) return strip;
    strip.cut.push(`q${q}${s < 1 ? ' half' : ''}`);
  }
  // (fewer pictures: the first ones kept, as the frames first showed them)
  const rest = sizeOf({ ...strip, images: [] }), lens = strip.images.map((s) => s.length + 3);
  let keep = 0, sum = rest; while (keep < lens.length && sum + lens[keep] <= max) sum += lens[keep++];
  strip.cut.push(`pictures after ${keep} of ${lens.length} dropped`);
  strip.images = strip.images.slice(0, keep);
  for (const f of strip.frames) if (f.img >= keep) f.img = -1;
  return strip;
}

// ---------------------------------------------------------------- a strip's analysis
/**
 * A strip's frames compared (a generator: it yields between frames — runSliced in a page; drain elsewhere). `lums`:
 * the distinct pictures' luminance (w x h), `seq`: each frame's picture index (-1: none). Per frame, in parts per
 * million of the picture's pixels: `chg` changed since the previous frame; `aba` went A-B-A over the last three frames
 * (|a-b| > T, |b-c| > T, |a-c| < T/3), `still` those of them whose surroundings (8 points 2 pixels away) are the same in
 * the first and the third (flicker where nothing moved — a scroll's chance A-B-A is not still: flicker-probe.js);
 * `abba` went A-B-B-A over the last four (a picture held two frames then back: a 30 fps game's alternation on a 60 Hz
 * screen). `exact`: frames whose picture is the one of two frames before and not the previous one's (by identity), and
 * `seq` with repeats collapsed (the pictures in the order they were shown: '0 1 0 1' is an alternation).
 */
export function* stripSteps(lums, seq, w, h) {
  const n = seq.length, N = w * h, chg = new Array(n).fill(null), aba = new Array(n).fill(null), still = new Array(n).fill(null), abba = new Array(n).fill(null);
  const pairs = new Map(), ppm = (c) => Math.round(c / N * 1e6);
  const pair = (i, j) => {
    if (i === j) return 0;
    const k = i < j ? `${i},${j}` : `${j},${i}`;
    let v = pairs.get(k);
    if (v === undefined) { const a = lums[i], b = lums[j]; let c = 0; for (let p = 0; p < N; p++) if (Math.abs(a[p] - b[p]) > T) c++; pairs.set(k, v = ppm(c)); }
    return v;
  };
  const S = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2]], T3 = T / 3;
  for (let k = 0; k < n; k++) {
    const C = seq[k];
    if (C < 0 || !lums[C]) { yield; continue; }
    if (k >= 1 && seq[k - 1] >= 0 && lums[seq[k - 1]]) chg[k] = pair(seq[k - 1], C);
    if (k >= 2 && seq[k - 2] >= 0 && seq[k - 1] >= 0 && lums[seq[k - 2]] && lums[seq[k - 1]]) {
      const A = seq[k - 2], B = seq[k - 1];
      if (A === B || B === C) { aba[k] = 0; still[k] = 0; }
      else if (A === C) { aba[k] = still[k] = pair(A, B); } // (the same picture back: every changed pixel went back, and nothing around it moved)
      else {
        const a = lums[A], b = lums[B], c = lums[C];
        let x = 0, s = 0;
        for (let y = 0; y < h; y++) for (let q = 0; q < w; q++) {
          const p = y * w + q;
          if (Math.abs(a[p] - b[p]) <= T || Math.abs(b[p] - c[p]) <= T || Math.abs(a[p] - c[p]) >= T3) continue;
          x++;
          let ok = true;
          for (const [dx, dy] of S) { const qx = Math.min(w - 1, Math.max(0, q + dx)), qy = Math.min(h - 1, Math.max(0, y + dy)), r = qy * w + qx; if (Math.abs(a[r] - c[r]) >= T3) { ok = false; break; } }
          if (ok) s++;
        }
        aba[k] = ppm(x); still[k] = ppm(s);
      }
    }
    if (k >= 3 && seq[k - 3] >= 0 && seq[k - 2] >= 0 && seq[k - 1] >= 0 && lums[seq[k - 3]] && lums[seq[k - 2]] && lums[seq[k - 1]]) {
      const A = seq[k - 3], B = seq[k - 2], Cc = seq[k - 1], D = C;
      if (A === B || Cc === D) abba[k] = 0;
      else if (B === Cc && A === D) abba[k] = pair(A, B);
      else {
        const a = lums[A], b = lums[B], c = lums[Cc], d = lums[D];
        let x = 0;
        for (let p = 0; p < N; p++) if (Math.abs(a[p] - b[p]) > T && Math.abs(b[p] - c[p]) < T3 && Math.abs(c[p] - d[p]) > T && Math.abs(a[p] - d[p]) < T3) x++;
        abba[k] = ppm(x);
      }
    }
    yield;
  }
  let exact = 0; const runs = [];
  for (let k = 0; k < n; k++) { if (k >= 2 && seq[k] >= 0 && seq[k] === seq[k - 2] && seq[k] !== seq[k - 1]) exact++; if (!runs.length || runs[runs.length - 1] !== seq[k]) runs.push(seq[k]); }
  const vals = (a) => a.filter((v) => v !== null), mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null), max = (a) => (a.length ? Math.max(...a) : null);
  const over = (a, lim) => a.filter((v) => v >= lim).length;
  const summary = {
    frames: n, pictures: lums.filter(Boolean).length, chgMean: mean(vals(chg)), chgMax: max(vals(chg)),
    abaMax: max(vals(aba)), stillMax: max(vals(still)), stillFrames: over(vals(still), 1000), abbaMax: max(vals(abba)), abbaFrames: over(vals(abba), 1000),
    exact, runs: runs.length, seq: runs.slice(0, 300).join(' '),
  };
  return { chg, aba, still, abba, summary };
}
/** stripSteps run to its end */
export function stripAnalysis(lums, seq, w, h) { const g = stripSteps(lums, seq, w, h); for (;;) { const r = g.next(); if (r.done) return r.value; } }

// ---------------------------------------------------------------- the two strips aligned
/** luminance `l` (w x h) resampled to W x H (nearest) */
export function resampleLum(l, w, h, W, H) {
  if (w === W && h === H) return l;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / H)); for (let x = 0; x < W; x++) out[y * W + x] = l[sy * w + Math.min(w - 1, Math.floor((x + 0.5) * w / W))]; }
  return out;
}
/**
 * Which back buffer each screen picture shows. Per screen frame whose picture (or device frame) differs from the
 * previous screen frame's:
 * - when the page knew the device frame its top canvas held (`df`: the render worker names each bitmap), that frame
 *   (`by: 'frame'`), compared with the picture: `unmatched` beyond `match` ppm (the canvas held something else than the
 *   frame it was handed); `other`: another back buffer of the window is clearly closer (half the difference, and 0.05 %
 *   of the pixels less) — `back` when it is older (the canvas showed an earlier frame's picture);
 * - else by the pictures alone (`by: 'pixels'`): among the back buffers presented in the `back` ms before it (and up to
 *   `ahead` ms after: the threads' clocks), the newest whose difference is within a tolerance of the smallest
 *   (consecutive frames can differ by a few pixels, under the pictures' noise); `unmatched` when even the closest is
 *   beyond `match` ppm (the screen showed what no back buffer had), `back` when it is older than the previous one's.
 * `diff`: pixels apart by more than T (ppm); `mad`: the mean absolute luminance difference; `lag`: screen time - present
 * time; `none`: no back buffer recorded in that time (outside the renderer's window: not compared). `bb` / `screen`: the
 * strips' frames with absolute times (`at`: t0 + t) and luminance pictures already at a common size w x h.
 */
export function alignStrips(bb, screen, w, h, { back = 600, ahead = 8, match = 20000 } = {}) {
  const N = w * h, cache = new Map(), out = [], byF = new Map();
  bb.frames.forEach((b, j) => { if (Number.isFinite(b.f)) byF.set(b.f, j); });
  const cmp = (si, bi) => {
    const key = `${si},${bi}`;
    let v = cache.get(key);
    if (!v) { const sl = screen.lums[si], bl = bb.lums[bi]; let c = 0, s = 0; for (let p = 0; p < N; p++) { const d = Math.abs(sl[p] - bl[p]); s += d; if (d > T) c++; } cache.set(key, v = { diff: Math.round(c / N * 1e6), mad: Math.round(s / N * 100) / 100 }); }
    return v;
  };
  const has = (j) => j !== undefined && bb.frames[j].img >= 0 && !!bb.lums[bb.frames[j].img];
  // (past the last back buffer by more than a slow frame: outside the renderer's window)
  const lastAt = bb.frames.length ? bb.frames[bb.frames.length - 1].at : -Infinity;
  let prev = null;
  screen.frames.forEach((f, k) => {
    if (f.img < 0 || !screen.lums[f.img]) return;
    const df = Number.isFinite(f.df) ? f.df : null;
    if (prev && f.img === prev.img && df === prev.df) { out.push({ ...prev, k, t: f.at, same: true }); return; }
    if ((df !== null && !byF.has(df) && f.at > lastAt) || f.at > lastAt + 100) { const row = { k, t: f.at, img: f.img, df, none: true, back: false, unmatched: false }; out.push(row); prev = row; return; }
    // (the closest back buffers by the pictures: the smallest difference, then the newest within its tolerance)
    const cands = [];
    for (let j = 0; j < bb.frames.length; j++) { const b = bb.frames[j]; if (has(j) && b.at <= f.at + ahead && b.at >= f.at - back) cands.push({ j, ...cmp(f.img, b.img) }); }
    let best = null;
    if (cands.length) { const min = Math.min(...cands.map((c) => c.diff)), tol = Math.max(300, min / 4); for (const c of cands) if (c.diff <= min + tol && (!best || c.j > best.j)) best = c; }
    const jdf = df !== null ? byF.get(df) : undefined;
    const row = { k, t: f.at, img: f.img, df };
    if (has(jdf)) {
      const r = cmp(f.img, bb.frames[jdf].img);
      Object.assign(row, { by: 'frame', j: jdf, diff: r.diff, mad: r.mad, unmatched: r.diff > match });
      const closest = cands.reduce((m, c) => (!m || c.diff < m.diff ? c : m), null);
      if (closest && closest.j !== jdf && closest.diff * 2 + 500 < r.diff) { row.other = closest.j; row.otherDiff = closest.diff; row.back = closest.j < jdf; }
    } else if (best) Object.assign(row, { by: 'pixels', j: best.j, diff: best.diff, mad: best.mad, unmatched: best.diff > match });
    else row.none = true;
    if (row.j !== undefined) { row.f = bb.frames[row.j].f ?? null; row.lag = Math.round((f.at - bb.frames[row.j].at) * 10) / 10; }
    if (row.by === 'pixels') row.back = !!(prev && Number.isFinite(prev.j) && row.j < prev.j && !row.unmatched);
    row.back = !!row.back; row.unmatched = !!row.unmatched;
    out.push(row); prev = row;
  });
  const own = out.filter((r) => !r.same), lags = own.filter((r) => Number.isFinite(r.lag)).map((r) => r.lag).sort((a, b) => a - b);
  return { rows: out, summary: { shown: own.length, byFrame: own.filter((r) => r.by === 'frame').length, none: own.filter((r) => r.none).length, unmatched: own.filter((r) => r.unmatched).length,
    other: own.filter((r) => r.other !== undefined).length, back: own.filter((r) => r.back).length, lagMedian: lags.length ? lags[lags.length >> 1] : null, diffMax: own.reduce((m, r) => Math.max(m, r.diff ?? 0), 0) } };
}

// ---------------------------------------------------------------- the server's check
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const STRIP_FIELDS = ['t0', 'size', 'img', 'q', 'frames', 'images', 'analysis', 'cut', 'notes', 'took', 'gl', 'info', 'layers', 'events', 'arrivals', 'page'];
/**
 * A report as received: its known fields kept (the size limit bounds each), the session, the strips' frame counts and
 * pictures checked. { ok: true, rec } or { ok: false, error }.
 */
export function sanitizeDisplayReport(r) {
  if (!r || typeof r !== 'object' || r.event !== 'display-report') return { ok: false, error: 'not a display report' };
  if (r.v !== DISPLAY_REPORT_VERSION) return { ok: false, error: 'unknown version' };
  if (typeof r.session !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(r.session)) return { ok: false, error: 'bad session' };
  const strip = (s, maxFrames) => {
    if (s === null || s === undefined) return null;
    if (typeof s !== 'object' || !Array.isArray(s.frames) || s.frames.length > maxFrames) return undefined;
    if (!Array.isArray(s.images) || s.images.length > maxFrames || !s.images.every((x) => typeof x === 'string' && x.length <= 200000 && B64.test(x))) return undefined;
    const o = {}; for (const k of STRIP_FIELDS) if (s[k] !== undefined) o[k] = s[k];
    return o;
  };
  const bb = strip(r.bb, BB_MAX_FRAMES), screen = strip(r.screen, SCREEN_MAX_FRAMES);
  if (bb === undefined || screen === undefined) return { ok: false, error: 'bad strip' };
  if (!bb && !screen) return { ok: false, error: 'empty report' };
  const rec = { event: 'display-report', v: r.v, session: r.session, id: Number.isFinite(r.id) ? r.id : null, bb, screen };
  for (const k of ['game', 'build', 'version', 'options', 'page', 'notes', 'took']) if (r[k] !== undefined) rec[k] = r[k];
  if (rec.game !== undefined && rec.game !== null) rec.game = String(rec.game).slice(0, 120);
  return { ok: true, rec };
}
