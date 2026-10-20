// The copies of an OpenMW installation's files that earlier versions of its page kept in this browser, taken into the
// game data every Orthros game reads (src/vfs/data-worker.js: the version's OPFS block store) before a file's first
// read, then removed — the player does not download again what is here. Imported by the data worker (adoptLegacy), told
// each mounted file by streamfs.js. The copies: Orthros' streaming of 2026-10-20 (OPFS orthros-streamfs-1/: a copy of
// each file at its offsets, <hash>.d, with a map of its 64 KB blocks, <hash>.m — a small file whole, no map) and the
// release's (Cache API mwdata-chunks-v1: 2 MB pieces).

const OLD_BLOCK = 65536, OLD_SMALL = 1 << 20, OLD_CHUNK = 2 << 20, RUN = 16 << 20;

/** The name an earlier page gave a file's copy (two 32-bit FNV-1a of its key). */
function oldName(key) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ key.length;
  for (let i = 0; i < key.length; i++) { const c = key.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193); h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 13); }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** What is there to take, listed once: the copies' directory and its names; the release's pieces by file. */
let kept = null;
function listing() {
  return (kept ??= (async () => {
    let dir = null; const names = new Set(), pieces = new Map();
    try { dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('orthros-streamfs-1'); for await (const n of dir.keys()) names.add(n); } catch { dir = null; }
    let cache = null;
    if (await caches.has('mwdata-chunks-v1').catch(() => false)) {
      cache = await caches.open('mwdata-chunks-v1');
      for (const req of await cache.keys()) {
        const m = /^https:\/\/sfs\.chunk\/([^/]+)\/(\d+)$/.exec(req.url); if (!m) continue;
        const key = decodeURIComponent(m[1]), at = key.indexOf('@'); if (at < 0) continue;
        const url = key.slice(0, at);
        (pieces.get(url) ?? pieces.set(url, []).get(url)).push({ req, key, at: Number(m[2]) });
      }
    }
    return { dir, names, cache, pieces };
  })());
}

/**
 * The copies of one file ({ url: its URL path, size, mtime: as the engine page mounted it }), handed to keep(at, bytes)
 * and removed.
 */
export async function adopt({ url, size, mtime }, keep) {
  const { dir, names, cache, pieces } = await listing();
  const base = oldName(`${url}@${size}@${mtime}`);
  if (dir && names.has(base + '.d')) {
    const copy = await (await dir.getFileHandle(base + '.d')).getFile();
    if (size <= OLD_SMALL) { if (copy.size === size) keep(0, new Uint8Array(await copy.arrayBuffer())); }
    else if (names.has(base + '.m')) {
      const map = new Uint8Array(await (await (await dir.getFileHandle(base + '.m')).getFile()).arrayBuffer());
      const blocks = Math.ceil(size / OLD_BLOCK), here = (k) => (map[k >> 3] >> (k & 7)) & 1;
      for (let k = 0; k < blocks;) {
        if (!here(k)) { k++; continue; }
        let e = k; while (e + 1 < blocks && here(e + 1) && (e + 1 - k) * OLD_BLOCK < RUN) e++;
        const at = k * OLD_BLOCK, end = Math.min(size, (e + 1) * OLD_BLOCK);
        if (end <= copy.size) keep(at, new Uint8Array(await copy.slice(at, end).arrayBuffer()));
        k = e + 1;
      }
    }
    for (const n of [base + '.d', base + '.m']) if (names.has(n)) { await dir.removeEntry(n).catch(() => {}); names.delete(n); }
  }
  for (const p of pieces.get(url) ?? []) {
    if (p.key.startsWith(`${url}@${size}@`) && p.key.endsWith(`@${OLD_CHUNK}`)) {
      const hit = await cache.match(p.req);
      const b = hit ? new Uint8Array(await hit.arrayBuffer()) : null;
      if (b && b.length === Math.min(OLD_CHUNK, size - p.at)) keep(p.at, b);
    }
    await cache.delete(p.req).catch(() => {});
  }
  pieces.delete(url);
}
