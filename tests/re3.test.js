// re3 browser ports (src/host/re3.js, src/ports/re3/, docs/browser-ports.md "re3 ports"): catalog entries without an
// executable, the engine release's availability and routes, its own game files laid over the version's, the INI editor
// of a language's settings, and the player's profile (the files the engine wrote among the mounted game files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGameCatalog } from '../src/host/game-catalog.js';
import { gameLayers } from '../src/host/game-files.js';
import { re3Problem } from '../src/host/re3.js';
import { createServer } from '../src/host/server.js';
import { setIni, bytesToText, textToBytes } from '../src/ports/re3/ini.js';
import { profileSnapshot, restoreProfile, setProfileIni, toCloud, findPath } from '../src/ports/re3/profile.js';
import { StreamedFiles } from '../src/ports/goldsrc/files.js';

const ENGINE = 'eng-test-1';
const re3 = (over = {}) => ({ engine: ENGINE, ...over });
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

/**
 * A games folder: a Win32 game, a GoldSrc port and an re3 port (`entry` merged into its version entry), the last two on
 * the same engine release; an engines folder with that release (its module, its WebAssembly, its own game files) and
 * another release no manifest names.
 */
function fixture(t, entry = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-re3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), engines = path.join(root, 'engines');
  write(path.join(games, 'win', 'base', 'game.exe'), 'MZ'); fs.mkdirSync(path.join(games, 'win', 'versions', '1'), { recursive: true });
  write(path.join(games, 'win', 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'win', name: 'Win', defaultVersion: 'win-1', versions: [{ id: 'win-1', dir: '1', version: '1', exe: 'game.exe' }] }));
  write(path.join(games, 'gs', 'base', 'valve', 'maps', 'start.bsp'), 'map'); fs.mkdirSync(path.join(games, 'gs', 'versions', '1'), { recursive: true });
  write(path.join(games, 'gs', 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'gs', name: 'GS', defaultVersion: 'gs-1', defaults: { runtime: 'goldsrc' },
    versions: [{ id: 'gs-1', dir: '1', version: '1', goldsrc: { engine: ENGINE, gameDir: 'valve', modules: { client: 'c.wasm', server: 's.wasm' }, solo: { map: 'start' } } }] }));
  const gm = path.join(games, 'gm');
  write(path.join(gm, 'base', 'Text', 'AMERICAN.GXT'), 'base text');
  write(path.join(gm, 'base', 'data', 'x.dat'), 'base x');
  write(path.join(gm, 'base', 'game.exe'), 'MZ');
  write(path.join(gm, 'versions', 'web', 'DATA', 'X.DAT'), 'version x');
  write(path.join(gm, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'gm', name: 'GM', defaultVersion: 'gm-web', defaults: { runtime: 're3' },
    versions: [{ id: 'gm-web', dir: 'web', version: 'Web', languages: ['en', 'fr'], re3: re3({ args: ['-nointro'], languages: { fr: { env: { GAME_LANG: 'fr' }, ini: { 'game.ini': { General: { Language: '1' } } } } } }), ...entry }] }));
  const release = path.join(engines, ENGINE);
  for (const f of ['release.json', 'engine/main.mjs', 'engine/main.wasm', 'engine/main.worker.mjs', 'c.wasm', 's.wasm', 'engine/index.js', 'engine/xash.wasm', 'engine/valve/extras.pk3']) write(path.join(release, f), f);
  write(path.join(release, 'gamefiles', 'TEXT', 'american.gxt'), 'engine text');
  write(path.join(release, 'gamefiles', 'models', 'extra.txd'), 'extra');
  write(path.join(engines, 'other-1', 'engine', 'main.mjs'), 'other');
  return { root, games, engines, gm, release };
}
async function serve(t, opts) {
  const server = createServer({ ...opts, lanLog: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const editManifest = (dir, fn) => { const f = path.join(dir, 'manifest.json'), spec = JSON.parse(fs.readFileSync(f, 'utf8')); fn(spec); fs.writeFileSync(f, JSON.stringify(spec)); };

test('an re3 version needs no executable and is checked by its own rules', (t) => {
  const { games, engines, gm, release } = fixture(t);
  const man = loadGameCatalog(games, null, { enginesDir: engines }).get('gm-web');
  assert.equal(man.runtime, 're3'); assert.equal(man.exe, undefined);
  assert.equal(man.saveKey, 'orthros-port:gm:web'); // (the installation, as the other ports': game and version folders)
  assert.deepEqual(gameLayers(man), [path.join(release, 'gamefiles'), man.folder, man.baseFolder]); // (the engine's files over the version's)
  assert.deepEqual(man.re3.languages.fr.env, { GAME_LANG: 'fr' });
  assert.equal(gameLayers(loadGameCatalog(games, null, { enginesDir: engines }).get('gs-1')).length, 2, 'a GoldSrc port gets no engine layer');
  assert.equal(re3Problem({ engine: ENGINE }), null);
  assert.equal(re3Problem({ engine: ENGINE, module: 'engine/main.mjs', args: ['+set', 'a=b', '-x.y'], solo: {}, languages: { en: {}, fr: { env: { A_1: '' }, ini: { 'sub/a.ini': { 'Main Section': { 'Some key': 'v w' } } } } } }), null);
  for (const [edit, error] of [
    [(v) => { delete v.re3; }, /re3 obligatoire/],
    [(v) => { v.re3.engine = '../x'; }, /re3.engine/],
    [(v) => { v.re3.module = '../engine/main.mjs'; }, /re3.module/],
    [(v) => { v.re3.module = 'engine/main.js'; }, /re3.module/],
    [(v) => { v.re3.args = '-nointro'; }, /re3.args/],
    [(v) => { v.re3.args = ['-a b']; }, /re3.args/],
    [(v) => { v.re3.args = ['-x;rm']; }, /re3.args/],
    [(v) => { v.re3.languages = { french: {} }; }, /re3.languages/],
    [(v) => { v.re3.languages = { fr: { env: { lower: 'x' } } }; }, /re3.languages/],
    [(v) => { v.re3.languages = { fr: { env: { A: 'x\ny' } } }; }, /re3.languages/],
    [(v) => { v.re3.languages = { fr: { env: { A: 'x'.repeat(65) } } }; }, /re3.languages/],
    [(v) => { v.re3.languages = { fr: { ini: { '../game.ini': { General: { Language: '1' } } } } }; }, /re3.languages/],
    [(v) => { v.re3.languages = { fr: { ini: { '/game.ini': { General: { Language: '1' } } } } }; }, /re3.languages/],
    [(v) => { v.re3.languages = { fr: { ini: { 'game.ini': { 'Gen]eral': { Language: '1' } } } } }; }, /re3.languages/],
    [(v) => { v.re3.languages = { fr: { ini: { 'game.ini': { General: { 'Lang=uage': '1' } } } } }; }, /re3.languages/],
    [(v) => { v.re3.languages = { fr: { ini: { 'game.ini': { General: { ';Language': '1' } } } } }; }, /re3.languages/],
    [(v) => { v.re3.languages = { fr: { ini: { 'game.ini': { General: { Language: '1\n[Other]' } } } } }; }, /re3.languages/],
    [(v) => { v.re3.languages = { fr: { ini: { 'game.ini': { General: {} } } } }; }, /re3.languages/],
    [(v) => { v.re3.solo = 'yes'; }, /re3.solo/],
    [(v) => { v.requires = [{ game: 'win', version: 'win-1', mount: 'C:\\Win' }]; }, /re3 n'a pas de requires/],
    [(v) => { v.overlays = ['/etc']; }, /overlays est généré/],
  ]) {
    editManifest(gm, (spec) => { spec.versions[0] = { id: 'gm-web', dir: 'web', version: 'Web', re3: re3() }; edit(spec.versions[0]); });
    assert.throws(() => loadGameCatalog(games, null, { enginesDir: engines }), error);
  }
  editManifest(gm, (spec) => { spec.versions[0] = { id: 'gm-web', dir: 'web', version: 'Web', re3: re3() }; spec.defaults.overlays = ['/etc']; });
  assert.throws(() => loadGameCatalog(games, null, { enginesDir: engines }), /defaults.overlays est réservé/);
});

test('the home lists an re3 port with its page and single player; available once its engine release is installed', async (t) => {
  const { games, engines, release, root } = fixture(t);
  const base = await serve(t, { gamesDir: games, enginesDir: engines });
  const entry = async () => (await (await fetch(`${base}/api/manifests`)).json()).find((m) => m.name === 'gm-web');
  const port = await entry();
  assert.deepEqual([port.runtime, port.launchUrl, port.modes, port.exe, port.available, port.saveKey], ['re3', '/ports/re3/gm-web/', ['solo'], null, true, 'orthros-port:gm:web']);
  // (the module the page imports: the release's only one with its WebAssembly — not a worker's)
  const man = await (await fetch(`${base}/api/manifest/gm-web`)).json();
  assert.equal(man.re3.module, 'engine/main.mjs'); assert.equal(man.launchUrl, '/ports/re3/gm-web/');
  assert.equal(man.overlays, undefined); assert.equal(JSON.stringify(man).includes(root), false);
  const page = await fetch(`${base}/ports/re3/gm-web/`);
  assert.equal(page.status, 200); assert.match(await page.text(), /src\/ports\/re3\/play\.js/);
  assert.equal(page.headers.get('cross-origin-embedder-policy'), 'require-corp');
  for (const p of ['/ports/re3/win-1/', '/ports/goldsrc/gm-web/', '/ports/re3/none/']) assert.equal((await fetch(base + p)).status, 404, p);
  // (two modules with their WebAssembly: none chosen, unless the manifest names one)
  write(path.join(release, 'engine', 'tool.mjs'), 'tool'); write(path.join(release, 'engine', 'tool.wasm'), 'tool');
  assert.equal((await entry()).available, false);
  assert.equal((await (await fetch(`${base}/api/manifest/gm-web`)).json()).re3.module, null);
  editManifest(path.join(games, 'gm'), (spec) => { spec.versions[0].re3.module = 'engine/main.mjs'; });
  assert.equal((await entry()).available, true);
  fs.rmSync(path.join(release, 'engine', 'main.wasm'));
  assert.equal((await entry()).available, false, 'its WebAssembly missing');
  fs.rmSync(release, { recursive: true });
  assert.equal((await entry()).available, false, 'the release missing');
});

test('engine files are served for the releases an re3 manifest names, immutable', async (t) => {
  const { games, engines } = fixture(t);
  const base = await serve(t, { gamesDir: games, enginesDir: engines });
  const wasm = await fetch(`${base}/engines/${ENGINE}/engine/main.wasm`);
  assert.equal(wasm.status, 200); assert.equal(wasm.headers.get('content-type'), 'application/wasm'); assert.match(wasm.headers.get('cache-control'), /immutable/);
  const module = await fetch(`${base}/engines/${ENGINE}/engine/main.mjs`);
  assert.equal(module.status, 200); assert.match(module.headers.get('content-type'), /javascript/);
  assert.equal(await (await fetch(`${base}/engines/${ENGINE}/gamefiles/TEXT/american.gxt`)).text(), 'engine text');
  assert.equal((await fetch(`${base}/engines/other-1/engine/main.mjs`)).status, 404, 'a release no manifest names');
  // (only a version whose runtime is re3 names one by its re3 entry)
  editManifest(path.join(games, 'win'), (spec) => { spec.versions[0].re3 = { engine: 'other-1' }; });
  assert.equal((await fetch(`${base}/engines/other-1/engine/main.mjs`)).status, 404);
  editManifest(path.join(games, 'gm'), (spec) => { spec.versions[0].re3.engine = 'other-1'; });
  await fetch(`${base}/api/manifests`); // (the catalog read again)
  assert.equal((await fetch(`${base}/engines/other-1/engine/main.mjs`)).status, 200);
});

test('the release\'s own game files lie over the version\'s, whatever their case: tree, files, compressed ranges, learned reads', async (t) => {
  const { games, engines, release } = fixture(t);
  const base = await serve(t, { gamesDir: games, enginesDir: engines });
  const tree = await (await fetch(`${base}/api/tree/gm-web`)).json();
  // (one folder of each name: the engine's spelling first, as a version's over the base's)
  assert.deepEqual(Object.keys(tree.dirs).sort(), ['DATA', 'TEXT', 'models']);
  assert.deepEqual(Object.keys(tree.dirs.TEXT.files), ['american.gxt']);
  assert.deepEqual(Object.keys(tree.dirs.models.files), ['extra.txd']);
  assert.equal(tree.dirs.TEXT.files['american.gxt'].size, 'engine text'.length);
  assert.equal(await (await fetch(`${base}/game/gm-web/text/AMERICAN.gxt`)).text(), 'engine text');
  assert.equal(await (await fetch(`${base}/game/gm-web/models/extra.txd`)).text(), 'extra');
  assert.equal(await (await fetch(`${base}/game/gm-web/data/x.dat`)).text(), 'version x'); // (the version over the base, as before)
  assert.equal(await (await fetch(`${base}/gamez/gm-web/TEXT/american.gxt?r=0-11`)).text(), 'engine text');
  const prefetch = `${base}/api/prefetch/gm-web`;
  assert.equal((await fetch(prefetch, { method: 'POST', body: JSON.stringify({ session: 's1', reads: [['models/extra.txd', 0, 5, 12], ['TEXT/american.gxt', 0, 11, 3]] }) })).status, 204);
  assert.deepEqual(await (await fetch(prefetch)).json(), [['TEXT/american.gxt', 0, 1, 3], ['models/extra.txd', 0, 1, 12]]);
  // (a GoldSrc port on the same release gets none of them)
  assert.equal((await fetch(`${base}/game/gs-1/TEXT/american.gxt`)).status, 404);
  // (the release not installed: no layer, the game's own file)
  fs.rmSync(path.join(release, 'gamefiles'), { recursive: true });
  await fetch(`${base}/api/manifests`); // (the trees listed again)
  assert.equal(await (await fetch(`${base}/game/gm-web/text/american.gxt`)).text(), 'base text');
  assert.equal((await (await fetch(`${base}/api/tree/gm-web`)).json()).dirs.models, undefined);
});

// ---------------------------------------------------------------- a language's settings in the engine's ini files

test('the INI editor sets keys in place and keeps everything else byte for byte', () => {
  const text = '; settings\r\n[General]\r\nLanguage = 0  \r\nother=1\r\n\r\n[Graphics]\r\nWidth=640\r\n';
  assert.equal(setIni(text, { general: { language: '0' } }), text, 'nothing to change: the same text');
  assert.equal(setIni(text, { General: { Language: '3' } }), text.replace('Language = 0  ', 'Language = 3'));
  // (a missing key after its section's last line, a missing section at the end, in the file's line endings)
  assert.equal(setIni(text, { General: { Subtitles: '1' }, Audio: { Volume: '7', Mute: '0' } }),
    '; settings\r\n[General]\r\nLanguage = 0  \r\nother=1\r\nSubtitles=1\r\n\r\n[Graphics]\r\nWidth=640\r\n\r\n[Audio]\r\nVolume=7\r\nMute=0\r\n');
  assert.equal(setIni('', { General: { Language: '1' } }), '[General]\nLanguage=1\n');
  assert.equal(setIni('[General]\nA=1', { General: { B: '2' } }), '[General]\nA=1\nB=2\n', 'a last line without its end');
  assert.equal(setIni('x=1', { S: { k: 'v' } }), 'x=1\n\n[S]\nk=v\n');
  // (every section of that name, every line of the key: whichever the engine reads; a key of another section untouched)
  assert.equal(setIni('[A]\nk=1\n[B]\nk=1\n[a]\n  K\t=\t1\n', { A: { k: '2' } }), '[A]\nk=2\n[B]\nk=1\n[a]\n  K\t=\t2\n');
  // (comments and look-alikes are not keys; a value may hold '=')
  assert.equal(setIni('[A]\n;k=1\n#k=1\nk = a=b\n', { A: { k: 'c' } }), '[A]\n;k=1\n#k=1\nk = c\n');
  // (a byte-order mark kept; the file's other bytes, whatever they are, too)
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from('[A]\nk=1\nname=\xe9t\xe9\n', 'latin1')]);
  const out = textToBytes(setIni(bytesToText(bytes), { a: { K: '2' } }));
  assert.deepEqual([...out], [0xef, 0xbb, 0xbf, ...Buffer.from('[A]\nk=2\nname=\xe9t\xe9\n', 'latin1')]);
});

// ---------------------------------------------------------------- the profile among the mounted game files

/** The part of Emscripten's FS the profile uses: folders, files of bytes, nodes (a file's reads counted). */
function memFS() {
  const DIR = 0o40000, FILE = 0o100000, top = { mode: DIR | 0o755, children: new Map() };
  const split = (p) => p.split('/').filter(Boolean);
  const get = (p) => { let n = top; for (const part of split(p)) { n = n.children?.get(part); if (!n) return null; } return n; };
  const parent = (p) => { const parts = split(p), n = get('/' + parts.slice(0, -1).join('/')); if (!n?.children) throw new Error(`ENOENT ${p}`); return [n, parts.at(-1)]; };
  const FS = {
    isDir: (mode) => (mode & 0o170000) === DIR, isFile: (mode) => (mode & 0o170000) === FILE,
    lookupPath(p) { const node = get(p); if (!node) throw new Error(`ENOENT ${p}`); return { path: p, node }; },
    readdir(p) { const n = get(p); if (!n?.children) throw new Error(`ENOTDIR ${p}`); return ['.', '..', ...n.children.keys()]; },
    readFile(p) { const n = get(p); if (!n || n.children) throw new Error(`ENOENT ${p}`); n.reads = (n.reads ?? 0) + 1; return n.data.slice(); },
    writeFile(p, data) { const [dir, name] = parent(p); const old = dir.children.get(name); if (old?.children) throw new Error('EISDIR'); if (old) old.data = Uint8Array.from(data); else dir.children.set(name, { mode: FILE | 0o644, data: Uint8Array.from(data) }); },
    unlink(p) { const [dir, name] = parent(p); dir.children.delete(name); },
    mkdirTree(p) { let n = top; for (const part of split(p)) { let next = n.children?.get(part); if (!next) { if (!n.children) throw new Error(`ENOTDIR ${p}`); n.children.set(part, next = { mode: DIR | 0o755, children: new Map() }); } n = next; } },
    // (a streamed game file's node, ../src/ports/goldsrc/files.js mount())
    createFile(dir, name) { const node = { mode: FILE | 0o444, stream_ops: {} }; get(dir).children.set(name, node); return node; },
    ErrnoError: class extends Error {},
  };
  return FS;
}
const text = (s) => new TextEncoder().encode(s);

test('the profile is every file the engine wrote among the game\'s, put back over the game files it replaced', () => {
  const FS = memFS(), game = new Set(), mount = (p, s) => { FS.mkdirTree(p.slice(0, p.lastIndexOf('/'))); FS.writeFile(p, text(s)); game.add(FS.lookupPath(p).node); };
  mount('/game/data/x.dat', 'game x'); mount('/game/TEXT/american.gxt', 'text'); mount('/game/settings.ini', '[General]\nLanguage=0\n');
  // (what the engine wrote: its user folder, its ini at the root, a game file it replaced, logs)
  FS.mkdirTree('/game/userfiles/screenshots'); FS.writeFile('/game/userfiles/save1.b', text('save'));
  FS.writeFile('/game/userfiles/screenshots/s.bmp', text('pic')); FS.writeFile('/game/engine.log', text('log'));
  FS.unlink('/game/data/x.dat'); FS.writeFile('/game/data/x.dat', text('rewritten'));
  const snap = profileSnapshot(FS, '/game', game);
  assert.deepEqual(snap.map((f) => f.path).sort(), ['data/x.dat', 'engine.log', 'userfiles/save1.b', 'userfiles/screenshots/s.bmp']);
  assert.equal([...game].reduce((n, node) => n + (node.reads ?? 0), 0), 0, 'a game file is never read: its bytes may not be here');
  assert.deepEqual(toCloud(snap).map((f) => f.path).sort(), ['data/x.dat', 'userfiles/save1.b'], 'the account keeps no logs nor screenshots');
  // (a new session: the game files mounted again, the profile put back over them)
  const FS2 = memFS(), game2 = new Set(), mount2 = (p, s) => { FS2.mkdirTree(p.slice(0, p.lastIndexOf('/'))); FS2.writeFile(p, text(s)); game2.add(FS2.lookupPath(p).node); };
  mount2('/game/data/x.dat', 'game x'); mount2('/game/userfiles', 'a file where the profile has a folder');
  const told = [];
  restoreProfile(FS2, '/game', [...snap, { path: '../escape', data: text('x') }, { path: 'a/b', data: 'not bytes' }], (line) => told.push(line));
  assert.equal(new TextDecoder().decode(FS2.readFile('/game/data/x.dat')), 'rewritten');
  assert.equal(game2.has(FS2.lookupPath('/game/data/x.dat').node), false, 'the profile\'s own copy');
  assert.deepEqual(profileSnapshot(FS2, '/game', game2).map((f) => f.path).sort(), ['data/x.dat', 'engine.log']);
  assert.equal(told.length, 4, told.join('\n')); // (two invalid entries, two under a game file that is not a folder)
});

test('the streamed game files mounted in the game\'s folder are never part of the profile, nor fetched for it', () => {
  const FS = memFS(), fetched = [];
  const files = [{ path: 'data/x.dat', size: 10, mtime: 1 }, { path: 'TEXT/american.gxt', size: 20, mtime: 1 }];
  const sf = new StreamedFiles({ name: 'gm-web', files, store: null, syncGet: (url) => { fetched.push(url); throw new Error('no network'); }, get: async (url) => { fetched.push(url); throw new Error('no network'); } });
  FS.mkdirTree('/game'); sf.mount(FS, '/game');
  const game = new Set([...sf.files.values()].map((f) => f.node));
  assert.equal(game.size, 2); assert.ok([...game].every(Boolean));
  FS.mkdirTree('/game/userfiles'); FS.writeFile('/game/userfiles/save1.b', text('save')); FS.writeFile('/game/settings.ini', text('[A]\n'));
  assert.deepEqual(profileSnapshot(FS, '/game', game).map((f) => f.path).sort(), ['settings.ini', 'userfiles/save1.b']);
  assert.deepEqual(fetched, []);
});

test('a language\'s settings go into the profile\'s ini file, the game\'s own copied first, found whatever its case', () => {
  const FS = memFS(), game = new Set();
  FS.mkdirTree('/game'); FS.writeFile('/game/Settings.INI', text('; game\n[General]\nLanguage=0\nWidth=640\n')); game.add(FS.lookupPath('/game/Settings.INI').node);
  assert.equal(findPath(FS, '/game', 'settings.ini'), 'Settings.INI');
  assert.equal(setProfileIni(FS, '/game', 'settings.ini', { General: { Language: '0' } }, game), 'same');
  assert.equal(game.has(FS.lookupPath('/game/Settings.INI').node), true, 'unchanged: still the game\'s');
  assert.equal(setProfileIni(FS, '/game', 'settings.ini', { General: { Language: '1' } }, game), 'set');
  assert.equal(new TextDecoder().decode(FS.readFile('/game/Settings.INI')), '; game\n[General]\nLanguage=1\nWidth=640\n');
  assert.deepEqual(profileSnapshot(FS, '/game', game).map((f) => f.path), ['Settings.INI']);
  assert.equal(setProfileIni(FS, '/game', 'sub/new.ini', { A: { k: 'v' } }, game), 'created');
  assert.equal(new TextDecoder().decode(FS.readFile('/game/sub/new.ini')), '[A]\nk=v\n');
});
