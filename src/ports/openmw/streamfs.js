// The OpenMW engine page's file streaming (its StreamFS interface: init, mount, mountLocal, mountBlob, setUrl, stats,
// window.__streamfsStats; and data, for the page's view distance, view-grow.js — src/host/openmw.js swaps the
// release's streamfs.js for this file): the installation's files from the game data every Orthros game reads
// (src/vfs/data-client.js, emscripten-files.js — CLAUDE.md "Standardization"), the engine's own mounts mapped onto the
// version's tree: mwdata/<file> → <file>, mwdata/mods/<part>/<file> → mods/<part>/<file>, moddata/<file> →
// _engine/<file> (the engine release's asset pack, a data mount of the manifest). Files of elsewhere (a signed address, a file the player picked, a Blob) go through the same worker. A copy
// an earlier page kept of a file (legacy-copies.js) is taken before its first read. The player first in the world marks
// the session playable (GameData.mark). The places the engine announces it loads are learned by the server
// (POST /api/places), and the place the player's saved game will load is predicted from the saves and fetched while
// the engine boots and the player sits in the menu (docs/openmw.md "Anticipated places", save-place.js); in play, the
// learned set of the next exterior row is fetched ahead the same way (docs/openmw.md "In
// play: crossings and doors", place-lead.js).
(() => {
  'use strict';
  // (a classic script — the page calls StreamFS synchronously — loading the shared modules at once: they are here long
  // before the engine's first mount, which comes after its own requests)
  const modules = Promise.all([import('/src/vfs/data-client.js'), import('/src/vfs/emscripten-files.js'), import('/src/ports/openmw/view-grow.js'), import('/src/ports/openmw/save-place.js'), import('/src/ports/openmw/boot-reads.js')]);
  let M = null; modules.then(([client, files, view, place, boot]) => {
    M = { ...client, ...files, inWorld: view.inWorld, savePlace: place, bootReads: boot.bootReads };
    // (the engine's package in — openmw.data, its own download —, its main() initialising for seconds before its first
    // read: the link idle meanwhile loads the learned order, on a cold store (little of the launch set here) — GameData.prefetchNow,
    // docs/openmw.md "The link after the engine's package". Installed long before the package ends: these modules are a
    // few KB, the package MBs over the same link.)
    M.onPackageLoaded(window.Module, () => { S.packaged = true; if (S.started) S.data.prefetchNow(); });
    // (the game data opened now — its worker, the version's tree and store, the learned order's list —, while the
    // engine's script, WebAssembly and package download: ready by the engine's first mount (docs/slow-network.md
    // "Opened early"), not opened there, serially, before the engine's run is released)
    try { open(); } catch (e) { console.warn('[streamfs]', e?.message ?? e); }
  });
  const app = location.pathname.slice(0, location.pathname.indexOf('/app/') + 5), name = decodeURIComponent(app.split('/')[3]);
  // (predicted: the place the page expects the player's save to load, and what it asked for it — anticipate)
  // (boot: the boot's announced scripts — announceBoot —, null before)
  const S = { data: null, session: Math.random().toString(36).slice(2, 14), byPath: new Map(), byKey: new Map(), byNode: new WeakMap(), byEnginePath: new Map(), legacy: [], predicted: null, hinted: false, packaged: false, started: false, boot: null, reloadQ: { queued: 0, seen: 0 } };
  /** The learned places of this installation (the server's: POST a load's announced batch, GET a place's set). */
  const placesUrl = `/api/places/${encodeURIComponent(name)}`;
  /** the most entries of a predicted place's set asked for (the server bounds its sets; a bad answer does not flood the link) */
  const PLACE_ENTRIES = 8192;
  /** the most bytes of a predicted place's set asked for (the files' own: Ald'ruhn's with a mod's textures, 134 MB) */
  const PLACE_BYTES = 256 << 20;
  /** how often the saves folders are looked at for a save the engine wrote (its place: the hint) */
  const SAVES_WATCH_MS = 5000;
  /** the longest the predicted place waits for the engine's first frame (see anticipate) */
  const BOOT_WAIT_MS = 180000;
  /** how often the engine's reports are looked at for the next place in play (view.lua reports every 500 ms) */
  const LEAD_POLL_MS = 500;
  /** the page's turns counted (window.orthrosTurns) this often when its thread is free */
  const TURN_MS = 50;
  /** how often the engine page is looked at for the end of its mounts (announceBoot), and for how long at most */
  const MOUNTS_POLL_MS = 100, MOUNTS_WAIT_MS = 120000;

  /** A parameter of the page (this engine page's, else the play page's around it: same origin), or null. */
  function pageParam(key) {
    const of = (w) => { try { return new URLSearchParams(w.location.search).get(key); } catch { return null; } };
    return of(window) ?? (window.parent && window.parent !== window ? of(window.parent) : null);
  }

  /** The tree path of an engine mount's URL (one of this installation's served files), or null. */
  function treePath(url) {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin || u.search || !u.pathname.startsWith(app)) return null;
    const rel = decodeURIComponent(u.pathname.slice(app.length));
    if (rel.startsWith('mwdata/')) return rel.slice('mwdata/'.length);
    if (rel.startsWith('moddata/')) return '_engine/' + rel.slice('moddata/'.length);
    return null;
  }

  /**
   * The bytes of the game files kept in the page: the page's memory tier — the upstream's slots were "about 1 MB each"
   * —, set by the engine page's preRun (__omwLruDefault), 128 MB before.
   */
  const cacheBytes = () => ((window.__omwLruDefault | 0) || 128) << 20;
  /**
   * The engine's reloads told and not done yet (GameData's realBacklog): the queue it reported at its last frame that
   * reloaded (globalThis.__orthrosTexReloads, engine.cpp reloadUpdated), and the files queued since (S.reloadQ: reset
   * when that report changes — a file queued twice counted twice until then).
   */
  function reloadBacklog() {
    const s = globalThis.__orthrosTexReloads, done = s ? s.updated + s.skipped : 0, q = S.reloadQ;
    if (done !== q.seen) { q.seen = done; q.queued = 0; }
    return (s?.pending ?? 0) + q.queued;
  }

  /** The game data opened (once): its worker started, the version's tree, store and learned order's list asked. */
  function open() {
    if (S.data) return S.data;
    S.data = new M.GameData({ name, session: S.session, prefetch: 'first-read', orderAtOpen: true, cacheBytes: cacheBytes(), realInPage: pageParam('realinpage') !== '0', pieceReuse: pageParam('piecereuse') !== '0', realBacklog: reloadBacklog, log: (t) => console.warn('[streamfs]', t) });
    // (observed at once, as openPortData's: a failed open before the engine's first need() — its download seconds long —
    // is not an unhandled rejection, the engine page's log opened on it; holdRun reports it at that need())
    S.data.ready.catch(() => {});
    return S.data;
  }

  function need() {
    if (!M) throw new Error('streamfs: the game data modules are not loaded yet');
    if (!S.started) {
      S.started = true;
      open();
      // (opened before the engine page's preRun set its tier: its bytes kept as the tier says now)
      S.data.budget = cacheBytes();
      S.data.start();
      if (S.packaged) S.data.prefetchNow();
      // (the engine's start held until the worker answered: its first reads wait synchronously, the page's thread
      // spinning, and Chrome hands a module worker the messages sent before its scripts ran through the page's thread —
      // a read before then is never answered: the engine's boot after a short manifest fetch, "the game data worker
      // stopped answering" 30 s later, the archive unreadable. The engine page's preRun holds its own dependencies until
      // its mounts, this one with them — here, not at the open: before the engine's script ran there is no run to hold,
      // and a hold skipped would let that read through again.)
      holdRun(S.data.ready);
      // (the loading in the background, for the Orthros page around the engine: its header's pill)
      if (window.parent !== window) S.data.onProgress((p) => window.parent.postMessage({ type: 'orthros-data', ...p }, location.origin));
      // (the player in the world — alone, Orthros' PLAYER script, view.lua, tells its view from its first poll; in
      // multiplayer, which has no Orthros script, the world joined and simulated: view-grow.js inWorld — the game shown
      // in play, after the menu and the load): the launch set's mark, src/vfs/launch-set.js
      const inWorld = setInterval(() => { if (M.inWorld(window)) { clearInterval(inWorld); S.data.mark('playable'); } }, 500);
      // (a texture read light, its file here now: loaded again in place by an engine that can — the Orthros build's
      // orthros_file_updated, docs/slow-network.md "Engines that reload in place" —, that load choosing the file itself;
      // the rest of a load under way keeps the light copy: repick. Told with its bytes in the page — GameData.realInPage,
      // ?realinpage=0 on this page or the play page: told as they come, the engine's read waiting for the worker)
      const canReload = () => typeof Module !== 'undefined' && !!Module._orthros_file_updated;
      S.data.onReal((keys) => {
        const update = canReload() ? (p) => Module.ccall('orthros_file_updated', 'number', ['string'], [p]) : null;
        for (const k of keys) {
          const at = S.byKey.get(k), h = at && S.byPath.get(at);
          if (!h || !S.data.lightRead(h)) continue;
          S.data.repick(h);
          try { if (update) { if (update(at)) { reloadBacklog(); S.reloadQ.queued++; } S.data.reloaded(); } } catch (e) { console.warn('[streamfs] reload', at, e?.message ?? e); }
        }
      });
      // (an engine that reloads in place: its loads read the light copies first on every link that is not fast, their
      // files soon after them — GameData.reloads; its export seen once the engine's module is instantiated)
      // (a big load read light first on a fast link too, GameData.lightFirst — ?lightfirst=0 on this page or the play
      // page around it: the link alone decides)
      S.data.lightFirst(pageParam('lightfirst') !== '0');
      if (canReload()) S.data.reloads(true);
      else { let n = 0; const look = setInterval(() => { if (canReload()) S.data.reloads(true); if (canReload() || ++n >= 240) clearInterval(look); }, 250); }
      try { Object.defineProperty(window, '__streamfsStats', { configurable: true, get: () => S.data.snapshot() }); } catch { /* defined */ }
      // (the page's turns, for the Orthros build's put-offs (orthros-r14.patch, QuadTreeWorld::orthrosPutOff): the
      // files a put-off asks reach the page between its tasks only — a load's frames or one frame's many rays, in one
      // task, can wait for nothing —, so an entry is built after its time limit only once the page had turns since)
      window.orthrosTurns = 0;
      S.turns = setInterval(() => { window.orthrosTurns = (window.orthrosTurns + 1) | 0; }, TURN_MS);
      // (the scripts the engine reads at its boot and at a save's load, announced once its mounts are over: the engine
      // page's mod list in — window.__serverMods, set once every mod is mounted, before the engine's run is released —,
      // or its content load said, whichever first; ?bootreads=0 on this page or the play page: the engine's reads alone)
      if (pageParam('bootreads') !== '0') {
        S.data.ready.then(() => until(() => window.__serverMods !== undefined || S.boot !== null, MOUNTS_POLL_MS, MOUNTS_WAIT_MS / MOUNTS_POLL_MS)).then(announceBoot, () => {});
      } else S.boot = { off: true };
      anticipate().catch((e) => console.warn('[streamfs] place', e?.message ?? e));
      // (in play: the next row's learned set ahead — only with ?lead=1 on this page or the play page: an A/B, off by
      // default — docs/openmw.md "In play: crossings and doors": the learned order already covers a taught row)
      if (pageParam('lead') === '1') import('/src/ports/openmw/place-lead.js').then(leadInPlay).catch((e) => console.warn('[streamfs] lead', e?.message ?? e));
    }
    return S.data;
  }

  // ---------------------------------------------------------------- the boot's scripts

  /**
   * The data folders' scripts, localisation and shaders the engine will read (boot-reads.js: the files its VFS resolves,
   * small first, bounded), announced once in one list — GameData.want `wait: false`: fetched at once in parallel, what
   * the page or the store holds already left out, the engine's reads of them joining their requests — instead of a
   * round trip each at its boot and at a save's load (docs/openmw.md "Scripts announced at the boot"). Once, after the
   * mounts (S.byPath: every file mounted, in the data folders' order).
   */
  function announceBoot() {
    if (S.boot !== null || !S.started || S.closed) return;
    const entries = M.bootReads(S.byPath);
    const bytes = entries.reduce((t, e) => t + e.h.size, 0);
    S.boot = { files: entries.length, bytes, asked: 0, atMs: Math.round(performance.now()) };
    if (entries.length) S.boot.asked = S.data.want(entries, { wait: false, label: 'boot:scripts' });
  }

  // ---------------------------------------------------------------- anticipated places

  /** `fn()` polled every `ms`, `n` times at most: true once it holds, false once given up. */
  const until = (fn, ms, n) => new Promise((resolve) => {
    if (fn()) { resolve(true); return; }
    let k = 0;
    const t = setInterval(() => { const ok = !!fn(); if (ok || ++k >= n) { clearInterval(t); resolve(ok); } }, ms);
  });
  /** A multiplayer session (the engine page's __omwMPEnabled): the server decides where the player spawns, its solo saves say nothing. */
  const multiplayer = () => !!window.__omwMPEnabled;
  /**
   * The place the player's saved game will load, fetched before the click (docs/openmw.md "Anticipated places"): once
   * the saves are readable — the engine page's __idbfsReady: IDBFS populated, the account's profile restored (cloud.js
   * answers the populate after it) — and the engine draws its first frame (its boot over, the player at the menu), the
   * saves parsed (save-place.js: their records' headers, read in place), one chosen (the remembered place, the newest,
   * the most played: chooseSave), its learned set asked of the server and fetched in the background at the place's
   * priority (GameData.want `prio: 'place'`: the link's idle time, below the game's reads, a load's and the launch set).
   * A save loaded elsewhere loses nothing: its load announces its own (orthrosWillRead). Then the saves the engine
   * writes are watched: their place is the hint for the next session. Not in multiplayer.
   */
  async function anticipate() {
    if (!await until(() => !!window.__idbfsReady && typeof FS !== 'undefined', 250, 480)) return;
    await window.__idbfsReady;
    if (multiplayer()) return;
    // (the saves read, the set asked and fetched once the engine draws its first frame, not while it boots: requests
    // beside the boot's delayed the engine's first read by 1.7 s with a warm store, 4.5 s on a new device (1.8 MB/s,
    // 90 ms; place-load.mjs), though the link was free — the page's and its worker's time, not the link's —, and so
    // would reading every save on the page's thread; an engine that never says it draws: after BOOT_WAIT_MS)
    await until(() => window.Module?.__omwRunning !== undefined, 250, BOOT_WAIT_MS / 250);
    if (multiplayer()) return;
    const P = M.savePlace, saves = P.listSaves(FS);
    watchSaves(saves.reduce((t, x) => Math.max(t, x.mtime), -Infinity));
    const pick = P.chooseSave(saves, { hint: P.placeHint.get(name, window.localStorage ?? null), restored: !!window.orthrosProfileRestored });
    if (!pick) return;
    S.predicted = { place: pick.place, why: pick.why, save: pick.save.path, listed: 0, asked: 0 };
    await S.data.ready;
    const r = await fetch(`${placesUrl}?place=${encodeURIComponent(pick.place)}`, { cache: 'no-store' });
    if (!r.ok) return;
    const entries = placeEntries(await r.json());
    S.predicted.listed = entries.length;
    if (!entries.length) return;
    S.predicted.atMs = Math.round(performance.now());
    S.predicted.asked = S.data.want(entries, { prio: 'place', label: 'place:' + pick.place });
  }
  /**
   * The player's next place guessed in play (place-lead.js: the exterior grid after the one just entered, the same
   * way), its learned set's meshes and terrain asked at the place's priority — never textures, bounded a guess and a session. Looked at every
   * LEAD_POLL_MS once the player is in the world; one look's GETs at a time. `lead`: place-lead.js, loaded only then
   * (off by default: the page fetches nothing more). Stopped by StreamFS.close (S.leadTimer; a module that arrives after
   * the close starts nothing).
   */
  function leadInPlay(lead) {
    if (S.closed) return;
    const L = S.lead = lead.createLead();
    let busy = false;
    S.leadTimer = setInterval(() => {
      if (busy || !M.inWorld(window)) return;
      const places = L.look(window.omw?.state);
      if (!places.length) return;
      busy = true;
      (async () => {
        await S.data.ready;
        for (const place of places) {
          const r = await fetch(`${placesUrl}?place=${encodeURIComponent(place)}`, { cache: 'no-store' }).catch(() => null);
          if (!r?.ok) continue;
          const { entries, bytes } = lead.leadEntries(await r.json(), { size: (p) => S.data.file(name, p)?.size ?? null });
          if (!entries.length) continue;
          L.spent(bytes);
          S.data.want(entries.map((e) => ({ h: S.data.file(name, e.path), off: e.off, len: e.len })), { prio: 'place', label: 'lead:' + place });
        }
      })().catch((e) => console.warn('[streamfs] lead', e?.message ?? e)).finally(() => { busy = false; });
    }, LEAD_POLL_MS);
  }
  /**
   * A place's set as the server lists it ([[path, start, end]] — end exclusive, absent or -1: the file's end —, or
   * { path, start, end }; bare or under `list`) to the game data's entries: the tree's files (others left out).
   */
  function placeEntries(doc) {
    const list = Array.isArray(doc) ? doc : Array.isArray(doc?.list) ? doc.list : [];
    const out = [];
    let bytes = 0;
    for (const x of list.slice(0, PLACE_ENTRIES)) {
      const [p, a, b] = Array.isArray(x) ? x : [x?.path, x?.start, x?.end];
      const h = typeof p === 'string' ? S.data.file(name, p) : null;
      if (!h) continue;
      const off = Math.max(0, Number(a) || 0), end = b === undefined || b === null ? -1 : Number(b);
      const len = Number.isFinite(end) && end >= 0 ? Math.max(0, end - off) : -1;
      // (cut at PLACE_BYTES, the list's order kept: a bad answer does not fill the store either)
      bytes += len < 0 ? Math.max(0, (h.size ?? 0) - off) : len;
      if (bytes > PLACE_BYTES) break;
      out.push({ h, off, len });
    }
    return out;
  }
  /** The saves the engine writes from now (after `since`, ms): the newest one's place remembered (placeHint, at its date). */
  function watchSaves(since) {
    const t = setInterval(() => {
      if (typeof FS === 'undefined') { clearInterval(t); return; }
      for (const x of M.savePlace.listSaves(FS, undefined, since).sort((a, b) => a.mtime - b.mtime)) {
        since = Math.max(since, x.mtime);
        if (x.info.place) M.savePlace.placeHint.set(name, x.info.place, window.localStorage ?? null, x.mtime);
      }
    }, SAVES_WATCH_MS);
  }
  /**
   * An announced batch of a load (`label` '<kind>:<place>', `entries` the game data's) to the server's learned places
   * (POST /api/places): its records [tree path, start, end) — the files themselves, never their light copies (each
   * player's link picks) —, with the place and kind. The session's first load (the game the player started from the
   * menu: a save, or a new game) remembered as the hint (placeHint) — not the cells the player walks through after it
   * (a hub revisited would steal the next prediction from the save written elsewhere: the saves written set it), not a
   * terrain read-ahead's (the view point's cell), not in multiplayer (the server's world, not a solo save's).
   */
  function learnPlace(label, entries) {
    const at = M?.savePlace?.labelPlace(label);
    if (!at) return;
    if (!S.hinted && at.kind !== 'terrain' && !multiplayer()) { S.hinted = true; M.savePlace.placeHint.set(name, at.place, window.localStorage ?? null); }
    const records = [];
    for (const { h, off, len } of entries) {
      if (h.src !== undefined || h.name !== name) continue;
      const a = Math.max(0, Math.min(h.size, off)), b = len < 0 ? h.size : Math.min(h.size, a + len);
      if (b > a) records.push([h.path, a, b]);
    }
    if (!records.length || typeof fetch !== 'function') return;
    fetch(placesUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: S.session, place: at.place, kind: at.kind, records }) }).catch(() => {});
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
    const h = S.data && byEngine(path);
    return !h || S.data.readable(h, offset, size);
  };
  /** The game file the engine opens as `path` (its file system's: an archive's for a file in it), or null (not streamed here). */
  function byEngine(path) {
    let h = S.byEnginePath.get(path);
    if (h === undefined) {
      h = null;
      try { h = S.byNode.get(FS.lookupPath(path, { follow: true }).node) ?? null; } catch { /* not a file here */ }
      S.byEnginePath.set(path, h);
    }
    return h;
  }
  // (the Orthros build's content load, orthros-r13.patch (docs/slow-network.md "Content files light before the menu"):
  // said before it reads its content files — their light copies read from then on, on every link: their land and cell
  // references' details zeroed —, and once they are loaded — the files themselves from then on, for every read of every
  // reader it keeps open; an engine that says nothing reads the files as they are; ?contentlight=0 on this page or the
  // play page around it: the files as they are all along — the pictures compared, tools/openmw/frame-compare.mjs)
  // (the content load starts after every mount: the boot's scripts announced now if the engine page did not say its mods
  // were in — announceBoot)
  window.orthrosContentLoading = () => {
    try { if (S.boot === null && S.data && pageParam('bootreads') !== '0') announceBoot(); } catch (e) { console.warn('[streamfs] boot', e?.message ?? e); }
    if (pageParam('contentlight') !== '0') S.data?.contentLoading();
  };
  window.orthrosContentLoaded = () => { S.data?.contentLoaded(); };
  // (the engine's reads of its content files for ids only — a cell's references listed: its search through every cell —,
  // `on` 1 then 0: served from the light copies, what the content load read, once it is loaded too — GameData.contentIds)
  window.orthrosContentIds = (on) => { S.data?.contentIds(!!on); };
  // (announced reads, the Orthros build's scene changes (its announced-reads patch, docs/slow-network.md "Announced reads"): before
  // it loads cells, the engine says what it reads — `list`: records 'enginePath\x1Foffset\x1Fsize' (size -1: to the end;
  // an archive's path and range for a file in it) separated by '\x1E', `label` '<meshes|textures|terrain>:<place>' — then
  // waits once (orthrosReadWait) instead of a round trip per file: fetched in parallel by the game data (GameData.want).
  // Returns how many are not in the page yet (0: nothing to wait for); paths not streamed here are left out.)
  window.orthrosWillRead = (list, label) => {
    if (!S.started) return 0;
    const entries = [];
    for (const rec of String(list ?? '').split('\x1E')) {
      if (!rec) continue;
      const [path, off, size] = rec.split('\x1F'), h = byEngine(path);
      if (h) entries.push({ h, off: Number(off) || 0, len: size === undefined || size === '' ? -1 : Number(size) });
    }
    S.place = String(label ?? ''); // (what the load is for: the learned places)
    learnPlace(S.place, entries);
    return entries.length ? S.data.want(entries, S.place) : 0;
  };
  // (the engine waits for what it announced, at most `timeoutMs`: 1 when it is all here (or failed — its reads say why),
  // 0 on time out (its reads fetch the rest); 1 at once without game data)
  window.orthrosReadWait = (timeoutMs) => {
    if (!S.started) return 1;
    const ms = Number(timeoutMs);
    return S.data.wantWait(Number.isFinite(ms) && ms >= 0 ? ms : 15000) ? 1 : 0;
  };

  window.StreamFS = {
    stats() { return S.started ? S.data.snapshot() : {}; },
    /** The place predicted for the player's save (anticipate): { place, why, save, listed, asked, atMs (when asked, the page's clock) }, or null. */
    place() { return S.predicted; },
    /** The boot's announced scripts (announceBoot): { files, bytes, asked, atMs }, { off: true } (?bootreads=0), or null (not yet). */
    boot() { return S.boot; },
    /** The places guessed in play (leadInPlay): { guessed, bytes, last }, or null (none yet, or no ?lead=1). */
    leads() { return S.lead?.snapshot() ?? null; },
    /** The game data (data-client.js GameData), once the engine used it (its first mount): null before (opened earlier). */
    data() { return S.started ? S.data : null; },
    /** The game data closed, opened or used (a test; the page's leaving closes its worker anyway). */
    close() { S.closed = true; if (S.leadTimer) { clearInterval(S.leadTimer); S.leadTimer = null; } if (S.turns) { clearInterval(S.turns); S.turns = null; } S.data?.close(); },
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
