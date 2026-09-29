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
  const server = createServer({ accountsDir: dir, accountOrigin: 'http://localhost:8080' });
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
  }
});
