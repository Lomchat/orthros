// A browser port's game files (src/ports/port-files.js): the game data opened as soon as the page knows its version —
// beside its engine's download, with the page's manifest and tree, the learned order's list asked at the open
// (openPortData) —, its files mounted in the engine's file system only once it is ready (mountPortFiles);
// docs/slow-network.md "Opened early".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPortData, mountPortFiles } from '../src/ports/port-files.js';

test('openPortData opens at once with the page\'s manifest and tree; mountPortFiles mounts once the worker answered', async (t) => {
  const workers = [], RealWorker = globalThis.Worker;
  globalThis.Worker = class { constructor() { this.sent = []; workers.push(this); } postMessage(m) { this.sent.push(m); } terminate() {} };
  t.after(() => { globalThis.Worker = RealWorker; });
  const tree = { dirs: { valve: { dirs: {}, files: { 'a.wad': { size: 3, mtime: 1 } } } }, files: {} }, manifest = { name: 'hl', runtime: 'goldsrc' };
  const data = openPortData({ name: 'hl', tree, manifest, session: 's1', lang: 'en', log() {} });
  t.after(() => data.close());
  assert.equal(workers.length, 1, 'its worker started at once');
  const init = workers[0].sent[0].init;
  assert.equal(init.name, 'hl'); assert.deepEqual(init.manifest, manifest); assert.deepEqual(init.tree, tree);
  assert.equal(init.orderAtOpen, true); assert.equal(init.prefetch, 'startup');
  assert.ok(data.times.open >= 0 && data.times.ready === null);
  // (the engine in before the worker answered: the mount waits for it)
  const made = [], FS = { mkdirTree() {}, createFile(dir, name) { const n = { dir, name, node_ops: {}, stream_ops: {} }; made.push(n); return n; } };
  let mounted = null;
  const mounting = mountPortFiles(data, { name: 'hl', files: [{ path: 'valve/a.wad' }], FS, root: '/rodir', log() {} }).then((r) => (mounted = r));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mounted, null, 'not mounted before the worker answered'); assert.equal(made.length, 0);
  workers[0].onmessage({ data: { ready: { trees: { hl: tree }, kept: { hl: true }, manifest, real: [] } } });
  await mounting;
  assert.equal(mounted.data, data); assert.equal(mounted.nodes.size, 1);
  assert.deepEqual(made.map((n) => [n.dir, n.name]), [['/rodir/valve', 'a.wad']]);
  const s = data.snapshot();
  assert.ok(s.readyMs >= s.openMs && s.mountedMs >= s.readyMs, JSON.stringify(s));
});

test('a game data that failed to open: told where the page mounts it, never as an unhandled rejection', async (t) => {
  const workers = [], RealWorker = globalThis.Worker;
  globalThis.Worker = class { constructor() { this.sent = []; workers.push(this); } postMessage(m) { this.sent.push(m); } terminate() {} };
  t.after(() => { globalThis.Worker = RealWorker; });
  const unhandled = []; const on = (e) => unhandled.push(e); process.on('unhandledRejection', on); t.after(() => process.off('unhandledRejection', on));
  const data = openPortData({ name: 'hl', tree: { dirs: {}, files: {} }, session: 's1', log() {} });
  t.after(() => data.close());
  workers[0].onmessage({ data: { failed: 'HTTP 500' } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(unhandled, []);
  await assert.rejects(mountPortFiles(data, { name: 'hl', files: [], FS: {}, root: '/r', log() {} }), /HTTP 500/);
});
