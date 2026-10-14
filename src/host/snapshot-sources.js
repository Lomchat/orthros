// The sources a snapshot depends on (docs/snapshot.md, stage 2): a snapshot taken by one version of Orthros is restored
// only by a version whose state-owning code is the same. These are the modules the emulator worker loads — the machine,
// its API modules, the host set-up that builds its start — followed from their roots through their imports, except the
// executors and backends a restore rebuilds anyway: the JIT's translator (its tables are left out of a snapshot) and the
// GPU backends (a restored device is one they have never seen). Their frequent changes then keep snapshots valid.
// tests/snapshot-lint.test.js checks that no module left out registers snapshot state.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SNAPSHOT_SOURCE_ROOTS = Object.freeze(['src/core/vm.js', 'src/host/web/worker.js']);
/** Modules not followed: the JIT (but for the guest memory layout it shares with the API modules) and the GPU backends. */
export const notSnapshotSource = (rel) => (/^src\/cpu\/jit\//.test(rel) && rel !== 'src/cpu/jit/runtime.js') || /^src\/gfx\/[^/]+$/.test(rel);

const IMPORTS = [
  /\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g, // static imports, side-effect imports
  /\bexport\s+[^'"`;]*?\s+from\s+['"]([^'"]+)['"]/g, // re-exports
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic imports of a literal
  /\bnew\s+URL\(\s*['"]([^'"]+\.m?js)['"]\s*,\s*import\.meta\.url\s*\)/g, // workers
];

/** Every module in the closure (paths relative to `root`, '/'-separated, sorted). */
export function snapshotSourceFiles(root) {
  const seen = new Set(), todo = [...SNAPSHOT_SOURCE_ROOTS];
  while (todo.length) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let text; try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    for (const re of IMPORTS) for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (!spec.startsWith('.') && !spec.startsWith('/src/')) continue; // (node: builtins: the Node host only)
      const dep = spec.startsWith('/') ? spec.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (!notSnapshotSource(dep)) todo.push(dep);
    }
  }
  return [...seen].filter((f) => fs.existsSync(path.join(root, f))).sort();
}

let cache = null;
/** { hash, files }: SHA-256 of the closure's paths and contents (recomputed when one of them changed, at most every 10 s). */
export function snapshotSourcesHash(root) {
  const now = Date.now();
  if (cache?.root === root && now - cache.at < 10000) return cache.value;
  const files = snapshotSourceFiles(root);
  const stamp = files.map((f) => { try { const s = fs.statSync(path.join(root, f)); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return f; } }).join('\n');
  if (cache?.root === root && cache.stamp === stamp) { cache.at = now; return cache.value; }
  const h = crypto.createHash('sha256');
  for (const f of files) { h.update(f + '\0'); h.update(fs.readFileSync(path.join(root, f))); h.update('\0'); }
  const value = { hash: h.digest('hex').slice(0, 32), files: files.length };
  cache = { root, at: now, stamp, value };
  return value;
}
