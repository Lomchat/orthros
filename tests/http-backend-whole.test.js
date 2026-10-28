// After the learned prefetch, an archive the game keeps reading at random (blocks missed in WHOLE_AFTER_MISSES distinct
// places) is wanted whole: its other blocks queued for the background fill — not before the prefetch is over, not
// without a block store, not for a media file nor a stream; the files wanted whole filled in order (laterNext: the one
// the game waited on latest, else the latest wanted). Fake synchronous XHR (the game's reads), fill not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend } from '../src/vfs/http-backend.js';

const MiB = 1 << 20, SIZE = 8 * MiB;
const byteAt = (i) => (i * 29 + (i >> 10)) & 0xff;
const bytes = (a, b) => Uint8Array.from({ length: b - a }, (_, k) => byteAt(a + k));
globalThis.XMLHttpRequest = class {
  open(m, url) { this.url = url; }
  setRequestHeader(k, v) { this.range = v; }
  send() { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range); this.status = 206; this.response = bytes(+a, +b + 1).buffer; }
};
// (fetch exists, never answers: the block downloads a miss starts stay in flight)
const realFetch = globalThis.fetch;
const memStore = () => { const map = new Map(); return { map, failed: false, has: (k) => map.has(k), put: (k, v) => { if (!map.has(k)) map.set(k, v.slice()); }, get: (k) => map.get(k)?.slice() ?? null, flush() {} }; };
function backend({ done = true, store = true, media = false } = {}) {
  const b = new HttpBackend('/game/w/', { dirs: {}, files: { 'f.big': { size: SIZE, mtime: 1, ...(media ? { media: true } : {}) } } }, store ? { store: memStore() } : {});
  b.fillBackground = () => {}; // (what is queued, not its download)
  b.learnedDone = done;
  return b;
}
const wanted = (b) => [...b.later.values()].map((w) => w.index).sort((x, y) => x - y);

test('a file missed in 3 distinct blocks after the learned prefetch: wanted whole, once (when turned on)', async () => {
  globalThis.fetch = () => new Promise(() => {});
  globalThis.ORTHROS_WHOLE_AFTER_MISSES = 1;
  try {
    const b = backend(), f = b.open('f.big');
    f.read(2 * MiB + 100, 10); f.read(5 * MiB + 100, 10); f.read(5 * MiB + 9000, 10);
    assert.deepEqual(wanted(b), [], 'two distinct blocks: not yet');
    f.read(7 * MiB + 100, 10);
    const w = wanted(b);
    assert.ok(w.length >= 5 && w.every((i) => i >= 0 && i < 8), `the rest of the file wanted: ${w}`);
    assert.equal(b.missedAfter.get('f.big'), true);
    assert.equal(b.stats.wholeAfterMisses, 1);
    b.later.clear(); f.read(0, 10); f.read(3 * MiB, 10);
    assert.deepEqual(wanted(b), [], 'asked once');
    for (const [o, why] of [[{ done: false }, 'the learned prefetch still running'], [{ store: false }, 'no block store'], [{ media: true }, 'a media file']]) {
      const c = backend(o), g = c.open('f.big');
      for (const blk of [1, 3, 4, 6]) g.read(blk * MiB + 100, 10);
      assert.deepEqual(wanted(c), [], why);
    }
  } finally { globalThis.fetch = realFetch; delete globalThis.ORTHROS_WHOLE_AFTER_MISSES; }
});

test('by default a file missed after the learned prefetch is not wanted whole (the download doubled for little)', async () => {
  globalThis.fetch = () => new Promise(() => {});
  try {
    const b = backend(), f = b.open('f.big');
    for (const at of [2, 5, 7, 9]) f.read(at * MiB + 100, 10);
    assert.deepEqual(wanted(b), []);
  } finally { globalThis.fetch = realFetch; }
});

test('files wanted whole fill file by file: the one the game waited on latest first, else the latest wanted; blocks in order', async () => {
  globalThis.fetch = () => new Promise(() => {});
  try {
    const tree = { dirs: {}, files: { 'sfx.raw': { size: 4 * MiB, mtime: 1 }, 'gta3.img': { size: 3 * MiB, mtime: 1 }, 'other.dat': { size: 2 * MiB, mtime: 1 } } };
    const b = new HttpBackend('/game/w/', tree, { store: memStore() });
    b.fillBackground = () => {};
    const next = () => { const [, w] = b.laterNext(); return `${w.path}#${w.index}`; };
    // (a bank wanted whole at the engine's start, an archive at the new game's: the archive first, from its block 0)
    b.wantWhole('sfx.raw'); b.wantWhole('gta3.img');
    assert.equal(next(), 'gta3.img#0', 'the latest file wanted whole, its first block');
    b.later.delete('gta3.img#0'); assert.equal(next(), 'gta3.img#1', 'its blocks in order');
    // (an ask of a sample the game goes on past — not held: a skipped sample, readable() — is no wait)
    // (its fetch never answers: the read stays parked)
    b.open('sfx.raw').prepare(2 * MiB + 100, 100);
    assert.equal(next(), 'gta3.img#1', 'a read the game did not wait for does not reorder');
    // (the game waits on the bank — a held read of a sample —, then on the archive)
    b.open('sfx.raw').prepare(3 * MiB + 100, 100, true);
    assert.equal(next(), 'sfx.raw#0', 'the file the game waited on goes first, from its first block still missing');
    b.open('gta3.img').read(2 * MiB + 100, 10); // (a synchronous read: fetchRange)
    assert.equal(next(), 'gta3.img#1', 'the game\'s latest wait: the archive');
    // (a file the game waited on, wanted whole after: first — its wait the latest)
    b.open('other.dat').read(100, 10); b.wantWhole('other.dat');
    assert.equal(next(), 'other.dat#0', 'waited on before it was wanted whole: first');
    for (const k of [...b.later.keys()]) if (k.startsWith('other.dat') || k.startsWith('gta3.img')) b.later.delete(k);
    assert.equal(next(), 'sfx.raw#0', 'the archive whole: the bank');
  } finally { globalThis.fetch = realFetch; }
});

test('a read the game went on past never outranks one it was blocked on (the fill keeps to the archive)', async () => {
  globalThis.fetch = () => new Promise(() => {});
  try {
    const tree = { dirs: {}, files: { 'sfx.raw': { size: 4 * MiB, mtime: 1 }, 'gta3.img': { size: 3 * MiB, mtime: 1 } } };
    const b = new HttpBackend('/game/w/', tree, { store: memStore() });
    b.fillBackground = () => {};
    const next = () => { const [, w] = b.laterNext(); return w.path; };
    b.wantWhole('gta3.img'); b.wantWhole('sfx.raw');
    // (the archive's held read, then many unheld sample asks and a background fetch of the bank: still the archive)
    b.open('gta3.img').prepare(MiB + 10, 10, true);
    for (let i = 0; i < 5; i++) b.open('sfx.raw').prepare(i * 300 * 1024 + 7, 100);
    b.fetchAhead('sfx.raw', 4 * MiB, 1, 3 * MiB + 100, 3 * MiB + 200, false);
    assert.equal(next(), 'gta3.img');
  } finally { globalThis.fetch = realFetch; }
});
