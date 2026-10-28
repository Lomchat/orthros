// "Download the whole game first" (home screen, docs/slow-network.md): a dedicated worker downloads a game version —
// and the versions it requires (manifest extraMounts) — into the same OPFS block stores the game's worker reads
// (orthros-files-<manifest>), before the game runs. The learned order comes first (what the game needs first), then
// every other block. Stopped and started again (another visit), it resumes: the stored blocks are skipped.
// "Prepare" (the home's card): the launch sets only, the version's and those of the versions it requires
// (src/vfs/launch-set.js: what earlier sessions read before their game was playable, as this link reads it), their
// pieces as the game's own startup set fetches them; resumed the same way (the pieces here are skipped) — the game
// language's own launch set (`lang`) —, and a browser port's engine release first (`engine`: its URLs, /api/manifests
// launch.engineFiles, immutable: into the browser's HTTP cache, where the page's first launch finds them). A version
// whose engine reloads in place (`reloads`: /api/manifests launch.reloads, launch-set.js lightLaunch) is prepared in two
// stages on a fast link: its light launch set — what its game reads before it plays without waiting: 'Ready' once
// here —, then the files themselves of the fast link's set (`upgrade` in the progress: what the game would load again
// sharp), the second stage stopped like the first (Play, another download).
// "Probe" (the home, on its arrival: `probe`): what the stores of the versions played before hold — their launch sets
// and their whole files —, so that the card says "Ready" from the store's contents, not only after a Prepare.
// Messages in: { type: 'download' | 'launch', name, bw, lang?, engine?, reloads? }, { type: 'probe', items: [{ name, lang?,
// engine?, reloads? }], bw }, { type: 'stop' }. Out: { type: 'progress', kind ('whole' | 'launch'), bytes, total, stored,
// engine (of them: the engine's wire bytes), bw, ratio, running, done, error, upgrade? ({ bytes, total }: the second
// stage's) }, { type: 'probed', name, lang, missing?, launch?, whole? }
// (probe), then { type: 'stopped' } once the stores are closed (the game's worker may open them).
// The files a version takes from one it requires go to that version's store (game-data.js openVersion's shared parts,
// learnedOrders): a version prepared or probed counts them there — what another version that reads them stored too —
// and in its own store (what it kept of them before the owners: UnderStore); the owner's store held by another tab's
// game, they are prepared into its own store, as before.
import { openVersion, openData, openStore, openStoreNow, storeExists, storeLocks, learnedOrders, UnderStore } from '../../vfs/game-data.js';
import { launchSet, setBytes, lightLaunch } from '../../vfs/launch-set.js';

let stopping = false, running = false;
/** the engine files' requests in flight (stop aborts them) */
const aborts = new Set();
const post = (m) => self.postMessage(m);

/**
 * An engine file's answer's sizes: { wire (bytes on the wire, 0 when not said), decoded (bytes of its body, 0 when not
 * said) } — a brotli answer says them in X-Orthros-Wire-Length / X-Orthros-Decoded-Length (server.js sendBrotli), its
 * Content-Length (when it has one) being the wire's; a plain one's Content-Length is both.
 */
export function engineSizes(h) {
  const enc = h.get('content-encoding'), len = Number(h.get('content-length')) || 0;
  const wire = Number(h.get('x-orthros-wire-length')) || len;
  return { wire, decoded: Number(h.get('x-orthros-decoded-length')) || (enc ? 0 : wire) };
}
/** `raw` decoded bytes of an engine file as wire bytes: in proportion when both sizes are known, else as they are. */
export const wireOf = (raw, wire, decoded) => (wire && decoded ? Math.min(wire, Math.round(raw * wire / decoded)) : wire ? Math.min(wire, raw) : raw);

/**
 * The engine release's files into the HTTP cache (`progress`: { bytes, total }, their wire bytes as far as known); true
 * once all came, false when stopped.
 */
async function fetchEngine(urls, progress) {
  // (ENGINE_PARTS files at once: one at a time, a release of 17 small files was a round trip each — Half-Life's at
  // 150 ms; the page loads them side by side too)
  let next = 0, failed = null;
  const one = async () => {
    while (next < urls.length && !failed) {
      const url = urls[next++];
      try { if (!(await engineFile(url, progress))) return; } catch (e) { failed ??= e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENGINE_PARTS, urls.length) }, one));
  if (stopping) return false;
  if (failed) throw failed;
  return true;
}
const ENGINE_PARTS = 4;
/** The HTTP cache has the engine file at `url`: no request — "only-if-cached" answers from it or fails. */
const engineCached = (url) => fetch(url, { cache: 'only-if-cached', mode: 'same-origin' }).then((r) => { r.body?.cancel().catch(() => {}); return r.ok; }).catch(() => false);
/** One engine file into the HTTP cache (see fetchEngine): true, false when stopped. */
async function engineFile(url, progress) {
  if (stopping) return false;
  if (await engineCached(url)) return true;
  const ctl = new AbortController(); aborts.add(ctl);
  let counted = 0; // (this file's bytes in progress.bytes: files come side by side)
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok || !r.body) throw new Error(`the engine file ${url} could not be downloaded (${r.status})`);
    const reader = r.body.getReader(), { wire, decoded } = engineSizes(r.headers);
    // (what came, in wire bytes — the unit of the total, /api/manifests launch.engine —: the body comes decoded)
    let raw = 0;
    const count = (n) => { progress.bytes += n - counted; counted = n; };
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      raw += value.length;
      count(wireOf(raw, wire, decoded));
    }
    count(wire || raw);
  } catch (e) {
    if (stopping) return false;
    throw e;
  } finally { aborts.delete(ctl); }
  return true;
}

/** (exported for a harness: tools/prepare-bench.mjs — `hooks.openStore`: the stores, the browser's OPFS ones without it) */
export async function download(name, bw, kind = 'whole', lang = null, engine = null, hooks = {}, reloads = false) {
  running = true; stopping = false;
  const stores = [];
  let parts = [], net = null, timer = null, launch = null, eng = null, upgrade = null;
  const report = (extra = {}) => {
    let bytes = parts.reduce((a, p) => a + (p.progress.started ? p.progress.bytes : 0), 0), total = parts.reduce((a, p) => a + p.total, 0);
    let stored = parts.reduce((a, p) => a + (p.progress.stored ?? 0), 0);
    // (the launch set: its pieces here now, counted again — those the reader kept, fetched now or before)
    if (launch) {
      bytes = 0; total = 0; stored = 0;
      for (const l of launch) { const b = setBytes(l.files, l.set); bytes += b.here; total += b.bytes; stored += l.stored; }
      if (eng) { bytes += eng.bytes; total += eng.total; }
    }
    // (the second stage's: the full files' set, its pieces here — counted apart, 'Ready' said by every report of it)
    if (upgrade) {
      let ub = 0, ut = 0;
      for (const u of upgrade) { const b = setBytes(u.files, u.set); ub += b.here; ut += b.bytes; }
      extra = { done: true, upgrade: { bytes: ub, total: ut }, ...extra };
    }
    const s = net?.snapshot();
    post({ type: 'progress', kind, name, bytes, total, stored, engine: eng?.total ?? 0, bw: s?.bw ?? null, ratio: net ? net.ratio() : 1, received: s ? s.bgBytes + s.demandBytes : 0, running, ...extra });
  };
  try {
    // (the game data every Orthros game reads, src/vfs/game-data.js: the version and those it requires, their stores)
    // (a shared part's — the owner's store — may be held by another tab's game: its files then kept in this version's
    // store, as before the owners — openVersion —, not a failed Prepare)
    const store = async (n, primary, shared) => {
      const st = await (hooks.openStore ?? openStore)(n);
      if (!st && shared) return null;
      if (!st) throw new Error('this browser cannot keep the game files (storage unavailable, or the game is open in another tab)');
      stores.push(st);
      return st;
    };
    const version = await openVersion(name, { bw, store });
    net = version.net;
    if (kind === 'launch') {
      // (every part's launch set: the version's and those of the versions it requires — the game reads them too —, each
      // from its own learned order; the version's first)
      const lists = await learnedOrders(version, lang);
      // (the light set first for an engine that reloads in place, on any link: lightLaunch)
      const light = lightLaunch(net.fast(), reloads), full = net.fast() && reloads;
      launch = version.parts.map((p, i) => {
        const set = launchSet(p.files, lists[i], !light);
        return { p, files: p.files, set, stored: setBytes(p.files, set).here, progress: { bytes: 0, blocks: 0, done: false } };
      });
      // (the engine release first: the page loads it before reading any game file)
      const urls = Array.isArray(engine?.files) ? engine.files.filter((u) => typeof u === 'string' && u.startsWith('/engines/')) : [];
      if (urls.length) eng = { bytes: 0, total: Number(engine.bytes) || 0 };
      timer = setInterval(() => report(), 500);
      if (eng && !(await fetchEngine(urls, eng))) { running = false; report({ done: false }); return; }
      if (eng) eng.bytes = eng.total = Math.max(eng.bytes, eng.total);
      for (const l of launch) {
        if (l.set.length) await l.files.prefetch(l.set, l.progress, () => stopping, { learnedOnly: true });
        else l.progress.done = true;
        if (stopping) break;
        if (!l.progress.done) { running = false; throw new Error(l.p.store.failed ? 'the browser storage is full or unavailable' : 'the server stopped answering: try again later'); }
      }
      if (full && !stopping) {
        // (ready: said at once, then the full files of the fast link's set — what the light copies stand for —, each part's
        // in its order; their end, a stop or a failure leave it ready)
        upgrade = version.parts.map((p, i) => ({ p, files: p.files, set: launchSet(p.files, lists[i], true), progress: { bytes: 0, blocks: 0, done: false } }));
        report();
        for (const u of upgrade) {
          if (u.set.length) await u.files.prefetch(u.set, u.progress, () => stopping, { learnedOnly: true });
          if (stopping || !u.progress.done) break;
        }
        running = false;
        report({ done: true });
        return;
      }
      running = false;
      report({ done: !stopping && launch.every((l) => l.progress.done) });
      return;
    }
    const orders = await learnedOrders(version);
    parts = version.parts.map((p, i) => ({ ...p, order: orders[i], progress: { bytes: 0, total: 0, done: false } }));
    timer = setInterval(() => report(), 500);
    for (const p of parts) {
      p.progress.started = true;
      await p.files.downloadAll(p.progress, () => stopping, { alone: true, order: p.order });
      if (stopping) break;
      if (!p.progress.done) throw new Error(p.store.failed ? 'the browser storage is full or unavailable' : 'the server stopped answering: try again later');
    }
    running = false;
    report({ done: !stopping && parts.every((p) => p.progress.done) });
  } catch (e) {
    running = false;
    report({ error: String(e?.message ?? e) });
  } finally {
    clearInterval(timer);
    for (const s of stores) { try { s.close(); } catch { /* closed */ } }
    post({ type: 'stopped', name });
  }
}

/**
 * The probe's count of a version (its stores' locks held): each part's store opened into `stores` (one only when it
 * exists — `has`: the version's own), its launch set as this link reads it and its whole blocks here: { bytes, here, wb,
 * wt }. A shared part (the files of a version another owns) counts its owner's store and what the stores of the parts
 * reading them kept of them before the owners (UnderStore, as the game reads them) — the owner's store held by another
 * tab's game: those only. Throws when a store cannot be told (unknown, another context holds it).
 */
async function countStores(version, orders, stores, exists, open, has = true, reloads = false) {
  const parts = [], opened = new Map();
  for (const [i, p] of version.parts.entries()) {
    const kept = i === 0 ? has : await exists(p.name);
    if (kept === null && !p.shared) throw new Error('unknown');
    let st = kept ? await open(p.name) : null;
    if (kept && !st && !p.shared) throw new Error('busy'); // (another tab's game holds it: unknown)
    if (st) stores.push(st);
    if (p.shared) {
      const below = version.parts.filter((q) => q.owned?.has(p.name) && opened.get(q.name)).map((q) => opened.get(q.name));
      if (below.length) st = new UnderStore(st, below);
    }
    opened.set(p.name, st);
    parts.push(await openData(p.name, { tree: p.files.tree, store: st, net: version.net })); // (its own files: files.tree)
  }
  // (a version whose engine reloads in place: its light set on every link — a light copy or its file whole, lightLaunch)
  const fast = !lightLaunch(version.net.fast(), reloads);
  let bytes = 0, here = 0, wb = 0, wt = 0;
  for (const [i, p] of parts.entries()) {
    const b = setBytes(p.files, launchSet(p.files, orders[i], fast));
    bytes += b.bytes; here += b.here;
    const w = p.files.storedBytes(); wb += w.bytes; wt += w.total;
  }
  return { bytes, here, wb, wt };
}

/**
 * The home's probe (docs/slow-network.md "The card from the store"): for each item { name, lang, engine } in turn (the
 * resume game first: the page's order), what this browser holds of the version — posted as { type: 'probed', name,
 * lang, launch: { bytes, total, engine, engineFiles, done } | null (no launch set known), whole: { bytes, total, done } },
 * or { missing: true } when its store does not exist, nor that of a version owning files it reads (manifest `owners`:
 * those files are kept there — one played before holds them) (never played, or evicted: nothing here). A store's directory is
 * looked up first (openStore creates it). The network first (manifest, trees, learned orders, the engine's files only if
 * cached), the stores then, opened only to count and closed at once: a stop (Play, Prepare) finds them closed but for
 * that moment — `running` is true only then, so a stop at any other time answers 'stopped' at once —, under the stores'
 * Web Locks taken without waiting (game-data.js storeLocks: a game opening one in this tab or another waits that moment
 * out instead of running without its store; one opening it now leaves the item unknown). Unknown (a store another
 * context holds, an error, OPFS unavailable): nothing posted for the item. The launch set as this link reads it
 * (launchSet: a store filled on a thin link holds light copies — no wait there, the files' pieces to fetch on a fast
 * one; an item's `reloads`, an engine that reloads in place: its light set on every link — a store filled light on a
 * thin link is ready on a fast one too —, lightLaunch). (exported for a test — `hooks`: { openStore (no lock taken: the probe holds it), exists }.)
 */
export async function probe(items, bw, hooks = {}) {
  stopping = false;
  const exists = hooks.exists ?? storeExists, open = hooks.openStore ?? openStoreNow;
  try {
    for (const it of Array.isArray(items) ? items : []) {
      if (stopping) break;
      const name = String(it?.name ?? ''), lang = typeof it?.lang === 'string' && it.lang ? it.lang : null;
      if (!name) continue;
      const has = await exists(name);
      if (has === null || stopping) continue;
      let manifest = null;
      if (!has) {
        // (its own store not here: the stores of the versions owning files it reads may hold them)
        try { manifest = await fetch(`/api/manifest/${encodeURIComponent(name)}`).then((r) => (r.ok ? r.json() : null)); } catch { /* unknown */ }
        if (stopping) break;
        const owners = Array.isArray(manifest?.owners) ? manifest.owners.filter((o) => typeof o === 'string') : [];
        if (!(await Promise.all(owners.map(exists))).some(Boolean)) { post({ type: 'probed', name, lang, missing: true }); continue; }
      }
      const stores = [];
      try {
        // (the network, no store held: the version and those it requires, their learned orders, the engine's files)
        const version = await openVersion(name, { bw, store: null, ...(manifest ? { manifest } : {}) });
        const orders = await learnedOrders(version, lang);
        const urls = Array.isArray(it.engine?.files) ? it.engine.files.filter((u) => typeof u === 'string' && u.startsWith('/engines/')) : [];
        const cached = (await Promise.all(urls.map(engineCached))).filter(Boolean).length;
        const engTotal = urls.length ? Number(it.engine.bytes) || 0 : 0, engHere = urls.length ? Math.round(engTotal * cached / urls.length) : 0;
        if (stopping) break;
        // (the stores, under their locks: opened, counted, closed — a required version's only when it exists, else
        // nothing of it is here)
        running = true;
        const { bytes, here, wb, wt } = await storeLocks(version.parts.map((p) => p.name), async (locked) => {
          if (!locked) throw new Error('busy'); // (a game opening one now: unknown)
          // (closed before the locks go, whatever happens: a game waiting on them opens them next)
          try { return await countStores(version, orders, stores, exists, open, has, it.reloads === true); } finally { for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } } }
        }, { ifAvailable: true });
        const launch = bytes > 0 ? { bytes: here + engHere, total: bytes + engTotal, engine: engTotal, engineFiles: urls, done: here >= bytes && cached === urls.length } : null;
        post({ type: 'probed', name, lang, launch, whole: { bytes: wb, total: wt, done: wt > 0 && wb >= wt } });
      } catch { /* unknown: nothing said */ } finally {
        for (const s of stores) { try { s.close(); } catch { /* closed */ } }
        running = false;
      }
    }
  } finally {
    running = false;
    post({ type: 'stopped', name: null });
  }
}

// (a worker's; imported elsewhere — a test — its helpers only)
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) self.onmessage = (e) => {
  const m = e.data ?? {};
  if (m.type === 'stop') { stopping = true; for (const c of aborts) c.abort(); if (!running) post({ type: 'stopped', name: m.name ?? null }); return; }
  if (m.type === 'probe' && !running) { probe(m.items, Number(m.bw) || undefined); return; }
  if ((m.type === 'download' || m.type === 'launch') && !running) {
    download(String(m.name), Number(m.bw) || undefined, m.type === 'launch' ? 'launch' : 'whole', typeof m.lang === 'string' && m.lang ? m.lang : null, m.engine ?? null, {}, m.reloads === true);
  }
};
