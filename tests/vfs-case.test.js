// Windows paths are case-insensitive, mount points included: a path spelled in another case than its mount (a game
// building "c:\users\player\...\save\map.map" in lowercase) reaches that mount, not the root one — BFME1 failed to
// re-create the map of a saved game there (ERROR_PATH_NOT_FOUND) and then looped in its exception handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';

test('a path reaches its mount whatever the case of the mount point', () => {
  const vfs = new Vfs(), root = new MemBackend(), profile = new MemBackend();
  vfs.mount('C:\\', root);
  vfs.mount('C:\\Users\\Player', profile);
  assert.equal(vfs.mkdir('C:\\Users\\Player\\Save'), true);
  const f = vfs.open('c:\\users\\player\\save\\map mp carrock.map', { create: true, write: true });
  assert.ok(f, 'created in the profile mount');
  f.write(0, new Uint8Array([1, 2, 3])); f.close();
  assert.equal(vfs.stat('C:\\Users\\Player\\Save\\Map MP Carrock.map')?.size, 3);
  assert.equal(root.stat('users/player/save/map mp carrock.map'), null, 'nothing in the root mount');
  assert.equal(vfs.resolve('C:\\USERS\\PLAYER').backend, profile);
  assert.equal(vfs.resolve('c:\\game\\data').backend, root);
});
