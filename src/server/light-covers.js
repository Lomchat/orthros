// Light covers for the home (docs/slow-network.md "Light covers"): a game's cover (its manifest's `cover`, a splash
// screen of the game, or the image beside its manifest, `coverFile`) as the home shows it — a card about 400 px wide,
// the page's backdrop at half opacity — at most COVER_WIDTH pixels wide in WebP. Measured on the library (2026-10-21):
// the home's ten covers 2.18 MB, unscaled JPEGs of 1920 × 1080 and 800 × 600; 960 px WebP 74-106 KB each. The game's
// files are never changed: a light cover is a file of the server's (`dir`), made from the cover by ffmpeg (a tool of
// the machine, as git is: without it the covers go as they are), in the background, one at a time, niced; keyed by
// the cover's real path, size and mtime (and the light shape), so a changed cover is made again, never served stale.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const COVER_WIDTH = 960;
export const COVER_QUALITY = 78;
/** the covers made light: raster images (an SVG is small, drawn at any size) */
const RASTER = /\.(jpe?g|png|bmp|webp)$/i;

/** The light cover's file name of `file` (`st`: its fs.Stats). */
export function lightCoverName(file, st) {
  let real = file; try { real = fs.realpathSync.native(file); } catch { /* as given */ }
  return crypto.createHash('sha1').update([real, st.size, st.mtimeMs, COVER_WIDTH, COVER_QUALITY].join('\0')).digest('hex') + '.webp';
}

/** ffmpeg's arguments making `out` from `file`: as wide as COVER_WIDTH at most (never wider than it is), WebP. */
export const coverArgs = (file, out) => ['-v', 'error', '-nostdin', '-y', '-i', file, '-vf', `scale='min(${COVER_WIDTH},iw)':-2`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', String(COVER_QUALITY), '-f', 'webp', out];

/**
 * The light covers of a server: { file(cover) -> the light cover's path when made (and smaller), else null — asking for
 * it to be made —, pending(cover) -> true while a light copy may still come (the full image served meanwhile is not to
 * be cached long), make(cover) -> Promise of that path or null }. opts: { dir, ffmpeg ('ffmpeg'), log }.
 */
export function lightCovers(opts) {
  const dir = path.resolve(opts.dir), ffmpeg = opts.ffmpeg ?? 'ffmpeg', log = opts.log ?? (() => {});
  const making = new Map(); // name -> Promise
  let queue = Promise.resolve(null);
  let missing = false; // (no ffmpeg: the covers as they are, not asked again)
  const outOf = (name) => path.join(dir, name);
  const make = (file) => {
    let st; try { st = fs.statSync(file); } catch { return Promise.resolve(null); }
    if (!RASTER.test(file) || missing) return Promise.resolve(null);
    const name = lightCoverName(file, st), out = outOf(name);
    if (fs.existsSync(out)) return Promise.resolve(fs.statSync(out).size > 0 ? out : null);
    if (making.has(name)) return making.get(name);
    const p = queue.then(() => new Promise((resolve) => {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { resolve(null); return; }
      const tmp = `${out}.tmp-${process.pid}`;
      let child;
      try { child = spawn(ffmpeg, coverArgs(file, tmp), { stdio: ['ignore', 'ignore', 'pipe'] }); } catch { missing = true; resolve(null); return; }
      try { os.setPriority(child.pid, 19); } catch { /* as it is */ }
      let err = '';
      child.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
      child.on('error', (e) => { if (e.code === 'ENOENT') { missing = true; log('light covers: no ffmpeg, the covers go as they are'); } fs.rm(tmp, { force: true }, () => {}); resolve(null); });
      child.on('close', (code) => {
        if (code !== 0) {
          // (ffmpeg could not make it: the empty "not lighter" mark, keyed by the cover's size and mtime — not tried again
          // at each home load, tried again once the cover changes; killed by a signal: tried again)
          if (code !== null) { log(`light covers: ${file}: ${err.trim().split('\n')[0]}`); try { fs.writeFileSync(out, ''); } catch { /* tried again next time */ } }
          fs.rm(tmp, { force: true }, () => {}); resolve(null); return;
        }
        try {
          const now = fs.statSync(file), size = fs.statSync(tmp).size;
          if (now.size !== st.size || now.mtimeMs !== st.mtimeMs) { fs.rmSync(tmp, { force: true }); resolve(null); return; } // (changed meanwhile)
          // (not lighter: an empty file says so, the cover goes as it is)
          if (size >= st.size) { fs.writeFileSync(tmp, ''); }
          fs.renameSync(tmp, out);
          resolve(size < st.size ? out : null);
        } catch { fs.rm(tmp, { force: true }, () => {}); resolve(null); }
      });
    })).finally(() => making.delete(name));
    queue = p.catch(() => null); // (one at a time)
    making.set(name, p);
    return p;
  };
  return {
    dir,
    file(cover) {
      let st; try { st = fs.statSync(cover); } catch { return null; }
      if (!RASTER.test(cover)) return null;
      const out = outOf(lightCoverName(cover, st));
      try { const s = fs.statSync(out); return s.size > 0 ? out : null; } catch { /* not made yet */ }
      make(cover);
      return null;
    },
    pending(cover) {
      if (missing || !RASTER.test(cover)) return false;
      let st; try { st = fs.statSync(cover); } catch { return false; }
      return !fs.existsSync(outOf(lightCoverName(cover, st)));
    },
    make,
  };
}
