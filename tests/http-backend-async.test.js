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
      release: () => { if (call.settled) return; call.settled = true; resolve({ status: 206, arrayBuffer: async () => bytes(+a, +b + 1).buffer }); },
      fail: () => { if (call.settled) return; call.settled = true; reject(new TypeError('Failed to fetch')); } };
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

/** Read [a, z) of `f` in 256 KiB reads, checking the bytes. */
const readSeq = (f, a, z) => { for (let pos = a; pos < z; pos += 256 << 10) assert.deepEqual(f.read(pos, Math.min(256 << 10, z - pos)), bytes(pos, Math.min(pos + (256 << 10), z))); };

test('read-ahead: a file read whole has its next blocks fetched asynchronously; its reads then find them here', () => withFetch(async (calls) => {
  const size = 12 * MiB;
  const b = new HttpBackend('/game/e/', tree(size));
  b.fillBackground = () => {}; // (the read-ahead alone)
  const f = b.open('f.big'), n0 = syncReqs.length;
  // (the first MiB by pieces, then the file is being read whole: 4 blocks at once, then the next ones ahead)
  readSeq(f, 0, 3 * MiB + (256 << 10));
  // (block 0, read by pieces again and again, is fetched whole too: see noteMiss)
  assert.deepEqual(calls.filter((c) => c.start < MiB).map((c) => [c.start, c.end]), [[0, MiB]]);
  const ahead = calls.filter((c) => c.start >= MiB);
  assert.ok(ahead.length >= 1, 'blocks fetched ahead of the reader');
  assert.ok(ahead.every((c) => c.start % BLOCK === 0 && c.start >= 3 * MiB && c.end <= 8 * MiB), `within the window past the reader (${ahead.map((c) => [c.start / MiB, c.end / MiB])})`);
  assert.equal(b.gameBusy(0), true, 'background downloads wait while the reader\'s blocks are on their way');
  // a parked read of a block on its way waits for that download instead of asking again
  const before = calls.length;
  const p = f.prepare(ahead[0].start, 64 << 10);
  assert.ok(p, 'the block is not here yet');
  assert.equal(calls.length, before, 'no second request for a block on its way');
  for (const c of calls) c.release();
  await p; await tick();
  const nSync = syncReqs.length;
  readSeq(f, 3 * MiB + (256 << 10), 8 * MiB);
  assert.equal(syncReqs.length, nSync, 'the blocks fetched ahead served the reads');
  // the reader moves on: the window moves with it, never past the file's end
  for (let pos = 8 * MiB; pos < size; pos += MiB) { for (const c of calls) c.release(); await tick(); readSeq(f, pos, pos + MiB); }
  assert.ok(calls.every((c) => c.end <= size), 'nothing past the end');
  assert.ok(syncReqs.slice(n0).every(([, z]) => z < 5 * MiB), `no synchronous request past the first whole blocks (${syncReqs.slice(n0).map(([a, z]) => [a, z - a + 1])})`);
  for (let bi = 5; bi < 12; bi++) assert.equal(calls.filter((c) => c.start <= bi * MiB && bi * MiB < c.end).length, 1, `block ${bi} asked once`);
  for (const c of calls) c.release(); await tick();
  assert.equal(b.readAheadPending, 0); assert.equal(b.blockFlights.size, 0);
}));

test('read-ahead: a failed download leaves the read to fetch the block itself, with the exact bytes', () => withFetch(async (calls) => {
  const size = 6 * MiB;
  const b = new HttpBackend('/game/g/', tree(size));
  b.fillBackground = () => {};
  const f = b.open('f.big');
  readSeq(f, 0, 3 * MiB + (256 << 10));
  assert.ok(calls.length >= 1);
  const p = f.prepare(3 * MiB + (256 << 10), 2 * MiB); // (a parked read reaching block 5, on its way)
  const failed = calls.length;
  for (const c of calls) c.fail();
  let done = false; p.then(() => { done = true; });
  for (let i = 0; i < 20 && !done; i++) { await tick(); for (const c of calls.slice(failed)) c.release(); }
  assert.ok(done, 'the parked read ends');
  assert.ok(calls.length > failed, 'it asked for the block itself');
  assert.equal(b.readAheadPending, 0);
  const n = syncReqs.length;
  assert.deepEqual(f.read(3 * MiB + (256 << 10), 2 * MiB), bytes(3 * MiB + (256 << 10), 5 * MiB + (256 << 10)));
  assert.equal(syncReqs.length, n, 'the parked read\'s own fetch served the read');
  for (const c of calls) c.release();
}));

test('missed block: a block the game misses a second time is fetched whole at once; its next reads wait for it', () => withFetch(async (calls) => {
  const b = new HttpBackend('/game/h/', tree());
  b.fillBackground = () => {}; // (the background fill would wait for a quiet network anyway)
  const f = b.open('f.big');
  const parked = async (off, len) => { const p = f.prepare(off, len); if (p) { await tick(); for (const c of calls) c.release(); await p; } assert.deepEqual(f.read(off, len), bytes(off, off + len)); };
  const n0 = syncReqs.length;
  await parked(3 * MiB + 1000, 100); // first miss: its piece only
  assert.deepEqual(calls.map((c) => [c.start, c.end]), [[3 * MiB, 3 * MiB + CHUNK]]);
  const p2 = f.prepare(3 * MiB + 5 * CHUNK, 100); // second miss in the same block: the piece, and the block whole
  assert.deepEqual(calls.slice(1).map((c) => [c.start, c.end]).sort((x, y) => y[1] - x[1]), [[3 * MiB, 4 * MiB], [3 * MiB + 5 * CHUNK, 3 * MiB + 6 * CHUNK]]);
  calls.find((c) => c.end === 3 * MiB + 6 * CHUNK).release(); await p2;
  const p3 = f.prepare(3 * MiB + 9 * CHUNK, 100); // a third read waits for the block on its way
  assert.ok(p3);
  assert.equal(calls.length, 3, 'no request of its own');
  for (const c of calls) c.release(); await p3;
  assert.ok(b.cache.has('f.big#3'));
  assert.deepEqual(f.read(3 * MiB + 9 * CHUNK, 100), bytes(3 * MiB + 9 * CHUNK, 3 * MiB + 9 * CHUNK + 100));
  assert.equal(syncReqs.length, n0, 'every read served without a synchronous request');
  // a block missed once elsewhere: its piece only
  await parked(6 * MiB + 77, 10);
  assert.equal(calls.filter((c) => c.start === 6 * MiB && c.end === 7 * MiB).length, 0);
}));
