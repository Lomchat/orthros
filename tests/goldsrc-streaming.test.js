// Streamed game files of the GoldSrc ports (src/ports/goldsrc/files.js): the engine's tree at once, bytes at their
// first read (synchronously), the learned startup set first, the browser's copy before the network, and the reads
// reported to the server's learned list (POST /api/prefetch/<manifest>).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamedFiles, learnedPlan, treeFiles, BLOCK, PIECE, STARTUP_GAP_MS } from '../src/ports/goldsrc/files.js';
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
/** Files over a fake server: `content` by path; requests counted; a store in a Map. */
function setup(content, { local = new Map() } = {}) {
  const files = [...content].map(([p, data]) => ({ path: p, size: data.length, mtime: 5 }));
  const requests = [], range = (url) => { const u = new URL(url, 'http://x'), [s, e] = u.searchParams.get('r').split('-').map(Number); return [decodeURIComponent(u.pathname.split('/').slice(3).join('/')), s, e]; };
  const writes = [], removed = [];
  let clock = 1000;
  const sf = new StreamedFiles({
    name: 'gs', files, now: () => clock,
    syncGet: (url, size) => { const [p, s, e] = range(url); requests.push(['sync', p, s, e]); assert.equal(size, e - s); return content.get(p).slice(s, e); },
    get: async (url) => { const [p, s, e] = range(url); requests.push(['async', p, s, e]); return content.get(p).slice(s, e); },
    store: { read: async (k) => local.get(k), write: async (k, v) => { writes.push(k); local.set(k, v); }, keys: async () => [...local.keys()], remove: async (ks) => { removed.push(...ks); } },
  });
  const FS = fakeFS(); sf.mount(FS, '/rodir');
  const node = (p) => FS.nodes.get(`/rodir/${p.split('/').slice(0, -1).join('/')}`.replace(/\/$/, '') + '/' + p.split('/').at(-1)) ?? FS.nodes.get(`/rodir/${p}`);
  const read = (p, position, length) => { const buf = new Uint8Array(length); const n = node(p).stream_ops.read({ node: node(p) }, buf, 0, length, position); return buf.subarray(0, n); };
  return { sf, FS, node, read, requests, writes, removed, local, tick: (ms) => { clock += ms; } };
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
