// The OpenMW engine page's file streaming (src/ports/openmw/streamfs.js): the engine's start (its Emscripten run) held
// until the game data worker answered — its first reads wait synchronously, and Chrome hands a module worker the
// messages sent before its scripts ran through the page's thread: a read before then is never answered (the engine's
// boot right after a short manifest fetch, "the game data worker stopped answering" 30 s later, Morrowind.bsa unreadable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../src/ports/openmw/streamfs.js', import.meta.url), 'utf8')
  .replaceAll("import('/src/", `import('${new URL('../src/', import.meta.url).href}`);

test('the engine does not run before the game data worker answered (its run dependency)', async () => {
  const workers = [];
  globalThis.Worker ??= class { constructor() { this.sent = []; workers.push(this); } postMessage(m) { this.sent.push(m); } };
  const deps = [], timers = [];
  const ctx = vm.createContext({
    console, URL, Promise, Map, WeakMap, Math, Object, Error, queueMicrotask, decodeURIComponent,
    self: { crossOriginIsolated: true }, location: { pathname: '/ports/openmw/morrowind-goty-en/app/index.html', href: 'https://o.test/ports/openmw/morrowind-goty-en/app/index.html' },
    setInterval: (f, ms) => { timers.push(f); return timers.length; }, clearInterval() {},
    addRunDependency: (id) => deps.push(['add', id]), removeRunDependency: (id) => deps.push(['remove', id]),
  });
  ctx.window = ctx; ctx.globalThis = ctx; ctx.window.parent = ctx;
  try {
    vm.runInContext(SRC, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    for (let i = 0; i < 50 && workers.length === 0; i++) {
      try { ctx.StreamFS.init(); } catch (e) { if (!/not loaded yet/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 10)); }
    }
    assert.equal(workers.length, 1, 'the game data opened');
    assert.deepEqual(deps, [['add', 'orthros-game-data']], 'held while the worker has not answered');
    ctx.StreamFS.init(); assert.equal(workers.length, 1, 'once');
    workers[0].onmessage({ data: { ready: { trees: {}, kept: {}, manifest: {}, real: [] } } });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(deps, [['add', 'orthros-game-data'], ['remove', 'orthros-game-data']], 'released once it answered');
  } finally { ctx.StreamFS?.data()?.close?.(); }
});

test('announced reads (orthrosWillRead / orthrosReadWait): engine paths to the game data\'s handles, an archive\'s range as it, one batch', async () => {
  const workers = [], RealWorker = globalThis.Worker;
  globalThis.Worker = class { constructor() { this.sent = []; workers.push(this); } postMessage(m) { this.sent.push(m); } };
  // (the engine's file system, enough for the file nodes: a node per created file, found by its path)
  const nodes = new Map();
  const FS = {
    ErrnoError: class extends Error { constructor(n) { super(`errno ${n}`); this.errno = n; } },
    mkdirTree() {},
    createFile(dir, name) { const n = { stream_ops: {}, node_ops: {} }; nodes.set(`${dir}/${name}`, n); return n; },
    lookupPath(p) { const n = nodes.get(p); if (!n) throw new FS.ErrnoError(44); return { node: n }; },
  };
  const ctx = vm.createContext({
    console, URL, Promise, Map, WeakMap, Math, Object, Error, Number, String, queueMicrotask, decodeURIComponent, FS,
    self: { crossOriginIsolated: true }, location: { pathname: '/ports/openmw/morrowind-goty-en/app/index.html', href: 'https://o.test/ports/openmw/morrowind-goty-en/app/index.html', origin: 'https://o.test' },
    setInterval: () => 0, clearInterval() {},
  });
  ctx.window = ctx; ctx.globalThis = ctx; ctx.window.parent = ctx;
  try {
    vm.runInContext(SRC, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    assert.equal(ctx.orthrosWillRead('x\x1F0\x1F-1', 'meshes:0,0'), 0, 'no game data yet: nothing announced');
    assert.equal(ctx.orthrosReadWait(100), 1, 'nor waited for');
    for (let i = 0; i < 50; i++) { try { ctx.StreamFS.init(); break; } catch (e) { if (!/not loaded yet/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 10)); } }
    const w = workers[0]; assert.ok(w, 'the game data opened');
    w.onmessage({ data: { ready: { trees: {}, kept: {}, manifest: {}, real: [] } } });
    const app = 'https://o.test/ports/openmw/morrowind-goty-en/app/';
    ctx.StreamFS.mount('/data/Morrowind.bsa', app + 'mwdata/Morrowind.bsa', 5000000);
    ctx.StreamFS.mount('/data/Meshes/x/a.nif', app + 'mwdata/Meshes/x/a.nif', 9000);
    const list = ['/data/Morrowind.bsa\x1F1048576\x1F70000', '/data/Meshes/x/a.nif\x1F0\x1F-1', '/data/nothing.nif\x1F0\x1F-1', ''].join('\x1E');
    assert.equal(ctx.orthrosWillRead(list, 'meshes:-2,6'), 2, 'two not in the page (the unknown path left out)');
    const sent = w.sent.find((m) => m.want);
    assert.deepEqual(sent.want, { seq: 1, from: 1, list: [['morrowind-goty-en', 'Morrowind.bsa', 1048576, 70000], ['morrowind-goty-en', 'Meshes/x/a.nif', 0, 9000]], label: 'meshes:-2,6' });
    const data = ctx.StreamFS.data();
    assert.equal(ctx.orthrosReadWait(5), 0, 'not settled: time out');
    assert.equal(ctx.orthrosReadWait(15000), 1, 'nothing announced since the last wait: nothing to wait for');
    // (the next batch's window starts after the one that timed out)
    ctx.StreamFS.mount('/data/Meshes/x/b.nif', app + 'mwdata/Meshes/x/b.nif', 9000);
    assert.equal(ctx.orthrosWillRead('/data/Meshes/x/b.nif\x1F0\x1F-1', 'meshes:-2,7'), 1);
    assert.equal(w.sent.filter((m) => m.want).at(-1).want.from, 2);
    Atomics.store(data.ctrl, 12, 2);
    assert.equal(ctx.orthrosReadWait(15000), 1, 'settled (ctrl[12] at the batch)');
    assert.equal(data.snapshot().wantTimeouts, 1);
  } finally { ctx.StreamFS?.data()?.close?.(); globalThis.Worker = RealWorker; }
});
