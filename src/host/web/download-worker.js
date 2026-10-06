// "Download the whole game first" (home screen, docs/slow-network.md): a dedicated worker downloads a game version —
// and the versions it requires (manifest extraMounts) — into the same OPFS block stores the game's worker reads
// (orthros-files-<manifest>), before the game runs. The learned order comes first (what the game needs first), then
// every other block. Stopped and started again (another visit), it resumes: the stored blocks are skipped.
// Messages in: { type: 'download', name, bw }, { type: 'stop' }. Out: { type: 'progress', bytes, total, stored, bw,
// ratio, running, done, error }, then { type: 'stopped' } once the stores are closed (the game's worker may open them).
import { HttpBackend } from '../../vfs/http-backend.js';
import { OpfsBlockStore } from '../../vfs/opfs-store.js';
import { NetLink } from '../../vfs/net-link.js';

let stopping = false, running = false;
const post = (m) => self.postMessage(m);

/** total bytes of a listing */
function treeBytes(node) {
  let n = 0;
  for (const f of Object.values(node.files ?? {})) n += f.size ?? 0;
  for (const d of Object.values(node.dirs ?? {})) n += treeBytes(d);
  return n;
}

async function download(name, bw) {
  running = true; stopping = false;
  const stores = [];
  let parts = [], net = null, timer = null;
  const report = (extra = {}) => {
    const bytes = parts.reduce((a, p) => a + (p.progress.started ? p.progress.bytes : 0), 0), total = parts.reduce((a, p) => a + p.total, 0);
    const stored = parts.reduce((a, p) => a + (p.progress.stored ?? 0), 0), s = net?.snapshot();
    post({ type: 'progress', name, bytes, total, stored, bw: s?.bw ?? null, ratio: net ? net.ratio() : 1, received: s ? s.bgBytes + s.demandBytes : 0, running, ...extra });
  };
  try {
    const man = await (await fetch(`/api/manifest/${encodeURIComponent(name)}`)).json();
    const names = [name, ...(Array.isArray(man.extraMounts) ? man.extraMounts.map((d) => d.manifest).filter(Boolean) : [])];
    net = new NetLink({ bw });
    for (const n of names) {
      const tree = await (await fetch(`/api/tree/${encodeURIComponent(n)}`)).json();
      const store = await OpfsBlockStore.open('orthros-files-' + n);
      if (!store) throw new Error('this browser cannot keep the game files (storage unavailable, or the game is open in another tab)');
      stores.push(store);
      const order = await fetch(`/api/prefetch/${encodeURIComponent(n)}`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
      const files = new HttpBackend(`/game/${n}/`, tree, { store, encoded: true, net });
      parts.push({ files, store, order: Array.isArray(order) ? order : [], total: treeBytes(tree), progress: { bytes: 0, total: 0, done: false } });
    }
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
  if (m.type === 'download' && !running) download(String(m.name), Number(m.bw) || undefined);
};
