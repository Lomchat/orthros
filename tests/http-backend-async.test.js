// HTTP game file backend, asynchronous side: the background downloads (whole blocks a random read touched, the
// learned prefetch) and the asynchronous reads (fetchAhead, a parked ReadFile) share the network. Modeled with a fake
// fetch whose answers are released by the test in a chosen order, and a fake synchronous XHR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';

const MiB = 1 << 20;
const SIZE = 8 * MiB;
const byteAt = (i) => (i * 13 + (i >> 9)) & 0xff;
const bytes = (a, b) => Uint8Array.from({ length: b - a }, (_, k) => byteAt(a + k));
const tree = (size = SIZE) => ({ dirs: {}, files: { 'f.big': { size, mtime: 1 } } });

const syncReqs = [];
globalThis.XMLHttpRequest = class {
  open(m, url) { this.url = url; }
  setRequestHeader(k, v) { this.range = v; }
  send() { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range); syncReqs.push([+a, +b]); this.status = 206; this.response = bytes(+a, +b + 1).buffer; }
};

/** fetch stand-in: every call pending until released; honors AbortSignal. */
function fakeFetch() {
  const calls = [];
  const fn = (url, init = {}) => new Promise((resolve, reject) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const call = { start: +a, end: +b + 1, bg: !!init.signal, signal: init.signal, settled: false,
      release: () => { if (call.settled) return; call.settled = true; resolve({ status: 206, arrayBuffer: async () => bytes(+a, +b + 1).buffer }); } };
    init.signal?.addEventListener('abort', () => { if (!call.settled) { call.settled = true; reject(new DOMException('aborted', 'AbortError')); } });
    calls.push(call);
  });
  return { calls, fn };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function withFetch(body) {
  const real = globalThis.fetch, f = fakeFetch();
  globalThis.fetch = f.fn;
  try { await body(f.calls); } finally { globalThis.fetch = real; }
}

test('async read: a background download aborted for a foreground fetch does not restart while that fetch runs', () => withFetch(async (calls) => {
  const b = new HttpBackend('/game/a/', tree());
  b.lastSyncFetchAt = -1e9;
  b.want.set('f.big#0', { path: 'f.big', size: SIZE, mtime: 1, index: 0 });
  b.fillBackground();
  await tick();
  assert.equal(calls.filter((c) => c.bg).length, 1, 'the background download started');
  const ahead = b.fetchAhead('f.big', SIZE, 1, 3 * MiB, 3 * MiB + 10, false);
  assert.equal(calls[0].signal.aborted, true, 'the background download gave way');
  await tick(250); // (longer than the pause after a synchronous read)
  assert.equal(calls.filter((c) => c.bg).length, 1, 'no background download while the game waits for its fetch');
  calls.find((c) => !c.bg).release();
  await ahead;
  for (let i = 0; i < 40 && calls.filter((c) => c.bg).length < 2; i++) await tick(20);
  assert.equal(calls.filter((c) => c.bg).length, 2, 'the background download resumes afterwards');
  calls[calls.length - 1].release();
  for (let i = 0; i < 40 && b.filling; i++) await tick(10);
  assert.ok(b.cache.has('f.big#0'));
}));

test('async read: every background download in flight (prefetch and block fill) gives way to the game', () => withFetch(async (calls) => {
  const store = new Map(); store.map = store; store.put = (k, v) => store.set(k, v); store.failed = false;
  const b = new HttpBackend('/game/b/', tree(), { store });
  b.lastSyncFetchAt = -1e9;
  const progress = {};
  const pf = b.prefetch([['f.big', 5]], progress);
  await tick();
  assert.equal(calls.length, 1, 'prefetch downloading');
  // a read whose pieces are here already queues its block: the block fill starts while the prefetch runs
  b.chunks.set('f.big#0', bytes(0, CHUNK)); b.chunkBytes += CHUNK;
  assert.deepEqual(b.open('f.big').read(10, 20), bytes(10, 30));
  await tick();
  assert.equal(calls.length, 2, 'block fill downloading too');
  // the game needs the network synchronously: both downloads stop
  b.open('f.big').read(6 * MiB, 10);
  assert.deepEqual(calls.map((c) => c.signal.aborted), [true, true], 'both background downloads aborted');
  b.lastSyncFetchAt = -1e9;
  for (let i = 0; i < 100 && !progress.done; i++) { for (const c of calls) c.release(); await tick(20); }
  assert.equal(progress.done, true);
  assert.ok(store.has(`f.big#${SIZE}#1#5`), 'the prefetched block made it after the abort');
  for (let i = 0; i < 40 && b.filling; i++) { for (const c of calls) c.release(); await tick(20); }
  assert.ok(b.cache.has('f.big#0'), 'the filled block made it after the abort');
}));

test('async read: a download a parked read waits for is not aborted by another thread\'s asynchronous read', () => withFetch(async (calls) => {
  const b = new HttpBackend('/game/c/', tree());
  b.lastSyncFetchAt = -1e9;
  b.want.set('f.big#0', { path: 'f.big', size: SIZE, mtime: 1, index: 0 });
  b.fillBackground();
  await tick();
  const bg = calls[0];
  let t1done = false;
  const t1 = b.fetchAhead('f.big', SIZE, 1, 100, 200, false).then(() => { t1done = true; }); // waits for block 0
  const t2 = b.fetchAhead('f.big', SIZE, 1, 2 * MiB, 2 * MiB + 10, false); // another thread, other block
  calls[1].release(); await t2;
  b.fetchAhead('f.big', SIZE, 1, 3 * MiB, 3 * MiB + 10, false); // a third one while thread 1 still waits
  assert.equal(bg.signal.aborted, false, 'the block thread 1 waits for keeps downloading');
  assert.equal(t1done, false);
  bg.release(); await t1;
  await tick(10);
  assert.ok(b.cache.has('f.big#0'), 'thread 1 finds its block');
  for (const c of calls) c.release();
}));

test('async read: pieces fetched ahead stay within the piece cache bound', () => withFetch(async (calls) => {
  const size = 100 * MiB;
  const b = new HttpBackend('/game/d/', tree(size));
  b.fillBackground = () => {}; // (no background downloads: the pieces alone)
  for (let bi = 0; bi < 80; bi++) {
    const p = b.fetchAhead('f.big', size, 1, bi * BLOCK, (bi + 1) * BLOCK, false); // a random read of a whole block, by pieces
    calls[calls.length - 1].release(); await p;
  }
  assert.ok(b.chunkBytes <= 64 * MiB, `piece cache ${b.chunkBytes / MiB} MiB`);
  let sum = 0; for (const v of b.chunks.values()) sum += v.length;
  assert.equal(sum, b.chunkBytes);
}));
