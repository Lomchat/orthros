// The game's files in the file system of an Emscripten engine that runs in the page (GoldSrc, re3, OpenMW, the next
// ones — CLAUDE.md "Standardization"): a node per file, its size known at once, its bytes from the game data
// (data-client.js) as the engine reads them. Read-only; an engine that suspends while it waits (JSPI) asks for its
// bytes ahead (`node.orthrosStreamed`); one that maps a file (mmap) gets it whole.

/** open()'s flags (Emscripten's, musl's values). */
const O_ACCMODE = 3, O_EXCL = 0o200, O_TRUNC = 0o1000;

/**
 * A node at `at` (an absolute path of the engine's file system) for the game file `h` (GameData.file).
 * @param {object} FS the engine's FS
 * @param {string} at
 * @param {import('./data-client.js').GameData} data
 * @param {object} h
 * @param {{ asyncReads?: boolean, mmap?: boolean, log?: (text: string) => void }} [o]
 *   asyncReads: the engine asks for missing bytes before reading (node.orthrosStreamed: missing, ensure, complete);
 *   mmap: false — the engine reads the file with read() only (its mmap fails: ENOSYS), as an engine that streams expects
 */
export function fileNode(FS, at, data, h, o = {}) {
  const slash = at.lastIndexOf('/'), dir = slash <= 0 ? '/' : at.slice(0, slash);
  FS.mkdirTree(dir);
  const node = FS.createFile(dir, at.slice(slash + 1), {}, true, false);
  Object.defineProperty(node, 'usedBytes', { get: () => h.size });
  Object.defineProperty(node, 'contents', { get: () => h.whole, set: () => {} }); // (whole once mapped: mmap reads it)
  const getattr = node.node_ops?.getattr;
  if (getattr) node.node_ops = { ...node.node_ops, getattr(n) { const a = getattr(n); a.size = h.size; return a; } };
  const ops = node.stream_ops, own = { ...ops };
  // (bytes that cannot be had: a read error for the engine (EIO), not an exception through its code)
  const io = (fn) => { try { return fn(); } catch (e) { if (e instanceof FS.ErrnoError) throw e; o.log?.(`${h.path}: ${e.message}`); throw new FS.ErrnoError(29); } };
  own.llseek = (stream, off, whence) => {
    const p = whence === 1 ? stream.position + off : whence === 2 ? h.size + off : off;
    if (p < 0) throw new FS.ErrnoError(28);
    return p;
  };
  own.read = (stream, buffer, offset, length, position) => io(() => data.read(h, buffer, offset, length, position));
  own.mmap = o.mmap === false ? () => { throw new FS.ErrnoError(52); } : (...a) => io(() => { data.whole(h); return ops.mmap(...a); });
  own.write = () => { throw new FS.ErrnoError(o.mmap === false ? 63 : 69); }; // (EROFS: the game files are read-only)
  node.stream_ops = own;
  if (o.asyncReads) node.orthrosStreamed = { missing: (position, length) => data.missing(h, position, length), ensure: (position, length) => data.ensure(h, position, length), complete: () => data.wantWhole(h) };
  return node;
}

/**
 * The game's phases told by its files (GameData.phase): a node among `nodes` whose path `phaseOf` names (a GoldSrc
 * map's .bsp: its map) starts that phase once an open of it has read at least half the file — a load, not a listing
 * that reads its header —, dated from that open's first read. Returns how many nodes are watched.
 * @param {object} FS the engine's FS
 * @param {Iterable<object>} nodes the game's file nodes (mountFiles)
 * @param {{ phase: (name: string, ago?: number) => void }} data
 * @param {(path: string) => string | null} phaseOf
 */
export function phaseOnRead(FS, nodes, data, phaseOf) {
  let n = 0;
  for (const node of nodes) {
    const name = phaseOf(FS.getPath(node)); if (!name) continue;
    const ops = node.stream_ops, read = ops.read, size = node.usedBytes;
    node.stream_ops = { ...ops, read(stream, buffer, offset, length, position) {
      stream.orthrosFirstRead ??= performance.now();
      const got = read(stream, buffer, offset, length, position);
      stream.orthrosRead = (stream.orthrosRead ?? 0) + got;
      if (!stream.orthrosPhase && stream.orthrosRead * 2 >= size) { stream.orthrosPhase = true; data.phase(name, performance.now() - stream.orthrosFirstRead); }
      return got;
    } };
    n++;
  }
  return n;
}

/**
 * The game's files (`files`: [{ path, at? }] of version `name` — `at`, where a language's file goes, languageFiles)
 * under `root`. `rewritable`: a game file the engine opens to write it anew (O_TRUNC: fopen's "w") replaced by an empty
 * file of the engine's own in its place, as in a game folder the player may write in (not when the open must create
 * it — O_EXCL — nor to change it in place: read-only). Returns the nodes.
 */
export function mountFiles(FS, root, data, name, files, o = {}) {
  const nodes = new Set();
  for (const f of files) {
    const h = data.file(name, f.path); if (!h) continue;
    nodes.add(fileNode(FS, `${root}/${f.at ?? h.path}`, data, h, o));
  }
  if (o.rewritable) {
    const open = FS.open;
    const anew = (flags) => (typeof flags === 'string' ? flags[0] === 'w' && !flags.includes('x') : (flags & O_TRUNC) && (flags & O_ACCMODE) && !(flags & O_EXCL));
    FS.open = function (at, flags, mode) {
      if (typeof at === 'string' && anew(flags)) {
        let node = null; try { node = FS.lookupPath(at, { follow: true }).node; } catch { /* not there */ }
        if (node && nodes.has(node)) { FS.unlink(at); FS.writeFile(at, new Uint8Array(0)); }
      }
      return open.call(this, at, flags, mode);
    };
  }
  return nodes;
}
