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
