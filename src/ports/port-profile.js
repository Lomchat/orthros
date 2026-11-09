// A browser port's player profile in this browser — the same for every port (docs/profiles.md): one for the game,
// shared by its versions (profile-share.js profileKeyOf), in its own IndexedDB database (portProfileDb), apart from
// the installation's (the manifest's saveKey: the game files its earlier pages fetched, multiplayer and launcher state,
// per version). The copies its versions kept before in their installation's database are merged into it once
// (profile-share.js migrateProfile, profile-merge.js), and left there: the data window lists them as old copies.
//   GoldSrc and re3: a 'profile' store, its 'files' entry the engine's writable files [{ path, data }] (GoldSrc's under
//   /rwdir/, re3's relative to the game's folder) — openPortProfile;
//   OpenMW: the engine's /userdata IDBFS database, one per account (its scope) beside the anonymous one — migrateIdbfs,
//   called by the engine page before its first read of /userdata (src/host/openmw.js openmwWebText).
import { migrateProfile, portProfileDb, profileKeyOf, profileSourcesOf } from '../vfs/profile-share.js';
import { contentHash } from '../host/web/cloud-sync.js';
import { readStorage, writeStorage } from './goldsrc/storage.js';

const databases = async () => new Set((await indexedDB.databases?.() ?? []).map((d) => d.name));
const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** A GoldSrc or re3 profile database (its 'profile' store made when new). */
function openProfileStore(name) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('profile')) r.result.createObjectStore('profile'); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}

/**
 * A GoldSrc or re3 page's profile database, its versions' copies of before merged in (once). `toCloud(files)`: the
 * files the account keeps of a profile (the page's CloudSave reads them so: the merge's record is compared with its).
 * @param {any} config the version's /api/manifest
 * @param {{ toCloud: (files: any[]) => any[], log?: (msg: string) => void }} o
 */
export async function openPortProfile(config, { toCloud, log = () => {} }) {
  const key = profileKeyOf(config), db = await openProfileStore(portProfileDb(key)), have = await databases();
  const sources = profileSourcesOf(config).filter((s) => s.saveKey).map((s) => ({
    name: s.name,
    read: async () => {
      if (!have.has(s.saveKey)) return null;
      const old = await openProfileStore(s.saveKey);
      try { return old.objectStoreNames.contains('profile') ? (await readStorage(old, 'profile', 'files')) ?? null : null; } finally { old.close(); }
    },
  }));
  await migrateProfile({
    key, sources, settings: config.profileSettings, log,
    target: { read: () => readStorage(db, 'profile', 'files'), write: (files) => writeStorage(db, 'profile', 'files', files.map((f) => ({ path: f.path, data: f.data }))) },
    hashOf: (name, files) => contentHash(name, toCloud(files)),
  });
  return db;
}

/**
 * The files of an IDBFS database's /userdata: [{ path (relative), data, mtime }], its folders' entries, and whether its
 * dates are Date objects (an older Emscripten's) or numbers.
 */
async function userdata(db) {
  const os = db.transaction('FILE_DATA').objectStore('FILE_DATA');
  const [keys, values] = await Promise.all([request(os.getAllKeys()), request(os.getAll())]);
  const files = [], dirs = new Map();
  let dates = false;
  keys.forEach((k, i) => {
    const p = String(k), e = values[i];
    if (!p.startsWith('/userdata/') || !e) return;
    dates ||= e.timestamp instanceof Date;
    if (e.contents) files.push({ path: p.slice(10), data: e.contents, mtime: +e.timestamp });
    else dirs.set(p, e);
  });
  return { files, dirs, dates };
}

/**
 * An OpenMW page's /userdata database (`target`, profile-share.js portProfileDb) with its versions' databases of before
 * merged in, once — before the engine reads it (the page's IDBFS.getDB waits for this). `getDB`: IDBFS's own (the
 * database made as the engine makes it).
 * @param {any} IDBFS
 * @param {Function} getDB
 * @param {{ key: string, scope: string | null, settings?: string[], sources: { name: string, db: string }[] }} o
 */
export async function migrateIdbfs(IDBFS, getDB, { key, scope = null, settings = [], sources }) {
  const open = (name) => new Promise((resolve, reject) => getDB.call(IDBFS, name, (e, db) => (e ? reject(e) : resolve(db))));
  const have = await databases(), target = portProfileDb(key, scope), dirs = new Map();
  let dates = false; // (the engine's IDBFS dates its entries with Date objects: the merged ones too)
  const read = async (name) => { const u = await userdata(await open(name)); dates ||= u.dates; for (const [p, e] of u.dirs) if (!dirs.has(p)) dirs.set(p, e); return u.files; };
  const stamp = (ms) => (dates ? new Date(ms || Date.now()) : ms || Date.now());
  // (what the account keeps of it: cloud.js's list)
  const kept = (files) => files.filter((f) => !/(^|\/)screenshots\//i.test(f.path) && !/\.log(?:\.\d+)?$/i.test(f.path));
  await migrateProfile({
    key, scope, settings, log: (m) => console.log(m),
    sources: sources.map((s) => ({ name: s.name, read: () => (have.has(s.db) ? read(s.db) : Promise.resolve(null)) })),
    target: {
      read: () => read(target),
      write: async (files) => {
        const db = await open(target), tx = db.transaction('FILE_DATA', 'readwrite'), os = tx.objectStore('FILE_DATA');
        const ended = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
        // (each file's folders, as IDBFS makes them again from its entries: a source's entry, else one dated as the file;
        // a file: its date kept, IDBFS's file mode)
        const folders = new Map();
        for (const f of files) {
          const parts = f.path.split('/');
          for (let i = 1; i < parts.length; i++) {
            const p = '/userdata/' + parts.slice(0, i).join('/');
            if (!folders.has(p)) folders.set(p, dirs.get(p) ?? { timestamp: stamp(f.mtime), mode: 0o40777 });
          }
        }
        for (const [p, e] of folders) os.put(e, p);
        for (const f of files) os.put({ timestamp: stamp(f.mtime), mode: 0o100666, contents: f.data }, '/userdata/' + f.path);
        await ended;
      },
    },
    hashOf: (name, files) => contentHash(name, kept(files)),
  });
}
