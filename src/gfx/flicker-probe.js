// A flicker counter for telemetry, cheap enough to stay on in every session (the owner's "everything flickers" on his
// GPU, 2026-11-17, never seen on the server's software rasterizer): every PERIOD_MS, three consecutive presented frames
// are compared pixel by pixel over the whole frame, on the GPU. The first two are copied (a framebuffer blit) into
// textures, the third too, then one draw into a W x H RGBA8 target reduces them: each of its pixels covers one block of
// the frame (the frame cut into W x H blocks, every pixel in exactly one) and counts that block's pixels whose
// luminance went from A to B and back to A (|a - b| > T, |b - c| > T, |a - c| < T / 3), those of them whose surroundings
// are the same in the first and the third frame (STILL: |a - c| < T / 3 at each of those points too) and those that
// changed between the first two frames, as fractions of the block (R, A, G), with the first frame's mean luminance (B).
// The STILL ones are the flicker — a picture that alternates where nothing moves: a missing pass, a stale target, a
// texture sampled from the wrong unit, depth fighting. A-B-A alone is not: a scroll moves textured terrain under every
// pixel, and its value comes back one frame later on 2-3 % of the pixels by chance (the owner's scroll of 2026-11-17,
// 2560x1440: 2.46 % A-B-A, the same 2.0-2.8 % measured on his screen recording's scroll frames), all over the terrain;
// around such a pixel the surroundings moved, so it is not STILL. (That recording does show real alternation too: small
// rocks drawn every other frame with the camera still, shrub shadows for one frame as the camera stops — docs/aotr-play.md
// "The owner's flicker".) That small picture is read back
// without a stall (readPixels into a pixel buffer, read once a fence says the GPU is done). Every pixel counts: a few
// objects that flicker (a 4 x 4 patch: 16 pixels of 480 000) show, which a filtered 64 x 48 blit of the frame (4 texels of
// each block of ~156) would mostly miss and would blur. Also counted: the WebGL errors (getError once per period — a round
// trip to the GPU process that waits for the commands queued before it: on a GPU only; a software rasterizer can be
// seconds behind). Cost: nothing at the other presents; at a sample's three, three blits of the frame, and at the third
// one draw reading the three copies once, the surroundings of the A-B-A pixels only (docs/real-machine-bench.md
// "Flicker": measured).
// Cumulative counters in `stats` (`n` triples measured, `aba` / `still` / `chg` their A-B-A / flickering / changed
// pixels in parts per million of the frame, summed, `max` the largest still, `recent` the last RECENT samples' still
// ([sample number, ppm]: a window's own maximum), `over1` the triples whose still is over 1 %, `alt` those where
// alternation dominates (still >= ALT_MIN ppm and at least half of what changed), `abaAlt` those that are not `alt` but
// where A-B-A anywhere dominates what changed (something alternating while the picture moved a little — the still rule
// cannot see it; a scroll's chance A-B-A is ~10 % of what changed), `glErrors`, `glError` the last code): readers take
// differences (web/perf-summary.js). The first LOG_MAX samples over 1 %, `alt` or `abaAlt` are also logged (a gfx
// line the page sends with the telemetry): where the pixels flickered (`mask` W x H bits, a block's bit set when one of
// its pixels was a STILL A-B-A one — any A-B-A one for an `abaAlt` sample, whose line says "alternating while the
// picture moved", and in the probe's first version, 2026-11-17 morning, whose lines say "of the pixels A-B-A over 3
// frames"; rows from the bottom of the picture: GL order, hex by 4 blocks) and what the
// screen looked like (`lum`: the first frame's luminance at W/2 x H/2, one hex digit per pixel, bottom row first).
// The first sample of a session whose still share reaches CAPTURE_STILL (2 %) also starts a capture of the next frames
// (flicker-capture.js: their pictures and the GL work of each, sent once with the telemetry through `send`); while it
// runs no sample is taken.
// A player's display report (frame-report.js: the page's "report a display problem", ORTHROS_FLICKER_REPORT=<id>) also
// goes through here: it takes the presents while it records — no sample, no capture meanwhile.
// ORTHROS_FLICKER (debug global): 0 off, 2 every sample logged.
import { FlickerCapture, CAPTURE_STILL } from './flicker-capture.js';
import { FrameReport } from './frame-report.js';

export const W = 64, H = 48, PERIOD_MS = 10000, T = 24;
/**
 * The surroundings of a pixel that must be the same in the first and the third frame for its A-B-A to count as
 * flicker (offsets in pixels of an 800-pixel-wide frame, scaled by stillScale for wider ones): a ring at 4 and 8
 * pixels, on the axes and the diagonals at 4 — wide enough that a scroll rarely matches all of them by chance, and a
 * flicker of any size in a still picture passes (outside the flickering area the picture did not change; inside it, it
 * came back). What still passes in a scroll: thin objects moving over a flat background (trees and towers over the
 * black beyond a map's edge, ~0.01 % of the owner's 2560x1440 frames).
 */
export const STILL = Object.freeze([[4, 0], [-4, 0], [0, 4], [0, -4], [8, 0], [-8, 0], [0, 8], [0, -8], [4, 4], [-4, -4], [4, -4], [-4, 4]]);
/** the STILL offsets' scale for a frame `w` pixels wide (a picture's detail spreads over more pixels as it grows) */
export const stillScale = (w) => Math.max(1, Math.round(w / 800));
/** presents after which a readback still not done is given up */
const STALE = 120;
/** samples logged per session at most */
const LOG_MAX = 3;
/** samples whose aba is kept for a window's maximum */
export const RECENT = 32;
/** an `alt` sample: at least this many ppm of the frame went A-B-A (48 pixels of 800 x 600) */
export const ALT_MIN = 100;

const VS = '#version 300 es\nvoid main() { gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0); }';
// (per output pixel: its block [x0, x1) x [y0, y1) of the frame, every pixel fetched from the three copies)
const FS = `#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D u_a, u_b, u_c; uniform ivec2 u_size; uniform int u_k;
out vec4 o;
const ivec2 STILL[${STILL.length}] = ivec2[${STILL.length}](${STILL.map(([x, y]) => `ivec2(${x}, ${y})`).join(', ')});
float lum(vec4 c) { return dot(c.rgb, vec3(0.299, 0.587, 0.114)) * 255.0; }
// (the first and the third frame the same around q: nothing moved there)
bool still(ivec2 q) {
  for (int k = 0; k < ${STILL.length}; k++) {
    ivec2 r = clamp(q + STILL[k] * u_k, ivec2(0), u_size - 1);
    if (abs(lum(texelFetch(u_a, r, 0)) - lum(texelFetch(u_c, r, 0))) >= ${T}.0 / 3.0) return false;
  }
  return true;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x0 = p.x * u_size.x / ${W}, x1 = (p.x + 1) * u_size.x / ${W}, y0 = p.y * u_size.y / ${H}, y1 = (p.y + 1) * u_size.y / ${H};
  float aba = 0.0, sab = 0.0, chg = 0.0, la0 = 0.0;
  for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) {
    ivec2 q = ivec2(x, y);
    float la = lum(texelFetch(u_a, q, 0)), lb = lum(texelFetch(u_b, q, 0)), lc = lum(texelFetch(u_c, q, 0));
    la0 += la;
    if (abs(la - lb) > ${T}.0) { chg += 1.0; if (abs(lb - lc) > ${T}.0 && abs(la - lc) < ${T}.0 / 3.0) { aba += 1.0; if (still(q)) sab += 1.0; } }
  }
  float n = float(max(1, (x1 - x0) * (y1 - y0)));
  o = vec4(aba / n, chg / n, la0 / n / 255.0, sab / n);
}`;

/**
 * The three sampled frames' command signatures compared: 'same' (the same commands three times, as far as the signature
 * sees: d3d8-webgl.js sigMix), 'aba' (the first and the third the same, the second other), 'differ', or null when not
 * known.
 */
export function cmdPattern(sigs) {
  if (!sigs || sigs.some((x) => x === undefined)) return null;
  return sigs[0] === sigs[1] && sigs[1] === sigs[2] ? 'same' : sigs[0] === sigs[2] ? 'aba' : 'differ';
}
/** the first index of each of n blocks over `size` pixels, and size: block k is [e[k], e[k + 1]) (the shader's cut) */
export const blockEdges = (size, n) => Array.from({ length: n + 1 }, (_, k) => Math.floor(k * size / n));
/**
 * A sample's result read back (W x H RGBA8: per block its A-B-A, changed and still A-B-A fractions, its mean luminance)
 * for a frame of w x h pixels: the A-B-A, still A-B-A (flicker) and changed shares of the frame's pixels (fractions),
 * `mask` (W x H, 1 where a block had flickering pixels) and `abaMask` (1 where it had A-B-A pixels, still or not).
 */
export function sampleShares(px, w, h) {
  const xs = blockEdges(w, W), ys = blockEdges(h, H), mask = new Uint8Array(W * H), abaMask = new Uint8Array(W * H);
  let aba = 0, chg = 0, still = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, n = (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
    aba += px[4 * k] / 255 * n; chg += px[4 * k + 1] / 255 * n; still += px[4 * k + 3] / 255 * n; mask[k] = px[4 * k + 3] > 0 ? 1 : 0; abaMask[k] = px[4 * k] > 0 ? 1 : 0;
  }
  return { aba: aba / (w * h), chg: chg / (w * h), still: still / (w * h), mask, abaMask };
}
/** the log line's pictures: the flicker mask (blocks with still A-B-A pixels) (W x H bits, 4 per hex digit) and the first frame's luminance at W/2 x H/2 (a hex digit each) */
export function flickerPictures(mask, px) {
  let m = '', l = '';
  for (let i = 0; i < W * H; i += 4) m += ((mask[i] << 3) | (mask[i + 1] << 2) | (mask[i + 2] << 1) | mask[i + 3]).toString(16);
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) l += Math.min(15, Math.round(px[4 * (y * W + x) + 2] / 17)).toString(16);
  return { mask: m, lum: l };
}

export class FlickerProbe {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {{ now?: () => number, log?: (m: string) => void, errors?: boolean, send?: (rec: object) => void, encode?: Function }} [opts]
   * `errors`: read getError; `send`: where the session's flicker capture goes (none: no capture); `encode`: its pictures' encoder (tests)
   */
  constructor(gl, opts = {}) {
    this.gl = gl; this.now = opts.now ?? (() => performance.now()); this.log = opts.log ?? null; this.logged = 0; this.errors = opts.errors ?? true;
    this.send = opts.send ?? null; this.encode = opts.encode; this.cap = null; this.captured = false; this.armed = null; this.report = null; this.reportAsked = null;
    this.stats = { n: 0, aba: 0, still: 0, chg: 0, max: 0, recent: [], over1: 0, alt: 0, abaAlt: 0, altSame: 0, altCmdAba: 0, glErrors: 0, glError: 0 };
    this.next = this.now() + PERIOD_MS; this.left = 0; this.read = null; this.presents = 0; this.sigs = [0, 0, 0];
    this.reset();
  }
  /** The context was lost (and restored): its objects are gone, the sample in progress dropped. */
  reset() { this.prog = null; this.fbo = null; this.rb = null; this.vao = null; this.copies = null; this.copyFbo = null; this.left = 0; this.read = null; this.cap?.abort(); this.cap = null; this.report?.abort('WebGL context lost'); this.report = null; this.unsign(); }
  /** the device that signs the sample's frames told to stop */
  unsign() { if (this.sigDev) { this.sigDev.sigOn = false; this.sigDev = null; } }
  /** a capture records GL calls now (the GL call counter keeps away) */
  get recording() { return !!this.cap?.recording; }
  /**
   * A frame is about to be shown: `fbo` (its back buffer's framebuffer, bound, scissor test off) of GL size w x h;
   * `dev`: the backend device presenting (a capture asks it for its GL objects and frame figures, flicker-capture.js);
   * `sig`: the signature of the commands that drew it (d3d8-webgl.js sigMix; undefined: not known).
   * Leaves `fbo` bound to FRAMEBUFFER. Returns true when it changed other GL state (the sample's draw: program,
   * textures, viewport, vertex array, capabilities) — the caller's cached GL state is then stale.
   */
  present(fbo, w, h, dev = null, sig = undefined) {
    if (globalThis.ORTHROS_GL_DISCARD && this.report) { this.report.abort('nothing rasterized (GL discard)'); this.report = null; }
    // (a player's display report — frame-report.js, asked by the page through ORTHROS_FLICKER_REPORT, the probe on or
    // off —: it takes the presents while it records)
    const rep = this.reportStep(fbo, w, h, dev, sig);
    if (rep !== null) return rep;
    if (globalThis.ORTHROS_FLICKER === 0 || globalThis.ORTHROS_GL_DISCARD) { if (this.cap) { this.cap.abort(); this.cap = null; } this.unsign(); return false; } // (nothing rasterized: nothing to compare — and its draw must not lift RASTERIZER_DISCARD)
    const gl = this.gl, now = this.now();
    this.presents++;
    if (this.cap) { // (a capture runs: it takes the presents, no sample meanwhile)
      const r = this.cap.present(fbo, w, h, dev);
      if (this.cap.phase === 'done') { this.cap = null; this.next = now + PERIOD_MS; }
      return r;
    }
    if (this.read) this.poll();
    // (a capture: armed by a sample, or asked — ORTHROS_FLICKER_CAPTURE=1, debugging —, when the GL methods are free to wrap)
    const ask = globalThis.ORTHROS_FLICKER_CAPTURE;
    if ((this.armed || ask === 1) && ask !== 0 && this.send && !this.left && !this.read && (dev?.flickerCanRecord?.() ?? true)) {
      if (ask === 1) globalThis.ORTHROS_FLICKER_CAPTURE = undefined;
      this.cap = new FlickerCapture(gl, { send: this.send, trigger: this.armed ?? { asked: true }, now: this.now, encode: this.encode, errors: this.errors });
      this.armed = null; this.captured = true; this.unsign();
      return this.cap.present(fbo, w, h, dev);
    }
    if (!this.left && !this.read && now >= this.next) {
      // (the device signs its frames' commands only when asked — dev.sigOn, d3d8-webgl.js sigMix —: asked now, the
      // sample starts at the next present, the first frame drawn with it on; switched off after the sample's third)
      if (dev && dev.sigOn === false) { dev.sigOn = true; this.sigDev = dev; return false; }
      this.next = now + PERIOD_MS; this.left = 3; this.w = w; this.h = h;
      if (this.errors) { const e = gl.getError(); if (e) { this.stats.glErrors++; this.stats.glError = e; } }
    }
    if (!this.left) return false;
    if (w !== this.w || h !== this.h) { this.left = 0; this.unsign(); this.dropCopies(); return false; } // (a resize between the frames: not a sample)
    const k = 3 - this.left--;
    this.sigs[k] = sig;
    if (!this.left) this.unsign();
    if (!this.copies) { // (bound on the active unit: the caller's cache must forget it — true is returned at the sample's end, these come first)
      this.copies = [0, 1, 2].map(() => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); return t; });
      this.texBound = true;
    }
    this.copyFbo ??= gl.createFramebuffer();
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.copyFbo); gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.copies[k], 0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0); // (no copy kept alive by the attachment)
    if (k < 2) { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); const t = this.texBound; this.texBound = false; return t; }
    this.reduce(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    return true;
  }
  /**
   * The display report's share of a present: started when the page asked for one (ORTHROS_FLICKER_REPORT=<id>, a new
   * id; not while a flicker capture wraps the GL methods — it waits for its end), then given the presents while it
   * records (the sample in progress dropped, none started; a capture reading back still polled), and afterwards each
   * present until it is read back (the probe goes on meanwhile). Returns what present returns while it records, else null.
   */
  reportStep(fbo, w, h, dev, sig) {
    const ask = globalThis.ORTHROS_FLICKER_REPORT;
    if (ask && ask !== this.reportAsked && !this.report && this.send && !globalThis.ORTHROS_GL_DISCARD && !(this.cap && (this.cap.recording || this.cap.phase === 'start'))) {
      this.reportAsked = ask; globalThis.ORTHROS_FLICKER_REPORT = undefined;
      if (this.left) { this.left = 0; this.dropCopies(); }
      this.unsign();
      this.report = new FrameReport(this.gl, { id: ask, send: this.send, encode: this.encode });
    }
    const r = this.report;
    if (!r) return null;
    if (!r.active) { r.present(fbo, w, h, dev, sig); if (r.phase === 'done') this.report = null; return null; } // (reading back, encoding)
    const changed = r.present(fbo, w, h, dev, sig);
    if (this.read) this.poll();
    if (this.cap && !this.cap.recording && this.cap.phase !== 'start') { this.cap.present(fbo, w, h, dev); if (this.cap.phase === 'done') this.cap = null; }
    return changed;
  }
  /** the third frame copied: the draw comparing the three into the small target, its readback started */
  reduce(w, h) {
    const gl = this.gl;
    if (!this.prog) {
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
      gl.useProgram(p); ['u_a', 'u_b', 'u_c'].forEach((u, i) => gl.uniform1i(gl.getUniformLocation(p, u), i));
      this.prog = p; this.uSize = gl.getUniformLocation(p, 'u_size'); this.uK = gl.getUniformLocation(p, 'u_k'); this.vao = gl.createVertexArray();
      this.fbo = gl.createFramebuffer(); this.rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.rb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, W, H);
    for (const cap of [gl.BLEND, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.CULL_FACE, gl.SCISSOR_TEST, gl.POLYGON_OFFSET_FILL, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.DITHER]) gl.disable(cap);
    gl.colorMask(true, true, true, true);
    gl.useProgram(this.prog); gl.uniform2i(this.uSize, w, h); gl.uniform1i(this.uK, stillScale(w));
    for (let i = 0; i < 3; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, this.copies[i]); gl.bindSampler(i, null); }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DITHER); // (GL's default, which the backend never changes: the fractions written exactly)
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf); gl.bufferData(gl.PIXEL_PACK_BUFFER, W * H * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.dropCopies(); // (deleted once the GPU is done with them: GL keeps them alive for the commands queued)
    this.read = { buf, sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), at: this.presents, w, h, sigs: this.sigs.slice() };
  }
  dropCopies() { const gl = this.gl; for (const t of this.copies ?? []) gl.deleteTexture(t); this.copies = null; }
  /** The sample's readback, once the GPU finished it: its shares counted. */
  poll() {
    const gl = this.gl, r = this.read;
    if (gl.getSyncParameter(r.sync, gl.SYNC_STATUS) !== gl.SIGNALED) {
      if (this.presents - r.at >= STALE) { try { gl.deleteSync(r.sync); gl.deleteBuffer(r.buf); } catch { /* context lost */ } this.read = null; }
      return;
    }
    this.read = null; gl.deleteSync(r.sync);
    const px = new Uint8Array(W * H * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, r.buf); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.deleteBuffer(r.buf);
    this.count(px, r.w, r.h, r.sigs);
  }
  /**
   * one sample's result (sampleShares of its readback) into the counters, logged when it flickered; `sigs`: the three
   * frames' command signatures (d3d8-webgl.js sigMix) — an `alt` sample whose three signatures are equal counts in
   * `altSame`: the same commands as far as the signature sees, the alternation then coming from what it leaves out
   * (buffer or texture contents, constants) or from the GPU (an undefined or implementation-dependent result) — not a
   * proof of a GPU fault; one whose signatures went A-B-A too in `altCmdAba`: the commands alternate with the picture
   * (the game's frames, or Orthros' translation of them)
   */
  count(px, w, h, sigs) {
    const s = sampleShares(px, w, h), st = this.stats, aba = Math.round(s.aba * 1e6), chg = Math.round(s.chg * 1e6), still = Math.round(s.still * 1e6);
    st.n++; st.aba += aba; st.still += still; st.chg += chg; if (still > st.max) st.max = still;
    st.recent.push([st.n, still]); if (st.recent.length > RECENT) st.recent.shift();
    const over1 = still > 10000, alt = still >= ALT_MIN && 2 * still >= chg, abaAlt = !alt && aba >= ALT_MIN && 2 * aba >= chg;
    if (over1) st.over1++;
    const cmd = cmdPattern(sigs);
    if (still >= CAPTURE_STILL && !this.captured && !this.armed && this.send) this.armed = { still: still / 1e4, aba: aba / 1e4, chg: chg / 1e4, w, h, sample: st.n, cmd }; // (the session's capture, at the next present: flicker-capture.js)
    if (alt) st.alt++;
    if (abaAlt) st.abaAlt++;
    if (alt && cmd === 'same') st.altSame++;
    if (alt && cmd === 'aba') st.altCmdAba++;
    const every = globalThis.ORTHROS_FLICKER === 2; // (debugging: every sample logged)
    if (this.log && (every || ((over1 || alt || abaAlt) && this.logged < LOG_MAX))) {
      if (!every) this.logged++;
      const moved = abaAlt && !over1, p = flickerPictures(moved ? s.abaMask : s.mask, px); // (an `abaAlt` sample: where the A-B-A pixels were)
      this.log(`d3d-webgl: flicker sample: ${(still / 1e4).toFixed(4)} % of the pixels flickered (A-B-A over 3 frames where nothing moved; A-B-A anywhere ${(aba / 1e4).toFixed(4)} %, changed ${(chg / 1e4).toFixed(4)} %, ${w}x${h}${moved ? '; alternating while the picture moved: mask of A-B-A anywhere' : ''}); commands ${cmd ?? 'unknown'}${cmd ? ` (${sigs.map((x) => (x >>> 0).toString(16)).join('/')})` : ''}; mask ${W}x${H} ${p.mask}; lum ${W / 2}x${H / 2} ${p.lum}`);
    }
  }
}
