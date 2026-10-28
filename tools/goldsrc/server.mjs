// The native dedicated servers of a GoldSrc version (docs/browser-ports.md), run by systemd
// (tools/goldsrc/orthros-goldsrc@.service, instance = the manifest id): Xash3D FWGS built from pinned sources
// (build-server.sh) in data/engines/<goldsrc.multiplayer.server>/, serving the version's files read-only on 127.0.0.1
// only — players reach them through the Orthros server's relay (/api/udp/<manifest>).
// Room 0 is the version's permanent server (goldsrc.multiplayer.port, its map, its rotation). With
// goldsrc.multiplayer.rooms, players create more — a name, a map it stays on, a size, bots — one per port of the
// range, each stopped after `IDLE` seconds without a human player. Rooms are listed and created over HTTP on
// 127.0.0.1:<goldsrc.multiplayer.port> (TCP), for the Orthros server only (src/host/goldsrc.js roomsProxy):
//   GET /rooms  -> { rooms: [{ index, port, name, map, players (bots included), humans, maxPlayers, bots, permanent, since, up }], maps,
//                    slots, maxPlayers, bots: { max } | null }
//   POST /rooms { name, map, maxPlayers, bots, options, by } -> 201 { room, key } once the server answers, or 400/409/503
//                    (`by`: the creator's address — one live room each; `key`: the room's secret, its creator's to close it)
//   DELETE /rooms/<index> { key } -> 200 { closed } (its server stopped), 403 (room 0, or not its key) or 404
// The game library is the one the game's files name, or goldsrc.multiplayer.gameLibrary: a native build in the browser
// release (tools/goldsrc/build-modules.sh). The writable state (configuration, logs, the linked game files) goes to
// $STATE_DIRECTORY, or --state <dir>; a room's to rooms/<index>/ there.
// Usage: node tools/goldsrc/server.mjs <manifest> [--games-dir <dir>] [--engines-dir <dir>] [--state <dir>]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadGameCatalog, DEFAULT_GAMES_DIR } from '../../src/host/game-catalog.js';
import { DEFAULT_ENGINES_DIR, engineFile, linkGameLayers, parseServerInfo, roomOptionCommands, roomPort, roomRequest, roomSlots, sameRoomName } from '../../src/host/goldsrc.js';

const IDLE = 300; // (seconds a created room stays without a human player)
const args = process.argv.slice(2), arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const id = args[0], stateArg = arg('--state') ?? process.env.STATE_DIRECTORY;
if (!id || !stateArg) { console.error('usage: server.mjs <manifest> [--games-dir d] [--engines-dir d] [--state d]'); process.exit(2); }
const state = path.resolve(stateArg);
// (the catalog over the same engines folder: the release's own game files — gamefiles/, its bots' meshes — laid over the
// version's as the page sees them, linkGameLayers below)
const engines = path.resolve(arg('--engines-dir') ?? DEFAULT_ENGINES_DIR);
const man = loadGameCatalog(path.resolve(arg('--games-dir') ?? DEFAULT_GAMES_DIR), null, { enginesDir: engines }).get(id);
const g = man?.runtime === 'goldsrc' ? man.goldsrc : null, mp = g?.multiplayer;
if (!mp) { console.error(`${id}: no GoldSrc version with a multiplayer server`); process.exit(2); }
const release = path.join(engines, mp.server);
if (!fs.existsSync(path.join(release, 'xash'))) { console.error(`${release}: dedicated-server release not installed (tools/goldsrc/build-server.sh)`); process.exit(1); }
const gameLibrary = mp.gameLibrary === undefined ? null : engineFile(engines, g.engine, mp.gameLibrary);
if (mp.gameLibrary !== undefined && !gameLibrary) { console.error(`${g.engine}/${mp.gameLibrary}: game library not installed (tools/goldsrc/build-modules.sh)`); process.exit(1); }
// (one directory for the engine: the release's game files over the version's, over the base's, linked afresh at each
// start)
const game = path.join(state, 'game');
console.log(`${id}: ${linkGameLayers(man, game)} game files linked`);
// (the archives goldsrc.extras names in the game folder, as the page mounts them: the engine's extras; an older
// release's bot profiles and navigation meshes, which a newer one has as loose game files in its gamefiles/)
const gameFolder = path.join(game, fs.readdirSync(game).find((n) => n.toLowerCase() === g.gameDir.toLowerCase()) ?? g.gameDir);
fs.mkdirSync(gameFolder, { recursive: true });
for (const extra of g.extras ?? []) {
  const file = engineFile(engines, g.engine, extra), dest = path.join(gameFolder, path.basename(extra));
  if (!file) { console.error(`${g.engine}/${extra}: archive not installed`); process.exit(1); }
  fs.rmSync(dest, { force: true }); fs.symlinkSync(file, dest);
}
// (the maps a room may be on: the manifest's list, else every map of the game folder)
const mapsDir = fs.readdirSync(gameFolder).find((n) => n.toLowerCase() === 'maps');
const MAPS = mp.maps ?? (mapsDir ? fs.readdirSync(path.join(gameFolder, mapsDir)).filter((n) => /^[A-Za-z0-9_.-]+\.bsp$/i.test(n)).map((n) => n.slice(0, -4)).sort() : [mp.map]);

/** @type {Map<number, { index: number, port: number, name: string, map: string, maxPlayers: number, bots: number, permanent: boolean, since: number, child: any, info: any, seen: number, idleSince: number, stopping?: boolean }>} */
const rooms = new Map();
const quote = (s) => String(s).replace(/["\\;]/g, '');
let shuttingDown = false;

/** A room's server started; a created room goes when it stops, room 0 starts again 5 s later. */
function launch(room) {
  room.stopping = false;
  const base = room.permanent ? state : path.join(state, 'rooms', String(room.index));
  fs.mkdirSync(path.join(base, g.gameDir), { recursive: true });
  // (its settings, written at each start: its name; a created room stays on its map)
  fs.writeFileSync(path.join(base, g.gameDir, 'server.cfg'), `hostname "${quote(room.name)}"\nsv_lan 1\nsv_cheats 0\nsv_maxrate 100000\nsv_minrate 10000\nmp_timelimit ${room.permanent ? 30 : 0}\n`);
  if (!room.permanent) fs.writeFileSync(path.join(base, g.gameDir, 'mapcycle.txt'), `${room.map}\n`);
  const botCommands = room.bots ? (mp.rooms?.bots?.commands ?? []).map((c) => c.replaceAll('{n}', String(room.bots))) : [];
  const optionCommands = room.permanent ? [] : roomOptionCommands(mp, room); // (its chosen settings: starting money, the bots' team…)
  const child = room.child = spawn(path.join(release, 'xash'), ['-dedicated', '-noip6', '-rodir', game, '-game', g.gameDir,
    ...(gameLibrary ? ['-dll', gameLibrary] : []), ...(room.bots ? mp.rooms?.bots?.args ?? [] : []), '-port', String(room.port), '+ip', '127.0.0.1', '+maxplayers', String(room.maxPlayers),
    // (goldsrc.multiplayer.commands: the version's settings, before the map starts; then a room's bots)
    ...[...(mp.commands ?? []), ...botCommands, ...optionCommands].flatMap((c) => c.split(' ').map((w, i) => (i ? w : `+${w}`))), '+map', room.map], {
    cwd: base,
    env: { ...process.env, XASH3D_BASEDIR: base, XASH3D_LIBDIR: release, LD_LIBRARY_PATH: release },
    stdio: room.permanent ? 'inherit' : ['ignore', 'ignore', 'inherit'],
  });
  const finish = (why) => {
    if (room.child !== child) return;
    room.child = null; room.seen = 0;
    if (room.permanent && !shuttingDown) {
      console.error(`room 0 stopped (${why}): starting it again in 5 s`);
      relaunch(room);
    } else { rooms.delete(room.index); if (!room.permanent) console.log(`room ${room.index} "${room.name}" closed (${why})`); }
  };
  // (a spawn that failed has no pid: no exit comes)
  child.on('error', (error) => { console.error(`room ${room.index}: ${error.message}`); if (child.pid === undefined) finish(error.message); });
  child.on('exit', (code, signal) => finish(code ?? signal));
}

/** Room 0 started again in 5 s (and again 5 s later while starting it fails). */
function relaunch(room) {
  clearTimeout(room.restart);
  room.restart = setTimeout(() => { if (shuttingDown) return; try { launch(room); } catch (error) { console.error(`room 0: ${error.message}`); relaunch(room); } }, 5000);
}

/** A room's server stopped: SIGTERM, then SIGKILL 10 s later if it is still there. */
function stop(room, why) {
  const child = room.child; if (!child || room.stopping) return;
  room.stopping = true; console.log(`room ${room.index} "${room.name}": ${why}, closing`);
  child.kill('SIGTERM'); setTimeout(() => { if (room.child === child) child.kill('SIGKILL'); }, 10000).unref();
}

// (every 5 s: each server's name, map and players — `info 49`, as the game's LAN search asks it)
const probe = dgram.createSocket('udp4');
probe.on('message', (bytes, from) => {
  const room = [...rooms.values()].find((r) => r.port === from.port), info = room && parseServerInfo(bytes);
  if (!info) return;
  room.info = info; room.seen = Date.now();
  // (the engine counts its human clients only: the bots are the room's own number)
  if (info.players > 0) room.idleSince = 0; else if (!room.idleSince) room.idleSince = Date.now();
});
probe.on('error', (error) => console.error(`probe: ${error.message}`));
probe.bind(0, '127.0.0.1');
const ask = (room) => { if (!shuttingDown) probe.send(Buffer.from('\xff\xff\xff\xffinfo 49', 'latin1'), room.port, '127.0.0.1'); };
const poll = setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.child) continue;
    ask(room);
    // (silent a minute once it had answered: stuck — a created room goes, room 0 starts again)
    if (room.seen && Date.now() - room.seen > 60000) { room.stopping = false; stop(room, 'no answer for a minute'); continue; }
    if (!room.permanent && room.idleSince && Date.now() - room.idleSince > IDLE * 1000) stop(room, `${IDLE} s without players`);
  }
}, 5000);

const view = (r) => ({ index: r.index, port: r.port, name: r.info?.name || r.name, map: r.info?.map ?? r.map, players: (r.info?.players ?? 0) + r.bots,
  humans: r.info?.players ?? 0, maxPlayers: r.maxPlayers, bots: r.bots, options: r.options ?? {}, permanent: r.permanent, since: r.since,
  up: !!r.child && !r.stopping && Date.now() - (r.seen ?? 0) < 15000, closing: !!r.stopping });

/** A new room: the first free index, its server started, answered once it answers its info (20 s at most). */
async function create(request) {
  const checked = roomRequest(request, mp, MAPS);
  if (checked.error) return [400, { error: checked.error }];
  const { room: spec } = checked, by = typeof request?.by === 'string' ? request.by.slice(0, 64) : '';
  if ([...rooms.values()].some((r) => sameRoomName(r.name, spec.name) || (r.info?.name && sameRoomName(r.info.name, spec.name)))) return [409, { error: 'taken' }];
  if (by && [...rooms.values()].some((r) => r.by === by && !r.stopping)) return [409, { error: 'owned' }]; // (a closing one: not anymore)
  let index = 1; while (rooms.has(index) && index <= roomSlots(mp)) index++;
  if (index > roomSlots(mp)) return [503, { error: 'full' }];
  const room = { index, port: roomPort(mp, index), ...spec, by, key: randomBytes(16).toString('hex'), permanent: false, since: Date.now(), child: null, info: null, seen: 0, idleSince: Date.now() };
  rooms.set(index, room);
  try { launch(room); } catch (error) { rooms.delete(index); console.error(`room ${index}: ${error.message}`); return [503, { error: 'start' }]; }
  console.log(`room ${index} "${room.name}" on ${room.map}, ${room.maxPlayers} players, ${room.bots} bots`);
  for (let t = 0; t < 40 && rooms.get(index) === room; t++) { ask(room); await new Promise((r) => setTimeout(r, 500)); if (room.seen) return [201, { room: view(room), key: room.key }]; }
  if (room.child) room.child.kill('SIGKILL'); else rooms.delete(index);
  return [503, { error: 'start' }];
}

const control = http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/rooms' && req.method === 'GET') return send(200, { rooms: [...rooms.values()].map(view).sort((a, b) => a.index - b.index), maps: MAPS, slots: roomSlots(mp), maxPlayers: mp.maxPlayers ?? 16, bots: mp.rooms?.bots ? { max: mp.rooms.bots.max } : null });
  if (req.url === '/rooms' && req.method === 'POST' && mp.rooms) {
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let request; try { request = JSON.parse(body); } catch { return send(400, { error: 'json' }); }
      create(request).then(([status, out]) => send(status, out), (error) => { console.error(`create: ${error.message}`); send(500, { error: 'start' }); });
    });
    return;
  }
  // (a created room closed by its creator: the key its creation answered)
  const del = /^\/rooms\/(\d{1,2})$/.exec(req.url ?? '');
  if (del && req.method === 'DELETE') {
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 512) req.destroy(); });
    req.on('end', () => {
      let key; try { key = JSON.parse(body)?.key; } catch { return send(400, { error: 'json' }); }
      const room = rooms.get(Number(del[1]));
      if (!room) return send(404, { error: 'none' });
      const given = Buffer.from(typeof key === 'string' ? key : ''), own = Buffer.from(room.key ?? '');
      if (room.permanent || !own.length || given.length !== own.length || !timingSafeEqual(given, own)) return send(403, { error: 'forbidden' });
      if (room.child) stop(room, 'closed by its creator'); else rooms.delete(room.index);
      send(200, { closed: room.index });
    });
    return;
  }
  send(404, { error: 'none' });
});
control.listen(mp.port, '127.0.0.1');

const permanent = { index: 0, port: mp.port, name: `Orthros - ${man.name}`, map: mp.map, maxPlayers: mp.maxPlayers ?? 16, bots: 0, permanent: true, since: Date.now(), child: null, info: null, seen: 0, idleSince: 0 };
rooms.set(0, permanent); launch(permanent);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  shuttingDown = true; clearInterval(poll); clearTimeout(permanent.restart); control.close(); probe.close();
  for (const room of rooms.values()) room.child?.kill('SIGTERM');
  const done = setInterval(() => { if (![...rooms.values()].some((r) => r.child)) process.exit(0); }, 200);
  setTimeout(() => { clearInterval(done); for (const room of rooms.values()) room.child?.kill('SIGKILL'); process.exit(0); }, 8000);
});
