// Hidden machine state (docs/snapshot.md): a snapshot holds what is reachable from the Vm; state a module keeps in a
// variable of its own — at its top level (shared by every Vm of the page!) or in its registration closure — is not, and
// a restored game would go on with that variable's initial value. Every such declaration must say what it is: handed
// over to the snapshot registry (snapKnown(vm, ...) in the same statement), or annotated `// snapshot: <why not state>`
// (on its line or the one above: a constant, a cache rebuilt from state, host-side...). A new one fails this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIRS = ['src/core', 'src/win32', 'src/gfx/gdi', 'src/vfs'];
const SKIP = new Set(['src/core/snapshot.js', 'src/core/vm-snapshot.js']);

/**
 * A declaration that may hold mutable state: a `let`/`var` starting from a value of its own (a counter, a flag, a
 * container: not one read from existing state), or a `const` bound to a container — unless its name is in capitals
 * (FMT, MODES, K: the sources' convention for constant tables and a module's API table).
 */
const MUTABLE = /^(let|var)\s+[\w$]+\s*(=\s*(-?[\d.]|['"`]|true\b|false\b|null\b|undefined\b|\[|\{|new\s)|[;,])|^const\s+(?![A-Z][A-Z0-9_]*\s*=)[A-Za-z_$][\w$]*\s*=\s*(new\s+(Map|Set|WeakMap|Array|Uint\w*Array|Int\w*Array|Float\w*Array)\b|\[|\{)/;
const ANNOTATED = /\/\/ snapshot:|vm\.snap\.(known|cls)\(|snap(Known|Class)\(vm,/;

/**
 * Declarations of `file` at its top level and at the top of its top-level functions taking the Vm (`vm`): the closures
 * a module registers its API in, whose variables live as long as the machine.
 */
export function hiddenStateCandidates(file) {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n'), out = [];
  let inReg = false;
  lines.forEach((line, i) => {
    if (/^(export )?function \w*\(.*\bvm\b.*\)\s*\{/.test(line)) { inReg = true; return; }
    if (inReg && /^\}/.test(line)) { inReg = false; return; }
    const top = !inReg && !/^\s/.test(line) ? line : inReg && /^ {2}\S/.test(line) ? line.slice(2) : null;
    if (top === null || !MUTABLE.test(top.replace(/^export\s+/, ''))) return;
    if (ANNOTATED.test(line) || ANNOTATED.test(lines[i - 1] ?? '')) return;
    out.push(`${file}:${i + 1}: ${line.trim().slice(0, 110)}`);
  });
  return out;
}

test('every module variable that could hold machine state is handed to snapshots or says why not', () => {
  const found = [];
  for (const dir of DIRS) for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    const file = `${dir}/${f}`;
    if (f.endsWith('.js') && !SKIP.has(file)) found.push(...hiddenStateCandidates(file));
  }
  assert.deepEqual(found, [], `\n${found.join('\n')}\n(docs/snapshot.md: hand it over with vm.snap.known(...) or annotate // snapshot: <why>)`);
});

test('modules that register snapshot state are among the sources a snapshot depends on', async () => {
  // (src/host/snapshot-sources.js: a change to a module left out of the hash keeps snapshots valid — it must own no state)
  const { snapshotSourceFiles } = await import('../src/host/snapshot-sources.js');
  const sources = new Set(snapshotSourceFiles(ROOT)), out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'ports') walk(rel); continue; }
      if (!e.name.endsWith('.js') || sources.has(rel) || rel === 'src/core/snapshot.js') continue;
      if (/\bsnapshotClass\(|\bsnap(Known|Class)\(vm,|\bsnap\.(known|cls|knowGraph)\(/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) out.push(rel);
    }
  };
  walk('src');
  assert.ok(sources.has('src/win32/kernel32.js') && sources.has('src/core/vm-snapshot.js') && !sources.has('src/cpu/jit/translate.js'), 'the closure is followed');
  assert.deepEqual(out, [], 'modules outside the snapshot sources (src/host/snapshot-sources.js) registering state');
});

test('the game data\'s transport is out of the snapshot sources, the guest-visible tree in', async () => {
  // (a data-only deploy keeps a returning player's snapshot: src/host/snapshot-sources.js DATA_TRANSPORT)
  const { snapshotSourceFiles, DATA_TRANSPORT, KEPT } = await import('../src/host/snapshot-sources.js');
  const sources = new Set(snapshotSourceFiles(ROOT));
  for (const f of DATA_TRANSPORT) assert.ok(!sources.has(f), `${f} out`);
  assert.ok(!sources.has('src/vfs/pcm-codec.js'), 'what only the transport imports out with it');
  for (const f of KEPT) assert.ok(sources.has(f), `${f} kept (which files the guest sees, their sizes)`);
  assert.ok(sources.has('src/vfs/vfs.js') && sources.has('src/host/web/worker.js'), 'the guest\'s file system and the worker kept');
});

test('what the guest sees of the game folder through the data transport is pinned (out of the snapshot key)', async () => {
  // (http-backend.js is out of the key, DATA_TRANSPORT: its answers to the guest's stat/readdir/open — case folding, the
  // listing's order, a directory's date — are restored over silently if they change. Changing one here fails this test:
  // such a change must change the key too — moved into a kept module, src/host/snapshot-sources.js KEPT —, never a
  // data-only deploy)
  const { HttpBackend } = await import('../src/vfs/http-backend.js');
  const { LIGHT_DIR } = await import('../src/vfs/game-tree.js');
  const tree = { dirs: {
    Data: { dirs: { Maps: { dirs: {}, files: { 'm1.map': { size: 7, mtime: 3 } } } }, files: { 'B.big': { size: 10, mtime: 5 }, 'a.ini': { size: 2 } } },
  }, files: { 'Game.exe': { size: 100, mtime: 9, light: 40 }, 'data.txt': { size: 1, mtime: 1 }, DATA: { size: 3 } } };
  const b = new HttpBackend('/game/g/', tree, {});
  const shape = (r) => r && (r.dir ? { dir: r.path, name: r.name } : { file: r.path, name: r.name, size: r.file.size });
  assert.deepEqual(shape(b.lookup('data/maps/M1.MAP')), { file: 'Data/Maps/m1.map', name: 'm1.map', size: 7 }, 'case folded to the tree\'s names');
  assert.deepEqual(shape(b.lookup('data')), { dir: 'Data', name: 'Data' }, 'a directory before a file of the same name (case aside)');
  assert.deepEqual(shape(b.lookup('DATA')), { dir: 'Data', name: 'Data' }, 'even an exact file name');
  assert.deepEqual(shape(b.lookup('data.txt')), { file: 'data.txt', name: 'data.txt', size: 1 });
  assert.deepEqual(shape(b.lookup('\\Data\\\\b.BIG')), { file: 'Data/B.big', name: 'B.big', size: 10 }, 'either separator, empty parts skipped');
  assert.deepEqual(shape(b.lookup('')), { dir: '', name: '' }, 'the root');
  assert.equal(b.lookup('Data/nope'), null);
  assert.equal(b.lookup('Game.exe/x'), null, 'no path through a file');
  assert.deepEqual(shape(b.lookup(`${LIGHT_DIR}/game.EXE`)), { file: `${LIGHT_DIR}/Game.exe`, name: 'Game.exe', size: 40 }, 'a light copy: its own size');
  assert.equal(b.lookup(`${LIGHT_DIR}/data.txt`), null, 'no light copy: none');
  assert.deepEqual(b.stat('data/b.big'), { size: 10, isDir: false, mtime: 5 });
  assert.deepEqual(b.stat('data/A.INI'), { size: 2, isDir: false, mtime: 0 }, 'no date: 0');
  assert.deepEqual(b.stat('data/MAPS'), { size: 0, isDir: true, mtime: 0 }, 'a directory: size and date 0');
  assert.equal(b.stat('x'), null);
  assert.deepEqual(b.readdir(''), [
    { name: 'Data', size: 0, isDir: true, mtime: 0 },
    { name: 'Game.exe', size: 100, isDir: false, mtime: 9 },
    { name: 'data.txt', size: 1, isDir: false, mtime: 1 },
    { name: 'DATA', size: 3, isDir: false, mtime: 0 },
  ], 'directories first, then files, each in the tree\'s order');
  assert.deepEqual(b.readdir('data').map((e) => e.name), ['Maps', 'B.big', 'a.ini']);
  assert.equal(b.readdir('data.txt'), null, 'a file is not listed');
});
