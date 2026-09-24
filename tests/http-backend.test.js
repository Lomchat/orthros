// HTTP game file backend: block reads, read-ahead, and the persistent block store (OPFS in pages, an
// in-memory stand-in here): fetched blocks are stored under the file's size/mtime, a later backend reads
// them without any request, a changed file misses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend } from '../src/vfs/http-backend.js';

const MiB = 1 << 20;
const FILE = Uint8Array.from({ length: 3 * MiB + 1234 }, (_, i) => (i * 7 + (i >> 11)) & 0xff);
const requests = [];
// synchronous XHR stand-in serving FILE for range requests
globalThis.XMLHttpRequest = class {
  open(method, url) { this.url = url; }
  setRequestHeader(k, v) { this.range = v; }
  send() {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range);
    requests.push([this.url, +a, +b]);
    this.status = 206; this.response = FILE.slice(+a, +b + 1).buffer;
  }
};

class MemStore {
  constructor() { this.m = new Map(); this.failed = false; }
  get map() { return this.m; }
  get(k) { return this.m.get(k)?.slice() ?? null; }
  put(k, b) { if (!this.m.has(k)) this.m.set(k, b.slice()); }
  flush() {}
}
const tree = (mtime) => ({ dirs: { Data: { files: { 'a.big': { size: FILE.length, mtime } } } }, files: {} });

test('http backend: reads through the block cache and the persistent store', () => {
  const store = new MemStore();
  const b1 = new HttpBackend('/game/x/', tree(5), { store });
  const f = b1.open('data\\A.BIG');
  assert.deepEqual(f.read(MiB - 10, 30), FILE.subarray(MiB - 10, MiB + 20)); // spans two blocks
  assert.equal(requests.length, 2);
  assert.equal(store.m.size, 2);
  // sequential reads fetch ahead in one request, every block stored
  assert.deepEqual(f.read(MiB + 20, 2 * MiB), FILE.subarray(MiB + 20, 3 * MiB + 20));
  assert.equal(requests.length, 3);
  assert.equal(store.m.size, 4);
  // a new backend (a later run) reads everything from the store
  const n = requests.length;
  const b2 = new HttpBackend('/game/x/', tree(5), { store });
  assert.deepEqual(b2.open('Data/a.big').read(0, FILE.length), FILE);
  assert.equal(requests.length, n);
  // the file changed on the server (mtime): no stale block
  const b3 = new HttpBackend('/game/x/', tree(6), { store });
  b3.open('Data/a.big').read(0, 16);
  assert.equal(requests.length, n + 1);
});

test('http backend: the offline copy downloads every block into the store, then nothing is requested', async () => {
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, init) => { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range); fetched.push([+a, +b]); return { status: 206, arrayBuffer: async () => FILE.slice(+a, +b + 1).buffer }; };
  try {
    const store = new MemStore(), progress = {};
    const b = new HttpBackend('/game/z/', tree(9), { store });
    await b.downloadAll(progress);
    assert.equal(progress.done, true);
    assert.equal(progress.bytes, FILE.length);
    assert.equal(store.m.size, 4); // 3 MiB + a partial block
    const n = requests.length;
    const b2 = new HttpBackend('/game/z/', tree(9), { store });
    assert.deepEqual(b2.open('Data/a.big').read(0, FILE.length), FILE);
    assert.equal(requests.length, n, 'no synchronous request after the offline copy');
    await b.downloadAll(progress); // already complete: nothing fetched again
    assert.equal(fetched.length, 1);
  } finally { globalThis.fetch = realFetch; }
});
