// A player's display reports (the frame's "report a display problem", Ctrl+Shift+F: src/shared/display-report.js) as
// pictures and text. Per report:
// - two filmstrips as PNG contact sheets (pages of --cols x --rows pictures): bb-<session>-<id>-p<n>.png, the back
//   buffers the renderer presented, and screen-<session>-<id>-p<n>.png, what the page's canvases held at each
//   requestAnimationFrame; under each picture its number, frame / time (ms since the report's start, one clock for both
//   strips), its change since the previous picture (C, %), the still A-B-A of the last three (A, %: where nothing else
//   moved) and the A-B-B-A of the last four (B, %); the back buffers' framebuffer and command signature (and, in the
//   text, the values signature and the draws whose TEXTUREFACTOR changed: d3d8-webgl.js valDraw), the screen's
//   canvas on top, the bitmaps received since the previous rAF and the back buffer it matched. A border marks a frame:
//   red still A-B-A >= 0.1 %, orange A-B-B-A >= 0.1 %, magenta a screen picture no back buffer had, cyan a screen that
//   went back to an older back buffer;
// - the two strips aligned (align-<session>-<id>-p<n>.png): per new screen picture, the screen, the back buffer it
//   matched best (presented in the 600 ms before it) and their difference (red: luminance apart by more than T);
// - the text: the page's and renderer's notes, the strips' summaries (from the decoded pictures; the page's own,
//   made before the JPEG encode, beside them), the alignment's (screen pictures matched, unmatched, back), then frame
//   by frame both strips and the alignment, the canvases' states, the page's events and the bitmaps it received;
// - the draw probe the report started in the same window (since 2026-11-18 evening; its own telemetry line, trigger
//   `report`): its frames, the odd ones (A-B-A or a run that came back), its verdict — tools/dev/draw-probe.mjs
//   --report <id> prints its draws.
// Usage: node tools/dev/flicker-report.mjs <telemetry .jsonl> [--session <id>] [--id <n>] [--out <dir>] [--cols 8] [--rows 6]
//   [--match <ppm>] (a screen picture farther than this from every back buffer is "unmatched"; default 20000 = 2 %)
//   [--frames] (the frame-by-frame tables; default: only frames that are marked)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { decodeJpeg } from '../../src/gfx/codecs/jpeg.js';
import { lumOf, stripAnalysis, alignStrips, resampleLum, T } from '../../src/shared/display-report.js';
import { ODD_PPM, analyse } from '../../src/shared/draw-probe.js';

const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const file = args[0], only = opt('session'), onlyId = opt('id'), out = opt('out') ?? '.', COLS = Number(opt('cols') ?? 8), ROWS = Number(opt('rows') ?? 6), MATCH = Number(opt('match') ?? 20000), allFrames = args.includes('--frames');
if (!file) { console.error('usage: node tools/dev/flicker-report.mjs <telemetry .jsonl> [--session <id>] [--id <n>] [--out <dir>] [--cols 8] [--rows 6] [--match <ppm>] [--frames]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });


function report(rec) {
  const S = `${rec.session ?? 'x'}-${rec.id ?? 0}`, pct = (ppm) => (ppm === null || ppm === undefined ? '-' : (ppm / 1e4).toFixed(2));
  console.log(`=== display report ${rec.id} of session ${rec.session} at ${rec.at ?? '?'}: ${rec.game ?? '?'} ${rec.version ?? ''}, build ${rec.build ?? '?'}`);
  console.log(`page: ${JSON.stringify(rec.page ?? {})}; options: ${JSON.stringify(rec.options ?? {})}${rec.notes?.length ? `\nnotes: ${rec.notes.join(' | ')}` : ''}`);
  const strips = { bb: load(rec.bb, 'bb'), screen: load(rec.screen, 'screen') };
  // (one clock: both strips' times from the earliest start)
  const t0 = Math.min(...[rec.bb?.t0, rec.screen?.t0].filter(Number.isFinite));
  for (const s of Object.values(strips)) if (s) for (const f of s.frames) f.at = s.t0 + f.t, f.rt = Math.round((f.at - t0) * 10) / 10;
  const B = strips.bb, C = strips.screen;
  if (B) {
    const g = rec.bb.gl ?? {}, info = rec.bb.info ?? {};
    console.log(`--- back buffers: ${B.frames.length} frames of ${rec.bb.size?.join('x')} (pictures ${B.w}x${B.h}, JPEG q ${rec.bb.q}${rec.bb.cut?.length ? `, cut: ${rec.bb.cut.join(', ')}` : ''}), from ${((rec.bb.t0 - t0)).toFixed(1)} ms; ${g.renderer ?? '?'}; drawing buffer ${g.drawingBuffer?.join('x')} (canvas ${g.canvas?.join('x')}, ${g.colorSpace ?? '?'}); device ${JSON.stringify(info)}${rec.bb.notes?.length ? `; notes: ${rec.bb.notes.join(' | ')}` : ''}${rec.bb.took ? `; made in ${rec.bb.took.ms} ms (${rec.bb.took.busy} busy, longest slice ${rec.bb.took.longest})` : ''}`);
    summary('back buffers', B, rec.bb.analysis?.summary);
    const fbs = [...new Set(B.frames.map((f) => f.fb))], sigs = [...new Set(B.frames.map((f) => f.sig))];
    console.log(`  framebuffers blitted: ${fbs.join(' ')} (${B.frames.map((f) => f.fb).join(' ').slice(0, 400)}); command signatures: ${sigs.length} distinct (${seqOf(B.frames.map((f) => f.sig)).slice(0, 400)})`);
    // (the values the draws read beside the commands — TEXTUREFACTOR, material...: a later build's reports; d3d8-webgl.js valDraw)
    if (B.frames.some((f) => f.vsig)) {
      const vs = [...new Set(B.frames.map((f) => f.vsig))], tfs = B.frames.map((f, k) => [f, k]).filter(([f]) => f.tf?.length);
      console.log(`  values signatures: ${vs.length} distinct (${seqOf(B.frames.map((f) => f.vsig)).slice(0, 400)}); frames whose draws' TEXTUREFACTOR changed: ${tfs.length ? tfs.map(([f, k]) => `#${k} f${f.f} [${f.tf.map(([i, a, b]) => `draw ${i} ${a}->${b}`).join(', ')}]`).join('; ').slice(0, 1200) : 'none'}`);
    }
    // (the shader constants the draws' shaders read — a D3DX effect's values: a later build's reports; valDraw. On a
    // still screen a few animated draws at most read other constants than in the frame before)
    if (B.frames.some((f) => f.csig)) {
      const cs = [...new Set(B.frames.map((f) => f.csig))], moved = B.frames.map((f, k) => [f, k]).filter(([f]) => f.cn);
      console.log(`  shader constants signatures: ${cs.length} distinct (${seqOf(B.frames.map((f) => f.csig)).slice(0, 400)}); draws reading other constants than the frame before: ${moved.length ? moved.map(([f, k]) => `#${k} ${f.cn}${f.cd?.length ? ` (draws ${f.cd.join(' ')}${f.cn > f.cd.length ? '...' : ''})` : ''}`).join('; ').slice(0, 1600) : 'none'}`);
    }
  } else console.log('--- no back-buffer strip');
  if (C) {
    const ls = rec.screen.layers ?? [];
    console.log(`--- screen: ${C.frames.length} frames of ${rec.screen.size?.join('x')} (pictures ${C.w}x${C.h}, JPEG q ${rec.screen.q}${rec.screen.cut?.length ? `, cut: ${rec.screen.cut.join(', ')}` : ''}), from ${((rec.screen.t0 - t0)).toFixed(1)} ms; page ${JSON.stringify(rec.screen.page ?? {})}${rec.screen.notes?.length ? `; notes: ${rec.screen.notes.join(' | ')}` : ''}${rec.screen.took ? `; made in ${rec.screen.took.ms} ms (${rec.screen.took.busy} busy, longest slice ${rec.screen.took.longest})` : ''}`);
    summary('screen', C, rec.screen.analysis?.summary);
    ls.forEach((l, i) => console.log(`  canvas state ${i}: transform ${l.transform}; ${l.canvases.map((c) => `${c.id} ${c.w}x${c.h} box ${c.box.join(',')} z ${c.z} ${c.vis}${c.disp === 'none' ? ' display none' : ''} opacity ${c.op} ${c.ir}`).join('; ')}`));
    const tops = {}; for (const f of C.frames) tops[`${f.top} (state ${f.ls})`] = (tops[`${f.top} (state ${f.ls})`] ?? 0) + 1;
    console.log(`  on top: ${Object.entries(tops).map(([k, v]) => `${k} ${v} frames`).join(', ')}`);
    const arr = rec.screen.arrivals ?? [], byLayer = {}; for (const a of arr) byLayer[a[1]] = (byLayer[a[1]] ?? 0) + 1;
    console.log(`  bitmaps received: ${arr.length} (${Object.entries(byLayer).map(([k, v]) => `${k} ${v}`).join(', ')})`);
    if (allFrames && arr.length) console.log(`  bitmaps (t ms, layer, size, device frame): ${arr.map((a) => `${(rec.screen.t0 + a[0] - t0).toFixed(1)} ${a[1]} ${a[2]}x${a[3]}${a[4] !== null ? ` f${a[4]}` : ''}`).join('; ')}`);
    for (const e of rec.screen.events ?? []) console.log(`  event at ${(rec.screen.t0 + e[0] - t0).toFixed(1)} ms: ${e[1]}${e[2] !== null && e[2] !== undefined ? ` ${e[2]}` : ''}`);
  } else console.log('--- no screen strip');
  // (the alignment: which back buffer each new screen picture shows)
  let al = null;
  if (B && C) {
    const w = B.w, h = B.h, bl = B.lums, sl = C.lums.map((l) => (l ? resampleLum(l, C.w, C.h, w, h) : null));
    al = alignStrips({ frames: B.frames, lums: bl }, { frames: C.frames, lums: sl }, w, h, { match: MATCH });
    const s = al.summary;
    console.log(`--- alignment: ${s.shown} new screen pictures, ${s.byFrame} by the device frame the page was handed, ${s.shown - s.byFrame - s.none} by their pixels${s.none ? `, ${s.none} outside the back buffers' window (not compared)` : ''}; ${s.unmatched} match no back buffer within ${pct(MATCH)} % (the screen showed what no back buffer had)${s.other ? `; ${s.other} closer to another back buffer than to the frame handed` : ''}${s.back ? `; ${s.back} went BACK to an older back buffer` : '; none went back to an older back buffer'}; lag (screen rAF - present) median ${s.lagMedian} ms; largest difference ${pct(s.diffMax)} %`);
    for (const r of al.rows) C.frames[r.k].match = r;
  }
  // (frame by frame: every frame with --frames, else the marked ones)
  const flagB = (k) => (B.an.still[k] ?? 0) >= 1000 || (B.an.abba[k] ?? 0) >= 1000;
  const flagC = (k) => (C.an.still[k] ?? 0) >= 1000 || (C.an.abba[k] ?? 0) >= 1000 || C.frames[k].match?.unmatched || C.frames[k].match?.back;
  if (B) { const rows = B.frames.map((f, k) => [f, k]).filter(([, k]) => allFrames || flagB(k)); if (rows.length) console.log(`--- back-buffer frames${allFrames ? '' : ' marked'} (t: ms since the report's start; C changed, A still A-B-A, B A-B-B-A, %):`); for (const [f, k] of rows) console.log(`  #${k} f${f.f} t ${f.rt} picture ${f.img} fb ${f.fb} bb ${f.bb} sig ${f.sig}${f.vsig ? ` vals ${f.vsig}` : ''}${f.tf?.length ? ` TF ${f.tf.map(([i, a, b]) => `d${i} ${a}->${b}`).join(' ')}` : ''}${f.gamma ? ' gamma' : ''}${f.db ? ` drawing buffer ${f.db}` : ''}: C ${pct(B.an.chg[k])} A ${pct(B.an.still[k])} (any ${pct(B.an.aba[k])}) B ${pct(B.an.abba[k])}`); }
  if (C) { const rows = C.frames.map((f, k) => [f, k]).filter(([, k]) => allFrames || flagC(k)); if (rows.length) console.log(`--- screen frames${allFrames ? '' : ' marked'}:`); for (const [f, k] of rows) { const m = f.match; console.log(`  #${k} t ${f.rt} picture ${f.img} top ${f.top} state ${f.ls} bitmaps ${f.a}: C ${pct(C.an.chg[k])} A ${pct(C.an.still[k])} (any ${pct(C.an.aba[k])}) B ${pct(C.an.abba[k])}${f.df !== undefined ? ` device frame ${f.df}` : ''}${m?.none ? '; no back buffer recorded in its time' : m ? `; shows back buffer #${m.j} (f${m.f}, ${m.lag} ms before, by ${m.by}) ${pct(m.diff)} % apart (mean ${m.mad})${m.other !== undefined ? `, closer to #${m.other} (${pct(m.otherDiff)} %)` : ''}${m.unmatched ? ' UNMATCHED' : ''}${m.back ? ' BACK' : ''}` : ''}`); } }
  if (B) sheets(`bb-${S}`, B, (f, k) => [`#${k} F${f.f} T${f.rt}`, `C${pct(B.an.chg[k])} A${pct(B.an.still[k])} B${pct(B.an.abba[k])}`, `${f.fb} ${f.sig ?? ''}`], (k) => ((B.an.still[k] ?? 0) >= 1000 ? RED : (B.an.abba[k] ?? 0) >= 1000 ? ORANGE : null));
  if (C) sheets(`screen-${S}`, C, (f, k) => [`#${k} T${f.rt} ${String(f.top ?? '-').toUpperCase()} N${f.a}`, `C${pct(C.an.chg[k])} A${pct(C.an.still[k])} B${pct(C.an.abba[k])}`, f.match ? (f.match.none ? 'NO BB IN TIME' : `BB#${f.match.j} F${f.match.f} ${f.match.lag}MS ${pct(f.match.diff)}`) : ''],
    (k) => (C.frames[k].match?.unmatched ? MAGENTA : C.frames[k].match?.back ? CYAN : (C.an.still[k] ?? 0) >= 1000 ? RED : (C.an.abba[k] ?? 0) >= 1000 ? ORANGE : null));
  if (al) alignSheets(`align-${S}`, B, C, al);
}

/** a strip's pictures decoded (RGBA, luminance), its frames, its analysis made again on them */
function load(s, name) {
  if (!s?.frames) return null;
  const pics = (s.images ?? []).map((b64) => { try { const im = decodeJpeg(new Uint8Array(Buffer.from(b64, 'base64'))); return { w: im.width, h: im.height, px: rgba(im) }; } catch (e) { console.log(`${name}: a picture could not be decoded: ${e.message}`); return null; } });
  const w = pics.find(Boolean)?.w ?? s.img?.[0] ?? 1, h = pics.find(Boolean)?.h ?? s.img?.[1] ?? 1;
  const lums = pics.map((p) => (p ? lumOf(p.px, p.w, p.h) : null));
  const frames = s.frames.map((f) => ({ ...f, img: f.img >= 0 && f.img < pics.length && pics[f.img] ? f.img : -1 }));
  return { t0: s.t0, w, h, pics, lums, frames, an: stripAnalysis(lums, frames.map((f) => f.img), w, h) };
}
function summary(name, s, page) {
  const x = s.an.summary, pct = (ppm) => (ppm === null || ppm === undefined ? '-' : (ppm / 1e4).toFixed(2));
  console.log(`  ${name}: ${x.frames} frames, ${x.pictures} distinct pictures; changed per frame mean ${pct(x.chgMean)} %, max ${pct(x.chgMax)} %; still A-B-A max ${pct(x.stillMax)} % (${x.stillFrames} frames >= 0.1 %; any A-B-A max ${pct(x.abaMax)} %); A-B-B-A max ${pct(x.abbaMax)} % (${x.abbaFrames} frames >= 0.1 %); exact A-B-A ${x.exact} frames`);
  if (page) console.log(`  (before the JPEG encode: still A-B-A max ${pct(page.stillMax)} %, ${page.stillFrames} frames; A-B-B-A max ${pct(page.abbaMax)} %, ${page.abbaFrames} frames; exact A-B-A ${page.exact}; changed mean ${pct(page.chgMean)} %)`);
  console.log(`  pictures in the order shown: ${x.seq}${x.runs > 300 ? ' ...' : ''}`);
}
const seqOf = (a) => { const o = []; for (const v of a) if (!o.length || o[o.length - 1][0] !== v) o.push([v, 1]); else o[o.length - 1][1]++; return o.map(([v, c]) => (c > 1 ? `${v}x${c}` : String(v))).join(' '); };

// ---------------------------------------------------------------- pictures
const RED = [230, 40, 40], ORANGE = [245, 150, 30], MAGENTA = [230, 40, 230], CYAN = [40, 200, 230], GREY = [70, 70, 70];
/** the contact sheets of a strip: pages of COLS x ROWS pictures, a label band under each, a border by `color(k)` */
function sheets(base, s, label, color) {
  const sc = s.w >= 240 ? 2 : 1, band = 3 * 6 * sc + 4, cw = s.w + 4, ch = s.h + 4 + band, per = COLS * ROWS;
  for (let p = 0; p * per < s.frames.length; p++) {
    const fr = s.frames.slice(p * per, (p + 1) * per), rows = Math.ceil(fr.length / COLS), W = COLS * cw, H = rows * ch, img = new Uint8Array(W * H * 4);
    for (let i = 3; i < img.length; i += 4) img[i] = 255;
    fr.forEach((f, i) => {
      const k = p * per + i, x = (i % COLS) * cw, y = Math.floor(i / COLS) * ch;
      fillRect(img, W, x, y, cw - 1, s.h + 4, color(k) ?? GREY);
      const pic = f.img >= 0 ? s.pics[f.img] : null;
      if (pic) blit(img, W, pic.px, pic.w, pic.h, x + 2, y + 2); else { fillRect(img, W, x + 2, y + 2, s.w, s.h, [30, 30, 30]); text(img, W, x + 6, y + 6, 'NO PICTURE', sc, [200, 200, 200]); }
      label(f, k).forEach((l, j) => text(img, W, x + 2, y + s.h + 6 + j * 6 * sc, l, sc, [220, 220, 220]));
    });
    const f = path.join(out, `${base}-p${p + 1}.png`); fs.writeFileSync(f, png(img, W, H)); console.log(`sheet: ${f}`);
  }
}
/** per new screen picture: the screen, the back buffer it matched, their difference */
function alignSheets(base, B, C, al) {
  const rows = al.rows.filter((r) => !r.same), w = B.w, h = B.h, sc = w >= 240 ? 2 : 1, band = 6 * sc + 4, cell = 3 * (w + 2) + 8, ch = h + band + 6, per = 2 * 8;
  for (let p = 0; p * per < rows.length; p++) {
    const rs = rows.slice(p * per, (p + 1) * per), W = 2 * cell, H = Math.ceil(rs.length / 2) * ch, img = new Uint8Array(W * H * 4);
    for (let i = 3; i < img.length; i += 4) img[i] = 255;
    rs.forEach((r, i) => {
      const x = (i % 2) * cell, y = Math.floor(i / 2) * ch, sp = C.pics[C.frames[r.k].img], bf = Number.isFinite(r.j) ? B.frames[r.j] : null, bp = bf && bf.img >= 0 ? B.pics[bf.img] : null;
      fillRect(img, W, x, y, cell - 6, h + 4, r.unmatched ? MAGENTA : r.back ? CYAN : GREY);
      const spx = sp ? (sp.w === w && sp.h === h ? sp.px : resample(sp.px, sp.w, sp.h, w, h)) : null;
      if (spx) blit(img, W, spx, w, h, x + 2, y + 2);
      if (bp) blit(img, W, bp.px, w, h, x + w + 4, y + 2);
      if (spx && bp) { const d = new Uint8Array(w * h * 4), la = lumOf(spx, w, h), lb = lumOf(bp.px, w, h); for (let q = 0; q < w * h; q++) { const g = la[q] * 0.35, dd = Math.abs(la[q] - lb[q]), hit = dd > T; d[4 * q] = hit ? 255 : Math.max(g, Math.min(255, dd * 4)); d[4 * q + 1] = hit ? 0 : g; d[4 * q + 2] = hit ? 0 : g; d[4 * q + 3] = 255; } blit(img, W, d, w, h, x + 2 * w + 6, y + 2); }
      text(img, W, x + 2, y + h + 6, `SCR#${r.k} T${C.frames[r.k].rt} > ${r.none ? 'NO BB IN TIME' : `BB#${r.j} F${r.f} LAG ${r.lag} D ${(r.diff / 1e4).toFixed(2)}%`}${r.other !== undefined ? ` CLOSER BB#${r.other}` : ''}${r.unmatched ? ' UNMATCHED' : ''}${r.back ? ' BACK' : ''}`, sc, [220, 220, 220]);
    });
    const f = path.join(out, `${base}-p${p + 1}.png`); fs.writeFileSync(f, png(img, W, H)); console.log(`aligned: ${f}`);
  }
}
function rgba(im) { const n = im.width * im.height, px = im.data; if (px.length === n * 4) return px; const o = new Uint8Array(n * 4); for (let i = 0; i < n; i++) { o[4 * i] = px[3 * i]; o[4 * i + 1] = px[3 * i + 1]; o[4 * i + 2] = px[3 * i + 2]; o[4 * i + 3] = 255; } return o; }
function resample(px, w, h, W, H) { const o = new Uint8Array(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = 4 * (Math.min(h - 1, Math.floor(y * h / H)) * w + Math.min(w - 1, Math.floor(x * w / W))); o.set(px.subarray(s, s + 4), 4 * (y * W + x)); } return o; }
function blit(dst, W, src, w, h, x0, y0) { for (let y = 0; y < h; y++) dst.set(src.subarray(y * w * 4, (y + 1) * w * 4), ((y0 + y) * W + x0) * 4); }
function fillRect(dst, W, x0, y0, w, h, c) { const H = dst.length / 4 / W; for (let y = y0; y < Math.min(H, y0 + h); y++) for (let x = x0; x < Math.min(W, x0 + w); x++) { const o = 4 * (y * W + x); dst[o] = c[0]; dst[o + 1] = c[1]; dst[o + 2] = c[2]; dst[o + 3] = 255; } }
// (a 3 x 5 font: digits, capitals and a few signs — the labels are written in capitals)
const GLYPHS = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001111',
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010', Z: '111001010100111',
  '.': '000000000000010', '-': '000000111000000', '+': '000010111010000', ':': '000010000010000', '%': '101001010100101', '#': '101111101111101', '/': '001001010100100', '>': '100010001010100', '<': '001010100010001', '(': '010100100100010', ')': '010001001001010', '_': '000000000000111', ' ': '000000000000000',
};
function text(dst, W, x0, y0, s, sc, c) {
  const H = dst.length / 4 / W;
  let x = x0;
  for (const ch of String(s).toUpperCase()) {
    const g = GLYPHS[ch] ?? GLYPHS['_'];
    for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) if (g[r * 3 + q] === '1') for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) { const X = x + q * sc + dx, Y = y0 + r * sc + dy; if (X < W && Y < H) { const o = 4 * (Y * W + X); dst[o] = c[0]; dst[o + 1] = c[1]; dst[o + 2] = c[2]; } }
    x += 4 * sc;
  }
}
/** RGBA as a PNG, its rows deflated (zlib: a contact sheet of stored rows would weigh 10 MB) */
function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * The draw probe the report started in its window (src/gfx/flicker-probe.js reportStep: event draw-probe, trigger
 * { why: 'report', id }; sent apart, after the report): its frames, odd ones and verdict (src/shared/draw-probe.js
 * analyse); tools/dev/draw-probe.mjs prints its draws.
 */
function probeOf(rec, probes) {
  const p = probes.find((x) => x.session === rec.session && Number(x.trigger?.id) === Number(rec.id));
  if (!p) { console.log(`--- draw probe of this report: none in that file${(rec.bb?.notes ?? []).some((x) => /draw probe started/.test(x)) ? ' (the renderer started one: not sent, or refused by the server)' : ' (a build before 2026-11-18 evening, or another probe was recording)'}`); return; }
  const a = analyse(p), sigs = new Set(p.frames.map((f) => f.sig)).size, vs = new Set(p.frames.map((f) => f.vsig)).size;
  console.log(`--- draw probe of this report (${p.at ?? '?'}; ${p.path}, the game's TEXTUREFACTOR ${p.stamps ? 'stamped' : 'NOT known'}): ${a.frames} frames (${a.probed} probed, ${a.control} control), ${a.odd} odd (${a.oddProbed} probed, ${a.oddControl} control), ${sigs} command signatures, ${vs} values signatures${p.notes?.length ? `; notes: ${p.notes.join(' | ')}` : ''}`);
  console.log(`  VERDICT: ${a.verdict}`);
  console.log(`  frames: ${p.frames.map((f) => `${f.ctl ? 'c' : ''}${f.odd >= ODD_PPM ? 'ODD' : '.'}`).join(' ')}`);
  console.log(`  node tools/dev/draw-probe.mjs ${file} --session ${rec.session} --report ${rec.id} [--frames] [--out <dir>]: its draws, values and pictures`);
}

// (the reports, read once every helper above is defined; the draw probes they started, sent apart)
const reports = [], probes = [];
for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
  if (!line.includes('"display-report"') && !(line.includes('"draw-probe"') && line.includes('"report"'))) continue;
  let rec; try { rec = JSON.parse(line); } catch { continue; }
  if ((only && rec.session !== only)) continue;
  if (rec.event === 'draw-probe' && rec.trigger?.why === 'report') probes.push(rec);
  else if (rec.event === 'display-report' && !(onlyId && String(rec.id) !== onlyId)) reports.push(rec);
}
for (const rec of reports) { report(rec); probeOf(rec, probes); }
if (!reports.length) console.log(`no display report${only ? ` of session ${only}` : ''} in that file`);
