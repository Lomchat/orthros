// Damaged AVI and WAVE files (src/media): opening and playing them ends in bounded time — a chunk size or a header
// field out of range (a 4 GiB strl list, a 16 M-pixel-wide frame, 65535 channels, a 4 GHz rate) is refused or skipped,
// never walked byte by byte nor allocated: the movie player runs on the emulator's thread, so a stall freezes the game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMedia } from '../src/media/open.js';
import { makeAvi } from './media-avi-writer.js';

const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
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
/** open and play `b` for up to 4 s of stream time: the wall time it took */
function playMs(b) {
  const t0 = performance.now();
  let s;
  try { s = openMedia(fileOf(b)); } catch { return performance.now() - t0; } // (refused: what RenderFile reports)
  try {
    for (let t = 0; t < 4 && !s.ended(t); t += 0.04) { s.load(t); if (s.video) s.pictureAt(t); s.audioUntil(t, () => {}); }
  } catch { /* (an exception while playing: the player's failure, quartz.js EC_ERRORABORT) */ }
  return performance.now() - t0;
}

test('damaged AVI / WAVE headers: refused or played in bounded time', () => {
  // the cases found by mutation: a strl list claiming 4 GiB, a frame 16 M pixels wide, 65535 channels, a 4 GHz rate
  const avi = makeAvi(32, 16, 8, 10).bytes;
  const at = (id) => { for (let i = 0; i + 4 < avi.length; i++) if (String.fromCharCode(...avi.subarray(i, i + 4)) === id) return i; return -1; };
  const hugeList = Uint8Array.from(avi), strl = at('strl') - 8; hugeList.set([0xf0, 0xff, 0xff, 0xff], strl + 4);
  const wide = Uint8Array.from(avi), strf = at('strf'); wide.set([0x20, 0x00, 0xff, 0x00], strf + 8 + 4);
  for (const [name, b] of [['4 GiB strl', hugeList], ['16 M-pixel frame', wide], ['65535 channels', wave(1, 65535, 22050, 16, 4, new Uint8Array(4000))], ['4 GHz', wave(1, 2, 0xffffffff, 16, 4, new Uint8Array(4000))], ['align 1 for 16-bit stereo', wave(1, 2, 22050, 16, 1, new Uint8Array(4000))]]) {
    const ms = playMs(b);
    assert.ok(ms < 500, `${name}: ${ms.toFixed(0)} ms`);
  }
  // random mutations of the header and of the whole file
  const imaExt = new Uint8Array([0xf9, 0x01]);
  const bases = { avi, wav: wave(1, 2, 22050, 16, 4, new Uint8Array(4000).map((_, i) => i * 7)), ima: wave(0x11, 1, 22050, 4, 256, new Uint8Array(2048).map((_, i) => i * 13), imaExt) };
  const r = rng(124);
  for (const [name, base] of Object.entries(bases)) {
    for (let k = 0; k < 150; k++) {
      const b = Uint8Array.from(base), n = 1 + Math.floor(r() * 12);
      for (let i = 0; i < n; i++) b[Math.floor(r() * (k % 2 ? b.length : Math.min(b.length, 300)))] = r() < 0.3 ? 0xff : r() < 0.5 ? 0 : Math.floor(r() * 256);
      const ms = playMs(r() < 0.2 ? b.subarray(0, Math.floor(r() * b.length)) : b);
      assert.ok(ms < 1000, `${name} mutation ${k}: ${ms.toFixed(0)} ms`);
    }
  }
});
