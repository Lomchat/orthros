import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createServer } from '../src/host/server.js';

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
