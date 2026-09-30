// Development/serving host: static files (the page, the ES modules of the emulator), manifests,
// and the game folder served read-only with HTTP range requests + a JSON directory listing.
// Sends the COOP/COEP headers required for SharedArrayBuffer and Atomics.wait in the page.
// Usage: node src/host/server.js [--port 8080] [--manifests manifests/] [--default <manifest>] [--telemetry <dir>] [--learn <dir>]
//   --default: the page starts that game directly (the picker stays reachable with ?menu)
//   --telemetry: the page's per-second measurements (frame rate, frame times, emulated CPU) are appended to
//                <dir>/telemetry-<date>.jsonl, one line per batch, to study the slowdowns seen by a player
//   --learn: the order in which sessions read the game's file blocks is kept there (the prefetch list of later sessions),
//            the GL programs they built and the code regions they translated (both prepared ahead by later sessions)
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { BLOCK as LEARN_BLOCK, CHUNK as LEARN_CHUNK } from '../vfs/http-backend.js';
import { createAccountApi } from './accounts.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDefaults } from './manifest.js';
import { listGameTree, resolveGameFile } from './game-files.js';
import { attachLan } from './lan.js';
import { SimLink } from './sim-link.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.ico': 'image/x-icon' };

export const listTree = (dir) => listGameTree({ folder: dir });

export function loadManifests(dir, extra = null) {
  const out = new Map();
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      m.folder = path.resolve(dir, m.folder ?? '.');
      if (m.baseFolder) m.baseFolder = path.resolve(dir, m.baseFolder);
      out.set(f.slice(0, -5), withDefaults(m));
    }
  }
  for (const [name, m] of extra ?? []) out.set(name, m); // (manifests given by the caller: `orthros run <folder>`)
  return out;
}

export function createServer(opts = {}) {
  const manifestDir = path.resolve(opts.manifests ?? path.join(ROOT, 'manifests'));
  let manifests = loadManifests(manifestDir, opts.extra);
  const trees = new Map(), treeObjs = new Map();
  const coverFile = (man) => man.cover && resolveGameFile(man, man.cover);
  const headers = (extra = {}) => ({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-cache',
    ...extra,
  });
  // testing: a slower network (opts.net = { delayMs, bytesPerSec }): each range answered after a round trip, its bytes
  // crossing one link shared by the answers in flight (see SimLink)
  const link = opts.net ? new SimLink(opts.net) : null;
  const viaLink = (res, bytes, go) => { const cancel = link.send(bytes, go); res.on('close', cancel); };
  const send = (res, code, body, extra) => { res.writeHead(code, headers({ 'Content-Type': 'text/plain; charset=utf-8', ...extra })); res.end(body); };
  const sendFile = (req, res, file, mime) => {
    let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
    if (!st.isFile()) return send(res, 404, 'not found');
    const range = req.headers.range;
    const h = headers({ 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString() });
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) return send(res, 416, 'bad range', { 'Content-Range': `bytes */${st.size}` });
      let start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
      let end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
      if (start > end || start >= st.size) return send(res, 416, 'bad range', { 'Content-Range': `bytes */${st.size}` });
      res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      if (link) { viaLink(res, end - start + 1, () => fs.createReadStream(file, { start, end }).pipe(res)); return; }
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...h, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  };

  /**
   * Learned prefetch order, per manifest: the 1 MiB blocks the game read synchronously in earlier sessions, with the
   * earliest time since its session's first read it was needed ('s' parameter of /gamez requests; prefetch requests,
   * 'p=1', are not counted). /api/prefetch/<manifest> lists them in that order: a new session downloads them in the
   * background (network otherwise idle while the game computes) before the game asks for them. Kept in
   * opts.learnDir/prefetch-<manifest>.json when set. Each block also carries the mask of the 64 KiB pieces sessions
   * read in it (bit i: piece i; absent for blocks learned before masks): a session fetches those pieces ahead of the
   * game — a few pieces of each block is what a run of small random reads needs, not whole blocks.
   */
  const learned = new Map(); // manifest -> Map("path#block" -> { t, n, mask })
  /** mask of the 64 KiB pieces of a block covered by [a, b) (offsets within the block) */
  const pieceBits = (a, b) => { let m = 0; for (let c = Math.floor(a / LEARN_CHUNK); c * LEARN_CHUNK < b; c++) m |= 1 << c; return m >>> 0; };
  const sessions = new Map(); // session id -> { start, seen: Set }
  const learnFile = (name) => opts.learnDir && path.join(opts.learnDir, `prefetch-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const learnedOf = (name) => {
    let m = learned.get(name);
    if (!m) {
      m = new Map(); learned.set(name, m);
      const f = learnFile(name);
      if (f) try { for (const [k, t, n, mask] of JSON.parse(fs.readFileSync(f, 'utf8'))) m.set(k, { t, n, mask: mask ?? undefined }); } catch { /* none yet */ }
    }
    return m;
  };
  let learnDirty = new Set(), learnTimer = null;
  const learnRead = (name, rel, start, end, sid) => {
    if (!sid || sid.length > 40) return;
    const now = Date.now();
    let ss = sessions.get(sid);
    if (!ss) {
      if (sessions.size > 1000) for (const [k, v] of sessions) if (now - v.start > 6 * 3600e3) sessions.delete(k);
      sessions.set(sid, ss = { start: now, seen: new Set() });
    }
    const m = learnedOf(name), t = now - ss.start;
    for (let b = Math.floor(start / LEARN_BLOCK); b * LEARN_BLOCK < end; b++) {
      const k = `${rel}#${b}`;
      const bits = pieceBits(Math.max(start, b * LEARN_BLOCK) - b * LEARN_BLOCK, Math.min(end, (b + 1) * LEARN_BLOCK) - b * LEARN_BLOCK);
      let e = m.get(k);
      if (!e) m.set(k, e = { t, n: 0, mask: 0 });
      e.mask = (e.mask ?? 0) | bits; // (every session's pieces, first read of the block or not)
      if (ss.seen.has(k)) continue;
      ss.seen.add(k);
      e.t = Math.min(e.t, t); e.n++;
    }
    if (learnFile(name)) {
      learnDirty.add(name);
      learnTimer ??= setTimeout(() => {
        learnTimer = null;
        for (const n of learnDirty) { const f = learnFile(n); try { fs.writeFileSync(f + '.tmp', JSON.stringify([...learnedOf(n)].map(([k, v]) => (v.mask === undefined ? [k, v.t, v.n] : [k, v.t, v.n, v.mask])))); fs.renameSync(f + '.tmp', f); } catch { /* next time */ } }
        learnDirty = new Set();
      }, 20000);
      learnTimer.unref?.(); // (does not keep a finished process alive)
    }
  };
  const prefetchList = (name) => [...learnedOf(name)].sort((a, b) => a[1].t - b[1].t).slice(0, 8192).map(([k, v]) => { const i = k.lastIndexOf('#'), e = [k.slice(0, i), Number(k.slice(i + 1))]; if (v.mask) e.push(v.mask); return e; });

  /**
   * Learned GL programs, per manifest: the programs sessions had to build at a draw (key, GLSL sources, attribute
   * names, earliest time since the page started), posted by the worker. /api/programs/<manifest> lists them in that
   * order: a new session compiles them in the background before the game draws with them (no build hitch in a match).
   * The sources are Orthros' own translations; a key posted again with other sources (translators changed) replaces
   * them. Kept in opts.learnDir/programs-<manifest>.json when set.
   */
  const programsLearned = new Map(); // manifest -> Map(key -> { vs, fs, attrs, t, n })
  const programsFile = (name) => opts.learnDir && path.join(opts.learnDir, `programs-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const programsOf = (name) => {
    let m = programsLearned.get(name);
    if (!m) {
      m = new Map(); programsLearned.set(name, m);
      const f = programsFile(name);
      if (f) try { for (const [k, vs, fs2, attrs, t, n] of JSON.parse(fs.readFileSync(f, 'utf8'))) m.set(k, { vs, fs: fs2, attrs, t, n }); } catch { /* none yet */ }
    }
    return m;
  };
  let programsDirty = new Set(), programsTimer = null;
  const PROGRAMS_MAX = 4096, PROGRAM_SRC_MAX = 64 * 1024;
  const learnPrograms = (name, list) => {
    const m = programsOf(name);
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || typeof e.key !== 'string' || typeof e.vs !== 'string' || typeof e.fs !== 'string' || !Array.isArray(e.attrs) || !e.attrs.every((a) => typeof a === 'string')) continue;
      if (e.key.length > 4096 || e.vs.length > PROGRAM_SRC_MAX || e.fs.length > PROGRAM_SRC_MAX || e.attrs.length > 32) continue;
      const t = Number.isFinite(e.t) ? Math.max(0, e.t) : 1e9, old = m.get(e.key);
      if (!old && m.size >= PROGRAMS_MAX) continue;
      if (old && old.vs === e.vs && old.fs === e.fs) { old.t = Math.min(old.t, t); old.n++; }
      else m.set(e.key, { vs: e.vs, fs: e.fs, attrs: e.attrs, t: old ? Math.min(old.t, t) : t, n: (old?.n ?? 0) + 1 });
    }
    if (programsFile(name)) {
      programsDirty.add(name);
      programsTimer ??= setTimeout(() => {
        programsTimer = null;
        for (const n of programsDirty) { const f = programsFile(n); try { fs.writeFileSync(f + '.tmp', JSON.stringify([...programsOf(n)].map(([k, v]) => [k, v.vs, v.fs, v.attrs, v.t, v.n]))); fs.renameSync(f + '.tmp', f); } catch { /* next time */ } }
        programsDirty = new Set();
      }, 20000);
      programsTimer.unref?.();
    }
  };
  const programsList = (name) => [...programsOf(name)].sort((a, b) => a[1].t - b[1].t).map(([key, v]) => ({ key, vs: v.vs, fs: v.fs, attrs: v.attrs }));

  /**
   * Learned code regions, per manifest: the entries of the regions the JIT translated at a miss (module, offset in it,
   * x87 mode), with the earliest time since the page started, posted by the worker. /api/regions/<manifest> lists them
   * in that order: a new session translates them while the game is idle (menus) instead of in the middle of a match.
   * Kept in opts.learnDir/regions-<manifest>.json when set.
   */
  const regionsLearned = new Map(); // manifest -> Map("module:rva:fpc" -> { t, n })
  const regionsFile = (name) => opts.learnDir && path.join(opts.learnDir, `regions-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const regionsOf = (name) => {
    let m = regionsLearned.get(name);
    if (!m) {
      m = new Map(); regionsLearned.set(name, m);
      const f = regionsFile(name);
      if (f) try { for (const [k, t, n] of JSON.parse(fs.readFileSync(f, 'utf8'))) m.set(k, { t, n }); } catch { /* none yet */ }
    }
    return m;
  };
  let regionsDirty = new Set(), regionsTimer = null;
  const REGIONS_MAX = 100000;
  const learnRegions = (name, list) => {
    const m = regionsOf(name);
    for (const e of Array.isArray(list) ? list : []) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || e[0].length > 64 || !Number.isInteger(e[1]) || e[1] < 0 || !(e[2] === null || Number.isInteger(e[2]))) continue;
      const k = `${e[0].toLowerCase()}:${e[1]}:${e[2] ?? ''}`, t = Number.isFinite(e[3]) ? Math.max(0, e[3]) : 1e9, old = m.get(k);
      if (old) { old.t = Math.min(old.t, t); old.n++; } else if (m.size < REGIONS_MAX) m.set(k, { t, n: 1 });
    }
    if (regionsFile(name)) {
      regionsDirty.add(name);
      regionsTimer ??= setTimeout(() => {
        regionsTimer = null;
        for (const n of regionsDirty) { const f = regionsFile(n); try { fs.writeFileSync(f + '.tmp', JSON.stringify([...regionsOf(n)].map(([k, v]) => [k, v.t, v.n]))); fs.renameSync(f + '.tmp', f); } catch { /* next time */ } }
        regionsDirty = new Set();
      }, 20000);
      regionsTimer.unref?.();
    }
  };
  /** [module, rva, fpc] by earliest use */
  const regionsList = (name) => [...regionsOf(name)].sort((a, b) => a[1].t - b[1].t).slice(0, 40000).map(([k]) => { const [mod, rva, fpc] = k.split(':'); return [mod, Number(rva), fpc === '' ? null : Number(fpc)]; });

  /** compressed range transport totals (requests, bytes read, bytes sent, encoding time) */
  const netStats = { requests: 0, raw: 0, sent: 0, encodeMs: 0, cacheHits: 0 };
  /** encoded ranges kept for the next players (key: file, mtime, range, encoding), least recently used first out */
  const encodedCache = new Map(); let encodedBytes = 0;
  const ENCODED_CACHE_MAX = opts.encodedCacheBytes ?? 256 * 1024 * 1024;
  const sendRangeEncoded = (req, res, file, r) => {
    let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
    const rm = /^(\d+)-(\d+)$/.exec(r);
    if (!rm) return send(res, 400, 'bad range');
    const start = Number(rm[1]), end = Math.min(Number(rm[2]), st.size);
    if (!(start < end) || end - start > 64 * 1024 * 1024) return send(res, 416, 'bad range');
    const accept = String(req.headers['accept-encoding'] ?? '');
    const enc = zlib.zstdCompress && /\bzstd\b/.test(accept) ? 'zstd' : /\bgzip\b/.test(accept) ? 'gzip' : null;
    const key = `${file}|${st.mtimeMs}|${start}-${end}|${enc}`;
    const reply = (body, encoding) => {
      netStats.requests++; netStats.raw += end - start; netStats.sent += body.length;
      const h = headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'X-Orthros-Raw': end - start });
      if (encoding) h['Content-Encoding'] = encoding;
      const go = () => { res.writeHead(200, h); res.end(body); };
      if (link) viaLink(res, body.length, go); else go();
    };
    const hit = encodedCache.get(key);
    if (hit) { encodedCache.delete(key); encodedCache.set(key, hit); netStats.cacheHits++; return reply(hit.body, hit.encoding); }
    const buf = Buffer.alloc(end - start);
    fs.open(file, 'r', (err, fd) => {
      if (err) return send(res, 500, String(err));
      fs.read(fd, buf, 0, buf.length, start, (err2, n) => {
        fs.close(fd, () => {});
        if (err2 || n !== buf.length) return send(res, 500, String(err2 ?? 'short read'));
        if (!enc) return reply(buf, null);
        const t0 = performance.now();
        const done = (err3, out) => {
          netStats.encodeMs += performance.now() - t0;
          // (not worth it: sent as is — the encoded form is still cached, as the raw bytes)
          const entry = !err3 && out.length < buf.length * 0.92 ? { body: out, encoding: enc } : { body: buf, encoding: null };
          encodedCache.set(key, entry); encodedBytes += entry.body.length;
          for (const [k, v] of encodedCache) { if (encodedBytes <= ENCODED_CACHE_MAX) break; encodedCache.delete(k); encodedBytes -= v.body.length; }
          reply(entry.body, entry.encoding);
        };
        if (enc === 'zstd') zlib.zstdCompress(buf, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }, done);
        else zlib.gzip(buf, { level: 4 }, done);
      });
    });
  };

  const accountApi = opts.accountsDir ? createAccountApi(opts.accountsDir, { publicOrigin: opts.accountOrigin, allowedGame: (game) => manifests.has(game) }) : null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    try {
      if (p === '/api/account' || p.startsWith('/api/account/') || p === '/api/cloud' || p.startsWith('/api/cloud/')) {
        if (!accountApi) return send(res, 503, 'accounts unavailable');
        accountApi(req, res).catch((e) => { console.error('account API:', e); if (!res.headersSent) send(res, e.status ?? 500, 'account API error'); else res.destroy(); });
        return;
      }
      if (p === '/api/config') return send(res, 200, JSON.stringify({ defaultManifest: opts.defaultManifest ?? null, telemetry: !!opts.telemetryDir, accounts: !!accountApi, encodedRanges: true, prefetch: true, programCache: true, regionCache: true }), { 'Content-Type': 'application/json' });
      if (p === '/api/telemetry' && req.method === 'POST') {
        if (!opts.telemetryDir) return send(res, 404, 'telemetry off');
        let body = '', size = 0;
        req.on('data', (d) => { size += d.length; if (size <= 256 * 1024) body += d; });
        req.on('end', () => {
          let rec; try { rec = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
          if (size > 256 * 1024) return send(res, 413, 'too large');
          const day = new Date().toISOString().slice(0, 10);
          fs.appendFile(path.join(opts.telemetryDir, `telemetry-${day}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n', () => {});
          send(res, 204, '');
        });
        return;
      }
      if (p === '/' || p === '/index.html') return sendFile(req, res, path.join(ROOT, 'src/host/web/index.html'), MIME['.html']);
      if (p === '/api/manifests') {
        manifests = loadManifests(manifestDir, opts.extra);
        const sizeOf = (t) => Object.values(t.files).reduce((a, f) => a + f.size, 0) + Object.values(t.dirs).reduce((a, d) => a + sizeOf(d), 0);
        const out = [...manifests].map(([name, m]) => {
          let bytes = null;
          try { if (fs.existsSync(m.folder) && (!m.baseFolder || fs.existsSync(m.baseFolder))) { if (!treeObjs.has(name)) treeObjs.set(name, listGameTree(m)); bytes = sizeOf(treeObjs.get(name)); } } catch { /* folder missing */ }
          return { name, title: m.name ?? name, gameId: m.gameId ?? name, version: m.version ?? null,
            versionOrder: m.versionOrder ?? 0, languages: m.languages ?? [], exe: m.exe,
            description: m.description ?? null, descriptionFr: m.descriptionFr ?? null,
            hidden: !!m.hidden, cover: !!coverFile(m), bytes, available: bytes !== null };
        });
        return send(res, 200, JSON.stringify(out), { 'Content-Type': 'application/json' });
      }
      let m = /^\/api\/manifest\/([^/]+)$/.exec(p);
      if (m) { const man = manifests.get(m[1]); if (!man) return send(res, 404, 'no such manifest'); return send(res, 200, JSON.stringify({ ...man, folder: undefined, baseFolder: undefined }), { 'Content-Type': 'application/json' }); }
      m = /^\/api\/cover\/([^/]+)$/.exec(p);
      if (m) { // the game's own image named by its manifest (a splash screen), found whatever the case of its path
        const man = manifests.get(m[1]), f = man && coverFile(man);
        if (!f) return send(res, 404, 'no cover');
        const ext = path.extname(f).toLowerCase();
        res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Cross-Origin-Resource-Policy': 'same-origin' });
        fs.createReadStream(f).pipe(res);
        return;
      }
      m = /^\/api\/tree\/([^/]+)$/.exec(p);
      if (m) { const man = manifests.get(m[1]); if (!man) return send(res, 404, 'no such manifest'); if (!trees.has(m[1])) { if (!treeObjs.has(m[1])) treeObjs.set(m[1], listGameTree(man)); trees.set(m[1], JSON.stringify(treeObjs.get(m[1]))); } return send(res, 200, trees.get(m[1]), { 'Content-Type': 'application/json' }); }
      // compressed ranges: /gamez/<manifest>/<path>?r=<start>-<end> (end exclusive), the bytes encoded with zstd or gzip
      // when that saves enough (Content-Encoding: the browser decodes before the page sees them), else sent as they are
      m = /^\/gamez\/([^/]+)\/(.*)$/.exec(p);
      if (m) {
        const man = manifests.get(m[1]); if (!man) return send(res, 404, 'no such manifest');
        const file = resolveGameFile(man, m[2]); if (!file) return send(res, 404, 'not found');
        const r = url.searchParams.get('r') ?? '', rm = /^(\d+)-(\d+)$/.exec(r);
        if (rm && !url.searchParams.get('p')) learnRead(m[1], m[2], Number(rm[1]), Number(rm[2]), url.searchParams.get('s'));
        return sendRangeEncoded(req, res, file, r);
      }
      m = /^\/api\/regions\/([^/]+)$/.exec(p);
      if (m) {
        if (!manifests.get(m[1])) return send(res, 404, 'no such manifest');
        if (req.method === 'POST') {
          let body = '', size = 0;
          req.on('data', (d) => { size += d.length; if (size <= 8 * 1024 * 1024) body += d; });
          req.on('end', () => {
            if (size > 8 * 1024 * 1024) return send(res, 413, 'too large');
            let rec; try { rec = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
            learnRegions(m[1], rec?.regions);
            send(res, 204, '');
          });
          return;
        }
        return send(res, 200, JSON.stringify(regionsList(m[1])), { 'Content-Type': 'application/json' });
      }
      m = /^\/api\/programs\/([^/]+)$/.exec(p);
      if (m) {
        if (!manifests.get(m[1])) return send(res, 404, 'no such manifest');
        if (req.method === 'POST') {
          let body = '', size = 0;
          req.on('data', (d) => { size += d.length; if (size <= 8 * 1024 * 1024) body += d; });
          req.on('end', () => {
            if (size > 8 * 1024 * 1024) return send(res, 413, 'too large');
            let rec; try { rec = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
            learnPrograms(m[1], rec?.programs);
            send(res, 204, '');
          });
          return;
        }
        return send(res, 200, JSON.stringify(programsList(m[1])), { 'Content-Type': 'application/json' });
      }
      m = /^\/api\/prefetch\/([^/]+)$/.exec(p);
      if (m) { if (!manifests.get(m[1])) return send(res, 404, 'no such manifest'); return send(res, 200, JSON.stringify(prefetchList(m[1])), { 'Content-Type': 'application/json' }); }
      if (p === '/api/netstats') return send(res, 200, JSON.stringify(netStats), { 'Content-Type': 'application/json' });
      m = /^\/game\/([^/]+)\/(.*)$/.exec(p);
      if (m) { const man = manifests.get(m[1]); if (!man) return send(res, 404, 'no such manifest'); const file = resolveGameFile(man, m[2]); if (!file) return send(res, 404, 'not found'); return sendFile(req, res, file, 'application/octet-stream'); }
      if (p.startsWith('/src/') || p.startsWith('/tools/') || p.startsWith('/tests/')) {
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
        return sendFile(req, res, file, MIME[path.extname(file)] ?? 'application/octet-stream');
      }
      return send(res, 404, 'not found');
    } catch (e) {
      return send(res, 500, String(e.stack || e));
    }
  });
  attachLan(server, opts.lanLog ?? ((m) => console.log(m))); // (the virtual LAN of the games: WebSocket /api/lan)
  return server;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1] || 8080) || 8080;
  const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const telemetryDir = arg('--telemetry'), learnDir = arg('--learn'), accountsDir = arg('--accounts');
  for (const d of [telemetryDir, learnDir, accountsDir]) if (d) fs.mkdirSync(d, { recursive: true });
  const server = createServer({ manifests: arg('--manifests'), defaultManifest: arg('--default'), telemetryDir, learnDir, accountsDir });
  server.listen(port, '127.0.0.1', () => console.log(`orthros: http://127.0.0.1:${port}/`));
}
