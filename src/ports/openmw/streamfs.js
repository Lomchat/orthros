// The OpenMW engine page's file streaming (its StreamFS interface: init, mount, mountLocal, mountBlob, setUrl, stats,
// window.__streamfsStats; and data, for the page's view distance, view-grow.js — src/host/openmw.js swaps the
// release's streamfs.js for this file): the installation's files from the game data every Orthros game reads
// (src/vfs/data-client.js, emscripten-files.js — CLAUDE.md "Standardization"), the engine's own mounts mapped onto the
// version's tree: mwdata/<file> → <file>, mwdata/mods/<part>/<file> → mods/<part>/<file>, moddata/<file> →
// _engine/<file> (the engine release's asset pack, a data mount of the manifest). Files of elsewhere (a signed address, a file the player picked, a Blob) go through the same worker. A copy
// an earlier page kept of a file (legacy-copies.js) is taken before its first read. The player first in the world marks
// the session playable (GameData.mark).
(() => {
  'use strict';
  // (a classic script — the page calls StreamFS synchronously — loading the shared modules at once: they are here long
  // before the engine's first mount, which comes after its own requests)
  const modules = Promise.all([import('/src/vfs/data-client.js'), import('/src/vfs/emscripten-files.js'), import('/src/ports/openmw/view-grow.js')]);
  let M = null; modules.then(([client, files, view]) => { M = { ...client, ...files, inWorld: view.inWorld }; });
  const app = location.pathname.slice(0, location.pathname.indexOf('/app/') + 5), name = decodeURIComponent(app.split('/')[3]);
  const S = { data: null, byPath: new Map(), byKey: new Map(), byNode: new WeakMap(), byEnginePath: new Map(), legacy: [] };

  /** The tree path of an engine mount's URL (one of this installation's served files), or null. */
  function treePath(url) {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin || u.search || !u.pathname.startsWith(app)) return null;
    const rel = decodeURIComponent(u.pathname.slice(app.length));
    if (rel.startsWith('mwdata/')) return rel.slice('mwdata/'.length);
    if (rel.startsWith('moddata/')) return '_engine/' + rel.slice('moddata/'.length);
    return null;
  }

  function need() {
    if (!M) throw new Error('streamfs: the game data modules are not loaded yet');
    if (!S.data) {
      // (the page's memory tier — the upstream's slots were "about 1 MB each" — as the bytes kept in the page)
      S.data = new M.GameData({ name, session: Math.random().toString(36).slice(2, 14), prefetch: 'first-read', cacheBytes: ((window.__omwLruDefault | 0) || 128) << 20,
        log: (t) => console.warn('[streamfs]', t) });
      S.data.start();
      // (the engine's start held until the worker answered: its first reads wait synchronously, the page's thread
      // spinning, and Chrome hands a module worker the messages sent before its scripts ran through the page's thread —
      // a read before then is never answered: the engine's boot after a short manifest fetch, "the game data worker
      // stopped answering" 30 s later, the archive unreadable. The engine page's preRun holds its own dependencies until
      // its mounts, this one with them.)
      holdRun(S.data.ready);
      // (the loading in the background, for the Orthros page around the engine: its header's pill)
      if (window.parent !== window) S.data.onProgress((p) => window.parent.postMessage({ type: 'orthros-data', ...p }, location.origin));
      // (the player in the world — alone, Orthros' PLAYER script, view.lua, tells its view from its first poll; in
      // multiplayer, which has no Orthros script, the world joined and simulated: view-grow.js inWorld — the game shown
      // in play, after the menu and the load): the launch set's mark, src/vfs/launch-set.js
      const inWorld = setInterval(() => { if (M.inWorld(window)) { clearInterval(inWorld); S.data.mark('playable'); } }, 500);
      // (a texture read light, its file here now: loaded again in place by an engine that can — the Orthros build's
      // orthros_file_updated, docs/slow-network.md "Engines that reload in place" —, that load choosing the file itself;
      // the rest of a load under way keeps the light copy: repick)
      const canReload = () => typeof Module !== 'undefined' && !!Module._orthros_file_updated;
      S.data.onReal((keys) => {
        const update = canReload() ? (p) => Module.ccall('orthros_file_updated', 'number', ['string'], [p]) : null;
        for (const k of keys) {
          const at = S.byKey.get(k), h = at && S.byPath.get(at);
          if (!h || !S.data.lightRead(h)) continue;
          S.data.repick(h);
          try { update?.(at); } catch (e) { console.warn('[streamfs] reload', at, e?.message ?? e); }
        }
      });
      // (an engine that reloads in place: its loads read the light copies first on every link that is not fast, their
      // files soon after them — GameData.reloads; its export seen once the engine's module is instantiated)
      if (canReload()) S.data.reloads(true);
      else { let n = 0; const look = setInterval(() => { if (canReload()) S.data.reloads(true); if (canReload() || ++n >= 240) clearInterval(look); }, 250); }
      try { Object.defineProperty(window, '__streamfsStats', { configurable: true, get: () => S.data.snapshot() }); } catch { /* defined */ }
    }
    return S.data;
  }

  /** The Emscripten engine's run (its main) held until `ready` settles (a page without the engine's globals: nothing). */
  function holdRun(ready) {
    const add = typeof addRunDependency === 'function' ? addRunDependency : globalThis.Module?.addRunDependency;
    const remove = typeof removeRunDependency === 'function' ? removeRunDependency : globalThis.Module?.removeRunDependency;
    if (typeof add !== 'function' || typeof remove !== 'function') return;
    add('orthros-game-data');
    ready.then(() => remove('orthros-game-data'), (e) => { console.warn('[streamfs]', e?.message ?? e); remove('orthros-game-data'); });
  }

  function node(path, h) {
    const n = M.fileNode(FS, path, need(), h, { mmap: false, log: (t) => console.warn('[streamfs]', t) });
    S.byPath.set(path, h); S.byNode.set(n, h); S.byEnginePath.clear();
    return n;
  }

  /**
   * The mounted file the engine's VFS knows as `name` (a data folder's path: sound/fx/a.wav, any case): the last one
   * mounted whose path ends with it (later mounts override, as the engine's later data folders), or null.
   */
  function byName(name) {
    if (S.indexed !== S.byPath.size) {
      S.names = new Map(); S.indexed = S.byPath.size;
      for (const [path, h] of S.byPath) {
        const p = path.toLowerCase();
        for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) S.names.set(p.slice(i), h);
      }
    }
    return S.names.get('/' + String(name).toLowerCase().replace(/\\/g, '/')) ?? null;
  }
  // (asked by the Orthros build of the engine before it loads a sound played once, orthros-r2.patch: false — the file
  // not in the page yet, fetched now in the background — and the engine skips that play instead of the page's thread
  // waiting for the network; a file not streamed here: true)
  window.orthrosFileReady = (name) => {
    const h = S.data && byName(name);
    return !h || S.data.readable(h);
  };
  // (asked by the Orthros build of the engine before a preload between frames reads a file — a mesh or a texture, in
  // an archive or not —, orthros-r5.patch: the engine's own path of the file it opens (an archive's: the archive) and
  // the bytes it reads (size < 0: to the end); false — not all in the page yet, fetched now in the background — and the
  // engine puts that work off a frame or more instead of the page's thread waiting for the network; a file not
  // streamed here: true)
  window.orthrosRangeReady = (path, offset, size) => {
    if (!S.data) return true;
    let h = S.byEnginePath.get(path);
    if (h === undefined) {
      h = null;
      try { h = S.byNode.get(FS.lookupPath(path, { follow: true }).node) ?? null; } catch { /* not a file here */ }
      S.byEnginePath.set(path, h);
    }
    return !h || S.data.readable(h, offset, size);
  };

  window.StreamFS = {
    stats() { return S.data ? S.data.snapshot() : {}; },
    /** The game data (data-client.js GameData), once the engine mounted a file: null before. */
    data() { return S.data; },
    init() {
      if (!self.crossOriginIsolated) throw new Error('streamfs needs crossOriginIsolated (COOP/COEP)');
      need();
    },
    /** A file at `url`, `size` bytes (`mtime`: the date the engine page knows): the installation's, or of elsewhere. */
    mount(path, url, size, mtime) {
      const data = need(), rel = treePath(url);
      if (rel === null) return node(path, data.source({ url: new URL(url, location.href).href, size, label: path }));
      // (a copy an earlier page kept of it: taken before its first read — legacy-copies.js, in the data worker)
      S.legacy.push({ name, path: rel, module: '/src/ports/openmw/legacy-copies.js', args: { url: new URL(url, location.href).pathname, size, mtime: mtime || 0 } });
      if (S.legacy.length === 1) queueMicrotask(() => data.legacy(S.legacy.splice(0)));
      S.byKey.set(name + '\n' + rel.toLowerCase(), path);
      return node(path, data.fileAs(name, rel, size));
    },
    /** A new address for a file of elsewhere (signed addresses expire). */
    setUrl(path, url) { const h = S.byPath.get(path); if (h?.src !== undefined) S.data.setSourceUrl(h, new URL(url, location.href).href); },
    /** A file the player picked (FileSystemFileHandle). */
    mountLocal(path, handle, size) { return node(path, need().source({ handle, size, label: path })); },
    /** A Blob (a file the page keeps in the browser's Cache API). */
    mountBlob(path, blob, size) { return node(path, need().source({ blob, size, label: path })); },
  };

})();
