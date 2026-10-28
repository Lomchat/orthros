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
    // (opened as soon as the shared modules are loaded, beside the engine's download — docs/slow-network.md "Opened
    // early" —, the run held only once the engine uses it: before its script ran there is no run to hold)
    for (let i = 0; i < 50 && workers.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(workers.length, 1, 'the game data opened before the engine asked');
    assert.deepEqual(deps, [], 'no run held yet');
    assert.ok(!workers[0].sent.some((m) => m.start), 'not started yet');
    assert.equal(workers[0].sent[0].init.orderAtOpen, true, 'the learned order\'s list asked at the open');
    ctx.__omwLruDefault = 192; // (the engine page's tier, set by its preRun: after the open)
    ctx.StreamFS.init();
    assert.equal(workers.length, 1, 'the same game data');
    assert.equal(ctx.StreamFS.data().budget, 192 << 20, 'its bytes kept as the tier says at the engine\'s first use');
    assert.ok(workers[0].sent.some((m) => m.start), 'started at the engine\'s first use');
    assert.deepEqual(deps, [['add', 'orthros-game-data']], 'held while the worker has not answered');
    ctx.StreamFS.init(); assert.equal(workers.length, 1, 'once');
    workers[0].onmessage({ data: { ready: { trees: {}, kept: {}, manifest: {}, real: [] } } });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(deps, [['add', 'orthros-game-data'], ['remove', 'orthros-game-data']], 'released once it answered');
  } finally { ctx.StreamFS?.close?.(); }
});

// The game data opened early, before the engine's first use (seconds later: its download): an open that fails meanwhile
// (/api/tree 5xx) is not an unhandled rejection — the engine page's log opened on it —; the engine's first use reports it.
test('a game data open failing before the engine asked is not an unhandled rejection', async (t) => {
  const RealWorker = globalThis.Worker, workers = [], unhandled = [], onUnhandled = (e) => unhandled.push(e);
  globalThis.Worker = class { constructor() { this.sent = []; workers.push(this); } postMessage(m) { this.sent.push(m); } };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { globalThis.Worker = RealWorker; process.off('unhandledRejection', onUnhandled); });
  const deps = [];
  const ctx = vm.createContext({
    console: { ...console, warn() {}, error() {} }, URL, Promise, Map, WeakMap, Math, Object, Error, queueMicrotask, decodeURIComponent,
    self: { crossOriginIsolated: true }, location: { pathname: '/ports/openmw/morrowind-goty-en/app/index.html', href: 'https://o.test/ports/openmw/morrowind-goty-en/app/index.html' },
    setInterval: () => 0, clearInterval() {},
    addRunDependency: (id) => deps.push(['add', id]), removeRunDependency: (id) => deps.push(['remove', id]),
  });
  ctx.window = ctx; ctx.globalThis = ctx; ctx.window.parent = ctx;
  try {
    vm.runInContext(SRC, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    for (let i = 0; i < 50 && workers.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(workers.length, 1, 'opened early');
    workers[0].onmessage({ data: { failed: '/api/tree/morrowind-goty-en: HTTP 502' } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(unhandled.length, 0, `unhandled: ${unhandled.map(String)}`);
    // (the engine's first use: the same game data, its failure handled there)
    ctx.StreamFS.init();
    assert.equal(workers.length, 1, 'the same game data');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(unhandled.length, 0);
  } finally { ctx.StreamFS?.close?.(); }
});

// The link after the engine's package (docs/openmw.md): once Emscripten's file_packager package is in (its run
// dependency 'datafile_<name>' removed — the packager calls Module.removeRunDependency, set by the engine's script after
// this one ran), the game data's learned order is asked to load now (GameData.prefetchNow; the worker decides by its store).
test('the engine\'s package in: the game data asked to load its learned order now, before or after the game data opened', async () => {
  const RealWorker = globalThis.Worker;
  {
    const workers = [], deps = [];
    globalThis.Worker = class { constructor() { this.sent = []; workers.push(this); } postMessage(m) { this.sent.push(m); } };
    const ctx = vm.createContext({
      console, URL, Promise, Map, WeakMap, Math, Object, Error, queueMicrotask, decodeURIComponent,
      self: { crossOriginIsolated: true }, location: { pathname: '/ports/openmw/morrowind-goty-en/app/index.html', href: 'https://o.test/ports/openmw/morrowind-goty-en/app/index.html' },
      setInterval: () => 0, clearInterval() {}, Module: {},
    });
    ctx.window = ctx; ctx.globalThis = ctx; ctx.window.parent = ctx;
    try {
      vm.runInContext(SRC, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      const init = async () => { for (let i = 0; i < 50; i++) { try { ctx.StreamFS.init(); return; } catch (e) { if (!/not loaded yet/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 10)); } } };
      await init(); // (the shared modules loaded: the hook installed; this first init opens the game data)
      const w = workers[0]; assert.ok(w, 'the game data opened');
      // (the engine's script, run after this one: its function set on Module, then the packager's call through it)
      ctx.Module.removeRunDependency = (id) => deps.push(id);
      ctx.Module.removeRunDependency('wasm-instantiate');
      assert.equal(w.sent.filter((m) => m.prefetch).length, 0, 'not for another dependency');
      ctx.Module.removeRunDependency('datafile_openmw.data');
      assert.deepEqual(deps, ['wasm-instantiate', 'datafile_openmw.data'], 'the engine\'s own function still called');
      assert.equal(w.sent.filter((m) => m.prefetch).length, 1, 'asked once the package is in');
      assert.ok(w.sent.findIndex((m) => m.start) < w.sent.findIndex((m) => m.prefetch), 'after the engine\'s start');
    } finally { ctx.StreamFS?.close?.(); }
  }
  // (the package in before the game data opened — a fast link: the manifest fetch after it —: asked at the open)
  const workers = [];
  globalThis.Worker = class { constructor() { this.sent = []; workers.push(this); } postMessage(m) { this.sent.push(m); } };
  const ctx = vm.createContext({
    console, URL, Promise, Map, WeakMap, Math, Object, Error, queueMicrotask, decodeURIComponent,
    self: { crossOriginIsolated: true }, location: { pathname: '/ports/openmw/morrowind-goty-en/app/index.html', href: 'https://o.test/ports/openmw/morrowind-goty-en/app/index.html' },
    setInterval: () => 0, clearInterval() {}, Module: { removeRunDependency() {} },
  });
  ctx.window = ctx; ctx.globalThis = ctx; ctx.window.parent = ctx;
  try {
    vm.runInContext(SRC, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    const hooked = () => !!Object.getOwnPropertyDescriptor(ctx.Module, 'removeRunDependency')?.get;
    for (let i = 0; i < 50 && !hooked(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(hooked(), 'the hook installed once the shared modules are loaded');
    ctx.Module.removeRunDependency('datafile_openmw.data');
    assert.equal(workers.length, 1, 'the game data opened with the modules (docs/slow-network.md "Opened early")');
    assert.equal(workers[0].sent.filter((m) => m.prefetch || m.start).length, 0, 'not started before the engine uses it');
    ctx.StreamFS.init();
    assert.equal(workers[0].sent.filter((m) => m.prefetch).length, 1, 'asked as the engine first uses it');
  } finally { ctx.StreamFS?.close?.(); globalThis.Worker = RealWorker; }
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
    ctx.orthrosContentLoading(); // (the engine's content load said before the game data opened: nothing)
    for (let i = 0; i < 50; i++) { try { ctx.StreamFS.init(); break; } catch (e) { if (!/not loaded yet/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 10)); } }
    const w = workers[0]; assert.ok(w, 'the game data opened');
    w.onmessage({ data: { ready: { trees: {}, kept: {}, manifest: {}, real: [] } } });
    const app = 'https://o.test/ports/openmw/morrowind-goty-en/app/';
    ctx.StreamFS.mount('/data/Morrowind.bsa', app + 'mwdata/Morrowind.bsa', 5000000);
    ctx.StreamFS.mount('/data/Meshes/x/a.nif', app + 'mwdata/Meshes/x/a.nif', 9000);
    const list = ['/data/Morrowind.bsa\x1F1048576\x1F70000', '/data/Meshes/x/a.nif\x1F0\x1F-1', '/data/nothing.nif\x1F0\x1F-1', ''].join('\x1E');
    assert.equal(ctx.orthrosWillRead(list, 'meshes:-2,6'), 2, 'two not in the page (the unknown path left out)');
    const data = ctx.StreamFS.data();
    // (posted with its wait window's other lists: at the wait, or once the page's thread yields — GameData.wantFlush)
    assert.equal(w.sent.filter((m) => m.want).length, 0);
    data.wantFlush();
    const sent = w.sent.find((m) => m.want);
    assert.deepEqual(sent.want, { seq: 1, from: 1, list: [['morrowind-goty-en', 'Morrowind.bsa', 1048576, 70000], ['morrowind-goty-en', 'Meshes/x/a.nif', 0, 9000]], label: 'meshes:-2,6' });
    assert.equal(ctx.orthrosReadWait(5), 0, 'not settled: time out');
    assert.equal(ctx.orthrosReadWait(15000), 1, 'nothing announced since the last wait: nothing to wait for');
    // (the next batch's window starts after the one that timed out)
    ctx.StreamFS.mount('/data/Meshes/x/b.nif', app + 'mwdata/Meshes/x/b.nif', 9000);
    assert.equal(ctx.orthrosWillRead('/data/Meshes/x/b.nif\x1F0\x1F-1', 'meshes:-2,7'), 1);
    data.wantFlush();
    assert.equal(w.sent.filter((m) => m.want).at(-1).want.from, 2);
    Atomics.store(data.ctrl, 12, 2);
    assert.equal(ctx.orthrosReadWait(15000), 1, 'settled (ctrl[12] at the batch)');
    assert.equal(data.snapshot().wantTimeouts, 1);
    // (the engine's content load (orthros-r13.patch): its content files light until it says it is over, for good)
    assert.equal(data.content, 'real');
    ctx.orthrosContentLoading(); assert.equal(data.content, 'light');
    ctx.orthrosContentLoaded(); assert.equal(data.content, 'done');
    // (a cell's references listed by their ids: the copies again, said back after)
    ctx.orthrosContentIds(1); assert.equal(data.contentIdsDepth, 1);
    ctx.orthrosContentIds(0); assert.equal(data.contentIdsDepth, 0);
  } finally { ctx.StreamFS?.close?.(); globalThis.Worker = RealWorker; }
});

// Anticipated places (docs/openmw.md "Anticipated places"): each announced batch posted to the server's learned places
// with its place (the files themselves: tree paths and ranges), the place remembered; once the saves are readable the
// save the player most likely loads is parsed (save-place.js), its place's learned set asked of the server and handed
// to the game data at the place's priority (GameData.want prio 'place': the worker's wantPlace, no wait window).
test('anticipated places: announced batches learned (POST /api/places), the predicted save\'s place fetched at the place\'s priority, saves written remembered', async () => {
  const workers = [], RealWorker = globalThis.Worker;
  globalThis.Worker = class { constructor() { this.sent = []; workers.push(this); } postMessage(m) { this.sent.push(m); } };
  const { parseSave } = await import('../src/ports/openmw/save-place.js');
  // (a save as the engine writes one: TES3 FORM 38, SAVE, PLAY with the player's cell RefId before LKEP)
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }, i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
  const sub = (n, d) => Buffer.concat([Buffer.from(n), u32(d.length), d]);
  const rec = (n, ...s) => { const body = Buffer.concat(s); return Buffer.concat([Buffer.from(n), u32(body.length), u32(0), u32(0), body]); };
  const f64 = (n) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
  const save = (cell, time) => new Uint8Array(Buffer.concat([rec('TES3', sub('FORM', u32(38)), sub('HEDR', Buffer.alloc(300))),
    rec('SAVE', sub('PLNA', Buffer.from('player')), sub('TIME', f64(time))), rec('PLAY', sub('NAME', cell), sub('LKEP', Buffer.alloc(8)))]));
  const ext = (x, y) => Buffer.concat([Buffer.from([6]), i32(x), i32(y)]), int = (s) => Buffer.concat([Buffer.from([2]), Buffer.from(s)]);
  assert.equal(parseSave(save(ext(-2, 6), 1)).place, '-2,6');
  // (the engine's file system: the mounted files' nodes, and the saves folders)
  const nodes = new Map(), saves = new Map([['/userdata/saves/player/Quicksave.omwsave', { bytes: save(ext(-2, 6), 30), mtime: 2000 }], ['/userdata/saves/player/old.omwsave', { bytes: save(int('Vivec, Arena'), 90), mtime: 1000 }]]);
  const FS = {
    ErrnoError: class extends Error { constructor(n) { super(`errno ${n}`); this.errno = n; } },
    mkdirTree() {},
    createFile(dir, name) { const n = { stream_ops: {}, node_ops: {} }; nodes.set(`${dir}/${name}`, n); return n; },
    lookupPath(p) { const n = nodes.get(p); if (!n) throw new FS.ErrnoError(44); return { node: n }; },
    readdir(d) {
      const out = new Set();
      for (const p of saves.keys()) if (p.startsWith(d + '/')) out.add(p.slice(d.length + 1).split('/')[0]);
      if (!out.size) throw new FS.ErrnoError(44);
      return ['.', '..', ...out];
    },
    stat(p) { return { mtime: new Date(saves.get(p)?.mtime ?? 0) }; },
    readFile(p) { return saves.get(p).bytes; },
  };
  const store = new Map(), localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const calls = [], intervals = [];
  let places = [['Meshes/x/a.nif', 0, 9000], ['Morrowind.bsa', 1048576, 1118576], { path: 'Textures/t.dds' }, ['nope.nif', 0, -1]];
  const fetch = async (url, init = {}) => { calls.push({ url, init }); return { ok: true, json: async () => places }; };
  const ctx = vm.createContext({
    console, URL, Promise, Map, WeakMap, Math, Object, Error, Number, String, JSON, Array, queueMicrotask, decodeURIComponent, encodeURIComponent, FS, fetch, localStorage,
    self: { crossOriginIsolated: true }, location: { pathname: '/ports/openmw/morrowind-goty-en/app/index.html', href: 'https://o.test/ports/openmw/morrowind-goty-en/app/index.html', origin: 'https://o.test' },
    setInterval: (f) => { intervals.push(f); return intervals.length; }, clearInterval() {},
    __idbfsReady: Promise.resolve(), performance, Module: {},
  });
  ctx.window = ctx; ctx.globalThis = ctx; ctx.window.parent = ctx;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  try {
    vm.runInContext(SRC, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    for (let i = 0; i < 50; i++) { try { ctx.StreamFS.init(); break; } catch (e) { if (!/not loaded yet/.test(e.message)) throw e; await tick(); } }
    const w = workers[0];
    const tree = { dirs: { Meshes: { dirs: { x: { files: { 'a.nif': { size: 9000 }, 'b.nif': { size: 9000 } } } } }, Textures: { files: { 't.dds': { size: 40000, light: 9000 } } } }, files: { 'Morrowind.bsa': { size: 5000000, mtime: 1 } } };
    w.onmessage({ data: { ready: { trees: { 'morrowind-goty-en': tree }, kept: {}, manifest: {}, real: [] } } });
    for (let i = 0; i < 50 && !calls.length; i++) await tick();
    await tick();
    // (the engine still booting — no first frame —: the set asked of the server, not fetched yet)
    assert.ok(!w.sent.some((m) => m.wantPlace), 'not while the engine boots');
    ctx.Module.__omwRunning = false; // (the engine's first frame)
    for (let i = 0; i < 50 && !w.sent.some((m) => m.wantPlace); i++) { for (const f of intervals) f(); await tick(); }
    // (no hint: the newest save — Quicksave at -2,6 — its place's learned set asked, handed to the worker at the place's priority)
    assert.deepEqual(calls.map((c) => c.url), ['/api/places/morrowind-goty-en?place=-2%2C6']);
    const sent = w.sent.find((m) => m.wantPlace).wantPlace;
    assert.equal(sent.label, 'place:-2,6');
    assert.deepEqual(sent.list.slice(0, 2), [['morrowind-goty-en', 'Meshes/x/a.nif', 0, 9000], ['morrowind-goty-en', 'Morrowind.bsa', 1048576, 70000]]);
    assert.equal(sent.list.length, 3, 'the tree\'s files (an unknown path left out)');
    assert.ok(/^(Textures\/t\.dds|\.light\/Textures\/t\.dds)$/.test(sent.list[2][1]), 'a texture as this link reads it (its light copy or the file)');
    assert.ok(!w.sent.some((m) => m.want), 'no announced batch (nothing the engine waits for)');
    const { atMs, ...predicted } = ctx.StreamFS.place();
    assert.deepEqual(predicted, { place: '-2,6', why: 'newest', save: '/userdata/saves/player/Quicksave.omwsave', listed: 3, asked: 3 });
    assert.equal(typeof atMs, 'number');
    assert.equal(ctx.StreamFS.data().wantSeq, 0, 'outside the wait window');

    // (a load the engine announces: its batch to the learned places — the files themselves, their ranges —, the place remembered)
    const app = 'https://o.test/ports/openmw/morrowind-goty-en/app/';
    ctx.StreamFS.mount('/data/Morrowind.bsa', app + 'mwdata/Morrowind.bsa', 5000000);
    ctx.StreamFS.mount('/data/Meshes/x/b.nif', app + 'mwdata/Meshes/x/b.nif', 9000);
    ctx.orthrosWillRead(['/data/Morrowind.bsa\x1F2000\x1F100', '/data/Meshes/x/b.nif\x1F0\x1F-1', '/data/elsewhere.nif\x1F0\x1F-1'].join('\x1E'), "meshes:ald'ruhn, temple");
    const post = calls.find((c) => c.init.method === 'POST');
    assert.equal(post.url, '/api/places/morrowind-goty-en');
    const body = JSON.parse(post.init.body);
    assert.deepEqual({ ...body, session: typeof body.session }, { session: 'string', place: "ald'ruhn, temple", kind: 'meshes', records: [['Morrowind.bsa', 2000, 2100], ['Meshes/x/b.nif', 0, 9000]] });
    const hint = () => JSON.parse(store.get('orthros.place.morrowind-goty-en'));
    assert.equal(hint().place, "ald'ruhn, temple");
    ctx.orthrosWillRead('/data/Meshes/x/b.nif\x1F0\x1F-1', 'nolabel');
    assert.equal(calls.filter((c) => c.init.method === 'POST').length, 1, 'a batch without a place: not learned');
    // (the cells walked through after the session's first load: learned, not the hint)
    ctx.orthrosWillRead('/data/Meshes/x/b.nif\x1F0\x1F-1', 'meshes:-3,-2');
    assert.equal(calls.filter((c) => c.init.method === 'POST').length, 2);
    assert.equal(hint().place, "ald'ruhn, temple", 'a later cell: not the hint');

    // (a save the engine writes: its place is the hint)
    saves.set('/userdata/saves/player/new.omwsave', { bytes: save(int('Balmora, Lucky Lockup'), 5), mtime: 9000 });
    for (const f of intervals) f();
    assert.deepEqual(hint(), { place: 'balmora, lucky lockup', at: 9000 }, 'at the save\'s date');
  } finally { ctx.StreamFS?.close?.(); globalThis.Worker = RealWorker; }
});

test('in play (?lead=1): the next row\'s learned set asked ahead at the place\'s priority, meshes and terrain only; none by default', async () => {
  const workers = [], RealWorker = globalThis.Worker;
  globalThis.Worker = class { constructor() { this.sent = []; workers.push(this); } postMessage(m) { this.sent.push(m); } };
  const run = async (search) => {
    const calls = [], intervals = [], cleared = [];
    const lists = { '-2,-7': [['Meshes/x/a.nif', 0, -1, 'meshes'], ['Textures/t.dds', 0, -1, 'textures'], ['Morrowind.bsa', 1000, 3000, 'terrain']], 'balmora, guild': [['Meshes/x/b.nif', 0, -1, 'meshes']] };
    const fetch = async (url, init = {}) => { calls.push(url); const q = new URL(url, 'https://o.test').searchParams.get('place'); return { ok: true, json: async () => ({ list: lists[q] ?? [] }) }; };
    const ctx = vm.createContext({
      console, URL, URLSearchParams, Promise, Map, WeakMap, Set, Math, Object, Error, Number, String, JSON, Array, queueMicrotask, decodeURIComponent, encodeURIComponent, fetch,
      self: { crossOriginIsolated: true }, location: { pathname: '/ports/openmw/morrowind-goty-en/app/index.html', href: 'https://o.test/ports/openmw/morrowind-goty-en/app/index.html', origin: 'https://o.test', search },
      setInterval: (f) => { intervals.push(f); return intervals.length; }, clearInterval: (id) => { cleared.push(id); }, performance, Module: {},
      omw: { state: {} },
    });
    ctx.window = ctx; ctx.globalThis = ctx; ctx.window.parent = ctx;
    const tick = () => new Promise((r) => setTimeout(r, 5));
    try {
      vm.runInContext(SRC, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      for (let i = 0; i < 50; i++) { try { ctx.StreamFS.init(); break; } catch (e) { if (!/not loaded yet/.test(e.message)) throw e; await tick(); } }
      const w = workers.at(-1);
      const tree = { dirs: { Meshes: { dirs: { x: { files: { 'a.nif': { size: 9000 }, 'b.nif': { size: 7000 } } } } }, Textures: { files: { 't.dds': { size: 40000, light: 9000 } } } }, files: { 'Morrowind.bsa': { size: 5000000, mtime: 1 } } };
      w.onmessage({ data: { ready: { trees: { 'morrowind-goty-en': tree }, kept: {}, manifest: {}, real: [] } } });
      const step = async (state) => { Object.assign(ctx.omw.state, state); for (let k = 0; k < 3; k++) { for (const f of intervals) f(); await tick(); } };
      // (not in the world yet: nothing; then the first cell, a crossing north, a door — no guess)
      await step({ 'orthros.cell': '-2 -9' });
      await step({ 'orthros.view': '8192 8192' });
      await step({ 'orthros.cell': '-2 -8' });
      await step({ 'orthros.door': 'Balmora, Guild' });
      const out = { calls, sent: w.sent.filter((m) => m.wantPlace).map((m) => m.wantPlace), leads: ctx.StreamFS.leads() };
      // (the page's close stops the lead's polling: its interval — the one that looks at the player's place — cleared)
      const leadIds = intervals.map((f, i) => (/\.look\(/.test(String(f)) ? i + 1 : 0)).filter(Boolean);
      ctx.StreamFS.close();
      out.leadIntervals = leadIds.length; out.leadCleared = leadIds.every((id) => cleared.includes(id));
      return out;
    } finally { ctx.StreamFS?.close?.(); }
  };
  try {
    const on = await run('?src=hosted&lead=1');
    assert.deepEqual(on.calls, ['/api/places/morrowind-goty-en?place=-2%2C-7']);
    assert.deepEqual(on.sent.map((s) => s.label), ['lead:-2,-7']);
    // (the row's meshes and terrain — the texture left out —, the files' ranges)
    assert.deepEqual(on.sent[0].list, [['morrowind-goty-en', 'Meshes/x/a.nif', 0, 9000], ['morrowind-goty-en', 'Morrowind.bsa', 1000, 2000]]);
    assert.deepEqual(on.leads, { guessed: 1, bytes: 9000 + 2000, last: ['-2,-7'] });
    assert.deepEqual([on.leadIntervals, on.leadCleared], [1, true], 'StreamFS.close clears the lead\'s interval');
    const off = await run('?src=hosted');
    assert.equal(off.leadIntervals, 0);
    assert.deepEqual([off.calls, off.sent, off.leads], [[], [], null]);
  } finally { globalThis.Worker = RealWorker; }
});
