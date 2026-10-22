// Development/serving host: static files (the page, the ES modules of the emulator), manifests,
// and the game folder served read-only with HTTP range requests + a JSON directory listing.
// Sends the COOP/COEP headers required for SharedArrayBuffer and Atomics.wait in the page.
// Usage: node src/host/server.js [--port 8080] [--manifests <dir>] [--games-dir <dir>] [--engines-dir <dir>] [--default <manifest>] [--telemetry <dir>] [--learn <dir>] [--br-cache <dir>|off] [--covers <dir>|off] [--br-cache-bytes N] [--accounts <dir>] [--mmo <dir>] [--profile-seed-quorum N] [--snapshot-jobs | --snapshot-queue]
//   --engines-dir: the installed engine releases of the browser ports (default data_engines/, docs/browser-ports.md)
//   --default: the page starts that game directly (the picker stays reachable with ?menu)
//   --telemetry: the page's per-second measurements (frame rate, frame times, emulated CPU) are appended to
//                <dir>/telemetry-<date>.jsonl, one line per batch, to study the slowdowns seen by a player
//   --learn: the order in which sessions read the game's file blocks is kept there (the prefetch list of later sessions),
//            the GL programs they built and the code regions they translated (both prepared ahead by later sessions),
//            and the small profile files first sessions wrote (shared first-launch profile; --profile-seed-quorum: the
//            distinct sessions that must report a set identical before it is offered, default 2; an operator-made set,
//            seedcanon-<manifest>.json written by tools/profile-seed-make.mjs, is offered first), and the shared snapshots
//            of the games' machines new players start from (docs/snapshot.md, stage 3)
//   --br-cache: where /gamez keeps its precompressed transport units (br-cache.js; default <learn>/../brcache, none
//            without --learn; `off`: none), at most --br-cache-bytes of them (default: 1.5 GiB grown to hold the launch sets)
//   --snapshot-jobs: when a page asks for a shared snapshot there is none of, a headless browser session of a new
//            player makes it (tools/snapshot-publish.mjs, one at a time, through the project's browser slots);
//            --snapshot-queue: the request is only queued, in <learn>/snapshots/queue.json, for tools/snapshot-jobs.mjs
//            (a sandboxed server: no browser from it)
//   --mmo: where the shared worlds of the versions with an `mmo` entry keep their characters and world state
//            (default <accounts>/mmo; without --accounts there is no shared world: the Orthros account is its identity)
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { BLOCK as LEARN_BLOCK, CHUNK as LEARN_CHUNK, unitOf, HttpBackend } from '../vfs/http-backend.js';
import { launchSummary, launchSet, entryPieces, PRE_PLAYABLE } from '../vfs/launch-set.js';
import { createBrCache } from './br-cache.js';
import { createAccountApi } from './accounts.js';
import { accountBridge, playerScope } from '../ports/openmw/account-bridge.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDefaults } from './manifest.js';
import { listGameTree, dirsStamp, resolveGameFile, resolveLightFile, DirListings } from './game-files.js';
import { LIGHT_DIR, readLight } from './light-copies.js';
import { lightCovers } from './light-covers.js';
import { loadGameCatalog, DEFAULT_GAMES_DIR } from './game-catalog.js';
import { lanUpgrades, acceptWebSocket } from './lan.js';
import { DEFAULT_ENGINES_DIR, engineFile, goldsrcEngineFiles, goldsrcInstalled, goldsrcModes, mapImageFile, portLaunchUrl, roomsApi, udpRelay } from './goldsrc.js';
import { openmwEngineFiles, openmwInstalled, openmwModes, openmwProxy, openmwWebText, withFrameMeter, withProgressiveView, withQualityTier, withSharedEngine, withStreaming } from './openmw.js';
import { leanPackages, withLeanPackage } from './openmw-lean.js';
import { re3EngineFiles, re3Installed, re3Modes, re3Module } from './re3.js';
import { mmoApi } from './mmo.js';
import { SimLink } from './sim-link.js';
import { programSourceId, ffKeyRegenerable } from '../gfx/program-id.js';
import { SEED_LIMITS, seedPathOk, seedSelect, seedKey, toBase64, fromBase64, seedCanonFile, canonSets } from './profile-seed.js';
import { RangeHeat } from '../cpu/jit/heat.js';
import { snapshotSourcesHash } from './snapshot-sources.js';
import { SnapshotStore, SnapshotJobs, SnapshotQueue, SNAPSHOT_KEY } from './snapshot-store.js';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.lua': 'text/plain; charset=utf-8' };

export const listTree = (dir) => listGameTree({ folder: dir });
/** A file version's validator (weak: the same for its encoded answers — a brotli body decodes to the same bytes). */
const etagOf = (st) => `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
/** the page's own text files (src/): sent brotli 11 once made (srcBrotli) */
const SRC_TEXT = /\.(m?js|html|css|json|svg|txt)$/;
/** The size of the file at `rel` ('/'-separated, exact names) in a tree of listGameTree, or null. */
const treeFileSize = (tree, rel) => {
  const parts = rel.split('/'), light = parts[0] === LIGHT_DIR; // (a light copy's: its size the file's `light`)
  if (light) parts.shift();
  let node = tree;
  for (let i = 0; i < parts.length - 1; i++) { node = Object.hasOwn(node.dirs, parts[i]) ? node.dirs[parts[i]] : null; if (!node) return null; }
  const f = Object.hasOwn(node.files, parts.at(-1)) ? node.files[parts.at(-1)] : null;
  return !f ? null : light ? f.light ?? null : f.size;
};

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

/**
 * A request's path, decoded, when it is safe to route: never a '..' or '.' segment, a backslash or a NUL once decoded
 * (WHATWG URL folds a literal '/../' but leaves '..%2f' and '%5c' encoded, so a decoded path could climb out of the
 * directory a route serves), else null — malformed escapes too.
 */
export function requestPath(pathname) {
  let p; try { p = decodeURIComponent(pathname); } catch { return null; }
  if (p.includes('\\') || p.includes('\0') || p.split('/').some((s) => s === '..' || s === '.')) return null;
  return p;
}

/** `file` is inside the directory `dir` (resolved, a trailing separator: '/srv/orthros2' is not under '/srv/orthros'). */
export const isUnder = (dir, file) => path.resolve(file).startsWith(path.resolve(dir) + path.sep);

export function createServer(opts = {}) {
  const manifestDir = opts.manifests ? path.resolve(opts.manifests) : null;
  const gamesDir = path.resolve(opts.gamesDir ?? DEFAULT_GAMES_DIR);
  const enginesDir = path.resolve(opts.enginesDir ?? DEFAULT_ENGINES_DIR);
  const readCatalog = () => manifestDir ? loadManifests(manifestDir, opts.extra) : loadGameCatalog(gamesDir, opts.extra, { enginesDir });
  let manifests = readCatalog();
  const trees = new Map(), treeObjs = new Map();
  // (the catalog read again — at each /api/manifests: a game added appears —, the trees of the manifests that say the
  // same kept: listing a game's tree is a stat of each of its files, all of them ~0.5 s that held every request)
  const refreshCatalog = () => {
    const before = manifests; manifests = readCatalog();
    for (const id of [...treeObjs.keys()]) {
      if (manifests.has(id) && JSON.stringify(manifests.get(id)) === JSON.stringify(before.get(id))) continue;
      treeObjs.delete(id); trees.delete(id);
    }
  };
  // (a game's tree, listed once: again when one of the folders it was listed from changed — a file added, removed or
  // renamed there, a version, a map, an re3 engine release installed, removed or rebuilt while the server runs: its
  // gamefiles/, whose files /game/ and /gamez/ resolve at each request —; looked at each time, one stat a folder: all
  // the trees of the library 5.6 ms, against 0.5 s to list them)
  const gameTree = (id, man) => {
    const cached = treeObjs.get(id);
    if (cached && dirsStamp(cached.dirs) === cached.stamp) return cached.tree;
    const dirs = [], tree = listGameTree(man, dirs);
    treeObjs.set(id, { tree, dirs, stamp: dirsStamp(dirs) }); trees.delete(id);
    return tree;
  };
  /** A tree's bytes (its files', every folder's), summed once per tree object (a tree listed again is a new one). */
  const treeSizes = new WeakMap();
  const treeBytes = (t) => {
    let n = treeSizes.get(t);
    if (n === undefined) { n = 0; for (const f of Object.values(t.files)) n += f.size; for (const d of Object.values(t.dirs)) n += treeBytes(d); treeSizes.set(t, n); }
    return n;
  };
  /** The tree as /api/tree sends it. */
  const gameTreeJson = (id, man) => { const tree = gameTree(id, man); if (!trees.has(id)) trees.set(id, JSON.stringify(tree)); return trees.get(id); };
  /**
   * The tree, brotli or gzip when the browser takes it (a page fetches it at every start and Prepare: 289 KB for
   * Half-Life, 1.3 MB for Morrowind — 2.9 and 13 s at 100 KB/s; brotli 9: 43 KB for Half-Life), made once per tree.
   */
  const treeEncoded = new Map(); // id -> { json, br, gz }
  const sendTree = (req, res, id, man) => {
    const json = gameTreeJson(id, man), accept = String(req.headers['accept-encoding'] ?? '');
    let c = treeEncoded.get(id);
    if (c?.json !== json) treeEncoded.set(id, c = { json, br: null, gz: null });
    const type = { 'Content-Type': 'application/json', 'Vary': 'Accept-Encoding' };
    if (/\bbr\b/.test(accept)) {
      c.br ??= zlib.brotliCompressSync(json, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: json.length } });
      return send(res, 200, c.br, { ...type, 'Content-Encoding': 'br', 'Content-Length': c.br.length });
    }
    if (/\bgzip\b/.test(accept)) { c.gz ??= zlib.gzipSync(json); return send(res, 200, c.gz, { ...type, 'Content-Encoding': 'gzip', 'Content-Length': c.gz.length }); }
    return send(res, 200, json, type);
  };
  // (the folders' listings the requests resolve paths with, each checked by a stat of its folder: DirListings)
  const listings = new DirListings(opts.listingNames);
  const getManifest = (id) => { if (!manifests.has(id) && !manifestDir) refreshCatalog(); return manifests.get(id); };
  const coverFile = (man) => man.coverPath ?? (man.cover && resolveGameFile(man, man.cover));
  const runtimeOf = (man) => man.runtime ?? 'win32';
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
  const viaLink = (res, bytes, go, onStart = null) => { const cancel = link.send(bytes, go, onStart); res.on('close', cancel); };
  const send = (res, code, body, extra) => { res.writeHead(code, headers({ 'Content-Type': 'text/plain; charset=utf-8', ...extra })); res.end(body); };
  /**
   * A whole file's answer when the browser has it already (its validators, revalidated: Cache-Control no-cache): 304,
   * no body. The Win32 page's workers each load their module graph (380 fetches of 150 modules, 8.3 MB per visit,
   * measured): every one of them a revalidation once the browser has the module.
   */
  const notModified = (req, st, etag) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const inm = req.headers['if-none-match'];
    if (inm !== undefined) return String(inm).split(',').some((t) => { t = t.trim(); return t === '*' || t.replace(/^W\//, '') === etag.replace(/^W\//, ''); });
    const ims = Date.parse(String(req.headers['if-modified-since'] ?? ''));
    return Number.isFinite(ims) && Math.floor(st.mtimeMs / 1000) * 1000 <= ims;
  };
  const sendNotModified = (res, h) => { const { 'Content-Length': _l, 'Content-Range': _r, ...rest } = h; res.writeHead(304, rest); res.end(); };
  const sendFile = (req, res, file, mime, extra = {}) => {
    let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
    if (!st.isFile()) return send(res, 404, 'not found');
    const range = req.headers.range, etag = etagOf(st);
    const h = headers({ 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString(), 'ETag': etag, ...extra });
    if (!range && notModified(req, st, etag)) return sendNotModified(res, h);
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
   * A brotli file sent whole as its decoded content (Content-Encoding: br). No Content-Length: a loader counting the
   * decoded bytes against it (Emscripten's package download) falls back to the decoded size it knows. Its sizes said
   * instead, for a client counting the transfer (download-worker.js fetchEngine: the body comes decoded):
   * X-Orthros-Wire-Length (the brotli bytes) and X-Orthros-Decoded-Length (`decoded`, when known).
   */
  const sendBrotli = (req, res, br, mime, extra = {}, decoded = null) => {
    let st; try { st = fs.statSync(br); } catch { return send(res, 404, 'not found'); }
    const etag = etagOf(st), h = headers({ 'Content-Type': mime, 'Content-Encoding': 'br', 'Last-Modified': st.mtime.toUTCString(), 'ETag': etag, ...extra,
      'X-Orthros-Wire-Length': String(st.size), ...(decoded > 0 ? { 'X-Orthros-Decoded-Length': String(decoded) } : {}) });
    if (notModified(req, st, etag)) return sendNotModified(res, h);
    res.writeHead(200, h);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(br).pipe(res);
  };
  /**
   * The page's own files (src/, and the pages: no build step, the browser loads the modules as they are): revalidated
   * at each load (Cache-Control no-cache: a new tree is new code at once), 304 when unchanged (sendFile), and a text
   * file sent brotli 11 once made — 0.90 MB for the Win32 page's 3.26 MB of modules where the reverse proxy's gzip
   * makes 1.03 MB (measured, docs/slow-network.md). Made in the background at its first request (brotli 11: a few
   * hundred ms of a core for the largest modules, on libuv's pool), that one sent as it is; kept in memory by the
   * file's size and mtime (the tree's text is ~4 MB, its brotli ~1 MB), checked again once made.
   */
  const srcBr = new Map(); // file -> { size, mtimeMs, br (Buffer | null: not worth it | undefined: being made) }
  let srcBrBytes = 0;
  const SRC_BR_MAX = 64 << 20;
  // (at most SRC_BR_JOBS made at once: a first load's ~150 modules would otherwise fill libuv's 4-thread pool, the game
  // data's reads — /gamez, /api ranges — waiting behind them)
  const SRC_BR_JOBS = 2, srcBrJobs = [];
  let srcBrRunning = 0, srcBrPeak = 0;
  const srcBrPump = () => {
    while (srcBrRunning < SRC_BR_JOBS && srcBrJobs.length) {
      srcBrRunning++; srcBrPeak = Math.max(srcBrPeak, srcBrRunning);
      let once = false;
      srcBrJobs.shift()(() => { if (once) return; once = true; srcBrRunning--; srcBrPump(); });
    }
  };
  const srcBrotli = (file, st) => {
    const c = srcBr.get(file);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.br ?? null;
    if (c) { srcBrBytes -= c.br?.length ?? 0; srcBr.delete(file); }
    if (st.size > 8 << 20 || st.size < 512) return null; // (small: brotli's gain under a header's size)
    const e = { size: st.size, mtimeMs: st.mtimeMs, br: undefined };
    srcBr.set(file, e);
    srcBrJobs.push((done) => fs.readFile(file, (err, buf) => {
      if (err || buf.length !== st.size) { if (srcBr.get(file) === e) srcBr.delete(file); return done(); }
      zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }, (err2, out) => {
        done();
        let now = null; try { now = fs.statSync(file); } catch { /* gone */ }
        if (err2 || srcBr.get(file) !== e || !now || now.size !== e.size || now.mtimeMs !== e.mtimeMs) { if (srcBr.get(file) === e) srcBr.delete(file); return; }
        e.br = out.length <= buf.length * 0.92 ? out : null;
        srcBrBytes += e.br?.length ?? 0;
        for (const [k, v] of srcBr) { if (srcBrBytes <= SRC_BR_MAX) break; if (v.br) { srcBrBytes -= v.br.length; srcBr.delete(k); } } // (oldest out)
      });
    }));
    srcBrPump();
    return null;
  };
  // (opts.prewarmSrc: every text file of src/ made at start, in the background two at a time — after a deployment, a
  // restart, the first visitors got the page's modules as they are: the Win32 page's 5.0 MB instead of ~0.85 MB in
  // brotli, measured; the ports' 0.8 MB)
  if (opts.prewarmSrc) setImmediate(() => {
    const walk = (dir) => { let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const d of names) { const f = path.join(dir, d.name); if (d.isDirectory()) walk(f); else if (SRC_TEXT.test(d.name)) { try { srcBrotli(f, fs.statSync(f)); } catch { /* gone */ } } } };
    walk(path.join(ROOT, 'src'));
  });
  const sendSource = (req, res, file, mime) => {
    let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
    if (!st.isFile() || req.headers.range || !SRC_TEXT.test(file)) return sendFile(req, res, file, mime);
    const etag = etagOf(st), vary = { 'Vary': 'Accept-Encoding' };
    const br = /\bbr\b/.test(String(req.headers['accept-encoding'] ?? '')) && !notModified(req, st, etag) ? srcBrotli(file, st) : null;
    if (!br) return sendFile(req, res, file, mime, vary);
    res.writeHead(200, headers({ 'Content-Type': mime, 'Content-Encoding': 'br', 'Content-Length': br.length, 'Last-Modified': st.mtime.toUTCString(), 'ETag': etag, ...vary }));
    res.end(req.method === 'HEAD' ? undefined : br);
  };
  /**
   * An engine release's file, or its precompressed sibling (<file>.br, as releases ship them: OpenMW's 204 MB package is
   * 33 MB) when the browser takes brotli and asks for the whole file (sendBrotli).
   */
  const sendEngineFile = (req, res, file, cache) => {
    const mime = MIME[path.extname(file)] ?? 'application/octet-stream';
    let br = null, st = null;
    try { st = fs.statSync(file); if (fs.statSync(file + '.br').mtimeMs >= st.mtimeMs) br = file + '.br'; } catch { /* none */ }
    if (!br) return sendFile(req, res, file, mime, { 'Cache-Control': cache });
    if (req.headers.range || !/\bbr\b/.test(String(req.headers['accept-encoding'] ?? ''))) return sendFile(req, res, file, mime, { 'Cache-Control': cache, 'Vary': 'Accept-Encoding' });
    sendBrotli(req, res, br, mime, { 'Cache-Control': cache, 'Vary': 'Accept-Encoding' }, st.size);
  };

  /**
   * Learned prefetch order, per manifest: the 1 MiB blocks the game read synchronously in earlier sessions, with the
   * earliest time since its session's first read it was needed ('s' parameter of /gamez requests; prefetch requests,
   * 'p=1', are not counted). /api/prefetch/<manifest> lists them in that order: a new session downloads them in the
   * background (network otherwise idle while the game computes) before the game asks for them. Kept in
   * opts.learnDir/prefetch-<manifest>.json when set. Each block also carries the mask of the 64 KiB pieces sessions
   * read in it (bit i: piece i; absent for blocks learned before masks): a session fetches those pieces ahead of the
   * game — a few pieces of each block is what a run of small random reads needs, not whole blocks. A page marks the
   * moment its game is first playable (a report's `mark`: { kind: 'playable' }, GameData.mark): each block that session
   * had read by then counts it (`pre`), the version the marking sessions (`marks`, kept in playable-<manifest>.json); once
   * one marked, each listed block carries flags (bit 0, launch-set.js PRE_PLAYABLE: read before playable in at least
   * half of them) — the launch set.
   */
  const learned = new Map(); // manifest -> Map("path#block" -> { t, n, mask, pre })
  /** mask of the 64 KiB pieces of a block covered by [a, b) (offsets within the block) */
  const pieceBits = (a, b) => { let m = 0; for (let c = Math.floor(a / LEARN_CHUNK); c * LEARN_CHUNK < b; c++) m |= 1 << c; return m >>> 0; };
  const sessions = new Map(); // session id -> { start, last, seen: Set, marked? }, least recently active first
  const SESSIONS_MAX = opts.sessionsMax ?? 256;
  const learnFile = (name) => opts.learnDir && path.join(opts.learnDir, `prefetch-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const learnedOf = (name) => {
    let m = learned.get(name);
    if (!m) {
      m = new Map(); learned.set(name, m);
      const f = learnFile(name);
      if (f) try { for (const [k, t, n, mask, pre, by, ph] of JSON.parse(fs.readFileSync(f, 'utf8'))) m.set(k, { t, n, mask: mask ?? undefined, pre: pre || 0, ...(by && typeof by === 'object' ? { by } : {}), ...(ph && typeof ph === 'object' ? { ph } : {}) }); } catch { /* none yet */ }
    }
    return m;
  };
  const playable = new Map(); // manifest -> { marks, by: { [game language]: marks } }
  const playableFile = (name) => opts.learnDir && path.join(opts.learnDir, `playable-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const playableOf = (name) => {
    let p = playable.get(name);
    if (!p) {
      p = { marks: 0, by: {} }; playable.set(name, p);
      const f = playableFile(name);
      if (f) try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); p.marks = Number(j.marks) || 0; if (j.by && typeof j.by === 'object') p.by = j.by; } catch { /* none yet */ }
    }
    return p;
  };
  /**
   * The phases of a version's sessions (a page's GameData.phase: a map, a level): each phase's start in the sessions that
   * entered it (ms from their start; the last PHASE_STARTS kept), in phases-<manifest>.json. A block read first in a phase
   * keeps, by phase, the earliest time it was needed from that phase's start (the entry's `ph`): prefetchList places it
   * at its phase's usual start plus that time — each phase's reads together, in the order its load reads them.
   */
  const PHASE_STARTS = 31;
  const phaseStarts = new Map(); // manifest -> Map(phase -> [start ms, ...])
  const phasesFile = (name) => opts.learnDir && path.join(opts.learnDir, `phases-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const phasesOf = (name) => {
    let q = phaseStarts.get(name);
    if (!q) {
      q = new Map(); phaseStarts.set(name, q);
      const f = phasesFile(name);
      if (f) try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) if (Array.isArray(v)) q.set(k, v.filter(Number.isFinite).slice(-PHASE_STARTS)); } catch { /* none yet */ }
    }
    return q;
  };
  /** A phase's usual start: the median of its sessions' starts (a session that jumps to it at once does not move it alone). */
  const phaseStart = (q, phase) => { const s = q.get(phase); if (!s?.length) return null; const o = [...s].sort((a, b) => a - b); return o[Math.floor((o.length - 1) / 2)]; };
  let learnDirty = new Set(), learnTimer = null;
  // (`read`: a session's read changed the order — the launch summaries made from it go on serving for LAUNCH_STALE_MS:
  // with players in a game each of their reads made /api/manifests summarize its launch set again, ~100 ms of the
  // server's thread at every home under 20 players, measured; a mark, which makes the launch set, forgets them)
  const learnSave = (name, read = false) => {
    if (!read) launches.delete(name);
    else for (const c of launches.get(name)?.values() ?? []) c.stale = true;
    if (!learnFile(name)) return;
    learnDirty.add(name);
    learnTimer ??= setTimeout(() => {
      learnTimer = null;
      for (const n of learnDirty) {
        const f = learnFile(n);
        try { fs.writeFileSync(f + '.tmp', JSON.stringify([...learnedOf(n)].map(([k, v]) => (v.ph ? [k, v.t, v.n, v.mask ?? null, v.pre ?? 0, v.by ?? null, v.ph] : v.pre ? [k, v.t, v.n, v.mask ?? null, v.pre, ...(v.by ? [v.by] : [])] : v.mask === undefined ? [k, v.t, v.n] : [k, v.t, v.n, v.mask])))); fs.renameSync(f + '.tmp', f); } catch { /* next time */ }
        const qf = phasesFile(n), q = phaseStarts.get(n);
        if (qf && q?.size) try { fs.writeFileSync(qf + '.tmp', JSON.stringify(Object.fromEntries(q))); fs.renameSync(qf + '.tmp', qf); } catch { /* next time */ }
        const pf = playableFile(n), pm = playable.get(n);
        if (pm?.marks) try { fs.writeFileSync(pf + '.tmp', JSON.stringify({ marks: pm.marks, ...(Object.keys(pm.by).length ? { by: pm.by } : {}) })); fs.renameSync(pf + '.tmp', pf); } catch { /* next time */ }
      }
      learnDirty = new Set();
    }, opts.learnWriteMs ?? 20000);
    learnTimer.unref?.(); // (does not keep a finished process alive)
  };
  // (`at`: the read's time as the page measured it — a page reporting the reads it served itself, e.g. a browser port)
  const learnRead = (name, rel, start, end, sid, at = null) => {
    if (!sid || sid.length > 40) return;
    const now = Date.now();
    let ss = sessions.get(sid);
    if (!ss) {
      // (each session's `seen` holds a key per block it read — thousands: bounded, the least recently active out —
      // those idle an hour first —, the 6-hour sweep at a thousand sessions let a day of visitors keep hundreds of MB)
      if (sessions.size >= SESSIONS_MAX) {
        for (const [k, v] of sessions) if (now - v.last > 3600e3) sessions.delete(k);
        for (const k of sessions.keys()) { if (sessions.size < SESSIONS_MAX) break; sessions.delete(k); }
      }
      sessions.set(sid, ss = { start: now, last: now, seen: new Set() });
    } else { ss.last = now; sessions.delete(sid); sessions.set(sid, ss); } // (most recently active last)
    const m = learnedOf(name), t = at ?? now - ss.start;
    // (the session's phase at t: the last one started by then — learnPhases)
    let ph = null; for (const p of ss.phases ?? []) { if (p[1] <= t) ph = p; else break; }
    for (let b = Math.floor(start / LEARN_BLOCK); b * LEARN_BLOCK < end; b++) {
      const k = `${rel}#${b}`;
      const bits = pieceBits(Math.max(start, b * LEARN_BLOCK) - b * LEARN_BLOCK, Math.min(end, (b + 1) * LEARN_BLOCK) - b * LEARN_BLOCK);
      let e = m.get(k);
      if (!e) m.set(k, e = { t, n: 0, mask: 0 });
      e.mask = (e.mask ?? 0) | bits; // (every session's pieces, first read of the block or not)
      const sk = `${name}\0${k}`; // (a session reads the versions its game requires too: each one's blocks its own)
      if (ss.seen.has(sk)) continue;
      ss.seen.add(sk);
      e.t = Math.min(e.t, t); e.n++;
      if (ph && (e.ph?.[ph[0]] ?? Infinity) > t - ph[1]) (e.ph ??= {})[ph[0]] = t - ph[1];
    }
    learnSave(name);
  };
  /**
   * Session `sid` of version `name` told its phases so far ([[phase, start]…], a report's `phases`, GameData.phase): kept
   * for its reads (learnRead), each new one's start counted for the version.
   */
  const learnPhases = (name, sid, phases) => {
    if (!sid || sid.length > 40 || !Array.isArray(phases)) return;
    const list = phases.filter((p) => Array.isArray(p) && typeof p[0] === 'string' && p[0].length > 0 && p[0].length <= 64 && Number.isFinite(p[1]) && p[1] >= 0 && p[1] <= 6 * 3600e3)
      .slice(0, 200).map(([p, t]) => [p, Math.round(t)]).sort((a, b) => a[1] - b[1]);
    if (!list.length) return;
    let ss = sessions.get(sid);
    if (!ss) sessions.set(sid, ss = { start: Date.now(), seen: new Set() });
    ss.phases = list;
    const q = phasesOf(name), counted = (ss.phasesCounted ??= new Set());
    for (const [p, t] of list) {
      const key = `${name}\0${p}\0${t}`; if (counted.has(key)) continue;
      counted.add(key);
      const s = q.get(p) ?? []; s.push(t); q.set(p, s.slice(-PHASE_STARTS));
    }
    learnSave(name, true);
  };
  /**
   * Session `sid` marked version `name` (`kind`): 'playable' counts the blocks it read until now, once a session — and
   * for its game language (`lang`, when the page tells it: a language's own files, e.g. a game's translated texts, are
   * read before playable by that language's sessions only).
   */
  const learnMark = (name, sid, kind, lang = null) => {
    const ss = sessions.get(sid), own = `${name}\0`;
    if (kind !== 'playable' || !ss || ss.marked?.has(name)) return false;
    const keys = [...ss.seen].filter((sk) => sk.startsWith(own));
    if (!keys.length) return false;
    (ss.marked ??= new Set()).add(name); // (once per version: a Windows game marks the versions it requires too)
    const m = learnedOf(name), p = playableOf(name);
    for (const sk of keys) {
      const e = m.get(sk.slice(own.length)); if (!e) continue;
      e.pre = (e.pre ?? 0) + 1;
      if (lang) { e.by ??= {}; e.by[lang] = (e.by[lang] ?? 0) + 1; }
    }
    p.marks++;
    if (lang) p.by[lang] = (p.by[lang] ?? 0) + 1;
    learnSave(name);
    return true;
  };
  // (each entry: [path, block, mask (0: unknown), t (ms from its earliest session's first read)], and once a session
  // marked the version playable, flags: bit 0 read before playable in at least half the marking sessions — those of
  // game language `lang` when some of them told it, else all of them)
  const prefetchList = (name, lang = null) => {
    const p = playableOf(name), own = lang && p.by[lang] > 0 ? p.by[lang] : 0, marks = own || p.marks;
    // (a block learned in phases: in the phase of them that usually starts first — learnPhases —, the phases in the
    // order of their usual starts, each one's blocks together in the order its load read them; its time, that start plus
    // its time in the phase. Others: their time)
    const q = phasesOf(name), when = new Map();
    for (const [k, v] of learnedOf(name)) {
      let key = [v.t, '', 0];
      if (v.ph) for (const [ph, d] of Object.entries(v.ph)) { const s = phaseStart(q, ph); if (s !== null && (key[1] === '' || s < key[0] || (s === key[0] && ph < key[1]))) key = [s, ph, d]; }
      when.set(k, key);
    }
    const order = (a, b) => { const x = when.get(a[0]), y = when.get(b[0]); return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || x[2] - y[2]; };
    return [...learnedOf(name)].sort(order).slice(0, 8192).map(([k, v]) => {
      const w = when.get(k), i = k.lastIndexOf('#'), e = [k.slice(0, i), Number(k.slice(i + 1)), v.mask ?? 0, Math.round(w[0] + w[2])];
      const pre = own ? v.by?.[lang] ?? 0 : v.pre;
      if (marks) e.push(pre && pre * 2 >= marks ? PRE_PLAYABLE : 0);
      return e;
    });
  };
  /**
   * What a version's launch costs (launch-set.js launchSummary: its launch set's bytes, with and without light copies,
   * and their wire bytes — the precompressed units' when made, br-cache.js), for the home: null until a session marked
   * it playable. Made again once its learned order changed, or a minute later (the units made meanwhile). The versions it
   * requires (manifest.extraMounts: the game reads them too) add their own launch sets, each learned from its own
   * sessions (a version none of whose sessions was marked playable adds nothing). Each game language whose sessions
   * marked it has its own (`langs`: the launch set of that language's sessions, prefetchList). A browser port's engine
   * release, downloaded at a first launch, is told apart: `engine` (its wire bytes) and `engineFiles` (its URLs, which
   * "Prepare" fetches too: download-worker.js).
   */
  const launches = new Map(); // manifest -> Map(game language | '' -> { at, tree, v, stale })
  const LAUNCH_STALE_MS = opts.launchStaleMs ?? 30000;
  const ownLaunchOf = (name, man, lang = null) => {
    let byLang = launches.get(name); if (!byLang) launches.set(name, byLang = new Map());
    // (kept while the game's tree is the same one — what sessions learn forgets it, learnSave —, made again every ten
    // minutes all the same: the compressed sizes the server comes to know meanwhile)
    const c = byLang.get(lang ?? ''), tree = gameTree(name, man);
    if (c && c.tree === tree && Date.now() - c.at < (c.stale ? LAUNCH_STALE_MS : 600e3)) return c.v;
    let v = null;
    try {
      if (playableOf(name).marks) {
        const at = unitFile(man);
        v = launchSummary(new HttpBackend(`/game/${name}/`, tree), prefetchList(name, lang), brCache && ((rel, unit) => {
          const f = at(rel); return f ? brCache.size(f.file, f.st, f.light, unit) : null;
        }));
      }
    } catch { v = null; }
    byLang.set(lang ?? '', { at: Date.now(), tree, v });
    return v;
  };
  const launchOf = (name, man) => {
    const required = (Array.isArray(man.extraMounts) ? man.extraMounts : []).map((d) => (d?.manifest && d.manifest !== name ? [d.manifest, manifests.get(d.manifest)] : null)).filter((r) => r?.[1]);
    const summed = (lang) => {
      const v = ownLaunchOf(name, man, lang);
      if (!v) return v;
      const sum = { ...v };
      for (const [rn, rm] of required) {
        const r = ownLaunchOf(rn, rm, lang);
        if (r) for (const k of ['bytes', 'lightBytes', 'wire', 'lightWire', 'entries']) sum[k] += r[k];
      }
      return sum;
    };
    const sum = summed(null);
    if (!sum) return sum;
    // (the languages some marking sessions told, of this version or of one it requires — those the version declares:
    // markLang; marks kept from before it are left out)
    const langs = new Set([name, ...required.map(([rn]) => rn)].flatMap((n) => Object.keys(playableOf(n).by)).filter((l) => markLang(man, l) === l));
    if (langs.size) sum.langs = Object.fromEntries([...langs].sort().map((l) => [l, summed(l)]));
    // (the engine's own download at a first launch: told apart, a browser that ran it before has it)
    const engine = engineOf(man);
    sum.engine = engine.wire; sum.engineFiles = engine.urls;
    if (sum.langs) for (const l of Object.values(sum.langs)) { l.engine = engine.wire; l.engineFiles = engine.urls; }
    return sum;
  };
  /**
   * A browser port's engine release as its page downloads it at a first launch: { wire (bytes, brotli when served so —
   * sendEngineFile), urls } — none for a Win32 game.
   */
  const engineOf = (man) => {
    const [release, files] = man.runtime === 'openmw' ? [man.openmw?.engine, openmwEngineFiles(man, enginesDir)]
      : man.runtime === 'goldsrc' ? [man.goldsrc?.engine, goldsrcEngineFiles(man, enginesDir)]
        : man.runtime === 're3' ? [man.re3?.engine, re3EngineFiles(man, enginesDir)] : [null, []];
    let wire = 0; const urls = [];
    for (const rel of files) {
      const f = engineFile(enginesDir, release, rel); if (!f) continue;
      // (a game of its own loads OpenMW's package without the example world once this server made it: openmw-lean.js)
      const leanable = man.runtime === 'openmw' && rel.endsWith('/openmw.data') && !man.openmw.example;
      const leanUrl = leanable ? lean?.url(release) : null;
      const leanBytes = leanUrl ? lean.size(release) : null;
      if (leanBytes) { wire += leanBytes; urls.push(leanUrl + 'openmw.data'); continue; }
      // (while it is being made: none — "Prepare" would cache the release's own package, which the page stops asking for
      // once the lean one is there; it comes at the first launch, or with a later "Prepare")
      if (leanable && lean?.pending(release)) continue;
      try {
        const st = fs.statSync(f); let n = st.size;
        try { const br = fs.statSync(f + '.br'); if (br.mtimeMs >= st.mtimeMs) n = br.size; } catch { /* none */ }
        wire += n; urls.push(`/engines/${encodeURIComponent(release)}/${rel}`);
      } catch { /* gone */ }
    }
    return { wire, urls };
  };

  /**
   * Precompressed transport units (br-cache.js, docs/slow-network.md "Precompressed units"): opts.brCacheDir, at most
   * opts.brCacheBytes. Made first for the requests that missed them, then from each manifest's learned order (its
   * earliest reads first: the launch sets, pinned) — the browser ports' first, a listed texture's light copy before
   * the file. A learned block whose pieces are all known (or not known) is a block unit, else its pieces are.
   */
  /** The files of a version's paths (a light copy's too), resolved once: rel -> { file, st, light, size } | null. */
  const unitFile = (man) => {
    const files = new Map(), memo = listings; // (the folders' listings: a launch set's paths resolved in a row)
    return (rel) => {
      if (!files.has(rel)) {
        let v = null;
        try {
          const light = rel.startsWith(LIGHT_DIR + '/') ? resolveLightFile(man, rel, memo) : null;
          const file = light ? light.file : !rel.startsWith(LIGHT_DIR + '/') && resolveGameFile(man, rel, memo);
          if (file) { const st = light?.st ?? fs.statSync(file); v = { file, st, light, size: light ? light.copy.size : st.size }; }
        } catch { /* gone */ }
        files.set(rel, v);
      }
      return files.get(rel);
    };
  };
  /** A learned order, its launch set first (the entries flagged PRE_PLAYABLE), each part in its order: what is pinned. */
  const launchFirstOrder = (list) => { const first = [], rest = []; for (const e of list) ((e[4] & PRE_PLAYABLE) !== 0 ? first : rest).push(e); return first.concat(rest); };
  const brSeedUnits = function* (man, list) {
    const at = unitFile(man), lights = new Set();
    for (const [rel, block, mask] of list) {
      // (a light copy is read on a link that is not fast, by pieces: its pieces — one block when it is one piece)
      if (man.lightCopies && !rel.startsWith(LIGHT_DIR + '/') && !lights.has(rel)) {
        lights.add(rel);
        const l = at(`${LIGHT_DIR}/${rel}`);
        if (l) for (let c = 0; c * LEARN_CHUNK < l.size; c++) yield { file: l.file, st: l.st, light: l.light, unit: l.size <= LEARN_CHUNK ? { kind: 'b', index: 0 } : { kind: 'p', index: c } };
      }
      const f = at(rel), b0 = block * LEARN_BLOCK;
      if (!f || b0 >= f.size) continue;
      const pieces = Math.ceil(Math.min(LEARN_BLOCK, f.size - b0) / LEARN_CHUNK), all = pieces >= 32 ? 0xffffffff : (2 ** pieces - 1);
      if (!mask || ((mask & all) >>> 0) === all) { yield { file: f.file, st: f.st, light: f.light, unit: { kind: 'b', index: block } }; continue; }
      for (let c = 0; c < pieces; c++) if (mask & (1 << c)) yield { file: f.file, st: f.st, light: f.light, unit: { kind: 'p', index: block * (LEARN_BLOCK / LEARN_CHUNK) + c } };
    }
    // (not the blocks learned by pieces whole as well, the shape a fast link asks for them — measured, Half-Life on a
    // fast link: 59 % of the bytes it asked: 1473 of Morrowind's 1830 learned blocks are known by pieces, which would
    // make its order about three times the brotli work; a fast link's misses ask for them, made after the launch sets)
  };
  /**
   * How much of each version's launch set the precompressed units cover, in the shapes the links ask for it
   * (`/api/netstats?launch=1`, the generation backlog an operator reads): per manifest { marked, entries, fast: { units,
   * made, bytes, madeBytes } — its entries' blocks whole, as a fast link asks them —, light: { … } — the launch set as a
   * link that is not fast reads it (light copies, no media), by pieces —, lightBlocks: { … } — the same, the blocks whose
   * pieces are all wanted asked whole }. A version no session marked: its first pause (launch-set.js startupHead).
   */
  const launchCoverage = () => {
    const out = {};
    for (const [name, man] of manifests) {
      if (!learnFile(name) || !fs.existsSync(learnFile(name)) || !brCache) continue;
      try {
        const tree = gameTree(name, man), files = new HttpBackend(`/game/${name}/`, tree), at = unitFile(man), list = prefetchList(name);
        const count = (set, shape) => {
          const c = { units: 0, made: 0, bytes: 0, madeBytes: 0 };
          const add = (rel, unit, raw) => { const f = at(rel); if (!f) return; c.units++; c.bytes += raw; const w = brCache.size(f.file, f.st, f.light, unit); if (w !== null) { c.made++; c.madeBytes += raw; } };
          for (const e of set) {
            const p = entryPieces(files, e); if (!p) continue;
            const blockRaw = Math.min(LEARN_BLOCK, p.size - p.block * LEARN_BLOCK);
            if (shape === 'fast' || (shape === 'blocks' && p.whole) || p.size <= LEARN_CHUNK) add(p.path, { kind: 'b', index: p.block }, blockRaw);
            else for (const i of p.pieces) add(p.path, { kind: 'p', index: i }, Math.min(LEARN_CHUNK, p.size - i * LEARN_CHUNK));
          }
          return c;
        };
        const fastSet = launchSet(files, list, true), lightSet = launchSet(files, list, false);
        out[name] = { marked: playableOf(name).marks, entries: fastSet.length, fast: count(fastSet, 'fast'), light: count(lightSet, 'pieces'), lightBlocks: count(lightSet, 'blocks') };
      } catch (e) { out[name] = { error: String(e?.message ?? e) }; }
    }
    return out;
  };
  const brCache = opts.brCacheDir ? createBrCache({
    dir: opts.brCacheDir, maxBytes: opts.brCacheBytes, log: opts.brCacheLog ?? ((m) => console.log(m)), ...opts.brCacheOptions,
    // (each launch set's pinned part from its size, the home's: its own and its light copies' units, both made; the
    // versions without one — no session marked them — an equal part, after those with one)
    sources: () => [...manifests].filter(([name]) => learnFile(name) && fs.existsSync(learnFile(name)))
      .map(([name, man]) => { let l = null; try { l = ownLaunchOf(name, man); } catch { /* none */ } return [name, man, l ? l.wire + (man.lightCopies ? l.lightWire : 0) : null]; })
      .sort(([, a, wa], [, b, wb]) => (wa === null) - (wb === null) || (runtimeOf(a) === 'win32') - (runtimeOf(b) === 'win32'))
      .map(([name, man, want]) => ({ name, want, units: () => brSeedUnits(man, launchFirstOrder(prefetchList(name))) })),
  }) : null;
  /** The home's light covers (light-covers.js): opts.coverDir, none without it. */
  const covers = opts.coverDir ? lightCovers({ dir: opts.coverDir, log: opts.brCacheLog ?? ((m) => console.log(m)) }) : null;
  // (made from the start, one at a time in the background: the first home after a deploy already has most of them)
  if (covers) setImmediate(() => { for (const man of manifests.values()) { let f = null; try { f = coverFile(man); } catch { /* none */ } if (f) covers.make(f); } });
  /** OpenMW engine packages without the example world (openmw-lean.js), kept beside the units: none without them. */
  const lean = opts.brCacheDir ? leanPackages({ dir: path.join(opts.brCacheDir, 'engines'), enginesDir, log: opts.brCacheLog ?? ((m) => console.log(m)) }) : null;
  // (made from the start for the installed games of their own: not first at a card or a page, the window without it short)
  if (lean) for (const m of manifests.values()) if (m.runtime === 'openmw' && !m.openmw?.example && openmwInstalled(m, enginesDir)) lean.url(m.openmw.engine);

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
   * Each entry carries the translator version (program-id.js PROGRAM_GLSL_VERSION) of the last session that built or
   * used it: a session asking with ?v=<its version> gets the entries of that version only, plus the fixed-function
   * ones it regenerates from their key (ffKeyRegenerable) and, for PROGRAMS_UNSTAMPED_SESSIONS sessions after their
   * last use, entries learned before versions existed — the sources an older translator made are not compiled ahead
   * for nothing (a session that builds the same sources again at a draw stamps them with its version).
   */
  const programsLearned = new Map(); // manifest -> { sessions, m: Map(id -> { key, vs, fs, attrs, t, n, s }) }
  const learnName = (name) => name.replace(/[^A-Za-z0-9._-]/g, '_');
  const programsFile = (name) => opts.learnDir && path.join(opts.learnDir, `programs2-${learnName(name)}.json`);
  const programsFileV1 = (name) => opts.learnDir && path.join(opts.learnDir, `programs-${learnName(name)}.json`);
  const PROGRAMS_MAX = 4096, PROGRAM_SRC_MAX = 64 * 1024, PROGRAMS_KEEP_SESSIONS = 64, PROGRAMS_UNSTAMPED_SESSIONS = 4;
  const versionOf = (v) => (Number.isInteger(v) && v > 0 ? v : null);
  const programsOf = (name) => {
    let L = programsLearned.get(name);
    if (!L) {
      L = { sessions: 0, m: new Map() }; programsLearned.set(name, L);
      const read = (f) => { try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; } };
      const add = (id0, key, vs, fs2, attrs, t, n, s, v = null) => {
        if (typeof vs !== 'string' || typeof fs2 !== 'string' || !Array.isArray(attrs) || !attrs.every((a) => typeof a === 'string')) return;
        const id = typeof id0 === 'string' ? id0 : programSourceId(vs, fs2, attrs), old = L.m.get(id);
        t = Number.isFinite(t) ? t : 1e9; n = Number.isFinite(n) ? n : 1; s = Number.isFinite(s) ? s : L.sessions;
        if (old) { old.t = Math.min(old.t, t); old.n = Math.max(old.n, n); old.s = Math.max(old.s, s); old.v ??= versionOf(v); }
        else if (L.m.size < PROGRAMS_MAX) L.m.set(id, { key: typeof key === 'string' ? key : '', vs, fs: fs2, attrs, t, n, s, v: versionOf(v) });
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
        try { fs.writeFileSync(f + '.tmp', JSON.stringify({ sessions: L.sessions, v1: L.v1 ?? null, programs: [...L.m].map(([id, v]) => [id, v.key, v.vs, v.fs, v.attrs, v.t, v.n, v.s, v.v]) })); fs.renameSync(f + '.tmp', f); } catch { /* next time */ }
      }
      programsDirty = new Set();
    }, opts.learnWriteMs ?? 20000); // (tests: sooner)
    programsTimer.unref?.();
  };
  const learnPrograms = (name, list, used, version) => {
    const L = programsOf(name), m = L.m, ver = versionOf(version);
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || typeof e.key !== 'string' || typeof e.vs !== 'string' || typeof e.fs !== 'string' || !Array.isArray(e.attrs) || !e.attrs.every((a) => typeof a === 'string')) continue;
      if (e.key.length > 4096 || e.vs.length > PROGRAM_SRC_MAX || e.fs.length > PROGRAM_SRC_MAX || e.attrs.length > 32) continue;
      const t = Number.isFinite(e.t) ? Math.max(0, e.t) : 1e9, id = programSourceId(e.vs, e.fs, e.attrs), old = m.get(id);
      if (old) { old.t = Math.min(old.t, t); old.n++; old.s = L.sessions; if (ver) old.v = ver; continue; }
      if (m.size >= PROGRAMS_MAX) { // (full: the least recently used one leaves, unless all were used this session)
        let lru = null;
        for (const [k, v] of m) if (!lru || v.s < lru[1].s) lru = [k, v];
        if (lru[1].s >= L.sessions) continue;
        m.delete(lru[0]);
      }
      m.set(id, { key: e.key, vs: e.vs, fs: e.fs, attrs: e.attrs, t, n: 1, s: L.sessions, v: ver });
    }
    // (a learned program a session took was found by its exact sources: they are those of its version — except a
    // fixed-function one, regenerated from its key whatever sources it carries)
    for (const id of Array.isArray(used) ? used.slice(0, PROGRAMS_MAX) : []) { const v = typeof id === 'string' ? m.get(id) : null; if (v) { v.s = L.sessions; if (ver && !ffKeyRegenerable(v.key)) v.v = ver; } }
    programsChanged(name);
  };
  /**
   * The list a new session compiles ahead (a session starts: the entries unused for too long are dropped first);
   * `version`: the session's translator version (none: every entry, as before versions existed).
   */
  const programsList = (name, version = null) => {
    const L = programsOf(name), ver = versionOf(version);
    L.sessions++;
    for (const [id, v] of L.m) if (v.s < L.sessions - PROGRAMS_KEEP_SESSIONS) L.m.delete(id);
    programsChanged(name);
    const keep = (v) => !ver || v.v === ver || ffKeyRegenerable(v.key) || (v.v === null && v.s >= L.sessions - PROGRAMS_UNSTAMPED_SESSIONS);
    return [...L.m].filter(([, v]) => keep(v)).sort((a, b) => a[1].t - b[1].t).map(([id, v]) => ({ id, key: v.key, vs: v.vs, fs: v.fs, attrs: v.attrs, v: v.v }));
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
   * A game language a page told for version `man` (a playable mark, a launch set asked for): one the manifest declares
   * (its `languages`), lowercased, else null — not any word a client makes up (each one a stored count and a launch set
   * summed on every list of the versions).
   */
  const markLang = (man, l) => {
    const s = seedLang(l ?? '');
    return s && (Array.isArray(man?.languages) ? man.languages : []).some((x) => String(x).toLowerCase() === s) ? s : null;
  };
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
  // shared snapshots (snapshot-store.js, docs/snapshot.md stage 3): kept with the learned data; their publishing
  // sessions started by this server only when asked (--snapshot-jobs: headless browsers on this machine)
  const snapshots = opts.learnDir ? new SnapshotStore(path.join(opts.learnDir, 'snapshots')) : null;
  // (opts.snapshotJobs: 'queue' — requests left in a file for tools/snapshot-jobs.mjs —, true — sessions started here —,
  // or, in tests, an object of the same interface: want, job)
  const snapshotJobs = !snapshots || !opts.snapshotJobs ? null
    : opts.snapshotJobs === 'queue' ? new SnapshotQueue(path.join(snapshots.dir, 'queue.json'))
      : opts.snapshotJobs === true ? new SnapshotJobs({ root: ROOT, url: () => `http://127.0.0.1:${server.address().port}`, logDir: path.join(opts.learnDir, 'snapshots') })
        : opts.snapshotJobs;
  // operator-made sets (seedcanon-<manifest>.json, tools/profile-seed-make.mjs): offered first, whatever the sessions
  // report (a first launch's settings depend on the emulated machine's speed, so independent reports rarely agree);
  // read again when the file changes (written by the tool while this server runs)
  const canonCache = new Map(); // manifest -> { mtime, sets }
  const canonFor = (name, lang) => {
    if (!opts.learnDir) return null;
    const f = path.join(opts.learnDir, seedCanonFile(name));
    let mtime = 0; try { const st = fs.statSync(f); mtime = `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { /* none */ }
    let c = canonCache.get(name);
    if (!c || c.mtime !== mtime) {
      let sets = [];
      if (mtime) { try { sets = canonSets(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { /* damaged: none */ } }
      canonCache.set(name, c = { mtime, sets });
    }
    return c.sets.find((s) => s.lang === lang) ?? null;
  };
  const seedFor = (name, lang) => {
    const canon = canonFor(name, lang);
    if (canon) return { key: canon.key, files: canon.files.map(([p, d]) => ({ path: p, data: d })) };
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
  // (testing: opts.netTrace, a file — one line per compressed range answered: start s, duration s, kind, file, range, bytes sent,
  // and how the units saw it: hit / raw / miss / none, pcm1 for an audio unit)
  const netTrace = opts.netTrace ? (line) => { try { fs.appendFileSync(opts.netTrace, line + '\n'); } catch { /* no trace */ } } : null;
  const netStats = { requests: 0, raw: 0, sent: 0, encodeMs: 0, cacheHits: 0, brHits: 0, joined: 0, demand: { requests: 0, sent: 0, ms: 0 }, bg: { requests: 0, sent: 0, ms: 0, aborted: 0 } };
  /** encoded ranges kept for the next players (key: file, mtime, range, encoding), least recently used first out */
  const encodedCache = new Map(); let encodedBytes = 0;
  const ENCODED_CACHE_MAX = opts.encodedCacheBytes ?? 256 * 1024 * 1024;
  /** ranges being encoded: key -> { joined: the requests of the same range waiting for it, job: its queued job, kind } */
  const encoding = new Map();
  /**
   * The ranges encoded on the fly, at most ENCODE_JOBS at once, the game's own reads (demand) before the background
   * ones: each takes a thread of libuv's pool (4) for its read and its compression, which the other requests' file
   * reads share — under 20 players ~120 compressions waited there at once, each with its range and its encoder's
   * state (the server's resident memory 180 MB -> 1.6 GB, measured), the game's reads behind the downloads. A request
   * whose client left before its turn is not encoded (`wanted` false: `drop` instead).
   */
  // (the pool's size less two, its other requests' reads; every third job a background one when both wait: the
  // downloads that make a game's next reads local go on under a busy server)
  const ENCODE_JOBS = opts.encodeJobs ?? Math.max(2, (Number(process.env.UV_THREADPOOL_SIZE) || 4) - 2);
  const encodeQueue = { demand: [], bg: [] };
  let encodeRunning = 0, encodePicks = 0;
  const encodePump = () => {
    while (encodeRunning < ENCODE_JOBS) {
      const bgTurn = ++encodePicks % 3 === 0 && encodeQueue.bg.length > 0;
      const j = (bgTurn ? encodeQueue.bg.shift() : encodeQueue.demand.shift() ?? encodeQueue.bg.shift()); if (!j) return;
      if (!j.wanted()) { j.drop(); continue; }
      encodeRunning++;
      let once = false;
      j.run(() => { if (once) return; once = true; encodeRunning--; encodePump(); });
    }
  };
  /** a job queued in `kind`'s queue (returned: a demand request joining it may move it to the demand queue) */
  const encodeSlot = (kind, wanted, run, drop) => { const j = { wanted, run, drop }; (kind === 'bg' ? encodeQueue.bg : encodeQueue.demand).push(j); encodePump(); return j; };
  /** brotli's window for `n` bytes: the smallest that holds them (10..24 bits; the ring is 2^lgwin - 16) */
  const brWindow = (n) => { let w = 10; while (w < 24 && (1 << w) - 16 < n) w++; return w; };
  // (`light`: a light copy of `file` — resolveLightFile — its bytes instead of the file's)
  const sendRangeEncoded = (req, res, file, r, kind = 'demand', light = null) => {
    const tReq = performance.now();
    let st = light?.st; if (!st) try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
    const rm = /^(\d+)-(\d+)$/.exec(r);
    if (!rm) return send(res, 400, 'bad range');
    const start = Number(rm[1]), end = Math.min(Number(rm[2]), light ? light.copy.size : st.size);
    if (!(start < end) || end - start > 64 * 1024 * 1024) return send(res, 416, 'bad range');
    const accept = String(req.headers['accept-encoding'] ?? '');
    // (on the fly: zstd, else brotli at a quality that costs about gzip's time — Cloudflare forwards gzip and br only —,
    // else gzip)
    const br = /\bbr\b/.test(accept);
    let enc = zlib.zstdCompress && /\bzstd\b/.test(accept) ? 'zstd' : br ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
    // (&pad=1: one byte (0) before the range — a page that reads it as text, the only synchronous binary read of a
    // window, x-user-defined, drops it; without it a range starting with a byte-order mark would be decoded as UTF-8/16)
    const pad = /[?&]pad=1(&|$)/.test(req.url) ? 1 : 0;
    const reply = (body, encoding) => {
      netStats.requests++; netStats.raw += end - start; netStats.sent += body.length;
      const k = netStats[kind]; k.requests++;
      let finished = false;
      res.on('finish', () => { finished = true; k.sent += body.length; k.ms += performance.now() - tReq; netTrace?.(`${(tReq / 1000).toFixed(1)} ${((performance.now() - tReq) / 1000).toFixed(2)} ${kind === 'bg' && /[?&]a=1/.test(req.url) ? 'ahead' : kind} ${path.basename(file)} ${start}-${end} ${body.length}${unitSeen ? ' ' + unitSeen : ''}${codec ? ' ' + codec : ''}`); });
      res.on('close', () => { if (!finished && k.aborted !== undefined) k.aborted++; });
      const h = headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'X-Orthros-Raw': end - start });
      // (X-Orthros-Unit: how the precompressed units saw the request — hit, raw (kept as is), miss, or none: not a unit)
      if (unitSeen) h['X-Orthros-Unit'] = unitSeen;
      if (codec) h['X-Orthros-Codec'] = codec;
      if (encoding) h['Content-Encoding'] = encoding;
      const go = () => { if (!res.headersSent) res.writeHead(200, h); res.end(body); };
      // (simulated link: the headers after the round trip, the body once it crossed — the client's time to the first
      // byte is the round trip, as on a real connection)
      if (link) viaLink(res, body.length, go, () => { res.writeHead(200, h); res.flushHeaders(); }); else go();
    };
    // a unit made ahead (br-cache.js: a whole block or a single piece, brotli 11) when the request is one and takes br;
    // missed, it is asked for (made in the background) and this request goes the dynamic way
    const unit = brCache && br && !pad ? unitOf(start, end, light ? light.copy.size : st.size) : null;
    // (&pc=1: the page decodes the audio units — a PCM transport container, X-Orthros-Codec: pcm1, src/vfs/pcm-codec.js —;
    // one made is sent before the brotli unit, its bytes fewer)
    let codec = null, unitSeen = null;
    const pcm = unit && /[?&]pc=1(&|$)/.test(req.url) ? brCache.lookupPcm(file, st, light, unit) : null;
    if (pcm) {
      return fs.readFile(pcm.path, (err, body) => {
        if (!err && body.length === pcm.bytes) { netStats.pcmHits = (netStats.pcmHits ?? 0) + 1; codec = 'pcm1'; unitSeen = 'hit'; return reply(body, 'br'); }
        brCache.dropPcm(file, st, light, unit); brUnit();
      });
    }
    return brUnit();
    function brUnit() {
      const pre = unit && brCache.lookup(file, st, light, unit);
      unitSeen = brCache && br && !pad ? (unit ? (pre ? (pre.raw ? 'raw' : 'hit') : 'miss') : 'none') : null;
      if (unit) brCache.want(file, st, light, unit); // (made when missing — the unit, or its audio form)
      if (pre?.raw) enc = null; // (brotli saves too little there: as it is)
      else if (pre) {
        return fs.readFile(pre.path, (err, body) => {
          if (!err && body.length === pre.bytes) { netStats.brHits++; return reply(body, 'br'); }
          brCache.drop(file, st, light, unit); unitSeen = 'miss'; brCache.want(file, st, light, unit); dynamic();
        });
      }
      dynamic();
    }
    function dynamic() {
      const key = `${light ? LIGHT_DIR + '|' : ''}${file}|${st.mtimeMs}|${start}-${end}|${enc}|${pad}`;
      const hit = encodedCache.get(key);
      if (hit) { encodedCache.delete(key); encodedCache.set(key, hit); netStats.cacheHits++; return reply(hit.body, hit.encoding); }
      // (the same range being encoded for another player — a launch set's blocks, asked by every new one —: its answer)
      const waiting = encoding.get(key);
      if (waiting) {
        netStats.joined++;
        // (a game's read joining a background request still queued: the job moves to the demand queue — else the read
        // would wait behind the downloads)
        if (kind === 'demand' && waiting.kind === 'bg') {
          const i = encodeQueue.bg.indexOf(waiting.job);
          if (i >= 0) { encodeQueue.bg.splice(i, 1); encodeQueue.demand.push(waiting.job); }
          waiting.kind = 'demand';
        }
        // (its res kept: the job is still wanted while any of its clients is)
        const cb = (err, entry) => (err ? send(res, 500, String(err)) : reply(entry.body, entry.encoding)); cb.res = res;
        waiting.joined.push(cb); return;
      }
      const read = (buf, done) => (light ? readLight(file, light.copy, start, end, buf, pad, done) : fs.open(file, 'r', (err, fd) => {
        if (err) return done(err);
        fs.read(fd, buf, pad, end - start, start, (err2, n) => { fs.close(fd, () => {}); done(err2 ?? (n === end - start ? null : new Error('short read'))); });
      }));
      if (!enc) { const buf = Buffer.alloc(end - start + pad); return read(buf, (err) => (err ? send(res, 500, String(err)) : reply(buf, null))); }
      const pending = { joined: [], job: null, kind }; encoding.set(key, pending);
      const finish = (err, entry) => { encoding.delete(key); if (err) send(res, 500, String(err)); else reply(entry.body, entry.encoding); for (const f of pending.joined) f(err, entry); };
      pending.job = encodeSlot(kind, () => !res.destroyed || pending.joined.some((f) => !f.res.destroyed), (release) => {
        const buf = Buffer.alloc(end - start + pad);
        read(buf, (err) => {
          if (err) { release(); return finish(err); }
          const t0 = performance.now();
          const done = (err3, out) => {
            release();
            netStats.encodeMs += performance.now() - t0;
            // (not worth it: sent as is — the encoded form is still cached, as the raw bytes)
            const entry = !err3 && out.length < buf.length * 0.92 ? { body: out, encoding: enc } : { body: buf, encoding: null };
            encodedCache.set(key, entry); encodedBytes += entry.body.length;
            for (const [k, v] of encodedCache) { if (encodedBytes <= ENCODED_CACHE_MAX) break; encodedCache.delete(k); encodedBytes -= v.body.length; }
            finish(null, entry);
          };
          if (enc === 'zstd') zlib.zstdCompress(buf, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }, done);
          // (a window no larger than the range: brotli's encoder state is sized by it — 4 MiB rings for 64 KiB pieces)
          else if (enc === 'br') zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length, [zlib.constants.BROTLI_PARAM_LGWIN]: brWindow(buf.length) } }, done);
          else zlib.gzip(buf, { level: 4 }, done);
        });
      }, () => finish(new Error('gone')));
    }
  };

  const accountApi = opts.accountsDir ? createAccountApi(opts.accountsDir, { publicOrigin: opts.accountOrigin, allowedGame: (game) => !!getManifest(game), ...(opts.accountMaxUserBytes ? { maxUserBytes: opts.accountMaxUserBytes } : {}), ...(opts.accountGoogle ? { google: opts.accountGoogle } : {}) }) : null;
  // (the Orthros account is a player's only identity: undefined on a server without accounts, null when nobody is signed in)
  const identify = (req) => (accountApi ? accountApi.session(req) ?? null : undefined);
  // the shared worlds of the versions whose manifest has an `mmo` entry (src/host/mmo.js): none without accounts
  const mmoDir = accountApi ? path.resolve(opts.mmoDir ?? path.join(opts.accountsDir, 'mmo')) : null;
  const mmo = mmoApi({ getManifest, identify, dir: mmoDir, log: opts.mmoLog ?? ((m) => console.log(m)), ...(opts.mmoNow ? { now: opts.mmoNow } : {}) });
  // Localized OpenMW masters need separate simulations, caches and save histories.
  // (`ok`: openmwInstalled's answers by version, kept for one answer — /api/manifests asks it of each version for each
  // of its languages)
  const openmwOk = (target, man, memo, ok) => {
    if (!ok) return openmwInstalled(man, enginesDir, memo);
    if (!ok.has(target)) ok.set(target, openmwInstalled(man, enginesDir, memo));
    return ok.get(target);
  };
  function portLanguages(man, id, memo = null, ok = null) {
    if (man.runtime !== 'openmw' || !man.openmw.languageVersions) return {};
    const languageLaunchUrls = {}, languageVersions = {};
    for (const [code, target] of Object.entries(man.openmw.languageVersions)) {
      const other = getManifest(target);
      if (other?.runtime === 'openmw' && other.gameId === man.gameId && other.languages?.includes(code) && openmwOk(target, other, memo, ok)) {
        languageLaunchUrls[code] = portLaunchUrl(target, other);
        if (target !== id) languageVersions[code] = target; // (the version a language runs: the home's card prepares and downloads it)
      }
    }
    // Keep the current language visible even while another localization is incomplete.
    for (const code of man.languages ?? []) languageLaunchUrls[code] ??= portLaunchUrl(id, man);
    return { languages: Object.keys(languageLaunchUrls), contentLanguages: man.languages ?? [], languageLaunchUrls, languageVersions };
  }
  const mapImages = new Map(); // (the lobby's map pictures, compressed: file|mtime -> { raw, gzip, zstd })
  const rooms = roomsApi({ getManifest, identify, ...(opts.roomsRequest ? { request: opts.roomsRequest } : {}) });
  const openmw = openmwProxy({ getManifest, session: accountApi?.session, ownsToken: accountApi?.ownsPortToken });
  const openmwAccounts = accountBridge({ accountsDir: opts.accountsDir, accountApi, getManifest });
  const server = http.createServer((req, res) => {
    let url; try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad path'); }
    const p = requestPath(url.pathname);
    if (p === null) return send(res, 400, 'bad path');
    try {
      if (openmwAccounts.handle(req, res, url) || openmw.handle(req, res, url) || mmo.handle(req, res, url)) return;
      // (the multiplayer rooms of a browser port, from its server manager)
      if (p.startsWith('/api/rooms/') && rooms.handle(req, res, url)) return;
      // (a map's picture for the lobby: the game's own overview, multiplayer.mapImage)
      { const m = /^\/api\/map-image\/([^/]+)\/([^/]+)$/.exec(p);
        if (m) {
          const file = mapImageFile(getManifest(m[1]), m[2]); if (!file) return send(res, 404, 'no picture');
          // (compressed once, kept: an 8-bit bitmap of the game shrinks several times; the browser draws it)
          let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'no picture'); }
          const key = `${file}|${st.mtimeMs}`; let packed = mapImages.get(key);
          if (!packed) { const raw = fs.readFileSync(file); packed = { raw, gzip: zlib.gzipSync(raw, { level: 9 }), zstd: zlib.zstdCompressSync?.(raw) ?? null }; mapImages.set(key, packed); if (mapImages.size > 200) mapImages.delete(mapImages.keys().next().value); }
          const accept = String(req.headers['accept-encoding'] ?? ''), enc = packed.zstd && /\bzstd\b/.test(accept) ? 'zstd' : /\bgzip\b/.test(accept) ? 'gzip' : null;
          const body = enc ? packed[enc] : packed.raw;
          res.writeHead(200, headers({ 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=86400', 'Vary': 'Accept-Encoding', 'Content-Length': body.length, ...(enc ? { 'Content-Encoding': enc } : {}) }));
          return res.end(req.method === 'HEAD' ? undefined : body);
        } }
      if (p === '/api/account' || p.startsWith('/api/account/') || p === '/api/cloud' || p.startsWith('/api/cloud/')) {
        if (!accountApi) return send(res, 503, 'accounts unavailable');
        accountApi(req, res).catch((e) => { console.error('account API:', e); if (!res.headersSent) send(res, e.status ?? 500, 'account API error'); else res.destroy(); });
        return;
      }
      if (p === '/api/config') return send(res, 200, JSON.stringify({ version: buildVersion(), defaultManifest: opts.defaultManifest ?? null, telemetry: !!opts.telemetryDir, accounts: !!accountApi, google: !!accountApi?.googleEnabled(), mmo: !!mmoDir, encodedRanges: true, prefetch: true, programCache: true, regionCache: true, profileSeed: true }), { 'Content-Type': 'application/json' });
      // (the sources snapshots depend on, docs/snapshot.md: a page keeps its snapshot of a game only while they are the same)
      if (p === '/api/snapshot-sources') return send(res, 200, JSON.stringify(snapshotSourcesHash(ROOT)), { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
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
      if (p === '/' || p === '/index.html') return sendSource(req, res, path.join(ROOT, 'src/host/web/index.html'), MIME['.html']);
      // (the privacy policy and the terms of use, at public addresses: the home screen, the account window and Google's sign-in link to them)
      if (p === '/privacy' || p === '/terms') return sendFile(req, res, path.join(ROOT, `src/host/web/${p.slice(1)}.html`), MIME['.html']);
      if (p === '/api/manifests') {
        refreshCatalog();
        const memo = listings, ok = new Map(); // (the folders' listings, the OpenMW versions' checks: shared by the versions)
        const out = [...manifests].map(([name, m]) => {
          let bytes = null;
          try { if (fs.existsSync(m.folder) && (!m.baseFolder || fs.existsSync(m.baseFolder))) bytes = treeBytes(gameTree(name, m)); } catch { /* folder missing */ }
          const runtime = runtimeOf(m), port = runtime !== 'win32';
          return { name, title: m.name ?? name, gameId: m.gameId ?? name, version: m.version ?? null,
            versionOrder: m.versionOrder ?? 0, languages: m.languages ?? [], ...portLanguages(m, name, memo, ok), runtime, exe: port ? null : m.exe,
            modes: runtime === 'goldsrc' ? goldsrcModes(m.goldsrc) : runtime === 'openmw' ? openmwModes(m.openmw) : runtime === 're3' ? re3Modes(m.re3) : null, launchUrl: port ? portLaunchUrl(name, m) : null,
            description: m.description ?? null, descriptionFr: m.descriptionFr ?? null,
            hidden: !!m.hidden, modified: !!m.modified, cover: !!coverFile(m), bytes, launch: bytes === null ? null : launchOf(name, m), saveKey: port ? m.saveKey ?? null : null, mmo: !!m.mmo,
            available: bytes !== null && (runtime !== 'goldsrc' || goldsrcInstalled(m, enginesDir)) && (runtime !== 'openmw' || openmwOk(name, m, memo, ok)) && (runtime !== 're3' || re3Installed(m, enginesDir)) };
        });
        return send(res, 200, JSON.stringify(out), { 'Content-Type': 'application/json' });
      }
      let m = /^\/api\/manifest\/([^/]+)$/.exec(p);
      if (m) {
        const man = getManifest(m[1]); if (!man) return send(res, 404, 'no such manifest');
        const launchUrl = runtimeOf(man) !== 'win32' ? portLaunchUrl(m[1], man) : undefined;
        // (an re3 port: the engine module its page imports, a path of its release — the manifest's, else the release's own)
        const re3 = runtimeOf(man) === 're3' ? { re3: { ...man.re3, module: re3Module(man, enginesDir) } } : {};
        return send(res, 200, JSON.stringify({ ...man, folder: undefined, baseFolder: undefined, underlays: undefined, overlays: undefined, dataMounts: undefined, saveDir: undefined, coverPath: undefined, launchUrl, ...re3, ...portLanguages(man, m[1]) }), { 'Content-Type': 'application/json' });
      }
      m = /^\/api\/cover\/([^/]+)$/.exec(p);
      if (m) { // the game's own image named by its manifest (a splash screen), found whatever the case of its path
        const man = getManifest(m[1]), f = man && coverFile(man);
        if (!f) return send(res, 404, 'no cover');
        // (the home's: a light copy once made, light-covers.js — ?full: the image itself)
        const light = covers && !url.searchParams.has('full') ? covers.file(f) : null;
        if (light) return sendFile(req, res, light, 'image/webp', { 'Cache-Control': 'public, max-age=86400' });
        const ext = path.extname(f).toLowerCase();
        // (the light copy still being made: the full image under the same address, not kept for a day by the browser or a proxy)
        const pending = !!covers && !url.searchParams.has('full') && covers.pending(f);
        res.writeHead(200, { 'Content-Type': MIME[ext]?.startsWith('image/') ? MIME[ext] : 'image/jpeg', 'Cache-Control': pending ? 'no-cache' : 'public, max-age=86400', 'Cross-Origin-Resource-Policy': 'same-origin',
          ...(ext === '.svg' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}) }); // (an SVG opened by itself runs nothing)
        fs.createReadStream(f).pipe(res);
        return;
      }
      m = /^\/api\/tree\/([^/]+)$/.exec(p);
      if (m) { const man = getManifest(m[1]); if (!man) return send(res, 404, 'no such manifest'); return sendTree(req, res, m[1], man); }
      // compressed ranges: /gamez/<manifest>/<path>?r=<start>-<end> (end exclusive), the bytes encoded with zstd, brotli
      // or gzip when that saves enough (a unit made ahead at brotli 11 when there is one: br-cache.js) (Content-Encoding: the browser decodes before the page sees them), else sent as they are;
      // /gamez/<manifest>/.light/<path>: the file's light copy (light-copies.js), when the version has them
      m = /^\/gamez\/([^/]+)\/(.*)$/.exec(p);
      if (m) {
        const man = getManifest(m[1]); if (!man) return send(res, 404, 'no such manifest');
        const light = m[2].startsWith(LIGHT_DIR + '/') ? resolveLightFile(man, m[2], listings) : null;
        const file = light ? light.file : resolveGameFile(man, m[2], listings); if (!file) return send(res, 404, 'not found');
        const r = url.searchParams.get('r') ?? '', rm = /^(\d+)-(\d+)$/.exec(r);
        if (rm && !url.searchParams.get('p')) learnRead(m[1], m[2], Number(rm[1]), Number(rm[2]), url.searchParams.get('s'));
        return sendRangeEncoded(req, res, file, r, url.searchParams.get('p') || url.searchParams.get('a') ? 'bg' : 'demand', light);
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
            learnPrograms(m[1], rec?.programs, rec?.used, rec?.v);
            send(res, 204, '');
          });
          return;
        }
        return send(res, 200, JSON.stringify(programsList(m[1], url.searchParams.has('v') ? Number(url.searchParams.get('v')) : null)), { 'Content-Type': 'application/json' });
      }
      // a new player's starting point (snapshot-store.js): the shared snapshot of this key, language and first-launch
      // profile; none yet: a publishing session queued. Published by that session only (its token).
      m = /^\/api\/snapshot\/([^/]+)$/.exec(p);
      if (m) {
        const man = getManifest(m[1]); if (!man) return send(res, 404, 'no such manifest');
        const key = url.searchParams.get('key') ?? '', lang = seedLang(url.searchParams.get('lang') ?? '');
        if (!snapshots || !SNAPSHOT_KEY.test(key) || lang === null || runtimeOf(man) !== 'win32') return send(res, 404, 'none');
        const seed = man.profileSeed === false ? null : (seedFor(m[1], lang).key ?? null);
        if (req.method === 'POST') {
          if (!snapshotJobs?.job(url.searchParams.get('token') ?? '', m[1], lang, key)) return send(res, 403, 'not a publishing session of this server');
          fs.mkdirSync(snapshots.dir, { recursive: true });
          const tmp = path.join(snapshots.dir, `upload-${process.pid}-${Date.now()}.tmp`);
          let size = 0;
          req.on('data', (d) => { size += d.length; if (size > 1 << 30) req.destroy(new Error('too large')); });
          pipeline(req, fs.createWriteStream(tmp)).then(async () => {
            const fd = fs.openSync(tmp, 'r'), head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
            if (head.readUInt32BE(0) !== 0x4f534e50) { fs.rmSync(tmp, { force: true }); return send(res, 400, 'not a snapshot'); }
            await snapshots.put(m[1], lang, key, tmp, { seed });
            send(res, 204, '');
          }).catch(() => { fs.rmSync(tmp, { force: true }); if (!res.headersSent) send(res, 500, 'not kept'); });
          return;
        }
        const f = snapshots.open(m[1], lang, key, String(req.headers['accept-encoding'] ?? ''));
        if (!f || (f.meta.seed ?? null) !== seed) { snapshotJobs?.want(m[1], lang, key); return send(res, 404, 'none yet'); }
        res.writeHead(200, headers({ 'Content-Type': 'application/octet-stream', 'Content-Encoding': f.encoding, 'Content-Length': String(f.size), 'X-Snapshot-Bytes': String(f.meta.bytes), 'Cache-Control': 'no-cache' }));
        fs.createReadStream(f.file).pipe(res);
        return;
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
      if (m) {
        const man = getManifest(m[1]); if (!man) return send(res, 404, 'no such manifest');
        // a page that serves the game's reads itself (a browser port) reports them: { session, reads: [[path, start,
        // end, t (ms since the game started)]] }, learned as the demand reads of the Windows games are
        if (req.method === 'POST') {
          let body = '', size = 0;
          req.on('data', (d) => { size += d.length; if (size <= 2 * 1024 * 1024) body += d; });
          req.on('end', () => {
            if (size > 2 * 1024 * 1024) return send(res, 413, 'too large');
            let rec; try { rec = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
            if (typeof rec?.session !== 'string' || !rec.session || rec.session.length > 40 || !Array.isArray(rec.reads)) return send(res, 400, 'bad report');
            const tree = gameTree(m[1], man);
            if (rec.phases !== undefined) learnPhases(m[1], 'r:' + rec.session, rec.phases);
            for (const r of rec.reads.slice(0, 50000)) {
              if (!Array.isArray(r) || typeof r[0] !== 'string' || r[0].length > 512) continue;
              const [rel, start, end, t] = r, size2 = treeFileSize(tree, rel);
              if (size2 === null || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > size2 || !Number.isFinite(t) || t < 0 || t > 6 * 3600e3) continue;
              learnRead(m[1], rel, start, end, 'r:' + rec.session, Math.round(t));
            }
            if (rec.mark && typeof rec.mark === 'object') learnMark(m[1], 'r:' + rec.session, rec.mark.kind, markLang(man, rec.mark.lang));
            send(res, 204, '');
          });
          return;
        }
        return send(res, 200, JSON.stringify(prefetchList(m[1], markLang(man, url.searchParams.get('lang')))), { 'Content-Type': 'application/json' });
      }
      if (p === '/api/netstats') {
        // (the server's own state too: its memory and what its caches hold — a long-running server's growth seen)
        const mem = process.memoryUsage();
        const state = { rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external, arrayBuffers: mem.arrayBuffers,
          encodedCache: { entries: encodedCache.size, bytes: encodedBytes }, encodeQueue: { running: encodeRunning, demand: encodeQueue.demand.length, bg: encodeQueue.bg.length },
          srcBr: { entries: srcBr.size, bytes: srcBrBytes }, sessions: sessions.size, listings: listings.size };
        return send(res, 200, JSON.stringify({ ...netStats, server: state, ...(brCache ? { brCache: brCache.stats() } : {}), ...(url.searchParams.has('launch') ? { launch: launchCoverage() } : {}) }), { 'Content-Type': 'application/json' });
      }
      m = /^\/game\/([^/]+)\/(.*)$/.exec(p);
      if (m) { const man = getManifest(m[1]); if (!man) return send(res, 404, 'no such manifest'); const file = resolveGameFile(man, m[2], listings); if (!file) return send(res, 404, 'not found'); return sendFile(req, res, file, 'application/octet-stream'); }
      // browser ports: the version's page (its runtime's own, src/ports/<runtime>/), and the engine releases they name,
      // immutable under their release id
      m = /^\/ports\/openmw\/([^/]+)\/app\/(.*)$/.exec(p);
      if (m) {
        const man = getManifest(m[1]); if (man?.runtime !== 'openmw') return send(res, 404, 'no such port');
        const rel = m[2] || (man.openmw.multiplayer ? 'play' : 'launcher.html'), base = `/ports/openmw/${encodeURIComponent(m[1])}/app`;
        if (rel === 'clientlog' && req.method === 'POST' && !man.openmw.multiplayer) { req.resume(); return send(res, 204, ''); }
        // The upstream operator dashboard is local only. No arbitrary files from a server installation.
        if (!/^(index\.html|launcher\.html|join|play|admin\/static\/(play\.js|providers\.js)|e\/[a-f0-9]+\/(openmw\.(js|wasm|data)(\.br)?|streamfs\.js)|moddata\/openmw-web-assets\.bsa|LICENSE|NOTICE|AUTHORS\.md|THIRD-PARTY-LICENSES\.md|CREDITS-DEMO-DATA\.txt)$/.test(rel)) return send(res, 404, 'not found');
        if (accountApi && (rel === 'play' || rel === 'join' && !accountApi.session(req))) { res.writeHead(302, headers({ Location: `/ports/openmw/${encodeURIComponent(m[1])}/`, 'Cache-Control': 'no-store' })); return res.end(); }
        const asset = rel === 'join' ? 'launcher.html' : rel === 'play' ? 'portal/play.html' : rel.startsWith('admin/static/') ? 'portal/' + rel.split('/').at(-1) : rel;
        const f = engineFile(enginesDir, man.openmw.engine, asset);
        if (!f) return send(res, 404, 'engine not installed');
        if (asset.endsWith('.html') || asset.startsWith('portal/')) {
          const user = accountApi?.session(req), scope = user ? playerScope(user) : null;
          const saveKey = scope ? `${man.saveKey}:user:${scope}` : man.saveKey;
          let page = openmwWebText(fs.readFileSync(f, 'utf8'), base, saveKey);
          if (asset.endsWith('.html')) page = withFrameMeter(page);
          if (asset === 'index.html') page = withQualityTier(withProgressiveView(withStreaming(withLeanPackage(withSharedEngine(page, man.openmw.engine), man.openmw.example ? null : lean?.url(man.openmw.engine)), url.searchParams.get('sfs') === 'upstream')));
          if (asset === 'index.html' && scope) {
            page = page.replace('<head>', '<head><script src="/src/ports/openmw/cloud.js"></script>');
            page = page.replace("FS.mount(IDBFS, {}, '/userdata');", `FS.mount(IDBFS, {}, '/userdata');window.orthrosCloudInstall(FS, ${JSON.stringify(m[1])}, ${JSON.stringify(scope)});`);
          }
          return send(res, 200, page, { 'Content-Type': MIME[path.extname(asset)], 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' });
        }
        // (e/<hash>/: the engine build's own content-versioned directory)
        const cache = rel.startsWith('e/') ? 'public, max-age=31536000, immutable' : 'public, max-age=86400';
        if (f.endsWith('.br')) {
          const mime = MIME[path.extname(f.slice(0, -3))] ?? 'application/octet-stream';
          if (req.headers.range) return sendFile(req, res, f, mime, { 'Content-Encoding': 'br', 'Cache-Control': cache });
          let decoded = null; try { decoded = fs.statSync(f.slice(0, -3)).size; } catch { /* the release ships the brotli only */ }
          return sendBrotli(req, res, f, mime, { 'Cache-Control': cache }, decoded);
        }
        return sendEngineFile(req, res, f, cache);
      }
      m = /^\/ports\/([a-z0-9]+)\/([^/]+)\/$/.exec(p);
      if (m) { const man = getManifest(m[2]); if (!man || runtimeOf(man) !== m[1] || m[1] === 'win32') return send(res, 404, 'no such port'); return sendSource(req, res, path.join(ROOT, 'src/ports', m[1], 'play.html'), MIME['.html']); }
      m = /^\/engines\/([^/]+)\/(.+)$/.exec(p);
      if (m) {
        if (![...manifests.values()].some((man) => man.goldsrc?.engine === m[1] || man.openmw?.engine === m[1] || (man.runtime === 're3' && man.re3?.engine === m[1]))) return send(res, 404, 'no such engine');
        // (an OpenMW release's lean package, made by this server: brotli only — a browser that takes none decodes nothing)
        const leanFile = lean?.file(m[1], m[2]);
        if (leanFile) {
          const cache = 'public, max-age=31536000, immutable';
          if (/\bbr\b/.test(String(req.headers['accept-encoding'] ?? '')) && !req.headers.range) return sendBrotli(req, res, leanFile, 'application/octet-stream', { 'Cache-Control': cache, 'Vary': 'Accept-Encoding' }, lean.decoded(m[1]));
          res.writeHead(200, headers({ 'Content-Type': 'application/octet-stream', 'Cache-Control': cache, 'Vary': 'Accept-Encoding' }));
          if (req.method === 'HEAD') return res.end();
          return void pipeline(fs.createReadStream(leanFile), zlib.createBrotliDecompress(), res).catch(() => res.destroy());
        }
        const file = engineFile(enginesDir, m[1], m[2]); if (!file) return send(res, 404, 'not found');
        return sendEngineFile(req, res, file, 'public, max-age=31536000, immutable');
      }
      if (p.startsWith('/src/') || p.startsWith('/tools/') || p.startsWith('/tests/')) {
        // (under the tree's own top directory, its real path too: no symlink out of it)
        const top = path.join(ROOT, p.split('/')[1]), file = path.join(ROOT, p);
        let real = null; try { real = fs.realpathSync(file); } catch { /* none: 404 below */ }
        if (!isUnder(top, file) || real && !isUnder(fs.realpathSync(top), real)) return send(res, 403, 'forbidden');
        return sendSource(req, res, file, MIME[path.extname(file)] ?? 'application/octet-stream');
      }
      return send(res, 404, 'not found');
    } catch (e) {
      return send(res, 500, String(e.stack || e));
    }
  });
  // WebSockets: the virtual LAN of the Win32 games (/api/lan), the multiplayer relay of the ports (/api/udp/<manifest>)
  // and the shared worlds (/api/mmo/<version>/ws) (on a server with accounts, multiplayer is for signed-in players)
  const upgrades = [lanUpgrades(opts.lanLog ?? ((m) => console.log(m)), { identify }), udpRelay({ getManifest, accept: acceptWebSocket, identify, log: (m) => console.log(m) }),
    { handle: (req, socket, url) => mmo.upgrade(req, socket, url) }];
  server.on('upgrade', (req, socket, head) => {
    let url; try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
    if (openmw.upgrade(req, socket, url, head)) return;
    if (!upgrades.some((u) => u.handle(req, socket, url))) socket.destroy();
  });
  server.snapshotJobs = snapshotJobs; // (tools/snapshot-shared-check.mjs: waits for the publishing sessions)
  // (the shared worlds saved and their connections closed when the server closes — first: close() waits for the upgraded
  // sockets, which closeAllConnections() leaves open)
  server.mmo = mmo;
  const closeServer = server.close.bind(server);
  server.close = (cb) => { mmo.close(); brCache?.close(); return closeServer(cb); };
  server.on('close', () => { mmo.close(); brCache?.close(); });
  server.brCache = brCache; // (tests: its state, drain)
  server.srcBrJobs = () => ({ running: srcBrRunning, queued: srcBrJobs.length, peak: srcBrPeak }); // (tests: the src brotli queue)
  return server;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // (libuv's pool, 4 threads by default, does every file read and on-the-fly compression of the game data: 8, set
  // before its first use, unless the environment says otherwise)
  process.env.UV_THREADPOOL_SIZE ??= '8';
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1] || 8080) || 8080;
  const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const telemetryDir = arg('--telemetry'), learnDir = arg('--learn'), accountsDir = arg('--accounts'), mmoDir = arg('--mmo');
  for (const d of [telemetryDir, learnDir, accountsDir, mmoDir]) if (d) fs.mkdirSync(d, { recursive: true });
  // (--br-cache <dir>: the precompressed units, default <learn>/../brcache — off without --learn, or with `off`;
  // --br-cache-bytes: their budget — unset, 1.5 GiB grown to hold the launch sets, br-cache.js fitBudget)
  const brArg = arg('--br-cache'), brCacheDir = brArg === 'off' ? null : brArg ?? (learnDir ? path.join(learnDir, '..', 'brcache') : null);
  const brBytesArg = arg('--br-cache-bytes'), brCacheBytes = brBytesArg === undefined ? undefined : Number(brBytesArg);
  if (brBytesArg !== undefined && !(Number.isFinite(brCacheBytes) && brCacheBytes > 0)) { console.error(`--br-cache-bytes ${brBytesArg}: expected a positive number of bytes`); process.exit(2); }
  // (--covers <dir>: the home's light covers, default <learn>/../covers — off without --learn, or with `off`)
  const coverArg = arg('--covers'), coverDir = coverArg === 'off' ? null : coverArg ?? (learnDir ? path.join(learnDir, '..', 'covers') : null);
  // (--br-cache-frozen: the units served as they are, none made — a measurement's copy of another server's)
  const brCacheOptions = args.includes('--br-cache-frozen') ? { generate: false } : undefined;
  const server = createServer({ prewarmSrc: true, coverDir, brCacheDir, brCacheBytes, brCacheOptions, manifests: arg('--manifests'), gamesDir: arg('--games-dir'), enginesDir: arg('--engines-dir'), defaultManifest: arg('--default'), telemetryDir, learnDir, accountsDir, mmoDir, profileSeedQuorum: arg('--profile-seed-quorum') ? Number(arg('--profile-seed-quorum')) : undefined, snapshotJobs: args.includes('--snapshot-jobs') || (args.includes('--snapshot-queue') && 'queue') });
  server.listen(port, '127.0.0.1', () => console.log(`orthros: http://127.0.0.1:${port}/`));
  // (a restart — every deployment — saves the shared worlds' last changes first: they are written a few seconds after)
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { server.mmo.flush(); } catch (e) { console.error('mmo flush:', e); } finally { process.exit(0); } });
}
