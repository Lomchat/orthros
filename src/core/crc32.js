// CRC-32 (IEEE 802.3, the zlib / PNG one), shared by the PNG encoder (src/gfx/codecs/png.js) and the PCM transport
// codec (src/vfs/pcm-codec.js).
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

/** CRC-32 of b[start, end) */
export function crc32(b, start = 0, end = b.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
