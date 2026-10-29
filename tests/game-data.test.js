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
import { treeFile, treeFiles, treeBytes, languageFiles, treeOwner, splitOwners } from '../src/vfs/game-tree.js';
import { createDataWorker } from '../src/vfs/data-worker.js';
import { openVersion, learnedOrders, partOf, UnderStore } from '../src/vfs/game-data.js';
import { MemBlockStore } from '../src/vfs/opfs-store.js';
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

test('a tree split by owner: its own files, each owner\'s at the same paths; a light copy\'s owner its file\'s', () => {
  const tree = { dirs: { Audio: { dirs: {}, files: { 'sfx.RAW': { size: 9, owner: 'vc' }, 'own.wav': { size: 2 } } }, Empty: { dirs: {}, files: {} } }, files: { 'gta3.img': { size: 5, owner: 'vc', light: 3 }, 'mine.dat': { size: 1, owner: 'me' } } };
  assert.equal(treeOwner(tree, 'AUDIO\\sfx.raw'), 'vc'); assert.equal(treeOwner(tree, '.light/gta3.img'), 'vc');
  assert.equal(treeOwner(tree, 'Audio/own.wav'), null); assert.equal(treeOwner(tree, 'mine.dat', 'me'), null, 'a mark of its own name');
  const { own, owners } = splitOwners(tree, 'me');
  assert.deepEqual([...owners.keys()], ['vc']);
  assert.deepEqual(treeFiles(owners.get('vc')).map((f) => f.path).sort(), ['Audio/sfx.RAW', 'gta3.img']);
  assert.deepEqual(treeFiles(own).map((f) => f.path).sort(), ['Audio/own.wav', 'mine.dat']);
  assert.equal(treeBytes(own) + treeBytes(owners.get('vc')), treeBytes(tree));
  const plain = { dirs: {}, files: { a: { size: 1 } } };
  assert.equal(splitOwners(plain).own, plain, 'nothing marked: the tree itself');
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

test('an OpenMW engine that reads its content light (its release exports CONTENT_EXPORT): its tree marks the TES3 masters, served zeroed under .light/', async (t) => {
  const { CONTENT_EXPORT } = await import('../src/vfs/launch-set.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-omwesm-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), engines = path.join(root, 'engines'), game = path.join(games, 'mw');
  fs.mkdirSync(path.join(game, 'base'), { recursive: true }); fs.mkdirSync(path.join(game, 'versions/1'), { recursive: true });
  // (a TES3 header, a LAND record whose heights the copy zeroes, a dialogue's padding past 1 MiB)
  const rec = (name, subs) => { const body = Buffer.concat(subs), h = Buffer.alloc(16); h.write(name, 0, 'latin1'); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); };
  const sub = (name, b) => { const h = Buffer.alloc(8); h.write(name, 0, 'latin1'); h.writeUInt32LE(b.length, 4); return Buffer.concat([h, b]); };
  const esm = Buffer.concat([rec('TES3', [sub('HEDR', Buffer.alloc(300, 1))]), rec('LAND', [sub('INTV', Buffer.alloc(8, 1)), sub('VHGT', Buffer.alloc(4232, 0x42))]), rec('INFO', [sub('INAM', Buffer.alloc(1 << 20, 3))])]);
  fs.writeFileSync(path.join(game, 'base/Game.esm'), esm);
  fs.writeFileSync(path.join(game, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'mw', name: 'MW', defaultVersion: 'mw-1', defaults: { runtime: 'openmw' },
    versions: [{ id: 'mw-1', dir: '1', version: '1', openmw: { engine: 'e1', files: ['Game.esm'] } }] }));
  fs.mkdirSync(path.join(engines, 'e1/moddata'), { recursive: true });
  const release = (exports) => fs.writeFileSync(path.join(engines, 'e1/release.json'), JSON.stringify({ schemaVersion: 1, id: 'e1', runtime: 'openmw', exports: exports.map((name) => ({ name })), files: [] }));
  release(['orthros_file_updated']);
  const server = createServer({ gamesDir: games, enginesDir: engines });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tree = async () => (await (await fetch(base + '/api/tree/mw-1')).json()).files['Game.esm'];
  assert.equal((await tree()).light, undefined, 'an engine that reads it as it is: no light copy listed');
  release(['orthros_file_updated', CONTENT_EXPORT]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await tree()).light, esm.length, 'its light copy: the same size');
  const at = 16 + 316 + 16 + 16;
  const part = new Uint8Array(await (await fetch(base + `/gamez/mw-1/.light/Game.esm?r=${at - 8}-${at + 100}`)).arrayBuffer());
  assert.deepEqual([...part.subarray(0, 4)], [...Buffer.from('VHGT')], 'the subrecord\'s header kept');
  assert.ok(part.subarray(8).every((b) => b === 0), 'its heights zeroed');
});

test('an engine reading its content light: a content file read as itself before playable learned apart (CONTENT_REAL), kept; no light copy of it for another engine', async (t) => {
  const { CONTENT_EXPORT, CONTENT_REAL, PRE_PLAYABLE } = await import('../src/vfs/launch-set.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-omwreal-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), engines = path.join(root, 'engines'), learn = path.join(root, 'learn'), game = path.join(games, 'mw');
  fs.mkdirSync(path.join(game, 'base'), { recursive: true }); fs.mkdirSync(path.join(game, 'versions/1'), { recursive: true }); fs.mkdirSync(learn);
  const rec = (name, subs) => { const body = Buffer.concat(subs), h = Buffer.alloc(16); h.write(name, 0, 'latin1'); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); };
  const sub = (name, b) => { const h = Buffer.alloc(8); h.write(name, 0, 'latin1'); h.writeUInt32LE(b.length, 4); return Buffer.concat([h, b]); };
  fs.writeFileSync(path.join(game, 'base/Game.esm'), Buffer.concat([rec('TES3', [sub('HEDR', Buffer.alloc(300, 1))]), rec('INFO', [sub('INAM', Buffer.alloc(3 << 20, 3))])]));
  fs.writeFileSync(path.join(game, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'mw', name: 'MW', defaultVersion: 'mw-1', defaults: { runtime: 'openmw' },
    versions: [{ id: 'mw-1', dir: '1', version: '1', openmw: { engine: 'e1', files: ['Game.esm'] } }] }));
  fs.mkdirSync(path.join(engines, 'e1/moddata'), { recursive: true });
  const release = (exports) => fs.writeFileSync(path.join(engines, 'e1/release.json'), JSON.stringify({ schemaVersion: 1, id: 'e1', runtime: 'openmw', exports: exports.map((name) => ({ name })), files: [] }));
  release([]);
  const start = async () => {
    const server = createServer({ gamesDir: games, enginesDir: engines, learnDir: learn, learnWriteMs: 10, lanLog: () => {} });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
  };
  let s = await start();
  t.after(() => s.close());
  const post = (body) => fetch(`${s.base}/api/prefetch/mw-1`, { method: 'POST', body: JSON.stringify(body) });
  const order = async () => (await fetch(`${s.base}/api/prefetch/mw-1`)).json();
  // (an engine that reads it as it is: no copy served; its sessions' reads of the file, PRE_PLAYABLE only)
  assert.equal((await fetch(`${s.base}/gamez/mw-1/.light/Game.esm?r=0-100`)).status, 404, 'no light copy for an engine that reads the file');
  await post({ session: 'old', reads: [['Game.esm', 0, 3 * BLOCK, 5]], mark: { kind: 'playable' } });
  release([CONTENT_EXPORT]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await fetch(`${s.base}/gamez/mw-1/.light/Game.esm?r=0-100`)).status, 200);
  // (two sessions reading the copy at the content load, then the file's block 2 — their first cell — before playable)
  for (const sid of ['n1', 'n2']) await post({ session: sid, reads: [['.light/Game.esm', 0, 3 * BLOCK, 5], ['Game.esm', 2 * BLOCK, 2 * BLOCK + 10, 900]], mark: { kind: 'playable' } });
  const flags = (list) => Object.fromEntries(list.map((e) => [`${e[0]}#${e[1]}`, e[4]]));
  const list = await order(), f = flags(list);
  assert.equal(f['Game.esm#0'] & CONTENT_REAL, 0, 'an older engine\'s content load: the copy\'s');
  assert.equal(f['Game.esm#2'], PRE_PLAYABLE | CONTENT_REAL, 'the first cell, read as the file by the sessions reading the copy');
  assert.equal(f['.light/Game.esm#2'], PRE_PLAYABLE);
  await new Promise((r) => setTimeout(r, 100)); // (written)
  await s.close();
  s = await start();
  assert.deepEqual(await order(), list, 'kept: the counts of the sessions reading the copy');
});

/**
 * A server of one version for the data worker: /api/manifest, /api/tree, /api/prefetch, /gamez ranges (`lights`: files'
 * light copies, under .light/); requests logged. `required`: { files, learned } of a version 'r' it requires
 * (extraMounts), its requests logged as 'r:<path>'; with `o.owned`, a version whose files 'v' takes instead (a port's
 * underlay): in v's tree marked `owner: 'r'`, served under /gamez/r/ only.
 */
function fakeServer(files, learned = [], lights = {}, required = null, o = {}) {
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
  const vs = { v: { ...version(files, lights), learned, man: { name: 'v', ...(required && !o.owned ? { extraMounts: [{ manifest: 'r', at: 'C:\\R' }] } : {}) } } };
  if (required) vs.r = { ...version(required.files, required.lights), learned: required.learned ?? [], man: { name: 'r' } };
  if (required && o.owned) {
    // (r's files in v's tree, marked: v's own win at the same path)
    (function graft(from, to) {
      for (const [n, e] of Object.entries(from.files)) to.files[n] ??= { ...e, owner: 'r' };
      for (const [n, d] of Object.entries(from.dirs)) graft(d, to.dirs[n] ??= { dirs: {}, files: {} });
    })(vs.r.tree, vs.v.tree);
  }
  const fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://x');
    const api = /^\/api\/(manifest|tree|prefetch)\/(\w+)$/.exec(u.pathname), av = api && vs[api[2]];
    if (av && api[1] === 'manifest') return Response.json(av.man);
    if (av && api[1] === 'tree') return Response.json(av.tree);
    if (av && api[1] === 'prefetch') { if (init.method === 'POST') { posts.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); } return Response.json(av.learned); }
    const m = /^\/gamez\/(\w+)\/(.+)$/.exec(u.pathname), gv = m && vs[m[1]];
    if (gv && gv.files[decodeURIComponent(m[2])]) {
      const [a, b] = u.searchParams.get('r').split('-').map(Number); asked.push([(m[1] === 'v' ? '' : m[1] + ':') + decodeURIComponent(m[2]), a, b, u.searchParams.get('w') ? 'want' : u.searchParams.get('p') ? 'bg' : 'demand']);
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

test('the learned order loaded now (prefetchNow: the engine\'s link idle before its first read) only on a store that lacks the launch set', async (t) => {
  const learned = [['Game.esm', 0, 0, 0], ['Game.esm', 1, 0, 500], ['b.dat', 0, 0, 9000]];
  const files = () => ({ 'Game.esm': bytes(3 << 20), 'b.dat': bytes(70000, 4) });
  const settle = () => new Promise((r) => setTimeout(r, 60));
  // (a new device: nothing here — the whole order, before any read; 'first-read' would wait for one)
  const cold = fakeServer(files(), learned), w = await startWorker(t, cold, { prefetch: 'first-read' });
  w.handle({ start: true }); await settle();
  assert.equal(cold.asked.length, 0, 'first-read: nothing before a read');
  w.handle({ prefetch: true });
  await w.until(() => cold.asked.some(([p]) => p === 'b.dat'), 'the order past its launch set');
  assert.ok(cold.asked.some(([p, a]) => p === 'Game.esm' && a === 0), 'its launch set first');
});

test('prefetchNow on a store that holds the launch set: nothing before the engine\'s first read, as before (no requests beside its boot)', async (t) => {
  const learned = [['Game.esm', 0, 0, 0], ['Game.esm', 1, 0, 500], ['b.dat', 0, 0, 9000]];
  const files = () => ({ 'Game.esm': bytes(3 << 20), 'b.dat': bytes(70000, 4) });
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const warm = fakeServer(files(), learned), v = await startWorker(t, warm, { prefetch: 'first-read' });
  v.handle({ startup: true }); await v.until(() => v.out.some((m) => m.startup?.done), 'startup');
  const had = warm.asked.length;
  v.handle({ start: true }); v.handle({ prefetch: true }); await settle();
  assert.equal(warm.asked.length, had, 'the launch set here: no pass before the first read');
  await v.read('Game.esm', 0, 100);
  await v.until(() => warm.asked.some(([p]) => p === 'b.dat'), 'the first read starts it');
});

/** prefetchNow on a store handed `given` ([path, at, bytes] of the files) before: the requests before any read. */
async function prefetchNowOn(t, given) {
  // (the launch set: Game.esm's two first blocks and b.dat — all three before the order's first pause)
  const learned = [['Game.esm', 0, 0, 0], ['Game.esm', 1, 0, 500], ['b.dat', 0, 0, 900]];
  const files = { 'Game.esm': bytes(3 << 20), 'b.dat': bytes(70000, 4) };
  const server = fakeServer(files, learned), w = await startWorker(t, server, { prefetch: 'first-read' });
  w.handle({ migrate: given.map(([path, at, n]) => ({ name: 'v', path, at, bytes: files[path].slice(at, at + n) })) });
  w.handle({ start: true }); w.handle({ prefetch: true });
  return { server, w };
}

test('prefetchNow on a store missing part of the launch set (another place\'s pieces, entries learned since): a warm store all the same, nothing before the first read', async (t) => {
  const { server } = await prefetchNowOn(t, [['Game.esm', 0, 2 << 20]]);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(server.asked.length, 0, '2 MB of 2.07 here: no pass beside the boot');
});

test('prefetchNow on a store holding little of the launch set: a cold one, the pass before any read', async (t) => {
  const { server, w } = await prefetchNowOn(t, [['b.dat', 0, 70000]]);
  await w.until(() => server.asked.some(([p, a]) => p === 'Game.esm' && a === 0), '70 KB of 2.07 MB here: the pass');
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

test('a file a version takes from one it requires is read, kept and loaded ahead under its owner; the version learns it as its own read', async (t) => {
  const shared = bytes(2 << 20, 5);
  const server = fakeServer({ 'Game.esm': bytes(3 << 20), 'Data/Over.dat': bytes(5000, 2) }, [['Game.esm', 0, 0, 0], ['Data/Shared.dat', 1, 0, 0]], {},
    { files: { 'Data/Shared.dat': shared, 'Data/Over.dat': bytes(9000, 3) }, learned: [['Data/Shared.dat', 0, 0, 0]] }, { owned: true });
  const w = await startWorker(t, server);
  const ready = w.out.find((m) => m.ready).ready;
  assert.deepEqual(Object.keys(ready.trees), ['v'], 'the page knows the version it opened only');
  assert.deepEqual(Object.keys(ready.kept), ['v', 'r'], 'the owner\'s store opened beside the version\'s');
  assert.equal(ready.trees.v.dirs.Data.files['Shared.dat'].owner, 'r');
  // (the startup set: the version's learned entries, the owner's file among them fetched under the owner — not the
  // owner's own order, its players' reads)
  w.handle({ startup: true });
  await w.until(() => w.out.some((m) => m.startup?.done), 'startup');
  assert.equal(w.out.findLast((m) => m.startup).startup.total, 2 << 20);
  assert.ok(server.asked.some(([p, a]) => p === 'r:Data/Shared.dat' && a === 1 << 20), 'under its owner');
  assert.ok(!server.asked.some(([p, a]) => p === 'r:Data/Shared.dat' && a === 0), 'not from the owner\'s order');
  // (the page's reads by the version's name: through the owner's part; a file of the version over the owner's: its own)
  assert.deepEqual(await w.read('data/shared.dat', 100, 50), shared.subarray(100, 150));
  assert.deepEqual(await w.read('Data/Over.dat', 0, 10), bytes(5000, 2).subarray(0, 10));
  assert.ok(server.asked.some(([p]) => p === 'Data/Over.dat') && !server.asked.some(([p]) => p === 'Data/Shared.dat' || p === 'r:Data/Over.dat'), JSON.stringify(server.asked));
  // (announced reads too)
  w.handle({ want: { seq: 1, from: 1, list: [['v', 'Data/Shared.dat', 1 << 20, 4096]] } });
  await w.until(() => Atomics.load(w.ctrl, 12) >= 1, 'announced');
  assert.equal(Atomics.load(w.ctrl, 14), 0, 'none failed');
  // (the engine's uses: the version's own learned reads)
  w.handle({ start: true }); w.handle({ used: [['v', 'Data/Shared.dat', 1]] }); w.handle({ close: true });
  await w.until(() => server.posts.length, 'reported');
  assert.deepEqual(server.posts[0].reads.map((r) => r[0]), ['Data/Shared.dat']);
});

// Opened early (docs/slow-network.md "Opened early"): a version's manifest, tree and store had at once, then every
// required version's tree and store at once — one wait each, not one after another —; the page's manifest and tree not
// asked again; a failure closes the stores that opened.
test('openVersion: the manifest, the tree and the store at once, the required versions\' at once; the page\'s manifest not asked again', async (t) => {
  const server = fakeServer({ 'Game.esm': bytes(1000) }, [], {}, { files: { 'R.dat': bytes(2000, 3) } });
  // (the API's answers held until the test opens them: what was asked meanwhile is what went at once)
  const asked = [], waits = [];
  let open = false;
  const gate = () => new Promise((r) => { if (open) r(); else waits.push(r); });
  const release = () => { open = true; for (const r of waits.splice(0)) r(); };
  const realFetch = globalThis.fetch; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init) => { asked.push(new URL(url, 'http://x').pathname); if (String(url).includes('/api/')) await gate(); return server.fetch(url, init); };
  const storesAsked = [], closed = [];
  const store = (n) => { storesAsked.push(n); const st = new MemBlockStore(); st.close = () => closed.push(n); return st; };
  const opening = openVersion('v', { store });
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(asked.sort(), ['/api/manifest/v', '/api/tree/v'], 'the manifest and the tree asked together');
  assert.deepEqual(storesAsked, ['v'], 'the store opened meanwhile');
  release();
  const version = await opening;
  assert.deepEqual(version.parts.map((p) => p.name), ['v', 'r']);
  assert.deepEqual(storesAsked, ['v', 'r']);
  // (the page's manifest and tree: nothing asked but the required version's tree)
  asked.length = 0; open = true;
  const man = await (await server.fetch('/api/manifest/v')).json(), tree = await (await server.fetch('/api/tree/v')).json();
  const again = await openVersion('v', { store, manifest: man, tree });
  assert.deepEqual(asked, ['/api/tree/r']);
  assert.deepEqual(again.parts.map((p) => [p.name, p.total]), [['v', 1000], ['r', 2000]]);
  // (a tree that cannot be had: the stores that opened closed, the failure thrown)
  globalThis.fetch = async (url, init) => (String(url).includes('/api/tree/r') ? new Response('no', { status: 500 }) : server.fetch(url, init));
  closed.length = 0;
  await assert.rejects(openVersion('v', { store }), /HTTP 500/);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(closed.sort(), ['r', 'v'], 'every store opened closed');
  globalThis.fetch = async (url, init) => (String(url).includes('/api/manifest/') ? new Response('no', { status: 404 }) : server.fetch(url, init));
  closed.length = 0;
  await assert.rejects(openVersion('v', { store }), /HTTP 404/);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(closed, ['v'], 'the version\'s store closed when its manifest cannot be had');
});

// A tree or a store that fails while the open still awaits something else (the manifest, the tree): the open rejects,
// nothing left unhandled — Node's process killed, the worker's "Uncaught (in promise)" before its clean failure.
test('openVersion: a tree or a store failing while the manifest or the tree is in flight rejects the open, no unhandled rejection', async (t) => {
  const server = fakeServer({ 'Game.esm': bytes(1000) });
  const unhandled = [], onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; process.off('unhandledRejection', onUnhandled); });
  const later = (ms) => new Promise((r) => setTimeout(r, ms));
  // (the tree failed at once, the manifest 50 ms later)
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/tree/')) return new Response('no', { status: 500 });
    if (String(url).includes('/api/manifest/')) await later(50);
    return server.fetch(url, init);
  };
  await assert.rejects(openVersion('v', { store: null }), /HTTP 500/);
  // (the store failed at once, the tree and the manifest 50 ms later — the download worker's store with the game open
  // in another tab)
  globalThis.fetch = async (url, init) => { if (String(url).includes('/api/')) await later(50); return server.fetch(url, init); };
  await assert.rejects(openVersion('v', { store: async () => { throw new Error('this browser cannot keep the game files'); } }), /cannot keep/);
  await later(10);
  assert.equal(unhandled.length, 0, `unhandled: ${unhandled.map(String)}`);
});

test('the data worker opened with the page\'s manifest and orderAtOpen: no manifest asked, the learned order\'s list asked at the open, no bytes', async (t) => {
  const server = fakeServer({ 'Game.esm': bytes(1 << 20) }, [['Game.esm', 0, 0, 5]]);
  const asked = [], inner = server.fetch;
  server.fetch = (url, init) => { asked.push(new URL(url, 'http://x').pathname); return inner(url, init); };
  const w = await startWorker(t, server, { prefetch: 'startup', manifest: { name: 'v' }, orderAtOpen: true });
  await w.until(() => asked.includes('/api/prefetch/v'), 'the learned order asked');
  assert.ok(!asked.includes('/api/manifest/v'), 'the page\'s manifest used');
  // (this version's: an earlier test's closed worker may still have reads of its own in flight through the global fetch)
  assert.ok(!asked.some((p) => p.startsWith('/gamez/v/')), 'no bytes before the page asks ' + JSON.stringify(asked));
  // (the startup set then: the order not asked again)
  w.handle({ startup: true });
  await w.until(() => w.out.some((m) => m.startup?.done), 'startup');
  assert.equal(asked.filter((p) => p === '/api/prefetch/v').length, 1);
  assert.ok(server.asked.some(([p]) => p === 'Game.esm'));
});

test('the blocks an edition kept of its owner\'s files before are read there and moved to the owner\'s store as read; routes and learned orders by owner', async (t) => {
  const server = fakeServer({ 'Game.esm': bytes(3 << 20) }, [['Data/Shared.dat', 1, 0, 0], ['Game.esm', 0, 0, 5]], {},
    { files: { 'Data/Shared.dat': bytes(2 << 20, 5) }, learned: [['Data/Shared.dat', 0, 0, 0]] }, { owned: true });
  const realFetch = globalThis.fetch; globalThis.fetch = server.fetch; t.after(() => { globalThis.fetch = realFetch; });
  const stores = { v: new MemBlockStore(), r: new MemBlockStore() };
  const mtime = 5, k0 = `Data/Shared.dat#${2 << 20}#${mtime}#0`, own = `Game.esm#${3 << 20}#${mtime}#0`;
  stores.v.put(k0, bytes(1 << 20, 1)); stores.v.put(own, bytes(1 << 20, 2)); stores.v.put(`Data/Shared.dat#${2 << 20}#${mtime}#c17`, bytes(65536, 3));
  const version = await openVersion('v', { store: (n) => stores[n] });
  assert.deepEqual(version.parts.map((p) => [p.name, !!p.shared, p.total]), [['v', false, 3 << 20], ['r', true, 2 << 20]]);
  assert.equal(partOf(version, 'v', 'data/SHARED.dat').name, 'r'); assert.equal(partOf(version, 'v', 'Game.esm').name, 'v');
  assert.deepEqual((await learnedOrders(version)).map((l) => l.map((e) => e[0])), [['Game.esm'], ['Data/Shared.dat']], 'the version\'s own order, split; not the owner\'s');
  const st = version.parts[1].store;
  assert.ok(st instanceof UnderStore && st.top === stores.r && st.below[0] === stores.v, 'the owner\'s store over the edition\'s');
  assert.ok(st.map.has(k0) && !stores.r.map.has(k0), 'here: nothing moved at the open');
  // (read from the edition's store: no request; moved under the owner as read)
  assert.deepEqual(new Uint8Array(await new Promise((res) => { const f = partOf(version, 'v', 'Data/Shared.dat').files.open('Data/Shared.dat'); res(f.read(10, 20)); })), bytes(1 << 20, 1).subarray(10, 30));
  assert.equal(server.asked.length, 0);
  assert.deepEqual(stores.r.get(k0), bytes(1 << 20, 1)); assert.ok(!stores.v.map.has(k0) && stores.v.map.has(own));
  // (the owner's store failed — the device full —, or held by another tab: the edition's keeps them, read and written)
  stores.r.failed = true;
  const k1 = `Data/Shared.dat#${2 << 20}#${mtime}#1`;
  st.put(k1, bytes(1 << 20, 4)); assert.ok(stores.v.map.has(k1) && !st.failed);
  assert.deepEqual(st.get(`Data/Shared.dat#${2 << 20}#${mtime}#c17`), bytes(65536, 3), 'read below, not moved into a failed store');
  const none = new UnderStore(null, [stores.v]); assert.ok(none.map.has(k1)); none.close();
  // (the edition's store in memory: no store below — the owner's alone)
  const mem = await openVersion('v', { store: (n) => stores[n], kept: (n) => n !== 'v' });
  assert.equal(mem.parts[1].store, stores.r);
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

test('a content file (TES3) read light while the engine loads its content, on a fast link too; the file itself once loaded, every read; never upgraded', async (t) => {
  const esm = bytes(4 << 20, 2), light = bytes(4 << 20, 9), server = fakeServer({ 'Game.esm': esm }, [], { 'Game.esm': light }), at = 3600000;
  const data = await inThread(t, server, { bw: 50 << 20 }), h = data.file('v', 'Game.esm'), out = new Uint8Array(1000);
  assert.equal(data.contentFile(h), true);
  // (an engine that says nothing: the file)
  await data.ensure(h, 0, 1000); data.read(h, out, 0, 1000, 0);
  assert.deepEqual(out, esm.subarray(0, 1000));
  // (its content load: the copy, wherever the reads start — no load chosen at the file's start — the link fast)
  data.contentLoading(); assert.equal(data.snapshot().content, 'light');
  await data.ensure(h, at, 1000); data.read(h, out, 0, 1000, at);
  assert.deepEqual(out, light.subarray(at, at + 1000));
  assert.equal(data.lightRead(h), true);
  // (a check of a range — a cell's land, the terrain's readiness — answers for the file itself, not the copy in the page)
  assert.equal(data.readable(h, at, 1000), false, 'the copy\'s bytes do not make the file\'s range ready');
  await until(() => data.readable(h, at, 1000), 'the file\'s range fetched in the background');
  // (loaded: the file for every read — the same reader's next bytes, sought or not)
  data.contentLoaded(); assert.equal(data.snapshot().content, 'done'); assert.ok(data.snapshot().contentLoadedMs >= data.snapshot().contentLoadingMs);
  data.read(h, out, 0, 1000, at);
  assert.deepEqual(out, esm.subarray(at, at + 1000));
  assert.equal(data.lightRead(h), false);
  data.contentLoading(); assert.equal(data.snapshot().content, 'done', 'for good');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!data.realHere.has('v\ngame.esm') && !data.lightReads.size, 'not told as read light: no upgrade of the whole file');
});

test('a content file\'s copy read from the file\'s own pieces where they are here (a store an older engine filled); reads of ids only light once loaded', async (t) => {
  const esm = bytes(4 << 20, 2), light = bytes(4 << 20, 9), server = fakeServer({ 'Game.esm': esm }, [], { 'Game.esm': light });
  const data = await inThread(t, server, { bw: 50 << 20 }), h = data.file('v', 'Game.esm'), out = new Uint8Array(1000);
  // (the file's first bytes here: read as itself, as an engine that read it at its content load stored them)
  await data.ensure(h, 0, 200000);
  data.contentLoading();
  await data.ensure(h, 70000, 1000); data.read(h, out, 0, 1000, 70000);
  assert.deepEqual(out, esm.subarray(70000, 71000), 'the file\'s bytes: every offset the copy\'s, its payloads filled');
  assert.ok(!server.asked.some(([p, a, b]) => p === '.light/Game.esm' && a < 71000 && b > 70000), 'not fetched again light');
  await data.ensure(h, 3000000, 1000); data.read(h, out, 0, 1000, 3000000);
  assert.deepEqual(out, light.subarray(3000000, 3001000), 'elsewhere: the copy');
  // (loaded: the file — but a listing of references by their ids, what the content load read: the copy, in the page)
  data.contentLoaded();
  data.contentIds(true);
  data.read(h, out, 0, 1000, 3000000); assert.deepEqual(out, light.subarray(3000000, 3001000), 'ids only: the copy');
  data.contentIds(false);
  await data.ensure(h, 3000000, 1000); data.read(h, out, 0, 1000, 3000000);
  assert.deepEqual(out, esm.subarray(3000000, 3001000), 'after: the file');
});

test('reads of ids only: the copy once the content is loaded, the file for an engine that never read it light; the content load\'s reads of a file here whole learned under its copy', () => {
  const told = [], fake = { onmessage: null, postMessage: (m) => told.push(m), terminate() {} };
  const data = new GameData({ name: 'v', worker: fake });
  try {
    data.trees = {};
    const h = data.fileAs('v', 'Data Files/Morrowind.esm', 80 << 20); h.light = h.size;
    assert.equal(data.contentFile(h), true);
    data.contentIds(true); assert.equal(data.nextPick(h), h, 'an engine that said nothing: the file'); data.contentIds(false);
    data.contentLoading(); data.contentLoaded();
    data.contentIds(true); data.contentIds(true); data.contentIds(false);
    assert.equal(data.nextPick(h).path, '.light/Data Files/Morrowind.esm', 'nested: still ids only');
    data.contentIds(false); data.contentIds(false);
    assert.equal(data.nextPick(h), h, 'said again: the file (never below zero)');
    // (a file here whole: read as itself at the content load, learned as its copy's read — server.js CONTENT_REAL)
    const g = data.fileAs('v', 'Data Files/Tribunal.esm', 4 << 20); g.light = g.size;
    data.realHere.add('v\ndata files/tribunal.esm'); data.content = 'light';
    data.keep(g, 0, new Uint8Array(1 << 16)); data.read(g, new Uint8Array(10), 0, 10, 0);
    data.content = 'done'; data.keep(g, 1, new Uint8Array(1 << 16)); data.read(g, new Uint8Array(10), 0, 10, 1 << 16);
    assert.deepEqual(data.used, [['v', '.light/Data Files/Tribunal.esm', 0], ['v', 'Data Files/Tribunal.esm', 1]]);
  } finally { data.close(); }
});

test('a content file announced: its copy\'s range while the content loads, the file\'s after (the same layout); never a big load', () => {
  const told = [], fake = { onmessage: null, postMessage: (m) => told.push(m), terminate() {} };
  const data = new GameData({ name: 'v', worker: fake });
  try {
    data.trees = {}; data.reloads(true);
    const c = data.ctrl; c[7] = 1; c[8] = 1 << 10; c[9] = 0; // (a fast link measured at 1 MiB/s: 2 MiB in LOAD_BUDGET_S)
    const h = data.fileAs('v', 'Data Files/Morrowind.esm', 80 << 20); h.light = h.size;
    assert.equal(data.contentFile(h), true);
    const posted = () => { data.wantFlush(); return told.filter((m) => m.want).at(-1).want.list; };
    data.contentLoading();
    assert.equal(data.want([{ h, off: 4000, len: 100 }], 'terrain:0,0'), 1);
    assert.deepEqual(posted(), [['v', '.light/Data Files/Morrowind.esm', 4000, 100]]);
    data.contentLoaded();
    assert.equal(data.want([{ h, off: 30 << 20, len: 20000 }, { h, off: 31 << 20, len: 20000 }], 'terrain:-2,6'), 2);
    assert.deepEqual(posted(), [['v', 'Data Files/Morrowind.esm', 30 << 20, 20000], ['v', 'Data Files/Morrowind.esm', 31 << 20, 20000]]);
    assert.equal(data.stats.bigLoads, 0, 'its 80 MB are not a texture load');
    assert.equal(data.nextPick(h), h);
    assert.ok(!told.some((m) => m.light), 'never told as read light');
    // (a peek does not take the copy's zeroed bytes for the file's)
    assert.equal(data.peek(h, 0, 10), null);
  } finally { data.close(); }
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
  // (not 25: on a busy machine the link measures fast and some reads find their bytes already in — no wait counted)
  assert.ok(net.waits >= 5 && net.loading === false, JSON.stringify(net));
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

test('announced reads: the page\'s entries (a texture as its light copy, whole; an archive\'s range) fetched by the worker at once, the page\'s wait on ctrl[12]', async (t) => {
  const tex = bytes(300000, 2), light = bytes(40000, 8), bsa = bytes(3 << 20, 5), mesh = bytes(9000, 4);
  const server = fakeServer({ 'tex.dds': tex, 'Morrowind.bsa': bsa, 'Meshes/a.nif': mesh }, [], { 'tex.dds': light });
  const data = await inThread(t, server, { reloads: true });
  const h = data.file('v', 'TEX.dds'), arc = data.file('v', 'morrowind.bsa'), m = data.file('v', 'meshes/A.NIF'), gone = data.fileAs('v', 'gone.nif', 500);
  assert.equal(data.wantWait(0), true, 'nothing announced: nothing to wait for');
  // (the link not measured: the texture's next load reads its light copy — announced as it, whole, the choice not made)
  const n = data.want([{ h, off: 0, len: -1 }, { h: arc, off: (1 << 20) + 5000, len: 70000 }, { h: m }, { h: gone }], 'meshes:-2,6');
  assert.equal(n, 4, 'none in the page');
  assert.equal(h.as, undefined, 'pick not made: the load\'s own first read makes it');
  assert.equal(data.wantWait(20), false, 'not here within 20 ms (the worker runs in this thread: it cannot answer while the page spins)');
  await until(() => Atomics.load(data.ctrl, 12) >= data.wantSeq, 'the batch settled');
  assert.equal(data.wantWait(1000), true);
  assert.equal(data.wantLeft, 0); assert.equal(data.wantFailed, 1, 'the file not in the listing failed');
  const wanted = server.asked.filter(([, , , k]) => k === 'want').map(([p, a, b]) => [p, a, b]).sort();
  assert.deepEqual(wanted, [['.light/tex.dds', 0, 40000], ['Meshes/a.nif', 0, 9000], ['Morrowind.bsa', 1 << 20, (1 << 20) + 65536], ['Morrowind.bsa', (1 << 20) + 65536, (1 << 20) + 131072]]);
  assert.ok(!server.asked.some(([p]) => p === 'tex.dds'), 'never the texture itself before its light copy');
  // (the engine's reads: from the worker's copy, no request)
  const asked = server.asked.length, out = new Uint8Array(300000);
  await data.ensure(h, 0, h.size); data.read(h, out, 0, h.size, 0);
  assert.deepEqual(out.subarray(0, light.length), light);
  await data.ensure(arc, (1 << 20) + 5000, 70000); data.read(arc, out, 0, 70000, (1 << 20) + 5000);
  assert.deepEqual(out.subarray(0, 70000), bsa.subarray((1 << 20) + 5000, (1 << 20) + 75000));
  await data.ensure(m, 0, m.size);
  assert.equal(server.asked.slice(asked).filter(([p, , , k]) => k !== 'bg' && p !== 'tex.dds').length, 0, `read here: ${JSON.stringify(server.asked.slice(asked))}`);
  // (in the page now: not announced again)
  assert.equal(data.want([{ h: m }, { h: arc, off: (1 << 20) + 5000, len: 70000 }], 'meshes:-2,6'), 0);
  assert.equal(data.snapshot().wants, 4);
});

test('announced reads the engine waits for through its own reads (wait false: a GoldSrc map\'s load): posted at once, no batch; an archive read light announced as its light copy\'s range', async (t) => {
  const wad = bytes(600000, 2), wlight = bytes(600000, 6), mdl = bytes(9000, 4);
  const server = fakeServer({ 'valve/halflife.wad': wad, 'valve/models/a.mdl': mdl }, [], { 'valve/halflife.wad': wlight });
  const data = await inThread(t, server), w = data.file('v', 'valve/halflife.wad'), m = data.file('v', 'valve/models/a.mdl'), out = new Uint8Array(70000);
  // (the archive opened at the engine's start, the link not measured: read light — its header)
  await data.ensure(w, 0, 12); data.read(w, out, 0, 12, 0);
  assert.deepEqual(out.subarray(0, 12), wlight.subarray(0, 12));
  const n = data.want([{ h: w, off: 300000, len: 70000 }, { h: m }], { label: 'textures:m1', wait: false });
  assert.equal(n, 2); assert.equal(data.wantSeq, 0, 'no batch number');
  await until(() => data.wantLeft === 0 && server.asked.filter(([, , , k]) => k === 'want').length >= 3, 'its entries settled');
  const wanted = server.asked.filter(([, , , k]) => k === 'want').map(([p, a, b]) => [p, a, b]).sort();
  assert.deepEqual(wanted, [['.light/valve/halflife.wad', 262144, 327680], ['.light/valve/halflife.wad', 327680, 393216], ['valve/models/a.mdl', 0, 9000]]);
  assert.equal(Atomics.load(data.ctrl, 12), 0, 'no batch settled: none was counted');
  assert.equal(data.wantWait(0), true, 'nothing for the page to wait for');
  // (the engine's read past the archive's start: the light copy's bytes, from the worker's copy)
  const asked = server.asked.length;
  await data.ensure(w, 300000, 70000); data.read(w, out, 0, 70000, 300000);
  assert.deepEqual(out, wlight.subarray(300000, 370000));
  assert.equal(server.asked.slice(asked).filter(([p, , , k]) => k === 'demand' && p.includes('halflife')).length, 0, `read here: ${JSON.stringify(server.asked.slice(asked))}`);
  assert.equal(data.snapshot().wants, 2);
});

test('announced reads: a wait covers the batches announced since the last one — an older batch still hung holds nothing', async (t) => {
  const server = fakeServer({ 'Meshes/stuck.nif': bytes(9000, 3), 'Meshes/a.nif': bytes(9000, 4) });
  let hang = true; const held = [];
  const fetch = server.fetch;
  server.fetch = (url, init) => (hang && /stuck\.nif/.test(String(url)) ? new Promise((r) => held.push(() => r(fetch(url, init)))) : fetch(url, init));
  const data = await inThread(t, server), stuck = data.file('v', 'meshes/stuck.nif'), a = data.file('v', 'meshes/a.nif');
  assert.equal(data.want([{ h: stuck }], 'meshes:0,0'), 1);
  await until(() => held.length > 0, 'its request on its way, hung');
  assert.equal(data.wantWait(10), false, 'timed out');
  assert.equal(data.wantWait(10), true, 'nothing announced since: nothing to wait for');
  assert.equal(data.want([{ h: a }], 'meshes:1,0'), 1);
  await until(() => Atomics.load(data.ctrl, 12) >= data.wantSeq, 'the new batch settled, the old one still hung');
  assert.equal(data.wantWait(1000), true);
  assert.equal(data.wantLeft, 1, 'the hung entry still counted as not settled');
  hang = false; for (const go of held.splice(0)) go();
  await until(() => data.wantLeft === 0, 'the old one settled too');
});

test('announced reads: the load announced reads what was announced (light copy or file), even when the link\'s measure changes meanwhile', async (t) => {
  const tex = bytes(300000, 2), light = bytes(40000, 8), server = fakeServer({ 'tex.dds': tex }, [], { 'tex.dds': light });
  const data = await inThread(t, server, { reloads: true }), h = data.file('v', 'tex.dds'), out = new Uint8Array(h.size);
  assert.equal(data.want([{ h }], 'textures:0,0'), 1, 'its light copy announced (the link not fast)');
  await until(() => Atomics.load(data.ctrl, 12) >= data.wantSeq, 'settled');
  assert.equal(data.wantWait(1000), true);
  // (the link measured fast during the wait: the load reads the light copy fetched all the same, not the file)
  Atomics.store(data.ctrl, 8, 1); Atomics.store(data.ctrl, 7, 1);
  const asked = server.asked.length;
  await data.ensure(h, 0, h.size); data.read(h, out, 0, h.size, 0);
  assert.deepEqual(out.subarray(0, light.length), light);
  assert.ok(!server.asked.slice(asked).some(([p, , , k]) => p === 'tex.dds' && k === 'demand'), 'the file itself not waited for');
  // (pinned for that load only: the next one chooses again)
  h.at = -Infinity; assert.equal(data.nextPick(h), h, 'the next load: the file (fast)');
});

test('announced reads on a fast link: the texture itself', async (t) => {
  const tex = bytes(300000, 2), light = bytes(40000, 8), server = fakeServer({ 'tex.dds': tex }, [], { 'tex.dds': light });
  const data = await inThread(t, server, { bw: 50 << 20, reloads: true }), h = data.file('v', 'tex.dds');
  await until(() => Atomics.load(data.ctrl, 7) === 1, 'the link fast');
  assert.equal(data.want([{ h }], 'textures:-2,6'), 1);
  await until(() => Atomics.load(data.ctrl, 12) >= data.wantSeq, 'settled');
  assert.deepEqual(server.asked.filter(([, , , k]) => k === 'want').map(([p, a, b]) => [p, a, b]), [['tex.dds', 0, 300000]]);
});

test('a big announced load of an engine that reloads in place reads light first on a fast link; small loads, places, the page\'s choice unchanged', () => {
  const told = [], fake = { onmessage: null, postMessage: (m) => told.push(m), terminate() {} };
  const data = new GameData({ name: 'v', worker: fake });
  try {
    data.reloads(true);
    const c = data.ctrl; c[7] = 1; c[8] = 12 << 10; c[9] = 0; // (a fast link: 12 MiB/s — 24 MiB in LOAD_BUDGET_S)
    const tex = (i, size = 3 << 20) => { const h = data.fileAs('v', `textures/t${i}.dds`, size); h.light = 60000; return h; };
    const mesh = data.fileAs('v', 'meshes/a.nif', 40 << 20); mesh.light = 0;
    const lightOf = (h) => `.light/${h.path}`;
    const posted = () => { data.wantFlush(); return told.filter((m) => m.want).at(-1).want.list.map(([, path]) => path); };
    // (small: 4 textures, 12 MiB — the files themselves, as before; a mesh weighs nothing in the choice)
    const small = [0, 1, 2, 3].map((i) => tex(i));
    assert.equal(data.want([...small, mesh].map((h) => ({ h })), 'textures:0,0'), 5);
    assert.deepEqual(posted(), [...small.map((h) => h.path), mesh.path]);
    assert.equal(data.bigLoad, null); assert.equal(data.stats.bigLoads, 0);
    // (big: 10 more, 30 MiB > 24 — their light copies announced and pinned; the files of the small load are under way)
    for (const h of small) h.at = performance.now();
    const big = Array.from({ length: 10 }, (_, i) => tex(10 + i));
    data.wantWait(0); // (the small load's window over)
    data.want([...big, ...small].map((h) => ({ h })), 'textures:-2,6');
    assert.deepEqual(posted().slice(0, 10), big.map(lightOf)); assert.ok(big.every((h) => h.pin && !h.pin.real));
    assert.deepEqual(data.snapshot().bigLoads, 1); assert.equal(data.stats.bigFiles, 10); assert.equal(data.stats.bigBytes, 30 << 20);
    // (its loads read light, their upgrades told soon; a preload of the moment (readable) reads light too)
    assert.notEqual(data.pick(big[0], 0), big[0]);
    assert.deepEqual(told.find((m) => m.light && m.light.path === big[0].path).light, { name: 'v', path: big[0].path, soon: true });
    const pre = tex(30); assert.notEqual(data.pick(pre, 0), pre, 'a preload during the big load: light');
    // (a predicted place keeps the link's choice: the files themselves on a fast link)
    const placed = tex(31); data.want([{ h: placed }], { prio: 'place', label: 'place:-2,6' });
    assert.ok(told.at(-1).wantPlace, 'posted at once');
    assert.deepEqual(told.at(-1).wantPlace.list.map(([, path]) => path), [placed.path]);
    // (the engine's wait ends the announce's hold: BIG_HOLD_MS after it, the link decides again)
    data.wantWait(1);
    assert.ok(data.bigLoad.end !== null && data.bigLoadNow());
    data.bigLoad.end -= 6000; assert.equal(data.bigLoadNow(), false); assert.equal(data.bigLoad, null);
    const later = tex(32); assert.equal(data.pick(later, 0), later, 'after it: the file (fast)');
    // (the page's own choice, or ?lightfirst=0, or an engine that cannot reload: no big load)
    const again = () => Array.from({ length: 10 }, (_, i) => tex(40 + i + 20 * again.n++)).map((h) => ({ h })); again.n = 0;
    data.prefer('real'); data.want(again()); data.wantWait(0); assert.equal(data.stats.bigLoads, 1, 'the page prefers real');
    data.prefer(null); data.lightFirst(false); data.want(again()); data.wantWait(0); assert.equal(data.stats.bigLoads, 1, 'light first off');
    data.lightFirst(true); data.reloads(false); data.want(again()); data.wantWait(0); assert.equal(data.stats.bigLoads, 1, 'no reload in place');
    data.reloads(true); c[8] = 0; data.want(again()); data.wantWait(0); assert.equal(data.stats.bigLoads, 2, 'not measured yet: FAST_BPS, 6 MiB in the budget');
  } finally { data.close(); }
});

test('the files made sharp in place reach the page\'s listeners a few at a time, the latest first, only those read light (a burst of reloads is a hitch)', () => {
  const fake = { onmessage: null, postMessage() {}, terminate() {} };
  // (told as they come: realInPage off — the next test tells them with their bytes in the page)
  const data = new GameData({ name: 'v', worker: fake, realInPage: false });
  try {
    const got = []; data.onReal((keys) => got.push(keys));
    // (5 textures read light — the link not fast —, then thousands of other files whole: the learned order, a download)
    const read = ['a', 'b', 'c', 'd', 'e'].map((n) => { const h = data.fileAs('v', `${n}.dds`, 300000); h.light = 40000; data.pick(h, 0); assert.ok(data.lightRead(h)); return h; });
    const others = Array.from({ length: 3000 }, (_, i) => `v\nother${i}.dds`);
    fake.onmessage({ data: { real: others } });
    fake.onmessage({ data: { real: read.map((h) => 'v\n' + h.path) } });
    assert.ok(data.realHere.has('v\ne.dds') && data.realHere.has('v\nother9.dds'), 'known at once (the next loads read the files)');
    assert.equal(got.length, 0);
    assert.equal(data.realQ.length, 5, 'only the files read light queued');
    data.holdWatch(); data.holdWatch(); data.holdWatch(); data.holdWatch();
    assert.deepEqual(got, [['v\ne.dds', 'v\nd.dds'], ['v\nc.dds', 'v\nb.dds'], ['v\na.dds']]);
    fake.onmessage({ data: { real: ['v\na.dds'] } }); data.holdWatch();
    assert.equal(got.length, 3, 'told once');
    data.reloaded(3); assert.equal(data.snapshot().reloaded, 3);
  } finally { data.close(); }
});

test('the files made sharp in place reach the listeners with their bytes in the page: fetched first, a few under way at once, the engine\'s read then waits for nothing', async () => {
  const asked = [], fake = { onmessage: null, terminate() {}, postMessage: (m) => { if (m.read) asked.push(m.read); } };
  const data = new GameData({ name: 'v', worker: fake, cacheBytes: 64 << 20, reloads: true });
  try {
    clearInterval(data.holdTimer); // (holdWatch called by the test)
    const got = []; data.onReal((keys) => got.push(...keys));
    const answer = (r) => fake.onmessage({ data: { id: r.id, bytes: new Uint8Array(r.len).fill(7) } });
    const task = () => new Promise((r) => setTimeout(r, 0));
    // (12 textures of 1 MiB read light, then here whole: 8 MiB = 1/8 of the page's bytes under way at most)
    const read = Array.from({ length: 12 }, (_, i) => { const h = data.fileAs('v', `t${i}.dds`, 1 << 20); h.light = 40000; data.pick(h, 0); return h; });
    fake.onmessage({ data: { real: read.map((h) => 'v\n' + h.path) } });
    data.holdWatch();
    assert.deepEqual(asked.map((r) => r.path), ['t11.dds', 't10.dds'], 'the latest first, REAL_PER_TICK a tick');
    assert.equal(got.length, 0, 'not told before its bytes are here');
    for (let i = 0; i < 5; i++) data.holdWatch();
    assert.equal(asked.length, 8, 'at most 8 MiB under way');
    for (const r of asked.splice(0, 2)) answer(r);
    await task();
    assert.deepEqual(got, ['v\nt11.dds', 'v\nt10.dds']);
    const out = new Uint8Array(1 << 20), syncs = data.stats.syncFetches;
    data.repick(read[11]); data.read(read[11], out, 0, 1 << 20, 0);
    assert.equal(data.stats.syncFetches, syncs, 'read from the page'); assert.equal(out[1000], 7);
    data.holdWatch(); assert.equal(asked.length, 8, 'two more under way');
    while (asked.length) { answer(asked.shift()); await task(); data.holdWatch(); }
    assert.equal(got.length, 12); assert.equal(data.snapshot().realFetches, 12);
    assert.equal(data.snapshot().realMissed, 0); assert.equal(data.snapshot().realRaced, 0);
  } finally { data.close(); }
});

test('the files made sharp in place: none fetched that no reload reads, none past the engine\'s backlog, a reload\'s read that waited all the same counted', async () => {
  const asked = [], fake = { onmessage: null, terminate() {}, postMessage: (m) => { if (m.read) asked.push(m.read); } };
  let backlog = 0;
  const data = new GameData({ name: 'v', worker: fake, cacheBytes: 64 << 20, reloads: true, realBacklog: () => backlog });
  try {
    clearInterval(data.holdTimer);
    const got = []; data.onReal((keys) => got.push(...keys));
    const answer = (r) => fake.onmessage({ data: { id: r.id, bytes: new Uint8Array(r.len).fill(7) } });
    const task = () => new Promise((r) => setTimeout(r, 0));
    const read = Array.from({ length: 6 }, (_, i) => { const h = data.fileAs('v', `t${i}.dds`, 1 << 20); h.light = 40000; data.pick(h, 0); return h; });
    backlog = 7;
    fake.onmessage({ data: { real: read.map((h) => 'v\n' + h.path) } });
    // (t5 loaded itself since: no reload reads it — told, not fetched)
    read[5].repick = true; data.pick(read[5], 0); assert.equal(data.lightRead(read[5]), false);
    data.holdWatch();
    assert.deepEqual(got, ['v\nt5.dds'], 'told at once'); assert.deepEqual(asked.map((r) => r.path), ['t4.dds'], 'the backlog and those under way: 8 at most');
    data.holdWatch(); assert.equal(asked.length, 1);
    answer(asked[0]); await task(); assert.deepEqual(got, ['v\nt5.dds', 'v\nt4.dds']);
    // (its bytes gone from the page before the engine read them: its read waits, counted)
    data.cache.clear(); data.repick(read[4]);
    data.fetchSync = (h) => { data.stats.syncFetches++; data.keep(h, 0, new Uint8Array(h.size)); }; // (the worker's answer, as if waited for)
    data.read(read[4], new Uint8Array(16), 0, 16, 0);
    assert.equal(data.snapshot().realMissed, 1);
    // (a load of the file itself while its fetch is under way: realRaced)
    backlog = 0; data.holdWatch(); assert.deepEqual(asked.slice(1).map((r) => r.path), ['t3.dds', 't2.dds']);
    read[3].repick = true; data.pick(read[3], 0); assert.equal(read[3].as, null, 'the file itself chosen: realHere');
    data.read(read[3], new Uint8Array(16), 0, 16, 0);
    assert.equal(data.snapshot().realRaced, 1);
    // (an engine that does not reload in place: told as they come, nothing fetched)
    data.reloadsInPlace = false; const before = asked.length; data.holdWatch();
    assert.equal(asked.length, before); assert.ok(got.includes('v\nt1.dds') && got.includes('v\nt0.dds'));
    for (const r of asked.splice(1)) answer(r);
    await task();
  } finally { data.close(); }
});

test('a big load announced in two lists (a place\'s textures, its land\'s), each under the budget, the window over it: light first for both', () => {
  const told = [], fake = { onmessage: null, postMessage: (m) => told.push(m), terminate() {} };
  const data = new GameData({ name: 'v', worker: fake });
  try {
    data.reloads(true);
    const c = data.ctrl; c[7] = 1; c[8] = 12 << 10; c[9] = 0; // (24 MiB in LOAD_BUDGET_S)
    const tex = (i) => { const h = data.fileAs('v', `textures/w${i}.dds`, 3 << 20); h.light = 60000; return h; };
    const models = Array.from({ length: 6 }, (_, i) => tex(i)), land = Array.from({ length: 6 }, (_, i) => tex(10 + i));
    // (18 MiB each, 36 together)
    assert.equal(data.want(models.map((h) => ({ h })), 'textures:-2,6'), 6);
    assert.equal(data.want(land.map((h) => ({ h })), 'terrain:-2,6'), 6);
    assert.equal(told.filter((m) => m.want).length, 0, 'posted with the window: at the wait');
    assert.equal(data.wantWait(0), false);
    const batches = told.filter((m) => m.want).map((m) => m.want);
    assert.deepEqual(batches.map((b) => [b.seq, b.label]), [[1, 'textures:-2,6'], [2, 'terrain:-2,6']]);
    assert.ok(batches.every((b) => b.list.every(([, path]) => path.startsWith('.light/'))), 'both halves light');
    assert.equal(data.stats.bigLoads, 1); assert.equal(data.stats.bigBytes, 36 << 20);
    // (compressed ranges: the same 36 MiB at 0.6 of it on the wire, 21.6 MiB — under the budget: the files)
    c[15] = 600;
    const more = Array.from({ length: 12 }, (_, i) => tex(30 + i));
    data.bigLoad = null; data.want(more.map((h) => ({ h })), 'textures:0,0'); data.wantWait(0);
    assert.ok(told.filter((m) => m.want).at(-1).want.list.every(([, path]) => !path.startsWith('.light/')), 'under the budget on the wire: the files');
    assert.equal(data.stats.bigLoads, 1);
  } finally { data.close(); }
});

test('a big load\'s hold: only its own window\'s wait ends it; a small load during the hold reads the files and does not extend it', () => {
  const told = [], fake = { onmessage: null, postMessage: (m) => told.push(m), terminate() {} };
  const data = new GameData({ name: 'v', worker: fake });
  try {
    data.reloads(true);
    const c = data.ctrl; c[7] = 1; c[8] = 12 << 10; c[9] = 0;
    const tex = (i, size = 3 << 20) => { const h = data.fileAs('v', `textures/x${i}.dds`, size); h.light = 60000; return h; };
    data.want(Array.from({ length: 10 }, (_, i) => ({ h: tex(i) })), 'textures:0,0');
    data.wantWait(0);
    assert.ok(data.bigLoadNow()); const end = data.bigLoad.end; assert.notEqual(end, null);
    // (a small load in the hold: the files themselves, its wait leaves the hold's end as it was)
    const small = tex(20);
    data.want([{ h: small }], 'textures:1,0'); data.wantWait(0);
    assert.deepEqual(told.filter((m) => m.want).at(-1).want.list.map(([, path]) => path), [small.path]);
    assert.equal(data.bigLoad.end, end);
    // (a preload of the moment, not announced: light)
    const pre = tex(21); assert.notEqual(data.pick(pre, 0), pre);
  } finally { data.close(); }
});

test('a predicted place (want prio \'place\'): fetched by the worker in the background (not learned), outside the wait\'s window, its light-or-file choice not pinned', async (t) => {
  const tex = bytes(300000, 2), light = bytes(40000, 8), mesh = bytes(9000, 4);
  const server = fakeServer({ 'tex.dds': tex, 'Meshes/a.nif': mesh }, [], { 'tex.dds': light });
  const data = await inThread(t, server, { reloads: true });
  const h = data.file('v', 'tex.dds'), m = data.file('v', 'meshes/a.nif');
  assert.equal(data.want([{ h }, { h: m }], { prio: 'place', label: 'place:-2,6' }), 2);
  assert.equal(data.wantSeq, 0, 'no batch: the engine\'s waits never wait for it');
  assert.equal(data.wantWait(0), true);
  assert.equal(h.pin, undefined, 'not pinned: the load, when it comes, chooses by its link then');
  await until(() => server.asked.filter(([p]) => p === 'Meshes/a.nif' || p === '.light/tex.dds').length === 2, 'both fetched');
  const asked = server.asked.filter(([p]) => p === 'Meshes/a.nif' || p === '.light/tex.dds');
  assert.ok(asked.every(([, , , k]) => k === 'bg'), `background requests (p=1, not learned): ${JSON.stringify(asked)}`);
  assert.equal(data.snapshot().placeWants, 2);
  assert.equal(data.snapshot().wants, 0);
});
