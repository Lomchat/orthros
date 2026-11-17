// A session's flicker capture (src/gfx/flicker-capture.js: sent once, at its first strong flicker, into the telemetry)
// as pictures and text: the captured frames as PNGs (capture-<session>-<k>.png, upscaled to the frame's aspect), what
// changed between frames 1 and 2 (diff-<session>-1-2.png: the luminance difference, amplified, over frame 1 dimmed), the
// pixels that went A-B-A over the three (aba-<session>.png: red over frame 1 dimmed; JPEG noise stays far below the
// threshold); then the WebGL context, each frame's passes (the framebuffer drawn into, its draws, clears, blits, GL
// errors), what alternates (src/shared/flicker-record.js alternation: per pass, the draws of frames 1 and 3 missing in
// frame 2, frame 2's draws found in neither, and the draws whose fields are the same in 1 and 3 but not in 2 — program,
// textures, raster state key by key, viewport, vertex array, uniforms, vertex data), then the frames compared pair by
// pair (diffFrames: 1-2, 2-3, 1-3; per changed draw, the fields that differ).
// Usage: node tools/dev/flicker-capture.mjs <telemetry .jsonl> [--session <id>] [--out <dir>] [--limit <n>] [--context]
//   --out: where the PNGs go (default: the current directory); --limit: entries listed per list (default 30);
//   --context: the extension list and every limit too
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { decodeJpeg } from '../../src/gfx/codecs/jpeg.js';
import { encodePng } from '../../src/gfx/codecs/png.js';
import { diffRecord, alternation, DRAW_FIELDS } from '../../src/shared/flicker-record.js';

const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const file = args[0], only = opt('session'), out = opt('out') ?? '.', limit = Number(opt('limit') ?? 30), full = args.includes('--context');
if (!file) { console.error('usage: node tools/dev/flicker-capture.mjs <telemetry .jsonl> [--session <id>] [--out <dir>] [--limit <n>] [--context]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

let n = 0;
for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
  if (!line.includes('"flicker-capture"')) continue;
  let rec; try { rec = JSON.parse(line); } catch { continue; }
  if (rec.event !== 'flicker-capture' || (only && rec.session !== only)) continue;
  n++; report(rec);
}
if (!n) console.log(`no flicker capture${only ? ` of session ${only}` : ''} in that file`);

function report(rec) {
  const S = rec.session ?? 'x', g = rec.gl ?? {};
  console.log(`=== flicker capture of session ${S} at ${rec.at ?? '?'}: ${rec.game ?? '?'}, build ${rec.build ?? '?'}`);
  console.log(`page: ${JSON.stringify(rec.page ?? {})}; options: ${JSON.stringify(rec.options ?? {})}`);
  console.log(`trigger: ${JSON.stringify(rec.trigger)}; frames ${rec.size?.join('x')} (pictures ${rec.img?.join('x')}, JPEG q ${rec.q})${rec.cut?.length ? `; cut to fit: ${rec.cut.join(', ')}` : ''}${rec.notes?.length ? `; notes: ${rec.notes.join(' | ')}` : ''}${rec.took ? `; made in ${rec.took.ms} ms on the page, ${rec.took.slices} slices, the longest ${rec.took.longest} ms` : ''}`);
  if (rec.small) console.log(`captured pictures: ${rec.small.aba} % of the pixels A-B-A (1 and 3 alike, 2 apart), changed 1-2 ${rec.small.chg12} %, 2-3 ${rec.small.chg23} %, 1-3 ${rec.small.chg13} %`);
  console.log(`context: ${g.renderer} (${g.vendor}); ${g.version}; ${g.glsl}; attributes ${JSON.stringify(g.attrs)}; drawing buffer ${g.drawingBuffer?.join('x')} (canvas ${g.canvas?.join('x')}, ${g.colorSpace}); ${g.ext?.length ?? 0} extensions; precision ${JSON.stringify(g.prec)}`);
  if (full) { console.log(`  extensions: ${(g.ext ?? []).join(' ')}`); console.log(`  limits: ${JSON.stringify(g.limits)}`); }
  else console.log(`  limits: ${['MAX_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_SAMPLES', 'MAX_DRAW_BUFFERS', 'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_FRAGMENT_UNIFORM_VECTORS'].map((k) => `${k} ${JSON.stringify(g.limits?.[k])}`).join(', ')}`);
  pictures(rec, S);
  const objs = rec.objs ?? {}, desc = (id) => { const o = objs[id]; return o ? `${id} ${Object.entries(o).filter(([k]) => k !== 'key').map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')}${o.key ? ` key=${o.key.slice(0, 80)}` : ''}` : id; };
  rec.frames.forEach((f, k) => {
    console.log(`--- frame ${k + 1}: ${f.ms} ms since the previous present, ${f.calls} GL calls recorded, ${f.draws} draws; device ${JSON.stringify(f.info)}${f.errs?.length ? `; GL errors at its end: ${f.errs.join(', ')}` : ''}`);
    if (f.ups?.length) console.log(`  uploads: ${f.ups.slice(0, limit).map((u) => u.join(' ')).join('; ')}${(f.nUps ?? f.ups.length) > limit ? ` ... (${f.nUps ?? f.ups.length})` : ''}`);
    if (f.att?.length) console.log(`  attachments: ${f.att.slice(0, limit).map((a) => a.join(' ')).join('; ')}${(f.nAtt ?? f.att.length) > limit ? ` ... (${f.nAtt ?? f.att.length})` : ''}`);
    if (f.nPasses > (f.passes?.length ?? 0)) console.log(`  (${f.nPasses} passes, the first ${f.passes?.length ?? 0} kept)`);
    (f.passes ?? []).forEach((p, i) => {
      const ev = p.ev ?? [], kinds = {};
      for (const e of ev) { const t = typeof e === 'number' ? 'draw' : e[0]; kinds[t] = (kinds[t] ?? 0) + 1; }
      const special = ev.filter((e) => typeof e !== 'number' && e[0] !== 'clear').slice(0, 6).map((e) => JSON.stringify(e)).join(' ');
      const clears = ev.filter((e) => typeof e !== 'number' && e[0] === 'clear').slice(0, 3).map((e) => `${e[1]}${e[2] ? ' color ' + e[2].join(',') : ''}${e[3] !== null ? ' z ' + e[3] : ''}${e[4] !== null ? ' s ' + e[4] : ''}${e[8] ? ' scissor ' + e[8].join(',') : ''}`).join('; ');
      console.log(`  pass ${i}: ${desc(p.fb)} | ${p.ev ? Object.entries(kinds).map(([t, c]) => `${c} ${t}`).join(', ') || 'nothing' : `${p.n} events (cut${p.same ? ', the same in every frame' : ''})`}${clears ? ` | clears ${clears}` : ''}${special ? ` | ${special}` : ''}`);
    });
  });
  const draws = rec.draws ?? [], states = rec.states ?? [];
  const drawText = (i) => { const d = draws[i]; if (!d) return `draw #${i} (dropped)`; return `#${i} ${d[0]}${objs[d[0]]?.key ? ` (${objs[d[0]].key.slice(0, 50)})` : ''} ${d[6]} tex[${d[1]}] state ${d[2]} vp ${d[3]} ${d[4]}${d[5] ? ' ebo ' + d[5] : ''} uni ${d[7]}${d[8] ? ' data ' + d[8] : ''}`; };
  const fieldText = (f, a, b) => {
    const k = DRAW_FIELDS.indexOf(f), va = draws[a]?.[k], vb = draws[b]?.[k];
    if (f !== 'st') return `${f}: ${va} -> ${vb}`;
    const sa = states[va] ?? {}, sb = states[vb] ?? {};
    return `state ${va} -> ${vb}: ${Object.keys({ ...sa, ...sb }).filter((x) => JSON.stringify(sa[x]) !== JSON.stringify(sb[x])).map((x) => `${x} ${JSON.stringify(sa[x])} -> ${JSON.stringify(sb[x])}`).join(', ')}`;
  };
  // (first what alternates: same in 1 and 3, not in 2 — then each pair of frames in full. A record the page cut (events,
  // uploads, draws, lists: anything but its pictures' quality) is compared again here only from what is left — the page's
  // own comparison, made before the cuts on every event, is the one shown then; else it is made again here, without the
  // page's cap on the work of its longest common sequences)
  const trimmed = (rec.cut ?? []).some((c) => !/^q[\d.]+$/.test(c)), stored = trimmed && (rec.diff || rec.alt);
  if (stored) console.log(`(the page's comparison, made before its cuts: ${rec.cut.join(', ')})`);
  const alt = stored ? rec.alt : alternation(rec, limit);
  // (a record cut to its minimum keeps only the counts of the comparisons' lists: `?? []`)
  if (alt) {
    const pm = alt.passesMissing ?? [], pe = alt.passesExtra ?? [], fl = alt.fields ?? {};
    console.log(`=== alternation (1 and 3 alike, 2 apart): ${alt.passes?.length ?? '?'} passes${Object.keys(fl).length ? `, draw fields ${Object.entries(fl).map(([f, c]) => `${f} ${c}`).join(', ')}` : ''}${pm.length ? `; passes of 1 and 3 missing in 2: ${pm.map((p) => `${p[0]} ${desc(p[1])} (${p[2]} events)`).join('; ')}` : ''}${pe.length ? `; passes in 2 only: ${pe.map((p) => `${p[0]} ${desc(p[1])} (${p[2]} events)`).join('; ')}` : ''}`);
    for (const p of alt.passes ?? []) {
      console.log(`  pass ${p.i} (${p.j} in frame 2) ${desc(p.fb)}${p.fb2 !== p.fb ? ` / in 2: ${p.fb2}` : ''}: ${p.n} / ${p.n2} events; ${p.nMissing} of 1 and 3 missing in 2, ${p.nExtra} in 2 only, ${p.nAlt} draws alternating (${Object.entries(p.fields ?? {}).map(([f, c]) => `${f} ${c}`).join(', ') || '-'})`);
      for (const [x, y, at, f] of p.alt ?? []) console.log(`    alternating at event ${at}: ${drawText(x)}\n      ${f.map((ff) => fieldText(ff, x, y)).join('\n      ')}`);
      for (const e of p.missing ?? []) console.log(`    missing in 2: ${typeof e === 'number' ? drawText(e) : JSON.stringify(e)}`);
      for (const e of p.extra ?? []) console.log(`    in 2 only: ${typeof e === 'number' ? drawText(e) : JSON.stringify(e)}`);
    }
  }
  const diff = stored ? rec.diff ?? {} : diffRecord(rec, limit);
  for (const [pair, d] of Object.entries(diff)) {
    const [a, b] = pair.split('-').map(Number);
    const oa = d.onlyA ?? [], ob = d.onlyB ?? [];
    console.log(`=== frames ${pair}: ${d.same} passes the same, ${d.passes?.length ?? '?'} differing${oa.length ? `; only in ${a}: ${oa.map((p) => `pass ${p[0]} ${desc(p[1])} (${p[2]} events)`).join('; ')}` : ''}${ob.length ? `; only in ${b}: ${ob.map((p) => `pass ${p[0]} ${desc(p[1])} (${p[2]} events)`).join('; ')}` : ''}`);
    for (const p of d.passes ?? []) {
      console.log(`  pass ${p.i}/${p.j} ${desc(p.fb)}: ${p.na} / ${p.nb} events, ${p.common} in common, ${p.nChanged} draws changed (${Object.entries(p.fields ?? {}).map(([f, c]) => `${f} ${c}`).join(', ') || '-'}), ${p.nOnlyA} only in ${a}, ${p.nOnlyB} only in ${b}`);
      for (const [x, y, at, f] of p.changed ?? []) console.log(`    changed at event ${at}: ${drawText(x)}\n      ${f.map((ff) => fieldText(ff, x, y)).join('\n      ')}`);
      for (const e of p.onlyA ?? []) console.log(`    only in ${a}: ${typeof e === 'number' ? drawText(e) : JSON.stringify(e)}`);
      for (const e of p.onlyB ?? []) console.log(`    only in ${b}: ${typeof e === 'number' ? drawText(e) : JSON.stringify(e)}`);
    }
  }
}

/** the frames as PNGs, their difference 1-2 and the A-B-A pixels */
function pictures(rec, S) {
  const imgs = (rec.images ?? []).map((b64) => { if (!b64) return null; try { return decodeJpeg(new Uint8Array(Buffer.from(b64, 'base64'))); } catch (e) { console.log(`a picture could not be decoded: ${e.message}`); return null; } });
  if (!imgs.length) { console.log('no pictures in the record'); return; }
  const save = (name, px, w, h) => { const f = path.join(out, name); fs.writeFileSync(f, encodePng(px, w, h)); return f; };
  imgs.forEach((im, k) => { if (im) console.log(`picture ${k + 1}: ${save(`capture-${S}-${k + 1}.png`, rgba(im), im.width, im.height)}`); });
  const [A, B, C] = imgs;
  if (!A || !B) return;
  const w = A.width, h = A.height, la = lum(A), lb = lum(B), lc = C ? lum(C) : null, d = new Uint8Array(w * h * 4), m = new Uint8Array(w * h * 4);
  let aba = 0;
  for (let i = 0; i < w * h; i++) {
    const g = la[i] * 0.35, dl = Math.abs(la[i] - lb[i]), diff = dl > 8 ? Math.min(255, dl * 4) : 0, o = 4 * i; // (below 8: the JPEG's noise)
    d[o] = Math.max(g, diff); d[o + 1] = g; d[o + 2] = g; d[o + 3] = 255;
    const hit = lc && Math.abs(la[i] - lb[i]) > 24 && Math.abs(lb[i] - lc[i]) > 24 && Math.abs(la[i] - lc[i]) < 8;
    if (hit) aba++;
    m[o] = hit ? 255 : g; m[o + 1] = hit ? 0 : g; m[o + 2] = hit ? 0 : g; m[o + 3] = 255;
  }
  console.log(`difference 1-2: ${save(`diff-${S}-1-2.png`, d, w, h)}`);
  if (lc) console.log(`A-B-A pixels (${(aba / (w * h) * 100).toFixed(2)} % on the decoded pictures): ${save(`aba-${S}.png`, m, w, h)}`);
}
function rgba(im) { const n = im.width * im.height, px = im.data; if (px.length === n * 4) return px; const o = new Uint8Array(n * 4); for (let i = 0; i < n; i++) { o[4 * i] = px[3 * i]; o[4 * i + 1] = px[3 * i + 1]; o[4 * i + 2] = px[3 * i + 2]; o[4 * i + 3] = 255; } return o; }
function lum(im) { const px = rgba(im), n = im.width * im.height, l = new Float32Array(n); for (let i = 0; i < n; i++) l[i] = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2]; return l; }
