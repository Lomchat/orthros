// The OpenMW engine page's boot reads announced (src/ports/openmw/boot-reads.js, streamfs.js announceBoot — docs/openmw.md
// "Scripts announced at the boot"): the data folders' scripts, localisation and shaders the engine's VFS resolves, in one
// list once the mounts are over, instead of a round trip each at the engine's boot and at a save's load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bootReads, vfsName, BOOT_FILE_MAX } from '../src/ports/openmw/boot-reads.js';

const SRC = fs.readFileSync(new URL('../src/ports/openmw/streamfs.js', import.meta.url), 'utf8')
  .replaceAll("import('/src/", `import('${new URL('../src/', import.meta.url).href}`);

test('vfsName: a data folder\'s file by the name the engine resolves', () => {
  assert.equal(vfsName('/mwdata/Scripts/A.lua'), 'scripts/a.lua');
  assert.equal(vfsName('/mwmods/ui-toolkit-0/scripts/UI/x.lua'), 'scripts/ui/x.lua');
  assert.equal(vfsName('/mods/openmw-web-assets.bsa'), null, 'the engine\'s asset pack: not a loose file of a data folder');
  assert.equal(vfsName('/mwmods/only-a-folder'), null);
});

test('bootReads: the files the engine resolves (a later data folder wins), their kinds, the smallest first, bounded', () => {
  const h = (size, extra = {}) => ({ size, ...extra });
  const overridden = h(10), winner = h(30), big = h(BOOT_FILE_MAX + 1), elsewhere = h(5, { src: 1 });
  const mounts = [
    ['/mwdata/Morrowind.esm', h(80 << 20)],
    ['/mwmods/a-0/scripts/a/init.lua', h(400)],
    ['/mwmods/a-0/scripts/a/menu.LUA', overridden],
    ['/mwmods/a-0/a.omwscripts', h(50)],
    ['/mwmods/a-0/l10n/A/fr.yaml', h(200)],
    ['/mwmods/a-0/questData/quests.yml', h(3000)],
    ['/mwmods/a-0/shaders/bloom.omwfx', h(900)],
    ['/mwmods/a-0/textures/a.png', h(70)],
    ['/mwmods/a-0/meshes/a.nif', h(60)],
    ['/mwmods/a-0/readme.txt', h(20)],
    ['/mwmods/b-0/Scripts/A/Menu.lua', winner],
    ['/mwmods/b-0/scripts/huge.lua', big],
    ['/mwmods/b-0/scripts/picked.lua', elsewhere],
    ['/mods/openmw-web-assets.bsa', h(1 << 20)],
  ];
  const sizes = (list) => list.map((e) => e.h.size);
  const all = bootReads(mounts);
  assert.deepEqual(sizes(all), [30, 50, 200, 400, 900, 3000], 'scripts, content lists, YAML, shaders; small first');
  assert.ok(all.every((e) => e.off === 0 && e.len === -1), 'whole files');
  assert.ok(all.some((e) => e.h === winner) && !all.some((e) => e.h === overridden), 'the later data folder\'s file only (any case)');
  assert.ok(!all.some((e) => e.h === big), 'a file over the bound left to the engine\'s reads');
  assert.ok(!all.some((e) => e.h === elsewhere), 'a source of elsewhere left out');
  assert.deepEqual(sizes(bootReads(mounts, { maxBytes: 300 })), [30, 50, 200], 'cut at the bytes bound');
  assert.deepEqual(sizes(bootReads(mounts, { maxFiles: 2 })), [30, 50], 'cut at the files bound');
  assert.deepEqual(bootReads([]), []);
});

/** streamfs.js in a context with an engine page's file system; `search`: the page's query. */
function page(search = '') {
  const workers = [];
  const RealWorker = globalThis.Worker;
  globalThis.Worker = class { constructor() { this.sent = []; workers.push(this); } postMessage(m) { this.sent.push(m); } };
  const nodes = new Map(), intervals = new Set();
  const FS = {
    ErrnoError: class extends Error { constructor(n) { super(`errno ${n}`); this.errno = n; } },
    mkdirTree() {},
    createFile(dir, name) { const n = { stream_ops: {}, node_ops: {} }; nodes.set(`${dir}/${name}`, n); return n; },
    lookupPath(p) { const n = nodes.get(p); if (!n) throw new FS.ErrnoError(44); return { node: n }; },
  };
  const ctx = vm.createContext({
    console, URL, URLSearchParams, Promise, Map, WeakMap, Math, Object, Error, Number, String, queueMicrotask, decodeURIComponent, FS, performance,
    self: { crossOriginIsolated: true }, location: { pathname: '/ports/openmw/mw-x/app/index.html', href: 'https://o.test/ports/openmw/mw-x/app/index.html' + search, origin: 'https://o.test', search },
    setInterval: (f, ms) => { const t = setInterval(f, ms); intervals.add(t); return t; }, clearInterval: (t) => { intervals.delete(t); clearInterval(t); }, setTimeout, clearTimeout,
  });
  ctx.window = ctx; ctx.globalThis = ctx; ctx.window.parent = ctx;
  vm.runInContext(SRC, ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  const close = () => { ctx.StreamFS?.close?.(); for (const t of intervals) clearInterval(t); globalThis.Worker = RealWorker; };
  return { ctx, workers, close };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function boot(ctx, workers) {
  for (let i = 0; i < 50; i++) { try { ctx.StreamFS.init(); break; } catch (e) { if (!/not loaded yet/.test(e.message)) throw e; await tick(); } }
  const w = workers[0]; assert.ok(w, 'the game data opened');
  w.onmessage({ data: { ready: { trees: {}, kept: {}, manifest: {}, real: [] } } });
  const app = 'https://o.test/ports/openmw/mw-x/app/';
  ctx.StreamFS.mount('/mwdata/Morrowind.esm', app + 'mwdata/Morrowind.esm', 80 << 20);
  ctx.StreamFS.mount('/mwmods/a-0/scripts/a/init.lua', app + 'mwdata/mods/a-0/scripts/a/init.lua', 400);
  ctx.StreamFS.mount('/mwmods/a-0/scripts/a/menu.lua', app + 'mwdata/mods/a-0/scripts/a/menu.lua', 10);
  ctx.StreamFS.mount('/mwmods/a-0/l10n/A/fr.yaml', app + 'mwdata/mods/a-0/l10n/A/fr.yaml', 200);
  ctx.StreamFS.mount('/mwmods/b-0/scripts/a/menu.lua', app + 'mwdata/mods/b-0/scripts/a/menu.lua', 30);
  return w;
}

test('streamfs: the boot\'s scripts announced in one list once the engine page\'s mods are mounted, the later folder\'s file', async () => {
  const { ctx, workers, close } = page();
  try {
    const w = await boot(ctx, workers);
    await tick(250);
    assert.ok(ctx.orthrosTurns > 0, 'the page\'s turns counted (orthros-r14.patch\'s put-offs)');
    assert.equal(w.sent.filter((m) => m.want).length, 0, 'not while the mounts go on');
    assert.equal(ctx.StreamFS.boot(), null);
    ctx.__serverMods = { dirs: ['/mwmods/a-0', '/mwmods/b-0'] }; // (the engine page: every mod mounted)
    for (let i = 0; i < 50 && !w.sent.some((m) => m.want); i++) await tick(20);
    const sent = w.sent.filter((m) => m.want);
    assert.equal(sent.length, 1, 'one list');
    assert.deepEqual(sent[0].want, { seq: 0, list: [['mw-x', 'mods/b-0/scripts/a/menu.lua', 0, 30], ['mw-x', 'mods/a-0/l10n/A/fr.yaml', 0, 200], ['mw-x', 'mods/a-0/scripts/a/init.lua', 0, 400]], label: 'boot:scripts', wait: false },
      'fetched at once, not waited for (the engine\'s reads join them); the overridden file and the content file left out');
    assert.deepEqual({ ...ctx.StreamFS.boot(), atMs: 0 }, { files: 3, bytes: 630, asked: 3, atMs: 0 });
    ctx.orthrosContentLoading(); // (the content load after: nothing announced again)
    assert.equal(w.sent.filter((m) => m.want).length, 1, 'once');
  } finally { close(); }
});

test('streamfs: the boot\'s scripts announced at the content load when the engine page never says its mods are in; ?bootreads=0: none', async () => {
  {
    const { ctx, workers, close } = page();
    try {
      const w = await boot(ctx, workers);
      ctx.orthrosContentLoading();
      const sent = w.sent.filter((m) => m.want);
      assert.equal(sent.length, 1, 'at the content load');
      assert.equal(sent[0].want.list.length, 3);
    } finally { close(); }
  }
  {
    const { ctx, workers, close } = page('?bootreads=0');
    try {
      const w = await boot(ctx, workers);
      ctx.__serverMods = { dirs: [] };
      await tick(250);
      ctx.orthrosContentLoading();
      assert.equal(w.sent.filter((m) => m.want).length, 0, 'the engine\'s reads alone');
      assert.equal(ctx.StreamFS.boot()?.off, true);
    } finally { close(); }
  }
});
