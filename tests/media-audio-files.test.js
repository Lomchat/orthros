// Audio files of the DirectShow path (src/media): RIFF WAVE (PCM, float, IMA / Microsoft ADPCM) and MPEG audio layer III
// through the browser's asynchronous decoder (WebCodecs AudioDecoder, here a stand-in; tools/media-browser-check.mjs
// checks the real one against ffmpeg).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openMedia } from '../src/media/open.js';

const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const f32 = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
let ffmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpeg = true; } catch { /* not installed */ }
const ff = (...a) => execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...a]);

/** a WAVE file: format tag, channels, rate, bits, block align, data bytes (and the cbSize extension bytes) */
function wave(tag, ch, rate, bits, align, data, ext = new Uint8Array(0)) {
  const fmtLen = 16 + (tag === 1 || tag === 3 ? 0 : 2 + ext.length), b = new Uint8Array(12 + 8 + fmtLen + 8 + data.length), dv = new DataView(b.buffer);
  const str = (o, s) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, b.length - 8, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, fmtLen, true);
  dv.setUint16(20, tag, true); dv.setUint16(22, ch, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * align, true); dv.setUint16(32, align, true); dv.setUint16(34, bits, true);
  if (fmtLen > 16) { dv.setUint16(36, ext.length, true); b.set(ext, 38); }
  str(20 + fmtLen, 'data'); dv.setUint32(24 + fmtLen, data.length, true); b.set(data, 28 + fmtLen);
  return b;
}
const fileOf = (b) => ({ size: () => b.length, read: (o, n) => b.subarray(o, o + n) });
function playAll(s) { const ch = []; s.audioUntil(1e9, (smp, start) => ch.push({ smp, start })); return ch; }

test('RIFF WAVE: integer and float PCM decoded exactly, in pieces with their times', () => {
  const r = rng(9), n = 70000; // (several 256 KiB reads at 16-bit stereo)
  const v = Float64Array.from({ length: 2 * n }, () => Math.round((r() * 2 - 1) * 32767) / 32768);
  const s16 = new Uint8Array(4 * n), dv = new DataView(s16.buffer); v.forEach((x, i) => dv.setInt16(2 * i, Math.round(x * 32768), true));
  const fl = new Uint8Array(8 * n), fv = new DataView(fl.buffer); v.forEach((x, i) => fv.setFloat32(4 * i, x, true));
  const u8 = Uint8Array.from({ length: n }, (_, i) => 128 + Math.round(v[i] * 127));
  for (const [file, ch, check] of [[wave(1, 2, 44100, 16, 4, s16), 2, (c, i) => v[i * 2 + c]], [wave(3, 2, 48000, 32, 8, fl), 2, (c, i) => Math.fround(v[i * 2 + c])], [wave(1, 1, 11025, 8, 1, u8), 1, (c, i) => (u8[i] - 128) / 128]]) {
    const s = openMedia(fileOf(file));
    assert.equal(s.kind, 'wav'); assert.equal(s.audioChannels, ch); assert.ok(!s.video);
    const pieces = playAll(s);
    assert.ok(s.audioDone && s.ended(s.audioEnd));
    let i = 0;
    for (const p of pieces) { assert.ok(Math.abs(p.start - i / s.audioRate) < 1e-9); for (let k = 0; k < p.smp[0].length; k++, i++) for (let c = 0; c < ch; c++) assert.equal(p.smp[c][k], Math.fround(check(c, i))); }
    assert.equal(i, n); assert.ok(Math.abs(s.duration - n / s.audioRate) < 1e-9);
  }
  assert.throws(() => openMedia(fileOf(wave(0x161, 2, 44100, 16, 4, new Uint8Array(100)))), /format tag 0x161/); // (Windows Media Audio: not here)
});

test('RIFF WAVE against ffmpeg: 24-bit PCM, IMA ADPCM, Microsoft ADPCM', { skip: !ffmpeg && 'ffmpeg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-wav-'));
  try {
    for (const [codec, ch, rate, min] of [['pcm_s24le', 2, 48000, 200], ['adpcm_ms', 1, 22050, 200], ['adpcm_ms', 2, 44100, 200], ['adpcm_ima_wav', 1, 22050, 38], ['adpcm_ima_wav', 2, 44100, 38]]) {
      // (IMA ADPCM: the reference algorithm's step arithmetic, which ffmpeg computes otherwise: a rounding difference)
      const w = path.join(dir, 'a.wav'), pcm = path.join(dir, 'a.f32');
      ff('-f', 'lavfi', '-i', `anoisesrc=d=1.2:c=pink:r=${rate}:a=0.4`, '-ac', String(ch), '-ar', String(rate), '-c:a', codec, w);
      ff('-i', w, '-f', 'f32le', '-c:a', 'pcm_f32le', pcm);
      const s = openMedia(fileOf(fs.readFileSync(w))), ref = f32(fs.readFileSync(pcm));
      let se = 0, sp = 0, n = 0;
      for (const p of playAll(s)) { for (let i = 0; i < p.smp[0].length; i++, n++) for (let c = 0; c < ch; c++) { const y = ref[n * ch + c]; se += (p.smp[c][i] - y) ** 2; sp += y * y; } }
      assert.equal(n, ref.length / ch, codec);
      const snrdb = se ? 10 * Math.log10(sp / se) : Infinity;
      assert.ok(snrdb > min, `${codec} ${ch} ch: SNR ${snrdb.toFixed(1)} dB`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MPEG audio layer III through an asynchronous decoder (WebCodecs interface): ahead, in order, the end, a failure', async () => {
  // a stand-in for the browser's AudioDecoder: each chunk decodes (later) to its frame's samples, all equal to its start
  const made = [];
  class FakeDecoder {
    constructor(init) { this.init = init; this.queue = []; this.state = 'unconfigured'; made.push(this); }
    configure(c) { this.config = c; this.state = 'configured'; if (c.codec !== 'mp3') throw new Error('codec'); }
    decode(chunk) { this.queue.push(chunk); setTimeout(() => this.drain(), 1); }
    drain() {
      for (const ch of this.queue.splice(0)) {
        if (this.failAt !== undefined && ch.timestamp >= this.failAt) { this.init.error(new Error('broken')); return; }
        this.init.output({ numberOfFrames: 1152, numberOfChannels: this.config.numberOfChannels, timestamp: ch.timestamp, copyTo: (a) => a.fill(ch.timestamp / 1e6), close() {} });
      }
    }
    flush() { return new Promise((r) => setTimeout(() => { this.drain(); r(); }, 2)); }
    close() { this.state = 'closed'; }
  }
  // an MP3-like elementary stream: layer III frame headers (MPEG-1, 128 kbit/s, 44.1 kHz, stereo) with empty bodies
  const frame = new Uint8Array(417); frame.set([0xff, 0xfb, 0x90, 0x00]);
  const nframes = 120, data = new Uint8Array(417 * nframes); for (let i = 0; i < nframes; i++) data.set(frame, 417 * i);
  const saved = [globalThis.AudioDecoder, globalThis.EncodedAudioChunk];
  assert.throws(() => openMedia(fileOf(data)), /layer III/, 'no decoder: unsupported, as before');
  globalThis.AudioDecoder = FakeDecoder; globalThis.EncodedAudioChunk = class { constructor(o) { Object.assign(this, o); } };
  try {
    const s = openMedia(fileOf(data));
    assert.ok(s.audio && s.audioAsync); assert.equal(s.audioRate, 44100); assert.equal(s.audioChannels, 2);
    const got = [];
    let t = 0, maxAhead = 0;
    for (let k = 0; k < 400 && !s.ended(t); k++) {
      t += 0.05; s.audioUntil(t, (smp, start) => got.push({ smp, start }));
      maxAhead = Math.max(maxAhead, s.submitPos / 44100 - t);
      await new Promise((r) => setTimeout(r, 3));
    }
    assert.ok(s.audioDone, 'the end once the decoder is flushed');
    assert.ok(maxAhead > 0.9 && maxAhead < 1.1, `submitted ${maxAhead.toFixed(2)} s ahead`);
    assert.equal(got.length, nframes);
    got.forEach((g, i) => { assert.ok(Math.abs(g.start - i * 1152 / 44100) < 1e-6); assert.equal(g.smp.length, 2); assert.ok(Math.abs(g.smp[1][0] - g.start) < 1e-6); });
    // a decoder failing midway: the stream ends (silent from there) instead of waiting forever
    const s2 = openMedia(fileOf(data));
    made.at(-1).failAt = 1e6; // (from 1 s on)
    let t2 = 0, n2 = 0;
    for (let k = 0; k < 400 && !s2.ended(t2); k++) { t2 += 0.05; s2.audioUntil(t2, () => n2++); await new Promise((r) => setTimeout(r, 3)); }
    assert.ok(s2.audioDone && n2 < nframes && n2 >= 30, `${n2} frames before the failure`);
    // the same stream in a WAVE file (format 0x55, as Windows' ACM plays it): its data chunk as an MPEG stream
    const s3 = openMedia(fileOf(wave(0x55, 2, 44100, 0, 1, data, new Uint8Array(12))));
    assert.ok(s3.audioAsync); assert.equal(s3.kind, 'mpeg-audio');
    const got3 = [];
    for (let t3 = 0, k = 0; k < 400 && !s3.ended(t3); k++) { t3 += 0.05; s3.audioUntil(t3, (smp, start) => got3.push(start)); await new Promise((r) => setTimeout(r, 3)); }
    assert.equal(got3.length, nframes);
  } finally { [globalThis.AudioDecoder, globalThis.EncodedAudioChunk] = saved; }
});
