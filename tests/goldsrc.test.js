// GoldSrc browser ports (src/host/goldsrc.js, docs/browser-ports.md): catalog entries without an executable, the
// port's page and engine routes, the multiplayer relay to a localhost UDP server, the rooms players create (the lobby),
// and the linked game tree of the native dedicated server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadGameCatalog } from '../src/host/game-catalog.js';
import { linkGameLayers, parseServerInfo, roomName, roomOptionCommands, roomPort, roomRequest, roomSlots } from '../src/host/goldsrc.js';
import { createServer } from '../src/host/server.js';
import { groupMaps } from '../src/ports/goldsrc/lobby.js';

const ENGINE = 'engine-test-1';
const goldsrc = (over = {}) => ({ engine: ENGINE, gameDir: 'valve', modules: { client: 'mod/client.wasm', server: 'mod/server.wasm' }, solo: { map: 'start' }, ...over });

/** A games folder: one Win32 game, one GoldSrc port (`port` merged into its version entry); an engines folder. */
function fixture(t, port = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-goldsrc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), engines = path.join(root, 'engines');
  const win = path.join(games, 'win');
  fs.mkdirSync(path.join(win, 'base'), { recursive: true }); fs.mkdirSync(path.join(win, 'versions', '1'), { recursive: true });
  fs.writeFileSync(path.join(win, 'base', 'game.exe'), 'MZ');
  fs.writeFileSync(path.join(win, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'win', name: 'Win', defaultVersion: 'win-1', versions: [{ id: 'win-1', dir: '1', version: '1', exe: 'game.exe' }] }));
  const gs = path.join(games, 'gs');
  fs.mkdirSync(path.join(gs, 'base', 'valve', 'maps'), { recursive: true }); fs.mkdirSync(path.join(gs, 'versions', 'orig', 'VALVE'), { recursive: true });
  fs.writeFileSync(path.join(gs, 'base', 'valve', 'maps', 'start.bsp'), 'map');
  fs.writeFileSync(path.join(gs, 'base', 'valve', 'Config.cfg'), 'base');
  fs.writeFileSync(path.join(gs, 'versions', 'orig', 'VALVE', 'config.cfg'), 'version');
  fs.writeFileSync(path.join(gs, 'cover.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(gs, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'gs', name: 'GS', defaultVersion: 'gs-orig',
    defaults: { runtime: 'goldsrc', coverFile: 'cover.svg' }, versions: [{ id: 'gs-orig', dir: 'orig', version: 'Original', goldsrc: goldsrc(), ...port }] }));
  const release = path.join(engines, ENGINE);
  for (const f of ['release.json', 'engine/index.js', 'engine/xash.wasm', 'engine/valve/extras.pk3', 'mod/client.wasm', 'mod/server.wasm', 'mod/bots.pk3']) {
    fs.mkdirSync(path.dirname(path.join(release, f)), { recursive: true }); fs.writeFileSync(path.join(release, f), f);
  }
  fs.writeFileSync(path.join(root, 'secret'), 'never served');
  fs.symlinkSync(path.join(root, 'secret'), path.join(release, 'escape'));
  return { root, games, engines, gs };
}
async function serve(t, opts) {
  const server = createServer({ ...opts, lanLog: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const editManifest = (dir, fn) => { const f = path.join(dir, 'manifest.json'), spec = JSON.parse(fs.readFileSync(f, 'utf8')); fn(spec); fs.writeFileSync(f, JSON.stringify(spec)); };

test('a GoldSrc version needs no executable and is checked by its own rules', (t) => {
  const { games, gs } = fixture(t);
  const man = loadGameCatalog(games).get('gs-orig');
  assert.equal(man.runtime, 'goldsrc'); assert.equal(man.exe, undefined);
  assert.equal(man.saveKey, 'orthros-port:gs:orig'); // (the installation: game and version folders)
  assert.equal(man.coverPath, path.join(gs, 'cover.svg'));
  assert.equal(loadGameCatalog(games).get('win-1').runtime, 'win32');
  // (a language's own arguments, commands and archives)
  editManifest(gs, (spec) => { spec.versions[0].goldsrc.languages = { fr: { args: ['-language', 'french'], commands: ['ars_lang fr'], extras: ['mod/fr.pk3'], overlays: { valve_french: 'valve' } } }; });
  assert.deepEqual(loadGameCatalog(games).get('gs-orig').goldsrc.languages.fr.commands, ['ars_lang fr']);
  for (const [edit, error] of [
    [(v) => { v.goldsrc.modules.client = '../client.wasm'; }, /goldsrc.modules/],
    [(v) => { delete v.goldsrc.solo; }, /solo ou goldsrc.multiplayer/],
    [(v) => { v.goldsrc.multiplayer = { server: 'srv', port: 80, map: 'dm' }; }, /goldsrc.multiplayer/],
    [(v) => { v.goldsrc.multiplayer = { server: 'srv', port: 27999, map: 'dm', gameLibrary: '../cs.so' }; }, /gameLibrary/],
    [(v) => { v.goldsrc.multiplayer = { server: 'srv', port: 27999, map: 'dm', commands: ['mp_startmoney 16000; quit'] }; }, /multiplayer.commands/],
    [(v) => { v.goldsrc.gameDir = 'a/b'; }, /gameDir/],
    [(v) => { v.goldsrc.extras = ['mod/bots.zip']; }, /extras/],
    [(v) => { v.goldsrc.extras = ['mod/bots.pk3', 'other/BOTS.pk3']; }, /extras/],
    [(v) => { v.goldsrc.solo.commands = ['bot_quota 4; quit']; }, /solo.commands/],
    [(v) => { v.goldsrc.languages = { fr: { commands: ['ars_lang fr; quit'] } }; }, /goldsrc.languages/],
    [(v) => { v.goldsrc.languages = { french: { args: ['-language', 'french'] } }; }, /goldsrc.languages/],
    [(v) => { v.goldsrc.languages = { fr: { extras: ['../fr.pk3'] } }; }, /goldsrc.languages/],
    [(v) => { v.goldsrc.languages = { fr: { overlays: { 'valve_french/x': 'valve' } } }; }, /goldsrc.languages/],
    [(v) => { v.goldsrc.languages = { fr: { overlays: { valve: 'VALVE' } } }; }, /goldsrc.languages/],
    [(v) => { v.requires = [{ game: 'win', version: 'win-1', mount: 'C:\\Win' }]; }, /requires invalide/],
    [(v) => { v.runtime = 'dos'; }, /runtime inconnu/],
    [(v) => { v.coverFile = '../cover.svg'; }, /coverFile/],
    [(v) => { v.saveKey = 'other'; }, /saveKey est généré/],
  ]) {
    editManifest(gs, (spec) => { spec.versions[0] = { id: 'gs-orig', dir: 'orig', version: 'Original', goldsrc: goldsrc() }; edit(spec.versions[0]); });
    assert.throws(() => loadGameCatalog(games), error);
  }
});

test('the home lists a port with its runtime, page and modes; its page and engine are served', async (t) => {
  const { games, engines } = fixture(t, { goldsrc: goldsrc({ multiplayer: { server: 'srv', port: 27999, map: 'dm' } }) });
  const base = await serve(t, { gamesDir: games, enginesDir: engines });
  const list = await (await fetch(`${base}/api/manifests`)).json();
  const port = list.find((m) => m.name === 'gs-orig'), win = list.find((m) => m.name === 'win-1');
  assert.deepEqual([port.runtime, port.launchUrl, port.modes, port.exe, port.available, port.cover], ['goldsrc', '/ports/goldsrc/gs-orig/', ['solo', 'multiplayer'], null, true, true]);
  assert.deepEqual([win.runtime, win.launchUrl, win.exe], ['win32', null, 'game.exe']);
  const man = await (await fetch(`${base}/api/manifest/gs-orig`)).json();
  assert.equal(man.launchUrl, '/ports/goldsrc/gs-orig/'); assert.equal(man.coverPath, undefined); assert.equal(man.folder, undefined);
  assert.equal((await (await fetch(`${base}/api/manifest/win-1`)).json()).launchUrl, undefined);
  const page = await fetch(`${base}/ports/goldsrc/gs-orig/`);
  assert.equal(page.status, 200); assert.match(await page.text(), /src\/ports\/goldsrc\/play\.js/);
  assert.equal(page.headers.get('cross-origin-embedder-policy'), 'require-corp');
  for (const p of ['/ports/goldsrc/win-1/', '/ports/win32/win-1/', '/ports/goldsrc/none/']) assert.equal((await fetch(base + p)).status, 404, p);
  const wasm = await fetch(`${base}/engines/${ENGINE}/engine/xash.wasm`);
  assert.equal(wasm.status, 200); assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.match(wasm.headers.get('cache-control'), /immutable/);
  for (const p of [`/engines/${ENGINE}/escape`, `/engines/${ENGINE}/missing.js`, '/engines/unused-1/engine/index.js']) assert.equal((await fetch(base + p)).status, 404, p);
  const cover = await fetch(`${base}/api/cover/gs-orig`);
  assert.equal(cover.headers.get('content-type'), 'image/svg+xml'); assert.match(cover.headers.get('content-security-policy'), /sandbox/);
  // (the version's files over the base's, as for a Windows game)
  assert.equal(await (await fetch(`${base}/game/gs-orig/valve/config.cfg`)).text(), 'version');
});

test('a port whose engine release is missing is listed as unavailable', async (t) => {
  const { games, engines } = fixture(t);
  fs.rmSync(path.join(engines, ENGINE, 'mod', 'server.wasm'));
  const base = await serve(t, { gamesDir: games, enginesDir: engines });
  assert.equal((await (await fetch(`${base}/api/manifests`)).json()).find((m) => m.name === 'gs-orig').available, false);
});

/** A raw WebSocket client (the Origin header set at will): send() binary messages, receive() the next one. */
function wsConnect(url, origin = new URL(url).origin) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: origin, 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64') } });
    req.on('error', reject);
    req.on('response', (res) => { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); });
    req.on('upgrade', (_res, socket, head) => {
      let buf = head; const waiting = [], queued = [];
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          let len = buf[1] & 127, o = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; }
          if (buf.length < o + len) return;
          const msg = Buffer.from(buf.subarray(o, o + len)), op = buf[0] & 15; buf = buf.subarray(o + len);
          if (op !== 2) continue;
          if (waiting.length) waiting.shift()(msg); else queued.push(msg);
        }
      });
      resolve({
        send(payload) {
          const data = Buffer.from(payload), mask = randomBytes(4), head2 = Buffer.alloc(data.length < 126 ? 2 : 4);
          head2[0] = 0x82;
          if (data.length < 126) head2[1] = 0x80 | data.length; else { head2[1] = 0x80 | 126; head2.writeUInt16BE(data.length, 2); }
          for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
          socket.write(Buffer.concat([head2, mask, data]));
        },
        receive: () => (queued.length ? Promise.resolve(queued.shift()) : new Promise((done, fail) => { const tm = setTimeout(() => fail(new Error('timeout')), 3000); waiting.push((m) => { clearTimeout(tm); done(m); }); })),
        close: () => socket.destroy(),
      });
    });
  });
}

test('multiplayer: each player gets its own UDP socket to the version\'s local server, same-origin only', async (t) => {
  const udp = dgram.createSocket('udp4'), senders = new Set();
  await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));
  t.after(() => udp.close());
  udp.on('message', (msg, from) => { senders.add(from.port); udp.send(msg, from.port, from.address); });
  const { games, engines } = fixture(t, { goldsrc: goldsrc({ multiplayer: { server: 'srv', port: udp.address().port, map: 'dm' } }) });
  const base = await serve(t, { gamesDir: games, enginesDir: engines });
  const players = [await wsConnect(`${base}/api/udp/gs-orig`), await wsConnect(`${base}/api/udp/gs-orig`)];
  try {
    const payloads = [Buffer.from([0, 255, 7, 8]), Buffer.alloc(300, 42)];
    await Promise.all(players.map(async (p, i) => { const back = p.receive(); p.send(payloads[i]); assert.deepEqual(await back, payloads[i]); }));
    assert.equal(senders.size, 2);
  } finally { players.forEach((p) => p.close()); } // (before the server closes: it waits for its sockets)
  await assert.rejects(wsConnect(`${base}/api/udp/gs-orig`, 'http://elsewhere.example'), /403/);
  await assert.rejects(wsConnect(`${base}/api/udp/win-1`), /403/);
  await assert.rejects(wsConnect(`${base}/api/udp/none`), /403/);
  // (the virtual LAN of the Windows games shares the upgrade path)
  const lan = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/lan?room=x`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64') } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); }); req.on('response', (res) => resolve(res.statusCode)); req.on('error', reject);
  });
  assert.equal(lan, 101);
});

test('the dedicated server sees the version\'s files over the base\'s as one tree of links', (t) => {
  const { root, games } = fixture(t);
  const dest = path.join(root, 'linked');
  fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, 'stale'), 'old');
  assert.equal(linkGameLayers(loadGameCatalog(games).get('gs-orig'), dest), 2);
  assert.equal(fs.existsSync(path.join(dest, 'stale')), false);
  assert.deepEqual(fs.readdirSync(dest), ['VALVE']); // (the version's name of the folder, as the page sees it)
  assert.equal(fs.readFileSync(path.join(dest, 'VALVE', 'config.cfg'), 'utf8'), 'version');
  assert.equal(fs.readFileSync(path.join(dest, 'VALVE', 'maps', 'start.bsp'), 'utf8'), 'map');
  assert.ok(fs.lstatSync(path.join(dest, 'VALVE', 'maps', 'start.bsp')).isSymbolicLink());
});

test('a port requiring another port has its files beneath its own: in the page\'s tree, the files served and the dedicated server\'s', async (t) => {
  const { root, games, engines } = fixture(t, { goldsrc: goldsrc({ extras: ['engine/valve/extras.pk3', 'mod/bots.pk3'], solo: { map: 'start', commands: ['bot_quota 4'] } }) });
  const mod = path.join(games, 'mod');
  fs.mkdirSync(path.join(mod, 'base', 'valve'), { recursive: true }); fs.mkdirSync(path.join(mod, 'versions', '1'), { recursive: true });
  fs.writeFileSync(path.join(mod, 'base', 'valve', 'config.cfg'), 'mod');
  fs.writeFileSync(path.join(mod, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'mod', name: 'Mod', defaultVersion: 'mod-1',
    defaults: { runtime: 'goldsrc' }, versions: [{ id: 'mod-1', dir: '1', version: '1', goldsrc: goldsrc(), requires: [{ game: 'gs', version: 'gs-orig' }] }] }));
  const catalog = loadGameCatalog(games), man = catalog.get('mod-1');
  assert.equal(man.extraMounts, undefined);
  const base = await serve(t, { gamesDir: games, enginesDir: engines });
  assert.equal(await (await fetch(`${base}/game/mod-1/valve/config.cfg`)).text(), 'mod'); // (its own file first)
  assert.equal(await (await fetch(`${base}/game/mod-1/valve/maps/start.bsp`)).text(), 'map'); // (then the required game's)
  const tree = await (await fetch(`${base}/api/tree/mod-1`)).json();
  assert.ok(JSON.stringify(tree).includes('start.bsp'));
  const info = await (await fetch(`${base}/api/manifest/mod-1`)).json();
  assert.equal(info.underlays, undefined); assert.equal(JSON.stringify(info).includes(root), false);
  const port = (await (await fetch(`${base}/api/manifests`)).json()).find((m) => m.name === 'gs-orig');
  assert.equal(port.available, true);
  fs.rmSync(path.join(engines, ENGINE, 'mod', 'bots.pk3'));
  assert.equal((await (await fetch(`${base}/api/manifests`)).json()).find((m) => m.name === 'gs-orig').available, false);
  const dest = path.join(root, 'linked');
  assert.equal(linkGameLayers(man, dest), 2);
  assert.equal(fs.readFileSync(path.join(dest, 'valve', 'config.cfg'), 'utf8'), 'mod');
  assert.equal(fs.readFileSync(path.join(dest, 'valve', 'maps', 'start.bsp'), 'utf8'), 'map');
  // (only another port, and never itself through a cycle)
  editManifest(mod, (spec) => { spec.versions[0].requires = [{ game: 'win', version: 'win-1' }]; });
  assert.throws(() => loadGameCatalog(games), /pas un portage goldsrc/);
  editManifest(mod, (spec) => { spec.versions[0].requires = [{ game: 'gs', version: 'gs-orig' }]; });
  const gsDir = path.join(games, 'gs');
  editManifest(gsDir, (spec) => { spec.versions[0].requires = [{ game: 'mod', version: 'mod-1' }]; });
  assert.throws(() => loadGameCatalog(games), /circulaire/);
});

// ---------------------------------------------------------------- rooms: the games players create (the lobby)

test('rooms: a version\'s rooms are checked, their ports one version\'s each', (t) => {
  const { games, gs } = fixture(t);
  const mp = (over = {}) => ({ server: 'srv', port: 27999, map: 'dm', ...over });
  for (const [rooms, error] of [
    [{ ports: [28000] }, /rooms.ports/], [{ ports: [28010, 28000] }, /rooms.ports/], [{ ports: [28000, 28010] }, /rooms.ports/], [{ ports: [27999, 28001] }, /rooms.ports/],
    [{ ports: [28000, 28001], bots: { max: 4, commands: ['bot_quota 4'] } }, /rooms.bots/], [{ ports: [28000, 28001], bots: { max: 40, commands: ['bot_quota {n}'] } }, /rooms.bots/],
    [{ ports: [28000, 28001], bots: { max: 4, commands: ['bot_quota {n}'], args: ['--evil;'] } }, /rooms.bots.args/],
  ]) {
    editManifest(gs, (spec) => { spec.versions[0].goldsrc = goldsrc({ multiplayer: mp({ rooms }) }); });
    assert.throws(() => loadGameCatalog(games), error);
  }
  editManifest(gs, (spec) => { spec.versions[0].goldsrc = goldsrc({ multiplayer: mp({ maps: ['ok', 'bad name'] }) }); });
  assert.throws(() => loadGameCatalog(games), /multiplayer.maps/);
  editManifest(gs, (spec) => { spec.versions[0].goldsrc = goldsrc({ multiplayer: mp({ rooms: { ports: [28000, 28003], bots: { max: 6, commands: ['bot_quota {n}'], args: ['-bots'] } } }) }); });
  const m = loadGameCatalog(games).get('gs-orig').goldsrc.multiplayer;
  assert.deepEqual([roomSlots(m), roomPort(m, 0), roomPort(m, 1), roomPort(m, 4)], [4, 27999, 28000, 28003]);
  // (another version whose server takes one of these ports)
  const other = path.join(games, 'gs2'); fs.cpSync(gs, other, { recursive: true });
  editManifest(other, (spec) => { spec.id = 'gs2'; spec.defaultVersion = 'gs2-orig'; spec.versions[0].id = 'gs2-orig'; spec.versions[0].goldsrc = goldsrc({ multiplayer: mp({ port: 28002 }) }); });
  assert.throws(() => loadGameCatalog(games), /port UDP 28002/);
});

test('rooms: a creation request is checked, a server\'s info read', () => {
  const mp = { port: 27999, maxPlayers: 12, rooms: { ports: [28000, 28001], bots: { max: 6, commands: ['bot_quota {n}'] } } };
  assert.equal(roomName('  a "quoted"; \\ name\n with  spaces that goes well past the limit '), 'a quoted name with spaces that g');
  assert.equal(roomName('Ort\u200bhros\u202e - x\u0085'), 'Orthros - x'); // (no control, invisible or bidi character)
  assert.deepEqual(roomRequest({ name: 'Dust', map: 'de_dust2', maxPlayers: 10, bots: 4 }, mp, ['de_dust2']), { room: { name: 'Dust', map: 'de_dust2', maxPlayers: 10, bots: 4, options: {} } });
  for (const [body, error] of [[{ name: 'x', map: 'de_dust2' }, 'name'], [{ name: 'Dust', map: 'nope' }, 'map'], [{ name: 'Dust', map: 'de_dust2', maxPlayers: 20 }, 'maxPlayers'],
    [{ name: 'Dust', map: 'de_dust2', maxPlayers: 4, bots: 4 }, 'bots'], [{ name: 'Dust', map: 'de_dust2', bots: 7 }, 'bots']]) assert.equal(roomRequest(body, mp, ['de_dust2']).error, error);
  assert.equal(roomRequest({ name: 'Dust', map: 'de_dust2', bots: 1 }, { ...mp, rooms: { ports: [28000, 28001] } }, ['de_dust2']).error, 'bots'); // (no bots: none)
  assert.deepEqual(parseServerInfo(Buffer.from('\xff\xff\xff\xffinfo\n\\p\\49\\map\\de_nuke\\numcl\\3\\maxcl\\12\\host\\Bots test', 'latin1')), { name: 'Bots test', map: 'de_nuke', players: 3, max: 12 });
  assert.equal(parseServerInfo(Buffer.from('\xff\xff\xff\xffinfo\nwrong version\n', 'latin1')), null);
});

test('rooms: a created room is closed with its key, from the page\'s origin only', async (t) => {
  const seen = [];
  const manager = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => { seen.push([req.method, req.url, body]); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"closed":2}'); });
  });
  await new Promise((resolve) => manager.listen(0, '127.0.0.1', resolve)); t.after(() => manager.close());
  const port = manager.address().port;
  const { games, engines } = fixture(t, { goldsrc: goldsrc({ multiplayer: { server: 'srv', port, map: 'dm', rooms: { ports: [port + 1, port + 2] } } }) });
  const base = await serve(t, { gamesDir: games, enginesDir: engines });
  const key = 'ab'.repeat(16);
  const del = (headers, body) => fetch(`${base}/api/rooms/gs-orig/2`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await del({}, { key })).status, 403); // (no Origin)
  assert.equal((await del({ Origin: 'http://elsewhere.example' }, { key })).status, 403);
  assert.equal((await del({ Origin: base }, { key: 'not-a-key' })).status, 403);
  assert.equal(seen.length, 0);
  const res = await del({ Origin: base }, { key });
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { closed: 2 });
  assert.deepEqual(seen, [['DELETE', '/rooms/2', JSON.stringify({ key })]]);
  assert.equal((await fetch(`${base}/api/rooms/gs-orig/2`)).status, 405);
});

test('rooms: the page\'s relay tags each packet with its room, a broadcast reaches every room', async (t) => {
  const echo = async (tag) => {
    const udp = dgram.createSocket('udp4'); await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve)); t.after(() => udp.close());
    udp.on('message', (msg, from) => udp.send(Buffer.concat([Buffer.from([tag]), msg]), from.port, from.address));
    return udp.address().port;
  };
  const [a, b] = [await echo(0xa0), await echo(0xb1)];
  const { games, engines } = fixture(t, { goldsrc: goldsrc({ multiplayer: { server: 'srv', port: a, map: 'dm', rooms: { ports: [b, b] } } }) });
  const base = await serve(t, { gamesDir: games, enginesDir: engines });
  const ws = await wsConnect(`${base}/api/udp/gs-orig?rooms`);
  try {
    let back = ws.receive(); ws.send([1, 9, 9]); assert.deepEqual([...await back], [1, 0xb1, 9, 9]);
    back = ws.receive(); ws.send([0, 7]); assert.deepEqual([...await back], [0, 0xa0, 7]);
    ws.send([5, 1, 2]); // (no such room: dropped)
    ws.send([255, 3]);
    const both = [await ws.receive(), await ws.receive()].map((m) => [...m]).sort((x, y) => x[0] - y[0]);
    assert.deepEqual(both, [[0, 0xa0, 3], [1, 0xb1, 3]]);
  } finally { ws.close(); }
});

test('rooms: listed and created through the server manager, from the page\'s origin, no delay between one\'s creations', async (t) => {
  const calls = [];
  const roomsRequest = async (port, method, body) => { calls.push([port, method, body]); return method === 'GET' ? [200, { rooms: [{ index: 0, name: 'Orthros - GS', humans: 1 }], maps: ['dm'] }] : [201, { room: { index: 1, ...body } }]; };
  const { games, engines } = fixture(t, { goldsrc: goldsrc({ multiplayer: { server: 'srv', port: 27999, map: 'dm', rooms: { ports: [28000, 28001] } } }) });
  const base = await serve(t, { gamesDir: games, enginesDir: engines, roomsRequest });
  const list = await (await fetch(`${base}/api/rooms/gs-orig`)).json();
  assert.equal(list.rooms[0].name, 'Orthros - GS'); assert.equal(list.creatable, true); assert.deepEqual(calls[0], [27999, 'GET', null]);
  const post = (body, origin = base) => fetch(`${base}/api/rooms/gs-orig`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await post({ name: 'Mine', map: 'dm' }, 'http://elsewhere.example')).status, 403);
  assert.equal((await post({ name: 'M', map: 'dm' })).status, 400);
  const made = await post({ name: 'Mine', map: 'dm', maxPlayers: 8 });
  assert.equal(made.status, 201); assert.equal((await made.json()).room.name, 'Mine');
  assert.equal((await post({ name: 'Again', map: 'dm' })).status, 201); // (one live room each: the manager's to refuse)
  assert.equal(calls.at(-1)[2].by, '127.0.0.1'); // (the creator's address: one live room each, the manager's to keep)
  assert.equal((await fetch(`${base}/api/rooms/win-1`)).status, 404);
  assert.equal((await (await fetch(`${base}/api/rooms/gs-orig`, { method: 'PUT' })).json()).error, 'method');
});

test('rooms: creations sent together from one address: one passes, the others wait', async (t) => {
  let pending = 0;
  const roomsRequest = async (port, method, body) => { pending++; await new Promise((r) => setTimeout(r, 50)); return [201, { room: { index: pending, ...body } }]; };
  const { games, engines } = fixture(t, { goldsrc: goldsrc({ multiplayer: { server: 'srv', port: 27999, map: 'dm', rooms: { ports: [28000, 28007] } } }) });
  const base = await serve(t, { gamesDir: games, enginesDir: engines, roomsRequest });
  const post = (name) => fetch(`${base}/api/rooms/gs-orig`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name, map: 'dm' }) });
  const statuses = (await Promise.all(['One', 'Two', 'Three', 'Four'].map(post))).map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 429, 429, 429]);
});

test('rooms: options a player chooses, each choice its commands; a map picture from the game folder', async (t) => {
  const options = [
    { id: 'team', label: { en: 'Bots\' team', fr: 'Équipe des bots' }, bots: true, default: 'any', choices: [{ id: 'any', label: 'Both', commands: ['bot_join_team any'] }, { id: 't', label: 'T', commands: ['bot_join_team T'] }] },
    { id: 'money', label: 'Money', default: '800', show: true, choices: [{ id: '800', label: '800 $', commands: ['mp_startmoney 800'] }, { id: '16000', label: '16000 $', commands: ['mp_startmoney 16000'] }] },
  ];
  const mp = { port: 27999, maxPlayers: 12, rooms: { ports: [28000, 28001], bots: { max: 6, commands: ['bot_quota {n}'] }, options } };
  const asked = roomRequest({ name: 'Rich', map: 'dm', bots: 2, options: { money: '16000' } }, mp, ['dm']);
  assert.deepEqual(asked.room.options, { team: 'any', money: '16000' });
  assert.deepEqual(roomOptionCommands(mp, asked.room), ['bot_join_team any', 'mp_startmoney 16000']);
  assert.deepEqual(roomOptionCommands(mp, { ...asked.room, bots: 0 }), ['mp_startmoney 16000']); // (the bots' option without bots: none)
  assert.equal(roomRequest({ name: 'Rich', map: 'dm', options: { money: '1000000' } }, mp, ['dm']).error, 'options');
  const { games, engines, gs } = fixture(t, { goldsrc: goldsrc({ multiplayer: { server: 'srv', port: 27999, map: 'dm', mapImage: 'overviews/{map}.bmp', rooms: { ports: [28000, 28001], options } } }) });
  fs.mkdirSync(path.join(gs, 'base', 'valve', 'Overviews'), { recursive: true }); fs.writeFileSync(path.join(gs, 'base', 'valve', 'Overviews', 'DM.bmp'), Buffer.alloc(5000, 7));
  const base = await serve(t, { gamesDir: games, enginesDir: engines, roomsRequest: async () => [200, { rooms: [], maps: ['dm'] }] });
  const picture = await fetch(`${base}/api/map-image/gs-orig/dm`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(picture.status, 200); assert.equal(picture.headers.get('content-type'), 'image/bmp');
  assert.equal((await picture.arrayBuffer()).byteLength, 5000); // (sent compressed, read whole)
  for (const bad of ['nope', '..%2Fsecret', 'a%20b']) assert.equal((await fetch(`${base}/api/map-image/gs-orig/${bad}`)).status, 404);
  const listed = await (await fetch(`${base}/api/rooms/gs-orig`)).json();
  assert.deepEqual(listed.mapGroups, []); // (no map groups in the manifest: none, the page shows its maps ungrouped)
  assert.equal(listed.mapImages, true); assert.deepEqual(listed.options.map((o) => [o.id, o.choices.length, o.choices[0].commands]), [['team', 2, undefined], ['money', 2, undefined]]); // (no commands sent out)
  editManifest(gs, (spec) => { spec.versions[0].goldsrc.multiplayer.rooms.options[0].default = 'none'; });
  assert.throws(() => loadGameCatalog(games), /rooms.options/);
  editManifest(gs, (spec) => { spec.versions[0].goldsrc.multiplayer.rooms.options[0].default = 'any'; spec.versions[0].goldsrc.multiplayer.rooms.options[1].id = 5; });
  assert.throws(() => loadGameCatalog(games), /rooms.options/); // (an id is a string)
  editManifest(gs, (spec) => { spec.versions[0].goldsrc.multiplayer.rooms.options[1].id = 'money'; });
  editManifest(gs, (spec) => { spec.versions[0].goldsrc.multiplayer.rooms.options[0].default = 'any'; spec.versions[0].goldsrc.multiplayer.mapImage = '../{map}.bmp'; });
  assert.throws(() => loadGameCatalog(games), /mapImage/);
});

test('rooms: the maps by group (multiplayer.mapGroups), from the manifest to the page', async (t) => {
  const mapGroups = [
    { id: 'defusal', label: { en: 'Bomb defusal', fr: 'Désamorçage' }, short: 'Bomb', icon: '💣', prefix: 'de_', description: { en: 'Plant or defuse.' } },
    { id: 'hostage', label: 'Hostage rescue', prefix: ['cs_', 'hr_'], maps: ['de_hostage'] },
  ];
  // (a map named by a group goes there first, else to the first group with its prefix, any case; the others last, by name)
  assert.deepEqual(groupMaps(['de_b', 'cs_a', 'De_A', 'de_hostage', 'hr_x', 'fy_2', 'fy_10'], mapGroups).map((s) => [s.group?.id ?? null, s.maps]),
    [['defusal', ['De_A', 'de_b']], ['hostage', ['cs_a', 'de_hostage', 'hr_x']], [null, ['fy_2', 'fy_10']]]);
  assert.deepEqual(groupMaps(['b', 'a']).map((s) => [s.group, s.maps]), [[null, ['a', 'b']]]); // (no groups: one section)
  assert.deepEqual(groupMaps(['de_x'], mapGroups).map((s) => s.group.id), ['defusal']); // (empty groups dropped)
  const { games, engines, gs } = fixture(t, { goldsrc: goldsrc({ multiplayer: { server: 'srv', port: 27999, map: 'dm', mapGroups, rooms: { ports: [28000, 28001] } } }) });
  const base = await serve(t, { gamesDir: games, enginesDir: engines, roomsRequest: async () => [200, { rooms: [], maps: ['de_b'] }] });
  assert.deepEqual((await (await fetch(`${base}/api/rooms/gs-orig`)).json()).mapGroups, mapGroups);
  const offline = await serve(t, { gamesDir: games, enginesDir: engines, roomsRequest: async () => { throw new Error('down'); } });
  const down = await (await fetch(`${offline}/api/rooms/gs-orig`)).json();
  assert.equal(down.offline, true); assert.deepEqual(down.mapGroups, mapGroups); // (the room manager unreachable: the groups still sent)
  for (const bad of [[], [{ id: 'x', label: 'X' }], [{ id: 'x', label: 'X', prefix: 'de_' }, { id: 'x', label: 'Y', prefix: 'cs_' }], [{ id: 'x', label: 'X', prefix: 'a b' }],
    [{ id: 'x', label: 'X', maps: ['../m'] }], [{ id: 'x', label: 'X', prefix: 'de_', short: 'far too long for a badge' }], [{ id: 'x', label: 'X', prefix: 'de_', icon: '\n' }],
    [{ id: 5, label: 'X', prefix: 'de_' }], [{ id: ['a'], label: 'X', prefix: 'de_' }], [{ id: 'x', label: 'X', prefix: 'de_', maps: Array(501).fill('m') }]]) {
    editManifest(gs, (spec) => { spec.versions[0].goldsrc.multiplayer.mapGroups = bad; });
    assert.throws(() => loadGameCatalog(games), /mapGroups/, JSON.stringify(bad));
  }
});
