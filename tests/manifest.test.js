// Manifests synthesized for bare game folders (`orthros run <folder>`): the main executable is picked by
// generic rules — installers/tools skipped, a name matching the folder preferred, then the largest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickExe, folderManifest } from '../src/host/manifest.js';

function folder(name, files) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-man-')), name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, size] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), Buffer.alloc(size)); }
  return dir;
}

test('pickExe: installers and tools are skipped, the folder name wins, then the size', () => {
  assert.equal(pickExe(folder('Space Racer', { 'setup.exe': 900, 'unins000.exe': 800, 'SpaceRacer.exe': 10, 'editor.exe': 500 })), 'SpaceRacer.exe');
  assert.equal(pickExe(folder('mygame', { 'Setup.exe': 900, 'game.exe': 300, 'tool.exe': 100, 'Uninstall.exe': 999 })), 'game.exe');
  assert.equal(pickExe(folder('x', { 'bin/run.exe': 5, 'data/readme.txt': 1 })), 'bin/run.exe'); // one level down
  assert.equal(pickExe(folder('y', { 'setup.exe': 5 })), 'setup.exe'); // nothing else: better than nothing
  assert.equal(pickExe(folder('z', { 'a.txt': 5 })), null);
});

test('folderManifest: the folder manifest.json and explicit options take precedence over the guess', () => {
  const dir = folder('g', { 'a.exe': 10, 'b.exe': 20 });
  assert.equal(folderManifest(dir).exe, 'b.exe');
  assert.equal(folderManifest(dir, { exe: 'a.exe' }).exe, 'a.exe');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ exe: 'a.exe', args: '-win' }));
  const m = folderManifest(dir);
  assert.deepEqual([m.exe, m.args, m.mount, m.folder], ['a.exe', '-win', 'C:\\Game', dir]);
});
