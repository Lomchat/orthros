// Checks the browser-side parts of the DirectShow path in headless Chromium against ffmpeg:
// - MPEG audio layer III (MP3) decoded through WebCodecs (src/media/mpeg-source.js AsyncAudio), compared with ffmpeg's
//   decoding;
// - the video layer's VideoFrame path (BrowserDisplay.presentVideoYuv): an I420 picture drawn on an OffscreenCanvas
//   compared with the RGBA conversion of src/media/yuv.js.
// Usage: tools/with-browser-slot.sh node tools/media-browser-check.mjs   (needs ffmpeg with libmp3lame)
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-media-'));
const ff = (...a) => execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...a]);
const cases = [['44100', '2', '128k'], ['22050', '1', '64k'], ['48000', '2', '320k']];
for (const [rate, ch, br] of cases) {
  ff('-f', 'lavfi', '-i', `anoisesrc=d=2:c=pink:r=${rate}:a=0.3`, '-ac', ch, '-ar', rate, '-c:a', 'libmp3lame', '-b:a', br, path.join(dir, `a${rate}.mp3`));
  ff('-c:a', 'mp3float', '-i', path.join(dir, `a${rate}.mp3`), '-f', 'f32le', path.join(dir, `a${rate}.f32`));
}
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader'] });
let failed = 0;
try {
  const page = await browser.newPage();
  await page.route('http://localhost:9/**', (r) => {
    const u = new URL(r.request().url()).pathname;
    const file = u.startsWith('/m/') ? path.join(dir, u.slice(3)) : path.join(root, u);
    if (u === '/') return r.fulfill({ body: '<!doctype html><title>media</title>', contentType: 'text/html' });
    if (!fs.existsSync(file)) return r.fulfill({ status: 404 });
    r.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream' });
  });
  page.on('console', (m) => console.log('[page]', m.text()));
  await page.goto('http://localhost:9/'); // (localhost: a secure context, where WebCodecs exists)
  for (const [rate, ch] of cases) {
    const pcm = await page.evaluate(async (name) => {
      const { openMedia } = await import('/src/media/open.js');
      const data = new Uint8Array(await (await fetch(name)).arrayBuffer());
      const s = openMedia({ size: () => data.length, read: (o, n) => data.subarray(o, o + n) }, { log: (m) => console.log(m) });
      const chunks = []; let t = 0;
      for (let i = 0; i < 2000 && !s.audioDone; i++) { t += 0.05; s.audioUntil(t, (smp, start) => chunks.push({ start, smp: smp.map((a) => Array.from(a)) })); await new Promise((r) => setTimeout(r, 2)); }
      return { kind: s.kind, async: !!s.audioAsync, rate: s.audioRate, done: s.audioDone, chunks };
    }, `/m/a${rate}.mp3`);
    const refb = fs.readFileSync(path.join(dir, `a${rate}.f32`)), ref = new Float32Array(refb.buffer.slice(refb.byteOffset, refb.byteOffset + refb.length));
    const n = Number(ch);
    // (ffmpeg drops the encoder's delay and padding announced by the LAME header, and the header frame itself; the
    // browser's decoder — as Windows' MPEG layer-3 decoder — plays every frame: compared at the best offset)
    const all = Array.from({ length: n }, () => []);
    let contiguous = true, expect = 0;
    for (const c of pcm.chunks) { const at = Math.round(c.start * pcm.rate); if (at !== expect) contiguous = false; for (let k = 0; k < n; k++) all[k].push(...c.smp[k]); expect = at + c.smp[0].length; }
    const total = all[0].length;
    let best = -Infinity, lag = 0;
    for (let d = 0; d <= 4000; d++) {
      let se = 0, sp = 0;
      for (let i = 0; i < ref.length / n; i += 7) for (let k = 0; k < n; k++) { const x = all[k][i + d]; if (x === undefined) continue; const y = ref[i * n + k]; se += (x - y) ** 2; sp += y * y; }
      const v = 10 * Math.log10(sp / se); if (v > best) { best = v; lag = d; }
    }
    const snr = best;
    const ok = pcm.async && pcm.done && contiguous && total >= ref.length / n && snr > 60;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} mp3 ${rate} Hz ${ch} ch: WebCodecs ${pcm.async}, ${total} samples (ffmpeg ${ref.length / n}), contiguous ${contiguous}, SNR ${snr.toFixed(1)} dB at an offset of ${lag} samples`);
  }
  // the VideoFrame path's colors against the RGBA conversion
  const diff = await page.evaluate(async () => {
    const { yuv420ToRgba } = await import('/src/media/yuv.js');
    const W = 64, H = 48, y = new Uint8Array(W * H), cb = new Uint8Array(W * H / 4), cr = new Uint8Array(W * H / 4);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) y[j * W + i] = 16 + ((i * 219) / (W - 1) | 0);
    for (let j = 0; j < H / 2; j++) for (let i = 0; i < W / 2; i++) { cb[j * W / 2 + i] = 16 + (j * 224 / (H / 2 - 1) | 0); cr[j * W / 2 + i] = 240 - (i * 224 / (W / 2 - 1) | 0); }
    const buf = new Uint8Array(W * H * 3 / 2); buf.set(y); buf.set(cb, W * H); buf.set(cr, W * H * 5 / 4);
    const vf = new VideoFrame(buf, { format: 'I420', codedWidth: W, codedHeight: H, timestamp: 0, colorSpace: { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false } });
    const c = new OffscreenCanvas(W, H), ctx = c.getContext('2d'); ctx.drawImage(vf, 0, 0); vf.close();
    const got = ctx.getImageData(0, 0, W, H).data, want = yuv420ToRgba({ y, cb, cr, stride: W, cstride: W / 2 }, 0, 0, W, H, new Uint8ClampedArray(W * H * 4));
    let max = 0, sum = 0; for (let i = 0; i < got.length; i++) { if ((i & 3) === 3) continue; const d = Math.abs(got[i] - want[i]); max = Math.max(max, d); sum += d; }
    return { max, mean: sum / (W * H * 3) };
  });
  const vok = diff.mean < 3; // (the canvas samples the chroma planes bilinearly where the RGBA conversion repeats them)
  if (!vok) failed++;
  console.log(`${vok ? 'ok  ' : 'FAIL'} VideoFrame I420 colors vs yuv.js: mean difference ${diff.mean.toFixed(2)}, max ${diff.max}`);
} finally {
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
