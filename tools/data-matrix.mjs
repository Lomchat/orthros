// Data-system matrix (docs/slow-network.md "Measuring"): every version of the catalog (/api/manifests) × link, as a new
// player in a fresh browser. Each run gets its own Orthros server (this tree's code) over a fresh copy of a learned
// directory (the live server's, copied once by hand) and a frozen copy of its precompressed units (--br-cache-frozen:
// what a player meets now, the same for every run), behind the player's-link proxy (tools/net-proxy.mjs: HTTP/2, one
// shared link, a round trip per request, Cloudflare's Accept-Encoding); the browser run is tools/data-matrix-run.mjs
// through the browser slot guard. One JSON line per run in --out: the runner's times (first frame, shown, playable,
// in play), and from the proxy's log up to the playable mark (else the end): bytes on the wire by kind (page /src,
// engine, game data demand / background, APIs), requests, the share of /gamez answers from precompressed units, and the
// demand-wait seconds (the time at least one of the game's own reads — neither `p=1` nor `a=1` — was in flight).
//
//   node tools/data-matrix.mjs --pristine <dir with learn/ brcache/ covers/> [--links 85k:150,1m:60,7m:75]
//     [--only a,b] [--skip a,b] [--parallel 2] [--seconds 85k=1800,1m=900,7m=600] [--win32-seconds N] [--out results.jsonl] [--scratch <dir>]
//     [--games-dir /srv/orthros/data/games] [--engines-dir /srv/orthros/data/engines] [--lang <code>]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startProxy, summarize, spkiOf, freePort, startOrigin } from './net-proxy.mjs';
import { DEFAULT_GAMES_DIR } from '../src/host/game-catalog.js';
import { DEFAULT_ENGINES_DIR } from '../src/host/goldsrc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const pristine = opt('pristine') && path.resolve(opt('pristine')); if (!pristine) { console.error('--pristine <dir> (learn/, brcache/, covers/)'); process.exit(2); }
// (absolute: the runner's cwd is this tree — a relative --json / --shot wrote its files into it)
const scratch = path.resolve(opt('scratch', path.join(path.dirname(pristine), 'runs')));
const gamesDir = opt('games-dir', DEFAULT_GAMES_DIR), enginesDir = opt('engines-dir', DEFAULT_ENGINES_DIR);
const outFile = path.resolve(opt('out', path.join(scratch, 'results.jsonl')));
const parallel = Number(opt('parallel', 2));

/** a link name (85k, 1m, 7m: KB/s of 1000 bytes, MB/s of 10^6) and its round trip: { name, rate, rtt } */
export function parseLink(s) {
  const [n, rtt] = s.split(':'); const m = /^([\d.]+)([km])$/.exec(n);
  if (!m) throw new Error(`link ${s}: <n>k|<n>m[:rtt ms]`);
  return { name: n, rate: Number(m[1]) * (m[2] === 'k' ? 1e3 : 1e6), rtt: Number(rtt ?? 50) };
}
const links = opt('links', '85k:150,1m:60,7m:75').split(',').map(parseLink);
const secs = Object.fromEntries(opt('seconds', '85k=1800,1m=900,7m=600').split(',').map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));

// (the proxy log's summary, tools/net-proxy.mjs: here since the matrix; tools/prepare-bench.mjs takes it from here)
export { summarize };

async function one(m, link) {
  const tag = `${m.name}-${link.name}`, dir = path.join(scratch, tag);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  execFileSync('cp', ['-a', path.join(pristine, 'learn'), path.join(dir, 'learn')]);
  const origin = await startOrigin({ tree: root, learn: path.join(dir, 'learn'), telemetry: path.join(dir, 'telemetry'), brcache: path.join(pristine, 'brcache'),
    covers: path.join(pristine, 'covers'), gamesDir, enginesDir, log: path.join(dir, 'server.log') });
  const sport = origin.port;
  const proxy = await startProxy({ upstream: `127.0.0.1:${sport}`, listen: 0, rate: link.rate, rtt: link.rtt, log: path.join(dir, 'proxy.jsonl'), certs: path.join(scratch, 'cert') });
  const lang = opt('lang') && m.languages.includes(opt('lang')) ? opt('lang') : m.languages.includes('en') ? 'en' : m.languages[0];
  // (--win32-seconds: a Win32 game's window — its menu's time on a loaded machine is the CPU's (SwiftShader), its data the
  // same window for every run)
  const seconds = (m.runtime ?? 'win32') === 'win32' && opt('win32-seconds') ? Number(opt('win32-seconds')) : secs[link.name] ?? 900;
  const runJson = path.join(dir, 'run.json');
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    const p = spawn('bash', [path.join(root, 'tools/with-browser-slot.sh'), process.execPath, path.join(root, 'tools/data-matrix-run.mjs'), '--base', `https://127.0.0.1:${proxy.port}`, '--manifest', m.name,
      ...(lang ? ['--lang', lang] : []), '--spki', spkiOf(path.join(scratch, 'cert')), '--seconds', String(seconds), '--json', runJson, '--shot', path.join(dir, 'end.png')], { cwd: root, env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; p.stdout.on('data', (d) => { text += d; }); p.stderr.on('data', (d) => { text += d; });
    p.on('close', (code) => resolve({ code, text }));
  });
  await proxy.close(); await origin.close();
  let run = null; try { run = JSON.parse(fs.readFileSync(runJson, 'utf8')); } catch { /* its output's line */ }
  if (!run) { const m = /^RESULT (.*)$/m.exec(res.text); try { run = m ? JSON.parse(m[1]) : null; } catch { /* none */ } }
  run ??= { error: `runner exited ${res.code}: ${res.text.slice(-400)}` };
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
