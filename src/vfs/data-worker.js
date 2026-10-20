// The game data of the engines that run in the page (GoldSrc, re3, OpenMW, the next ones — CLAUDE.md
// "Standardization"): the Windows games' reader (game-data.js: HttpBackend over the server's compressed ranges, the
// browser's OPFS copy, the order earlier sessions read the game in, the whole download) in a worker of its own. The
// page asks it for bytes through data-client.js: a read the engine waits for synchronously is answered on shared
// memory (ctrl[0] the request answered, ctrl[1] the bytes delivered or -1), one it can wait for (JSPI) by message.
// Counters shared with the page's indicator: ctrl[2] bytes received (decoded), ctrl[3] this worker's heartbeat,
// ctrl[4] / ctrl[5] KB of the current step here / in all (the learned order: HttpBackend.stepEstimate), ctrl[6] the
// page's reads waiting for the network.
import { openVersion, openStore, learnedOrder } from './game-data.js';
import { MemBlockStore } from './opfs-store.js';
import { BLOCK, CHUNK } from './http-backend.js';

/** The startup set (loaded before the engine starts, when the page asks): the learned order up to its first pause this long. */
const STARTUP_GAP_MS = 2000;
/** The reads the engine used, sent to the server's learned order every so often. */
const REPORT_MS = 15000;
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
    session: '', t0: null, reads: [], seen: new Map(), waiting: 0, lastWait: -1e9, step: null,
    prefetchAt: 'none', prefetching: false, stop: false, whole: null, learned: null,
    legacy: new Map(), adopters: new Map(), sources: new Map(),
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
  if (typeof m.gen === 'number') { answerSync(m); return; }
  if (m.read) { answerAsync(m.read); return; }
  if (m.start) { W.t0 = performance.now(); if (W.prefetchAt === 'start') prefetchAll(); return; }
  if (m.startup) { startup(); return; }
  if (m.wantWhole) { W.parts.get(m.wantWhole.name)?.files.wantWhole(m.wantWhole.path); return; }
  if ('whole' in m) { m.whole ? wholeDownload() : (W.whole && (W.whole.stop = true)); return; }
  if (m.migrate) { migrate(m.migrate); return; }
  if (m.close) { W.stop = true; report(true); for (const t of W.timers) clearInterval(t); for (const p of W.parts.values()) try { p.store?.close(); } catch { /* closed */ } }
}

/**
 * { name, session, bw, ctrl, data, prefetch: 'startup' | 'start' | 'first-read' | 'none', memBytes, cacheBlocks }: the
 * version and the ones it requires opened (their stores: OPFS, else in memory — another tab holds them, or no OPFS).
 */
async function init(o) {
  W.data = new Uint8Array(o.data); W.session = o.session ?? ''; W.prefetchAt = o.prefetch ?? 'none';
  const kept = {};
  W.version = await openVersion(o.name, { bw: o.bw, tree: o.tree, cacheBlocks: o.cacheBlocks, store: async (n) => {
    const s = await openStore(n); kept[n] = !!s;
    return s ?? new MemBlockStore(o.memBytes ?? 512 << 20);
  } });
  for (const p of W.version.parts) W.parts.set(p.name, p);
  W.timers.push(setInterval(monitor, 100), setInterval(report, REPORT_MS));
  postMessage({ ready: { trees: Object.fromEntries(W.version.parts.map((p) => [p.name, p.tree])), kept, manifest: W.version.manifest } });
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
 * ahead, the link's measure), and on as far as they are here already, up to `want` in all.
 */
async function bytesOf({ name, path, off, len, want, src }) {
  if (src !== undefined) return sourceBytes(src, off, len);
  const part = W.parts.get(name), f = handle(name, path);
  if (!part || !f) throw new Error(`${name}: ${path} not in the game's files`);
  const end = Math.min(f.len, off + len);
  if (end <= off) return new Uint8Array(0);
  if (W.prefetchAt === 'first-read' && !W.prefetching) prefetchAll();
  await adoptLegacy(name, path, part, f);
  const wait = f.prepare(off, end - off);
  if (wait) {
    W.waiting++; W.lastWait = performance.now();
    try { await wait; } finally { W.waiting--; W.lastWait = performance.now(); }
  }
  const stop = Math.max(end, hereUntil(part.files, f, Math.ceil(end / CHUNK) * CHUNK, Math.min(f.len, off + Math.max(len, want ?? 0))));
  return f.read(off, stop - off);
}

async function answerSync(m) {
  const { ctrl, data } = W;
  try {
    const bytes = await bytesOf(m);
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
  try { const bytes = await bytesOf(m); postMessage({ id: m.id, bytes }, [bytes.buffer]); }
  catch (err) { postMessage({ id: m.id, error: String(err?.message ?? err) }); }
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

function report(final = false) {
  if (!W.reads.length || !W.session) return;
  const reads = W.reads.splice(0, 5000), name = W.version.parts[0].name;
  fetch(`/api/prefetch/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: final, body: JSON.stringify({ session: W.session, reads }) }).catch(() => {});
}

// ---------------------------------------------------------------- loading ahead

/** The learned order of the version: what earlier sessions read first, the startup set its head. */
const order = () => (W.learned ??= Promise.all(W.version.parts.map((p) => learnedOrder(p.name))));

/** The startup set loaded (before the engine starts): progress { bytes, total, done } to the page. */
async function startup() {
  const lists = await order(), part = W.version.parts[0], list = lists[0];
  let end = list.length;
  for (let i = 1; i < list.length; i++) if (list[i][3] - list[i - 1][3] > STARTUP_GAP_MS) { end = i; break; }
  const head = list.slice(0, end);
  const progress = { bytes: 0, blocks: 0, done: false };
  const total = head.reduce((n, [, , mask]) => n + (mask ? popcount(mask) * CHUNK : BLOCK), 0);
  const tick = setInterval(() => postMessage({ startup: { bytes: progress.bytes, total, done: false } }), 250);
  if (!head.length) { clearInterval(tick); postMessage({ startup: { bytes: 0, total: 0, done: true } }); return; }
  // (the pieces sessions read only: the rest of their blocks comes with the learned order, once the engine runs)
  try { await part.files.prefetch(head, progress, () => W.stop, { learnedOnly: true }); }
  finally { clearInterval(tick); postMessage({ startup: { bytes: progress.bytes, total, done: true } }); }
}
const popcount = (m) => { let n = 0; while (m) { n += m & 1; m >>>= 1; } return n; };

/** The whole learned order, in the background from the game's position in it (HttpBackend.prefetch), every part's. */
async function prefetchAll() {
  if (W.prefetching) return;
  W.prefetching = true;
  const lists = await order();
  W.version.parts.forEach((p, i) => { if (lists[i].length) p.files.prefetch(lists[i], { bytes: 0, blocks: 0, done: false }, () => W.stop).catch(() => {}); });
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
  // (the current step: from the first wait after a pause, the bytes received, and those the learned order says remain)
  const now = performance.now();
  if (W.waiting > 0) {
    W.step ??= { base: raw };
    let rest = null;
    for (const p of W.version.parts) { const e = p.files.stepEstimate(); if (e) rest = (rest ?? 0) + e.bytes; }
    const done = raw - W.step.base;
    Atomics.store(ctrl, 4, Math.round(done / 1024)); Atomics.store(ctrl, 5, rest === null ? 0 : Math.round((done + rest) / 1024));
  } else if (W.step && now - W.lastWait > STEP_PAUSE_MS) { W.step = null; Atomics.store(ctrl, 4, 0); Atomics.store(ctrl, 5, 0); }
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
