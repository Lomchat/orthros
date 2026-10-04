// MPEG decoders of the DirectShow path (src/media): bitstream tables, inverse DCT, MPEG-1 video and MPEG audio layer II
// against reference decodings (tests/fixtures/media, made with ffmpeg; more configurations when ffmpeg is installed),
// the program stream demultiplexer fed in arbitrary pieces, playback timing, and damaged streams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Vlc } from '../src/media/bits.js';
import { Mpeg1VideoDecoder, idct8x8, idct8x8Reference, MB_ADDR_CODES, MB_TYPE_CODES, CBP_CODES, MOTION_CODES, DC_LUMA_CODES, DC_CHROMA_CODES, DCT_CODES } from '../src/media/mpeg1-video.js';
import { MpegAudioDecoder, SYNTH_WINDOW, ALLOC_TABLES } from '../src/media/mpeg-audio.js';
import { MpegPsDemuxer, probeMpeg } from '../src/media/mpeg-ps.js';
import { MpegSource } from '../src/media/mpeg-source.js';
import { yuv420ToRgba } from '../src/media/yuv.js';

const FIX = (n) => fs.readFileSync(new URL(`./fixtures/media/${n}`, import.meta.url));
const MOVIE = FIX('movie.mpg');
const f32 = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };

function demux(bytes) {
  const v = [], a = [];
  new MpegPsDemuxer({ video: (b) => v.push(b), audio: (b) => a.push(b) }).push(bytes);
  return { video: Buffer.concat(v), audio: Buffer.concat(a) };
}
function decodeVideo(es) {
  const d = new Mpeg1VideoDecoder(); d.push(es); d.end();
  const out = [];
  for (let f; (f = d.decode());) out.push({ type: f.type, y: f.y.slice(), cb: f.cb.slice(), cr: f.cr.slice(), stride: f.stride, cstride: f.cstride, width: f.width, height: f.height });
  return { frames: out, errors: d.errors };
}
function psnr(f, ref, w, h) {
  let se = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const e = f.y[y * f.stride + x] - ref[y * w + x]; se += e * e; n++; }
  for (const [pl, off] of [[f.cb, w * h], [f.cr, w * h * 5 / 4]]) for (let y = 0; y < h / 2; y++) for (let x = 0; x < w / 2; x++) { const e = pl[y * f.cstride + x] - ref[off + y * w / 2 + x]; se += e * e; n++; }
  return se ? 10 * Math.log10(255 * 255 * n / se) : 99;
}
function decodeAudio(es) {
  const d = new MpegAudioDecoder(), ch = [];
  for (let i = 0; i + 4 <= es.length;) { const f = d.decodeFrame(es, i); if (!f) { i++; continue; } ch.push(f); i += d.header.bytes; }
  return ch;
}
function snr(frames, ref, nch) {
  let se = 0, sp = 0, t = 0;
  for (const f of frames) { for (let s = 0; s < f.samples[0].length; s++) for (let c = 0; c < nch; c++) { const y = ref[(t + s) * nch + c]; if (y === undefined) continue; se += (f.samples[c][s] - y) ** 2; sp += y * y; } t += f.samples[0].length; }
  return 10 * Math.log10(sp / se);
}

test('variable-length code tables: prefix-free, every value once, Kraft sums', () => {
  const kraft = (codes) => codes.reduce((s, [c]) => s + 2 ** -c.length, 0);
  for (const codes of [MB_ADDR_CODES, CBP_CODES, MOTION_CODES, DC_LUMA_CODES, DC_CHROMA_CODES, ...Object.values(MB_TYPE_CODES)]) {
    new Vlc(codes); // (throws on overlapping codes)
    assert.equal(new Set(codes.map(([, v]) => v)).size, codes.length);
    assert.ok(kraft(codes) <= 1);
  }
  assert.deepEqual(CBP_CODES.map(([, v]) => v).sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i));
  const dct = [['10'], ['000001'], ...DCT_CODES];
  new Vlc(dct.map(([c], i) => [c, i]));
  assert.equal(new Set(DCT_CODES.map(([, r, l]) => `${r}/${l}`)).size, DCT_CODES.length);
  // dct_coeff_next: the only unused codes are those starting with 12 zeros (11172-2 table B.5c)
  assert.ok(Math.abs(kraft(dct) - (1 - 2 ** -12)) < 1e-12, `dct kraft ${kraft(dct)}`);
});

test('inverse DCT: the fast transform rounds as the definition (random sparse and dense blocks)', () => {
  const r = rng(7);
  let off = 0;
  for (let n = 0; n < 3000; n++) {
    const blk = new Int32Array(64), dense = n % 3 === 0;
    for (let i = 0; i < 64; i++) if (dense || r() < 0.08) blk[i] = Math.round((r() * 2 - 1) * (r() < 0.2 ? 2048 : 200));
    const a = blk.slice(), b = blk.slice();
    idct8x8(a); idct8x8Reference(b);
    for (let i = 0; i < 64; i++) { const d = Math.abs(a[i] - b[i]); assert.ok(d <= 1, `block ${n}: ${a[i]} vs ${b[i]}`); off += d; }
  }
  assert.ok(off < 10, `${off} values off by one (a .5 rounded the other way)`);
});

test('MPEG-1 video: the fixture decodes as the reference (I, P, B pictures, display order)', () => {
  const { video } = demux(MOVIE);
  const { frames, errors } = decodeVideo(video);
  assert.equal(errors, 0);
  assert.equal(frames.length, 30);
  assert.deepEqual(frames.slice(0, 7).map((f) => f.type), [1, 3, 3, 2, 3, 3, 2]);
  const ref = FIX('movie-video-ref.yuv'), F = 96 * 64 * 3 / 2;
  [0, 1, 3, 29].forEach((n, i) => { const p = psnr(frames[n], ref.subarray(i * F), 96, 64); assert.ok(p > 50, `picture ${n}: ${p.toFixed(1)} dB`); });
});

test('MPEG audio layer II: the fixture decodes as the reference; the synthesis window', () => {
  const { audio } = demux(MOVIE);
  const frames = decodeAudio(audio);
  assert.equal(frames[0].rate, 32000); assert.equal(frames[0].channels, 1);
  const ref = f32(FIX('movie-audio-ref.f32'));
  const s = snr(frames.slice(0, 4), ref, 1);
  assert.ok(s > 100, `SNR ${s.toFixed(1)} dB`);
  assert.equal(SYNTH_WINDOW[256] * 65536, 75038);
  for (let i = 1; i < 256; i++) assert.equal(SYNTH_WINDOW[512 - i], (i % 64 === 0 ? 1 : -1) * SYNTH_WINDOW[i]);
  assert.deepEqual(Object.fromEntries(Object.entries(ALLOC_TABLES).map(([k, t]) => [k, t.length])), { a: 27, b: 30, c: 8, d: 12, lsf: 30 });
});

test('program stream demultiplexer: the same streams whatever the pieces it is fed in', () => {
  const whole = demux(MOVIE);
  assert.equal(probeMpeg(MOVIE), 'mpeg-ps');
  const r = rng(3);
  for (let k = 0; k < 20; k++) {
    const v = [], a = [], d = new MpegPsDemuxer({ video: (b) => v.push(b), audio: (b) => a.push(b) });
    for (let i = 0; i < MOVIE.length;) { const n = 1 + Math.floor(r() * (k < 10 ? 50 : 5000)); d.push(MOVIE.subarray(i, i + n)); i += n; }
    assert.ok(Buffer.concat(v).equals(whole.video)); assert.ok(Buffer.concat(a).equals(whole.audio));
  }
});

test('MpegSource: pictures and sound on the stream clock, late pictures skipped, seeking back', () => {
  const file = { size: () => MOVIE.length, read: (o, n) => MOVIE.subarray(o, o + n) };
  const s = new MpegSource(file);
  assert.equal(s.kind, 'mpeg-ps'); assert.equal(s.width, 96); assert.equal(s.height, 64); assert.equal(s.fps, 25);
  assert.equal(s.audioRate, 32000); assert.equal(s.audioChannels, 1);
  assert.ok(Math.abs(s.duration - 1.2) < 0.05, `duration ${s.duration}`);
  let shown = 0, samples = 0, t = 0;
  for (; t < 5 && !s.ended(t); t += 0.005) {
    s.load(t);
    const p = s.pictureAt(t);
    if (p) { shown++; assert.ok(s.frameTime(s.frameIndex - 1) <= t); }
    s.audioUntil(t + 0.2, (smp, start) => { assert.ok(Math.abs(start - s.audioStart - samples / 32000) < 1e-9); samples += smp[0].length; });
  }
  assert.equal(shown, 30); assert.equal(s.frameIndex, 30);
  assert.ok(t >= s.videoEnd && Math.abs(t - 1.2) < 0.06, `ended at ${t}`);
  assert.equal(samples, 34 * 1152);
  // a late caller: B pictures due before the one shown are not decoded
  s.reset();
  s.load(10, Infinity);
  assert.ok(s.pictureAt(0.9));
  assert.ok(s.stats.skipped >= 10, `${s.stats.skipped} skipped`); assert.equal(s.frameIndex, 23);
  // RGBA conversion of the picture shown (mid-gray luma, neutral chroma -> gray)
  const p = { y: new Uint8Array([126, 126, 235, 16]), cb: new Uint8Array([128]), cr: new Uint8Array([128]), stride: 2, cstride: 1 };
  assert.deepEqual(Array.from(yuv420ToRgba(p, 0, 0, 2, 2, new Uint8ClampedArray(16))), [128, 128, 128, 255, 128, 128, 128, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
});

test('Y\'CbCr -> RGBA: the word-at-a-time conversion writes what the per-byte one does (random planes and crops)', () => {
  const r = rng(5);
  for (let k = 0; k < 40; k++) {
    const W = 2 * (1 + Math.floor(r() * 40)), H = 2 * (1 + Math.floor(r() * 30));
    const p = { y: Uint8Array.from({ length: W * H }, () => r() * 256), cb: Uint8Array.from({ length: W * H / 4 }, () => r() * 256), cr: Uint8Array.from({ length: W * H / 4 }, () => r() * 256), stride: W, cstride: W / 2 };
    const x = 2 * Math.floor(r() * W / 4), y = 2 * Math.floor(r() * H / 4), w = 1 + Math.floor(r() * (W - x)), h = 1 + Math.floor(r() * (H - y));
    const fast = yuv420ToRgba(p, x, y, w, h, new Uint8ClampedArray(w * h * 4));
    const slow = yuv420ToRgba(p, x, y, w, h, new Uint8ClampedArray(new ArrayBuffer(w * h * 4 + 1), 1, w * h * 4)); // (unaligned: per byte)
    assert.deepEqual(Array.from(fast), Array.from(slow));
  }
});

test('damaged streams: decoding goes on (no exception, no endless loop)', () => {
  const r = rng(11);
  for (let k = 0; k < 30; k++) {
    const b = Buffer.from(MOVIE);
    for (let i = 0; i < 5 + k * 3; i++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
    const { video, audio } = demux(b);
    const v = decodeVideo(video);
    assert.ok(v.frames.length <= 40);
    decodeAudio(audio);
    const file = { size: () => b.length, read: (o, n) => b.subarray(o, o + n) };
    let s; try { s = new MpegSource(file); } catch { continue; }
    for (let t = 0; t < 3 && !s.ended(t); t += 0.04) { s.load(t); s.pictureAt(t); s.audioUntil(t, () => {}); }
  }
});

// ---- more configurations against ffmpeg's decoders (when installed)
let ffmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpeg = true; } catch { /* not installed */ }
const ff = (...a) => execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...a]);

test('MPEG-1 video against ffmpeg: motion range, quantizer matrices, picture structures', { skip: !ffmpeg && 'ffmpeg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-mpeg-'));
  try {
    const cases = [
      ['testsrc2=size=176x144:rate=25', ['-bf', '2', '-g', '12', '-q:v', '3']],
      ['mandelbrot=size=320x240:rate=30', ['-bf', '3', '-g', '30', '-b:v', '600k', '-me_range', '64']], // (large vectors: f_code > 1)
      ['testsrc=size=208x112:rate=24', ['-bf', '0', '-g', '9', '-q:v', '12', '-intra_matrix', Array.from({ length: 64 }, (_, i) => 8 + (i * 3) % 50).join(',')]],
      ['life=size=160x128:rate=25:mold=10', ['-bf', '1', '-g', '6', '-qmin', '1', '-qmax', '31', '-b:v', '200k']],
    ];
    for (const [src, opts] of cases) {
      const es = path.join(dir, 'v.m1v'), yuv = path.join(dir, 'v.yuv');
      ff('-f', 'lavfi', '-i', src, '-t', '2', '-c:v', 'mpeg1video', ...opts, '-f', 'mpeg1video', es);
      ff('-idct', 'simple', '-i', es, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', yuv);
      const [w, h] = src.match(/size=(\d+)x(\d+)/).slice(1).map(Number);
      const { frames, errors } = decodeVideo(fs.readFileSync(es));
      const ref = fs.readFileSync(yuv), F = w * h * 3 / 2;
      assert.equal(errors, 0, src);
      assert.equal(frames.length, ref.length / F, src);
      const worst = Math.min(...frames.map((f, i) => psnr(f, ref.subarray(i * F), w, h)));
      assert.ok(worst > 45, `${src}: worst picture ${worst.toFixed(1)} dB`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MPEG audio layer II against ffmpeg: allocation tables, joint stereo, low sampling frequencies', { skip: !ffmpeg && 'ffmpeg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-mpa-'));
  try {
    const cases = [[48000, 2, '384k', 'mp2'], [44100, 2, '128k', 'mp2'], [32000, 1, '48k', 'mp2'], [48000, 2, '64k', 'mp2'], [22050, 2, '64k', 'mp2'], [24000, 1, '96k', 'mp2'],
      [48000, 2, '64k', 'libtwolame']];
    for (const [rate, ch, br, enc] of cases) {
      const es = path.join(dir, 'a.mp2'), pcm = path.join(dir, 'a.f32');
      try { ff('-f', 'lavfi', '-i', `anoisesrc=d=1.5:c=pink:r=${rate}:a=0.3`, '-ac', String(ch), '-c:a', enc, ...(enc === 'libtwolame' ? ['-mode', 'joint_stereo', '-psymodel', '0'] : []), '-b:a', br, '-ar', String(rate), es); } catch { if (enc === 'libtwolame') continue; throw new Error(`ffmpeg ${enc}`); }
      ff('-c:a', 'mp2float', '-i', es, '-f', 'f32le', pcm);
      const frames = decodeAudio(fs.readFileSync(es));
      const s = snr(frames, f32(fs.readFileSync(pcm)), ch);
      assert.ok(s > 100, `${rate} Hz ${ch} ch ${br} ${enc}: SNR ${s.toFixed(1)} dB`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
