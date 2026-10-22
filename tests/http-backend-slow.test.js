// HTTP game file backend on a thin link (docs/slow-network.md): the game's reads fetch what they need (pieces, plus a
// little measured past a stream), the pieces are kept in the persistent store (a second launch reads them locally) and
// become whole blocks once all are here, no speculative whole blocks go in the background, the learned pieces come in
// the learned order, and the offline copy follows the learned order first and resumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';
import { NetLink } from '../src/vfs/net-link.js';
import { MemBlockStore } from '../src/vfs/opfs-store.js';

const MiB = 1 << 20;
const SIZE = 6 * MiB + 4321;
const byteAt = (i) => (i * 11 + (i >> 10)) & 0xff;
const bytes = (a, b) => Uint8Array.from({ length: b - a }, (_, k) => byteAt(a + k));
const tree = () => ({ dirs: {}, files: { 'f.big': { size: SIZE, mtime: 3 }, 'g.big': { size: 2 * MiB, mtime: 3 } } });
const thin = () => new NetLink({ bw: 85000, fixed: true });

const syncReqs = [];
globalThis.XMLHttpRequest = class {
  open(m, url) { this.url = url; }
  setRequestHeader(k, v) { this.range = v; }
  getResponseHeader() { return null; }
  send() { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range); syncReqs.push([+a, +b + 1]); this.status = 206; this.response = bytes(+a, +b + 1).buffer; }
};
/** fetch stand-in answering at once (a microtask later) */
function withFetch(body) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? '') ?? /[?&]r=(\d+)-(\d+)/.exec(url);
    const a = +m[1], e = init.headers?.Range ? +m[2] + 1 : +m[2];
    calls.push({ url, start: a, end: e });
    return { status: 206, headers: { get: () => null }, arrayBuffer: async () => bytes(a, e).buffer };
  };
  return Promise.resolve(body(calls)).finally(() => { globalThis.fetch = real; });
}
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1)); };

test('thin link: a random read fetches its pieces only, keeps them in the store; a second launch reads them locally', () => withFetch(async (calls) => {
  const store = new MemBlockStore();
  const b = new HttpBackend('/game/s/', tree(), { store, net: thin() });
  const f = b.open('f.big'), n0 = syncReqs.length;
  assert.deepEqual(f.read(2 * MiB + 1000, 300), bytes(2 * MiB + 1000, 2 * MiB + 1300));
  assert.deepEqual(syncReqs.slice(n0), [[2 * MiB, 2 * MiB + CHUNK]], 'one piece');
  await settle();
  assert.equal(calls.length, 0, 'no whole block in the background (16 times the bytes on a thin link)');
  assert.equal(b.want.size, 0);
  assert.ok(store.map.has(`f.big#${SIZE}#3#c${(2 * MiB) / CHUNK}`), 'the piece is kept');
  // a later session (same store): no request
  const b2 = new HttpBackend('/game/s/', tree(), { store, net: thin() }), n1 = syncReqs.length;
  assert.deepEqual(b2.open('f.big').read(2 * MiB + 1000, 300), bytes(2 * MiB + 1000, 2 * MiB + 1300));
  assert.equal(syncReqs.length, n1, 'read from the stored piece');
  // all of a block's pieces here: the block itself is stored, its pieces dropped
  const g = b2.open('g.big');
  for (let c = 0; c < BLOCK / CHUNK; c++) g.read(c * CHUNK + 5, 10);
  assert.ok(store.map.has(`g.big#${2 * MiB}#3#0`), 'block 0 assembled and stored');
  assert.ok(![...store.map.keys()].some((k) => k.startsWith(`g.big#${2 * MiB}#3#c`) && Number(k.split('#c')[1]) < 16), 'its pieces dropped');
  assert.deepEqual(g.read(BLOCK - 100, 200), bytes(BLOCK - 100, BLOCK + 100));
}));

test('thin link: a file read in sequence is fetched a little past each read, never 4 MiB at once; the rest comes ahead in small requests', () => withFetch(async (calls) => {
  const b = new HttpBackend('/game/q/', tree(), { net: thin() });
  const f = b.open('f.big'), n0 = syncReqs.length;
  for (let pos = 0; pos < 2 * MiB; pos += 32 << 10) { assert.deepEqual(f.read(pos, 32 << 10), bytes(pos, pos + (32 << 10))); await settle(2); }
  const sync = syncReqs.slice(n0);
  assert.ok(sync.length > 0);
  assert.ok(sync.every(([a, z]) => z - a <= 2 * CHUNK), `sync requests small (${sync.map(([a, z]) => (z - a) / 1024)} KiB)`);
  assert.ok(calls.length > 0, 'pieces fetched ahead of the reader');
  assert.ok(calls.every((c) => c.end - c.start <= b.net.backgroundBytes()), 'background requests of the link\'s size');
  assert.ok(calls.every((c) => c.start < 2 * MiB + 256 * 1024), 'not far past the reader');
}));

test('thin link: the learned prefetch fetches the learned pieces in order from the game\'s position, nothing else', () => withFetch(async (calls) => {
  const store = new MemBlockStore();
  const b = new HttpBackend('/game/p/', tree(), { store, encoded: true, net: thin() });
  b.gameBusy = () => false;
  const progress = {};
  // block 4 of f.big: pieces 1 and 2; block 0 of g.big: piece 0; block 1 of f.big: mask unknown (0)
  await b.prefetch([['f.big', 4, 0b110, 0], ['g.big', 0, 0b1, 100], ['f.big', 1, 0, 200]], progress);
  // (one 64 KiB piece per request: what 85 KB/s carries in BG_SECONDS, rounded up to a piece)
  assert.deepEqual(calls.map((c) => [c.url.split('?')[0].split('/').pop(), c.start, c.end]), [['f.big', 4 * MiB + CHUNK, 4 * MiB + 2 * CHUNK], ['f.big', 4 * MiB + 2 * CHUNK, 4 * MiB + 3 * CHUNK], ['g.big', 0, CHUNK]]);
  assert.ok(calls.every((c) => c.url.includes('&p=1')), 'asked as background downloads');
  assert.ok(progress.done);
  assert.ok(store.map.has(`f.big#${SIZE}#3#c${4 * 16 + 1}`) && store.map.has(`g.big#${2 * MiB}#3#c0`));
  // the step estimate: what the learned entries past the position still need
  const b2 = new HttpBackend('/game/p/', tree(), { store: new MemBlockStore(), encoded: true, net: thin() });
  b2.learned = { entries: [{ path: 'f.big', size: SIZE, mtime: 3, index: 4, mask: 0b110, t: 0 }, { path: 'g.big', size: 2 * MiB, mtime: 3, index: 0, mask: 1, t: 100 }, { path: 'f.big', size: SIZE, mtime: 3, index: 1, mask: 0, t: 60000 }], pos: -1, rankOf: new Map() };
  assert.equal(b2.stepEstimate().bytes, 3 * CHUNK, 'up to the pause: two pieces and one piece');
}));

test('offline copy: the learned blocks first, then the rest; a second start resumes (stored blocks skipped)', () => withFetch(async (calls) => {
  const store = new MemBlockStore();
  const b = new HttpBackend('/game/o/', tree(), { store, encoded: true, net: thin() });
  let n = 0;
  const p1 = {};
  await b.downloadAll(p1, () => ++n > 3, { alone: true, order: [['g.big', 1], ['f.big', 5]] });
  assert.deepEqual(calls.slice(0, 2).map((c) => [c.url.split('?')[0].split('/').pop(), c.start]), [['g.big', MiB], ['f.big', 5 * MiB]], 'the learned blocks first');
  assert.ok(calls.every((c) => c.url.includes('&p=1')), 'not learned as the game\'s own reads');
  assert.ok(!p1.done);
  const p2 = {};
  await b.downloadAll(p2, () => false, { alone: true, order: [['g.big', 1], ['f.big', 5]] });
  assert.ok(p2.done); assert.ok(p2.stored > 0, 'resumed: bytes already here');
  assert.equal(p2.bytes, p2.total);
  for (let i = 0; i * BLOCK < SIZE; i++) assert.ok(store.map.has(`f.big#${SIZE}#3#${i}`));
  const asked = new Map(); for (const c of calls) { const k = `${c.url.split('?')[0]}#${c.start}`; asked.set(k, (asked.get(k) ?? 0) + 1); }
  assert.ok([...asked.values()].every((v) => v === 1), 'no range asked twice');
}));

test('thin link: a parked read of pieces whose background request waits for its turn makes it go at once (no wait behind the game\'s other reads)', () => withFetch(async (calls) => {
  const net = thin(), b = new HttpBackend('/game/u/', tree(), { net });
  const f = b.open('f.big');
  const busy = net.begin('demand', CHUNK); // (another thread's read on its way: background turns wait on a thin link)
  const part = b.fetchPartBg('f.big', SIZE, 3, 32, 33, [5, 300]);
  await settle();
  assert.equal(calls.length, 0, 'waits for its turn');
  const p = f.prepare(32 * CHUNK + 10, 100);
  assert.ok(p, 'the read parks');
  await settle();
  assert.equal(calls.length, 1, 'promoted: started although a game read is in flight');
  assert.equal(await part, true);
  await p;
  const n0 = syncReqs.length;
  assert.deepEqual(f.read(32 * CHUNK + 10, 100), bytes(32 * CHUNK + 10, 32 * CHUNK + 110));
  assert.equal(syncReqs.length, n0, 'the read finds the pieces here');
  net.end(busy, CHUNK);
}));

test('thin link: a synchronous read aborts a background request for the same bytes; the read is exact and the aborted pieces are not kept half', async () => {
  const real = globalThis.fetch, pending = [];
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? ''), a = +m[1], e = +m[2] + 1;
    const p = { a, e, resolve: () => resolve({ status: 206, headers: { get: () => null }, arrayBuffer: async () => bytes(a, e).buffer }) };
    init.signal?.addEventListener('abort', () => { p.aborted = true; reject(new DOMException('aborted', 'AbortError')); });
    pending.push(p);
  });
  try {
    const store = new MemBlockStore(), net = thin(), b = new HttpBackend('/game/v/', tree(), { store, net });
    const f = b.open('f.big');
    const part = b.fetchPartBg('f.big', SIZE, 3, 48, 48, [5, 0]);
    await settle();
    assert.equal(pending.length, 1);
    assert.deepEqual(f.read(48 * CHUNK + 7, 1000), bytes(48 * CHUNK + 7, 48 * CHUNK + 1007));
    assert.ok(pending[0].aborted, 'the background request for the same bytes went away');
    assert.equal(await part, false);
    assert.ok(store.map.has(`f.big#${SIZE}#3#c48`), 'the piece kept from the read');
    assert.deepEqual(store.get(`f.big#${SIZE}#3#c48`), bytes(48 * CHUNK, 49 * CHUNK));
    assert.equal(net.inflight.bg, 0); assert.equal(net.bgFlights.size, 0);
  } finally { globalThis.fetch = real; }
});

test('download first on a thin link: one block per request (a 4 MiB request would take 50 s), four on a fast one', () => withFetch(async (calls) => {
  const b = new HttpBackend('/game/w/', tree(), { store: new MemBlockStore(), encoded: true, net: thin() });
  const p = {};
  await b.downloadAll(p, () => false, { alone: true });
  assert.ok(p.done);
  assert.ok(calls.every((c) => c.end - c.start <= BLOCK), `request sizes ${calls.map((c) => (c.end - c.start) >> 10)} KiB`);
  calls.length = 0;
  // (unitRequests off: the 4 MiB download as planned, not cut at its blocks for the server's precompressed units)
  const f = new HttpBackend('/game/w2/', tree(), { store: new MemBlockStore(), encoded: true, unitRequests: false, net: new NetLink({ bw: 20 << 20, fixed: true }) });
  await f.downloadAll({}, () => false, { alone: true });
  assert.ok(calls.some((c) => c.end - c.start === 4 * BLOCK));
}));

test('a link between thin and fast: a learned block wanted whole goes as the block (the server\'s unit), not as pieces; a slower one by pieces', () => withFetch(async (calls) => {
  // 1 MB/s: backgroundBytes() is 320 KiB, a block crosses the link in about 1 s (within WHOLE_BLOCK_SECONDS)
  const b = new HttpBackend('/game/u/', tree(), { store: new MemBlockStore(), encoded: true, net: new NetLink({ bw: 1e6, fixed: true }) });
  b.gameBusy = () => false;
  assert.ok(b.net.backgroundBytes() < BLOCK && b.wholeBlockFits());
  // block 2 of f.big: every piece learned; block 4: pieces 1 and 2 (no whole block for those)
  await b.prefetch([['f.big', 2, 0xffff, 0], ['f.big', 4, 0b110, 10]], {}, () => false, { learnedOnly: true });
  const got = calls.map((c) => [c.start, c.end]);
  assert.deepEqual(got[0], [2 * MiB, 3 * MiB], `the whole block in one request: ${JSON.stringify(got)}`);
  assert.deepEqual(got.slice(1), [[4 * MiB + CHUNK, 4 * MiB + 2 * CHUNK], [4 * MiB + 2 * CHUNK, 4 * MiB + 3 * CHUNK]], 'the learned pieces of the other one');
  assert.ok(b.peekBlockHere('f.big', SIZE, 3, 2), 'the block kept whole');
  // 300 KB/s: a block would take ~3.5 s — while the game runs, by pieces, backgroundBytes() at a time
  calls.length = 0;
  const s = new HttpBackend('/game/u2/', tree(), { store: new MemBlockStore(), encoded: true, net: new NetLink({ bw: 400e3, fixed: true }) });
  s.gameBusy = () => false;
  assert.equal(s.wholeBlockFits(), false);
  await s.prefetch([['f.big', 2, 0xffff, 0]], {}, () => false);
  assert.ok(calls.length > 1 && calls.every((c) => c.end - c.start <= s.net.backgroundBytes()), `by pieces: ${calls.map((c) => (c.end - c.start) >> 10)} KiB`);
  // before the game starts (learnedOnly: a startup set, Prepare), nothing of the game's on the link: the block whole on
  // a thin link too (its unit: ~16 % fewer bytes than pieces brotli makes on the fly, 1 request instead of 16); a light
  // copy's pieces as they are made (by pieces)
  for (const bw of [400e3, 85e3]) {
    calls.length = 0;
    const t = new HttpBackend('/game/u3/', tree(), { store: new MemBlockStore(), encoded: true, net: new NetLink({ bw, fixed: true }) });
    t.gameBusy = () => false;
    await t.prefetch([['f.big', 2, 0xffff, 0], ['f.big', 4, 0b110, 10]], {}, () => false, { learnedOnly: true });
    const got2 = calls.map((c) => [c.start, c.end]);
    assert.deepEqual(got2[0], [2 * MiB, 3 * MiB], `${bw}: the whole block in one request: ${JSON.stringify(got2)}`);
    assert.ok(got2.slice(1).every(([a, e]) => a >= 4 * MiB && e <= 4 * MiB + 3 * CHUNK), `${bw}: the other one's learned pieces: ${JSON.stringify(got2)}`);
    assert.ok(t.peekBlockHere('f.big', SIZE, 3, 2), 'the block kept whole');
  }
}));

test('a fast link before the game starts (learnedOnly): the learned pieces only, several requests at once, none again of those here; while the game runs, whole blocks one at a time', async () => {
  const real = globalThis.fetch;
  let now = 0, most = 0, asked = [];
  globalThis.fetch = async (url) => {
    const [, a, e] = /[?&]r=(\d+)-(\d+)/.exec(url); asked.push([+a, +e]);
    now++; most = Math.max(most, now);
    await new Promise((r) => setTimeout(r, 5)); now--;
    return { status: 206, headers: { get: () => null }, arrayBuffer: async () => bytes(+a, +e).buffer };
  };
  try {
    const files = {}; for (let i = 0; i < 12; i++) files[`s${i}.txt`] = { size: 5000 + i, mtime: 3 };
    files['f.big'] = { size: SIZE, mtime: 3 };
    const list = Object.keys(files).filter((p) => p !== 'f.big').map((p, i) => [p, 0, 1, i]);
    const run = async (opts) => {
      const store = new MemBlockStore(), b = new HttpBackend('/game/q/', { dirs: {}, files }, { store, encoded: true, net: new NetLink({ bw: 20e6, fixed: true }) });
      b.gameBusy = () => false; most = 0; asked = [];
      // (block 1 of f.big: its learned pieces 0 and 3 here already — fetched by pieces before the link was measured)
      store.put(b.pieceKey('f.big', SIZE, 3, 16), bytes(MiB, MiB + CHUNK)); store.put(b.pieceKey('f.big', SIZE, 3, 19), bytes(MiB + 3 * CHUNK, MiB + 4 * CHUNK));
      const p = {}; await b.prefetch([...list, ['f.big', 1, 0b1001, 20], ['f.big', 2, 0b0110, 30]], p, () => false, opts);
      assert.ok(p.done);
      for (const [path, f] of Object.entries(files)) if (path !== 'f.big') assert.ok(b.peekBlockHere(path, f.size, 3, 0) || b.pieceHere(path, f.size, 3, 0), `${path} stored`);
      // (kept in the store, not only in memory: a fast link keeps whole blocks only otherwise — the pass fetched the same
      // pieces again and again once the memory's pieces were trimmed: Morrowind Vanilla+'s launch set, 56 000 requests)
      if (opts.learnedOnly) for (const c of [33, 34]) assert.ok(store.map.has(b.pieceKey('f.big', SIZE, 3, c)), `piece ${c} in the store`);
      return { most, asked: [...asked] };
    };
    const before = await run({ learnedOnly: true });
    assert.ok(before.most >= 4 && before.most <= 8, `requests at once: ${before.most}`);
    assert.ok(!before.asked.some(([a, e]) => a < 2 * MiB && e > MiB), `nothing of the block whose learned pieces are here: ${JSON.stringify(before.asked)}`);
    assert.deepEqual(before.asked.filter(([a]) => a >= 2 * MiB), [[2 * MiB + CHUNK, 2 * MiB + 2 * CHUNK], [2 * MiB + 2 * CHUNK, 2 * MiB + 3 * CHUNK]], 'the other block\'s learned pieces, not the block (its units)');
    const playing = await run({});
    assert.ok(playing.most <= 2, `one request at a time while the game runs (two blocks of one cut at their units): ${playing.most}`);
    assert.ok(playing.asked.some(([a]) => a === MiB), 'the whole block, the game running (the rest of it comes too)');
  } finally { globalThis.fetch = real; }
});

test('learnedOnly with a full store: an entry the store did not keep is asked once (not again each time the memory evicts it)', async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const [, a, e] = /[?&]r=(\d+)-(\d+)/.exec(url); asked.push([+a, +e]);
    return { status: 206, headers: { get: () => null }, arrayBuffer: async () => bytes(+a, +e).buffer };
  };
  try {
    const files = { 'f.big': { size: SIZE, mtime: 3 } };
    // (a store that keeps nothing, a memory cache of one block: every block evicted by the next)
    const b = new HttpBackend('/game/full/', { dirs: {}, files }, { store: new MemBlockStore(0), encoded: true, net: new NetLink({ bw: 20e6, fixed: true }) });
    b.gameBusy = () => false;
    b.maxBlocks = 1;
    const list = [0, 1, 2, 3].map((i) => ['f.big', i, 0xffff, i]);
    // (stopped after 40 requests: the pass would otherwise go on for good)
    const p = {}; await b.prefetch(list, p, () => asked.length > 40, { learnedOnly: true });
    assert.ok(p.done, `the pass ended by itself after ${asked.length} requests`);
    const per = new Map(); for (const [a] of asked) { const k = Math.floor(a / MiB); per.set(k, (per.get(k) ?? 0) + 1); }
    assert.deepEqual([...per.values()], [1, 1, 1, 1], `each block asked once: ${JSON.stringify(asked)}`);
  } finally { globalThis.fetch = real; }
});
