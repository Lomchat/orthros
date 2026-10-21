// OpenMW browser ports. Third-party code stays in data_engines; HTTP and WebSocket traffic
// stays on the Orthros origin, beneath the selected installation's URL.
import http from 'node:http';
import fs from 'node:fs';
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

/**
 * The bytes a page downloads for the engine itself at its first launch (its release's e/ files, brotli when served so:
 * the home's "playable after", which a browser that ran this engine release before does not pay again), or 0.
 */
export function openmwEngineWire(man, enginesDir, lean = null) {
  try {
    const release = JSON.parse(fs.readFileSync(engineFile(enginesDir, man.openmw.engine, 'release.json'), 'utf8'));
    let n = 0;
    for (const f of release.files ?? []) {
      if (!/^e\/[^/]+\/[^/]+\.(js|wasm|data)$/.test(f)) continue;
      // (a game of its own loads the package without the example world once the server made it: openmw-lean.js)
      const leanBytes = f.endsWith('/openmw.data') && !man.openmw.example ? lean?.size(man.openmw.engine) : null;
      if (leanBytes) { n += leanBytes; continue; }
      const p = engineFile(enginesDir, man.openmw.engine, f); if (!p) continue;
      const br = p + '.br';
      n += fs.existsSync(br) ? fs.statSync(br).size : fs.statSync(p).size;
    }
    return n;
  } catch { return 0; }
}

export const openmwBase = (id) => `/ports/openmw/${encodeURIComponent(id)}/app`;
export const openmwModes = (o) => ['solo', ...(o.multiplayer ? ['multiplayer'] : [])];

// Only the upstream browser pages are adapted. Guest filesystem paths (/mwdata, /userdata)
// and the generated Emscripten JS must retain their original meaning.
/**
 * An engine page with the Orthros page's meter (src/ports/openmw/frame-meter.js: its frame rate, the mouse and the
 * engine's loading status), the indicator of the game data it waits for (src/host/web/data-meter.js, every game's) and the
 * engine interface's texts in the Orthros page's language (src/ports/openmw/ui-l10n.js).
 */
export const withFrameMeter = (html) => html
  .replace('<head>', '<head><script src="/src/ports/openmw/frame-meter.js"></script><script src="/src/host/web/data-meter.js"></script><script src="/src/ports/openmw/ui-l10n.js"></script>')
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

/**
 * The engine page's view distance and Orthros' script in the engine (src/ports/openmw/view-grow.js, view.lua): the
 * module loaded before the engine (its load waits for it), the boot viewing distance its choice (short on a link that
 * is not fast, then raised as the game data allows; distant terrain and object paging as the tier says), and Orthros'
 * content (orthros.omwscripts) in every single-player openmw.cfg the page writes, whatever the link (saves list their
 * content files). Multiplayer and the baked example world (?nomw) keep the tier's distance and their own content list:
 * a world refuses a client whose content its own list lacks (BAD_CONTENT). Each hook falls back to the page's own when
 * the module did not load.
 */
export const withProgressiveView = (html) => html
  .replace('<head>', `<head><script>window.orthrosViewReady = import('/src/ports/openmw/view-grow.js').then(function (m) { return m.install(window); }).catch(function (e) { console.warn('[orthros view]', e); });</script>`)
  .replace("'viewing distance = ' + ((/[?&]vd=(\\d+)/.exec(location.search)||[])[1] || TIER.vd)",
    "'viewing distance = ' + ((/[?&]vd=(\\d+)/.exec(location.search)||[])[1] || (window.orthrosViewBoot ? window.orthrosViewBoot(TIER.vd) : TIER.vd))")
  .replace(/FS\.writeFile\('\/openmw\.cfg',\s*cfg\.join\('\\n'\)\)/g, "FS.writeFile('/openmw.cfg', (window.orthrosContent ? window.orthrosContent(FS, cfg) : cfg).join('\\n'))")
  .replace('document.body.appendChild(s);', 'Promise.resolve(window.orthrosViewReady).then(function () { document.body.appendChild(s); });');

export const withSharedEngine =(html, release) => html.replace('("e/" + __ENGINE_VER + "/")', `(${JSON.stringify(`/engines/${release}/e/`)} + __ENGINE_VER + "/")`);

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
