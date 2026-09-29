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
  assert.deepEqual(f.read(0, 30), FILE.subarray(0, 30)); // a random read: its 64 KiB piece only
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].slice(1), [0, 65535]);
  assert.equal(store.m.size, 0);
  // sequential reads fetch whole blocks, ahead, in one request, every block stored
  assert.deepEqual(f.read(30, 3 * MiB), FILE.subarray(30, 3 * MiB + 30));
  assert.equal(requests.length, 2);
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
  assert.deepEqual(retries, ['NetworkError', 'status 502', '100 bytes of 65536']);
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

// Learned GL programs: sessions post the programs they built at a draw; the server lists them by earliest use, and a
// key posted again with other sources (the translators changed) takes the new sources.
test('learned programs: listed by first use, new sources replace old ones', async () => {
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os');
  const { createServer } = await import('../src/host/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-programs-'));
  fs.mkdirSync(path.join(dir, 'man')); fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  const server = createServer({ manifests: path.join(dir, 'man') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/programs/g`;
  const post = (programs) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ programs }) });
  try {
    assert.deepEqual(await (await fetch(url)).json(), []);
    assert.equal((await post([{ key: 'b', vs: 'vs-b', fs: 'fs-b', attrs: ['a_pos'], t: 900 }, { key: 'a', vs: 'vs-a', fs: 'fs-a', attrs: [], t: 1200 }, { key: 'bad', vs: 1, fs: 'x', attrs: [] }])).status, 204);
    assert.equal((await post([{ key: 'a', vs: 'vs-a2', fs: 'fs-a', attrs: [], t: 100 }])).status, 204);
    const list = await (await fetch(url)).json();
    assert.deepEqual(list.map((e) => e.key), ['a', 'b'], 'by earliest use, the malformed entry dropped');
    assert.equal(list[0].vs, 'vs-a2', 'the newer sources');
    assert.deepEqual(list[1].attrs, ['a_pos']);
    assert.equal((await fetch(url.replace('/g', '/nope'))).status, 404);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// Learned code regions: sessions post the region entries they translated (module, offset, x87 mode, time); the server
// lists them by earliest use across sessions, module names folded to lower case, malformed entries dropped.
test('learned regions: listed by first use across sessions', async () => {
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os');
  const { createServer } = await import('../src/host/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-regions-'));
  fs.mkdirSync(path.join(dir, 'man')); fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  const server = createServer({ manifests: path.join(dir, 'man') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/regions/g`;
  const post = (regions) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regions }) });
  try {
    assert.equal((await post([['Game.exe', 0x1000, 0x200, 500], ['game.exe', 0x2000, null, 100], ['x.dll', -1, null, 1], ['game.exe', 1.5, null, 1]])).status, 204);
    assert.equal((await post([['GAME.EXE', 0x1000, 0x200, 50]])).status, 204);
    assert.deepEqual(await (await fetch(url)).json(), [['game.exe', 0x1000, 0x200], ['game.exe', 0x2000, null]]);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
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

test('http backend: a random read fetches only its 64 KiB pieces; the whole block follows in the background, stored', async () => {
  const realFetch = globalThis.fetch;
  const fetched = [];
  let release; const gate = new Promise((r) => { release = r; });
  // (only this backend's requests count: a background fill loop an earlier test left may call fetch meanwhile)
  globalThis.fetch = async (url, init) => { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range); if (String(url).startsWith('/game/p/')) fetched.push([+a, +b]); await gate; return { status: 206, arrayBuffer: async () => FILE.slice(+a, +b + 1).buffer }; };
  try {
    const store = new MemStore();
    const b = new HttpBackend('/game/p/', tree(3), { store });
    const f = b.open('Data/a.big'), n = requests.length;
    // a read straddling two pieces and two blocks: one request per block, only the pieces
    assert.deepEqual(f.read(MiB - 70000, 140000), FILE.subarray(MiB - 70000, MiB + 70000));
    assert.deepEqual(requests.slice(n).map((r) => r.slice(1)), [[MiB - 2 * 65536, MiB - 1], [MiB, MiB + 2 * 65536 - 1]]);
    // pieces already here: no request (a later read at another offset is random again)
    f.read(MiB + 1000, 10);
    assert.equal(requests.length, n + 2);
    assert.equal(store.m.size, 0);
    b.lastSyncFetchAt = -1e9; release();
    for (let i = 0; i < 50 && store.m.size < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fetched, [[0, MiB - 1], [MiB, 2 * MiB - 1]]);
    assert.equal(store.m.size, 2);
    assert.equal(b.chunks.size, 0, 'the pieces are dropped once their block is here');
    assert.deepEqual(f.read(5, 2 * MiB - 10), FILE.subarray(5, 2 * MiB - 5));
    assert.equal(requests.length, n + 2, 'no synchronous request once the blocks are stored');
  } finally { globalThis.fetch = realFetch; }
});

test('http backend: a stream read a little at a time fetches growing windows, not whole blocks ahead', () => {
  const b = new HttpBackend('/game/s/', tree(4), {});
  b.fillBackground = () => {}; // (no background downloads here)
  const f = b.open('Data/a.big'), n = requests.length;
  for (let pos = 0; pos < MiB + 8192; pos += 4096) assert.deepEqual(f.read(pos, 4096), FILE.subarray(pos, pos + 4096));
  const reqs = requests.slice(n), sizes = reqs.map((r) => r[2] - r[1] + 1);
  // doubling windows within the first block (its tail last), then — a file read whole — whole blocks ahead
  assert.deepEqual(sizes.slice(0, 3), [65536, 131072, 262144]); // (then capped: at most 256 KiB ahead while the game waits)
  assert.ok(sizes.every((n, i) => i === sizes.length - 1 || n <= 262144 + 65536), `bounded windows (${sizes})`);
  assert.ok(reqs.filter((r) => r[1] < MiB).every((r) => r[2] < MiB), `the first MiB by pieces (${sizes})`);
  assert.ok(sizes.length <= 8, `few requests (${sizes})`);
});
