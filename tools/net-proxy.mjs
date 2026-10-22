// A player's connection in front of an Orthros server (measurement tool, docs/slow-network.md "Measuring"): an HTTP/2
// TLS proxy, as the production front (Cloudflare) speaks to Chrome — every request of the page on ONE connection, no
// six-connections-per-host queue as a local HTTP/1.1 server has (a synchronous game read queued behind six background
// downloads is a local artifact, not a player's) —, with a round trip and one downstream link whose rate the answers in
// transfer share equally (HTTP/2 interleaves its streams' frames), and the origin asked with `Accept-Encoding: gzip, br`
// (Cloudflare's: no zstd).
//
//   node tools/net-proxy.mjs --upstream http://127.0.0.1:18431 --listen 18443 --rate 7m --rtt 75 [--log <file>] [--certs <dir>]
//
// The page is then https://127.0.0.1:18443/ (Chrome with --ignore-certificate-errors: a self-signed certificate made
// with openssl in --certs, default a new temporary directory). --log: one line per request — start s, time to the
// first byte ms, total ms, kind (demand: the game's own read `&s=`, bg: `&p=1`, ahead: `&a=1`, other), status, body
// bytes sent, the URL; `reset` when the browser cancelled it.
import http from 'node:http';
import http2 from 'node:http2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

export function startProxy({ upstream, listen, rate, rtt, log = null, certs }) {
  const up = new URL(upstream);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  const shaper = new Shaper(rate);
  const t0 = performance.now();
  const logLine = log ? (l) => { try { fs.appendFileSync(log, l + '\n'); } catch { /* no log */ } } : null;
  const half = rtt / 2;
  const server = http2.createSecureServer({ ...makeCert(certs), allowHTTP1: true, settings: { initialWindowSize: 16 << 20 } }, (req, res) => {
    const start = performance.now(), url = req.url;
    const kind = /[?&]s=/.test(url) ? 'demand' : /[?&]a=1/.test(url) ? 'ahead' : /[?&]p=1/.test(url) ? 'bg' : 'other';
    let sent = 0, ttfb = -1, reset = false, ended = false;
    const s = { write: (b) => { sent += b.length; try { res.write(b); } catch { /* gone */ } }, onEnd: () => { if (ended) return; ended = true; try { res.end(); } catch { /* gone */ } } };
    const done = () => logLine?.(`${((start - t0) / 1000).toFixed(3)} ${ttfb.toFixed(0)} ${(performance.now() - start).toFixed(0)} ${kind} ${res.statusCode} ${sent}${reset ? ' reset' : ''} ${url}`);
    res.on('close', () => { if (!ended) { reset = true; shaper.drop(s); } done(); });
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith(':') && !HOP.has(k)) headers[k] = v;
    headers.host = up.host;
    headers['accept-encoding'] = 'gzip, br'; // (Cloudflare's to the origin)
    // (the request crosses half the round trip before the origin sees it)
    setTimeout(() => {
      if (reset) return;
      const ureq = http.request({ host: up.hostname, port: up.port, method: req.method, path: url, headers, agent }, (ures) => {
        // (its headers cross the other half)
        const h = {};
        for (const [k, v] of Object.entries(ures.headers)) if (!HOP.has(k)) h[k] = v;
        const body = [];
        let upEnded = false, headSent = false;
        setTimeout(() => {
          if (reset) { ures.destroy(); return; }
          try { res.writeHead(ures.statusCode, h); } catch { ures.destroy(); return; }
          headSent = true; ttfb = performance.now() - start;
          for (const b of body.splice(0)) shaper.push(s, b);
          if (upEnded) shaper.finish(s);
        }, half);
        ures.on('data', (b) => { if (reset) return; if (headSent) shaper.push(s, b); else body.push(b); });
        ures.on('end', () => { upEnded = true; if (headSent && !reset) shaper.finish(s); });
        ures.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
      });
      ureq.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* gone */ } });
      res.on('close', () => { if (reset) ureq.destroy(); });
      req.pipe(ureq);
    }, half);
  });
  server.listen(Number(listen), '127.0.0.1');
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const upstream = opt('upstream'), listen = opt('listen', '18443');
  const rate = parseRate(opt('rate', '7m')), rtt = Number(opt('rtt', '75'));
  if (!upstream || !(rate > 0)) { console.error('usage: node tools/net-proxy.mjs --upstream http://127.0.0.1:<port> [--listen 18443] [--rate 7m] [--rtt 75] [--log file] [--certs dir]'); process.exit(2); }
  const certs = opt('certs') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-proxy-'));
  startProxy({ upstream, listen, rate, rtt, log: opt('log'), certs });
  console.log(`[proxy] https://127.0.0.1:${listen}/ -> ${upstream}, ${(rate / 1e6).toFixed(2)} MB/s, ${rtt} ms round trip`);
}
