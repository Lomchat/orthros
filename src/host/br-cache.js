// Precompressed transport units for /gamez (docs/slow-network.md "Precompressed units"), every runtime's game data:
// ranges of a file version (or of its light copy) kept on disk compressed at brotli's best (quality 11: ~20-28 % fewer
// bytes than the gzip-4 a request gets on the fly, measured on Morrowind, GTA and Half-Life data), served as they are
// to a request of exactly that shape that accepts br (Content-Encoding: br, the browser decodes it). A unit is a whole
// 1 MiB block — the file's tail for its last one — or a single 64 KiB piece (unitOf in src/vfs/http-backend.js: the
// shapes the shared reader asks for). Brotli 11 costs seconds of a core per MiB: units are made in the background by a
// forked child niced to 19 (src/host/br-cache-worker.js), one at a time, paused while the machine is loaded or the
// disk full — the launch sets first (every manifest's head side by side; one live miss every WANT_EVERY of their
// units meanwhile), then the units requests missed, then each launch set's blocks learned by pieces whole, then more of
// the learned orders; a request that misses goes the dynamic way and asks for its unit (the misses waiting kept across
// a restart: <dir>/wanted.json). Nothing is ever served stale: a unit's
// key is the file's resolved real path, size and mtime (and the light copy's shape), the generator checks the file
// before and after reading it, and a sweep removes the units of files gone or changed.
//
// Layout: <dir>/<k[0:2]>/<k>/ per file version (k: the key's sha1) — meta.json { path, size, mtimeMs, light, ... } and
// one file per unit, b<block>.br or p<piece>.br (an empty .raw when brotli saved too little: sent as is, never made
// again). Audio units (docs/slow-network.md "Audio units", src/vfs/pcm-codec.js): beside a unit, b<block>.pcm.br /
// p<piece>.pcm.br — its PCM transport container, brotli on top — for the requests that decode it (`&pc=1`), or an
// empty .pcm.raw (no sound found there, or it did not pay); waves.json: where the file's RIFF WAVE sounds are
// (src/host/pcm-units.js, found once per file version). Light copies have none. The index is rebuilt from the disk at
// start. Least recently used out when over `maxBytes`, down to `lowBytes`; the units of each manifest's launch set (the
// head of its learned order, `sources`) are pinned — out last, at most `pinShare` of the budget.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BLOCK, CHUNK } from '../vfs/http-backend.js';
import { LIGHT_SIDE, lightCopy } from './light-copies.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'br-cache-worker.js');
/** a unit kept compressed only when brotli makes it this much of its bytes at most (as the dynamic path's test) */
const MIN_GAIN = 0.92;
/** live misses waiting for their unit, at most (the oldest out first) */
const MAX_WANTED = 4096;
/**
 * one live miss made every this many launch-set units while the walk's first pass runs (see nextJob): that pass took
 * days on the live server — paused under load, its launch sets growing with each deploy, started again at each restart
 * —, and the misses waited behind all of it (2026-10-27: 291 of the owner's 451 BFME blocks missed five days earlier
 * still without a unit)
 */
export const WANT_EVERY = 8;
/** the live misses kept on the disk (a restart — each deploy — dropped them): <dir>/WANTED_FILE, written this long after a change */
const WANTED_FILE = 'wanted.json', WANTED_WRITE_MS = 5000;
/** the pinned part of an automatic budget: the launch sets' bytes times this (their sizes are estimates, a version's set grows) */
const PIN_SLACK = 1.25;

/** the unit's file name in its version's directory */
export const unitName = (u) => `${u.kind}${u.index}`;
/** the name of a unit's PCM transport form (pcm-codec.js) */
const PCM = '.pcm';
/** an audio unit kept when its wire bytes are this much of the brotli unit's at most */
export const PCM_MIN_GAIN = 0.95;
/** [start, end) of unit `u` of a file of `size` bytes */
export const unitRange = (u, size) => {
  const n = u.kind === 'b' ? BLOCK : CHUNK, start = u.index * n;
  return [start, Math.min(size, start + n)];
};

/**
 * The pinned budget `cap` split between the launch sets (`wants`: each one's bytes when known — its wire size, the
 * home's "playable after" —, else null): one whose size is known weighs it, one whose size is not an equal part of
 * the budget (as every one did before: Morrowind's 98 MB launch set was evictable past its 1/16, while small ones
 * left their part unused); what the known ones leave goes to all equally (the head of each order past its launch set).
 */
export function pinShares(wants, cap) {
  const n = wants.length; if (!n) return [];
  const equal = cap / n, weights = wants.map((w) => (Number.isFinite(w) && w > 0 ? w : equal));
  const total = weights.reduce((a, w) => a + w, 0);
  return total <= cap ? weights.map((w) => w + (cap - total) / n) : weights.map((w) => (w * cap) / total);
}

/**
 * The cache. opts: { dir, maxBytes (1.5 GiB — unset: at least that, grown to the launch sets, fitBudget, up to maxAutoBytes, 8 GiB, from minBytes, 1.5 GiB), lowBytes (0.9 × maxBytes), pinShare (0.5), sources: () => [{ name,
 * units: () => iterator of { file, st, light, unit }, want (bytes of its launch set, or null), whole (optional: () =>
 * iterator of the same — its launch set's blocks learned by pieces, whole: the shape a fast link asks for them, made
 * first in the second pass, unpinned) }] (the launch sets, in
 * their order: the first `pinShare` of the budget shared between them by their size (pinShares) is pinned, then more
 * of each while under `lowBytes`; walked side by side, made before the live misses for the pinned part, after them for
 * the rest — one live miss every WANT_EVERY of the pinned part's units: see nextJob), loadLimit (24: the 1-minute load
 * average generation waits under, half the machine's 48 cores), diskLimit (0.85: the disk's used fraction it waits
 * under), pauseMs (30000), idleMs (60000: the child kept that long without work), sweepMs (hourly: the sweep and the
 * launch sets again), log, onMade (tests: (file, unit) for each unit made), generate (false: nothing made — a frozen
 * copy served as it is, for measurements: tools/data-matrix.mjs) }.
 */
export function createBrCache(opts) {
  const dir = path.resolve(opts.dir);
  // (a budget that is not a positive number — NaN from a bad flag — would never evict, nor stop seeding: the default)
  const setBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : null;
  const baseBytes = setBytes ?? opts.minBytes ?? 1536 * 1024 * 1024, pinShare = opts.pinShare ?? 0.5;
  // (not set by the operator: the budget grows with the catalog's launch sets — see fitBudget —, up to maxAutoBytes)
  const maxAutoBytes = opts.maxAutoBytes ?? 8 * 1024 ** 3;
  let maxBytes = baseBytes, lowBytes = 0, pinCap = 0, pinWant = 0;
  const budget = (max) => {
    maxBytes = max;
    lowBytes = Number.isFinite(opts.lowBytes) && opts.lowBytes >= 0 ? opts.lowBytes : Math.floor(maxBytes * 0.9);
    pinCap = maxBytes * pinShare;
  };
  budget(baseBytes);
  /**
   * The budget for the launch sets `wants` (sources' bytes, null when unknown: the mean of the known ones): their sum
   * pinned with PIN_SLACK, the pinned share of a budget grown to hold it — the default 1.5 GiB held 0.8 GB pinned
   * where the catalog's 17 versions want ~1.3 GB: the units the launch sets need evicted each other, 2-30 % of them
   * made on the live server at a given time —; a budget set by the operator stays as set.
   */
  const fitBudget = (wants) => {
    const known = wants.filter((w) => Number.isFinite(w) && w > 0), mean = known.length ? known.reduce((a, w) => a + w, 0) / known.length : 0;
    pinWant = wants.reduce((a, w) => a + (Number.isFinite(w) && w > 0 ? w : mean), 0);
    if (setBytes === null) budget(Math.min(maxAutoBytes, Math.max(baseBytes, Math.ceil((pinWant * PIN_SLACK) / pinShare))));
  };
  const loadLimit = opts.loadLimit ?? 24, diskLimit = opts.diskLimit ?? 0.85, pauseMs = opts.pauseMs ?? 30000, idleMs = opts.idleMs ?? 60000;
  const log = opts.log ?? (() => {});
  // (audio units: on unless opts.pcm is false — never for a light copy)
  const pcmOn = opts.pcm !== false;
  const pcmFor = (light) => pcmOn && !light;
  fs.mkdirSync(dir, { recursive: true });

  /** k -> { dir, meta, units: Map(name -> { bytes, raw, lastHit, pinned }) } */
  const entries = new Map();
  let total = 0, pinnedBytes = 0;
  const counts = { hits: 0, misses: 0, generated: 0, stale: 0, failed: 0, evicted: 0, swept: 0, pcmHits: 0, pcmMade: 0 };
  let paused = null, closed = false;

  // ------------------------------------------------------------------------------------------- keys
  const reals = new Map(); // file -> its resolved real path (bounded: the oldest out)
  const realOf = (file) => {
    let r = reals.get(file);
    if (r === undefined) {
      try { r = fs.realpathSync.native(file); } catch { r = file; }
      reals.set(file, r); if (reals.size > 65536) reals.delete(reals.keys().next().value);
    }
    return r;
  };
  // (the light copy's shape in the key too: a new LIGHT_SIDE, or a copy made differently, is another version)
  // (lightFormat: a copy redrawn in place — a WAD's, light-copies.js lightWad — told apart from one cut from the file)
  const metaOf = (file, st, light) => ({ path: realOf(file), size: st.size, mtimeMs: st.mtimeMs, ...(light ? { light: true, lightSide: LIGHT_SIDE, lightSize: light.copy.size, lightFrom: light.copy.from, ...(light.copy.mips ? { lightFormat: 'wad1' } : {}) } : {}) });
  const keyOf = (meta) => crypto.createHash('sha1').update([meta.path, meta.size, meta.mtimeMs, meta.light ? `light\0${meta.lightSide}\0${meta.lightSize}\0${meta.lightFrom}${meta.lightFormat ? '\0' + meta.lightFormat : ''}` : ''].join('\0')).digest('hex');
  const dirOf = (k) => path.join(dir, k.slice(0, 2), k);
  const entryOf = (file, st, light, make = false) => {
    const meta = metaOf(file, st, light), k = keyOf(meta);
    let e = entries.get(k);
    if (!e && make) entries.set(k, e = { k, dir: dirOf(k), meta, units: new Map() });
    return e ? e : { k, dir: dirOf(k), meta, units: null };
  };

  // ------------------------------------------------------------------------------------------- index
  const addUnit = (e, name, bytes, raw, lastHit, pinned) => {
    const old = e.units.get(name);
    if (old) dropUnit(e, name, false);
    e.units.set(name, { bytes, raw, lastHit, pinned });
    total += bytes; if (pinned) pinnedBytes += bytes;
  };
  const dropUnit = (e, name, unlink = true) => {
    const u = e.units.get(name); if (!u) return;
    e.units.delete(name); total -= u.bytes; if (u.pinned) pinnedBytes -= u.bytes;
    if (unlink) fs.unlink(path.join(e.dir, name + (u.raw ? '.raw' : '.br')), () => {});
  };
  const dropEntry = (e) => {
    for (const name of [...e.units.keys()]) dropUnit(e, name, false);
    entries.delete(e.k);
    return fs.promises.rm(e.dir, { recursive: true, force: true }).catch(() => {});
  };
  const pin = (u) => { if (!u.pinned) { u.pinned = true; pinnedBytes += u.bytes; } };

  /** the index from the disk (unfinished files and directories without meta out) */
  const load = async () => {
    let tops; try { tops = await fs.promises.readdir(dir); } catch { return; }
    for (const top of tops) {
      if (!/^[0-9a-f]{2}$/.test(top)) continue;
      let ks; try { ks = await fs.promises.readdir(path.join(dir, top)); } catch { continue; }
      for (const k of ks) {
        const d = path.join(dir, top, k);
        let meta = null; try { meta = JSON.parse(await fs.promises.readFile(path.join(d, 'meta.json'), 'utf8')); } catch { /* none */ }
        if (!meta || keyOf(meta) !== k) { await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {}); continue; }
        const e = { k, dir: d, meta, units: new Map() };
        entries.set(k, e);
        let names; try { names = await fs.promises.readdir(d); } catch { names = []; }
        for (const n of names) {
          const m = /^([bp]\d+(?:\.pcm)?)\.(br|raw)$/.exec(n);
          if (!m) { if (n !== 'meta.json' && n !== 'waves.json') fs.unlink(path.join(d, n), () => {}); continue; }
          try { const s = await fs.promises.stat(path.join(d, n)); addUnit(e, m[1], s.size, m[2] === 'raw', s.mtimeMs, false); } catch { /* gone */ }
        }
      }
    }
  };

  /** the versions of files gone or changed out (and of light copies of another shape) */
  const sweep = async () => {
    for (const e of [...entries.values()]) {
      if (closed) return;
      let ok = e.units.size > 0 && (!e.meta.light || e.meta.lightSide === LIGHT_SIDE);
      if (ok) try { const s = await fs.promises.stat(e.meta.path); ok = s.isFile() && s.size === e.meta.size && s.mtimeMs === e.meta.mtimeMs; } catch { ok = false; }
      if (!ok && entries.get(e.k) === e && !(job && job.k === e.k)) { counts.swept++; await dropEntry(e); }
    }
  };

  /**
   * least recently used units out, the unpinned ones first, down to `to` bytes — never the raw markers (empty files:
   * nothing freed, brotli run again for them later; the sweep removes them once their file changed)
   */
  const evict = (to = lowBytes) => {
    if (total <= to) return;
    const all = [];
    for (const e of entries.values()) for (const [name, u] of e.units) if (u.bytes > 0) all.push([u.pinned ? 1 : 0, u.lastHit, e, name]);
    all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, , e, name] of all) {
      if (total <= to) break;
      dropUnit(e, name); counts.evicted++;
      if (!e.units.size && !(job && job.k === e.k)) dropEntry(e);
    }
  };
  const diskUse = () => { try { const s = fs.statfsSync(dir); return s.blocks ? 1 - s.bavail / s.blocks : 0; } catch { return 0; } };

  // ------------------------------------------------------------------------------------------- generation
  /** live misses: id -> { file, st, light, unit, count } (kept in WANTED_FILE: saveWanted, loadWanted) */
  const wanted = new Map();
  /** launch-set units made since the last live miss (the first pass: one miss every WANT_EVERY) */
  let seedRun = 0;
  /** the launch sets being walked: { sources: [{ name, it, used, share, done }], pass } */
  let seeding = null;
  let job = null, pumping = null, child = null, childIdle = null, nextId = 1;
  /** the launch sets' pinning under way (pinNow): nothing made before it is over */
  let seedPins = null;
  const replies = new Map();

  const startChild = () => {
    if (child) return child;
    child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
    try { os.setPriority(child.pid, 19); } catch { /* not allowed: as it is */ }
    const c = child;
    // (the ids sent to this child: its exit fails those only — a child started after it, while it was stopping, keeps its own)
    c.mine = new Set();
    c.on('message', (m) => { c.mine.delete(m.id); const r = replies.get(m.id); if (r) { replies.delete(m.id); r(m); } });
    c.on('exit', () => {
      if (child === c) child = null;
      for (const id of c.mine) { const r = replies.get(id); replies.delete(id); r?.({ id, error: 'generator exited' }); }
      c.mine.clear();
    });
    return c;
  };
  const stopChild = () => { const c = child; child = null; if (c) { try { c.disconnect(); } catch { /* gone */ } c.kill(); } };
  const ask = (msg) => new Promise((resolve) => {
    clearTimeout(childIdle);
    const c = startChild(), id = nextId++;
    c.channel?.ref?.();
    replies.set(id, resolve); c.mine.add(id);
    try { c.send({ ...msg, id }); } catch (e) { replies.delete(id); c.mine.delete(id); resolve({ id, error: String(e) }); }
  }).finally(() => {
    child?.channel?.unref?.(); // (an idle generator keeps no process alive)
    clearTimeout(childIdle); childIdle = setTimeout(stopChild, idleMs); childIdle.unref?.();
  });

  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); }); // (a paused generation keeps no process alive)
  /** waits while the machine is loaded or the disk too full (evicting meanwhile); false once closed */
  const free = async () => {
    for (;;) {
      if (closed) return false;
      const load = os.loadavg()[0], disk = diskUse();
      if (disk > diskLimit) evict();
      if (load < loadLimit && disk <= diskLimit) { paused = null; return true; }
      if (!paused) log(`br-cache: generation paused (load ${load.toFixed(1)}, disk ${(disk * 100).toFixed(0)} %)`);
      paused = { load, disk };
      await sleep(pauseMs);
    }
  };

  /** what of the unit is still to make: { br, pcm } (each true when missing), or null: nothing */
  const missing = (file, st, light, unit) => {
    const us = entryOf(file, st, light).units, name = unitName(unit);
    const br = !us?.has(name), pcm = pcmFor(light) && !us?.has(name + PCM);
    return br || pcm ? { br, pcm } : null;
  };
  /**
   * The next unit to make: the launch sets' (the first pass of the learned orders, pinned) first — every new player
   * asks for them, where a live miss is one session's read, that session served already —, but for the most asked live
   * miss every WANT_EVERY of them; then the live misses, then more of the learned orders (null: nothing). The orders are walked side by side, the one with the fewest
   * bytes made first: the head of every manifest's order before the tail of any (walked one after the other, the last
   * manifest's launch set waited for every other's share — hours of brotli 11).
   */
  const nextJob = async () => {
    const sd = seeding; // (read again meanwhile, hourly: that walk goes on instead)
    // (the first pass yields to the most asked live miss every WANT_EVERY units: that pass is hours of brotli 11 at
    // best, days when paused under load and started again at each restart — the misses never reached otherwise)
    if (sd && sd.pass === 0 && !(wanted.size && seedRun >= WANT_EVERY)) {
      const j = await nextSeed(sd);
      if (j) { seedRun++; return j; }
      if (seeding !== sd) return j;
    }
    // (a miss made meanwhile — by the walk, or asked before the index was loaded: every unit missing then — dropped
    // here, not spent: its slot would have made nothing, the real misses behind it waiting WANT_EVERY units more each)
    for (;;) {
      let best = null;
      for (const [id, w] of wanted) if (!best || w.count > best[1].count) best = [id, w];
      if (!best) break;
      wanted.delete(best[0]); wantedChanged();
      const w = best[1];
      if (missing(w.file, w.st, w.light, w.unit)) { seedRun = 0; return { ...w, pin: false }; }
    }
    return sd && seeding === sd ? nextSeed(sd) : null;
  };
  /** the next unit of the launch sets' walk `sd` not made yet, in its current pass (see nextJob), or null */
  const nextSeed = async (sd) => {
    let steps = 0;
    for (; sd.pass < 2; sd.pass++) {
      for (;;) {
        if (++steps % 64 === 0) await new Promise((r) => setImmediate(r)); // (the walk resolves paths: in slices)
        if (closed || seeding !== sd) return null;
        // first pass: each source's share of the pinned budget; second: more while under lowBytes
        if (sd.pass === 0 ? pinnedBytes >= pinCap : total >= lowBytes) break;
        // (the second pass: each source's launch-set blocks whole first — `whole` —, side by side, then its order's rest)
        let s = null, w = false;
        if (sd.pass > 0) for (const c of sd.sources) if (c.whole && (!s || c.used < s.used)) { s = c; w = true; }
        if (!s) for (const c of sd.sources) if (!c.done && (sd.pass > 0 || c.used < c.share) && (!s || c.used < s.used)) s = c;
        if (!s) break;
        const n = w ? s.whole.next() : s.it.next();
        if (n.done) { if (w) s.whole = null; else s.done = true; continue; }
        const { file, st, light, unit } = n.value;
        const e = entryOf(file, st, light), u = e.units?.get(unitName(unit)), up = e.units?.get(unitName(unit) + PCM);
        if (u && (up || !pcmFor(light))) { if (sd.pass === 0) { pin(u); if (up) pin(up); } s.used += u.bytes + (up?.bytes ?? 0); continue; }
        return { file, st, light, unit, pin: sd.pass === 0, source: s };
      }
      if (sd.pass === 0) { sd.pass = 1; return null; } // (the live misses before the second pass)
    }
    if (seeding === sd) seeding = null;
    return null;
  };

  const generate = async (j) => {
    const { file, light, unit } = j;
    let st; try { st = await fs.promises.stat(file); } catch { counts.stale++; return; }
    if (st.size !== j.st.size || st.mtimeMs !== j.st.mtimeMs) { counts.stale++; return; }
    const e = entryOf(file, st, light, true), name = unitName(unit);
    const old = e.units.get(name), br = !old, pcm = pcmFor(light) && !e.units.has(name + PCM);
    if (!br && !pcm) return;
    const [start, end] = unitRange(unit, light ? light.copy.size : st.size);
    if (!(start < end)) return;
    job = e;
    try {
      // (the audio form against the brotli unit's wire bytes: the one made now, or the one kept)
      const r = await ask({ file, size: st.size, mtimeMs: st.mtimeMs, light: light ? { head: light.copy.head, from: light.copy.from, size: light.copy.size, ...(light.copy.mips ? { mips: light.copy.mips } : {}) } : null, start, end, dir: e.dir, name, meta: e.meta, minGain: MIN_GAIN,
        br, pcm, brWire: old ? (old.raw ? end - start : old.bytes) : null, pcmGain: PCM_MIN_GAIN });
      if (r.error) { counts.failed++; log(`br-cache: ${file} ${name}: ${r.error}`); return; }
      if (r.stale) { counts.stale++; return; }
      if (closed || entries.get(e.k) !== e) return;
      const now = Date.now();
      if (br) addUnit(e, name, r.bytes, r.raw, now, j.pin && pinnedBytes + r.bytes <= pinCap);
      if (r.pcm) { addUnit(e, name + PCM, r.pcm.bytes, r.pcm.raw, now, j.pin && pinnedBytes + r.pcm.bytes <= pinCap); if (!r.pcm.raw) counts.pcmMade++; }
      if (j.source) j.source.used += (br ? r.bytes : 0) + (r.pcm?.bytes ?? 0);
      counts.generated++;
      opts.onMade?.(file, unit); // (tests: the order units are made in)
    } finally { job = null; }
    if (total > maxBytes) evict();
  };

  const pump = () => {
    if (pumping || closed || opts.generate === false) return pumping; // (frozen: a measurement serves what is there)
    pumping = (async () => {
      try {
        await ready;
        for (;;) {
          if (!(await free())) break;
          await seedPins; // (the launch sets pinned before anything is made: see pinNow)
          const j = await nextJob();
          if (!j) { if (seeding || wanted.size) continue; break; } // (the launch sets read again meanwhile: the new walk)
          await generate(j);
        }
      } catch (e) { log(`br-cache: ${e?.stack ?? e}`); } finally { pumping = null; }
    })();
    return pumping;
  };

  /**
   * The launch sets' units already made pinned at once, each source up to its share (the walk's first pass in order,
   * without making anything): until 2026-10-22 the pins were dropped at each reseed (start, hourly) and given back only
   * as the walk reached them — a walk that made one missing unit with the cache full evicted the oldest unpinned units
   * first, i.e. the launch sets made earliest of the sources not walked yet (live, 2026-10-22: Half-Life's and
   * Counter-Strike's launch sets gone while 1.5 GB of the cache held one session's misses).
   */
  const pinNow = async (list, shares, sd) => {
    let steps = 0;
    for (let i = 0; i < list.length; i++) {
      let used = 0;
      for (const { file, st, light, unit } of list[i].units()) {
        if (++steps % 256 === 0) await new Promise((r) => setImmediate(r)); // (in slices: requests go on meanwhile)
        if (closed || seeding !== sd || used >= shares[i]) break;
        // (its audio form too, counted as the walk counts it: nextSeed)
        const us = entryOf(file, st, light).units, name = unitName(unit);
        const u = us?.get(name), up = pcmFor(light) ? us?.get(name + PCM) : null;
        if (u) { pin(u); used += u.bytes; }
        if (up) { pin(up); used += up.bytes; }
      }
    }
  };
  const readSources = () => { let list = []; if (opts.sources) try { list = opts.sources() ?? []; } catch (e) { log(`br-cache: sources: ${e}`); } return list; };
  const reseed = () => {
    if (!opts.sources || closed) return;
    const list = readSources();
    fitBudget(list.map((s) => s.want));
    const shares = pinShares(list.map((s) => s.want), pinCap);
    const sd = seeding = list.length ? { sources: list.map((s, i) => ({ name: s.name, it: s.units()[Symbol.iterator](), whole: s.whole?.()[Symbol.iterator]() ?? null, used: 0, share: shares[i], done: false })), pass: 0 } : null;
    for (const e of entries.values()) for (const u of e.units.values()) u.pinned = false;
    pinnedBytes = 0;
    // (the pins first, then the walk that makes what is missing: no eviction meanwhile finds them unpinned)
    if (sd) seedPins = pinNow(list, shares, sd).catch((e) => log(`br-cache: pins: ${e}`));
    pump();
  };

  // ------------------------------------------------------------------------------------------- the misses kept
  // (a frozen copy — a measurement's — keeps its directory as it is: nothing written)
  const keepWanted = opts.generate !== false;
  const wantedPath = path.join(dir, WANTED_FILE);
  let wantedTimer = null;
  /**
   * the kept misses read back (loadWanted): nothing written before — a miss asked while the index loads (seconds on the
   * live cache, a restart with a player on) would otherwise write a file of that miss alone over the kept queue, before
   * it is read; `wantedDirty`: one asked meanwhile, written once loaded
   */
  let wantedLoaded = false, wantedDirty = false;
  /** the live misses as kept: [{ file, size, mtimeMs, light: { size, from } | null, unit: 'b3', count }] */
  const wantedList = () => [...wanted.values()].map((w) => ({ file: w.file, size: w.st.size, mtimeMs: w.st.mtimeMs,
    light: w.light ? { size: w.light.copy.size, from: w.light.copy.from } : null, unit: unitName(w.unit), count: w.count }));
  /** the misses written now (a new file renamed over the old one: never half of it) */
  const saveWanted = () => {
    clearTimeout(wantedTimer); wantedTimer = null;
    if (!keepWanted || !wantedLoaded) return;
    try { fs.writeFileSync(wantedPath + '.new', JSON.stringify(wantedList())); fs.renameSync(wantedPath + '.new', wantedPath); } catch (e) { log(`br-cache: ${WANTED_FILE}: ${e}`); }
  };
  /** the misses changed: written a few seconds later (a burst of misses, one write) */
  const wantedChanged = () => {
    if (!keepWanted || wantedTimer || closed) return;
    if (!wantedLoaded) { wantedDirty = true; return; }
    wantedTimer = setTimeout(saveWanted, WANTED_WRITE_MS); wantedTimer.unref?.();
  };
  /**
   * The misses an earlier process kept, those of files unchanged (size and mtime; a light copy of the same shape,
   * found again: lightCopy) and still missing, back in the queue — before the ones asked since, which they do not
   * replace (a count adds up; the ones asked since checked again too: asked before the index was loaded, every unit
   * was missing). Gathered apart, joined at once at the end: a miss asked during its stats is not overwritten.
   */
  const loadWanted = async () => {
    try { await readWanted(); } finally {
      wantedLoaded = true;
      if (wantedDirty || wanted.size) { wantedDirty = false; wantedChanged(); }
    }
  };
  const readWanted = async () => {
    let list; try { list = JSON.parse(await fs.promises.readFile(wantedPath, 'utf8')); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    const kept = new Map();
    for (const w of list.slice(-MAX_WANTED)) {
      const m = /^([bp])(\d+)$/.exec(w?.unit ?? ''); if (!m || typeof w.file !== 'string') continue;
      let st; try { st = await fs.promises.stat(w.file); } catch { continue; }
      if (!st.isFile() || st.size !== w.size || st.mtimeMs !== w.mtimeMs) continue;
      let light = null;
      if (w.light) {
        const copy = lightCopy(w.file, st);
        if (!copy || copy.size !== w.light.size || copy.from !== w.light.from) continue;
        light = { file: w.file, st, copy };
      }
      const unit = { kind: m[1], index: Number(m[2]) };
      if (!missing(w.file, st, light, unit)) continue;
      kept.set(`${entryOf(w.file, st, light).k}#${w.unit}`, { file: w.file, st: { size: st.size, mtimeMs: st.mtimeMs }, light, unit, count: Math.max(1, Number(w.count) || 1) });
    }
    for (const [id, w] of wanted) {
      if (!missing(w.file, w.st, w.light, w.unit)) continue;
      const o = kept.get(id); if (o) o.count += w.count; else kept.set(id, w);
    }
    wanted.clear();
    for (const [id, w] of kept) wanted.set(id, w);
    while (wanted.size > MAX_WANTED) wanted.delete(wanted.keys().next().value);
  };

  // (the budget fitted before anything is evicted: a restart kept what a grown budget held)
  // (a load that fails still reads the kept misses back before any is written: see wantedLoaded)
  const ready = (async () => { await load(); await sweep(); await loadWanted(); if (opts.sources) fitBudget(readSources().map((s) => s.want)); evict(maxBytes); })()
    .catch(async (e) => { log(`br-cache: load: ${e}`); if (!wantedLoaded) await loadWanted().catch((e2) => log(`br-cache: ${WANTED_FILE}: ${e2}`)); });
  ready.then(() => { reseed(); if (wanted.size) pump(); }); // (the misses kept: made even without launch sets)
  const timer = setInterval(() => { sweep().then(reseed); }, opts.sweepMs ?? 3600e3); timer.unref?.();

  return {
    dir,
    ready,
    /**
     * The unit `unit` of `file` (`st`: its fs.Stats; `light`: its light copy, resolveLightFile's), or null: { path,
     * bytes, raw } — raw: brotli saved too little, the range goes as it is.
     */
    lookup(file, st, light, unit) {
      const e = entryOf(file, st, light), name = unitName(unit), u = e.units?.get(name);
      if (!u) { counts.misses++; return null; }
      counts.hits++; u.lastHit = Date.now();
      return { path: path.join(e.dir, name + (u.raw ? '.raw' : '.br')), bytes: u.bytes, raw: u.raw };
    },
    /**
     * The unit's audio form (a PCM transport container, brotli on top: pcm-codec.js), for a request that decodes it, or
     * null (none: the brotli unit or the dynamic way then): { path, bytes }.
     */
    lookupPcm(file, st, light, unit) {
      if (!pcmFor(light)) return null;
      const e = entryOf(file, st, light), u = e.units?.get(unitName(unit) + PCM);
      if (!u || u.raw) return null;
      counts.pcmHits++; u.lastHit = Date.now();
      return { path: path.join(e.dir, unitName(unit) + PCM + '.br'), bytes: u.bytes };
    },
    /**
     * the bytes the unit `unit` of `file` takes on the wire when made (its compressed size, or raw's: its range's; its
     * audio form's when smaller — every page decodes it), else null: not a hit
     */
    size(file, st, light, unit) {
      const us = entryOf(file, st, light).units, u = us?.get(unitName(unit));
      if (!u) return null;
      const p = pcmFor(light) ? us.get(unitName(unit) + PCM) : null, pw = p && !p.raw ? p.bytes : Infinity;
      if (!u.raw) return Math.min(u.bytes, pw);
      const [start, end] = unitRange(unit, light ? light.copy.size : st.size);
      return Math.min(end - start, pw);
    },
    /** a unit found missing on the disk (evicted meanwhile, removed by hand): out of the index */
    drop(file, st, light, unit) { const e = entryOf(file, st, light); if (e.units) dropUnit(e, unitName(unit), false); },
    /** an audio form found missing or bad: out of the index (made again when asked) */
    dropPcm(file, st, light, unit) { const e = entryOf(file, st, light); if (e.units) dropUnit(e, unitName(unit) + PCM, true); },
    /** a request missed the unit: made next (before the launch sets), the most asked first */
    want(file, st, light, unit) {
      if (closed || !missing(file, st, light, unit)) return;
      const id = `${entryOf(file, st, light).k}#${unitName(unit)}`, w = wanted.get(id);
      if (w) w.count++;
      else {
        wanted.set(id, { file, st: { size: st.size, mtimeMs: st.mtimeMs }, light, unit, count: 1 });
        if (wanted.size > MAX_WANTED) wanted.delete(wanted.keys().next().value);
      }
      wantedChanged(); pump();
    },
    /** the launch sets read again (the learned orders changed) */
    reseed,
    sweep,
    /** resolves once nothing is left to make (tests) */
    async drain() { await ready; while (pumping) await pumping; },
    // (units: the brotli ones; pcmUnits: the audio forms made — their tried-and-not-kept markers not counted)
    stats: () => ({ units: [...entries.values()].reduce((n, e) => n + [...e.units.keys()].filter((k) => !k.endsWith(PCM)).length, 0),
      pcmUnits: [...entries.values()].reduce((n, e) => n + [...e.units].filter(([k, u]) => k.endsWith(PCM) && !u.raw).length, 0), bytes: total, pinnedBytes, pinCap: Math.round(pinCap), pinWant: Math.round(pinWant), maxBytes, wanted: wanted.size, seeding: !!seeding, paused, ...counts }),
    /** the live misses written now (a process about to exit: server.js's SIGTERM) */
    flush() { if (wantedTimer) saveWanted(); },
    close() { if (!closed && wantedTimer) saveWanted(); closed = true; clearInterval(timer); clearTimeout(childIdle); stopChild(); },
  };
}
