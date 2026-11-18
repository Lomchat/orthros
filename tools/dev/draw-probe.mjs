// A session's draw probe (src/gfx/draw-probe.js, the record: src/shared/draw-probe.js) as text and pictures: what each
// of the frame's last draws did to the picture, frame by frame, and the values it was drawn with.
// Per record:
// - the trigger, the renderer, the path (render worker: the game's TEXTUREFACTOR came through the command ring), the
//   frames (probed, control: presented frames only), the odd ones (presented picture away from the reference) and the
//   verdict (src/shared/draw-probe.js analyse): the game's values, the render worker's replay, Orthros' uniform cache,
//   or the same values making another picture (GL), or the scene under the draws;
// - the rectangles (grid points of GW x GH native pixels: 'var' where the presented frames varied most, 'fix' fixed);
// - per probed draw (by its position from the frame's end: 1 the last draw): its description (program, target, depth,
//   vertex array, buffers, raster state), its values (the producer's TEXTUREFACTOR, the backend's, the program's cached
//   copy before / after, the last value sent to its uniform; flags), its effect (after / before luminance ratio per
//   rectangle: ~0.20 where a black layer of alpha 0.80 covers; a difference where it adds);
// - frame by frame (every frame with --frames, else the odd ones and their neighbours): per draw that darkens or moved,
//   the ratio per rectangle, its TEXTUREFACTOR when it varies, the texture matrices when they do;
// - PNGs (--out): the record's pictures (the reference and odd presented frames, before / after the draw that changed
//   most), 4x, the rectangles outlined.
// A session may hold several: its own (started by a flicker sample, a still screen or an alternation sample — the
// picture coming back at the same place after runs of frames, src/shared/draw-probe.js alternation) and one per display
// report (the player's button, the same window: --report <id> picks it). Odd frames are A-B-A or runs that came back.
// Usage: node tools/dev/draw-probe.mjs <telemetry .jsonl | record .json> [--session <id>] [--report <id>] [--out <dir>] [--frames] [--draws all]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { GW, GH, ODD_PPM, analyse, frameRects, unpackGrid } from '../../src/shared/draw-probe.js';
import { encodePng } from '../../src/gfx/codecs/png.js';

const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const file = args[0], only = opt('session'), onlyReport = opt('report'), out = opt('out'), allFrames = args.includes('--frames'), allDraws = opt('draws') === 'all';
if (!file) { console.error('usage: node tools/dev/draw-probe.mjs <telemetry .jsonl | record .json> [--session <id>] [--report <id>] [--out <dir>] [--frames] [--draws all]'); process.exit(2); }
/** what started the probe, in words (src/gfx/flicker-probe.js: the probe's own triggers, or a player's display report) */
const triggerText = (t) => (!t ? '?' : t.why === 'report' ? `the player's display report ${t.id} (the same window)` : t.why === 'alternation' ? `an alternation sample: the picture came back ${t.same ?? '?'} times at the same place in ${t.returns ?? '?'} returns (runs of ${(t.runs ?? []).join('/')} frames), ${t.w}x${t.h}` : t.why === 'asked' ? 'asked (ORTHROS_DRAW_PROBE=1)' : `${t.why}: sample ${t.sample ?? '?'}, ${t.still ?? '?'} % flickering, commands ${t.cmd ?? '?'}`);
if (out) fs.mkdirSync(out, { recursive: true });
const hex = (v) => (v === null || v === undefined ? '-' : (v >>> 0).toString(16));
const f2 = (x) => (x === null || x === undefined ? '  -  ' : x.toFixed(2));

function report(rec) {
  const S = rec.session ?? 'x', a = analyse(rec), R = rec.rects.length;
  console.log(`=== draw probe of session ${S} at ${rec.at ?? '?'}: ${rec.game ?? '?'} ${rec.version ?? ''}, build ${rec.build ?? '?'}`);
  console.log(`started by ${triggerText(rec.trigger)}; ${rec.gl?.renderer ?? '?'}; frames ${rec.size?.join('x')} (mode ${rec.mode}); path ${rec.path} (the game's TEXTUREFACTOR ${rec.stamps ? 'known' : 'NOT known'}); last ${rec.lastN} draws probed; page ${JSON.stringify(rec.page ?? {})}`);
  if (rec.notes?.length) console.log(`notes: ${rec.notes.join(' | ')}`);
  if (rec.cut?.length) console.log(`cut: ${rec.cut.join(', ')}`);
  console.log(`frames: ${a.frames} (${a.probed} probed, ${a.control} control); odd: ${a.odd} (${a.oddProbed} probed, ${a.oddControl} control); signatures ${[...new Set(rec.frames.map((f) => f.sig))].join(' ')}; values ${[...new Set(rec.frames.map((f) => f.vsig))].join(' ')}${rec.frames.some((f) => f.csig) ? `; shader constants ${new Set(rec.frames.map((f) => f.csig)).size} distinct, draws reading other constants than the frame before: ${rec.frames.map((f) => f.cn ?? 0).join(' ').slice(0, 300)}` : ''}`);
  console.log(`VERDICT: ${a.verdict}`);
  const [W, H] = rec.size ?? [GW, GH];
  console.log('rectangles (grid points; frame pixels):');
  rec.rects.forEach((r, i) => console.log(`  R${i} ${rec.rectKinds?.[i] ?? ''} at ${r[0]},${r[1]} ${r[2]}x${r[3]} = pixels ${Math.round(r[0] * W / GW)},${Math.round(r[1] * H / GH)}-${Math.round((r[0] + r[2]) * W / GW)},${Math.round((r[1] + r[3]) * H / GH)}`));
  // (draws)
  const shown = a.draws.filter((d) => allDraws || d.kind !== 'keeps' || d.oddAfter >= 8 || d.tfM.length > 1 || d.tfP.length > 1), culprit = a.moved[0];
  console.log(`--- probed draws (position from the frame's end; ${allDraws ? 'all' : 'those that change the picture or whose values vary — --draws all for every one'}):`);
  for (const d of shown) {
    const rows = rec.frames.flatMap((f) => (f.ctl ? [] : f.d.filter((e) => f.n - e[0] === d.pos)));
    const metas = [...new Set(rows.map((e) => e[1]))], vals = [...new Set(rows.map((e) => e[2]))];
    console.log(`  d${d.pos} (${d.n} frames) ${d.kind}${d.ratio !== null ? `: after/before ${f2(d.ratio)} in normal frames, each frame within ±${d.ratioSpread.toFixed(2)}` : ''}; in the odd frames its result moved by ${d.oddAfter.toFixed(0)}, the picture under it by ${d.oddBefore.toFixed(0)} (luminance)${d.pos === culprit ? '   <== the first draw whose result moved over the same picture' : ''}`);
    console.log(`     TEXTUREFACTOR in normal frames: producer ${d.normal.tfP.map(hex).join('/')} backend ${d.normal.tfM.map(hex).join('/')} cache ${d.normal.sv.map(hex).join('/')} sent ${d.normal.sent.map(hex).join('/')}; in odd frames: producer ${d.odd.tfP.map(hex).join('/') || '-'} backend ${d.odd.tfM.map(hex).join('/') || '-'} cache ${d.odd.sv.map(hex).join('/') || '-'} sent ${d.odd.sent.map(hex).join('/') || '-'}`);
    for (const m of metas) console.log(`     ${rec.metas[m] ?? '?'}${metas.length > 1 ? ` (${rows.filter((e) => e[1] === m).length} frames)` : ''}`);
    for (const v of vals) { const x = rec.vals[v]; if (x) console.log(`     TEXTUREFACTOR producer ${hex(x[0])} backend ${hex(x[1])}, program cache ${hex(x[2])} -> ${hex(x[3])}, last sent ${hex(x[4])}; ${flagText(x[5])}${vals.length > 1 ? ` (${rows.filter((e) => e[2] === v).length} frames)` : ''}`); }
    const tms = [...new Set(rows.map((e) => e[3]).filter((x) => x >= 0))];
    if (tms.length) console.log(`     texture matrices: ${tms.length} distinct (e.g. ${JSON.stringify(rec.tms[tms[0]])})`);
    console.log(`     per rect (normal frames: before -> after, after/before; odd frames: how far after / before moved): ${d.perRect.map((p, i) => `R${i} ${p.before === null ? '-' : p.before.toFixed(0)}->${p.after === null ? '-' : p.after.toFixed(0)}${p.ratio !== null ? ` x${p.ratio.toFixed(2)}` : ''} odd ${p.oddAfter.toFixed(0)}/${p.oddBefore.toFixed(0)}`).join('  ')}`);
  }
  // (frames)
  const odd = new Set(rec.frames.map((f, k) => (f.odd >= ODD_PPM ? k : -1)).filter((k) => k >= 0));
  const near = new Set([...odd].flatMap((k) => [k - 1, k, k + 1]));
  const rowsF = rec.frames.map((f, k) => [f, k]).filter(([, k]) => allFrames || near.has(k));
  console.log(`--- frames (${allFrames ? 'all' : 'the odd ones and their neighbours — --frames for all'}); per draw and rect R0..R${R - 1} the after/before ratio (x) — or for a draw that adds, after - before (+) —, then its TEXTUREFACTOR producer/backend; present: the presented frame's mean luminance per rect:`);
  for (const [f, k] of rowsF) {
    const r = frameRects(f, R);
    const ds = (f.ctl || !r) ? [] : f.d.map((e, j) => [f.n - e[0], e, r.draws[j]]).filter(([pos]) => shown.some((d) => d.pos === pos));
    console.log(`  #${k} f${f.f} t ${f.t}${f.ctl ? ' control' : ''}${f.odd >= ODD_PPM ? ` ODD ${(f.odd / 1e4).toFixed(1)} %` : ''} (mad ${f.mad ?? '-'}) sig ${f.sig} vals ${f.vsig}${f.tf ? ` TF changed ${f.tf.map(([i, x, y]) => `d${i} ${x}->${y}`).join(' ')}` : ''}${f.p ? '' : ' (no figures)'}`);
    for (const [pos, e, dr] of ds) { const add = shown.find((d) => d.pos === pos)?.kind === 'adds'; console.log(`     d${pos}: ${dr.b.map((b, i) => (!add && b >= 16 ? `x${(dr.a[i] / b).toFixed(2)}` : `+${(dr.a[i] - b).toFixed(0)}`)).join(' ')}   tf ${hex(rec.vals[e[2]]?.[0])}/${hex(rec.vals[e[2]]?.[1])}${e[3] >= 0 ? ` tm ${e[3]}` : ''}`); }
    if (r) console.log(`     present: ${r.present.map((x) => x.toFixed(0)).join(' ')}`);
  }
  // (pictures)
  if (out && rec.pics?.length) {
    rec.pics.forEach((p, i) => {
      const g = unpackGrid(p.img), sc = 4, w = GW * sc, h = GH * sc, px = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = g[Math.floor(y / sc) * GW + Math.floor(x / sc)], o = 4 * (y * w + x); px[o] = px[o + 1] = px[o + 2] = v; px[o + 3] = 255; }
      rec.rects.forEach((r, ri) => { const c = rec.rectKinds?.[ri] === 'var' ? [255, 60, 60] : [60, 200, 255]; for (let y = r[1] * sc; y < (r[1] + r[3]) * sc; y++) for (let x = r[0] * sc; x < (r[0] + r[2]) * sc; x++) if (y === r[1] * sc || y === (r[1] + r[3]) * sc - 1 || x === r[0] * sc || x === (r[0] + r[2]) * sc - 1) { const o = 4 * (y * w + x); px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; } });
      const name = path.join(out, `dp-${S}-${i}-f${rec.frames[p.frame]?.f ?? p.frame}-${p.what.replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '')}.png`);
      fs.writeFileSync(name, encodePng(px, w, h));
      console.log(`picture ${name}: ${p.what}, frame #${p.frame}`);
    });
  }
}
function flagText(f) { return [f & 1 ? 'program reads TEXTUREFACTOR' : 'no u_tfactor', f & 2 ? 'state group skipped (version seen)' : 'state group compared', f & 4 ? 'uniform sent at this draw' : '', f & 8 ? 'transforms skipped' : '', f & 16 ? '' : "producer's value unknown"].filter(Boolean).join(', '); }

let n = 0;
if (file.endsWith('.json')) { report(JSON.parse(fs.readFileSync(file, 'utf8'))); n++; }
else {
  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    if (!line.includes('"draw-probe"')) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.event !== 'draw-probe' || (only && rec.session !== only)) continue;
    if (onlyReport !== null && !(rec.trigger?.why === 'report' && String(rec.trigger.id) === onlyReport)) continue;
    n++; report(rec);
  }
}
if (!n) console.log(`no draw probe${only ? ` of session ${only}` : ''} in that file`);
