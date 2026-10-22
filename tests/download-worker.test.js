// "Prepare" (src/host/web/download-worker.js): a browser port's engine files come side by side (a release of 17 small
// files was a round trip each), each once, their wire bytes counted once whatever their order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemBlockStore } from '../src/vfs/opfs-store.js';

test('prepare: the engine files side by side (at most 4), each once, the bytes counted once', async () => {
  const real = globalThis.fetch, realSelf = globalThis.self;
  const posts = []; globalThis.self = { postMessage: (m) => posts.push(m) };
  let now = 0, most = 0; const asked = [];
  const urls = Array.from({ length: 9 }, (_, i) => `/engines/r/e${i}.wasm`);
  globalThis.fetch = async (url, o = {}) => {
    if (o.cache === 'only-if-cached') throw new TypeError('not cached');
    const json = (v) => ({ ok: true, status: 200, json: async () => v, headers: new Headers() });
    if (url.startsWith('/api/manifest/')) return json({});
    if (url.startsWith('/api/tree/')) return json({ dirs: {}, files: {} });
    if (url.startsWith('/api/prefetch/')) return json([]);
    asked.push(url); now++; most = Math.max(most, now);
    await new Promise((r) => setTimeout(r, 10));
    now--;
    const body = new Uint8Array(1000 + asked.length);
    return { ok: true, status: 200, headers: new Headers({ 'content-length': String(body.length) }), body: new Response(body).body };
  };
  try {
    const { download } = await import('../src/host/web/download-worker.js');
    await download('g', undefined, 'launch', null, { files: urls, bytes: 9 * 1005 }, { openStore: async () => new MemBlockStore() });
    assert.deepEqual([...asked].sort(), [...urls].sort(), 'each once');
    assert.ok(most > 1 && most <= 4, `side by side: ${most}`);
    const done = posts.filter((m) => m.type === 'progress').at(-1);
    assert.equal(done.done, true, JSON.stringify(done));
  } finally { globalThis.fetch = real; globalThis.self = realSelf; }
});
