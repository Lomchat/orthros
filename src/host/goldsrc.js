// GoldSrc browser ports (docs/browser-ports.md): a game version whose manifest says "runtime": "goldsrc" does not run in
// the Win32 runtime. Its page (src/ports/goldsrc/) runs a pinned third-party GoldSrc engine compiled to WebAssembly,
// installed outside Git in data_engines/<release>/, over the game's own files (/game/<manifest>/). This module checks
// such a manifest entry, tells whether its engine release is installed, links the game's layers for the native
// dedicated server, and relays multiplayer: one WebSocket per player to the version's dedicated server on a localhost
// UDP port. Nothing here names a game: engine release, game directory, modules, maps and ports come from the manifest.
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameLayers } from './game-files.js';

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
  }
  return null;
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
 * Multiplayer relay: a WebSocket upgrade on /api/udp/<manifest> becomes one UDP socket to the version's dedicated
 * server on 127.0.0.1:<goldsrc.multiplayer.port> — never another destination. Same-origin pages only (a page elsewhere
 * cannot use this server as a relay), at most `maxClients` at once, idle connections closed after two minutes.
 * `accept(req, socket)` completes the WebSocket handshake and returns a peer (lan.js).
 */
export function udpRelay({ getManifest, accept, maxClients = 64, log = () => {} }) {
  const clients = new Set();
  const handle = (req, socket, url) => {
    const m = /^\/api\/udp\/([^/]+)$/.exec(url.pathname);
    if (!m) return false;
    const man = getManifest(decodeURIComponent(m[1])), mp = man?.runtime === 'goldsrc' ? man.goldsrc?.multiplayer : null;
    let sameOrigin = false; try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* no Origin: refused */ }
    // (the refusal, then the socket closed for good: a client keeping its side open would hold it forever)
    if (!mp || !sameOrigin || clients.size >= maxClients) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => socket.destroy()); return true; }
    const udp = dgram.createSocket('udp4');
    let ready = false, closed = false;
    const pending = [];
    const peer = accept(req, socket, (msg, text) => {
      if (text) return;
      if (ready) udp.send(msg); else if (pending.length < 32) pending.push(msg); else peer.close();
    }, () => { closed = true; clients.delete(peer); try { udp.close(); } catch { /* not bound */ } });
    if (!peer) { try { udp.close(); } catch { /* not bound */ } return true; }
    clients.add(peer);
    socket.setTimeout(120000, () => peer.close());
    udp.on('error', (e) => { log(`udp relay ${m[1]}: ${e.message}`); peer.close(); });
    udp.on('message', (bytes) => { if (socket.writableLength > 1024 * 1024) peer.close(); else peer.send(bytes); });
    udp.connect(mp.port, '127.0.0.1', () => { if (closed) return; ready = true; for (const p of pending.splice(0)) udp.send(p); });
    return true;
  };
  return { handle, clients };
}
