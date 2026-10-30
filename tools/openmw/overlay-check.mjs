// The data overlays of an OpenMW game against what they replace, at every engine release change (docs/openmw.md
// "Data overlays"): a mod's `overlays` entry { of, file, originalSha256, sha256 } says it replaces `file` whose original
// hash was `originalSha256`. For an overlay of the engine's own scripts (`of: "openmw built-in"`), the original is the
// file the version's engine release packs under /resources/vfs/ (its e/<build>/openmw.data, located through openmw.js's
// package list): if the new release changed it, the overlay would silently bring back the older copy — refused here
// until the overlay is regenerated from the new original or withdrawn. Every overlay's installed file is checked
// against its `sha256` too (versions/<dir>/<part dir>/<file>). Read-only; exit 1 on any mismatch.
//   node tools/openmw/overlay-check.mjs <game manifest.json> [--engines-dir data/engines] [--engine <release id>]
// (--engine: check against another release than the manifest's — the one about to replace it.)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BUILTIN = 'openmw built-in';

/** The packed files of an engine release's openmw.js: { '/resources/vfs/...': [start, end] } and its data file. */
export function enginePackage(releaseDir) {
  const e = path.join(releaseDir, 'e');
  const build = fs.readdirSync(e).find((d) => fs.existsSync(path.join(e, d, 'openmw.js')));
  if (!build) throw new Error(`${releaseDir}: no e/<build>/openmw.js`);
  const js = fs.readFileSync(path.join(e, build, 'openmw.js'), 'utf8'), files = new Map();
  for (const m of js.matchAll(/\{filename:"([^"]+)",start:(\d+),end:(\d+)/g)) files.set(m[1], [Number(m[2]), Number(m[3])]);
  if (!files.size) throw new Error(`${releaseDir}: no package list in openmw.js`);
  return { files, data: path.join(e, build, 'openmw.data') };
}

/** sha256 of a packed file of the engine (null: not packed). */
export function builtinSha256(pkg, file) {
  const r = pkg.files.get('/resources/vfs/' + file.replace(/\\/g, '/').replace(/^\/+/, ''));
  if (!r) return null;
  const fd = fs.openSync(pkg.data, 'r');
  try { const b = Buffer.alloc(r[1] - r[0]); fs.readSync(fd, b, 0, b.length, r[0]); return crypto.createHash('sha256').update(b).digest('hex'); }
  finally { fs.closeSync(fd); }
}

/** The problems of a game manifest's overlays ([] when all agree). */
export function checkOverlays(manifestFile, { enginesDir, engine = null } = {}) {
  const man = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), gameDir = path.dirname(manifestFile), out = [], pkgs = new Map();
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  for (const v of man.versions ?? []) {
    const rel = engine ?? v.openmw?.engine; if (!rel) continue;
    for (const mod of v.openmw?.mods ?? []) {
      for (const o of mod.overlays ?? []) {
        const at = `${v.id} ${mod.id} ${o.file}`;
        if (o.of === BUILTIN) {
          if (!pkgs.has(rel)) pkgs.set(rel, enginePackage(path.join(enginesDir, rel)));
          const now = builtinSha256(pkgs.get(rel), o.file);
          if (now === null) out.push(`${at}: ${rel} no longer has this built-in file`);
          else if (now !== o.originalSha256) out.push(`${at}: ${rel}'s built-in is ${now}, the overlay was made from ${o.originalSha256} — regenerate or withdraw it`);
        }
        const installed = (mod.parts ?? []).map((p) => path.join(gameDir, 'versions', v.dir ?? '', p.dir, o.file)).find((f) => fs.existsSync(f));
        if (mod.installed && !installed) out.push(`${at}: not installed`);
        else if (installed && o.sha256 && sha(installed) !== o.sha256) out.push(`${at}: installed file differs from the overlay's sha256`);
      }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
  const enginesDir = path.resolve(opt('--engines-dir', 'data/engines')), engine = opt('--engine', null);
  if (args.length !== 1) { console.error('usage: overlay-check.mjs <game manifest.json> [--engines-dir dir] [--engine release]'); process.exit(64); }
  const bad = checkOverlays(path.resolve(args[0]), { enginesDir, engine });
  for (const b of bad) console.log('MISMATCH ' + b);
  console.log(bad.length ? `${bad.length} overlay problem(s)` : 'overlays: all agree with their originals');
  process.exit(bad.length ? 1 : 0);
}
