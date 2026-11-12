// Translation knowledge shared by code content (docs/startup.md "Learned code shared by content").
//
// What sessions learn about guest code — the heat (code ranges that ran: heat-<manifest>.json) and the entries of the
// regions translated at a miss (regions-<manifest>.json) — is recorded per version, by module name and offset. The
// same bytes appear in many versions and games: msvcr71.dll, mss32.dll and the Miles plugins are the same files in
// every SAGE game, and BFME II 1.09, RotWK 2.01, RotWK 2.02 and Age of the Ring run executables whose code pages are
// 99 % the same at the same offsets (different files: a patch changed a few pages, a launcher renamed the game).
//
// Here the knowledge is keyed by content: every module a version's data names is resolved to its file in that version's
// tree, its image cut into 4 KiB pages (by RVA, from the file's bytes: before relocation and before the manifest's
// `patches`, so a module loaded elsewhere or patched in memory has the same pages), each page identified by a hash of
// its bytes. A page of another version with the same hash lends what was learned in it, moved to the page's offset in
// this version's module. Nothing names a module or a game: a library is recognised by its bytes alone.
//
// It is only ever a hint: heat changes a region's extent (exact whatever it says, src/cpu/jit/heat.js), a learned entry
// is translated ahead and installed only when the code bytes in memory are those it was translated from. The versions'
// own files stay the record (POSTs unchanged); what is shared is derived from them, again after STALE_MS.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { PeImage } from '../loader/pe.js';
import { RangeHeat } from '../cpu/jit/heat.js';

export const PAGE = 4096;
const SHIFT = 12;

/**
 * The page hashes of a PE file's image: an array indexed by RVA >> 12, each a 16-hex-digit hash of the page's bytes as
 * mapped from the file (section raw data, zero past it) or null (no section there — headers included —, or a page of
 * one repeated byte: padding and zeroes, shared by unrelated modules). null when the file is not a PE32 image.
 * @param {Uint8Array} bytes
 */
export function imagePages(bytes) {
  let img; try { img = new PeImage(bytes); } catch { return null; }
  const n = Math.ceil(img.sizeOfImage / PAGE), pages = new Array(n).fill(null);
  // (each page's bytes from every section it holds — sections smaller than a page may share one —, hashed after)
  const bufs = new Map();
  for (const s of img.sections) {
    const vsize = s.virtualSize || s.rawSize;
    for (let rva = s.rva & ~(PAGE - 1); rva < s.rva + vsize && (rva >> SHIFT) < n; rva += PAGE) {
      let buf = bufs.get(rva); if (!buf) bufs.set(rva, buf = new Uint8Array(PAGE));
      // (the part of this page the section covers, from its raw data)
      const from = Math.max(rva, s.rva), to = Math.min(rva + PAGE, s.rva + vsize, s.rva + s.rawSize);
      if (to > from) {
        const src = s.rawPtr + (from - s.rva), len = Math.min(to - from, bytes.length - src);
        if (len > 0) buf.set(bytes.subarray(src, src + len), from - rva);
      }
    }
  }
  for (const [rva, buf] of bufs) {
    let uniform = true; for (let i = 1; i < PAGE; i++) if (buf[i] !== buf[0]) { uniform = false; break; }
    if (!uniform) pages[rva >> SHIFT] = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  }
  return pages;
}

/** whether a file starts with a PE image's headers (MZ, then 'PE\0\0' at e_lfanew), read from its first 4 KiB */
function looksPe(file) {
  let fd; try {
    fd = fs.openSync(file, 'r');
    const h = Buffer.alloc(4096), n = fs.readSync(fd, h, 0, 4096, 0);
    if (n < 64 || h[0] !== 0x4d || h[1] !== 0x5a) return false;
    const pe = h.readUInt32LE(0x3c);
    return pe + 4 <= n && h.readUInt32LE(pe) === 0x00004550;
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * The file a version loads for a module name: the name beside its executable, in its working folder or at its root
 * (where Windows looks first), else the shallowest file of that name in its tree (Miles' plugins under mss/), one under
 * the executable's folder first. `resolve` is resolveGameFile bound to the version, `tree()` its listing ({ dirs,
 * files }), asked only when the first places miss.
 */
export function moduleFile(man, name, resolve, tree) {
  const exeDir = path.posix.dirname(String(man.exe ?? '').replace(/\\/g, '/')), top = exeDir === '.' ? '' : exeDir;
  const cwd = String(man.cwd ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  for (const d of [top, cwd, '']) { const f = resolve(d ? `${d}/${name}` : name); if (f) return f; }
  const t = tree(); if (!t) return null;
  const all = treeNames(t).get(name); if (!all) return null;
  const under = top && all.find((r) => r.toLowerCase().startsWith(top.toLowerCase() + '/'));
  for (const r of under ? [under, ...all] : all) { const f = resolve(r); if (f) return f; }
  return null;
}
/** a tree's file paths by lower-case name, shallowest first (made once per tree object) */
const namesOf = new WeakMap();
function treeNames(tree) {
  let m = namesOf.get(tree);
  if (m) return m;
  m = new Map();
  const queue = [[tree, '']];
  for (let i = 0; i < queue.length; i++) {
    const [node, at] = queue[i];
    for (const k of Object.keys(node.files ?? {})) { const n = k.toLowerCase(); let l = m.get(n); if (!l) m.set(n, l = []); l.push(at ? `${at}/${k}` : k); }
    for (const [k, sub] of Object.entries(node.dirs ?? {})) queue.push([sub, at ? `${at}/${k}` : k]);
  }
  namesOf.set(tree, m);
  return m;
}

/** A heat-<manifest>.json file as the server keeps it: Map(module -> RangeHeat), empty when there is none. */
export function readHeatFile(f) {
  const m = new Map();
  try { for (const [mod, list] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) { const h = new RangeHeat(); for (let i = 0; i + 1 < list.length; i += 2) h.add(list[i], list[i] + list[i + 1]); h.merge(); m.set(mod, h); } } catch { /* none */ }
  return m;
}
/** A regions-<manifest>.json file as the server keeps it: Map("module:rva:fpc" -> { t, n }). */
export function readRegionsFile(f) {
  const m = new Map();
  try { for (const [k, t, n] of JSON.parse(fs.readFileSync(f, 'utf8'))) m.set(k, { t, n }); } catch { /* none */ }
  return m;
}

/** at most this many region entries served (the server's list before sharing: 40 000) */
export const REGIONS_SERVED = 40000;

/**
 * The heat served to a version: its own (Map(module -> RangeHeat)) and the lent ranges merged, per module, as
 * { module: [rva, length, ...] }. (Heat only grows over a version's sessions, which differ in what they play as much
 * as versions do: the lent ranges are merged like another session's.)
 */
export function servedHeat(own, lent) {
  const o = Object.create(null), mods = new Set([...own.keys(), ...(lent?.heat.keys() ?? [])]);
  for (const mod of mods) {
    let h = own.get(mod);
    const l = lent?.heat.get(mod);
    if (l) { const r = new RangeHeat(); if (h) r.addPairs(h.pairs()); r.addPairs(l); h = r; }
    const p = h.pairs(), out = [];
    for (let i = 0; i < p.length; i += 2) out.push(p[i], p[i + 1] - p[i]);
    o[mod] = out;
  }
  return o;
}

/**
 * The region entries served to a version, [module, rva, fpc] in order: its own by their first use (as before sharing,
 * the earliest REGIONS_SERVED), then the lent ones it does not have, by their first use in the versions that taught
 * them, up to REGIONS_SERVED in all — never before one of its own: a version its sessions taught translates what they
 * need first, the lent entries after (on a first session, they are the whole list).
 */
export function servedRegions(own, lent, max = REGIONS_SERVED) {
  const list = [...own].sort((a, b) => a[1].t - b[1].t).slice(0, max).map(([k]) => { const [mod, rva, fpc] = k.split(':'); return [mod, Number(rva), fpc === '' ? null : Number(fpc)]; });
  for (const [mod, rva, fpc] of lent?.regions ?? []) {
    if (list.length >= max) break;
    if (!own.has(`${mod}:${rva}:${fpc ?? ''}`)) list.push([mod, rva, fpc]);
  }
  return list;
}

/**
 * The content index over every version's learned data and what it lends a version.
 *
 * `opts`:
 * - versions(): the ids of the versions whose data may lend (each with learned files or not)
 * - manifestOf(id): the version's manifest; tree(id): its file listing; resolve(id, rel): resolveGameFile there
 * - heatOf(id): Map(module -> RangeHeat of offsets); regionsOf(id): Map("module:rva:fpc" -> { t, n })
 * - hasData(id): whether the version has learned heat or regions (else not loaded for nothing)
 * - staleMs: the index and the answers made again after that (default 60 s)
 */
export class CodeShare {
  constructor(opts) {
    this.opts = opts;
    this.staleMs = opts.staleMs ?? 60000;
    this.files = new Map(); // path -> { id (dev:ino:size:mtime), pages }
    this.index = null; // { at, byHash: Map(hash -> [{ v, mod, page }]), heat: Map(`${v}\0${mod}` -> RangeHeat), regions: Map(`${v}\0${mod}` -> Map(page -> [[off, fpc, t]])), modules: Set }
    this.lent = new Map(); // version -> { heat, regions, pagesLent }
    this.where = new Map(); // `${version}\0${module}` -> its pages (modulePages), until the next build
    this.lends = 0;
    this.stats = { builds: 0, buildMs: 0, hashedFiles: 0 };
  }

  /** a file's page hashes, made again when the file changed */
  pagesOf(file) {
    if (!file) return null;
    let st; try { st = fs.statSync(file); } catch { return null; }
    const id = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`, c = this.files.get(file);
    if (c && c.id === id) return c.pages;
    let pages = null;
    // (module names come from clients' POSTs: a file is read whole only when its headers say PE and it is no bigger
    // than a module a game loads — a game archive named as a module is not read)
    if (st.size <= 64 * 1048576 && looksPe(file)) try { pages = imagePages(new Uint8Array(fs.readFileSync(file))); } catch { pages = null; }
    this.files.set(file, { id, pages }); this.stats.hashedFiles++;
    return pages;
  }

  /** the pages of module `mod` as version `v` loads it (null: not found, not a PE image), looked up once per index */
  modulePages(v, mod) {
    const k = `${v}\0${mod}`;
    if (this.where.has(k)) return this.where.get(k);
    const o = this.opts, man = o.manifestOf(v);
    const pages = man ? this.pagesOf(moduleFile(man, mod, (rel) => o.resolve(v, rel), () => o.tree(v))) : null;
    this.where.set(k, pages);
    return pages;
  }

  build() {
    const t0 = performance.now(), o = this.opts;
    this.where.clear();
    const byHash = new Map(), heat = new Map(), regions = new Map(), modules = new Set();
    const at = (h, e) => { let l = byHash.get(h); if (!l) byHash.set(h, l = []); l.push(e); };
    for (const v of o.versions()) {
      if (!o.hasData(v)) continue;
      const hv = o.heatOf(v), rv = o.regionsOf(v), byMod = new Map();
      for (const [mod, h] of hv) { modules.add(mod); byMod.set(mod, { h, r: null }); }
      for (const [k, e] of rv) {
        const i = k.indexOf(':'), j = k.indexOf(':', i + 1), mod = k.slice(0, i), rva = Number(k.slice(i + 1, j)), fpc = k.slice(j + 1);
        modules.add(mod);
        let m = byMod.get(mod); if (!m) byMod.set(mod, m = { h: null, r: null });
        m.r ??= new Map();
        const page = rva >> SHIFT; let l = m.r.get(page); if (!l) m.r.set(page, l = []);
        l.push([rva & (PAGE - 1), fpc === '' ? null : Number(fpc), e.t]);
      }
      for (const [mod, m] of byMod) {
        const pages = this.modulePages(v, mod); if (!pages) continue;
        const key = `${v}\0${mod}`, seen = new Set();
        if (m.h) {
          m.h.merge(); heat.set(key, m.h);
          const p = m.h.pairs();
          for (let i = 0; i < p.length; i += 2) for (let pg = p[i] >> SHIFT; pg <= (p[i + 1] - 1) >> SHIFT && pg < pages.length; pg++) seen.add(pg);
        }
        if (m.r) { regions.set(key, m.r); for (const pg of m.r.keys()) seen.add(pg); }
        for (const pg of seen) if (pages[pg]) at(pages[pg], { v, mod, key, page: pg, claim: null });
      }
    }
    this.index = { at: Date.now(), byHash, heat, regions, modules };
    this.lent.clear();
    this.stats.builds++; this.stats.buildMs += performance.now() - t0;
    return this.index;
  }

  /**
   * What the other versions' data lends version `v`: { heat: Map(module -> pairs lo, hi, ... of offsets), regions:
   * [[module, rva, fpc, t], ...] by t, each entry once }. Made again after staleMs.
   */
  lend(v) {
    const now = Date.now();
    if (!this.index || now - this.index.at >= this.staleMs) this.build();
    const c = this.lent.get(v); if (c) return c;
    const { byHash, heat, regions, modules } = this.index;
    const outHeat = new Map(), outRegions = [];
    // (the modules looked at in the version's tree: its executable first, then those its own sessions named, then the
    // names the other versions' data uses. A source page lends to one module of the version, the first that has it:
    // the same code under two names in a tree — RotWK 2.02's base/game.dat beside its lotrbfme2ep1.exe — is lent to the
    // one the version runs, not to both: entries for a module never loaded would take room in the served list)
    const man = this.opts.manifestOf(v), exe = String(man?.exe ?? '').replace(/\\/g, '/').split('/').pop().toLowerCase();
    const ownMods = [...(this.opts.heatOf(v)?.keys() ?? []), ...[...(this.opts.regionsOf(v)?.keys() ?? [])].map((k) => k.slice(0, k.indexOf(':')))];
    const order = [...new Set([...(exe ? [exe] : []), ...ownMods, ...modules])];
    const lendId = ++this.lends; // (a source page claimed by this lend: s.claim = { lendId, mod })
    let pagesLent = 0;
    for (const mod of order) {
      const pages = this.modulePages(v, mod); if (!pages) continue;
      let pairs = null;
      const entries = new Map(); // (rva * 0x10001 + x87 mode + 1 -> [module, rva, fpc, t])
      for (let pg = 0; pg < pages.length; pg++) {
        const h = pages[pg]; if (!h) continue;
        const srcs = byHash.get(h); if (!srcs) continue;
        let lent = false;
        for (const s of srcs) {
          if (s.v === v) continue;
          if (s.claim?.lendId === lendId && s.claim.mod !== mod) continue;
          s.claim = { lendId, mod };
          const delta = (pg - s.page) * PAGE, rh = heat.get(s.key);
          if (rh) {
            // (the source's ranges within its page, clipped to it, moved to this page)
            const lo = rh.lo, hi = rh.hi, a = s.page * PAGE, b = a + PAGE;
            let l = 0, r = lo.length; while (l < r) { const m = (l + r) >> 1; if (hi[m] <= a) l = m + 1; else r = m; }
            for (let i = l; i < lo.length && lo[i] < b; i++) { (pairs ??= []).push(Math.max(lo[i], a) + delta, Math.min(hi[i], b) + delta); lent = true; }
          }
          const rr = regions.get(s.key)?.get(s.page);
          if (rr) {
            for (const [off, fpc, t] of rr) {
              const rva = pg * PAGE + off, k = rva * 0x10001 + (fpc ?? -1) + 1, old = entries.get(k);
              if (!old) entries.set(k, [mod, rva, fpc, t]); else if (t < old[3]) old[3] = t;
            }
            lent = true;
          }
        }
        if (lent) pagesLent++;
      }
      if (pairs) { const r = new RangeHeat(); r.addPairs(pairs); outHeat.set(mod, r.pairs()); }
      for (const e of entries.values()) outRegions.push(e);
    }
    const out = { heat: outHeat, regions: outRegions.sort((a, b) => a[3] - b[3]), pagesLent };
    this.lent.set(v, out);
    return out;
  }
}
