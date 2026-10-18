// Keep explicitly selected UI addons out of the native simulation peer. The original addon
// files stay untouched; one final data root supplies guarded script entry points on both ends.
// Usage: node tools/openmw/guard-client-ui.mjs <game-folder> <version-id> <mod-id> [...]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function guardClientUi(folder, versionId, ids) {
  const game = fs.realpathSync(folder), file = path.join(game, 'manifest.json');
  const spec = JSON.parse(fs.readFileSync(file)), version = spec.versions.find((v) => v.id === versionId);
  const mods = version?.openmw?.mods;
  if (!mods || !ids.length || new Set(ids).size !== ids.length) throw new Error('Select distinct installed UI mods');
  const compatId = 'client-ui-compat';
  if (mods.some((m) => m.id === compatId)) throw new Error('Client UI compatibility is already installed');
  const versionDir = fs.realpathSync(path.join(game, 'versions', version.dir));
  const dir = `mods/${compatId}-0`, dest = path.join(versionDir, dir);
  if (fs.existsSync(dest)) throw new Error('Compatibility data root already exists; refusing overwrite');
  const files = new Map(), selections = [], plugins = [];
  let sequence = 0;
  for (const id of ids) {
    const mod = mods.find((m) => m.id === id);
    if (!mod?.installed) throw new Error(`UI mod is not installed: ${id}`);
    for (const part of mod.parts ?? []) for (const plugin of part.plugins) {
      if (!/^[^/\\]+\.omwscripts$/i.test(plugin)) throw new Error('Only script-only UI addons can be guarded');
      if (plugins.some((p) => p.toLowerCase() === plugin.toLowerCase())) throw new Error('Duplicate UI plugin');
      const source = fs.realpathSync(path.join(versionDir, part.dir, plugin));
      if (!source.startsWith(versionDir + path.sep)) throw new Error('UI plugin outside the version directory');
      const lines = [];
      for (const line of fs.readFileSync(source, 'utf8').split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const match = /^\s*([A-Z][A-Z_, ]*):\s*([\w/.-]+\.lua)\s*$/.exec(line);
        if (!match || match[2].split('/').some((p) => !p || p === '.' || p === '..')) throw new Error(`Unsupported UI script declaration: ${plugin}`);
        // CUSTOM scripts are attached explicitly by their original filename. Renaming that
        // declaration would break GameObject:addScript/hasScript/removeScript in the addon.
        // The guarded automatic entry points never attach them on a simulation peer.
        if (match[1].trim() === 'CUSTOM') { lines.push(line); continue; }
        const wrapper = `scripts/orthros_client_ui/${sequence++}.lua`;
        const module = match[2].slice(0, -4).replaceAll('/', '.');
        files.set(wrapper, `-- Generated client UI entry point; original addon sources are unchanged.\nlocal ok, mp = pcall(require, 'openmw.mp')\nif ok and mp.isSystem and mp.isSystem() then return {} end\nreturn require(${JSON.stringify(module)})\n`);
        lines.push(`${match[1]}: ${wrapper}`);
      }
      if (!lines.length) throw new Error(`Empty UI plugin: ${plugin}`);
      files.set(plugin, lines.join('\n') + '\n'); plugins.push(plugin);
      selections.push({ mod: id, part, plugin });
    }
    if (!selections.some((s) => s.mod === id)) throw new Error(`No enabled UI script plugin: ${id}`);
  }
  // Validate everything before changing any installation or manifest.
  fs.mkdirSync(dest, { recursive: true });
  const hash = createHash('sha256');
  for (const [name, text] of files) {
    fs.mkdirSync(path.dirname(path.join(dest, name)), { recursive: true });
    fs.writeFileSync(path.join(dest, name), text, { flag: 'wx' }); hash.update(name).update('\0').update(text);
  }
  for (const { part, plugin } of selections) part.plugins = part.plugins.filter((p) => p !== plugin);
  mods.push({ id: compatId, name: 'Client UI multiplayer compatibility', installed: true,
    installedAt: new Date().toISOString(), generatedSha256: hash.digest('hex'),
    guardedPlugins: selections.map(({ mod, plugin }) => ({ mod, plugin })),
    parts: [{ dir, source: 'generated client UI guards', sentinel: plugins[0], plugins, archives: [],
      files: files.size, bytes: [...files.values()].reduce((sum, s) => sum + Buffer.byteLength(s), 0) }] });
  fs.writeFileSync(file + '.new', JSON.stringify(spec, null, 2) + '\n'); fs.renameSync(file + '.new', file);
  return { plugins, wrappers: sequence };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [folder, version, ...ids] = process.argv.slice(2);
  if (!folder || !version) throw new Error('Expected game folder, version id and UI mod ids');
  console.log(JSON.stringify(guardClientUi(folder, version, ids)));
}
