// Static frames (docs/render-worker.md section 11): a frame whose recorded commands are those of the previous frame,
// replayed from the same device state with the same resources, makes the same image — the render worker then shows
// the previous image again instead of rendering it. On a machine without GPU (SwiftShader) every rendered frame costs
// the GPU process its rasterization: a LOADING screen or a menu presented 30-60 times a second keeps 3-4 cores busy
// for an image that does not change.
//
// Image-exact by construction, not by comparing pixels:
// - a frame is "plain" when every command in it is an absolute state setter (render/stage/sampler states, viewport,
//   shaders, streams, textures by id, transforms, lights, constants, buffer bytes carried in the ring, a texture level
//   the guest wrote — its bytes then part of the frame, copied as the command is read) or work on the targets (clears,
//   draws), and nothing reads what was there before: each target it draws to is first cleared whole
//   (color, and depth and stencil before a draw that tests them — a depth test that always passes reads nothing), no render-target texture is sampled before being
//   cleared in the frame. Anything else (a resource created or destroyed, a buffer written in guest memory, a readback,
//   a copy, gamma, another device...) makes the frame not plain.
// - two consecutive plain frames with equal commands and equal written surface bytes (the version counters, which only
//   key the backend's caches, set aside) leave the device state as it was between them: a sequence of absolute setters
//   applied twice gives what it gives once. The third frame with equal commands then starts from the same state as the second, reads the same
//   resources (a write is a command: one with the same bytes leaves them as they were) and renders the same image.
// - that third frame's commands are held (copied out of the ring, compared word for word with the reference as they
//   arrive) and not replayed; at its PRESENT the state commands are applied (the mirror stays exact) and the frame is
//   "presented" without any GL work: the page keeps the image it has. The first command that differs releases the held
//   prefix, replayed as usual before it. Held commands are not reported consumed until the frame is decided (the
//   emulator's fences still protect the guest memory they may read); an emulator that waits for them releases them.
// ORTHROS_STATIC_REUSE (render worker debug global): 1 on, 2 count only (frames that could be reused, none reused),
// unset/0 off — the default: the measured scenes have no reusable frames (docs/render-worker.md 11.3).
import { OP, OPS, OP_NAMES } from './cmd-ring.js';
import { RingReader } from './cmd-ring.js';
import { RS } from './d3d8-shaders.js';

/** commands a plain frame may hold (absolute setters, target work, the present) */
const PLAIN = new Uint8Array(OPS.length);
for (const k of ['TSET', 'TSETS', 'VIEWPORT', 'SCISSOR', 'FVF', 'DECL', 'VS9', 'PS9', 'VS8', 'PS8', 'STREAM', 'INDICES', 'TEXTURE', 'RT', 'VERSION', 'XFORM', 'LIGHT', 'LIGHTS_ON', 'MATERIAL', 'CONST', 'BUF_DATA', 'SURF_MEM', 'SURF_DIRTY', 'BEGIN_SCENE', 'CLEAR', 'DRAW', 'DRAW_INDEXED', 'DRAW_UP', 'DRAW_INDEXED_UP', 'PRESENT']) PLAIN[OP[k]] = 1;
/** work on the targets: not replayed for a reused frame */
const WORK = new Uint8Array(OPS.length);
for (const k of ['BEGIN_SCENE', 'CLEAR', 'DRAW', 'DRAW_INDEXED', 'DRAW_UP', 'DRAW_INDEXED_UP']) WORK[OP[k]] = 1;
/** a frame larger than this (words) is not recorded: it is not plain; nor one writing more than MAX_BYTES of surfaces */
const MAX_WORDS = 1 << 20, MAX_BYTES = 32 << 20;
const D3DUSAGE_RENDERTARGET = 1, CMP_ALWAYS = 8;

/** words of a kind-'n' value at index p */
const nLen = (I, p) => { const t = I[p]; return t === 3 ? 1 : t === 2 ? 3 : 2; };

/** a growable word buffer of whole commands (header and payload), readable as a ring that never wraps */
class Words {
  constructor() { this.I = new Int32Array(1 << 12); this.n = 0; this.D = new Uint8Array(0); this.dn = 0; }
  push(src, from, count) {
    if (this.n + count > this.I.length) { let c = this.I.length; while (c < this.n + count) c *= 2; const I = new Int32Array(c); I.set(this.I.subarray(0, this.n)); this.I = I; }
    this.I.set(src.subarray(from, from + count), this.n); this.n += count;
  }
  /** the contents of a surface written in the frame (its guest bytes as the SURF_DIRTY command is read) */
  pushBytes(bytes) {
    const k = bytes.length;
    if (this.dn + k > this.D.length) { let c = Math.max(this.D.length, 1 << 16); while (c < this.dn + k) c *= 2; const D = new Uint8Array(c); D.set(this.D.subarray(0, this.dn)); this.D = D; }
    this.D.set(bytes, this.dn); this.dn += k;
  }
}

export class StaticFrames {
  /** `replayer`: the Replayer it filters (its `apply`), `onReuse(mirror, frame)`: a frame presented without rendering */
  constructor(replayer, onReuse) {
    this.rp = replayer; this.onReuse = onReuse;
    this.cur = new Words(); this.ref = new Words(); this.hold = new Words();
    this.plain = true; // (the frame being recorded so far)
    this.streak = 0; // consecutive plain frames with equal commands, the last one included (1: a plain frame)
    this.holding = false; this.at = 0; // (holding: the frame's commands held, `at` words of the reference matched)
    /** ring position of the first held command (null: none held) — the words consumed published stop there (render-loop.js) */
    this.heldFrom = null;
    this.key = null; // the backend's render key at the last present (render scale): a change ends the streak
    this.tgt = new Map(); // per target of the frame: 1 color cleared, 2 depth cleared, 16 stencil cleared (before any draw), 4 drawn, 8 depends on what it held
    this.dep = null; // (diagnostics: the first dependence on the targets' contents found)
    this.early = null; this.owners = null; // render-target textures sampled before being cleared, textures drawn to
    this.m = this.mode();
    this.memOver = null; // (a held frame's SURF_MEMs: surface id -> memory)
    this.stats = { frames: 0, plain: 0, equal: 0, reused: 0, released: 0, notPlain: 0, dependent: 0 };
  }
  mode() { return Number(globalThis.ORTHROS_STATIC_REUSE) || 0; } // (off by default: docs/render-worker.md 11.3)
  /** before a run of commands: the switch read (`m`: 0 the commands go straight to the replayer) */
  begin() {
    const m = this.mode();
    if (m !== this.m) { if (this.holding) this.release(null); this.reset(); this.m = m; } // (a partial frame: not recorded)
    return m;
  }
  /** (diagnostics: why frames are not reused — the first command that is not plain, or differs) */
  why(k) { const w = this.stats.why ??= {}; w[k] = (w[k] ?? 0) + 1; }
  /** forget the reference (context restored, a mode change) */
  reset() { this.streak = 0; this.ref.n = 0; this.ref.dn = 0; this.cur.n = 0; this.cur.dn = 0; this.plain = true; this.tgt.clear(); this.early = this.owners = null; }

  /** one command read from the ring (`r`: the reader at it) */
  step(r) {
    if (this.holding) { this.held(r); return; }
    this.note(r);
    this.rp.apply(r);
    if (r.op === OP.PRESENT) this.frameEnd();
  }

  // ---------------------------------------------------------------- recording a frame (replayed as usual)
  note(r) {
    if (!this.plain) return;
    const op = r.op, m = this.rp.cur;
    if (!PLAIN[op] || m === null || this.cur.n + r.n + 1 > MAX_WORDS) { this.plain = false; this.why(OP_NAMES[op]); return; }
    if (op === OP.SURF_DIRTY) { const b = this.surfBytes(r); if (b === null || this.cur.dn + b.length > MAX_BYTES) { this.plain = false; this.why('SURF_DIRTY (no contents)'); return; } this.cur.pushBytes(b); }
    this.cur.push(r.I, r.p - 1, r.n + 1);
    if (WORK[op] && op !== OP.BEGIN_SCENE) this.work(op, r, m);
  }
  /**
   * The guest bytes of a surface the guest wrote (SURF_DIRTY: a texture level, as the backend uploads it from guest
   * memory at its next use), null if it has none. Read as the command is: the emulator's fences keep them as they are
   * until the draws recorded after it are replayed (d3d-recorder.js beforeWrite).
   */
  surfBytes(r) {
    const id = r.I[r.p] >>> 0, s = this.rp.res.get(id), mem = this.rp.mem;
    const addr = (this.memOver?.get(id) ?? s?.mem) >>> 0; // (a held frame's SURF_MEM, not applied yet)
    if (!s || !s.owner || !addr || !mem?.u8 || !(s.bytes > 0)) return null;
    return mem.u8.subarray(addr, addr + s.bytes);
  }
  /** a clear or a draw on the current target: does the frame's image depend on what the targets held before it? */
  work(op, r, m) {
    const rt = m.renderTarget ?? m.backBuffers[0];
    if (!rt) { this.plain = false; return; }
    let s = this.tgt.get(rt) ?? 0;
    if (op === OP.CLEAR) {
      const I = r.I, p = r.p, n = I[p], flags = I[p + 1], v = m.viewport;
      const whole = n === 0 && v.x <= 0 && v.y <= 0 && v.x + v.w >= rt.width && v.y + v.h >= rt.height;
      if (!whole) { s |= 8; this.dep ??= 'clears part of its target'; }
      else if (!(s & 4)) s |= (flags & 1 ? 1 : 0) | (flags & 2 ? 2 : 0) | (flags & 4 ? 16 : 0); // (cleared before any draw on it)
    } else {
      s |= 4;
      if (!(s & 1)) { s |= 8; this.dep ??= rt.owner ? 'draws over a texture' : 'draws over its target'; } // (drawn over what it held)
      // (a depth test that always passes reads nothing: the depth it may write depends on the draw alone)
      if (!(s & 2) && (m.rs.get(RS.ZENABLE) ?? 1) !== 0 && (m.rs.get(RS.ZFUNC) ?? 4) !== CMP_ALWAYS) { s |= 8; this.dep ??= 'tests the depth it held'; }
      if (!(s & 16) && (m.rs.get(RS.STENCILENABLE) ?? 0) !== 0) { s |= 8; this.dep ??= 'tests the stencil it held'; }
      // (render-target textures sampled: they must have been made in this frame first)
      const tx = m.textures, res = this.rp.res;
      for (let i = 0; i < tx.length; i++) {
        if (!tx[i]) continue;
        const t = res.get(tx[i]);
        if (t && (t.usage & D3DUSAGE_RENDERTARGET) && !((this.owners?.get(t) ?? 0) & 1)) (this.early ??= new Set()).add(t);
      }
    }
    this.tgt.set(rt, s);
    if (rt.owner) (this.owners ??= new Map()).set(rt.owner, (this.owners.get(rt.owner) ?? 0) | (s & 1 && !(s & 8) ? 1 : 0) | 2);
  }
  frameEnd() {
    const S = this.stats, mode = this.m;
    S.frames++;
    let plain = this.plain;
    if (plain) {
      for (const s of this.tgt.values()) if (s & 8) plain = false;
      if (plain && this.early) for (const t of this.early) if (this.owners?.has(t)) plain = false;
      if (!plain) { S.dependent++; this.why(this.dep ?? 'samples a texture it draws to'); }
    } else S.notPlain++;
    const g = this.rp.cur?.gfx, key = g ? g.rscale ?? 1 : null;
    if (plain) {
      S.plain++;
      const same = this.ref.n > 0 && key === this.key && equalFrames(this.cur, this.ref, this);
      if (same) { S.equal++; this.streak++; } else this.streak = 1;
      const t = this.ref; this.ref = this.cur; this.cur = t;
    } else {
      this.streak = 0;
      // (count mode: frames that would be equal but for reading their targets — what a weaker rule would reuse)
      if (mode === 2 && this.plain) { if (this.ref.n > 0 && equalFrames(this.cur, this.ref, this)) S.equalDependent = (S.equalDependent ?? 0) + 1; const t = this.ref; this.ref = this.cur; this.cur = t; }
    }
    this.key = key;
    this.cur.n = 0; this.cur.dn = 0; this.plain = true; this.dep = null; this.tgt.clear(); this.early = this.owners = null;
    // (the next frame held when two equal plain frames precede it)
    if (mode === 1 && this.streak >= 2 && g && !this.rp.opts.beforePresent) { this.holding = true; this.at = 0; this.hold.n = 0; this.hold.dn = 0; }
  }

  // ---------------------------------------------------------------- holding a frame
  held(r) {
    const I = r.I, p = r.p, n = r.n, R = this.ref.I, at = this.at, op = r.op;
    if (at + n + 1 > this.ref.n || !sameCommand(I, p - 1, R, at)) { this.release(r); return; }
    if (this.heldFrom === null) this.heldFrom = r.consumed - n - 1;
    if (op === OP.SURF_MEM) (this.memOver ??= new Map()).set(I[p] >>> 0, I[p + 1] >>> 0);
    else if (op === OP.SURF_DIRTY) { // (the surface's contents: those the reference wrote, byte for byte)
      const b = this.surfBytes(r), o = this.hold.dn;
      if (b === null || o + b.length > this.ref.dn || !sameBytes(b, this.ref.D, o)) { this.release(r); return; }
      this.hold.dn = o + b.length;
    }
    this.hold.push(I, p - 1, n + 1); this.at = at + n + 1;
    if (op !== OP.PRESENT) return;
    // the whole frame equal to the reference: its state applied, no GL work, the previous image kept
    const S = this.stats, m0 = this.rp.cur, g = m0?.gfx;
    const rd = new RingReader(this.hold.I), end = this.hold.n;
    while (rd.consumed < end) { rd.next(); if (rd.op === OP.PRESENT) break; if (!WORK[rd.op]) this.rp.apply(rd); }
    S.frames++; S.plain++; S.equal++; S.reused++;
    this.memOver = null; this.heldFrom = null; this.at = 0; this.hold.n = 0; this.hold.dn = 0;
    this.onReuse?.(m0, I[p]);
    this.holding = this.m === 1 && !!g; // (the next one held too)
  }
  /** a command that differs from the reference (null: the switch turned off): the held ones replayed as usual first, then it */
  release(r) {
    this.holding = false; this.heldFrom = null; this.memOver = null; this.stats.released++;
    const h = this.hold; this.hold = new Words(); // (replayed through step(), which records them again)
    const rd = new RingReader(h.I);
    while (rd.consumed < h.n) { rd.next(); this.step(rd); }
    h.n = 0; h.dn = 0; this.hold = h;
    if (r) this.step(r);
  }
}

/**
 * Equal commands (one at `a` in A, one at `b` in B: their header words): the same words, the values of the version
 * counters (VERSION, a transform's slot version) set aside — they only key the backend's caches —, and the frame number.
 */
function sameCommand(A, a, B, b) {
  const h = A[a];
  if (h !== B[b]) return false;
  const op = h & 0xff, n = h >>> 8;
  if (op === OP.VERSION) return A[a + 1] === B[b + 1];
  if (op === OP.PRESENT) return true; // (its frame number)
  if (op === OP.SURF_MEM) return A[a + 1] === B[b + 1]; // (the memory a copy on write moved its contents to: compared at SURF_DIRTY)
  if (op === OP.SURF_DIRTY) { for (let i = 3; i <= n; i++) if (A[a + i] !== B[b + i]) return false; return A[a + 1] === B[b + 1]; } // (its generation set aside: its contents compared)
  let i = 1;
  if (op === OP.XFORM) { if (A[a + 1] !== B[b + 1]) return false; i = 2 + nLen(A, a + 2); if (nLen(B, b + 2) !== i - 2) return false; }
  for (; i <= n; i++) if (A[a + i] !== B[b + i]) return false;
  return true;
}
/** two recorded frames with equal commands */
function equalFrames(x, y, sf) {
  const A = x.I, B = y.I;
  for (let a = 0; a < x.n && a < y.n;) { if (!sameCommand(A, a, B, a)) { sf.why(`differs at ${OP_NAMES[A[a] & 0xff]}`); return false; } a += (A[a] >>> 8) + 1; }
  if (x.n !== y.n) { sf.why('differs in length'); return false; }
  if (x.dn !== y.dn || !sameBytes(x.D.subarray(0, x.dn), y.D, 0)) { sf.why('differs in surface contents'); return false; }
  return true;
}
/** bytes `b` equal to those of D from `o` (compared as words where both are aligned) */
function sameBytes(b, D, o) {
  const n = b.length;
  if ((b.byteOffset & 3) === 0 && (o & 3) === 0 && (D.byteOffset & 3) === 0) {
    const w = n >> 2, x = new Int32Array(b.buffer, b.byteOffset, w), y = new Int32Array(D.buffer, D.byteOffset + o, w);
    for (let i = 0; i < w; i++) if (x[i] !== y[i]) return false;
    for (let i = w << 2; i < n; i++) if (b[i] !== D[o + i]) return false;
    return true;
  }
  for (let i = 0; i < n; i++) if (b[i] !== D[o + i]) return false;
  return true;
}
