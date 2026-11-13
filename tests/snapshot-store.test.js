// Shared snapshots (src/server/snapshot-store.js, server routes /api/snapshot/<manifest>, docs/snapshot.md stage 3): a new
// player's starting point, published by the server's own session (its token), served compressed, stale once the shared
// first-launch profile changed, the older keys pruned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createServer } from '../src/server/server.js';
import { toBase64 } from '../src/shared/profile-seed.js';
import { SnapshotStore } from '../src/server/snapshot-store.js';

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
    const kept = fs.readdirSync(path.join(dir, 'learn', 'snapshots', 'g')).filter((f) => f.endsWith('.json') && !f.endsWith('.brp.json')).sort();
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

test('a later snapshot of the same key posted while the first is still compressed: both kept in turn, the last one stays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapstore-'));
  try {
    const store = new SnapshotStore(dir), src = (n) => { const f = path.join(dir, `up-${n}`); fs.writeFileSync(f, snap(n)); return f; };
    const recs = await Promise.all([store.put('g', 'fr', KEY, src(300000)), store.put('g', 'fr', KEY, src(1000))]);
    assert.deepEqual(recs.map((r) => r.bytes), [300000, 1000]);
    assert.equal(store.meta('g', 'fr', KEY).bytes, 1000);
    assert.equal(zlib.gunzipSync(fs.readFileSync(store.base('g', 'fr', KEY) + '.gz')).length, 1000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** An OPFS directory in memory (the calls snapshot-fetch.js makes). */
const memDir = () => {
  const files = new Map(), dirs = new Map();
  const dir = {
    async getDirectoryHandle(n, o = {}) { if (!dirs.has(n)) { if (!o.create) throw new Error('none'); dirs.set(n, memDir()); } return dirs.get(n); },
    async getFileHandle(n, o = {}) {
      if (!files.has(n)) { if (!o.create) throw new Error('none'); files.set(n, new Blob([])); }
      return { kind: 'file', getFile: async () => files.get(n), createWritable: async () => { const parts = []; return { write: async (b) => { parts.push(typeof b === 'string' ? b : b.slice()); }, close: async () => { files.set(n, new Blob(parts)); } }; } };
    },
    async *entries() { for (const n of [...files.keys()]) yield [n, await dir.getFileHandle(n)]; },
    async *keys() { yield* [...files.keys(), ...dirs.keys()]; },
    async removeEntry(n) { files.delete(n); dirs.delete(n); },
    files,
  };
  return dir;
};

test('a shared snapshot downloaded piece by piece into the store: resumed after a cut, put together whole; the choice against a cold start', async () => {
  const { fetchSharedSnapshot, chooseSnapshot } = await import('../src/web/snapshot-fetch.js');
  const { SNAPSHOT_PIECE: PIECE } = await import('../src/server/snapshot-store.js');
  // (the choice: 92 MB at 85 KB/s against a 57 MB launch set and 120 s of start-up — cold; the same at 1.25 MB/s — the
  // snapshot; 55 MB against 42 MB and 250 s at 85 KB/s — the snapshot)
  assert.equal(chooseSnapshot({ left: 92e6, bytes: 313e6, bw: 85e3, launchWire: 57e6, bootMs: 120e3 }).snapshot, false);
  assert.equal(chooseSnapshot({ left: 92e6, bytes: 313e6, bw: 1.25e6, launchWire: 57e6, bootMs: 120e3 }).snapshot, true);
  assert.equal(chooseSnapshot({ left: 55e6, bytes: 300e6, bw: 85e3, launchWire: 42e6, bootMs: 250e3 }).snapshot, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-snapfetch-'));
  fs.mkdirSync(path.join(dir, 'man')); fs.mkdirSync(path.join(dir, 'learn'));
  fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  const s = createServer({ manifests: path.join(dir, 'man'), learnDir: path.join(dir, 'learn'), learnWriteMs: 10, profileSeedQuorum: 1, snapshotJobs: { want: () => true, job: (t) => (t === 'tok' ? {} : null) } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const u = (p) => `http://127.0.0.1:${s.address().port}${p}`;
  try {
    // (random bytes: they do not compress — three pieces)
    const body = Buffer.concat([snap(16), crypto.randomBytes(2 * PIECE + 12345)]);
    assert.equal((await fetch(u(`/api/snapshot/g?key=${KEY}&lang=en&token=tok&bootMs=90000`), { method: 'POST', body })).status, 204);
    const opfs = memDir(), logs = [];
    // cut after the first answers: the pieces there kept, the rest on the next visit
    let answers = 0;
    const cut = (url, init) => (++answers > 2 ? Promise.reject(new Error('link lost')) : fetch(u(url), init));
    assert.equal(await fetchSharedSnapshot({ name: 'g', key: KEY, lang: 'en', dir: async () => opfs, log: (m) => logs.push(m), fetch: cut }), null);
    const kept = (await opfs.getDirectoryHandle('shared')).files;
    assert.ok(kept.has('info.json') && [...kept.keys()].some((n) => /^\d+$/.test(n)), [...kept.keys()].join());
    const asked = [];
    const ab = await fetchSharedSnapshot({ name: 'g', key: KEY, lang: 'en', dir: async () => opfs, log: (m) => logs.push(m), fetch: (url, init) => { asked.push(url.split('piece=')[1]); return fetch(u(url), init); } });
    assert.ok(ab, logs.join('\n'));
    assert.ok(Buffer.from(ab).equals(body));
    assert.equal(ab.how.chosen, 'snapshot'); assert.ok(ab.how.resumed >= PIECE, logs.join('\n'));
    assert.ok(asked.length < 3, asked.join()); // (what was there not asked again)
    assert.equal((await fetch(u(`/api/snapshot/g?key=${KEY}&lang=en&piece=3`))).status, 416);
    // republished under the same key, larger (4 pieces), while the old one's pieces are all here: the old pieces go, never
    // an answer kept under another piece's index (piece 0 was once written as piece 2 and restored corrupted)
    await new Promise((r) => setTimeout(r, 5)); // (another `at`: the snapshot's id)
    const body2 = Buffer.concat([snap(16), crypto.randomBytes(3 * PIECE + 999)]);
    assert.equal((await fetch(u(`/api/snapshot/g?key=${KEY}&lang=en&token=tok`), { method: 'POST', body: body2 })).status, 204);
    const opfs2 = memDir(), sh2 = await opfs2.getDirectoryHandle('shared', { create: true });
    sh2.files.set('info.json', new Blob([JSON.stringify({ key: KEY, lang: 'en', id: 'older', piece: PIECE, count: 3, bytes: body.length })]));
    for (let i = 0; i < 3; i++) sh2.files.set(String(i), new Blob([body.subarray(i * PIECE, Math.min(body.length, (i + 1) * PIECE))]));
    const ab2 = await fetchSharedSnapshot({ name: 'g', key: KEY, lang: 'en', dir: async () => opfs2, log: (m) => logs.push(m), fetch: (url, init) => fetch(u(url), init) });
    assert.ok(ab2 && Buffer.from(ab2).equals(body2), 'the new snapshot, whole and in order');
    // a store over its quota from the second piece: the download goes on in memory, not lost
    const full = memDir(); let writes = 0;
    const real = full.getDirectoryHandle.bind(full);
    full.getDirectoryHandle = async (n, o) => { const d = await real(n, o), fh = d.getFileHandle.bind(d); d.getFileHandle = async (f, oo) => { const h = await fh(f, oo); if (/^\d+$/.test(f)) { const cw = h.createWritable; h.createWritable = async () => { if (++writes > 1) throw new Error('QuotaExceededError'); return cw(); }; } return h; }; return d; };
    const ab3 = await fetchSharedSnapshot({ name: 'g', key: KEY, lang: 'en', dir: async () => full, log: (m) => logs.push(m), fetch: (url, init) => fetch(u(url), init) });
    assert.ok(ab3 && Buffer.from(ab3).equals(body2), logs.slice(-3).join('\n'));
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
