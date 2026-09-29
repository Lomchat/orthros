// Parallel DXT encoding (dxt-pool.js): block rows split between helper threads and the caller give the bytes of the
// sequential encoder, for every format and sizes whose block rows do not divide evenly; small images are left to the
// caller; helpers that never answer turn the pool off (the caller encodes) instead of hanging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { DxtPool } from '../src/win32/dxt-pool.js';
import { encodeDxt, encodeDxtRows, dxtBytes } from '../src/win32/d3dx9-image.js';
import { FMT } from '../src/win32/d3d8.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; }; }
const image = (w, h, seed) => { const r = rng(seed), px = new Uint8Array(w * h * 4); for (let i = 0; i < px.length; i++) px[i] = (i & 3) === 3 ? (r() < 40 ? 0 : 255) : ((i >> 4) + r() % 32) & 255; return px; };
const sequential = (fmt, px, w, h) => encodeDxtRows(fmt, px, w, h, 0, Math.max(1, (h + 3) >> 2), new Uint8Array(dxtBytes(fmt, w, h)));

test('helper threads: the same blocks as one thread', async () => {
  const url = new URL('../src/win32/dxt-pool.js', import.meta.url).href;
  const threads = [];
  const spawn = () => { const w = new Worker(`import('${url}').then(({ helperLoop }) => require('node:worker_threads').parentPort.once('message', helperLoop));`, { eval: true }); threads.push(w); return w; };
  const pool = new DxtPool(3, spawn);
  try {
    for (const fmt of [FMT.DXT1, FMT.DXT3, FMT.DXT5]) for (const [w, h] of [[256, 256], [128, 132], [512, 128], [130, 250]]) {
      const px = image(w, h, w + h + fmt);
      const got = pool.encode(fmt, px, w, h);
      assert.ok(got, `${w}x${h} encoded by the pool`);
      assert.deepEqual(got, sequential(fmt, px, w, h), `format ${fmt} ${w}x${h}`);
    }
    assert.equal(pool.encode(FMT.DXT1, image(64, 64, 1), 64, 64), null, 'a small image: the caller encodes');
    assert.equal(pool.stats.jobs, 12);
  } finally { for (const t of threads) await t.terminate(); }
});

test('installed as the encoder, a pool that declines leaves the sequential encoder', () => {
  const px = image(64, 64, 7);
  assert.deepEqual(encodeDxt(FMT.DXT5, px, 64, 64), sequential(FMT.DXT5, px, 64, 64));
});

test('helpers that never answer: the pool turns itself off and returns null (no hang)', () => {
  const logs = [];
  const pool = new DxtPool(2, () => ({ postMessage() {}, terminate() {} }), (m) => logs.push(m), { firstMs: 100, ms: 100 });
  assert.equal(pool.encode(FMT.DXT1, image(256, 256, 3), 256, 256), null);
  assert.equal(pool.broken, true); assert.equal(logs.length, 1);
  assert.equal(pool.encode(FMT.DXT1, image(256, 256, 3), 256, 256), null, 'stays off');
});
