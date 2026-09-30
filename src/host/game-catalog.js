// The production catalog is entirely described by data_games/<game>/manifest.json.
// A game's base files are overlaid by the selected version's files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDefaults } from './manifest.js';
import { resolveGameFile } from './game-files.js';

export const DEFAULT_GAMES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data_games');
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const WIN_MOUNT = /^[A-Za-z]:\\[^/:*?"<>|]*$/;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const fail = (file, message) => { throw new Error(`${file}: ${message}`); };
const directory = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const safePath = (value) => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every((part) => part && part !== '.' && part !== '..');

export function loadGameFolder(gameDir) {
  const file = path.join(gameDir, 'manifest.json');
  if (!fs.existsSync(file)) fail(file, 'manifest.json obligatoire pour chaque jeu');
  let spec;
  try { spec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { fail(file, `JSON invalide: ${error.message}`); }
  if (!spec || Array.isArray(spec) || typeof spec !== 'object') fail(file, 'objet JSON attendu');
  if (spec.schemaVersion !== 1) fail(file, 'schemaVersion doit être 1');
  if (!ID.test(spec.id ?? '') || spec.id !== path.basename(gameDir)) fail(file, 'id doit correspondre au nom du dossier');
  if (typeof spec.name !== 'string' || !spec.name.trim()) fail(file, 'name obligatoire');
  if (!directory(path.join(gameDir, 'base'))) fail(file, 'dossier base/ manquant');
  if (!Array.isArray(spec.versions) || !spec.versions.length) fail(file, 'versions doit contenir au moins une version');
  if (spec.defaults !== undefined && (!spec.defaults || Array.isArray(spec.defaults) || typeof spec.defaults !== 'object')) fail(file, 'defaults doit être un objet');
  const defaults = spec.defaults ?? {};
  for (const key of ['folder', 'baseFolder', 'gameId', 'id', 'dir', 'requires', 'extraMounts', 'saveDir']) if (own(defaults, key)) fail(file, `defaults.${key} est réservé`);
  const versions = new Map();
  for (const entry of spec.versions) {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') fail(file, 'entrée de version invalide');
    if (!ID.test(entry.id ?? '') || versions.has(entry.id)) fail(file, `id de version invalide ou dupliqué: ${entry.id}`);
    if (!safePath(entry.dir) || entry.dir.includes('/')) fail(file, `${entry.id}: dir doit nommer un dossier de versions/`);
    if (!directory(path.join(gameDir, 'versions', entry.dir))) fail(file, `${entry.id}: dossier versions/${entry.dir} manquant`);
    if (typeof entry.version !== 'string' || !entry.version.trim()) fail(file, `${entry.id}: version obligatoire`);
    if (!safePath(entry.exe)) fail(file, `${entry.id}: exe doit être un chemin relatif sûr`);
    if (entry.languages !== undefined && (!Array.isArray(entry.languages) || !entry.languages.length || !entry.languages.every((v) => typeof v === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(v)))) fail(file, `${entry.id}: languages invalide`);
    if (entry.requires !== undefined && (!Array.isArray(entry.requires) || !entry.requires.every((d) => d && ID.test(d.game ?? '') && ID.test(d.version ?? '') && WIN_MOUNT.test(d.mount ?? '')))) fail(file, `${entry.id}: requires invalide`);
    for (const key of ['folder', 'baseFolder', 'gameId', 'saveDir', 'extraMounts']) if (own(entry, key)) fail(file, `${entry.id}: ${key} est généré depuis le dossier`);
    const { id, dir, requires, ...version } = entry;
    const manifest = withDefaults({ ...defaults, ...version, name: spec.name, gameId: spec.id,
      folder: path.join(gameDir, 'versions', dir), baseFolder: path.join(gameDir, 'base'),
      saveDir: path.resolve(gameDir, '../../build/saves', id) });
    if (!WIN_MOUNT.test(manifest.mount)) fail(file, `${id}: mount invalide`);
    if (!resolveGameFile(manifest, manifest.exe)) fail(file, `${id}: exécutable ${manifest.exe} absent de base/ et versions/${dir}/`);
    versions.set(id, { manifest, requires: requires ?? [] });
  }
  if (!versions.has(spec.defaultVersion)) fail(file, 'defaultVersion doit désigner une version');
  return { spec, versions };
}

export function loadGameCatalog(root = DEFAULT_GAMES_DIR, extra = null) {
  const catalog = new Map(), sources = new Map();
  if (!directory(root)) throw new Error(`Dossier des jeux introuvable: ${root}`);
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const game = loadGameFolder(path.join(root, ent.name));
    for (const [id, item] of game.versions) {
      if (catalog.has(id)) throw new Error(`Identifiant de version dupliqué: ${id}`);
      catalog.set(id, item.manifest);
      sources.set(id, { game: game.spec.id, requires: item.requires });
    }
  }
  for (const [id, source] of sources) {
    const deps = [];
    for (const dep of source.requires) {
      if (dep.version === id || sources.get(dep.version)?.game !== dep.game) throw new Error(`${id}: dépendance introuvable ou invalide: ${dep.game}/${dep.version}`);
      deps.push({ mount: dep.mount, manifest: dep.version });
    }
    if (deps.length) catalog.get(id).extraMounts = deps;
  }
  for (const [id, manifest] of extra ?? []) catalog.set(id, manifest);
  return catalog;
}

export function defaultGameManifest(gameDir) {
  const dir = path.resolve(gameDir);
  const { spec } = loadGameFolder(dir);
  return loadGameCatalog(path.dirname(dir)).get(spec.defaultVersion);
}
