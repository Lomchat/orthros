// MP3 decoding off the emulator's thread (src/media/mp3-host.js, mp3-helper.js; docs/miles-mp3.md): what the game's
// thread reads back is exactly the session's samples, at their places — a decoder that drops or delays samples leaves
// zeros at their time (no shift), output a frame already covered is not written twice, the length is the frames'
// total — through a ring that wraps many times while the reader goes on. The helper's test codec passes 16-bit PCM
// frames through, "decoded" asynchronously; the real decoders (WebCodecs, ffmpeg) are checked on games' streams by
// tools/dev/mp3-compare.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { Mp3Host, ST_DONE } from '../src/media/mp3-host.js';

const helper = () => new Worker(new URL('../src/media/mp3-helper.js', import.meta.url));
const pcm = (n, ch, f) => { const a = new Int16Array(n * ch); for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) a[i * ch + c] = f(i, c); return a; };
const bytes = (a) => new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));

/** read the session until done (the emulator's way: Atomics.wait on the ring), as Int16Array */
function readAll(ses, total, ch, send) {
  const out = new Uint8Array(total * 2 * ch); let got = 0;
  for (let guard = 0; guard < 100000; guard++) {
    send?.(got / (2 * ch));
    got += ses.take(out.subarray(got), out.length - got);
    if (ses.state() === ST_DONE && ses.available() <= 0) break;
    ses.wait(50);
  }
  return { pcm: new Int16Array(out.buffer, 0, got >> 1), got };
}

test('samples land at their time: gaps are zeros, overlaps written once, the end padded to the total', async () => {
  const host = new Mp3Host(helper);
  try {
    const ch = 2, ses = host.open(1000, ch, 'pcm-test');
    const A = pcm(100, ch, (i, c) => 1 + i + c), B = pcm(100, ch, (i, c) => 1000 + i + c), C = pcm(100, ch, (i, c) => 2000 + i + c);
    const all = new Uint8Array(600 * ch); all.set(bytes(A), 0); all.set(bytes(B), 400); all.set(bytes(C), 800);
    // A at 0, B at 150 (50 samples lost before it), C at 200 (its first 50 samples already covered by B)
    ses.send(all, [[0, 0, 400], [150, 400, 400], [200, 800, 400]]);
    ses.end(400);
    const { pcm: out } = readAll(ses, 400, ch);
    assert.equal(out.length, 400 * ch);
    const at = (i, c) => out[i * ch + c];
    for (let i = 0; i < 100; i++) assert.equal(at(i, 1), 1 + i + 1);
    for (let i = 100; i < 150; i++) assert.equal(at(i, 0), 0);
    for (let i = 150; i < 250; i++) assert.equal(at(i, 0), 1000 + i - 150);
    for (let i = 250; i < 300; i++) assert.equal(at(i, 0), 2000 + i - 200);
    for (let i = 300; i < 400; i++) assert.equal(at(i, 1), 0);
    ses.close();
  } finally { host.terminate(); }
});

test('a long session through the ring: sent ahead of the reader within its capacity, every sample in order', async () => {
  const host = new Mp3Host(helper);
  try {
    const ch = 2, spf = 1152, frames = 150, ses = host.open(44100, ch, 'pcm-test'); // (1.35 MB of PCM: the 192 KiB ring wraps 7 times)
    let sent = 0;
    const send = (read) => {
      while (sent < frames && (sent + 1) * spf - read <= ses.cap / (2 * ch) - spf) {
        ses.send(bytes(pcm(spf, ch, (i, c) => ((sent * spf + i) * 7 + c) & 0x7fff)), [[sent * spf, 0, spf * 2 * ch]]);
        if (++sent === frames) ses.end(frames * spf - 100); // (a total shorter than the frames: the excess dropped)
      }
    };
    const { pcm: out } = readAll(ses, frames * spf, ch, send);
    assert.equal(out.length, (frames * spf - 100) * ch);
    for (let i = 0; i < out.length / ch; i++) for (let c = 0; c < ch; c++) if (out[i * ch + c] !== ((i * 7 + c) & 0x7fff)) assert.fail(`sample ${i} channel ${c}: ${out[i * ch + c]}`);
    ses.close();
  } finally { host.terminate(); }
});
