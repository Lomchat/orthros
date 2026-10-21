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

let stopping = false, running = false, abort = null;
const post = (m) => self.postMessage(m);

/**
 * The engine release's files into the HTTP cache (`progress`: { bytes, total }, their wire bytes as far as known); true
 * once all came, false when stopped.
 */
async function fetchEngine(urls, progress) {
  for (const url of urls) {
    if (stopping) return false;
    // (a file the cache has: no request — "only-if-cached" answers from it or fails)
    const cached = await fetch(url, { cache: 'only-if-cached', mode: 'same-origin' }).then((r) => { r.body?.cancel().catch(() => {}); return r.ok; }).catch(() => false);
    if (cached) continue;
    abort = new AbortController();
    const before = progress.bytes;
    try {
      const r = await fetch(url, { signal: abort.signal });
      if (!r.ok || !r.body) throw new Error(`the engine file ${url} could not be downloaded (${r.status})`);
      const wire = Number(r.headers.get('content-length')) || 0, reader = r.body.getReader();
      // (what came, counted against the file's wire bytes when its answer says them: the body comes decoded)
      let raw = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        raw += value.length;
        progress.bytes = before + (wire ? Math.min(wire, raw) : raw);
      }
      progress.bytes = before + (wire || raw);
    } catch (e) {
      if (stopping) return false;
      throw e;
    } finally { abort = null; }
  }
  return true;
}

async function download(name, bw, kind = 'whole', lang = null, engine = null) {
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
      const st = await openStore(n);
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

self.onmessage = (e) => {
  const m = e.data ?? {};
  if (m.type === 'stop') { stopping = true; abort?.abort(); if (!running) post({ type: 'stopped', name: m.name ?? null }); return; }
  if ((m.type === 'download' || m.type === 'launch') && !running) {
    download(String(m.name), Number(m.bw) || undefined, m.type === 'launch' ? 'launch' : 'whole', typeof m.lang === 'string' && m.lang ? m.lang : null, m.engine ?? null);
  }
};
