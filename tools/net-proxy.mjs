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
// tools/data-matrix.mjs and tools/prepare-bench.mjs use startProxy.
import http from 'node:http';
import http2 from 'node:http2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const upstream = opt('upstream'), listen = opt('listen', '18443');
  const rate = parseRate(opt('rate', '7m')), rtt = Number(opt('rtt', '75'));
  if (!upstream || !(rate > 0)) { console.error('usage: node tools/net-proxy.mjs --upstream http://127.0.0.1:<port> [--listen 18443] [--rate 7m] [--rtt 75] [--log file] [--certs dir] [--http1]'); process.exit(2); }
  await startProxy({ upstream, listen, rate, rtt, log: opt('log'), certs: opt('certs'), http1: args.includes('--http1') });
  console.log(`[proxy] ${args.includes('--http1') ? 'http' : 'https'}://127.0.0.1:${listen}/ -> ${upstream}, ${(rate / 1e6).toFixed(2)} MB/s, ${rtt} ms round trip`);
}
