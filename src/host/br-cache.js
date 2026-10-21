// Precompressed transport units for /gamez (docs/slow-network.md "Precompressed units"), every runtime's game data:
// ranges of a file version (or of its light copy) kept on disk compressed at brotli's best (quality 11: ~20-28 % fewer
// bytes than the gzip-4 a request gets on the fly, measured on Morrowind, GTA and Half-Life data), served as they are
// to a request of exactly that shape that accepts br (Content-Encoding: br, the browser decodes it). A unit is a whole
// 1 MiB block — the file's tail for its last one — or a single 64 KiB piece (unitOf in src/vfs/http-backend.js: the
// shapes the shared reader asks for). Brotli 11 costs seconds of a core per MiB: units are made in the background by a
// forked child niced to 19 (src/host/br-cache-worker.js), one at a time, paused while the machine is loaded or the
// disk full; a request that misses goes the dynamic way and asks for its unit. Nothing is ever served stale: a unit's
// key is the file's resolved real path, size and mtime (and the light copy's shape), the generator checks the file
// before and after reading it, and a sweep removes the units of files gone or changed.
//
// Layout: <dir>/<k[0:2]>/<k>/ per file version (k: the key's sha1) — meta.json { path, size, mtimeMs, light, ... } and
// one file per unit, b<block>.br or p<piece>.br (an empty .raw when brotli saved too little: sent as is, never made
// again). The index is rebuilt from the disk at start. Least recently used out when over `maxBytes`, down to
// `lowBytes`; the units of each manifest's launch set (the head of its learned order, `sources`) are pinned — out last,
// at most `pinShare` of the budget.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BLOCK, CHUNK } from '../vfs/http-backend.js';
import { LIGHT_SIDE } from './light-copies.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'br-cache-worker.js');
/** a unit kept compressed only when brotli makes it this much of its bytes at most (as the dynamic path's test) */
const MIN_GAIN = 0.92;
/** live misses waiting for their unit, at most (the oldest out first) */
const MAX_WANTED = 4096;

/** the unit's file name in its version's directory */
export const unitName = (u) => `${u.kind}${u.index}`;
/** [start, end) of unit `u` of a file of `size` bytes */
export const unitRange = (u, size) => {
  const n = u.kind === 'b' ? BLOCK : CHUNK, start = u.index * n;
  return [start, Math.min(size, start + n)];
};

/**
 * The cache. opts: { dir, maxBytes (1.5 GiB), lowBytes (0.9 × maxBytes), pinShare (0.5), sources: () => [{ name,
 * units: () => iterator of { file, st, light, unit } }] (the launch sets, in their order: the first `pinShare` of the
 * budget shared between them is pinned, then more of each while under `lowBytes`), loadLimit (24: the 1-minute load
 * average generation waits under, half the machine's 48 cores), diskLimit (0.85: the disk's used fraction it waits
 * under), pauseMs (30000), idleMs (60000: the child kept that long without work), sweepMs (hourly: the sweep and the
 * launch sets again), log }.
 */
export function createBrCache(opts) {
  const dir = path.resolve(opts.dir);
  const maxBytes = opts.maxBytes ?? 1536 * 1024 * 1024, lowBytes = opts.lowBytes ?? Math.floor(maxBytes * 0.9);
  const pinCap = maxBytes * (opts.pinShare ?? 0.5);
  const loadLimit = opts.loadLimit ?? 24, diskLimit = opts.diskLimit ?? 0.85, pauseMs = opts.pauseMs ?? 30000, idleMs = opts.idleMs ?? 60000;
  const log = opts.log ?? (() => {});
  fs.mkdirSync(dir, { recursive: true });

  /** k -> { dir, meta, units: Map(name -> { bytes, raw, lastHit, pinned }) } */
  const entries = new Map();
  let total = 0, pinnedBytes = 0;
  const counts = { hits: 0, misses: 0, generated: 0, stale: 0, failed: 0, evicted: 0, swept: 0 };
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
  const metaOf = (file, st, light) => ({ path: realOf(file), size: st.size, mtimeMs: st.mtimeMs, ...(light ? { light: true, lightSide: LIGHT_SIDE, lightSize: light.copy.size, lightFrom: light.copy.from } : {}) });
  const keyOf = (meta) => crypto.createHash('sha1').update([meta.path, meta.size, meta.mtimeMs, meta.light ? `light\0${meta.lightSide}\0${meta.lightSize}\0${meta.lightFrom}` : ''].join('\0')).digest('hex');
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
          const m = /^([bp]\d+)\.(br|raw)$/.exec(n);
          if (!m) { if (n !== 'meta.json') fs.unlink(path.join(d, n), () => {}); continue; }
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

  /** least recently used units out, the unpinned ones first, down to `to` bytes */
  const evict = (to = lowBytes) => {
    if (total <= to) return;
    const all = [];
    for (const e of entries.values()) for (const [name, u] of e.units) all.push([u.pinned ? 1 : 0, u.lastHit, e, name]);
    all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, , e, name] of all) {
      if (total <= to) break;
      dropUnit(e, name); counts.evicted++;
      if (!e.units.size && !(job && job.k === e.k)) dropEntry(e);
    }
  };
  const diskUse = () => { try { const s = fs.statfsSync(dir); return s.blocks ? 1 - s.bavail / s.blocks : 0; } catch { return 0; } };

  // ------------------------------------------------------------------------------------------- generation
  /** live misses: id -> { file, st, light, unit, count } */
  const wanted = new Map();
  /** the launch sets being walked: { sources: [{ name, it, used, share, done }], pass } */
  let seeding = null;
  let job = null, pumping = null, child = null, childIdle = null, nextId = 1;
  const replies = new Map();

  const startChild = () => {
    if (child) return child;
    child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
    try { os.setPriority(child.pid, 19); } catch { /* not allowed: as it is */ }
    const c = child;
    c.on('message', (m) => { const r = replies.get(m.id); if (r) { replies.delete(m.id); r(m); } });
    c.on('exit', () => { if (child === c) child = null; for (const [id, r] of replies) { replies.delete(id); r({ id, error: 'generator exited' }); } });
    return c;
  };
  const stopChild = () => { const c = child; child = null; if (c) { try { c.disconnect(); } catch { /* gone */ } c.kill(); } };
  const ask = (msg) => new Promise((resolve) => {
    clearTimeout(childIdle);
    const c = startChild(), id = nextId++;
    c.channel?.ref?.();
    replies.set(id, resolve);
    try { c.send({ ...msg, id }); } catch (e) { replies.delete(id); resolve({ id, error: String(e) }); }
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

  const has = (file, st, light, unit) => !!entryOf(file, st, light).units?.has(unitName(unit));
  /** the next unit to make: the most asked live miss, else the next of the launch sets (null: nothing) */
  const nextJob = async () => {
    let best = null;
    for (const [id, w] of wanted) if (!best || w.count > best[1].count) best = [id, w];
    if (best) { wanted.delete(best[0]); return { ...best[1], pin: false }; }
    const sd = seeding; // (read again meanwhile, hourly: that walk goes on instead)
    if (!sd) return null;
    let steps = 0;
    for (; sd.pass < 2; sd.pass++, sd.i = 0) {
      for (; sd.i < sd.sources.length; sd.i++) {
        const s = sd.sources[sd.i];
        while (!s.done) {
          if (++steps % 64 === 0) await new Promise((r) => setImmediate(r)); // (the walk resolves paths: in slices)
          if (closed || seeding !== sd) return null;
          // first pass: the source's share of the pinned budget; second: more while under lowBytes
          if (sd.pass === 0 ? s.used >= s.share || pinnedBytes >= pinCap : total >= lowBytes) break;
          const n = s.it.next();
          if (n.done) { s.done = true; break; }
          const { file, st, light, unit } = n.value;
          const e = entryOf(file, st, light), u = e.units?.get(unitName(unit));
          if (u) { if (sd.pass === 0) { pin(u); s.used += u.bytes; } continue; }
          return { file, st, light, unit, pin: sd.pass === 0, source: s };
        }
      }
    }
    if (seeding === sd) seeding = null;
    return null;
  };

  const generate = async (j) => {
    const { file, light, unit } = j;
    let st; try { st = await fs.promises.stat(file); } catch { counts.stale++; return; }
    if (st.size !== j.st.size || st.mtimeMs !== j.st.mtimeMs) { counts.stale++; return; }
    const e = entryOf(file, st, light, true), name = unitName(unit);
    if (e.units.has(name)) return;
    const [start, end] = unitRange(unit, light ? light.copy.size : st.size);
    if (!(start < end)) return;
    job = e;
    try {
      const r = await ask({ file, size: st.size, mtimeMs: st.mtimeMs, light: light ? { head: light.copy.head, from: light.copy.from, size: light.copy.size } : null, start, end, dir: e.dir, name, meta: e.meta, minGain: MIN_GAIN });
      if (r.error) { counts.failed++; log(`br-cache: ${file} ${name}: ${r.error}`); return; }
      if (r.stale) { counts.stale++; return; }
      if (closed || entries.get(e.k) !== e) return;
      addUnit(e, name, r.bytes, r.raw, Date.now(), j.pin && pinnedBytes + r.bytes <= pinCap);
      if (j.source) j.source.used += r.bytes;
      counts.generated++;
    } finally { job = null; }
    if (total > maxBytes) evict();
  };

  const pump = () => {
    if (pumping || closed) return pumping;
    pumping = (async () => {
      try {
        await ready;
        for (;;) {
          if (!(await free())) break;
          const j = await nextJob();
          if (!j) { if (seeding || wanted.size) continue; break; } // (the launch sets read again meanwhile: the new walk)
          await generate(j);
        }
      } catch (e) { log(`br-cache: ${e?.stack ?? e}`); } finally { pumping = null; }
    })();
    return pumping;
  };

  const reseed = () => {
    if (!opts.sources || closed) return;
    let list = []; try { list = opts.sources() ?? []; } catch (e) { log(`br-cache: sources: ${e}`); }
    const share = list.length ? pinCap / list.length : 0;
    seeding = list.length ? { sources: list.map((s) => ({ name: s.name, it: s.units()[Symbol.iterator](), used: 0, share, done: false })), pass: 0, i: 0 } : null;
    for (const e of entries.values()) for (const u of e.units.values()) u.pinned = false;
    pinnedBytes = 0;
    pump();
  };

  const ready = (async () => { await load(); await sweep(); evict(maxBytes); })().catch((e) => log(`br-cache: load: ${e}`));
  ready.then(reseed);
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
    /** the bytes the unit `unit` of `file` takes on the wire when made (its compressed size, or raw's), else null: not a hit */
    size(file, st, light, unit) { return entryOf(file, st, light).units?.get(unitName(unit))?.bytes ?? null; },
    /** a unit found missing on the disk (evicted meanwhile, removed by hand): out of the index */
    drop(file, st, light, unit) { const e = entryOf(file, st, light); if (e.units) dropUnit(e, unitName(unit), false); },
    /** a request missed the unit: made next (before the launch sets), the most asked first */
    want(file, st, light, unit) {
      if (closed || has(file, st, light, unit)) return;
      const id = `${entryOf(file, st, light).k}#${unitName(unit)}`, w = wanted.get(id);
      if (w) w.count++;
      else {
        wanted.set(id, { file, st: { size: st.size, mtimeMs: st.mtimeMs }, light, unit, count: 1 });
        if (wanted.size > MAX_WANTED) wanted.delete(wanted.keys().next().value);
      }
      pump();
    },
    /** the launch sets read again (the learned orders changed) */
    reseed,
    sweep,
    /** resolves once nothing is left to make (tests) */
    async drain() { await ready; while (pumping) await pumping; },
    stats: () => ({ units: [...entries.values()].reduce((n, e) => n + e.units.size, 0), bytes: total, pinnedBytes, maxBytes, wanted: wanted.size, seeding: !!seeding, paused, ...counts }),
    close() { closed = true; clearInterval(timer); clearTimeout(childIdle); stopChild(); },
  };
}
