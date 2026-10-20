/** Store writable profiles per installation, independently from content caches and engine releases. */
export async function openStorage(key) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(key, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('profile'); request.result.createObjectStore('content'); };
    request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
  });
}
export function readStorage(db, store, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
  });
}
export function writeStorage(db, store, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
/** Several entries ([key, value]) in one transaction. */
export function writeManyStorage(db, store, entries) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite'), os = tx.objectStore(store);
    for (const [key, value] of entries) os.put(value, key);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export function storageKeys(db, store) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAllKeys();
    request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
  });
}
export function removeStorage(db, store, keys) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite'), os = tx.objectStore(store);
    for (const key of keys) os.delete(key);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export function writableSnapshot(FS, root = '/rwdir') {
  const files = [];
  function walk(dir) {
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const file = dir + '/' + name, stat = FS.stat(file);
      if (FS.isDir(stat.mode)) walk(file);
      else if (FS.isFile(stat.mode)) files.push({ path: file, data: FS.readFile(file) });
    }
  }
  walk(root); return files;
}
export function restoreSnapshot(FS, files) {
  for (const file of files ?? []) {
    if (!file.path.startsWith('/rwdir/') || file.path.includes('..') || file.path.includes('\\')) throw new Error('Invalid save path');
    FS.mkdirTree(file.path.slice(0, file.path.lastIndexOf('/'))); FS.writeFile(file.path, file.data);
  }
}
