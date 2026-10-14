// Shared snapshots (src/host/snapshot-store.js, server routes /api/snapshot/<manifest>, docs/snapshot.md stage 3): a new
// player's starting point, published by the server's own session (its token), served compressed, stale once the shared
// first-launch profile changed, the older keys pruned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createServer } from '../src/host/server.js';
import { toBase64 } from '../src/host/profile-seed.js';

const KEY = 'a'.repeat(32), KEY2 = 'b'.repeat(32), KEY3 = 'c'.repeat(32);
const snap = (n) => { const b = Buffer.alloc(n, 7); b.writeUInt32BE(0x4f534e50, 0); return b; };

test('shared snapshots: published by the server\'s session only, served compressed, stale with another first-launch profile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-snapstore-'));
  fs.mkdirSync(path.join(dir, 'man')); fs.mkdirSync(path.join(dir, 'learn'));
  fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  const wanted = [], jobs = { want: (...a) => { wanted.push(a.join('|')); return true; }, job: (t, name, lang, key) => (t === 'tok' && name === 'g' && lang === 'en' && [KEY, KEY2, KEY3].includes(key) ? {} : null) };
  const s = createServer({ manifests: path.join(dir, 'man'), learnDir: path.join(dir, 'learn'), learnWriteMs: 10, profileSeedQuorum: 1, snapshotJobs: jobs });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const u = (p) => `http://127.0.0.1:${s.address().port}${p}`;
  const post = (key, body, token = 'tok') => fetch(u(`/api/snapshot/g?key=${key}&lang=en&token=${token}`), { method: 'POST', body });
  try {
    // none yet: a session queued for it
    assert.equal((await fetch(u(`/api/snapshot/g?key=${KEY}&lang=en`))).status, 404);
    assert.deepEqual(wanted, [`g|en|${KEY}`]);
    assert.equal((await fetch(u('/api/snapshot/g?key=nothex&lang=en'))).status, 404);
    // published: with the job's token only, a snapshot only
    assert.equal((await post(KEY, snap(5000), 'other')).status, 403);
    assert.equal((await post(KEY, Buffer.from('not a snapshot'))).status, 400);
    assert.equal((await post(KEY, snap(300000))).status, 204);
    const r = await fetch(u(`/api/snapshot/g?key=${KEY}&lang=en`));
    assert.equal(r.status, 200); assert.equal(r.headers.get('x-snapshot-bytes'), '300000');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), snap(300000)); // (fetch decoded it)
    const raw = await new Promise((res) => fetch(u(`/api/snapshot/g?key=${KEY}&lang=en`), { headers: { 'Accept-Encoding': 'gzip' } }).then(async (x) => res([x.headers.get('content-encoding'), Number(x.headers.get('content-length'))])));
    assert.equal(raw[0], 'gzip'); assert.ok(raw[1] < 300000 / 10);
    // another shared first-launch profile since: stale (a new session wanted)
    await fetch(u('/api/profile-seed/g'), { method: 'POST', body: JSON.stringify({ lang: 'en', session: 's1', files: [{ path: 'AppData/G/a.ini', data: toBase64(new TextEncoder().encode('x')) }] }) });
    assert.equal((await fetch(u(`/api/snapshot/g?key=${KEY}&lang=en`))).status, 404);
    assert.equal(wanted.length, 2);
    // the two most recent keys kept
    assert.equal((await post(KEY2, snap(1000))).status, 204);
    await new Promise((res) => setTimeout(res, 20));
    assert.equal((await post(KEY3, snap(1000))).status, 204);
    const kept = fs.readdirSync(path.join(dir, 'learn', 'snapshots', 'g')).filter((f) => f.endsWith('.json')).sort();
    assert.deepEqual(kept, [`en-${KEY2}.json`, `en-${KEY3}.json`]);
    assert.ok(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'learn', 'snapshots', 'g', `en-${KEY3}.gz`))).equals(snap(1000)));
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a sandboxed server only queues the publishing sessions (their tokens in a file a runner reads)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-snapqueue-'));
  fs.mkdirSync(path.join(dir, 'man')); fs.mkdirSync(path.join(dir, 'learn'));
  fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  const s = createServer({ manifests: path.join(dir, 'man'), learnDir: path.join(dir, 'learn'), snapshotJobs: 'queue' });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const u = (p) => `http://127.0.0.1:${s.address().port}${p}`;
  try {
    assert.equal((await fetch(u(`/api/snapshot/g?key=${KEY}&lang=fr`))).status, 404);
    assert.equal((await fetch(u(`/api/snapshot/g?key=${KEY}&lang=fr`))).status, 404); // (asked twice: queued once)
    const q = JSON.parse(fs.readFileSync(path.join(dir, 'learn', 'snapshots', 'queue.json'), 'utf8')).jobs;
    assert.equal(q.length, 1); assert.deepEqual([q[0].name, q[0].lang, q[0].key], ['g', 'fr', KEY]); assert.match(q[0].token, /^[0-9a-f]{32}$/);
    const post = (token, key = KEY) => fetch(u(`/api/snapshot/g?key=${key}&lang=fr&token=${token}`), { method: 'POST', body: snap(2000) });
    assert.equal((await post('0'.repeat(32))).status, 403);
    assert.equal((await post(q[0].token, KEY2)).status, 403); // (a token is for its own key)
    assert.equal((await post(q[0].token)).status, 204);
    assert.equal((await fetch(u(`/api/snapshot/g?key=${KEY}&lang=fr`))).status, 200);
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
