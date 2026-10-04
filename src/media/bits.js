// Bit reader and variable-length code tables for the MPEG decoders (src/media). Big-endian bit order, as the MPEG
// bitstreams are written. The reader works on a byte array padded with zeros (reads past the end see zero bits).

export class BitReader {
  /** @param {Uint8Array} bytes @param {number} [start] byte offset @param {number} [end] byte end (exclusive) */
  constructor(bytes, start = 0, end = bytes.length) {
    // (4 zero bytes of padding: peek() reads a 32-bit window without bounds checks)
    if (bytes.length < end + 4) { const p = new Uint8Array(end + 4); p.set(bytes.subarray(0, end)); bytes = p; }
    this.b = bytes; this.pos = start * 8; this.end = end * 8;
  }
  /** the next n bits (n <= 24) without consuming them */
  peek(n) {
    const p = this.pos, i = p >>> 3, b = this.b;
    const w = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    return ((w << (p & 7)) >>> 0) >>> (32 - n);
  }
  /** read n bits (n <= 24) */
  read(n) { const v = this.peek(n); this.pos += n; return v; }
  /** read n bits (n <= 32) */
  read32(n) { if (n <= 24) return this.read(n); const hi = this.read(n - 16); return hi * 65536 + this.read(16); }
  skip(n) { this.pos += n; }
  get left() { return this.end - this.pos; }
  align() { this.pos = (this.pos + 7) & ~7; }
  /** at a start code prefix (0x000001, byte aligned)? */
  atStartCode() { return (this.pos & 7) === 0 && this.peek(24) === 1; }
  /**
   * Move to the next start code (byte aligned 00 00 01 xx) at or after the current position: returns its code byte
   * (the reader is placed after it) or -1 at the end.
   */
  nextStartCode() {
    this.align();
    const b = this.b, end = this.end >>> 3;
    for (let i = this.pos >>> 3; i + 3 < end; i++) {
      if (b[i + 2] > 1) { i += 2; continue; } // (no prefix can end at i + 2: skip ahead)
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) { this.pos = (i + 4) * 8; return b[i + 3]; }
    }
    this.pos = this.end;
    return -1;
  }
}

/**
 * A prefix code as a lookup table indexed by the next `bits` bits. `codes`: [bit string, value] pairs.
 * lookup(br) consumes the code and returns its value (or `invalid` when the bits match no code: a corrupt stream).
 */
export class Vlc {
  constructor(codes, invalid = -0x7fff) {
    const bits = Math.max(...codes.map(([s]) => s.length));
    this.bits = bits; this.invalid = invalid;
    this.len = new Uint8Array(1 << bits);
    this.val = new Int32Array(1 << bits).fill(invalid);
    for (const [s, v] of codes) {
      const n = s.length, base = parseInt(s, 2) << (bits - n);
      for (let j = 0; j < 1 << (bits - n); j++) {
        if (this.len[base + j]) throw new Error(`Vlc: code ${s} overlaps another code`);
        this.len[base + j] = n; this.val[base + j] = v;
      }
    }
  }
  read(br) {
    const i = br.peek(this.bits), n = this.len[i];
    if (!n) { br.skip(1); return this.invalid; }
    br.skip(n);
    return this.val[i];
  }
}
