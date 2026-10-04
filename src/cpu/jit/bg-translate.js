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
import { translateRegion, buildRegionModule, discoverRegion, patchAltSlot, patchVisitSlots, patchSelfIdx, VisitSlots, JIT_DEFAULTS } from './translate.js';
import { CodeCache, inlineDeps, hashText, moduleClosureText, openOpfsStore } from './code-cache.js';
import { RangeHeat } from './heat.js';
import './translate-x87.js'; // (the translators register their handlers on import, as jit.js does)
import './translate-sse-float.js';
import './translate-sse-int.js';

let mem = null, opts = null, cache = null, cacheReady = null;
/** the cache's upkeep waits for this long without a batch (the learned regions in place, the game's new code rare) */
const IDLE_MS = 3000;
let idleTimer = null;
/**
 * Code heat shaping the regions (heat.js; Jit.heatAdd sends it: learned ranges, this session's visit flags) and this
 * thread's visit flags (translate.js VisitSlots). Kept apart from `opts`, the translation options hashed into the
 * cache's key: heat varies by session and grows during one. A translation is a function of its code bytes, its options
 * and two effects of the heat only: the extent discovery finds (cold exits) and the blocks given a visit flag (those
 * the heat does not know to have run). A cache entry is compared on the first, and kept with the second (`visits`):
 * see flagsCover / relocateVisits.
 */
let heat = null, visitSlots = null;
/** (no heat known: what discovery and the visit flags see then — the same translation as without any heat) */
const NO_HEAT = { get: () => 0, has: () => false };
/** (the flag byte of blocks a reused entry flags while the heat already knows them: set, never harvested) */
const SINK = -1;
/**
 * Does a cache entry flag every block of it heat `h` does not know to have run (a translation now would flag those)?
 * Its other flagged blocks are ones the heat learned since: their flag stores go to the sink byte (relocateVisits),
 * the body otherwise the translation of now.
 */
function flagsCover(meta, h) {
  if (!(opts.visit ?? JIT_DEFAULTS.visit)) return true; // (no visit flags: the heat is in the extent only)
  const flagged = new Set((meta.visits ?? []).map((v) => v[0]));
  for (const b of meta.blocks) if (!flagged.has(b[0]) && !h.has(b[0])) return false;
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
 * A cache entry's visit flags ([block, end, [body offsets]]) given this thread's flag bytes and heat `h`: { patch:
 * [[offset, address]], visits: [[block, end, address]] (Jit.harvestVisits) }, or null when the flag area is full (the
 * region is translated instead). A block the heat knows now flags the sink byte (a translation now would not flag
 * it: the same blocks reported to the harvest).
 */
function relocateVisits(list, h) {
  const patch = [], visits = [];
  for (const [eip, end, offs] of list ?? []) {
    const known = h.has(eip), a = visitSlots.get(mem, known ? SINK : eip); if (a < 0) return null;
    if (!known) visits.push([eip, end, a]);
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
      const h = heat ?? NO_HEAT;
      // (it.mode: the x87 mode to translate for, Jit.learnedMode; it.fpc: as the entry was learned, reported back)
      const mode = it.mode !== undefined ? it.mode : it.fpc;
      const o = { ...opts, ...over, heat: h, visitSlots, fnIdx: it.fnIdx, fpcAssume: mode };
      const found = discoverRegion(mem, it.eip, o).blocks;
      const before = found.map((b) => ({ eip: b.eip, end: b.end }));
      if (!before.length) continue;
      const snap = snapshot(before);
      // (in-session options, Jit.switchOpts: neither looked up nor kept — the cache's key holds the session's options)
      const useCache = cache && !over;
      const deps = useCache ? inlineDeps(found) : null;
      // (the same extent, and visit flags on every block the heat of now does not know: see flagsCover; entries of
      // the same code under an earlier heat's shape are superseded by the translation added below)
      const hit = useCache ? cache.lookup(it.eip, mode, before, snap, deps, (meta) => flagsCover(meta, h), mem.u8) : null;
      // (its visit flags moved to this session's: one byte per block address, see VisitSlots; none left: translated)
      const sites = hit ? relocateVisits(hit.visits, h) : null;
      if (hit && sites) {
        // (the bytes read just now are the entry's: an earlier session's translation of exactly this code, under the
        // same options, with the extent and the flagged blocks a translation now would have)
        const code = patchSelfIdx(patchVisitSlots(patchAltSlot(hit.code.slice(), hit.altAt, it.fnIdx), sites.patch), hit.stats?.selfSites, it.fnIdx); code.hints = hit.hints;
        r.k = codes.length; r.blocks = hit.blocks.map(([eip, end, index]) => ({ eip, end, index })); r.snap = snap; r.fpc = hit.fpcOut;
        r.stats = { ...hit.stats, visits: sites.visits };
        codes.push(code); names.push('r_' + it.eip.toString(16)); hits++;
        for (const b of r.blocks) covered.set(b.eip, it.eip);
        remember(it.eip, mode, found);
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
      // (kept when the translation saw the inline-API slots this discovery saw: nothing changed in between; with its
      // visit flags as [block, end, body offset] — their addresses are this session's; not kept when the flag area
      // ran out mid-region: fewer flags than the heat asked)
      if (useCache) keep(it.eip, mode, t, deps, snap);
      if (useCache) remember(it.eip, mode, found);
    } catch { /* undecodable: left to the emulator */ }
  }
  return { codes, names, out, hits, emitMs };
}

/** A translation into the cache (see translateBatch); false when not kept. */
function keep(eip, fpc, t, deps, snap) {
  if (!sameDeps(deps, t.deps) || t.stats.visitsCut) return false;
  const v = t.stats.visits ?? [], at = new Map(), sitesOf = t.stats.visitSites ?? [];
  for (let i = 0; i + 1 < sitesOf.length; i += 2) { const l = at.get(sitesOf[i]); if (l) l.push(sitesOf[i + 1]); else at.set(sitesOf[i], [sitesOf[i + 1]]); }
  const visits = v.map(([e, end]) => [e, end, at.get(e) ?? []]);
  const stats = { native: t.stats.native, fallback: t.stats.fallback, calls: t.stats.calls, counters: t.stats.counters, selfSites: t.stats.selfSites };
  return cache.add({ eip, fpcIn: fpc, fpcOut: t.fpcAssume, altAt: t.altAt, blocks: t.blocks, deps, stats, hints: t.code.hints, visits, snap, code: t.code });
}

// ---- Cached shapes brought up to the heat of the session's end. The heat grows during a session (visit flags
// harvested every 10 s): a region translated at its start under the heat learned then gets another shape (extent) at
// the next launch, under the heat this session taught — a miss, translated again while that session starts. When idle
// (the learned regions in place) the worker discovers again the regions it answered this session under the heat of
// now and keeps a translation of those whose shape changed (not installed: for the next sessions), again each time
// the heat grew (20 s apart at the soonest, once no batch came for a second). Only the regions the heat added since
// touches are discovered again (sensitive / touched); a pass runs in 10 ms slices, as long a pause after each (half a
// core at most), batches answered between them.
/**
 * this session's regions answered with the cache on: "eip:fpc" -> { eip, fpc, ext: [block, end, ...], sens: [lo, hi,
 * ...] (where the heat decides its discovery: its blocks — branch sources, visit flags — and its blocks' successors),
 * h: heatAdded then }
 */
let answered = new Map();
let heatAdded = 0, heatLog = []; // (heat pairs received so far: their number, the pairs)
let refresh = null, refreshTimer = null, refreshDoneAt = 0, refreshNext = 0, report = null;
const REFRESH_SLICE_MS = 10, REFRESH_GAP_MS = 20000, REFRESH_QUIET_MS = 1000;
let lastBatchAt = 0;
/** (the visit flags of translations not installed: the sink byte, relocated at reuse) */
const sinkSlots = { get: (m) => visitSlots.get(m, SINK) };
const extFlat = (blocks) => { const a = new Uint32Array(2 * blocks.length); blocks.forEach((b, i) => { a[2 * i] = b.eip; a[2 * i + 1] = b.end; }); return a; };
const sameFlat = (flat, blocks) => flat.length === 2 * blocks.length && blocks.every((b, i) => flat[2 * i] === b.eip && flat[2 * i + 1] === b.end);
/**
 * The heat decides a discovery through its answers for the blocks found (cold edges from their branches, visit flags)
 * and for those branches' successors only: when none of these addresses gained heat, the discovery is the same.
 */
export function sensitive(blocks) {
  const a = [];
  for (const b of blocks) {
    a.push(b.eip, b.end);
    const last = b.insns?.[b.insns.length - 1];
    if (!last) continue;
    a.push(last.next >>> 0, (last.next >>> 0) + 1);
    const v = last.ops?.[0]?.v;
    if (typeof v === 'number') a.push(v >>> 0, (v >>> 0) + 1); // (a direct target; any other operand: a needless check)
  }
  return Uint32Array.from(a);
}
/** does any range of `sens` overlap a range of `delta` (a merged RangeHeat)? */
export function touched(sens, delta) {
  const lo = delta.lo, hi = delta.hi;
  for (let i = 0; i < sens.length; i += 2) {
    const a = sens[i], b = sens[i + 1];
    let l = 0, h = lo.length - 1, k = -1;
    while (l <= h) { const m = (l + h) >> 1; if (lo[m] < b) { k = m; l = m + 1; } else h = m - 1; }
    if (k >= 0 && hi[k] > a) return true;
  }
  return false;
}
function remember(eip, fpc, blocks) {
  const k = `${eip}:${fpc}`;
  if (answered.size < 262144 || answered.has(k)) answered.set(k, { eip, fpc, ext: extFlat(blocks), sens: sensitive(blocks), h: heatAdded });
}
/**
 * A pass starts when the heat grew since the last one, REFRESH_GAP_MS after it at the soonest, once no batch came for
 * REFRESH_QUIET_MS (the learned regions translated first); once started it goes on between batches.
 */
function refreshIdle() {
  if (!cache?.refreshOn || !heat || refreshTimer) return;
  if (!refresh) {
    if (heatAdded === refreshDoneAt || !answered.size) return;
    const now = performance.now(), wait = Math.max(refreshNext - now, lastBatchAt + REFRESH_QUIET_MS - now);
    if (wait > 0) { refreshTimer = setTimeout(() => { refreshTimer = null; refreshIdle(); }, wait); refreshTimer.unref?.(); return; }
    // (the heat added since the last pass: a region none of whose sensitive addresses gained heat keeps its shape)
    const delta = new RangeHeat(); delta.addPairs(heatLog.slice(2 * refreshDoneAt, 2 * heatAdded)); delta.merge();
    refresh = { list: [...answered.values()], i: 0, at: heatAdded, delta };
  }
  refreshStep();
}
function refreshStep() {
  refreshTimer = null;
  const r = refresh, c = cache, t0 = performance.now(), st = c.stats;
  while (r.i < r.list.length && performance.now() - t0 < REFRESH_SLICE_MS) {
    const it = r.list[r.i++];
    if (it.h === r.at || (covered.has(it.eip) && covered.get(it.eip) !== it.eip)) continue; // (no heat came since)
    it.h = r.at;
    if (!touched(it.sens, r.delta)) continue;
    try {
      const h = heat, o = { ...opts, heat: h, visitSlots: sinkSlots, fnIdx: 0, fpcAssume: it.fpc };
      const found = discoverRegion(mem, it.eip, o).blocks;
      st.refreshChecked = (st.refreshChecked ?? 0) + 1;
      if (!found.length || sameFlat(it.ext, found)) continue;
      const before = found.map((b) => ({ eip: b.eip, end: b.end })), snap = snapshot(before), deps = inlineDeps(found);
      // (its new shape already there — another session's —, else translated; the shape it replaces superseded)
      if (!c.lookup(it.eip, it.fpc, before, snap, deps, (meta) => flagsCover(meta, h), mem.u8, false)) {
        const te = performance.now(), t = translateRegion(mem, it.eip, o);
        st.refreshMs = (st.refreshMs ?? 0) + performance.now() - te;
        if (!sameExtent(before, t.blocks) || !sameBytes(snap, snapshot(t.blocks)) || !keep(it.eip, it.fpc, t, deps, snap)) continue;
        st.refreshed = (st.refreshed ?? 0) + 1;
      }
      it.ext = extFlat(before); it.sens = sensitive(found);
    } catch { /* undecodable now */ }
  }
  st.refreshBusyMs = (st.refreshBusyMs ?? 0) + performance.now() - t0;
  // (half of a core at most: as long a pause after each slice)
  if (r.i < r.list.length) { refreshTimer = setTimeout(refreshStep, REFRESH_SLICE_MS); refreshTimer.unref?.(); return; }
  // (done: the next pass once the heat grew again, REFRESH_GAP_MS later at the soonest)
  refresh = null; refreshDoneAt = r.at; st.refreshPasses = (st.refreshPasses ?? 0) + 1;
  refreshNext = performance.now() + (c.refreshGapMs ?? REFRESH_GAP_MS);
  if (st.refreshed) { c.flush(); c.flushedAt = performance.now(); }
  report?.({ type: 'cache-stats', cache: { ...st } }); // (the emulator's view of the cache: no batch carries it now)
}

/**
 * The persistent cache of this game's translations, or null: `c` = { name (the game), sources (module URLs whose
 * import closure is the translator: hashed into the key), store (tests: a store object instead of OPFS), key (tests:
 * the key itself) }.
 */
async function openCache(c) {
  if (opts.profile || opts.blockCounts) return null; // (instrumented translations: not kept)
  // (the options as sent and the defaults they complete — layout, cold exits and their threshold, visit flags, region
  // sizes...: every option changing the code; the heat is per entry, see flagsCover)
  const key = c.key ?? `${hashText(await moduleClosureText(c.sources, (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); })))}|${JSON.stringify(opts)}|${JSON.stringify(JIT_DEFAULTS)}`;
  const store = c.store ?? await openOpfsStore('orthros-jitcache', `${String(c.name).replace(/[^A-Za-z0-9._-]/g, '_')}.bin`);
  const cc = new CodeCache(store, key, c.maxBytes);
  if (c.idleMs !== undefined) cc.idleMs = c.idleMs; // (tests)
  if (c.refreshGapMs !== undefined) cc.refreshGapMs = c.refreshGapMs;
  cc.refreshOn = c.refresh !== false; // (tests: off)
  return cc;
}

/**
 * No batch (nor heat) for IDLE_MS: the cache's room made (eviction, compaction: see CodeCache.maintain), what was added
 * flushed, then the shapes of this session's regions brought up to the grown heat (refreshIdle).
 */
function armIdle() {
  if (!cache) return;
  clearTimeout(idleTimer);
  const c = cache;
  idleTimer = setTimeout(() => { if (cache !== c) return; c.maintain(); if (c.stats.added) { c.flush(); c.flushedAt = performance.now(); } refreshIdle(); }, c.idleMs ?? IDLE_MS);
  idleTimer.unref?.(); // (Node tests: no wait for it at exit)
}

function batch(m, reply) {
  const t0 = lastBatchAt = performance.now();
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
  armIdle();
  reply({ type: 'batch', id: m.id, module, items: out, ms: t2 - t0, compileMs: t2 - t1, translateMs: emitMs, cacheHits: hits, cache: cache ? { ...cache.stats } : null });
}

/** A message from the emulator's worker; the answer (if any) goes through `reply` (tests call this directly). */
export function handleMessage(m, reply) {
  if (m.type === 'init') {
    mem = new GuestMemory({ memory: m.memory }); opts = m.opts; cache = null; cacheReady = null; covered = new Map();
    heat = null; visitSlots = new VisitSlots(); // (this thread's visit flags)
    answered = new Map(); heatAdded = 0; heatLog = []; refresh = null; clearTimeout(refreshTimer); refreshTimer = null; refreshDoneAt = 0; refreshNext = 0; lastBatchAt = 0; report = reply;
    if (m.cache) {
      // (batches wait for the cache, read once; without one — no OPFS, another tab holds it — nothing is kept)
      const ready = openCache(m.cache).then((c) => { cache = c; }, (e) => { cache = null; reply({ type: 'cache-error', message: String(e?.message ?? e) }); });
      cacheReady = ready; ready.then(() => { if (cacheReady === ready) cacheReady = null; });
    }
    return;
  }
  if (m.type === 'heat') { if (opts) { heat ??= new RangeHeat(); heat.addPairs(m.pairs); heatAdded += m.pairs.length >> 1; for (const x of m.pairs) heatLog.push(x); if (answered.size) { armIdle(); refreshIdle(); } } return; } // (see Jit.heatAdd)
  // (a region the emulator did not install — its code changed —: its blocks are no longer covered by it)
  if (m.type === 'uncover') { for (const [entry, eips] of m.regions) for (const e of eips) if (covered.get(e) === entry) covered.delete(e); return; }
  if (m.type === 'cache-stats') { reply({ type: 'cache-stats', cache: cache ? { ...cache.stats } : null }); return; } // (tests)
  if (m.type !== 'batch' || !mem) return;
  if (cacheReady) cacheReady.then(() => batch(m, reply)); else batch(m, reply);
}
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) globalThis.onmessage = (e) => handleMessage(e.data, (r) => globalThis.postMessage(r));
