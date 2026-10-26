// The game data every runtime reads (CLAUDE.md "Standardization"): the served tree with an engine's data mount, the
// data worker of the engines that run in the page (reads, files of elsewhere, learned reports, startup set, copies
// handed over), its page-side client, the Emscripten file nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/host/server.js';
import { listGameTree, resolveGameFile } from '../src/host/game-files.js';
import { treeFile, treeFiles, treeBytes, languageFiles } from '../src/vfs/game-tree.js';
import { createDataWorker } from '../src/vfs/data-worker.js';
import { GameData, PIECE, readsReal } from '../src/vfs/data-client.js';
import { fileNode, mountFiles, phaseOnRead } from '../src/vfs/emscripten-files.js';
import { BLOCK } from '../src/vfs/http-backend.js';
import { FAST_BPS } from '../src/vfs/net-link.js';

const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed + (i >> 10)) & 255);

test('a data mount puts an engine release\'s folder in the served tree under its own name, nowhere else', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-mount-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['base', 'ver', 'engine']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'base/Game.esm'), 'game'); fs.writeFileSync(path.join(root, 'engine/pack.bsa'), 'pack');
  const man = { folder: path.join(root, 'ver'), baseFolder: path.join(root, 'base'), dataMounts: [{ at: '_engine', dir: path.join(root, 'engine') }] };
  const tree = listGameTree(man);
  assert.deepEqual(Object.keys(tree.files), ['Game.esm']); assert.deepEqual(Object.keys(tree.dirs._engine.files), ['pack.bsa']);
  assert.equal(resolveGameFile(man, '_engine/pack.bsa'), path.join(root, 'engine/pack.bsa'));
  assert.equal(resolveGameFile(man, '_engine/../base/Game.esm'), null);
  assert.equal(resolveGameFile(man, 'pack.bsa'), null, 'not among the game\'s own files');
  assert.deepEqual(treeFile(tree, '_ENGINE/Pack.BSA'), { path: '_engine/pack.bsa', size: 4, mtime: tree.dirs._engine.files['pack.bsa'].mtime });
  assert.equal(treeBytes(tree), 8);
  assert.deepEqual(languageFiles(treeFiles({ dirs: { valve: { files: { 'a.txt': { size: 1 } } }, valve_french: { files: { 'a.txt': { size: 2 } } } }, files: {} }), { valve_french: 'valve' }).map((f) => [f.path, f.at]), [['valve_french/a.txt', 'valve/a.txt']]);
});

test('an OpenMW installation serves its engine\'s asset pack with its game files (/api/tree, /gamez)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-omwdata-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), engines = path.join(root, 'engines'), game = path.join(games, 'mw');
  fs.mkdirSync(path.join(game, 'base'), { recursive: true }); fs.mkdirSync(path.join(game, 'versions/1'), { recursive: true });
  fs.writeFileSync(path.join(game, 'base/Game.esm'), bytes(300000));
  fs.writeFileSync(path.join(game, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'mw', name: 'MW', defaultVersion: 'mw-1', defaults: { runtime: 'openmw' },
    versions: [{ id: 'mw-1', dir: '1', version: '1', openmw: { engine: 'e1', files: ['Game.esm'] } }] }));
  fs.mkdirSync(path.join(engines, 'e1/moddata'), { recursive: true }); fs.writeFileSync(path.join(engines, 'e1/moddata/openmw-web-assets.bsa'), bytes(200000, 7));
  const server = createServer({ gamesDir: games, enginesDir: engines });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tree = await (await fetch(base + '/api/tree/mw-1')).json();
  assert.equal(tree.dirs._engine.files['openmw-web-assets.bsa'].size, 200000);
  const part = new Uint8Array(await (await fetch(base + '/gamez/mw-1/_engine/openmw-web-assets.bsa?r=1000-5000')).arrayBuffer());
  assert.deepEqual(part, bytes(200000, 7).subarray(1000, 5000));
});

/**
 * A server of one version for the data worker: /api/manifest, /api/tree, /api/prefetch, /gamez ranges (`lights`: files'
 * light copies, under .light/); requests logged. `required`: { files, learned } of a version 'r' it requires
 * (extraMounts), its requests logged as 'r:<path>'.
 */
function fakeServer(files, learned = [], lights = {}, required = null) {
  const posts = [], asked = [];
  const version = (files, lights = {}) => {
    const tree = { dirs: {}, files: {} };
    for (const [p, b] of Object.entries(files)) {
      const parts = p.split('/'); let node = tree;
      for (const d of parts.slice(0, -1)) node = node.dirs[d] ??= { dirs: {}, files: {} };
      node.files[parts.at(-1)] = { size: b.length, mtime: 5, ...(lights[p] ? { light: lights[p].length } : {}) };
    }
    return { tree, files: { ...files, ...Object.fromEntries(Object.entries(lights).map(([p, b]) => ['.light/' + p, b])) } };
  };
  const vs = { v: { ...version(files, lights), learned, man: { name: 'v', ...(required ? { extraMounts: [{ manifest: 'r', at: 'C:\\R' }] } : {}) } } };
  if (required) vs.r = { ...version(required.files), learned: required.learned ?? [], man: { name: 'r' } };
  const fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://x');
    const api = /^\/api\/(manifest|tree|prefetch)\/(\w+)$/.exec(u.pathname), av = api && vs[api[2]];
    if (av && api[1] === 'manifest') return Response.json(av.man);
    if (av && api[1] === 'tree') return Response.json(av.tree);
    if (av && api[1] === 'prefetch') { if (init.method === 'POST') { posts.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); } return Response.json(av.learned); }
    const m = /^\/gamez\/(\w+)\/(.+)$/.exec(u.pathname), gv = m && vs[m[1]];
    if (gv && gv.files[decodeURIComponent(m[2])]) {
      const [a, b] = u.searchParams.get('r').split('-').map(Number); asked.push([(m[1] === 'v' ? '' : m[1] + ':') + decodeURIComponent(m[2]), a, b, u.searchParams.get('p') ? 'bg' : 'demand']);
      const body = gv.files[decodeURIComponent(m[2])].slice(a, b);
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    }
    if (u.pathname === '/elsewhere.bin') { const all = bytes(5000, 9), [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? 'bytes=0-4999').map(Number); return new Response(all.slice(a, b + 1), { status: 206 }); }
    return new Response('no', { status: 404 });
  };
  return { fetch, posts, asked };
}

/** The data worker in this thread, its answers collected. */
async function startWorker(t, server, init = {}) {
  const realFetch = globalThis.fetch; globalThis.fetch = server.fetch; t.after(() => { globalThis.fetch = realFetch; });
  const out = [], handle = createDataWorker((m) => out.push(m));
  const ctrl = new Int32Array(new SharedArrayBuffer(64)), data = new Uint8Array(new SharedArrayBuffer(16 << 20));
  handle({ init: { name: 'v', session: 'sess1', prefetch: 'none', ctrl: ctrl.buffer, data: data.buffer, ...init } });
  const until = async (ok, what) => { for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(ok(), what); };
  await until(() => out.some((m) => m.ready || m.failed), 'ready');
  t.after(() => handle({ close: true }));
  let gen = 0;
  const read = async (path, off, len, want = 0) => { handle({ gen: ++gen, name: 'v', path, off, len, want }); await until(() => Atomics.load(ctrl, 0) === gen, 'answered'); return ctrl[1] < 0 ? null : data.slice(0, ctrl[1]); };
  return { handle, out, ctrl, data, read, until };
}

test('the data worker answers the page\'s reads, more than asked when it has it, files of elsewhere too', async (t) => {
  const esm = bytes(3 << 20), small = bytes(5000, 3), server = fakeServer({ 'Data/Game.esm': esm, 'small.txt': small });
  const w = await startWorker(t, server);
  assert.deepEqual(Object.keys(w.out.find((m) => m.ready).ready.trees), ['v']);
  assert.deepEqual(await w.read('data/game.esm', 0, 100), esm.subarray(0, 100), 'found without case: at least what was asked');
  const more = await w.read('Data/Game.esm', 0, 100, 1 << 20);
  assert.ok(more.length > 100 && more.length <= 1 << 20, `${more.length}: on, as far as it is here already`);
  assert.deepEqual(more, esm.subarray(0, more.length));
  assert.deepEqual(await w.read('small.txt', 4000, 2000), small.subarray(4000));
  assert.equal(await w.read('nothing', 0, 10), null);
  w.handle({ source: { id: 0, url: '/elsewhere.bin' } });
  w.handle({ gen: 99, src: 0, off: 10, len: 20 }); await w.until(() => Atomics.load(w.ctrl, 0) === 99, 'source');
  assert.equal(w.ctrl[1], 20); assert.deepEqual(w.data.slice(0, 20), bytes(5000, 9).subarray(10, 30));
  assert.ok(server.asked.every(([, a, b]) => Number.isInteger(a) && Number.isInteger(b) && b > a));
});

test('the data worker reports the pieces the engine used, loads the startup set, and keeps copies handed over', async (t) => {
  const esm = bytes(3 << 20), server = fakeServer({ 'Game.esm': esm, 'b.dat': bytes(70000, 4) }, [['Game.esm', 0, 0, 0], ['Game.esm', 1, 0, 500], ['b.dat', 0, 0, 9000]]);
  const w = await startWorker(t, server);
  // (the startup set: the learned order up to its first pause of 2 s — the first two blocks)
  w.handle({ startup: true });
  await w.until(() => w.out.some((m) => m.startup?.done), 'startup');
  assert.equal(w.out.findLast((m) => m.startup).startup.total, 2 << 20);
  assert.ok(server.asked.some(([p, a]) => p === 'Game.esm' && a === 1 << 20), 'the second learned block fetched');
  assert.ok(!server.asked.some(([p]) => p === 'b.dat'), 'not past the pause');
  // (copies handed over: read without a request)
  const before = server.asked.length;
  w.handle({ migrate: [{ name: 'v', path: 'b.dat', at: 0, bytes: bytes(70000, 4) }] });
  assert.deepEqual(await w.read('b.dat', 65536, 4000), bytes(70000, 4).subarray(65536, 69536));
  assert.equal(server.asked.length, before, 'from the copy handed over');
  // (the engine's first uses, reported with their time since its start)
  w.handle({ start: true }); w.handle({ used: [['v', 'Game.esm', 0], ['v', 'Game.esm', 1], ['v', 'Game.esm', 0]] }); w.handle({ close: true });
  await w.until(() => server.posts.length, 'reported');
  assert.deepEqual(server.posts[0].reads.map((r) => r.slice(0, 3)), [['Game.esm', 0, 2 * PIECE]]);
  assert.equal(server.posts[0].session, 'sess1');
});

test('the page\'s phases go with the reports: each one\'s start in the session\'s time, the same one twice in a row once', async (t) => {
  const server = fakeServer({ 'maps/a.bsp': bytes(70000, 4) });
  const w = await startWorker(t, server);
  w.handle({ phase: { name: 'early', ago: 0 } }); // (before the engine's start: no session time yet)
  w.handle({ start: true });
  // (the map's file read, its phase told a little later: dated from that read)
  await new Promise((r) => setTimeout(r, 15));
  w.handle({ used: [['v', 'maps/a.bsp', 0]], phase: { name: 'a', ago: 10 } }); w.handle({ phase: { name: 'a', ago: 0 } });
  await new Promise((r) => setTimeout(r, 30));
  w.handle({ phase: { name: 'b', ago: 20 } }); w.handle({ close: true });
  await w.until(() => server.posts.length, 'reported');
  const { phases, reads } = server.posts[0];
  assert.deepEqual(phases.map(([n]) => n), ['a', 'b']);
  assert.ok(phases[0][1] <= reads[0][3], 'the read of its map at or after its start');
  assert.ok(phases[1][1] >= phases[0][1] && phases[1][1] <= phases[0][1] + 30, `b dated 20 ms before it was told: ${phases}`);
});

test('the startup set covers the versions a version requires, each from its own learned order', async (t) => {
  const server = fakeServer({ 'Game.esm': bytes(3 << 20) }, [['Game.esm', 0, 0, 0]], {}, { files: { 'Base.dat': bytes(2 << 20, 5) }, learned: [['Base.dat', 1, 0, 0]] });
  const w = await startWorker(t, server);
  assert.deepEqual(Object.keys(w.out.find((m) => m.ready).ready.trees), ['v', 'r']);
  w.handle({ startup: true });
  await w.until(() => w.out.some((m) => m.startup?.done), 'startup');
  assert.equal(w.out.findLast((m) => m.startup).startup.total, 2 << 20, 'a block of each');
  assert.ok(server.asked.some(([p, a]) => p === 'Game.esm' && a === 0), 'the version\'s');
  assert.ok(server.asked.some(([p, a]) => p === 'r:Base.dat' && a === 1 << 20), 'the required version\'s, its own order');
});

test('the page\'s client reads through the worker: pieces kept in the page, asked once, the engine\'s waits by message', async (t) => {
  const esm = bytes(1 << 20), server = fakeServer({ 'Game.esm': esm });
  const realFetch = globalThis.fetch; globalThis.fetch = server.fetch; t.after(() => { globalThis.fetch = realFetch; });
  // (the worker in this thread: the client's synchronous reads would wait for it forever, its asynchronous ones work)
  const fake = { onmessage: null, postMessage: (m) => queueMicrotask(() => handle(m)), terminate() {} };
  const handle = createDataWorker((m) => queueMicrotask(() => fake.onmessage?.({ data: m })));
  const data = await GameData.open({ name: 'v', worker: fake, prefetch: 'none' }); t.after(() => data.close());
  const h = data.file('v', 'game.ESM');
  assert.equal(h.size, 1 << 20); assert.equal(data.file('v', 'nothing'), null);
  assert.equal(data.missing(h, 1000, 10), true);
  await data.ensure(h, 1000, 100000);
  assert.equal(data.missing(h, 1000, 100000), false);
  const out = new Uint8Array(100000); assert.equal(data.read(h, out, 0, 100000, 1000), 100000);
  assert.deepEqual(out, esm.subarray(1000, 101000));
  const asked = server.asked.length; data.read(h, new Uint8Array(10), 0, 10, 5000); assert.equal(server.asked.length, asked, 'kept in the page');
  assert.ok(data.snapshot().hits > 0);
});

test('a file not in the page yet is not readable at once: fetched in the background, once, then readable without a wait', async (t) => {
  const wav = bytes(200000, 3), server = fakeServer({ 'Sound/Fx/step.wav': wav });
  const data = await inThread(t, server), h = data.file('v', 'sound/fx/STEP.wav');
  assert.equal(data.readable(h), false); assert.equal(data.readable(h), false, 'asked again meanwhile');
  const first = h.ensuring; assert.ok(first, 'its fetch under way');
  await first;
  assert.equal(data.readable(h), true);
  const out = new Uint8Array(h.size), asked = server.asked.length;
  assert.equal(data.read(h, out, 0, h.size, 0), h.size); assert.deepEqual(out, wav);
  assert.equal(server.asked.length, asked, 'read from the page: no wait');
  assert.equal(server.asked.filter(([p]) => p === 'Sound/Fx/step.wav').length >= 1, true);
  // (a fetch that fails: readable — its read waits and says what failed)
  const gone = data.fileAs('v', 'gone.wav', 1000);
  assert.equal(data.readable(gone), false); await gone.ensuring.catch?.(() => {}); await new Promise((r) => setTimeout(r, 20));
  assert.equal(data.readable(gone), true);
});

test('a range of a file (an archive\'s member) not in the page yet: fetched in the background, once, only its pieces; then readable', async (t) => {
  const bsa = bytes(1 << 20, 5), server = fakeServer({ 'Morrowind.bsa': bsa });
  const data = await inThread(t, server), h = data.file('v', 'morrowind.BSA');
  const at = 300000, len = 70000;
  assert.equal(data.readable(h, at, len), false); assert.equal(data.readable(h, at, len), false, 'asked again meanwhile');
  assert.equal(h.ensuringRanges.size, 1, 'one fetch for those bytes'); assert.equal(h.ensuring ?? null, null, 'not the whole file');
  await [...h.ensuringRanges.values()][0];
  assert.equal(data.readable(h, at, len), true);
  const out = new Uint8Array(len), asked = server.asked.length;
  assert.equal(data.read(h, out, 0, len, at), len); assert.deepEqual(out, bsa.subarray(at, at + len));
  assert.equal(server.asked.length, asked, 'read from the page: no wait');
  assert.equal(data.missing(h, 0, h.size), true, 'the rest of the archive not fetched for it');
  // (to the end, a negative size; past the end, or nothing: readable)
  assert.equal(data.readable(h, h.size - 1000, -1), false); await Promise.all(h.ensuringRanges.values());
  assert.equal(data.readable(h, h.size - 1000, -1), true);
  assert.equal(data.readable(h, h.size + 5, 10), true); assert.equal(data.readable(h, 10, 0), true);
});

/** The page's client and its worker in this thread (asynchronous reads only), on `server`. */
const nativeFetch = globalThis.fetch;
async function inThread(t, server, o = {}) {
  globalThis.fetch = server.fetch; t.after(() => { globalThis.fetch = nativeFetch; });
  const fake = { onmessage: null, postMessage: (m) => queueMicrotask(() => handle(m)), terminate() {} };
  const handle = createDataWorker((m) => queueMicrotask(() => fake.onmessage?.({ data: m })));
  const data = await GameData.open({ name: 'v', worker: fake, prefetch: 'none', ...o }); t.after(() => data.close());
  return data;
}
const until = async (ok, what, ms = 10000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); assert.ok(ok(), what); };

test('on a link that is not fast a texture\'s load reads its light copy, the file itself fetched after it for its next load', async (t) => {
  const tex = bytes(300000, 2), light = bytes(40000, 8), server = fakeServer({ 'tex.dds': tex }, [], { 'tex.dds': light });
  const data = await inThread(t, server), h = data.file('v', 'TEX.dds'), out = new Uint8Array(h.size);
  await data.ensure(h, 0, h.size);
  assert.equal(data.read(h, out, 0, h.size, 0), h.size);
  assert.deepEqual(out.subarray(0, light.length), light); assert.ok(out.subarray(light.length).every((b) => b === 0), 'zeros past it');
  assert.ok(!server.asked.some(([p, , , kind]) => p === 'tex.dds' && kind === 'demand'), 'the file itself not waited for');
  // (the file in the background, the link quiet; told to the page: its next load reads it)
  await until(() => data.realHere.has('v\ntex.dds'), 'the file itself here');
  assert.ok(server.asked.some(([p, , , kind]) => p === 'tex.dds' && kind === 'bg'));
  data.read(h, out, 0, 100, 5000); assert.deepEqual(out.subarray(0, 100), light.subarray(5000, 5100), 'the same load: its light copy still');
  h.at = -Infinity; await data.ensure(h, 0, h.size); data.read(h, out, 0, h.size, 0);
  assert.deepEqual(out, tex, 'its next load: the file');
});

test('an engine that reloads in place gets the file of a texture read light soon (the game quiet 1.5 s, not 8)', async (t) => {
  const tex = bytes(300000, 2), light = bytes(40000, 8), server = fakeServer({ 'tex.dds': tex }, [], { 'tex.dds': light });
  const data = await inThread(t, server, { reloads: true }), h = data.file('v', 'tex.dds'), out = new Uint8Array(h.size);
  const t0 = Date.now();
  await data.ensure(h, 0, h.size); data.read(h, out, 0, h.size, 0);
  assert.deepEqual(out.subarray(0, light.length), light);
  await until(() => data.realHere.has('v\ntex.dds'), 'the file itself here', 6000);
  assert.ok(Date.now() - t0 < 6000, `${Date.now() - t0} ms`);
});

test('on a fast link a texture\'s load reads the file; the learned order brings light copies on a link that is not fast', async (t) => {
  const tex = bytes(300000, 2), light = bytes(40000, 8), learned = [['tex.dds', 0, 0, 0]];
  const fast = fakeServer({ 'tex.dds': tex }, learned, { 'tex.dds': light });
  const data = await inThread(t, fast, { bw: 50 << 20 }), h = data.file('v', 'tex.dds'), out = new Uint8Array(h.size);
  await until(() => Atomics.load(data.ctrl, 7) === 1, 'the link fast');
  await data.ensure(h, 0, h.size); data.read(h, out, 0, h.size, 0);
  assert.deepEqual(out, tex); assert.ok(!fast.asked.some(([p]) => p.startsWith('.light/')));
  await data.startup(); assert.ok(!fast.asked.some(([p]) => p.startsWith('.light/')), 'the files themselves ahead');
  data.close(); await new Promise((r) => setTimeout(r, 20)); // (one data worker at a time in this thread: closed first)
  const slow = fakeServer({ 'tex.dds': tex }, learned, { 'tex.dds': light });
  const data2 = await inThread(t, slow);
  await data2.startup();
  assert.deepEqual(slow.asked.map(([p]) => p), ['.light/tex.dds'], 'its light copy ahead, not the file');
  // (told to the page: that load reads its light copy, here, even once the link is measured fast)
  await until(() => data2.lightHere.has('v\ntex.dds'), 'the light copy here');
});

test('a texture\'s load reads the file or its light copy by the link, unless the page says what its loads are for', () => {
  const link = { thin: { thin: true, measured: true, fast: false }, between: { thin: false, measured: true, fast: false },
    fast: { thin: false, measured: true, fast: true }, unknown: { thin: false, measured: false, fast: false } };
  const real = (l, o = {}) => readsReal({ here: false, lightHere: false, ...link[l], ...o });
  assert.deepEqual(Object.keys(link).map((l) => real(l)), [false, true, true, false], 'light on a thin link or one not measured');
  assert.deepEqual(Object.keys(link).map((l) => real(l, { lightHere: true })), [false, false, false, false], 'its light copy here: no wait');
  assert.deepEqual(Object.keys(link).map((l) => real(l, { prefer: 'light' })), [false, false, false, false], 'the far ring: light');
  assert.deepEqual(Object.keys(link).map((l) => real(l, { prefer: 'real', lightHere: true })), [true, true, true, true]);
  assert.deepEqual(Object.keys(link).map((l) => real(l, { prefer: 'light', here: true })), [true, true, true, true], 'the file here: itself');
  // (an engine that loads a file again in place: light first on every link that is not fast)
  assert.deepEqual(Object.keys(link).map((l) => real(l, { reloads: true })), [false, false, true, false], 'reloads: light unless fast');
  assert.deepEqual(Object.keys(link).map((l) => real(l, { reloads: true, prefer: 'real' })), [true, true, true, true]);
});

test('an engine that reloads in place: its loads choose again at the next start (repick), the current one keeps its copy; upgrades soon', () => {
  const told = [], fake = { onmessage: null, postMessage: (m) => told.push(m), terminate() {} };
  const data = new GameData({ name: 'v', worker: fake });
  try {
    assert.equal(data.reloadsInPlace, false); data.reloads(true); assert.equal(data.reloadsInPlace, true);
    const c = data.ctrl; c[7] = 0; c[8] = 1000; c[9] = 0; // (a link measured between thin and fast)
    const h = data.fileAs('v', 'tex.dds', 300000); h.light = 40000;
    assert.notEqual(data.pick(h, 0), h, 'between thin and fast: light first'); assert.equal(data.lightRead(h), true);
    assert.deepEqual(told.find((m) => m.light).light, { name: 'v', path: 'tex.dds', soon: true }, 'its upgrade soon');
    // (the file here, the engine about to reload it: the rest of the load keeps the light copy, the next load the file)
    data.realHere.add('v\ntex.dds'); data.repick(h);
    assert.notEqual(data.pick(h, 4096), h, 'mid-load: the light copy still');
    assert.equal(data.pick(h, 0), h, 'its reload: the file'); assert.equal(data.lightRead(h), false);
    // (an engine that cannot reload: the file itself on a link between thin and fast, as before)
    const g = new GameData({ name: 'v', worker: { onmessage: null, postMessage() {}, terminate() {} } });
    g.ctrl[8] = 1000; const h2 = g.fileAs('v', 'tex.dds', 300000); h2.light = 40000;
    assert.equal(g.pick(h2, 0), h2); g.close();
  } finally { data.close(); }
});

test('the page\'s game data says when nothing waits (no read waited, the learned order idle) and the link\'s kind', async (t) => {
  const server = fakeServer({ 'Game.esm': bytes(1 << 20) });
  const w = await startWorker(t, server);
  await w.until(() => Atomics.load(w.ctrl, 11) > 0, 'its counters');
  assert.equal(Atomics.load(w.ctrl, 10), 1, 'no learned order running: idle'); assert.equal(Atomics.load(w.ctrl, 9), 0, 'not measured: not thin');
  const fake = { onmessage: null, postMessage() {}, terminate() {} };
  const data = new GameData({ name: 'v', worker: fake }); t.after(() => data.close());
  const c = data.ctrl;
  c[10] = 1; c[11] = 5000; assert.equal(data.quiet(), true);
  c[11] = 1000; assert.equal(data.quiet(), false, 'a read waited 1 s ago'); assert.equal(data.quiet(500), true);
  c[11] = 5000; c[6] = 1; assert.equal(data.quiet(), false, 'a read waits');
  c[6] = 0; c[10] = 0; assert.equal(data.quiet(), false, 'the learned order busy with the current step');
  c[9] = 1; assert.equal(data.thin, true);
  data.prefer('light'); assert.equal(data.preferred, 'light'); data.prefer('nonsense'); assert.equal(data.preferred, null);
});

test('an Emscripten file node reads its bytes through the game data, maps the file whole, refuses writes', () => {
  class ErrnoError extends Error { constructor(errno) { super('errno ' + errno); this.errno = errno; } }
  const made = [];
  const FS = { ErrnoError, mkdirTree() {}, createFile(dir, name) { const n = { dir, name, node_ops: { getattr: () => ({ size: 0 }) }, stream_ops: { mmap: () => 'mapped' } }; made.push(n); return n; } };
  const file = bytes(10000), h = { path: 'a.bin', size: 10000, whole: null };
  const data = { read: (hh, buf, off, len, pos) => { buf.set(file.subarray(pos, pos + len), off); return Math.min(len, file.length - pos); }, whole: (hh) => (hh.whole = file), missing: () => false, ensure: async () => {}, wantWhole() {} };
  const node = fileNode(FS, '/game/a.bin', data, h, { asyncReads: true });
  assert.equal(node.usedBytes, 10000); assert.equal(node.node_ops.getattr(node).size, 10000);
  const buf = new Uint8Array(50); assert.equal(node.stream_ops.read({}, buf, 0, 50, 100), 50); assert.deepEqual(buf, file.subarray(100, 150));
  assert.equal(node.stream_ops.mmap(), 'mapped'); assert.equal(node.contents, file);
  assert.throws(() => node.stream_ops.write(), (e) => e.errno === 69);
  assert.equal(node.stream_ops.llseek({ position: 10 }, -5, 2), 9995);
  assert.equal(typeof node.orthrosStreamed.ensure, 'function');
  const failing = fileNode(FS, '/game/b.bin', { ...data, read: () => { throw new Error('gone'); } }, { path: 'b.bin', size: 5 });
  assert.throws(() => failing.stream_ops.read({}, buf, 0, 5, 0), (e) => e.errno === 29, 'EIO for the engine');
  const nodes = mountFiles(FS, '/root', { file: (n, p) => ({ path: p, size: 3 }) }, 'v', [{ path: 'x/y.txt' }, { path: 'z.txt', at: 'w/z.txt' }]);
  assert.equal(nodes.size, 2); assert.deepEqual(made.slice(-2).map((n) => [n.dir, n.name]), [['/root/x', 'y.txt'], ['/root/w', 'z.txt']]);
});

test('a map\'s load starts its phase: an open that reads half its .bsp or more, once, dated from that open\'s first read; a listing does not', () => {
  const told = [], data = { phase: (name, ago) => told.push([name, ago]) };
  const toldAtRead = [];
  const node = (p, size) => ({ p, usedBytes: size, stream_ops: { read: (s, buf, off, len) => { toldAtRead.push(told.length); return len; } } });
  const bsp = node('/rodir/valve/maps/C1A0.bsp', 1000), wad = node('/rodir/valve/gfx.wad', 1000);
  const FS = { getPath: (n) => n.p };
  assert.equal(phaseOnRead(FS, [bsp, wad], data, (p) => /\/maps\/([^/]+)\.bsp$/i.exec(p)?.[1].toLowerCase() ?? null), 1);
  const listing = {}; bsp.stream_ops.read(listing, null, 0, 100, 0); bsp.stream_ops.read(listing, null, 0, 300, 500);
  assert.deepEqual(told, [], 'a header and a lump: not a load');
  const load = {}; bsp.stream_ops.read(load, null, 0, 400, 0); bsp.stream_ops.read(load, null, 0, 600, 400); bsp.stream_ops.read(load, null, 0, 10, 0);
  assert.equal(told.length, 1); assert.equal(told[0][0], 'c1a0');
  assert.deepEqual(toldAtRead.slice(-3), [0, 1, 1], 'told before the read that reaches half the file (its fetches are the phase\'s)'); assert.ok(told[0][1] >= 0 && told[0][1] < 1000);
  wad.stream_ops.read({}, null, 0, 1000, 0); assert.equal(told.length, 1, 'other files: no phase');
  bsp.stream_ops.read({}, null, 0, 1000, 0); assert.equal(told.length, 2, 'loaded again: told again');
});

test('a page\'s read reports teach the server\'s learned list, in the page\'s own times', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-stream-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), gs = path.join(games, 'gs');
  fs.mkdirSync(path.join(gs, 'base', 'valve', 'maps'), { recursive: true }); fs.mkdirSync(path.join(gs, 'versions', 'orig'), { recursive: true });
  fs.writeFileSync(path.join(gs, 'base', 'valve', 'gfx.wad'), bytes(5000, 7));
  fs.writeFileSync(path.join(gs, 'base', 'valve', 'maps', 'start.bsp'), bytes(2 * BLOCK, 7));
  fs.writeFileSync(path.join(gs, 'base', 'valve', 'bom.txt'), Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]));
  fs.writeFileSync(path.join(gs, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'gs', name: 'GS', defaultVersion: 'gs-orig', defaults: { runtime: 'goldsrc' },
    versions: [{ id: 'gs-orig', dir: 'orig', version: 'O', goldsrc: { engine: 'e-1', gameDir: 'valve', modules: { client: 'c.wasm', server: 's.wasm' }, solo: { map: 'start' } } }] }));
  const server = createServer({ gamesDir: games, lanLog: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/prefetch/gs-orig`;
  const post = (body) => fetch(base, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post({ session: 's1', reads: [['valve/gfx.wad', 0, 5000, 40], ['valve/maps/start.bsp', BLOCK, BLOCK + 10, 2500], ['valve/none', 0, 1, 1], ['valve/gfx.wad', 0, 9999, 1], ['VALVE/gfx.wad', 0, 1, 1]] })).status, 204);
  assert.equal((await post({ session: 's2', reads: [['valve/maps/start.bsp', BLOCK, BLOCK + 10, 900]] })).status, 204);
  assert.equal((await post({ reads: [] })).status, 400);
  assert.deepEqual(await (await fetch(base)).json(), [['valve/gfx.wad', 0, 1, 40], ['valve/maps/start.bsp', 1, 1, 900]]);
  // (a synchronous read's padding byte: a leading byte-order mark is not taken as one by the page's text decoding)
  const game = base.replace('/api/prefetch/', '/gamez/') + '/valve/bom.txt?r=0-6';
  assert.deepEqual([...new Uint8Array(await (await fetch(game + '&pad=1')).arrayBuffer())], [0, 0xff, 0xfe, 0x41, 0, 0x42, 0]);
  assert.deepEqual([...new Uint8Array(await (await fetch(game)).arrayBuffer())], [0xff, 0xfe, 0x41, 0, 0x42, 0]);
});

test('reads learned by phase (a map): each phase\'s blocks together at its usual start, in the order its load reads them; kept on disk', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-phase-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), gs = path.join(games, 'gs'), learn = path.join(root, 'learn');
  fs.mkdirSync(path.join(gs, 'base', 'valve', 'maps'), { recursive: true }); fs.mkdirSync(path.join(gs, 'versions', 'orig'), { recursive: true }); fs.mkdirSync(learn);
  for (const f of ['a.bsp', 'b.bsp', 'c.bsp']) fs.writeFileSync(path.join(gs, 'base', 'valve', 'maps', f), bytes(3 * BLOCK, 3));
  fs.writeFileSync(path.join(gs, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'gs', name: 'GS', defaultVersion: 'gs-orig', defaults: { runtime: 'goldsrc' },
    versions: [{ id: 'gs-orig', dir: 'orig', version: 'O', goldsrc: { engine: 'e-1', gameDir: 'valve', modules: { client: 'c.wasm', server: 's.wasm' }, solo: { map: 'a' } } }] }));
  const start = async () => {
    const server = createServer({ gamesDir: games, learnDir: learn, learnWriteMs: 10, lanLog: () => {} });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, base: `http://127.0.0.1:${server.address().port}/api/prefetch/gs-orig` };
  };
  const stop = (server) => new Promise((resolve) => { if (!server.listening) return resolve(); server.closeAllConnections?.(); server.close(resolve); });
  const { server, base } = await start(); t.after(() => stop(server));
  const post = (body) => fetch(base, { method: 'POST', body: JSON.stringify(body) });
  // (a slow player: map a, then b after 600 s; its load reads b's blocks 0, 1, 2 at 600.1, 600.2, 600.3 s)
  assert.equal((await post({ session: 'slow', phases: [['a', 10], ['b', 600000]], reads: [['valve/maps/a.bsp', 0, 10, 20],
    ['valve/maps/b.bsp', 0, 10, 600100], ['valve/maps/b.bsp', BLOCK, BLOCK + 10, 600200], ['valve/maps/b.bsp', 2 * BLOCK, 2 * BLOCK + 10, 600300]] })).status, 204);
  // (a player who goes to b at once, reading its blocks in another order slower, then c; and one at b after 500 s)
  assert.equal((await post({ session: 'quick', phases: [['b', 5000], ['c', 9000], ['bad', -1], 'x'], reads: [['valve/maps/b.bsp', 2 * BLOCK, 2 * BLOCK + 10, 5050],
    ['valve/maps/b.bsp', BLOCK, BLOCK + 10, 8000], ['valve/maps/c.bsp', 0, 10, 9100], ['valve/maps/c.bsp', BLOCK, BLOCK + 10, 9200]] })).status, 204);
  assert.equal((await post({ session: 'mid', phases: [['b', 500000]], reads: [] })).status, 204);
  // (a phase that usually starts when c does: its blocks after c's, not between them)
  assert.equal((await post({ session: 'tie', phases: [['d', 9000]], reads: [['valve/maps/a.bsp', BLOCK, BLOCK + 10, 9050], ['valve/maps/a.bsp', 2 * BLOCK, 2 * BLOCK + 10, 9300]] })).status, 204);
  const list = await (await fetch(base)).json();
  // (b's usual start: the median of 600, 5 and 500 s — 500 s; its blocks by their time from b's start: 2 (50 ms), 0 (100 ms), 1 (200 ms));
  // c after it once its start is known (9 s, alone: before b), a at its start
  assert.deepEqual(list.map(([p, b, , at]) => [p.slice(11), b, at]), [['a.bsp', 0, 20], ['c.bsp', 0, 9100], ['c.bsp', 1, 9200], ['a.bsp', 1, 9050], ['a.bsp', 2, 9300],
    ['b.bsp', 2, 500050], ['b.bsp', 0, 500100], ['b.bsp', 1, 500200]]);
  // (no phases told: the global time, as before)
  await new Promise((r) => setTimeout(r, 100)); await stop(server);
  const again = await start(); t.after(() => stop(again.server));
  assert.deepEqual(await (await fetch(again.base)).json(), list, 'the phases and their reads kept on disk');
});

// (a learned-phases version for the tests below: maps a.bsp, b.bsp; opts the server's)
const phaseServer = async (t, opts = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-phase-b-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), gs = path.join(games, 'gs'), learn = path.join(root, 'learn');
  fs.mkdirSync(path.join(gs, 'base', 'valve', 'maps'), { recursive: true }); fs.mkdirSync(path.join(gs, 'versions', 'orig'), { recursive: true }); fs.mkdirSync(learn);
  for (const f of ['a.bsp', 'b.bsp']) fs.writeFileSync(path.join(gs, 'base', 'valve', 'maps', f), bytes(2 * BLOCK, 3));
  fs.writeFileSync(path.join(gs, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'gs', name: 'GS', defaultVersion: 'gs-orig', defaults: { runtime: 'goldsrc' },
    versions: [{ id: 'gs-orig', dir: 'orig', version: 'O', goldsrc: { engine: 'e-1', gameDir: 'valve', modules: { client: 'c.wasm', server: 's.wasm' }, solo: { map: 'a' } } }] }));
  const start = async () => {
    const server = createServer({ gamesDir: games, learnDir: learn, learnWriteMs: 10, lanLog: () => {}, ...opts });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const close = () => new Promise((resolve) => { if (!server.listening) return resolve(); server.closeAllConnections?.(); server.close(resolve); });
    t.after(close);
    const origin = `http://127.0.0.1:${server.address().port}`, base = `${origin}/api/prefetch/gs-orig`;
    return { origin, base, close, post: (body) => fetch(base, { method: 'POST', body: JSON.stringify(body) }) };
  };
  return { learn, start };
};

test('clients\' phases are bounded: 64 a report, phasesMax a version, sessions made by phases evicted too, 16 phases an entry', async (t) => {
  const { learn, start } = await phaseServer(t, { phasesMax: 40, sessionsMax: 4 });
  const s = await start();
  // (one report of 100 phases: its first 64 told, 40 of them counted for the version)
  assert.equal((await s.post({ session: 'many', phases: Array.from({ length: 100 }, (_, i) => [`p${i}`, i]), reads: [] })).status, 204);
  // (phase-only reports from fresh sessions: bounded as reading ones are)
  for (let i = 0; i < 10; i++) assert.equal((await s.post({ session: `only${i}`, phases: [[`p${i}`, 10]], reads: [] })).status, 204);
  assert.ok(JSON.parse(await (await fetch(`${s.origin}/api/netstats`)).text()).server.sessions <= 4, 'sessions bounded');
  // (20 sessions each read block 0 first in another phase: the entry keeps 16 of them; a phase not counted for the
  // version — past phasesMax — is none)
  for (let i = 0; i < 20; i++) await s.post({ session: `r${i}`, phases: [[`p${i}`, 100]], reads: [['valve/maps/a.bsp', 0, 10, 150]] });
  await s.post({ session: 'late', phases: [['p70', 100]], reads: [['valve/maps/b.bsp', 0, 10, 150]] });
  await new Promise((r) => setTimeout(r, 100)); await s.close();
  const phases = JSON.parse(fs.readFileSync(path.join(learn, 'phases-gs-orig.json'), 'utf8'));
  assert.equal(Object.keys(phases).length, 40); assert.equal(phases.p70, undefined);
  const entries = new Map(JSON.parse(fs.readFileSync(path.join(learn, 'prefetch-gs-orig.json'), 'utf8')).map((e) => [e[0], e]));
  assert.equal(Object.keys(entries.get('valve/maps/a.bsp#0')[6]).length, 16);
  assert.equal(entries.get('valve/maps/b.bsp#0')[6], undefined, 'read in a phase not counted: none');
});

test('a block some session read before a phase began keeps its time, not the phase\'s (kept on disk)', async (t) => {
  const { start } = await phaseServer(t);
  let s = await start();
  // (A reads a.bsp#0 at 1 s in the menu, no phase yet; B goes to map m at 20 s and reads a.bsp#0 then b.bsp#0 there)
  await s.post({ session: 'A', reads: [['valve/maps/a.bsp', 0, 10, 1000]] });
  await s.post({ session: 'B', phases: [['m', 20000]], reads: [['valve/maps/a.bsp', 0, 10, 20500], ['valve/maps/b.bsp', 0, 10, 20100]] });
  const list = await (await fetch(s.base)).json();
  assert.deepEqual(list.map(([p, b, , at]) => [p.slice(11), b, at]), [['a.bsp', 0, 1000], ['b.bsp', 0, 20100]]);
  await new Promise((r) => setTimeout(r, 100)); await s.close();
  s = await start();
  assert.deepEqual(await (await fetch(s.base)).json(), list);
});

/** `server` whose game file ranges wait until release(): a read waiting for the network as long as the test wants. */
function gatedServer(server) {
  let open = null; const gate = new Promise((r) => { open = r; });
  return { ...server, release: open, fetch: async (url, init) => { if (String(url).includes('/gamez/')) await gate; return server.fetch(url, init); } };
}

test('the engine\'s waits count only the reads it waits for: a synchronous one, an asynchronous one the page says holds it', async (t) => {
  const server = gatedServer(fakeServer({ 'a.img': bytes(1 << 20), 'b.img': bytes(1 << 20, 3), 'c.img': bytes(1 << 20, 5) }));
  const w = await startWorker(t, server);
  await w.until(() => Atomics.load(w.ctrl, 11) > 0, 'its counters');
  // (asked ahead, the engine going on: waiting for the network, not counted)
  w.handle({ read: { id: 1, name: 'v', path: 'a.img', off: 0, len: 65536, held: false } });
  w.handle({ read: { id: 2, name: 'v', path: 'b.img', off: 0, len: 65536 } });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(Atomics.load(w.ctrl, 6), 0, 'reads asked ahead are not waits');
  assert.ok(Atomics.load(w.ctrl, 11) >= 200, 'nor do they make the game data busy');
  // (the page says the engine waits for one now: counted; then that it went on: not any more)
  w.handle({ held: [[1, 1]] });
  await w.until(() => Atomics.load(w.ctrl, 6) === 1, 'the held read counted');
  assert.equal(Atomics.load(w.ctrl, 11), 0);
  w.handle({ held: [[1, 0], [77, 1]] });
  await w.until(() => Atomics.load(w.ctrl, 6) === 0, 'not once the engine went on');
  // (a synchronous read: the page's thread waits — counted at once)
  w.handle({ gen: 5, name: 'v', path: 'c.img', off: 0, len: 65536 });
  await w.until(() => Atomics.load(w.ctrl, 6) === 1, 'a synchronous read counted');
  server.release();
  await w.until(() => Atomics.load(w.ctrl, 0) === 5 && w.out.filter((m) => m.id).length === 2, 'all answered');
  await w.until(() => Atomics.load(w.ctrl, 6) === 0, 'nothing waits');
});

test('the page tells which of the engine\'s asynchronous reads hold it: not the ones it asked ahead and went on past', async () => {
  const told = [], fake = { onmessage: null, postMessage: (m) => told.push(m), terminate() {} };
  const data = new GameData({ name: 'v', worker: fake });
  const task = () => new Promise((r) => setTimeout(r, 0)); // (the page's next task: the engine gave it its turn)
  try {
    clearInterval(data.holdTimer); // (holdWatch called by the test)
    data.trees = { v: { dirs: {}, files: { 'a.img': { size: 1 << 20 }, 'b.wav': { size: 1000 } } } };
    const h = data.file('v', 'a.img'), s = data.file('v', 'b.wav');
    const reads = () => told.filter((m) => m.read).map((m) => m.read), held = () => told.filter((m) => m.held).flatMap((m) => m.held);
    // (asked ahead: the engine goes on before it gives the page its turn — polls, reads, its frame shown)
    data.ensure(h, 0, 65536);
    const ahead = reads().at(-1); assert.equal(ahead.held, false);
    data.missing(h, 0, 65536); data.progress();
    await task(); data.holdWatch();
    assert.deepEqual(held(), [], 'gone on past it: never a wait');
    // (asked, then the page's turn with nothing more: the engine waits for it — told once)
    data.ensure(h, 65536 * 4, 65536);
    const waited = reads().at(-1);
    assert.deepEqual(held(), [], 'not before the page\'s turn');
    await task(); await task(); data.holdWatch();
    assert.deepEqual(held(), [[waited.id, 1]]);
    // (the engine went on while it was under way: not a wait any more)
    data.progress(); data.holdWatch();
    assert.deepEqual(held(), [[waited.id, 1], [waited.id, 0]]);
    // (in the background — readable(): never)
    told.length = 0;
    assert.equal(data.readable(s), false);
    await task(); data.holdWatch();
    assert.equal(reads().length, 1); assert.equal(reads()[0].held, false); assert.deepEqual(held(), []);
    assert.equal(data.pending.size, 2, 'the background read not among those that may hold the engine');
  } finally { data.close(); }
});

test('an engine that streams ahead (re3: ask, go on, poll) never shows a wait; one that suspends on its read does', async (t) => {
  const server = gatedServer(fakeServer({ 'models.img': bytes(1 << 20), 'audio.sfx': bytes(1 << 20, 4) }));
  const data = await inThread(t, server), img = data.file('v', 'models.img'), sfx = data.file('v', 'audio.sfx');
  const seen = [];
  // (the engine's frames for a second: it asks for a model and a sound ahead in its first, polls the model in each, shows
  // it, then gives the page its turn until the next)
  for (let i = 0; i < 40; i++) {
    if (i === 0) { data.ensure(img, 0, 65536).catch(() => {}); data.ensure(sfx, 0, 65536).catch(() => {}); }
    data.missing(img, 0, 65536); data.progress();
    await new Promise((r) => setTimeout(r, 25)); seen.push(Atomics.load(data.ctrl, 6));
  }
  assert.deepEqual(seen.filter((n) => n > 0), [], 'no wait over smooth play');
  assert.equal(data.quiet(500), true, 'the game data quiet meanwhile');
  // (it needs a model now: it suspends until it is here — calls nothing)
  const before = data.snapshot().misses, wait = data.ensure(img, 65536 * 8, 65536);
  await until(() => Atomics.load(data.ctrl, 6) > 0, 'its wait counted', 3000);
  server.release(); await wait;
  await until(() => Atomics.load(data.ctrl, 6) === 0, 'over');
  assert.equal(data.snapshot().misses - before, 1, 'among the engine\'s waits: that one only');
  assert.ok(data.snapshot().stallMs > 0);
});

test('a load made of many short waits (each read the engine suspends on, 60 ms) is a wait all along', async (t) => {
  const base = fakeServer({ 'level.dat': bytes(4 << 20) });
  const server = { ...base, fetch: async (url, init) => { if (String(url).includes('/gamez/')) await new Promise((r) => setTimeout(r, 60)); return base.fetch(url, init); } };
  const data = await inThread(t, server), h = data.file('v', 'level.dat');
  let loading = true;
  const seen = [];
  const watch = (async () => { while (loading) { await new Promise((r) => setTimeout(r, 100)); if (loading) seen.push(Atomics.load(data.ctrl, 6)); } })();
  // (the engine reads the file in order, far apart — every read misses —, suspending on each: the worker's own read-ahead
  // kept small by the reads' spread)
  const out = new Uint8Array(4096);
  for (let i = 0; i < 25; i++) { const at = i * 160 * 1024; if (data.missing(h, at, 4096)) await data.ensure(h, at, 4096); data.read(h, out, 0, 4096, at); }
  loading = false; await watch;
  assert.ok(seen.length >= 3, `sampled during the load (${seen.length})`); // (how long the load lasts depends on the machine: a few samples are enough)
  assert.ok(seen.filter((n) => n > 0).length >= seen.length * 0.6, `counted as a wait most of the load: ${seen.join('')}`);
  // (the link silent meanwhile: the blocks the load touched — the block fill — wait for its end; the worker's counters
  // tell the page each producer's bytes, those begun during a load apart)
  // (the load's end: a pause of loadGap() — LOAD_HOLD_MS once the run has lasted LOAD_LONG_MS, as on a busy machine)
  await until(() => data.snapshot().net?.bgBy?.want && data.snapshot().net.loading === false, 'the block fill after the load', 8000);
  const net = data.snapshot().net;
  if (net.bw < FAST_BPS) for (const [why, r] of Object.entries(net.bgBy)) assert.equal(r.inLoad, 0, `${why} begun during the load: ${JSON.stringify(net.bgBy)}`);
  assert.ok(net.waits >= 25 && net.loading === false, JSON.stringify(net));
});

test('on a link that is not fast a picture read light (a loading screen: a TGA\'s light copy) is never upgraded; a texture is', async (t) => {
  const pic = bytes(400000, 2), plight = bytes(30000, 8), tex = bytes(300000, 3), tlight = bytes(40000, 9);
  const server = fakeServer({ 'Splash/load.tga': pic, 'tex.dds': tex }, [], { 'Splash/load.tga': plight, 'tex.dds': tlight });
  const data = await inThread(t, server, { reloads: true }), out = new Uint8Array(400000);
  for (const p of ['Splash/load.tga', 'tex.dds']) { const h = data.file('v', p); await data.ensure(h, 0, h.size); data.read(h, out, 0, h.size, 0); }
  await until(() => data.realHere.has('v\ntex.dds'), 'the texture\'s file here', 6000);
  assert.ok(!server.asked.some(([p]) => p === 'Splash/load.tga'), `the picture's file never asked: ${JSON.stringify(server.asked)}`);
  assert.ok(!data.realHere.has('v\nsplash/load.tga'));
});
