// D3DX texture jobs (docs/api-layer.md "D3DX texture jobs"): the pixel work of D3DX's texture loaders — converting an
// image's levels, generating mip levels, writing RGBA into a surface, D3DXFilterTexture's chains — handed to texture
// helper workers while the game thread goes on. The calls still answer at once with their exact result: every check and
// error stays on the game thread, which also allocates the levels' memory and marks them written before the job is
// handed out; only the bytes come later. The helpers write them straight into the guest's memory (shared), running
// the same functions as the synchronous path (d3dx9-texwork.js): the same bytes.
// Each level a job reads or writes carries the job's fence (Surface.texJob, its texture's too): whatever touches the
// level's memory — a lock, a copy, a draw binding the texture, a release, a snapshot — waits for it first (Surface.mem).
// The jobs of one texture go to one helper, in order. A helper that stops answering: its jobs run again here.
import { fillChainFromImage, blitInto, sourceRgba, filterChain } from './d3dx9-texwork.js';
import { acct, C as ACCT } from '../core/frame-acct.js';

export class TexJobs {
  /**
   * @param {number} helpers number of helper workers
   * @param {() => { postMessage: (m: any) => void, terminate?: () => void }} spawn a helper (a Worker running d3dx9-tex-helper.js)
   * @param {import('../cpu/memory.js').GuestMemory} mem the guest memory (shared)
   * @param {(m: string) => void} [log]
   * @param {{ firstMs?: number, ms?: number }} [timeouts] how long a wait may last (the first job: the helpers loading)
   */
  constructor(helpers, spawn, mem, log = () => {}, timeouts = {}) {
    this.mem = mem; this.log = log; this.timeouts = { firstMs: timeouts.firstMs ?? 15000, ms: timeouts.ms ?? 5000 };
    this.ctl = new Int32Array(new SharedArrayBuffer(4 * Math.max(1, helpers)));
    this.workers = []; this.seq = []; this.pending = []; this.answered = [];
    for (let i = 0; i < helpers; i++) { const w = spawn(); w.postMessage({ init: true, ctl: this.ctl.buffer, memory: mem.memory, index: i }); this.workers.push(w); this.seq.push(0); this.pending.push([]); this.answered.push(false); }
    this.broken = false;
    this.stats = { jobs: 0, waits: 0, waitMs: 0, local: 0 };
  }
  /** the helper of a texture (its jobs in order on one helper) */
  helperOf(id) { return id % this.workers.length; }
  /** Hand a job to helper `h`; returns its fence. (Never once broken: the caller runs the job itself.) */
  submit(h, job) {
    const seq = job.seq = ++this.seq[h];
    const q = this.pending[h], done = Atomics.load(this.ctl, h);
    while (q.length && q[0].seq <= done) q.shift(); // (kept until done: rerun here if the helper stops answering)
    q.push(job);
    this.workers[h].postMessage(job);
    this.stats.jobs++;
    return { h, seq };
  }
  done(f) { return Atomics.load(this.ctl, f.h) >= f.seq; }
  /** Wait for a fence (Atomics.wait: the emulator runs in a worker). */
  wait(f) {
    if (!f || this.done(f)) return;
    const t0 = performance.now(), ap = acct.enter(ACCT.tex); // (frame accounting: waiting for a texture job)
    try {
      for (;;) {
        const v = Atomics.load(this.ctl, f.h);
        if (v >= f.seq) break;
        const limit = this.answered[f.h] ? this.timeouts.ms : this.timeouts.firstMs;
        if (this.broken || performance.now() - t0 > limit) { this.takeOver(limit); return; }
        Atomics.wait(this.ctl, f.h, v, 50);
      }
      this.answered[f.h] = true;
    } finally { this.stats.waits++; this.stats.waitMs += performance.now() - t0; acct.leave(ap); }
  }
  /** every job done (a snapshot, a device reset) */
  settleAll() { for (let h = 0; h < this.workers.length; h++) this.wait({ h, seq: this.seq[h] }); }
  /**
   * Helpers not answering: never used again — their jobs not yet done run here, in order, with the same functions (a job
   * the helper had begun is run again from its inputs).
   */
  takeOver(limit) {
    if (!this.broken) { this.broken = true; this.log(`d3dx texture jobs: helpers did not answer within ${limit} ms, the remaining jobs run on this thread from now on`); for (const w of this.workers) w.terminate?.(); }
    for (let h = 0; h < this.workers.length; h++) {
      const done = Atomics.load(this.ctl, h);
      for (const job of this.pending[h]) if (job.seq > done) { runJob(this.mem, job); this.stats.local++; }
      this.pending[h] = []; Atomics.store(this.ctl, h, this.seq[h]);
    }
  }
}

/** write `data` into a level's memory (at most its bytes) */
const writeLevel = (mem, l, data) => mem.writeBytes(l.mem, data.subarray(0, Math.min(data.length, l.bytes)));

/**
 * Run one job on guest memory `mem`:
 * - image: { im (levels of face 0), fmt, levels, w, h, o } — fillChainFromImage
 * - blit: { dst, dr, src: { fmt, bytes, start, pitch, sr, sw, sh }, filter, colorKey, keep } — the source rectangle's bytes
 *   (a copy, from `start`) as RGBA into dst (blitInto); keep: a shared array receiving the RGBA kept (D3DXFilterTexture's)
 * - filter: { levels (each its kept RGBA, `cache`), src, point } — filterChain
 */
export function runJob(mem, job) {
  if (job.kind === 'image') fillChainFromImage(mem, job.im, 0, job.fmt, job.levels, job.w, job.h, job.o, (i, data) => writeLevel(mem, job.levels[i], data));
  else if (job.kind === 'blit') {
    const s = job.src, copy = s.bytes;
    const rgba = s.rgba ?? sourceRgba({ bytes: (a, n) => copy.subarray(a, a + n) }, s.fmt, -s.start, s.sr, s.pitch, s.sw, s.sh);
    const r = blitInto(mem, job.dst, job.dr, rgba, s.sw, s.sh, job.filter, job.colorKey);
    if (r?.rgba && job.keep) job.keep.set(r.rgba);
  } else if (job.kind === 'filter') filterChain(mem, job.levels, job.src, job.point, (l) => l.cache ?? null, (l, data) => writeLevel(mem, l, data));
}

/**
 * The helper side (d3dx9-tex-helper.js): its first message carries the guest memory and the fence words, then jobs, run
 * in order; each one done is counted in this helper's word (Atomics.notify wakes a waiting game thread).
 */
export function texHelper(GuestMemory) {
  let mem = null, ctl = null, index = 0;
  return (m) => {
    if (m.init) { mem = new GuestMemory({ memory: m.memory }); ctl = new Int32Array(m.ctl); index = m.index; return; }
    try { runJob(mem, m); } catch (e) { console.error(`d3dx texture job ${m.kind} failed: ${e?.stack ?? e}`); } finally { Atomics.store(ctl, index, m.seq); Atomics.notify(ctl, index); }
  };
}
