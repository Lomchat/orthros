// Install selected data roots of an already extracted mod, without touching the original game.
// No plugin/data parsing: filenames and the operator's explicit plugin selection only.
// Usage: node tools/openmw/install-mod.mjs <game-folder> <version-id> <mod-id> <source-folder>
//        --part '00 Core' --part '01 Textures' [--plugin 'Patch.esp'] [--sha256 archive-sha256]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2), [folder, versionId, modId, sourceFolder] = args;
if (!folder || !versionId || !modId || !sourceFolder) throw new Error('Expected game folder, version id, mod id and extracted source folder');
const values = (key) => args.flatMap((v, i) => v === key ? [args[i + 1]] : []);
const game = fs.realpathSync(folder), source = fs.realpathSync(sourceFolder), file = path.join(game, 'manifest.json');
const spec = JSON.parse(fs.readFileSync(file)), version = spec.versions.find((v) => v.id === versionId);
const mod = version?.openmw?.mods?.find((m) => m.id === modId);
if (!mod) throw new Error('No such declared mod');
if (mod.installed) throw new Error('Already installed; original mod files will not be overwritten');
const roots = values('--part'); if (!roots.length) throw new Error('Select at least one --part (use . for the archive root)');
const wanted = values('--plugin'), parts = [];
for (const [i, rel] of roots.entries()) {
  const src = fs.realpathSync(path.resolve(source, rel));
  if (src !== source && !src.startsWith(source + path.sep)) throw new Error('Part outside source folder');
  if (!fs.statSync(src).isDirectory()) throw new Error('Part is not a data directory');
  const dir = `mods/${mod.id}-${i}`, dest = path.join(game, 'versions', version.dir, dir);
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists; no overwrite`);
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) throw new Error('Symlink in mod source');
      const name = prefix + ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), name + '/');
      else if (ent.isFile()) files.push({ name, size: fs.statSync(path.join(dir, ent.name)).size });
    }
  }; walk(src);
  // (game data the engine reads: assets, plugins, Lua scripts and shaders — an overlay of a mod's — and l10n texts)
  const sentinel = files.find((f) => /\.(dds|nif|esm|esp|omwaddon|omwscripts|lua|omwfx|yaml)$/i.test(f.name))?.name;
  if (!sentinel) throw new Error(`No game assets in ${src}`);
  parts.push({ dir, source: rel, sentinel, plugins: files.filter((f) => !f.name.includes('/') && wanted.some((n) => n.toLowerCase() === f.name.toLowerCase())).map((f) => f.name),
    archives: files.filter((f) => !f.name.includes('/') && /\.(bsa|ba2)$/i.test(f.name)).map((f) => f.name), files: files.length, bytes: files.reduce((s, f) => s + f.size, 0), src, dest });
}
for (const name of wanted) if (!parts.some((p) => p.plugins.some((f) => f.toLowerCase() === name.toLowerCase()))) throw new Error(`Selected plugin not found: ${name}`);
for (const part of parts) fs.cpSync(part.src, part.dest, { recursive: true, force: false, errorOnExist: true });
mod.parts = parts.map(({ src, dest, ...p }) => p); mod.installed = true;
if (values('--sha256')[0]) mod.sha256 = values('--sha256')[0];
mod.installedAt = new Date().toISOString();
fs.writeFileSync(file + '.new', JSON.stringify(spec, null, 2) + '\n'); fs.renameSync(file + '.new', file);
console.log(`Installed ${mod.name}: ${parts.reduce((s, p) => s + p.files, 0)} files in ${parts.length} data roots`);
