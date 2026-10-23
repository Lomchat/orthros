// tools/learn-prune.mjs: a mask-less learned entry is dropped only when proven stale (a masked entry of the same block,
// or enough recent sessions that went through its phase without reading it); a dry run by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planPrune, pruneFile, splitOrder } from '../tools/learn-prune.mjs';

const TOOL = fileURLToPath(new URL('../tools/learn-prune.mjs', import.meta.url));
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-prune-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const verdict = (plan, e) => plan.drops.get(e) ?? null;

// A menu learned again with masks, and a map load only ever learned before masks (no recent session reached it).
const menu = [['a.big#0', 100, 4, 3], ['a.big#1', 1200, 4, 1], ['a.big#2', 2500, 4, 7], ['a.big#3', 3000, 3, 1]];
const menuOld = ['A.BIG#1', 1100, 9]; // (the same block as a.big#1, learned before masks under another case)
const menuGap = ['b.big#7', 2000, 6]; // (a menu block the recent sessions did not read)
const mapLoad = [['maps\\m1.big#0', 60000, 2], ['maps\\m1.big#1', 61000, 2], ['c.big#9', 62000, 2]];
const order = () => [...menu, menuOld, menuGap, ...mapLoad, ['d.big#0', 30000, 1, null, 2, { en: 2 }]];
const menuSession = (id, extra = {}) => ({ id, reached: 5000, phases: [], read: ['a.big#0', 'a.big#1', 'a.big#2', 'a.big#3'], ...extra });

test('learn-prune: splitOrder counts mask-less entries and the masked ones\' pieces', () => {
  const s = splitOrder([['a.big#0', 5, 3], ['a.big#1', 6, 2, 3], ['b.big#4', 7, 1, null, 2, { en: 2 }], ['c.big#0', 8, 1, 0xffff, 1]]);
  assert.equal(s.maskless.length, 2); assert.equal(s.maskedBytes, 2 * 64 * 1024 + (1 << 20));
});

test('learn-prune: without per-session records only a block re-learned with a mask goes; an unreached phase stays', () => {
  const o = order(), p = planPrune(o);
  assert.equal(verdict(p, o[4]), 'masked-duplicate', 'same block, other case: superseded');
  assert.equal(p.drops.size, 1);
  for (const e of [menuGap, ...mapLoad].map((x) => o.find((y) => y[0] === x[0]))) assert.match(p.kept.get(e), /refused/);
  assert.equal(verdict(p, o.at(-1)), null, 'a flagged entry without mask (null) is mask-less, kept');
  assert.ok(p.rules['passed-unread'].refused);
  // (backslash and slash are one path)
  const q = [['maps/m1.big#0', 5, 1, 1], ['maps\\M1.big#0', 1, 3]];
  assert.equal(verdict(planPrune(q), q[1]), 'masked-duplicate');
  assert.equal(planPrune([['x#1', 1, 1, 1], ['x#2', 1, 3]]).drops.size, 0, 'another block of the same file is not a duplicate');
});

test('learn-prune: passed-unread needs N recent sessions that reached the entry\'s time and phase without reading it', () => {
  const o = order(), gap = o[5], map0 = o[6];
  const three = [menuSession('s1'), menuSession('s2'), menuSession('s3')];
  let p = planPrune(o, { sessions: three });
  assert.equal(verdict(p, gap), 'passed-unread', 'three menu sessions read its neighbours, not it');
  assert.equal(verdict(p, map0), null, 'the map load: no session reached 60 s');
  assert.equal(p.rules['passed-unread'].entries, 1); assert.equal(p.rules['passed-unread'].sessions, 3);
  // A session that stayed 10 min in the menu reached the map's time, but no masked entry stands for that phase.
  const idle = three.map((s) => ({ ...s, reached: 600000 }));
  assert.equal(verdict(planPrune(o, { sessions: idle }), map0), null, 'time alone does not prove a phase passed');
  assert.equal(verdict(planPrune(o, { sessions: three.slice(0, 2) }), gap), null, 'two sessions, three needed');
  assert.equal(verdict(planPrune(o, { sessions: three.slice(0, 2), need: 2 }), gap), 'passed-unread', '--sessions 2');
  assert.equal(verdict(planPrune(o, { sessions: [...three, ...three.map((s) => ({ ...s, reached: 1000 }))], recent: 3 }), gap), null, 'only the K latest count');
  assert.equal(verdict(planPrune(o, { sessions: three.map((s) => ({ ...s, reached: 1999 })) }), gap), null, 'stopped before its time');
  assert.equal(verdict(planPrune(o, { sessions: three.map((s, i) => (i ? s : { ...s, read: [...s.read, 'B.BIG#7'] })) }), gap), null, 'one of them read it');
  assert.equal(verdict(planPrune(o, { sessions: three.map((s) => ({ ...s, read: ['a.big#0'] })) }), gap), null, 'the neighbours not read: phase not proven');
  assert.equal(verdict(planPrune(o, { sessions: three, minNeighbors: 5 }), gap), null, 'too few neighbours to stand for a phase');
  assert.equal(verdict(planPrune(o, { sessions: three, windowMs: 100 }), gap), null, 'no neighbour within the window');
  // An entry that knows its phases: the sessions must have entered one of them.
  const ph = [...menu, ['e.big#0', 3000, 2, null, 0, null, { map1: 500 }]];
  assert.equal(verdict(planPrune(ph, { sessions: three }), ph[4]), null);
  assert.equal(verdict(planPrune(ph, { sessions: three.map((s) => ({ ...s, phases: [['map1', 2500]] })) }), ph[4]), 'passed-unread');
  assert.equal(planPrune(o, { sessions: [{ id: 'bad' }, null, 7] }).rules['passed-unread'].sessions, 0, 'malformed records ignored');
});

test('learn-prune: --write drops only what the rules prove (backup kept, flags kept); a dry run writes nothing', (t) => {
  const d = tmp(t), f = path.join(d, 'prefetch-v.json'), o = order();
  fs.writeFileSync(f, JSON.stringify(o));
  assert.equal(pruneFile(f).written, false); assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), o);
  const r = pruneFile(f, { write: true, now: new Date(0) });
  assert.ok(r.written);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), o.filter((_, i) => i !== 4));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'prefetch-v.json.bak-1970-01-01T00-00-00-000Z'), 'utf8')), o);
  // Nothing proven: the file untouched, no backup.
  const g = path.join(d, 'prefetch-w.json'); fs.writeFileSync(g, JSON.stringify(mapLoad));
  assert.equal(pruneFile(g, { write: true }).written, false);
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.startsWith('prefetch-w')), ['prefetch-w.json']);
  // The per-session records beside the order (sessions-<manifest>.json) are read.
  fs.writeFileSync(path.join(d, 'sessions-v.json'), JSON.stringify([menuSession('s1'), menuSession('s2'), menuSession('s3')]));
  const r2 = pruneFile(f, { write: true, now: new Date(1) });
  assert.equal(r2.drops.size, 1); assert.equal([...r2.drops.values()][0], 'passed-unread');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).some((e) => e[0] === 'b.big#7'), false);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).filter((e) => e[3] == null).length, 4, 'the map load and the flagged entry stay');
});

test('learn-prune CLI: a dry run by default with each rule\'s count; --min-masked refused', (t) => {
  const d = tmp(t), f = path.join(d, 'prefetch-v.json'), o = order();
  fs.writeFileSync(f, JSON.stringify(o));
  const out = execFileSync(process.execPath, [TOOL, d, '--list'], { encoding: 'utf8' });
  assert.match(out, /dry run/); assert.match(out, /masked-duplicate: 1 \(1 MB\)/); assert.match(out, /passed-unread: refused/);
  assert.match(out, /maps\\m1\.big#0 .* keep: no per-session record/); assert.match(out, /A\.BIG#1 .* drop: masked-duplicate/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), o, 'dry run: untouched');
  const bad = spawnSync(process.execPath, [TOOL, d, '--min-masked', '50', '--write'], { encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /--min-masked is gone/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), o);
  execFileSync(process.execPath, [TOOL, d, '--write'], { encoding: 'utf8' });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).length, o.length - 1);
});
