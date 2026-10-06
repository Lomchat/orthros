// The OPFS block store's index log (format 3): records appended at sync points (every 2 s or 256 blocks, or forced),
// replayed at open up to the last complete undamaged record; a v2 JSON index migrated once. Synchronous access handles
// are faked in memory (counting their writes and flushes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpfsBlockStore, SYNC_BLOCKS, SYNC_MS, blockHash } from '../src/vfs/opfs-store.js';

class FakeHandle {
  constructor() { this.b = new Uint8Array(0); this.writes = 0; this.flushes = 0; this.truncates = 0; }
  getSize() { return this.b.length; }
  read(out, { at }) { const n = Math.max(0, Math.min(out.length, this.b.length - at)); out.set(this.b.subarray(at, at + n)); return n; }
  write(src, { at }) { this.writes++; if (at + src.length > this.b.length) { const nb = new Uint8Array(at + src.length); nb.set(this.b); this.b = nb; } this.b.set(src, at); return src.length; }
  truncate(n) { this.truncates++; const nb = new Uint8Array(n); nb.set(this.b.subarray(0, Math.min(n, this.b.length))); this.b = nb; }
  flush() { this.flushes++; } close() {}
}

/** a fake OPFS (one directory) around `fn(files)` */
async function withFakeOpfs(fn) {
  const files = new Map();
  const dir = {
    getFileHandle: async (name, o) => { if (!o?.create && !files.has(name)) throw new Error('NotFoundError'); return { createSyncAccessHandle: async () => { if (!files.has(name)) files.set(name, new FakeHandle()); return files.get(name); } }; },
    removeEntry: async (name) => { if (!files.delete(name)) throw new Error('NotFoundError'); },
  };
  const realNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) } }, configurable: true });
  try { await fn(files); } finally { if (realNav) Object.defineProperty(globalThis, 'navigator', realNav); else delete globalThis.navigator; }
}

const block = (i, n = 1000 + i) => Uint8Array.from({ length: n }, (_, k) => (k * 31 + i * 7) & 0xff);
const key = (i) => `Data/file é ${i}.big#123456#0#${i}`; // (a non-ASCII key: UTF-8 bytes in the record)

test('block store: put / sync / reopen roundtrip, drops replayed, a key stored again after its drop', async () => {
  await withFakeOpfs(async (files) => {
    let s = await OpfsBlockStore.open('x');
    assert.equal(s.resetReason, null);
    for (let i = 0; i < 10; i++) s.put(key(i), block(i));
    s.drop(key(3));
    s.close();
    s = await OpfsBlockStore.open('x');
    assert.equal(s.resetReason, null);
    assert.equal(s.indexCut, 0);
    assert.equal(s.map.size, 9);
    for (let i = 0; i < 10; i++) assert.deepEqual(s.get(key(i)), i === 3 ? null : block(i));
    s.put(key(3), block(3)); s.close();
    s = await OpfsBlockStore.open('x');
    assert.deepEqual(s.get(key(3)), block(3), 'stored again at the end of the data file');
    assert.equal(s.map.get(key(3))[0] > s.map.get(key(9))[0], true);
    assert.equal(files.has('index.json'), false);
  });
});

test('block store: a truncated tail record is cut; the blocks before it stay', async () => {
  await withFakeOpfs(async (files) => {
    let s = await OpfsBlockStore.open('x');
    for (let i = 0; i < 4; i++) s.put(key(i), block(i));
    s.close();
    const idx = files.get('index.bin'), full = idx.getSize();
    idx.b = idx.b.slice(0, full - 7); // (the last record's write lost its end)
    s = await OpfsBlockStore.open('x');
    assert.equal(s.map.size, 3);
    assert.ok(s.indexCut > 0);
    assert.deepEqual(s.get(key(2)), block(2));
    assert.equal(s.get(key(3)), null, 'not indexed: fetched again');
    // the log was cut at the last complete record: later appends are readable
    s.put(key(3), block(3)); s.close();
    s = await OpfsBlockStore.open('x');
    assert.equal(s.indexCut, 0);
    assert.equal(s.map.size, 4);
    assert.deepEqual(s.get(key(3)), block(3));
  });
});

test('block store: a damaged record ends the log there (its block and the later ones fetched again)', async () => {
  await withFakeOpfs(async (files) => {
    let s = await OpfsBlockStore.open('x');
    for (let i = 0; i < 3; i++) s.put(key(i), block(i));
    s.flush(true);
    const mid = files.get('index.bin').getSize();
    for (let i = 3; i < 6; i++) s.put(key(i), block(i));
    s.close();
    files.get('index.bin').b[mid + 6] ^= 1; // (the 4th record's offset)
    s = await OpfsBlockStore.open('x');
    assert.deepEqual([...s.map.keys()], [key(0), key(1), key(2)]);
    assert.equal(s.get(key(3)), null);
    assert.equal(files.get('index.bin').getSize(), mid);
  });
});

test('block store: a record pointing past the data file is dropped; a damaged block is dropped durably', async () => {
  await withFakeOpfs(async (files) => {
    let s = await OpfsBlockStore.open('x');
    for (let i = 0; i < 3; i++) s.put(key(i), block(i));
    s.close();
    const d = files.get('blocks.bin');
    d.b = d.b.slice(0, d.getSize() - 10); // (the data file's tail lost)
    s = await OpfsBlockStore.open('x');
    assert.equal(s.map.size, 2);
    d.b[5] ^= 0xff; // (the first block damaged on disk)
    const bad = []; s.onCorrupt = (k) => bad.push(k);
    assert.equal(s.get(key(0)), null);
    assert.deepEqual(bad, [key(0)]);
    s.close();
    s = await OpfsBlockStore.open('x');
    assert.deepEqual([...s.map.keys()], [key(1)], 'the drop was recorded');
  });
});

test('block store: a v2 JSON index is read once and rewritten as a log; v1 and unreadable indexes empty the store', async () => {
  await withFakeOpfs(async (files) => {
    // a store written by the earlier format
    const data = new FakeHandle(), blocks = [block(0), block(1, 4096)];
    const entries = []; let off = 0;
    for (let i = 0; i < 2; i++) { data.write(blocks[i], { at: off }); entries.push([key(i), off, blocks[i].length, blockHash(blocks[i])]); off += blocks[i].length; }
    entries.push([key(2), off, 100, 0]); // (past the end of the data file)
    const json = new FakeHandle(); json.write(new TextEncoder().encode(JSON.stringify({ v: 2, entries })), { at: 0 });
    files.set('blocks.bin', data); files.set('index.json', json);
    let s = await OpfsBlockStore.open('x');
    assert.equal(s.resetReason, null);
    assert.equal(s.migrated, true);
    assert.equal(files.has('index.json'), false, 'the JSON index removed');
    assert.deepEqual(s.get(key(0)), blocks[0]);
    assert.deepEqual(s.get(key(1)), blocks[1]);
    assert.equal(s.map.size, 2);
    s.put(key(5), block(5)); s.close();
    s = await OpfsBlockStore.open('x');
    assert.equal(s.migrated, false);
    assert.equal(s.map.size, 3);
    assert.deepEqual(s.get(key(5)), block(5));
    // v1 (no checksums)
    files.delete('index.bin'); files.set('index.json', new FakeHandle()); files.get('index.json').write(new TextEncoder().encode(JSON.stringify([[key(0), 0, 1000]])), { at: 0 });
    s = await OpfsBlockStore.open('x');
    assert.equal(s.resetReason, 'an earlier format without block checksums');
    assert.equal(s.map.size, 0);
    assert.equal(files.get('blocks.bin').getSize(), 0);
    // a log whose header is not this format's
    s.put(key(1), block(1)); s.close();
    files.get('index.bin').b[0] ^= 1;
    s = await OpfsBlockStore.open('x');
    assert.equal(s.resetReason, 'unreadable index');
    assert.equal(s.map.size, 0);
    s.put(key(1), block(1)); s.close();
    s = await OpfsBlockStore.open('x');
    assert.deepEqual(s.get(key(1)), block(1), 'usable again after the reset');
  });
});

test('block store: index sync cadence — every 256 blocks or 2 s, at once when forced; nothing written in between', async () => {
  await withFakeOpfs(async (files) => {
    const s = await OpfsBlockStore.open('x');
    const idx = files.get('index.bin'), data = files.get('blocks.bin');
    const w0 = idx.writes, f0 = idx.flushes, small = new Uint8Array(16);
    for (let i = 0; i < SYNC_BLOCKS - 1; i++) { s.put(key(i), small); s.flush(); }
    assert.equal(idx.writes, w0, 'no index write before the cadence');
    assert.equal(idx.flushes, f0);
    assert.equal(data.flushes, 0);
    assert.equal(s.stats.flushes ?? 0, 0);
    s.put(key(SYNC_BLOCKS - 1), small);
    assert.equal(s.stats.flushes, 1, 'synced at 256 blocks');
    assert.equal(idx.writes, w0 + 1, 'one append');
    assert.equal(idx.flushes, f0 + 1);
    assert.equal(data.flushes, 0, 'the data file is not flushed at a sync point (checksums catch a lost block)');
    assert.equal(idx.truncates, 1, 'no rewrite (the one truncate is the new log at open)');
    // time-based: the next put syncs once SYNC_MS passed
    s.put(key(1000), small);
    assert.equal(s.stats.flushes, 1);
    s.lastSync -= SYNC_MS;
    s.flush();
    assert.equal(s.stats.flushes, 2);
    // forced (prefetch end, close): at once; with nothing waiting: nothing
    s.put(key(1001), small);
    s.flush(true);
    assert.equal(s.stats.flushes, 3);
    s.flush(true);
    assert.equal(s.stats.flushes, 3);
    assert.equal(s.dirty, 0);
    assert.equal(data.flushes, 0);
    s.close();
    assert.equal(data.flushes, 1, 'the data file flushed at close');
    const again = await OpfsBlockStore.open('x');
    assert.equal(again.map.size, SYNC_BLOCKS + 2);
  });
});

test('block store: a record dropped at open (past the data file) does not come back once later blocks fill that range', async () => {
  await withFakeOpfs(async (files) => {
    let s = await OpfsBlockStore.open('x');
    for (let i = 0; i < 3; i++) s.put(key(i), block(i));
    s.close();
    const d = files.get('blocks.bin');
    d.b = d.b.slice(0, d.getSize() - 10); // (a crash lost the data file's tail; the index record of key 2 survived)
    s = await OpfsBlockStore.open('x');
    assert.equal(s.map.has(key(2)), false);
    s.put(key(7), block(7, 3000)); // (appended where key 2's bytes were: its old record now lies inside the file)
    s.close();
    s = await OpfsBlockStore.open('x');
    const bad = []; s.onCorrupt = (k) => bad.push(k);
    assert.equal(s.map.has(key(2)), false, 'the stale record stays dropped');
    assert.equal(s.get(key(2)), null);
    assert.deepEqual(bad, []);
    assert.deepEqual(s.get(key(7)), block(7, 3000));
    assert.equal(s.map.size, 3);
  });
});
