// The precompressed units' generator (src/host/br-cache.js): a child process of the server, niced, one job at a time —
// brotli at quality 11 costs seconds of a core per MiB, which must never run on the server's own threads (its fs reads
// and the request path share libuv's pool). A job: { id, file, size, mtimeMs, light: { head, from, size } | null,
// start, end, dir, name, meta, minGain }: the bytes [start, end) of the file (of its light copy), read here, the file
// checked unchanged before and after; the unit written to <dir>/<name>.br — or an empty <name>.raw when brotli saves
// less than `minGain` (sent as they are) — through a temporary file renamed (never a partial unit). Answers
// { id, bytes, raw } or { id, stale } or { id, error }.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readLight } from './light-copies.js';

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

async function run(job) {
  if (!same(fs.statSync(job.file), job)) return { stale: true };
  const buf = Buffer.alloc(job.end - job.start);
  await readRange(job, buf);
  if (!same(fs.statSync(job.file), job)) return { stale: true }; // (replaced while read)
  const out = zlib.brotliCompressSync(buf, { params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_LGWIN]: buf.length > 1 << 18 ? 22 : 18, // (window: 4 MiB for a block, 256 KiB for a piece: the unit fits)
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
  } });
  fs.mkdirSync(job.dir, { recursive: true });
  const metaFile = path.join(job.dir, 'meta.json');
  if (!fs.existsSync(metaFile)) writeAtomic(metaFile, JSON.stringify(job.meta));
  const raw = !(out.length < buf.length * job.minGain);
  writeAtomic(path.join(job.dir, job.name + (raw ? '.raw' : '.br')), raw ? Buffer.alloc(0) : out);
  return { bytes: raw ? 0 : out.length, raw };
}

process.on('message', (job) => {
  run(job).then((r) => process.send({ id: job.id, ...r }), (e) => process.send({ id: job.id, error: String(e?.message ?? e) }));
});
process.on('disconnect', () => process.exit(0)); // (the server gone: nothing to do it for)
