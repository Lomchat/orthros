// Frame-drop summary of the server's telemetry (src/host/server.js --telemetry): per session, the browser / GPU, the
// options and build it ran with, and per stretch of play (consecutive samples of the same kind: a 3D scene — many draws
// per frame — or not) the frames > 33 / > 50 ms per minute, the mean work per frame, the time by category of the
// frames and of the slow ones (docs/frame-accounting.md). Sessions recorded before the frame accounting show the
// frame counts only.
// Usage: node tools/telemetry-report.mjs <telemetry dir | .jsonl file>... [--session <id>] [--min-seconds 60] [--json]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const files = [];
for (const a of args.filter((x, i) => !x.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--json'].includes(args[i - 1])))) {
  if (fs.statSync(a).isDirectory()) for (const f of fs.readdirSync(a).sort()) { if (f.endsWith('.jsonl')) files.push(path.join(a, f)); }
  else files.push(a);
}
if (!files.length) { console.error('usage: node tools/telemetry-report.mjs <telemetry dir | file.jsonl>... [--session id] [--min-seconds 60] [--json]'); process.exit(2); }
const only = opt('session'), minSeconds = Number(opt('min-seconds', 60));

/** @type {Map<string, any>} */
const sessions = new Map();
for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r.session || (only && r.session !== only)) continue;
    let s = sessions.get(r.session);
    if (!s) sessions.set(r.session, (s = { id: r.session, game: r.game, env: null, options: null, version: null, samples: [], slow: 0 }));
    if (r.env) { s.env = r.env; s.version ??= r.env.version ?? null; }
    for (const x of r.samples ?? []) {
      if (x.event === 'options') { s.options = x.options; s.version = x.version ?? s.version; }
      else if (x.event === 'slow') s.slow++;
      else if (!x.event && x.dt) s.samples.push(x);
    }
  }
}

const add = (into, o, k = 1) => { for (const [n, v] of Object.entries(o ?? {})) into[n] = (into[n] ?? 0) + v * k; };
const fmt = (o, scale = 1, min = 0.3) => Object.entries(o).map(([k, v]) => [k, v * scale]).filter(([, v]) => v >= min).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ');
/** Consecutive samples of one kind (3D scene or not, by draws per frame) as stretches. */
function stretches(samples) {
  const out = []; let cur = null;
  for (const x of samples) {
    const frames = (x.fps ?? 0) * x.dt, kind = frames > 0 && (x.draws ?? 0) / frames >= 50 ? '3D' : frames > 0 ? 'other' : 'no frames';
    if (!cur || cur.kind !== kind) out.push(cur = { kind, t0: x.t, seconds: 0, frames: 0, s33: 0, s50: 0, acctFrames: 0, work: 0, cats: {}, slowCats: {}, worst: null, busy: 0 });
    cur.seconds += x.dt; cur.frames += frames; cur.s33 += x.s33 ?? 0; cur.s50 += x.s50 ?? 0; cur.busy += (x.busy ?? 0) * x.dt;
    if (x.c) { cur.acctFrames += frames; cur.work += (x.w ?? 0) * frames; add(cur.cats, x.c, frames); }
    if (x.sc) add(cur.slowCats, x.sc);
    if (x.wf && (!cur.worst || x.wf[0] > cur.worst[0])) cur.worst = x.wf;
  }
  // (a stretch shorter than 10 s is merged into the previous one — a loading hiccup — then neighbours of one kind)
  const merge = (a, b) => { a.seconds += b.seconds; a.frames += b.frames; a.s33 += b.s33; a.s50 += b.s50; a.busy += b.busy; a.acctFrames += b.acctFrames; a.work += b.work; add(a.cats, b.cats); add(a.slowCats, b.slowCats); if (b.worst && (!a.worst || b.worst[0] > a.worst[0])) a.worst = b.worst; };
  const kept = [];
  for (const st of out) {
    const last = kept[kept.length - 1];
    if (last && (st.seconds < 10 || st.kind === last.kind)) merge(last, st); else kept.push(st);
  }
  return kept;
}

const report = [];
for (const s of sessions.values()) {
  const seconds = s.samples.reduce((a, x) => a + x.dt, 0);
  if (seconds < minSeconds) continue;
  const r = { session: s.id, game: s.game, gpu: s.env?.gpu ?? null, cores: s.env?.cores ?? null, version: s.version, options: s.options, seconds: Math.round(seconds), slowEvents: s.slow, stretches: [] };
  for (const st of stretches(s.samples)) {
    const min = st.seconds / 60, n = st.acctFrames || 1, slowTotal = Object.values(st.slowCats).reduce((a, b) => a + b, 0);
    r.stretches.push({ kind: st.kind, at: new Date(st.t0).toISOString().slice(11, 19), seconds: Math.round(st.seconds), fps: +(st.frames / st.seconds).toFixed(1), busy: Math.round(st.busy / st.seconds), per33: Math.round(st.s33 / min), per50: Math.round(st.s50 / min),
      work: st.acctFrames ? +(st.work / n).toFixed(1) : null, cats: st.acctFrames ? fmt(st.cats, 1 / n) : null, slowShares: slowTotal ? fmt(st.slowCats, 100 / slowTotal, 1) : null, worst: st.worst });
  }
  report.push(r);
}
if (args.includes('--json')) { console.log(JSON.stringify(report, null, 1)); process.exit(0); }
for (const r of report) {
  console.log(`session ${r.session} ${r.game} ${r.seconds} s, ${r.gpu ?? '?'}${r.cores ? `, ${r.cores} cores` : ''}${r.version ? `, build ${r.version}` : ''}; ${r.slowEvents} slow-frame events`);
  if (r.options) console.log(`  options: ${Object.entries(r.options).filter(([, v]) => v !== '' && v !== false).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  for (const st of r.stretches) {
    console.log(`  ${st.at} ${st.kind.padEnd(9)} ${String(st.seconds).padStart(5)} s ${String(st.fps).padStart(5)} fps busy ${st.busy}% >33 ms ${st.per33}/min >50 ms ${st.per50}/min${st.work !== null ? `; work ${st.work} ms/frame: ${st.cats}` : ''}`);
    if (st.slowShares) console.log(`      slow frames' time (%): ${st.slowShares}; worst ${st.worst[0]} ms (work ${st.worst[1]}: ${Object.entries(st.worst[2]).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  }
}
