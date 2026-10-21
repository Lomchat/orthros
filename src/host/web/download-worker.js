// "Download the whole game first" (home screen, docs/slow-network.md): a dedicated worker downloads a game version —
// and the versions it requires (manifest extraMounts) — into the same OPFS block stores the game's worker reads
// (orthros-files-<manifest>), before the game runs. The learned order comes first (what the game needs first), then
// every other block. Stopped and started again (another visit), it resumes: the stored blocks are skipped.
// "Prepare" (the home's card): the version's launch set only (src/vfs/launch-set.js: what earlier sessions read before
// their game was playable, as this link reads it), its pieces as the game's own startup set fetches them; resumed the
// same way (the pieces here are skipped).
// Messages in: { type: 'download' | 'launch', name, bw }, { type: 'stop' }. Out: { type: 'progress', kind ('whole' |
// 'launch'), bytes, total, stored, bw, ratio, running, done, error }, then { type: 'stopped' } once the stores are
// closed (the game's worker may open them).
import { openVersion, openStore, learnedOrder } from '../../vfs/game-data.js';
import { launchSet, setBytes } from '../../vfs/launch-set.js';

let stopping = false, running = false;
const post = (m) => self.postMessage(m);

async function download(name, bw, kind = 'whole') {
  running = true; stopping = false;
  const stores = [];
  let parts = [], net = null, timer = null, launch = null;
  const report = (extra = {}) => {
    let bytes = parts.reduce((a, p) => a + (p.progress.started ? p.progress.bytes : 0), 0), total = parts.reduce((a, p) => a + p.total, 0);
    let stored = parts.reduce((a, p) => a + (p.progress.stored ?? 0), 0);
    // (the launch set: its pieces here now, counted again — those the reader kept, fetched now or before)
    if (launch) { const b = setBytes(launch.files, launch.set); bytes = b.here; total = b.bytes; stored = launch.stored; }
    const s = net?.snapshot();
    post({ type: 'progress', kind, name, bytes, total, stored, bw: s?.bw ?? null, ratio: net ? net.ratio() : 1, received: s ? s.bgBytes + s.demandBytes : 0, running, ...extra });
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
      // (the version's own learned order: the launch set is its — the versions it requires are read on their own order)
      const p = version.parts[0], set = launchSet(p.files, await learnedOrder(p.name), net.fast());
      launch = { files: p.files, set, stored: setBytes(p.files, set).here };
      const progress = { bytes: 0, blocks: 0, done: false };
      timer = setInterval(() => report(), 500);
      if (set.length) await p.files.prefetch(set, progress, () => stopping, { learnedOnly: true });
      else progress.done = true;
      running = false;
      if (!stopping && !progress.done) throw new Error(p.store.failed ? 'the browser storage is full or unavailable' : 'the server stopped answering: try again later');
      report({ done: !stopping && progress.done });
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
  if (m.type === 'stop') { stopping = true; if (!running) post({ type: 'stopped', name: m.name ?? null }); return; }
  if ((m.type === 'download' || m.type === 'launch') && !running) download(String(m.name), Number(m.bw) || undefined, m.type === 'launch' ? 'launch' : 'whole');
};
