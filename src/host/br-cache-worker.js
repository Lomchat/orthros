// The precompressed units' generator (src/host/br-cache.js): a child process of the server, niced, one job at a time —
// brotli at quality 11 costs seconds of a core per MiB, which must never run on the server's own threads (its fs reads
// and the request path share libuv's pool). A job: { id, file, size, mtimeMs, light: { head, from, size } | null,
// start, end, dir, name, meta, minGain }: the bytes [start, end) of the file (of its light copy), read here, the file
// checked unchanged before and after; the unit written to <dir>/<name>.br — or an empty <name>.raw when brotli saves
// less than `minGain` (sent as they are) — through a temporary file renamed (never a partial unit). With `pcm`, the
// unit's audio form too (docs/slow-network.md "Audio units"): the range's PCM sound — the file's RIFF WAVE sounds
// (pcm-units.js scanWaves, kept in <dir>/waves.json), else the trial layouts for a file with none — coded losslessly
// (src/vfs/pcm-codec.js), checked by decoding it, brotli on top, written to <name>.pcm.br when its bytes are at most
// `pcmGain` of the brotli unit's wire bytes (`brWire`, or the one made now), else an empty <name>.pcm.raw. `br` false:
// the brotli unit is kept already, only the audio form is made. Answers { id, bytes, raw, pcm: { bytes, raw } | null }
// or { id, stale } or { id, error }.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readLight } from './light-copies.js';
import { encodePcm, decodePcm, pcmCodedBytes } from '../vfs/pcm-codec.js';
import { scanWaves, regionsIn, trialLayouts, estimateCoded } from './pcm-units.js';

const same = (st, job) => st.size === job.size && st.mtimeMs === job.mtimeMs;
const readRange = (job, buf) => new Promise((resolve, reject) => {
  const done = (err) => (err ? reject(err) : resolve());
  if (job.light) return readLight(job.file, { ...job.light, head: Buffer.from(job.light.head) }, job.start, job.end, buf, 0, done);
  fs.open(job.file, 'r', (err, fd) => {
    if (err) return reject(err);
    fs.read(fd, buf, 0, buf.length, job.start, (err2, n) => { fs.close(fd, () => {}); done(err2 ?? (n === buf.length ? null : new Error('short read'))); });
  });
});
const writeAtomic = (file, data) => { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); };
const brotli = (buf, quality) => zlib.brotliCompressSync(buf, { params: {
  [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
  [zlib.constants.BROTLI_PARAM_LGWIN]: buf.length > 1 << 18 ? 22 : 18, // (window: 4 MiB for a block, 256 KiB for a piece: the unit fits)
  [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
} });

/** the RIFF WAVE sounds of the job's file version: kept in its unit directory (one scan of the file per version) */
const wavesOf = (job) => {
  const f = path.join(job.dir, 'waves.json');
  try { const w = JSON.parse(fs.readFileSync(f, 'utf8')); if (w.size === job.size && w.mtimeMs === job.mtimeMs) return w.waves; } catch { /* none yet */ }
  const waves = scanWaves(job.file);
  writeAtomic(f, JSON.stringify({ size: job.size, mtimeMs: job.mtimeMs, waves }));
  return waves;
};

/** the audio form of `buf` (the job's range) when it pays against `wire` bytes: the bytes to write, or null */
function audioForm(job, buf, wire) {
  const waves = wavesOf(job), u = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  let regions = regionsIn(waves, job.start, job.end);
  if (!waves.length) { // (no sound headers in the file: the trial layouts, the most promising one if it may pay)
    const best = trialLayouts(u.length).map((l) => [l, estimateCoded(u, l)]).sort((a, b) => a[1] - b[1])[0];
    regions = best[1] < wire * 0.9 ? [best[0]] : [];
  }
  if (!regions.length) return null;
  const c = encodePcm(u, regions);
  const coded = pcmCodedBytes(c);
  if (!coded) return null;
  const d = decodePcm(c); // (never a unit that does not decode to the file's bytes)
  if (!Buffer.from(d.buffer, d.byteOffset, d.length).equals(buf)) throw new Error('pcm: round trip differs');
  // (brotli on top: the bytes between the sounds — headers, other members — compress; coded samples do not)
  const out = brotli(c, coded < u.length * 0.95 ? 11 : 4);
  return out.length <= wire * job.pcmGain ? out : null;
}

async function run(job) {
  if (!same(fs.statSync(job.file), job)) return { stale: true };
  const buf = Buffer.alloc(job.end - job.start);
  await readRange(job, buf);
  if (!same(fs.statSync(job.file), job)) return { stale: true }; // (replaced while read)
  fs.mkdirSync(job.dir, { recursive: true });
  const metaFile = path.join(job.dir, 'meta.json');
  if (!fs.existsSync(metaFile)) writeAtomic(metaFile, JSON.stringify(job.meta));
  let bytes = 0, raw = false, wire = job.brWire;
  if (job.br !== false) {
    const out = brotli(buf, 11);
    raw = !(out.length < buf.length * job.minGain);
    writeAtomic(path.join(job.dir, job.name + (raw ? '.raw' : '.br')), raw ? Buffer.alloc(0) : out);
    bytes = raw ? 0 : out.length; wire = raw ? buf.length : out.length;
  }
  let pcm = null;
  if (job.pcm && !job.light) {
    const out = audioForm(job, buf, wire ?? buf.length);
    if (!same(fs.statSync(job.file), job)) return { stale: true }; // (replaced meanwhile: its waves too)
    writeAtomic(path.join(job.dir, job.name + '.pcm' + (out ? '.br' : '.raw')), out ?? Buffer.alloc(0));
    pcm = { bytes: out ? out.length : 0, raw: !out };
  }
  return { bytes, raw, pcm };
}

// (the server gone meanwhile: the answer dropped — a send on a closed channel would throw EPIPE out of the process)
const answer = (m) => { if (process.connected) process.send(m, () => {}); };
process.on('message', (job) => {
  run(job).then((r) => answer({ id: job.id, ...r }), (e) => answer({ id: job.id, error: String(e?.message ?? e) }));
});
process.on('disconnect', () => process.exit(0)); // (the server gone: nothing to do it for)
