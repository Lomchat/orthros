#!/usr/bin/env node
// Load test of an Orthros server: N simulated players at once, each a first visit of the home (the page, its config,
// the catalog, the covers) then a game's start the way the shared reader does it (its manifest, tree and learned
// order, then its demand reads — the order's 64 KiB pieces and 1 MiB blocks, a few in flight — and background
// blocks, &p=1). A probe asks a tiny route every 25 ms the whole time: its latency is the server's event loop stall,
// what every player's next read waits for. No browser.
//
//   node tools/server-load.mjs --url http://127.0.0.1:8080 [--clients 20] [--seconds 30] [--games a,b] [--pid <server pid>]
//        [--accept 'gzip, deflate, br, zstd'] [--json]
// --pid: the server's resident memory sampled too (/proc/<pid>/status). Prints per-route latency p50/p90/p99/max (ms),
// requests, bytes, and the server's /api/netstats delta.
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const base = arg('--url', 'http://127.0.0.1:8080').replace(/\/$/, '');
const clients = Number(arg('--clients', 20)), seconds = Number(arg('--seconds', 30)), pid = arg('--pid');
const accept = arg('--accept', 'gzip, deflate, br, zstd');
const BLOCK = 1 << 20, CHUNK = 64 << 10;

const stats = new Map(); // route -> { t: [], bytes, errors }
const note = (route, ms, bytes, ok) => {
  let s = stats.get(route); if (!s) stats.set(route, s = { t: [], bytes: 0, errors: 0 });
  s.t.push(ms); s.bytes += bytes; if (!ok) s.errors++;
};
const get = async (route, url, headers = {}) => {
  const t0 = performance.now();
  try {
    const r = await fetch(base + url, { headers: { 'accept-encoding': accept, ...headers } });
    const b = await r.arrayBuffer();
    note(route, performance.now() - t0, Number(r.headers.get('content-length') ?? b.byteLength), r.ok || r.status === 304);
    return r.ok ? { r, b } : null;
  } catch { note(route, performance.now() - t0, 0, false); return null; }
};
const json = (x) => { try { return JSON.parse(Buffer.from(x.b).toString('utf8')); } catch { return null; } };

const deadline = performance.now() + seconds * 1000;
const live = () => performance.now() < deadline;

const catalog = json(await get('warm', '/api/manifests')) ?? [];
const wantGames = arg('--games', null)?.split(',');
const games = catalog.filter((m) => m.available && (!wantGames || wantGames.includes(m.name)));
if (!games.length) { console.error('no available game'); process.exit(2); }

const fileSize = (tree, rel) => {
  let n = tree; const parts = rel.split('/');
  for (let i = 0; i < parts.length - 1; i++) { n = n.dirs?.[parts[i]]; if (!n) return null; }
  return n.files?.[parts.at(-1)]?.size ?? null;
};

async function player(i) {
  const session = `load${process.pid}x${i}x${Date.now().toString(36)}`;
  // home, first visit
  await Promise.all([get('home /', '/'), get('home /api/config', '/api/config'), get('home /api/manifests', '/api/manifests')]);
  await Promise.all(games.slice(0, 8).map((g) => get('home cover', `/api/cover/${encodeURIComponent(g.name)}`)));
  const g = games[i % games.length], id = encodeURIComponent(g.name);
  await get('start /api/manifest', `/api/manifest/${id}`);
  const [t, o] = await Promise.all([get('start /api/tree', `/api/tree/${id}`), get('start /api/prefetch', `/api/prefetch/${id}`)]);
  const tree = t && json(t), order = (o && json(o)) ?? [];
  if (!tree) return;
  // the reads: each learned entry's pieces (its mask) or its whole block, 4 in flight; background blocks beside, 2
  const demand = [], bg = [];
  for (const [rel, block, mask] of order) {
    const size = fileSize(tree, rel); if (size === null) continue;
    const b0 = block * BLOCK; if (b0 >= size) continue;
    const enc = rel.split('/').map(encodeURIComponent).join('/');
    if (!mask || mask === 0xffffffff || mask === -1) { demand.push(`/gamez/${id}/${enc}?r=${b0}-${Math.min(size, b0 + BLOCK)}&s=${session}`); continue; }
    for (let c = 0; c < 16; c++) if (mask & (1 << c)) { const a = b0 + c * CHUNK; if (a < size) demand.push(`/gamez/${id}/${enc}?r=${a}-${Math.min(size, a + CHUNK)}&s=${session}`); }
    bg.push(`/gamez/${id}/${enc}?r=${b0}-${Math.min(size, b0 + BLOCK)}&p=1`);
  }
  let di = 0, bi = 0;
  const lane = async (list, next, route) => { for (let k; live() && (k = next()) < list.length;) await get(route, list[k]); };
  await Promise.all([
    ...Array.from({ length: 4 }, () => lane(demand, () => di++, 'gamez demand')),
    ...Array.from({ length: 2 }, () => lane(bg, () => bi++, 'gamez bg')),
  ]);
}

const rss = [];
const rssOf = () => { try { const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Number(m[1]) / 1024 : null; } catch { return null; } };
const net0 = json(await get('warm', '/api/netstats'));
const probe = (async () => { while (live()) { await get('probe /api/config', '/api/config'); if (pid) rss.push(rssOf()); await new Promise((r) => setTimeout(r, 25)); } })();
const t0 = performance.now();
// players arrive over the first quarter of the run, each starting again once done
await Promise.all(Array.from({ length: clients }, async (_, i) => {
  await new Promise((r) => setTimeout(r, (i / clients) * seconds * 250));
  for (let round = 0; live(); round++) await player(i + round * clients);
}));
await probe;
const net1 = json(await get('warm', '/api/netstats'));

const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const out = { clients, seconds: (performance.now() - t0) / 1000, routes: {} };
for (const [route, s] of stats) {
  if (route === 'warm') continue;
  s.t.sort((a, b) => a - b);
  out.routes[route] = { n: s.t.length, p50: +q(s.t, 0.5).toFixed(1), p90: +q(s.t, 0.9).toFixed(1), p99: +q(s.t, 0.99).toFixed(1), max: +s.t.at(-1).toFixed(1), MB: +(s.bytes / 1e6).toFixed(1), errors: s.errors };
}
if (net0 && net1) out.netstats = { requests: net1.requests - net0.requests, sentMB: +((net1.sent - net0.sent) / 1e6).toFixed(1), encodeMs: Math.round(net1.encodeMs - net0.encodeMs), cacheHits: net1.cacheHits - net0.cacheHits, brHits: net1.brHits - net0.brHits };
if (rss.length) { const r = rss.filter((x) => x !== null); out.rssMB = { first: Math.round(r[0]), max: Math.round(Math.max(...r)), last: Math.round(r.at(-1)) }; }
if (args.includes('--json')) console.log(JSON.stringify(out));
else {
  console.log(`${clients} clients, ${out.seconds.toFixed(1)} s${out.rssMB ? `, server RSS ${out.rssMB.first} -> max ${out.rssMB.max} MB` : ''}`);
  console.log('route'.padEnd(22), 'n'.padStart(6), 'p50'.padStart(8), 'p90'.padStart(8), 'p99'.padStart(8), 'max'.padStart(8), 'MB'.padStart(8), 'err'.padStart(5));
  for (const [r, s] of Object.entries(out.routes)) console.log(r.padEnd(22), String(s.n).padStart(6), String(s.p50).padStart(8), String(s.p90).padStart(8), String(s.p99).padStart(8), String(s.max).padStart(8), String(s.MB).padStart(8), String(s.errors).padStart(5));
  if (out.netstats) console.log('netstats', JSON.stringify(out.netstats));
}
