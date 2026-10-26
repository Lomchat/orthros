// This browser's storage as the data window and the account's sync see it (src/host/web/data-store.js scanStorage): a
// game's profile is only its own folder — the page's other folders under the same prefix (the translated code kept
// across sessions, the OpenMW page's copies of 2026-10-20) are caches, never read whole and sent to the account as a
// save (2026-10-26: the home's automatic sync read them into memory, "Out of Memory" a few seconds after the home).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanStorage, removeCache, removeOther } from '../src/host/web/data-store.js';

/** an OPFS directory in memory: files are their sizes */
class FakeDir {
  constructor(tree = {}) {
    this.kind = 'directory'; this.items = new Map();
    for (const [n, v] of Object.entries(tree)) this.items.set(n, typeof v === 'number' ? { kind: 'file', getFile: async () => ({ size: v }) } : new FakeDir(v));
  }
  async *entries() { yield* this.items.entries(); }
  async getDirectoryHandle(name) { const d = this.items.get(name); if (!(d instanceof FakeDir)) throw Object.assign(new Error(name), { name: 'NotFoundError' }); return d; }
  async removeEntry(name) { if (!this.items.delete(name)) throw Object.assign(new Error(name), { name: 'NotFoundError' }); }
}
function withRoot(tree) {
  const root = new FakeDir(tree);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => root, estimate: async () => ({ usage: 1, quota: 2 }), persisted: async () => false } } });
  return root;
}

test('the translated code and the OpenMW copies are caches, not profiles; a restore left behind is a copy aside', async () => {
  withRoot({
    'orthros-bfme1-108': { AppData: { 'Options.ini': 180 } },
    'orthros-files-bfme1-108': { 'blocks.bin': 5000, 'index.bin': 40 },
    'orthros-jitcache': { 'bfme1-108.bin': 700, 'rotwk-202.bin': 300 },
    'orthros-streamfs-1': { 'a.d': 900_000_000, 'a.m': 10 },
    'orthros-bfme2-aside-2026-10-21T10-00-00-000Z': { 'x.ini': 5 },
    'orthros-bfme2-restore-1792579504816': { 'y.ini': 7 },
  });
  const st = await scanStorage();
  assert.deepEqual(st.games.map((g) => [g.game, g.profile, g.cache]), [['bfme1-108', 180, 5740], ['rotwk-202', 0, 300]]);
  assert.deepEqual(st.others.map((o) => [o.name, o.bytes]), [['orthros-streamfs-1', 900_000_010]]);
  assert.deepEqual(st.asides.map((a) => a.name).sort(), ['orthros-bfme2-aside-2026-10-21T10-00-00-000Z', 'orthros-bfme2-restore-1792579504816']);
});

test('clearing a game\'s cache removes its translated code too (even with no game files kept); only known folders go as "others"', async () => {
  const root = withRoot({ 'orthros-jitcache': { 'bfme1-108.bin': 700, 'rotwk-202.bin': 300 }, 'orthros-streamfs-1': { 'a.d': 9 }, 'orthros-bfme1-108': { 'Options.ini': 1 } });
  await removeCache('bfme1-108', null);
  assert.deepEqual([...root.items.get('orthros-jitcache').items.keys()], ['rotwk-202.bin']);
  await assert.rejects(removeOther('orthros-bfme1-108'));
  assert.ok(root.items.has('orthros-bfme1-108'));
  await removeOther('orthros-streamfs-1');
  assert.ok(!root.items.has('orthros-streamfs-1'));
});
