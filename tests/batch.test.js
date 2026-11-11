// Batched requests (docs/slow-network.md "Batched requests"): the learned order's small pieces of many files go in one
// POST /gamezb request, compressed together, and arrive byte for byte; a missing file sends its run alone, the others
// still come.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpBackend, CHUNK } from '../src/vfs/http-backend.js';
import { NetLink } from '../src/vfs/net-link.js';
import { MemBlockStore } from '../src/vfs/opfs-store.js';
import { createServer } from '../src/server/server.js';

const text = (n, seed) => { const out = Buffer.alloc(n); let s = seed; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; out[i] = 97 + ((s >>> 16) % 20); } return out; };

test('batch: the learned order\'s small pieces in one request, byte for byte; a file gone goes alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-batch-'));
  const files = {}, tree = { dirs: {}, files: {} };
  for (let i = 0; i < 12; i++) { const b = text(3000 + i * 5000, 7 + (i % 3)); files[`f${i}.ini`] = b; fs.writeFileSync(path.join(dir, `f${i}.ini`), b); tree.files[`f${i}.ini`] = { size: b.length, mtime: 1 }; }
  const big = text(3 * CHUNK + 10, 3); fs.writeFileSync(path.join(dir, 'big.dat'), big); tree.files['big.dat'] = { size: big.length, mtime: 1 };
  fs.mkdirSync(path.join(dir, 'man')); fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  const server = createServer({ manifests: path.join(dir, 'man') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const netstats = async () => (await fetch(`${base}/api/netstats`)).json();
  try {
    const store = new MemBlockStore();
    const b = new HttpBackend(`${base}/game/g/`, tree, { encoded: true, batch: true, store, net: new NetLink({ bw: 1.25e6, fixed: true }) });
    // (a learned list: every file's first block, the big file's second piece only)
    const list = [...Object.keys(files).map((p) => [p, 0, 1]), ['big.dat', 0, 2]];
    const progress = {};
    await b.prefetch(list, progress, () => false, { learnedOnly: true });
    const s = await netstats();
    assert.ok(s.batches >= 1 && s.requests <= 3, `few requests: ${s.requests}, ${s.batches} batches`);
    assert.equal(s.batchItems, 13);
    assert.ok(s.sent < s.raw / 3, `compressed together: ${s.sent} of ${s.raw}`);
    for (const [p, bytes] of Object.entries(files)) assert.deepEqual(Buffer.from(b.open(p).read(0, bytes.length)), bytes, p);
    assert.deepEqual(Buffer.from(b.open('big.dat').read(CHUNK, CHUNK)), big.subarray(CHUNK, 2 * CHUNK));
    assert.equal((await netstats()).requests, s.requests, 'all of it from the batch');
    // a file gone since the listing: its run alone (not found), the others still come
    const tree2 = { dirs: {}, files: { ...tree.files, 'gone.ini': { size: 100, mtime: 1 } } };
    const b2 = new HttpBackend(`${base}/game/g/`, tree2, { encoded: true, batch: true, net: new NetLink({ bw: 1.25e6, fixed: true }) });
    const B = b2.batch({ prio: [5, 0], stop: () => false, reason: 'pf1' });
    const got = [B.add('gone.ini', 100, 1, 0, 0), B.add('f1.ini', files['f1.ini'].length, 1, 0, 0)];
    B.send();
    const [r0, r1] = await Promise.all(got);
    assert.equal(r0, undefined, 'the missing file: an answer to skip');
    assert.equal(r1, true);
    assert.deepEqual(Buffer.from(b2.cache.get('f1.ini#0') ?? b2.chunks.get('f1.ini#0')), files['f1.ini']);
    assert.equal(b2.batchOff, false, 'batches still on');
    // a file shorter on disk than in the client's tree (the game updated since): the server refuses the batch — it once
    // cut a.ini's range to the file and b.ini's first bytes were taken as a.ini's end —, the runs go alone, a.ini's answer
    // skipped, b.ini's bytes exact
    const a = text(3000, 11), bb = text(4000, 13);
    fs.writeFileSync(path.join(dir, 'a.ini'), a); fs.writeFileSync(path.join(dir, 'b.ini'), bb);
    const r416 = await fetch(`${base}/gamezb/g?p=1`, { method: 'POST', body: JSON.stringify([['a.ini', 0, 5000], ['b.ini', 0, 4000]]) });
    assert.equal(r416.status, 416, 'a range past the file\'s end refused');
    const tree3 = { dirs: {}, files: { 'a.ini': { size: 5000, mtime: 1 }, 'b.ini': { size: 4000, mtime: 1 } } };
    const b3 = new HttpBackend(`${base}/game/g/`, tree3, { encoded: true, batch: true, net: new NetLink({ bw: 1.25e6, fixed: true }) });
    const B3 = b3.batch({ prio: [5, 0], stop: () => false, reason: 'pf1' });
    const got3 = [B3.add('a.ini', 5000, 1, 0, 0), B3.add('b.ini', 4000, 1, 0, 0)];
    B3.send();
    const [ra, rb] = await Promise.all(got3);
    assert.equal(ra, undefined, 'a.ini: no bytes taken');
    assert.equal(b3.cache.get('a.ini#0') ?? b3.chunks.get('a.ini#0'), undefined);
    assert.equal(rb, true);
    assert.deepEqual(Buffer.from(b3.cache.get('b.ini#0') ?? b3.chunks.get('b.ini#0')), bb);
  } finally { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); fs.rmSync(dir, { recursive: true, force: true }); }
});
