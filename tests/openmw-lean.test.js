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
  const url = await until(() => lean.url('eng'));
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
  release(root);
  const games = path.join(root, 'games');
  const mk = (id, openmw) => { const g = path.join(games, id); fs.mkdirSync(path.join(g, 'base'), { recursive: true }); fs.mkdirSync(path.join(g, 'versions/1'), { recursive: true });
    fs.writeFileSync(path.join(g, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id, name: id, defaultVersion: `${id}-1`, defaults: { runtime: 'openmw' }, versions: [{ id: `${id}-1`, dir: '1', version: '1', openmw: { engine: 'eng', ...openmw } }] })); return g; };
  fs.writeFileSync(path.join(mk('game', { files: ['Game.esm'] }), 'base/Game.esm'), 'esm');
  mk('demo', { example: true, files: [] });
  const server = createServer({ gamesDir: games, enginesDir: path.join(root, 'engines'), brCacheDir: path.join(root, 'brcache'), brCacheLog: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`, page = (id) => fetch(`${base}/ports/openmw/${id}-1/app/index.html`).then((r) => r.text());
  assert.ok(!(await page('game')).includes('lean'), 'its first page: the release\'s package (the lean one being made)');
  let html = '';
  for (let i = 0; i < 400 && !html.includes('lean'); i++) { await new Promise((r) => setTimeout(r, 50)); html = await page('game'); }
  assert.match(html, new RegExp(`/engines/eng/lean${LEAN_RULE}/abc123/`));
  assert.ok(!(await page('demo')).includes('lean'), 'the example world loads the whole package');
  const r = await fetch(`${base}/engines/eng/lean${LEAN_RULE}/abc123/openmw.data`, { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-encoding'), 'br');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString('latin1'), 'RES' + '\0'.repeat(9) + 'IC', 'decoded by the client');
  assert.equal((await fetch(`${base}/engines/eng/lean${LEAN_RULE}/abc123/openmw.data`, { headers: { 'Accept-Encoding': 'identity' } }).then((x) => x.arrayBuffer())).byteLength, 14, 'without brotli: decoded by the server');
  assert.equal((await fetch(`${base}/engines/eng/lean${LEAN_RULE}/ffff/openmw.data`)).status, 404);
});
