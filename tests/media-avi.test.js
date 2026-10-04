// AVI files of the DirectShow path (src/media/avi-source.js, vfw-codecs.js): a file written here (uncompressed DIB frames
// + PCM, palette changes, 'rec ' lists, idx1) decoded exactly; Cinepak, Microsoft Video 1, Microsoft RLE, uncompressed
// DIBs and the audio formats against ffmpeg when it is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openMedia } from '../src/media/open.js';
import { makeAvi } from './media-avi-writer.js';

let ffmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpeg = true; } catch { /* not installed */ }
const ff = (...a) => execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...a]);
const fileOf = (b) => ({ size: () => b.length, read: (o, n) => b.subarray(o, o + n) });

test('AVI written here: paletted frames, a palette change, interleaved PCM, timing', () => {
  const W = 12, H = 8, fps = 10, N = 7;
  const { bytes, frames, sound, pal } = makeAvi(W, H, N, fps);
  const s = openMedia(fileOf(bytes));
  assert.equal(s.kind, 'avi'); assert.equal(s.width, W); assert.equal(s.height, H); assert.equal(s.fps, fps);
  assert.equal(s.audioRate, 8000); assert.equal(s.audioChannels, 1); assert.ok(Math.abs(s.duration - N / fps) < 1e-9);
  const P = pal.slice(); let shown = 0, samples = [];
  for (let t = 0; t < 2 && !s.ended(t); t += 0.025) {
    s.load(t);
    const p = s.pictureAt(t);
    if (p) {
      const f = s.frameIndex - 1;
      if (f === 2) P.splice(0, 8, 30, 20, 10, 0, 60, 50, 40, 0); // (PALETTEENTRY: red, green, blue; P: as RGBQUAD, blue first)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = frames[f][(H - 1 - y) * W + x], o = 4 * (y * W + x);
        assert.deepEqual(Array.from(p.rgba.subarray(o, o + 4)), [P[4 * v + 2], P[4 * v + 1], P[4 * v], 255], `frame ${f} (${x}, ${y})`);
      }
      assert.ok(Math.abs(s.frameTime(f) - f / fps) < 1e-9 && s.frameTime(f) <= t);
      shown++;
    }
    s.audioUntil(t + 0.1, (smp, start) => { assert.ok(Math.abs(start - samples.length / 8000) < 1e-9); samples.push(...smp[0]); });
  }
  assert.equal(shown, N); assert.equal(s.frameIndex, N);
  const want = sound.flatMap((a) => Array.from(a, (v) => v / 32768));
  assert.deepEqual(samples, want);
});

test('AVI codecs against ffmpeg: Cinepak (color, gray, strips), Microsoft Video 1, RLE8, DIB 8 / 16 / 24-bit; audio formats', { skip: !ffmpeg && 'ffmpeg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-avi-'));
  try {
    const W = 160, H = 120;
    const cases = [
      ['testsrc2', ['-c:v', 'cinepak', '-g', '30', '-max_strips', '4', '-min_strips', '2'], 50],
      ['testsrc', ['-c:v', 'cinepak', '-pix_fmt', 'gray', '-g', '50'], 50],
      ['testsrc2', ['-c:v', 'msvideo1'], 50],
      ['testsrc2', ['-c:v', 'msrle', '-pix_fmt', 'pal8'], 99],
      ['testsrc2', ['-c:v', 'rawvideo', '-pix_fmt', 'bgr24'], 99],
      ['testsrc2', ['-c:v', 'rawvideo', '-pix_fmt', 'pal8'], 99],
      ['testsrc2', ['-c:v', 'rawvideo', '-pix_fmt', 'rgb555le'], 50], // (5-bit expansion: rounding)
    ];
    for (const [src, opts, min] of cases) {
      const avi = path.join(dir, 'v.avi'), rgba = path.join(dir, 'v.rgba');
      ff('-f', 'lavfi', '-i', `${src}=size=${W}x${H}:rate=15`, '-t', '2', ...opts, avi);
      ff('-i', avi, '-f', 'rawvideo', '-pix_fmt', 'rgba', rgba);
      const ref = fs.readFileSync(rgba), F = W * H * 4, s = openMedia(fileOf(fs.readFileSync(avi)));
      let worst = 99;
      for (let k = 0; k < 30; k++) {
        const t = k / 15 + 0.001; s.load(t); const p = s.pictureAt(t);
        assert.ok(p, `${opts.join(' ')}: picture ${k}`);
        const r = ref.subarray(k * F, (k + 1) * F); let se = 0;
        for (let i = 0; i < F; i++) if ((i & 3) !== 3) se += (p.rgba[i] - r[i]) ** 2;
        worst = Math.min(worst, se ? 10 * Math.log10(255 * 255 * W * H * 3 / se) : 99);
      }
      assert.ok(worst >= min, `${opts.join(' ')}: worst picture ${worst.toFixed(1)} dB`);
    }
    // sound streams in AVI files
    for (const [codec, ch, rate, exact] of [['pcm_s16le', 2, 22050, true], ['adpcm_ms', 1, 22050, true], ['adpcm_ima_wav', 2, 44100, false], ['mp2', 2, 44100, false]]) {
      const avi = path.join(dir, 'a.avi'), pcm = path.join(dir, 'a.f32');
      ff('-f', 'lavfi', '-i', `testsrc2=size=64x48:rate=10`, '-f', 'lavfi', '-i', `anoisesrc=d=2:c=pink:r=${rate}:a=0.3`, '-t', '2', '-c:v', 'rawvideo', '-pix_fmt', 'bgr24', '-c:a', codec, '-ac', String(ch), '-ar', String(rate), avi);
      ff(...(codec === 'mp2' ? ['-c:a', 'mp2float'] : []), '-i', avi, '-map', '0:a', '-f', 'f32le', '-c:a', 'pcm_f32le', pcm);
      const b = fs.readFileSync(pcm), ref = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), s = openMedia(fileOf(fs.readFileSync(avi)));
      assert.equal(s.audioChannels, ch); assert.equal(s.audioRate, rate);
      let n = 0, se = 0, sp = 0;
      for (let t = 0; t < 3 && !s.audioDone; t += 0.1) { s.load(t); s.audioUntil(t, (smp) => { for (let i = 0; i < smp[0].length; i++, n++) for (let c = 0; c < ch; c++) { const y = ref[n * ch + c] ?? 0; se += (smp[c][i] - y) ** 2; sp += y * y; } }); }
      const snr = se ? 10 * Math.log10(sp / se) : Infinity;
      assert.ok(s.audioDone, codec);
      assert.ok(Math.abs(n - ref.length / ch) <= (codec === 'mp2' ? 1152 : 0), `${codec}: ${n} samples, ffmpeg ${ref.length / ch}`);
      assert.ok(exact ? snr === Infinity || snr > 200 : snr > 38, `${codec}: SNR ${snr.toFixed(1)} dB`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
