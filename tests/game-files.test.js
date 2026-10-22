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
    await new Promise((r) => setTimeout(r, 20)); // (a tick of the file system's clock later)
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
