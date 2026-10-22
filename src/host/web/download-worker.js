// "Download the whole game first" (home screen, docs/slow-network.md): a dedicated worker downloads a game version —
// and the versions it requires (manifest extraMounts) — into the same OPFS block stores the game's worker reads
// (orthros-files-<manifest>), before the game runs. The learned order comes first (what the game needs first), then
// every other block. Stopped and started again (another visit), it resumes: the stored blocks are skipped.
// "Prepare" (the home's card): the launch sets only, the version's and those of the versions it requires
// (src/vfs/launch-set.js: what earlier sessions read before their game was playable, as this link reads it), their
// pieces as the game's own startup set fetches them; resumed the same way (the pieces here are skipped) — the game
// language's own launch set (`lang`) —, and a browser port's engine release first (`engine`: its URLs, /api/manifests
// launch.engineFiles, immutable: into the browser's HTTP cache, where the page's first launch finds them).
// Messages in: { type: 'download' | 'launch', name, bw, lang?, engine? }, { type: 'stop' }. Out: { type: 'progress', kind ('whole' |
// 'launch'), bytes, total, stored, engine (of them: the engine's wire bytes), bw, ratio, running, done, error }, then { type: 'stopped' } once the stores are
// closed (the game's worker may open them).
import { openVersion, openStore, learnedOrder } from '../../vfs/game-data.js';
import { launchSet, setBytes } from '../../vfs/launch-set.js';

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
/** One engine file into the HTTP cache (see fetchEngine): true, false when stopped. */
async function engineFile(url, progress) {
  if (stopping) return false;
  // (a file the cache has: no request — "only-if-cached" answers from it or fails)
  const cached = await fetch(url, { cache: 'only-if-cached', mode: 'same-origin' }).then((r) => { r.body?.cancel().catch(() => {}); return r.ok; }).catch(() => false);
  if (cached) return true;
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
export async function download(name, bw, kind = 'whole', lang = null, engine = null, hooks = {}) {
  running = true; stopping = false;
  const stores = [];
  let parts = [], net = null, timer = null, launch = null, eng = null;
  const report = (extra = {}) => {
    let bytes = parts.reduce((a, p) => a + (p.progress.started ? p.progress.bytes : 0), 0), total = parts.reduce((a, p) => a + p.total, 0);
    let stored = parts.reduce((a, p) => a + (p.progress.stored ?? 0), 0);
    // (the launch set: its pieces here now, counted again — those the reader kept, fetched now or before)
    if (launch) {
      bytes = 0; total = 0; stored = 0;
      for (const l of launch) { const b = setBytes(l.files, l.set); bytes += b.here; total += b.bytes; stored += l.stored; }
      if (eng) { bytes += eng.bytes; total += eng.total; }
    }
    const s = net?.snapshot();
    post({ type: 'progress', kind, name, bytes, total, stored, engine: eng?.total ?? 0, bw: s?.bw ?? null, ratio: net ? net.ratio() : 1, received: s ? s.bgBytes + s.demandBytes : 0, running, ...extra });
  };
  try {
    // (the game data every Orthros game reads, src/vfs/game-data.js: the version and those it requires, their stores)
    const store = async (n) => {
      const st = await (hooks.openStore ?? openStore)(n);
      if (!st) throw new Error('this browser cannot keep the game files (storage unavailable, or the game is open in another tab)');
      stores.push(st);
      return st;
    };
    const version = await openVersion(name, { bw, store });
    net = version.net;
    if (kind === 'launch') {
      // (every part's launch set: the version's and those of the versions it requires — the game reads them too —, each
      // from its own learned order; the version's first)
      launch = await Promise.all(version.parts.map(async (p) => {
        const set = launchSet(p.files, await learnedOrder(p.name, lang), net.fast());
        return { p, files: p.files, set, stored: setBytes(p.files, set).here, progress: { bytes: 0, blocks: 0, done: false } };
      }));
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
      running = false;
      report({ done: !stopping && launch.every((l) => l.progress.done) });
      return;
    }
    parts = await Promise.all(version.parts.map(async (p) => ({ ...p, order: await learnedOrder(p.name), progress: { bytes: 0, total: 0, done: false } })));
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

// (a worker's; imported elsewhere — a test — its helpers only)
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) self.onmessage = (e) => {
  const m = e.data ?? {};
  if (m.type === 'stop') { stopping = true; for (const c of aborts) c.abort(); if (!running) post({ type: 'stopped', name: m.name ?? null }); return; }
  if ((m.type === 'download' || m.type === 'launch') && !running) {
    download(String(m.name), Number(m.bw) || undefined, m.type === 'launch' ? 'launch' : 'whole', typeof m.lang === 'string' && m.lang ? m.lang : null, m.engine ?? null);
  }
};
