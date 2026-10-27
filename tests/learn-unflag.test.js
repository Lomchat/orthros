// tools/learn-unflag.mjs: a file's entries leave the learned launch set (their `pre` counts gone, the rest of each entry
// and the version's marks kept), in the rows the server writes; a server started on the result no longer flags them and
// still lists them. Dry run by default; --write keeps a backup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planUnflag, unflagEntry, unflagFile } from '../tools/learn-unflag.mjs';
import { createServer } from '../src/host/server.js';
import { PRE_PLAYABLE } from '../src/vfs/launch-set.js';

const TOOL = fileURLToPath(new URL('../tools/learn-unflag.mjs', import.meta.url));
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-unflag-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
// (an order as the server writes it: sfx.RAW flagged by every mark, one block with phases, one counted by few sessions)
const order = () => [
  ['Audio/sfx.SDT#0', 198, 38, 15, 19, { en: 17 }],
  ['Audio/sfx.RAW#0', 209, 38, 65535, 19, { en: 17 }],
  ['Audio/sfx.RAW#1', 209, 38, 3, 19, { en: 17 }, { menu: 10 }, 5],
  ['AUDIO\\SFX.RAW#200', 90000, 2, 1, 1],
  ['Audio/sfx.RAW#201', 90000, 1, 1],
  ['models/fonts.txd#0', 300, 38, 255, 19, { en: 17 }],
  ['Audio/other.raw#0', 400, 3],
];

test('learn-unflag: an entry loses its counts and its phases, at the time given, in the server\'s row form', () => {
  assert.deepEqual(unflagEntry(['a#0', 1, 2, 7, 3, { en: 3 }]), ['a#0', 1, 2, 7]);
  assert.deepEqual(unflagEntry(['a#0', 1, 2, null, 3], 50), ['a#0', 50, 2]);
  assert.deepEqual(unflagEntry(['a#0', 1, 2, 7, 3, { en: 3 }, { map: 5 }, 9], 50), ['a#0', 50, 2, 7]);
});

test('learn-unflag: the files named (any case, either separator) leave the launch set; the others and the marks stay', () => {
  const o = order(), r = planUnflag(o, ['audio/SFX.raw'], 19);
  assert.equal(r.hit.size, 3, 'the counted entries of sfx.RAW (the one never counted untouched)');
  assert.equal(r.flagged, 2, 'two flagged today (pre*2 >= marks), the third counted once');
  assert.equal(r.flaggedBytes, 16 * 65536 + 2 * 65536, 'their learned pieces');
  // (moved past the order's latest entry, 90000, in their own order: an early time would still fetch them first after
  // the launch set)
  assert.deepEqual(r.entries[1], ['Audio/sfx.RAW#0', 90001, 38, 65535]);
  assert.deepEqual(r.entries[2], ['Audio/sfx.RAW#1', 90002, 38, 3]);
  assert.deepEqual(r.entries[3], ['AUDIO\\SFX.RAW#200', 90003, 2, 1]);
  for (const i of [0, 4, 5, 6]) assert.equal(r.entries[i], o[i]);
  assert.equal(planUnflag(o, ['Audio/sfx.RAW']).flagged, 0, 'never marked: nothing flagged');
});

test('learn-unflag: --write (backup kept) and a server on the result lists the entries unflagged', async (t) => {
  const d = tmp(t), learn = path.join(d, 'learn'), games = path.join(d, 'games'); fs.mkdirSync(learn);
  const f = path.join(learn, 'prefetch-vc.json');
  fs.writeFileSync(f, JSON.stringify(order())); fs.writeFileSync(path.join(learn, 'playable-vc.json'), JSON.stringify({ marks: 19, by: { en: 17 } }));
  const dry = unflagFile(f, ['Audio/sfx.RAW']);
  assert.equal(dry.written, false); assert.equal(dry.marks, 19); assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), order());
  const r = unflagFile(f, ['Audio/sfx.RAW'], { write: true, now: new Date(0) });
  assert.ok(r.written);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(learn, 'prefetch-vc.json.bak-1970-01-01T00-00-00-000Z'), 'utf8')), order());
  // (a game whose files the order names: a server's /api/prefetch made from the rewritten file)
  fs.mkdirSync(path.join(games, 'vc', 'base', 'Audio'), { recursive: true }); fs.mkdirSync(path.join(games, 'vc', 'versions', '1'), { recursive: true });
  fs.writeFileSync(path.join(games, 'vc', 'base', 'game.exe'), 'MZ');
  fs.writeFileSync(path.join(games, 'vc', 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'vc', name: 'vc', defaultVersion: 'vc', versions: [{ id: 'vc', dir: '1', version: '1', exe: 'game.exe' }] }));
  const server = createServer({ gamesDir: games, learnDir: learn, learnWriteMs: 10, lanLog: () => {} });
  await new Promise((res) => server.listen(0, '127.0.0.1', res)); t.after(() => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }));
  for (const q of ['', '?lang=en']) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/prefetch/vc${q}`), list = await res.json().catch(() => null);
    assert.ok(Array.isArray(list), `${q}: ${res.status}`);
    const flags = Object.fromEntries(list.map((e) => [`${e[0]}#${e[1]}`, e[4]]));
    assert.equal(flags['Audio/sfx.SDT#0'] & PRE_PLAYABLE, PRE_PLAYABLE, `${q}: another file stays flagged`);
    assert.equal(flags['models/fonts.txd#0'] & PRE_PLAYABLE, PRE_PLAYABLE);
    for (const k of ['Audio/sfx.RAW#0', 'Audio/sfx.RAW#1', 'Audio/sfx.RAW#201']) assert.equal(flags[k], 0, `${q}: ${k} listed, unflagged`);
    // (and listed after the order's other entries: no longer fetched first after the launch set)
    const at = (k) => list.findIndex((e) => `${e[0]}#${e[1]}` === k);
    for (const k of ['Audio/sfx.RAW#0', 'Audio/sfx.RAW#1']) assert.ok(at(k) > at('Audio/other.raw#0') && at(k) > at('models/fonts.txd#0'), `${q}: ${k} last`);
  }
});

test('learn-unflag CLI: --only and --path required; a dry run by default', (t) => {
  const d = tmp(t), f = path.join(d, 'prefetch-vc.json');
  fs.writeFileSync(f, JSON.stringify(order())); fs.writeFileSync(path.join(d, 'playable-vc.json'), JSON.stringify({ marks: 19 }));
  assert.equal(spawnSync(process.execPath, [TOOL, d, '--path', 'Audio/sfx.RAW'], { encoding: 'utf8' }).status, 2);
  const out = execFileSync(process.execPath, [TOOL, d, '--only', 'vc', '--path', 'Audio/sfx.RAW'], { encoding: 'utf8' });
  assert.match(out, /dry run/); assert.match(out, /3 entries counted before playable, 2 flagged of 19 marks \(1\.13 MB\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), order());
  assert.match(execFileSync(process.execPath, [TOOL, d, '--only', 'vc', '--only', 'none', '--path', 'Audio/sfx.RAW', '--write'], { encoding: 'utf8' }), /none: no learned order[\s\S]*-> written|-> written[\s\S]*none: no learned order/);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8'))[1].length, 4);
});
