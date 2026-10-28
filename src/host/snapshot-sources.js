// The sources a snapshot depends on (docs/snapshot.md, stage 2): a snapshot taken by one version of Orthros is restored
// only by a version whose state-owning code is the same. These are the modules the emulator worker loads — the machine,
// its API modules, the host set-up that builds its start — followed from their roots through their imports, except the
// executors and backends a restore rebuilds anyway: the JIT's translator (its tables are left out of a snapshot) and the
// GPU backends (a restored device is one they have never seen) —, and the game data's transport, the host side of the
// game files (the mounts are host objects, state:false in src/core/vm-snapshot.js, a file reopened by its path): how
// bytes come (http-backend.js, net-link.js, opfs-store.js, pcm-codec.js through them), when (game-data.js,
// launch-set.js, playable-watch.js) and when a snapshot is taken (snapshot-watch.js). Their frequent changes then keep
// snapshots valid — until 2026-10-28 48 of the 246 key changes of the month were data-only commits (the 4 of
// 10-27), each a cold start of 35-50 s to the menu for a returning player instead of a restore. Which files the guest
// sees and their sizes stay in the key through the version's tree itself (src/host/web/snapshot-key.js); game-tree.js
// (KEPT) holds only the tree's helpers. How the guest's stat/readdir/open are answered from that tree — case folding,
// a listing's order, a directory's date: HttpBackend.lookup/stat/readdir — is out with http-backend.js, pinned by a
// test instead (tests/snapshot-lint.test.js): a change there fails it and must change the key too (moved into a kept
// module), never ship as a data-only deploy. (Which part serves a file, game-data.js's partOf, is out as well: the
// owner's copy holds the same bytes.) tests/snapshot-lint.test.js also checks that no module left out registers snapshot
// state, and that the data modules are out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SNAPSHOT_SOURCE_ROOTS = Object.freeze(['src/core/vm.js', 'src/host/web/worker.js']);
/** The game data's host side (see above): not followed. */
export const DATA_TRANSPORT = Object.freeze(['src/vfs/game-data.js', 'src/vfs/http-backend.js', 'src/vfs/launch-set.js', 'src/vfs/net-link.js',
  'src/vfs/opfs-store.js', 'src/vfs/playable-watch.js', 'src/host/snapshot-watch.js']);
/** Modules kept in the closure though reached only through the data transport: the game tree's helpers (game-tree.js). */
export const KEPT = Object.freeze(['src/vfs/game-tree.js']);
/**
 * Modules not followed: the JIT (but for the guest memory layout it shares with the API modules), the GPU backends and
 * the game data's transport.
 */
export const notSnapshotSource = (rel) => (/^src\/cpu\/jit\//.test(rel) && rel !== 'src/cpu/jit/runtime.js') || /^src\/gfx\/[^/]+$/.test(rel) || DATA_TRANSPORT.includes(rel);

const IMPORTS = [
  /\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g, // static imports, side-effect imports
  /\bexport\s+[^'"`;]*?\s+from\s+['"]([^'"]+)['"]/g, // re-exports
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic imports of a literal
  /\bnew\s+URL\(\s*['"]([^'"]+\.m?js)['"]\s*,\s*import\.meta\.url\s*\)/g, // workers
];

/** Every module in the closure (paths relative to `root`, '/'-separated, sorted). */
export function snapshotSourceFiles(root) {
  const seen = new Set(), todo = [...SNAPSHOT_SOURCE_ROOTS, ...KEPT];
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
