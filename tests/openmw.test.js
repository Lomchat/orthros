import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { loadGameCatalog } from '../src/host/game-catalog.js';
import { createServer } from '../src/host/server.js';
import { openmwProblem, openmwWebText } from '../src/host/openmw.js';

function fixture(t, options = { example: true, files: [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-openmw-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const games = path.join(root, 'games'), engines = path.join(root, 'engines'), game = path.join(games, 'sample');
  fs.mkdirSync(path.join(game, 'base'), { recursive: true }); fs.mkdirSync(path.join(game, 'versions/1'), { recursive: true });
  const spec = { schemaVersion: 1, id: 'sample', name: 'Sample', defaultVersion: 'sample-1', defaults: { runtime: 'openmw' },
    versions: [{ id: 'sample-1', dir: '1', version: '1', openmw: { engine: 'test-engine', ...options } }] };
  const file = path.join(game, 'manifest.json'); fs.writeFileSync(file, JSON.stringify(spec));
  const release = path.join(engines, 'test-engine'); fs.mkdirSync(path.join(release, 'e/abc'), { recursive: true });
  for (const f of ['index.html', 'launcher.html']) fs.writeFileSync(path.join(release, f), `<script>fetch('/auth/profile');FS.readFile('/mwdata/file')</script>`);
  fs.writeFileSync(path.join(release, 'e/abc/openmw.wasm'), 'wasm-test');
  fs.writeFileSync(path.join(release, 'release.json'), JSON.stringify({ runtime: 'openmw', files: ['e/abc/openmw.wasm'] }));
  fs.mkdirSync(path.join(release, 'portal'));
  fs.writeFileSync(path.join(release, 'portal/play.html'), '<script src="/admin/static/play.js"></script>');
  return { root, games, engines, game, spec, file };
}
async function listen(t, server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('OpenMW manifests validate paths, examples, mod status and localhost ports', () => {
  assert.equal(openmwProblem({ engine: 'v1', files: [], example: true }), null);
  for (const o of [{ engine: '../x', files: [] }, { engine: 'v1', files: [] }, { engine: 'v1', files: ['../x'] },
    { engine: 'v1', files: ['x'], multiplayer: { port: 0 } }, { engine: 'v1', files: [], example: true, multiplayer: { port: 28100 } },
    { engine: 'v1', files: ['x'], mods: [{ id: 'mod', name: 'Mod', installed: 'yes' }] }]) assert.ok(openmwProblem(o), JSON.stringify(o));
});

test('OpenMW appears in the catalog, serves only browser assets, and refuses missing data/mods', async (t) => {
  const f = fixture(t), server = createServer({ gamesDir: f.games, enginesDir: f.engines });
  const base = await listen(t, server);
  const entries = async () => (await (await fetch(base + '/api/manifests')).json())[0];
  assert.deepEqual([(await entries()).runtime, (await entries()).available, (await entries()).modes], ['openmw', true, ['solo']]);
  const man = loadGameCatalog(f.games).get('sample-1'); assert.equal(man.saveKey, 'orthros-port:sample:1');
  const page = await fetch(base + '/ports/openmw/sample-1/'); assert.equal(page.status, 200); assert.match(await page.text(), /src\/ports\/openmw\/play.js/);
  const engine = await fetch(base + '/ports/openmw/sample-1/app/index.html');
  assert.equal(engine.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.match(await engine.text(), /fetch\('\/ports\/openmw\/sample-1\/app\/auth\/profile'\)/);
  const wasm = await fetch(base + '/ports/openmw/sample-1/app/e/abc/openmw.wasm', { headers: { Range: 'bytes=0-3' } });
  assert.equal(wasm.status, 206); assert.equal(wasm.headers.get('content-type'), 'application/wasm'); assert.equal(await wasm.text(), 'wasm');
  for (const rel of ['server.py', 'release.json', 'admin', 'admin/api/settings', 'e/abc/secret']) assert.equal((await fetch(base + '/ports/openmw/sample-1/app/' + rel)).status, 404, rel);
  f.spec.versions[0].openmw = { engine: 'test-engine', files: ['Game.esm', 'Game.bsa'], mods: [{ id: 'fix', name: 'Fix', installed: false }] };
  fs.writeFileSync(f.file, JSON.stringify(f.spec)); assert.equal((await entries()).available, false);
  fs.writeFileSync(path.join(f.game, 'base/Game.esm'), 'master'); fs.writeFileSync(path.join(f.game, 'base/Game.bsa'), 'archive');
  assert.equal((await entries()).available, false, 'pending mods are not advertised as installed');
  f.spec.versions[0].openmw.mods[0].installed = true; fs.writeFileSync(f.file, JSON.stringify(f.spec)); assert.equal((await entries()).available, false, 'a receipt without data roots is insufficient');
  f.spec.versions[0].openmw.mods[0].parts = [{ dir: 'mods/fix-0', sentinel: 'asset.dds', plugins: [], archives: [] }];
  fs.writeFileSync(f.file, JSON.stringify(f.spec)); assert.equal((await entries()).available, false, 'a missing mod sentinel is insufficient');
  fs.mkdirSync(path.join(f.game, 'versions/1/mods/fix-0'), { recursive: true }); fs.writeFileSync(path.join(f.game, 'versions/1/mods/fix-0/asset.dds'), 'asset');
  assert.equal((await entries()).available, true);
  fs.rmSync(path.join(f.engines, 'test-engine/e/abc/openmw.wasm')); assert.equal((await entries()).available, false);
});

test('the web adaptation namespaces HTTP paths and saves without changing guest paths', () => {
  const text = `fetch('/auth/profile');const ws='/ws';location.href='/join';location.replace('/');const door=location.pathname === '/join';FS.readFile('/mwdata/a');FS.mount(IDBFS, {}, '/userdata');sessionStorage.getItem('omwmp:bootfrag');`;
  const result = openmwWebText(text, '/ports/openmw/a/app', 'orthros-port:a:1');
  assert.match(result, /fetch\('\/ports\/openmw\/a\/app\/auth\/profile'\)/);
  assert.match(result, /location.replace\('\/ports\/openmw\/a\/app\/'\)/);
  assert.match(result, /FS.readFile\('\/mwdata\/a'\)/);
  assert.match(result, /orthrosGetDB.call\(IDBFS, name === '\/userdata' \? "orthros-port:a:1"/);
  assert.match(result, /orthros-port:a:1:mp:bootfrag/);
});

test('the engine page loads the build from the release, brotli when taken, and keeps the streamed game files', async (t) => {
  const f = fixture(t), release = path.join(f.engines, 'test-engine');
  fs.writeFileSync(path.join(release, 'index.html'), `<head></head><script>var __ENGINE_DIR = (__ENGINE_VER.charAt(0) === "_") ? "" : ("e/" + __ENGINE_VER + "/");`
    + `var Module = { setStatus: (t)=>{ if(t){ append(t); } } };StreamFS.mount('/mwdata/' + f.p, 'mwdata/' + encodeURI(f.p) + '?v=2', f.s);</script>`);
  const wasm = 'wasm-test'.repeat(1000);
  fs.writeFileSync(path.join(release, 'e/abc/openmw.wasm'), wasm);
  fs.writeFileSync(path.join(release, 'e/abc/openmw.wasm.br'), (await import('node:zlib')).brotliCompressSync(wasm));
  const base = await listen(t, createServer({ gamesDir: f.games, enginesDir: f.engines }));
  const page = await (await fetch(base + '/ports/openmw/sample-1/app/index.html')).text();
  assert.match(page, /\("\/engines\/test-engine\/e\/" \+ __ENGINE_VER \+ "\/"\)/, 'one URL for every installation');
  assert.match(page, /'mwdata\/' \+ encodeURI\(f\.p\), f\.s\)/, 'no query: the engine keeps the pieces it streamed');
  assert.match(page, /setStatus: \(t\)=>\{ window\.orthrosStatus\?\.\(t\); if\(t\)\{/);
  assert.match(page, /src\/ports\/openmw\/stream-meter\.js/);
  for (const url of ['/engines/test-engine/e/abc/openmw.wasm', '/ports/openmw/sample-1/app/e/abc/openmw.wasm']) {
    const raw = (opts) => new Promise((resolve) => http.get(base + url, opts, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve({ r, body: Buffer.concat(c) })); }));
    const br = await raw({ headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } });
    assert.equal(br.r.headers['content-encoding'], 'br', url); assert.equal(br.r.headers['content-length'], undefined, 'the loader counts the decoded size');
    assert.equal((await import('node:zlib')).brotliDecompressSync(br.body).toString(), wasm);
    assert.match(br.r.headers['cache-control'], /immutable/); assert.equal(br.r.headers.vary, 'Accept-Encoding');
    const plain = await raw({ headers: { 'accept-encoding': 'gzip' } });
    assert.equal(plain.r.headers['content-encoding'], undefined); assert.equal(plain.body.toString(), wasm);
    const part = await raw({ headers: { 'accept-encoding': 'br', range: 'bytes=0-3' } });
    assert.equal(part.r.statusCode, 206); assert.equal(part.r.headers['content-encoding'], undefined); assert.equal(part.body.toString(), 'wasm');
  }
});

test('world travel scopes destinations received through the engine protocol before rebooting', async () => {
  const base = '/ports/openmw/sample-1/app';
  const code = openmwWebText('async function rebootIntoWorld(wsUrl){ return wsUrl; }', base, 'save');
  const context = { URL, location: new URL('https://games.example' + base + '/index.html') };
  runInNewContext(code, context);
  const travel = (url) => context.rebootIntoWorld(url);
  assert.equal(await travel('wss://games.example/w/friend-1'), 'wss://games.example' + base + '/w/friend-1');
  assert.equal(await travel('wss://games.example' + base + '/w/home'), 'wss://games.example' + base + '/w/home');
  assert.equal(await travel('wss://elsewhere.example/w/friend-1'), 'wss://elsewhere.example/w/friend-1');
  assert.equal(await travel('https://games.example/w/friend-1'), 'https://games.example/w/friend-1');
  assert.equal(await travel('wss://games.example:8443/w/friend-1'), 'wss://games.example:8443/w/friend-1');
  context.location = new URL('http://localhost:8080' + base + '/index.html');
  assert.equal(await travel('ws://localhost:8080/w/local'), 'ws://localhost:8080' + base + '/w/local');
});

test('native engine storage and adapted HTML share an installation-specific resume token', () => {
  class Storage {
    constructor() { this.items = new Map(); }
    getItem(key) { return this.items.get(key) ?? null; }
    setItem(key, value) { this.items.set(key, String(value)); }
    removeItem(key) { this.items.delete(key); }
  }
  const html = '<script>async function rebootIntoWorld(wsUrl){ return wsUrl; }</script>';
  const adapted = openmwWebText(html, '/ports/openmw/a/app', 'save-a');
  runInNewContext(adapted.match(/<script>([\s\S]*?)<\/script>/)[1], { Storage, URL });
  const session = new Storage(), local = new Storage();
  session.setItem('omwmp:resume', 'native-token');
  assert.equal(session.getItem('save-a:mp:resume'), 'native-token');
  assert.equal(session.getItem('save-b:mp:resume'), null);
  assert.equal(session.items.has('omwmp:resume'), false);
  session.removeItem('save-a:mp:resume');
  assert.equal(session.getItem('omwmp:resume'), null, 'fresh HTML ticket clears the native token');
  local.setItem('omwmp:resume', 'old-local-token'); local.removeItem('save-a:mp:resume');
  assert.equal(local.getItem('omwmp:resume'), null, 'legacy token cleanup shares the namespace');
  session.setItem('unrelated', 'kept'); assert.equal(session.getItem('unrelated'), 'kept');
});

test('gateway HTTP proxy preserves streamed bytes, scopes world paths and cookies, and hides administration', async (t) => {
  let seen;
  const backend = http.createServer((req, res) => {
    seen = { path: req.url, headers: req.headers };
    if (req.url === '/worlds') { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=value; Path=/; HttpOnly' }); res.end(JSON.stringify({ wsPath: '/w/test', name: '/w/keep-user-text' })); }
    else if (req.url === '/mwdata/archive.bsa') { res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': 'bytes 1-3/5' }); res.end(Buffer.from([0, 255, 2])); }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<script src="/admin/static/play.js"></script>'); }
  });
  await listen(t, backend);
  const f = fixture(t, { files: ['Game.esm'], multiplayer: { port: backend.address().port } });
  const base = await listen(t, createServer({ gamesDir: f.games, enginesDir: f.engines }));
  const prefix = base + '/ports/openmw/sample-1/app';
  const r = await fetch(prefix + '/worlds', { headers: { 'cf-connecting-ip': 'forged', 'x-omw-client-ip': 'forged' } });
  assert.deepEqual(await r.json(), { wsPath: '/ports/openmw/sample-1/app/w/test', name: '/w/keep-user-text' });
  assert.match(r.headers.get('set-cookie'), /Path=\/ports\/openmw\/sample-1\/app\//);
  assert.equal(seen.headers['cf-connecting-ip'], undefined); assert.equal(seen.headers['x-omw-client-ip'], undefined);
  const binary = await fetch(prefix + '/mwdata/archive.bsa', { headers: { Range: 'bytes=1-3' } });
  assert.equal(binary.status, 206); assert.equal(seen.headers.range, 'bytes=1-3'); assert.deepEqual(Buffer.from(await binary.arrayBuffer()), Buffer.from([0, 255, 2]));
  assert.match(await (await fetch(prefix + '/')).text(), /src="\/ports\/openmw\/sample-1\/app\/admin\/static\/play.js"/);
  const old = seen; const state = await (await fetch(prefix + '/admin/api/state')).json(); assert.equal(state.setup.deploymentMode, 'multiplayer'); assert.equal(seen, old);
  for (const rel of ['/admin', '/admin/api/settings', '/healthz', '/metrics']) assert.equal((await fetch(prefix + rel)).status, 404);
});

test('the WebSocket bridge forwards the world handshake and rejects a different origin', async (t) => {
  let upgrades = 0;
  const peers = new Set(), backend = http.createServer();
  backend.on('upgrade', (req, socket) => {
    upgrades++; peers.add(socket); socket.on('close', () => peers.delete(socket));
    assert.equal(req.url, '/w/test');
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  t.after(() => { for (const s of peers) s.destroy(); }); await listen(t, backend);
  const f = fixture(t, { files: ['Game.esm'], multiplayer: { port: backend.address().port } });
  const base = await listen(t, createServer({ gamesDir: f.games, enginesDir: f.engines }));
  const dial = (origin) => new Promise((resolve) => {
    const req = http.get(base + '/ports/openmw/sample-1/app/w/test', { headers: { Origin: origin, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('upgrade', (r, socket) => { socket.destroy(); resolve(r.statusCode); }); req.on('error', () => resolve(0));
  });
  assert.equal(await dial(base), 101); assert.equal(upgrades, 1);
  assert.equal(await dial('https://elsewhere.invalid'), 0); assert.equal(upgrades, 1);
});

test('Orthros sessions provision isolated players, protect tokens, scope caches and revoke port access', async (t) => {
  const players = new Map(), lockers = new Map(); let adminCreates = 0;
  const backend = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/auth/password') {
      if (players.get(body.name)?.password !== body.password) return send(401, {});
      const locker = 'locker-' + Math.random(); lockers.set(locker, body.name);
      return send(200, { ticket: 'ticket-' + Math.random(), locker, account: body.name });
    }
    if (req.url === '/admin/api/login') return send(200, { token: 'owner' });
    if (req.url === '/admin/api/logout') return send(200, {});
    if (req.url === '/admin/api/accounts/create') {
      assert.equal(body.role, ''); assert.equal(req.headers.authorization, 'Bearer owner'); adminCreates++;
      players.set(body.name, { password: body.password }); return send(200, {});
    }
    if (req.url === '/auth/profile') {
      const name = lockers.get(req.headers.authorization?.slice(7));
      if (!name) return send(401, {});
      if (req.method === 'POST') players.get(name).username = body.username;
      return send(200, { needsProfile: !players.get(name).username, username: players.get(name).username });
    }
    return send(200, {});
  });
  await listen(t, backend);
  const f = fixture(t, { files: ['Game.esm'], multiplayer: { port: backend.address().port } });
  const accounts = path.join(f.root, 'accounts'); fs.mkdirSync(accounts);
  fs.writeFileSync(path.join(accounts, 'openmw.json'), JSON.stringify({ secret: 'test-only-secret-must-be-at-least-32-characters', operators: { 'sample-1': { name: 'owner', password: 'private' } } }));
  fs.writeFileSync(path.join(f.engines, 'test-engine/index.html'), "<head></head><script>FS.mount(IDBFS, {}, '/userdata');</script>");
  const base = await listen(t, createServer({ gamesDir: f.games, enginesDir: f.engines, accountsDir: accounts }));
  async function request(route, method = 'GET', cookie, body) {
    return fetch(base + route, { method, headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  const launch = '/api/openmw/sample-1/launch', prefix = '/ports/openmw/sample-1/app';
  assert.equal((await request(launch, 'POST')).status, 401);
  const register = async (username) => {
    const r = await request('/api/account/register', 'POST', null, { username, password: 'orthros-only-password' });
    assert.match(r.headers.get('set-cookie'), /Path=\/;/);
    return r.headers.get('set-cookie').split(';')[0];
  };
  const a = await register('player.one'), b = await register('player_two');
  const l1 = await (await request(launch, 'POST', a)).json();
  const l2 = await (await request(launch, 'POST', b)).json();
  const again = await (await request(launch, 'POST', a)).json();
  assert.notEqual(l1.account, l2.account); assert.equal(again.account, l1.account); assert.notEqual(again.ticket, l1.ticket);
  assert.equal(adminCreates, 2); assert.ok([...players.values()].every((p) => p.password !== 'orthros-only-password' && p.username));
  assert.equal((await fetch(base + launch, { method: 'POST', headers: { Origin: 'https://evil.invalid', Cookie: a } })).status, 403);
  assert.equal((await request(prefix + '/auth/password', 'POST', a)).status, 403);
  assert.equal((await request(prefix + '/worlds')).status, 401);
  assert.equal((await request(prefix + '/worlds', 'GET', a)).status, 200);
  const bearer = (cookie, token) => fetch(base + prefix + '/auth/profile', { headers: { Cookie: cookie, Authorization: 'Bearer ' + token } });
  assert.equal((await bearer(a, l1.locker)).status, 200);
  assert.equal((await bearer(b, l1.locker)).status, 403);
  const pageA = await request(prefix + '/index.html', 'GET', a), pageB = await request(prefix + '/index.html', 'GET', b);
  const htmlA = await pageA.text(), htmlB = await pageB.text();
  assert.match(htmlA, /orthrosCloudInstall/); assert.notEqual(htmlA, htmlB);
  assert.match(pageA.headers.get('cache-control'), /private, no-store/);
  assert.match(htmlA, /cloud.js/);
  assert.equal((await fetch(base + '/api/cloud/sample-1', { headers: { Cookie: a, 'X-Orthros-Player-Scope': 'other-account' } })).status, 401);
  await request('/api/account/logout', 'POST', a);
  assert.equal((await request(launch, 'POST', a)).status, 401);
  assert.equal((await request(prefix + '/worlds', 'GET', a)).status, 401);
});

test('localized OpenMW profiles share a launcher language choice with distinct save and server targets', async (t) => {
  const f = fixture(t, { files: [], example: true });
  const original = f.spec.versions[0]; original.languages = ['en'];
  original.openmw.languageVersions = { en: 'sample-1', fr: 'sample-fr' };
  const french = structuredClone(original); french.id = 'sample-fr'; french.dir = 'fr'; french.languages = ['fr']; french.hidden = true;
  f.spec.versions.push(french); fs.mkdirSync(path.join(f.game, 'versions/fr')); fs.writeFileSync(f.file, JSON.stringify(f.spec));
  const base = await listen(t, createServer({ gamesDir: f.games, enginesDir: f.engines }));
  const man = await (await fetch(base + '/api/manifest/sample-1')).json();
  assert.deepEqual(man.languages, ['en', 'fr']); assert.deepEqual(man.contentLanguages, ['en']);
  assert.equal(man.languageLaunchUrls.fr, '/ports/openmw/sample-fr/');
  const fr = await (await fetch(base + '/api/manifest/sample-fr')).json();
  assert.notEqual(man.saveKey, fr.saveKey); assert.deepEqual(fr.contentLanguages, ['fr']);
  const catalog = await (await fetch(base + '/api/manifests')).json();
  assert.deepEqual(catalog.find((e) => e.name === 'sample-1').languages, ['en', 'fr']);
  assert.equal(catalog.find((e) => e.name === 'sample-fr').hidden, true);
  assert.ok(openmwProblem({ engine: 'test', files: [], example: true, languageVersions: { fr: '../outside' } }));
});
