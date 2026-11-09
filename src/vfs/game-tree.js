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
/** Movies among the media files: a game playing one is not playable yet (playable-watch.js). */
const VIDEO = /\.(bik|bk2|avi|mpg|mpeg|wmv|smk|webm)$/i;
/** The file `name` is a movie (by format). */
export const isVideoFile = (name) => VIDEO.test(name);
/** A .wav this large or larger is a media file (music, speech); smaller ones are a game's sound effects. */
export const MEDIA_WAV_BYTES = 512 << 10;
/** The file `name` of `size` bytes is a media file (see MEDIA). */
export function isMediaFile(name, size) { return MEDIA.test(name) || (/\.wav$/i.test(name) && size >= MEDIA_WAV_BYTES); }

/**
 * A file whose light copy is a picture rather than a texture, by format: src/host/light-copies.js lightens a TGA only
 * when it is a picture of a screen's size (TGA_LIGHT_FROM: a loading screen, a map) — shown a moment, often never again;
 * on a link that is not fast its file is not fetched after its light copy (HttpBackend.upgrade), it comes with the
 * offline copy, or read itself on a fast link.
 */
export const isLightPicture = (name) => /\.tga$/i.test(name);

/**
 * A content file whose light copy keeps only what an engine reads of it while it loads its content (src/host/light-
 * copies.js esmZeroRanges, by format: a TES3 file — Morrowind's masters and plugins, its LAND payloads and cell
 * references' details zeroed, every offset kept): read light only until the engine says its content is loaded
 * (data-client.js GameData.contentLoading / contentLoaded), on every link — the file itself from then on, by the ranges
 * its cells read; never fetched whole after its light copy (no upgrade), nor read light by an engine that does not say
 * so. docs/slow-network.md "Content files light before the menu".
 */
export const isLightContent = (name) => /\.(esm|esp|omwaddon|omwgame)$/i.test(name);

/**
 * An image file (a texture: DDS, TGA, PNG, JPEG, BMP, KTX), which an engine reads whole once it reads it: its first
 * missing piece is asked for to the file's end (data-client.js askedEnd, where the engine's page asks for it: wholeLoads).
 */
export const isWholeImage = (name) => /\.(dds|tga|png|jpe?g|bmp|ktx2?)$/i.test(name);

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

/**
 * The guest's view of a tree (every runtime's reader of it: HttpBackend, game-data.js PartsBackend): `rel` walked
 * without case — a directory before a file of the same name, either separator, empty parts skipped —: { file, name,
 * path (the tree's names) } or { dir (its node), name, path }, or null. A file's light copy (LIGHT_DIR/<path>,
 * src/host/light-copies.js) is a file of its own: its size the tree's `light`. (Which files the guest sees and how: in
 * the snapshot key with this module — src/host/snapshot-sources.js KEPT.)
 */
export function treeLookup(tree, rel) {
  if (rel.startsWith(LIGHT_DIR + '/')) {
    const r = treeLookup(tree, rel.slice(LIGHT_DIR.length + 1));
    return r?.file?.light ? { file: { size: r.file.light, mtime: r.file.mtime ?? 0 }, name: r.name, path: `${LIGHT_DIR}/${r.path}` } : null;
  }
  const parts = rel.split(/[\\/]/).filter(Boolean);
  let node = tree; const realParts = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], last = i === parts.length - 1;
    const dirs = node.dirs ?? {}, files = node.files ?? {};
    let hit = dirs[p] !== undefined ? p : Object.keys(dirs).find((n) => n.toLowerCase() === p.toLowerCase());
    if (hit !== undefined) { node = dirs[hit]; realParts.push(hit); continue; }
    if (!last) return null;
    hit = files[p] !== undefined ? p : Object.keys(files).find((n) => n.toLowerCase() === p.toLowerCase());
    if (hit === undefined) return null;
    return { file: files[hit], name: hit, path: [...realParts, hit].join('/') };
  }
  return { dir: node, name: realParts[realParts.length - 1] ?? '', path: realParts.join('/') };
}
/** A path's stat as the guest sees it (treeLookup): { size, isDir, mtime } (a directory's size and date 0), or null. */
export function treeStat(tree, rel) {
  const r = treeLookup(tree, rel);
  if (!r) return null;
  return r.dir ? { size: 0, isDir: true, mtime: 0 } : { size: r.file.size, isDir: false, mtime: r.file.mtime ?? 0 };
}
/** A directory's listing as the guest sees it (treeLookup): its directories, then its files, each in the tree's order; or null. */
export function treeReaddir(tree, rel) {
  const r = treeLookup(tree, rel);
  if (!r || !r.dir) return null;
  const out = [];
  for (const n of Object.keys(r.dir.dirs ?? {})) out.push({ name: n, size: 0, isDir: true, mtime: 0 });
  for (const [n, f] of Object.entries(r.dir.files ?? {})) out.push({ name: n, size: f.size, isDir: false, mtime: f.mtime ?? 0 });
  return out;
}

/** The file at `rel` in a tree, found without case: { path (its real names), size, mtime, light?, owner?, op? }, or null. */
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
    return { path: [...real, name].join('/'), size: f.size, mtime: f.mtime ?? 0, ...(f.light ? { light: f.light } : {}), ...(f.owner ? { owner: f.owner } : {}), ...(f.op ? { op: f.op } : {}) };
  }
  return null;
}

/**
 * The version that owns the file `rel` of a tree when it is another version's (the server's `owner` mark: a file a
 * version takes from one it requires — its underlays, src/host/game-files.js listGameTree —, stored and fetched under
 * that version: docs/slow-network.md "Files of a required version"), else null. A light copy's (LIGHT_DIR/<path>): its
 * file's. `self`: the tree's own version (a mark of its own name is its own file).
 */
export function treeOwner(tree, rel, self = null) {
  const p = rel.replace(/\\/g, '/');
  const o = treeFile(tree, p.startsWith(LIGHT_DIR + '/') ? p.slice(LIGHT_DIR.length + 1) : p)?.owner ?? null;
  return o && o !== self ? o : null;
}

/**
 * A version's tree split by owner (treeOwner): { own: the tree of its own files (the tree itself when no file is
 * another's), owners: Map(owner -> the tree of that version's files it takes, at the same paths — at the owner's own,
 * `op`, where the server says it differs: the same keys in the browser's store whatever version reads them) }.
 */
export function splitOwners(tree, self = null) {
  const owners = new Map();
  const marked = (node) => Object.values(node.files ?? {}).some((f) => f.owner && f.owner !== self) || Object.values(node.dirs ?? {}).some(marked);
  if (!marked(tree)) return { own: tree, owners };
  const split = (node, at) => {
    const own = { dirs: {}, files: {} };
    for (const [name, f] of Object.entries(node.files ?? {})) {
      if (!f.owner || f.owner === self) { own.files[name] = f; continue; }
      let o = owners.get(f.owner); if (!o) owners.set(f.owner, o = { dirs: {}, files: {} });
      const p = typeof f.op === 'string' && f.op ? f.op.split('/') : null;
      for (const d of p ? p.slice(0, -1) : at) o = o.dirs[d] ??= { dirs: {}, files: {} };
      o.files[p ? p[p.length - 1] : name] = f;
    }
    for (const [name, d] of Object.entries(node.dirs ?? {})) own.dirs[name] = split(d, [...at, name]);
    return own;
  };
  return { own: split(tree, []), owners };
}
