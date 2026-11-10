// Predicted opens (src/vfs/open-predict.js): a walk of a folder's files is fetched ahead; opens in no order fetch
// little (the guard against wasting a slow link on wrong guesses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenPredictor } from '../src/vfs/open-predict.js';

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
