#!/usr/bin/env node
// Precompressed siblings of an engine release's files (<file>.br, brotli 11), as OpenMW's releases ship them: the
// server sends one to a browser that takes brotli and asks for the whole file (server.js sendEngineFile), and counts
// it as the file's wire size on the home's card (engineOf). Without one an engine file goes out as it is from the
// origin — the reverse proxy gzips it on the fly. Measured (2026-10-21, brotli 11 vs the proxy's gzip): Half-Life's
// engine 3.82 -> 3.30 MB, the arsenal 15.44 -> 14.82, Counter-Strike rebuilt 8.86 -> 8.25, Vice City 1.43 -> 1.07.
//
// Usage: node tools/engine-br.mjs [--dry-run] <release dir>...
//   Every file of the release whose name is compressible (.js .mjs .wasm .json .txt .data: not archives, media or native libraries)
//   and whose brotli 11 is at most 92 % of it gets <file>.br next to it (written to a temporary name, then renamed:
//   its mtime after the file's, as sendEngineFile requires); an existing .br newer than its file is kept. Run by the
//   install / build scripts on a release before it is moved in place (tools/goldsrc/install-engine.py,
//   tools/goldsrc/build-modules.sh, tools/re3/build.sh); an installed release: by the operator.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const COMPRESSIBLE = /\.(m?js|wasm|json|txt|data)$/i;
export const MIN_GAIN = 0.92;

/** brotli 11 of `buf` (generic mode: wasm and text alike) */
export const brotli11 = (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } });

/** The files of `dir` that get a sibling, and those made: [{ rel, raw, br, kept }] (br: its size, null: not worth it). */
export function precompress(dir, { dryRun = false, log = () => {} } = {}) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      // (a release's gamefiles/ is laid over the game's own files, releaseGameFiles: a sibling there would be a game file)
      if (e.isDirectory()) { if (!(d === root && e.name === 'gamefiles')) walk(f); continue; }
      if (!e.isFile() || !COMPRESSIBLE.test(e.name)) continue;
      const st = fs.statSync(f), rel = path.relative(root, f);
      if (st.size < 1024) continue;
      let old = null; try { old = fs.statSync(f + '.br'); } catch { /* none */ }
      if (old && old.mtimeMs >= st.mtimeMs) { out.push({ rel, raw: st.size, br: old.size, kept: true }); continue; }
      const raw = fs.readFileSync(f), br = brotli11(raw), worth = br.length <= raw.length * MIN_GAIN;
      out.push({ rel, raw: raw.length, br: worth ? br.length : null, kept: false });
      log(`${rel}: ${raw.length} -> ${br.length}${worth ? '' : ' (not worth it)'}`);
      if (dryRun || !worth) continue;
      const tmp = `${f}.br.tmp-${process.pid}`;
      fs.writeFileSync(tmp, br);
      // (the file must not have changed meanwhile: the sibling would claim another version's bytes)
      const now = fs.statSync(f);
      if (now.size !== st.size || now.mtimeMs !== st.mtimeMs) { fs.unlinkSync(tmp); throw new Error(`${f} changed while compressed`); }
      fs.renameSync(tmp, f + '.br');
    }
  };
  const root = path.resolve(dir);
  walk(root);
  return out;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), dryRun = args.includes('--dry-run'), dirs = args.filter((a) => a !== '--dry-run');
  if (!dirs.length) { console.error('usage: node tools/engine-br.mjs [--dry-run] <release dir>...'); process.exit(2); }
  for (const d of dirs) {
    if (!fs.existsSync(path.join(d, 'release.json')) && !fs.existsSync(path.join(d, 'engine'))) { console.error(`${d}: not an engine release`); process.exit(2); }
    const r = precompress(d, { dryRun, log: (m) => console.log(`  ${m}`) });
    const raw = r.reduce((n, x) => n + x.raw, 0), wire = r.reduce((n, x) => n + (x.br ?? x.raw), 0);
    console.log(`${d}: ${r.length} files, ${(raw / 1048576).toFixed(2)} MB -> ${(wire / 1048576).toFixed(2)} MB${dryRun ? ' (dry run)' : ''}`);
  }
}
