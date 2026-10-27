import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listGameTree, resolveGameFile, dirsStamp, DirListings } from '../src/host/game-files.js';
import { OverlayBackend } from '../src/vfs/overlay-backend.js';
import { createServer } from '../src/host/server.js';

test('version files override base files and both directory trees remain visible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-layers-'));
  try {
    const baseFolder = path.join(root, 'base'), folder = path.join(root, 'version');
    fs.mkdirSync(path.join(baseFolder, 'Data'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'data'), { recursive: true });
    fs.writeFileSync(path.join(baseFolder, 'Data', 'common.big'), 'base');
    fs.writeFileSync(path.join(baseFolder, 'Data', 'only.big'), 'only');
    fs.writeFileSync(path.join(folder, 'data', 'COMMON.big'), 'patch');
    const manifest = { folder, baseFolder };
    const tree = listGameTree(manifest);
    assert.deepEqual(Object.keys(tree.dirs), ['data']);
    assert.deepEqual(Object.keys(tree.dirs.data.files), ['COMMON.big', 'only.big']);
    assert.equal(fs.readFileSync(resolveGameFile(manifest, 'DATA/common.big'), 'utf8'), 'patch');
    assert.equal(fs.readFileSync(resolveGameFile(manifest, 'data/ONLY.big'), 'utf8'), 'only');
    assert.equal(resolveGameFile(manifest, '../secret'), null);
    const backend = new OverlayBackend([folder, baseFolder]);
    assert.deepEqual(backend.readdir('data').map((f) => f.name), ['COMMON.big', 'only.big']);
    assert.equal(backend.stat('DATA/common.big').size, 5);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the folders a tree is listed from tell when it changes; many paths resolved over the same listings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-stamp-')), recent = DirListings.RECENT_MS;
  try {
    const baseFolder = path.join(root, 'base'), folder = path.join(root, 'version');
    fs.mkdirSync(path.join(baseFolder, 'Data', 'Maps'), { recursive: true }); fs.mkdirSync(folder);
    fs.writeFileSync(path.join(baseFolder, 'Data', 'Maps', 'a.bsp'), 'a');
    const manifest = { folder, baseFolder }, dirs = [];
    listGameTree(manifest, dirs);
    assert.deepEqual(dirs.sort(), [baseFolder, path.join(baseFolder, 'Data'), path.join(baseFolder, 'Data', 'Maps'), folder].sort());
    // (folders changed a moment ago: a stamp of their own each time — the file system's clock is coarse)
    assert.notEqual(dirsStamp(dirs), dirsStamp(dirs), 'just changed: not trusted');
    DirListings.RECENT_MS = 0; // (as if older)
    const stamp = dirsStamp(dirs);
    assert.equal(dirsStamp(dirs), stamp, 'nothing changed');
    // (past the file system's timestamp tick, ~4 ms here: a folder changed within the tick of its first listing keeps
    // the same times — the test failed one run in two or three)
    for (const t0 = Date.now(); Date.now() - t0 < 25;);
    fs.writeFileSync(path.join(baseFolder, 'Data', 'Maps', 'b.bsp'), 'b');
    assert.notEqual(dirsStamp(dirs), stamp, 'a file added deep in a folder');
    // (one listing a folder for a run of lookups: the same answers as one by one)
    const memo = new Map();
    for (const rel of ['data/maps/A.BSP', 'DATA/Maps/b.bsp', 'data/maps/c.bsp', 'data', '../x']) assert.equal(resolveGameFile(manifest, rel, memo), resolveGameFile(manifest, rel), rel);
    assert.ok(memo.has(path.join(baseFolder, 'Data', 'Maps')));
  } finally { DirListings.RECENT_MS = recent; fs.rmSync(root, { recursive: true, force: true }); }
});

test('the home\'s list of games keeps each game\'s tree: listed again only when one of its folders changed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-trees-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, 'alpha');
  for (let d = 0; d < 4; d++) { fs.mkdirSync(path.join(game, 'base', `d${d}`), { recursive: true }); for (let f = 0; f < 50; f++) fs.writeFileSync(path.join(game, 'base', `d${d}`, `f${f}.dat`), 'x'); }
  fs.writeFileSync(path.join(game, 'base', 'game.exe'), 'exe'); fs.mkdirSync(path.join(game, 'versions', '1'), { recursive: true });
  fs.writeFileSync(path.join(game, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'alpha', name: 'Alpha', defaultVersion: 'alpha-1', versions: [{ id: 'alpha-1', dir: '1', version: '1', exe: 'game.exe' }] }));
  const server = createServer({ gamesDir: root });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bytes = async () => (await (await fetch(base + '/api/manifests')).json())[0].bytes;
  const recent = DirListings.RECENT_MS; DirListings.RECENT_MS = 0; t.after(() => { DirListings.RECENT_MS = recent; }); // (the folders as if older)
  assert.equal(await bytes(), 203);
  // (the game's 201 files stat'ed once: then its folders only)
  const stat = fs.statSync; let stats = 0;
  fs.statSync = (...a) => { stats++; return stat(...a); }; t.after(() => { fs.statSync = stat; });
  assert.equal(await bytes(), 203);
  assert.ok(stats < 40, `${stats} stats`);
  fs.statSync = stat;
  await new Promise((r) => setTimeout(r, 20)); // (a tick of the file system's clock later)
  fs.writeFileSync(path.join(game, 'base', 'd2', 'new.dat'), 'four');
  assert.equal(await bytes(), 207, 'a file added in a folder: the tree listed again');
  assert.ok((await (await fetch(base + '/api/tree/alpha-1')).json()).dirs.d2.files['new.dat']);
});

test('a file taken from a required version is marked with its owner only when /gamez/<owner>/ serves the same file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-owner-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, body = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  for (const f of ['o/base/a.dat', 'o/base/hidden.dat', 'o/base/_engine/e.dat', 'o/base/tex.tga', 'o/ver/b.dat', 'r/ver/own.dat', 'r/ver/a2.dat', 'o/engine/hidden.dat']) put(f);
  // (a TGA of a screen's size: it has a light copy)
  const tga = Buffer.alloc(18 + 1024 * 512 * 3); tga[2] = 2; tga.writeUInt16LE(1024, 12); tga.writeUInt16LE(512, 14); tga[16] = 24; put('o/base/tex.tga', tga);
  const owner = { folder: path.join(root, 'o/ver'), baseFolder: path.join(root, 'o/base'), overlays: [path.join(root, 'o/engine')], dataMounts: [{ at: '_engine', dir: path.join(root, 'o/mount') }] };
  const man = { folder: path.join(root, 'r/ver'), lightCopies: true, underlays: [owner.folder, owner.baseFolder], underlayOwners: [{ manifest: 'o', dirs: [owner.folder, owner.baseFolder] }] };
  const marks = (m, ownerOf) => { const tree = listGameTree(m, null, ownerOf); return Object.fromEntries(Object.entries(tree.files).map(([n, e]) => [n, e.owner ?? null])); };
  assert.deepEqual(marks(man, (id) => (id === 'o' ? owner : null)), { 'own.dat': null, 'a2.dat': null, 'b.dat': 'o', 'a.dat': 'o', 'hidden.dat': null, 'tex.tga': null },
    'its own files, one the owner\'s overlay hides, a light copy the owner does not serve: not marked');
  assert.equal(listGameTree(man, null, () => owner).dirs._engine.files['e.dat'].owner, undefined, 'under the owner\'s data mount: another file there');
  assert.equal(marks(man, () => ({ ...owner, lightCopies: true }))['tex.tga'], 'o', 'the owner serves light copies too');
  assert.ok(listGameTree(man, null, () => ({ ...owner, lightCopies: true })).files['tex.tga'].light > 0);
  assert.deepEqual(Object.values(marks(man, null)).filter(Boolean), [], 'no owners known: no marks');
});

test('a required version\'s file is marked only when it is that version\'s own at the same path: a shared base, a hard link', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-owner-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, body = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  // (one game folder G: version a overrides base's X; version b — a port — requires a and shares the base)
  for (const f of ['G/base/X.dat', 'G/base/Y.dat', 'G/versions/b/own.dat', 'H/a/arch.bsa', 'H/a/copy.bsa']) put(f, f);
  put('G/versions/a/X.dat', 'a\'s own X, longer');
  const a = { folder: path.join(root, 'G/versions/a'), baseFolder: path.join(root, 'G/base') };
  const b = { folder: path.join(root, 'G/versions/b'), baseFolder: a.baseFolder, underlays: [a.folder, a.baseFolder], underlayOwners: [{ manifest: 'a', dirs: [a.folder, a.baseFolder] }] };
  const seen = [], tree = listGameTree(b, seen, (id) => (id === 'a' ? a : null));
  assert.equal(tree.files['X.dat'].owner, undefined, 'b sees base\'s X; /gamez/a/X.dat serves a\'s other X: b\'s own');
  assert.equal(tree.files['Y.dat'].owner, 'a', 'the base\'s Y: the same file through a');
  assert.equal(tree.files['own.dat'].owner, undefined);
  assert.ok(seen.includes(a.folder), 'a\'s folder watched (a file added there changes the marks)');
  // (a port's version folder keeping hard links of the files of the version it requires — not a copy)
  const c = { folder: path.join(root, 'H/c'), underlays: [path.join(root, 'H/a')], underlayOwners: [{ manifest: 'a2', dirs: [path.join(root, 'H/a')] }] };
  fs.mkdirSync(c.folder, { recursive: true });
  fs.linkSync(path.join(root, 'H/a/arch.bsa'), path.join(c.folder, 'arch.bsa'));
  fs.copyFileSync(path.join(root, 'H/a/copy.bsa'), path.join(c.folder, 'copy.bsa'));
  const tc = listGameTree(c, null, (id) => (id === 'a2' ? { folder: path.join(root, 'H/a') } : null));
  assert.equal(tc.files['arch.bsa'].owner, 'a2', 'a hard link of the owner\'s file: the owner\'s');
  assert.equal(tc.files['copy.bsa'].owner, undefined, 'a copy (another file): the version\'s own');
});
