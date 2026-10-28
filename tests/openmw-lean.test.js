// The OpenMW engine package without what a game of its own never reads (src/host/openmw-lean.js, docs/openmw.md "The
// engine's package"): the same package, the example world's and ICU's unused root copy's bytes zeroed, made once per
// content by a niced child, loaded by a game of its own, at an address every release with that package shares.
import { test } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { leanPackages, leanRanges, leanRewrites, leanIcuData, packageFiles, withLeanPackage, LEAN_RULE, ICU_DROPPED } from '../src/host/openmw-lean.js';
import { createServer } from '../src/host/server.js';
import { engineContent } from '../src/host/engine-content.js';

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
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };

test('the lean package\'s ranges: the example world, and ICU\'s root copy only beside the copy the engine opens', () => {
  const js = (names) => `loadPackage({files:[${names.map((n, i) => `{filename:"${n}",start:${i * 10},end:${i * 10 + 10}}`).join(',')}]})`;
  assert.deepEqual(packageFiles(js(['/resources/a', '/gamedata/b'])).map((f) => f.name), ['/resources/a', '/gamedata/b']);
  assert.deepEqual(leanRanges(js(['/resources/a', '/gamedata/b', '/icu/icudt68l.dat', '/icudt68l.dat'])), [[10, 20], [30, 40]]);
  assert.deepEqual(leanRanges(js(['/icudt68l.dat', '/resources/a', '/icu/icudt68l.dat'])), [[0, 10]], 'by name, wherever it is');
  assert.deepEqual(leanRanges(js(['/resources/a', '/gamedata/b', '/icu/icudt68l.dat'])), [[10, 20]], 'a release without the root copy');
  assert.deepEqual(leanRanges(js(['/resources/a', '/gamedata/b', '/icudt68l.dat'])), [[10, 20]], 'the root copy alone: kept, the engine may read it');
  assert.deepEqual(leanRanges(js(['/resources/icudt68l.dat', '/gamedata/b'])), [[10, 20]]);
});

/**
 * ICU common data ("CmnD", little-endian ASCII) of `items` ([name, body] — sorted by name here, as ICU's tool writes
 * them): a 32-byte data header, the table (count, then name/data offsets from the table), the names, the items 16-aligned.
 */
function icuData(items) {
  items = [...items].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const hs = 32, header = Buffer.alloc(hs);
  header.writeUInt16LE(hs, 0); header[2] = 0xda; header[3] = 0x27; header.writeUInt16LE(20, 4); header[10] = 2; header.write('CmnD', 12, 'latin1');
  const names = Buffer.concat(items.map(([n]) => Buffer.from(`${n}\0`, 'latin1'))), tableLen = 4 + 8 * items.length;
  let data = (tableLen + names.length + 15) & ~15;
  const table = Buffer.alloc(tableLen), parts = []; let name = tableLen;
  table.writeUInt32LE(items.length, 0);
  items.forEach(([n, body], i) => {
    table.writeUInt32LE(name, 4 + 8 * i); table.writeUInt32LE(data, 8 + 8 * i); name += n.length + 1;
    const b = Buffer.alloc((body.length + 15) & ~15); Buffer.from(body, 'latin1').copy(b); parts.push(b); data += b.length;
  });
  const pad = Buffer.alloc(((tableLen + names.length + 15) & ~15) - tableLen - names.length);
  return Buffer.concat([header, table, names, pad, ...parts]);
}
/** The items of ICU common data: { name: body (to its next item's start, trailing zeros cut) } — as ICU looks them up. */
function icuItems(b) {
  const hs = b.readUInt16LE(0), n = b.readUInt32LE(hs), out = {}, at = [];
  for (let i = 0; i < n; i++) at.push([hs + b.readUInt32LE(hs + 4 + 8 * i), hs + b.readUInt32LE(hs + 8 + 8 * i)]);
  at.forEach(([name, data], i) => { out[b.toString('latin1', name, b.indexOf(0, name))] = b.toString('latin1', data, i + 1 < n ? at[i + 1][1] : b.length).replace(/\0+$/, ''); });
  return out;
}
const ICU_ITEMS = [['icudt68l/root.res', 'MAIN-ROOT'], ['icudt68l/fr.res', 'FRFR'], ['icudt68l/plurals.res', 'PLURALS'], ['icudt68l/coll/root.res', 'COLLROOT'],
  ['icudt68l/coll/fr.res', 'COLLFR'], ['icudt68l/curr/fr.res', 'CURRFR'], ['icudt68l/lang/fr.res', 'LANGFR'], ['icudt68l/zone/fr.res', 'ZONEFR'],
  ['icudt68l/brkitr/word.brk', 'WORDBRK'], ['icudt68l/region/fr.res', 'REGIONFR'], ['icudt68l/unit/fr.res', 'UNITFR'], ['icudt68l/rbnf/fr.res', 'RBNFFR'],
  ['icudt68l/translit/root.res', 'TRANSLIT']];

test('rule 3: ICU\'s common data without the feature trees the engine never opens — its table rewritten, same length, kept items at their offsets', () => {
  assert.deepEqual(ICU_DROPPED, ['brkitr', 'coll', 'rbnf', 'translit', 'unit', 'zone']);
  const icu = icuData(ICU_ITEMS), lean = leanIcuData(icu);
  assert.equal(lean.length, icu.length);
  assert.deepEqual(icuItems(lean), { 'icudt68l/curr/fr.res': 'CURRFR', 'icudt68l/fr.res': 'FRFR', 'icudt68l/lang/fr.res': 'LANGFR', 'icudt68l/plurals.res': 'PLURALS',
    'icudt68l/region/fr.res': 'REGIONFR', 'icudt68l/root.res': 'MAIN-ROOT' }, 'the kept items, found by name as ICU finds them');
  const names = Object.keys(icuItems(lean)); assert.deepEqual(names, [...names].sort(), 'still sorted (binary search)');
  for (const [n, body] of ICU_ITEMS) {
    const at = icu.indexOf(Buffer.from(body, 'latin1'));
    if (ICU_DROPPED.includes(n.split('/')[1])) { assert.equal(lean.indexOf(Buffer.from(body, 'latin1')), -1, `${n}: zeroed`); assert.equal(lean.indexOf(Buffer.from(n, 'latin1')), -1, `${n}: its name too`); }
    else assert.equal(lean.toString('latin1', at, at + body.length), body, `${n}: at its offset`);
  }
  assert.ok(lean.subarray(0, 32).equals(icu.subarray(0, 32)), 'the data header as it was');
  // (not ICU's common data, or nothing to drop: left whole)
  assert.equal(leanIcuData(Buffer.from('IC')), null);
  assert.equal(leanIcuData(icuData(ICU_ITEMS.filter(([n]) => !ICU_DROPPED.includes(n.split('/')[1])))), null);
  const big = Buffer.from(icu); big[8] = 1; assert.equal(leanIcuData(big), null, 'big-endian: not this format');
  const bad = Buffer.from(icu); bad.writeUInt32LE(1e6, 32); assert.equal(leanIcuData(bad), null, 'a table past the end');
  // (the package's rewrite: the opened copy only, by name)
  const js = `loadPackage({files:[{filename:"/icu/icudt68l.dat",start:0,end:${icu.length}},{filename:"/icudt68l.dat",start:${icu.length},end:${2 * icu.length}}]})`;
  const rw = leanRewrites(js);
  assert.deepEqual(rw.map((r) => [r.start, r.end]), [[0, icu.length]]);
  assert.ok(rw[0].rewrite(icu).equals(lean)); assert.equal(rw[0].rewrite(Buffer.from('IC')).toString(), 'IC', 'not ICU data: as it is');
});

test('rule 3 made by the child: the opened ICU copy rewritten in place across read chunks, the rest as rules 1-2', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-lean-icu-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // (ICU data larger than the child's 1 MiB reads, not aligned to them: its rewrite spans several chunks)
  const filler = Array.from({ length: 300 }, (_, i) => [`icudt68l/coll/x${String(i).padStart(3, '0')}.res`, `C${i}`.repeat(1200)]);
  const icu = icuData([...ICU_ITEMS, ...filler, ...Array.from({ length: 300 }, (_, i) => [`icudt68l/l${String(i).padStart(3, '0')}.res`, `L${i}`.repeat(1200)])]);
  assert.ok(icu.length > 2 << 20);
  const files = [['/resources/a', Buffer.alloc(700001, 7)], ['/gamedata/b', Buffer.from('BBBBB')], ['/icu/icudt68l.dat', icu], ['/icudt68l.dat', icu], ['/resources/z', Buffer.from('ZZ')]];
  let at = 0; const meta = [];
  for (const [name, body] of files) { meta.push(`{filename:"${name}",start:${at},end:${at + body.length}}`); at += body.length; }
  const data = Buffer.concat(files.map((f) => f[1])), dir = path.join(root, 'e');
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'openmw.data'), data); fs.writeFileSync(path.join(dir, 'openmw.js'), `loadPackage({files:[${meta.join(',')}]})`);
  const out = path.join(root, 'lean.br'), sha = crypto.createHash('sha256').update(data).digest('hex');
  const { fork } = await import('node:child_process');
  const code = await new Promise((res) => fork(new URL('../src/host/openmw-lean-worker.js', import.meta.url).pathname, [path.join(dir, 'openmw.data'), path.join(dir, 'openmw.js'), out, sha]).on('exit', res));
  assert.equal(code, 0);
  const got = zlib.brotliDecompressSync(fs.readFileSync(out)), want = Buffer.concat([files[0][1], Buffer.alloc(5), leanIcuData(icu), Buffer.alloc(icu.length), files[4][1]]);
  assert.equal(got.length, data.length); assert.ok(got.equals(want), 'the package: the opened ICU copy rewritten at its offset, the root copy and the example zeroed');
});

test('the lean package: keyed by the package\'s content, made once, loaded unless the page boots the example', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-lean-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { build, sha } = release(root);
  release(root, { id: 'eng2', build: 'def456', wasm: 'wasm2' }); // (the next release: another wasm, the same package)
  const logs = [], dir = path.join(root, 'cache'), lean = leanPackages({ dir, enginesDir: path.join(root, 'engines'), log: (m) => logs.push(m) });
  assert.equal(lean.url('eng'), null, 'not made yet: the release\'s own package meanwhile');
  assert.equal(lean.pending('eng'), true, 'being made');
  assert.equal(lean.url('eng2'), null); assert.equal(lean.pending('eng2'), true, 'the same content: the same making');
  // (the file is renamed in place before the maker's log line arrives: wait for both)
  const url = await until(() => logs.some((l) => /bytes in/.test(l)) && lean.url('eng'));
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

test('the lean package: keyed by the package\'s bytes as hashed, said or not by the release; a making that fails makes nothing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-lean-hash-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { sha } = release(root, { sha: false });
  const lean = leanPackages({ dir: path.join(root, 'cache'), enginesDir: path.join(root, 'engines') });
  assert.equal(lean.url('eng'), null); assert.equal(lean.pending('eng'), true, 'hashed, then made');
  assert.equal(await until(() => lean.url('eng')), `/engines/_c/${sha}/lean${LEAN_RULE}/`);
  // (a release.json whose sha256 is not its package's — a package replaced since —: keyed by what the package holds,
  // the mismatch logged by the shared hashing, engine-content.js)
  const { dir } = release(root, { id: 'bad', build: 'bad000' });
  const rj = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8')); rj.engineFiles['openmw.data'] = 'e'.repeat(64);
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(rj));
  const logs = [], bad = leanPackages({ dir: path.join(root, 'cache2'), enginesDir: path.join(root, 'engines'), log: (m) => logs.push(m) });
  assert.equal(bad.url('bad'), null); assert.equal(bad.pending('bad'), true);
  assert.equal(await until(() => bad.url('bad')), `/engines/_c/${sha}/lean${LEAN_RULE}/`, 'never under the sha256 it says');
  assert.match(logs.join('\n'), new RegExp(`openmw.data: sha256 ${sha}, not the ${'e'.repeat(64)}`));
  assert.ok(!fs.existsSync(path.join(root, 'cache2', '_c', 'e'.repeat(64))));
  // (a making that fails — its file cannot be written —: nothing given, nothing pending, not tried again this run)
  const cache3 = path.join(root, 'cache3'); fs.mkdirSync(path.join(cache3, '_c', sha, `lean${LEAN_RULE}`, 'openmw.data.br'), { recursive: true });
  const logs3 = [], failing = leanPackages({ dir: cache3, enginesDir: path.join(root, 'engines'), log: (m) => logs3.push(m) });
  failing.url('eng'); await until(() => /failed/.test(logs3.join('\n')));
  assert.equal(failing.url('eng'), null); assert.equal(failing.pending('eng'), false);
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
    // (its package hashed already — the server's engine files by content, shared —: this content's files at once)
    const content = engineContent({ enginesDir: path.join(root, 'engines') }); assert.equal(await content.hashed('eng', 'e/abc123/openmw.data'), sha);
    const l2 = leanPackages({ dir: dir2, enginesDir: path.join(root, 'engines'), content });
    assert.equal(l2.url('eng'), `/engines/_c/${sha}/lean${LEAN_RULE - 1}/`); assert.equal(l2.size('eng'), fs.statSync(prev).size);
    assert.equal(l2.contentFile(sha, `lean${LEAN_RULE - 1}/openmw.data`).file, prev);
    await until(() => l2.url('eng') === `/engines/_c/${sha}/lean${LEAN_RULE}/`);
  }
  // (a making that fails — its file cannot be written —: the old file for the rest of the run)
  release(root, { id: 'bad', build: 'bad000' });
  const dir3 = path.join(root, 'cache3'); fs.mkdirSync(path.join(dir3, '_c', sha, `lean${LEAN_RULE}`, 'openmw.data.br'), { recursive: true });
  const logs = [], l3 = leanPackages({ dir: dir3, enginesDir: path.join(root, 'engines'), log: (m) => logs.push(m) });
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
  // (the release's files by their content once hashed — not by the sha256s its release.json says: engine-content.js —;
  // never the release's own package)
  const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(build, f))).digest('hex');
  const js = `/engines/_c/${hash('openmw.js')}/openmw.js`, wasm = `/engines/_c/${hash('openmw.wasm')}/openmw.wasm`;
  const first = await until(async () => { const f = await engineFiles(); return f.includes(js) && f.includes(wasm) && f; });
  assert.ok(!first.some((u) => /openmw\.data$/.test(u) && !u.includes('/lean')), `its making just started: ${first}`);
  const leanFile = path.join(root, 'brcache', 'engines', '_c', sha, `lean${LEAN_RULE}`, 'openmw.data.br'), leanUrl = `/engines/_c/${sha}/lean${LEAN_RULE}/openmw.data`;
  await until(() => fs.existsSync(leanFile));
  // (a server started with the game installed: made from its start, before any card or page asked for it)
  const other = createServer({ gamesDir: games, enginesDir: path.join(root, 'engines'), brCacheDir: path.join(root, 'brcache2'), brCacheLog: () => {} });
  t.after(() => other.close());
  await until(() => fs.existsSync(path.join(root, 'brcache2', 'engines', '_c', sha, `lean${LEAN_RULE}`, 'openmw.data.br')));
  let html = '';
  for (let i = 0; i < 400 && !html.includes('lean'); i++) { html = await page('game'); if (!html.includes('lean')) await new Promise((r) => setTimeout(r, 50)); }
  assert.match(html, new RegExp(`/engines/_c/${sha}/lean${LEAN_RULE}/`));
  assert.deepEqual(await engineFiles(), [leanUrl, js, wasm]);
  assert.ok(!(await page('demo')).includes('lean'), 'the example world loads the whole package');
  const r = await fetch(base + leanUrl, { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-encoding'), 'br');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  // (no Content-Length — Emscripten counts the decoded bytes against it —; the sizes said for "Prepare"'s count)
  assert.equal(r.headers.get('content-length'), null);
  assert.equal(r.headers.get('x-orthros-wire-length'), String(fs.statSync(leanFile).size)); assert.equal(r.headers.get('x-orthros-decoded-length'), '16');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString('latin1'), LEAN, 'decoded by the client');
  assert.equal((await fetch(base + leanUrl, { headers: { 'Accept-Encoding': 'identity' } }).then((x) => x.arrayBuffer())).byteLength, 16, 'without brotli: decoded by the server');
  // (a range asked: the brotli body whole, as without one — not the package decoded here, ~26 times its bytes live)
  const ranged = await new Promise((resolve, reject) => http.get(base + leanUrl, { headers: { 'Accept-Encoding': 'br', Range: 'bytes=0-0' } }, (res) => {
    const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => resolve({ res, body: Buffer.concat(parts) }));
  }).on('error', reject));
  assert.equal(ranged.res.statusCode, 200); assert.equal(ranged.res.headers['content-encoding'], 'br');
  assert.deepEqual(ranged.body, fs.readFileSync(leanFile), 'the brotli file as it is');
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
