// Recovers the synthesis window D[0..511] of MPEG audio layers I / II (ISO/IEC 11172-3 table B.3, a constant of the
// standard) from a reference decoding, and writes src/media/mpeg-audio-window.js.
//
// Each output sample j of a 32-sample block is sum_i D[j + 32 i] * U[j + 32 i] (16 terms), with U computed by the
// decoder of src/media/mpeg-audio.js before windowing: given a stream and its reference decoding (32-bit float PCM),
// D is the least-squares solution of 32 independent 16-unknown systems. The table of the standard is in units of 2^-16;
// the tool checks that every fitted value is within 1e-4 of such a multiple (else something else in the decoder is
// wrong) and that the second half mirrors the first.
//
// Usage: node tools/mpa-window-fit.mjs <stream.mp2> <reference.f32le> [--write]
//   e.g. ffmpeg -f lavfi -i anoisesrc=d=6:c=pink:r=48000 -ac 2 -c:a mp2 -b:a 384k n.mp2
//        ffmpeg -c:a mp2float -i n.mp2 -f f32le n.f32
import { readFileSync, writeFileSync } from 'node:fs';
import { MpegAudioDecoder } from '../src/media/mpeg-audio.js';

const [file, refFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const data = readFileSync(file), ref = new Float32Array(readFileSync(refFile).buffer.slice(0));
const ata = Array.from({ length: 32 }, () => new Float64Array(256)), atb = Array.from({ length: 32 }, () => new Float64Array(16));
const u = new Float64Array(16);
const dec = new MpegAudioDecoder();
let block = 0, nch = 2, rows = 0;
dec.emit = function (ch, out, o) {
  this.synth[ch].run(this.sb[ch], this.pcm, 0, new Float64Array(512));
  const t = block + o / 32;
  for (let j = 0; j < 32; j++) {
    const y = ref[(t * 32 + j) * nch + ch];
    if (y === undefined) return;
    this.synth[ch].inputs(j, u);
    const A = ata[j], B = atb[j];
    for (let a = 0; a < 16; a++) { B[a] += u[a] * y; for (let b = 0; b < 16; b++) A[a * 16 + b] += u[a] * u[b]; }
    rows++;
  }
};
for (let i = 0; i + 4 < data.length;) {
  const f = dec.decodeFrame(data, i);
  if (!f) { i++; continue; }
  nch = f.channels; block += f.samples[0].length / 32; i += dec.header.bytes;
}
function solve(A, b, n) { // Gaussian elimination with partial pivoting
  const M = Array.from({ length: n }, (_, r) => [...A.subarray(r * n, r * n + n), b[r]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let k2 = c; k2 <= n; k2++) M[r][k2] -= k * M[c][k2]; }
  }
  return M.map((row, r) => row[n] / row[r]);
}
// (the matrixing makes V[16 + 64 m] zero: the window values applied to those inputs never matter — left out of the fit,
// and taken from their mirror)
const D = new Float64Array(512), free = new Uint8Array(512);
for (let j = 0; j < 32; j++) {
  const A = ata[j], keep = [];
  for (let i = 0; i < 16; i++) if (A[i * 16 + i] > 1e-9 * rows) keep.push(i); else free[j + 32 * i] = 1;
  const n = keep.length, As = new Float64Array(n * n), bs = new Float64Array(n);
  keep.forEach((a, r) => { bs[r] = atb[j][a]; keep.forEach((b, c) => { As[r * n + c] = A[a * 16 + b]; }); });
  const x = solve(As, bs, n);
  keep.forEach((i, r) => { D[j + 32 * i] = x[r]; });
}
const mirror = (i) => (i % 64 === 0 ? 1 : -1);
for (let i = 1; i < 512; i++) if (free[i] && !free[512 - i]) D[i] = mirror(i) * D[512 - i];
console.log(`window values never used by the matrixing: ${[...free.keys()].filter((i) => free[i]).join(' ')}`);
let worst = 0, asym = 0;
const ints = Array.from(D, (v) => Math.round(v * 65536));
for (let i = 0; i < 512; i++) if (!free[i]) worst = Math.max(worst, Math.abs(D[i] * 65536 - ints[i]));
for (let i = 1; i < 256; i++) if (!free[i] && !free[512 - i]) asym = Math.max(asym, Math.abs(ints[512 - i] - mirror(i) * ints[i]));
if (process.argv.includes("--dump")) for (const i of [1,2,31,32,33,63,64,65,96,127,128,129,160,192,224,255,256]) console.log(i, ints[i], ints[512 - i]);
console.log(`${rows} equations; largest distance to a multiple of 2^-16: ${worst.toFixed(6)} units; asymmetry ${asym}; D[256] = ${ints[256]} / 65536`);
if (worst > 1e-4 * 65536 || asym) { console.log('not a clean fit: the table is not written'); process.exit(1); }
if (process.argv.includes('--write')) {
  const half = ints.slice(0, 257), lines = [];
  for (let i = 0; i < half.length; i += 16) lines.push('  ' + half.slice(i, i + 16).join(', ') + ',');
  writeFileSync(new URL('../src/media/mpeg-audio-window.js', import.meta.url), `// The polyphase synthesis window of MPEG audio layers I and II (ISO/IEC 11172-3 table B.3), D[0..256] in units of
// 2^-16 (the other half follows by symmetry, see mpeg-audio.js). Produced by tools/mpa-window-fit.mjs.
export const SYNTH_WINDOW_HALF = new Int32Array([
${lines.join('\n')}
]);
`);
  console.log('src/media/mpeg-audio-window.js written');
}
