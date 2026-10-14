// GoldSrc browser ports (src/host/goldsrc.js, docs/browser-ports.md): catalog entries without an executable, the
// port's page and engine routes, the multiplayer relay to a localhost UDP server, and the linked game tree of the
// native dedicated server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadGameCatalog } from '../src/host/game-catalog.js';
import { linkGameLayers } from '../src/host/goldsrc.js';
import { createServer } from '../src/host/server.js';

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
  for (const f of ['release.json', 'engine/index.js', 'engine/xash.wasm', 'mod/client.wasm', 'mod/server.wasm']) {
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
  for (const [edit, error] of [
    [(v) => { v.goldsrc.modules.client = '../client.wasm'; }, /goldsrc.modules/],
    [(v) => { delete v.goldsrc.solo; }, /solo ou goldsrc.multiplayer/],
    [(v) => { v.goldsrc.multiplayer = { server: 'srv', port: 80, map: 'dm' }; }, /goldsrc.multiplayer/],
    [(v) => { v.goldsrc.multiplayer = { server: 'srv', port: 27999, map: 'dm', gameLibrary: '../cs.so' }; }, /gameLibrary/],
    [(v) => { v.goldsrc.gameDir = 'a/b'; }, /gameDir/],
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
