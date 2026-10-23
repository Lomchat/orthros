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
