// D3DX texture jobs (d3dx9-tex-jobs.js): a random sequence of D3DX loads into texture levels (rectangles aligned or not,
// formats converted, color keys, filters), D3DXFilterTexture, textures created from DDS files, locks that read and write
// a level, draws (a backend binding the texture: Resource.settleJobs) and releases, run with the pixel work on the
// calling thread and by texture helpers (worker threads on the shared guest memory): every lock, draw and the end see
// the same bytes — the game's buffers overwritten right after each call (a job keeps nothing of them). Then helpers that
// never answer: their jobs run on the calling thread, the same bytes. One set of helpers serves every session's memory
// (a page's machines: a launcher and its game have a guest memory each).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { d3dEnv } from './d3d-random.js';
import { registerD3DX9 } from '../src/win32/d3dx9.js';
import { TexJobs } from '../src/win32/d3dx9-tex-jobs.js';
import { FMT } from '../src/win32/d3d8.js';
import { depth } from './depth.js';

const helpers = [];
after(async () => { for (const w of helpers) await w.terminate(); });
const spawnHelper = () => {
  const url = new URL('../src/win32/d3dx9-tex-jobs.js', import.meta.url).href, memUrl = new URL('../src/cpu/memory.js', import.meta.url).href;
  const w = new Worker(`Promise.all([import('${url}'), import('${memUrl}')]).then(([{ texHelper }, { GuestMemory }]) => { const run = texHelper(GuestMemory); require('node:worker_threads').parentPort.on('message', run); });`, { eval: true });
  helpers.push(w); return w;
};

function env(jobs) {
  const E = d3dEnv(null, true), { mem, ctx, com } = E;
  if (jobs) E.vm.host.texJobs = jobs();
  const X = {}; registerD3DX9({ define(dll, d) { Object.assign(X, d); } }, E.vm);
  const out = E.alloc(64), pp = E.alloc(64);
  [320, 240, 22, 1, 0, 0, 1, 0, 1, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
  const d3dPtr = E.defs.Direct3DCreate9[1](ctx([32]));
  assert.equal(com.implAt(d3dPtr).CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
  const devPtr = mem.read32(out), dev = com.implAt(devPtr), stack = E.alloc(256);
  const sctx = (args) => { args.forEach((v, i) => mem.write32(stack + 4 + 4 * i, v >>> 0)); return { sp: stack, proc: E.proc, thread: { id: 1 }, retAddr: 0, arg(i) { return mem.read32(this.sp + 4 + 4 * i) >>> 0; }, out32(i, v) { const a = this.arg(i); if (a) mem.write32(a, v >>> 0); } }; };
  const call = (name, ...args) => X[name][1](sctx(args));
  return { E, mem, ctx, com, call, dev, devPtr, out };
}

/** a DDS file of random levels (DXT1/5 blocks, 16 / 32-bit texels) */
function dds(fmt, w, h, mips, rnd) {
  const bytes = (lw, lh) => fmt === FMT.DXT1 ? Math.max(1, (lw + 3) >> 2) * Math.max(1, (lh + 3) >> 2) * 8 : fmt === FMT.DXT5 ? Math.max(1, (lw + 3) >> 2) * Math.max(1, (lh + 3) >> 2) * 16 : lw * lh * (fmt === FMT.R5G6B5 ? 2 : 4);
  let n = 0; for (let i = 0; i < mips; i++) n += bytes(Math.max(1, w >> i), Math.max(1, h >> i));
  const b = new Uint8Array(128 + n), dv = new DataView(b.buffer);
  b.set([0x44, 0x44, 0x53, 0x20]); dv.setUint32(4, 124, true); dv.setUint32(8, 0x1007 | 0x20000, true); dv.setUint32(12, h, true); dv.setUint32(16, w, true); dv.setUint32(28, mips, true); dv.setUint32(76, 32, true);
  if (fmt === FMT.DXT1 || fmt === FMT.DXT5) { dv.setUint32(80, 4, true); dv.setUint32(84, fmt, true); }
  else if (fmt === FMT.R5G6B5) { dv.setUint32(80, 0x40, true); dv.setUint32(88, 16, true); dv.setUint32(92, 0xf800, true); dv.setUint32(96, 0x7e0, true); dv.setUint32(100, 0x1f, true); }
  else { dv.setUint32(80, 0x41, true); dv.setUint32(88, 32, true); dv.setUint32(92, 0xff0000, true); dv.setUint32(96, 0xff00, true); dv.setUint32(100, 0xff, true); dv.setUint32(104, 0xff000000, true); }
  for (let i = 128; i < b.length; i++) b[i] = rnd(256);
  return b;
}

/** the session: `ops` random operations; returns every byte array the locks, draws and the end read */
function session(seed, jobs) {
  let s = seed; const rnd = (n) => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0; return (s >>> 0) % n; };
  const { E, mem, ctx, com, call, dev, devPtr, out } = env(jobs);
  const seen = [], buf = E.alloc(256 * 256 * 4 + 4096), rect = E.alloc(16), rect2 = E.alloc(16), lr = E.alloc(8);
  const FORMATS = [FMT.DXT1, FMT.DXT5, FMT.R5G6B5, FMT.A8R8G8B8, FMT.A1R5G5B5];
  const make = () => { const w = 16 << rnd(4), h = 16 << rnd(3); assert.equal(dev.CreateTexture(ctx([devPtr, w, h, 0, 0, FORMATS[rnd(FORMATS.length)], 1, out, 0])), 0); return mem.read32(out); };
  const texs = [make(), make(), make()];
  const level = (p, l) => { const t = com.implAt(p); assert.equal(t.GetSurfaceLevel(ctx([p, l, out])), 0); const sp = mem.read32(out); com.release(com.objectAt(sp)); return sp; };
  const all = (p) => com.implAt(p).levels.map((l) => (l.mem ? Array.from(mem.bytes(l.mem, l.bytes)) : null));
  for (let i = 0; i < depth(120, 50); i++) {
    const k = rnd(12), ti = rnd(texs.length), p = texs[ti], t = com.implAt(p);
    if (k < 4) { // D3DXLoadSurfaceFromMemory into a level, from a random source format and rectangle
      const l = rnd(Math.min(2, t.levels.length)), sf = t.levels[l], srcFmt = [FMT.A8R8G8B8, FMT.R5G6B5, FMT.DXT1, FMT.X8R8G8B8][rnd(4)];
      const dxt = srcFmt === FMT.DXT1, align = (v) => (dxt ? v & ~3 : v);
      let sw = Math.max(dxt ? 4 : 1, align(1 + rnd(sf.width))), sh = Math.max(dxt ? 4 : 1, align(1 + rnd(sf.height)));
      const whole = rnd(3) === 0, dl = whole ? 0 : rnd(sf.width), dt = whole ? 0 : rnd(sf.height);
      const dw = whole ? sf.width : 1 + rnd(sf.width - dl), dh = whole ? sf.height : 1 + rnd(sf.height - dt);
      if (rnd(2)) { sw = dw; sh = dh; } // (often the same size: no resize)
      sw = Math.max(dxt ? 4 : 1, align(sw)); sh = Math.max(dxt ? 4 : 1, align(sh));
      const pitch = dxt ? Math.ceil(sw / 4) * 8 + 8 : sw * (srcFmt === FMT.R5G6B5 ? 2 : 4) + 4 * rnd(3);
      for (let j = 0; j < pitch * Math.ceil(sh / (dxt ? 4 : 1)) + 64; j++) mem.write8(buf + j, rnd(256));
      [0, 0, sw, sh].forEach((v, j) => mem.write32(rect + 4 * j, v)); [dl, dt, dl + dw, dt + dh].forEach((v, j) => mem.write32(rect2 + 4 * j, v));
      const r = call('D3DXLoadSurfaceFromMemory', level(p, l), 0, whole && rnd(2) ? 0 : rect2, buf, srcFmt, pitch, 0, rect, [1, 2, 5][rnd(3)], rnd(4) === 0 ? 0xff000000 : 0);
      seen.push(['load', r]);
      mem.fill(buf, 256 * 256 * 4, 0xee); // (the game's buffer, reused at once)
    } else if (k < 6) { // D3DXFilterTexture from level 0 or 1
      seen.push(['filter', call('D3DXFilterTexture', p, 0, rnd(2), rnd(3) === 0 ? 2 : 5)]);
    } else if (k < 7) { // a texture from a DDS file in place of one
      const fmt = FORMATS.slice(0, 4)[rnd(4)], w = 16 << rnd(3), h = 16 << rnd(3), f = dds(fmt, w, h, 1 + rnd(3), rnd);
      mem.writeBytes(buf, f);
      const r = call('D3DXCreateTextureFromFileInMemoryEx', devPtr, buf, f.length, rnd(2) ? 0 : w >> 1, rnd(2) ? 0 : h >> 1, 0, 0, rnd(2) ? 0 : FORMATS[rnd(FORMATS.length)], 1, 5, [2, 5][rnd(2)], rnd(4) === 0 ? 0xff000000 : 0, 0, 0, out);
      seen.push(['create', r]);
      mem.fill(buf, f.length, 0xee);
      if (r === 0) { com.release(com.objectAt(p)); texs[ti] = mem.read32(out); }
    } else if (k < 9) { // a lock: the level read, a few bytes written
      const l = rnd(t.levels.length);
      assert.equal(t.LockRect(ctx([p, l, lr, 0, 0])), 0);
      const sf = t.levels[l], a = mem.read32(lr + 4);
      seen.push(['lock', Array.from(mem.bytes(a, sf.bytes))]);
      for (let j = 0; j < 4; j++) mem.write8(a + rnd(sf.bytes), rnd(256));
      assert.equal(t.UnlockRect(ctx([p, l])), 0);
    } else if (k < 11) { // a draw: the backend binds the texture
      t.settleJobs(); seen.push(['draw', all(p)]);
    } else { com.release(com.objectAt(p)); texs[ti] = make(); seen.push(['release']); }
  }
  for (const p of texs) seen.push(['end', all(p)]);
  return { seen, stats: E.vm.host.texJobs?.stats };
}

test('texture jobs: random sessions see the bytes of the synchronous path (one set of helpers, a guest memory per session)', () => {
  const jobs = new TexJobs(2, spawnHelper); // (several machines of a page — a launcher, its game — share the helpers)
  for (let seed = 1; seed <= depth(6, 3); seed++) {
    const want = session(seed, null).seen;
    const got = session(seed, () => jobs), n0 = got.stats.jobs; got.stats = { ...got.stats };
    assert.ok(n0 > 10, `seed ${seed}: jobs handed out (${n0})`);
    assert.equal(got.seen.length, want.length);
    got.seen.forEach((g, i) => assert.deepEqual(g, want[i], `seed ${seed} step ${i} (${want[i][0]})`));
  }
});

test('texture jobs: helpers that never answer — their jobs run on the calling thread, the same bytes', () => {
  const logs = [];
  const want = session(3, null).seen;
  const got = session(3, () => new TexJobs(2, () => ({ postMessage() {}, terminate() {} }), (m) => logs.push(m), { firstMs: 20, ms: 20 }));
  assert.ok(got.stats.local > 0 && logs.length === 1, `jobs run here (${got.stats.local}), told once`);
  got.seen.forEach((g, i) => assert.deepEqual(g, want[i], `step ${i} (${want[i][0]})`));
});
