// Development/serving host: static files (the page, the ES modules of the emulator), manifests,
// and the game folder served read-only with HTTP range requests + a JSON directory listing.
// Sends the COOP/COEP headers required for SharedArrayBuffer and Atomics.wait in the page.
// Usage: node src/host/server.js [--port 8080] [--manifests <dir>] [--default <manifest>] [--telemetry <dir>] [--learn <dir>] [--profile-seed-quorum N]
//   --default: the page starts that game directly (the picker stays reachable with ?menu)
//   --telemetry: the page's per-second measurements (frame rate, frame times, emulated CPU) are appended to
//                <dir>/telemetry-<date>.jsonl, one line per batch, to study the slowdowns seen by a player
//   --learn: the order in which sessions read the game's file blocks is kept there (the prefetch list of later sessions),
//            the GL programs they built and the code regions they translated (both prepared ahead by later sessions),
//            and the small profile files first sessions wrote (shared first-launch profile; --profile-seed-quorum: the
//            distinct sessions that must report a set identical before it is offered, default 2)
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { BLOCK as LEARN_BLOCK, CHUNK as LEARN_CHUNK } from '../vfs/http-backend.js';
import { createAccountApi } from './accounts.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDefaults } from './manifest.js';
import { listGameTree, resolveGameFile } from './game-files.js';
import { loadGameCatalog, DEFAULT_GAMES_DIR } from './game-catalog.js';
import { attachLan } from './lan.js';
import { SimLink } from './sim-link.js';
import { programSourceId } from '../gfx/program-id.js';
import { SEED_LIMITS, seedPathOk, seedSelect, seedKey, toBase64, fromBase64 } from './profile-seed.js';
import { RangeHeat } from '../cpu/jit/heat.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

export const listTree = (dir) => listGameTree({ folder: dir });

export function loadManifests(dir, extra = null) {
  const out = new Map();
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      m.folder = path.resolve(dir, m.folder ?? '.');
      if (m.baseFolder) m.baseFolder = path.resolve(dir, m.baseFolder);
      out.set(f.slice(0, -5), withDefaults(m));
    }
  }
  for (const [name, m] of extra ?? []) out.set(name, m); // (manifests given by the caller: `orthros run <folder>`)
  return out;
}

/**
 * The build the server serves, for telemetry: the git commit of the tree, '+' when tracked files under src/ differ
 * from it, and the newest modification time of the runtime's files (the page loads src/ directly: an edited tree
 * serves new code without a new commit). Recomputed at most once a minute.
 */
let versionCache = null;
export function buildVersion(root = ROOT) {
  const now = Date.now();
  if (versionCache && versionCache.root === root && now - versionCache.at < 60000) return versionCache.value;
  let commit = 'nogit', dirty = false, newest = 0;
  // (--no-optional-locks: the status never writes the index nor takes its lock — the tree may be edited meanwhile)
  const vcs = (...a) => execFileSync('git', ['--no-optional-locks', ...a], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  try { commit = vcs('rev-parse', '--short', 'HEAD') || 'nogit'; dirty = vcs('status', '--porcelain', '--untracked-files=no', '--', 'src') !== ''; } catch { /* not a checkout */ }
  const walk = (d) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(m?js|html|css)$/.test(e.name)) { try { const t = fs.statSync(f).mtimeMs; if (t > newest) newest = t; } catch { /* gone */ } }
    }
  };
  walk(path.join(root, 'src'));
  const value = `${commit}${dirty ? '+' : ''}@${newest ? new Date(newest).toISOString().slice(0, 19) + 'Z' : '?'}`;
  versionCache = { root, at: now, value };
  return value;
}

export function createServer(opts = {}) {
  const manifestDir = opts.manifests ? path.resolve(opts.manifests) : null;
  const gamesDir = path.resolve(opts.gamesDir ?? DEFAULT_GAMES_DIR);
  const readCatalog = () => manifestDir ? loadManifests(manifestDir, opts.extra) : loadGameCatalog(gamesDir, opts.extra);
  let manifests = readCatalog();
  const trees = new Map(), treeObjs = new Map();
  const refreshCatalog = () => { manifests = readCatalog(); trees.clear(); treeObjs.clear(); };
  const getManifest = (id) => { if (!manifests.has(id) && !manifestDir) refreshCatalog(); return manifests.get(id); };
  const coverFile = (man) => man.cover && resolveGameFile(man, man.cover);
  const headers = (extra = {}) => ({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-cache',
    ...extra,
  });
  // testing: a slower network (opts.net = { delayMs, bytesPerSec }): each range answered after a round trip, its bytes
  // crossing one link shared by the answers in flight (see SimLink)
  const link = opts.net ? new SimLink(opts.net) : null;
  const viaLink = (res, bytes, go) => { const cancel = link.send(bytes, go); res.on('close', cancel); };
  const send = (res, code, body, extra) => { res.writeHead(code, headers({ 'Content-Type': 'text/plain; charset=utf-8', ...extra })); res.end(body); };
  const sendFile = (req, res, file, mime) => {
    let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
    if (!st.isFile()) return send(res, 404, 'not found');
    const range = req.headers.range;
    const h = headers({ 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString() });
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) return send(res, 416, 'bad range', { 'Content-Range': `bytes */${st.size}` });
      let start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
      let end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
      if (start > end || start >= st.size) return send(res, 416, 'bad range', { 'Content-Range': `bytes */${st.size}` });
      res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      if (link) { viaLink(res, end - start + 1, () => fs.createReadStream(file, { start, end }).pipe(res)); return; }
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...h, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  };

  /**
   * Learned prefetch order, per manifest: the 1 MiB blocks the game read synchronously in earlier sessions, with the
   * earliest time since its session's first read it was needed ('s' parameter of /gamez requests; prefetch requests,
   * 'p=1', are not counted). /api/prefetch/<manifest> lists them in that order: a new session downloads them in the
   * background (network otherwise idle while the game computes) before the game asks for them. Kept in
   * opts.learnDir/prefetch-<manifest>.json when set. Each block also carries the mask of the 64 KiB pieces sessions
   * read in it (bit i: piece i; absent for blocks learned before masks): a session fetches those pieces ahead of the
   * game — a few pieces of each block is what a run of small random reads needs, not whole blocks.
   */
  const learned = new Map(); // manifest -> Map("path#block" -> { t, n, mask })
  /** mask of the 64 KiB pieces of a block covered by [a, b) (offsets within the block) */
  const pieceBits = (a, b) => { let m = 0; for (let c = Math.floor(a / LEARN_CHUNK); c * LEARN_CHUNK < b; c++) m |= 1 << c; return m >>> 0; };
  const sessions = new Map(); // session id -> { start, seen: Set }
  const learnFile = (name) => opts.learnDir && path.join(opts.learnDir, `prefetch-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const learnedOf = (name) => {
    let m = learned.get(name);
    if (!m) {
      m = new Map(); learned.set(name, m);
      const f = learnFile(name);
      if (f) try { for (const [k, t, n, mask] of JSON.parse(fs.readFileSync(f, 'utf8'))) m.set(k, { t, n, mask: mask ?? undefined }); } catch { /* none yet */ }
    }
    return m;
  };
  let learnDirty = new Set(), learnTimer = null;
  const learnRead = (name, rel, start, end, sid) => {
    if (!sid || sid.length > 40) return;
    const now = Date.now();
    let ss = sessions.get(sid);
    if (!ss) {
      if (sessions.size > 1000) for (const [k, v] of sessions) if (now - v.start > 6 * 3600e3) sessions.delete(k);
      sessions.set(sid, ss = { start: now, seen: new Set() });
    }
    const m = learnedOf(name), t = now - ss.start;
    for (let b = Math.floor(start / LEARN_BLOCK); b * LEARN_BLOCK < end; b++) {
      const k = `${rel}#${b}`;
      const bits = pieceBits(Math.max(start, b * LEARN_BLOCK) - b * LEARN_BLOCK, Math.min(end, (b + 1) * LEARN_BLOCK) - b * LEARN_BLOCK);
      let e = m.get(k);
      if (!e) m.set(k, e = { t, n: 0, mask: 0 });
      e.mask = (e.mask ?? 0) | bits; // (every session's pieces, first read of the block or not)
      if (ss.seen.has(k)) continue;
      ss.seen.add(k);
      e.t = Math.min(e.t, t); e.n++;
    }
    if (learnFile(name)) {
      learnDirty.add(name);
      learnTimer ??= setTimeout(() => {
        learnTimer = null;
        for (const n of learnDirty) { const f = learnFile(n); try { fs.writeFileSync(f + '.tmp', JSON.stringify([...learnedOf(n)].map(([k, v]) => (v.mask === undefined ? [k, v.t, v.n] : [k, v.t, v.n, v.mask])))); fs.renameSync(f + '.tmp', f); } catch { /* next time */ } }
        learnDirty = new Set();
      }, 20000);
      learnTimer.unref?.(); // (does not keep a finished process alive)
    }
  };
  // (each entry: [path, block, mask (0: unknown), t (ms from its earliest session's first read)])
  const prefetchList = (name) => [...learnedOf(name)].sort((a, b) => a[1].t - b[1].t).slice(0, 8192).map(([k, v]) => { const i = k.lastIndexOf('#'); return [k.slice(0, i), Number(k.slice(i + 1)), v.mask ?? 0, Math.round(v.t)]; });

  /**
   * Learned GL programs, per manifest: the programs sessions had to build at a draw (key, GLSL sources, attribute
   * names, earliest time since the page started), posted by the worker. /api/programs/<manifest> lists them in that
   * order: a new session compiles them in the background before the game draws with them (no build hitch in a match).
   * They are identified by their sources (programSourceId), not by their key: a key names shader objects by handle,
   * which varies between sessions, and several keys can build the same sources. The sources are Orthros' own
   * translations: those of an older translator are never drawn with again, so an entry no session has built or used
   * (the worker reports the learned programs it took, `used`) for PROGRAMS_KEEP_SESSIONS sessions is dropped, and
   * the least recently used one makes room when the list is full. Kept in opts.learnDir/programs2-<manifest>.json;
   * programs-<manifest>.json, the list of the first format (by key), is only read: its programs missing from the new
   * list are added at each start (a server of the first format may still run on the same directory: neither server
   * rewrites the other's file).
   */
  const programsLearned = new Map(); // manifest -> { sessions, m: Map(id -> { key, vs, fs, attrs, t, n, s }) }
  const learnName = (name) => name.replace(/[^A-Za-z0-9._-]/g, '_');
  const programsFile = (name) => opts.learnDir && path.join(opts.learnDir, `programs2-${learnName(name)}.json`);
  const programsFileV1 = (name) => opts.learnDir && path.join(opts.learnDir, `programs-${learnName(name)}.json`);
  const PROGRAMS_MAX = 4096, PROGRAM_SRC_MAX = 64 * 1024, PROGRAMS_KEEP_SESSIONS = 64;
  const programsOf = (name) => {
    let L = programsLearned.get(name);
    if (!L) {
      L = { sessions: 0, m: new Map() }; programsLearned.set(name, L);
      const read = (f) => { try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; } };
      const add = (id0, key, vs, fs2, attrs, t, n, s) => {
        if (typeof vs !== 'string' || typeof fs2 !== 'string' || !Array.isArray(attrs) || !attrs.every((a) => typeof a === 'string')) return;
        const id = typeof id0 === 'string' ? id0 : programSourceId(vs, fs2, attrs), old = L.m.get(id);
        t = Number.isFinite(t) ? t : 1e9; n = Number.isFinite(n) ? n : 1; s = Number.isFinite(s) ? s : L.sessions;
        if (old) { old.t = Math.min(old.t, t); old.n = Math.max(old.n, n); old.s = Math.max(old.s, s); }
        else if (L.m.size < PROGRAMS_MAX) L.m.set(id, { key: typeof key === 'string' ? key : '', vs, fs: fs2, attrs, t, n, s });
      };
      const j = read(programsFile(name));
      if (j && Array.isArray(j.programs)) {
        L.sessions = Number(j.sessions) || 0;
        for (const r of j.programs) if (Array.isArray(r)) add(...r);
      }
      // (the first format: an array of [key, vs, fs, attrs, t, n] by key, imported when it changed since the last
      // import — `v1`, its size and time — so that entries aged out here do not come back at every start. Entries of
      // the same sources merged, those already listed left as they are)
      let st = null; try { st = programsFileV1(name) ? fs.statSync(programsFileV1(name)) : null; } catch { /* none */ }
      L.v1 = st ? `${st.size}:${Math.round(st.mtimeMs)}` : j?.v1 ?? null;
      const v1 = st && L.v1 !== j?.v1 ? read(programsFileV1(name)) : null;
      if (Array.isArray(v1)) {
        for (const r of v1) if (Array.isArray(r)) { const [key, vs, fs2, attrs, t, n] = r; add(null, key, vs, fs2, attrs, t, n, L.sessions); }
        programsChanged(name);
      }
    }
    return L;
  };
  let programsDirty = new Set(), programsTimer = null;
  const programsChanged = (name) => {
    if (!programsFile(name)) return;
    programsDirty.add(name);
    programsTimer ??= setTimeout(() => {
      programsTimer = null;
      for (const n of programsDirty) {
        const f = programsFile(n), L = programsOf(n);
        try { fs.writeFileSync(f + '.tmp', JSON.stringify({ sessions: L.sessions, v1: L.v1 ?? null, programs: [...L.m].map(([id, v]) => [id, v.key, v.vs, v.fs, v.attrs, v.t, v.n, v.s]) })); fs.renameSync(f + '.tmp', f); } catch { /* next time */ }
      }
      programsDirty = new Set();
    }, opts.learnWriteMs ?? 20000); // (tests: sooner)
    programsTimer.unref?.();
  };
  const learnPrograms = (name, list, used) => {
    const L = programsOf(name), m = L.m;
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || typeof e.key !== 'string' || typeof e.vs !== 'string' || typeof e.fs !== 'string' || !Array.isArray(e.attrs) || !e.attrs.every((a) => typeof a === 'string')) continue;
      if (e.key.length > 4096 || e.vs.length > PROGRAM_SRC_MAX || e.fs.length > PROGRAM_SRC_MAX || e.attrs.length > 32) continue;
      const t = Number.isFinite(e.t) ? Math.max(0, e.t) : 1e9, id = programSourceId(e.vs, e.fs, e.attrs), old = m.get(id);
      if (old) { old.t = Math.min(old.t, t); old.n++; old.s = L.sessions; continue; }
      if (m.size >= PROGRAMS_MAX) { // (full: the least recently used one leaves, unless all were used this session)
        let lru = null;
        for (const [k, v] of m) if (!lru || v.s < lru[1].s) lru = [k, v];
        if (lru[1].s >= L.sessions) continue;
        m.delete(lru[0]);
      }
      m.set(id, { key: e.key, vs: e.vs, fs: e.fs, attrs: e.attrs, t, n: 1, s: L.sessions });
    }
    for (const id of Array.isArray(used) ? used.slice(0, PROGRAMS_MAX) : []) { const v = typeof id === 'string' ? m.get(id) : null; if (v) v.s = L.sessions; }
    programsChanged(name);
  };
  /** The list a new session compiles ahead (a session starts: the entries unused for too long are dropped first). */
  const programsList = (name) => {
    const L = programsOf(name);
    L.sessions++;
    for (const [id, v] of L.m) if (v.s < L.sessions - PROGRAMS_KEEP_SESSIONS) L.m.delete(id);
    programsChanged(name);
    return [...L.m].sort((a, b) => a[1].t - b[1].t).map(([id, v]) => ({ id, key: v.key, vs: v.vs, fs: v.fs, attrs: v.attrs }));
  };

  /**
   * Learned code regions, per manifest: the entries of the regions the JIT translated at a miss (module, offset in it,
   * x87 mode), with the earliest time since the page started, posted by the worker. /api/regions/<manifest> lists them
   * in that order: a new session translates them while the game is idle (menus) instead of in the middle of a match.
   * Kept in opts.learnDir/regions-<manifest>.json when set.
   */
  const regionsLearned = new Map(); // manifest -> Map("module:rva:fpc" -> { t, n })
  const regionsFile = (name) => opts.learnDir && path.join(opts.learnDir, `regions-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const regionsOf = (name) => {
    let m = regionsLearned.get(name);
    if (!m) {
      m = new Map(); regionsLearned.set(name, m);
      const f = regionsFile(name);
      if (f) try { for (const [k, t, n] of JSON.parse(fs.readFileSync(f, 'utf8'))) m.set(k, { t, n }); } catch { /* none yet */ }
    }
    return m;
  };
  let regionsDirty = new Set(), regionsTimer = null;
  const REGIONS_MAX = 100000;
  const regionKey = (e) => (!Array.isArray(e) || typeof e[0] !== 'string' || e[0].length > 64 || !Number.isInteger(e[1]) || e[1] < 0 || !(e[2] === null || Number.isInteger(e[2])) ? null : `${e[0].toLowerCase()}:${e[1]}:${e[2] ?? ''}`);
  /**
   * A session's report: `list` the entries it translated at a miss ([module, rva, fpc, t]); `covered` learned entries
   * its background translator found to be blocks of learned regions listed before them ([module, rva, fpc]: never
   * installed as regions of their own) — forgotten, which leaves their room in the served list to regions of later
   * phases; one a session misses again is learned again.
   */
  const learnRegions = (name, list, covered) => {
    const m = regionsOf(name);
    for (const e of Array.isArray(list) ? list : []) {
      const k = regionKey(e); if (!k) continue;
      const t = Number.isFinite(e[3]) ? Math.max(0, e[3]) : 1e9, old = m.get(k);
      if (old) { old.t = Math.min(old.t, t); old.n++; } else if (m.size < REGIONS_MAX) m.set(k, { t, n: 1 });
    }
    for (const e of Array.isArray(covered) ? covered : []) { const k = regionKey(e); if (k) m.delete(k); }
    if (regionsFile(name)) {
      regionsDirty.add(name);
      regionsTimer ??= setTimeout(() => {
        regionsTimer = null;
        for (const n of regionsDirty) { const f = regionsFile(n); try { fs.writeFileSync(f + '.tmp', JSON.stringify([...regionsOf(n)].map(([k, v]) => [k, v.t, v.n]))); fs.renameSync(f + '.tmp', f); } catch { /* next time */ } }
        regionsDirty = new Set();
      }, 20000);
      regionsTimer.unref?.();
    }
  };
  /** [module, rva, fpc] by earliest use */
  const regionsList = (name) => [...regionsOf(name)].sort((a, b) => a[1].t - b[1].t).slice(0, 40000).map(([k]) => { const [mod, rva, fpc] = k.split(':'); return [mod, Number(rva), fpc === '' ? null : Number(fpc)]; });

  /**
   * Shared first-launch profile, per manifest and game language (see profile-seed.js): the sets of small profile files
   * first sessions reported (identical sets merged by content: `key`), with the distinct sessions that reported each.
   * /api/profile-seed/<manifest>?lang= gives a new player's empty profile the set at least `profileSeedQuorum`
   * (default 2) distinct sessions reported identical — the most reported one — or nothing. Bounded: a set within
   * SEED_LIMITS, SEED_SETS_MAX sets per manifest (the least recently reported one makes room), SEED_SESSIONS_MAX session
   * ids per set. Kept in opts.learnDir/profileseed-<manifest>.json (a server without it ignores the file). The manifest
   * compat flag "profileSeed": false turns it off for a game.
   */
  const seedsLearned = new Map(); // manifest -> { sets: [{ lang, key, files: [[path, b64]], sessions: [], at }] }
  const seedFile = (name) => opts.learnDir && path.join(opts.learnDir, `profileseed-${learnName(name)}.json`);
  const SEED_SETS_MAX = 16, SEED_SESSIONS_MAX = 32, seedQuorum = Math.max(1, opts.profileSeedQuorum ?? 2);
  const seedsOf = (name) => {
    let L = seedsLearned.get(name);
    if (!L) {
      L = { sets: [] }; seedsLearned.set(name, L);
      try {
        const j = JSON.parse(fs.readFileSync(seedFile(name), 'utf8'));
        for (const s of Array.isArray(j?.sets) ? j.sets.slice(0, SEED_SETS_MAX) : []) {
          if (s && typeof s.lang === 'string' && typeof s.key === 'string' && Array.isArray(s.files) && Array.isArray(s.sessions)) L.sets.push({ lang: s.lang, key: s.key, files: s.files, sessions: s.sessions.slice(0, SEED_SESSIONS_MAX), at: Number(s.at) || 0 });
        }
      } catch { /* none yet */ }
    }
    return L;
  };
  let seedsDirty = new Set(), seedsTimer = null;
  const seedsChanged = (name) => {
    if (!seedFile(name)) return;
    seedsDirty.add(name);
    seedsTimer ??= setTimeout(() => {
      seedsTimer = null;
      for (const n of seedsDirty) { const f = seedFile(n); try { fs.writeFileSync(f + '.tmp', JSON.stringify({ v: 1, sets: seedsOf(n).sets })); fs.renameSync(f + '.tmp', f); } catch { /* next time */ } }
      seedsDirty = new Set();
    }, opts.learnWriteMs ?? 20000);
    seedsTimer.unref?.();
  };
  const seedLang = (l) => (typeof l === 'string' && /^[A-Za-z-]{0,16}$/.test(l) ? l.toLowerCase() : null);
  /**
   * Who reported a set, for the quorum: the client's address (behind the reverse proxy, the first X-Forwarded-For hop;
   * hashed, not stored as such), so that one client cannot make up the quorum with invented session ids; on a loopback
   * connection without a proxy header (the harness, a local server: one machine for every session) the session id.
   */
  /**
   * One client's network: an IPv4 address as is (an IPv4-mapped IPv6 one as IPv4); an IPv6 address by its /64 prefix
   * (one host is handed a whole /64 and picks addresses in it at will).
   */
  const clientNet = (addr) => {
    const a = addr.toLowerCase().replace(/^\[|\](:\d+)?$/g, '').replace(/%.*$/, '');
    const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (v4) return v4[1];
    if (!a.includes(':')) return a;
    const [head, tail = ''] = a.split('::');
    const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
    if (t.length && t[t.length - 1].includes('.')) t.splice(-1, 1, '0', '0'); // (embedded IPv4: past the /64)
    const groups = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
    return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
  };
  const seedReporter = (req, sid) => {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    const addr = fwd || String(req.socket.remoteAddress ?? '');
    if (!fwd && /^(127\.|::1$|::ffff:127\.)/.test(addr)) return 's:' + sid;
    return 'a:' + seedKey([{ path: clientNet(addr), data: new Uint8Array(0) }]);
  };
  /** a first session's report: { lang, session, files: [{ path, data (base64) }] } from `reporter` — false when refused */
  const learnSeed = (name, rec, reporter) => {
    const lang = seedLang(rec?.lang ?? ''), sid = rec?.session;
    if (lang === null || typeof sid !== 'string' || !sid || sid.length > 40 || !Array.isArray(rec.files) || rec.files.length > SEED_LIMITS.files) return false;
    const files = [];
    for (const f of rec.files) { const data = fromBase64(f?.data); if (!data || !seedPathOk(f?.path)) return false; files.push({ path: f.path, data }); }
    const sel = seedSelect(files);
    if (!sel.length || sel.length !== files.length) return false; // (over the limits: refused as a whole)
    const L = seedsOf(name), key = seedKey(sel);
    let set = L.sets.find((s) => s.lang === lang && s.key === key);
    if (!set) {
      if (L.sets.length >= SEED_SETS_MAX) L.sets.splice(L.sets.reduce((o, s, i) => (s.at < L.sets[o].at ? i : o), 0), 1);
      L.sets.push(set = { lang, key, files: sel.map((f) => [f.path, toBase64(f.data)]), sessions: [], at: 0 });
    }
    const who = reporter ?? 's:' + sid;
    if (!set.sessions.includes(who) && set.sessions.length < SEED_SESSIONS_MAX) set.sessions.push(who);
    set.at = Date.now();
    seedsChanged(name);
    return true;
  };
  const seedFor = (name, lang) => {
    let best = null;
    for (const s of seedsOf(name).sets) if (s.lang === lang && s.sessions.length >= seedQuorum && (!best || s.sessions.length > best.sessions.length || (s.sessions.length === best.sessions.length && s.at > best.at))) best = s;
    return best ? { key: best.key, files: best.files.map(([p, d]) => ({ path: p, data: d })) } : { files: [] };
  };

  /**
   * Learned code heat, per manifest: the code ranges (module, offset, length) that ran in the sessions' translations
   * (their visit flags), posted by the worker; /api/heat/<manifest> returns them merged per module ({ module: [rva, len,
   * ...] }) for the JIT's region formation (src/cpu/jit/heat.js: a region leaves out the successors that never ran).
   * Kept in opts.learnDir/heat-<manifest>.json when set.
   */
  const heatLearned = new Map(); // manifest -> Map(module -> RangeHeat of offsets)
  const heatFile = (name) => opts.learnDir && path.join(opts.learnDir, `heat-${learnName(name)}.json`);
  const heatOf = (name) => {
    let m = heatLearned.get(name);
    if (!m) {
      m = new Map(); heatLearned.set(name, m);
      const f = heatFile(name);
      if (f) try { for (const [mod, list] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) { const h = new RangeHeat(); for (let i = 0; i + 1 < list.length; i += 2) h.add(list[i], list[i] + list[i + 1]); h.merge(); m.set(mod, h); } } catch { /* none yet */ }
    }
    return m;
  };
  const heatJson = (name) => { const o = Object.create(null); for (const [mod, h] of heatOf(name)) { const p = h.pairs(), l = []; for (let i = 0; i < p.length; i += 2) l.push(p[i], p[i + 1] - p[i]); o[mod] = l; } return o; };
  let heatDirty = new Set(), heatTimer = null;
  // (bounds per manifest: modules, and merged ranges over all its modules — a client posting scattered ranges cannot grow
  // the file or the answers past ~HEAT_RANGES pairs)
  const HEAT_MODULES = 256, HEAT_RANGES = 400000;
  const learnHeat = (name, list) => {
    const m = heatOf(name);
    let total = 0; for (const h of m.values()) total += h.size;
    for (const e of Array.isArray(list) ? list : []) {
      if (total >= HEAT_RANGES) break;
      if (!Array.isArray(e) || typeof e[0] !== 'string' || e[0].length > 64 || !Number.isInteger(e[1]) || e[1] < 0 || e[1] >= 0x40000000 || !Number.isInteger(e[2]) || e[2] <= 0 || e[2] > 0x100000) continue;
      const mod = e[0].toLowerCase();
      let h = m.get(mod);
      if (!h) { if (m.size >= HEAT_MODULES) continue; h = new RangeHeat(); m.set(mod, h); }
      h.add(e[1], e[1] + e[2]); total++;
    }
    for (const h of m.values()) h.merge();
    if (heatFile(name)) {
      heatDirty.add(name);
      heatTimer ??= setTimeout(() => {
        heatTimer = null;
        for (const n of heatDirty) { const f = heatFile(n); try { fs.writeFileSync(f + '.tmp', JSON.stringify(heatJson(n))); fs.renameSync(f + '.tmp', f); } catch { /* next time */ } }
        heatDirty = new Set();
      }, opts.learnWriteMs ?? 20000);
      heatTimer.unref?.();
    }
  };

  /** compressed range transport totals (requests, bytes read, bytes sent, encoding time) */
  // (split by kind: `demand` the game's own reads (&s=), `bg` the background downloads (&p=1); `ms` the time from the
  // request to the last byte handed to the socket, simulated link included)
  // (testing: opts.netTrace, a file — one line per compressed range answered: start s, duration s, kind, file, range, bytes sent)
  const netTrace = opts.netTrace ? (line) => { try { fs.appendFileSync(opts.netTrace, line + '\n'); } catch { /* no trace */ } } : null;
  const netStats = { requests: 0, raw: 0, sent: 0, encodeMs: 0, cacheHits: 0, demand: { requests: 0, sent: 0, ms: 0 }, bg: { requests: 0, sent: 0, ms: 0, aborted: 0 } };
  /** encoded ranges kept for the next players (key: file, mtime, range, encoding), least recently used first out */
  const encodedCache = new Map(); let encodedBytes = 0;
  const ENCODED_CACHE_MAX = opts.encodedCacheBytes ?? 256 * 1024 * 1024;
  const sendRangeEncoded = (req, res, file, r, kind = 'demand') => {
    const tReq = performance.now();
    let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
    const rm = /^(\d+)-(\d+)$/.exec(r);
    if (!rm) return send(res, 400, 'bad range');
    const start = Number(rm[1]), end = Math.min(Number(rm[2]), st.size);
    if (!(start < end) || end - start > 64 * 1024 * 1024) return send(res, 416, 'bad range');
    const accept = String(req.headers['accept-encoding'] ?? '');
    const enc = zlib.zstdCompress && /\bzstd\b/.test(accept) ? 'zstd' : /\bgzip\b/.test(accept) ? 'gzip' : null;
    const key = `${file}|${st.mtimeMs}|${start}-${end}|${enc}`;
    const reply = (body, encoding) => {
      netStats.requests++; netStats.raw += end - start; netStats.sent += body.length;
      const k = netStats[kind]; k.requests++;
      let finished = false;
      res.on('finish', () => { finished = true; k.sent += body.length; k.ms += performance.now() - tReq; netTrace?.(`${(tReq / 1000).toFixed(1)} ${((performance.now() - tReq) / 1000).toFixed(2)} ${kind} ${path.basename(file)} ${start}-${end} ${body.length}`); });
      res.on('close', () => { if (!finished && k.aborted !== undefined) k.aborted++; });
      const h = headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'X-Orthros-Raw': end - start });
      if (encoding) h['Content-Encoding'] = encoding;
      const go = () => { res.writeHead(200, h); res.end(body); };
      if (link) viaLink(res, body.length, go); else go();
    };
    const hit = encodedCache.get(key);
    if (hit) { encodedCache.delete(key); encodedCache.set(key, hit); netStats.cacheHits++; return reply(hit.body, hit.encoding); }
    const buf = Buffer.alloc(end - start);
    fs.open(file, 'r', (err, fd) => {
      if (err) return send(res, 500, String(err));
      fs.read(fd, buf, 0, buf.length, start, (err2, n) => {
        fs.close(fd, () => {});
        if (err2 || n !== buf.length) return send(res, 500, String(err2 ?? 'short read'));
        if (!enc) return reply(buf, null);
        const t0 = performance.now();
        const done = (err3, out) => {
          netStats.encodeMs += performance.now() - t0;
          // (not worth it: sent as is — the encoded form is still cached, as the raw bytes)
          const entry = !err3 && out.length < buf.length * 0.92 ? { body: out, encoding: enc } : { body: buf, encoding: null };
          encodedCache.set(key, entry); encodedBytes += entry.body.length;
          for (const [k, v] of encodedCache) { if (encodedBytes <= ENCODED_CACHE_MAX) break; encodedCache.delete(k); encodedBytes -= v.body.length; }
          reply(entry.body, entry.encoding);
        };
        if (enc === 'zstd') zlib.zstdCompress(buf, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }, done);
        else zlib.gzip(buf, { level: 4 }, done);
      });
    });
  };

  const accountApi = opts.accountsDir ? createAccountApi(opts.accountsDir, { publicOrigin: opts.accountOrigin, allowedGame: (game) => !!getManifest(game) }) : null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    try {
      if (p === '/api/account' || p.startsWith('/api/account/') || p === '/api/cloud' || p.startsWith('/api/cloud/')) {
        if (!accountApi) return send(res, 503, 'accounts unavailable');
        accountApi(req, res).catch((e) => { console.error('account API:', e); if (!res.headersSent) send(res, e.status ?? 500, 'account API error'); else res.destroy(); });
        return;
      }
      if (p === '/api/config') return send(res, 200, JSON.stringify({ version: buildVersion(), defaultManifest: opts.defaultManifest ?? null, telemetry: !!opts.telemetryDir, accounts: !!accountApi, encodedRanges: true, prefetch: true, programCache: true, regionCache: true, profileSeed: true }), { 'Content-Type': 'application/json' });
      if (p === '/api/telemetry' && req.method === 'POST') {
        if (!opts.telemetryDir) return send(res, 404, 'telemetry off');
        let body = '', size = 0;
        req.on('data', (d) => { size += d.length; if (size <= 256 * 1024) body += d; });
        req.on('end', () => {
          let rec; try { rec = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
          if (size > 256 * 1024) return send(res, 413, 'too large');
          const day = new Date().toISOString().slice(0, 10);
          fs.appendFile(path.join(opts.telemetryDir, `telemetry-${day}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n', () => {});
          send(res, 204, '');
        });
        return;
      }
      if (p === '/' || p === '/index.html') return sendFile(req, res, path.join(ROOT, 'src/host/web/index.html'), MIME['.html']);
      if (p === '/api/manifests') {
        refreshCatalog();
        const sizeOf = (t) => Object.values(t.files).reduce((a, f) => a + f.size, 0) + Object.values(t.dirs).reduce((a, d) => a + sizeOf(d), 0);
        const out = [...manifests].map(([name, m]) => {
          let bytes = null;
          try { if (fs.existsSync(m.folder) && (!m.baseFolder || fs.existsSync(m.baseFolder))) { if (!treeObjs.has(name)) treeObjs.set(name, listGameTree(m)); bytes = sizeOf(treeObjs.get(name)); } } catch { /* folder missing */ }
          return { name, title: m.name ?? name, gameId: m.gameId ?? name, version: m.version ?? null,
            versionOrder: m.versionOrder ?? 0, languages: m.languages ?? [], exe: m.exe,
            description: m.description ?? null, descriptionFr: m.descriptionFr ?? null,
            hidden: !!m.hidden, cover: !!coverFile(m), bytes, available: bytes !== null };
        });
        return send(res, 200, JSON.stringify(out), { 'Content-Type': 'application/json' });
      }
      let m = /^\/api\/manifest\/([^/]+)$/.exec(p);
      if (m) { const man = getManifest(m[1]); if (!man) return send(res, 404, 'no such manifest'); return send(res, 200, JSON.stringify({ ...man, folder: undefined, baseFolder: undefined, saveDir: undefined }), { 'Content-Type': 'application/json' }); }
      m = /^\/api\/cover\/([^/]+)$/.exec(p);
      if (m) { // the game's own image named by its manifest (a splash screen), found whatever the case of its path
        const man = getManifest(m[1]), f = man && coverFile(man);
        if (!f) return send(res, 404, 'no cover');
        const ext = path.extname(f).toLowerCase();
        res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Cross-Origin-Resource-Policy': 'same-origin' });
        fs.createReadStream(f).pipe(res);
        return;
      }
      m = /^\/api\/tree\/([^/]+)$/.exec(p);
      if (m) { const man = getManifest(m[1]); if (!man) return send(res, 404, 'no such manifest'); if (!trees.has(m[1])) { if (!treeObjs.has(m[1])) treeObjs.set(m[1], listGameTree(man)); trees.set(m[1], JSON.stringify(treeObjs.get(m[1]))); } return send(res, 200, trees.get(m[1]), { 'Content-Type': 'application/json' }); }
      // compressed ranges: /gamez/<manifest>/<path>?r=<start>-<end> (end exclusive), the bytes encoded with zstd or gzip
      // when that saves enough (Content-Encoding: the browser decodes before the page sees them), else sent as they are
      m = /^\/gamez\/([^/]+)\/(.*)$/.exec(p);
      if (m) {
        const man = getManifest(m[1]); if (!man) return send(res, 404, 'no such manifest');
        const file = resolveGameFile(man, m[2]); if (!file) return send(res, 404, 'not found');
        const r = url.searchParams.get('r') ?? '', rm = /^(\d+)-(\d+)$/.exec(r);
        if (rm && !url.searchParams.get('p')) learnRead(m[1], m[2], Number(rm[1]), Number(rm[2]), url.searchParams.get('s'));
        return sendRangeEncoded(req, res, file, r, url.searchParams.get('p') || url.searchParams.get('a') ? 'bg' : 'demand');
      }
      m = /^\/api\/regions\/([^/]+)$/.exec(p);
      if (m) {
        if (!getManifest(m[1])) return send(res, 404, 'no such manifest');
        if (req.method === 'POST') {
          let body = '', size = 0;
          req.on('data', (d) => { size += d.length; if (size <= 8 * 1024 * 1024) body += d; });
          req.on('end', () => {
            if (size > 8 * 1024 * 1024) return send(res, 413, 'too large');
            let rec; try { rec = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
            learnRegions(m[1], rec?.regions, rec?.covered);
            send(res, 204, '');
          });
          return;
        }
        return send(res, 200, JSON.stringify(regionsList(m[1])), { 'Content-Type': 'application/json' });
      }
      m = /^\/api\/heat\/([^/]+)$/.exec(p);
      if (m) {
        if (!getManifest(m[1])) return send(res, 404, 'no such manifest');
        if (req.method === 'POST') {
          let body = '', size = 0;
          req.on('data', (d) => { size += d.length; if (size <= 16 * 1024 * 1024) body += d; });
          req.on('end', () => {
            if (size > 16 * 1024 * 1024) return send(res, 413, 'too large');
            let rec; try { rec = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
            learnHeat(m[1], rec?.heat);
            send(res, 204, '');
          });
          return;
        }
        return send(res, 200, JSON.stringify(heatJson(m[1])), { 'Content-Type': 'application/json' });
      }
      m = /^\/api\/programs\/([^/]+)$/.exec(p);
      if (m) {
        if (!getManifest(m[1])) return send(res, 404, 'no such manifest');
        if (req.method === 'POST') {
          let body = '', size = 0;
          req.on('data', (d) => { size += d.length; if (size <= 8 * 1024 * 1024) body += d; });
          req.on('end', () => {
            if (size > 8 * 1024 * 1024) return send(res, 413, 'too large');
            let rec; try { rec = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
            learnPrograms(m[1], rec?.programs, rec?.used);
            send(res, 204, '');
          });
          return;
        }
        return send(res, 200, JSON.stringify(programsList(m[1])), { 'Content-Type': 'application/json' });
      }
      m = /^\/api\/profile-seed\/([^/]+)$/.exec(p);
      if (m) {
        const man = getManifest(m[1]);
        if (!man) return send(res, 404, 'no such manifest');
        if (req.method === 'POST') {
          let body = '', size = 0;
          req.on('data', (d) => { size += d.length; if (size <= 512 * 1024) body += d; });
          req.on('end', () => {
            if (size > 512 * 1024) return send(res, 413, 'too large');
            let rec; try { rec = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
            if (man.profileSeed === false) return send(res, 204, '');
            send(res, learnSeed(m[1], rec, seedReporter(req, rec?.session)) ? 204 : 400, '');
          });
          return;
        }
        const lang = seedLang(url.searchParams.get('lang') ?? '');
        return send(res, 200, JSON.stringify(man.profileSeed === false || lang === null ? { files: [] } : seedFor(m[1], lang)), { 'Content-Type': 'application/json' });
      }
      m = /^\/api\/prefetch\/([^/]+)$/.exec(p);
      if (m) { if (!getManifest(m[1])) return send(res, 404, 'no such manifest'); return send(res, 200, JSON.stringify(prefetchList(m[1])), { 'Content-Type': 'application/json' }); }
      if (p === '/api/netstats') return send(res, 200, JSON.stringify(netStats), { 'Content-Type': 'application/json' });
      m = /^\/game\/([^/]+)\/(.*)$/.exec(p);
      if (m) { const man = getManifest(m[1]); if (!man) return send(res, 404, 'no such manifest'); const file = resolveGameFile(man, m[2]); if (!file) return send(res, 404, 'not found'); return sendFile(req, res, file, 'application/octet-stream'); }
      if (p.startsWith('/src/') || p.startsWith('/tools/') || p.startsWith('/tests/')) {
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
        return sendFile(req, res, file, MIME[path.extname(file)] ?? 'application/octet-stream');
      }
      return send(res, 404, 'not found');
    } catch (e) {
      return send(res, 500, String(e.stack || e));
    }
  });
  attachLan(server, opts.lanLog ?? ((m) => console.log(m))); // (the virtual LAN of the games: WebSocket /api/lan)
  return server;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1] || 8080) || 8080;
  const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const telemetryDir = arg('--telemetry'), learnDir = arg('--learn'), accountsDir = arg('--accounts');
  for (const d of [telemetryDir, learnDir, accountsDir]) if (d) fs.mkdirSync(d, { recursive: true });
  const server = createServer({ manifests: arg('--manifests'), gamesDir: arg('--games-dir'), defaultManifest: arg('--default'), telemetryDir, learnDir, accountsDir, profileSeedQuorum: arg('--profile-seed-quorum') ? Number(arg('--profile-seed-quorum')) : undefined });
  server.listen(port, '127.0.0.1', () => console.log(`orthros: http://127.0.0.1:${port}/`));
}
