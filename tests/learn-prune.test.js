// tools/learn-prune.mjs: a learned order without its mask-less entries, once it has enough masked ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneFile, splitOrder } from '../tools/learn-prune.mjs';

test('learn-prune: mask-less entries out (backup kept) when the order has enough masked ones; the flags kept', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-prune-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'prefetch-v.json');
  const order = [['a.big#0', 5, 3], ['a.big#1', 6, 2, 3], ['b.big#4', 7, 1, null, 2, { en: 2 }], ['c.big#0', 8, 1, 0xffff, 1]];
  fs.writeFileSync(f, JSON.stringify(order));
  const s = splitOrder(order);
  assert.equal(s.maskless.length, 2); assert.equal(s.maskedBytes, 2 * 64 * 1024 + (1 << 20));
  assert.equal(pruneFile(f, { minMasked: 3, write: true }).written, false, 'too few masked entries: kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), order);
  const r = pruneFile(f, { minMasked: 2, write: true, now: new Date(0) });
  assert.ok(r.written);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), [order[1], order[3]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'prefetch-v.json.bak-1970-01-01T00-00-00-000Z'), 'utf8')), order);
});
