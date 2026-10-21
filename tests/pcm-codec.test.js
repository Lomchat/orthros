// The lossless PCM transport codec (src/vfs/pcm-codec.js) and the server's sound finder (src/host/pcm-units.js,
// docs/slow-network.md "Audio units"): every container decodes to exactly the bytes it was made from (checked by hash),
// whatever they are; sampled sound codes smaller than brotli; a damaged container throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { encodePcm, decodePcm, pcmCodedBytes } from '../src/vfs/pcm-codec.js';
import { parseWave, scanWaves, regionsIn, trialLayouts, estimateCoded } from '../src/host/pcm-units.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
/** a sound: a few decaying partials plus noise, as `bits` / `ch` PCM bytes */
function sound(frames, bits, ch, seed = 1) {
  const r = rng(seed), b = new Uint8Array(frames * ch * (bits >> 3)), amp = bits === 8 ? 100 : 20000;
  const parts = Array.from({ length: 4 }, () => [r() * 0.2, r() * 6.28, 0.3 + r() * 0.5]);
  let p = 0;
  for (let i = 0; i < frames; i++) for (let c = 0; c < ch; c++) {
    let v = 0; for (const [f, ph, a] of parts) v += a * Math.sin(i * f * (1 + c * 0.01) + ph);
    v = Math.round(Math.max(-1, Math.min(1, v * Math.exp(-i / (frames * 2)) / 2 + (r() - 0.5) * 0.01)) * amp);
    if (bits === 8) b[p++] = v + 128; else { b[p++] = v & 0xff; b[p++] = (v >> 8) & 0xff; }
  }
  return b;
}
const roundTrip = (b, regions, opts) => { const c = encodePcm(b, regions, opts), d = decodePcm(c); assert.equal(sha(d), sha(b)); return c; };
const wave = (pcm, bits, ch, rate = 22050, tag = 1) => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8, 'latin1'); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(tag, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * ch * (bits >> 3), 28); h.writeUInt16LE(ch * (bits >> 3), 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, Buffer.from(pcm)]);
};

test('codec: every layout round-trips byte-exact, and sound codes well under brotli', () => {
  for (const [bits, ch] of [[16, 1], [16, 2], [8, 1], [8, 2]]) {
    const b = sound(20000, bits, ch, bits + ch), c = roundTrip(b, [{ at: 0, len: b.length, bits, ch }]);
    const br = zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }).length;
    assert.ok(c.length < br * 0.8, `${bits}-bit ${ch} ch: ${c.length} against brotli ${br}`);
    assert.equal(pcmCodedBytes(c), b.length);
  }
});

test('codec: any bytes — noise, constants, silence, extremes, odd lengths, short frames — come back exact', () => {
  const r = rng(7);
  const noise = Uint8Array.from({ length: 70001 }, () => Math.floor(r() * 256));
  const c = roundTrip(noise, [{ at: 0, len: noise.length, bits: 16, ch: 1 }]);
  assert.ok(c.length <= noise.length + 64, 'unpredictable bytes: kept as they are');
  roundTrip(new Uint8Array(50000), [{ at: 0, len: 50000, bits: 16, ch: 2 }]);
  roundTrip(new Uint8Array(50000).fill(0x80), [{ at: 0, len: 50000, bits: 8, ch: 1 }]);
  // full-scale square waves and clicks: the widest residuals (escape codes, side channel 17 bits)
  const sq = new Uint8Array(40000); for (let i = 0; i < sq.length; i += 2) { const v = (i >> 6) & 1 ? 32767 : -32768; sq[i] = v & 0xff; sq[i + 1] = (v >> 8) & 0xff; }
  roundTrip(sq, [{ at: 0, len: sq.length, bits: 16, ch: 1 }]);
  roundTrip(sq, [{ at: 0, len: sq.length, bits: 16, ch: 2 }]);
  const lr = new Uint8Array(40000); for (let i = 0; i < lr.length; i += 4) { lr[i] = 0x00; lr[i + 1] = 0x80; lr[i + 2] = 0xff; lr[i + 3] = 0x7f; } // (left −32768, right 32767)
  roundTrip(lr, [{ at: 0, len: lr.length, bits: 16, ch: 2 }]);
  for (let i = 0; i < 4000; i += 97) noise[i] = 0;
  const s = sound(3001, 16, 1, 3); // (odd frame count, a last frame of 3001 % 2048)
  roundTrip(s, [{ at: 0, len: s.length, bits: 16, ch: 1 }]);
  for (const frame of [64, 256, 1024, 4096, 65536]) roundTrip(s, [{ at: 0, len: s.length, bits: 16, ch: 1 }], { frame });
  roundTrip(new Uint8Array(0), []);
  roundTrip(Uint8Array.of(1, 2, 3), [{ at: 0, len: 3, bits: 16, ch: 1 }]);
});

test('codec: sound regions inside other bytes (headers, other members), cut ones skipped', () => {
  const a = sound(9000, 16, 1, 5), b8 = sound(12000, 8, 1, 6), text = Buffer.from('not a sound at all '.repeat(300));
  const all = Buffer.concat([text, a, text.subarray(0, 77), b8, text]);
  const at1 = text.length, at2 = at1 + a.length + 77;
  const c = roundTrip(all, [{ at: at1, len: a.length, bits: 16, ch: 1 }, { at: at2, len: b8.length, bits: 8, ch: 1 }]);
  assert.equal(pcmCodedBytes(c), a.length + b8.length);
  // a region past the end, overlapping ones, one too short: still exact
  roundTrip(all, [{ at: at1, len: a.length + 10, bits: 16, ch: 1 }, { at: at1 + 100, len: 5000, bits: 16, ch: 1 }, { at: at2, len: 20, bits: 8, ch: 1 }, { at: all.length - 1000, len: 9000, bits: 16, ch: 2 }]);
});

test('codec: a damaged, cut or foreign container throws (never wrong bytes)', () => {
  const b = sound(8000, 16, 1, 9), c = encodePcm(b, [{ at: 0, len: b.length, bits: 16, ch: 1 }]);
  assert.throws(() => decodePcm(c.subarray(0, c.length - 1)));
  assert.throws(() => decodePcm(c.subarray(0, 10)));
  assert.throws(() => decodePcm(new Uint8Array(100)));
  let caught = 0;
  for (let i = 30; i < c.length; i += Math.max(1, c.length >> 6)) {
    const d = c.slice(); d[i] ^= 0x10;
    try { const out = decodePcm(d); assert.equal(sha(out), sha(b), 'a flip the CRC let through must not change the bytes'); } catch { caught++; }
  }
  assert.ok(caught > 0);
});

test('sound finder: RIFF WAVE PCM found in a file or inside an archive, other formats not', () => {
  const a = sound(5000, 8, 1, 2), s = sound(4000, 16, 2, 3), adpcm = wave(sound(3000, 16, 1, 4), 4, 1, 22050, 0x11);
  const w1 = wave(a, 8, 1), w2 = wave(s, 16, 2);
  assert.deepEqual(parseWave(w1, 0, w1.length), { start: 44, end: 44 + a.length, bits: 8, ch: 1, next: w1.length });
  assert.equal(parseWave(adpcm, 0, adpcm.length), null, 'IMA ADPCM: not PCM');
  const junk = Buffer.from('RIFF....junk'), arch = Buffer.concat([Buffer.from('BIGF header'), w1, junk, adpcm, Buffer.alloc(3), w2, Buffer.from('tail')]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-pcm-')), f = path.join(dir, 'a.big');
  try {
    fs.writeFileSync(f, arch);
    const at1 = 11, at2 = at1 + w1.length + junk.length + adpcm.length + 3;
    const waves = scanWaves(f);
    assert.deepEqual(waves, [{ start: at1 + 44, end: at1 + 44 + a.length, bits: 8, ch: 1 }, { start: at2 + 44, end: at2 + 44 + s.length, bits: 16, ch: 2 }]);
    // a unit cut inside the stereo sound starts on its next sample frame
    const cut = at2 + 44 + 1001, rs = regionsIn(waves, cut, cut + 4096);
    assert.deepEqual(rs, [{ at: 3, len: 4092, bits: 16, ch: 2 }]);
    const unit = arch.subarray(cut, cut + 4096);
    assert.equal(sha(decodePcm(encodePcm(unit, rs))), sha(unit));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('trial layouts: a raw 16-bit bank estimates well under its bytes, noise does not', () => {
  const s = sound(30000, 16, 1, 11), r = rng(3), noise = Uint8Array.from({ length: 60000 }, () => Math.floor(r() * 256));
  const est = (b) => Math.min(...trialLayouts(b.length).map((l) => estimateCoded(b, l)));
  assert.ok(est(s) < s.length * 0.7, `sound ${est(s)} of ${s.length}`);
  assert.ok(est(noise) > noise.length * 0.9, `noise ${est(noise)} of ${noise.length}`);
});
