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
import { GameData, PIECE } from '../src/vfs/data-client.js';
import { fileNode, mountFiles } from '../src/vfs/emscripten-files.js';
import { BLOCK } from '../src/vfs/http-backend.js';

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

/** A server of one version for the data worker: /api/manifest, /api/tree, /api/prefetch, /gamez ranges; requests logged. */
function fakeServer(files, learned = []) {
  const tree = { dirs: {}, files: {} }, posts = [], asked = [];
  for (const [p, b] of Object.entries(files)) {
    const parts = p.split('/'); let node = tree;
    for (const d of parts.slice(0, -1)) node = node.dirs[d] ??= { dirs: {}, files: {} };
    node.files[parts.at(-1)] = { size: b.length, mtime: 5 };
  }
  const fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/manifest/v') return Response.json({ name: 'v' });
    if (u.pathname === '/api/tree/v') return Response.json(tree);
    if (u.pathname === '/api/prefetch/v') { if (init.method === 'POST') { posts.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); } return Response.json(learned); }
    const m = /^\/gamez\/v\/(.+)$/.exec(u.pathname);
    if (m && files[decodeURIComponent(m[1])]) {
      const [a, b] = u.searchParams.get('r').split('-').map(Number); asked.push([decodeURIComponent(m[1]), a, b, u.searchParams.get('p') ? 'bg' : 'demand']);
      const body = files[decodeURIComponent(m[1])].slice(a, b);
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
  const ctrl = new Int32Array(new SharedArrayBuffer(32)), data = new Uint8Array(new SharedArrayBuffer(16 << 20));
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
