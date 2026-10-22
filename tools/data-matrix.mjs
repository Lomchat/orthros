// Data-system matrix (docs/slow-network.md "Measuring"): every version of the catalog (/api/manifests) × link, as a new
// player in a fresh browser. Each run gets its own Orthros server (this tree's code) over a fresh copy of a learned
// directory (the live server's, copied once by hand) and a frozen copy of its precompressed units (--br-cache-frozen:
// what a player meets now, the same for every run), behind the throttling proxy (tools/throttle-proxy.mjs: HTTP/2, one
// shared link, a round trip per request, Cloudflare's Accept-Encoding); the browser run is tools/data-matrix-run.mjs
// through the browser slot guard. One JSON line per run in --out: the runner's times (first frame, shown, playable,
// in play), and from the proxy's log up to the playable mark (else the end): bytes on the wire by kind (page /src,
// engine, game data demand / background, APIs), requests, the share of /gamez answers from precompressed units, and the
// demand-wait seconds (the time at least one of the game's own reads — neither `p=1` nor `a=1` — was in flight).
//
//   node tools/data-matrix.mjs --pristine <dir with learn/ brcache/ covers/> [--links 85k:150,1m:60,7m:75]
//     [--only a,b] [--skip a,b] [--parallel 2] [--seconds 85k=1800,1m=900,7m=600] [--out results.jsonl] [--scratch <dir>]
//     [--games-dir /srv/orthros/data_games] [--engines-dir /srv/orthros/data_engines] [--lang <code>]
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startProxy } from './throttle-proxy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const pristine = opt('pristine'); if (!pristine) { console.error('--pristine <dir> (learn/, brcache/, covers/)'); process.exit(2); }
const scratch = opt('scratch', path.join(path.dirname(path.resolve(pristine)), 'runs'));
const gamesDir = opt('games-dir', '/srv/orthros/data_games'), enginesDir = opt('engines-dir', '/srv/orthros/data_engines');
const outFile = opt('out', path.join(scratch, 'results.jsonl'));
const parallel = Number(opt('parallel', 2));

/** a link name (85k, 1m, 7m: KB/s of 1000 bytes, MB/s of 10^6) and its round trip: { name, rate, rtt } */
export function parseLink(s) {
  const [n, rtt] = s.split(':'); const m = /^([\d.]+)([km])$/.exec(n);
  if (!m) throw new Error(`link ${s}: <n>k|<n>m[:rtt ms]`);
  return { name: n, rate: Number(m[1]) * (m[2] === 'k' ? 1e3 : 1e6), rtt: Number(rtt ?? 50) };
}
const links = opt('links', '85k:150,1m:60,7m:75').split(',').map(parseLink);
const secs = Object.fromEntries(opt('seconds', '85k=1800,1m=900,7m=600').split(',').map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));

/**
 * The proxy log's summary up to `until` ms (its own clock): bytes and requests by kind, unit answers, demand-wait.
 * `recs`: the log's request lines.
 */
export function summarize(recs, until = Infinity) {
  const kinds = {}; let wire = 0, requests = 0, gz = 0, units = { hit: 0, raw: 0, miss: 0, none: 0 }, unitWire = { hit: 0, raw: 0, miss: 0, none: 0 };
  const demand = [];
  for (const r of recs) {
    if (r.mark || r.t > until) continue;
    // (the game's own reads: no `p=1` nor `a=1` — `&s=` when the backend has a session, nothing for a port's data worker)
    const k = r.url.startsWith('/gamez/') || r.url.startsWith('/game/') ? (/[?&][pa]=1/.test(r.url) ? 'background' : 'demand') : r.url.startsWith('/src/') ? 'src' : r.url.startsWith('/engines/') ? 'engine' : r.url.startsWith('/api/') ? 'api' : 'page';
    const s = (kinds[k] ??= { requests: 0, wire: 0 }); s.requests++; s.wire += r.wire; wire += r.wire; requests++;
    if (k === 'demand' || k === 'background') { gz++; const u = r.unit ?? 'none'; units[u] = (units[u] ?? 0) + 1; unitWire[u] = (unitWire[u] ?? 0) + r.wire; }
    if (k === 'demand') demand.push([r.t, Math.min(until, r.t + r.ms)]);
  }
  demand.sort((a, b) => a[0] - b[0]);
  let waitMs = 0, cur = null;
  for (const [a, b] of demand) { if (!cur || a > cur[1]) { if (cur) waitMs += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b); }
  if (cur) waitMs += cur[1] - cur[0];
  const MB = (n) => Math.round(n / 1e4) / 100;
  return {
    wireMB: MB(wire), requests, byKind: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, { requests: v.requests, MB: MB(v.wire) }])),
    dataRequests: gz, units, unitMB: Object.fromEntries(Object.entries(unitWire).map(([k, v]) => [k, MB(v)])), demandWaitS: Math.round(waitMs / 100) / 10,
  };
}

/** the base64 SHA-256 of the proxy certificate's key: the browser trusts it (--ignore-certificate-errors-spki-list) */
const spkiOf = (dir) => execFileSync('bash', ['-c', `openssl x509 -in ${JSON.stringify(path.join(dir, 'cert.pem'))} -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`], { encoding: 'utf8' }).trim();
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function one(m, link) {
  const tag = `${m.name}-${link.name}`, dir = path.join(scratch, tag);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  execFileSync('cp', ['-a', path.join(pristine, 'learn'), path.join(dir, 'learn')]);
  const sport = await freePort();
  const srv = spawn(process.execPath, [path.join(root, 'src/host/server.js'), '--port', String(sport), '--learn', path.join(dir, 'learn'), '--telemetry', path.join(dir, 'telemetry'),
    '--br-cache', path.join(pristine, 'brcache'), '--br-cache-frozen', '--covers', path.join(pristine, 'covers'), '--games-dir', gamesDir, '--engines-dir', enginesDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const srvLog = fs.createWriteStream(path.join(dir, 'server.log')); srv.stdout.pipe(srvLog); srv.stderr.pipe(srvLog);
  await new Promise((resolve) => { const on = (d) => { if (String(d).includes('orthros: http')) { srv.stdout.off('data', on); resolve(); } }; srv.stdout.on('data', on); setTimeout(resolve, 30000); });
  // (the page's modules made brotli as on a server up for a while: every src text file asked once, then until all come so)
  const srcFiles = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(m?js|html|css|json|svg|txt)$/.test(e.name) && fs.statSync(f).size >= 512) srcFiles.push(path.relative(root, f)); } };
  walk(path.join(root, 'src'));
  for (let pass = 0, left = srcFiles; pass < 8 && left.length; pass++) {
    const next = [];
    for (let i = 0; i < left.length; i += 16) await Promise.all(left.slice(i, i + 16).map(async (f) => { const r = await fetch(`http://127.0.0.1:${sport}/${f}`, { headers: { 'accept-encoding': 'br' } }).catch(() => null); await r?.arrayBuffer().catch(() => {}); if (r && r.headers.get('content-encoding') !== 'br' && r.status === 200) next.push(f); }));
    left = next; if (left.length) await new Promise((r) => setTimeout(r, 1500));
  }
  const proxy = await startProxy({ upstream: `127.0.0.1:${sport}`, port: 0, rate: link.rate, rtt: link.rtt, log: path.join(dir, 'proxy.jsonl'), certDir: path.join(scratch, 'cert') });
  const lang = opt('lang') && m.languages.includes(opt('lang')) ? opt('lang') : m.languages.includes('en') ? 'en' : m.languages[0];
  const seconds = secs[link.name] ?? 900;
  const runJson = path.join(dir, 'run.json');
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    const p = spawn('bash', [path.join(root, 'tools/with-browser-slot.sh'), process.execPath, path.join(root, 'tools/data-matrix-run.mjs'), '--base', `https://127.0.0.1:${proxy.port}`, '--manifest', m.name,
      ...(lang ? ['--lang', lang] : []), '--spki', spkiOf(path.join(scratch, 'cert')), '--seconds', String(seconds), '--json', runJson, '--shot', path.join(dir, 'end.png')], { cwd: root, env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; p.stdout.on('data', (d) => { text += d; }); p.stderr.on('data', (d) => { text += d; });
    p.on('close', (code) => resolve({ code, text }));
  });
  await proxy.close(); srv.kill('SIGTERM');
  let run = null; try { run = JSON.parse(fs.readFileSync(runJson, 'utf8')); } catch { run = { error: `runner exited ${res.code}: ${res.text.slice(-400)}` }; }
  const recs = fs.readFileSync(path.join(dir, 'proxy.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const nav = recs.find((r) => !r.mark && r.url.startsWith('/?manifest='))?.t ?? 0;
  const mark = recs.find((r) => r.mark?.kind === 'playable' && r.url.endsWith('/' + encodeURIComponent(m.name)));
  const row = {
    manifest: m.name, runtime: m.runtime, lang, link: link.name, rtt: link.rtt, run,
    markS: mark ? Math.round((mark.t - nav) / 100) / 10 : null,
    toPlayable: summarize(recs, mark ? mark.t : Infinity), all: summarize(recs), slotWaitS: Math.round((Date.now() - t0) / 1000 - (run?.wall ?? 0)),
  };
  fs.appendFileSync(outFile, JSON.stringify(row) + '\n');
  // (the logs kept, small; the server's copies removed)
  fs.rmSync(path.join(dir, 'learn'), { recursive: true, force: true }); fs.rmSync(path.join(dir, 'telemetry'), { recursive: true, force: true });
  execFileSync('gzip', ['-f', path.join(dir, 'proxy.jsonl')]);
  console.log(`[matrix] ${tag}: first frame ${run?.firstFrame ?? '-'} s, shown ${run?.shown ?? '-'} s, playable ${row.markS ?? '-'} s, in play ${run?.inPlay ?? '-'} s; to playable ${row.toPlayable.wireMB} MB, ${row.toPlayable.requests} req, demand wait ${row.toPlayable.demandWaitS} s${run?.error ? ` (${run.error})` : ''}`);
  return row;
}

async function main() {
  fs.mkdirSync(scratch, { recursive: true });
  // (the catalog from a throwaway server over the pristine copy: every version, hidden ones too)
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(root, 'src/host/server.js'), '--port', String(port), '--games-dir', gamesDir, '--engines-dir', enginesDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => { srv.stdout.on('data', (d) => { if (String(d).includes('orthros: http')) r(); }); setTimeout(r, 20000); });
  const catalog = await (await fetch(`http://127.0.0.1:${port}/api/manifests`)).json(); srv.kill();
  const only = opt('only')?.split(','), skip = opt('skip')?.split(',') ?? [];
  const jobs = [];
  for (const link of links) for (const m of catalog) if (m.available && (!only || only.includes(m.name)) && !skip.includes(m.name)) jobs.push([m, link]);
  console.log(`[matrix] ${jobs.length} runs, ${parallel} at a time`);
  const running = new Set();
  for (const [m, link] of jobs) {
    while (running.size >= parallel) await Promise.race(running);
    const p = one(m, link).catch((e) => console.log(`[matrix] ${m.name}-${link.name}: ${e.stack ?? e}`)).finally(() => running.delete(p));
    running.add(p);
    await new Promise((r) => setTimeout(r, 3000));
  }
  await Promise.all(running);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
