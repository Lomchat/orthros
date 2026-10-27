// WAD3: GoldSrc's texture archives — a 12-byte header ('WAD3', its lumps' count, its directory's offset), the lumps, then
// the directory (32 bytes a lump: offset, size in the file, size, type, compression, two pad bytes, a 16-byte name).
// One reader for every place that reads one: the server's light copies (src/host/light-copies.js: a texture's finest
// level redrawn) and a GoldSrc page that announces the textures a map's load reads (src/ports/goldsrc/bsp-reads.js).
// Pure: bytes in (a Uint8Array or a Buffer), values out — Node and the browser alike.

/** WAD3 lump type of a texture with its mip levels (miptex) */
export const WAD_MIPTEX = 0x43;
/** Bytes of a directory entry. */
export const WAD_ENTRY = 32;

/**
 * A WAD3's header (its first 12 bytes at least) in a file of `size` bytes: { n, dir } — its lumps' count and its
 * directory's offset —, or null: not a WAD3, or a directory that does not fit in the file.
 * @param {Uint8Array} head
 * @param {number} size
 */
export function wadHeader(head, size) {
  if (head.length < 12 || head[0] !== 0x57 || head[1] !== 0x41 || head[2] !== 0x44 || head[3] !== 0x33) return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength), n = v.getInt32(4, true), dir = v.getInt32(8, true);
  return n > 0 && n < 1 << 20 && dir >= 12 && dir + n * WAD_ENTRY <= size ? { n, dir } : null;
}

/**
 * The directory's entries (`bytes`: its n × 32 bytes) of a WAD3 of `size` bytes: [{ name, pos, disk, size, type, comp }]
 * — name lower case (the engine finds a texture by its name without case), up to its first NUL —, those whose bytes
 * lie in the file (after the header) only.
 * @param {Uint8Array} bytes
 * @param {number} n
 * @param {number} size
 */
export function wadEntries(bytes, n, size) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
  for (let i = 0; i < n && (i + 1) * WAD_ENTRY <= bytes.length; i++) {
    const at = i * WAD_ENTRY, pos = v.getInt32(at, true), disk = v.getInt32(at + 4, true);
    if (!(pos >= 12 && disk >= 0 && pos + disk <= size)) continue;
    let name = '';
    for (let k = at + 16; k < at + 32 && bytes[k]; k++) name += String.fromCharCode(bytes[k]);
    out.push({ name: name.toLowerCase(), pos, disk, size: v.getInt32(at + 8, true), type: bytes[at + 12], comp: bytes[at + 13] });
  }
  return out;
}
