// Review: the learned prefetch pass must terminate when the store keeps nothing (a full in-memory store drops new
// blocks silently), instead of downloading the same entry again and again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend } from '../src/vfs/http-backend.js';

const MiB = 1 << 20;
const SIZE = 4 * MiB;
const byteAt = (i) => (i * 31 + (i >> 9)) & 0xff;
const bytes = (a, b) => Uint8Array.from({ length: b - a }, (_, k) => byteAt(a + k));
const tree = () => ({ dirs: {}, files: { 'f.big': { size: SIZE, mtime: 1 } } });

test('learned prefetch: a store that refuses every block does not make the pass loop forever', async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls++;
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return { status: 206, arrayBuffer: async () => bytes(+a, +b + 1).buffer };
  };
  try {
    const full = { map: new Map(), failed: false, put() {}, get: () => null, flush() {} }; // (full: drops every put)
    const b = new HttpBackend('/game/r/', tree(), { store: full });
    b.fillBackground = () => {};
    const progress = {};
    let stopped = false;
    const pf = b.prefetch([['f.big', 0], ['f.big', 2], ['f.big', 3]], progress, () => stopped);
    for (let i = 0; i < 50 && !progress.done; i++) await new Promise((r) => setTimeout(r, 10));
    stopped = true; await pf;
    assert.ok(progress.done, 'the pass ends');
    assert.equal(calls, 2, 'each entry downloaded once (2 and 3 in one request)');
  } finally { globalThis.fetch = real; }
});
