// Translated code kept across sessions (code-cache.js, bg-translate.js): a second session reuses the first one's
// translations (moved to other table indexes) only for code whose extent, bytes and inline-API slots are the same, and
// runs exactly like the reference interpreter — randomized programs (flags across blocks, x87 under several precision
// modes, memory, self-modifying code, faults), whole and time-sliced, with two threads sharing the translations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { translateRegion, patchAltSlot } from '../src/cpu/jit/translate.js';
import { handleMessage } from '../src/cpu/jit/bg-translate.js';
import { CodeCache, MemStore, moduleClosureText, hashText } from '../src/cpu/jit/code-cache.js';

const CODE = 0x20000000, DATA = 0x10000000, CW = DATA + 0x100;
const tick = () => new Promise((r) => setTimeout(r, 0));
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };

// ---- program generator: blocks of flag writers / readers, x87, memory and SMC snippets joined by forward jumps,
// looped by `dec ebp ; jnz CODE`; the first instruction (mov ebx, imm32) is the one the SMC snippet rewrites
const W = () => [[0xd3, 0xe0], [0x01, 0xd0], [0x28, 0xd0], [0x66, 0x39, 0xd0], [0x48], [0x42], [0x11, 0xd0], [0x18, 0xd0], [0xd3, 0xe8], [0x21, 0xd0], [0xf7, 0xd8], [0x0f, 0xaf, 0xc2], [0x89, 0xc1, 0x83, 0xe1, 0x1f]][rnd(13)];
const R = () => { const cc = rnd(16); return [[0x0f, 0x90 + cc, 0xc3, 0x8d, 0x34, 0x73], [0x47], [0x0f, 0x40 + cc, 0xf8], [0x13, 0xf8]][rnd(4)]; };
const X87 = () => [0xdd, 0x05, ...le(DATA + 8), 0xdc, 0x05, ...le(DATA + 16), 0xdc, 0x0d, ...le(DATA + 24), 0xdd, 0x1d, ...le(DATA + 8)]; // x = (x + a) * b
const CWSET = () => [0xd9, 0x2d, ...le(CW + 2 * rnd(3))]; // fldcw: 24, 53 or 64-bit precision
const MEM = () => [[0xa3, ...le(DATA + 32)], [0x01, 0x15, ...le(DATA + 36)]][rnd(2)];
const SMC = () => [0xa3, ...le(CODE + 1)]; // mov [CODE+1], eax: the next iteration's mov ebx, imm32
function gen({ x87 = true, mem = true, smc = true, fault = false } = {}) {
  const nb = 4 + rnd(6), blocks = [];
  for (let i = 0; i < nb; i++) {
    const body = [];
    for (let k = rnd(4); k > 0; k--) {
      const r = rnd(10);
      body.push(...(r < 4 ? W() : r < 7 ? R() : r === 7 && x87 ? (rnd(3) ? X87() : CWSET()) : r === 8 && mem ? MEM() : r === 9 && smc && rnd(3) === 0 ? SMC() : W()));
    }
    blocks.push(body);
  }
  const out = [0xbb, ...le(rnd(1 << 30))], fix = [], start = [];
  for (let i = 0; i < nb; i++) {
    start[i] = out.length; out.push(...blocks[i]);
    const t = rnd(4);
    if (i < nb - 1 && t < 3) { const tgt = i + 1 + rnd(nb - i - 1); if (t === 0) out.push(0xe9); else out.push(0x0f, 0x80 + rnd(16)); fix.push([out.length, tgt]); out.push(0, 0, 0, 0); }
  }
  start[nb] = out.length;
  out.push(0x4d, 0x0f, 0x85, ...le(-(out.length + 7)));
  out.push(...(fault ? [0x0f, 0x0b] : [0xf4])); // (ud2: an invalid opcode fault / hlt)
  for (const [at, tgt] of fix) out.splice(at, 4, ...le(start[tgt] - (at + 4)));
  return Uint8Array.from(out);
}
const V = [0, 1, 0x7f, 0x80, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678];
const val = () => (rnd(3) ? V[rnd(V.length)] : ((rnd(65536) << 16) | rnd(65536)) >>> 0);

function machine({ shared = false, code, regs, bg = null }) {
  const mem = new GuestMemory({ shared });
  const cpu = new CpuState(mem, THREAD_STATES_BASE); cpu.reset();
  mem.fill(CODE, 0x1000, 0xcc); mem.writeBytes(CODE, code);
  mem.writeF64(DATA + 8, 1.25); mem.writeF64(DATA + 16, 0.1); mem.writeF64(DATA + 24, 0.7);
  mem.write16(CW, 0x007f); mem.write16(CW + 2, 0x027f); mem.write16(CW + 4, 0x037f);
  const setRegs = (c, r) => { c.eip = CODE; c.esp = DATA + 0x800; [c.eax, c.ecx, c.edx, c.ebx, , , c.esi, c.edi] = r; c.ebp = 6; c.eflags = F.RESERVED1 | F.IF | (r[8] & 0x8d5); mem.write16(c.base + ST.FPU_CW, 0x027f); };
  setRegs(cpu, regs);
  const interp = new Interp(mem, cpu);
  let jit = null, replies = null;
  if (bg) {
    jit = new Jit(mem, interp, { smc: true, warn: (m) => { throw new Error(m); } });
    jit.cpu = cpu; replies = [];
    for (let i = 0; i < bg.skipFns; i++) jit.reserveFn(); // (another session: other table indexes)
    jit.attachBackground({ postMessage: (m) => handleMessage(m.type === 'init' ? { ...m, cache: bg.cache } : m, (r) => replies.push(r)) });
  }
  return { mem, cpu, interp, jit, replies, setRegs };
}
const state = (c, mem) => [c.eax, c.ecx, c.edx, c.ebx, c.esi, c.edi, c.ebp, c.eflags & 0x8d5, c.eip, ...[0, 4, 8, 12].map((o) => mem.read32(DATA + 32 + o) >>> 0)].map((x) => (x >>> 0).toString(16)).join(' ');
// (the run stops at the final hlt — privileged: never executed — or runs into the final ud2's fault)
const end = (code) => (code[code.length - 1] === 0xf4 ? CODE + code.length - 1 : CODE + code.length + 0x100);

/** reference: the interpreter alone */
function reference(code, regs) {
  const m = machine({ code, regs });
  const r = m.interp.run({ stopAt: end(code), maxInsns: 1e6 });
  return { r, s: state(m.cpu, m.mem) };
}
/** the entries a plain JIT run translated at a miss (what the server would have learned) */
function learnedOf(code, regs) {
  const m = machine({ code, regs });
  const jit = new Jit(m.mem, m.interp, { smc: true }); jit.cpu = m.cpu; jit.learned = [];
  let r, n = 0; do r = jit.run({ stopAt: end(code), maxInsns: 1e6 }); while (r === EXIT.TIMESLICE && ++n < 1e5);
  return jit.learned.map(([eip, fpc]) => [eip, fpc]);
}
/** a session with the background translator and the cache: learned regions installed first, then a (sliced) run */
async function session(code, regs, cache, skipFns, learned, slice) {
  const m = machine({ shared: true, code, regs, bg: { cache, skipFns } });
  await tick();
  if (learned.length) { m.jit.bgPrewarm(learned); await tick(); await tick(); for (const rep of m.replies.splice(0)) if (rep.type === 'batch') m.jit.bgInstall(rep); }
  let r, k = 0;
  do r = m.jit.run({ stopAt: end(code), maxInsns: slice || 1e6 }); while (r === EXIT.TIMESLICE && ++k < 1e6);
  return { r, s: state(m.cpu, m.mem), bg: m.jit.bg, misses: m.jit.stats.misses };
}

test('code cache: a body moved to another table index differs only by its alt slot offset', () => {
  const code = Uint8Array.from([...X87(), 0x48, 0x75, 0xf0 - 19, 0xf4]);
  const m = machine({ code, regs: [1, 2, 3, 4, 0, 0, 5, 6, 0] });
  const a = translateRegion(m.mem, CODE, { chain: true, smc: true, fnIdx: 10, fpcAssume: 0x200 });
  const b = translateRegion(m.mem, CODE, { chain: true, smc: true, fnIdx: 54321, fpcAssume: 0x200 });
  assert.ok(a.altAt > 0 && a.altAt === b.altAt);
  assert.notDeepEqual(a.code, b.code);
  assert.deepEqual([...patchAltSlot(a.code.slice(), a.altAt, 54321)], [...b.code]);
  const g = translateRegion(m.mem, CODE, { chain: true, smc: true, fnIdx: 10, fpcAssume: null });
  assert.equal(g.altAt, -1); // (a generic translation: no alt slot)
});

test('code cache: randomized programs reuse an earlier session translations and match the interpreter', async () => {
  const key = 'test|translator', store = new MemStore();
  let reused = 0, programs = 0, mutatedMisses = 0;
  for (let t = 0; t < 36; t++) {
    const fault = t % 6 === 5;
    const code = gen({ fault }), regs = [val(), rnd(40), val(), 0, val(), val(), 0, 0, rnd(0x1000)];
    const ref = reference(code, regs);
    const learned = learnedOf(code, regs);
    // session 1 fills the cache, session 2 (other table indexes) reuses it; whole and time-sliced runs
    const s1 = await session(code, regs, { key, store }, 0, learned, 0);
    assert.equal(s1.r, ref.r, `program ${t}`); assert.equal(s1.s, ref.s, `program ${t} session 1: ${Buffer.from(code).toString('hex')}`);
    for (const slice of [0, 3, 17]) {
      const s2 = await session(code, regs, { key, store }, 37 + slice, learned, slice);
      assert.equal(s2.r, ref.r, `program ${t} slice ${slice}`);
      assert.equal(s2.s, ref.s, `program ${t} slice ${slice}: ${Buffer.from(code).toString('hex')}`);
      assert.equal(s2.bg.cacheHits, learned.length, 'every learned region reused');
      reused += s2.bg.cacheHits;
    }
    // the same program with another first immediate (bytes differ): the region holding it is not reused
    const mutated = code.slice(); mutated[2] ^= 0x5a;
    const refM = reference(mutated, regs), learnedM = learnedOf(mutated, regs);
    const s3 = await session(mutated, regs, { key, store }, 5, learnedM, 3);
    assert.equal(s3.r, refM.r); assert.equal(s3.s, refM.s, `program ${t} mutated`);
    if (s3.bg.cacheHits < learnedM.length) mutatedMisses++;
    programs++;
  }
  assert.ok(reused >= programs * 3, `reused ${reused}`);
  assert.equal(mutatedMisses, programs, 'the mutated entry region is translated again');
});

test('code cache: two threads run the reused translations, each like the interpreter', async () => {
  const key = 'test|threads', store = new MemStore();
  for (let t = 0; t < 12; t++) {
    const code = gen({ mem: false, smc: false, x87: false });
    const ra = [val(), rnd(40), val(), 0, val(), val(), 0, 0, rnd(0x1000)], rb = [val(), rnd(40), val(), 0, val(), val(), 0, 0, rnd(0x1000)];
    const refA = reference(code, ra), refB = reference(code, rb);
    const learned = learnedOf(code, ra);
    await session(code, ra, { key, store }, 0, learned, 0);
    const m = machine({ shared: true, code, regs: ra, bg: { cache: { key, store }, skipFns: 3 } });
    await tick();
    m.jit.bgPrewarm(learned); await tick(); await tick(); for (const rep of m.replies.splice(0)) if (rep.type === 'batch') m.jit.bgInstall(rep);
    const cpuB = new CpuState(m.mem, THREAD_STATES_BASE + 0x1000); cpuB.reset(); m.setRegs(cpuB, rb);
    const cpus = [m.cpu, cpuB], res = [null, null];
    for (let k = 0; k < 1e5 && (res[0] === null || res[1] === null); k++) {
      const i = k & 1; if (res[i] !== null) continue;
      m.jit.cpu = cpus[i]; m.interp.cpu = cpus[i];
      const r = m.jit.run({ stopAt: end(code), maxInsns: 5 });
      if (r !== EXIT.TIMESLICE) res[i] = r;
    }
    assert.equal(res[0], refA.r); assert.equal(res[1], refB.r);
    assert.equal(state(m.cpu, m.mem).split(' ').slice(0, 9).join(' '), refA.s.split(' ').slice(0, 9).join(' '), `program ${t} thread A`);
    assert.equal(state(cpuB, m.mem).split(' ').slice(0, 9).join(' '), refB.s.split(' ').slice(0, 9).join(' '), `program ${t} thread B`);
  }
});

test('code cache: entries need the same extent, bytes and inline-API slots; another key empties it; a cut tail is dropped', () => {
  const store = new MemStore();
  let c = new CodeCache(store, 'k1');
  const e = { eip: 0x1000, fpcIn: 0x200, fpcOut: 0x200, altAt: -1, blocks: [{ eip: 0x1000, end: 0x1004, index: 0 }], deps: [0x5000, 0x7f000010, 3], stats: { native: 2, fallback: 0, calls: null, counters: -1 }, hints: [3, 1], snap: Uint8Array.of(1, 2, 3, 4), code: Uint8Array.of(9, 9, 9) };
  assert.ok(c.add(e));
  c = new CodeCache(store, 'k1'); // (read back)
  assert.equal(c.stats.loaded, 1);
  const ext = [{ eip: 0x1000, end: 0x1004 }];
  const hit = c.lookup(0x1000, 0x200, ext, Uint8Array.of(1, 2, 3, 4), [0x5000, 0x7f000010, 3]);
  assert.deepEqual([...hit.code], [9, 9, 9]); assert.deepEqual(hit.hints, [3, 1]); assert.equal(hit.fpcOut, 0x200);
  assert.equal(c.lookup(0x1000, null, ext, Uint8Array.of(1, 2, 3, 4), [0x5000, 0x7f000010, 3]), null, 'another x87 mode asked');
  assert.equal(c.lookup(0x1000, 0x200, ext, Uint8Array.of(1, 2, 3, 5), [0x5000, 0x7f000010, 3]), null, 'other bytes');
  assert.equal(c.lookup(0x1000, 0x200, [{ eip: 0x1000, end: 0x1005 }], Uint8Array.of(1, 2, 3, 4, 5), [0x5000, 0x7f000010, 3]), null, 'other extent');
  assert.equal(c.lookup(0x1000, 0x200, ext, Uint8Array.of(1, 2, 3, 4), [0x5000, 0x7f000020, 3]), null, 'the slot holds another thunk');
  // a record cut short (a session ended mid-write): dropped, the file cut back
  const full = store.size();
  assert.ok(c.add({ ...e, eip: 0x2000 }));
  store.truncate(store.size() - 2);
  c = new CodeCache(store, 'k1');
  assert.equal(c.stats.loaded, 1); assert.equal(store.size(), full);
  // another translator: emptied
  c = new CodeCache(store, 'k2');
  assert.equal(c.stats.loaded, 0); assert.ok(c.stats.reset);
  assert.equal(new CodeCache(store, 'k2').stats.loaded, 0);
  // bounded
  const small = new CodeCache(new MemStore(), 'k', 400); // (bounded)
  assert.ok(small.add(e)); assert.ok(!small.add({ ...e, eip: 0x3000, code: new Uint8Array(200) }));
  // full: this session's entries are never evicted (a first session fills it and stops adding); a later session
  // evicts the entries no session used for longest and compacts the file
  const fs2 = new MemStore(), big = { ...e, code: new Uint8Array(300) }, at = (eip) => ({ ...big, eip, blocks: [{ eip, end: eip + 4, index: 0 }] });
  const ext2 = (eip) => [{ eip, end: eip + 4 }], snap = Uint8Array.of(1, 2, 3, 4), deps = [0x5000, 0x7f000010, 3];
  let f = new CodeCache(fs2, 'k', 2000); // (room for 3 records of 516 bytes)
  assert.ok(f.add(at(0x1000)) && f.add(at(0x2000)) && f.add(at(0x3000)));
  assert.ok(!f.add(at(0x4000)), 'first session: its own entries fill it');
  f = new CodeCache(fs2, 'k', 2000); // (session 2: reuses 0x3000)
  assert.equal(f.stats.loaded, 3);
  assert.ok(f.lookup(0x3000, 0x200, ext2(0x3000), snap, deps));
  // (session 3: reuses 0x2000, adds 0x4000: down to 3/4 of the bound, the least recently used first — 0x1000 (session
  // 1), then 0x3000 (session 2) — evicted, 0x2000 (this session's) kept)
  f = new CodeCache(fs2, 'k', 2000);
  assert.ok(f.lookup(0x2000, 0x200, ext2(0x2000), snap, deps));
  assert.ok(f.add(at(0x4000)));
  assert.equal(f.stats.evicted, 2); assert.equal(f.stats.compactions, 1);
  for (const a of [0x1000, 0x3000]) assert.equal(f.lookup(a, 0x200, ext2(a), snap, deps), null, `evicted ${a.toString(16)}`);
  for (const a of [0x2000, 0x4000]) assert.ok(f.lookup(a, 0x200, ext2(a), snap, deps), `kept ${a.toString(16)}`);
  assert.ok(fs2.size() === f.end && f.end === f.headLen + f.live && f.end < 17 + 3 * 516 && f.stats.dead === 0, 'compacted');
  f = new CodeCache(fs2, 'k', 2000); // (read back after the compaction)
  assert.equal(f.stats.loaded, 2); assert.equal(f.stats.dead, 0);
  for (const a of [0x2000, 0x4000]) assert.deepEqual([...f.lookup(a, 0x200, ext2(a), snap, deps).code], [...big.code]);
});

test('code cache: one shape per code (superseded entries), variants for other code, LRU eviction, compaction, interrupted compaction', () => {
  // random sessions over a small file: what a lookup returns is always what was added for exactly that entry, extent,
  // bytes and deps; entries of the same code under another shape are superseded; the file never passes its bound
  let rs = 12345;
  const r = (n) => { rs = (Math.imul(rs, 1103515245) + 12345) >>> 0; return (rs >>> 8) % n; };
  const u8 = new Uint8Array(0x10000);
  const store = new MemStore(), MAX = 24000;
  const model = new Map(); // "eip:fpc|extent|bytes" -> body (what was added last for it)
  let hits = 0, superseded = 0, evicted = 0, compactions = 0, variants = 0;
  for (let session = 0; session < 60; session++) {
    const c = new CodeCache(store, 'k', MAX);
    assert.ok(store.size() <= MAX);
    for (let n = 0; n < 40; n++) {
      // (a region's shape: one of three per address, the heat of the moment)
      const eip = 0x100 * (1 + r(24)), fpc = r(4) ? null : 0x200, shape = r(3), nb = 1 + ((eip >> 8) + shape) % 3, ext = [];
      for (let b = 0, a = eip; b < nb; b++) { const end = a + 1 + ((a + shape) % 6); ext.push({ eip: a, end }); a = end + ((a + b) % 3); }
      // the code there: one of two programs at that address (variants), its bytes in memory now
      const prog = r(5) === 0 ? 1 : 0;
      const snap = [];
      for (const b of ext) for (let a = b.eip; a < b.end; a++) { u8[a] = (a * 7 + prog * 13) & 0xff; snap.push(u8[a]); }
      const key = `${eip}:${fpc}|${ext.map((b) => `${b.eip}-${b.end}`).join(',')}|${prog}`;
      const hit = c.lookup(eip, fpc, ext, Uint8Array.from(snap), [], null, u8);
      if (hit) {
        hits++;
        assert.ok(model.has(key), 'a hit is for an entry added for exactly this');
        assert.deepEqual([...hit.code], model.get(key));
        continue;
      }
      const code = Array.from({ length: 50 + r(400) }, () => r(256));
      const before = c.stats.superseded;
      if (c.add({ eip, fpcIn: fpc, blocks: ext.map((b, i) => ({ ...b, index: i })), deps: [], stats: {}, snap: Uint8Array.from(snap), code: Uint8Array.from(code) })) model.set(key, code);
      if (c.stats.superseded > before) superseded++;
      assert.ok(c.end <= MAX && store.size() === c.end);
      let perKey = 0; for (const [k, l] of c.map) { assert.ok(l.length <= 4, `variants of ${k}`); if (l.length > 1) perKey++; }
      variants = Math.max(variants, perKey);
    }
    evicted += c.stats.evicted; compactions += c.stats.compactions;
    c.flush();
  }
  assert.ok(hits > 100 && superseded > 50 && evicted > 20 && compactions > 3 && variants > 0, `hits ${hits} superseded ${superseded} evicted ${evicted} compactions ${compactions} variants ${variants}`);
  // a compaction cut short (state left in the header): the next load starts over
  const c = new CodeCache(store, 'k', MAX);
  assert.ok(c.stats.loaded > 0);
  c.writeHead(1);
  const d = new CodeCache(store, 'k', MAX);
  assert.equal(d.stats.loaded, 0); assert.match(d.stats.reset, /interrupted/);
});

test('code cache: the key covers the import closure of the translator modules', async () => {
  const files = { 'http://x/src/a.js': "import { b } from './b.js';\nimport './c/d.js';\nexport const a = 1;", 'http://x/src/b.js': "export { e } from '../src/e.js'; // import './nope.js'", 'http://x/src/c/d.js': 'x', 'http://x/src/e.js': 'e' };
  const got = [];
  const parts = await moduleClosureText(['http://x/src/a.js'], async (u) => { got.push(u); if (!(u in files)) throw new Error('missing ' + u); return files[u]; });
  // (a specifier seen in a comment is fetched too: one that does not exist counts as missing, the key stays defined)
  assert.deepEqual(got.sort(), [...Object.keys(files), 'http://x/src/nope.js'].sort());
  const k1 = hashText(parts);
  assert.equal(hashText(await moduleClosureText(['http://x/src/a.js'], async (u) => { if (!(u in files)) throw new Error('missing'); return files[u]; })), k1);
  files['http://x/src/e.js'] = 'e2';
  assert.notEqual(hashText(await moduleClosureText(['http://x/src/a.js'], async (u) => { if (!(u in files)) throw new Error('missing'); return files[u]; })), k1);
});
