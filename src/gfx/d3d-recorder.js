// Recording side of the render worker (docs/render-worker.md section 5, D063). In place of the WebGL backend, each
// Direct3D device gets a Recorder as its `gfx`: it records what the backend would read — the device's state changes
// (from the state tables' set hooks, the constant writers, and a comparison of the few other fields at each draw,
// version counters copied as they are), resources by id with their guest memory and dirty rectangles, draws, clears,
// presents — into the command ring (cmd-ring.js) of a RenderLink. The render worker (or ?glworker=inline: the same
// thread) replays them into a device mirror (d3d-mirror.js) that the unchanged backend reads.
//
// The guest memory of resources is read by the render worker later than the draw that uses it, so every write path
// first calls beforeWrite / lockBuffer (fences: wait until no pending command may still read the old contents), and
// memory releases wait the same way (deferFree). A resource's contents are acknowledged by the render worker once
// uploaded (the ack table: the generation of the contents uploaded), after which writes need no wait.
import { OP, CTL, VERSION_FIELDS, CONST_FIELDS, RingWriter, TWO32, ACK_SLOTS } from './cmd-ring.js';
import { copyRectsCpu } from './d3d8-webgl.js';

const READONLY = 0x10, NOOVERWRITE = 0x1000, DISCARD = 0x2000;
/** frames recorded ahead of the frames the render worker has shown */
export const MAX_FRAMES_IN_FLIGHT = 2;
/** a wait for the render worker without any progress on its side for this long: it is considered dead */
export const STALL_MS = 10000;
const NO_RECT = null;
const EMPTY_STATS = { draws: 0, programs: 0, uploads: 0, errors: 0, vaos: 0 };
/** the recorder entry points the recording probe times */
const REC_ENTRIES = ['drawPrimitive', 'drawIndexedPrimitive', 'drawPrimitiveUP', 'drawIndexedPrimitiveUP', 'clear', 'present', 'readbackSurface', 'stretchRect', 'bufferUpdated', 'surfaceDirty', 'surfaceMem', 'beginScene', 'reset', 'setGamma', 'destroyResource'];

/** the recorded resource (texture of a level, else the resource itself) */
const recOf = (r) => (r.owner ?? r).rec;

export class RenderLink {
  /**
   * @param {{ words: Int32Array, ctl?: Int32Array, ack?: Int32Array, replayer?: any, log?: (m: string) => void, onFail?: (reason: string) => void }} o
   * `replayer`: inline mode (the commands replayed on this thread when needed); else `ctl`/`ack` are shared with a render worker.
   */
  constructor(o) {
    this.w = new RingWriter(o.words, (need) => this.waitSpace(need));
    this.ctl = o.ctl ?? null; this.ack = o.ack ?? null; this.replayer = o.replayer ?? null;
    this.log = o.log ?? (() => {}); this.onFail = o.onFail ?? null; this.stallMs = o.stallMs ?? STALL_MS;
    this.gen = 0; this.frames = 0; this.tickets = 0;
    this.freeSlots = []; this.nextSlot = 0;
    this.lastWorkEnd = 0; // ring position after the last command that may read bound resources (draws, clears...)
    this.deferred = []; // memory releases waiting for the render worker: [addr, position] pairs
    this.recorders = new Set(); this.curDev = -1; this.nextDeviceId = 1; this.nextObjId = 1;
    this.proc = null; this.failed = false;
    this.published = 0; this.notifiedAt = 0; this.drawsSinceNotify = 0;
    this.stats = { gpuWaitMs: 0, waits: 0, fenceWaits: 0, fenceMs: 0, frameWaits: 0, frameMs: 0, readbackMs: 0, readbacks: 0, ringWaits: 0, renames: 0, deferredFrees: 0 };
  }
  /** words the render worker has consumed (its 32-bit counter widened against what was produced) */
  consumedNow() {
    const w = this.w;
    if (this.replayer) return (w.consumed = this.replayer.reader.consumed);
    const tail = Atomics.load(this.ctl, CTL.TAIL) >>> 0, lo = w.produced % TWO32;
    return (w.consumed = w.produced - ((lo - tail + TWO32) % TWO32));
  }
  /** make the commands recorded so far visible; `urgent`: wake the render worker (inline: replay them now) */
  publish(urgent = false) {
    if (this.failed) return;
    const w = this.w;
    if (this.replayer) { if (urgent) this.drain(w.produced); return; }
    if (this.published !== w.produced) { this.published = w.produced; Atomics.store(this.ctl, CTL.HEAD, w.produced % TWO32 | 0); }
    if ((urgent || this.drawsSinceNotify >= 32 || w.produced - this.notifiedAt > 16384) && this.notifiedAt !== w.produced && Atomics.load(this.ctl, CTL.SLEEP)) { this.notifiedAt = w.produced; this.drawsSinceNotify = 0; Atomics.notify(this.ctl, CTL.HEAD); }
    if (this.deferred.length) this.releaseDeferred();
  }
  /** inline: replay up to `pos` on this thread */
  drain(pos) {
    const r = this.replayer;
    if (r.reader.consumed < pos) { const t0 = performance.now(); r.run(this.w.produced); this.replayMs = (this.replayMs ?? 0) + performance.now() - t0; }
    this.w.consumed = r.reader.consumed;
  }
  /** wait until `cond()` (re-checked as the render worker advances `word`), counting the time; false if the worker failed */
  waitFor(cond, word, kind) {
    if (cond()) return true;
    if (this.failed) return false;
    const t0 = performance.now();
    this.publish(true);
    if (this.replayer) { this.drain(this.w.produced); this.account(kind, t0); return cond(); }
    const ctl = this.ctl;
    Atomics.store(ctl, CTL.EMU_WAIT, 1);
    let beat = Atomics.load(ctl, CTL.HEARTBEAT), tail = Atomics.load(ctl, CTL.TAIL), still = t0;
    while (!cond()) {
      Atomics.notify(ctl, CTL.HEAD);
      Atomics.wait(ctl, word, Atomics.load(ctl, word), 20);
      const b = Atomics.load(ctl, CTL.HEARTBEAT), t = Atomics.load(ctl, CTL.TAIL), now = performance.now();
      if (b !== beat || t !== tail) { beat = b; tail = t; still = now; }
      // (no progress, or never the answer)
      if (now - still > this.stallMs || now - t0 > 3 * this.stallMs || Atomics.load(ctl, CTL.READY) < 0) { Atomics.store(ctl, CTL.EMU_WAIT, 0); this.fail(`render worker stalled for ${((now - still) / 1000).toFixed(1)} s waiting for ${kind}`); this.account(kind, t0); return false; }
      if (this.failed) break;
    }
    Atomics.store(ctl, CTL.EMU_WAIT, 0);
    this.account(kind, t0);
    return !this.failed;
  }
  account(kind, t0) {
    const ms = performance.now() - t0, s = this.stats;
    s.gpuWaitMs += ms; s.waits++;
    if (kind === 'fence') { s.fenceWaits++; s.fenceMs += ms; } else if (kind === 'frame') { s.frameWaits++; s.frameMs += ms; } else if (kind === 'readback') s.readbackMs += ms; else if (kind === 'ring') s.ringWaits++;
  }
  waitConsumed(pos, kind) { return this.waitFor(() => this.consumedNow() >= pos, CTL.TAIL, kind); }
  /** the ring is full: wait until the render worker has consumed enough (`need`: produced count wanted) */
  waitSpace(need) {
    const size = this.w.size;
    if (this.replayer) { this.drain(this.w.produced); return; }
    if (!this.waitConsumed(need - size, 'ring')) throw new Error('render worker gone while the command ring was full');
  }
  fail(reason) {
    if (this.failed) return;
    this.failed = true;
    this.w.waitSpace = () => { this.w.consumed = this.w.produced; }; // (nobody reads the ring any more: whatever is still recorded is dropped)
    this.log(`render worker: ${reason}; rendering goes on in this thread`);
    for (let i = 0; i < this.deferred.length; i += 2) this.proc?.vmem.release(this.deferred[i]);
    this.deferred.length = 0;
    this.onFail?.(reason);
  }
  // ---------------------------------------------------------------- resources: ids, fences, memory
  slot() { return this.freeSlots.length ? this.freeSlots.pop() : this.nextSlot < ACK_SLOTS ? this.nextSlot++ : -1; }
  newRec(r, slotted) { const gen = ++this.gen; return (r.rec = { id: r.id, slot: slotted ? this.slot() : -1, gen, gen0: gen, lastRef: 0, refFloor: 0, binds: 0, destroyed: false, pool: null }); }
  /** latest ring position of a command that may read the resource's guest memory */
  lastRefOf(rr) { return rr.binds > 0 && this.lastWorkEnd > rr.lastRef ? this.lastWorkEnd : rr.lastRef; }
  /** may a command not yet replayed still read the resource's guest memory? */
  mayRead(rr) {
    const e = this.lastRefOf(rr);
    if (e <= rr.refFloor || e <= this.w.consumed) return false;
    if (e <= this.consumedNow()) return false;
    return !(rr.slot >= 0 && this.ack !== null && this.ack[rr.slot] === (rr.gen | 0));
  }
  /** before the guest writes a resource's memory: wait while a pending command may read the old contents */
  fence(rr) {
    if (!rr || this.failed || rr.destroyed || !this.mayRead(rr)) return;
    this.waitConsumed(this.lastRefOf(rr), 'fence');
  }
  bind(rr) { if (rr) rr.binds++; }
  unbind(rr) { if (rr) { rr.binds--; if (this.lastWorkEnd > rr.lastRef) rr.lastRef = this.lastWorkEnd; } }
  ref(rr) { if (rr) rr.lastRef = this.w.produced; }
  /** A buffer locked for writing (Buffer.Lock): wait, or with DISCARD give it other memory (its old block retired). */
  lockBuffer(b, flags, off = 0, size = 0) {
    const rr = b.rec;
    if ((flags & READONLY) || !rr || this.failed || !this.mayRead(rr)) return;
    // NOOVERWRITE: the application does not write data pending draws use — but a pending upload may take more than
    // what the draws use: the whole buffer at its first upload (as after a context loss), and the union of the
    // ranges written since its last upload: waited for when the locked range meets them
    if ((flags & NOOVERWRITE) && rr.slot >= 0 && this.ack !== null && this.ack[rr.slot] - rr.gen0 >= 0 && !this.pendingOverlap(rr, off, size ? off + size : b.length)) return;
    if (!(flags & DISCARD)) { this.waitConsumed(this.lastRefOf(rr), 'fence'); return; }
    const pool = rr.pool ??= [], consumed = this.consumedNow();
    let addr = 0;
    for (let i = 0; i < pool.length; i++) if (pool[i].pos <= consumed) { addr = pool[i].addr; pool.splice(i, 1); break; }
    if (!addr && pool.length < 3) addr = b.dev.proc.vmem.alloc(Math.max(b.length, 16), 4, 'd3d8:renamed') >>> 0;
    if (!addr) { let k = 0; for (let i = 1; i < pool.length; i++) if (pool[i].pos < pool[k].pos) k = i; if (!this.waitConsumed(pool[k].pos, 'fence')) return; addr = pool[k].addr; pool.splice(k, 1); }
    // (the new memory starts with the buffer's contents: what the application did not rewrite reads as before —
    // undefined after DISCARD in Direct3D, the old contents in the in-thread path; kept exact)
    b.dev.proc.mem.copy(addr, b.mem, b.length);
    pool.push({ addr: b.mem, pos: this.lastRefOf(rr) });
    b.mem = addr; rr.refFloor = this.w.produced; this.stats.renames++; this.stats.renameBytes = (this.stats.renameBytes ?? 0) + b.length;
  }
  /** do the ranges written but not yet uploaded (generations past the acknowledged one) meet [lo, hi)? */
  pendingOverlap(rr, lo, hi) {
    const p = rr.pend; if (!p) return false;
    const acked = this.ack[rr.slot];
    let j = 0, hit = false;
    for (let i = 0; i < p.length; i += 3) { if (p[i] - acked <= 0) continue; p[j++] = p[i]; p[j++] = p[i + 1]; p[j++] = p[i + 2]; if (p[i + 1] < hi && lo < p[i + 2]) hit = true; }
    p.length = j;
    return hit;
  }
  /** A resource's memory released: later if a pending command may still read it (true: the release is taken care of). */
  deferFree(rr, addr) {
    if (!rr || this.failed) return false;
    let deferred = false;
    if (rr.pool) { for (const p of rr.pool) this.deferred.push(p.addr, p.pos); rr.pool = null; deferred = true; }
    if (this.mayRead(rr)) { this.deferred.push(addr, this.lastRefOf(rr)); this.stats.deferredFrees++; return true; }
    if (deferred) { this.proc?.vmem.release(addr); return true; }
    return false;
  }
  releaseDeferred() {
    const c = this.consumedNow(), d = this.deferred;
    let j = 0;
    for (let i = 0; i < d.length; i += 2) { if (d[i + 1] <= c) this.proc?.vmem.release(d[i]); else { d[j++] = d[i]; d[j++] = d[i + 1]; } }
    d.length = j;
  }
  /**
   * Recording cost probe (ORTHROS_REC_TIME=<frames>, a worker debug global: harness dbg:): the recorders' entry points
   * (draws, clears, presents, readbacks, blits, dirty records, with the state sync they run) timed over that many
   * frames, the waits for the render worker taken out; one report logged. The state-table and constant hooks run
   * inside the Direct3D setters and are not counted (tools/render-record-bench.mjs measures everything).
   */
  recTimeStep() {
    const T = this.recTime;
    if (T) {
      if (--T.left > 0) return;
      for (const r of T.wrapped) for (const k of REC_ENTRIES) delete r[k];
      this.recTime = null;
      const F = T.frames, ms = T.ms - (this.stats.gpuWaitMs - T.wait0) - T.n * T.overhead / 1000;
      this.log(`render record: ${(ms / F).toFixed(3)} ms per frame over ${F} frames (${T.n} entry calls, ${(T.n / F).toFixed(0)} per frame, timer ${T.overhead.toFixed(3)} us each taken out; waits ${(this.stats.gpuWaitMs - T.wait0).toFixed(0)} ms excluded); commands ${((this.w.produced - T.words0) * 4 / F / 1024).toFixed(0)} KiB per frame`);
      return;
    }
    const want = globalThis.ORTHROS_REC_TIME; if (!want) return;
    globalThis.ORTHROS_REC_TIME = undefined;
    const now = performance.now.bind(performance);
    const t = { ms: 0, n: 0, depth: 0, left: Number(want) || 60, frames: Number(want) || 60, wait0: this.stats.gpuWaitMs, words0: this.w.produced, wrapped: [...this.recorders] };
    { let x = 0; const c0 = now(); for (let i = 0; i < 20000; i++) { const a = now(); x += now() - a; } t.overhead = (now() - c0) * 1000 / 20000; void x; } // (a timed empty span)
    for (const r of t.wrapped) for (const k of REC_ENTRIES) {
      const f = Recorder.prototype[k];
      r[k] = function () { if (t.depth++) { try { return f.apply(this, arguments); } finally { t.depth--; } } const t0 = now(); try { return f.apply(this, arguments); } finally { t.depth--; t.ms += now() - t0; t.n++; } };
    }
    this.recTime = t;
    this.log(`render record: timing the recording over ${t.frames} frames`);
  }
  /** the statistics of a device's backend (inline: the backend itself; render worker: its last report) */
  statsFor(id) { return (this.replayer ? this.replayer.devices.get(id)?.gfx?.stats : this.remoteStats?.get(id)) ?? EMPTY_STATS; }
  /** the display's size changed (the canvas frames are presented on) */
  canvas(w, h) { if (!this.failed) this.w.put(OP.CANVAS, w, h); }
}

/** The `gfx` of one Direct3D device: records its work into a RenderLink (see the file comment). */
export class Recorder {
  constructor(link, dev) {
    this.link = link; this.dev = dev; this.w = link.w; this.id = link.nextDeviceId++;
    link.recorders.add(this); link.proc ??= dev.proc;
    this.mem = dev.proc.mem;
    this.dirtyT = []; this.dirtyK = []; this.nDirty = 0; // state table sets since the last flush (table, key): a count, not the arrays' length (shrinking an array costs)
    this.texHook = 0; this.streamHook = 0; this.shaderHook = false; this.xfDirty = []; this.nXf = 0;
    this.fbos = new Set(); // surfaces the backend holds a framebuffer for (its `fbos` keys): StretchRect's GPU path
    this.s = { api9: !!dev.api9, rs: null, tss: null, samplers: null, pp: null, bb: null, rt: undefined, rtRes: null, vp: null, sc: undefined, fvf: undefined, decl: undefined, vs: undefined, ps: undefined, vs8: undefined, vs8o: undefined, ps8: undefined, ps8o: undefined,
      texArr: null, tex: [], texRes: [], streamsArr: null, sVb: [], sStride: [], sOff: [], sRes: [], indices: null, ib: undefined, ibase: undefined, ibRes: null,
      versions: new Array(VERSION_FIELDS.length).fill(NaN), xf: null, xfSlots: null, xfVer: NaN, lights: null, lightVer: NaN, lightSize: -1, lightShadow: new Map(), enabled: [], enabledSet: null, material: null,
      consts: CONST_FIELDS.map(() => null), cWords: CONST_FIELDS.map(() => null), cLo: new Array(6).fill(Infinity), cHi: new Array(6).fill(-1) };
    link.curDev = this.id;
    const pp = dev.pp;
    this.w.put(OP.DEVICE, this.id, dev.api9 ? 1 : 0, pp.width >>> 0, pp.height >>> 0, pp.swap >>> 0);
  }
  /** the backend's statistics (render worker: its last report) */
  get stats() { return this.link.statsFor(this.id); }
  sel() { const L = this.link; if (L.curDev !== this.id) { L.curDev = this.id; this.w.c1(OP.SELECT, this.id); } }
  // ---------------------------------------------------------------- hooks from the Direct3D layer
  noteSet(t, k) {
    if (k < t.v.length) { if (t.recMark[k]) return; t.recMark[k] = 1; }
    const n = this.nDirty++; this.dirtyT[n] = t; this.dirtyK[n] = k;
  }
  setTexture(st) { this.texHook |= 1 << st; }
  setStreamSource(n) { this.streamHook |= 1 << n; }
  setIndices() { this.s.ib = NaN; }
  createVertexShader() { this.shaderHook = true; }
  createPixelShader() { this.shaderHook = true; }
  deleteVertexShader(sh) { this.shaderHook = true; this.deleteShader(sh); }
  deletePixelShader(sh) { this.shaderHook = true; this.deleteShader(sh); }
  deleteShader(sh) { if (sh.recId && !this.link.failed) { this.sel(); this.w.c1(OP.SHADER_DELETE, sh.recId); sh.recId = 0; } }
  constTouched(k, lo, hi) { const s = this.s; if (lo < s.cLo[k]) s.cLo[k] = lo; if (hi > s.cHi[k]) s.cHi[k] = hi; }
  surfaceDirty(sf, rect) {
    const rr = recOf(sf); if (!rr || rr.destroyed || this.link.failed) return;
    const gen = rr.gen = ++this.link.gen;
    if (rect) { const p = this.w.begin(OP.SURF_DIRTY, 7), I = this.w.I; I[p] = sf.id; I[p + 1] = gen; I[p + 2] = 4; I[p + 3] = rect[0]; I[p + 4] = rect[1]; I[p + 5] = rect[2]; I[p + 6] = rect[3]; }
    else this.w.put(OP.SURF_DIRTY, sf.id, gen, NO_RECT);
  }
  surfaceMem(sf) { const rr = recOf(sf); if (rr && !rr.destroyed && !this.link.failed && sf !== this.readbackOf) this.w.c2(OP.SURF_MEM, sf.id, sf.mem); }
  volumeMem(t, i) { if (t.rec && !t.rec.destroyed && !this.link.failed) this.w.c3(OP.VOL_MEM, t.id, i, t.levels[i].mem); }
  volumeUpdated(t, i) { this.volumeMem(t, i); }
  bufferUpdated(b, start = 0, size = b.length) {
    const rr = b.rec; if (!rr || rr.destroyed || this.link.failed) return;
    rr.gen = ++this.link.gen;
    // (the ranges not yet uploaded, for lockBuffer: past 16 of them the two oldest merge — a wider range, never a lost one)
    const pend = rr.pend ??= [];
    if (pend.length >= 48) { pend[3] = Math.max(pend[0], pend[3]); pend[4] = Math.min(pend[1], pend[4]); pend[5] = Math.max(pend[2], pend[5]); pend.splice(0, 3); }
    pend.push(rr.gen, start, start + size);
    this.sel();
    const p = this.w.begin(OP.BUF_DIRTY, 5), I = this.w.I; I[p] = b.id; I[p + 1] = rr.gen; I[p + 2] = start; I[p + 3] = size; I[p + 4] = b.mem;
  }
  beforeWrite(r) { this.link.fence(r.rec); }
  lockBuffer(b, flags) { this.link.lockBuffer(b, flags); }
  deferFree(r, addr) { return this.link.deferFree(r.rec, addr); }
  createTexture() {} createBuffer() {} createSurface() {} surfaceUpdated() {}
  setTransform() {} setViewport() {} setMaterial() {} setLight() {} lightEnable() {} setClipPlane() {} setRenderState() {} setTextureStageState() {} setSamplerState() {}
  setVertexShader() {} setVertexShaderConstant() {} setPixelShader() {} setPixelShaderConstant() {} setRenderTarget() {} setCursor() {} endScene() {}
  // ---------------------------------------------------------------- resources by id
  ensureRes(r) {
    if (!r) return 0;
    const o = r.owner ?? r;
    if (o.rec) return r.id;
    const L = this.link, W = this.w;
    if (o.levels || o.faces) { // textures: their levels (with ids) and memory
      const kind = o.faces ? 2 : o.depth ? 3 : 1, rr = L.newRec(o, true);
      const list = o.faces ? o.faces.flat() : o.levels, lv = new Array(list.length * 5);
      for (let i = 0; i < list.length; i++) { const l = list[i]; lv[5 * i] = l.id ?? 0; lv[5 * i + 1] = l.width; lv[5 * i + 2] = l.height; lv[5 * i + 3] = l.depth ?? 1; lv[5 * i + 4] = l.mem; }
      W.put(OP.TEX, o.id, kind, o.fmt, o.width, o.height, o.depth ?? 1, o.usage, o.pool, rr.slot >>> 0, rr.gen, lv);
    } else if (o.length !== undefined) { // buffers
      const rr = L.newRec(o, true);
      W.put(OP.BUF, o.id, o.type, o.length, o.usage, o.fmt, o.mem, rr.slot >>> 0, rr.gen);
    } else { // standalone surfaces (render targets, back buffers, depth, offscreen): never read by the render worker
      L.newRec(o, false);
      W.put(OP.SURF, o.id, o.fmt, o.width, o.height, o.usage, o.pool, o.mem, o.lockable ? 1 : 0);
    }
    return r.id;
  }
  destroyResource(r) {
    const rr = r.rec; if (!rr || rr.destroyed) return;
    rr.destroyed = true;
    if (rr.slot >= 0) this.link.freeSlots.push(rr.slot);
    // (destroyed while bound — a state block's texture is not reference-counted — its pointer may come back as
    // another object: every binding is resolved again at the next flush)
    if (rr.binds > 0) for (const x of this.link.recorders) { x.texHook = -1; x.streamHook = -1; x.s.ib = NaN; }
    for (const l of r.levels ?? (r.faces ? r.faces.flat() : r.type === 1 ? [r] : [])) if (l.id !== undefined) this.fbos.delete(l.id);
    this.lastTarget = null;
    if (this.link.failed) return;
    this.sel(); this.w.c1(OP.DESTROY, r.id);
  }
  shaderId(sh, dx9) {
    if (!sh) return 0;
    if (sh.recId) return sh.recId;
    const id = sh.recId = this.link.nextObjId++;
    if (dx9) this.w.put(OP.SHADER9, id, sh.kind === 'ps' ? 1 : 0, sh.handle >>> 0, sh.code);
    else this.w.put(OP.SHADER8, id, sh.decl ? 0 : 1, sh.handle >>> 0, sh.usage, sh.decl ?? null, sh.code ?? null);
    return id;
  }
  /** a vertex declaration released (VertexDecl.destroy) */
  declDestroyed(d) { if (d.recId && !this.link.failed) { this.w.c1(OP.DECL_DELETE, d.recId); d.recId = 0; } }
  declId(d) {
    if (!d) return 0;
    if (!d.recId) { d.recId = this.link.nextObjId++; this.w.put(OP.DECL_CREATE, d.recId, d.bytes); }
    return d.recId;
  }
  // ---------------------------------------------------------------- state
  /** Record every backend-visible change of the device since the last flush (before each command that reads them). */
  flush() {
    const d = this.dev, s = this.s, L = this.link, W = this.w;
    this.sel();
    // render / stage / sampler state tables
    if (!!d.api9 !== s.api9) { s.api9 = !!d.api9; W.c1(OP.API9, s.api9 ? 1 : 0); }
    if (d.rs !== s.rs || d.tss !== s.tss || d.samplers !== s.samplers) this.syncTables();
    else if (this.nDirty) { // (one TSETS command for the uint32 values — nearly all of them)
      const T = this.dirtyT, K = this.dirtyK, nd = this.nDirty;
      const p0 = W.begin(OP.TSETS, 1 + 3 * nd), I = W.I;
      let q = p0 + 1;
      for (let i = 0; i < nd; i++) {
        const t = T[i], k = K[i], v = t.get(k);
        if (k < t.v.length) t.recMark[k] = 0;
        if ((v >>> 0) === v && (k >>> 0) === k) { I[q] = t.recId; I[q + 1] = k; I[q + 2] = v; q += 3; }
        else (this.oddSets ??= []).push(t.recId, k, v);
      }
      I[p0] = q - p0 - 1;
      if (q < p0 + 1 + 3 * nd) { I[p0 - 1] = OP.TSETS | ((q - p0) << 8); W.produced -= p0 + 1 + 3 * nd - q; } // (the unused end given back)
      if (this.oddSets?.length) { const o = this.oddSets; for (let i = 0; i < o.length; i += 3) W.put(OP.TSET, o[i], o[i + 1] >>> 0, o[i + 2]); o.length = 0; }
      this.nDirty = 0;
    }
    if (d.pp !== s.pp) { s.pp = d.pp; W.put(OP.PP, d.pp.width >>> 0, d.pp.height >>> 0, d.pp.swap >>> 0, d.pp.count >>> 0); }
    if (d.backBuffers !== s.bb) {
      for (const b of s.bb ?? []) if (!d.backBuffers.includes(b) && b.rec && !b.rec.destroyed) { b.rec.destroyed = true; W.c1(OP.FORGET, b.id); } // (replaced by Reset)
      s.bb = d.backBuffers; for (const b of d.backBuffers) this.ensureRes(b); W.put(OP.BACKBUFFERS, d.backBuffers.map((b) => b.id));
    }
    if (d.renderTarget !== s.rt) {
      const rt = d.renderTarget; s.rt = rt;
      this.ensureRes(rt);
      const nres = rt?.owner ? rt.owner.rec : null; // (a texture level: its texture may be uploaded when its framebuffer is made)
      if (s.rtRes !== nres) { L.unbind(s.rtRes); L.bind(nres); s.rtRes = nres; }
      W.c1(OP.RT, rt ? rt.id : 0);
    }
    if (d.viewport !== s.vp) { const v = d.viewport; s.vp = v; W.put(OP.VIEWPORT, v.x, v.y, v.w, v.h, v.minZ, v.maxZ); }
    if (d.api9) {
      if (d.scissor !== s.sc) { const c = d.scissor; s.sc = c; if (c) W.put(OP.SCISSOR, 1, c.l, c.t, c.r, c.b); else W.put(OP.SCISSOR, 0, 0, 0, 0, 0); }
      if (d.fvf !== s.fvf) { s.fvf = d.fvf; W.put(OP.FVF, d.fvf); }
      if (d.vertexDecl !== s.decl) { s.decl = d.vertexDecl; W.c1(OP.DECL, this.declId(d.vertexDecl)); }
      if (d.vsObj !== s.vs) { s.vs = d.vsObj; W.c1(OP.VS9, this.shaderId(d.vsObj, true)); }
      if (d.psObj !== s.ps) { s.ps = d.psObj; W.c1(OP.PS9, this.shaderId(d.psObj, true)); }
    } else if (this.shaderHook || d.vertexShader !== s.vs8 || d.pixelShader !== s.ps8) {
      this.shaderHook = false;
      const vo = d.vertexShaders.get(d.vertexShader) ?? null, po = d.pixelShaders.get(d.pixelShader) ?? null;
      if (d.vertexShader !== s.vs8 || vo !== s.vs8o) { s.vs8 = d.vertexShader; s.vs8o = vo; const id = this.shaderId(vo, false); W.put(OP.VS8, d.vertexShader, id); }
      if (d.pixelShader !== s.ps8 || po !== s.ps8o) { s.ps8 = d.pixelShader; s.ps8o = po; const id = this.shaderId(po, false); W.put(OP.PS8, d.pixelShader, id); }
    }
    // textures of the stages (by object: a pointer may be reused by another object once released)
    const tx = d.textures;
    if (tx !== s.texArr) {
      s.texArr = tx; W.c1(OP.TEXTURES, tx.length);
      for (const r of s.texRes) L.unbind(r);
      s.tex = new Array(tx.length).fill(0); s.texRes = new Array(tx.length).fill(null); this.texHook = -1;
    }
    // (every change of a stage's texture goes through gfx.setTexture — SetTexture, state blocks — or replaces the array)
    if (this.texHook) {
      for (let i = 0; i < tx.length; i++) if ((this.texHook & (1 << i)) || tx[i] !== s.tex[i]) this.syncTexture(i);
      this.texHook = 0;
    }
    // vertex streams and indices
    const st = d.streams;
    if (st !== s.streamsArr) {
      s.streamsArr = st; W.c1(OP.STREAMS, st.length);
      for (const r of s.sRes) L.unbind(r);
      s.sVb = new Array(st.length).fill(0); s.sStride = new Array(st.length).fill(0); s.sOff = new Array(st.length).fill(d.api9 ? 0 : undefined); s.sRes = new Array(st.length).fill(null);
      this.streamHook = -1;
    }
    // (every change of a stream goes through gfx.setStreamSource, or replaces the array)
    if (this.streamHook) {
      for (let i = 0; i < st.length; i++) {
        const x = st[i];
        if (x.vb !== s.sVb[i] || x.stride !== s.sStride[i] || x.offset !== s.sOff[i] || (this.streamHook & (1 << i))) this.syncStream(i, x);
      }
      this.streamHook = 0;
    }
    if (d.indices !== s.indices || d.indices.ib !== s.ib || d.indices.base !== s.ibase) {
      const ix = d.indices; s.indices = ix; s.ib = ix.ib; s.ibase = ix.base;
      const r = ix.ib ? d.com.implAt(ix.ib) : null, nres = r ? (this.ensureRes(r), r.rec) : null;
      if (nres !== s.ibRes) { L.unbind(s.ibRes); L.bind(nres); s.ibRes = nres; }
      W.put(OP.INDICES, r ? r.id : 0, ix.base);
    }
    // transforms, lights, material, constants
    if (d.transformVersion !== s.xfVer || d.transforms !== s.xf || d.transformSlotVersion !== s.xfSlots) this.syncTransforms();
    if (d.lightVersion !== s.lightVer || d.lights !== s.lights || d.lights.size !== s.lightSize || d.lightEnabled !== s.enabledSet || d.lightEnabled.size !== s.enabled.length) this.syncLights();
    this.syncConsts();
    // version counters, as they are (the mirror never recomputes them; fields read by name: VERSION_FIELDS order)
    const V = s.versions;
    if (d.stateVersion !== V[0]) this.putVersion(0, d.stateVersion);
    if (d.programVersion !== V[1]) this.putVersion(1, d.programVersion);
    if (d.transformVersion !== V[2]) this.putVersion(2, d.transformVersion);
    if (d.lightVersion !== V[3]) this.putVersion(3, d.lightVersion);
    if (d.viewportVersion !== V[4]) this.putVersion(4, d.viewportVersion);
    if (d.constVersion !== V[5]) this.putVersion(5, d.constVersion);
    if (d.transformAllVersion !== V[6]) this.putVersion(6, d.transformAllVersion);
  }
  putVersion(i, v) {
    const W = this.w; this.s.versions[i] = v;
    if ((v >>> 0) === v) { const p = W.begin(OP.VERSION, 3), I = W.I; I[p] = i; I[p + 1] = 0; I[p + 2] = v; } else W.put(OP.VERSION, i, v);
  }
  syncTables() {
    const d = this.dev, s = this.s, W = this.w;
    for (const t of [s.rs, ...(s.tss ?? []), ...(s.samplers ?? [])]) if (t && t.rec === this) t.rec = null;
    s.rs = d.rs; s.tss = d.tss; s.samplers = d.samplers;
    const all = [d.rs, ...d.tss, ...(d.samplers ?? [])];
    W.c2(OP.TABLES, d.tss.length, d.samplers ? d.samplers.length : 0);
    all.forEach((t, id) => {
      t.rec = this; t.recId = id; t.recMark = new Uint8Array(t.v.length);
      for (const [k, v] of t) W.put(OP.TSET, id, k >>> 0, v);
    });
    this.nDirty = 0;
  }
  syncTexture(i) {
    const d = this.dev, s = this.s, L = this.link, ptr = d.textures[i];
    const r = ptr ? d.com.implAt(ptr) : null, old = s.texRes[i], nres = r ? (this.ensureRes(r), r.rec) : null;
    s.tex[i] = ptr;
    if (nres === old && ptr) return;
    L.unbind(old); L.bind(nres); s.texRes[i] = nres;
    this.w.c2(OP.TEXTURE, i, r ? r.id : 0);
  }
  syncStream(i, x) {
    const d = this.dev, s = this.s, L = this.link;
    const r = x.vb ? d.com.implAt(x.vb) : null, nres = r ? (this.ensureRes(r), r.rec) : null;
    s.sVb[i] = x.vb; s.sStride[i] = x.stride; s.sOff[i] = x.offset;
    if (nres !== s.sRes[i]) { L.unbind(s.sRes[i]); L.bind(nres); s.sRes[i] = nres; }
    this.w.put(OP.STREAM, i, r ? r.id : 0, x.stride, x.offset);
  }
  /** a transform slot changed (Device.touchTransform: every change of a matrix goes through it) */
  transformTouched(slot) { const x = this.xfDirty, n = this.nXf; for (let i = 0; i < n; i++) if (x[i] === slot) return; x[n] = slot; this.nXf = n + 1; }
  syncTransforms() {
    const d = this.dev, s = this.s, W = this.w, x = this.xfDirty;
    if (d.transforms !== s.xf || d.transformSlotVersion !== s.xfSlots) {
      s.xf = d.transforms; s.xfSlots = d.transformSlotVersion;
      W.c0(OP.XFORMS);
      const slots = new Set([...d.transforms.keys(), ...d.transformSlotVersion.keys()]);
      for (const k of slots) this.putXform(k);
    } else for (let i = 0, n = this.nXf; i < n; i++) this.putXform(x[i]);
    this.nXf = 0;
    s.xfVer = d.transformVersion;
  }
  putXform(slot) {
    const d = this.dev, m = d.transforms.get(slot), ver = d.transformSlotVersion.get(slot), W = this.w;
    if (m && m.length === 16 && (ver >>> 0) === ver) { // (the common case, encoded in place)
      const p = W.begin(OP.XFORM, 20), I = W.I;
      I[p] = slot; I[p + 1] = 0; I[p + 2] = ver; I[p + 3] = 16;
      W.F.set(m, p + 4); // (same element type: a copy of the bytes, bit-exact)
      return;
    }
    W.put(OP.XFORM, slot >>> 0, ver, m ? new Int32Array(m.buffer, m.byteOffset, m.length) : null);
  }
  syncLights() {
    const d = this.dev, s = this.s, W = this.w;
    if (d.lights !== s.lights || d.lightEnabled !== s.enabledSet) { s.lights = d.lights; s.enabledSet = d.lightEnabled; s.lightShadow = new Map(); s.enabled = []; s.material = null; W.c0(OP.LIGHTS); }
    for (const [i, l] of d.lights) {
      const w = new Int32Array(l.buffer, l.byteOffset, l.length);
      let sh = s.lightShadow.get(i), same = !!sh;
      if (sh) for (let k = 0; k < w.length; k++) if (sh[k] !== w[k]) { same = false; break; }
      if (same) continue;
      if (!sh) s.lightShadow.set(i, (sh = new Int32Array(w.length)));
      sh.set(w);
      W.put(OP.LIGHT, i >>> 0, w);
    }
    s.lightSize = d.lights.size;
    let en = s.enabled.length === d.lightEnabled.size, k = 0;
    if (en) for (const i of d.lightEnabled) if (s.enabled[k++] !== i) { en = false; break; }
    if (!en) { s.enabled = [...d.lightEnabled]; W.put(OP.LIGHTS_ON, s.enabled); }
    const mt = d.material, mw = new Int32Array(mt.buffer, mt.byteOffset, mt.length);
    let msame = !!s.material; if (msame) for (let i = 0; i < mw.length; i++) if (s.material[i] !== mw[i]) { msame = false; break; }
    if (!msame) { s.material = mw.slice(); W.put(OP.MATERIAL, mw); }
    s.lightVer = d.lightVersion;
  }
  syncConsts() {
    const d = this.dev, s = this.s, W = this.w;
    if (d.vsConst !== s.consts[0] || d.psConst !== s.consts[1] || d.vsConstI !== s.consts[2] || d.psConstI !== s.consts[3] || d.vsConstB !== s.consts[4] || d.psConstB !== s.consts[5]) {
      for (let k = 0; k < 6; k++) { const a = s.consts[k] = d[CONST_FIELDS[k]]; s.cLo[k] = 0; s.cHi[k] = a ? a.length : -1; s.cWords[k] = a && k < 2 ? new Int32Array(a.buffer, a.byteOffset, a.length) : a; }
      W.put(OP.CONSTS, d.vsConst.length, d.psConst.length, d.vsConstI?.length ?? 0, d.psConstI?.length ?? 0, d.vsConstB?.length ?? 0, d.psConstB?.length ?? 0);
    }
    for (let k = 0; k < 6; k++) {
      const hi = s.cHi[k]; if (hi < 0) continue;
      const lo = s.cLo[k], a = s.consts[k];
      s.cLo[k] = Infinity; s.cHi[k] = -1;
      if (!a || hi <= lo) continue;
      const n = Math.min(hi, a.length) - lo;
      const p = W.begin(OP.CONST, 3 + n), I = W.I;
      I[p] = k; I[p + 1] = lo; I[p + 2] = n;
      const src = s.cWords[k]; // (floats as their bits)
      for (let i = 0; i < n; i++) I[p + 3 + i] = src[lo + i];
    }
  }
  // ---------------------------------------------------------------- work
  /** the backend creates a framebuffer for the surface it renders to (its `fbos`): StretchRect's GPU path follows */
  noteTarget(t) { if (t && t !== this.lastTarget) { this.fbos.add(t.id); this.lastTarget = t; } }
  /** a command that may read the bound resources was recorded: published at once (the render worker follows closely) */
  workDone() {
    const L = this.link, pos = this.w.produced;
    L.lastWorkEnd = pos;
    if (L.ctl === null) return;
    if (++L.drawsSinceNotify >= 32) L.publish();
    else { L.published = pos; Atomics.store(L.ctl, CTL.HEAD, pos % TWO32 | 0); }
  }
  beginScene() { if (this.link.failed) return; this.sel(); this.w.c0(OP.BEGIN_SCENE); }
  clear(n, rects, flags, color, z, stencil) {
    this.flush();
    const d = this.dev, mem = this.mem;
    this.noteTarget(d.renderTarget ?? d.backBuffers[0]);
    let r = null;
    if (n && rects) { r = new Int32Array(4 * n); for (let i = 0; i < 4 * n; i++) r[i] = mem.readS32(rects + 4 * i); }
    this.w.put(OP.CLEAR, n >>> 0, flags >>> 0, color >>> 0, z, stencil >>> 0, r);
    this.workDone();
  }
  drawPrimitive(type, start, count) {
    this.flush();
    this.noteTarget(this.dev.renderTarget ?? this.dev.backBuffers[0]);
    this.w.c3(OP.DRAW, type, start, count);
    this.workDone();
  }
  drawIndexedPrimitive(type, minIdx, numV, start, count, base = this.dev.indices.base) {
    this.flush();
    const d = this.dev;
    if (this.s.ibRes) this.noteTarget(d.renderTarget ?? d.backBuffers[0]); // (the backend draws nothing without indices)
    const W = this.w;
    if ((base >>> 0) === base || (base | 0) === base) { const p = W.begin(OP.DRAW_INDEXED, 7), I = W.I; I[p] = type; I[p + 1] = minIdx; I[p + 2] = numV; I[p + 3] = start; I[p + 4] = count; I[p + 5] = (base >>> 0) === base ? 0 : 1; I[p + 6] = base; }
    else W.put(OP.DRAW_INDEXED, type, minIdx, numV, start, count, base);
    this.workDone();
  }
  vertexCount(type, prims) { switch (type) { case 1: return prims; case 2: return prims * 2; case 3: return prims + 1; case 4: return prims * 3; default: return prims + 2; } }
  drawPrimitiveUP(type, count, data, stride) {
    this.flush();
    this.noteTarget(this.dev.renderTarget ?? this.dev.backBuffers[0]);
    const n = this.vertexCount(type, count) * stride;
    this.w.put(OP.DRAW_UP, type, count, stride, this.mem.bytes(data, Math.max(0, n)));
    this.workDone();
  }
  drawIndexedPrimitiveUP(type, minIdx, numV, count, idx, ifmt, data, stride) {
    this.flush();
    this.noteTarget(this.dev.renderTarget ?? this.dev.backBuffers[0]);
    const nv = (minIdx + numV) * stride, ni = this.vertexCount(type, count) * (ifmt === 101 ? 2 : 4);
    this.w.put(OP.DRAW_INDEXED_UP, type, minIdx, numV, count, ifmt, stride, this.mem.bytes(data, Math.max(0, nv)), this.mem.bytes(idx, Math.max(0, ni)));
    this.workDone();
  }
  present() {
    const L = this.link;
    if (L.failed) return this.dev.gfx !== this ? this.dev.gfx.present(this.dev) : undefined;
    this.flush();
    const d = this.dev;
    this.noteTarget(d.backBuffers[0]);
    const frame = ++L.frames;
    this.w.c1(OP.PRESENT, frame);
    L.lastWorkEnd = this.w.produced;
    if (d.backBuffers.length > 1 && d.pp.swap !== 3) { // (the backend rotates its framebuffers: so does this copy of its keys)
      const ids = d.backBuffers.map((b) => b.id), has = ids.map((id) => this.fbos.has(id));
      ids.forEach((id, i) => { if (has[(i + 1) % ids.length]) this.fbos.add(id); else this.fbos.delete(id); });
      this.lastTarget = null;
    }
    if (L.ctl) Atomics.store(L.ctl, CTL.FRAMES, frame);
    if (L.recTime || globalThis.ORTHROS_REC_TIME) L.recTimeStep();
    L.publish(true);
    if (L.ctl) L.waitFor(() => Atomics.load(L.ctl, CTL.SHOWN) >= frame - MAX_FRAMES_IN_FLIGHT, CTL.SHOWN, 'frame');
  }
  readbackSurface(sf) {
    const L = this.link;
    if (L.failed) { if (this.dev.gfx !== this) this.dev.gfx.readbackSurface(sf); return; }
    this.flush();
    this.ensureRes(sf);
    // (the memory the pixels go to: the mirror's surface gets it once they are read, as the backend allocates it)
    const had = sf.mem;
    this.readbackOf = sf; sf.ensureMem(this.dev.proc); this.readbackOf = null;
    this.noteTarget(sf);
    const t = ++L.tickets, t0 = performance.now();
    if (had) this.w.c3(OP.READBACK, sf.id, t, 0); else this.w.c3(OP.READBACK, sf.id, t, sf.mem);
    L.lastWorkEnd = this.w.produced;
    if (L.replayer) { L.publish(true); }
    else L.waitFor(() => Atomics.load(L.ctl, CTL.READBACK) === t, CTL.READBACK, 'readback');
    L.stats.readbacks++; void t0;
    if (L.failed && this.dev.gfx !== this) this.dev.gfx.readbackSurface(sf);
  }
  readbackFrontBuffer(sf) { const b = this.dev.backBuffers[0]; this.readbackSurface(b); if (b.mem && b.fmt === sf.fmt) this.mem.copy(sf.ensureMem(this.dev.proc), b.mem, Math.min(b.bytes, sf.bytes)); }
  copyRects(src, dst, rects, n, points) { return copyRectsCpu(this.mem, this.dev.proc, src, dst, rects, n, points, (x) => this.dev.gfx.readbackSurface(x)); }
  stretchRect(src, sr, dst, dr, filter) {
    if (this.link.failed) return this.dev.gfx !== this ? this.dev.gfx.stretchRect(src, sr, dst, dr, filter) : null;
    if (!this.fbos.has(src.id) || (dst.usage & 2)) return null;
    this.flush();
    this.ensureRes(src); this.ensureRes(dst);
    const mem = this.mem, rect = (p) => (p ? [mem.readS32(p), mem.readS32(p + 4), mem.readS32(p + 8), mem.readS32(p + 12)] : null);
    this.w.put(OP.STRETCH, src.id, dst.id, filter >>> 0, rect(sr), rect(dr));
    this.noteTarget(dst);
    this.link.ref(recOf(src)); this.link.ref(recOf(dst));
    this.workDone();
    return 0;
  }
  setGamma(ramp) { if (this.link.failed) return; this.sel(); this.w.put(OP.GAMMA, ramp.subarray(0, 1536)); }
  reset() { if (this.link.failed) return; this.flush(); this.w.c0(OP.RESET); this.fbos.clear(); this.lastTarget = null; }
  /** stop recording (the device gets another backend): the state tables' hooks removed */
  detach() {
    this.link.recorders.delete(this);
    for (const t of [this.s.rs, ...(this.s.tss ?? []), ...(this.s.samplers ?? [])]) if (t && t.rec === this) t.rec = null;
  }
  destroy() {
    this.link.recorders.delete(this);
    for (const t of [this.s.rs, ...(this.s.tss ?? []), ...(this.s.samplers ?? [])]) if (t && t.rec === this) t.rec = null;
    if (this.link.failed) return;
    this.sel(); this.w.c1(OP.DEVICE_DESTROY, this.id);
  }
}
