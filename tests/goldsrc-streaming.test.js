// Streamed game files of the GoldSrc ports (src/ports/goldsrc/files.js): the engine's tree at once, bytes at their
// first read (synchronously), the learned startup set first, the browser's copy before the network, and the reads
// reported to the server's learned list (POST /api/prefetch/<manifest>).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamedFiles, learnedPlan, treeFiles, languageFiles, BLOCK, PIECE, STARTUP_GAP_MS, QUIET_MS } from '../src/ports/goldsrc/files.js';
import { BLOCK as SERVER_BLOCK, CHUNK as SERVER_PIECE } from '../src/vfs/http-backend.js';
import { createServer } from '../src/host/server.js';

const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255);
/** The part of Emscripten's FS the streamed files use. */
function fakeFS() {
  const nodes = new Map();
  return {
    nodes,
    ErrnoError: class extends Error { constructor(n) { super(`errno ${n}`); this.errno = n; } },
    mkdirTree() {},
    createFile(dir, name) {
      const node = { contents: null, usedBytes: 0, stream_ops: { read() { throw new Error('MEMFS read'); }, mmap: (stream) => ({ data: stream.node.contents }), llseek: () => 0 } };
      nodes.set(`${dir}/${name}`, node); return node;
    },
  };
}
/**
 * Files over a fake server: `content` by path; requests counted; a store in a Map; `readAhead`: the option's;
 * `batches`: a store that writes many at once (its batches' keys listed there); `failing`: paths whose requests fail.
 */
function setup(content, { local = new Map(), readAhead = undefined, held = false, batches = null, failing = [], ...options } = {}) {
  const files = [...content].map(([p, data]) => ({ path: p, size: data.length, mtime: 5 }));
  const requests = [], range = (url) => { const u = new URL(url, 'http://x'), [s, e] = u.searchParams.get('r').split('-').map(Number); return [decodeURIComponent(u.pathname.split('/').slice(3).join('/')), s, e]; };
  const writes = [], removed = [], pending = [], backgrounds = [];
  let clock = 1000;
  const sf = new StreamedFiles({
    name: 'gs', files, now: () => clock, readAhead, ...options,
    syncGet: (url, size) => { const [p, s, e] = range(url); requests.push(['sync', p, s, e]); assert.equal(size, e - s); return content.get(p).slice(s, e); },
    // (held: each answer waits for release() — a slow link)
    get: async (url) => {
      const [p, s, e] = range(url); requests.push(['async', p, s, e]); backgrounds.push(url.includes('&p=1'));
      if (held) await new Promise((r) => pending.push(r));
      if (failing.includes(p)) throw new Error('HTTP 503');
      return content.get(p).slice(s, e);
    },
    store: {
      read: async (k) => local.get(k), write: async (k, v) => { writes.push(k); local.set(k, v); }, keys: async () => [...local.keys()], remove: async (ks) => { removed.push(...ks); },
      ...(batches ? { writeMany: async (entries) => { batches.push(entries.map(([k]) => k.split('#')[1])); for (const [k, v] of entries) local.set(k, v); } } : {}),
    },
  });
  const FS = fakeFS(); sf.mount(FS, '/rodir');
  const node = (p) => FS.nodes.get(`/rodir/${p.split('/').slice(0, -1).join('/')}`.replace(/\/$/, '') + '/' + p.split('/').at(-1)) ?? FS.nodes.get(`/rodir/${p}`);
  const read = (p, position, length) => { const buf = new Uint8Array(length); const n = node(p).stream_ops.read({ node: node(p) }, buf, 0, length, position); return buf.subarray(0, n); };
  const release = async () => { while (pending.length) pending.shift()(); await new Promise((r) => setTimeout(r, 0)); };
  return { sf, FS, node, read, requests, backgrounds, writes, removed, local, release, tick: (ms) => { clock += ms; } };
}

test('the learned-list units are the server\'s', () => {
  assert.equal(BLOCK, SERVER_BLOCK); assert.equal(PIECE, SERVER_PIECE);
});

test('the tree lists the game files, not the native binaries nor dot files', () => {
  const tree = { dirs: { valve: { dirs: { dlls: { dirs: {}, files: { 'hl.dll': { size: 1, mtime: 1 }, 'hl.so': { size: 1, mtime: 1 } } }, '.git': { dirs: {}, files: { x: { size: 1, mtime: 1 } } } }, files: { 'gfx.wad': { size: 3, mtime: 2 } } } }, files: { 'game.EXE': { size: 1, mtime: 1 } } };
  assert.deepEqual(treeFiles(tree), [{ path: 'valve/gfx.wad', size: 3, mtime: 2 }]);
});

test('the startup set is the learned list up to its first pause; big files mostly unread come as pieces', () => {
  const files = [{ path: 'a', size: 100 }, { path: 'b', size: 4 * BLOCK }, { path: 'c', size: 3 * BLOCK }, { path: 'd', size: 10 }, { path: 'later', size: 10 }];
  const plan = learnedPlan([
    ['a', 0, 1, 0], ['b', 0, 0b11, 300], ['c', 0, 0, 900], ['c', 1, 0, 950], ['c', 2, 0, 960], ['gone', 0, 1, 1000],
    ['d', 0, 1, 960 + STARTUP_GAP_MS], ['later', 0, 1, 961 + 2 * STARTUP_GAP_MS],
  ], files);
  assert.deepEqual(plan.map((e) => [e.file.path, e.pieces, e.startup]), [
    ['a', null, true], ['b', [0, 1], true], ['c', null, true], ['d', null, true], ['later', null, false]]);
});

test('a read fetches the bytes it needs at once, only those, and the engine\'s later reads find them here', () => {
  const big = bytes(3 * BLOCK + 5), small = bytes(1000, 9);
  const { sf, read, requests, writes, tick } = setup(new Map([['maps/x.bsp', big], ['gfx.wad', small]]));
  sf.start();
  assert.deepEqual(read('maps/x.bsp', 10, 20), big.subarray(10, 30)); // (a header: its piece only)
  assert.deepEqual(requests, [['sync', 'maps/x.bsp', 0, PIECE]]);
  tick(500);
  assert.deepEqual(read('maps/x.bsp', BLOCK - 4, 8), big.subarray(BLOCK - 4, BLOCK + 4)); // (across two pieces: one request)
  assert.deepEqual(requests.at(-1), ['sync', 'maps/x.bsp', BLOCK - PIECE, BLOCK + PIECE]);
  assert.deepEqual(read('maps/x.bsp', 0, big.length), big); // (the whole file: the missing runs)
  assert.equal(sf.files.get('maps/x.bsp').data.length, big.length);
  const n = requests.length;
  assert.deepEqual(read('maps/x.bsp', 5, 100), big.subarray(5, 105)); assert.equal(requests.length, n);
  assert.deepEqual(read('gfx.wad', 0, 4096), small); // (past the end: what there is)
  assert.deepEqual(requests.at(-1), ['sync', 'gfx.wad', 0, 1000]);
  assert.ok(writes.includes('gfx.wad\n1000\n5') && writes.includes(`maps/x.bsp\n${big.length}\n5\n#0`));
  const reads = sf.takeReads();
  assert.deepEqual(reads[0], ['maps/x.bsp', 0, PIECE, 0]);
  assert.deepEqual(reads[1], ['maps/x.bsp', BLOCK - PIECE, BLOCK + PIECE, 500]);
  assert.deepEqual(sf.takeReads(), []);
});

test('the browser\'s copy serves before the network; entries of older files are removed; mmap has the whole file', async () => {
  const big = bytes(2 * BLOCK), small = bytes(300, 4);
  const local = new Map([['small\n300\n5', small], [`big\n${2 * BLOCK}\n5\n#3`, big.slice(3 * PIECE, 4 * PIECE)], ['small\n300\n4', bytes(300)], ['oldsha:small', bytes(1)]]);
  const { sf, node, requests, removed } = setup(new Map([['small', small], ['big', big]]), { local });
  await sf.openLocal();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(removed.sort(), ['oldsha:small', 'small\n300\n4']);
  assert.deepEqual(sf.localNotLoaded().map((e) => [e.file.path, e.pieces]).sort(), [['big', [3]], ['small', null]]);
  await sf.load(sf.files.get('small'));
  assert.deepEqual(sf.files.get('small').data, small); assert.deepEqual(requests, []);
  await sf.load(sf.files.get('big'), [2, 3, 4]); // (pieces: 3 from here, 2 and 4 from the server)
  assert.deepEqual(requests, [['async', 'big', 2 * PIECE, 3 * PIECE], ['async', 'big', 4 * PIECE, 5 * PIECE]]);
  await sf.load(sf.files.get('big')); // (the rest)
  assert.deepEqual(sf.files.get('big').data, big);
  const nb = node('big');
  assert.deepEqual(nb.stream_ops.mmap({ node: nb }).data, big); assert.equal(nb.usedBytes, big.length);
});

test('read-ahead (opt-in): after a read that waited, the file\'s next missing pieces load in the background, one load per file', async () => {
  const big = bytes(3 * BLOCK), small = bytes(5 * PIECE, 3);
  const { sf, read, requests } = setup(new Map([['stream.adf', big], ['short.adf', small]]), { readAhead: 16 });
  sf.start();
  assert.deepEqual(read('stream.adf', 0, 100), big.subarray(0, 100));
  // (the read's own piece at once; the next sixteen, from the server, without the engine waiting)
  assert.deepEqual(requests, [['sync', 'stream.adf', 0, PIECE], ['async', 'stream.adf', PIECE, 17 * PIECE]]);
  const f = sf.files.get('stream.adf'), inFlight = f.ahead;
  assert.deepEqual(read('stream.adf', 40 * PIECE, 10), big.subarray(40 * PIECE, 40 * PIECE + 10));
  assert.deepEqual(requests.slice(2), [['sync', 'stream.adf', 40 * PIECE, 41 * PIECE]], 'one load per file at a time');
  await inFlight;
  assert.equal(f.ahead, null);
  assert.deepEqual(read('stream.adf', PIECE + 7, 16 * PIECE - 7), big.subarray(PIECE + 7, 17 * PIECE)); // (all here)
  assert.equal(requests.length, 3);
  read('stream.adf', 17 * PIECE, 10);
  assert.deepEqual(requests.slice(3), [['sync', 'stream.adf', 17 * PIECE, 18 * PIECE], ['async', 'stream.adf', 18 * PIECE, 34 * PIECE]]);
  await f.ahead;
  // (a short file: its last pieces, then it is whole)
  read('short.adf', 0, 10);
  assert.deepEqual(requests.slice(5), [['sync', 'short.adf', 0, PIECE], ['async', 'short.adf', PIECE, 5 * PIECE]]);
  await sf.files.get('short.adf').ahead;
  assert.deepEqual(sf.files.get('short.adf').data, small);
  assert.equal(sf.stats.ahead, 3);
  // (the reads learned are the engine's own, not the loads ahead)
  assert.deepEqual(sf.takeReads().map((r) => r.slice(0, 3)), [['stream.adf', 0, PIECE], ['stream.adf', 40 * PIECE, 41 * PIECE], ['stream.adf', PIECE, 17 * PIECE], ['stream.adf', 17 * PIECE, 18 * PIECE], ['short.adf', 0, PIECE]]);
  // (off by default: a read fetches what it needs, nothing more)
  const off = setup(new Map([['stream.adf', big]]));
  off.read('stream.adf', 0, 100);
  assert.deepEqual(off.requests, [['sync', 'stream.adf', 0, PIECE]]);
});

test('a page\'s read reports teach the server\'s learned list, in the page\'s own times', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-stream-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), gs = path.join(games, 'gs');
  fs.mkdirSync(path.join(gs, 'base', 'valve', 'maps'), { recursive: true }); fs.mkdirSync(path.join(gs, 'versions', 'orig'), { recursive: true });
  fs.writeFileSync(path.join(gs, 'base', 'valve', 'gfx.wad'), bytes(5000));
  fs.writeFileSync(path.join(gs, 'base', 'valve', 'maps', 'start.bsp'), bytes(2 * BLOCK));
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

test('a language\'s folders are mounted over the ones they translate; without it, out of the engine\'s tree', () => {
  const files = [{ path: 'valve/titles.txt', size: 10 }, { path: 'valve/sound/vox/a.wav', size: 5 }, { path: 'valve/maps/c0a0.bsp', size: 99 },
    { path: 'valve_french/Titles.txt', size: 12 }, { path: 'valve_french/sound/vox/a.wav', size: 6 }, { path: 'valve_french/resource/gameui_french.txt', size: 3 }];
  const fr = languageFiles(files, { valve_french: 'valve' }, ['valve_french']);
  const at = (f) => f.at ?? f.path;
  assert.deepEqual(fr.map(at).sort(), ['valve/Titles.txt', 'valve/maps/c0a0.bsp', 'valve/resource/gameui_french.txt', 'valve/sound/vox/a.wav']);
  assert.equal(fr.find((f) => at(f) === 'valve/sound/vox/a.wav').path, 'valve_french/sound/vox/a.wav', 'fetched from its own folder');
  const en = languageFiles(files, undefined, ['valve_french']);
  assert.deepEqual(en.map(at).sort(), ['valve/maps/c0a0.bsp', 'valve/sound/vox/a.wav', 'valve/titles.txt']);
});

test('asyncReads (opt-in): a file node tells its missing bytes and fetches them without a synchronous request', async () => {
  const big = bytes(3 * BLOCK);
  const local = new Map([[`stream.adf\n${big.length}\n5\n#2`, big.slice(2 * PIECE, 3 * PIECE)]]);
  const { sf, node, read, requests, backgrounds } = setup(new Map([['stream.adf', big]]), { local, asyncReads: true, readAhead: 4 });
  await sf.openLocal(); sf.start();
  const io = node('stream.adf').orthrosStreamed;
  assert.equal(io.missing(10, 100), true);
  await io.ensure(PIECE - 5, 15); // (pieces 0 and 1: the engine's own read, not a background load)
  assert.deepEqual(requests[0], ['async', 'stream.adf', 0, 2 * PIECE]);
  assert.equal(io.missing(10, 100), false);
  assert.deepEqual(read('stream.adf', PIECE - 5, 15), big.subarray(PIECE - 5, PIECE + 10)); // (no synchronous request)
  assert.ok(!requests.some((r) => r[0] === 'sync'));
  await sf.files.get('stream.adf').ahead; // (then read ahead: pieces 2 to 5, the kept one from the browser's copy)
  assert.deepEqual(requests.slice(1), [['async', 'stream.adf', 3 * PIECE, 6 * PIECE]]);
  assert.deepEqual(backgrounds, [false, true]);
  assert.equal(sf.stats.waits, 1);
  // (off by default: no hook on the nodes)
  assert.equal(setup(new Map([['x', bytes(10)]])).node('x').orthrosStreamed, undefined);
});

test('a piece another load is fetching is waited for, not fetched twice', async () => {
  const big = bytes(2 * BLOCK);
  const { sf, node, requests, release } = setup(new Map([['f.bin', big]]), { asyncReads: true, held: true });
  const f = sf.files.get('f.bin');
  const background = sf.load(f, [0, 1, 2, 3]);
  await new Promise((r) => setTimeout(r, 0));
  const wait = node('f.bin').orthrosStreamed.ensure(PIECE + 1, 10);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(requests, [['async', 'f.bin', 0, 4 * PIECE]]);
  await release(); await Promise.all([background, wait]);
  assert.equal(requests.length, 1);
  assert.equal(node('f.bin').orthrosStreamed.missing(PIECE + 1, 10), false);
});

test('demandFirst (opt-in): background loads wait while the engine waits for bytes, in requests of backgroundRange', async () => {
  const a = bytes(BLOCK), b = bytes(BLOCK, 9);
  const { sf, node, requests, release, tick } = setup(new Map([['a', a], ['b', b]]), { asyncReads: true, demandFirst: true, backgroundRange: 4 * PIECE, held: true });
  const demand = node('a').orthrosStreamed.ensure(0, 10);
  const background = sf.load(sf.files.get('b'));
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(requests, [['async', 'a', 0, PIECE]], 'the background load waits its turn');
  await release(); await demand;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(requests.length, 1, 'and a moment after');
  tick(QUIET_MS);
  for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 80)); await release(); }
  await background;
  assert.deepEqual(requests.slice(1), [0, 4, 8, 12].map((p) => ['async', 'b', p * PIECE, (p + 4) * PIECE]));
  assert.deepEqual(sf.files.get('b').data, b);
});

test('a file the engine reads at random loads whole in the background once asked, each response kept in one write', async () => {
  const img = bytes(5 * PIECE + 3), sfx = bytes(3 * PIECE, 4), batches = [];
  const { sf, node, requests, backgrounds, writes } = setup(new Map([['models/img', img], ['audio/sfx', sfx]]), { asyncReads: true, backgroundRange: 2 * PIECE, batches, failing: ['audio/sfx'] });
  await node('models/img').orthrosStreamed.ensure(2 * PIECE, 10); // (the engine's own read first)
  node('models/img').orthrosStreamed.complete(); node('audio/sfx').orthrosStreamed.complete();
  assert.equal(requests.length, 1, 'nothing until the page lets them load (after the learned list)');
  await sf.completeWanted(2);
  assert.deepEqual(requests.slice(1).filter((r) => r[1] === 'models/img'), [['async', 'models/img', 0, 2 * PIECE], ['async', 'models/img', 3 * PIECE, 5 * PIECE], ['async', 'models/img', 5 * PIECE, img.length]]);
  assert.ok(backgrounds.slice(1).every(Boolean));
  assert.deepEqual(sf.files.get('models/img').data, img);
  assert.deepEqual(batches.filter((b) => b.length > 1), [['0', '1'], ['3', '4']]);
  assert.equal(writes.length, 0);
  assert.equal(sf.stats.completed, 1);
  // (a file whose loads failed is not tried again in a loop: its pieces wait for the engine's reads)
  const tried = requests.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(requests.length, tried);
  assert.equal(node('audio/sfx').orthrosStreamed.missing(0, 10), true);
  node('models/img').orthrosStreamed.complete(); await sf.completeWanted(2);
  assert.equal(requests.length, tried);
});
