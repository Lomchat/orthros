// OpenMW browser ports. Third-party code stays in data_engines; HTTP and WebSocket traffic
// stays on the Orthros origin, beneath the selected installation's URL.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { engineFile, clientAddress } from './goldsrc.js';
import { resolveGameFile } from './game-files.js';

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const MOD_ID = /^[a-z0-9][a-z0-9-]{0,54}$/;
const safePath = (s) => typeof s === 'string' && s.length > 0 && !s.includes('\\') && s.split('/').every((p) => p && p !== '.' && p !== '..');
export function openmwProblem(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || !ID.test(o.engine ?? '')) return 'openmw.engine doit nommer une release';
  if (o.example !== undefined && typeof o.example !== 'boolean') return 'openmw.example doit être un booléen';
  if (o.startCell !== undefined && (typeof o.startCell !== 'string' || !o.startCell.length || o.startCell.length > 128 || /[\r\n\0]/.test(o.startCell))) return 'openmw.startCell invalide';
  if (!Array.isArray(o.files) || !o.files.every(safePath) || (!o.example && !o.files.length)) return 'openmw.files doit lister les fichiers nécessaires';
  if (o.example && (o.files.length || o.multiplayer)) return 'openmw.example est le monde de démonstration solo du moteur';
  if (o.mods !== undefined && (!Array.isArray(o.mods) || !o.mods.every((m) => m && MOD_ID.test(m.id ?? '') && typeof m.name === 'string' && typeof m.installed === 'boolean') || new Set(o.mods.map((m) => m.id)).size !== o.mods.length)) return 'openmw.mods doit lister les mods et leur état, avec des ids distincts';
  if ((o.mods ?? []).some((m) => m.parts !== undefined && (!Array.isArray(m.parts) || !m.parts.every((p, i) => p && p.dir === `mods/${m.id}-${i}` && safePath(p.sentinel) && Array.isArray(p.plugins) && p.plugins.every(safePath) && Array.isArray(p.archives) && p.archives.every(safePath))))) return 'openmw.mods.parts invalide';
  if (o.languageVersions !== undefined && (!o.languageVersions || Array.isArray(o.languageVersions) || typeof o.languageVersions !== 'object' || !Object.entries(o.languageVersions).every(([code, id]) => /^[a-z]{2}$/.test(code) && typeof id === 'string' && ID.test(id)))) return 'openmw.languageVersions invalide';
  if (o.multiplayer !== undefined) {
    const mp = o.multiplayer;
    if (!mp || !Number.isInteger(mp.port) || mp.port < 1024 || mp.port > 65535) return 'openmw.multiplayer.port invalide';
    if (mp.maxPlayers !== undefined && (!Number.isInteger(mp.maxPlayers) || mp.maxPlayers < 2 || mp.maxPlayers > 32)) return 'openmw.multiplayer.maxPlayers invalide';
  }
  return null;
}

export function openmwInstalled(man, enginesDir) {
  const engine = man.openmw?.engine;
  try {
    const release = JSON.parse(fs.readFileSync(engineFile(enginesDir, engine, 'release.json'), 'utf8'));
    return release.runtime === 'openmw' && Array.isArray(release.files) && release.files.length > 0
      && ['index.html', 'launcher.html', ...release.files].every((f) => engineFile(enginesDir, engine, f))
      && (man.openmw.mods ?? []).every((m) => m.installed && m.parts?.length > 0)
      && (man.openmw.mods ?? []).flatMap((m) => m.parts ?? []).every((p) => resolveGameFile(man, `${p.dir}/${p.sentinel}`))
      && man.openmw.files.every((f) => resolveGameFile(man, f));
  } catch { return false; }
}

export const openmwBase = (id) => `/ports/openmw/${encodeURIComponent(id)}/app`;
export const openmwModes = (o) => ['solo', ...(o.multiplayer ? ['multiplayer'] : [])];

// Only the upstream browser pages are adapted. Guest filesystem paths (/mwdata, /userdata)
// and the generated Emscripten JS must retain their original meaning.
/**
 * An engine page with the Orthros page's meter (src/ports/openmw/frame-meter.js: its frame rate, the mouse and the
 * engine's loading status), the indicator of the game data it waits for (src/ports/openmw/stream-meter.js) and the
 * engine interface's texts in the Orthros page's language (src/ports/openmw/ui-l10n.js).
 */
export const withFrameMeter = (html) => html
  .replace('<head>', '<head><script src="/src/ports/openmw/frame-meter.js"></script><script src="/src/ports/openmw/stream-meter.js"></script><script src="/src/ports/openmw/ui-l10n.js"></script>')
  .replace('setStatus: (t)=>{ if(t){', 'setStatus: (t)=>{ window.orthrosStatus?.(t); if(t){');

/**
 * The engine build's files from the release's own URL (/engines/<release>/e/<hash>/, immutable) instead of beneath
 * each installation's: one browser copy for every version of a game, never downloaded again.
 */
/**
 * The engine page's file streaming: Orthros' own (src/ports/openmw/streamfs.js) in place of the release's, unless the
 * page is asked for the upstream one (?sfs=upstream: a comparison, a way around a fault).
 */
export const withStreaming = (html, upstream = false) => upstream ? html
  : html.replace(/<script src="e\/[0-9a-f]+\/streamfs\.js"><\/script>/, '<script src="/src/ports/openmw/streamfs.js"></script>');

export const withSharedEngine = (html, release) => html.replace('("e/" + __ENGINE_VER + "/")', `(${JSON.stringify(`/engines/${release}/e/`)} + __ENGINE_VER + "/")`);

export function openmwWebText(text, base, saveKey) {
  // Native EM_ASM in the untouched engine glue uses the upstream storage keys too.
  // HTML-only replacements would clear a different resume token than the engine reads.
  if (text.includes('async function rebootIntoWorld(wsUrl){') || text.includes('omw-mp-session')) text = text.replace('<script>', `<script>
    (function(){ ['getItem', 'setItem', 'removeItem'].forEach(function(method){
      var original = Storage.prototype[method];
      Storage.prototype[method] = function(){
        var args = Array.prototype.slice.call(arguments);
        if (typeof args[0] === 'string' && args[0].indexOf('omwmp:') === 0)
          args[0] = ${JSON.stringify(saveKey + ':mp:')} + args[0].slice(6);
        return original.apply(this, args);
      };
    }); })();
  `);
  return text.replace(/ · <a href="\/admin">server administration<\/a>/, '')
    .replace(/(["'`])\/(auth(?:\/|["'`])|worlds(?:\/|["'`])|locker(?:\/|["'`])|saves(?:\/|["'`])|w\/|ws(?=["'`])|clientlog(?=["'`])|admin(?:\/|["'`])|mwdata-(?:manifest|mods)\.json|index\.html|launcher\.html|join(?=["'`])|play(?=["'`]))/g, `$1${base}/$2`)
    .replace(/(location\.(?:href\s*=\s*|replace\(\s*))["']\/["']/g, `$1'${base}/'`)
    .replace(/(['"])omwmp:([^'"]+)\1/g, (_m, q, k) => `${q}${saveKey}:mp:${k}${q}`)
    .replace(/(['"])omw-mp-session\1/g, (_m, q) => `${q}${saveKey}:session${q}`)
    .replace(/(['"])omw-launcher\1/g, (_m, q) => `${q}${saveKey}:launcher${q}`)
    // The pieces of the served game files the engine streams are kept in its browser cache only for URLs without a
    // query (streamfs.js): the upstream's ?v=2 (a workaround for its CDN) kept none of Morrowind's own, so every
    // session read Morrowind.esm and the archives over the network again, the page frozen meanwhile.
    .replace("'mwdata/' + encodeURI(f.p) + '?v=2'", "'mwdata/' + encodeURI(f.p)")
    // IDBFS normally names the database after its guest mount point (/userdata).
    .replace("FS.mount(IDBFS, {}, '/userdata');", `var orthrosGetDB = IDBFS.getDB; IDBFS.getDB = function(name, callback) { return orthrosGetDB.call(IDBFS, name === '/userdata' ? ${JSON.stringify(saveKey)} : name, callback); }; FS.mount(IDBFS, {}, '/userdata');`)
    // JoinFriend also arrives inside the engine's WebSocket protocol, beyond the HTTP JSON
    // adaptation below. Scope its destination at the page's world-travel boundary, before
    // it is parked in the next boot fragment. Already scoped and foreign targets stay intact.
    .replace('async function rebootIntoWorld(wsUrl){', `async function rebootIntoWorld(wsUrl){
      var orthrosWorld = new URL(wsUrl, location.href);
      if (/^wss?:$/.test(orthrosWorld.protocol) && orthrosWorld.host === location.host
          && /^\\/w\\/[a-zA-Z0-9_-]+$/.test(orthrosWorld.pathname)) {
        orthrosWorld.pathname = ${JSON.stringify(base)} + orthrosWorld.pathname;
        wsUrl = orthrosWorld.href;
      }`);
}

function responseJson(body, base) {
  const visit = (v) => {
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      if (['wsPath', 'joinWsPath'].includes(k) && typeof v[k] === 'string' && v[k].startsWith('/w/')) v[k] = base + v[k];
      else visit(v[k]);
    }
  };
  const value = JSON.parse(body); visit(value); return JSON.stringify(value);
}

const proxyPath = (p) => /^\/(auth|worlds|locker|saves)(\/|$)/.test(p) || p === '/clientlog'
  || /^\/mwdata\//.test(p) || /^\/mwdata-(manifest|mods)\.json$/.test(p);
const OMIT_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'content-security-policy', 'x-frame-options']);
const isolation = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' };
function upstreamHeaders(req) {
  const headers = { ...req.headers, 'accept-encoding': 'identity', 'x-forwarded-for': clientAddress(req) };
  for (const key of ['cf-connecting-ip', 'true-client-ip', 'x-omw-client-ip', 'forwarded', 'cookie']) delete headers[key];
  return headers;
}

/** A namespaced bridge to one manifest's localhost gateway. Never accepts a target URL from a visitor. */
export function openmwProxy({ getManifest, session, ownsToken }) {
  function target(url) {
    const m = /^\/ports\/openmw\/([^/]+)\/app(\/.*)$/.exec(url.pathname);
    if (!m) return null;
    const man = getManifest(m[1]);
    return man?.runtime === 'openmw' && man.openmw?.multiplayer ? { man, id: m[1], path: m[2], base: openmwBase(m[1]) } : null;
  }
  return {
    handle(req, res, url) {
      const t = target(url);
      if (t?.path === '/admin/api/state' && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(200, { ...isolation, 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ serverName: t.man.name, setup: { deploymentMode: 'multiplayer', deliveryModel: 'serve' } })); return true;
      }
      if (!t || !proxyPath(t.path)) return false;
      // Hosted data is public for solo. Game sessions and lockers require Orthros identity.
      if (session && /^\/(auth|worlds|locker|saves)(\/|$)/.test(t.path)) {
        const user = session(req);
        if (!user || t.path.startsWith('/auth/') && !/^\/auth\/(profile|ticket|characters|friends-playing|providers)$/.test(t.path)) {
          res.writeHead(user ? 403 : 401, { ...isolation, 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: 'Connexion Orthros requise depuis la page du jeu.' })); return true;
        }
        const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
        if (bearer && ownsToken && !ownsToken(user, t.id, bearer)) {
          res.writeHead(403, { ...isolation, 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cette partie appartient à un autre compte ou doit être relancée.' })); return true;
        }
        if (!['GET', 'HEAD'].includes(req.method)) {
          let origin; try { origin = new URL(req.headers.origin); } catch { /* refused below */ }
          if (!origin || origin.host !== req.headers.host || !['https:', 'http:'].includes(origin.protocol)) {
            res.writeHead(403, isolation); res.end('Origine refusée.'); return true;
          }
        }
      }
      const upstream = http.request({ hostname: '127.0.0.1', port: t.man.openmw.multiplayer.port,
        path: t.path + url.search, method: req.method, headers: upstreamHeaders(req) }, (reply) => {
        const headers = { ...isolation, 'cache-control': 'no-store' };
        for (const [k, v] of Object.entries(reply.headers)) if (!OMIT_HEADERS.has(k) && v !== undefined) headers[k] = v;
        if (headers.location?.startsWith('/') && !headers.location.startsWith('//')) headers.location = t.base + headers.location;
        if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map((c) => c.replace(/;\s*Path=\/([^;]*)/i, `; Path=${t.base}/$1`));
        const type = String(reply.headers['content-type'] ?? '');
        if (req.method === 'HEAD' || !/text\/html|javascript|application\/json/.test(type)) {
          res.writeHead(reply.statusCode, headers); reply.pipe(res); return;
        }
        const chunks = []; let bytes = 0;
        reply.on('data', (c) => { bytes += c.length; if (bytes > 8 * 1024 * 1024) reply.destroy(new Error('OpenMW response too large')); else chunks.push(c); });
        reply.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8');
          try { body = /application\/json/.test(type) ? responseJson(body, t.base) : openmwWebText(body, t.base, t.man.saveKey); if (/text\/html/.test(type)) body = withFrameMeter(body); }
          catch { res.writeHead(502, isolation); res.end('Invalid OpenMW response'); return; }
          res.writeHead(reply.statusCode, headers); res.end(body);
        });
        reply.on('error', () => { if (!res.headersSent) res.writeHead(502, isolation); res.end('OpenMW gateway response failed'); });
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(503, isolation); res.end('OpenMW multiplayer is not running.'); });
      upstream.setTimeout(30000, () => upstream.destroy(new Error('timeout')));
      req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
      return true;
    },
    upgrade(req, socket, url, head) {
      const t = target(url);
      if (!t || !/^\/w\/[a-zA-Z0-9_-]+$/.test(t.path)) return false;
      if (session && !session(req)) { socket.destroy(); return true; }
      // Same origin is required before forwarding a player's credentials or opening a world.
      let origin; try { origin = new URL(req.headers.origin); } catch { socket.destroy(); return true; }
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) { socket.destroy(); return true; }
      const up = http.request({ hostname: '127.0.0.1', port: t.man.openmw.multiplayer.port,
        path: t.path + url.search, headers: upstreamHeaders(req) });
      up.on('upgrade', (reply, peer, first) => {
        let lines = `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n`;
        for (let i = 0; i < reply.rawHeaders.length; i += 2) lines += `${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}\r\n`;
        socket.write(lines + '\r\n'); if (first.length) socket.write(first); if (head?.length) peer.write(head);
        socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
        socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
        socket.pipe(peer).pipe(socket);
      });
      up.on('response', (reply) => { reply.resume(); socket.destroy(); });
      up.on('error', () => socket.destroy()); socket.on('close', () => up.destroy()); up.end();
      return true;
    },
  };
}

/**
 * Bytes [a, b) of a game file an OpenMW installation serves, brotli-compressed when that saves enough: how the page's
 * file streaming (src/ports/openmw/streamfs.js) reads them, the archives' records and the masters about 2 to 5 times
 * smaller than through the gateway's ranges. GET /ports/openmw/<manifest>/app/z/mwdata/<file>?r=<a>-<b>&s=<size>
 * (z/moddata/<file>: the engine release's own data). A whole answer, not a range: the browser decodes it before the page
 * sees it, through any proxy on the way. The file is the one the gateway serves (the installation's layered files),
 * its size the one the page knows (else 412: the page reads the plain range instead).
 */
export function openmwSpans({ getManifest, enginesDir, headers }) {
  const MAX = 16 << 20, JOBS = 4;
  let running = 0; const waiting = [];
  const take = () => running < JOBS ? (running++, Promise.resolve()) : new Promise((go) => waiting.push(go));
  const give = () => { const next = waiting.shift(); if (next) next(); else running--; };
  const fail = (res, code, text) => { res.writeHead(code, headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })); res.end(text); };
  return {
    handle(req, res, url) {
      const m = /^\/ports\/openmw\/([^/]+)\/app\/z\/(mwdata|moddata)\/(.+)$/.exec(url.pathname);
      if (!m || !['GET', 'HEAD'].includes(req.method)) return false;
      let id, rel; try { id = decodeURIComponent(m[1]); rel = decodeURIComponent(m[3]); } catch { fail(res, 400, 'bad path'); return true; }
      const man = getManifest(id);
      if (man?.runtime !== 'openmw' || !safePath(rel)) { fail(res, 404, 'not found'); return true; }
      const file = m[2] === 'mwdata' ? resolveGameFile(man, rel) : rel === 'openmw-web-assets.bsa' ? engineFile(enginesDir, man.openmw.engine, 'moddata/' + rel) : null;
      const r = /^(\d+)-(\d+)$/.exec(url.searchParams.get('r') ?? ''), size = Number(url.searchParams.get('s'));
      if (!file) { fail(res, 404, 'not found'); return true; }
      let st; try { st = fs.statSync(file); } catch { fail(res, 404, 'not found'); return true; }
      const a = r ? Number(r[1]) : NaN, b = r ? Number(r[2]) : NaN;
      if (!(a >= 0 && b > a && b <= st.size && b - a <= MAX)) { fail(res, 416, 'bad span'); return true; }
      if (size !== st.size) { fail(res, 412, 'size changed'); return true; }
      (async () => {
        await take();
        try {
          const raw = Buffer.alloc(b - a), fd = await fs.promises.open(file, 'r');
          try { await fd.read(raw, 0, raw.length, a); } finally { await fd.close(); }
          const packed = await new Promise((ok, no) => zlib.brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_LGWIN]: 22, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }, (e, out) => e ? no(e) : ok(out)));
          const body = packed.length < raw.length * 0.95 ? packed : raw;
          res.writeHead(200, headers({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': body.length, ...(body === packed ? { 'Content-Encoding': 'br' } : {}) }));
          res.end(req.method === 'HEAD' ? undefined : body);
        } catch { if (!res.headersSent) fail(res, 500, 'read failed'); else res.destroy(); }
        finally { give(); }
      })();
      return true;
    },
  };
}

/**
 * The order in which earlier sessions' file streaming (src/ports/openmw/streamfs-worker.js) read an installation's
 * files, and the list a new session fetches ahead from it: the opening every player goes through (the engine's start,
 * the menu, a new game), on its way while the engine still downloads or the player reads the menu, instead of piece by
 * piece while the page waits. POST /api/openmw/<manifest>/reads { session, reads: [[file, size, from, to, ms], …] }
 * (file: the path beneath the installation's app/ — mwdata/…, moddata/…; from/to: 64 KB block bounds; ms: the time in
 * its session); GET /api/openmw/<manifest>/prefetch: [[file, size, from, to, ms], …], each block at the mean time its
 * sessions needed it (a block a single session read is left out once three sessions are known), 400 MB at most, the
 * first 30 minutes of a session. Kept in <learnDir>/openmw-reads-<manifest>.json when there is one.
 */
export function openmwReads({ getManifest, enginesDir, learnDir, headers }) {
  const BLOCK = 65536, CAP = 400 << 20, UNTIL = 30 * 60000, PER_SESSION = 20000;
  const all = new Map();   // manifest -> { sessions, files: Map(key "file|size" -> Map(block -> [sum of ms, sessions, last session])), list }
  const counts = new Map();   // session -> reads taken (bounded)
  const fileOf = (id) => id.replace(/[^A-Za-z0-9._-]/g, '_');
  const store = (id) => learnDir && path.join(learnDir, `openmw-reads-${fileOf(id)}.json`);
  const send = (res, code, body) => { res.writeHead(code, headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })); res.end(JSON.stringify(body)); };
  function of(id) {
    let l = all.get(id);
    if (l) return l;
    l = { sessions: 0, seen: new Set(), files: new Map(), sizes: new Map(), list: null, dirty: false };
    try {
      const saved = JSON.parse(fs.readFileSync(store(id), 'utf8'));
      l.sessions = saved.sessions | 0;
      for (const [key, blocks] of Object.entries(saved.files ?? {})) l.files.set(key, new Map(blocks.map(([b, t, n]) => [b, [t, n, null]])));
    } catch { /* none yet */ }
    all.set(id, l); return l;
  }
  let timer = null;
  const save = () => {
    timer ??= setTimeout(() => {
      timer = null;
      for (const [id, l] of all) {
        if (!l.dirty || !store(id)) continue;
        l.dirty = false;
        const files = {};
        for (const [key, blocks] of l.files) files[key] = [...blocks].map(([b, [t, n]]) => [b, t, n]);
        try { fs.writeFileSync(store(id) + '.tmp', JSON.stringify({ sessions: l.sessions, files })); fs.renameSync(store(id) + '.tmp', store(id)); } catch { /* next time */ }
      }
    }, 10000);
    timer.unref?.();
  };
  /** The size of a file the installation serves at that path beneath app/, or null. */
  function sizeOf(man, l, file) {
    if (l.sizes.has(file)) return l.sizes.get(file);
    let found = null;
    try {
      const rel = decodeURIComponent(file);
      const f = rel.startsWith('mwdata/') && safePath(rel.slice(7)) ? resolveGameFile(man, rel.slice(7))
        : rel === 'moddata/openmw-web-assets.bsa' ? engineFile(enginesDir, man.openmw.engine, rel) : null;
      if (f) found = fs.statSync(f).size;
    } catch { /* not served */ }
    if (l.sizes.size < 50000) l.sizes.set(file, found);
    return found;
  }
  function list(l) {
    if (l.list) return l.list;
    const quorum = l.sessions >= 3 ? 2 : 1, blocks = [];
    for (const [key, map] of l.files) {
      const cut = key.lastIndexOf('|'), file = key.slice(0, cut), size = Number(key.slice(cut + 1));
      for (const [b, [t, n]] of map) if (n >= quorum) blocks.push([t / n, file, size, b]);
    }
    blocks.sort((x, y) => x[0] - y[0]);
    const out = []; let bytes = 0;
    for (const [t, file, size, b] of blocks) {
      const from = b * BLOCK, to = Math.min(size, from + BLOCK), last = out.at(-1);
      if (bytes + (to - from) > CAP) break;
      bytes += to - from;
      if (last && last[0] === file && last[3] === from && last[3] - last[2] < 4 << 20) last[3] = to; else out.push([file, size, from, to, Math.round(t)]);
    }
    l.list = JSON.stringify(out);
    setTimeout(() => { l.list = null; }, 30000).unref?.();
    return l.list;
  }
  return {
    handle(req, res, url) {
      const m = /^\/api\/openmw\/([^/]+)\/(reads|prefetch)$/.exec(url.pathname);
      if (!m) return false;
      let id; try { id = decodeURIComponent(m[1]); } catch { send(res, 400, { error: 'bad id' }); return true; }
      const man = getManifest(id);
      if (man?.runtime !== 'openmw') { send(res, 404, { error: 'no such installation' }); return true; }
      const l = of(id);
      if (m[2] === 'prefetch') {
        if (req.method !== 'GET') { send(res, 405, { error: 'GET' }); return true; }
        res.writeHead(200, headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })); res.end(list(l)); return true;
      }
      if (req.method !== 'POST') { send(res, 405, { error: 'POST' }); return true; }
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 1 << 20) req.destroy(); else chunks.push(c); });
      req.on('end', () => {
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(res, 400, { error: 'json' }); return; }
        const session = typeof body?.session === 'string' && /^[a-z0-9]{8,32}$/.test(body.session) ? body.session : null;
        if (!session || !Array.isArray(body.reads)) { send(res, 400, { error: 'session, reads' }); return; }
        if (!l.seen.has(session)) { l.seen.add(session); l.sessions++; if (l.seen.size > 10000) l.seen.clear(); }
        let taken = counts.get(session) ?? 0;
        for (const r of body.reads) {
          if (taken >= PER_SESSION) break;
          if (!Array.isArray(r) || r.length !== 5 || typeof r[0] !== 'string' || r[0].length > 600) continue;
          const [file, fsize, from, to, ms] = r;
          if (![fsize, from, to, ms].every(Number.isInteger) || ms < 0 || ms > UNTIL || from < 0 || to <= from || to > fsize || from % BLOCK) continue;
          if (sizeOf(man, l, file) !== fsize) continue;
          const key = file + '|' + fsize, blocks = l.files.get(key) ?? l.files.set(key, new Map()).get(key);
          for (let b = from / BLOCK; b * BLOCK < to && taken < PER_SESSION; b++, taken++) {
            const e = blocks.get(b);
            if (!e) blocks.set(b, [ms, 1, session]);
            else if (e[2] !== session) { e[0] += ms; e[1]++; e[2] = session; }
          }
        }
        counts.set(session, taken); if (counts.size > 10000) counts.clear();
        l.dirty = true; l.list = null; save();
        send(res, 200, { ok: true });
      });
      return true;
    },
  };
}
