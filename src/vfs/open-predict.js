// Predicted opens (docs/slow-network.md "Predicted opens"): the files a game is about to open, guessed from the files it
// opens now, fetched several at once — a run of loose files read one after another is a chain of round trips the game
// waits for (Age of the Ring's first boot: ~2 700 .ini files then ~2 300 .bse files, each its own wait of ~60 ms on a
// 50 ms link), which the link could carry side by side. Generic: the tree's paths and the order of the game's opens only.
//
// The guess: a game that opens files of one extension one after another under one folder (or its subfolders) walks
// them in an order — an engine loading every .ini under a folder in the order its enumeration sorted them, every base
// file a list names — and its next opens are the files of that extension near the latest one in the tree's order (the
// paths compared without case, as an enumeration's sorted set of them). Each extension has its run: its folder (the
// common ancestor of its latest opens, at most MAX_UP levels above the latest one's), and the window of the WINDOW files
// that follow the latest one there. A prediction is made only for a run whose opens keep landing in its previous window
// (EVIDENCE of the last HISTORY: shadow hits, nothing fetched to know it), and it carries as many files as its own
// fetched predictions proved right (PREDICT_MIN, plus two per hit among its last HISTORY_HITS opens, PREDICT_MAX at
// most) within a few seconds of the link (PREDICT_SECONDS of the measured rate, PREDICT_SECONDS_THIN on a thin link): a
// run whose predictions miss falls back to PREDICT_MIN files, or none once its opens leave the window. A file of at most
// WHOLE_MAX bytes is fetched whole (one request, its transport unit), a larger one its first HEAD_BYTES.
//
// Not while the learned order follows the game (HttpBackend.learned.tracked: it knows the next reads), nor once switched
// off (?dbg=ORTHROS_PREDICT=0, read at each open: in-session A/B).

/** the files after the latest open of a run looked at (its window: the next opens a walk lands in) */
export const WINDOW = 8;
/** a run whose latest open is older than this (ms) starts again */
const RUN_IDLE_MS = 15000;
/** a run's folder is at most this many levels above its latest open's */
const MAX_UP = 3;
/** opens that landed in their run's previous window, among the last HISTORY, before anything is fetched */
const EVIDENCE = 3, HISTORY = 5;
/** predicted files on their way (or here, not opened yet) per run: PREDICT_MIN + 2 per hit among the last HISTORY_HITS opens */
const PREDICT_MIN = 3, PREDICT_MAX = 32, HISTORY_HITS = 16;
/** the bytes a run's predictions not opened yet may hold: this many seconds of the link (bytes of file), at least MIN_BYTES */
const PREDICT_SECONDS = 2, PREDICT_SECONDS_THIN = 0.75, MIN_BYTES = 256 << 10, UNKNOWN_BYTES = 1 << 20;
/** a prediction not opened within this long (ms), or within this many opens of its run, is a miss */
const EXPIRE_MS = 30000, EXPIRE_OPENS = 24;
/**
 * a right guess saves a round trip, which is worth GAIN times its bytes on the link (the game waits for it; the link
 * otherwise idle between the reads of a serial load); UNKNOWN_*: the link not measured yet
 */
const GAIN = 2, UNKNOWN_BPS = 1 << 20, UNKNOWN_RTT_MS = 50;
/** the chance a small file opened is read whole (see openWhole) */
const OPEN_P = 0.8;
/** a file this small is fetched whole, a larger one its first HEAD_BYTES */
const WHOLE_MAX = 1 << 20, HEAD_BYTES = 64 << 10;
/** a run's folder with more files of its extension than this is not looked at (the whole game's textures) */
const MAX_CANDIDATES = 20000;
/** candidate lists kept (by folder and extension) */
const LISTS_KEPT = 64;
/** files scanned past the latest open for the next predictions, at most */
const SCAN_MAX = 512;
/**
 * a run's last RESULTS predictions (opened or expired): once RESULTS_MIN of them are known and fewer than RESULTS_SHARE
 * were opened, it predicts nothing more until its opens all land in its windows again
 */
const RESULTS = 12, RESULTS_MIN = 4, RESULTS_SHARE = 0.5;
/** the latest opens of a run whose places it walks from (see noteOpen) */
const ANCHORS = 4;

/**
 * Referenced names (see noteBytes): an opened file of at most REF_FILE_MAX bytes names others (a model its textures);
 * a name whose stem (its name without extension, without case) is that of at most REF_STEM_FILES files of the tree
 * refers to them. Such a reference from a file of extension A to a file of extension B is fetched once the game opened,
 * within REF_MATURE_MS, at least REF_SHARE of at least REF_MIN earlier ones of that pair (measured without fetching:
 * REF_PENDING references remembered at most).
 */
const REF_FILE_MAX = 4 << 20, REF_STEM_FILES = 3, REF_MATURE_MS = 60000, REF_MIN = 12, REF_SHARE = 0.5, REF_PENDING = 8192;
/** a name in a file's bytes: a stem of 2-64 name characters, a dot, an extension of 2-4 */
const REF_RE = /([A-Za-z0-9_-]{2,64})\.([A-Za-z][A-Za-z0-9]{1,3})(?![A-Za-z0-9])/g;

/** On unless ?dbg=ORTHROS_PREDICT_REFS=0 (read at each arrival). */
export function predictRefsOn() { const v = globalThis.ORTHROS_PREDICT_REFS; return v === undefined || v === '' || Number(v) !== 0; }

/** On unless ?dbg=ORTHROS_PREDICT=0 (read at each open). */
export function predictOn() { const v = globalThis.ORTHROS_PREDICT; return v === undefined || v === '' || Number(v) !== 0; }

const extOf = (p) => { const s = p.lastIndexOf('/'), d = p.lastIndexOf('.'); return d > s + 1 ? p.slice(d + 1).toLowerCase() : ''; };
const dirOf = (p) => { const s = p.lastIndexOf('/'); return s < 0 ? '' : p.slice(0, s); };
const depth = (d) => (d === '' ? 0 : d.split('/').length);
/** the deepest folder holding both `a` and `b` (tree paths) */
function common(a, b) {
  if (a === b) return a;
  const x = a.split('/'), y = b.split('/'); const out = [];
  for (let i = 0; i < x.length && i < y.length && x[i] === y[i]; i++) out.push(x[i]);
  return out.join('/');
}
/** the sort key of a path: its lower case with Windows separators (an enumeration's sorted set of paths) */
const keyOf = (p) => p.toLowerCase().replace(/\//g, '\\');

export class OpenPredictor {
  /**
   * @param {object} tree the version's tree as the game sees it (game-tree.js)
   * @param {{ fetch: (path: string, end: number) => (true | Promise<boolean>), tracked?: () => boolean, net?: any, now?: () => number }} io
   *   fetch: [0, end) of `path` (a tree path) fetched ahead (HttpBackend.predict) — true when here already, else its
   *   promise; tracked: the learned order follows the game now; net: the NetLink (its measured rate bounds the bytes)
   */
  constructor(tree, io) {
    this.tree = tree; this.io = io;
    this.now = io.now ?? (() => performance.now());
    /** extension -> its run */
    this.runs = new Map();
    /** predictions not opened yet: key -> { t, bytes, run } (insertion order: oldest first) */
    this.issued = new Map();
    /** files opened (keys) */
    this.opened = new Set();
    /** (folder, extension) -> { list: [{ path, key, size }], index: Map(key -> i) } | null */
    this.lists = new Map();
    this.stats = { opens: 0, files: 0, bytes: 0, hits: 0, hitsHere: 0, misses: 0, here: 0, refs: 0, refFiles: 0, refBytes: 0, openFiles: 0, openBytes: 0 };
    /** the files opened: key -> size (see noteBytes) */
    this.sizes = new Map();
    /** references not opened yet: target key -> { pair, t }; pair name -> { made, hit, gone } */
    this.refPending = new Map(); this.pairs = new Map();
    /** the referenced files fetched, as a run of their own (see issued) */
    this.refRun = { n: 0, out: 0, outBytes: 0 };
    /** stem -> [{ path, size }] of the tree, and its extensions (made at the first arrival) */
    this.stems = null; this.exts = null;
  }

  /** The files of extension `ext` under folder `dir` (a tree path), in key order — null when too many. */
  candidates(dir, ext) {
    const k = dir + '\n' + ext;
    if (this.lists.has(k)) { const v = this.lists.get(k); this.lists.delete(k); this.lists.set(k, v); return v; }
    let node = this.tree;
    for (const p of dir ? dir.split('/') : []) { node = node.dirs?.[p]; if (!node) break; }
    let list = [];
    if (node) {
      const walk = (n, prefix) => {
        if (list === null) return;
        for (const [name, f] of Object.entries(n.files ?? {})) if (extOf(name) === ext) { list.push({ path: prefix + name, key: '', size: f.size ?? 0 }); if (list.length > MAX_CANDIDATES) { list = null; return; } }
        for (const [name, d] of Object.entries(n.dirs ?? {})) if (!name.startsWith('.')) walk(d, prefix + name + '/');
      };
      walk(node, dir ? dir + '/' : '');
    }
    let v = null;
    if (list && list.length) {
      for (const e of list) e.key = keyOf(e.path);
      list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      v = { list, index: new Map(list.map((e, i) => [e.key, i])) };
    }
    this.lists.set(k, v);
    if (this.lists.size > LISTS_KEPT) this.lists.delete(this.lists.keys().next().value);
    return v;
  }

  /** bytes of file a run's predictions not opened yet may hold now */
  /**
   * The file bytes a round trip of the link is worth (its rate times its round trip, as file bytes): a guess right with
   * probability p saves the game one round trip, wrong it costs its bytes — worth fetching when
   * (1 - p) × bytes ≤ GAIN × p × rttBytes() (see worth).
   */
  rttBytes() {
    const net = this.io.net, bw = net?.bw || UNKNOWN_BPS, rtt = net?.rtt || UNKNOWN_RTT_MS;
    return bw * rtt / 1000 / (net?.ratio?.() ?? 1);
  }
  /**
   * A file of `size` bytes just opened is fetched whole (?dbg=ORTHROS_PREDICT_OPEN=0: off): at most WHOLE_MAX, worth it
   * at OPEN_P (the share of a load's small files a game reads whole — Age of the Ring's Create-a-Hero load: 582 of
   * its 592 files of more than one piece), never while the learned order follows the game.
   */
  openWhole(size) {
    const v = globalThis.ORTHROS_PREDICT_OPEN;
    if (!(v === undefined || v === '' || Number(v) !== 0)) return false;
    return size > 0 && size <= WHOLE_MAX && this.worth(size, OPEN_P) && !this.io.tracked?.();
  }
  /**
   * The link allows guesses: measured, and not thin (NetLink.thin). On a thin link a guess's bytes are what the game
   * waits for, and a synchronous read of the game's waited behind the guesses on their way: measured at 85 KB/s, the
   * launch stopped at its first archive for 10 minutes with the guesses on, went on with them off.
   */
  linkOk() { const net = this.io.net; return !net || (net.bw !== null && net.bw !== undefined && !net.thin?.()); }
  /** A guess of `bytes` right with probability `p` is worth its bytes on the link (see rttBytes). */
  worth(bytes, p) { return (1 - p) * bytes <= GAIN * p * this.rttBytes(); }
  byteBudget() {
    const net = this.io.net;
    if (!net?.bw) return UNKNOWN_BYTES;
    const s = net.thin?.() ? PREDICT_SECONDS_THIN : PREDICT_SECONDS;
    return Math.max(MIN_BYTES, Math.floor(net.bw * s / (net.ratio?.() ?? 1)));
  }

  /** The predictions older than EXPIRE_MS, or passed by EXPIRE_OPENS opens of their run: misses. */
  expire(now) {
    for (const [k, e] of this.issued) {
      if (now - e.t < EXPIRE_MS && e.run.n - e.n <= EXPIRE_OPENS) continue;
      this.issued.delete(k); e.run.out--; e.run.outBytes -= e.bytes; if (!e.here) this.stats.misses++;
      this.outcome(e.run, false);
    }
    for (const [k, r] of this.refPending) { if (now - r.t < REF_MATURE_MS) break; this.refPending.delete(k); r.pair.gone++; }
  }

  /** A prediction of run `s` was opened (true) or expired (false). */
  outcome(s, hit) { if (!s.res) return; s.res.push(hit); if (s.res.length > RESULTS) s.res.shift(); }
  /** The tree's files by stem, its extensions. */
  indexStems() {
    this.stems = new Map(); this.exts = new Set();
    const walk = (n, prefix) => {
      for (const [name, f] of Object.entries(n.files ?? {})) {
        const d = name.lastIndexOf('.'); if (d <= 0) continue;
        const stem = name.slice(0, d).toLowerCase(); this.exts.add(name.slice(d + 1).toLowerCase());
        let l = this.stems.get(stem); if (!l) this.stems.set(stem, l = []);
        if (l.length <= REF_STEM_FILES) l.push({ path: prefix + name, size: f.size ?? 0 });
      }
      for (const [name, d] of Object.entries(n.dirs ?? {})) if (!name.startsWith('.')) walk(d, prefix + name + '/');
    };
    walk(this.tree, '');
  }

  /**
   * Bytes of `path` (a tree path) arrived from the network at `start`: when the game opened that file (at most
   * REF_FILE_MAX bytes), the names it holds refer to files the game may open next (a model's textures): each new
   * reference counted for its pair of extensions, and fetched when that pair proved right (see REF_SHARE).
   */
  noteBytes(path, start, bytes) {
    if (!predictOn() || !predictRefsOn()) return;
    const key = keyOf(path), size = this.sizes.get(key);
    if (size === undefined || size > REF_FILE_MAX || !bytes?.length) return;
    // (the learned order follows the game: nothing to guess — not even the names' cost, a scan of every file opened)
    const tracked = this.io.tracked?.();
    if (tracked) return;
    if (!this.stems) this.indexStems();
    const now = this.now(), src = extOf(path);
    this.expire(now);
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + 8192)));
    const budget = this.byteBudget(), R = this.refRun;
    REF_RE.lastIndex = 0;
    for (let m; (m = REF_RE.exec(text));) {
      if (!this.exts.has(m[2].toLowerCase())) continue;
      const targets = this.stems.get(m[1].toLowerCase());
      if (!targets || targets.length > REF_STEM_FILES) continue;
      for (const t of targets) {
        const tk = keyOf(t.path);
        if (tk === key || this.sizes.has(tk) || this.refPending.has(tk)) continue;
        const name = src + '>' + extOf(t.path);
        let P = this.pairs.get(name); if (!P) this.pairs.set(name, P = { made: 0, hit: 0, gone: 0 });
        P.made++; this.stats.refs++;
        this.refPending.set(tk, { pair: P, t: now });
        if (this.refPending.size > REF_PENDING) { const [k0, r0] = this.refPending.entries().next().value; this.refPending.delete(k0); r0.pair.gone++; }
        if (P.hit + P.gone < REF_MIN || P.hit < REF_SHARE * (P.hit + P.gone)) continue;
        if (this.issued.has(tk) || R.out >= PREDICT_MAX || R.outBytes >= budget) continue;
        const end = t.size <= WHOLE_MAX ? t.size : HEAD_BYTES;
        if (!(end > 0) || !this.worth(end, P.hit / (P.hit + P.gone))) continue;
        if (!this.linkOk()) continue;
        const r = this.io.fetch(t.path, end);
        if (r === true) continue;
        this.issued.set(tk, { t: now, n: R.n, bytes: end, run: R }); R.out++; R.outBytes += end;
        this.stats.refFiles++; this.stats.refBytes += end;
      }
    }
  }

  /** The game opened `path` (a tree path, a file of `size` bytes): its run noted, its next files fetched when it walks. */
  noteOpen(path, size) {
    if (!predictOn()) return;
    const now = this.now(), key = keyOf(path), ext = extOf(path);
    this.stats.opens++;
    this.expire(now);
    if (this.opened.has(key) && !this.issued.has(key)) return; // (opened again: says nothing new)
    this.opened.add(key); this.sizes.set(key, size);
    const ref = this.refPending.get(key); if (ref) { this.refPending.delete(key); ref.pair.hit++; }
    // (its bytes here already — a guess fetched them before it was opened —: the names they hold, now; see noteBytes)
    if (size <= REF_FILE_MAX && this.io.peek && predictRefsOn() && !this.io.tracked?.()) this.io.peek(path, size, (start, bytes) => this.noteBytes(path, start, bytes));
    // (a small file opened, not here: all of it on its way at once — the game reads it whole, piece after piece, each
    // piece a wait of its own otherwise; see openWhole)
    if (this.openWhole(size) && this.linkOk()) {
      const r = this.io.fetch(path, size);
      if (r !== true) { this.stats.openFiles++; this.stats.openBytes += size; }
    }
    if (!ext) return;
    const issued = this.issued.get(key);
    if (issued) { this.issued.delete(key); issued.run.out--; issued.run.outBytes -= issued.bytes; if (issued.here) this.stats.hitsHere++; else this.stats.hits++; this.outcome(issued.run, true); }
    const dir = dirOf(path);
    let s = this.runs.get(ext);
    // (a run idle long starts again — the same object: its predictions on their way still count in it)
    if (!s) this.runs.set(ext, s = { anc: dir, hist: [], hits: [], res: [], window: null, at: [], list: null, n: 0, out: 0, outBytes: 0, t: now });
    else if (now - s.t > RUN_IDLE_MS) Object.assign(s, { anc: dir, hist: [], hits: [], res: [], window: null, at: [], list: null });
    else { const a = common(s.anc, dir); s.anc = depth(dir) - depth(a) <= MAX_UP && (a !== '' || dir === '') ? a : dir; }
    s.t = now; s.n++;
    // (a hit of this run's own predictions: a file another kind of guess fetched — a referenced name — is not its)
    const own = issued?.run === s;
    s.hist.push(own || !!s.window?.has(key)); if (s.hist.length > HISTORY) s.hist.shift();
    s.hits.push(own); if (s.hits.length > HISTORY_HITS) s.hits.shift();
    const C = this.candidates(s.anc, ext);
    const i = C?.index.get(key);
    if (i === undefined) { s.window = null; s.at = []; return; }
    // (the latest opens' places in the run's list: several walks in turn — a list naming three kinds of files by number
    // interleaves three runs of the tree's order)
    if (s.list !== C) { s.list = C; s.at = []; }
    s.at = s.at.filter((x) => x !== i); s.at.push(i); if (s.at.length > ANCHORS) s.at.shift();
    s.window = new Set();
    for (const a of s.at) for (let k = a + 1, n = 0; k < C.list.length && n < WINDOW; k++) if (!this.opened.has(C.list[k].key)) { s.window.add(C.list[k].key); n++; }
    const shadow = s.hist.filter(Boolean).length;
    if (shadow < EVIDENCE) return;
    // (its predictions missed lately: none until every open of its last HISTORY lands in a window again)
    const proved = s.res.filter(Boolean).length;
    if (s.res.length >= RESULTS_MIN && proved < RESULTS_SHARE * s.res.length) { if (shadow < HISTORY) return; s.res = []; }
    if (this.io.tracked?.() || !this.linkOk()) return;
    const most = Math.min(PREDICT_MAX, PREDICT_MIN + 2 * s.hits.filter(Boolean).length), budget = this.byteBudget();
    // (the chance a guess is right: its predictions' outcomes once RESULTS_MIN are known, else the shadow's share)
    const p = s.res.length >= RESULTS_MIN ? proved / s.res.length : shadow / HISTORY;
    // (from each place in turn, the latest first: the next file of each walk, then the one after…)
    const next = s.at.map((a) => a + 1).reverse();
    for (let n = 0, idle = 0; idle < next.length && n < SCAN_MAX && s.out < most && s.outBytes < budget;) {
      idle = 0;
      for (let j = 0; j < next.length && s.out < most && s.outBytes < budget; j++) {
        let k = next[j];
        while (k < C.list.length && (this.opened.has(C.list[k].key) || this.issued.has(C.list[k].key))) k++;
        if (k >= C.list.length || k - (s.at[s.at.length - 1 - j] ?? 0) > SCAN_MAX) { idle++; continue; }
        next[j] = k + 1; n++;
        const e = C.list[k], end = e.size <= WHOLE_MAX ? e.size : HEAD_BYTES;
        if (!(end > 0) || !this.worth(end, p)) continue;
        const r = this.io.fetch(e.path, end);
        // (here already: nothing fetched — remembered as predicted, not counted on the link)
        if (r === true) { this.stats.here++; this.issued.set(e.key, { t: now, n: s.n, bytes: 0, run: s, here: true }); s.out++; continue; }
        this.issued.set(e.key, { t: now, n: s.n, bytes: end, run: s }); s.out++; s.outBytes += end;
        this.stats.files++; this.stats.bytes += end;
      }
    }
  }
}
