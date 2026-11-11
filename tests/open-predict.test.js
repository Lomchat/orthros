// Predicted opens (src/vfs/open-predict.js): a walk of a folder's files is fetched ahead; opens in no order fetch
// little (the guard against wasting a slow link on wrong guesses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenPredictor } from '../src/vfs/open-predict.js';
import { HttpBackend, CHUNK } from '../src/vfs/http-backend.js';

const tree = () => {
  const files = {};
  for (let i = 0; i < 400; i++) files[`f${String(i).padStart(3, '0')}.ini`] = { size: 20000 };
  return { dirs: { data: { dirs: {}, files } }, files: {} };
};
const run = (order) => {
  let t = 0; const fetched = new Set();
  const P = new OpenPredictor(tree(), { now: () => t, fetch: (p) => { if (fetched.has(p)) return true; fetched.add(p); return Promise.resolve(true); }, net: { bw: 1.25e6, rtt: 50, ratio: () => 0.5, thin: () => false } });
  let ahead = 0;
  for (const i of order) { t += 60; const p = `data/f${String(i).padStart(3, '0')}.ini`; if (fetched.has(p)) ahead++; P.noteOpen(p, 20000); }
  const opened = new Set(order.map((i) => `data/f${String(i).padStart(3, '0')}.ini`));
  return { ahead, wasted: [...fetched].filter((p) => !opened.has(p)).length };
};

test('a walk of a folder in name order is fetched ahead of the game', () => {
  const r = run(Array.from({ length: 300 }, (_, i) => i));
  assert.ok(r.ahead >= 290, `ahead ${r.ahead}`);
  assert.ok(r.wasted <= 40, `wasted ${r.wasted}`);
});

test('opens in no order fetch few files the game does not open', () => {
  let x = 12345; const order = [], seen = new Set();
  while (order.length < 120) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; const i = x % 400; if (!seen.has(i)) { seen.add(i); order.push(i); } }
  const r = run(order);
  assert.ok(r.wasted <= 30, `wasted ${r.wasted}`);
});

test('a session restored from a snapshot reports the reads served by predicted bytes (the server does not learn w=1)', async () => {
  const size = 3 * CHUNK, urls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(url); const [, a, b] = /r=(\d+)-(\d+)/.exec(url);
    return { status: 206, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(b - a).buffer };
  };
  try {
    const b = new HttpBackend('/game/v/', { dirs: {}, files: { 'a.ini': { size, mtime: 1 } } }, { encoded: true, session: 's1' });
    const p = b.predict('a.ini', 0, size);
    assert.notEqual(p, true);
    assert.equal(await p, true);
    assert.ok(urls.length && urls.every((u) => u.includes('w=1') && !u.includes('s=s1')), 'asked as a guess, not learned');
    assert.deepEqual(b.takeUnlearned('a.ini', 100, CHUNK + 10), [[100, CHUNK + 10]], 'the game\'s read of it: to report');
    assert.equal(b.takeUnlearned('a.ini', 0, CHUNK), null, 'each piece once');
    b.rangeUrl('a.ini', 2 * CHUNK, size); // (a learned request of the last piece: the server learns that read itself)
    assert.equal(b.takeUnlearned('a.ini', 2 * CHUNK, size), null);
  } finally { globalThis.fetch = real; }
});
