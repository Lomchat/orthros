// The game data of the engines that run in the page (GoldSrc, re3, OpenMW, the next ones — CLAUDE.md
// "Standardization"): the Windows games' reader (game-data.js: HttpBackend over the server's compressed ranges, the
// browser's OPFS copy, the order earlier sessions read the game in, the whole download) in a worker of its own. The
// page asks it for bytes through data-client.js: a read the engine waits for synchronously is answered on shared
// memory (ctrl[0] the request answered, ctrl[1] the bytes delivered or -1), one it can wait for (JSPI) by message. A
// request the page may give up on (`late`: data-client.js fetchSpin — an engine that suspends after a few ms) is answered
// on shared memory only while ctrl[16] still names it (claimed first: -gen), else by message, as an asynchronous read.
// Counters shared with the page's indicator: ctrl[2] bytes received (decoded), ctrl[3] this worker's heartbeat,
// ctrl[4] / ctrl[5] KB of the current step here / in all (the learned order: HttpBackend.stepEstimate), ctrl[6] the
// page's reads waiting for the network that the engine waits for — a synchronous read, or an asynchronous one the page
// says holds the engine (`held`: data-client.js holdCheck; not one the engine asked ahead and went on past, nor one
// fetched in the background). The link, for the page: ctrl[7] 1 when it is fast (the files themselves read,
// not their light copies), ctrl[8] its measured rate (KB/s, 0 until measured), ctrl[9] 1 when it is thin (measured
// below THIN_BPS, net-link.js), ctrl[15] its wire bytes per file byte (NetLink.ratio, thousandths: the compressed
// ranges — GameData.bigBatch weighs a load's files on the wire). The page's quiet (GameData.quiet: a page that loads more of its game when nothing waits):
// ctrl[10] 1 when the learned order's loading has nothing left for the game's current step (or does not run), ctrl[11]
// the time since a read last waited for the network (ms, 0 while one waits).
// Announced reads (GameData.want: the ranges the engine says it reads next, fetched in parallel — HttpBackend.wantList):
// ctrl[12] the last batch settled with every one of the page's current wait window before it (the batches from the
// window's first, `from`: each entry here, or failed — GameData.wantWait spins on it), ctrl[13] the announced entries not settled yet, ctrl[14] those that failed (since the start).
// A page's mark (GameData.mark('playable'): its game first draws in play) goes to the server with the reads before it:
// the launch set later sessions wait for and the home announces (launch-set.js).
// Light copies (src/server/light-copies.js): on a link that is not fast, the page reads a texture's light copy unless the
// file itself is here (told: { real: [keys] }); the learned order brings the light copies; the files whose light copy
// the engine read come last, in the background (HttpBackend.upgrade).
// The page knows the files by the version it opened (its parts' names); a file that version takes from one it requires
// is read, kept and learned-ahead through that version's part (game-data.js partOf, learnedOrders): its store, its URLs.
// The Windows games' emulator (src/web/worker.js, through data-link.js) has the same worker: `w32` below — its reads
// answered from shared memory (shared-blocks.js), their misses here.
import { openVersion, openStore, openLegacyStore, learnedOrders, partOf, PartsBackend, UnderStore } from './game-data.js';
import { MemBlockStore } from './opfs-store.js';
import { SharedBlocks, fileKeys } from './shared-blocks.js';
import { BLOCK, CHUNK } from './http-backend.js';
import { LIGHT_DIR, isLightContent, treeFiles } from './game-tree.js';
import { flagged, launchFirst, launchSet, lightLaunch, setBytes, WIRE_RATIO } from './launch-set.js';
import { ReadReports } from './playable-watch.js';

/** The reads the engine used, sent to the server's learned order every so often. */
const REPORT_MS = 15000;
/** The most reads a report that carries a mark sends (the server takes 50000). */
const MARK_READS = 40000;
/** How often the way to playable (launchWatch) is told to the page while the game is not there. */
const LAUNCH_TELL_MS = 2000;
/** How often the learned order's progress (ahead, launch) is told to the page while the engine boots (prefetchNow). */
const BOOT_TELL_MS = 5000;
/**
 * prefetchNow loads the learned order before the engine's first read only on a store holding less than this share of
 * the launch set's bytes: a cold one (a new device, a store cleared, a version updated — its files' mtimes changed). A
 * returning store rarely holds all of it (the server's majority set holds other sessions' first places, it learns between
 * visits, a light copy or the file by the link's speed) and waits for the first read, as before.
 */
const LAUNCH_COLD = 0.5;
/** After this long without a read waiting, the next wait is a new step for the indicator. */
const STEP_PAUSE_MS = 3000;

/** The worker's state (one version per worker). */
// snapshot: host side — the data worker of an engine running in the page, not a machine's state
let W = null, postMessage = null;

/**
 * The worker's message handler, its answers through `post` (the worker's postMessage; a test's function). In a worker,
 * started below.
 */
export function createDataWorker(post) {
  postMessage = post;
  W = {
    ctrl: null, data: null, version: null, parts: new Map(), handles: new Map(), ready: null, timers: [],
    session: '', lang: null, t0: null, reads: [], seen: new Map(), waiting: 0, lastWait: -1e9, step: null, waits: new Set(), held: new Map(),
    prefetchAt: 'none', prefetching: false, runs: null, stop: false, whole: null, learned: null, boot: false, readSeen: false,
    wants: new Map(), wantFrom: 1, wantMax: 0, wantLeft: 0, wantFailed: 0, wantLabel: null,
    legacy: new Map(), adopters: new Map(), sources: new Map(), light: new Map(), marks: new Set(), reports: new ReadReports(), phases: [],
    reloads: false,
  };
  return (m) => {
    if (m.w32) { W.ready = w32Init(m.w32).catch((err) => { postMessage({ failed: String(err?.message ?? err) }); throw err; }); return; }
    if (m.init) {
      // (alive from now on — the page's waits watch it — though the version takes a moment to open: the rest waits for it)
      W.ctrl = new Int32Array(m.init.ctrl); Atomics.add(W.ctrl, 3, 1); W.timers.push(setInterval(() => Atomics.add(W.ctrl, 3, 1), 100));
      W.ready = init(m.init).catch((err) => { postMessage({ failed: String(err?.message ?? err) }); throw err; });
      return;
    }
    W.ready.then(() => dispatch(m), () => { if (typeof m.gen === 'number') settleSync(m, null, 'the game data did not open'); });
  };
}
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  const handle = createDataWorker((m, transfer) => self.postMessage(m, transfer));
  self.onmessage = (e) => handle(e.data);
}

function dispatch(m) {
  if (W.w32 && w32Dispatch(m)) return;
  if (m.used) used(m.used);
  if (m.source) { W.sources.set(m.source.id, { ...m.source }); return; }
  if (m.legacy) { for (const r of m.legacy) W.legacy.set(r.name + '\n' + r.path.toLowerCase(), r); return; }
  if (m.setSource) { const src = W.sources.get(m.setSource.id); if (src) src.url = m.setSource.url; return; }
  if (m.held) { hold(m.held); return; }
  if (typeof m.gen === 'number') { answerSync(m); return; }
  if (m.read) { answerAsync(m.read); return; }
  // ('startup': the startup set before the engine, then the whole learned order once it runs — as 'start')
  if (m.start) { W.t0 = performance.now(); if (W.prefetchAt === 'start' || W.prefetchAt === 'startup') prefetchAll(); return; }
  if (m.startup) { startup(); return; }
  if (m.prefetch) { prefetchNow(); return; }
  if (m.mark) { mark(m.mark); return; }
  if (m.phase) { phase(m.phase); return; }
  if (m.reloads !== undefined) { W.reloads = !!m.reloads; return; }
  if (m.want) { want(m.want); return; }
  if (m.wantPlace) { wantPlace(m.wantPlace); return; }
  if (m.wantWhole) { route(m.wantWhole.name, m.wantWhole.path)?.files.wantWhole(m.wantWhole.path); return; }
  if (m.light) { upgrade(m.light.name, m.light.path, !!m.light.soon); return; }
  if ('whole' in m) { m.whole ? wholeDownload() : (W.whole && (W.whole.stop = true)); return; }
  if (m.migrate) { migrate(m.migrate); return; }
  if (m.close) { W.stop = true; report(true); for (const t of W.timers) clearInterval(t); for (const p of W.parts.values()) try { p.files?.stopFill?.(); p.store?.close(); } catch { /* closed */ } }
}

/**
 * { name, session, lang, bw, ctrl, data, prefetch: 'startup' | 'start' | 'first-read' | 'none', tree, manifest (the page's,
 * when it holds them), orderAtOpen, memBytes, cacheBlocks }: the
 * version and the ones it requires opened (lang: the game's language — its sessions' own launch set, launch-set.js) (their stores: OPFS, else in memory — another tab holds them, or no OPFS; the files of a version another owns: in
 * that one's store over this one's — game-data.js UnderStore: what this one kept of them before read there —, in this
 * one's when another tab's game holds the owner's).
 */
async function init(o) {
  W.data = new Uint8Array(o.data); W.session = o.session ?? ''; W.lang = typeof o.lang === 'string' && o.lang ? o.lang : null; W.prefetchAt = o.prefetch ?? 'none'; W.reloads = !!o.reloads;
  const kept = {};
  // (legacy: the stores of the game's other versions that kept its shared base's files before — ownerLegacy —, closed
  // with the shared part's store)
  W.version = await openVersion(o.name, { bw: o.bw, tree: o.tree, manifest: o.manifest, cacheBlocks: o.cacheBlocks, kept: (n) => kept[n], legacy: openLegacyStore, store: async (n) => {
    const s = await openStore(n); kept[n] = !!s;
    return s ?? new MemBlockStore(o.memBytes ?? 512 << 20);
  } });
  for (const p of W.version.parts) W.parts.set(p.name, p);
  // (a measuring harness's trace — the page's GameData.trace —: the readers' requests ahead of the game's reads, posted
  // in batches with their time since the epoch)
  if (o.trace) {
    const q = [];
    W.trace = (e) => { if (q.length < 5000) q.push({ t: performance.timeOrigin + performance.now(), ...e }); };
    for (const p of W.version.parts) p.files.traceAhead = W.trace;
    W.timers.push(setInterval(() => { if (q.length) postMessage({ trace: q.splice(0) }); }, 200));
  }
  // (the learned order's list asked now, its bytes not: here before the startup set or the engine's first read asks)
  if (o.orderAtOpen) order();
  W.timers.push(setInterval(monitor, 100), setInterval(report, REPORT_MS), setInterval(lightWatch, 1000));
  // (the files that have a light copy: those here whole the page reads themselves; the others watched — lightWatch —,
  // each by the name the page knows it under, through the part that reads it)
  const real = [];
  for (const p of W.version.parts) if (!p.shared) for (const f of treeFiles(p.tree)) {
    if (!f.light) continue;
    const r = route(p.name, f.path), k = lightKey(p.name, f.path);
    if (r.files.isWhole(f.path)) real.push(k); else W.light.set(k, { part: r, path: f.path, told: false });
  }
  // (the trees of the versions the page opened: a shared part's files are in them already)
  postMessage({ ready: { trees: Object.fromEntries(W.version.parts.filter((p) => !p.shared).map((p) => [p.name, p.tree])), kept, manifest: W.version.manifest, real } });
  lightWatch();
}

/** The part that reads the file `path` of version `name` as the page knows it (game-data.js partOf), or null. */
const route = (name, path) => (W.parts.has(name) ? partOf(W.version, name, path) : null);

/** The file `path` of version `name`, opened once (through the part that reads it). */
function handle(name, path) {
  const key = name + '\n' + path;
  let f = W.handles.get(key);
  if (!f) { f = route(name, path)?.files.open(path) ?? null; if (f) W.handles.set(key, f); }
  return f;
}

/** How far the bytes of `f` from `from` are here already (memory or store: no network), up to `limit`. */
function hereUntil(files, f, from, limit) {
  let pos = from;
  while (pos < limit) {
    const bi = Math.floor(pos / BLOCK), c = Math.floor(pos / CHUNK);
    if (files.peekBlockHere(f.path, f.len, f.mtime, bi)) pos = (bi + 1) * BLOCK;
    else if (files.pieceHere(f.path, f.len, f.mtime, c)) pos = (c + 1) * CHUNK;
    else break;
  }
  return Math.min(pos, limit);
}

/**
 * Bytes of `path` from `off`: at least `len` (fetched when missing — the reader's own planning: pieces, blocks, read
 * ahead, the link's measure), and on as far as they are here already, up to `want` in all. `ask`: the read, { held } —
 * whether the engine waits for it (counted among the waits while it waits for the network: waited()). Always a buffer
 * of their own (a copy, or a fetch's response), nothing the worker keeps: answerAsync hands it over to the page, which
 * frees it.
 */
async function bytesOf({ name, path, off, len, want, src }, ask = { held: true }) {
  if (src !== undefined) return sourceBytes(src, off, len);
  const part = route(name, path), f = handle(name, path);
  if (!part || !f) throw new Error(`${name}: ${path} not in the game's files`);
  const end = Math.min(f.len, off + len);
  if (end <= off) return new Uint8Array(0);
  W.readSeen = true; W.boot = false;
  if (W.prefetchAt === 'first-read' && !W.prefetching) prefetchAll();
  await adoptLegacy(name, path, part, f);
  const real = contentHere(name, path, f, off, end);
  if (real) {
    const stop = Math.max(end, hereUntil(real.files, real.f, Math.ceil(end / CHUNK) * CHUNK, Math.min(real.f.len, off + Math.max(len, want ?? 0))));
    return real.f.read(off, stop - off);
  }
  const wait = f.prepare(off, end - off);
  if (wait) {
    // (a media stream's read: a wait of the engine's, not of a load — see HttpFile.prepare)
    ask.media = !!part.files.isMedia?.(f.path);
    // (its file's whole fill first once the engine waits for it: waited, HttpBackend.noteWait)
    ask.files = part.files; ask.path = f.path;
    W.waits.add(ask); waited();
    try { await wait; } finally { W.waits.delete(ask); if (ask.tok) { W.version.net.waitEnd(ask.tok); ask.tok = null; } waited(); }
  }
  const stop = Math.max(end, hereUntil(part.files, f, Math.ceil(end / CHUNK) * CHUNK, Math.min(f.len, off + Math.max(len, want ?? 0))));
  W.trace?.({ k: 'wread', f: path, off, len: stop - off, held: ask.held ? 1 : 0, waited: wait ? 1 : 0 });
  return f.read(off, stop - off);
}

/**
 * A content file's light copy (game-tree.js isLightContent: every offset the file's, payloads zeroed) read where the
 * file's own bytes [off, end) are all here already (memory or store): the file's { files, f } to read them from — a
 * superset of the copy's, what an engine reading the file itself at its content load stored (a store from before its
 * engine read the copy) read as it is instead of fetched again light —, else null.
 */
function contentHere(name, path, f, off, end) {
  if (!path.startsWith(LIGHT_DIR + '/') || !isLightContent(path)) return null;
  const rel = path.slice(LIGHT_DIR.length + 1), part = route(name, rel), r = part ? handle(name, rel) : null;
  return r && r.len === f.len && hereUntil(part.files, r, off, end) >= end ? { files: part.files, f: r } : null;
}

/**
 * The reads waiting for the network that the engine waits for, counted again (W.waiting; lastWait while there are);
 * each one a wait of the link's while it is held (NetLink.wait: the background keeps to a load's needs during a run of
 * them) — not a read fetched in the background, nor one the engine went on past, nor a media stream's.
 */
function waited() {
  const was = W.waiting, net = W.version.net;
  W.waiting = 0;
  for (const a of W.waits) {
    if (a.held) W.waiting++;
    // (once per ask: an ask the engine went on past never counts — a sample skipped while missing)
    if (a.held && !a.noted && a.files) { a.noted = true; a.files.noteWait?.(a.path); }
    if (a.held && !a.media && !a.tok) a.tok = net.wait(); else if (!a.held && a.tok) { net.waitEnd(a.tok); a.tok = null; }
  }
  if (W.waiting > 0 || was > 0) W.lastWait = performance.now();
}

/** The page says which of its asynchronous reads the engine waits for now ([id, 1 | 0]: data-client.js holdCheck, holdWatch). */
function hold(list) {
  for (const [id, on] of list) { const a = W.held.get(id); if (a) a.held = !!on; }
  waited();
}

async function answerSync(m) {
  let bytes = null, error = null;
  try { bytes = await bytesOf(m); } // (the page's thread waits for it)
  catch (err) { error = String(err?.message ?? err); postMessage({ log: `${m.path}: ${error}` }); }
  settleSync(m, bytes, error);
}

/**
 * A synchronous request's answer: on shared memory (its bytes in W.data, ctrl[1] their count or -1, ctrl[0] its number),
 * unless the page gave it up (late: ctrl[16] no longer its number — the page's engine suspended meanwhile): then by
 * message, as answerAsync's.
 */
function settleSync(m, bytes, error) {
  const { ctrl, data } = W;
  if (m.late !== undefined && Atomics.compareExchange(ctrl, 16, m.gen, -m.gen) !== m.gen) {
    if (bytes) postMessage({ id: m.late, bytes }, [bytes.buffer]); else postMessage({ id: m.late, error: error ?? 'read failed' });
    return;
  }
  if (bytes) { const n = Math.min(bytes.length, data.length); data.set(bytes.subarray(0, n), 0); ctrl[1] = n; } else ctrl[1] = -1;
  Atomics.store(ctrl, 0, m.gen);
  Atomics.notify(ctrl, 0);
}

/**
 * An asynchronous read answered: its bytes a buffer of their own (bytesOf), transferred — the page takes it over and
 * frees it once copied into its pieces (data-client.js fetchAsync, release). Never a view of what the worker keeps.
 */
async function answerAsync(m) {
  // (the engine waits for it once the page says so — held —, at once when it says so with the read)
  const ask = { held: !!m.held };
  W.held.set(m.id, ask);
  try { const bytes = await bytesOf(m, ask); postMessage({ id: m.id, bytes }, [bytes.buffer]); }
  catch (err) { postMessage({ id: m.id, error: String(err?.message ?? err) }); }
  finally { W.held.delete(m.id); }
}

// ---------------------------------------------------------------- announced reads

/**
 * A batch of announced reads (GameData.want: `seq` its number, `from` the first batch of the page's current wait window,
 * `list` [[name, path, off, len]] — len -1: to the end of the file —, `label` what the load is for, e.g. 'meshes:-2,6'):
 * each version's entries to its reader (HttpBackend.wantList: fetched in parallel, kept), and as they land or fail, the
 * counters the page's wait reads (ctrl[12] — every batch of the window up to it settled —, ctrl[13], ctrl[14]). The
 * batch is registered whatever happens (an exception: its entries failed), so the window's count never stops at it.
 * `wait` false (GameData.want's: the engine waits for it through its own reads, never wantWait): no batch — its entries
 * counted in ctrl[13] and ctrl[14] only —, and no hold of the link's nor of the learned read-ahead (wantList `wait` false).
 */
function want({ seq, from, list, label, wait }) {
  const batch = wait !== false;
  W.wantLabel = typeof label === 'string' ? label.slice(0, 80) : null;
  const byPart = new Map();
  for (const [name, path, off, len] of list) {
    const part = route(name, String(path));
    const a = Math.max(0, Number(off) || 0), n = Number(len);
    if (!part) { W.wantFailed++; continue; }
    let e = byPart.get(part); if (!e) byPart.set(part, e = []);
    e.push([path, a, n < 0 || !Number.isFinite(n) ? -1 : a + n]);
  }
  const all = [];
  try { for (const [part, ranges] of byPart) all.push(...part.files.wantList(ranges, { label: W.wantLabel, wait: batch })); }
  catch { W.wantFailed += list.length - all.length; }
  if (batch) {
    W.wantMax = Math.max(W.wantMax, seq);
    if (Number.isInteger(from) && from > W.wantFrom) W.wantFrom = from;
    // (a settled batch leaves the map: a number up to wantMax not in it is settled)
    if (all.length) W.wants.set(seq, all.length);
  }
  W.wantLeft += all.length;
  const settle = (ok) => {
    W.wantLeft--; if (!ok) W.wantFailed++;
    if (batch) { const n = W.wants.get(seq) - 1; if (n > 0) W.wants.set(seq, n); else W.wants.delete(seq); }
    wantTell();
  };
  for (const p of all) p.then(settle, () => settle(false));
  wantTell();
}

/**
 * A predicted place's set (GameData.want `prio: 'place'`: `list` [[name, path, off, len]], `label` 'place:<key>'): each
 * version's entries to its reader at the place's priority (HttpBackend.wantList `prio: 'place'` — the link's idle time,
 * below the game's reads, a load's and the launch set); no batch, no counter the page waits on.
 */
function wantPlace({ list, label }) {
  const byPart = new Map();
  for (const [name, path, off, len] of Array.isArray(list) ? list : []) {
    const part = route(name, String(path)); if (!part) continue;
    const a = Math.max(0, Number(off) || 0), n = Number(len);
    let e = byPart.get(part); if (!e) byPart.set(part, e = []);
    e.push([path, a, n < 0 || !Number.isFinite(n) ? -1 : a + n]);
  }
  for (const [part, ranges] of byPart) try { part.files.wantList(ranges, { label: typeof label === 'string' ? label.slice(0, 80) : '', prio: 'place' }); } catch { /* a reader closed: nothing kept */ }
}

/**
 * The announced batches' counters to the page: the last batch settled with every one of the window before it (ctrl[12]:
 * from W.wantFrom — an older one still unsettled, its wait over, holds nothing), entries left, failed.
 */
function wantTell() {
  let done = W.wantFrom - 1;
  while (done < W.wantMax && !W.wants.has(done + 1)) done++;
  Atomics.store(W.ctrl, 13, W.wantLeft); Atomics.store(W.ctrl, 14, W.wantFailed);
  Atomics.store(W.ctrl, 12, done); Atomics.notify(W.ctrl, 12);
}

// ---------------------------------------------------------------- files of elsewhere

/**
 * Files an engine reads that are not the game's (a file the player picked, a Blob the page keeps, a signed address):
 * { url } read by ranges (retried), { handle } (a FileSystemFileHandle) or { blob } sliced. Not kept, not learned.
 */
async function sourceBytes(id, off, len) {
  const s = W.sources.get(id); if (!s) throw new Error('unknown source');
  if (s.blob || s.handle) { s.file ??= s.blob ?? await s.handle.getFile(); return new Uint8Array(await s.file.slice(off, off + len).arrayBuffer()); }
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
    try {
      const r = await fetch(s.url, { headers: { Range: `bytes=${off}-${off + len - 1}` }, cache: 'no-store' });
      if (r.status === 206 || r.ok) { const b = new Uint8Array(await r.arrayBuffer()); return r.status === 206 ? b : b.subarray(off, off + len); }
      last = new Error('HTTP ' + r.status); if (r.status < 500 && r.status !== 408 && r.status !== 429) break;
    } catch (err) { last = err; }
  }
  throw last ?? new Error('read failed');
}

// ---------------------------------------------------------------- what the engine read: the server's learned order

/** Pieces the engine used for the first time ([name, path, piece], told by the page): reported with their time. */
function used(list) {
  if (W.t0 === null) return;
  const t = Math.round(performance.now() - W.t0);
  for (const [name, path, c] of list) {
    if (name !== W.version.parts[0].name) continue; // (the learned order is the version's own)
    let s = W.seen.get(path); if (!s) W.seen.set(path, s = new Set());
    if (s.has(c)) continue;
    s.add(c);
    const f = handle(name, path); if (!f) continue;
    const a = c * CHUNK, b = Math.min(f.len, a + CHUNK), last = W.reads.at(-1);
    if (last && last[0] === path && last[2] === a && last[3] === t) last[2] = b; else W.reads.push([path, a, b, t]);
  }
}

function report(final = false, marked = null) {
  if ((!W.reads.length && !marked) || !W.session) return;
  // (a mark goes with every read before it, in one report: the server flags what the session had read by then)
  const reads = W.reads.splice(0, marked ? MARK_READS : 5000), name = W.version.parts[0].name;
  // (in order: a mark after the reports before it; the final one at once, keepalive while small enough — playable-watch.js)
  W.reports.send(name, W.session, reads, marked, final, W.phases);
}

/** The most phases a session tells (GameData.phase). */
const MAX_PHASES = 200;

/**
 * The page's game entered phase `name` (GameData.phase: a map, a level) `ago` ms ago: [name, t] (t: ms from the
 * session's start, the reads' times) goes with every report from now on — the server learns each read as its phase's.
 */
function phase({ name, ago }) {
  if (W.t0 === null || typeof name !== 'string' || !name || W.phases.length >= MAX_PHASES) return;
  const t = Math.max(0, Math.round(performance.now() - W.t0 - ago));
  if (W.phases.at(-1)?.[0] === name) return;
  W.phases.push([name, t]);
}

/**
 * The page's game reached a moment of its own (GameData.mark: 'playable' — it first draws in play): told to the server
 * once per kind, with the reads before it (the server learns the launch set from it: launch-set.js).
 */
function mark(m) {
  const kind = String(m.kind ?? ''); if (!/^[a-z-]{1,20}$/.test(kind) || W.marks.has(kind) || W.t0 === null) return;
  W.marks.add(kind);
  report(false, { kind, t: Math.round(performance.now() - W.t0), ...(W.lang ? { lang: W.lang } : {}) });
}

// ---------------------------------------------------------------- loading ahead

/**
 * The learned order of the version, one list a part: what earlier sessions read first, the startup set its head — the
 * entries of files another version owns in that version's part's list (learnedOrders).
 */
const order = () => (W.learned ??= learnedOrders(W.version, W.lang));

/**
 * The startup set loaded (before the engine starts): every part's launch set — the version's, then those of the versions
 * it requires (the game reads them too), each from its own learned order —; progress { bytes, total, done } to the page.
 */
async function startup() {
  const lists = await order(), fast = W.version.net.fast();
  const heads = W.version.parts.map((p, i) => ({ p, head: launchSet(p.files, lists[i], fast), progress: { bytes: 0, blocks: 0, done: false } })).filter((h) => h.head.length);
  // (a fast link fetches the set's blocks whole: counted so; the progress never past its total all the same)
  const total = heads.reduce((n, h) => n + setBytes(h.p.files, h.head, fast).bytes, 0);
  const bytes = () => Math.min(total, heads.reduce((n, h) => n + h.progress.bytes, 0));
  if (!heads.length) { postMessage({ startup: { bytes: 0, total: 0, done: true } }); return; }
  const tick = setInterval(() => postMessage({ startup: { bytes: bytes(), total, done: false } }), 250);
  // (the pieces sessions read only: the rest of their blocks comes with the learned order, once the engine runs)
  try { for (const h of heads) { if (W.stop) break; await h.p.files.prefetch(h.head, h.progress, () => W.stop, { learnedOnly: true }); } }
  finally { clearInterval(tick); postMessage({ startup: { bytes: bytes(), total, done: true } }); }
}

/**
 * The learned order loaded now, before the engine's first read (GameData.prefetchNow: a page whose engine went quiet on
 * the link — OpenMW's once its package is in, its main() initialising for seconds before it reads a game file), only
 * on a cold store (less than LAUNCH_COLD of the launch set's bytes here: a new device, a store cleared, a version
 * updated): the link idle meanwhile fetches what the way to the menu reads first. A warm one, even missing part of the
 * set (another session's first place, entries learned since), starts at the first read as before
 * ('first-read': requests beside an engine's boot delay its first read — docs/openmw-history.md "Anticipated places" —, and
 * nothing there would be fetched). Its progress told to the page every BOOT_TELL_MS until that first read (boot).
 */
async function prefetchNow() {
  if (W.prefetching || W.stop) return;
  const lists = await order();
  if (W.prefetching || W.stop) return;
  // (judged on the set the home's card and "Prepare" call ready: the light one for an engine that reloads in place —
  // W.reloads, told by the page before its engine runs, read after the order's await; a store "Prepare" left at its
  // light stage is warm — and the files' own set on a fast link otherwise: lightLaunch)
  const fast = !lightLaunch(W.version.net.fast(), W.reloads);
  let bytes = 0, here = 0;
  W.version.parts.forEach((p, i) => { const s = setBytes(p.files, launchSet(p.files, lists[i], fast)); bytes += s.bytes; here += s.here; });
  if (!bytes || here >= bytes * LAUNCH_COLD) return;
  // (paced only before the engine's first read: one that came while the order was on its way ended the boot)
  W.boot = !W.readSeen;
  prefetchAll();
}

/**
 * The whole learned order, in the background from the game's position in it (HttpBackend.prefetch), every part's; its
 * progress to the page every second ({ ahead: { done, total, finished } }: entries of the order passed, of all).
 */
async function prefetchAll() {
  if (W.prefetching) return;
  W.prefetching = true;
  const lists = await order(), runs = [];
  W.version.parts.forEach((p, i) => {
    // (a part without a store: a Windows game's run without the browser's copy — a harness's —, as before the data worker)
    if (!lists[i].length || !p.store) return;
    // (its launch set first: a player waiting in the menu gets what the way to playable still needs first — launchFirst)
    const list = launchFirst(p.files, lists[i], W.version.net.fast());
    const progress = { bytes: 0, blocks: 0, done: false, total: list.length };
    // (made again when the link's class changes: the rate this page started with was another page's — relist)
    runs.push({ p, progress, job: p.files.prefetch(list, progress, () => W.stop, { first: list.first, relist: (fast) => launchFirst(p.files, lists[i], fast) }).catch(() => {}) });
  });
  W.runs = runs;
  if (!runs.length) return;
  launchWatch(lists);
  const tell = () => {
    let done = 0, total = 0;
    for (const { p, progress } of runs) { const n = p.files.learned?.entries.length ?? 0; total += n; done += progress.done ? n : Math.min(n, Math.max(0, (progress.k ?? -1) + 1)); }
    postMessage({ ahead: { done, total, finished: runs.every((r) => r.progress.done) } });
  };
  // (paced while the engine boots: each post a task of the page's thread — and of the page around it — the boot shares)
  let told = -1e9;
  const tick = setInterval(() => { const now = performance.now(); if (W.boot && now - told < BOOT_TELL_MS) return; told = now; tell(); }, 1000);
  await Promise.all(runs.map((r) => r.job));
  clearInterval(tick); tell();
}

/**
 * The way to playable, told to the page every LAUNCH_TELL_MS while the game is not there yet ({ launch: { bytes, here,
 * wireLeft, seconds, done } }): the launch set of every part as this link reads it (launch-set.js: what earlier
 * sessions read before their game was playable — a new game's first load included), its bytes here already, the wire
 * bytes left (the link's measured ratio of wire to decoded bytes, else WIRE_RATIO) and the seconds they take at the
 * link's measured rate (null until measured). The set prefetchAll fetches first (launchFirst on this link's class), not
 * the light one the home announces for an engine that reloads in place (lightLaunch): counted on a set nothing fetches,
 * the pill would stay at its light copies' bytes while the link brings the files. Only for an order with flags (a
 * session marked the version playable); over once all of it is here or the game is playable (the page's mark).
 */
function launchWatch(lists) {
  if (!lists.some(flagged)) return;
  let sets = null, fastWas = null, timer = null, told = -1e9;
  const tell = () => {
    const now = performance.now();
    if (W.boot && now - told < BOOT_TELL_MS) return false;
    told = now;
    const net = W.version.net, fast = net.fast();
    if (fast !== fastWas) { fastWas = fast; sets = W.version.parts.map((p, i) => ({ p, set: launchSet(p.files, lists[i], fast) })); }
    let bytes = 0, here = 0;
    for (const { p, set } of sets) { const s = setBytes(p.files, set); bytes += s.bytes; here += s.here; }
    // (WIRE_RATIO at least: the session's own ratio so far is a game's master files', which compress far better than the
    // textures and models of a first load — measured at 85 KB/s, it said "< 1 min" for a load of 86 s)
    const ratio = Math.max(WIRE_RATIO, net.totals.rawBytes >= 1 << 20 ? net.ratio() : 0), wireLeft = Math.round(Math.max(0, bytes - here) * ratio);
    const seconds = net.measured && net.bw > 0 ? Math.ceil(wireLeft / net.bw) : null;
    const done = here >= bytes || W.marks.has('playable') || W.stop;
    postMessage({ launch: { bytes, here, wireLeft, seconds, done } });
    if (done && timer !== null) clearInterval(timer);
    return done;
  };
  if (!tell()) W.timers.push(timer = setInterval(tell, LAUNCH_TELL_MS));
}

/** The whole version (and the ones it requires) into the browser's copy, in the background, after the game's reads. */
async function wholeDownload() {
  if (W.whole && !W.whole.stop) return;
  const w = W.whole = { stop: false, bytes: 0, total: W.version.parts.reduce((n, p) => n + p.total, 0), done: false };
  const lists = await order();
  const tick = setInterval(() => postMessage({ whole: { bytes: w.bytes, total: w.total, done: false } }), 1000);
  try {
    for (const [i, p] of W.version.parts.entries()) {
      const progress = { bytes: 0, total: 0, done: false }, before = w.bytes;
      const watch = setInterval(() => { w.bytes = before + (progress.bytes ?? 0); }, 250); // (bytes: those stored before included)
      try { await p.files.downloadAll(progress, () => w.stop || W.stop, { order: lists[i] }); } finally { clearInterval(watch); }
      w.bytes = before + p.total;
      if (w.stop || !progress.done) return;
    }
    w.done = true;
  } finally { clearInterval(tick); postMessage({ whole: { bytes: w.bytes, total: w.total, done: w.done, stopped: w.stop } }); }
}

// ---------------------------------------------------------------- the indicator's counters

function monitor() {
  const { ctrl } = W, net = W.version.net, raw = net.totals.rawBytes;
  Atomics.store(ctrl, 2, raw % 0x7fffffff);
  Atomics.store(ctrl, 6, W.waiting);
  Atomics.store(ctrl, 7, net.fast() ? 1 : 0); Atomics.store(ctrl, 8, net.measured && net.bw > 0 ? Math.round(net.bw / 1024) : 0);
  Atomics.store(ctrl, 9, net.thin() ? 1 : 0);
  Atomics.store(ctrl, 15, Math.round(net.ratio() * 1000));
  const now = performance.now();
  Atomics.store(ctrl, 10, aheadIdle() ? 1 : 0);
  Atomics.store(ctrl, 11, W.waiting > 0 ? 0 : Math.min(0x7fffffff, Math.round(now - W.lastWait)));
  // (the current step: from the first wait after a pause, the bytes received, and those the learned order says remain)
  if (W.waiting > 0) {
    W.step ??= { base: raw };
    let rest = null;
    for (const p of W.version.parts) { const e = p.files.stepEstimate(); if (e) rest = (rest ?? 0) + e.bytes; }
    const done = raw - W.step.base;
    Atomics.store(ctrl, 4, Math.round(done / 1024)); Atomics.store(ctrl, 5, rest === null ? 0 : Math.round((done + rest) / 1024));
  } else if (W.step && now - W.lastWait > STEP_PAUSE_MS) { W.step = null; Atomics.store(ctrl, 4, 0); Atomics.store(ctrl, 5, 0); }
  // (the link's counters for the page's reports — GameData.snapshot's `net`: the background's bytes by producer —, every second)
  if (now - (W.netAt ?? -1e9) >= 1000) { W.netAt = now; postMessage({ net: net.snapshot() }); }
}

/**
 * The learned order's loading has nothing left for the game's current step: it does not run, it is over, or the
 * entries past the game's position up to its next pause are here (HttpBackend.stepEstimate) — every part's.
 */
function aheadIdle() {
  if (!W.prefetching) return true;
  if (!W.runs) return false; // (its order on its way)
  return W.runs.every(({ p, progress }) => progress.done || p.files.stepEstimate()?.bytes === 0);
}

// ---------------------------------------------------------------- light copies: the files themselves after them

/** The key the page knows a file by (data-client.js). */
const lightKey = (name, path) => name + '\n' + path.toLowerCase();

/**
 * The engine read the light copy of `path`: the file itself in the background (HttpBackend.upgrade), told once here;
 * `soon` for an engine that loads it again in place (GameData.reloads: the player sees it sharpen).
 */
function upgrade(name, path, soon = false) {
  const part = route(name, path), r = part?.files.lookup(path); if (!r?.file) return;
  part.files.upgrade(r.path, { soon });
}

/**
 * The files that have a light copy, as they come (every second): one here whole now — upgraded, or brought by the
 * whole download, the learned order, a read — is told to the page (`real`: read itself from its next load); one whose
 * light copy is here whole (`lightHere`: read light even on a fast link — the learned order brought it before the link
 * was measured — until the file itself is here).
 */
function lightWatch() {
  const real = [], lightHere = [];
  for (const [k, e] of W.light) {
    if (e.part.files.isWhole(e.path)) { real.push(k); W.light.delete(k); }
    else if (!e.told && e.part.files.isWhole(`${LIGHT_DIR}/${e.path}`)) { e.told = true; lightHere.push(k); }
  }
  if (real.length || lightHere.length) postMessage({ real, lightHere });
}

// ---------------------------------------------------------------- copies kept by earlier versions of the page

/**
 * A copy of a file an earlier version of the page kept elsewhere (told by the page: { name, path, module, args } — the
 * runtime's module that knows that copy, its `adopt(args, keep)` handing its bytes to keep(at, bytes)): taken into the
 * store before the file's first read, once.
 */
async function adoptLegacy(name, path, part, f) {
  const key = name + '\n' + path.toLowerCase(), rec = W.legacy.get(key);
  if (!rec) return;
  W.legacy.delete(key);
  try {
    let mod = W.adopters.get(rec.module);
    if (!mod) W.adopters.set(rec.module, mod = import(rec.module));
    await (await mod).adopt(rec.args, (at, bytes) => part.files.keep(f.path, f.len, f.mtime, at, bytes));
  } catch (err) { postMessage({ log: `${path}: an earlier copy not taken (${err?.message ?? err})` }); }
}

/**
 * Bytes the page kept elsewhere before (an earlier store of the page: { name, path, at, bytes } — whole blocks or 64 KiB
 * pieces of the file `path` from offset `at`), put into this store as if fetched.
 */
function migrate(list) {
  for (const { name, path, at, bytes } of list) {
    const part = route(name, path), f = handle(name, path);
    if (!part?.store || !f || at % CHUNK || at + bytes.length > f.len) continue;
    part.files.keep(f.path, f.len, f.mtime, at, bytes);
  }
  postMessage({ migrated: list.length });
}

// ---------------------------------------------------------------- a Windows game's data (data-link.js)

/** How often the replayed reads are taken from the ring (ms), the counters told to the emulator, the stores synced. */
const W32_DRAIN_MS = 4, W32_STATS_MS = 250, W32_FLUSH_MS = 2000;

/**
 * A Windows game's version opened for its emulator (data-link.js DataLink.open: o — name, tree, manifest, mounts,
 * session, lang, bw, cacheBlocks, encoded, stores 'opfs' | 'none', memPrefetch, prefetch, offline, netLog): the parts'
 * stores as the emulator opened them before (the browser's copy for a page or a harness's persistent profile; a memory
 * one for a harness's --memprefetch; none otherwise), each mounted version a PartsBackend (its prediction of opens),
 * the shared blocks (one block cache for the parts, cacheBlocks a mounted version as their memory budget was), every
 * network arrival put there; the learned order and the offline copy as the engines' (prefetchAll, wholeDownload).
 */
async function w32Init(o) {
  W.session = o.session ?? ''; W.lang = typeof o.lang === 'string' && o.lang ? o.lang : null; W.t0 = performance.now();
  const X = W.w32 = { handles: new Map(), dead: new Set(), mounts: new Map(), keys: new Map(), blocks: null, answer: null, unlearnedOnly: false, reads: [] };
  const log = (msg, kind = 'file') => postMessage({ log: msg, kind });
  const persistent = o.stores === 'opfs';
  const storeOf = async (name, primary, shared) => {
    let store = persistent ? await openStore(name) : null;
    if (!store && o.memPrefetch) store = new MemBlockStore((primary || shared ? 1536 : 1024) * 1048576); // (harness: prefetch measured without a persistent profile)
    const tag = primary ? '' : ` (${name})`;
    if (store) {
      log(`block store${tag}: ${store.map.size} blocks (${Math.round((store.end ?? store.bytes ?? 0) / 1048576)} MiB) from earlier runs${store.resetReason ? ` (emptied: ${store.resetReason})` : ''}`);
      store.onCorrupt = (key) => { if ((store.stats.corrupt ?? 0) <= 20) log(`block store${tag}: a stored block did not read back as written, fetched again: ${key}`, 'warn'); };
    }
    return store;
  };
  // (the emulator's memory cache is the shared blocks: the reader here keeps a smaller one of its own — its planning's
  // look-ups, the blocks it assembles —, the stores answer the rest)
  const cacheBlocks = Math.max(1, o.cacheBlocks ?? 256), own = Math.min(cacheBlocks, Number(globalThis.ORTHROS_DATA_OWN_BLOCKS) || 64);
  W.version = await openVersion(o.name, { tree: o.tree, manifest: o.manifest, bw: o.bw, store: storeOf, legacy: persistent ? openLegacyStore : null,
    cacheBlocks: own, encoded: !!o.encoded, session: W.session,
    // (a session restored from a snapshot reports only the reads the server did not learn from its requests — those
    // without a session, and those served by bytes an announced or predicted request brought: HttpBackend.takeUnlearned;
    // the emulator reports every other session's reads itself)
    onRead: (p, a, b, f) => {
      const un = f?.b?.takeUnlearned?.(p, a, b);
      if (!X.unlearnedOnly) return;
      const name = f?.readName ?? o.name, path = f?.readPath ?? p, t = performance.now();
      if (!f?.b?.session) X.reads.push([name, path, a, b, t]); else if (un) for (const [x, y] of un) X.reads.push([name, path, x, y, t]);
    },
    onFetch: o.netLog ? (f) => log(`t=${(performance.now() / 1000).toFixed(1)}s ${f.async ? 'parked' : 'sync'} ${f.url} [${f.start}, ${f.end}) ${Math.round(f.ms)}ms`, 'net') : null,
    onRetry: (r) => log(`game file read: ${r.problem} for ${r.url} [${r.start}, ${r.end}), attempt ${r.attempt + 1}`, 'warn') });
  const v = W.version;
  for (const p of v.parts) W.parts.set(p.name, p);
  for (const p of v.parts) if (p.store instanceof UnderStore) log(`block store (${p.name}): its files, kept before in ${p.store.below.length} other store(s), moved there as read`);
  // (the shared blocks: as many as the parts' memory caches had — a mounted version's budget each, game-data.js openVersion)
  const units = Math.max(1, v.parts.filter((p) => !p.name.endsWith('@base')).length);
  X.blocks = new SharedBlocks(SharedBlocks.create(cacheBlocks * units), true);
  const mounts = [];
  (o.mounts ?? [o.name]).forEach((name, i) => {
    const b = new PartsBackend(v, name), keys = fileKeys(b.tree, i);
    X.mounts.set(name, b);
    // (a file's keys by the part that reads it and that part's path: a network arrival put under each)
    for (const [path, key] of keys) {
      const part = partOf(v, name, path) ?? b.own, r = part.files.lookup(path); if (!r?.file) continue;
      let m = X.keys.get(part.files); if (!m) X.keys.set(part.files, m = new Map());
      let l = m.get(r.path); if (!l) m.set(r.path, l = []);
      l.push(key);
    }
    mounts.push({ name, tree: b.tree, parts: b.parts.map((p) => p.name) });
  });
  for (const p of v.parts) p.files.arrivals.add((path, start, bytes) => w32Arrived(p.files, path, start, bytes));
  W.timers.push(setInterval(w32Drain, W32_DRAIN_MS), setInterval(w32Stats, W32_STATS_MS), setInterval(() => w32Flush(false), W32_FLUSH_MS), setInterval(() => X.blocks.beat(), 100));
  if (o.prefetch) prefetchAll();
  if (o.offline) wholeDownload();
  postMessage({ w32ready: { sab: X.blocks.sab, mounts, manifest: v.manifest, parts: v.parts.map((p) => p.name) } });
}

/** A Windows game's message (true: taken). */
function w32Dispatch(m) {
  const X = W.w32;
  if (m.w32open) { const [h, name, path] = m.w32open, f = X.mounts.get(name)?.open(path); if (f) X.handles.set(h, f); else X.dead.add(h); return true; }
  if (m.w32close !== undefined) { w32Drain(); X.handles.get(m.w32close)?.close(); X.handles.delete(m.w32close); X.dead.add(m.w32close); return true; }
  if (m.w32prep) { w32Prepare(m.w32prep); return true; }
  if (m.w32sync) { w32Sync(m.w32sync); return true; }
  if (m.w32flush !== undefined) { w32Flush(!!m.w32flush); return true; }
  if (m.w32unlearned) { X.unlearnedOnly = true; return true; }
  if (m.w32stop) { W.stop = true; if (W.whole) W.whole.stop = true; w32Drain(); w32Stats(); w32Flush(true); for (const p of W.version.parts) try { p.files?.stopFill?.(); } catch { /* closed */ } return true; }
  return false;
}

/** The reads the emulator answered from the shared blocks, replayed in order through their handles (HttpFile.seen). */
function w32Drain() {
  const X = W.w32;
  X.blocks.drain((h, off, end) => {
    const f = X.handles.get(h);
    if (!f) return X.dead.has(h); // (its open's message not here yet: later)
    f.seen(off, end);
    return true;
  });
}

/** Bytes that arrived from the network for `files`' file `path` from `start`, put in the shared blocks under its keys. */
function w32Arrived(files, path, start, bytes) {
  const keys = W.w32.keys.get(files)?.get(path); if (!keys) return;
  const len = files.lookup(path)?.file?.size; if (!(len > 0)) return;
  for (const key of keys) w32Put(key, len, start, bytes);
}
/** Bytes of a file of `len` bytes from `start` (piece-aligned) into the shared blocks, block by block. */
function w32Put(key, len, start, bytes) {
  const B = W.w32.blocks, end = Math.min(len, start + bytes.length);
  for (let pos = start; pos < end;) {
    const bi = Math.floor(pos / BLOCK), b0 = bi * BLOCK, stop = Math.min(end, b0 + BLOCK);
    B.publish(key, bi, pos - b0, bytes.subarray(pos - start, stop - start), Math.min(BLOCK, len - b0));
    pos = stop;
  }
}
/** What the reader here has of [off, end) of handle `f` (memory, store; no network) put in the shared blocks. */
function w32Publish(f, off, end) {
  const B = W.w32.blocks, b = f.b, keys = W.w32.keys.get(b)?.get(f.path); if (!keys) return;
  end = Math.min(end, f.len);
  for (let bi = Math.floor(off / BLOCK); bi * BLOCK < end; bi++) {
    const b0 = bi * BLOCK, blockLen = Math.min(BLOCK, f.len - b0), full = (1 << Math.ceil(blockLen / CHUNK)) - 1;
    if (keys.every((key) => B.maskOf(key, bi) === full)) continue;
    const blk = b.peekBlock(f.path, f.len, bi, f.mtime);
    if (blk) { for (const key of keys) B.publish(key, bi, 0, blk, blockLen); continue; }
    for (let c = Math.floor(Math.max(off, b0) / CHUNK), e = Math.floor((Math.min(end, b0 + BLOCK) - 1) / CHUNK); c <= e; c++) {
      if (!b.hasPiece(f.path, f.len, f.mtime, c)) continue;
      const piece = b.chunks.get(`${f.path}#${c}`); if (!piece) continue;
      for (const key of keys) B.publish(key, bi, c * CHUNK - b0, piece, blockLen);
    }
  }
}

/**
 * An asynchronous read the shared blocks did not hold (data-link.js prepare): HttpFile.prepare here (`held`: the guest
 * thread is parked on it), the emulator told at once when it needs the network (acked: its thread parks), then its
 * bytes put in the shared blocks and the read finished (shared memory, then a message: the emulator's event loop wakes).
 */
async function w32Prepare({ seq, h, off, len, held }) {
  w32Drain();
  const f = W.w32.handles.get(h), B = W.w32.blocks;
  if (f) {
    let p = null;
    try { p = f.prepare(off, len, held); } catch { /* the read fetches it and reports */ }
    if (p) { B.acked(seq); try { await p; } catch { /* likewise */ } }
    try { w32Publish(f, off, off + len); } catch { /* the read asks again */ }
  }
  B.finished(seq);
  postMessage({ w32done: seq });
}

/**
 * A synchronous read (data-link.js syncRead: the emulator's thread waits): [off, end) read here — this reader's state
 * follows it, as every read —, its bytes from `from` in the answer buffer.
 */
async function w32Sync({ gen, h, off, end, from, buf }) {
  const X = W.w32, B = X.blocks;
  if (buf) X.answer = new Uint8Array(buf);
  w32Drain();
  try {
    const f = X.handles.get(h); if (!f) throw new Error('file not open');
    const p = f.prepare(off, end - off, true);
    if (p) await p;
    const bytes = f.read(off, end - off);
    try { w32Publish(f, off, end); } catch { /* answered all the same */ }
    const k = Math.max(0, Math.min(bytes.length - (from - off), X.answer.length));
    if (k) X.answer.set(bytes.subarray(from - off, from - off + k));
    B.answer(gen, k);
  } catch (err) {
    postMessage({ log: `game file read failed: ${err?.message ?? err}`, kind: 'warn' });
    B.answer(gen, -1);
  }
}

/** The parts' stores synced (their index: a sync point every 2 s, at once when forced). */
function w32Flush(force) { for (const p of W.version?.parts ?? []) try { p.store?.flush?.(force); } catch { /* closed */ } }

/** The counters the emulator shows and reports (data-link.js state): the link, the parts' readers and stores, the background. */
function w32Stats() {
  const X = W.w32, v = W.version, net = v.net;
  if (X.reads.length) postMessage({ w32reads: X.reads.splice(0), t0: performance.timeOrigin });
  const pf = new Map((W.runs ?? []).map((r) => [r.p, r.progress]));
  postMessage({ w32stats: {
    net: net.snapshot(), ratio: net.ratio(), fast: net.fast(), thin: net.thin(),
    parts: v.parts.map((p) => ({ name: p.name, stats: { ...p.files.stats }, store: p.store ? { ...p.store.stats } : null, step: p.files.stepEstimate()?.bytes ?? null, prefetch: pf.has(p) ? { ...pf.get(p) } : null })),
    whole: W.whole ? { bytes: W.whole.bytes, total: W.whole.total, done: W.whole.done } : null,
    predicted: [...X.mounts.values()].map((b) => b.predictor?.stats ?? {}),
    blocks: { ...X.blocks.stats, drops: X.blocks.drops },
  } });
}
