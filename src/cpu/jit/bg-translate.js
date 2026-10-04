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
import { translateRegion, buildRegionModule, discoverRegion, patchAltSlot, patchVisitSlots, VisitSlots, JIT_DEFAULTS } from './translate.js';
import { CodeCache, inlineDeps, hashText, moduleClosureText, openOpfsStore } from './code-cache.js';
import { RangeHeat } from './heat.js';
import './translate-x87.js'; // (the translators register their handlers on import, as jit.js does)
import './translate-sse-float.js';
import './translate-sse-int.js';

let mem = null, opts = null, cache = null, cacheReady = null;
/**
 * Code heat shaping the regions (heat.js; Jit.heatAdd sends it: learned ranges, this session's visit flags) and this
 * thread's visit flags (translate.js VisitSlots). Kept apart from `opts`, the translation options hashed into the
 * cache's key: heat varies by session and grows during one — it is recorded per cache entry instead (heatRecorder).
 */
let heat = null, visitSlots = null;
/** (no heat known: what discovery and the visit flags see then — the same translation as without any heat) */
const NO_HEAT = { get: () => 0, has: () => false };
/**
 * The heat as translations see it, every answer recorded: `log` maps an address to the queries made of it (bit 0:
 * get asked, bit 1: get(a) >= coldMin; bit 2: has asked, bit 3: has(a)). A translation is a function of its code
 * bytes, its options and these answers only (discovery's cold edges, the blocks given visit flags): a cache entry
 * keeps them, and is reused only where the heat of now gives the same answers (heatAnswers / sameHeat).
 */
function heatRecorder(h, coldMin) {
  const log = new Map();
  return {
    log,
    get(a) { const v = h.get(a) ?? 0; log.set(a, (log.get(a) ?? 0) | 1 | (v >= coldMin ? 2 : 0)); return v; },
    has(a) { const v = !!h.has(a); log.set(a, (log.get(a) ?? 0) | 4 | (v ? 8 : 0)); return v; },
  };
}
/** a recorder's answers, flat [address, bits, ...] in address order (a cache entry's `heat`) */
const heatAnswers = (log) => [...log].sort((x, y) => x[0] - y[0]).flat();
/** does heat `h` give the answers recorded? */
function sameHeat(answers, h, coldMin) {
  if (!Array.isArray(answers)) return false;
  for (let i = 0; i + 1 < answers.length; i += 2) {
    const a = answers[i], bits = answers[i + 1];
    if (bits & 1 && ((h.get(a) ?? 0) >= coldMin) !== !!(bits & 2)) return false;
    if (bits & 4 && !!h.has(a) !== !!(bits & 8)) return false;
  }
  return true;
}
/**
 * Block addresses of the regions this worker translated in this session. A learned entry that is a block of another
 * of them is not translated: the emulator would drop it at install (its address is a block of a region installed
 * before it, entered through the block hash), so translating it — and keeping it in the cache — is wasted work. The
 * emulator says which regions it did not install ('uncover': their code changed): their blocks are free again.
 */
let covered = new Map(); // block address -> entry of the region holding it

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

/**
 * A cache entry's visit flags ([block, end, [body offsets]]) given this thread's flag bytes: { patch: [[offset,
 * address]], visits: [[block, end, address]] (Jit.harvestVisits) }, or null when the flag area is full (the region is
 * translated instead).
 */
function relocateVisits(list) {
  const patch = [], visits = [];
  for (const [eip, end, offs] of list ?? []) {
    const a = visitSlots.get(mem, eip); if (a < 0) return null;
    visits.push([eip, end, a]);
    for (const o of offs) patch.push([o, a]);
  }
  return { patch, visits: visits.length ? visits : undefined };
}

function translateBatch(items, over) {
  const codes = [], names = [], out = [];
  let hits = 0, emitMs = 0;
  for (const it of items) {
    const r = { eip: it.eip, fnIdx: it.fnIdx, fpc: it.fpc, k: -1 };
    out.push(r);
    if (covered.has(it.eip) && covered.get(it.eip) !== it.eip) { r.covered = true; continue; }
    try {
      const coldMin = over?.coldMin ?? opts.coldMin ?? JIT_DEFAULTS.coldMin, rec = heatRecorder(heat ?? NO_HEAT, coldMin);
      // (it.mode: the x87 mode to translate for, Jit.learnedMode; it.fpc: as the entry was learned, reported back)
      const mode = it.mode !== undefined ? it.mode : it.fpc;
      const o = { ...opts, ...over, heat: rec, visitSlots, fnIdx: it.fnIdx, fpcAssume: mode };
      const found = discoverRegion(mem, it.eip, o).blocks;
      const before = found.map((b) => ({ eip: b.eip, end: b.end }));
      if (!before.length) continue;
      const snap = snapshot(before);
      // (in-session options, Jit.switchOpts: neither looked up nor kept — the cache's key holds the session's options)
      const useCache = cache && !over;
      const deps = useCache ? inlineDeps(found) : null;
      // (an entry made under other heat answers is not this translation: see heatRecorder)
      const hit = useCache ? cache.lookup(it.eip, mode, before, snap, deps, (meta) => sameHeat(meta.heat, heat ?? NO_HEAT, coldMin)) : null;
      // (its visit flags moved to this session's: one byte per block address, see VisitSlots; none left: translated)
      const sites = hit ? relocateVisits(hit.visits) : null;
      if (hit && sites) {
        // (the bytes read just now are the entry's: an earlier session's translation of exactly this code, under the
        // same options and the same heat answers)
        const code = patchVisitSlots(patchAltSlot(hit.code.slice(), hit.altAt, it.fnIdx), sites.patch); code.hints = hit.hints;
        r.k = codes.length; r.blocks = hit.blocks.map(([eip, end, index]) => ({ eip, end, index })); r.snap = snap; r.fpc = hit.fpcOut;
        r.stats = { ...hit.stats, visits: sites.visits };
        codes.push(code); names.push('r_' + it.eip.toString(16)); hits++;
        for (const b of r.blocks) covered.set(b.eip, it.eip);
        continue;
      }
      const te = performance.now();
      const t = translateRegion(mem, it.eip, o);
      emitMs += performance.now() - te;
      if (!sameExtent(before, t.blocks) || !sameBytes(snap, snapshot(t.blocks))) continue; // (the code changed meanwhile)
      r.k = codes.length; r.blocks = t.blocks; r.snap = snap; r.fpc = t.fpcAssume;
      const stats = { native: t.stats.native, fallback: t.stats.fallback, calls: t.stats.calls, counters: t.stats.counters };
      r.stats = { ...stats, visits: t.stats.visits };
      codes.push(t.code); names.push('r_' + it.eip.toString(16));
      for (const b of t.blocks) covered.set(b.eip, it.eip);
      // (kept when the translation saw the inline-API slots this discovery saw: nothing changed in between; with the
      // heat answers it was made under, and its visit flags as [block, end, body offset] — their addresses are this
      // session's; not kept when the flag area ran out mid-region: fewer flags than the heat asked)
      if (useCache && sameDeps(deps, t.deps) && !t.stats.visitsCut) {
        const v = t.stats.visits ?? [], at = new Map(), sitesOf = t.stats.visitSites ?? [];
        for (let i = 0; i + 1 < sitesOf.length; i += 2) { const l = at.get(sitesOf[i]); if (l) l.push(sitesOf[i + 1]); else at.set(sitesOf[i], [sitesOf[i + 1]]); }
        const visits = v.map(([eip, end]) => [eip, end, at.get(eip) ?? []]);
        cache.add({ eip: it.eip, fpcIn: mode, fpcOut: t.fpcAssume, altAt: t.altAt, blocks: t.blocks, deps, stats, hints: t.code.hints, heat: heatAnswers(rec.log), visits, snap, code: t.code });
      }
    } catch { /* undecodable: left to the emulator */ }
  }
  return { codes, names, out, hits, emitMs };
}

/**
 * The persistent cache of this game's translations, or null: `c` = { name (the game), sources (module URLs whose
 * import closure is the translator: hashed into the key), store (tests: a store object instead of OPFS), key (tests:
 * the key itself) }.
 */
async function openCache(c) {
  if (opts.profile || opts.blockCounts) return null; // (instrumented translations: not kept)
  // (the options as sent and the defaults they complete — layout, cold exits and their threshold, visit flags, region
  // sizes...: every option changing the code; the heat is per entry, see heatRecorder)
  const key = c.key ?? `${hashText(await moduleClosureText(c.sources, (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); })))}|${JSON.stringify(opts)}|${JSON.stringify(JIT_DEFAULTS)}`;
  const store = c.store ?? await openOpfsStore('orthros-jitcache', `${String(c.name).replace(/[^A-Za-z0-9._-]/g, '_')}.bin`);
  return new CodeCache(store, key, c.maxBytes);
}

function batch(m, reply) {
  const t0 = performance.now();
  const { codes, names, out, hits, emitMs } = translateBatch(m.items, m.over ?? null);
  const t1 = performance.now();
  let module = null;
  if (codes.length) {
    try { module = new WebAssembly.Module(buildRegionModule(codes, names, mem.memory.buffer instanceof SharedArrayBuffer)); }
    catch { for (const r of out) { if (r.k >= 0) for (const b of r.blocks) if (covered.get(b.eip) === r.eip) covered.delete(b.eip); r.k = -1; } }
  }
  const t2 = performance.now();
  // (written records reach the disk at the next flush — a costly sync: at most every 5 s; a session ended before
  // keeps what was flushed, a record cut short is dropped at the next load)
  if (cache && cache.stats.added && t2 - (cache.flushedAt ?? 0) > 5000) { cache.flush(); cache.flushedAt = performance.now(); }
  reply({ type: 'batch', id: m.id, module, items: out, ms: t2 - t0, compileMs: t2 - t1, translateMs: emitMs, cacheHits: hits, cache: cache ? { ...cache.stats } : null });
}

/** A message from the emulator's worker; the answer (if any) goes through `reply` (tests call this directly). */
export function handleMessage(m, reply) {
  if (m.type === 'init') {
    mem = new GuestMemory({ memory: m.memory }); opts = m.opts; cache = null; cacheReady = null; covered = new Map();
    heat = null; visitSlots = new VisitSlots(); // (this thread's visit flags)
    if (m.cache) {
      // (batches wait for the cache, read once; without one — no OPFS, another tab holds it — nothing is kept)
      const ready = openCache(m.cache).then((c) => { cache = c; }, (e) => { cache = null; reply({ type: 'cache-error', message: String(e?.message ?? e) }); });
      cacheReady = ready; ready.then(() => { if (cacheReady === ready) cacheReady = null; });
    }
    return;
  }
  if (m.type === 'heat') { if (opts) { heat ??= new RangeHeat(); heat.addPairs(m.pairs); } return; } // (see Jit.heatAdd)
  // (a region the emulator did not install — its code changed —: its blocks are no longer covered by it)
  if (m.type === 'uncover') { for (const [entry, eips] of m.regions) for (const e of eips) if (covered.get(e) === entry) covered.delete(e); return; }
  if (m.type !== 'batch' || !mem) return;
  if (cacheReady) cacheReady.then(() => batch(m, reply)); else batch(m, reply);
}
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) globalThis.onmessage = (e) => handleMessage(e.data, (r) => globalThis.postMessage(r));
