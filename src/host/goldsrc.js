// GoldSrc browser ports (docs/browser-ports.md): a game version whose manifest says "runtime": "goldsrc" does not run in
// the Win32 runtime. Its page (src/ports/goldsrc/) runs a pinned third-party GoldSrc engine compiled to WebAssembly,
// installed outside Git in data_engines/<release>/, over the game's own files (/game/<manifest>/). This module checks
// such a manifest entry, tells whether its engine release is installed, links the game's layers for the native
// dedicated server, and relays multiplayer: one WebSocket per player to the version's dedicated server on a localhost
// UDP port. Nothing here names a game: engine release, game directory, modules, maps and ports come from the manifest.
import dgram from 'node:dgram';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameLayers, resolveGameFile } from './game-files.js';

export const DEFAULT_ENGINES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data_engines');
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const MAP = /^[A-Za-z0-9_.-]+$/;
const COMMAND = /^[\x20-\x7e]{1,200}$/;
// (console commands of a manifest: one per entry, none chained)
const commandsOk = (list) => Array.isArray(list) && list.every((c) => typeof c === 'string' && COMMAND.test(c) && !c.includes(';'));
/** The archives a version mounts in its game folder (release paths): the engine's own by default. */
export const goldsrcExtras = (g) => g.extras ?? ['engine/valve/extras.pk3'];
const safePath = (value) => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.'));
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** What is wrong with a version's `goldsrc` entry, or null. */
export function goldsrcProblem(g) {
  if (!isObject(g)) return 'goldsrc obligatoire pour le runtime goldsrc';
  if (!ID.test(g.engine ?? '')) return 'goldsrc.engine doit nommer une release de data_engines/';
  if (!safePath(g.gameDir) || g.gameDir.includes('/')) return 'goldsrc.gameDir doit nommer un dossier du jeu';
  if (!isObject(g.modules) || !['client', 'server'].every((k) => safePath(g.modules[k])) || (g.modules.menu !== undefined && !safePath(g.modules.menu))) return 'goldsrc.modules.client et .server (et .menu) doivent être des chemins de la release';
  if (g.solo === undefined && g.multiplayer === undefined) return 'goldsrc.solo ou goldsrc.multiplayer obligatoire';
  if (g.solo !== undefined && (!isObject(g.solo) || !MAP.test(g.solo.map ?? ''))) return 'goldsrc.solo.map invalide';
  if (g.solo?.commands !== undefined && !commandsOk(g.solo.commands)) return 'goldsrc.solo.commands : commandes de console, une par entrée';
  if (g.extras !== undefined && (!Array.isArray(g.extras) || !g.extras.every((e) => safePath(e) && /\.pk3$/i.test(e)) || new Set(g.extras.map((e) => path.posix.basename(e).toLowerCase())).size !== g.extras.length)) return 'goldsrc.extras : archives .pk3 de la release, de noms distincts';
  if (g.multiplayer !== undefined) {
    const mp = g.multiplayer;
    if (!isObject(mp) || !MAP.test(mp.map ?? '') || !Number.isInteger(mp.port) || mp.port < 1024 || mp.port > 65535 || !ID.test(mp.server ?? '')) return 'goldsrc.multiplayer : server, port (1024-65535) et map obligatoires';
    if (mp.maxPlayers !== undefined && (!Number.isInteger(mp.maxPlayers) || mp.maxPlayers < 2 || mp.maxPlayers > 32)) return 'goldsrc.multiplayer.maxPlayers invalide';
    if (mp.gameLibrary !== undefined && !safePath(mp.gameLibrary)) return 'goldsrc.multiplayer.gameLibrary doit être un chemin de la release';
    if (mp.commands !== undefined && !commandsOk(mp.commands)) return 'goldsrc.multiplayer.commands : commandes de console, une par entrée';
    if (mp.mapImage !== undefined && (typeof mp.mapImage !== 'string' || !mp.mapImage.includes('{map}') || !safePath(mp.mapImage.replaceAll('{map}', 'm')))) return 'goldsrc.multiplayer.mapImage : chemin du dossier du jeu avec {map}';
    if (mp.maps !== undefined && (!Array.isArray(mp.maps) || !mp.maps.length || !mp.maps.every((n) => typeof n === 'string' && MAP.test(n)))) return 'goldsrc.multiplayer.maps : noms de cartes';
    if (mp.rooms !== undefined) {
      const r = mp.rooms, [first, last] = Array.isArray(r?.ports) ? r.ports : [];
      if (!isObject(r) || !Number.isInteger(first) || !Number.isInteger(last) || first < 1024 || last > 65535 || last < first || last - first >= 8 || (mp.port >= first && mp.port <= last)) return 'goldsrc.multiplayer.rooms.ports : [premier, dernier], 8 ports au plus, hors du port du serveur';
      if (r.bots !== undefined && (!isObject(r.bots) || !Number.isInteger(r.bots.max) || r.bots.max < 1 || r.bots.max > 31 || !commandsOk(r.bots.commands ?? []) || !(r.bots.commands ?? []).some((c) => c.includes('{n}')))) return 'goldsrc.multiplayer.rooms.bots : max (1-31) et commands, l\'une avec {n}';
      if (r.options !== undefined && !roomOptionsOk(r.options)) return 'goldsrc.multiplayer.rooms.options : [{ id, label, default, choices: [{ id, label, commands }] }], ids distincts';
      if (r.bots?.args !== undefined && (!Array.isArray(r.bots.args) || !r.bots.args.every((a) => typeof a === 'string' && /^-[a-z0-9_]{1,32}$/.test(a)))) return 'goldsrc.multiplayer.rooms.bots.args : options de ligne de commande (-nom)';
    }
  }
  return null;
}

const OPTION_ID = /^[A-Za-z0-9_-]{1,32}$/;
const labelOk = (l) => typeof l === 'string' ? l.length > 0 && l.length <= 60 : isObject(l) && Object.entries(l).length > 0 && Object.entries(l).every(([k, v]) => /^[a-z]{2}$/.test(k) && typeof v === 'string' && v.length > 0 && v.length <= 60);
/** A room's settings a player chooses (rooms.options): each a few choices, each its server commands. */
function roomOptionsOk(options) {
  if (!Array.isArray(options) || options.length > 8 || new Set(options.map((o) => o?.id)).size !== options.length) return false;
  return options.every((o) => isObject(o) && OPTION_ID.test(o.id ?? '') && labelOk(o.label) && [o.bots, o.show].every((b) => b === undefined || typeof b === 'boolean')
    && Array.isArray(o.choices) && o.choices.length >= 2 && o.choices.length <= 12
    && o.choices.every((c) => isObject(c) && OPTION_ID.test(c.id ?? '') && labelOk(c.label) && commandsOk(c.commands ?? []))
    && new Set(o.choices.map((c) => c.id)).size === o.choices.length && o.choices.some((c) => c.id === o.default));
}

// ---------------------------------------------------------------- the rooms: the games players create
// A version whose multiplayer names `rooms` gets, beside its permanent server (room 0), up to one room per port of its
// range, created on demand with a name, a map, a size and bots, and stopped once empty (tools/goldsrc/server.mjs).

/** The UDP port of a room. */
export const roomPort = (mp, index) => (index === 0 ? mp.port : mp.rooms.ports[0] + index - 1);
/** How many rooms players may create. */
export const roomSlots = (mp) => (mp.rooms ? mp.rooms.ports[1] - mp.rooms.ports[0] + 1 : 0);
/** A room's name as players read it: printable, no quotes nor console separators, 32 characters at most. */
export const roomName = (value) => String(value ?? '').normalize('NFC').replace(/[\p{C}"\\;]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 32);
/** Two room names that read the same (case, compatibility forms). */
export const sameRoomName = (a, b) => roomName(a).normalize('NFKC').toLowerCase() === roomName(b).normalize('NFKC').toLowerCase();

/** The visitor's address: the one the local reverse proxy (Caddy, trusting Cloudflare's) put last, else the socket's. */
export function clientAddress(req) {
  const remote = String(req.socket?.remoteAddress ?? '');
  const local = /^(127\.|::1$|::ffff:127\.)/.test(remote);
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((v) => v.trim()).filter(Boolean).at(-1);
  return local && forwarded ? forwarded : remote;
}

/**
 * A request to create a room, checked: { name, map (one of `maps`), maxPlayers (2 to the server's), bots (0 to the
 * rooms' max, none without bots) }, or a message saying what is wrong.
 */
export function roomRequest(body, mp, maps) {
  const name = roomName(body?.name), map = String(body?.map ?? ''), maxPlayers = Number(body?.maxPlayers ?? mp.maxPlayers ?? 16), bots = Number(body?.bots ?? 0);
  if (name.length < 2) return { error: 'name' };
  if (!maps.includes(map)) return { error: 'map' };
  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > (mp.maxPlayers ?? 16)) return { error: 'maxPlayers' };
  if (!Number.isInteger(bots) || bots < 0 || bots > (mp.rooms?.bots?.max ?? 0) || bots >= maxPlayers) return { error: 'bots' };
  // (each option a choice of its own, its default when none: rooms.options)
  const options = {};
  for (const o of mp.rooms?.options ?? []) {
    const wanted = body?.options?.[o.id] ?? o.default;
    if (!o.choices.some((c) => c.id === wanted)) return { error: 'options' };
    options[o.id] = wanted;
  }
  return { room: { name, map, maxPlayers, bots, options } };
}

/** The server commands of a room's chosen options (an option whose bots: true goes only with bots). */
export const roomOptionCommands = (mp, room) => (mp.rooms?.options ?? [])
  .filter((o) => !o.bots || room.bots > 0)
  .flatMap((o) => o.choices.find((c) => c.id === room.options?.[o.id])?.commands ?? []);

/** A map's picture for the lobby (multiplayer.mapImage, a file of the game folder: the game's own overview), or null. */
export function mapImageFile(manifest, map) {
  const mp = manifest?.goldsrc?.multiplayer;
  if (!mp?.mapImage || !MAP.test(map ?? '')) return null;
  return resolveGameFile(manifest, `${manifest.goldsrc.gameDir}/${mp.mapImage.replaceAll('{map}', map)}`);
}

/** The answer of a dedicated server to `info 49` (its name, map, clients, maximum), or null. */
export function parseServerInfo(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  if (!text.startsWith('\xff\xff\xff\xffinfo\n\\')) return null;
  const parts = text.slice(10).split('\\'), info = {};
  for (let i = 0; i + 1 < parts.length; i += 2) info[parts[i]] = parts[i + 1];
  const players = Number(info.numcl), max = Number(info.maxcl);
  return info.map && Number.isFinite(players) && Number.isFinite(max) ? { name: info.host ?? '', map: info.map, players, max } : null;
}

/** The modes a version offers, in the page's order. */
export const goldsrcModes = (g) => [...(g?.solo ? ['solo'] : []), ...(g?.multiplayer ? ['multiplayer'] : [])];

/** A file of an installed engine release (no traversal, no symlink leaving the release), or null. */
export function engineFile(enginesDir, release, rel) {
  if (!ID.test(release ?? '') || !safePath(rel)) return null;
  try {
    const root = fs.realpathSync(path.join(enginesDir, release)), file = fs.realpathSync(path.join(root, rel));
    return file.startsWith(root + path.sep) && fs.statSync(file).isFile() ? file : null;
  } catch { return null; }
}

/** The engine release and every module the version names are installed. */
export function goldsrcInstalled(manifest, enginesDir) {
  const g = manifest.goldsrc;
  return !!engineFile(enginesDir, g.engine, 'release.json') && ['engine/index.js', 'engine/xash.wasm', ...Object.values(g.modules), ...goldsrcExtras(g)].every((f) => engineFile(enginesDir, g.engine, f));
}

/** The browser launch page of a port. */
export const portLaunchUrl = (name, manifest) => `/ports/${manifest.runtime}/${encodeURIComponent(name)}/`;

/**
 * The version's files as one directory for the native dedicated server (it reads a single directory): `dest` is
 * rebuilt with a symbolic link per file, version files replacing same-named base files whatever their case, as the page
 * sees them. Returns the number of files linked.
 */
export function linkGameLayers(manifest, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  let count = 0;
  const walk = (dirs, out) => {
    fs.mkdirSync(out, { recursive: true });
    const entries = new Map();
    for (const dir of dirs) {
      let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of list) {
        const key = ent.name.toLowerCase(), prev = entries.get(key), p = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (!prev) entries.set(key, { name: ent.name, dirs: [p] }); else prev.dirs?.push(p); }
        else if (ent.isFile() && !prev) entries.set(key, { name: ent.name, file: p });
      }
    }
    for (const e of entries.values()) {
      if (e.dirs) walk(e.dirs, path.join(out, e.name));
      else { fs.symlinkSync(e.file, path.join(out, e.name)); count++; }
    }
  };
  walk(gameLayers(manifest), dest);
  return count;
}

/**
 * The rooms of a version (GET /api/rooms/<manifest>: its servers, maps and limits; POST: a room created, checked here
 * first), asked of its server manager on 127.0.0.1:<goldsrc.multiplayer.port> over TCP (tools/goldsrc/server.mjs).
 * A creation needs the page's origin and comes once a minute per address. `handle(req, res, url)` answers or returns false.
 */
export function roomsApi({ getManifest, request = managerRequest, now = () => Date.now() }) {
  const created = new Map(), recent = []; // (per address; every creation of the last minute: 6 at most, all addresses)
  const handle = (req, res, url) => {
    const m = /^\/api\/rooms\/([^/]+)$/.exec(url.pathname);
    if (!m) return false;
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const man = getManifest(decodeURIComponent(m[1])), mp = man?.runtime === 'goldsrc' ? man.goldsrc?.multiplayer : null;
    if (!mp) { send(404, { error: 'none' }); return true; }
    if (req.method === 'GET') {
      // (the options' choices for the page: ids and labels, not their commands)
      const options = (mp.rooms?.options ?? []).map((o) => ({ id: o.id, label: o.label, default: o.default, bots: !!o.bots, show: !!o.show, choices: o.choices.map((c) => ({ id: c.id, label: c.label })) }));
      request(mp.port, 'GET', null).then(([, body]) => send(200, { ...body, options, mapImages: !!mp.mapImage, creatable: !!mp.rooms }), () => send(200, { rooms: [], maps: [], options, slots: 0, offline: true, creatable: false }));
      return true;
    }
    if (req.method !== 'POST') { send(405, { error: 'method' }); return true; }
    let sameOrigin = false; try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* no Origin: refused */ }
    if (!sameOrigin || !mp.rooms) { send(403, { error: 'forbidden' }); return true; }
    const who = clientAddress(req), t = now();
    while (recent.length && t - recent[0] > 60000) recent.shift();
    if (t - (created.get(who) ?? -Infinity) < 60000 || recent.length >= 6) { send(429, { error: 'wait' }); return true; }
    // (the slot taken at once: requests sent together cannot all pass the check)
    created.set(who, t); recent.push(t);
    const release = () => { created.delete(who); const i = recent.indexOf(t); if (i >= 0) recent.splice(i, 1); };
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 2048) { release(); req.destroy(); } });
    req.on('end', () => {
      let wanted; try { wanted = JSON.parse(body); } catch { release(); send(400, { error: 'json' }); return; }
      const checked = roomRequest(wanted, mp, [wanted?.map].filter((x) => typeof x === 'string')); // (the map is the manager's to check)
      if (checked.error && checked.error !== 'map') { release(); send(400, { error: checked.error }); return; }
      // (`by`: one live room per address, the manager's to keep)
      request(mp.port, 'POST', { name: wanted.name, map: wanted.map, maxPlayers: wanted.maxPlayers, bots: wanted.bots ?? 0, options: wanted.options ?? {}, by: who })
        .then(([status, out]) => { if (status !== 201) release(); send(status, out); }, () => { release(); send(503, { error: 'offline' }); });
    });
    return true;
  };
  return { handle };
}

/** An HTTP request to a version's server manager: [status, json]. */
export function managerRequest(port, method, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/rooms', method, timeout: method === 'POST' ? 30000 : 2000, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let text = ''; res.on('data', (d) => { text += d; }); res.on('end', () => { try { resolve([res.statusCode, JSON.parse(text)]); } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

/**
 * Multiplayer relay: a WebSocket upgrade on /api/udp/<manifest> becomes UDP sockets to the version's dedicated servers
 * on 127.0.0.1 — never another destination. Without `?rooms`, one socket to its permanent server
 * (goldsrc.multiplayer.port). With `?rooms` (the page's own), each message carries the room it goes to or comes from in
 * its first byte (255: to every room, the game's LAN search), each room its own socket. Same-origin pages only (a page
 * elsewhere cannot use this server as a relay), at most `maxClients` at once, idle connections closed after two
 * minutes. `accept(req, socket)` completes the WebSocket handshake and returns a peer (lan.js).
 */
export function udpRelay({ getManifest, accept, maxClients = 64, log = () => {} }) {
  const clients = new Set();
  let serial = 0;
  const handle = (req, socket, url) => {
    const m = /^\/api\/udp\/([^/]+)$/.exec(url.pathname);
    if (!m) return false;
    const man = getManifest(decodeURIComponent(m[1])), mp = man?.runtime === 'goldsrc' ? man.goldsrc?.multiplayer : null;
    let sameOrigin = false; try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* no Origin: refused */ }
    // (the refusal, then the socket closed for good: a client keeping its side open would hold it forever)
    if (!mp || !sameOrigin || clients.size >= maxClients) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => socket.destroy()); return true; }
    const tagged = url.searchParams.has('rooms'), count = 1 + roomSlots(mp);
    // (each player its own loopback address: the engine limits queries and connections per address — one for all
    // would let one player's queries starve everyone's, the manager's included; 127.64.0.0/16, never 127.0.0.1)
    const n = serial++ % 65000 + 1, address = `127.64.${n >> 8}.${n & 255}`;
    // (a budget of packets a second: a game sends some tens; the LAN search, every room at once, a few)
    const budget = { at: Date.now(), packets: 0, searches: 0 };
    const allowed = (search) => {
      const t = Date.now(); if (t - budget.at >= 1000) { budget.at = t; budget.packets = 0; budget.searches = 0; }
      if (++budget.packets > 500) return false;
      return !search || ++budget.searches <= 4;
    };
    /** @type {Map<number, { udp: any, ready: boolean, pending: Buffer[] }>} */
    const sockets = new Map();
    let closed = false, peer = null;
    const open = (index) => {
      let s = sockets.get(index);
      if (s) return s;
      const udp = dgram.createSocket('udp4');
      s = { udp, ready: false, pending: [] }; sockets.set(index, s);
      // (a room that is not running refuses its packets: that socket goes, the others stay)
      udp.on('error', (e) => { if (index === 0 && !tagged) { log(`udp relay ${m[1]}: ${e.message}`); peer?.close(); } else { sockets.delete(index); try { udp.close(); } catch { /* closed */ } } });
      udp.on('message', (bytes) => {
        if (socket.writableLength > 1024 * 1024) { peer?.close(); return; }
        peer?.send(tagged ? Buffer.concat([Buffer.from([index]), bytes]) : bytes);
      });
      udp.bind(0, address, () => udp.connect(roomPort(mp, index), '127.0.0.1', () => { if (closed) return; s.ready = true; for (const p of s.pending.splice(0)) udp.send(p); }));
      return s;
    };
    const send = (index, msg) => {
      const s = open(index);
      if (s.ready) s.udp.send(msg); else if (s.pending.length < 32) s.pending.push(msg); else peer?.close();
    };
    peer = accept(req, socket, (msg, text) => {
      if (text) return;
      if (!tagged) { if (allowed(false)) send(0, msg); return; }
      if (msg.length < 2) return;
      const index = msg[0], data = msg.subarray(1);
      if (!allowed(index === 255)) return;
      if (index === 255) { for (let i = 0; i < count; i++) send(i, data); } else if (index < count) send(index, data);
    }, () => { closed = true; clients.delete(peer); for (const s of sockets.values()) { try { s.udp.close(); } catch { /* not bound */ } } });
    if (!peer) return true;
    clients.add(peer);
    socket.setTimeout(120000, () => peer.close());
    if (!tagged) open(0);
    return true;
  };
  return { handle, clients };
}
