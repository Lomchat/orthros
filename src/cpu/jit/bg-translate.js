// Background translation worker: translates guest code regions ahead of their first execution (the regions earlier
// sessions reached, see the page worker's region prewarm) on another thread, over the guest memory it shares with the
// emulator's worker, and sends them back compiled, several per module (Jit.bgInstall installs them).
// The game runs meanwhile and may be writing the very code being read: a region is sent only when its bytes were the
// same before and after its translation (a discovery pass gives its extent, the bytes are copied, the translation
// runs, the bytes are compared again), with that copy — the emulator installs it only if its memory still holds
// those bytes.
import { GuestMemory } from '../memory.js';
import { translateRegion, buildRegionModule, discoverRegion } from './translate.js';
import './translate-x87.js'; // (the translators register their handlers on import, as jit.js does)
import './translate-sse-float.js';
import './translate-sse-int.js';

let mem = null, opts = null;

/** the bytes of the blocks' ranges, concatenated */
function snapshot(blocks) {
  let n = 0; for (const b of blocks) n += b.end - b.eip;
  const out = new Uint8Array(n);
  let o = 0; for (const b of blocks) { out.set(mem.u8.subarray(b.eip, b.end), o); o += b.end - b.eip; }
  return out;
}
const sameBytes = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const sameExtent = (a, b) => a.length === b.length && a.every((x, i) => x.eip === b[i].eip && x.end === b[i].end);

function translateBatch(items) {
  const codes = [], names = [], out = [];
  for (const it of items) {
    const r = { eip: it.eip, fnIdx: it.fnIdx, fpc: it.fpc, k: -1 };
    out.push(r);
    try {
      const o = { ...opts, fnIdx: it.fnIdx, fpcAssume: it.fpc };
      const before = discoverRegion(mem, it.eip, o).blocks.map((b) => ({ eip: b.eip, end: b.end }));
      if (!before.length) continue;
      const snap = snapshot(before);
      const t = translateRegion(mem, it.eip, o);
      if (!sameExtent(before, t.blocks) || !sameBytes(snap, snapshot(t.blocks))) continue; // (the code changed meanwhile)
      r.k = codes.length; r.blocks = t.blocks; r.snap = snap; r.fpc = t.fpcAssume;
      r.stats = { native: t.stats.native, fallback: t.stats.fallback, calls: t.stats.calls };
      codes.push(t.code); names.push('r_' + it.eip.toString(16));
    } catch { /* undecodable: left to the emulator */ }
  }
  return { codes, names, out };
}

/** A message from the emulator's worker; the answer (if any) goes through `reply` (tests call this directly). */
export function handleMessage(m, reply) {
  if (m.type === 'init') { mem = new GuestMemory({ memory: m.memory }); opts = m.opts; return; }
  if (m.type !== 'batch' || !mem) return;
  const t0 = performance.now();
  const { codes, names, out } = translateBatch(m.items);
  let module = null;
  if (codes.length) {
    try { module = new WebAssembly.Module(buildRegionModule(codes, names, mem.memory.buffer instanceof SharedArrayBuffer)); }
    catch { for (const r of out) r.k = -1; }
  }
  reply({ type: 'batch', id: m.id, module, items: out, ms: performance.now() - t0 });
}
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) globalThis.onmessage = (e) => handleMessage(e.data, (r) => globalThis.postMessage(r));
