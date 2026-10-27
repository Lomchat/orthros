// The OpenMW engine package without what a game of its own never reads (src/host/openmw-lean.js, docs/openmw.md "The
// engine's package"): the same package, the example world's and ICU's unused root copy's bytes zeroed, made once per
// content by a niced child, loaded by a game of its own, at an address every release with that package shares.
import { test } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { leanPackages, leanRanges, packageFiles, withLeanPackage, LEAN_RULE } from '../src/host/openmw-lean.js';
import { createServer } from '../src/host/server.js';

const LOCATE = 'locateFile: function(path){ return __ENGINE_DIR + path; }';

/**
 * An engine release with a package: /resources/a (3 bytes), /gamedata/b (5), /gamedata/c/d (4), ICU's two copies
 * (/icu/icudt68l.dat, the opened one, 2; /icudt68l.dat, 2). `o.id`: the release (eng), `o.build` its build (abc123),
 * `o.sha`: release.json says its package's sha256 (true by default; false: not said), `o.wasm` its wasm's bytes.
 */
function release(root, o = {}) {
  const id = o.id ?? 'eng', b = o.build ?? 'abc123', dir = path.join(root, 'engines', id), build = path.join(dir, 'e', b);
  fs.mkdirSync(build, { recursive: true });
  const files = [['/resources/a', 'RES'], ['/gamedata/b', 'BBBBB'], ['/gamedata/c/d', 'DDDD'], ['/icu/icudt68l.dat', 'IC'], ['/icudt68l.dat', 'IC']];
  let at = 0; const meta = [];
  for (const [name, body] of files) { meta.push(`{filename:"${name}",start:${at},end:${at + body.length}}`); at += body.length; }
  const data = files.map((f) => f[1]).join(''), sha = crypto.createHash('sha256').update(data).digest('hex');
  fs.writeFileSync(path.join(build, 'openmw.data'), data);
  fs.writeFileSync(path.join(build, 'openmw.js'), `loadPackage({files:[${meta.join(',')}],remote_package_size:${at}})`);
  fs.writeFileSync(path.join(build, 'openmw.wasm'), o.wasm ?? 'wasm');
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ runtime: 'openmw', files: [`e/${b}/openmw.data`, `e/${b}/openmw.js`, `e/${b}/openmw.wasm`],
    ...(o.sha === false ? {} : { engineFiles: { 'openmw.js': '0'.repeat(64), 'openmw.wasm': '1'.repeat(64), 'openmw.data': sha } }) }));
  fs.writeFileSync(path.join(dir, 'index.html'), `<script>var Module = { ${LOCATE} };</script>`);
  fs.writeFileSync(path.join(dir, 'launcher.html'), '');
  return { dir, build, sha };
}
/** The lean package of release(): the resources and the opened ICU copy, the rest zeroed. */
const LEAN = 'RES' + '\0'.repeat(9) + 'IC' + '\0\0';
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };

test('the lean package\'s ranges: the example world, and ICU\'s root copy only beside the copy the engine opens', () => {
  const js = (names) => `loadPackage({files:[${names.map((n, i) => `{filename:"${n}",start:${i * 10},end:${i * 10 + 10}}`).join(',')}]})`;
  assert.deepEqual(packageFiles(js(['/resources/a', '/gamedata/b'])).map((f) => f.name), ['/resources/a', '/gamedata/b']);
  assert.deepEqual(leanRanges(js(['/resources/a', '/gamedata/b', '/icu/icudt68l.dat', '/icudt68l.dat'])), [[10, 20], [30, 40]]);
  assert.deepEqual(leanRanges(js(['/icudt68l.dat', '/resources/a', '/icu/icudt68l.dat'])), [[0, 10]], 'by name, wherever it is');
  assert.deepEqual(leanRanges(js(['/resources/a', '/gamedata/b', '/icu/icudt68l.dat'])), [[10, 20]], 'a release without the root copy');
  assert.deepEqual(leanRanges(js(['/resources/a', '/gamedata/b', '/icudt68l.dat'])), [[10, 20]], 'the root copy alone: kept, the engine may read it');
  assert.deepEqual(leanRanges(js(['/resources/icudt68l.dat', '/gamedata/b'])), [[10, 20]]);
});

test('the lean package: keyed by the package\'s content, made once, loaded unless the page boots the example', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-lean-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { build, sha } = release(root);
  release(root, { id: 'eng2', build: 'def456', wasm: 'wasm2' }); // (the next release: another wasm, the same package)
  const logs = [], dir = path.join(root, 'cache'), lean = leanPackages({ dir, enginesDir: path.join(root, 'engines'), log: (m) => logs.push(m) });
  assert.equal(lean.url('eng'), null, 'not made yet: the release\'s own package meanwhile');
  assert.equal(lean.pending('eng'), true, 'being made');
  assert.equal(lean.url('eng2'), null); assert.equal(lean.pending('eng2'), true, 'the same content: the same making');
  const url = await until(() => lean.url('eng'));
  assert.equal(lean.pending('eng'), false);
  assert.equal(lean.decoded('eng'), 16, 'the decoded bytes: the release\'s package\'s');
  assert.equal(url, `/engines/_c/${sha}/lean${LEAN_RULE}/`);
  assert.equal(lean.url('eng2'), url, 'every release with that package: one address');
  assert.equal(logs.filter((l) => /bytes in/.test(l)).length, 1, `made once: ${logs}`);
  const c = lean.contentFile(sha, `lean${LEAN_RULE}/openmw.data`);
  assert.equal(c.file, path.join(dir, '_c', sha, `lean${LEAN_RULE}`, 'openmw.data.br')); assert.equal(c.decoded, 16);
  assert.equal(zlib.brotliDecompressSync(fs.readFileSync(c.file)).toString('latin1'), LEAN, 'same size and offsets, the unread bytes zeroed');
  assert.equal(lean.size('eng'), fs.statSync(c.file).size); assert.equal(lean.size('eng2'), lean.size('eng'));
  assert.equal(lean.contentFile('f'.repeat(64), `lean${LEAN_RULE}/openmw.data`), null, 'another content: none');
  assert.equal(lean.contentFile(sha, 'lean9/openmw.data'), null); assert.equal(lean.contentFile('../x', `lean${LEAN_RULE}/openmw.data`), null);
  // (an earlier server's release-keyed address: its own file while kept, else this content's; another build's: none)
  assert.equal(lean.file('eng', `lean1/${path.basename(build)}/openmw.data`), c.file);
  const old = path.join(dir, 'eng', 'lean1', 'abc123', 'openmw.data.br'); fs.mkdirSync(path.dirname(old), { recursive: true }); fs.writeFileSync(old, 'old');
  assert.equal(lean.file('eng', 'lean1/abc123/openmw.data'), old);
  assert.equal(lean.file('eng', 'lean1/ffff/openmw.data'), null, 'another build: none');
  assert.equal(lean.file('eng', 'e/abc123/openmw.data'), null);
  assert.equal(lean.url('other'), null);
  // (the page: the lean package for openmw.data unless ?nomw; the rest from the release)
  const page = withLeanPackage(`var Module = { ${LOCATE} };`, url);
  const locate = (search) => new Function('window', 'location', '__ENGINE_DIR', `${page.replace('var Module =', 'return')}`)({}, { search }, '/engines/eng/e/abc123/').locateFile;
  assert.equal(locate('?src=hosted')('openmw.data'), `${url}openmw.data`);
  assert.equal(locate('?src=hosted')('openmw.wasm'), '/engines/eng/e/abc123/openmw.wasm');
  assert.equal(locate('?nomw')('openmw.data'), '/engines/eng/e/abc123/openmw.data', 'the example world: the whole package');
  assert.equal(withLeanPackage('x', null), 'x');
});

test('the lean package of a release that does not say its package\'s sha256: hashed once, then made; a wrong one makes nothing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-lean-hash-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { sha } = release(root, { sha: false });
  const lean = leanPackages({ dir: path.join(root, 'cache'), enginesDir: path.join(root, 'engines') });
  assert.equal(lean.url('eng'), null); assert.equal(lean.pending('eng'), true, 'hashed, then made');
  assert.equal(await until(() => lean.url('eng')), `/engines/_c/${sha}/lean${LEAN_RULE}/`);
  // (a release.json whose sha256 is not its package's: the child checks what it reads, writes nothing)
  const { dir } = release(root, { id: 'bad', build: 'bad000' });
  const rj = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8')); rj.engineFiles['openmw.data'] = 'e'.repeat(64);
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(rj));
  const logs = [], bad = leanPackages({ dir: path.join(root, 'cache2'), enginesDir: path.join(root, 'engines'), log: (m) => logs.push(m) });
  assert.equal(bad.url('bad'), null);
  await until(() => !bad.pending('bad'));
  assert.equal(bad.url('bad'), null); assert.match(logs.join('\n'), /failed/);
});

test('while the current rule\'s lean package is made, or after its making failed: the newest one already on disk', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-lean-old-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { sha } = release(root);
  const put = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  // (an earlier server's release-keyed lean1: given at once, while this content's lean package is made; then this one)
  const dir = path.join(root, 'cache'), old = put(path.join(dir, 'eng', 'lean1', 'abc123', 'openmw.data.br'), 'old-lean1');
  const lean = leanPackages({ dir, enginesDir: path.join(root, 'engines') });
  assert.equal(lean.url('eng'), '/engines/eng/lean1/abc123/', 'the earlier server\'s file meanwhile');
  assert.equal(lean.pending('eng'), false, 'a package to prepare: the one the page asks for');
  assert.equal(lean.size('eng'), fs.statSync(old).size);
  assert.equal(lean.file('eng', 'lean1/abc123/openmw.data'), old, 'served at that address');
  assert.equal(await until(() => (lean.url('eng') ?? '').includes('/_c/') && lean.url('eng')), `/engines/_c/${sha}/lean${LEAN_RULE}/`, 'then this content\'s');
  // (an earlier rule's file of this content: preferred to the release-keyed one)
  if (LEAN_RULE > 1) {
    const dir2 = path.join(root, 'cache2'); put(path.join(dir2, 'eng', 'lean1', 'abc123', 'openmw.data.br'), 'old');
    const prev = put(path.join(dir2, '_c', sha, `lean${LEAN_RULE - 1}`, 'openmw.data.br'), 'prev-rule');
    const l2 = leanPackages({ dir: dir2, enginesDir: path.join(root, 'engines') });
    assert.equal(l2.url('eng'), `/engines/_c/${sha}/lean${LEAN_RULE - 1}/`); assert.equal(l2.size('eng'), fs.statSync(prev).size);
    assert.equal(l2.contentFile(sha, `lean${LEAN_RULE - 1}/openmw.data`).file, prev);
    await until(() => l2.url('eng') === `/engines/_c/${sha}/lean${LEAN_RULE}/`);
  }
  // (a making that fails — release.json's sha256 is not its package's —: the old file for the rest of the run)
  const { dir: bad } = release(root, { id: 'bad', build: 'bad000' });
  const rj = JSON.parse(fs.readFileSync(path.join(bad, 'release.json'), 'utf8')); rj.engineFiles['openmw.data'] = 'e'.repeat(64);
  fs.writeFileSync(path.join(bad, 'release.json'), JSON.stringify(rj));
  const dir3 = path.join(root, 'cache3'), logs = [], l3 = leanPackages({ dir: dir3, enginesDir: path.join(root, 'engines'), log: (m) => logs.push(m) });
  assert.equal(l3.url('bad'), null); assert.equal(l3.pending('bad'), true);
  await until(() => /failed/.test(logs.join('\n')));
  assert.equal(l3.url('bad'), null, 'failed, nothing older: the release\'s own package'); assert.equal(l3.pending('bad'), false);
  const kept = put(path.join(dir3, 'bad', 'lean1', 'bad000', 'openmw.data.br'), 'kept');
  assert.equal(l3.url('bad'), '/engines/bad/lean1/bad000/'); assert.equal(l3.size('bad'), fs.statSync(kept).size); assert.equal(l3.pending('bad'), false);
  // (a release that does not say its sha256, being hashed: the release-keyed file needs only the build)
  release(root, { id: 'unsaid', build: 'aaa111', sha: false }); // (the same package: the same content once hashed)
  const dir4 = path.join(root, 'cache4'); put(path.join(dir4, 'unsaid', 'lean1', 'aaa111', 'openmw.data.br'), 'x');
  const l4 = leanPackages({ dir: dir4, enginesDir: path.join(root, 'engines') });
  assert.equal(l4.url('unsaid'), '/engines/unsaid/lean1/aaa111/'); assert.equal(l4.pending('unsaid'), false);
  await until(() => l4.url('unsaid') === `/engines/_c/${sha}/lean${LEAN_RULE}/`);
});

test('the server makes and serves the lean package of a game of its own, not of the example world', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-lean-srv-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { build, sha } = release(root);
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
  const leanFile = path.join(root, 'brcache', 'engines', '_c', sha, `lean${LEAN_RULE}`, 'openmw.data.br'), leanUrl = `/engines/_c/${sha}/lean${LEAN_RULE}/openmw.data`;
  await until(() => fs.existsSync(leanFile));
  // (a server started with the game installed: made from its start, before any card or page asked for it)
  const other = createServer({ gamesDir: games, enginesDir: path.join(root, 'engines'), brCacheDir: path.join(root, 'brcache2'), brCacheLog: () => {} });
  t.after(() => other.close());
  await until(() => fs.existsSync(path.join(root, 'brcache2', 'engines', '_c', sha, `lean${LEAN_RULE}`, 'openmw.data.br')));
  let html = '';
  for (let i = 0; i < 400 && !html.includes('lean'); i++) { html = await page('game'); if (!html.includes('lean')) await new Promise((r) => setTimeout(r, 50)); }
  assert.match(html, new RegExp(`/engines/_c/${sha}/lean${LEAN_RULE}/`));
  assert.deepEqual(await engineFiles(), [leanUrl, '/engines/eng/e/abc123/openmw.js', '/engines/eng/e/abc123/openmw.wasm']);
  assert.ok(!(await page('demo')).includes('lean'), 'the example world loads the whole package');
  const r = await fetch(base + leanUrl, { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-encoding'), 'br');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  // (no Content-Length — Emscripten counts the decoded bytes against it —; the sizes said for "Prepare"'s count)
  assert.equal(r.headers.get('content-length'), null);
  assert.equal(r.headers.get('x-orthros-wire-length'), String(fs.statSync(leanFile).size)); assert.equal(r.headers.get('x-orthros-decoded-length'), '16');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString('latin1'), LEAN, 'decoded by the client');
  assert.equal((await fetch(base + leanUrl, { headers: { 'Accept-Encoding': 'identity' } }).then((x) => x.arrayBuffer())).byteLength, 16, 'without brotli: decoded by the server');
  assert.equal((await fetch(`${base}/engines/_c/${'f'.repeat(64)}/lean${LEAN_RULE}/openmw.data`)).status, 404, 'another content');
  assert.equal((await fetch(`${base}/engines/_c/${sha}/lean${LEAN_RULE}/openmw.wasm`)).status, 404);
  // (the release-keyed address a page opened before gave: still answered, another build's not)
  const old = await fetch(`${base}/engines/eng/lean1/abc123/openmw.data`, { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(old.status, 200); assert.equal(old.headers.get('x-orthros-decoded-length'), '16'); assert.equal(Buffer.from(await old.arrayBuffer()).toString('latin1'), LEAN);
  assert.equal((await fetch(`${base}/engines/eng/lean1/ffff/openmw.data`)).status, 404);
  // (an engine file's brotli sibling, and the port's own .br path: the same answer)
  for (const u of ['/engines/eng/e/abc123/openmw.wasm', '/ports/openmw/game-1/app/e/abc123/openmw.wasm.br']) {
    const w = await fetch(base + u, { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(w.headers.get('content-encoding'), 'br', u); assert.equal(w.headers.get('content-length'), null, u);
    assert.equal(w.headers.get('x-orthros-wire-length'), String(fs.statSync(path.join(build, 'openmw.wasm.br')).size), u);
    assert.equal(w.headers.get('x-orthros-decoded-length'), '4', u); assert.equal(await w.text(), 'wasm', u);
  }
});
