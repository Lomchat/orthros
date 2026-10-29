// The OpenMW engine page's boot reads announced (docs/openmw.md "Scripts announced at the boot"): the engine reads its
// data folders' Lua scripts, their localisation and the post-processing shaders one small file at a time — at its boot
// (LuaManager::initConfiguration, the scripts' `require` chains, L10n::MessageBundles::load, a script's YAML::LoadAll),
// then again at a saved game's load (StateManager::loadGame: every object's scripts loaded anew, ScriptsContainer::
// addScript) and in play —, each a synchronous read: one round trip a file for every file not in the page (a mod added
// since the player's last visit, a new device: 200-450 serial reads on a 2 MB/s, 85 ms link, 20-40 s of a frozen page).
// No announce of the engine covers them, and the learned order brings them one at a time behind the game's reads. The
// page knows them all before the engine starts: the files it mounted, in the data folders' order. So, once the mounts
// are over, the files the engine's VFS will resolve (a later data folder's file wins over an earlier one of the same
// name, as the engine's own lookup) whose kind is one of these text formats are announced in one list (GameData.want
// `wait: false`: fetched at once, in parallel, the engine's reads joining them), the smallest first (many round trips
// for few bytes), bounded.

/** the kinds of file announced: Lua scripts and their content lists, YAML (localisation, a script's data), shaders */
export const BOOT_KINDS = /\.(?:lua|omwscripts|ya?ml|omwfx)$/i;
/** a file bigger than this is left to the engine's own reads (a script's data file read in part, a mod's mistake) */
export const BOOT_FILE_MAX = 8 << 20;
/** the most bytes (the files' own) one boot's list asks */
export const BOOT_BYTES = 32 << 20;
/** the most files one boot's list asks */
export const BOOT_FILES = 4096;

/**
 * The name the engine's VFS knows an engine path by (its data folder's root left out, lowercased), or null: `/mwdata/
 * <name>` (the game's folder) and `/mwmods/<mod>/<name>` (a mod's), as the engine page mounts them; other mounts (the
 * engine's asset pack archive, a file the player picked) are not loose files of a data folder.
 */
export function vfsName(enginePath) {
  const p = String(enginePath ?? '');
  const m = /^\/mwdata\/(.+)$/.exec(p) ?? /^\/mwmods\/[^/]+\/(.+)$/.exec(p);
  return m ? m[1].toLowerCase() : null;
}

/**
 * The boot's list: `mounts` [enginePath, h] in the order mounted (the data folders' order: a later one wins), `h` the
 * game data's handle ({ size }; a source of elsewhere — `src` — left out). Returns [{ h, off: 0, len: -1 }], the files the
 * engine resolves whose name is one of BOOT_KINDS, each at most `maxFile` bytes, the smallest first, cut at `maxBytes` /
 * `maxFiles` in that order.
 */
export function bootReads(mounts, { maxFile = BOOT_FILE_MAX, maxBytes = BOOT_BYTES, maxFiles = BOOT_FILES } = {}) {
  const byName = new Map();
  for (const [path, h] of mounts) {
    const name = vfsName(path);
    if (name === null || !BOOT_KINDS.test(name)) continue;
    // (the name resolved to the last data folder's file — an earlier one's never read —, whatever its size)
    byName.set(name, h);
  }
  const files = [...byName.values()].filter((h) => h && h.src === undefined && h.size > 0 && h.size <= maxFile).sort((a, b) => a.size - b.size);
  const out = [];
  let bytes = 0;
  for (const h of files) {
    if (out.length >= maxFiles || bytes + h.size > maxBytes) break;
    bytes += h.size;
    out.push({ h, off: 0, len: -1 });
  }
  return out;
}
