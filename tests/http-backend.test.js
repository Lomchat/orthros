// HTTP game file backend: block reads, read-ahead, and the persistent block store (OPFS in pages, an
// in-memory stand-in here): fetched blocks are stored under the file's size/mtime, a later backend reads
// them without any request, a changed file misses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpBackend } from '../src/vfs/http-backend.js';

const MiB = 1 << 20;
const FILE = Uint8Array.from({ length: 3 * MiB + 1234 }, (_, i) => (i * 7 + (i >> 11)) & 0xff);
const requests = [];
const faults = []; // injected failures of the next requests: 'network' | 'status' | 'short'
// synchronous XHR stand-in serving FILE for range requests
globalThis.XMLHttpRequest = class {
  open(method, url) { this.url = url; }
  setRequestHeader(k, v) { this.range = v; }
  send() {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range);
    requests.push([this.url, +a, +b]);
    const fault = faults.shift();
    if (fault === 'network') throw new Error('NetworkError');
    this.status = fault === 'status' ? 502 : 206; this.response = FILE.slice(+a, fault === 'short' ? +a + 100 : +b + 1).buffer;
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

test('http backend: a failed range request (network error, error status, short answer) is retried, then fails the read', () => {
  const retries = [];
  const b = new HttpBackend('/game/r/', tree(1), { retryWaits: [1, 1, 1], onRetry: (r) => retries.push(r.problem) });
  faults.push('network', 'status', 'short');
  assert.deepEqual(b.open('Data/a.big').read(5, 10), FILE.subarray(5, 15));
  assert.deepEqual(retries, ['NetworkError', 'status 502', '100 bytes of 1048576']);
  faults.push('status', 'status', 'status', 'status');
  assert.throws(() => b.open('Data/a.big').read(2 * MiB, 10), /range request failed \(status 502\)/);
  faults.length = 0;
});

// The server's compressed ranges (/gamez/<manifest>/<path>?r=start-end): the exact bytes, zstd or gzip encoded when
// the client accepts it and it saves enough, plain otherwise; the backend requests them without a Range header.
test('server: compressed ranges carry the exact bytes (zstd, gzip, identity), and the backend asks for them', async () => {
  const fs = await import('node:fs'), zlib = await import('node:zlib'), path = await import('node:path'), os = await import('node:os'), http = await import('node:http'), crypto = await import('node:crypto');
  const { createServer } = await import('../src/host/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-gamez-'));
  const text = Buffer.from('the same line again and again\n'.repeat(40000)); // compressible
  const noise = crypto.randomBytes(300000); // incompressible
  fs.writeFileSync(path.join(dir, 'Text.dat'), text); fs.writeFileSync(path.join(dir, 'noise.bin'), noise);
  fs.mkdirSync(path.join(dir, 'man')); fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  const server = createServer({ manifests: path.join(dir, 'man') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = async (url, enc) => { const r = await new Promise((res, rej) => http.get(url, { headers: { 'accept-encoding': enc } }, res).on('error', rej)); const parts = []; for await (const d of r) parts.push(d); return { r, body: Buffer.concat(parts) }; };
    for (const [enc, want] of [['zstd, gzip', 'zstd'], ['gzip', 'gzip'], ['', undefined]]) {
      const { r, body } = await get(`${base}/gamez/g/text.dat?r=1000-700000`, enc);
      assert.equal(r.headers['content-encoding'], want, `encoding for "${enc}"`);
      const plain = want === 'zstd' ? zlib.zstdDecompressSync(body) : want === 'gzip' ? zlib.gunzipSync(body) : body;
      assert.deepEqual(plain, text.subarray(1000, 700000));
    }
    const { r, body } = await get(`${base}/gamez/g/noise.bin?r=5-299999`, 'zstd');
    assert.equal(r.headers['content-encoding'], undefined, 'incompressible range sent as is');
    assert.deepEqual(body, noise.subarray(5, 299999));
    assert.equal((await get(`${base}/gamez/g/noise.bin?r=10-5`, 'zstd')).r.statusCode, 416);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  // the backend: no Range header, the range in the URL
  const b = new HttpBackend('/game/x/', tree(1), { encoded: true });
  const seen = [];
  const Real = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class { open(m, url) { this.url = url; } setRequestHeader(k) { seen.push(k); } send() { const [, a, e] = /\?r=(\d+)-(\d+)$/.exec(this.url); this.status = 200; this.response = FILE.slice(+a, +e).buffer; } };
  try {
    assert.deepEqual(b.open('Data/a.big').read(MiB - 3, 10), FILE.subarray(MiB - 3, MiB + 7));
    assert.deepEqual(seen, []);
  } finally { globalThis.XMLHttpRequest = Real; }
});

// Learned prefetch: the server records, per session, the blocks read synchronously (not the prefetch requests) with
// the earliest time they were needed, and lists them in that order; the backend downloads the listed blocks it does
// not hold into its store in the background, and later reads are served from the store.
test('learned prefetch: the server orders the blocks sessions needed; the backend downloads them ahead', async () => {
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os'), http = await import('node:http');
  const { createServer } = await import('../src/host/server.js');
  const { MemBlockStore } = await import('../src/vfs/opfs-store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-learn-'));
  fs.writeFileSync(path.join(dir, 'a.big'), FILE);
  fs.mkdirSync(path.join(dir, 'man')); fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  const learnDir = path.join(dir, 'learn');
  fs.mkdirSync(learnDir);
  const server = createServer({ manifests: path.join(dir, 'man'), learnDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (u) => { const r = await new Promise((res, rej) => http.get(base + u, res).on('error', rej)); const parts = []; for await (const d of r) parts.push(d); return Buffer.concat(parts); };
  try {
    // session s1 reads block 3 then block 1; session s2 reads block 1 first, then 0 (a prefetch request is not counted)
    await get(`/gamez/g/a.big?r=${3 * MiB}-${3 * MiB + 10}&s=s1`);
    await new Promise((r) => setTimeout(r, 30));
    await get(`/gamez/g/a.big?r=${MiB}-${MiB + 10}&s=s1`);
    await get(`/gamez/g/a.big?r=${2 * MiB}-${2 * MiB + 10}&p=1`);
    await get(`/gamez/g/a.big?r=${MiB + 5}-${MiB + 9}&s=s2`);
    await get(`/gamez/g/a.big?r=0-4&s=s2`);
    const list = JSON.parse(await get('/api/prefetch/g'));
    assert.deepEqual(list.map(([, b]) => b).slice(0, 2).sort(), [1, 3], 'both sessions start at t=0: blocks 1 and 3 first');
    assert.deepEqual(new Set(list.map(([p, b]) => `${p}#${b}`)), new Set(['a.big#0', 'a.big#1', 'a.big#3']), 'the prefetch request was not learned');
  } finally { server.close(); }
  // the backend: the listed blocks into the store, in order, then reads without requests
  const realFetch = globalThis.fetch, fetched = [];
  globalThis.fetch = async (url) => { const [, a, e] = /\?r=(\d+)-(\d+)/.exec(url); assert.match(url, /&p=1$/); fetched.push([+a, +e]); return { status: 200, arrayBuffer: async () => FILE.slice(+a, +e).buffer }; };
  try {
    const store = new MemBlockStore();
    const b = new HttpBackend('/game/g/', { dirs: {}, files: { 'a.big': { size: FILE.length, mtime: 7 } } }, { store, encoded: true });
    const progress = {};
    await b.prefetch([['a.big', 3], ['a.big', 0], ['a.big', 1], ['missing.big', 0]], progress);
    assert.equal(progress.done, true);
    assert.deepEqual(fetched, [[3 * MiB, FILE.length], [0, 2 * MiB]], 'block 3 (partial), then blocks 0-1 in one request');
    const n = requests.length;
    assert.deepEqual(b.open('a.big').read(MiB - 5, 10), FILE.subarray(MiB - 5, MiB + 5));
    assert.equal(requests.length, n, 'served from the store');
  } finally { globalThis.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }); }
});

// The OPFS block store (synchronous access handles, faked in memory here): every block carries a checksum written with
// it; a block that does not read back as written is dropped and reported; an index of the earlier format (no checksums)
// empties the store.
test('block store: checksummed blocks, a damaged block dropped, an earlier-format store emptied', async () => {
  const { OpfsBlockStore } = await import('../src/vfs/opfs-store.js');
  class FakeHandle {
    constructor() { this.b = new Uint8Array(0); }
    getSize() { return this.b.length; }
    read(out, { at }) { const n = Math.max(0, Math.min(out.length, this.b.length - at)); out.set(this.b.subarray(at, at + n)); return n; }
    write(src, { at }) { if (at + src.length > this.b.length) { const nb = new Uint8Array(at + src.length); nb.set(this.b); this.b = nb; } this.b.set(src, at); return src.length; }
    truncate(n) { this.b = this.b.slice(0, n); }
    flush() {} close() {}
  }
  const files = new Map();
  const dir = { getFileHandle: async (name) => ({ createSyncAccessHandle: async () => { if (!files.has(name)) files.set(name, new FakeHandle()); return files.get(name); } }) };
  const realNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) } }, configurable: true });
  try {
    const a = FILE.slice(0, MiB), b = FILE.slice(MiB, 2 * MiB);
    let s = await OpfsBlockStore.open('x');
    s.put('f#1#0#0', a); s.put('f#1#0#1', b); s.flush();
    s = await OpfsBlockStore.open('x'); // a later run
    assert.equal(s.resetReason, null);
    assert.deepEqual(s.get('f#1#0#0'), a);
    files.get('blocks.bin').b[MiB + 12345] ^= 0x40; // one byte of the second block changes on disk
    const bad = []; s.onCorrupt = (k) => bad.push(k);
    assert.equal(s.get('f#1#0#1'), null, 'damaged block not returned');
    assert.deepEqual(bad, ['f#1#0#1']);
    assert.equal(s.map.has('f#1#0#1'), false, 'and forgotten (fetched again)');
    // an index of the earlier format: the store starts over
    files.get('index.json').b = new TextEncoder().encode(JSON.stringify([['f#1#0#0', 0, MiB]]));
    s = await OpfsBlockStore.open('x');
    assert.equal(s.resetReason, 'an earlier format without block checksums');
    assert.equal(s.map.size, 0);
    assert.equal(files.get('blocks.bin').getSize(), 0, 'data file emptied');
  } finally { if (realNav) Object.defineProperty(globalThis, 'navigator', realNav); else delete globalThis.navigator; }
});
