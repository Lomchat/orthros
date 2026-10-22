// Player profile moves declared by a manifest (src/vfs/profile-moves.js): a game's files put at their new place of the
// profile before it starts — idempotent, nothing overwritten, the browser's mirror told what to remove — and the
// catalog's check of the field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemBackend } from '../src/vfs/vfs.js';
import { NodeBackend } from '../src/vfs/node-backend.js';
import { applyProfileMoves, profileMovesProblem } from '../src/vfs/profile-moves.js';
import { loadGameCatalog } from '../src/host/game-catalog.js';

const LEAF = 'AppData/Roaming/My Game Files';
const MOVES = [{ from: 'AppData/Roaming', to: LEAF }];
const bytes = (s) => new TextEncoder().encode(s);
const text = (b, p) => { const st = b.stat(p); return st && !st.isDir ? new TextDecoder().decode(b.open(p).read(0, st.size)) : null; };

function put(b, p, s) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) b.mkdir(parts.slice(0, i).join('/'));
  const f = b.open(p, { create: true, truncate: true }); f.write(0, bytes(s)); f.close?.();
}

/** An old-layout profile: the settings and saves directly in Roaming, the new folder already made (empty maps). */
function oldProfile(b) {
  for (const d of ['Temp', 'AppData', 'AppData/Roaming', 'AppData/Local']) b.mkdir(d);
  put(b, 'AppData/Roaming/Options.ini', 'Resolution = 800 600\r\n');
  put(b, 'AppData/Roaming/Save/one.sav', 'save one');
  put(b, 'AppData/Roaming/Save/Sub/two.sav', 'save two');
  b.mkdir('AppData/Roaming/Replays');
  b.mkdir(LEAF); b.mkdir(LEAF + '/Maps');
  put(b, 'AppData/Local/other.dat', 'not moved');
}

for (const [kind, make] of [['MemBackend', () => new MemBackend()], ['NodeBackend', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-moves-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new NodeBackend(dir);
}]]) {
  test(`${kind}: files and folders moved to the new place, folders merged, once`, (t) => {
    const b = make(t); oldProfile(b);
    const { moved, kept } = applyProfileMoves(b, MOVES);
    assert.deepEqual(kept, []);
    assert.equal(text(b, LEAF + '/Options.ini'), 'Resolution = 800 600\r\n');
    assert.equal(text(b, LEAF + '/Save/one.sav'), 'save one');
    assert.equal(text(b, LEAF + '/save/sub/TWO.sav'), 'save two');
    assert.ok(b.stat(LEAF + '/Replays')?.isDir && b.stat(LEAF + '/Maps')?.isDir);
    assert.deepEqual(b.readdir('AppData/Roaming').map((e) => e.name), ['My Game Files']); // (nothing left at the old place)
    assert.equal(text(b, 'AppData/Local/other.dat'), 'not moved');
    assert.ok(moved.some(([s, d]) => s === 'AppData/Roaming/Options.ini' && d === LEAF + '/Options.ini'));
    // (the names keep their case at the new place)
    assert.ok(b.readdir(LEAF).some((e) => e.name === 'Save'));
    // idempotent: a later start changes nothing
    assert.deepEqual(applyProfileMoves(b, MOVES), { moved: [], kept: [] });
  });

  test(`${kind}: a file the new place already has is never overwritten — the old one stays`, (t) => {
    const b = make(t); oldProfile(b);
    put(b, LEAF + '/Options.ini', 'Resolution = 1024 768\r\n');
    const { kept } = applyProfileMoves(b, MOVES);
    assert.deepEqual(kept, ['AppData/Roaming/Options.ini']);
    assert.equal(text(b, LEAF + '/Options.ini'), 'Resolution = 1024 768\r\n');
    assert.equal(text(b, 'AppData/Roaming/Options.ini'), 'Resolution = 800 600\r\n');
    assert.equal(text(b, LEAF + '/Save/one.sav'), 'save one'); // (the rest moved all the same)
    assert.deepEqual(applyProfileMoves(b, MOVES).moved, []);
  });
}

test('names: only the entries listed move; a profile without the old folder is left alone', () => {
  const b = new MemBackend(); oldProfile(b);
  applyProfileMoves(b, [{ from: 'AppData/Roaming', to: LEAF, names: ['options.INI'] }]);
  assert.ok(b.stat(LEAF + '/Options.ini') && !b.stat('AppData/Roaming/Options.ini'));
  assert.equal(text(b, 'AppData/Roaming/Save/one.sav'), 'save one');
  const empty = new MemBackend();
  assert.deepEqual(applyProfileMoves(empty, MOVES), { moved: [], kept: [] });
  assert.equal(empty.dirs.size, 1); // (no folder made where nothing moved)
  assert.deepEqual(applyProfileMoves(b, undefined), { moved: [], kept: [] });
});

test('the browser mirror is told every change: new folders, moved files, old folders removed after their files', () => {
  const b = new MemBackend(); oldProfile(b);
  b.changes = new Set();
  applyProfileMoves(b, MOVES);
  const order = [...b.changes];
  for (const k of ['appdata/roaming/options.ini', 'appdata/roaming/save/one.sav', 'appdata/roaming/save', 'appdata/roaming/replays',
    `${LEAF.toLowerCase()}/options.ini`, `${LEAF.toLowerCase()}/save`, `${LEAF.toLowerCase()}/save/sub/two.sav`]) assert.ok(order.includes(k), k);
  // (a folder removed after the files it held, a new folder before the files moved into it — the mirror replays in order)
  assert.ok(order.indexOf('appdata/roaming/save/sub/two.sav') < order.indexOf('appdata/roaming/save/sub'));
  assert.ok(order.indexOf('appdata/roaming/save/sub') < order.indexOf('appdata/roaming/save'));
  assert.ok(order.indexOf(`${LEAF.toLowerCase()}/save`) < order.indexOf(`${LEAF.toLowerCase()}/save/one.sav`));
  // (removed folders keep their original name: the mirror removes 'Save', not 'save')
  assert.equal(b.names.get('appdata/roaming/save'), 'Save');
  assert.ok(!b.dirs.has('appdata/roaming/save') && !b.files.has('appdata/roaming/options.ini'));
});

test('MemBackend.rmdir removes only an empty folder', () => {
  const b = new MemBackend(); b.mkdir('A'); b.mkdir('A/B'); put(b, 'A/f', 'x');
  assert.equal(b.rmdir('A'), false); assert.equal(b.rmdir(''), false); assert.equal(b.rmdir('none'), false);
  assert.equal(b.rmdir('A/B'), true); b.unlink('A/f'); assert.equal(b.rmdir('a'), true);
  assert.deepEqual([...b.dirs], ['']);
});

test('profileMoves checked: paths, fields, a destination containing its source', () => {
  assert.equal(profileMovesProblem(undefined), null);
  assert.equal(profileMovesProblem(MOVES), null);
  assert.equal(profileMovesProblem([{ from: 'AppData/Roaming', to: 'AppData/Roaming/My Battle for Middle-earth(tm) II Files', names: ['Options.ini'] }]), null);
  for (const bad of [{}, [{ from: 'A' }], [{ from: '/A', to: 'B' }], [{ from: 'A/../B', to: 'C' }], [{ from: 'A\\B', to: 'C' }],
    [{ from: 'A', to: 'a' }], [{ from: 'A/B', to: 'A' }], [{ from: 'A', to: 'B', names: [] }], [{ from: 'A', to: 'B', names: ['x/y'] }],
    [{ from: 'A', to: 'B', extra: 1 }], [{ from: 'A', to: 'C:' }], new Array(9).fill({ from: 'A', to: 'B' })]) {
    assert.ok(profileMovesProblem(bad), JSON.stringify(bad));
  }
  // (an invalid list is not applied)
  const b = new MemBackend(); oldProfile(b);
  assert.deepEqual(applyProfileMoves(b, [{ from: 'AppData/Roaming', to: 'AppData' }]), { moved: [], kept: [] });
});

test('the catalog refuses a version with invalid profileMoves and passes valid ones on', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-games-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'alpha');
  fs.mkdirSync(path.join(dir, 'base'), { recursive: true }); fs.mkdirSync(path.join(dir, 'versions', '1.0'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'base', 'Game.exe'), 'x');
  const spec = { schemaVersion: 1, id: 'alpha', name: 'alpha', defaultVersion: 'alpha-1', defaults: { profileMoves: MOVES }, versions: [{ id: 'alpha-1', dir: '1.0', version: '1.0', exe: 'Game.exe' }] };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(spec));
  assert.deepEqual(loadGameCatalog(root).get('alpha-1').profileMoves, MOVES);
  spec.defaults.profileMoves = [{ from: 'AppData/Roaming', to: '../outside' }];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(spec));
  assert.throws(() => loadGameCatalog(root), /profileMoves/);
});
