// The OpenMW engine package without the example world (src/host/openmw-lean.js, docs/openmw.md "The engine's package"):
// the same package, the example world's bytes zeroed, made once by a niced child, loaded by a game of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { leanPackages, leanRanges, packageFiles, withLeanPackage, LEAN_RULE } from '../src/host/openmw-lean.js';
import { createServer } from '../src/host/server.js';

const LOCATE = 'locateFile: function(path){ return __ENGINE_DIR + path; }';

/** An engine release with a package: /resources/a (3 bytes), /gamedata/b (5), /gamedata/c/d (4), /icu (2). */
function release(root) {
  const dir = path.join(root, 'engines', 'eng'), build = path.join(dir, 'e', 'abc123');
  fs.mkdirSync(build, { recursive: true });
  const files = [['/resources/a', 'RES'], ['/gamedata/b', 'BBBBB'], ['/gamedata/c/d', 'DDDD'], ['/icu.dat', 'IC']];
  let at = 0; const meta = [];
  for (const [name, body] of files) { meta.push(`{filename:"${name}",start:${at},end:${at + body.length}}`); at += body.length; }
  fs.writeFileSync(path.join(build, 'openmw.data'), files.map((f) => f[1]).join(''));
  fs.writeFileSync(path.join(build, 'openmw.js'), `loadPackage({files:[${meta.join(',')}],remote_package_size:${at}})`);
  fs.writeFileSync(path.join(build, 'openmw.wasm'), 'wasm');
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ runtime: 'openmw', files: ['e/abc123/openmw.data', 'e/abc123/openmw.js', 'e/abc123/openmw.wasm'] }));
  fs.writeFileSync(path.join(dir, 'index.html'), `<script>var Module = { ${LOCATE} };</script>`);
  fs.writeFileSync(path.join(dir, 'launcher.html'), '');
  return { dir, build };
}
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };

test('the lean package: the example world\'s ranges zeroed, made once, loaded unless the page boots the example', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-lean-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { build } = release(root), js = fs.readFileSync(path.join(build, 'openmw.js'), 'utf8');
  assert.deepEqual(packageFiles(js).map((f) => f.name), ['/resources/a', '/gamedata/b', '/gamedata/c/d', '/icu.dat']);
  assert.deepEqual(leanRanges(js), [[3, 8], [8, 12]]);
  const logs = [], lean = leanPackages({ dir: path.join(root, 'cache'), enginesDir: path.join(root, 'engines'), log: (m) => logs.push(m) });
  assert.equal(lean.url('eng'), null, 'not made yet: the release\'s own package meanwhile');
  assert.equal(lean.pending('eng'), true, 'being made');
  const url = await until(() => lean.url('eng'));
  assert.equal(lean.pending('eng'), false);
  assert.equal(lean.decoded('eng'), 14, 'the decoded bytes: the release\'s package\'s');
  assert.equal(url, `/engines/eng/lean${LEAN_RULE}/abc123/`);
  const file = lean.file('eng', `lean${LEAN_RULE}/abc123/openmw.data`);
  assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(file)).toString('latin1'), 'RES' + '\0'.repeat(9) + 'IC', 'same size and offsets, the example world zeroed');
  assert.equal(lean.size('eng'), fs.statSync(file).size);
  assert.equal(lean.file('eng', `lean${LEAN_RULE}/ffff/openmw.data`), null, 'another build: none');
  assert.equal(lean.url('other'), null);
  // (the page: the lean package for openmw.data unless ?nomw; the rest from the release)
  const page = withLeanPackage(`var Module = { ${LOCATE} };`, url);
  const locate = (search) => new Function('window', 'location', '__ENGINE_DIR', `${page.replace('var Module =', 'return')}`)({}, { search }, '/engines/eng/e/abc123/').locateFile;
  assert.equal(locate('?src=hosted')('openmw.data'), `${url}openmw.data`);
  assert.equal(locate('?src=hosted')('openmw.wasm'), '/engines/eng/e/abc123/openmw.wasm');
  assert.equal(locate('?nomw')('openmw.data'), '/engines/eng/e/abc123/openmw.data', 'the example world: the whole package');
  assert.equal(withLeanPackage('x', null), 'x');
});

test('the server makes and serves the lean package of a game of its own, not of the example world', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-lean-srv-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { build } = release(root);
  fs.writeFileSync(path.join(build, 'openmw.wasm.br'), zlib.brotliCompressSync(Buffer.from('wasm')));
  const games = path.join(root, 'games');
  const mk = (id, openmw) => { const g = path.join(games, id); fs.mkdirSync(path.join(g, 'base'), { recursive: true }); fs.mkdirSync(path.join(g, 'versions/1'), { recursive: true });
    fs.writeFileSync(path.join(g, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id, name: id, defaultVersion: `${id}-1`, defaults: { runtime: 'openmw' }, versions: [{ id: `${id}-1`, dir: '1', version: '1', openmw: { engine: 'eng', ...openmw } }] })); return g; };
  const game = mk('game', { files: ['Game.esm'] });
  mk('demo', { example: true, files: [] });
  const server = createServer({ gamesDir: games, enginesDir: path.join(root, 'engines'), brCacheDir: path.join(root, 'brcache'), brCacheLog: () => {} });
  fs.writeFileSync(path.join(game, 'base/Game.esm'), 'esm'); // (installed once the server runs: its lean package not started yet)
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`, page = (id) => fetch(`${base}/ports/openmw/${id}-1/app/index.html`).then((r) => r.text());
  // (a card's engine files: not the release's own package while the lean one is being made — "Prepare" would cache
  // what the page stops asking for —, the lean one once made)
  await fetch(`${base}/api/prefetch/game-1`, { method: 'POST', body: JSON.stringify({ session: 's', reads: [['Game.esm', 0, 3, 5]], mark: { kind: 'playable' } }) });
  const engineFiles = async () => (await (await fetch(`${base}/api/manifests`)).json()).find((m) => m.name === 'game-1').launch.engineFiles;
  assert.deepEqual(await engineFiles(), ['/engines/eng/e/abc123/openmw.js', '/engines/eng/e/abc123/openmw.wasm'], 'its making just started');
  const leanFile = path.join(root, 'brcache', 'engines', 'eng', `lean${LEAN_RULE}`, 'abc123', 'openmw.data.br');
  await until(() => fs.existsSync(leanFile));
  // (a server started with the game installed: made from its start, before any card or page asked for it)
  const other = createServer({ gamesDir: games, enginesDir: path.join(root, 'engines'), brCacheDir: path.join(root, 'brcache2'), brCacheLog: () => {} });
  t.after(() => other.close());
  await until(() => fs.existsSync(path.join(root, 'brcache2', 'engines', 'eng', `lean${LEAN_RULE}`, 'abc123', 'openmw.data.br')));
  let html = '';
  for (let i = 0; i < 400 && !html.includes('lean'); i++) { html = await page('game'); if (!html.includes('lean')) await new Promise((r) => setTimeout(r, 50)); }
  assert.match(html, new RegExp(`/engines/eng/lean${LEAN_RULE}/abc123/`));
  assert.deepEqual(await engineFiles(), [`/engines/eng/lean${LEAN_RULE}/abc123/openmw.data`, '/engines/eng/e/abc123/openmw.js', '/engines/eng/e/abc123/openmw.wasm']);
  assert.ok(!(await page('demo')).includes('lean'), 'the example world loads the whole package');
  const r = await fetch(`${base}/engines/eng/lean${LEAN_RULE}/abc123/openmw.data`, { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-encoding'), 'br');
  // (no Content-Length — Emscripten counts the decoded bytes against it —; the sizes said for "Prepare"'s count)
  assert.equal(r.headers.get('content-length'), null);
  assert.equal(r.headers.get('x-orthros-wire-length'), String(fs.statSync(leanFile).size)); assert.equal(r.headers.get('x-orthros-decoded-length'), '14');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString('latin1'), 'RES' + '\0'.repeat(9) + 'IC', 'decoded by the client');
  assert.equal((await fetch(`${base}/engines/eng/lean${LEAN_RULE}/abc123/openmw.data`, { headers: { 'Accept-Encoding': 'identity' } }).then((x) => x.arrayBuffer())).byteLength, 14, 'without brotli: decoded by the server');
  assert.equal((await fetch(`${base}/engines/eng/lean${LEAN_RULE}/ffff/openmw.data`)).status, 404);
  // (an engine file's brotli sibling, and the port's own .br path: the same answer)
  for (const u of ['/engines/eng/e/abc123/openmw.wasm', '/ports/openmw/game-1/app/e/abc123/openmw.wasm.br']) {
    const w = await fetch(base + u, { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(w.headers.get('content-encoding'), 'br', u); assert.equal(w.headers.get('content-length'), null, u);
    assert.equal(w.headers.get('x-orthros-wire-length'), String(fs.statSync(path.join(build, 'openmw.wasm.br')).size), u);
    assert.equal(w.headers.get('x-orthros-decoded-length'), '4', u); assert.equal(await w.text(), 'wasm', u);
  }
});
