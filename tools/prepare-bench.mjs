// "Prepare" (the home's launch-set download, src/host/web/download-worker.js) replayed in Node for every version of the
// catalog × link — no browser: the download worker's own code (openVersion, launchSet, the engine's files, then
// HttpBackend.prefetch with learnedOnly) over the player's-link proxy (tools/net-proxy.mjs, plain HTTP here) in front
// of one Orthros server of a code tree (--code: this tree, or a copy of another commit) on a learned directory's copy
// and a frozen copy of the precompressed units. A port's page waits for the same set at a first launch (data-worker.js
// startup()), so its time is the floor of the time to the menu on that link. One JSON line per run: seconds, wire
// bytes (engine apart), requests, unit answers, the card's sizes (/api/manifests launch); `readyS` / `readyWireMB`: the
// time and wire bytes to the first progress that says done — "Ready" — (an engine that reloads in place, the card's
// `reloads`: its light set's end, the files themselves coming after as a second stage counted in `seconds`).
//
//   node tools/prepare-bench.mjs --pristine <dir with learn/ brcache/ covers/> [--code <tree>] [--links 85k:150,1m:60,7m:75]
//     [--only a,b] [--out file] [--max-seconds 1800] [--logs <dir>: the proxy's logs kept] [--known-bw]
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startProxy } from './net-proxy.mjs';
import { parseLink, summarize } from './data-matrix.mjs';
import { DEFAULT_GAMES_DIR } from '../src/host/game-catalog.js';
import { DEFAULT_ENGINES_DIR } from '../src/host/goldsrc.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const code = path.resolve(opt('code', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const pristine = opt('pristine'); if (!pristine) { console.error('--pristine <dir>'); process.exit(2); }
const links = opt('links', '85k:150,1m:60,7m:75').split(',').map(parseLink);
const out = opt('out', '/dev/stdout'), maxSeconds = Number(opt('max-seconds', 1800)), keepLogs = opt('logs', null);
const only = opt('only')?.split(',');
const work = fs.mkdtempSync(path.join(path.dirname(path.resolve(pristine)), 'prep-'));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

execFileSync('cp', ['-a', path.join(pristine, 'learn'), path.join(work, 'learn')]);
const sport = await freePort();
const srv = spawn(process.execPath, [path.join(code, 'src/host/server.js'), '--port', String(sport), '--learn', path.join(work, 'learn'), '--br-cache', path.join(pristine, 'brcache'), '--br-cache-frozen',
  '--covers', 'off', '--games-dir', opt('games-dir', DEFAULT_GAMES_DIR), '--engines-dir', opt('engines-dir', DEFAULT_ENGINES_DIR)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => { srv.stdout.on('data', (d) => { if (String(d).includes('orthros: http')) r(); }); setTimeout(r, 30000); });
const catalog = await (await fetch(`http://127.0.0.1:${sport}/api/manifests`)).json();

const { download } = await import(pathToFileURL(path.join(code, 'src/host/web/download-worker.js')).href);
const { MemBlockStore } = await import(pathToFileURL(path.join(code, 'src/vfs/opfs-store.js')).href);
const realFetch = globalThis.fetch;
let base = null;
// (a new player's browser: nothing in its HTTP cache — an "only-if-cached" request fails, as Chrome's 504)
globalThis.fetch = (u, o = {}) => { const { cache, mode, ...rest } = o; if (cache === 'only-if-cached') return Promise.resolve(new Response(null, { status: 504 })); return realFetch(typeof u === 'string' && u.startsWith('/') ? base + u : u, rest); };
// (the last progress message: the worker's last post is 'stopped')
let last = null, readyAt = null; globalThis.self = { postMessage: (m) => { if (m.type !== 'stopped') last = m; if (m.type === 'progress' && m.done && readyAt === null) readyAt = performance.now(); } };

try {
  for (const link of links) for (const m of catalog) {
    if (!m.available || (only && !only.includes(m.name))) continue;
    const langs = m.launch?.langs ? Object.keys(m.launch.langs) : [];
    const lang = langs.includes('en') ? 'en' : langs[0] ?? (m.languages.includes('en') ? 'en' : m.languages[0] ?? null);
    const card = (lang && m.launch?.langs?.[lang]) ?? m.launch;
    const logf = path.join(work, `${m.name}-${link.name}.jsonl`);
    const proxy = await startProxy({ upstream: `127.0.0.1:${sport}`, listen: 0, rate: link.rate, rtt: link.rtt, log: logf, http1: true });
    base = `http://127.0.0.1:${proxy.port}`; last = null; readyAt = null;
    const t0 = performance.now();
    const engine = card?.engineFiles?.length ? { files: card.engineFiles, bytes: card.engine } : null;
    const timer = setTimeout(() => { globalThis.self.onmessage?.({ data: { type: 'stop' } }); }, maxSeconds * 1000);
    // (--known-bw: the page knew the link's rate — a player who came before —, else a new player's unmeasured link)
    await download(m.name, args.includes('--known-bw') ? link.rate : undefined, 'launch', lang, engine, { openStore: async () => new MemBlockStore(2 ** 32) }, card?.reloads === true);
    clearTimeout(timer);
    const seconds = Math.round((performance.now() - t0) / 100) / 10;
    await proxy.close();
    const recs = fs.readFileSync(logf, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const s = summarize(recs), ready = readyAt === null ? null : summarize(recs, readyAt - t0);
    const row = { manifest: m.name, runtime: m.runtime, lang, link: link.name, marked: !!m.launch, seconds, done: !!last?.done, error: last?.error ?? null,
      cardMB: card ? Math.round((card.wire ?? 0) / 1e4) / 100 : null, cardLightMB: card ? Math.round((card.lightWire ?? 0) / 1e4) / 100 : null, engineCardMB: card?.engine ? Math.round(card.engine / 1e4) / 100 : 0,
      reloads: card?.reloads === true, readyS: readyAt === null ? null : Math.round((readyAt - t0) / 100) / 10, readyWireMB: ready?.wireMB ?? null,
      wireMB: s.wireMB, engineMB: s.byKind.engine?.MB ?? 0, dataMB: s.byKind.background?.MB ?? 0, requests: s.requests, dataRequests: s.dataRequests, units: s.units };
    fs.appendFileSync(out, JSON.stringify(row) + '\n');
    console.error(`[prepare] ${m.name} ${link.name}: ready ${row.readyS} s (${row.readyWireMB} MB), all ${seconds} s, ${s.wireMB} MB (engine ${row.engineMB}), ${s.requests} req, units ${JSON.stringify(s.units)}${row.error ? ' ' + row.error : ''}`);
    if (keepLogs) { fs.mkdirSync(keepLogs, { recursive: true }); fs.copyFileSync(logf, path.join(keepLogs, path.basename(logf))); }
    fs.rmSync(logf, { force: true });
  }
} finally { srv.kill(); fs.rmSync(work, { recursive: true, force: true }); process.exit(0); }
