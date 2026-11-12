// A game folder of the player's own (src/vfs/local-games.js, docs/drop-game.md): copied into its block store, it must
// be read entirely from there by the same reader as the server's games — a key format drifting between the copy and
// the reader would send every read to a server that does not have the game (it fails at once: `local`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemBlockStore } from '../src/vfs/opfs-store.js';
import { openVersion, PartsBackend } from '../src/vfs/game-data.js';
import { copyIntoStore, folderTree, localId, localManifest } from '../src/vfs/local-games.js';

const bytes = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7 + (i >> 9)) & 255; return b; };
const file = (path, b, mtime = 1700000000000) => ({ path, file: new Blob([b]), size: b.length, mtime });

test('a dropped folder: copied into its store (resumed), synthesized manifest, read back with no network', async (t) => {
  const big = bytes((2 << 20) + 777, 1), exe = bytes(70000, 2), ini = bytes(12, 3);
  const files = [file('Data/A.big', big), file('MyGame.exe', exe), file('setup.exe', bytes(900000, 4)), file('cfg/x.ini', ini)];
  const id = await localId('My Game', files);
  assert.match(id, /^local-my-game-[0-9a-f]{8}$/);
  assert.equal(id, await localId('My Game', files.slice().reverse()), 'the same folder, the same id');
  const m = localManifest(id, 'My Game', files);
  assert.deepEqual([m.exe, m.profileKey, m.mount, m.local], ['MyGame.exe', id, 'C:\\Game', true], 'the game, not its installer');
  // (an interrupted copy resumes: the blocks there are not read again)
  const store = new MemBlockStore(1 << 30), stop = { n: 0 };
  assert.equal(await copyIntoStore(files, store, {}, () => ++stop.n > 2), false);
  const progress = {};
  assert.equal(await copyIntoStore(files, store, progress), true);
  assert.equal(progress.bytes, progress.total);
  assert.ok(progress.stored < progress.total, 'resumed');
  const realFetch = globalThis.fetch, asked = [];
  globalThis.fetch = (url) => { asked.push(String(url)); return Promise.reject(new Error('no network')); };
  t.after(() => { globalThis.fetch = realFetch; });
  const version = await openVersion(id, { tree: folderTree(files), manifest: m, store: () => store, encoded: false, local: true });
  const game = new PartsBackend(version, id);
  for (const [p, b] of [['data/a.BIG', big], ['MYGAME.EXE', exe], ['cfg/X.ini', ini]]) {
    const f = game.open(p);
    await f.prepare?.(0, b.length);
    assert.deepEqual(f.read(0, b.length), b, p);
  }
  assert.deepEqual(asked, [], 'nothing asked of the server');
});
