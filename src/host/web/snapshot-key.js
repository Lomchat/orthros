// The key a snapshot of the machine is kept under (docs/snapshot.md): the page's own snapshot in OPFS and the server's
// shared one are used only by a session whose key is the same — Orthros' state-owning sources (/api/snapshot-sources),
// the game version's manifest and files, the game language and the page's options that change the machine. The debug
// flags that only measure the host (gpu-probe.js HOST_ONLY_DBG) are not among them: a ?bench page adds ORTHROS_GL_COUNT,
// and until 2026-10-27 that alone gave it a key no publishing session (tools/snapshot-publish.mjs, a plain page) could
// match — every shared-snapshot job a bench queued failed.
import { HOST_ONLY_DBG } from '../../gfx/gpu-probe.js';

/** `dbg` (the page's ?dbg=, "K=V,K=V") without the host-only flags, its order kept: the part a snapshot's key covers. */
export const machineDbg = (dbg) => String(dbg ?? '').split(',').filter((kv) => kv && !HOST_ONLY_DBG.includes(kv.split('=')[0])).join(',');

/**
 * The key of a snapshot of game `name` (a hex string, 32 digits): `sources` the state-owning sources' hash, `manifest`
 * and `tree` the version's, `opts` the worker's start options (main.js) — those that change the machine only.
 */
export async function snapshotKey(sources, name, manifest, tree, opts) {
  const machine = { lang: opts.gameLanguage, timeScale: opts.timeScale, interp: opts.interp, interpRange: opts.interpRange, dbg: machineDbg(opts.dbg), jitOpts: opts.jitOpts, noF32: opts.noF32, f32Off: opts.f32Off };
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ sources, name, manifest, tree, machine })));
  return Array.from(new Uint8Array(d).subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
