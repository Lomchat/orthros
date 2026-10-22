// Throttling proxy for data-system measurements (docs/slow-network.md "Measuring"): a player's whole connection in
// front of an Orthros server — every request (the page, its /src modules, the engines, /gamez, the APIs) waits a round
// trip, then its answer crosses ONE link of the given rate shared by the answers in flight (src/host/sim-link.js), as a
// home link does. As Cloudflare in front of the live server: HTTP/2 to the browser (TLS, a self-signed certificate made
// once: the browser runs with --ignore-certificate-errors), `Accept-Encoding: gzip, br` to the origin. Every answer is
// logged (JSON lines: t ms from the proxy's start, method, url, status, wire bytes, unit header, first byte / end ms),
// and the data reports that carry a mark (`/api/prefetch/<manifest>` POSTs with `mark`: a page's or worker's
// "playable") as { mark }.
//
//   node tools/throttle-proxy.mjs --upstream 127.0.0.1:<port> --port <p> --rate 85000 --rtt 150 [--log file] [--http1]
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { SimLink } from '../src/host/sim-link.js';

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'http2-settings', 'te']);

/** A self-signed certificate for 127.0.0.1 / localhost, made once in `dir`: { key, cert }. */
export function selfSigned(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

/**
 * The proxy: { server, port, close(), stats(), marks } — opts: { upstream: 'host:port', port (0: any), rate (bytes/s,
 * 0: no limit), rtt (ms), log (file or null), http1 (plain HTTP/1.1 instead of HTTP/2 over TLS), certDir }.
 */
export function startProxy(opts) {
  const [uhost, uport] = opts.upstream.split(':');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  const link = opts.rate > 0 ? new SimLink({ delayMs: opts.rtt ?? 0, bytesPerSec: opts.rate }) : null;
  const t0 = performance.now();
  const log = opts.log ? fs.createWriteStream(opts.log) : null;
  const stats = { requests: 0, wire: 0, byKind: {} };
  const marks = [];
  const note = (rec) => {
    stats.requests++; stats.wire += rec.wire;
    const k = rec.url.startsWith('/gamez/') ? (/[?&]s=/.test(rec.url) ? 'demand' : 'background') : rec.url.startsWith('/src/') ? 'src' : rec.url.startsWith('/engines/') ? 'engine' : rec.url.startsWith('/api/') ? 'api' : 'other';
    const s = (stats.byKind[k] ??= { requests: 0, wire: 0 }); s.requests++; s.wire += rec.wire;
    log?.write(JSON.stringify(rec) + '\n');
  };

  const handler = (req, res) => {
    const start = performance.now() - t0, url = req.url;
    // (the runner's view of the marks seen: not forwarded, not throttled)
    if (url === '/__proxy/marks') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(marks)); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && url.startsWith('/api/prefetch/') && body.length) {
        try { const j = JSON.parse(body.toString('utf8')); if (j?.mark) { const m = { t: Math.round(start), mark: j.mark, url }; marks.push(m); log?.write(JSON.stringify(m) + '\n'); } } catch { /* not JSON */ }
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith(':') && !HOP.has(k.toLowerCase())) headers[k] = v;
      // (as Cloudflare: the origin sees gzip and br only)
      if (headers['accept-encoding'] !== undefined) headers['accept-encoding'] = 'gzip, br';
      headers.host = opts.upstream;
      if (body.length) headers['content-length'] = String(body.length);
      const up = http.request({ host: uhost, port: Number(uport), method: req.method, path: url, headers, agent }, (ur) => {
        const parts = [];
        ur.on('data', (c) => parts.push(c));
        ur.on('end', () => {
          let data = Buffer.concat(parts);
          const out = {};
          for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
          // (as Cloudflare: a text answer the origin sent as it is goes gzip-compressed on the fly — measured on the live
          // site: /api/regions/<manifest> 1065 KB → 136 KB gzip, `cf-cache-status: DYNAMIC`)
          if (!opts.noEdgeGzip && !ur.headers['content-encoding'] && data.length >= 1024 && /gzip/.test(String(req.headers['accept-encoding'] ?? ''))
            && /^(text\/|application\/(json|javascript|xml|wasm)|image\/svg)/.test(String(ur.headers['content-type'] ?? '')) && ur.statusCode === 200) {
            data = zlib.gzipSync(data, { level: 6 }); out['content-encoding'] = 'gzip'; delete out['content-length']; out['content-length'] = String(data.length);
          }
          let firstByte = null;
          const head = () => { firstByte = performance.now() - t0; try { res.writeHead(ur.statusCode, out); } catch { /* gone */ } };
          const done = () => {
            try { res.end(data); } catch { /* gone */ }
            note({ t: Math.round(start), method: req.method, url, status: ur.statusCode, wire: data.length + 200, enc: ur.headers['content-encoding'] ?? null, unit: ur.headers['x-orthros-unit'] ?? null, first: firstByte === null ? null : Math.round(firstByte - start), ms: Math.round(performance.now() - t0 - start) });
          };
          if (!link) { head(); done(); return; }
          // (~200 bytes of headers per answer on the wire, as HTTP/2 through a CDN)
          const cancel = link.send(data.length + 200, done, head);
          res.on('close', () => { if (!res.writableEnded) cancel(); });
        });
        ur.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* gone */ } });
      });
      up.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* gone */ } });
      up.end(body.length ? body : undefined);
    });
  };
  const server = opts.http1 ? http.createServer(handler) : http2.createSecureServer({ ...selfSigned(opts.certDir ?? path.join(path.dirname(opts.log ?? '/tmp/orthros-scratch/proxy/x'), 'cert')), allowHTTP1: true }, handler);
  return new Promise((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve({
    server, port: server.address().port, marks, stats: () => stats, t0,
    close: () => new Promise((r) => { log?.end(); server.close(() => r()); setTimeout(r, 2000).unref?.(); }),
  })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  const p = await startProxy({ upstream: opt('upstream', '127.0.0.1:8080'), port: Number(opt('port', 0)), rate: Number(opt('rate', 0)), rtt: Number(opt('rtt', 0)), log: opt('log', null), http1: args.includes('--http1') });
  console.log(`throttle-proxy: ${args.includes('--http1') ? 'http' : 'https'}://127.0.0.1:${p.port}/ -> ${opt('upstream', '127.0.0.1:8080')}`);
}
