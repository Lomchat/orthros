// After the learned prefetch, an archive the game keeps reading at random (blocks missed in WHOLE_AFTER_MISSES distinct
// places) is wanted whole: its other blocks queued for the background fill — not before the prefetch is over, not
// without a block store, not for a media file nor a stream. Fake synchronous XHR (the game's reads), fill not run.
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

test('a file missed in 3 distinct blocks after the learned prefetch: wanted whole, once', async () => {
  globalThis.fetch = () => new Promise(() => {});
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
  } finally { globalThis.fetch = realFetch; }
});
