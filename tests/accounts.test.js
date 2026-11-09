import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createServer } from '../src/server/server.js';

test('optional account, private cloud backups, versions and conflict protection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-accounts-'));
  // (a game of its own, bfme-vanilla in name only: the test needs no installed game, and runs where none is, as in CI)
  const games = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-accounts-games-'));
  fs.mkdirSync(path.join(games, 'fixture', 'base'), { recursive: true }); fs.mkdirSync(path.join(games, 'fixture', 'versions', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(games, 'fixture', 'base', 'game.exe'), 'MZ');
  fs.writeFileSync(path.join(games, 'fixture', 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'fixture', name: 'Fixture', defaultVersion: 'bfme-vanilla',
    versions: [{ id: 'bfme-vanilla', dir: 'v1', version: '1', exe: 'game.exe' }] }));
  const server = createServer({ accountsDir: dir, gamesDir: games, accountOrigin: 'http://localhost:8080' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (route, method = 'GET', body, cookie) => fetch(base + route, {
    method, body, headers: { Origin: 'http://localhost:8080', ...(cookie ? { Cookie: cookie } : {}),
      ...(body instanceof Uint8Array ? { 'X-Orthros-Parent-Hash': 'none', 'Content-Type': 'application/octet-stream' }
        : body ? { 'Content-Type': 'application/json' } : {}) },
  });
  try {
    assert.deepEqual((await (await request('/api/account')).json()).user, null);
    const registered = await request('/api/account/register', 'POST', JSON.stringify({ username: 'player_one', password: 'long secret password' }));
    assert.equal(registered.status, 200);
    const cookie = registered.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await request('/api/account', 'GET', undefined, cookie)).json()).user.username, 'player_one');
    // (the site under another name — a front proxy's X-Forwarded-Host —: its own pages' changes accepted, another site's refused)
    const viaMirror = (origin, route, body) => fetch(base + route, { method: 'POST', body: JSON.stringify(body),
      headers: { Origin: origin, 'X-Forwarded-Host': 'orthros.mirror.test', 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json' } });
    const mirrored = await viaMirror('https://orthros.mirror.test', '/api/account/register', { username: 'mirror_player', password: 'another long password' });
    assert.equal(mirrored.status, 200);
    assert.match(mirrored.headers.get('set-cookie'), /; Secure/);
    assert.equal((await viaMirror('https://orthros.mirror.test', '/api/account/login', { username: 'mirror_player', password: 'another long password' })).status, 200);
    assert.equal((await viaMirror('https://elsewhere.test', '/api/account/login', { username: 'mirror_player', password: 'another long password' })).status, 403);
    assert.equal((await request('/api/account/login', 'POST', JSON.stringify({ username: 'mirror_player', password: 'another long password' }))).status, 200, 'the configured origin still');
    const backup = gzipSync(JSON.stringify({ format: 'orthros-profile', version: 1, game: 'bfme-vanilla', files: [{ path: 'Saves/a.sav', data: 'YQ==' }] }));
    const first = await request('/api/cloud/bfme-vanilla', 'PUT', backup, cookie);
    assert.equal(first.status, 201);
    const head = await first.json();
    assert.equal(head.version, 1);
    const listed = await (await request('/api/cloud', 'GET', undefined, cookie)).json();
    assert.equal(listed.games[0].game, 'bfme-vanilla');
    assert.deepEqual(Buffer.from(await (await request('/api/cloud/bfme-vanilla', 'GET', undefined, cookie)).arrayBuffer()), backup);
    const conflict = await request('/api/cloud/bfme-vanilla', 'PUT', backup, cookie);
    assert.equal(conflict.status, 409);
    const second = await fetch(base + '/api/cloud/bfme-vanilla', {
      method: 'PUT', body: gzipSync(JSON.stringify({ format: 'orthros-profile', version: 1, game: 'bfme-vanilla', files: [{ path: 'Saves/a.sav', data: 'Yg==' }] })),
      headers: { Origin: 'http://localhost:8080', Cookie: cookie, 'X-Orthros-Parent-Hash': head.hash },
    });
    assert.equal(second.status, 201);
    assert.equal((await (await request('/api/cloud/bfme-vanilla/history', 'GET', undefined, cookie)).json()).versions.length, 2);
    const other = await request('/api/account/register', 'POST', JSON.stringify({ username: 'player_two', password: 'another long secret' }));
    const otherCookie = other.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await request('/api/cloud', 'GET', undefined, otherCookie)).json()).games.length, 0);
    assert.equal((await request('/api/cloud/bfme-vanilla', 'GET', undefined, otherCookie)).status, 404);
    assert.equal((await request('/api/cloud/bfme-vanilla', 'DELETE', undefined, cookie)).status, 200);
    assert.equal((await (await request('/api/cloud', 'GET', undefined, cookie)).json()).games.length, 0);
    assert.equal((await request('/api/account/logout', 'POST', undefined, cookie)).status, 200);
    assert.equal((await (await request('/api/account', 'GET', undefined, cookie)).json()).user, null);
  } finally {
    server.close();
    await once(server, 'close');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(games, { recursive: true, force: true });
  }
});

test('an account over its space loses its oldest versions first, never a game\'s latest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-accounts-quota-'));
  const games = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-accounts-quota-games-'));
  fs.mkdirSync(path.join(games, 'fixture', 'base'), { recursive: true }); fs.mkdirSync(path.join(games, 'fixture', 'versions', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(games, 'fixture', 'base', 'game.exe'), 'MZ');
  fs.writeFileSync(path.join(games, 'fixture', 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'fixture', name: 'Fixture', defaultVersion: 'g1',
    versions: [{ id: 'g1', dir: 'v1', version: '1', exe: 'game.exe' }, { id: 'g2', dir: 'v1', version: '2', exe: 'game.exe' }] }));
  // (each backup below is ~1.1 KB compressed: five of them fit, not six)
  const backup = (game, n) => gzipSync(JSON.stringify({ format: 'orthros-profile', version: 1, game, files: [{ path: 'Saves/a.sav', data: Buffer.from(Array.from({ length: 800 }, (_, i) => (i * 7919 + n * 104729) % 256)).toString('base64') }] }));
  const size = backup('g1', 0).length;
  const server = createServer({ accountsDir: dir, gamesDir: games, accountOrigin: 'http://localhost:8080', accountMaxUserBytes: size * 5 + 10 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (route, method = 'GET', body, cookie, parent = 'none') => fetch(base + route, { method, body,
    headers: { Origin: 'http://localhost:8080', ...(cookie ? { Cookie: cookie } : {}), ...(body instanceof Uint8Array ? { 'X-Orthros-Parent-Hash': parent, 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) } });
  try {
    const registered = await request('/api/account/register', 'POST', JSON.stringify({ username: 'quota_one', password: 'long secret password' }));
    const cookie = registered.headers.get('set-cookie').split(';')[0];
    let parent = 'none', other = 'none';
    other = (await (await request('/api/cloud/g2', 'PUT', backup('g2', 99), cookie, other)).json()).hash;
    for (let n = 1; n <= 7; n++) {
      const r = await request('/api/cloud/g1', 'PUT', backup('g1', n), cookie, parent);
      assert.equal(r.status, 201, `version ${n} accepted`);
      parent = (await r.json()).hash;
    }
    const history = (await (await request('/api/cloud/g1/history', 'GET', undefined, cookie)).json()).versions.map((v) => v.version);
    assert.equal(history[0], 7, 'the latest is kept'); assert.ok(history.length <= 4, `older versions pruned: ${history}`);
    assert.equal((await (await request('/api/cloud', 'GET', undefined, cookie)).json()).games.find((g) => g.game === 'g2').hash, other, 'another game\'s latest untouched');
  } finally { server.close(); }
});

test('a game\'s versions\' account copies merge once into its shared profile, nothing lost, the old keys frozen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-accounts-shared-'));
  const games = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-accounts-shared-games-'));
  fs.mkdirSync(path.join(games, 'fixture', 'base'), { recursive: true }); fs.mkdirSync(path.join(games, 'fixture', 'versions', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(games, 'fixture', 'base', 'game.exe'), 'MZ');
  fs.writeFileSync(path.join(games, 'fixture', 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'fixture', name: 'Fixture', defaultVersion: 'g1',
    versions: [{ id: 'g1', dir: 'v1', version: '1', exe: 'game.exe' }, { id: 'g2', dir: 'v1', version: '2', exe: 'game.exe' }, { id: 'g3', dir: 'v1', version: '3', exe: 'game.exe', ownProfile: true }] }));
  const b64 = (s) => Buffer.from(s).toString('base64');
  const backup = (game, files) => gzipSync(JSON.stringify({ format: 'orthros-profile', version: 1, game, files: files.map(([p, s]) => ({ path: p, data: b64(s) })) }));
  const start = async () => { const s = createServer({ accountsDir: dir, gamesDir: games, accountOrigin: 'http://localhost:8080' }); s.listen(0, '127.0.0.1'); await once(s, 'listening'); return s; };
  let server = await start();
  const request = (route, method = 'GET', body, cookie, parent = 'none') => fetch('http://127.0.0.1:' + server.address().port + route, { method, body,
    headers: { Origin: 'http://localhost:8080', ...(cookie ? { Cookie: cookie } : {}), ...(body instanceof Uint8Array ? { 'X-Orthros-Parent-Hash': parent, 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) } });
  try {
    const cookie = (await request('/api/account/register', 'POST', JSON.stringify({ username: 'shared_one', password: 'long secret password' }))).headers.get('set-cookie').split(';')[0];
    // (each version's copy as an earlier page sent it: a save under the same name, different; settings; a save of its own)
    assert.equal((await request('/api/cloud/g1', 'PUT', backup('g1', [['Saves/a.sav', 'one'], ['opts.ini', 'old'], ['Saves/only1.sav', 'x']]), cookie)).status, 201);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await request('/api/cloud/g2', 'PUT', backup('g2', [['Saves/a.sav', 'two'], ['opts.ini', 'new']]), cookie)).status, 201);
    assert.equal((await request('/api/cloud/g3', 'PUT', backup('g3', [['Saves/a.sav', 'own']]), cookie)).status, 201);
    server.close(); await once(server, 'close');
    for (let run = 0; run < 2; run++) { // (the next starts: the merge once — the second adds nothing)
      server = await start();
      const list = (await (await request('/api/cloud', 'GET', undefined, cookie)).json()).games;
      const shared = list.find((g) => g.game === 'fixture');
      assert.equal(shared.version, 1); assert.deepEqual(shared.merged.sort(), ['g1', 'g2']);
      assert.equal(list.find((g) => g.game === 'g1').migratedTo, 'fixture'); assert.equal(list.find((g) => g.game === 'g3').migratedTo, undefined, 'a version with its own profile untouched');
      if (run === 0) { server.close(); await once(server, 'close'); }
    }
    const doc = JSON.parse(gunzipSync(Buffer.from(await (await request('/api/cloud/fixture', 'GET', undefined, cookie)).arrayBuffer())));
    assert.equal(doc.game, 'fixture');
    assert.deepEqual(Object.fromEntries(doc.files.map((f) => [f.path, Buffer.from(f.data, 'base64').toString()])),
      { 'Saves/a (g1).sav': 'one', 'Saves/a.sav': 'two', 'Saves/only1.sav': 'x', 'opts.ini': 'new' });
    assert.equal((await request('/api/cloud/g1', 'GET', undefined, cookie)).status, 200, 'the old copy readable');
    const gone = await request('/api/cloud/g1', 'PUT', backup('g1', [['Saves/a.sav', 'late']]), cookie);
    assert.equal(gone.status, 410); assert.equal((await gone.json()).profileKey, 'fixture');
    assert.equal((await request('/api/cloud/g3', 'PUT', backup('g3', [['Saves/a.sav', 'own 2']]), cookie)).status, 409, 'its own key still written (its parent checked)');
    // (a version joining the game later — its ownProfile dropped —: its copy merged at the next start, then frozen)
    const spec = JSON.parse(fs.readFileSync(path.join(games, 'fixture', 'manifest.json'), 'utf8')); delete spec.versions[2].ownProfile;
    fs.writeFileSync(path.join(games, 'fixture', 'manifest.json'), JSON.stringify(spec));
    server.close(); await once(server, 'close'); server = await start();
    const after = JSON.parse(gunzipSync(Buffer.from(await (await request('/api/cloud/fixture', 'GET', undefined, cookie)).arrayBuffer())));
    assert.equal(Object.fromEntries(after.files.map((f) => [f.path, Buffer.from(f.data, 'base64').toString()]))['Saves/a (g3).sav'], 'own');
    assert.equal((await request('/api/cloud/g3', 'PUT', backup('g3', [['Saves/a.sav', 'late']]), cookie)).status, 410);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(games, { recursive: true, force: true });
  }
});
