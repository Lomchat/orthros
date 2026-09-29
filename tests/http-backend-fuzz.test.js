// Randomized exactness check of the HTTP game file backend: every read must return exactly the file's bytes, whatever
// mix of 64 KiB pieces, whole blocks, background downloads (completing, failing or aborted at random moments),
// asynchronous prepare() fetches, the persistent store (shared by two versions of the files: another mtime), the
// offline copy, the prefetch and injected range request failures. FUZZ_SEEDS=n runs more seeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const SIZES = { 'a.big': 3 * BLOCK + 12345, 'b.big': BLOCK - 1000, 'c.big': 2 * BLOCK, 'd.big': 5 * CHUNK + 7, 'e.big': 0, 'f.big': 1, 'g.big': BLOCK + CHUNK };
const NAMES = Object.keys(SIZES);
/** two versions of the folder: /game/v7/ (mtime 7) and /game/v8/ (mtime 8, other bytes, same sizes) */
const VERSIONS = { 7: {}, 8: {} };
for (const [n, size] of Object.entries(SIZES)) {
  const r = rng(size + n.charCodeAt(0));
  VERSIONS[7][n] = Uint8Array.from({ length: size }, () => (r() * 256) | 0);
  VERSIONS[8][n] = VERSIONS[7][n].map((x, i) => x ^ (1 + (i % 251)));
}
const fileOfUrl = (url) => { const m = /\/game\/v(\d+)\/Data\/([^/?]+)/.exec(url); return VERSIONS[m[1]][decodeURIComponent(m[2])]; };

class MemStore {
  constructor() { this.m = new Map(); this.failed = false; }
  get map() { return this.m; }
  get(k) { return this.m.get(k)?.slice() ?? null; }
  put(k, b) { if (!this.m.has(k)) this.m.set(k, b.slice()); }
  drop(k) { this.m.delete(k); }
  flush() {}
}

async function run(seed) {
  const R = rng(seed), ri = (n) => Math.floor(R() * n);
  const xhrFaults = [];
  const pending = []; // fetches (background, prefetch, offline copy, prepare) not answered yet
  const realXhr = globalThis.XMLHttpRequest, realFetch = globalThis.fetch, realNow = performance.now;
  let clock = 0;
  performance.now = () => (clock += 1000); // (every wait for a quiet network passes at once)
  globalThis.XMLHttpRequest = class {
    open(m, url) { this.url = url; }
    setRequestHeader(k, v) { this.range = v; }
    send() {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range), data = fileOfUrl(this.url);
      const fault = xhrFaults.shift();
      if (fault === 'network') throw new Error('NetworkError');
      if (fault === 'full') { this.status = 200; this.response = data.slice().buffer; return; } // (a server ignoring Range)
      this.status = fault === 'status' ? 503 : 206;
      this.response = data.slice(+a, fault === 'short' ? +a + Math.floor((+b - +a) / 2) : +b + 1).buffer;
    }
  };
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range), data = fileOfUrl(url);
    const p = { resolve, reject, a: +a, b: +b, data };
    init.signal?.addEventListener('abort', () => { const i = pending.indexOf(p); if (i >= 0) pending.splice(i, 1); reject(new Error('AbortError')); });
    pending.push(p);
  });
  const settle = (p) => {
    const k = R();
    if (k < 0.08) p.reject(new Error('NetworkError'));
    else if (k < 0.14) p.resolve({ status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    else if (k < 0.2) p.resolve({ status: 206, arrayBuffer: async () => p.data.slice(p.a, p.a + Math.floor((p.b - p.a) / 2)).buffer });
    else if (k < 0.25) p.resolve({ status: 200, arrayBuffer: async () => p.data.slice().buffer });
    else p.resolve({ status: 206, arrayBuffer: async () => p.data.slice(p.a, p.b + 1).buffer });
  };
  const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  const settleSome = async () => { for (let n = ri(3); n > 0 && pending.length; n--) settle(pending.splice(ri(pending.length), 1)[0]); await tick(); };
  let sides = [], finished = false;
  try {
    const store = R() < 0.7 ? new MemStore() : null;
    const tree = (mtime) => ({ dirs: { Data: { files: Object.fromEntries(Object.entries(SIZES).map(([n, size]) => [n, { size, mtime }])) } }, files: {} });
    const cacheBlocks = 1 + ri(10); // (down to a cache smaller than the read-ahead)
    sides = [7, 8].map((v) => {
      const b = new HttpBackend(`/game/v${v}/`, tree(v), { store, cacheBlocks, retryWaits: [0, 0] });
      return { v, b, files: VERSIONS[v], handles: NAMES.map((n) => b.open(`Data/${n}`)), offline: null };
    });
    const doRead = (s, fi, off, len) => {
      const name = NAMES[fi], data = s.files[name];
      let fail = false;
      if (R() < 0.1) { const k = ri(4); if (k === 3) { xhrFaults.push('status', 'status', 'status'); fail = true; } else xhrFaults.push(['network', 'status', 'short', 'full'][k]); }
      let got;
      try { got = s.handles[fi].read(off, len); } catch (e) { if (!fail) throw e; xhrFaults.length = 0; return; }
      xhrFaults.length = 0;
      const end = Math.min(off + len, data.length), want = off >= end ? new Uint8Array(0) : data.subarray(off, end);
      assert.equal(got.length, want.length, `seed ${seed}: v${s.v} ${name} @${off} +${len}: ${got.length} bytes, not ${want.length}`);
      assert.ok(Buffer.from(got).equals(Buffer.from(want)), `seed ${seed}: v${s.v} ${name} @${off} +${len}: wrong bytes`);
    };
    const randRange = (size) => {
      const off = R() < 0.05 ? size + ri(10) : ri(size + 1);
      const k = R(); const len = k < 0.05 ? 0 : k < 0.5 ? 1 + ri(4096) : k < 0.85 ? 1 + ri(3 * CHUNK) : 1 + ri(3 * BLOCK);
      return [off, len];
    };
    for (let step = 0; step < 400; step++) {
      const s = sides[R() < 0.75 ? 0 : 1], op = R(), fi = ri(NAMES.length), size = SIZES[NAMES[fi]];
      if (op < 0.35) doRead(s, fi, ...randRange(size));
      else if (op < 0.55) { // a sequential run (a stream or a file read whole)
        let [off] = randRange(size); const piece = R() < 0.5 ? 4096 : 1 + ri(200000);
        for (let i = 0, n = 1 + ri(40); i < n; i++) { doRead(s, fi, off, piece); off += piece; if (R() < 0.2) await settleSome(); }
      } else if (op < 0.75) { // an asynchronous read: prepare, answer the fetches (or not), meanwhile other reads, then the read
        const [off, len] = randRange(size);
        const p = s.handles[fi].prepare(off, len);
        if (p) {
          let done = false; p.then(() => { done = true; });
          for (let i = 0; i < 50 && !done; i++) { if (R() < 0.3) { const g = ri(NAMES.length); doRead(sides[ri(2)], g, ...randRange(SIZES[NAMES[g]])); } await settleSome(); }
        }
        doRead(s, fi, off, len);
      } else if (op < 0.99) await settleSome();
      else if (store && op < 0.995) { // the prefetch of blocks an earlier session needed
        const list = []; for (let i = 0, n = 1 + ri(8); i < n; i++) { const f = ri(NAMES.length); list.push([`Data/${NAMES[f]}`, ri(Math.ceil(SIZES[NAMES[f]] / BLOCK) + 1)]); }
        s.b.prefetch(list, {}, () => finished || R() < 0.01);
      } else if (store && !s.offline) { s.offline = {}; s.b.downloadAll(s.offline, () => finished); }
      // invariants: every piece, block and stored block holds its version's bytes
      if (step % 25 !== 24) continue;
      for (const { b, files } of sides) {
        let bytes = 0;
        for (const [k, v] of b.chunks) {
          const c = +k.slice(k.lastIndexOf('#') + 1), d = files[k.slice(0, k.lastIndexOf('#')).split('/').pop()];
          bytes += v.length;
          assert.ok(Buffer.from(v).equals(Buffer.from(d.subarray(c * CHUNK, c * CHUNK + CHUNK))), `seed ${seed}: piece ${k}`);
        }
        assert.equal(b.chunkBytes, bytes, `seed ${seed}: piece byte count`);
        for (const [k, v] of b.cache) {
          const i = +k.slice(k.lastIndexOf('#') + 1), d = files[k.slice(0, k.lastIndexOf('#')).split('/').pop()];
          assert.ok(Buffer.from(v).equals(Buffer.from(d.subarray(i * BLOCK, i * BLOCK + BLOCK))), `seed ${seed}: block ${k}`);
        }
      }
      if (store) for (const [k, v] of store.m) {
        const [p, , mtime, i] = k.split('#'), d = VERSIONS[mtime][p.split('/').pop()];
        assert.ok(Buffer.from(v).equals(Buffer.from(d.subarray(+i * BLOCK, +i * BLOCK + BLOCK))), `seed ${seed}: stored ${k}`);
      }
    }
    for (let i = 0; i < 200 && pending.length; i++) { settle(pending.shift()); await tick(); }
    if (process.env.FUZZ_STATS) console.log(seed, sides.map((s) => JSON.stringify(s.b.stats)).join(' '), store?.m.size);
  } finally {
    // (the background loops still running end: nothing wanted, the network quiet, the fetches in flight failed)
    finished = true;
    for (const { b } of sides) { b.want.clear(); b.lastSyncFetchAt = -Infinity; }
    for (const p of pending.splice(0)) p.reject(new Error('NetworkError'));
    globalThis.XMLHttpRequest = realXhr; globalThis.fetch = realFetch; performance.now = realNow;
  }
}

test('http backend: a memory cache smaller than the read-ahead (?cache=2) still returns the block just fetched', () => {
  const size = 5 * BLOCK, data = Uint8Array.from({ length: size }, (_, i) => (i * 31) >> 3);
  const realXhr = globalThis.XMLHttpRequest, realFetch = globalThis.fetch;
  globalThis.XMLHttpRequest = class {
    open() {} setRequestHeader(k, v) { this.range = v; }
    send() { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range); this.status = 206; this.response = data.slice(+a, +b + 1).buffer; }
  };
  delete globalThis.fetch;
  try {
    const b = new HttpBackend('/game/small/', { dirs: {}, files: { x: { size, mtime: 1 } } }, { cacheBlocks: 2 });
    const f = b.open('x');
    f.read(0, BLOCK);
    // sequential: 4 blocks fetched in one request, the first of them evicted at once by the 2-block cache
    assert.ok(Buffer.from(f.read(BLOCK, 3 * BLOCK)).equals(Buffer.from(data.subarray(BLOCK, 4 * BLOCK))));
  } finally { globalThis.XMLHttpRequest = realXhr; if (realFetch) globalThis.fetch = realFetch; }
});

test('http backend (randomized): pieces evicted in the middle of a read (past 64 MiB of pieces) — the read stays exact', () => {
  const size = 72 * BLOCK + 777, data = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) data[i] = (i >>> 12) & 0xff, data[i + 1] = (i >>> 20) & 0xff;
  for (let i = 0; i < size; i++) data[i] ^= i & 0xff;
  const realXhr = globalThis.XMLHttpRequest, realFetch = globalThis.fetch;
  globalThis.XMLHttpRequest = class {
    open() {} setRequestHeader(k, v) { this.range = v; }
    send() { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range); this.status = 206; this.response = data.slice(+a, +b + 1).buffer; }
  };
  delete globalThis.fetch; // (no background downloads: the pieces pile up)
  try {
    const b = new HttpBackend('/game/big/', { dirs: {}, files: { 'x.bin': { size, mtime: 1 } } }, { cacheBlocks: 8 });
    const f = b.open('x.bin'), R = rng(99), ri = (n) => Math.floor(R() * n);
    for (let i = 0; i < +(process.env.EVN ?? 4000); i++) {
      const off = ri(size), len = R() < 0.5 ? 1 + ri(3 * CHUNK) : 1 + ri(200), got = f.read(off, len);
      const want = data.subarray(off, Math.min(size, off + len));
      assert.ok(Buffer.from(got).equals(Buffer.from(want)), `@${off} +${len}`);
      if (i % 3 === 0) f.lastEnd = -1; // (random, not a stream)
    }
    assert.ok(b.chunkBytes <= 64 << 20);
  } finally { globalThis.XMLHttpRequest = realXhr; if (realFetch) globalThis.fetch = realFetch; }
});

test('http backend (randomized): reads return exactly the file bytes under pieces, blocks, background fills and failures', async () => {
  const seeds = process.env.FUZZ_SEEDS ? +process.env.FUZZ_SEEDS : 30;
  for (let s = 1; s <= seeds; s++) await run(s * 7919);
});
