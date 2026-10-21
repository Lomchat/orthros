#!/usr/bin/env node
// What the audio units save (docs/slow-network.md "Audio units"): for each manifest with a learned order, the units of
// its launch set (as a link that is not fast reads it) and of its whole order (as a fast one does) that hold PCM sound —
// RIFF WAVE sound in a file or an archive, a raw bank by trial (src/host/pcm-units.js) —, their brotli-11 bytes (the
// precompressed units', br-cache.js) and the audio form's (src/vfs/pcm-codec.js, brotli on top, kept when ≤ 0.95 of
// brotli's, as the generator does); every container decoded and compared. Brotli 11 costs ~3 s of a core per MiB: run
// it niced; results are kept per unit in --cache (default /tmp/orthros-scratch/audio-units/units.json) between runs.
//
// Usage: nice -n 19 node tools/audio-units.mjs --learn <copy of the learn dir> [--games-dir data_games] [--only <regex>]
//   [--cache <file>]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createServer } from '../src/host/server.js';
import { HttpBackend, BLOCK, CHUNK } from '../src/vfs/http-backend.js';
import { launchSet, forLink, entryPieces } from '../src/vfs/launch-set.js';
import { loadGameCatalog } from '../src/host/game-catalog.js';
import { resolveGameFile } from '../src/host/game-files.js';
import { LIGHT_DIR } from '../src/vfs/game-tree.js';
import { scanWaves, regionsIn, trialLayouts, estimateCoded } from '../src/host/pcm-units.js';
import { encodePcm, decodePcm, pcmCodedBytes } from '../src/vfs/pcm-codec.js';
import { PCM_MIN_GAIN } from '../src/host/br-cache.js';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const learnDir = arg('--learn'), gamesDir = path.resolve(arg('--games-dir', 'data_games')), only = arg('--only') ? new RegExp(arg('--only')) : null;
const cachePath = arg('--cache', '/tmp/orthros-scratch/audio-units/units.json');
if (!learnDir) { console.error('usage: node tools/audio-units.mjs --learn <learn dir copy> [--games-dir dir] [--only regex] [--cache file]'); process.exit(2); }

const catalog = loadGameCatalog(gamesDir);
const srv = createServer({ learnDir: path.resolve(learnDir), gamesDir });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const orders = {};
for (const { name } of await (await fetch(base + '/api/manifests')).json()) {
  if (only && !only.test(name)) continue;
  const list = await (await fetch(`${base}/api/prefetch/${name}`)).json().catch(() => null);
  if (Array.isArray(list) && list.length) orders[name] = [list, await (await fetch(`${base}/api/tree/${name}`)).json()];
}
srv.close();

const br11 = (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: b.length > 1 << 18 ? 22 : 18, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length;
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
const waves = new Map();
/** { raw, br, pcm, trial, decMs } of a unit holding sound, or null */
function unitOf(f, size, kind, index) {
  const st = fs.statSync(f), k = `${f}|${st.size}|${st.mtimeMs}|${kind}${index}`;
  if (k in cache) return cache[k];
  let w = waves.get(f); if (!w) waves.set(f, w = scanWaves(f));
  const n = kind === 'b' ? BLOCK : CHUNK, start = index * n, end = Math.min(size, start + n);
  const buf = Buffer.alloc(end - start), fd = fs.openSync(f, 'r'); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
  const u = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  let regions = regionsIn(w, start, end), trial = false, v = null;
  if (!w.length) { const best = trialLayouts(u.length).map((l) => [l, estimateCoded(u, l)]).sort((a, b) => a[1] - b[1])[0]; if (best[1] < u.length * 0.85) { regions = [best[0]]; trial = true; } }
  if (regions.reduce((a, r) => a + r.len, 0) >= u.length * 0.15) {
    const c = encodePcm(u, regions);
    if (pcmCodedBytes(c)) {
      const t0 = performance.now(), d = decodePcm(c), decMs = performance.now() - t0;
      if (!Buffer.from(d.buffer, d.byteOffset, d.length).equals(buf)) throw new Error(`round trip differs: ${k}`);
      const b = Math.min(br11(u), u.length);
      v = { raw: u.length, br: b, pcm: Math.min(c.length, br11(c)), trial, decMs };
    }
  }
  cache[k] = v;
  return v;
}

const mb = (n) => (n / 1e6).toFixed(2);
for (const [name, [list, tree]] of Object.entries(orders)) {
  const man = catalog.get(name), files = new HttpBackend(`/game/${name}/`, tree), out = {};
  for (const [kind, set, fast] of [['launch', launchSet(files, list, false), false], ['order', forLink(files, list, true), true]]) {
    const t = { raw: 0, br: 0, pcm: 0, units: 0, trial: 0, decMs: 0 };
    for (const e of set) {
      const p = entryPieces(files, e); if (!p || p.path.startsWith(LIGHT_DIR + '/')) continue;
      const f = resolveGameFile(man, p.path); if (!f) continue;
      // (the units the reader asks: a block learned whole — or any block on a fast link —, else its learned pieces)
      for (const [k, i] of fast || p.whole ? [['b', p.block]] : p.pieces.map((c) => ['p', c])) {
        const v = unitOf(f, p.size, k, i);
        if (!v || v.pcm > v.br * PCM_MIN_GAIN) continue;
        t.raw += v.raw; t.br += v.br; t.pcm += v.pcm; t.units++; if (v.trial) t.trial++; t.decMs += v.decMs;
      }
    }
    out[kind] = t;
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify(cache));
  for (const [kind, t] of Object.entries(out)) console.log(`${name} ${kind}: ${t.units} units (${t.trial} by trial), ${mb(t.raw)} MB of file bytes, brotli-11 ${mb(t.br)} MB → audio ${mb(t.pcm)} MB (−${mb(t.br - t.pcm)} MB, ${t.br ? ((1 - t.pcm / t.br) * 100).toFixed(1) : '0.0'} %), decoded in ${t.decMs.toFixed(0)} ms`);
}
process.exit(0);
