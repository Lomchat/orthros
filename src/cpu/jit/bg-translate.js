// Background translation worker: translates guest code regions ahead of their first execution (the regions earlier
// sessions reached, see the page worker's region prewarm) on another thread, over the guest memory it shares with the
// emulator's worker, and sends them back compiled, several per module (Jit.bgInstall installs them).
// The game runs meanwhile and may be writing the very code being read: a region is sent only when its bytes were the
// same before and after its translation (a discovery pass gives its extent, the bytes are copied, the translation
// runs, the bytes are compared again), with that copy — the emulator installs it only if its memory still holds
// those bytes.
// With a persistent cache (init `cache`: code-cache.js, an OPFS file per game) a region whose extent, bytes and
// inline-API slots are those of an earlier session's translation by the same translator is not translated again.
import { GuestMemory } from '../memory.js';
import { translateRegion, buildRegionModule, discoverRegion, patchAltSlot } from './translate.js';
import { CodeCache, inlineDeps, hashText, moduleClosureText, openOpfsStore } from './code-cache.js';
import './translate-x87.js'; // (the translators register their handlers on import, as jit.js does)
import './translate-sse-float.js';
import './translate-sse-int.js';

let mem = null, opts = null, cache = null, cacheReady = null;

/** the bytes of the blocks' ranges, concatenated */
function snapshot(blocks) {
  let n = 0; for (const b of blocks) n += b.end - b.eip;
  const out = new Uint8Array(n);
  let o = 0; for (const b of blocks) { out.set(mem.u8.subarray(b.eip, b.end), o); o += b.end - b.eip; }
  return out;
}
const sameBytes = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const sameExtent = (a, b) => a.length === b.length && a.every((x, i) => x.eip === b[i].eip && x.end === b[i].end);
const sameDeps = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function translateBatch(items) {
  const codes = [], names = [], out = [];
  let hits = 0;
  for (const it of items) {
    const r = { eip: it.eip, fnIdx: it.fnIdx, fpc: it.fpc, k: -1 };
    out.push(r);
    try {
      const o = { ...opts, fnIdx: it.fnIdx, fpcAssume: it.fpc };
      const found = discoverRegion(mem, it.eip, o).blocks;
      const before = found.map((b) => ({ eip: b.eip, end: b.end }));
      if (!before.length) continue;
      const snap = snapshot(before);
      const deps = cache ? inlineDeps(found) : null;
      const hit = cache ? cache.lookup(it.eip, it.fpc, before, snap, deps) : null;
      if (hit) {
        // (the bytes read just now are the entry's: an earlier session's translation of exactly this code)
        const code = patchAltSlot(hit.code.slice(), hit.altAt, it.fnIdx); code.hints = hit.hints;
        r.k = codes.length; r.blocks = hit.blocks.map(([eip, end, index]) => ({ eip, end, index })); r.snap = snap; r.fpc = hit.fpcOut;
        r.stats = { ...hit.stats };
        codes.push(code); names.push('r_' + it.eip.toString(16)); hits++;
        continue;
      }
      const t = translateRegion(mem, it.eip, o);
      if (!sameExtent(before, t.blocks) || !sameBytes(snap, snapshot(t.blocks))) continue; // (the code changed meanwhile)
      r.k = codes.length; r.blocks = t.blocks; r.snap = snap; r.fpc = t.fpcAssume;
      r.stats = { native: t.stats.native, fallback: t.stats.fallback, calls: t.stats.calls, counters: t.stats.counters };
      codes.push(t.code); names.push('r_' + it.eip.toString(16));
      // (kept when the translation saw the inline-API slots this discovery saw: nothing changed in between)
      if (cache && sameDeps(deps, t.deps)) cache.add({ eip: it.eip, fpcIn: it.fpc, fpcOut: t.fpcAssume, altAt: t.altAt, blocks: t.blocks, deps, stats: r.stats, hints: t.code.hints, snap, code: t.code });
    } catch { /* undecodable: left to the emulator */ }
  }
  return { codes, names, out, hits };
}

/**
 * The persistent cache of this game's translations, or null: `c` = { name (the game), sources (module URLs whose
 * import closure is the translator: hashed into the key), store (tests: a store object instead of OPFS), key (tests:
 * the key itself) }.
 */
async function openCache(c) {
  if (opts.profile || opts.blockCounts) return null; // (instrumented translations: not kept)
  const key = c.key ?? `${hashText(await moduleClosureText(c.sources, (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); })))}|${JSON.stringify(opts)}`;
  const store = c.store ?? await openOpfsStore('orthros-jitcache', `${String(c.name).replace(/[^A-Za-z0-9._-]/g, '_')}.bin`);
  return new CodeCache(store, key, c.maxBytes);
}

function batch(m, reply) {
  const t0 = performance.now();
  const { codes, names, out, hits } = translateBatch(m.items);
  const t1 = performance.now();
  let module = null;
  if (codes.length) {
    try { module = new WebAssembly.Module(buildRegionModule(codes, names, mem.memory.buffer instanceof SharedArrayBuffer)); }
    catch { for (const r of out) r.k = -1; }
  }
  if (cache && cache.stats.added) cache.flush();
  const t2 = performance.now();
  reply({ type: 'batch', id: m.id, module, items: out, ms: t2 - t0, compileMs: t2 - t1, cacheHits: hits, cache: cache ? { ...cache.stats } : null });
}

/** A message from the emulator's worker; the answer (if any) goes through `reply` (tests call this directly). */
export function handleMessage(m, reply) {
  if (m.type === 'init') {
    mem = new GuestMemory({ memory: m.memory }); opts = m.opts; cache = null; cacheReady = null;
    if (m.cache) {
      // (batches wait for the cache, read once; without one — no OPFS, another tab holds it — nothing is kept)
      const ready = openCache(m.cache).then((c) => { cache = c; }, (e) => { cache = null; reply({ type: 'cache-error', message: String(e?.message ?? e) }); });
      cacheReady = ready; ready.then(() => { if (cacheReady === ready) cacheReady = null; });
    }
    return;
  }
  if (m.type !== 'batch' || !mem) return;
  if (cacheReady) cacheReady.then(() => batch(m, reply)); else batch(m, reply);
}
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) globalThis.onmessage = (e) => handleMessage(e.data, (r) => globalThis.postMessage(r));
