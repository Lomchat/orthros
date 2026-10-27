// src/host/engine-content.js: every engine file of a browser port addressed by its content (docs/browser-ports.md
// "Engine files by content") — the map (the bytes hashed, a release's word checked), the trees of module graphs, the
// route (a request waiting for the hashing of a server just started).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { declaredShas, engineContent, treeSha } from '../src/host/engine-content.js';
import { createServer } from '../src/host/server.js';
import { withEngineUrls, withSharedEngine } from '../src/host/openmw.js';
import { withLeanPackage } from '../src/host/openmw-lean.js';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const until = async (fn, ms = 5000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };
const put = (root, files) => { for (const [f, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), b); } };
/** A release.json written after its files. */
const releaseJson = (dir, json) => { const f = path.join(dir, 'release.json'); fs.writeFileSync(f, JSON.stringify(json)); const t = new Date(Date.now() + 2000); fs.utimesSync(f, t, t); };

test('declaredShas: the three shapes of release.json', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
  assert.deepEqual([...declaredShas({ files: [{ path: 'engine/x.wasm', sha256: a, bytes: 3 }, { path: 'y', sha256: 'nope' }, 'z'] })], [['engine/x.wasm', { sha: a, bytes: 3 }]]);
  assert.deepEqual([...declaredShas({ files: { 'engine/revc.mjs': b, bad: 1 } })], [['engine/revc.mjs', { sha: b, bytes: null }]]);
  assert.deepEqual([...declaredShas({ files: ['e/1/openmw.js', 'e/1/openmw.wasm', 'x/openmw.data', 'y/openmw.data'], engineFiles: { 'openmw.js': c, 'openmw.data': a, 'openmw.wasm': 'short' } })],
    [['e/1/openmw.js', { sha: c, bytes: null }]], 'an ambiguous name, or a malformed sha256: nothing said');
  assert.deepEqual([...declaredShas(null)], []);
});

test('the map: every file hashed once, a release\'s word only checked; a tree of scripts; the lookup checks the bytes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-content-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r1 = path.join(root, 'r1'), r2 = path.join(root, 'r2');
  const files = { 'engine/index.js': 'export * from "./a.js";', 'engine/a.js': 'export const a = 1;', 'engine/sub/b.js': 'b', 'engine/x.wasm': 'wasm-1', 'game/c.wasm': 'client-1' };
  put(r1, files); put(r2, { ...files, 'game/c.wasm': 'client-2' });
  releaseJson(r1, { files: Object.keys(files).map((p) => ({ path: p, sha256: sha256(files[p]), bytes: files[p].length })) });
  // (r2 is a copy of r1, then its game/c.wasm replaced by a file with an OLDER mtime than its release.json — cp -p,
  // rsync -a, a restore —: its release.json says r1's sha256, the file holds other bytes; never addressed by the word)
  releaseJson(r2, { files: Object.keys(files).map((p) => ({ path: p, sha256: sha256(files[p]) })) });
  const t2 = new Date(Date.now() - 50000); fs.utimesSync(path.join(r2, 'game/c.wasm'), t2, t2);
  const logs = [], c = engineContent({ enginesDir: root, log: (m) => logs.push(m) });
  assert.equal(c.sha('r1', 'engine/x.wasm'), null, 'hashed first, even when its release says it');
  assert.equal(c.url('r1', 'engine/x.wasm'), null, 'the release URL meanwhile');
  assert.equal(c.pending('r1', 'engine/x.wasm'), true);
  assert.equal(await c.hashed('r1', 'engine/x.wasm'), sha256('wasm-1'));
  assert.equal(c.url('r1', 'engine/x.wasm'), `/engines/_c/${sha256('wasm-1')}/x.wasm`);
  assert.equal(await until(() => c.url('r2', 'engine/x.wasm')), c.url('r1', 'engine/x.wasm'), 'the same bytes in another release: the same address');
  assert.equal(c.sha('r2', 'game/c.wasm'), null);
  assert.equal(await c.hashed('r2', 'game/c.wasm'), sha256('client-2'), 'addressed by its bytes, not by its release\'s word');
  c.sha('r1', 'game/c.wasm'); assert.equal(await c.hashed('r1', 'game/c.wasm'), sha256('client-1'));
  assert.equal(c.lookup(sha256('client-1'), 'c.wasm'), fs.realpathSync(path.join(r1, 'game/c.wasm')), 'r1\'s address: r1\'s bytes only');
  assert.match(logs.join('\n'), new RegExp(`r2/game/c.wasm: sha256 ${sha256('client-2')}, not the ${sha256('client-1')}`), 'the mismatch logged');
  assert.equal(await c.hashed('nope', 'x'), null); assert.equal(c.pending('nope', 'x'), false);
  assert.equal(c.hashing(), 0);
  // (served once hashed, before anyone asks its sha256 again: an address given before a restart — served() waits)
  const c3 = engineContent({ enginesDir: root });
  assert.equal(c3.sha('r2', 'game/c.wasm'), null); assert.equal(c3.lookup(sha256('client-2'), 'c.wasm'), null);
  assert.equal(await c3.served(sha256('client-2'), 'c.wasm'), fs.realpathSync(path.join(r2, 'game/c.wasm')), 'the request waits for the hashing');
  assert.equal(await c3.served('f'.repeat(64), 'c.wasm'), null, 'nothing hashed: no wait');
  // (a tree after a restart: known once its members are hashed and the releases asked again — reindex)
  const c4 = engineContent({ enginesDir: root }), list = () => c4.pageUrls('r1', ['engine/index.js'], 'engine/')['engine/index.js'];
  assert.equal(list(), undefined);
  const treeAt = await until(list);
  const c5 = engineContent({ enginesDir: root }); let asked = 0;
  assert.equal(await c5.served(treeAt.split('/')[3], 'index.js', { reindex: () => { asked++; c5.pageUrls('r1', ['engine/index.js'], 'engine/'); } }), fs.realpathSync(path.join(r1, 'engine/index.js')));
  assert.ok(asked >= 2, 'asked again once hashed');
  assert.equal(c.sha('r1', '../r2/game/c.wasm'), null); assert.equal(c.sha('nope', 'engine/x.wasm'), null); assert.equal(c.sha('r1', 'missing'), null);
  // (the scripts under engine/ one tree — those not listed in it too —, the others each by its own content)
  const urls = (r) => until(() => { const u = c.pageUrls(r, ['engine/index.js', 'engine/x.wasm', 'game/c.wasm'], 'engine/'); return Object.keys(u).length === 3 && u; });
  const u1 = await urls('r1'), u2 = await urls('r2');
  const tree = treeSha([['index.js', sha256(files['engine/index.js'])], ['a.js', sha256(files['engine/a.js'])], ['sub/b.js', sha256('b')]]);
  assert.deepEqual(u1, { 'engine/x.wasm': `/engines/_c/${sha256('wasm-1')}/x.wasm`, 'game/c.wasm': `/engines/_c/${sha256('client-1')}/c.wasm`, 'engine/index.js': `/engines/_c/${tree}/index.js` });
  assert.equal(u2['engine/index.js'], u1['engine/index.js'], 'unchanged scripts: the same tree'); assert.equal(u2['engine/x.wasm'], u1['engine/x.wasm']);
  assert.notEqual(u2['game/c.wasm'], u1['game/c.wasm']);
  assert.equal(c.lookup(tree, 'index.js'), fs.realpathSync(path.join(r1, 'engine/index.js')));
  assert.equal(path.basename(c.lookup(tree, 'sub/b.js')), 'b.js', 'a script the graph imports, listed or not');
  assert.equal(c.lookup(tree, 'x.wasm'), null, 'not a member'); assert.equal(c.lookup(tree, '../x.wasm'), null);
  assert.equal(c.lookup(sha256('wasm-1'), 'x.wasm') !== null, true);
  assert.equal(c.lookup(sha256('wasm-1'), 'other.wasm'), null, 'under its own name only'); assert.equal(c.lookup(sha256('wasm-1'), 'engine/x.wasm'), null);
  assert.equal(c.lookup('f'.repeat(64), 'x.wasm'), null); assert.equal(c.lookup('..', 'x.wasm'), null);
  // (a tree with a member not hashed yet: its scripts under the release meanwhile)
  put(r1, { 'engine/late.js': 'late' }); const late = new Date(Date.now() + 9000); fs.utimesSync(path.join(r1, 'engine/late.js'), late, late);
  const c2 = engineContent({ enginesDir: root });
  assert.equal(c2.pageUrls('r1', ['engine/index.js'], 'engine/')['engine/index.js'], undefined);
  await until(() => c2.pageUrls('r1', ['engine/index.js'], 'engine/')['engine/index.js']);
  // (a file changed under an indexed address: out of the index, not served)
  const x = path.join(r1, 'engine/x.wasm'); fs.writeFileSync(x, 'wasm-X'); fs.utimesSync(x, late, late);
  const now = c.lookup(sha256('wasm-1'), 'x.wasm');
  assert.notEqual(now, fs.realpathSync(x), 'r1\'s changed file not served under the old sha256');
  assert.equal(now, fs.realpathSync(path.join(r2, 'engine/x.wasm')), 'the other release\'s identical bytes still are');
});

test('the route /engines/_c/<sha>/<name>: the indexed files, immutable, brotli when shipped; 404s; the pages\' URLs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-content-srv-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engines = path.join(root, 'engines'), games = path.join(root, 'games');
  const gs = { 'engine/index.js': 'export const X = 1;', 'engine/net/index.js': 'n', 'engine/xash.wasm': 'xash', 'engine/filesystem_stdio.wasm': 'fs', 'engine/libmenu.wasm': 'menu',
    'engine/libref_webgl2.wasm': 'ref', 'cl/c.wasm': 'client', 'dl/s.wasm': 'server', 'engine/valve/extras.pk3': 'pk3', 'engine/valve/fr.pk3': 'fr' };
  put(path.join(engines, 'gs-1'), gs); put(path.join(engines, 'gs-2'), { ...gs, 'cl/c.wasm': 'client-2' });
  fs.writeFileSync(path.join(engines, 'gs-1', 'engine/xash.wasm.br'), zlib.brotliCompressSync(Buffer.from('xash')));
  put(path.join(engines, 're-1'), { 'engine/revc.mjs': 'export default 1;', 'engine/revc.wasm': 'revc', 'gamefiles/a.txt': 'a' });
  releaseJson(path.join(engines, 're-1'), { id: 're-1', files: { 'engine/revc.mjs': sha256('export default 1;'), 'engine/revc.wasm': sha256('revc') } });
  const mk = (id, runtime, v) => { const g = path.join(games, id); fs.mkdirSync(path.join(g, 'base'), { recursive: true }); fs.mkdirSync(path.join(g, 'versions/1'), { recursive: true }); fs.writeFileSync(path.join(g, 'base/x.txt'), 'x');
    fs.writeFileSync(path.join(g, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id, name: id, defaultVersion: `${id}-1`, defaults: { runtime }, versions: [{ id: `${id}-1`, dir: '1', version: '1', languages: ['en', 'fr'], ...v }] })); };
  const goldsrc = (engine) => ({ goldsrc: { engine, gameDir: 'valve', modules: { client: 'cl/c.wasm', server: 'dl/s.wasm' }, solo: { map: 'start' }, languages: { fr: { extras: ['engine/valve/fr.pk3'] } } } });
  mk('hl', 'goldsrc', goldsrc('gs-1')); mk('hl2', 'goldsrc', goldsrc('gs-2')); mk('vc', 're3', { re3: { engine: 're-1' } });
  for (const r of ['gs-1', 'gs-2']) fs.writeFileSync(path.join(engines, r, 'release.json'), '{}');
  const server = createServer({ gamesDir: games, enginesDir: engines, lanLog: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`, get = (u, h = {}) => fetch(base + u, { headers: h });
  const urlsOf = async (name) => (await (await get(`/api/manifest/${name}`)).json()).engineUrls;
  // (gs releases say no sha256: hashed from the server's start, their release URLs meanwhile)
  const hl = await until(async () => { const u = await urlsOf('hl-1'); return Object.keys(u).length === 10 && u; });
  const hl2 = await until(async () => { const u = await urlsOf('hl2-1'); return Object.keys(u).length === 10 && u; });
  for (const [rel, u] of Object.entries(hl)) {
    if (rel === 'cl/c.wasm') assert.notEqual(hl2[rel], u); else assert.equal(hl2[rel], u, `${rel}: the same bytes, the same address across releases`);
  }
  assert.equal(hl['engine/valve/fr.pk3'], `/engines/_c/${sha256('fr')}/fr.pk3`, 'a language\'s archives too');
  assert.match(hl['engine/index.js'], /^\/engines\/_c\/[0-9a-f]{64}\/index\.js$/);
  // (the module graph's relative imports resolve in its tree)
  const treeBase = hl['engine/index.js'].slice(0, -'index.js'.length);
  assert.equal(hl['engine/net/index.js'], treeBase + 'net/index.js');
  assert.equal(await (await get(treeBase + 'net/index.js')).text(), 'n');
  const r = await get(hl['engine/index.js']);
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable'); assert.match(r.headers.get('content-type'), /javascript/);
  const w = await get(hl['engine/xash.wasm'], { 'Accept-Encoding': 'br' });
  assert.equal(w.headers.get('content-encoding'), 'br'); assert.equal(await w.text(), 'xash', 'the release\'s brotli sibling');
  // (the home's "Prepare" given the same addresses)
  await fetch(`${base}/api/prefetch/hl-1`, { method: 'POST', body: JSON.stringify({ session: 's', reads: [['x.txt', 0, 1, 5]], mark: { kind: 'playable' } }) });
  const launch = await until(async () => (await (await get('/api/manifests')).json()).find((m) => m.name === 'hl-1').launch);
  assert.deepEqual(launch.engineFiles, ['engine/index.js', 'engine/net/index.js', 'engine/xash.wasm', 'engine/filesystem_stdio.wasm', 'engine/libmenu.wasm', 'cl/c.wasm', 'dl/s.wasm', 'engine/libref_webgl2.wasm', 'engine/valve/extras.pk3'].map((f) => hl[f]));
  // (re3: the release's word, the module and its WebAssembly)
  const vc = await until(async () => { const u = await urlsOf('vc-1'); return Object.keys(u).length === 2 && u; });
  assert.deepEqual(vc, { 'engine/revc.mjs': `/engines/_c/${sha256('export default 1;')}/revc.mjs`, 'engine/revc.wasm': `/engines/_c/${sha256('revc')}/revc.wasm` });
  assert.equal(await (await get(vc['engine/revc.wasm'])).text(), 'revc');
  // (404s: another content, another name, a path through a file, traversal, a release URL still answered)
  for (const u of [`/engines/_c/${'f'.repeat(64)}/c.wasm`, `/engines/_c/${sha256('client')}/s.wasm`, `/engines/_c/${sha256('client')}/x/c.wasm`, `/engines/_c/${sha256('client')}/..%2F..%2Fdl%2Fs.wasm`,
    `${treeBase}..%2Fxash.wasm`, `${treeBase}xash.wasm`, '/engines/_c/x/c.wasm', `/engines/_c/${sha256('a')}/a.txt`]) assert.ok([400, 404].includes((await get(u)).status), u); // (400: a path the server refuses before routes)
  assert.equal(await (await get('/engines/gs-1/cl/c.wasm')).text(), 'client', 'the release URLs of the pages already open');
  // (a server just restarted: the addresses the previous process gave — a file, a tree's member — answered once hashed again)
  const again = createServer({ gamesDir: games, enginesDir: engines, lanLog: () => {} });
  await new Promise((r) => again.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { again.closeAllConnections(); again.close(r); }));
  const base2 = `http://127.0.0.1:${again.address().port}`;
  for (const [u, body] of [[hl['cl/c.wasm'], 'client'], [treeBase + 'net/index.js', 'n'], [vc['engine/revc.mjs'], 'export default 1;']]) {
    const x = await fetch(base2 + u); assert.equal(x.status, 200, u); assert.equal(await x.text(), body, u);
  }
});

test('the OpenMW page: openmw.js, its WebAssembly and package by content, the lean package kept', () => {
  const html = ' var __ENGINE_VER = "abc123";\n var __ENGINE_DIR = (__ENGINE_VER.charAt(0) === "_") ? "" : ("e/" + __ENGINE_VER + "/");\n var Module = {\n   locateFile: function(path){ return __ENGINE_DIR + path; },\n };\n'
    + '(function(){ var s = {}; s.src = __ENGINE_DIR + \'openmw.js\'; return s; })';
  const urls = { 'openmw.js': '/engines/_c/1/openmw.js', 'openmw.wasm': '/engines/_c/2/openmw.wasm', 'openmw.data': '/engines/_c/3/openmw.data' };
  const run = (page, search = '') => new Function('window', 'location', `${page}; return { Module, src: (${page.slice(page.lastIndexOf('(function(){'))})().src };`)({}, { search });
  const plain = run(withEngineUrls(withSharedEngine(html, 'rel'), urls));
  assert.equal(plain.src, urls['openmw.js']); assert.equal(plain.Module.locateFile('openmw.wasm'), urls['openmw.wasm']); assert.equal(plain.Module.locateFile('openmw.data'), urls['openmw.data']);
  assert.equal(plain.Module.locateFile('other.bin'), '/engines/rel/e/abc123/other.bin', 'a file without one: the release\'s build directory');
  const lean = withEngineUrls(withLeanPackage(withSharedEngine(html, 'rel'), '/engines/_c/9/lean2/'), urls);
  assert.equal(run(lean).Module.locateFile('openmw.data'), '/engines/_c/9/lean2/openmw.data', 'the lean package first');
  assert.equal(run(lean, '?nomw').Module.locateFile('openmw.data'), urls['openmw.data'], 'the example world: the release\'s package by content');
  assert.equal(run(lean).Module.locateFile('openmw.wasm'), urls['openmw.wasm']);
  assert.equal(withEngineUrls(html, {}), html); assert.equal(withEngineUrls(html, null), html);
});
