// Browser-only profile and cache operations. Nothing here sends game files to the server.
const PROFILE_PREFIX = 'orthros-';
const CACHE_PREFIX = 'orthros-files-';
// (a game's snapshot of its machine, docs/snapshot.md: regenerable like the cache, counted and cleared with it)
export const SNAPSHOT_PREFIX = 'orthros-snapshot-';
const ARCHIVE_FORMAT = 'orthros-profile';
const MAX_FILES = 10000;
const MAX_RAW = 128 * 1024 * 1024;

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' o';
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return n.toLocaleString('fr-FR', { maximumFractionDigits: n < 10 ? 1 : 0 }) + ' ' + units[i];
}

async function dirBytes(dir) {
  let bytes = 0, files = 0, locked = 0;
  for await (const [, handle] of dir.entries()) {
    if (handle.kind === 'directory') {
      const sub = await dirBytes(handle);
      bytes += sub.bytes; files += sub.files; locked += sub.locked;
    } else {
      try { bytes += (await handle.getFile()).size; files++; } catch { locked++; }
    }
  }
  return { bytes, files, locked };
}

export async function scanStorage() {
  const root = await navigator.storage.getDirectory();
  const games = new Map(), asides = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'directory') continue;
    if (name.startsWith(CACHE_PREFIX) || name.startsWith(SNAPSHOT_PREFIX)) {
      const game = name.slice((name.startsWith(CACHE_PREFIX) ? CACHE_PREFIX : SNAPSHOT_PREFIX).length);
      const row = games.get(game) ?? { game, profile: 0, cache: 0, files: 0, locked: 0 };
      const size = await dirBytes(handle);
      row.cache += size.bytes; row.locked += size.locked; games.set(game, row);
    } else if (name.startsWith(PROFILE_PREFIX)) {
      const game = name.slice(PROFILE_PREFIX.length);
      const size = await dirBytes(handle);
      if (/-aside-\d{4}-\d\d-\d\dT/.test(game)) {
        asides.push({ name, ...size });
      } else {
        const row = games.get(game) ?? { game, profile: 0, cache: 0, files: 0, locked: 0 };
        row.profile = size.bytes; row.files = size.files; row.locked += size.locked; games.set(game, row);
      }
    }
  }
  const quota = await navigator.storage.estimate();
  return { games: [...games.values()].sort((a, b) => a.game.localeCompare(b.game)), asides,
    usage: quota.usage ?? 0, quota: quota.quota ?? 0, persistent: await navigator.storage.persisted?.() ?? false };
}

function validPath(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 1024 &&
    !name.startsWith('/') && !name.includes('\\') && !/[\x00-\x1f]/.test(name) &&
    name.split('/').every((p) => p && p !== '.' && p !== '..');
}
function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unbase64(s) {
  const binary = atob(s), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function collect(dir, prefix, out) {
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? prefix + '/' + name : name;
    if (handle.kind === 'directory') await collect(handle, path, out);
    else out.push({ path, data: base64(new Uint8Array(await (await handle.getFile()).arrayBuffer())) });
  }
}
async function activeFiles(game, state) {
  const worker = state?.worker;
  if (!worker || state.manifest !== game || !['running', 'loading', 'starting'].includes(state.status)) return null;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { worker.removeEventListener('message', onMessage); reject(new Error('Le jeu ne répond pas à la demande de sauvegarde.')); }, 20000);
    function onMessage(event) {
      if (event.data?.type !== 'profile') return;
      clearTimeout(timeout); worker.removeEventListener('message', onMessage);
      resolve(event.data.files);
    }
    worker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'profile-dump' });
  });
}
/**
 * The profile's files a player keeps (cloud-sync.js): [{ path, data: Uint8Array }], from the running game when it is
 * this one, else from this browser's copy. The profile's Temp folder is left out (the game's scratch files).
 */
export async function profileFiles(game, state) {
  let files = await activeFiles(game, state);
  if (!files) {
    const root = await navigator.storage.getDirectory();
    let dir; try { dir = await root.getDirectoryHandle(PROFILE_PREFIX + game); } catch { return []; }
    files = [];
    await collect(dir, '', files);
  }
  return files.filter((f) => !/^temp(\/|$)/i.test(f.path)).map((f) => ({ path: f.path, data: unbase64(f.data) }));
}
/** This browser's profile of the game replaced by `files` ([{ path, data: Uint8Array }]); the previous one kept aside. */
export async function replaceProfile(game, files, state) {
  return restoreProfile(game, { files: files.map((f) => ({ path: f.path, data: base64(f.data) })) }, state);
}
export async function archiveProfile(game, state) {
  let files = await activeFiles(game, state);
  if (!files) {
    const root = await navigator.storage.getDirectory();
    let dir; try { dir = await root.getDirectoryHandle(PROFILE_PREFIX + game); } catch { return null; }
    files = [];
    await collect(dir, '', files);
  }
  if (!files.length) return null;
  files.sort((a, b) => a.path.localeCompare(b.path));
  const json = JSON.stringify({ format: ARCHIVE_FORMAT, version: 1, game, files });
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function parseArchive(bytes, expectedGame) {
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('Fichier trop volumineux.');
  let archive;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    archive = JSON.parse(await new Response(stream).text());
  } catch { throw new Error('Ce fichier ne contient pas une sauvegarde Orthros valide.'); }
  if (archive?.format !== ARCHIVE_FORMAT || archive.version !== 1 || archive.game !== expectedGame || !Array.isArray(archive.files))
    throw new Error('Cette sauvegarde ne correspond pas à ce jeu.');
  if (archive.files.length > MAX_FILES) throw new Error('Trop de fichiers dans la sauvegarde.');
  const seen = new Set(); let total = 0;
  for (const file of archive.files) {
    if (!validPath(file.path) || seen.has(file.path) || typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))
      throw new Error('Chemin ou contenu de sauvegarde invalide.');
    seen.add(file.path); total += file.data.length * 3 / 4;
    if (total > MAX_RAW) throw new Error('Sauvegarde trop volumineuse une fois décompressée.');
  }
  return archive;
}
async function copyDirectory(source, target) {
  for await (const [name, handle] of source.entries()) {
    if (handle.kind === 'directory') await copyDirectory(handle, await target.getDirectoryHandle(name, { create: true }));
    else { const writer = await (await target.getFileHandle(name, { create: true })).createWritable(); await writer.write(await handle.getFile()); await writer.close(); }
  }
}
async function writeArchive(dir, archive) {
  for (const file of archive.files) {
    const parts = file.path.split('/');
    let target = dir;
    for (const part of parts.slice(0, -1)) target = await target.getDirectoryHandle(part, { create: true });
    const writer = await (await target.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await writer.write(unbase64(file.data)); await writer.close();
  }
}
export async function restoreProfile(game, archive, state) {
  if (state?.manifest === game && ['running', 'loading', 'starting'].includes(state.status))
    throw new Error('Quitte ce jeu avant de restaurer ses sauvegardes.');
  const root = await navigator.storage.getDirectory();
  const name = PROFILE_PREFIX + game, tempName = name + '-restore-' + Date.now();
  const temp = await root.getDirectoryHandle(tempName, { create: true });
  try { await writeArchive(temp, archive); } catch (e) { await root.removeEntry(tempName, { recursive: true }); throw e; }
  let previous = null;
  try { previous = await root.getDirectoryHandle(name); } catch { /* first profile */ }
  const asideName = previous ? name + '-aside-' + new Date().toISOString().replace(/[:.]/g, '-') : null;
  if (previous) await copyDirectory(previous, await root.getDirectoryHandle(asideName, { create: true }));
  try {
    if (previous) await root.removeEntry(name, { recursive: true });
    await copyDirectory(temp, await root.getDirectoryHandle(name, { create: true }));
  } catch (e) {
    await root.removeEntry(name, { recursive: true }).catch(() => {});
    if (asideName) await copyDirectory(await root.getDirectoryHandle(asideName), await root.getDirectoryHandle(name, { create: true }));
    throw e;
  } finally { await root.removeEntry(tempName, { recursive: true }).catch(() => {}); }
  return asideName;
}
export async function removeCache(game, state) {
  if (state?.manifest === game && ['running', 'loading', 'starting'].includes(state.status))
    throw new Error('Quitte ce jeu avant de vider son cache.');
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(SNAPSHOT_PREFIX + game, { recursive: true }).catch(() => {}); // (often none)
  await root.removeEntry(CACHE_PREFIX + game, { recursive: true });
}
export async function removeProfile(game, state) {
  if (state?.manifest === game && ['running', 'loading', 'starting'].includes(state.status))
    throw new Error('Quitte ce jeu avant de supprimer ses sauvegardes.');
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(PROFILE_PREFIX + game, { recursive: true });
}
export function download(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export async function hashBytes(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- the browser ports' storage
// IndexedDB, named after the installation (the manifest's saveKey): a GoldSrc or re3 port's database ('profile': the
// engine's writable files — saves, settings: GoldSrc's under /rwdir/, re3's relative to its game folder —, 'content':
// the game files fetched, whole or as 64 KiB pieces, their size in their key), an OpenMW port's IDBFS databases (the
// installation's, and one per account: saveKey:user:<scope>).
const PORT_PIECE = 1 << 16;
const portDbs = async (saveKey) => (await indexedDB.databases?.() ?? []).map((d) => d.name).filter((n) => n === saveKey || n?.startsWith(saveKey + ':'));
function openDb(name) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name);
    r.onupgradeneeded = () => { r.transaction.abort(); }; // (never one that does not exist yet)
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const sizeOf = (v) => (v == null ? 0 : ArrayBuffer.isView(v) || v instanceof ArrayBuffer ? v.byteLength : typeof v === 'string' ? v.length
  : Array.isArray(v) ? v.reduce((n, e) => n + sizeOf(e?.data ?? e), 0) : typeof v === 'object' ? sizeOf(v.contents ?? v.data) : 0);
/** Each port's data in this browser: [{ game, profile (bytes of saves), cache (bytes of game files), port: true }]. */
export async function scanPorts(ports) {
  const rows = [];
  for (const { name, saveKey } of ports) {
    let profile = 0, cache = 0;
    for (const dbName of await portDbs(saveKey)) {
      let db; try { db = await openDb(dbName); } catch { continue; }
      try {
        for (const store of db.objectStoreNames) {
          const os = db.transaction(store).objectStore(store);
          if (store === 'content') {
            for (const k of await req(os.getAllKeys())) { const m = /\n(\d+)\n[^\n]*(\n#\d+)?$/.exec(String(k)); cache += m ? (m[2] ? PORT_PIECE : Number(m[1])) : 0; }
          } else for (const v of await req(os.getAll())) profile += sizeOf(v);
        }
      } finally { db.close(); }
    }
    if (profile || cache) rows.push({ game: name, profile, cache, files: 0, locked: 0, port: true });
  }
  return rows;
}
/** A port's saves as the account keeps them (cloud-sync.js): [{ path, data }] — GoldSrc's tree, re3's, OpenMW's /userdata. */
export async function portFiles(saveKey) {
  const files = [];
  for (const dbName of await portDbs(saveKey)) {
    let db; try { db = await openDb(dbName); } catch { continue; }
    try {
      if ([...db.objectStoreNames].includes('profile')) {
        for (const f of await req(db.transaction('profile').objectStore('profile').get('files')) ?? []) {
          if (f.path.startsWith('/rwdir/')) files.push({ path: f.path.slice(7), data: f.data });
          else if (!f.path.startsWith('/')) files.push({ path: f.path, data: f.data }); // (re3: relative already)
        }
      } else if ([...db.objectStoreNames].includes('FILE_DATA')) {
        const os = db.transaction('FILE_DATA').objectStore('FILE_DATA'), keys = await req(os.getAllKeys()), values = await req(os.getAll());
        // (an account's database: its files under a folder of its own name)
        const prefix = dbName === saveKey ? '' : dbName.slice(saveKey.length + 1).replace(/[^A-Za-z0-9._-]/g, '_') + '/';
        keys.forEach((k, i) => { const v = values[i]; if (v?.contents && String(k).startsWith('/userdata/')) files.push({ path: prefix + String(k).slice(10), data: new Uint8Array(v.contents) }); });
      }
    } finally { db.close(); }
  }
  return files;
}
/** A port's game files fetched in this browser, deleted (fetched again when needed). */
export async function clearPortCache(saveKey) {
  for (const dbName of await portDbs(saveKey)) {
    const db = await openDb(dbName);
    try { if ([...db.objectStoreNames].includes('content')) await req(db.transaction('content', 'readwrite').objectStore('content').clear()); } finally { db.close(); }
  }
}
/** A port's saves in this browser, deleted (GoldSrc's profile entries, OpenMW's IDBFS databases). */
export async function clearPortSaves(saveKey) {
  for (const dbName of await portDbs(saveKey)) {
    const db = await openDb(dbName), stores = [...db.objectStoreNames];
    try { if (stores.includes('profile')) await req(db.transaction('profile', 'readwrite').objectStore('profile').clear()); } finally { db.close(); }
    if (!stores.includes('profile') && stores.includes('FILE_DATA')) await req(indexedDB.deleteDatabase(dbName));
  }
}
