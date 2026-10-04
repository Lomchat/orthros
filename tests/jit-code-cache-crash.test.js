// Translated code cache (code-cache.js), review: the file's records survive a session cut short at any write (the
// tab closed mid-append, mid-supersede, mid-eviction or mid-compaction) — the next load either starts over or finds
// only entries whose bodies are exactly what was added for that entry, extent and bytes; compactions moving records
// larger than one move span (MOVE_SPAN) keep every byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeCache, MemStore } from '../src/cpu/jit/code-cache.js';

/** a store whose writes stop at the n-th (the tab closed): every later write, truncate and flush throws */
class CutStore {
  constructor(inner, n) { this.inner = inner; this.n = n; }
  cut() { if (this.n-- <= 0) throw new Error('cut'); }
  size() { return this.inner.size(); }
  read(at, len) { return this.inner.read(at, len); }
  write(at, b) { this.cut(); this.inner.write(at, b); }
  truncate(n) { this.cut(); this.inner.truncate(n); }
  flush() { this.cut(); this.inner.flush(); }
}

test('code cache: a session cut short at any write leaves a file that loads to correct entries or starts over', () => {
  let rs = 4242;
  const r = (n) => { rs = (Math.imul(rs, 1103515245) + 12345) >>> 0; return (rs >>> 8) % n; };
  const u8 = new Uint8Array(0x10000);
  let cuts = 0, restarts = 0, hits = 0, compactCuts = 0;
  for (let trial = 0; trial < 120; trial++) {
    const store = new MemStore(), MAX = 8000 + r(16000);
    const model = new Map(); // key -> Set of bodies ever added for it (a cut add may or may not have landed)
    for (let session = 0; session < 12; session++) {
      const cutAt = r(3) === 0 ? r(60) : Infinity;
      const cs = new CutStore(store, cutAt);
      let c;
      try { c = new CodeCache(cs, 'k', MAX); } catch { cuts++; continue; }
      if (c.stats.reset) { restarts++; model.clear(); }
      try {
        for (let n = 0; n < 30; n++) {
          const eip = 0x100 * (1 + r(16)), shape = r(3), nb = 1 + ((eip >> 8) + shape) % 3, ext = [];
          for (let b = 0, a = eip; b < nb; b++) { const end = a + 1 + ((a + shape) % 6); ext.push({ eip: a, end }); a = end + 1; }
          const prog = r(4) === 0 ? 1 : 0, snap = [];
          for (const b of ext) for (let a = b.eip; a < b.end; a++) { u8[a] = (a * 7 + prog * 13) & 0xff; snap.push(u8[a]); }
          const key = `${eip}|${ext.map((b) => `${b.eip}-${b.end}`).join(',')}|${prog}`;
          const hit = c.lookup(eip, null, ext, Uint8Array.from(snap), [], null, u8);
          if (hit) {
            hits++;
            assert.ok(model.get(key)?.has(hit.code.join(',')), `trial ${trial} session ${session}: a hit is a body added for exactly this`);
            continue;
          }
          const code = Array.from({ length: 40 + r(900) }, () => r(256));
          (model.get(key) ?? model.set(key, new Set()).get(key)).add(code.join(','));
          c.add({ eip, fpcIn: null, blocks: ext.map((b, i) => ({ ...b, index: i })), deps: [], stats: {}, snap: Uint8Array.from(snap), code: Uint8Array.from(code) });
          if (r(6) === 0) c.maintain();
        }
        c.flush();
      } catch (e) {
        assert.equal(e.message, 'cut');
        cuts++;
        if (c.store.inner.size() >= 16 && new DataView(store.read(12, 4).buffer).getUint32(0, true) & 1) compactCuts++;
      }
    }
  }
  assert.ok(cuts > 20 && restarts > 0 && compactCuts > 0 && hits > 200, `cuts ${cuts} (in a compaction ${compactCuts}), restarts ${restarts}, hits ${hits}`);
});

test('code cache: a compaction moving records larger than a move span keeps them byte for byte', () => {
  const store = new MemStore(), MB = 1 << 20, MAX = 24 * MB;
  const body = (eip, n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (eip * 31 + i * 7 + (i >> 11)) & 0xff; return b; };
  const ext = (eip) => [{ eip, end: eip + 4 }], snap = Uint8Array.of(1, 2, 3, 4);
  const entry = (eip, n) => ({ eip, fpcIn: null, blocks: [{ eip, end: eip + 4, index: 0 }], deps: [], stats: {}, snap, code: body(eip, n) });
  const sizes = { 0x1000: 5 * MB, 0x2000: 3 * MB, 0x3000: 2 * MB + 17, 0x4000: 6 * MB, 0x5000: 1 * MB + 3 };
  let c = new CodeCache(store, 'k', MAX);
  for (const [a, n] of Object.entries(sizes)) assert.ok(c.add(entry(+a, n)));
  // session 2 reuses some, session 3 adds past the bound: the others evicted, the kept ones moved over them
  c = new CodeCache(store, 'k', MAX);
  for (const a of [0x2000, 0x4000, 0x5000]) assert.ok(c.lookup(a, null, ext(a), snap, []));
  c = new CodeCache(store, 'k', MAX);
  assert.ok(c.lookup(0x4000, null, ext(0x4000), snap, []));
  assert.ok(c.add(entry(0x6000, 7 * MB)));
  c.maintain();
  assert.ok(c.stats.compactions >= 1 && c.stats.evicted >= 1, `compactions ${c.stats.compactions}, evicted ${c.stats.evicted}`);
  c = new CodeCache(store, 'k', MAX);
  for (const a of [0x4000, 0x6000]) {
    const hit = c.lookup(a, null, ext(a), snap, []);
    assert.ok(hit, `kept ${a.toString(16)}`);
    assert.deepEqual(hit.code, body(a, a === 0x6000 ? 7 * MB : sizes[a]), `${a.toString(16)} byte for byte`);
  }
  assert.ok(store.size() <= MAX);
});
