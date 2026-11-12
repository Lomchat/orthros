#!/usr/bin/env node
// Miles' MP3 decoder against the host's (docs/miles-mp3.md): the streams a game decoded with the guest's own decoder
// (`startbench --mp3-capture <dir>`: each stream's MP3 input as the decoder fetched it and the PCM it returned) decoded
// again by the host path — src/media/mp3-host.js and its helper, ffmpeg in Node or, with --browser, the browser's
// WebCodecs AudioDecoder in a Chromium page (the path players get) — and compared: length, channels / rate, the lag
// that aligns them best, the signal-to-error ratio over the aligned samples, the largest difference.
// Usage: node tools/dev/mp3-compare.mjs <capture dir> [--browser] [--max <streams>] [--only <id,...>] [--blocks]
//   (--browser starts Chromium: run it through tools/with-browser-slot.sh)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mpegAudioHeader } from '../../src/media/mpeg-ps.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const browser = args.includes('--browser');
const max = args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : Infinity;
if (!dir) { console.error('usage: mp3-compare.mjs <capture dir> [--browser] [--max n]'); process.exit(2); }

/** a captured stream: the MP3 input from the decoder's last rewind (its first process call reads from offset 0 again) */
function loadStream(id) {
  const mp3 = fs.readFileSync(path.join(dir, `${id}.mp3`)), pcm = fs.readFileSync(path.join(dir, `${id}.pcm`));
  const log = fs.existsSync(path.join(dir, `${id}.log`)) ? fs.readFileSync(path.join(dir, `${id}.log`), 'utf8') : '';
  const rewinds = [...log.matchAll(/fetch offset (-?\d+) at (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  if (rewinds.some(([off]) => off !== 0) || /ASI_stream_seek/.test(log)) return null; // (seeks: not compared)
  const from = rewinds.length ? rewinds[rewinds.length - 1][1] : 0;
  return { id, mp3: new Uint8Array(mp3.subarray(from)), pcm: new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1) };
}

/** frames as miles-mp3.js parses them: Layer III, the first header's version and rate, two headers in a row to sync */
function frames(b) {
  const out = []; let fmt = null, synced = false;
  const at = (i) => { const h = b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0 ? mpegAudioHeader(b, i) : null; return !h || h.layer !== 3 || !h.bytes || (fmt && (h.version !== fmt.version || h.rate !== fmt.rate)) ? null : h; };
  for (let i = 0; i + 4 <= b.length;) {
    const h = at(i);
    if (!h) { i++; synced = false; continue; }
    if (i + h.bytes > b.length) break;
    if (!synced) { if (i + h.bytes + 4 > b.length || !at(i + h.bytes)) { i++; continue; } synced = true; }
    fmt ??= { version: h.version, rate: h.rate, ch: h.channels };
    const crc = h.crc ? 2 : 0, q = i + 4 + crc, mono = h.channels === 1, side = h.version === 1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    out.push([i, h.bytes, h.samples, h.version === 1 ? (b[q] << 1) | (b[q + 1] >> 7) : b[q], h.bytes - 4 - crc - side]); i += h.bytes;
  }
  return { fmt, frames: out };
}

/** decode through Mp3Host (Node: worker_threads + ffmpeg): Int16Array interleaved */
async function decodeNode(s) {
  const { Worker } = await import('node:worker_threads');
  const { Mp3Host, ST_DONE, ST_FAILED } = await import('../../src/media/mp3-host.js');
  const host = new Mp3Host(() => new Worker(new URL('../../src/media/mp3-helper.js', import.meta.url)), (m) => console.log(m));
  try { return await decodeWith(host, s, ST_DONE, ST_FAILED, (ms) => new Promise((r) => setTimeout(r, ms))); } finally { host.terminate(); }
}
/** (also run in the page) send every frame, read the ring until the session is done */
async function decodeWith(host, s, ST_DONE, ST_FAILED, sleep) {
  const { fmt, frames: fr } = s.parsed, ses = host.open(fmt.rate, fmt.ch), B = 2 * fmt.ch;
  let total = 0; const list = [];
  for (const [at, len, n] of fr) { list.push([total, at, len]); total += n; }
  const out = new Uint8Array(total * B); let got = 0, k = 0;
  // (sent in parts: the ring holds ~1 s; what is sent and not read must fit)
  while (k < list.length || got < out.length) {
    if (k < list.length && list[k][0] + 4 * 1152 - got / B <= ses.cap / B - 1152) {
      const part = list.slice(k, k + 4), a = part[0][1], z = part[part.length - 1][1] + part[part.length - 1][2];
      ses.send(s.mp3.slice(a, z), part.map(([st, at, len]) => [st, at - a, len])); k += part.length;
      if (k === list.length) ses.end(total);
      continue;
    }
    const n = ses.take(out.subarray(got), out.length - got); got += n;
    if (ses.state() === ST_FAILED) throw new Error('decoder failed');
    if (!n) { if (ses.state() === ST_DONE && ses.available() <= 0) break; await sleep(2); }
  }
  ses.close();
  // (as miles-mp3.js: the first frames whose data begins before the stream's first byte are not heard)
  let skip = 0, resv = 0;
  for (const f of fr) { if (f[3] <= resv) break; skip += f[2]; resv += f[4]; }
  return { pcm: new Int16Array(out.buffer, skip * B, Math.max(0, (got >> 1) - skip * fmt.ch)), ch: fmt.ch, rate: fmt.rate, skipped: skip };
}

/** the best lag (samples, test against ref) within ±maxLag on the first channel, and the signal-to-error ratio there */
function compare(ref, test, ch) {
  const n = Math.min(ref.length, test.length) / ch | 0, maxLag = 1500;
  const at = (lag) => {
    let sig = 0, err = 0, maxd = 0;
    for (let i = Math.max(0, -lag); i < n && i + lag < n; i++) for (let c = 0; c < ch; c++) {
      const r = ref[i * ch + c], t = test[(i + lag) * ch + c], d = r - t;
      sig += r * r; err += d * d; if (Math.abs(d) > maxd) maxd = Math.abs(d);
    }
    return { lag, snr: err ? 10 * Math.log10(sig / err) : Infinity, maxd };
  };
  // candidates: whole frames (a decoder dropping a priming frame) and the best correlation over the loudest 4 s
  const lags = new Set([0, -576, 576, -1152, 1152, -2304, 2304, -3456, 3456]); // (a decoder starting mid-stream may skip the frames whose bit reservoir it lacks)
  let loud = 0, best = -1, w = Math.min(n - 2 * maxLag, 44100 * 4);
  if (w > 1000) {
    for (let a = maxLag; a + w < n - maxLag; a += w >> 1) { let e = 0; for (let i = a; i < a + w; i += 7) e += ref[i * ch] * ref[i * ch]; if (e > best) { best = e; loud = a; } }
    let bc = -Infinity, bl = 0;
    for (let lag = -maxLag; lag <= maxLag; lag++) { let c = 0; for (let i = loud; i < loud + w; i += 3) c += ref[i * ch] * test[(i + lag) * ch]; if (c > bc) { bc = c; bl = lag; } }
    lags.add(bl);
  }
  const r = [...lags].map(at).sort((x, y) => y.snr - x.snr)[0];
  if (args.includes('--blocks')) { // (the signal-to-error ratio per second at that lag: where they part)
    const out = [];
    for (let a = 0; a < n; a += 44100) { let s = 0, e = 0; for (let i = a; i < Math.min(n, a + 44100); i++) { const j = i + r.lag; if (j < 0 || j >= n) continue; const d = ref[i * ch] - test[j * ch]; s += ref[i * ch] ** 2; e += d * d; } out.push(e ? (10 * Math.log10(s / e)).toFixed(0) : 'inf'); }
    r.blocks = out.join(' ');
  }
  return r;
}

const ids = [...new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.pcm')).map((f) => f.slice(0, -4)))].sort((a, b) => a - b).slice(0, max).filter((id) => !args.includes('--only') || args[args.indexOf('--only') + 1].split(',').includes(id));
const streams = ids.map(loadStream).filter((s) => s && s.mp3.length > 4).map((s) => ({ ...s, parsed: frames(s.mp3) })).filter((s) => s.parsed.fmt);
let decoded;
if (!browser) decoded = []; else decoded = await decodeInBrowser(streams);
for (let i = 0; i < streams.length; i++) {
  const s = streams[i], d = browser ? decoded[i] : await decodeNode(s);
  const fr = s.parsed.frames.length, exp = s.parsed.frames.reduce((k, f) => k + f[2], 0) - (d.skipped ?? 0);
  const c = compare(s.pcm, d.pcm, d.ch);
  console.log(`stream ${s.id}: ${s.mp3.length} MP3 bytes, ${fr} frames, ${d.rate} Hz ${d.ch} ch; guest ${s.pcm.length / d.ch} samples, host ${d.pcm.length / d.ch} (frames hold ${exp}${d.skipped ? `, ${d.skipped} not decodable skipped` : ''}); best lag ${c.lag}, SNR ${c.snr.toFixed(1)} dB, max |diff| ${c.maxd}${c.blocks ? `\n  per second: ${c.blocks}` : ''}`);
}

async function decodeInBrowser(list) {
  const require = createRequire(new URL('../../package.json', import.meta.url));
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = createRequire('/srv/orthros/package.json')('playwright')); }
  const root = new URL('../../', import.meta.url).pathname;
  const page = '<!doctype html><script type="module">window.ready = true;</script>';
  const server = http.createServer((q, s) => {
    const h = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
    if (q.url === '/') { s.writeHead(200, { ...h, 'content-type': 'text/html' }); s.end(page); return; }
    const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
    if (!f.startsWith(root + 'src/') || !fs.existsSync(f)) { s.writeHead(404); s.end(); return; }
    s.writeHead(200, { ...h, 'content-type': 'text/javascript' }); s.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const b = await chromium.launch({ headless: true });
  try {
    const p = await b.newPage();
    p.on('console', (m) => console.log(`[page] ${m.text()}`));
    await p.goto(`http://127.0.0.1:${server.address().port}/`);
    const out = [];
    for (const s of list) {
      const r = await p.evaluate(async ({ b64, parsed, src }) => {
        const { Mp3Host, ST_DONE, ST_FAILED } = await import('/src/media/mp3-host.js');
        const bin = atob(b64), mp3 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) mp3[i] = bin.charCodeAt(i);
        const host = new Mp3Host(() => new Worker('/src/media/mp3-helper.js', { type: 'module' }), (m) => console.log(m));
        const decodeWith = new Function(`return (${src})`)();
        const d = await decodeWith(host, { mp3, parsed }, ST_DONE, ST_FAILED, (ms) => new Promise((res) => setTimeout(res, ms)));
        host.terminate();
        let s = ''; const u8 = new Uint8Array(d.pcm.buffer, d.pcm.byteOffset, d.pcm.byteLength); for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        return { b64: btoa(s), ch: d.ch, rate: d.rate, skipped: d.skipped };
      }, { b64: Buffer.from(s.mp3).toString('base64'), parsed: s.parsed, src: decodeWith.toString() });
      const buf = Buffer.from(r.b64, 'base64');
      out.push({ pcm: new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1), ch: r.ch, rate: r.rate, skipped: r.skipped });
    }
    return out;
  } finally { await b.close(); server.close(); }
}
