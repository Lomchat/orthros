// A flicker counter for telemetry, cheap enough to stay on in every session (the owner's "everything flickers" on his
// GPU, 2026-11-17, never seen on the server's software rasterizer): every PERIOD_MS, three consecutive presented frames
// are copied (a filtered blit) into a small RGBA8 framebuffer of W x H pixels and read back without a stall (readPixels
// into a pixel buffer, read once a fence says the GPU is done). A sampled pixel flickers when its luminance goes from A
// to B and back to A over the three frames (|a - b| > T, |b - c| > T, |a - c| < T / 3): a scroll or an animation rarely
// comes back to the same value one frame later, a picture that alternates (a missing pass, a stale target, a texture
// sampled from the wrong unit, depth fighting) does. Also counted: what changed between the first two frames, and the
// WebGL errors (getError once per period — a round trip to the GPU process that waits for the commands queued before
// it: on a GPU only; a software rasterizer can be seconds behind).
// Cumulative counters in `stats` (`n` triples measured, `aba` / `chg` their flickering / changed pixels in hundredths of
// a percent, summed, `max` the largest aba, `over1` the triples over 1 %, `glErrors`, `glError` the last code): readers
// take differences (web/perf-summary.js). The first LOG_MAX samples over 1 % are also logged (a gfx line the page sends
// with the telemetry): where the pixels flickered (`mask` W x H bits, rows from the bottom of the picture: GL order, hex
// by 4 pixels) and what the screen looked like (`lum`: the first frame's luminance at W/2 x H/2, one hex digit per
// pixel, bottom row first). ORTHROS_FLICKER=0 (debug global): off.
export const W = 64, H = 48, PERIOD_MS = 10000, T = 24;
/** presents after which a readback still not done is given up (a sample whose frames are not consecutive is worthless) */
const STALE = 120;
/** samples over 1 % logged per session at most */
const LOG_MAX = 3;

const lum = (px, p) => 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
/** the A-B-A and change shares (fractions) of three RGBA8 frames of `n` pixels; `mask` (optional, n entries): 1 where A-B-A */
export function flickerShares(a, b, c, n, t = T, mask = null) {
  let aba = 0, chg = 0;
  for (let i = 0; i < n; i++) {
    const p = 4 * i, la = lum(a, p), lb = lum(b, p), lc = lum(c, p);
    let f = 0;
    if (Math.abs(la - lb) > t) { chg++; if (Math.abs(lb - lc) > t && Math.abs(la - lc) < t / 3) { aba++; f = 1; } }
    if (mask) mask[i] = f;
  }
  return { aba: aba / n, chg: chg / n };
}
/** the log line's pictures: the A-B-A mask (W x H bits, 4 per hex digit) and the first frame's luminance at W/2 x H/2 (a hex digit each) */
export function flickerPictures(mask, a) {
  let m = '', l = '';
  for (let i = 0; i < W * H; i += 4) m += ((mask[i] << 3) | (mask[i + 1] << 2) | (mask[i + 2] << 1) | mask[i + 3]).toString(16);
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) l += Math.min(15, Math.round(lum(a, 4 * (y * W + x)) / 17)).toString(16);
  return { mask: m, lum: l };
}

export class FlickerProbe {
  /** @param {WebGL2RenderingContext} gl @param {{ now?: () => number, log?: (m: string) => void, errors?: boolean }} [opts] `errors`: read getError */
  constructor(gl, opts = {}) {
    this.gl = gl; this.now = opts.now ?? (() => performance.now()); this.log = opts.log ?? null; this.logged = 0; this.errors = opts.errors ?? true;
    this.stats = { n: 0, aba: 0, chg: 0, max: 0, over1: 0, glErrors: 0, glError: 0 };
    this.fbo = null; this.rb = null; this.next = this.now() + PERIOD_MS; this.left = 0; this.reads = []; this.frames = []; this.presents = 0;
  }
  /** The context was lost (and restored): its objects are gone, the sample in progress dropped. */
  reset() { this.fbo = null; this.rb = null; this.left = 0; this.reads.length = 0; this.frames.length = 0; }
  /**
   * A frame is about to be shown: `fbo` (its back buffer's framebuffer, bound, scissor test off) of GL size w x h.
   * Leaves `fbo` bound to FRAMEBUFFER.
   */
  present(fbo, w, h) {
    if (globalThis.ORTHROS_FLICKER === 0) return;
    const gl = this.gl, now = this.now();
    this.presents++;
    if (this.reads.length) this.poll();
    if (!this.left && !this.reads.length && now >= this.next) {
      this.next = now + PERIOD_MS; this.left = 3; this.frames.length = 0; this.start = this.presents;
      if (this.errors) { const e = gl.getError(); if (e) { this.stats.glErrors++; this.stats.glError = e; } }
    }
    if (!this.left) return;
    this.left--;
    if (!this.fbo) {
      this.fbo = gl.createFramebuffer(); this.rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.rb);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf); gl.bufferData(gl.PIXEL_PACK_BUFFER, W * H * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    this.reads.push({ buf, sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), at: this.presents });
  }
  /** Readbacks the GPU finished: their pixels taken, in order; three of them make a sample. */
  poll() {
    const gl = this.gl;
    while (this.reads.length) {
      const r = this.reads[0];
      if (gl.getSyncParameter(r.sync, gl.SYNC_STATUS) !== gl.SIGNALED) {
        if (this.presents - r.at < STALE) return;
        this.drop(); return;
      }
      this.reads.shift(); gl.deleteSync(r.sync);
      const px = new Uint8Array(W * H * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, r.buf); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.deleteBuffer(r.buf);
      this.frames.push(px);
    }
    if (this.frames.length === 3 && !this.left) {
      const [a, b, c] = this.frames, mask = new Uint8Array(W * H), s = flickerShares(a, b, c, W * H, T, mask), st = this.stats;
      const aba = Math.round(s.aba * 10000), chg = Math.round(s.chg * 10000);
      st.n++; st.aba += aba; st.chg += chg; if (aba > st.max) st.max = aba; if (aba > 100) st.over1++;
      if (aba > 100 && this.log && this.logged < LOG_MAX) { this.logged++; const p = flickerPictures(mask, a); this.log(`d3d-webgl: flicker sample: ${(aba / 100).toFixed(2)} % of the pixels A-B-A over 3 frames (changed ${(chg / 100).toFixed(2)} %); mask ${W}x${H} ${p.mask}; lum ${W / 2}x${H / 2} ${p.lum}`); }
      this.frames.length = 0;
    }
  }
  /** a sample abandoned (a readback that never completed) */
  drop() { const gl = this.gl; for (const r of this.reads) { try { gl.deleteSync(r.sync); gl.deleteBuffer(r.buf); } catch { /* context lost */ } } this.reads.length = 0; this.frames.length = 0; this.left = 0; }
}
