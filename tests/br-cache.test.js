// Precompressed transport units (src/host/br-cache.js, docs/slow-network.md "Precompressed units"): a request of a
// unit's shape that takes br is answered from the unit made ahead in the background, else the dynamic way (and the
// unit is made); a changed file never hits; the budget is kept, launch units last out; the index survives a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { unitOf, rangeUnits, HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';
import { createBrCache } from '../src/host/br-cache.js';
import { createServer } from '../src/host/server.js';

// (the machine's own load and disk never pause the tests' generation)
const QUIET = { loadLimit: Infinity, diskLimit: 1, idleMs: 50 };
const text = (n, seed = 'x') => { const out = Buffer.alloc(n); let s = 1; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; out[i] = 97 + ((s >>> 16) % 6); } out.write(seed); return out; };

test('units: a whole block (the tail for the last), a single piece; ranges cut at them', () => {
  const size = 3 * BLOCK + 100;
  assert.deepEqual(unitOf(0, BLOCK, size), { kind: 'b', index: 0 });
  assert.deepEqual(unitOf(3 * BLOCK, size, size), { kind: 'b', index: 3 }, 'the tail block');
  assert.deepEqual(unitOf(CHUNK, 2 * CHUNK, size), { kind: 'p', index: 1 });
  assert.deepEqual(unitOf(0, 500, 500), { kind: 'b', index: 0 }, 'a file under a piece: its block');
  assert.equal(unitOf(0, 2 * CHUNK, size), null);
  assert.equal(unitOf(10, CHUNK + 10, size), null);
  assert.deepEqual(rangeUnits(0, 2 * BLOCK, size), [[0, BLOCK], [BLOCK, 2 * BLOCK]]);
  assert.deepEqual(rangeUnits(BLOCK, BLOCK + 3 * CHUNK, size), [[BLOCK, BLOCK + CHUNK], [BLOCK + CHUNK, BLOCK + 2 * CHUNK], [BLOCK + 2 * CHUNK, BLOCK + 3 * CHUNK]]);
  assert.deepEqual(rangeUnits(15 * CHUNK, BLOCK + CHUNK, size), [[15 * CHUNK, BLOCK], [BLOCK, BLOCK + CHUNK]], 'a run across a block boundary');
  assert.deepEqual(rangeUnits(2 * BLOCK, size, size), [[2 * BLOCK, 3 * BLOCK], [3 * BLOCK, size]], 'up to the tail');
  assert.equal(rangeUnits(0, BLOCK, size), null, 'one unit already');
  assert.equal(rangeUnits(5, 3 * CHUNK, size), null, 'not aligned');
  assert.equal(rangeUnits(CHUNK, 18 * CHUNK, 64 * BLOCK), null, 'more parts than worth it');
});

test('the backend cuts a compressed background range at its units and joins the answers', async () => {
  const FILE = text(2 * BLOCK);
  const b = new HttpBackend('/game/g/', { dirs: {}, files: { 'a.big': { size: FILE.length, mtime: 1 } } }, { encoded: true });
  const realFetch = globalThis.fetch, asked = [];
  globalThis.fetch = async (url) => { const [, a, e] = /\?r=(\d+)-(\d+)/.exec(url); asked.push([+a, +e]); return { status: 200, headers: { get: () => String(100) }, arrayBuffer: async () => new Uint8Array(FILE.subarray(+a, +e)).buffer }; };
  try {
    const d = await b.fetchBackground('a.big', 14 * CHUNK, BLOCK + CHUNK, null);
    assert.deepEqual(asked, [[14 * CHUNK, 15 * CHUNK], [15 * CHUNK, BLOCK], [BLOCK, BLOCK + CHUNK]]);
    assert.deepEqual(Buffer.from(d), FILE.subarray(14 * CHUNK, BLOCK + CHUNK));
    asked.length = 0;
    b.unitRequests = false;
    await b.fetchBackground('a.big', 14 * CHUNK, BLOCK + CHUNK, null);
    assert.deepEqual(asked, [[14 * CHUNK, BLOCK + CHUNK]], 'off: one request');
  } finally { globalThis.fetch = realFetch; }
});

test('the backend cuts its ranges while the server answers from units, else one request in 8 (a probe)', async () => {
  const FILE = text(2 * BLOCK);
  const b = new HttpBackend('/game/g/', { dirs: {}, files: { 'a.big': { size: FILE.length, mtime: 1 } } }, { encoded: true });
  const realFetch = globalThis.fetch;
  let asked = 0, hit = false;
  globalThis.fetch = async (url) => { const [, a, e] = /\?r=(\d+)-(\d+)/.exec(url); asked++; return { status: 200, headers: { get: (h) => (h === 'x-orthros-unit' ? (hit ? 'hit' : null) : null) }, arrayBuffer: async () => new Uint8Array(FILE.subarray(+a, +e)).buffer }; };
  const requests = async (n) => { const out = []; for (let i = 0; i < n; i++) { asked = 0; const d = await b.fetchBackground('a.big', 2 * CHUNK, 6 * CHUNK, null); assert.deepEqual(Buffer.from(d), FILE.subarray(2 * CHUNK, 6 * CHUNK)); out.push(asked); } return out; };
  try {
    // no units on the server: cut until the misses show, then whole but every 8th
    assert.deepEqual(await requests(2), [4, 4]);
    assert.deepEqual(await requests(16), [1, 1, 1, 1, 1, 1, 1, 4, 1, 1, 1, 1, 1, 1, 1, 4]);
    // the units made meanwhile: the probes hit (three raise the share past UNIT_HIT_MIN), cut again from then on
    hit = true;
    const probe = [1, 1, 1, 1, 1, 1, 1, 4];
    assert.deepEqual(await requests(32), [...probe, ...probe, ...probe, 4, 4, 4, 4, 4, 4, 4, 4]);
  } finally { globalThis.fetch = realFetch; }
});

const get = (url, enc) => new Promise((res, rej) => http.get(url, { headers: { 'accept-encoding': enc } }, async (r) => { const parts = []; for await (const d of r) parts.push(d); res({ r, body: Buffer.concat(parts) }); }).on('error', rej));
const plain = ({ r, body }) => (r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(body) : r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(body) : body);

test('server: a unit missed goes the dynamic way and is made; then served precompressed; changed files never hit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-brcache-'));
  const big = text(2 * BLOCK + 3000), small = text(5000, 'small'), noise = crypto.randomBytes(CHUNK);
  fs.writeFileSync(path.join(dir, 'a.big'), big); fs.writeFileSync(path.join(dir, 'small.txt'), small); fs.writeFileSync(path.join(dir, 'noise.bin'), noise);
  fs.mkdirSync(path.join(dir, 'man')); fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  const brDir = path.join(dir, 'brcache');
  const server = createServer({ manifests: path.join(dir, 'man'), brCacheDir: brDir, brCacheOptions: QUIET, brCacheLog: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stats = async () => JSON.parse((await get(`${base}/api/netstats`, '')).body);
  try {
    const unitUrls = [[`/gamez/g/a.big?r=0-${BLOCK}`, big.subarray(0, BLOCK)], [`/gamez/g/a.big?r=${2 * BLOCK}-${3 * BLOCK}`, big.subarray(2 * BLOCK)],
      [`/gamez/g/a.big?r=${CHUNK}-${2 * CHUNK}&s=x`, big.subarray(CHUNK, 2 * CHUNK)], ['/gamez/g/small.txt?r=0-5000', small]];
    for (const [u, want] of unitUrls) {
      const a = await get(base + u, 'gzip, br');
      assert.equal(a.r.headers['content-encoding'], 'br', `dynamic brotli (no zstd asked): ${u}`);
      assert.equal(a.r.headers['x-orthros-unit'], 'miss', 'a miss says so (the reader counts it against cutting)');
      assert.deepEqual(plain(a), want);
    }
    assert.equal((await stats()).brHits, 0);
    await server.brCache.drain();
    assert.equal(server.brCache.stats().units, 4);
    for (const [u, want] of unitUrls) {
      const a = await get(base + u, 'gzip, deflate, br, zstd'); // (a unit made ahead beats zstd on the fly)
      assert.equal(a.r.headers['content-encoding'], 'br', u);
      assert.equal(a.r.headers['x-orthros-unit'], 'hit', `a hit says so (the reader keeps cutting): ${u}`);
      assert.deepEqual(plain(a), want);
    }
    let s = await stats();
    assert.equal(s.brHits, 4); assert.equal(s.brCache.units, 4);
    // not units, a padded range, no br: the dynamic way as before
    assert.deepEqual(plain(await get(`${base}/gamez/g/a.big?r=0-${2 * CHUNK}`, 'gzip, br')), big.subarray(0, 2 * CHUNK));
    const padded = await get(`${base}/gamez/g/a.big?r=0-${BLOCK}&pad=1`, 'gzip, br');
    assert.deepEqual(plain(padded).subarray(1), big.subarray(0, BLOCK));
    const gz = await get(`${base}/gamez/g/a.big?r=0-${BLOCK}`, 'gzip');
    assert.equal(gz.r.headers['content-encoding'], 'gzip');
    assert.equal((await stats()).brHits, 4);
    // incompressible: an empty .raw, sent as is (never made again)
    await get(`${base}/gamez/g/noise.bin?r=0-${CHUNK}`, 'br');
    await server.brCache.drain();
    const n = await get(`${base}/gamez/g/noise.bin?r=0-${CHUNK}`, 'br');
    assert.equal(n.r.headers['content-encoding'], undefined);
    assert.equal(n.r.headers['x-orthros-unit'], 'raw', 'a unit known not to compress: raw, as good as a hit for the reader');
    assert.deepEqual(n.body, noise);
    assert.equal(server.brCache.stats().generated, 5);
    // the file changed (same size, new mtime): its old units never served, the sweep removes them
    const before = fs.readdirSync(brDir).flatMap((t) => fs.readdirSync(path.join(brDir, t)).map((k) => path.join(brDir, t, k)));
    const changed = Buffer.from(small); changed.write('CHANGED');
    fs.writeFileSync(path.join(dir, 'small.txt'), changed); fs.utimesSync(path.join(dir, 'small.txt'), new Date(), new Date(Date.now() + 5000));
    const c = await get(`${base}/gamez/g/small.txt?r=0-5000`, 'br');
    assert.deepEqual(plain(c), changed);
    assert.equal((await stats()).brHits, 4, 'a miss');
    await server.brCache.drain();
    await server.brCache.sweep();
    const after = fs.readdirSync(brDir).flatMap((t) => fs.readdirSync(path.join(brDir, t)).map((k) => path.join(brDir, t, k)));
    assert.equal(before.filter((d) => !after.includes(d)).length, 1, 'the old version of small.txt swept');
    assert.deepEqual(plain(await get(`${base}/gamez/g/small.txt?r=0-5000`, 'br')), changed);
    assert.equal((await stats()).brHits, 5, 'the new version made and served');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache: tiny budget, least recently used out, launch units last; the index rebuilt from the disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-brcache-'));
  const files = ['a', 'b', 'c', 'd'].map((n) => { const f = path.join(dir, n); fs.writeFileSync(f, text(CHUNK, n)); return [f, fs.statSync(f)]; });
  const piece = { kind: 'p', index: 0 };
  try {
    // the size of one unit (the same for all: the same text but its first byte)
    const probe = createBrCache({ dir: path.join(dir, 'probe'), ...QUIET });
    probe.want(files[0][0], files[0][1], null, piece); await probe.drain();
    const one = probe.stats().bytes; probe.close();
    assert.ok(one > 0 && one < CHUNK);
    // room for 2.5 units: the launch unit (file a, from `sources`) and the most recent one stay
    const cdir = path.join(dir, 'cache');
    const cache = createBrCache({ dir: cdir, maxBytes: Math.floor(one * 2.5), lowBytes: Math.floor(one * 2.2), pinShare: 0.5, ...QUIET,
      sources: () => [{ name: 'g', units: () => [{ file: files[0][0], st: files[0][1], light: null, unit: piece }] }] });
    await cache.ready; await cache.drain();
    assert.ok(cache.lookup(files[0][0], files[0][1], null, piece), 'the launch unit made');
    for (const [f, st] of files.slice(1)) { cache.want(f, st, null, piece); await cache.drain(); }
    const s = cache.stats();
    assert.ok(s.bytes <= Math.floor(one * 2.5), `within the budget: ${s.bytes}`);
    assert.ok(s.evicted >= 1);
    assert.ok(cache.lookup(files[0][0], files[0][1], null, piece), 'the pinned launch unit kept');
    assert.ok(cache.lookup(files[3][0], files[3][1], null, piece), 'the most recent kept');
    assert.equal(cache.lookup(files[1][0], files[1][1], null, piece), null, 'the least recent out');
    cache.close();
    // a new process: the same units from the disk
    const again = createBrCache({ dir: cdir, ...QUIET });
    await again.ready;
    assert.equal(again.stats().units, s.units);
    const hit = again.lookup(files[3][0], files[3][1], null, piece);
    assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(hit.path)), fs.readFileSync(files[3][0]));
    assert.equal(again.lookup(files[3][0], { size: files[3][1].size, mtimeMs: files[3][1].mtimeMs + 1 }, null, piece), null, 'another mtime: another version');
    again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache: raw markers never evicted (nothing freed), their wire size their range\'s; a budget not a positive number: the default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-brcache-'));
  const piece = { kind: 'p', index: 0 };
  const noise = path.join(dir, 'noise'); fs.writeFileSync(noise, crypto.randomBytes(CHUNK - 100));
  const files = ['a', 'b', 'c'].map((n) => { const f = path.join(dir, n); fs.writeFileSync(f, text(CHUNK, n)); return [f, fs.statSync(f)]; });
  try {
    const probe = createBrCache({ dir: path.join(dir, 'probe'), ...QUIET });
    probe.want(files[0][0], files[0][1], null, piece); await probe.drain();
    const one = probe.stats().bytes; probe.close();
    const cache = createBrCache({ dir: path.join(dir, 'cache'), maxBytes: Math.floor(one * 1.5), lowBytes: Math.floor(one * 1.2), ...QUIET });
    await cache.ready;
    const nst = fs.statSync(noise);
    cache.want(noise, nst, null, piece); await cache.drain();
    assert.equal(cache.lookup(noise, nst, null, piece)?.raw, true, 'a raw marker');
    assert.equal(cache.size(noise, nst, null, piece), CHUNK - 100, 'sent as it is: its range\'s bytes');
    for (const [f, st] of files) { cache.want(f, st, null, piece); await cache.drain(); }
    assert.ok(cache.stats().evicted >= 1);
    assert.equal(cache.lookup(noise, nst, null, piece)?.raw, true, 'the marker kept');
    assert.equal(cache.size(files[2][0], files[2][1], null, piece), one, 'a .br unit: its compressed bytes');
    cache.close();
    for (const bad of [NaN, 0, -5, Infinity]) { const c = createBrCache({ dir: path.join(dir, 'bad'), maxBytes: bad, ...QUIET }); assert.equal(c.stats().maxBytes, 1536 * 1024 * 1024, String(bad)); c.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server: the learned order seeds the units ahead of any request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-brcache-'));
  const big = text(2 * BLOCK);
  fs.writeFileSync(path.join(dir, 'a.big'), big);
  fs.mkdirSync(path.join(dir, 'man')); fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  const learnDir = path.join(dir, 'learn'); fs.mkdirSync(learnDir);
  // block 1 read whole (no mask), block 0's pieces 0 and 2 only
  fs.writeFileSync(path.join(learnDir, 'prefetch-g.json'), JSON.stringify([['a.big#1', 10, 1], ['a.big#0', 20, 1, 0b101]]));
  const server = createServer({ manifests: path.join(dir, 'man'), learnDir, brCacheDir: path.join(dir, 'brcache'), brCacheOptions: QUIET, brCacheLog: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await server.brCache.ready; await new Promise((r) => setTimeout(r, 20)); await server.brCache.drain();
    assert.equal(server.brCache.stats().units, 3);
    for (const [a, e] of [[BLOCK, 2 * BLOCK], [0, CHUNK], [2 * CHUNK, 3 * CHUNK]]) {
      const r = await get(`${base}/gamez/g/a.big?r=${a}-${e}&p=1`, 'br');
      assert.equal(r.r.headers['x-orthros-unit'], 'hit');
      assert.deepEqual(plain(r), big.subarray(a, e));
    }
    assert.equal(JSON.parse((await get(`${base}/api/netstats`, '')).body).brHits, 3);
    assert.equal((await get(`${base}/gamez/g/a.big?r=0-${2 * CHUNK}&p=1`, 'br')).r.headers['x-orthros-unit'], 'none', 'not a unit');
    assert.ok(server.brCache.stats().pinnedBytes > 0, 'the launch set pinned');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache: a light copy\'s units are its own version, made from its bytes', async () => {
  const { lightCopy, readLight } = await import('../src/host/light-copies.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-brcache-'));
  // (a DXT1 texture of 1024², 11 levels: each level's bytes its own value)
  const head = Buffer.alloc(128);
  head.write('DDS ', 0, 'latin1'); head.writeUInt32LE(124, 4); head.writeUInt32LE(0x1007 | 0x20000 | 0x80000, 8);
  head.writeUInt32LE(1024, 12); head.writeUInt32LE(1024, 16); head.writeUInt32LE(11, 28); head.writeUInt32LE(32, 76); head.writeUInt32LE(0x4, 80); head.write('DXT1', 84, 'latin1');
  const levels = []; for (let i = 0; i < 11; i++) { const s = Math.max(1, 1024 >> i); levels.push(Buffer.alloc(Math.ceil(s / 4) ** 2 * 8, i + 1)); }
  const file = path.join(dir, 't.dds'); fs.writeFileSync(file, Buffer.concat([head, ...levels]));
  const st = fs.statSync(file), copy = lightCopy(file, st), light = { file, st, copy };
  const cache = createBrCache({ dir: path.join(dir, 'cache'), ...QUIET });
  try {
    assert.ok(copy && copy.size < BLOCK);
    const unit = { kind: 'b', index: 0 };
    cache.want(file, st, light, unit); await cache.drain();
    const hit = cache.lookup(file, st, light, unit);
    const want = Buffer.alloc(copy.size); await new Promise((r, j) => readLight(file, copy, 0, copy.size, want, 0, (e) => (e ? j(e) : r())));
    assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(hit.path)), want);
    assert.equal(cache.lookup(file, st, null, unit), null, 'the file itself: another version');
  } finally { cache.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache: the launch sets first, side by side, before the live misses; then more of the orders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-brcache-'));
  const file = (n) => { const f = path.join(dir, n); fs.writeFileSync(f, text(CHUNK, n)); return { file: f, st: fs.statSync(f), light: null, unit: { kind: 'p', index: 0 } }; };
  const a = ['a1', 'a2', 'a3', 'a4'].map(file), b = ['b1', 'b2', 'b3', 'b4'].map(file), miss = file('miss');
  try {
    // (one unit's bytes: the pinned share of each source room for about two of them)
    const probe = createBrCache({ dir: path.join(dir, 'probe'), ...QUIET });
    probe.want(a[0].file, a[0].st, null, a[0].unit); await probe.drain();
    const one = probe.stats().bytes; probe.close();
    const made = [];
    const cache = createBrCache({ dir: path.join(dir, 'cache'), maxBytes: one * 40, pinShare: (one * 3.5) / (one * 40), ...QUIET,
      onMade: (f) => made.push(path.basename(f)),
      sources: () => [{ name: 'A', units: () => a }, { name: 'B', units: () => b }] });
    cache.want(miss.file, miss.st, null, miss.unit); // (a request missed before the walk began)
    await cache.ready; await cache.drain();
    // (the source with the fewest bytes made next: units of about the same size alternate)
    assert.deepEqual(made.slice(0, 2).sort(), ['a1', 'b1'], `the launch sets side by side: ${made}`);
    assert.deepEqual(made.slice(0, 4).sort(), ['a1', 'a2', 'b1', 'b2'], `the launch sets side by side: ${made}`);
    assert.equal(made[4], 'miss', `the live miss once the launch sets are made: ${made}`);
    assert.deepEqual(made.slice(5).sort(), ['a3', 'a4', 'b3', 'b4'], 'then the rest of the orders');
    assert.ok(cache.stats().pinnedBytes <= one * 3.5 + 1);
    cache.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
