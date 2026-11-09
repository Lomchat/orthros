// The production catalog is entirely described by data/games/<game>/manifest.json.
// A game's base files are overlaid by the selected version's files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDefaults } from './manifest.js';
import { resolveGameFile, releaseGameFiles } from './game-files.js';
import { goldsrcProblem, DEFAULT_ENGINES_DIR } from './goldsrc.js';
import { openmwProblem } from './openmw.js';
import { re3Problem } from './re3.js';
import { mmoProblem } from './mmo.js';
import { profileMovesProblem } from '../vfs/profile-moves.js';
import { keyRemapProblem } from '../win32/vk-scan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_GAMES_DIR = path.join(ROOT, 'data/games');
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const WIN_MOUNT = /^[A-Za-z]:\\[^/:*?"<>|]*$/;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const fail = (file, message) => { throw new Error(`${file}: ${message}`); };
const directory = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const RUNTIMES = ['win32', 'goldsrc', 'openmw', 're3'];
const COVER_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|svg|webp)$/i;
const HEX = /^(?:[0-9a-f]{2})+$/i;
/** What is wrong with a version's `patches` (process.js applyPatches), null when nothing. */
export function patchesProblem(patches) {
  if (patches === undefined) return null;
  if (!Array.isArray(patches)) return 'patches doit être une liste';
  for (const p of patches) {
    const what = `patches: ${p?.module ?? '?'}+${p?.rva ?? '?'}`;
    if (!p || typeof p !== 'object' || typeof p.module !== 'string' || !/^[\w.-]+$/.test(p.module) || !/^0x[0-9a-f]+$/i.test(p.rva ?? '') || !HEX.test(p.from ?? '')) return `${what} : module, rva (0x…) et from (octets en hexadécimal) obligatoires`;
    if ((p.to === undefined) === (p.call === undefined)) return `${what} : to ou call, l'un des deux`;
    if (p.to !== undefined && (!HEX.test(p.to) || p.to.length !== p.from.length)) return `${what} : to, autant d'octets que from`;
    if (p.call !== undefined && (!HEX.test(p.call) || p.from.length < 10)) return `${what} : call (octets en hexadécimal) remplace 5 octets ou plus de from`;
    if (p.why !== undefined && typeof p.why !== 'string') return `${what} : why, un texte`;
  }
  return null;
}
const safePath = (value) => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every((part) => part && part !== '.' && part !== '..');

/**
 * A game folder's manifest and its versions. `enginesDir`: the browser ports' engine releases (an re3 or GoldSrc port's
 * release's game files lie over its version's: `overlays`).
 */
export function loadGameFolder(gameDir, { enginesDir = DEFAULT_ENGINES_DIR } = {}) {
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
  for (const key of ['folder', 'baseFolder', 'gameId', 'id', 'dir', 'requires', 'formerGame', 'extraMounts', 'saveDir', 'coverPath', 'saveKey', 'overlays', 'dataMounts', 'underlays', 'underlayOwners', 'baseOwner', 'sharedBase']) if (own(defaults, key)) fail(file, `defaults.${key} est réservé`);
  if (spec.sharedBase !== undefined && typeof spec.sharedBase !== 'boolean') fail(file, 'sharedBase doit être un booléen');
  // (the files of base/ a version does not override: one owner for every version of the folder — `<id>@base`, which no
  // version id can be ('@' is not in ID) —, stored and fetched once by the browsers whatever the version played:
  // listGameTree marks them, docs/slow-network.md "Files of a required version". A folder of two versions or more,
  // unless it says sharedBase: false; a version saying sharedBase: false keeps its own copy of them)
  const sharing = spec.sharedBase !== false && spec.versions.filter((v) => v?.sharedBase !== false).length >= 2;
  const versions = new Map();
  for (const entry of spec.versions) {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') fail(file, 'entrée de version invalide');
    if (!ID.test(entry.id ?? '') || versions.has(entry.id)) fail(file, `id de version invalide ou dupliqué: ${entry.id}`);
    if (!safePath(entry.dir) || entry.dir.includes('/')) fail(file, `${entry.id}: dir doit nommer un dossier de versions/`);
    if (!directory(path.join(gameDir, 'versions', entry.dir))) fail(file, `${entry.id}: dossier versions/${entry.dir} manquant`);
    if (typeof entry.version !== 'string' || !entry.version.trim()) fail(file, `${entry.id}: version obligatoire`);
    const runtime = entry.runtime ?? defaults.runtime ?? 'win32';
    if (!RUNTIMES.includes(runtime)) fail(file, `${entry.id}: runtime inconnu: ${runtime}`);
    if (runtime === 'win32' && !safePath(entry.exe)) fail(file, `${entry.id}: exe doit être un chemin relatif sûr`);
    if (entry.languages !== undefined && (!Array.isArray(entry.languages) || !entry.languages.length || !entry.languages.every((v) => typeof v === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(v)))) fail(file, `${entry.id}: languages invalide`);
    // (win32: another game's version mounted at its own drive path; goldsrc, re3, openmw: its files beneath this
    // version's, no mount)
    const layered = runtime === 'goldsrc' || runtime === 're3' || runtime === 'openmw';
    if (entry.requires !== undefined && (!Array.isArray(entry.requires) || !entry.requires.every((d) => d && ID.test(d.game ?? '') && ID.test(d.version ?? '') && (layered ? d.mount === undefined : WIN_MOUNT.test(d.mount ?? ''))))) fail(file, `${entry.id}: requires invalide`);
    for (const key of ['folder', 'baseFolder', 'gameId', 'saveDir', 'extraMounts', 'coverPath', 'saveKey', 'overlays', 'dataMounts', 'underlays', 'underlayOwners', 'baseOwner']) if (own(entry, key)) fail(file, `${entry.id}: ${key} est généré depuis le dossier`);
    if (entry.sharedBase !== undefined && typeof entry.sharedBase !== 'boolean') fail(file, `${entry.id}: sharedBase doit être un booléen`);
    // (a version moved from another game folder: the browser's saves keep that installation's key — the port's saveKey)
    if (entry.formerGame !== undefined && (!ID.test(entry.formerGame) || entry.formerGame === spec.id)) fail(file, `${entry.id}: formerGame doit nommer un autre dossier de jeu`);
    const { id, dir, requires, formerGame, sharedBase, ...version } = entry;
    const installation = `orthros-port:${formerGame ?? spec.id}:${dir}`;
    const manifest = withDefaults({ ...defaults, ...version, runtime, name: spec.name, gameId: spec.id,
      folder: path.join(gameDir, 'versions', dir), baseFolder: path.join(gameDir, 'base'),
      saveDir: path.join(ROOT, 'build/saves', id) });
    if (sharing && sharedBase !== false) manifest.baseOwner = baseOwnerOf(spec.id);
    if (!WIN_MOUNT.test(manifest.mount)) fail(file, `${id}: mount invalide`);
    if (manifest.modified !== undefined && typeof manifest.modified !== 'boolean') fail(file, `${id}: modified doit être un booléen`);
    // (a shared world, any runtime: src/host/mmo.js)
    { const problem = mmoProblem(manifest.mmo); if (problem) fail(file, `${id}: ${problem}`); }
    // (files of the player's profile the game keeps elsewhere now: moved at each start, src/vfs/profile-moves.js)
    { const problem = profileMovesProblem(manifest.profileMoves); if (problem) fail(file, `${id}: ${problem}`); }
    // (light copies of the textures for a slow link, src/host/light-copies.js: the browser ports — a Windows game reads
    // its files as they are —, unless the version says false)
    if (manifest.lightCopies !== undefined && typeof manifest.lightCopies !== 'boolean') fail(file, `${id}: lightCopies doit être un booléen`);
    manifest.lightCopies = runtime !== 'win32' && manifest.lightCopies !== false;
    // (the player's keys as the game gets them: user32.js remapKey)
    { const problem = keyRemapProblem(manifest.keys); if (problem) fail(file, `${id}: ${problem}`); }
    // (patches of the game's code in memory: process.js applyPatches)
    { const problem = patchesProblem(manifest.patches); if (problem) fail(file, `${id}: ${problem}`); }
    if (runtime === 'win32' && !resolveGameFile(manifest, manifest.exe)) fail(file, `${id}: exécutable ${manifest.exe} absent de base/ et versions/${dir}/`);
    if (runtime === 'goldsrc') {
      const problem = goldsrcProblem(manifest.goldsrc);
      if (problem) fail(file, `${id}: ${problem}`);
      manifest.saveKey = installation; // (the installation, game/version folder: the page's saved profile)
      // (the release's own game files over the version's — the files Orthros builds, as the bots' meshes: game data, not
      // archives the page fetches whole —; none while the release has no gamefiles/)
      manifest.overlays = [releaseGameFiles(enginesDir, manifest.goldsrc.engine)];
    }
    if (runtime === 'openmw') {
      const problem = openmwProblem(manifest.openmw);
      if (problem) fail(file, `${id}: ${problem}`);
      manifest.saveKey = installation;
      // (the engine release's own data — its asset pack — served with the game's files, under _engine/)
      manifest.dataMounts = [{ at: '_engine', dir: path.join(enginesDir, manifest.openmw.engine, 'moddata') }];
    }
    if (runtime === 're3') {
      const problem = re3Problem(manifest.re3);
      if (problem) fail(file, `${id}: ${problem}`);
      manifest.saveKey = installation;
      // (the engine release's own game files over the version's, whatever their case — none while it is not installed)
      manifest.overlays = [releaseGameFiles(enginesDir, manifest.re3.engine)];
    }
    // (an image beside manifest.json, for a game whose own files hold none a browser displays)
    if (manifest.coverFile !== undefined) {
      if (!COVER_FILE.test(manifest.coverFile) || !fs.statSync(path.join(gameDir, manifest.coverFile), { throwIfNoEntry: false })?.isFile()) fail(file, `${id}: coverFile doit nommer une image à côté de manifest.json`);
      manifest.coverPath = path.join(gameDir, manifest.coverFile);
    }
    if (manifest.languageFileAliases !== undefined) {
      const aliases = manifest.languageFileAliases;
      if (!aliases || Array.isArray(aliases) || typeof aliases !== 'object') fail(file, `${id}: languageFileAliases invalide`);
      for (const [language, paths] of Object.entries(aliases)) {
        if (!manifest.languages?.includes(language) || !paths || Array.isArray(paths) || typeof paths !== 'object') fail(file, `${id}: languageFileAliases.${language} invalide`);
        const seen = new Set();
        for (const [from, to] of Object.entries(paths)) {
          // (`from` a file of the game, or a new name: a file the game looks for in this language — a fallback its
          // archive pattern finds, a file of its language folder — read from `to`, which must exist)
          if (!safePath(from) || !safePath(to) || seen.has(from.toLowerCase()) || !resolveGameFile(manifest, to))
            fail(file, `${id}: alias de fichier invalide: ${from} -> ${to}`);
          seen.add(from.toLowerCase());
        }
      }
    }
    // (files of the version for one language only — hidden from the game in the others)
    if (manifest.languageFiles !== undefined) {
      const lf = manifest.languageFiles;
      if (!lf || Array.isArray(lf) || typeof lf !== 'object') fail(file, `${id}: languageFiles invalide`);
      for (const [language, paths] of Object.entries(lf)) {
        if (!manifest.languages?.includes(language) || !Array.isArray(paths) || !paths.every((p) => safePath(p) && resolveGameFile(manifest, p))) fail(file, `${id}: languageFiles.${language} : fichiers du jeu pour une langue de la version`);
      }
    }
    versions.set(id, { manifest, requires: requires ?? [] });
  }
  if (!versions.has(spec.defaultVersion)) fail(file, 'defaultVersion doit désigner une version');
  return { spec, versions };
}

export function loadGameCatalog(root = DEFAULT_GAMES_DIR, extra = null, { enginesDir = DEFAULT_ENGINES_DIR } = {}) {
  const catalog = new Map(), sources = new Map();
  if (!directory(root)) throw new Error(`Dossier des jeux introuvable: ${root}`);
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const game = loadGameFolder(path.join(root, ent.name), { enginesDir });
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
      // (the required game's language key too: the player's language set on both, as their installers do)
      const req = catalog.get(dep.version);
      deps.push({ mount: dep.mount, manifest: dep.version, ...(req.languageRegistryKey ? { languageRegistryKey: req.languageRegistryKey, languages: req.languages ?? [] } : {}) });
    }
    if (deps.length && catalog.get(id).runtime === 'win32') catalog.get(id).extraMounts = deps;
  }
  // (the UDP ports of the dedicated servers and their rooms: one version each)
  const ports = new Map();
  const tcpPorts = new Map();
  for (const [id, m] of catalog) {
    if (m.runtime === 'openmw' && m.openmw.multiplayer) {
      const p = m.openmw.multiplayer.port;
      if (tcpPorts.has(p)) throw new Error(`${id}: port TCP ${p} déjà pris par ${tcpPorts.get(p)}`);
      tcpPorts.set(p, id);
    }
    const mp = m.runtime === 'goldsrc' ? m.goldsrc?.multiplayer : null; if (!mp) continue;
    const own = [mp.port];
    if (mp.rooms) for (let p = mp.rooms.ports[0]; p <= mp.rooms.ports[1]; p++) own.push(p);
    for (const p of own) { if (ports.has(p)) throw new Error(`${id}: port UDP ${p} déjà pris par ${ports.get(p)}`); ports.set(p, id); }
  }
  // (a GoldSrc version's required versions lie beneath its own files, in order, with theirs: a mod over its game; an
  // re3 version's, of any runtime, the same way — a recompiled engine over the original game's files, as a game of its
  // own on the home without a copy of them; an OpenMW version's too — its mod stack over the original game's files;
  // a required version's own requires followed for a port only)
  // (each underlay folder with the version it is the folder of — `underlayOwners`: [{ manifest, dirs }]: the files the
  // tree takes from them are that version's, stored and fetched under its name by the browsers — game-files.js
  // listGameTree, docs/slow-network.md "Files of a required version")
  const underlays = (id, seen) => {
    if (seen.includes(id)) throw new Error(`dépendance circulaire: ${[...seen, id].join(' -> ')}`);
    const own = catalog.get(id).runtime;
    return sources.get(id).requires.flatMap((dep) => {
      const m = catalog.get(dep.version);
      if (own === 'goldsrc' && m.runtime !== 'goldsrc') throw new Error(`${id}: ${dep.version} n'est pas un portage goldsrc`);
      return [{ manifest: dep.version, dirs: [m.folder, m.baseFolder] }, ...(m.runtime === 'win32' ? [] : underlays(dep.version, [...seen, id]))];
    });
  };
  for (const [id, source] of sources) {
    const runtime = catalog.get(id).runtime;
    if (!source.requires.length || runtime === 'win32') continue;
    const owners = underlays(id, []);
    catalog.get(id).underlays = owners.flatMap((o) => o.dirs);
    catalog.get(id).underlayOwners = owners.map((o) => ({ manifest: o.manifest, dirs: o.dirs.filter(Boolean) }));
  }
  for (const [id, manifest] of extra ?? []) catalog.set(id, manifest);
  return catalog;
}

/** The owner id of a game folder's shared base files (loadGameFolder: manifest.baseOwner). */
export const baseOwnerOf = (gameId) => `${gameId}@base`;

/**
 * The manifests of the game folders' shared bases (manifest.baseOwner): owner id -> a manifest of base/ alone, hidden,
 * served by /gamez/<owner>/ and /api/tree/<owner> only (never a version of the home, nor learned): `baseOf` the
 * versions that share it; light copies when any of them reads them (a file marked with this owner is served with its
 * light copy: listGameTree marks one only then).
 */
export function baseManifests(catalog) {
  const out = new Map();
  for (const [id, m] of catalog) {
    if (!m.baseOwner || !m.baseFolder) continue;
    let b = out.get(m.baseOwner);
    if (!b) out.set(m.baseOwner, b = { name: m.name, gameId: m.gameId, runtime: m.runtime, hidden: true, folder: m.baseFolder, lightCopies: false, baseOf: [] });
    b.lightCopies ||= !!m.lightCopies;
    b.baseOf.push(id);
  }
  return out;
}

/**
 * The versions whose files version `id` reads elsewhere (/api/manifest `owners`: its game's shared base, those of the
 * versions it mounts — extraMounts —, the versions beneath a port's files and their shared bases), and for each shared
 * base the versions of its game whose own browser stores may hold its files from before it was shared (`ownerLegacy`:
 * owner -> [version ids] — the browser reads them there and moves them under the owner: game-data.js openVersion).
 * `catalog`: the versions' manifests by id (loadGameCatalog's).
 */
export function versionOwners(catalog, id) {
  const lookup = (n) => catalog.get(n), m = lookup(id); if (!m) return { owners: [], ownerLegacy: {} };
  const owners = [];
  const add = (o) => { if (o && o !== id && !owners.includes(o)) owners.push(o); };
  add(m.baseOwner);
  for (const d of m.extraMounts ?? []) add(lookup(d.manifest)?.baseOwner);
  for (const o of m.underlayOwners ?? []) { add(o.manifest); add(lookup(o.manifest)?.baseOwner); }
  const ownerLegacy = {};
  for (const o of owners) {
    const game = [...catalog.values()].find((v) => v.baseOwner === o)?.gameId; if (!game) continue;
    ownerLegacy[o] = [...catalog].filter(([, v]) => v.gameId === game).map(([n]) => n);
  }
  return { owners, ownerLegacy };
}

export function defaultGameManifest(gameDir) {
  const dir = path.resolve(gameDir);
  const { spec } = loadGameFolder(dir);
  return loadGameCatalog(path.dirname(dir)).get(spec.defaultVersion);
}
