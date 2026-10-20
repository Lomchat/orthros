// A game version's tree as the server lists it (/api/tree/<manifest>: { dirs, files: { name: { size, mtime } } }), for
// every runtime (CLAUDE.md "Standardization"): its files as a list, its size, a language's view of it.

/** Native binaries of an installation: useless to a WebAssembly engine, never part of its files. */
const NATIVE = /\.(exe|dll|so|dylib)$/i;

/** Total bytes of a tree. */
export function treeBytes(node) {
  let n = 0;
  for (const f of Object.values(node.files ?? {})) n += f.size ?? 0;
  for (const d of Object.values(node.dirs ?? {})) n += treeBytes(d);
  return n;
}

/** The files of a tree ({ path, size, mtime }), dot files and native binaries left out. */
export function treeFiles(tree) {
  const files = [];
  (function walk(node, prefix) {
    for (const [dir, sub] of Object.entries(node.dirs ?? {})) if (!dir.startsWith('.')) walk(sub, prefix + dir + '/');
    for (const [file, st] of Object.entries(node.files ?? {})) if (!file.startsWith('.') && !NATIVE.test(file)) files.push({ path: prefix + file, size: st.size, mtime: st.mtime ?? 0 });
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

/** The file at `rel` in a tree, found without case: { path (its real names), size, mtime }, or null. */
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
    return name === undefined ? null : { path: [...real, name].join('/'), size: node.files[name].size, mtime: node.files[name].mtime ?? 0 };
  }
  return null;
}
