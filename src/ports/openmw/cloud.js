// Bridge the engine's saved user state (excluding logs and screenshots) to Orthros versioned account backups.
// Game data is excluded. IDBFS remains the working cache; optimistic hashes protect other devices.
(() => {
  window.orthrosCloudInstall = (FS, game, scope) => {
    const original = FS.syncfs.bind(FS), key = `orthros.openmw.cloud.${scope}.${game}`;
    const endpoint = `/api/cloud/${encodeURIComponent(game)}`;
    let parent = 'none', uploading = false, queued = false, blocked = false, lastHash = null;
    const notify = (message, error = false) => {
      if (window.parent !== window) window.parent.postMessage({ type: 'orthros-save-status', message, error }, location.origin);
    };
    const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
    async function transform(bytes, decompress = false) {
      return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(decompress ? new DecompressionStream('gzip') : new CompressionStream('gzip'))).arrayBuffer());
    }
    const savedState = () => { try { return JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { return {}; } };
    const remember = (dirty) => localStorage.setItem(key, JSON.stringify({ parent, dirty }));
    function collect(root = '/userdata', prefix = '') {
      const files = [];
      for (const name of FS.readdir(root)) {
        if (name === '.' || name === '..' || name.toLowerCase() === 'screenshots' || /\.log(?:\.\d+)?$/i.test(name)) continue;
        const full = `${root}/${name}`, relative = prefix + name, st = FS.stat(full);
        if (FS.isDir(st.mode)) files.push(...collect(full, relative + '/'));
        else if (FS.isFile(st.mode)) {
          const bytes = FS.readFile(full); let data = '';
          for (let n = 0; n < bytes.length; n += 0x8000) data += String.fromCharCode(...bytes.subarray(n, n + 0x8000));
          files.push({ path: relative, data: btoa(data) });
        }
      }
      return files;
    }
    function clear(root = '/userdata') {
      for (const n of FS.readdir(root)) {
        if (n === '.' || n === '..') continue;
        const p = `${root}/${n}`;
        if (FS.isDir(FS.stat(p).mode)) { clear(p); FS.rmdir(p); } else FS.unlink(p);
      }
    }
    async function restore() {
      notify('Chargement des sauvegardes du compte…');
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
      notify('Sauvegardes liées au compte Orthros.');
    }
    async function upload() {
      if (blocked) return;
      if (uploading) { queued = true; return; }
      uploading = true;
      try {
        const raw = new TextEncoder().encode(JSON.stringify({ format: 'orthros-profile', version: 1, game, files: collect() }));
        const hash = await digest(raw);
        if (hash === lastHash) { remember(false); return; }
        remember(true); notify('Envoi des sauvegardes sur le compte…');
        const bytes = await transform(raw);
        const r = await fetch(endpoint, { method: 'PUT', headers: { 'X-Orthros-Player-Scope': scope, 'X-Orthros-Parent-Hash': parent, 'Content-Type': 'application/octet-stream' }, body: bytes });
        if (!r.ok) {
          if (r.status === 409 || r.status === 401) blocked = true;
          throw new Error(r.status === 409 ? 'Conflit : une autre sauvegarde existe en ligne. La copie locale est conservée ; synchronisation suspendue.' : 'Sauvegarde conservée sur cet appareil. Envoi au compte impossible ; garde cet onglet ouvert pour réessayer.');
        }
        parent = (await r.json()).hash; lastHash = hash; remember(false);
        notify('Sauvegardes enregistrées sur le compte Orthros.');
      } catch (e) { notify(e.message, true); }
      finally { uploading = false; if (queued) { queued = false; upload(); } }
    }
    FS.syncfs = (populate, callback) => original(populate, (err) => {
      if (err) return callback?.(err);
      if (populate) {
        restore().then(() => callback?.(null)).catch((e) => {
          blocked = true; notify(e.message, true);
          // Never start the engine with missing or conflicting account data.
          const panel = document.createElement('p'); panel.setAttribute('role', 'alert'); panel.textContent = e.message;
          document.body.prepend(panel);
        });
      } else { callback?.(null); remember(true); upload(); }
    });
    window.addEventListener('online', () => { if (!blocked) upload(); });
    window.addEventListener('beforeunload', (event) => {
      if (savedState().dirty || uploading) { event.preventDefault(); event.returnValue = ''; }
    });
  };
})();
