// A player's connection in front of an Orthros server (measurement tool, docs/slow-network.md "Measuring"): an HTTP/2
// TLS proxy, as the production front (Cloudflare) speaks to Chrome — every request of the page on ONE connection, no
// six-connections-per-host queue as a local HTTP/1.1 server has (a synchronous game read queued behind six background
// downloads is a local artifact, not a player's) —, with a round trip and one downstream link whose rate the answers in
// transfer share equally (HTTP/2 interleaves its streams' frames), and the origin asked with `Accept-Encoding: gzip, br`
// (Cloudflare's: no zstd); a text answer the origin sends as it is goes gzip-compressed on the way (Cloudflare's
// `cf-cache-status: DYNAMIC`: /api/regions/<manifest> 1065 KB → 136 KB on the live site).
//
//   node tools/net-proxy.mjs --upstream http://127.0.0.1:18431 --listen 18443 --rate 7m --rtt 75 [--log <file>] [--certs <dir>] [--http1]
//
// The page is then https://127.0.0.1:18443/ (Chrome with --ignore-certificate-errors, or trusting the key of the
// self-signed certificate made with openssl in --certs, default a new temporary directory). --log: one JSON line per
// request — t (ms from the proxy's start), method, url, kind (demand: the game's own read `&s=`, bg: `&p=1`, ahead:
// `&a=1`, other), status, wire (body bytes sent + ~200 of headers), enc, unit (X-Orthros-Unit: hit, raw, miss, none),
// first (ms to the first byte), ms (total), reset when the browser cancelled it —, and a line { t, mark, url } for each
// data report carrying a mark (`/api/prefetch/<manifest>` POSTs with `mark`: a page's or worker's "playable"), which
// GET /__proxy/marks lists (not forwarded). --http1: plain HTTP/1.1 (a Node client: tools/prepare-bench.mjs).
// tools/data-matrix.mjs, tools/prepare-bench.mjs and tools/openmw/place-load.mjs use startProxy; the log's readers
// (readLog, summarize: the run's bytes by kind; loadWindow: a stretch of it — the game's own reads, their spacing, and
// the background's bytes by kind and file category) and the origin behind it (startOrigin: an Orthros server of a code
// tree on a measurement's copies, spkiOf, freePort) are theirs too.
import http from 'node:http';
import net from 'node:net';
import http2 from 'node:http2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
/** "7m" / "85k" / "7000000" → bytes per second */
export function parseRate(s) { const m = /^([\d.]+)\s*([kKmM]?)/.exec(String(s)); if (!m) return NaN; return Number(m[1]) * (m[2].toLowerCase() === 'm' ? 1e6 : m[2].toLowerCase() === 'k' ? 1e3 : 1); }

/**
 * The downstream link: `rate` bytes/s shared equally by the streams with bytes to send (round robin in quanta of
 * QUANTUM bytes every tick), each stream's bytes in order.
 */
export class Shaper {
  constructor(rate, { now = () => performance.now(), tickMs = 2 } = {}) {
    this.rate = rate / 1000; this.now = now; this.tickMs = tickMs;
    /** streams with bytes waiting: { queue: Buffer[], write(buf), end?, onDone } */
    this.active = []; this.credit = 0; this.last = now(); this.timer = null; this.rr = 0;
  }
  /** queue `buf` on stream `s` (s.write(chunk) gets it once its share of the link carried it) */
  push(s, buf) { s.queue ??= []; s.queue.push(buf); if (!this.active.includes(s)) this.active.push(s); this.start(); }
  /** the stream's last byte queued: s.onEnd() runs once all of it crossed the link */
  finish(s) { s.ending = true; if (!s.queue?.length) { s.onEnd?.(); return; } if (!this.active.includes(s)) this.active.push(s); this.start(); }
  drop(s) { s.queue = []; s.dropped = true; this.active = this.active.filter((x) => x !== s); }
  start() { if (this.timer === null) { this.last = this.now(); this.timer = setInterval(() => this.tick(), this.tickMs); } }
  tick() {
    const now = this.now();
    // (credit of the idle link not hoarded: at most one tick's worth beyond what the streams take)
    this.credit = Math.min(this.credit + (now - this.last) * this.rate, Math.max(this.rate * this.tickMs * 4, 16384));
    this.last = now;
    while (this.credit >= 1 && this.active.length) {
      const n = this.active.length, share = Math.max(1, Math.floor(this.credit / n));
      for (const s of [...this.active]) {
        let give = Math.min(share, this.credit);
        while (give > 0 && s.queue.length) {
          const b = s.queue[0];
          if (b.length <= give) { s.queue.shift(); give -= b.length; this.credit -= b.length; s.write(b); }
          else { s.queue[0] = b.subarray(give); this.credit -= give; s.write(b.subarray(0, give)); give = 0; }
        }
        if (!s.queue.length) { this.active = this.active.filter((x) => x !== s); if (s.ending) s.onEnd?.(); }
      }
      if (share <= 1) break;
    }
    if (!this.active.length) { clearInterval(this.timer); this.timer = null; this.credit = 0; }
  }
}

function makeCert(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(key)) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'host', 'http2-settings']);

/** a text answer the origin sent as it is: the front compresses it (Cloudflare) */
const EDGE_TEXT = /^(text\/|application\/(json|javascript|xml|wasm)|image\/svg)/;

/**
 * The proxy: a promise of { server, port, marks, close() } — opts: { upstream (URL or host:port), listen (port, 0:
 * any), rate (bytes/s), rtt (ms), log (file or null), certs (directory of the certificate), http1, edgeGzip (true) }.
 */
export function startProxy({ upstream, listen = 0, rate, rtt = 0, log = null, certs, http1 = false, edgeGzip = true }) {
  const up = new URL(/^https?:/.test(upstream) ? upstream : `http://${upstream}`);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  const shaper = new Shaper(rate);
  const t0 = performance.now();
  const out = log ? fs.createWriteStream(log) : null;
  const marks = [];
  const half = rtt / 2;
  const handler = (req, res) => {
    const start = performance.now(), url = req.url;
    // (the runner's view of the marks seen: not forwarded, not throttled)
    if (url === '/__proxy/marks') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(marks)); return; }
    const kind = /[?&]s=/.test(url) ? 'demand' : /[?&]a=1/.test(url) ? 'ahead' : /[?&]p=1/.test(url) ? 'bg' : 'other';
    let sent = 0, ttfb = -1, reset = false, ended = false, enc = null, unit = null, status = 0;
    const s = { write: (b) => { sent += b.length; try { res.write(b); } catch { /* gone */ } }, onEnd: () => { if (ended) return; ended = true; try { res.end(); } catch { /* gone */ } } };
    const done = () => out?.write(JSON.stringify({ t: Math.round(start - t0), method: req.method, url, kind, status, wire: sent + 200, enc, unit, first: ttfb < 0 ? null : Math.round(ttfb), ms: Math.round(performance.now() - start), ...(reset ? { reset: true } : {}) }) + '\n');
    res.on('close', () => { if (!ended) { reset = true; shaper.drop(s); } done(); });
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith(':') && !HOP.has(k)) headers[k] = v;
    headers.host = up.host;
    if (headers['accept-encoding'] !== undefined) headers['accept-encoding'] = 'gzip, br'; // (Cloudflare's to the origin)
    // (a data report's mark, seen as it goes by)
    const body = [];
    if (req.method === 'POST' && url.startsWith('/api/prefetch/')) req.on('data', (c) => body.push(c));
    req.on('end', () => {
      if (!body.length) return;
      try { const j = JSON.parse(Buffer.concat(body).toString('utf8')); if (j?.mark) { const m = { t: Math.round(start - t0), mark: j.mark, url }; marks.push(m); out?.write(JSON.stringify(m) + '\n'); } } catch { /* not JSON */ }
    });
    // (the request crosses half the round trip before the origin sees it)
    const ureq = http.request({ host: up.hostname, port: up.port, method: req.method, path: url, headers, agent }, (ures) => {
      // (its headers cross the other half)
      const h = {};
      for (const [k, v] of Object.entries(ures.headers)) if (!HOP.has(k)) h[k] = v;
      status = ures.statusCode; enc = ures.headers['content-encoding'] ?? null; unit = ures.headers['x-orthros-unit'] ?? null;
      let src = ures;
      if (edgeGzip && !enc && status === 200 && /gzip/.test(String(req.headers['accept-encoding'] ?? '')) && EDGE_TEXT.test(String(ures.headers['content-type'] ?? ''))
        && !(Number(ures.headers['content-length']) < 1024)) {
        src = ures.pipe(zlib.createGzip({ level: 6 })); enc = h['content-encoding'] = 'gzip'; delete h['content-length'];
      }
      const pending = [];
      let upEnded = false, headSent = false;
      setTimeout(() => {
        if (reset) { ures.destroy(); return; }
        try { res.writeHead(status, h); } catch { ures.destroy(); return; }
        headSent = true; ttfb = performance.now() - start;
        for (const b of pending.splice(0)) shaper.push(s, b);
        if (upEnded) shaper.finish(s);
      }, half);
      src.on('data', (b) => { if (reset) return; if (headSent) shaper.push(s, b); else pending.push(b); });
      src.on('end', () => { upEnded = true; if (headSent && !reset) shaper.finish(s); });
      ures.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
    });
    ureq.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* gone */ } });
    res.on('close', () => { if (reset) ureq.destroy(); });
    // (the request's body, if any, held for half the round trip with it)
    const held = [];
    let reqEnded = false, go = false;
    req.on('data', (c) => { if (go) ureq.write(c); else held.push(c); });
    req.on('end', () => { reqEnded = true; if (go) ureq.end(); });
    setTimeout(() => { if (reset) return; go = true; for (const c of held) ureq.write(c); if (reqEnded) ureq.end(); }, half);
  };
  const server = http1 ? http.createServer(handler) : http2.createSecureServer({ ...makeCert(certs ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-proxy-'))), allowHTTP1: true, settings: { initialWindowSize: 16 << 20 } }, handler);
  return new Promise((resolve) => server.listen(Number(listen), '127.0.0.1', () => resolve({
    server, port: server.address().port, marks,
    close: () => new Promise((r) => { out?.end(); server.close(() => r()); setTimeout(r, 2000).unref?.(); }),
  })));
}

/** the base64 SHA-256 of the proxy certificate's key: the browser trusts it (--ignore-certificate-errors-spki-list) */
export const spkiOf = (dir) => execFileSync('bash', ['-c', `openssl x509 -in ${JSON.stringify(path.join(dir, 'cert.pem'))} -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`], { encoding: 'utf8' }).trim();
/** a free local port */
export const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/**
 * The origin behind the proxy for a measurement: the Orthros server of the code tree `tree` (its src/host/server.js)
 * on a port of its own, with the measurement's directories — `learn` (a fresh copy: the run's reports land there),
 * `telemetry`, `brcache` (always given: the default <learn>/../brcache would start making units; served `frozen`, none
 * made), `covers` (a directory or 'off'), `gamesDir`, `enginesDir` —, its output in `log`; ready once it listens, the
 * page's modules then made brotli as on a server up for a while (every src text file asked until all come so).
 * A promise of { port, close() }.
 */
export async function startOrigin({ tree, learn, telemetry, brcache, frozen = true, covers = 'off', gamesDir, enginesDir, log, warmSrc = true }) {
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(tree, 'src/host/server.js'), '--port', String(port), '--learn', learn, '--telemetry', telemetry,
    '--br-cache', brcache, ...(frozen ? ['--br-cache-frozen'] : []), '--covers', covers, '--games-dir', gamesDir, '--engines-dir', enginesDir], { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'] });
  if (log) { const w = fs.createWriteStream(log); srv.stdout.pipe(w); srv.stderr.pipe(w); }
  const exited = new Promise((r) => srv.on('exit', r));
  await new Promise((resolve) => { const on = (d) => { if (String(d).includes('orthros: http')) { srv.stdout.off('data', on); resolve(); } }; srv.stdout.on('data', on); srv.on('exit', resolve); setTimeout(resolve, 30000); });
  if (srv.exitCode !== null) throw new Error(`origin: the server exited (${srv.exitCode})${log ? `, see ${log}` : ''}`);
  if (warmSrc) {
    const srcFiles = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(m?js|html|css|json|svg|txt)$/.test(e.name) && fs.statSync(f).size >= 512) srcFiles.push(path.relative(tree, f)); } };
    walk(path.join(tree, 'src'));
    for (let pass = 0, left = srcFiles; pass < 8 && left.length; pass++) {
      const next = [];
      for (let i = 0; i < left.length; i += 16) await Promise.all(left.slice(i, i + 16).map(async (f) => { const r = await fetch(`http://127.0.0.1:${port}/${f}`, { headers: { 'accept-encoding': 'br' } }).catch(() => null); await r?.arrayBuffer().catch(() => {}); if (r && r.headers.get('content-encoding') !== 'br' && r.status === 200) next.push(f); }));
      left = next; if (left.length) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { port, close: () => { srv.kill('SIGTERM'); return Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); } };
}

/** A proxy log's lines (a file, gzip too): requests and marks, by request start (`t`; lines are written as they close). */
export function readLog(file) {
  const raw = fs.readFileSync(file); const text = (file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
  const recs = []; for (const l of text.split('\n')) { if (!l) continue; try { recs.push(JSON.parse(l)); } catch { /* a line cut by a kill */ } }
  return recs.sort((a, b) => a.t - b.t);
}

/**
 * A request's kind from its URL (the backend's rangeUrl): game data (/gamez/, /game/) read for the game itself —
 * 'demand' —, fetched ahead of it as its own read ('ahead': `a=1`, which carries the session `s=` too: the proxy's own
 * `kind` counts it as demand), announced by its engine as its next reads ('want': `w=1`, HttpBackend.wantList — the load's own
 * bytes, fetched in parallel) or in the background ('bg': `p=1`); anything else 'other'.
 */
export function urlKind(url) {
  if (!url.startsWith('/gamez/') && !url.startsWith('/game/')) return 'other';
  return /[?&]w=1/.test(url) ? 'want' : /[?&]p=1/.test(url) ? 'bg' : /[?&]a=1/.test(url) ? 'ahead' : 'demand';
}

/** A game data request's { manifest, path (decoded, without the light copies' folder), light, decoded (bytes, from `r=a-b`; null: the file) }, else null. */
export function dataRead(url) {
  const m = /^\/gamez?\/([^/?]+)\/([^?]*)(?:\?(.*))?$/.exec(url); if (!m) return null;
  let p; try { p = m[2].split('/').map(decodeURIComponent).join('/'); } catch { p = m[2]; }
  const light = p.startsWith('.light/'); if (light) p = p.slice(7);
  const r = /(?:^|&)r=(\d+)-(\d+)/.exec(m[3] ?? '');
  return { manifest: decodeURIComponent(m[1]), path: p, light, decoded: r ? Number(r[2]) - Number(r[1]) : null };
}

/** The file categories of loadWindow, the first that matches wins (`folders`: a path segment's name, any case). */
export const FILE_FOLDERS = ['Video', 'Splash', 'Music', 'Sound'];
/**
 * A game data read's category: 'upgrade' (the full file of a light copy read earlier: `lightSeen` has its path),
 * 'light', a folder of `folders`, then by format — 'texture' (dds, tga, bmp, ktx), 'mesh' (nif, kf, x), 'archive'
 * (bsa, ba2, pak, big, wad), 'content' (esm, esp, omwaddon, omwgame), '_engine' (the engine release's own data) —,
 * else 'other'.
 */
export function fileCategory(read, { lightSeen = null, folders = FILE_FOLDERS } = {}) {
  if (read.light) return 'light';
  if (lightSeen?.has(read.path)) return 'upgrade';
  if (read.path.startsWith('_engine/')) return '_engine';
  const segs = read.path.toLowerCase().split('/').slice(0, -1);
  for (const f of folders) if (segs.includes(f.toLowerCase())) return f;
  const ext = /\.([^./]+)$/.exec(read.path)?.[1]?.toLowerCase() ?? '';
  if (/^(dds|tga|bmp|ktx2?)$/.test(ext)) return 'texture';
  if (/^(nif|kf|x)$/.test(ext)) return 'mesh';
  if (/^(bsa|ba2|pak|big|wad)$/.test(ext)) return 'archive';
  if (/^(esm|esp|omwaddon|omwgame)$/.test(ext)) return 'content';
  return 'other';
}

const quant = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]); };
const q3 = (a) => ({ p10: quant(a, 0.1), p50: quant(a, 0.5), p90: quant(a, 0.9) });

/**
 * A stretch [from, to] of a proxy log (ms, its clock; `recs` the whole log, readLog): the game's own reads that started
 * in it — count, decoded and wire bytes (light copies apart), start-to-start spacing, time to the first byte, transfer
 * (after the first byte), idle (from a read's end to the next one's start), the time at least one was in flight
 * (waitMs) —, the announced ranges that started in it (want: count, decoded and wire bytes — the load's own, not
 * background) and the wire bytes every request carried during it (an answer spanning an edge counted for its share of
 * time inside) by kind (demand, ahead, want, bg, other) and, for game data other than the game's own reads and announced ones, by kind × file
 * category (fileCategory; 'upgrade': a light copy read earlier in the log, at any time before that request).
 */
export function loadWindow(recs, from, to, { folders = FILE_FOLDERS } = {}) {
  const lightSeen = new Set(), demand = [], wanted = [], byKind = {}, byCategory = {}, bgByCategory = {};
  let bgWire = 0;
  const MB = (n) => Math.round(n / 1e4) / 100;
  for (const r of recs) {
    if (r.mark || r.url === undefined) continue;
    const kind = urlKind(r.url), read = kind === 'other' ? null : dataRead(r.url);
    const end = r.t + (r.ms ?? 0), inside = Math.max(0, Math.min(to, end) - Math.max(from, r.t));
    const share = end > r.t ? inside / (end - r.t) : (r.t >= from && r.t <= to ? 1 : 0);
    if (share > 0) {
      const w = r.wire * share;
      byKind[kind] = (byKind[kind] ?? 0) + w;
      if (read && kind !== 'demand' && kind !== 'want') {
        const c = fileCategory(read, { lightSeen, folders });
        bgWire += w; byCategory[c] = (byCategory[c] ?? 0) + w;
        (bgByCategory[kind] ??= {})[c] = (bgByCategory[kind][c] ?? 0) + w;
      }
    }
    if (read && kind === 'want' && r.t >= from && r.t <= to) wanted.push({ wire: r.wire, decoded: read.decoded ?? 0 });
    if (read && kind === 'demand' && r.t >= from && r.t <= to) demand.push({ t: r.t, end, first: r.first, ms: r.ms, wire: r.wire, decoded: read.decoded ?? 0, light: read.light });
    if (read?.light) lightSeen.add(read.path);
  }
  const spacing = demand.slice(1).map((d, i) => d.t - demand[i].t);
  const idle = []; let lastEnd = -Infinity;
  for (const d of demand) { if (lastEnd > -Infinity) idle.push(Math.max(0, d.t - lastEnd)); lastEnd = Math.max(lastEnd, d.end); }
  let waitMs = 0, cur = null;
  for (const d of demand) { const b = Math.min(to, d.end); if (!cur || d.t > cur[1]) { if (cur) waitMs += cur[1] - cur[0]; cur = [d.t, b]; } else cur[1] = Math.max(cur[1], b); }
  if (cur) waitMs += cur[1] - cur[0];
  const sum = (a, k) => a.reduce((n, d) => n + d[k], 0), lights = demand.filter((d) => d.light);
  const mbOf = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, MB(v)]));
  return {
    ms: Math.round(to - from),
    demand: {
      count: demand.length, decodedMB: MB(sum(demand, 'decoded')), wireMB: MB(sum(demand, 'wire')),
      light: { count: lights.length, decodedMB: MB(sum(lights, 'decoded')), wireMB: MB(sum(lights, 'wire')) },
      spacing: q3(spacing), ttfb: q3(demand.filter((d) => d.first !== null && d.first !== undefined).map((d) => d.first)),
      transfer: q3(demand.filter((d) => d.first !== null && d.first !== undefined).map((d) => d.ms - d.first)), idle: q3(idle), waitMs: Math.round(waitMs),
    },
    want: { count: wanted.length, decodedMB: MB(sum(wanted, 'decoded')), wireMB: MB(sum(wanted, 'wire')) },
    wireMB: mbOf(byKind), backgroundMB: MB(bgWire), backgroundByCategory: mbOf(byCategory),
    backgroundByKind: Object.fromEntries(Object.entries(bgByCategory).map(([k, v]) => [k, mbOf(v)])),
  };
}

/**
 * The proxy log's summary up to `until` ms (its own clock): bytes and requests by kind, unit answers, demand-wait.
 * `recs`: the log's request lines.
 */
export function summarize(recs, until = Infinity) {
  const kinds = {}; let wire = 0, requests = 0, gz = 0, units = { hit: 0, raw: 0, miss: 0, none: 0 }, unitWire = { hit: 0, raw: 0, miss: 0, none: 0 };
  const demand = [];
  for (const r of recs) {
    if (r.mark || r.t > until) continue;
    // (the game's own reads: no `p=1`, `a=1` nor `w=1` — `&s=` when the backend has a session, nothing for a port's data
    // worker; `want`: the ranges an engine announced it reads next, fetched in parallel — HttpBackend.wantList)
    const k = r.url.startsWith('/gamez/') || r.url.startsWith('/game/') ? (/[?&]w=1/.test(r.url) ? 'want' : /[?&][pa]=1/.test(r.url) ? 'background' : 'demand') : r.url.startsWith('/src/') ? 'src' : r.url.startsWith('/engines/') ? 'engine' : r.url.startsWith('/api/') ? 'api' : 'page';
    const s = (kinds[k] ??= { requests: 0, wire: 0 }); s.requests++; s.wire += r.wire; wire += r.wire; requests++;
    if (k === 'demand' || k === 'background' || k === 'want') { gz++; const u = r.unit ?? 'none'; units[u] = (units[u] ?? 0) + 1; unitWire[u] = (unitWire[u] ?? 0) + r.wire; }
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const upstream = opt('upstream'), listen = opt('listen', '18443');
  const rate = parseRate(opt('rate', '7m')), rtt = Number(opt('rtt', '75'));
  if (!upstream || !(rate > 0)) { console.error('usage: node tools/net-proxy.mjs --upstream http://127.0.0.1:<port> [--listen 18443] [--rate 7m] [--rtt 75] [--log file] [--certs dir] [--http1]'); process.exit(2); }
  await startProxy({ upstream, listen, rate, rtt, log: opt('log'), certs: opt('certs'), http1: args.includes('--http1') });
  console.log(`[proxy] ${args.includes('--http1') ? 'http' : 'https'}://127.0.0.1:${listen}/ -> ${upstream}, ${(rate / 1e6).toFixed(2)} MB/s, ${rtt} ms round trip`);
}
