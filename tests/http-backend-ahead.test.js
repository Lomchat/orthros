// Learned prefetch that follows the game: the server learns which 64 KiB pieces sessions read in each block, the
// backend follows the game's position in the learned list (whole blocks from there on) and fetches the learned pieces
// of the next entries ahead of the game's reads. Fake fetch (answers released by the test) and fake synchronous XHR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';

const MiB = 1 << 20;
const SIZE = 8 * MiB;
const byteAt = (i) => (i * 29 + (i >> 10)) & 0xff;
const bytes = (a, b) => Uint8Array.from({ length: b - a }, (_, k) => byteAt(a + k));
const tree = () => ({ dirs: {}, files: { 'f.big': { size: SIZE, mtime: 1 } } });

const syncReqs = [];
globalThis.XMLHttpRequest = class {
  open(m, url) { this.url = url; }
  setRequestHeader(k, v) { this.range = v; }
  send() { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range); syncReqs.push([+a, +b + 1]); this.status = 206; this.response = bytes(+a, +b + 1).buffer; }
};
function fakeFetch() {
  const calls = [];
  const fn = (url, init = {}) => new Promise((resolve, reject) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const call = { start: +a, end: +b + 1, signal: init.signal, settled: false,
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
const memStore = () => { const map = new Map(); return { map, failed: false, has: (k) => map.has(k), put: (k, v) => { if (!map.has(k)) map.set(k, v.slice()); }, get: (k) => map.get(k)?.slice() ?? null, flush() {} }; };
const addPiece = (b, c) => { b.chunks.set(`f.big#${c}`, bytes(c * CHUNK, (c + 1) * CHUNK)); b.chunkBytes += CHUNK; };

test('learned prefetch: whole blocks from the game\'s position in the list on, then the ones before it', () => withFetch(async (calls) => {
  const store = memStore();
  const b = new HttpBackend('/game/a/', tree(), { store });
  b.fillBackground = () => {}; // (the blocks the game touches are not fetched by the block fill here)
  b.lastSyncFetchAt = performance.now() + 1e9; // the game is reading: the prefetch waits
  const progress = {};
  const pf = b.prefetch([['f.big', 0], ['f.big', 1], ['f.big', 5], ['f.big', 6], ['f.big', 3]], progress);
  await tick();
  assert.equal(calls.length, 0);
  addPiece(b, 5 * (BLOCK / CHUNK));
  assert.deepEqual(b.open('f.big').read(5 * MiB + 3, 10), bytes(5 * MiB + 3, 5 * MiB + 13)); // the game reaches entry 2
  assert.equal(b.learned.pos, 2);
  b.lastSyncFetchAt = -1e9;
  for (let i = 0; i < 20 && !calls.length; i++) await tick(20);
  assert.deepEqual([calls[0].start, calls[0].end], [6 * MiB, 7 * MiB], 'the entry past the game first (block 5 is not stored: the game only read a piece of it)');
  for (let i = 0; i < 100 && !progress.done; i++) { for (const c of calls) c.release(); await tick(20); }
  await pf;
  assert.deepEqual(calls.map((c) => c.start / MiB), [6, 3, 0, 5], 'then the rest of the list past it, then from the start (0 and 1 in one request)');
  for (const i of [0, 1, 3, 5, 6]) assert.ok(store.has(`f.big#${SIZE}#1#${i}`), `block ${i} stored`);
}));

test('learned pieces: fetched ahead of the game, not aborted by its reads, waited for by a parked read', () => withFetch(async (calls) => {
  const store = memStore();
  const b = new HttpBackend('/game/b/', tree(), { store });
  b.fillBackground = () => {};
  b.lastSyncFetchAt = performance.now() + 1e9; // (the whole-block pass stays out of the way)
  const P = BLOCK / CHUNK;
  let stopped = false;
  b.prefetch([['f.big', 0, 0b1], ['f.big', 1, 0b100], ['f.big', 2, 0b1011], ['f.big', 3, 0xffff], ['f.big', 4, 0b1], ['f.big', 7]], {}, () => stopped);
  await tick();
  addPiece(b, 0);
  const f = b.open('f.big');
  assert.deepEqual(f.read(100, 50), bytes(100, 150)); // the game reads entry 0: the next entries' pieces are fetched
  const ranges = calls.map((c) => [c.start, c.end]);
  assert.deepEqual(ranges, [[MiB + 2 * CHUNK, MiB + 3 * CHUNK], [2 * MiB, 2 * MiB + 2 * CHUNK], [2 * MiB + 3 * CHUNK, 2 * MiB + 4 * CHUNK]],
    'the learned pieces of entries 1 and 2 (runs of pieces), three requests at most');
  // the game reads synchronously elsewhere: the requests ahead go on
  f.read(6 * MiB + 5, 10);
  assert.ok(calls.every((c) => !c.signal.aborted));
  // a parked read of a piece in flight waits for it instead of asking again
  const p = f.prepare(MiB + 2 * CHUNK + 7, 100);
  assert.ok(p);
  await tick();
  assert.equal(calls.length, 3, 'no second request for that piece');
  calls[0].release();
  await p;
  const n = syncReqs.length;
  assert.deepEqual(f.read(MiB + 2 * CHUNK + 7, 100), bytes(MiB + 2 * CHUNK + 7, MiB + 2 * CHUNK + 107));
  assert.equal(syncReqs.length, n, 'served from the pieces fetched ahead');
  // a request slot freed: the next entry (every piece learned) is fetched as its whole block, stored
  await tick();
  assert.deepEqual([calls[3].start, calls[3].end], [3 * MiB, 4 * MiB]);
  for (const c of calls) c.release();
  await tick(10);
  assert.ok(store.has(`f.big#${SIZE}#1#3`), 'a block wanted whole is stored');
  assert.ok(b.chunks.has(`f.big#${2 * P + 3}`));
  // entry 5 has no mask (learned before masks): left to the whole-block pass
  assert.ok(calls.every((c) => c.start < 7 * MiB));
  assert.equal(b.stats.aheadRequests, 5);
  stopped = true;
}));

test('server: the learned list carries the pieces sessions read in each block', async () => {
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os'), http = await import('node:http');
  const { createServer } = await import('../src/host/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-mask-'));
  fs.writeFileSync(path.join(dir, 'a.big'), bytes(0, 3 * MiB));
  fs.mkdirSync(path.join(dir, 'man')); fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  const learnDir = path.join(dir, 'learn'); fs.mkdirSync(learnDir);
  // an earlier learned file, from before masks: its block stays without a mask until a session reads it
  fs.writeFileSync(path.join(learnDir, 'prefetch-g.json'), JSON.stringify([['a.big#2', 5, 1], ['a.big#0', 1, 3]]));
  const server = createServer({ manifests: path.join(dir, 'man'), learnDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (u) => { const r = await new Promise((res, rej) => http.get(base + u, res).on('error', rej)); const parts = []; for await (const d of r) parts.push(d); return Buffer.concat(parts); };
  try {
    await get(`/gamez/g/a.big?r=${MiB}-${MiB + 10}&s=s1`);
    await get(`/gamez/g/a.big?r=${MiB + 3 * CHUNK + 1}-${MiB + 3 * CHUNK + 5}&s=s1`); // (same session, same block)
    await get(`/gamez/g/a.big?r=${MiB + 5 * CHUNK}-${MiB + 7 * CHUNK}&s=s2`);
    await get(`/gamez/g/a.big?r=${MiB + 9 * CHUNK}-${MiB + 10 * CHUNK}&p=1`); // (a prefetch request: not learned)
    await get(`/gamez/g/a.big?r=${CHUNK - 1}-${CHUNK + 1}&s=s2`); // (across a piece boundary)
    const list = JSON.parse(await get('/api/prefetch/g'));
    const byKey = Object.fromEntries(list.map(([p, b, m]) => [`${p}#${b}`, m]));
    assert.equal(byKey['a.big#1'], 0b1101001, 'pieces 0, 3 (session 1), 5 and 6 (session 2)');
    assert.equal(byKey['a.big#0'], 0b11);
    assert.equal(byKey['a.big#2'], undefined, 'no mask learned yet');
    assert.equal(list.find(([p, b]) => b === 2).length, 2);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('learned prefetch: runs beside a block fill that always has blocks to fetch, leaves it the block it is fetching', () => withFetch(async (calls) => {
  const store = memStore();
  const b = new HttpBackend('/game/c/', tree(), { store });
  b.lastSyncFetchAt = -1e9;
  // the game keeps touching new blocks: the fill always has one more to fetch (here: it never ends)
  b.want.set('f.big#2', { path: 'f.big', size: SIZE, mtime: 1, index: 2 });
  b.want.set('f.big#6', { path: 'f.big', size: SIZE, mtime: 1, index: 6 });
  b.fillBackground();
  await tick();
  assert.equal(calls.length, 1, 'the fill downloads block 2');
  const progress = {};
  const pf = b.prefetch([['f.big', 2], ['f.big', 4], ['f.big', 6]], progress);
  for (let i = 0; i < 20 && calls.length < 2; i++) await tick(20);
  assert.deepEqual(calls.map((c) => c.start / MiB), [2, 4], 'the prefetch goes on beside the fill, without block 2 (the fill\'s)');
  calls[1].release(); // block 4, stored by the prefetch
  for (let i = 0; i < 20 && calls.length < 3; i++) await tick(20);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].start / MiB, 6, 'then block 6 (the fill has not reached it)');
  calls[2].release();
  for (let i = 0; i < 20 && !store.has(`f.big#${SIZE}#1#6`); i++) await tick(20);
  calls[0].release(); // block 2: the fill installs and stores it
  for (let i = 0; i < 100 && !progress.done; i++) await tick(20);
  await pf;
  for (let i = 0; i < 40 && b.filling; i++) await tick(10);
  assert.equal(b.filling, false);
  assert.deepEqual(calls.map((c) => c.start / MiB), [2, 4, 6], 'the fill does not fetch block 6 again (stored by the prefetch), nor the prefetch block 2');
  for (const i of [2, 4, 6]) assert.ok(store.has(`f.big#${SIZE}#1#${i}`), `block ${i} stored`);
}));
