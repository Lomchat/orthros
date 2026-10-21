// Bridge the engine's saved user state (excluding logs and screenshots) to Orthros versioned account backups.
// Game data is excluded. IDBFS remains the working cache; optimistic hashes protect other devices.
(() => {
  window.orthrosCloudInstall = (FS, game, scope) => {
    const original = FS.syncfs.bind(FS), key = `orthros.openmw.cloud.${scope}.${game}`;
    const endpoint = `/api/cloud/${encodeURIComponent(game)}`;
    let parent = 'none', uploading = false, queued = false, blocked = false, lastHash = null;
    // (told to the Orthros page around the engine: its header's save indicator — states as cloud-sync.js's)
    const notify = (state, message = '') => {
      if (window.parent !== window) window.parent.postMessage({ type: 'orthros-save-status', state, message, error: state === 'error' || state === 'conflict' }, location.origin);
    };
    let pending = Promise.resolve(true);
    const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
    async function transform(bytes, decompress = false) {
      return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(decompress ? new DecompressionStream('gzip') : new CompressionStream('gzip'))).arrayBuffer());
    }
    const savedState = () => { try { return JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { return {}; } };
    const remember = (dirty) => localStorage.setItem(key, JSON.stringify({ parent, dirty }));
    // (each file's last reading — its size, date and base64 — and the files as the account last took them: a sync that
    // changed nothing reads, encodes and hashes nothing; the engine page syncs every 15 s, and reading every save each
    // time cost 78 ms per MB of saves on the page's thread)
    const known = new Map();
    let sent = null;
    const base64 = (bytes) => {
      if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
      let data = '';
      for (let n = 0; n < bytes.length; n += 0x8000) data += String.fromCharCode.apply(null, bytes.subarray(n, n + 0x8000));
      return btoa(data);
    };
    /** The profile's files: { path, full, size, mtime } (mtime: milliseconds, undefined when the file system has none). */
    function list(root = '/userdata', prefix = '', out = []) {
      for (const name of FS.readdir(root)) {
        if (name === '.' || name === '..' || name.toLowerCase() === 'screenshots' || /\.log(?:\.\d+)?$/i.test(name)) continue;
        const full = `${root}/${name}`, relative = prefix + name, st = FS.stat(full);
        if (FS.isDir(st.mode)) list(full, relative + '/', out);
        else if (FS.isFile(st.mode)) {
          const t = typeof st.mtime?.getTime === 'function' ? st.mtime.getTime() : st.mtime;
          out.push({ path: relative, full, size: st.size, mtime: Number.isFinite(t) ? t : undefined });
        }
      }
      return out;
    }
    /** The profile's files with their base64: a file read again only when its size or date changed. */
    function collect(files = list()) {
      return files.map((f) => {
        const k = known.get(f.path);
        if (k && f.mtime !== undefined && k.size === f.size && k.mtime === f.mtime) return { path: f.path, data: k.data };
        const data = base64(FS.readFile(f.full));
        known.set(f.path, { size: f.size, mtime: f.mtime, data });
        return { path: f.path, data };
      });
    }
    /** The same files, with the same bytes, as the account last took (a file written again unchanged: the same). */
    const unchanged = (files) => !!sent && files.length === sent.size && files.every((f) => sent.get(f.path) === f.data);
    function clear(root = '/userdata') {
      for (const n of FS.readdir(root)) {
        if (n === '.' || n === '..') continue;
        const p = `${root}/${n}`;
        if (FS.isDir(FS.stat(p).mode)) { clear(p); FS.rmdir(p); } else FS.unlink(p);
      }
    }
    async function restore() {
      notify('saving');
      const r = await fetch(endpoint, { cache: 'no-store', headers: { 'X-Orthros-Player-Scope': scope } });
      if (!r.ok && r.status !== 404) throw new Error('Impossible de charger les sauvegardes du compte. Réessaie avant de jouer.');
      const remote = r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
      parent = r.ok ? r.headers.get('X-Orthros-Backup-Hash') : 'none';
      const local = savedState();
      if (local.dirty && local.parent !== parent) {
        blocked = true;
        throw new Error('Conflit de sauvegardes : cet appareil a des changements non envoyés et une autre partie existe en ligne. Garde cet onglet et sa copie locale.');
      }
      // A failed upload on this device can resume only if the cloud head has not moved.
      if (remote && !local.dirty) {
        const doc = JSON.parse(new TextDecoder().decode(await transform(remote, true)));
        if (doc.format !== 'orthros-profile' || doc.game !== game || !Array.isArray(doc.files)) throw new Error('Sauvegarde en ligne invalide.');
        for (const f of doc.files) if (typeof f.path !== 'string' || f.path.startsWith('/') || f.path.includes('\\') || f.path.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error('Chemin de sauvegarde invalide.');
        clear();
        for (const f of doc.files) {
          const p = `/userdata/${f.path}`; FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
          FS.writeFile(p, Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)));
        }
        await new Promise((resolve, reject) => original(false, (e) => e ? reject(e) : resolve()));
      }
      remember(!!local.dirty);
      notify(local.dirty ? 'idle' : 'saved');
    }
    async function upload() {
      if (blocked) return;
      if (uploading) { queued = true; return; }
      uploading = true;
      try {
        const files = collect();
        if (lastHash !== null && unchanged(files)) { remember(false); return; }
        const raw = new TextEncoder().encode(JSON.stringify({ format: 'orthros-profile', version: 1, game, files }));
        const hash = await digest(raw);
        if (hash === lastHash) { sent = new Map(files.map((f) => [f.path, f.data])); remember(false); return; }
        remember(true); notify('saving');
        const bytes = await transform(raw);
        const r = await fetch(endpoint, { method: 'PUT', headers: { 'X-Orthros-Player-Scope': scope, 'X-Orthros-Parent-Hash': parent, 'Content-Type': 'application/octet-stream' }, body: bytes });
        if (!r.ok) {
          if (r.status === 409 || r.status === 401) blocked = true;
          throw new Error(r.status === 409 ? 'Conflit : une autre sauvegarde existe en ligne. La copie locale est conservée ; synchronisation suspendue.' : 'Sauvegarde conservée sur cet appareil. Envoi au compte impossible ; garde cet onglet ouvert pour réessayer.');
        }
        parent = (await r.json()).hash; lastHash = hash; sent = new Map(files.map((f) => [f.path, f.data])); remember(false);
        notify('saved');
        return true;
      } catch (e) { notify(blocked && /Conflit/.test(e.message) ? 'conflict' : 'error', e.message); return false; }
      finally { uploading = false; if (queued) { queued = false; upload(); } }
    }
    FS.syncfs = (populate, callback) => original(populate, (err) => {
      if (err) return callback?.(err);
      if (populate) {
        restore().then(() => callback?.(null)).catch((e) => {
          blocked = true; notify(/Conflit/.test(e.message) ? 'conflict' : 'error', e.message);
          // Never start the engine with missing or conflicting account data.
          const panel = document.createElement('p'); panel.setAttribute('role', 'alert'); panel.textContent = e.message;
          document.body.prepend(panel);
        });
      } else { remember(true); pending = upload(); callback?.(null); }
    });
    // (the Orthros page leaves: what the engine wrote synced, then sent — answered with whether it reached the account)
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.source !== window.parent || e.data?.type !== 'orthros-flush') return;
      const answer = (ok) => window.parent.postMessage({ type: 'orthros-flushed', ok }, location.origin);
      if (blocked) { answer(false); return; }
      try { FS.syncfs(false, () => Promise.resolve(pending).then((ok) => answer(ok !== false && !blocked && !savedState().dirty), () => answer(false))); } catch { answer(false); }
    });
    window.addEventListener('online', () => { if (!blocked) upload(); });
    window.addEventListener('beforeunload', (event) => {
      if (savedState().dirty || uploading) { event.preventDefault(); event.returnValue = ''; }
    });
  };
})();
