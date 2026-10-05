// Incremental heat harvest (Jit.harvestVisitsStep) and the linear RangeHeat.merge, checked against copies of the
// algorithms they replaced: a whole harvest pass over every live region, and a merge sorting all ranges again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jit } from '../src/cpu/jit/jit.js';
import { RangeHeat } from '../src/cpu/jit/heat.js';

let seed = 0x5eed1234;
const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };

// ---------------------------------------------------------------- the previous algorithms (reference copies)
/** the previous Jit.harvestVisits over the live regions ({ visits: [[eip, end, flag address], ...] | null }) */
function oldHarvest(u8, regions) {
  const out = [], seen = new Set();
  for (const r of regions) {
    const v = r.visits; if (!v) continue;
    let left = 0;
    for (const e of v) {
      if (e[2] < 0) continue;
      if (u8[e[2]]) { if (!seen.has(e[0])) { seen.add(e[0]); out.push(e[0], e[1]); } e[2] = -1; } else left++;
    }
    if (!left) r.visits = null;
  }
  return out;
}
/** the previous RangeHeat.merge: lo/hi of the merged ranges lo0/hi0 and the added ones */
function oldMerge(lo0, hi0, addLo, addHi) {
  const n = lo0.length + addLo.length, idx = new Array(n), L = new Float64Array(n), H = new Float64Array(n);
  for (let i = 0; i < lo0.length; i++) { L[i] = lo0[i]; H[i] = hi0[i]; }
  for (let i = 0; i < addLo.length; i++) { L[lo0.length + i] = addLo[i]; H[lo0.length + i] = addHi[i]; }
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => L[a] - L[b]);
  const lo = [], hi = [];
  for (const i of idx) {
    if (lo.length && L[i] <= hi[hi.length - 1]) { if (H[i] > hi[hi.length - 1]) hi[hi.length - 1] = H[i]; } else { lo.push(L[i]); hi.push(H[i]); }
  }
  return { lo: Int32Array.from(lo), hi: Int32Array.from(hi) };
}

// ---------------------------------------------------------------- harvest
/**
 * A Jit reduced to what the harvest uses (guest bytes, the regions with visit flags, heatAdd), and a mirror of its
 * regions for the old harvest: add() registers a region in both (as Jit.register), drop() drops it (as Jit.dropOne).
 */
function world() {
  const u8 = new Uint8Array(1 << 15), slots = new Map(); // (one flag per block address, as VisitSlots)
  const jit = Object.create(Jit.prototype);
  jit.mem = { u8 }; jit.visitRegions = []; jit.harvestAt = 0; jit.harvestKept = 0; jit.harvestOut = null; jit.harvestSeen = null;
  jit.added = []; jit.heatAdd = (pairs) => { for (const x of pairs) jit.added.push(x); };
  const regions = [], live = []; let nextId = 1;
  const w = {
    u8, slots, jit, live, regions,
    add() {
      const visits = [], used = new Set(), id = nextId++;
      for (let b = 0, nb = 1 + rnd(12); b < nb; b++) {
        const eip = 0x400000 + 16 * rnd(800); if (used.has(eip)) continue; used.add(eip);
        let a = slots.get(eip); if (a === undefined) { a = 16 + slots.size; slots.set(eip, a); }
        visits.push([eip, eip + id, a]); // (a block's end tells its region: a pair reported twice shows)
      }
      const r = { visits: visits.length ? visits : null, alive: true }, twin = { visits: r.visits && r.visits.map((e) => e.slice()) };
      r.twin = twin; regions.push(r); live.push(twin);
      if (r.visits) jit.visitRegions.push(r);
    },
    drop() {
      const l = regions.filter((r) => r.alive); if (!l.length) return;
      const r = l[rnd(l.length)]; r.alive = false; r.visits = null; live.splice(live.indexOf(r.twin), 1);
    },
    setFlags(n) { for (let i = 0; i < n; i++) u8[16 + rnd(Math.max(1, slots.size))] = 1; },
  };
  return w;
}
const keys = (p) => { const s = []; for (let i = 0; i < p.length; i += 2) s.push(`${p[i]}-${p[i + 1]}`); return s; };
const eipsOf = (p) => { const s = new Set(); for (let i = 0; i < p.length; i += 2) s.add(p[i]); return s; };
const BUDGETS = [0, 1e-6, 0.02, Infinity];

test('harvestVisitsStep: a pass gives exactly the old harvest\'s pairs (budgets 0, tiny, Infinity), the heat gets them', () => {
  for (let t = 0; t < 300; t++) {
    const w = world(), budget = BUDGETS[rnd(BUDGETS.length)];
    for (let i = 0, n = rnd(400); i < n; i++) w.add();
    for (let pass = 0; pass < 4; pass++) {
      w.setFlags(rnd(pass ? 60 : 300));
      if (pass) for (let i = 0, n = rnd(40); i < n; i++) w.add(); // (blocks already reported, translated again)
      let out, steps = 0;
      while (!(out = w.jit.harvestVisitsStep(budget))) steps++;
      if (budget === Infinity) assert.equal(steps, 0);
      const old = oldHarvest(w.u8, w.live);
      assert.deepEqual(keys(out).sort(), keys(old).sort(), `trial ${t} pass ${pass}`);
      assert.deepEqual(w.jit.added.splice(0), out, 'added to the heat');
      // the regions left are those with a flag not set yet, in registration order
      assert.deepEqual(w.jit.visitRegions.map((r) => r.twin), w.live.filter((r) => r.visits));
    }
    for (let a = 16; a < 16 + w.slots.size; a++) w.u8[a] = 1;
    assert.deepEqual(keys(w.jit.harvestVisits()).sort(), keys(oldHarvest(w.u8, w.live)).sort());
    assert.equal(w.jit.visitRegions.length, 0);
    assert.equal(w.jit.harvestVisits().length, 0);
  }
});

test('harvestVisitsStep: flags set and regions registered between steps — each reported once, same blocks as the old harvest', () => {
  for (let t = 0; t < 300; t++) {
    const w = world(), budget = BUDGETS[rnd(3)]; // (budgets that cut passes)
    for (let i = 0, n = 64 + rnd(400); i < n; i++) w.add();
    const got = [], want = [];
    let cut = 0;
    for (let round = 0; round < 40; round++) {
      const k = rnd(3);
      if (k === 0) w.setFlags(1 + rnd(20)); else if (k === 1) w.add();
      const out = w.jit.harvestVisitsStep(budget);
      if (out) { got.push(...keys(out)); want.push(...eipsOf(oldHarvest(w.u8, w.live))); } else cut++;
    }
    let out; while (!(out = w.jit.harvestVisitsStep(budget))); got.push(...keys(out)); want.push(...eipsOf(oldHarvest(w.u8, w.live)));
    out = w.jit.harvestVisits(); got.push(...keys(out)); want.push(...eipsOf(oldHarvest(w.u8, w.live))); // (flags set during the last pass)
    assert.equal(new Set(got).size, got.length, `trial ${t}: a region's block reported twice`);
    assert.deepEqual(new Set(got.map((s) => Number(s.split('-')[0]))), new Set(want), `trial ${t}`);
    for (const s of got) assert.ok(w.u8[w.slots.get(Number(s.split('-')[0]))], 'reported flag set');
    if (budget === 0) assert.ok(cut > 0);
  }
});

test('harvestVisitsStep: regions dropped between steps — their flags not reported after the drop, the others all reported', () => {
  for (let t = 0; t < 300; t++) {
    const w = world(), budget = BUDGETS[rnd(3)];
    for (let i = 0, n = 64 + rnd(400); i < n; i++) w.add();
    const got = [];
    for (let round = 0; round < 40; round++) {
      const k = rnd(4);
      if (k === 0) w.setFlags(1 + rnd(20)); else if (k === 1) w.add(); else if (k === 2) w.drop();
      const out = w.jit.harvestVisitsStep(budget);
      if (out) got.push(...keys(out));
    }
    // (as a real drop: what a dropped region found before its drop was reported; nothing of it after)
    let out; while (!(out = w.jit.harvestVisitsStep(budget))); got.push(...keys(out));
    got.push(...keys(w.jit.harvestVisits()));
    assert.equal(new Set(got).size, got.length, `trial ${t}: reported twice`);
    for (const s of got) assert.ok(w.u8[w.slots.get(Number(s.split('-')[0]))], 'reported flag set');
    // every set flag of a live region was reported (by it or by another region holding the block)
    const eips = new Set(got.map((s) => Number(s.split('-')[0])));
    for (const r of w.regions) if (r.alive) for (const e of r.twin.visits ?? []) if (e[2] >= 0 && w.u8[e[2]]) assert.ok(eips.has(e[0]), `trial ${t}: ${e[0].toString(16)} missed`);
    assert.ok(w.jit.visitRegions.every((r) => r.alive && r.visits));
  }
});

// ---------------------------------------------------------------- merge
test('RangeHeat.merge: lo/hi identical to sorting all ranges (overlapping, nested, adjacent, duplicate, empty ranges)', () => {
  for (let t = 0; t < 2000; t++) {
    const h = new RangeHeat();
    let lo = new Int32Array(0), hi = new Int32Array(0), aLo = [], aHi = [];
    const span = [50, 400, 5000, 0x7ff00000][rnd(4)];
    for (let op = 0, n = 1 + rnd(30); op < n; op++) {
      const k = rnd(10);
      if (k < 6) {
        const pairs = [];
        for (let i = 0, m = t % 10 === 0 && op % 3 === 0 ? rnd(3000) : rnd(25); i < m; i++) { // (and a few new ranges among many: runs copied)
          const a = rnd(span), kind = rnd(6);
          const b = Math.min(0x7fffffff, kind === 0 ? a : kind === 1 ? a - rnd(3) : a + 1 + rnd(kind === 2 ? 3 : kind === 3 ? 64 : 4000)); // (empty, reversed, short, long, nesting)
          pairs.push(a, b);
          if (rnd(5) === 0) pairs.push(b, Math.min(0x7fffffff, b + rnd(9))); // (adjacent)
          if (rnd(7) === 0) pairs.push(a, b); // (duplicate)
        }
        h.addPairs(rnd(2) ? pairs : Int32Array.from(pairs));
        for (let i = 0; i + 1 < pairs.length; i += 2) if (pairs[i + 1] > pairs[i]) { aLo.push(pairs[i]); aHi.push(pairs[i + 1]); }
      } else if (k < 8) {
        h.merge(); ({ lo, hi } = oldMerge(lo, hi, aLo, aHi)); aLo = []; aHi = [];
        assert.deepEqual([...h.lo], [...lo], `trial ${t} lo`); assert.deepEqual([...h.hi], [...hi], `trial ${t} hi`); assert.equal(h.size, lo.length);
      } else {
        ({ lo, hi } = oldMerge(lo, hi, aLo, aHi)); aLo = []; aHi = [];
        for (let q = 0; q < 8; q++) {
          const a = q < 4 && lo.length ? [lo, hi][q & 1][rnd(lo.length)] - (q >> 1) : rnd(span + 10);
          let want = false; for (let i = 0; i < lo.length; i++) if (lo[i] <= a && a < hi[i]) want = true;
          assert.equal(h.has(a), want, `trial ${t} has ${a}`);
        }
      }
    }
    ({ lo, hi } = oldMerge(lo, hi, aLo, aHi));
    assert.deepEqual([...h.pairs()], [...lo].flatMap((x, i) => [x, hi[i]]));
  }
});
