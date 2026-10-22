// Audio units (docs/slow-network.md "Audio units"): the server makes a unit's PCM transport form beside its brotli one —
// for RIFF WAVE sound found in a file or an archive, for a raw sample bank by trial — and sends it to a request that
// says it decodes them (&pc=1); the shared reader decodes it before the game sees a byte; the bytes are the file's
// (checked by hash); other requests, light copies and data that is not sound are as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';
import { createServer } from '../src/host/server.js';
import { createBrCache } from '../src/host/br-cache.js';
import { encodePcm, decodePcm } from '../src/vfs/pcm-codec.js';

const QUIET = { loadLimit: Infinity, diskLimit: 1, idleMs: 50 };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** 16-bit mono sound bytes: partials and a little noise */
function sound(frames, seed = 1) {
  let s = seed; const r = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 2 ** 32; };
  const b = Buffer.alloc(frames * 2), f = [0.01 + r() * 0.05, 0.07 + r() * 0.1, 0.2 + r() * 0.1];
  for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round((Math.sin(i * f[0]) * 0.5 + Math.sin(i * f[1]) * 0.25 + Math.sin(i * f[2]) * 0.1 + (r() - 0.5) * 0.02) * 20000), i * 2);
  return b;
}
const wave = (pcm) => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8, 'latin1'); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(22050, 24); h.writeUInt32LE(44100, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};
const get = (url, enc = 'gzip, br') => new Promise((res, rej) => http.get(url, { headers: { 'accept-encoding': enc } }, async (r) => { const parts = []; for await (const d of r) parts.push(d); res({ r, body: Buffer.concat(parts) }); }).on('error', rej));
const plain = ({ r, body }) => (r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(body) : body);

test('server: audio units made for sound (a .wav, an archive member, a raw bank), sent to &pc=1 only, the bytes exact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-pcmunits-'));
  const w = wave(sound(BLOCK / 2 + 5000, 3)); // (a block and a tail)
  const text = Buffer.from('member text, compressible '.repeat(2000));
  const arch = Buffer.concat([Buffer.from('BIGF....'), text, wave(sound(30000, 4)), text]);
  const bank = Buffer.concat([sound(40000, 5), sound(30000, 6)]); // (no header: the trial layouts)
  const noise = crypto.randomBytes(CHUNK);
  for (const [n, b] of [['s.wav', w], ['a.big', arch], ['sfx.raw', bank], ['noise.bin', noise]]) fs.writeFileSync(path.join(dir, n), b);
  fs.mkdirSync(path.join(dir, 'man')); fs.writeFileSync(path.join(dir, 'man', 'g.json'), JSON.stringify({ name: 'g', folder: dir, exe: 'x.exe' }));
  const brDir = path.join(dir, 'brcache');
  const server = createServer({ manifests: path.join(dir, 'man'), brCacheDir: brDir, brCacheOptions: QUIET, brCacheLog: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const units = [['s.wav', 0, BLOCK, w], ['s.wav', BLOCK, w.length, w], ['a.big', 0, arch.length, arch], ['sfx.raw', 0, bank.length, bank], ['noise.bin', 0, CHUNK, noise]];
  try {
    for (const [f, a, e, b] of units) assert.equal(sha(plain(await get(`${base}/gamez/g/${f}?r=${a}-${e}&pc=1`))), sha(b.subarray(a, e)), 'a miss: the dynamic way');
    await server.brCache.drain();
    const st = server.brCache.stats();
    assert.equal(st.units, 5); assert.equal(st.pcmUnits, 4, 'the sound units, not the noise');
    for (const [f, a, e, b] of units) {
      const want = sha(b.subarray(a, e));
      const p = await get(`${base}/gamez/g/${f}?r=${a}-${e}&p=1&pc=1`);
      if (f === 'noise.bin') { assert.equal(p.r.headers['x-orthros-codec'], undefined); assert.equal(sha(p.body), want); continue; }
      assert.equal(p.r.headers['x-orthros-codec'], 'pcm1', f);
      assert.equal(p.r.headers['content-encoding'], 'br');
      assert.equal(p.r.headers['x-orthros-unit'], 'hit');
      assert.equal(sha(decodePcm(zlib.brotliDecompressSync(p.body))), want, `${f} ${a}-${e}: decoded to the file's bytes`);
      const q = await get(`${base}/gamez/g/${f}?r=${a}-${e}&p=1`);
      assert.equal(q.r.headers['x-orthros-codec'], undefined, 'without &pc=1: the brotli unit');
      assert.equal(sha(plain(q)), want);
      assert.ok(p.body.length < q.body.length * 0.95, `${f}: ${p.body.length} against brotli's ${q.body.length}`);
    }
    assert.ok(JSON.parse((await get(`${base}/api/netstats`, '')).body).pcmHits >= 4);
    // the index rebuilt from the disk keeps them (and the files' waves); a unit's audio form gone: made again
    server.brCache.close();
    const again = createBrCache({ dir: brDir, ...QUIET });
    await again.ready;
    assert.equal(again.stats().pcmUnits, 4);
    const f = path.join(dir, 's.wav'), sz = fs.statSync(f);
    assert.ok(again.lookupPcm(f, sz, null, { kind: 'b', index: 0 }));
    assert.ok(again.size(f, sz, null, { kind: 'b', index: 0 }) < again.lookup(f, sz, null, { kind: 'b', index: 0 }).bytes, 'its wire size: the audio form\'s');
    again.close();
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache: units made before audio units get their audio form later; none for light copies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-pcmunits-'));
  const f = path.join(dir, 's.wav'); fs.writeFileSync(f, wave(sound(20000, 8)));
  try {
    const old = createBrCache({ dir: path.join(dir, 'c'), ...QUIET, pcm: false });
    const st = fs.statSync(f), unit = { kind: 'b', index: 0 };
    old.want(f, st, null, unit); await old.drain();
    assert.ok(old.lookup(f, st, null, unit)); assert.equal(old.lookupPcm(f, st, null, unit), null);
    old.close();
    const made = [], c = createBrCache({ dir: path.join(dir, 'c'), ...QUIET, onMade: (file, u) => made.push(u) });
    await c.ready;
    c.want(f, st, null, unit); await c.drain();
    assert.equal(made.length, 1, 'the audio form only');
    assert.ok(c.lookupPcm(f, st, null, unit));
    assert.equal(c.lookupPcm(f, st, { copy: { size: 10, from: 0, head: [] } }, unit), null);
    c.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backend: an audio unit is decoded before the reader keeps it; a bad one turns them off and is asked again', async () => {
  const FILE = Buffer.concat([sound(BLOCK / 2, 9), sound(BLOCK / 2, 10)]);
  const tree = { dirs: {}, files: { 'a.raw': { size: FILE.length, mtime: 1 } } };
  const realFetch = globalThis.fetch, asked = [];
  let corrupt = false, dropHeader = false;
  globalThis.fetch = async (url) => {
    const [, a, e] = /\?r=(\d+)-(\d+)/.exec(url), pc = /&pc=1(&|$)/.test(url); asked.push([+a, +e, pc]);
    let body = new Uint8Array(FILE.subarray(+a, +e)), codec = null;
    if (pc) { body = encodePcm(body, [{ at: 0, len: body.length, bits: 16, ch: 1 }]); codec = dropHeader ? null : 'pcm1'; if (corrupt) body[body.length >> 1] ^= 0x55; }
    return { status: 200, headers: { get: (h) => (h === 'x-orthros-codec' ? codec : h === 'content-length' ? String(body.length) : null) }, arrayBuffer: async () => body.slice().buffer };
  };
  try {
    const b = new HttpBackend('/game/g/', tree, { encoded: true });
    const d = await b.fetchBackground('a.raw', 0, 2 * BLOCK, null);
    assert.equal(sha(d), sha(FILE));
    assert.deepEqual(asked.map((x) => x[2]), [true, true], 'asked with &pc=1, one request per unit');
    assert.equal(b.stats.pcmUnits, 2);
    const fg = await b.fetchForeground('a.raw', CHUNK, 2 * CHUNK);
    assert.equal(sha(fg), sha(FILE.subarray(CHUNK, 2 * CHUNK)));
    dropHeader = true; // (a proxy that drops X-Orthros-Codec: the container told by its length and magic)
    assert.equal(sha(await b.fetchBackground('a.raw', BLOCK, 2 * BLOCK, null)), sha(FILE.subarray(BLOCK)));
    dropHeader = false;
    corrupt = true; asked.length = 0;
    assert.equal(await b.fetchBackground('a.raw', 0, BLOCK, null), undefined, 'a bad unit: no bytes');
    assert.equal(b.pcm, false);
    corrupt = false;
    assert.equal(sha(await b.fetchBackground('a.raw', 0, BLOCK, null)), sha(FILE.subarray(0, BLOCK)));
    assert.deepEqual(asked.map((x) => x[2]), [true, false], 'asked again without');
    const off = new HttpBackend('/game/g/', tree, { encoded: true, pcm: false });
    assert.ok(!off.rangeUrl('a.raw', 0, BLOCK).includes('pc=1'));
    assert.ok(!new HttpBackend('/game/g/', tree, {}).rangeUrl('a.raw', 0, BLOCK).includes('pc=1'), 'not the compressed ranges: never');
  } finally { globalThis.fetch = realFetch; }
});

test('backend: a synchronous read whose audio unit does not decode is asked again without the codec', () => {
  const FILE = Buffer.from(sound(CHUNK, 4));
  const tree = { dirs: {}, files: { 'a.raw': { size: FILE.length, mtime: 1 } } };
  const Real = globalThis.XMLHttpRequest, urls = [];
  globalThis.XMLHttpRequest = class {
    open(m, url) { this.url = url; }
    setRequestHeader() {}
    getResponseHeader(h) { return /x-orthros-codec/i.test(h) ? this.codec : null; }
    send() {
      urls.push(this.url);
      const [, a, e] = /\?r=(\d+)-(\d+)/.exec(this.url), body = new Uint8Array(FILE.subarray(+a, +e));
      this.status = 200;
      if (/&pc=1(&|$)/.test(this.url)) { const enc = encodePcm(body, [{ at: 0, len: body.length, bits: 16, ch: 1 }]); enc[enc.length >> 1] ^= 0x55; this.codec = 'pcm1'; this.response = enc.buffer; }
      else { this.codec = null; this.response = body.slice().buffer; }
    }
  };
  try {
    const b = new HttpBackend('/game/g/', tree, { encoded: true, retryWaits: [0, 0, 0] });
    assert.equal(sha(b.fetchRange('a.raw', 0, CHUNK)), sha(FILE.subarray(0, CHUNK)));
    assert.equal(b.pcm, false);
    assert.deepEqual(urls.map((u) => /&pc=1/.test(u)), [true, false], 'the retry without &pc=1');
  } finally { globalThis.XMLHttpRequest = Real; }
});

test('cache: a restart pins a launch set\'s audio units with its brotli ones before anything is made (pinNow)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-pcmpin-'));
  const unit = { kind: 'p', index: 0 };
  const file = (n, b) => { const f = path.join(dir, n); fs.writeFileSync(f, b); return { file: f, st: fs.statSync(f), light: null, unit }; };
  const s = file('s.wav', wave(sound(CHUNK, 7)));
  const [a0, m1, m2] = ['a0', 'm1', 'm2'].map((n) => file(n, Buffer.from(`${n} compressible text `.repeat(3000)).subarray(0, CHUNK)));
  const cdir = path.join(dir, 'cache');
  try {
    // an earlier process: the launch unit s (brotli and audio forms) made long ago, two live misses lately
    const first = createBrCache({ dir: cdir, ...QUIET });
    for (const u of [s, m1, m2]) { first.want(u.file, u.st, null, u.unit); await first.drain(); }
    const now = Date.now() / 1000, pcm = first.lookupPcm(s.file, s.st, null, unit);
    assert.ok(pcm, 'the audio form made');
    for (const [p, age] of [[first.lookup(s.file, s.st, null, unit).path, 3000], [pcm.path, 3000], [first.lookup(m1.file, m1.st, null, unit).path, 100], [first.lookup(m2.file, m2.st, null, unit).path, 50]]) fs.utimesSync(p, now - age, now - age);
    const before = first.stats().bytes; first.close();
    // (a0's unit: what making it adds)
    const probe = createBrCache({ dir: path.join(dir, 'probe'), ...QUIET });
    probe.want(a0.file, a0.st, null, unit); await probe.drain(); const add = probe.stats().bytes; probe.close();
    // restarted with one unit's room too few: making A's missing unit evicts one unit — a live miss, not B's audio form
    const max = before + add - 1;
    const cache = createBrCache({ dir: cdir, maxBytes: max, lowBytes: max, pinShare: 0.9, ...QUIET,
      sources: () => [{ name: 'A', units: () => [a0] }, { name: 'B', units: () => [s] }] });
    await cache.ready; await new Promise((r) => setTimeout(r, 20)); await cache.drain();
    assert.ok(cache.lookup(a0.file, a0.st, null, unit), 'the missing launch unit made');
    assert.ok(cache.stats().evicted >= 1);
    // (before, B's audio unit — the oldest, not pinned until the walk reached it — went out and the walk made it again)
    assert.equal(cache.stats().generated, 1, 'nothing made twice'); assert.equal(cache.stats().pcmMade, 0);
    assert.ok(cache.lookupPcm(s.file, s.st, null, unit), 'B\'s audio unit kept');
    assert.ok(cache.lookup(s.file, s.st, null, unit), 'B\'s brotli unit kept');
    assert.equal(cache.lookup(m1.file, m1.st, null, unit), null, 'a live miss out instead');
    cache.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
