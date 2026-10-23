// The game data of the engines that run in the page (GoldSrc, re3, OpenMW, the next ones — CLAUDE.md
// "Standardization"): the Windows games' reader (game-data.js: HttpBackend over the server's compressed ranges, the
// browser's OPFS copy, the order earlier sessions read the game in, the whole download) in a worker of its own. The
// page asks it for bytes through data-client.js: a read the engine waits for synchronously is answered on shared
// memory (ctrl[0] the request answered, ctrl[1] the bytes delivered or -1), one it can wait for (JSPI) by message.
// Counters shared with the page's indicator: ctrl[2] bytes received (decoded), ctrl[3] this worker's heartbeat,
// ctrl[4] / ctrl[5] KB of the current step here / in all (the learned order: HttpBackend.stepEstimate), ctrl[6] the
// page's reads waiting for the network that the engine waits for — a synchronous read, or an asynchronous one the page
// says holds the engine (`held`: data-client.js HOLD_MS; not one the engine asked ahead and went on past, nor one
// fetched in the background). The link, for the page: ctrl[7] 1 when it is fast (the files themselves read,
// not their light copies), ctrl[8] its measured rate (KB/s, 0 until measured), ctrl[9] 1 when it is thin (measured
// below THIN_BPS, net-link.js). The page's quiet (GameData.quiet: a page that loads more of its game when nothing waits):
// ctrl[10] 1 when the learned order's loading has nothing left for the game's current step (or does not run), ctrl[11]
// the time since a read last waited for the network (ms, 0 while one waits).
// A page's mark (GameData.mark('playable'): its game first draws in play) goes to the server with the reads before it:
// the launch set later sessions wait for and the home announces (launch-set.js).
// Light copies (src/host/light-copies.js): on a link that is not fast, the page reads a texture's light copy unless the
// file itself is here (told: { real: [keys] }); the learned order brings the light copies; the files whose light copy
// the engine read come last, in the background (HttpBackend.upgrade).
import { openVersion, openStore, learnedOrder } from './game-data.js';
import { MemBlockStore } from './opfs-store.js';
import { BLOCK, CHUNK } from './http-backend.js';
import { LIGHT_DIR, treeFiles } from './game-tree.js';
import { flagged, launchFirst, launchSet, setBytes, WIRE_RATIO } from './launch-set.js';
import { ReadReports } from './playable-watch.js';

/** The reads the engine used, sent to the server's learned order every so often. */
const REPORT_MS = 15000;
/** The most reads a report that carries a mark sends (the server takes 50000). */
const MARK_READS = 40000;
/** How often the way to playable (launchWatch) is told to the page while the game is not there. */
const LAUNCH_TELL_MS = 2000;
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
    prefetchAt: 'none', prefetching: false, runs: null, stop: false, whole: null, learned: null,
    legacy: new Map(), adopters: new Map(), sources: new Map(), light: new Map(), marks: new Set(), reports: new ReadReports(), phases: [],
  };
  return (m) => {
    if (m.init) {
      // (alive from now on — the page's waits watch it — though the version takes a moment to open: the rest waits for it)
      W.ctrl = new Int32Array(m.init.ctrl); W.timers.push(setInterval(() => Atomics.add(W.ctrl, 3, 1), 100));
      W.ready = init(m.init).catch((err) => { postMessage({ failed: String(err?.message ?? err) }); throw err; });
      return;
    }
    W.ready.then(() => dispatch(m), () => { if (typeof m.gen === 'number') { W.ctrl[1] = -1; Atomics.store(W.ctrl, 0, m.gen); } });
  };
}
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  const handle = createDataWorker((m, transfer) => self.postMessage(m, transfer));
  self.onmessage = (e) => handle(e.data);
}

function dispatch(m) {
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
  if (m.mark) { mark(m.mark); return; }
  if (m.phase) { phase(m.phase); return; }
  if (m.wantWhole) { W.parts.get(m.wantWhole.name)?.files.wantWhole(m.wantWhole.path); return; }
  if (m.light) { upgrade(m.light.name, m.light.path, !!m.light.soon); return; }
  if ('whole' in m) { m.whole ? wholeDownload() : (W.whole && (W.whole.stop = true)); return; }
  if (m.migrate) { migrate(m.migrate); return; }
  if (m.close) { W.stop = true; report(true); for (const t of W.timers) clearInterval(t); for (const p of W.parts.values()) try { p.store?.close(); } catch { /* closed */ } }
}

/**
 * { name, session, lang, bw, ctrl, data, prefetch: 'startup' | 'start' | 'first-read' | 'none', memBytes, cacheBlocks }: the
 * version and the ones it requires opened (lang: the game's language — its sessions' own launch set, launch-set.js) (their stores: OPFS, else in memory — another tab holds them, or no OPFS).
 */
async function init(o) {
  W.data = new Uint8Array(o.data); W.session = o.session ?? ''; W.lang = typeof o.lang === 'string' && o.lang ? o.lang : null; W.prefetchAt = o.prefetch ?? 'none';
  const kept = {};
  W.version = await openVersion(o.name, { bw: o.bw, tree: o.tree, cacheBlocks: o.cacheBlocks, store: async (n) => {
    const s = await openStore(n); kept[n] = !!s;
    return s ?? new MemBlockStore(o.memBytes ?? 512 << 20);
  } });
  for (const p of W.version.parts) W.parts.set(p.name, p);
  W.timers.push(setInterval(monitor, 100), setInterval(report, REPORT_MS), setInterval(lightWatch, 1000));
  // (the files that have a light copy: those here whole the page reads themselves; the others watched — lightWatch)
  const real = [];
  for (const p of W.version.parts) for (const f of treeFiles(p.tree)) {
    if (!f.light) continue;
    if (p.files.isWhole(f.path)) real.push(lightKey(p.name, f.path)); else W.light.set(lightKey(p.name, f.path), { part: p, path: f.path, told: false });
  }
  postMessage({ ready: { trees: Object.fromEntries(W.version.parts.map((p) => [p.name, p.tree])), kept, manifest: W.version.manifest, real } });
  lightWatch();
}

/** The file `path` of version `name`, opened once. */
function handle(name, path) {
  const key = name + '\n' + path;
  let f = W.handles.get(key);
  if (!f) { f = W.parts.get(name)?.files.open(path) ?? null; if (f) W.handles.set(key, f); }
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
 * whether the engine waits for it (counted among the waits while it waits for the network: waited()).
 */
async function bytesOf({ name, path, off, len, want, src }, ask = { held: true }) {
  if (src !== undefined) return sourceBytes(src, off, len);
  const part = W.parts.get(name), f = handle(name, path);
  if (!part || !f) throw new Error(`${name}: ${path} not in the game's files`);
  const end = Math.min(f.len, off + len);
  if (end <= off) return new Uint8Array(0);
  if (W.prefetchAt === 'first-read' && !W.prefetching) prefetchAll();
  await adoptLegacy(name, path, part, f);
  const wait = f.prepare(off, end - off);
  if (wait) {
    W.waits.add(ask); waited();
    try { await wait; } finally { W.waits.delete(ask); waited(); }
  }
  const stop = Math.max(end, hereUntil(part.files, f, Math.ceil(end / CHUNK) * CHUNK, Math.min(f.len, off + Math.max(len, want ?? 0))));
  return f.read(off, stop - off);
}

/** The reads waiting for the network that the engine waits for, counted again (W.waiting; lastWait while there are). */
function waited() {
  const was = W.waiting;
  W.waiting = 0;
  for (const a of W.waits) if (a.held) W.waiting++;
  if (W.waiting > 0 || was > 0) W.lastWait = performance.now();
}

/** The page says which of its asynchronous reads the engine waits for now ([id, 1 | 0]: data-client.js holdWatch). */
function hold(list) {
  for (const [id, on] of list) { const a = W.held.get(id); if (a) a.held = !!on; }
  waited();
}

async function answerSync(m) {
  const { ctrl, data } = W;
  try {
    const bytes = await bytesOf(m); // (the page's thread waits for it)
    const n = Math.min(bytes.length, data.length);
    data.set(bytes.subarray(0, n), 0);
    ctrl[1] = n;
  } catch (err) {
    ctrl[1] = -1;
    postMessage({ log: `${m.path}: ${err?.message ?? err}` });
  }
  Atomics.store(ctrl, 0, m.gen);
  Atomics.notify(ctrl, 0);
}

async function answerAsync(m) {
  // (the engine waits for it once the page says so — held —, at once when it says so with the read)
  const ask = { held: !!m.held };
  W.held.set(m.id, ask);
  try { const bytes = await bytesOf(m, ask); postMessage({ id: m.id, bytes }, [bytes.buffer]); }
  catch (err) { postMessage({ id: m.id, error: String(err?.message ?? err) }); }
  finally { W.held.delete(m.id); }
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

/** The learned order of the version: what earlier sessions read first, the startup set its head. */
const order = () => (W.learned ??= Promise.all(W.version.parts.map((p) => learnedOrder(p.name, W.lang))));

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
 * The whole learned order, in the background from the game's position in it (HttpBackend.prefetch), every part's; its
 * progress to the page every second ({ ahead: { done, total, finished } }: entries of the order passed, of all).
 */
async function prefetchAll() {
  if (W.prefetching) return;
  W.prefetching = true;
  const lists = await order(), runs = [];
  W.version.parts.forEach((p, i) => {
    if (!lists[i].length) return;
    const progress = { bytes: 0, blocks: 0, done: false };
    // (its launch set first: a player waiting in the menu gets what the way to playable still needs first — launchFirst)
    const list = launchFirst(p.files, lists[i], W.version.net.fast());
    runs.push({ p, progress, job: p.files.prefetch(list, progress, () => W.stop, { first: list.first }).catch(() => {}) });
  });
  W.runs = runs;
  if (!runs.length) return;
  launchWatch(lists);
  const tell = () => {
    let done = 0, total = 0;
    for (const { p, progress } of runs) { const n = p.files.learned?.entries.length ?? 0; total += n; done += progress.done ? n : Math.min(n, Math.max(0, (progress.k ?? -1) + 1)); }
    postMessage({ ahead: { done, total, finished: runs.every((r) => r.progress.done) } });
  };
  const tick = setInterval(tell, 1000);
  await Promise.all(runs.map((r) => r.job));
  clearInterval(tick); tell();
}

/**
 * The way to playable, told to the page every LAUNCH_TELL_MS while the game is not there yet ({ launch: { bytes, here,
 * wireLeft, seconds, done } }): the launch set of every part as this link reads it (launch-set.js: what earlier
 * sessions read before their game was playable — a new game's first load included), its bytes here already, the wire
 * bytes left (the link's measured ratio of wire to decoded bytes, else WIRE_RATIO) and the seconds they take at the
 * link's measured rate (null until measured). Only for an order with flags (a session marked the version playable);
 * over once all of it is here or the game is playable (the page's mark).
 */
function launchWatch(lists) {
  if (!lists.some(flagged)) return;
  let sets = null, fastWas = null, timer = null;
  const tell = () => {
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
  const part = W.parts.get(name), r = part?.files.lookup(path); if (!r?.file) return;
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
    const part = W.parts.get(name), f = handle(name, path);
    if (!part?.store || !f || at % CHUNK || at + bytes.length > f.len) continue;
    part.files.keep(f.path, f.len, f.mtime, at, bytes);
  }
  postMessage({ migrated: list.length });
}
