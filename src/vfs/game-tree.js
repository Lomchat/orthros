// A game version's tree as the server lists it (/api/tree/<manifest>: { dirs, files: { name: { size, mtime } } }), for
// every runtime (CLAUDE.md "Standardization"): its files as a list, its size, a language's view of it.

/**
 * The light copies' folder in a version's paths (src/host/light-copies.js: a texture without its finest levels, for a
 * slow link — the tree tells a file's light size, `light`; read as `.light/<path>`).
 */
export const LIGHT_DIR = '.light';

/**
 * Media files by format (movies, music, long sounds), for every runtime: the server marks them in the tree (`media:
 * true`); on a link that is not fast they come after every other file the game reads (learned order, offline copy), are
 * left out of the startup set, and get no speculative fills unless the game is streaming them (src/vfs/http-backend.js,
 * data-worker.js). Their bytes are never faked: a read of one waits for the network as any other.
 */
const MEDIA = /\.(bik|bk2|mp3|ogg|avi|mpg|mpeg|wmv|smk|webm)$/i;
/** A .wav this large or larger is a media file (music, speech); smaller ones are a game's sound effects. */
export const MEDIA_WAV_BYTES = 512 << 10;
/** The file `name` of `size` bytes is a media file (see MEDIA). */
export function isMediaFile(name, size) { return MEDIA.test(name) || (/\.wav$/i.test(name) && size >= MEDIA_WAV_BYTES); }

/** Native binaries of an installation: useless to a WebAssembly engine, never part of its files. */
const NATIVE = /\.(exe|dll|so|dylib)$/i;

/** Total bytes of a tree. */
export function treeBytes(node) {
  let n = 0;
  for (const f of Object.values(node.files ?? {})) n += f.size ?? 0;
  for (const d of Object.values(node.dirs ?? {})) n += treeBytes(d);
  return n;
}

/** The files of a tree ({ path, size, mtime, light?, media? }), dot files and native binaries left out. */
export function treeFiles(tree) {
  const files = [];
  (function walk(node, prefix) {
    for (const [dir, sub] of Object.entries(node.dirs ?? {})) if (!dir.startsWith('.')) walk(sub, prefix + dir + '/');
    for (const [file, st] of Object.entries(node.files ?? {})) if (!file.startsWith('.') && !NATIVE.test(file)) files.push({ path: prefix + file, size: st.size, mtime: st.mtime ?? 0, ...(st.light ? { light: st.light } : {}), ...(st.media ? { media: true } : {}) });
  })(tree, '');
  return files;
}

/**
 * The game's files as a language shows them (goldsrc.languages.<code>.overlays: { "valve_french": "valve" }): each file of
 * a language folder is mounted at the same place in the folder it translates (`at`), over the original of that path
 * (compared without case, as the engine finds files); the language folders themselves are not mounted otherwise.
 * Without overlays, the files as they are, the language folders left out of the engine's tree.
 */
export function languageFiles(files, overlays = {}, known = []) {
  const lower = (p) => p.toLowerCase(), top = (p) => lower(p.split('/')[0]);
  const over = new Map(Object.entries(overlays).map(([from, to]) => [lower(from), to]));
  const hidden = new Set([...known.map(lower)].filter((d) => !over.has(d)));
  const translated = new Map();
  for (const f of files) {
    const to = over.get(top(f.path)); if (!to) continue;
    const at = to + f.path.slice(f.path.indexOf('/'));
    translated.set(lower(at), { ...f, at });
  }
  const out = [];
  for (const f of files) {
    const t = top(f.path);
    if (over.has(t) || hidden.has(t)) continue;
    if (!translated.has(lower(f.path))) out.push(f);
  }
  return [...out, ...translated.values()];
}

/** The file at `rel` in a tree, found without case: { path (its real names), size, mtime, light? }, or null. */
export function treeFile(tree, rel) {
  let node = tree;
  const parts = rel.split('/').filter(Boolean), real = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], low = p.toLowerCase();
    if (i < parts.length - 1) {
      const name = node.dirs?.[p] !== undefined ? p : Object.keys(node.dirs ?? {}).find((n) => n.toLowerCase() === low);
      if (name === undefined) return null;
      node = node.dirs[name]; real.push(name); continue;
    }
    const name = node.files?.[p] !== undefined ? p : Object.keys(node.files ?? {}).find((n) => n.toLowerCase() === low);
    if (name === undefined) return null;
    const f = node.files[name];
    return { path: [...real, name].join('/'), size: f.size, mtime: f.mtime ?? 0, ...(f.light ? { light: f.light } : {}) };
  }
  return null;
}
