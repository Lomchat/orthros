// The lean package of an OpenMW engine release (openmw-lean.js): a child of the server, niced. Arguments: the release's
// openmw.data, its openmw.js (the package's metadata), the brotli file to write — the package with the bytes no game of
// its own reads zeroed (leanRanges) and the files it rewrites in place rewritten (leanRewrites: held whole while read,
// written at the same offsets), at brotli quality 11 as the releases' own siblings, written through a temporary
// file renamed (never a partial package) —, and the package's sha256 the file is keyed by (the bytes read are checked
// against it: a release.json that no longer says its package writes nothing). Exits 0 when written.
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { leanRanges, leanRewrites } from './openmw-lean.js';

const [data, js, out, sha] = process.argv.slice(2);
const hash = crypto.createHash('sha256');
const meta = fs.readFileSync(js, 'utf8'), ranges = leanRanges(meta), rewrites = leanRewrites(meta);
const size = fs.statSync(data).size;
let at = 0, held = null; // held: { r (the rewrite), buf (its file's bytes, filled while read) }
const zero = new Transform({
  transform(chunk, _enc, done) {
    const from = at, to = at + chunk.length;
    hash.update(chunk);
    for (const [a, b] of ranges) { if (b <= from) continue; if (a >= to) break; chunk.fill(0, Math.max(a, from) - from, Math.min(b, to) - from); }
    at = to;
    // (a rewritten file: the bytes before it pass, its own are held until its end is read, then pass rewritten)
    let pos = from;
    while (pos < to) {
      if (!held) {
        const r = rewrites.find((x) => x.end > pos && x.start < to);
        if (!r) { this.push(chunk.subarray(pos - from)); break; }
        if (r.start > pos) { this.push(chunk.subarray(pos - from, r.start - from)); pos = r.start; }
        held = { r, buf: Buffer.alloc(r.end - r.start) };
      }
      const n = Math.min(to, held.r.end) - pos;
      chunk.copy(held.buf, pos - held.r.start, pos - from, pos - from + n); pos += n;
      if (pos === held.r.end) {
        const body = held.r.rewrite(held.buf);
        if (body.length !== held.buf.length) { done(new Error('a rewrite changed a file\'s length')); return; }
        held = null; this.push(body);
      }
    }
    done();
  },
  flush(done) { done(held ? new Error('the package ends inside a rewritten file') : null); },
});
const tmp = `${out}.tmp-${process.pid}`;
try {
  await pipeline(fs.createReadStream(data, { highWaterMark: 1 << 20 }), zero, zlib.createBrotliCompress({ params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
  } }), fs.createWriteStream(tmp));
  if (fs.statSync(data).size !== size || at !== size) throw new Error('the package changed while read');
  if (sha && hash.digest('hex') !== sha) throw new Error(`the package is not ${sha}`);
  fs.renameSync(tmp, out);
} catch (e) { fs.rmSync(tmp, { force: true }); console.error(`openmw lean package: ${e.message}`); process.exit(1); }
