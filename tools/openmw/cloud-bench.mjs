// The OpenMW cloud bridge's cost for a sync (src/ports/openmw/cloud.js; the engine page syncs every 15 s): a profile of
// N saves of M MB in a MEMFS-like file system, uploaded once, then synced again — nothing changed, and the engine's
// settings written again with the same bytes (as its _omw_save_settings does before each sync). Timed from the sync to
// the bridge's answer to the Orthros page's flush (its upload done or skipped), median of runs. Node, no browser.
// Usage: node tools/openmw/cloud-bench.mjs [--cloud <cloud.js>] [--saves 20] [--mb 2] [--runs 9]
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2), arg = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const file = arg('--cloud', new URL('../../src/ports/openmw/cloud.js', import.meta.url).pathname);
const saves = Number(arg('--saves', 20)), mb = Number(arg('--mb', 2)), runs = Number(arg('--runs', 9));
const files = new Map(), times = new Map(); let clock = 1, puts = 0;
const write = (p, b) => { files.set(p, b); times.set(p, clock++); };
for (let i = 0; i < saves; i++) { const b = new Uint8Array(mb << 20); for (let j = 0; j < b.length; j += 64) b[j] = (i * 7 + j) & 255; write(`/userdata/saves/s${i}.omwsave`, b); }
const settings = new TextEncoder().encode('[Video]\nresolution x = 1280\n'.repeat(40));
write('/userdata/config/openmw/settings.cfg', settings);
const FS = {
  syncfs(_p, cb) { cb(null); },
  readdir(root) { const prefix = root + '/'; return ['.', '..', ...new Set([...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split('/')[0]))]; },
  stat(p) { return files.has(p) ? { mode: 1, size: files.get(p).length, mtime: new Date(times.get(p)) } : { mode: 2 }; },
  isDir: (m) => m === 2, isFile: (m) => m === 1, readFile: (p) => files.get(p), writeFile: write, mkdirTree() {}, unlink() {}, rmdir() {},
};
let onMessage = null, answered = null;
const parent = { postMessage: (m) => { if (m.type === 'orthros-flushed') answered?.(m.ok); } };
const window = { parent, addEventListener: (type, f) => { if (type === 'message') onMessage = f; } };
const storage = new Map();
runInNewContext(fs.readFileSync(file, 'utf8'), {
  window, document: {}, crypto: webcrypto, TextEncoder, TextDecoder, Blob, Response, CompressionStream, DecompressionStream, Uint8Array,
  btoa: globalThis.btoa, atob: globalThis.atob, location: { origin: 'https://orthros.test' },
  localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
  fetch: async (_u, o) => { if (o?.method === 'PUT') { puts++; return new Response(JSON.stringify({ hash: 'h' + puts })); } return new Response('{}', { status: 404 }); },
});
window.orthrosCloudInstall(FS, 'game', 'user');
await new Promise((r) => FS.syncfs(true, r));
/** One sync, to the bridge's answer: its milliseconds and whether it was on the account. */
const flush = () => new Promise((resolve) => {
  const t0 = performance.now();
  answered = (ok) => resolve({ ms: performance.now() - t0, ok });
  onMessage({ origin: 'https://orthros.test', source: parent, data: { type: 'orthros-flush' } });
});
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const series = async (before) => { const out = []; for (let i = 0; i < runs; i++) { before?.(); out.push((await flush()).ms); } return out; };
const first = await flush(), putsAfterFirst = puts;
const unchanged = await series();
const rewritten = await series(() => write('/userdata/config/openmw/settings.cfg', settings.slice()));
console.log(JSON.stringify({ cloud: file, saves, mb, runs, firstUploadMs: +first.ms.toFixed(1), unchangedMsMedian: +median(unchanged).toFixed(2),
  settingsRewrittenMsMedian: +median(rewritten).toFixed(2), uploadsAfterFirst: puts - putsAfterFirst }));
