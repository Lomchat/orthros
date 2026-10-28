// The learned read-ahead's budget (NetLink.aheadBudget, HttpBackend.pumpAhead — docs/slow-network.md "Read-ahead by the
// link's bandwidth-delay product"): requests in flight by the link's class, on a fast HTTP/2 link as many as keep two
// bandwidth-delay products in flight; and the whole-block pass's blocks on their way registered (blockFlights), so the
// pieces ahead skip them and a parked read joins them rather than asking the same bytes twice at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';
import { NetLink, AHEAD_REQUESTS, AHEAD_REQUESTS_MID, AHEAD_REQUESTS_MAX, AHEAD_BDP, AHEAD_BYTES_MIN } from '../src/vfs/net-link.js';

const SIZE = 48 * BLOCK;
const byteAt = (i) => (i * 29 + (i >> 10)) & 0xff;
const bytes = (a, b) => Uint8Array.from({ length: b - a }, (_, k) => byteAt(a + k));
const tree = () => ({ dirs: {}, files: { 'f.big': { size: SIZE, mtime: 1 } } });

globalThis.XMLHttpRequest = class {
  open(m, url) { this.url = url; }
  setRequestHeader(k, v) { this.range = v; }
  send() { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range); this.status = 206; this.response = bytes(+a, +b + 1).buffer; }
};
function fakeFetch() {
  const calls = [];
  const fn = (url, init = {}) => new Promise((resolve, reject) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const call = { start: +a, end: +b + 1, signal: init.signal, settled: false,
      release: () => { if (call.settled) return; call.settled = true; resolve({ status: 206, headers: { get: () => null }, arrayBuffer: async () => bytes(+a, +b + 1).buffer }); } };
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
class MemStore {
  constructor() { this.m = new Map(); this.failed = false; }
  get map() { return this.m; }
  get(k) { return this.m.get(k)?.slice() ?? null; }
  put(k, b) { if (!this.m.has(k)) this.m.set(k, b.slice()); }
  flush() {}
}
/** a link measured at `bw` bytes/s with a round trip of `rtt` ms, over `protocol` (fixed: the fake answers measure nothing) */
const link = (bw, rtt = 85, protocol = 'h2') => { const net = new NetLink({ bw, protocol, fixed: true }); net.measured = true; net.rtt = rtt; return net; };

test('ahead budget: a thin link and HTTP/1.x a few requests, a mid link more, a fast HTTP/2 link by its bandwidth-delay product', () => {
  assert.deepEqual(link(85e3).aheadBudget(), { requests: AHEAD_REQUESTS, bytes: Infinity }, 'thin');
  assert.deepEqual(link(1.8e6).aheadBudget(), { requests: AHEAD_REQUESTS_MID, bytes: Infinity }, 'between thin and fast');
  assert.deepEqual(new NetLink({}).aheadBudget(), { requests: AHEAD_REQUESTS_MID, bytes: Infinity }, 'not measured yet');
  assert.deepEqual(link(8e6, 85, 'http/1.1').aheadBudget(), { requests: AHEAD_REQUESTS, bytes: Infinity }, 'fast, HTTP/1.1: six connections shared with the game');
  assert.deepEqual(new NetLink({ fixed: true }).aheadBudget(), { requests: AHEAD_REQUESTS, bytes: Infinity }, 'fixed, not measured (local policies)');
  const f = link(8e6, 85).aheadBudget();
  assert.equal(f.requests, AHEAD_REQUESTS_MAX);
  assert.equal(f.bytes, Math.round(AHEAD_BDP * 8e6 * 0.085), 'two bandwidth-delay products');
  assert.equal(link(3.5e6, 10).aheadBudget().bytes, AHEAD_BYTES_MIN, 'a short round trip: a mid link\'s pieces at least');
});

test('fast HTTP/2 link: the learned pieces ahead keep about two bandwidth-delay products in flight, AHEAD_REQUESTS_MID pieces at least; none asked twice', { timeout: 20000 }, () => withFetch(async (calls) => {
  for (const [bw, rtt] of [[8e6, 85], [3.5e6, 20], [40e6, 150]]) {
    calls.length = 0;
    const store = new MemStore(), net = link(bw, rtt);
    const b = new HttpBackend('/game/a/', tree(), { store, net });
    b.fillBackground = () => {}; b.noteMiss = () => {};
    let stopped = false;
    // (40 learned entries, one 64 KiB piece of each: a map's small files)
    b.prefetch(Array.from({ length: 40 }, (_, i) => ['f.big', i, 0b1, i]), {}, () => stopped);
    try {
      await tick();
      b.chunks.set('f.big#0', bytes(0, CHUNK)); b.chunkBytes += CHUNK;
      b.open('f.big').read(10, 10); // (the game reads entry 0: the next entries' pieces go ahead)
      await tick(30);
      const ahead = calls.filter((c) => c.end - c.start === CHUNK);
      const wanted = () => { const { bytes: budget } = net.aheadBudget(); let n = 0; while (n < AHEAD_REQUESTS_MAX && (n < AHEAD_REQUESTS || n * CHUNK < budget)) n++; return n; };
      const want = wanted();
      assert.equal(ahead.length, want, `${bw / 1e6} MB/s, ${rtt} ms: ${want} requests ahead`);
      assert.equal(b.learned.inBytes, want * CHUNK);
      // (the whole-block pass beside them: never the same bytes at once)
      const seen = new Set();
      for (const c of calls) for (let p = Math.floor(c.start / CHUNK); p * CHUNK < c.end; p++) { assert.ok(!seen.has(p), `piece ${p} asked twice`); seen.add(p); }
      // (one comes: its bytes counted down, another goes — or waits for its turn on the link — within the budget as the
      // link is measured again: here its round trip, the fake answer's, shorter — AHEAD_REQUESTS_MID still at least)
      ahead[0].release(); await tick(30);
      assert.equal(b.learned.inBytes, b.learned.inFlight * CHUNK);
      assert.ok(want >= AHEAD_REQUESTS_MID && b.learned.inFlight >= AHEAD_REQUESTS_MID && b.learned.inFlight <= want);
    } finally { stopped = true; for (const c of calls) c.release(); await tick(30); for (const c of calls) c.release(); }
  }
}));

test('a mid link keeps AHEAD_REQUESTS_MID ahead, a fast HTTP/1.1 one AHEAD_REQUESTS', { timeout: 20000 }, () => withFetch(async (calls) => {
  for (const [net, want] of [[link(1.8e6), AHEAD_REQUESTS_MID], [link(8e6, 85, 'http/1.1'), AHEAD_REQUESTS]]) {
    calls.length = 0;
    const b = new HttpBackend('/game/a/', tree(), { store: new MemStore(), net });
    b.fillBackground = () => {}; b.noteMiss = () => {};
    let stopped = false;
    b.lastSyncFetchAt = performance.now() + 1e9; // (the learned pass waits on a link that is not fast)
    b.prefetch(Array.from({ length: 40 }, (_, i) => ['f.big', i, 0b1, i]), {}, () => stopped);
    try {
      await tick();
      b.chunks.set('f.big#0', bytes(0, CHUNK)); b.chunkBytes += CHUNK;
      b.open('f.big').read(10, 10);
      await tick(30);
      assert.equal(b.learned.inFlight, want);
    } finally { stopped = true; for (const c of calls) c.release(); await tick(30); for (const c of calls) c.release(); }
  }
}));

test('fast link: a block the whole-block pass downloads is on its way — the pieces ahead skip it, a parked read joins it', { timeout: 20000 }, () => withFetch(async (calls) => {
  const store = new MemStore();
  const b = new HttpBackend('/game/a/', tree(), { store, net: link(8e6, 85) });
  b.fillBackground = () => {}; b.noteMiss = () => {};
  let stopped = false;
  const pf = b.prefetch([['f.big', 3, 0xffff, 0]], {}, () => stopped);
  try {
    for (let i = 0; i < 250 && !calls.length; i++) await tick(20);
    assert.deepEqual(calls.map((c) => [c.start / BLOCK, c.end / BLOCK]), [[3, 4]], 'the whole block');
    assert.ok(b.blockFlights.has('f.big#3'), 'registered as on its way');
    // (the game reads in it: it waits for that request rather than asking its bytes again)
    const read = b.fetchAhead('f.big', SIZE, 1, 3 * BLOCK + 10, 3 * BLOCK + 20, false);
    await tick(30);
    assert.equal(calls.length, 1, 'no second request for the same bytes');
    calls[0].release();
    await read; await pf;
    assert.ok(store.m.has(`f.big#${SIZE}#1#3`), 'stored');
    assert.ok(!b.blockFlights.has('f.big#3'), 'no longer on its way');
    assert.equal(calls.length, 1);
  } finally { stopped = true; for (const c of calls) c.release(); }
}));

test('fast HTTP/2 link: whole learned blocks ahead stay bounded by bytes — AHEAD_REQUESTS of them, as before, not a count of pieces', { timeout: 20000 }, () => withFetch(async (calls) => {
  const net = link(8e6, 85), b = new HttpBackend('/game/a/', tree(), { store: new MemStore(), net });
  b.fillBackground = () => {}; b.noteMiss = () => {};
  let stopped = false;
  b.lastSyncFetchAt = performance.now() + 1e9; // (the game busy: the whole-block pass beside it one request at most)
  b.prefetch(Array.from({ length: 40 }, (_, i) => ['f.big', i, 0xffff, i]), {}, () => stopped);
  try {
    await tick();
    b.chunks.set('f.big#0', bytes(0, CHUNK)); b.chunkBytes += CHUNK;
    b.open('f.big').read(10, 10);
    await tick(30);
    const blocks = calls.filter((c) => c.end - c.start === BLOCK && b.flights.has(`f.big#${c.start / CHUNK}`));
    assert.ok(3 * BLOCK > net.aheadBudget().bytes, 'three blocks past the budget');
    assert.equal(blocks.length, AHEAD_REQUESTS);
    assert.equal(b.learned.inFlight, AHEAD_REQUESTS);
  } finally { stopped = true; for (const c of calls) c.release(); await tick(30); for (const c of calls) c.release(); }
}));

test('fast link: a whole-block pass request still waiting for its turn is given up to the pieces ahead; a started one is skipped', { timeout: 20000 }, () => withFetch(async (calls) => {
  const net = link(8e6, 85), b = new HttpBackend('/game/a/', tree(), { store: new MemStore(), net });
  b.fillBackground = () => {}; b.noteMiss = () => {};
  let stopped = false;
  // (the link's turns closed to whole blocks: the pass's requests wait in NetLink.waiters, as behind a load's reads)
  const mayStart = net.mayStart.bind(net); let open = false;
  net.mayStart = (...a) => (open || a[2] < BLOCK ? mayStart(...a) : false);
  b.prefetch([['f.big', 0, 0b1, 0], ['f.big', 5, 0b11, 1], ['f.big', 9, 0b1, 2]], {}, () => stopped);
  try {
    for (let i = 0; i < 100 && !b.blockFlights.has('f.big#5'); i++) await tick(10);
    const pass = b.blockFlights.get('f.big#5');
    assert.ok(pass && net.waiters.includes(pass.w), 'the pass\'s block 5 queued');
    b.chunks.set('f.big#0', bytes(0, CHUNK)); b.chunkBytes += CHUNK;
    b.open('f.big').read(10, 10);
    await tick(30);
    assert.ok(!net.waiters.includes(pass.w) && b.blockFlights.get('f.big#5') !== pass, 'given up');
    const p5 = calls.filter((c) => c.start >= 5 * BLOCK && c.start < 6 * BLOCK);
    assert.deepEqual(p5.map((c) => [c.start, c.end]), [[5 * BLOCK, 5 * BLOCK + 2 * CHUNK]], 'its learned pieces go ahead, once');
  } finally { stopped = true; open = true; for (const c of calls) c.release(); await tick(30); for (const c of calls) c.release(); }
}));

test('fast link: a read that joined the whole-block pass\'s request finds its block in memory though the store dropped it', { timeout: 20000 }, () => withFetch(async (calls) => {
  const store = new MemStore(); store.put = () => {}; // (full: every block dropped)
  const b = new HttpBackend('/game/a/', tree(), { store, net: link(8e6, 85) });
  b.fillBackground = () => {}; b.noteMiss = () => {};
  let stopped = false;
  const pf = b.prefetch([['f.big', 3, 0xffff, 0]], {}, () => stopped);
  try {
    for (let i = 0; i < 250 && !calls.length; i++) await tick(20);
    const read = b.fetchAhead('f.big', SIZE, 1, 3 * BLOCK + 10, 3 * BLOCK + 20, false);
    await tick(30);
    calls[0].release();
    await read; await pf;
    assert.equal(calls.length, 1, 'no second request after the wait');
    assert.ok(b.cache.has('f.big#3'), 'in memory');
  } finally { stopped = true; for (const c of calls) c.release(); }
}));
