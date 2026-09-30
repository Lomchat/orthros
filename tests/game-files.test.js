import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listGameTree, resolveGameFile } from '../src/host/game-files.js';
import { OverlayBackend } from '../src/vfs/overlay-backend.js';

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
