// HTTP game file backend on a measured fast link with a real round trip (docs/slow-network.md "A fast link far away"):
// the learned prefetch keeps several requests in flight (one while the game reads from the network), a game read
// does not abort the background downloads in flight, and one read covering several whole blocks none of which is here
// fetches them in one request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend, BLOCK } from '../src/vfs/http-backend.js';
import { NetLink } from '../src/vfs/net-link.js';

const SIZE = 12 * BLOCK + 5000;
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
    const call = { start: +a, end: +b + 1, bg: !!init.signal, signal: init.signal, settled: false,
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
/** a link measured at 7 MB/s with a 75 ms round trip (as the owner's) */
const fastFar = () => { const net = new NetLink({ bw: 7e6 }); net.measured = true; net.rtt = 75; return net; };

test('fast link far away: the learned prefetch keeps several requests in flight, one while the game reads from the network', { timeout: 20000 }, () => withFetch(async (calls) => {
  const store = new MemStore();
  const b = new HttpBackend('/game/a/', tree(), { store, net: fastFar() });
  const list = [0, 2, 4, 6, 8, 10].map((i) => ['f.big', i, 0xffff, i]);
  const progress = {};
  let stopped = false; // (a failed assertion leaves no prefetch loop running: the test file ends)
  const pf = b.prefetch(list, progress, () => stopped);
  const until = async (ok) => { for (let i = 0; i < 250 && !ok(); i++) await tick(20); };
  try {
  await until(() => calls.length >= 3); await tick(30);
  assert.equal(calls.length, 3, 'three requests side by side');
  assert.deepEqual(calls.map((c) => c.start / BLOCK), [0, 2, 4], 'in the learned order, none twice');
  b.fgPending = 1; // (the game waits for a read from the network: one request at a time meanwhile)
  calls[0].release(); calls[1].release();
  await tick(150);
  assert.equal(calls.length, 3, 'none more while one is in flight and the game reads');
  calls[2].release();
  await until(() => calls.length >= 4); await tick(150);
  assert.equal(calls.length, 4, 'one at a time while the game reads');
  b.fgPending = 0;
  await until(() => calls.length >= 6);
  assert.equal(calls.length, 6);
  for (const c of calls) c.release();
  await pf;
  } finally { stopped = true; for (const c of calls) c.release(); }
  assert.equal(progress.done, true);
  for (const i of [0, 2, 4, 6, 8, 10]) assert.ok(store.m.has(`f.big#${SIZE}#1#${i}`), `block ${i} stored`);
}));

test('fast link far away: a game read leaves the background downloads in flight alone (a link not measured aborts them)', { timeout: 20000 }, () => withFetch(async (calls) => {
  for (const [net, aborted] of [[fastFar(), false], [new NetLink({ fixed: true }), true]]) {
    calls.length = 0;
    const store = new MemStore();
    const b = new HttpBackend('/game/a/', tree(), { store, net }); b.noteMiss = () => {};
    let stopped = false;
    const pf = b.prefetch([['f.big', 3, 0xffff, 0]], {}, () => stopped);
    try {
    for (let i = 0; i < 250 && !calls.length; i++) await tick(20);
    assert.equal(calls.length, 1);
    const ahead = b.fetchAhead('f.big', SIZE, 1, 8 * BLOCK, 8 * BLOCK + 10, false);
    assert.equal(calls[0].signal.aborted, aborted);
    for (const c of calls) c.release();
    await ahead; await tick(20);
    for (const c of calls) c.release();
    for (let i = 0; i < 250 && !store.m.has(`f.big#${SIZE}#1#3`); i++) { await tick(20); for (const c of calls) c.release(); }
    await pf;
    assert.ok(store.m.has(`f.big#${SIZE}#1#3`), 'the prefetched block made it');
    } finally { stopped = true; for (const c of calls) c.release(); }
  }
}));

test('a read covering several whole blocks none of which is here: one request (then by blocks where something is here)', () => {
  syncReqs.length = 0;
  const b = new HttpBackend('/game/a/', tree(), { net: fastFar() });
  b.noteMiss = () => {}; b.fillBackground = async () => {};
  const f = b.open('f.big');
  assert.deepEqual(f.read(0, 5 * BLOCK), bytes(0, 5 * BLOCK));
  assert.deepEqual(syncReqs, [[0, 5 * BLOCK]], 'five blocks in one request');
  // a piece of block 7 here already: blocks 5-6 together, then block 7 by its missing pieces, blocks 8-11 and the tail together
  syncReqs.length = 0;
  f.read(7 * BLOCK + 100, 10); // (a random read: block 7's first piece)
  syncReqs.length = 0;
  assert.deepEqual(b.open('f.big').read(5 * BLOCK, SIZE - 5 * BLOCK), bytes(5 * BLOCK, SIZE));
  assert.deepEqual(syncReqs[0], [5 * BLOCK, 7 * BLOCK]);
  assert.deepEqual(syncReqs.at(-1), [8 * BLOCK, SIZE], 'the last blocks and the tail in one');
});
