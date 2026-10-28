// Keep explicitly selected UI addons out of the native simulation peer. The original addon
// files stay untouched; one final data root supplies guarded script entry points on both ends.
// Usage: node tools/openmw/guard-client-ui.mjs <game-folder> <version-id> [--id <compat-id>] <mod-id>[:TYPE,...] [...]
//   <mod-id>              a UI-only addon: every automatic entry point of its script plugins is guarded
//   <mod-id>:MENU,PLAYER  a mod with gameplay too: only the declarations whose targets are all among those types are
//                         guarded; the others (GLOBAL, CONTAINER, item scripts...) stay as shipped and still run on the
//                         simulation peer. A declaration mixing both kinds is refused.
//   --id <compat-id>      the generated root's mod id (default client-ui-compat), to guard addons installed after an
//                         earlier root; its wrappers get their own namespace (scripts/orthros_<id without -compat>/)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_ID = 'client-ui-compat';
/** The generated root's wrapper folder: client-ui-compat → scripts/orthros_client_ui (the first root's, unchanged). */
export const wrapperDir = (compatId) => `scripts/orthros_${compatId.replace(/-compat$/, '').replaceAll('-', '_')}`;

/** `selected`: mod ids, each optionally `id:TYPE,TYPE` (only those declaration types guarded). */
export function guardClientUi(folder, versionId, selected, { id: compatId = DEFAULT_ID } = {}) {
  const game = fs.realpathSync(folder), file = path.join(game, 'manifest.json');
  const spec = JSON.parse(fs.readFileSync(file)), version = spec.versions.find((v) => v.id === versionId);
  const mods = version?.openmw?.mods;
  const picks = selected.map((s) => {
    const [id, types, extra] = String(s).split(':');
    const only = types === undefined ? null : new Set(types.split(',').map((t) => t.trim()));
    if (extra !== undefined || (only && (!only.size || [...only].some((t) => !/^[A-Z][A-Z_]*$/.test(t)))))
      throw new Error(`Expected <mod-id> or <mod-id>:TYPE,TYPE, got ${s}`);
    return { id, only };
  });
  if (!mods || !picks.length || new Set(picks.map((p) => p.id)).size !== picks.length) throw new Error('Select distinct installed UI mods');
  // (the manifest's mod id rule, src/host/openmw.js MOD_ID)
  if (!/^[a-z0-9][a-z0-9-]{0,54}$/.test(compatId)) throw new Error('Invalid compatibility mod id');
  if (mods.some((m) => m.id === compatId)) throw new Error('Client UI compatibility is already installed');
  const versionDir = fs.realpathSync(path.join(game, 'versions', version.dir));
  const dir = `mods/${compatId}-0`, dest = path.join(versionDir, dir), ns = wrapperDir(compatId);
  if (fs.existsSync(dest)) throw new Error('Compatibility data root already exists; refusing overwrite');
  // a later root's wrappers must not replace an earlier root's (same path in the engine's file system)
  for (const part of mods.flatMap((m) => m.parts ?? []))
    if (fs.existsSync(path.join(versionDir, part.dir, ns))) throw new Error(`${ns} already exists in ${part.dir}; choose another --id`);
  const files = new Map(), selections = [], plugins = [], unguarded = [];
  let sequence = 0;
  for (const { id, only } of picks) {
    const mod = mods.find((m) => m.id === id);
    if (!mod?.installed) throw new Error(`UI mod is not installed: ${id}`);
    for (const part of mod.parts ?? []) for (const plugin of part.plugins) {
      if (!/^[^/\\]+\.omwscripts$/i.test(plugin)) throw new Error('Only script-only UI addons can be guarded');
      if (plugins.some((p) => p.toLowerCase() === plugin.toLowerCase())) throw new Error('Duplicate UI plugin');
      const source = fs.realpathSync(path.join(versionDir, part.dir, plugin));
      if (!source.startsWith(versionDir + path.sep)) throw new Error('UI plugin outside the version directory');
      const lines = [], kept = [], wrappers = new Map();
      for (const line of fs.readFileSync(source, 'utf8').split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const match = /^\s*([A-Z][A-Z_, ]*):\s*([\w/.-]+\.lua)\s*$/.exec(line);
        if (!match || match[2].split('/').some((p) => !p || p === '.' || p === '..')) throw new Error(`Unsupported UI script declaration: ${plugin}`);
        // CUSTOM scripts are attached explicitly by their original filename. Renaming that
        // declaration would break GameObject:addScript/hasScript/removeScript in the addon.
        // The guarded automatic entry points never attach them on a simulation peer.
        if (match[1].trim() === 'CUSTOM') { lines.push(line); continue; }
        if (only) {
          const targets = match[1].split(',').map((t) => t.trim()).filter(Boolean), guarded = targets.filter((t) => only.has(t));
          // a gameplay declaration: kept as shipped, so it runs on simulation peers too
          if (!guarded.length) { lines.push(line); kept.push(line.trim()); continue; }
          if (guarded.length < targets.length) throw new Error(`Declaration mixes guarded and kept types: ${plugin}: ${match[1].trim()}`);
        }
        const wrapper = `${ns}/${sequence++}.lua`;
        const module = match[2].slice(0, -4).replaceAll('/', '.');
        wrappers.set(wrapper, `-- Generated client UI entry point; original addon sources are unchanged.\nlocal ok, mp = pcall(require, 'openmw.mp')\nif ok and mp.isSystem and mp.isSystem() then return {} end\nreturn require(${JSON.stringify(module)})\n`);
        lines.push(`${match[1]}: ${wrapper}`);
      }
      if (!lines.length) throw new Error(`Empty UI plugin: ${plugin}`);
      // (with a type selection, a plugin holding none of those types stays where it is, untouched)
      if (only && !wrappers.size) continue;
      for (const [name, text] of wrappers) files.set(name, text);
      files.set(plugin, lines.join('\n') + '\n'); plugins.push(plugin);
      selections.push({ mod: id, part, plugin, only });
      for (const entry of kept) unguarded.push({ mod: id, plugin, entry });
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
  mods.push({ id: compatId, name: compatId === DEFAULT_ID ? 'Client UI multiplayer compatibility' : `Client UI multiplayer compatibility (${compatId})`,
    installed: true, installedAt: new Date().toISOString(), generatedSha256: hash.digest('hex'),
    guardedPlugins: selections.map(({ mod, plugin, only }) => ({ mod, plugin, ...(only ? { guardedTypes: [...only] } : {}) })),
    // the selected plugins' declarations kept as shipped: they still run on simulation peers
    ...(unguarded.length ? { unguardedEntries: unguarded } : {}),
    parts: [{ dir, source: 'generated client UI guards', sentinel: plugins[0], plugins, archives: [],
      files: files.size, bytes: [...files.values()].reduce((sum, s) => sum + Buffer.byteLength(s), 0) }] });
  fs.writeFileSync(file + '.new', JSON.stringify(spec, null, 2) + '\n'); fs.renameSync(file + '.new', file);
  return { plugins, wrappers: sequence };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), at = args.indexOf('--id'), opts = {};
  if (at >= 0) { opts.id = args[at + 1]; args.splice(at, 2); }
  const [folder, version, ...ids] = args;
  if (!folder || !version || (at >= 0 && !opts.id)) throw new Error('Expected game folder, version id and UI mod ids');
  console.log(JSON.stringify(guardClientUi(folder, version, ids, opts)));
}
