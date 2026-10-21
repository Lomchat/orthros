// The lean package of an OpenMW engine release (openmw-lean.js): a child of the server, niced. Arguments: the release's
// openmw.data, its openmw.js (the package's metadata), the brotli file to write — the package with the example world's
// bytes zeroed (leanRanges), at brotli quality 11 as the releases' own siblings, written through a temporary file
// renamed (never a partial package). Exits 0 when written.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { leanRanges } from './openmw-lean.js';

const [data, js, out] = process.argv.slice(2);
const ranges = leanRanges(fs.readFileSync(js, 'utf8'));
const size = fs.statSync(data).size;
let at = 0;
const zero = new Transform({
  transform(chunk, _enc, done) {
    const from = at, to = at + chunk.length;
    for (const [a, b] of ranges) { if (b <= from) continue; if (a >= to) break; chunk.fill(0, Math.max(a, from) - from, Math.min(b, to) - from); }
    at = to; done(null, chunk);
  },
});
const tmp = `${out}.tmp-${process.pid}`;
try {
  await pipeline(fs.createReadStream(data, { highWaterMark: 1 << 20 }), zero, zlib.createBrotliCompress({ params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
  } }), fs.createWriteStream(tmp));
  if (fs.statSync(data).size !== size || at !== size) throw new Error('the package changed while read');
  fs.renameSync(tmp, out);
} catch (e) { fs.rmSync(tmp, { force: true }); console.error(`openmw lean package: ${e.message}`); process.exit(1); }
