// Command ring of the render worker (docs/render-worker.md, D063): the emulator records the Direct3D work of its
// devices — state changes, resource lifetimes, draws, presents — as commands of 32-bit words into a ring; the render
// worker (or, ?glworker=inline, the same thread later) replays them into a mirror of each device that the unchanged
// WebGL backend reads. One table below names every command and the kinds of its arguments: the recorder's encoders
// and the replayer's decoder both follow it (tests/render-ring.test.js checks every command round trip).
//
// Layout: a command is a header word (opcode | payload words << 8) and its payload; a command never straddles the
// end of the ring (a WRAP header fills the rest). Positions are word counts since the start (JavaScript numbers on
// each side, exact to 2^53); the shared control words hold their low 32 bits, from which the other side rebuilds the
// full count (the distance between the two sides is always less than the ring).

/**
 * Argument kinds: u uint32, i int32, f float32 (bit-exact), n any number (a tag word, then 1 or 2 words: uint32,
 * int32, float64 bits, or undefined), w words (a count, then that many uint32), b bytes (a byte count, then the bytes
 * padded to whole words).
 */
export const OPS = [
  ['WRAP', ''],
  // devices
  ['DEVICE', 'uuuuu'], // id, api9, pp width, height, swap effect
  ['SELECT', 'u'], // device id the following commands apply to
  ['DEVICE_DESTROY', 'u'],
  ['PP', 'uuuu'], // width, height, swap, back buffer count
  ['RESET', ''],
  ['API9', 'u'], // a Direct3D 9 device (known once its constructor ran: its backend is created by the Direct3D 8 part)
  // state
  ['TABLES', 'uu'], // fresh state tables: texture stages, samplers (0 for a Direct3D 8 device)
  ['TSET', 'uun'], // table (0 render states, 1 + stage, 1 + stages + sampler), key, value
  ['TSETS', 'w'], // several uint32 values at once: (table, key, value) triples
  ['VIEWPORT', 'nnnnff'],
  ['SCISSOR', 'uiiii'], // present, l, t, r, b
  ['FVF', 'n'],
  ['DECL', 'u'], // vertex declaration id (0: none)
  ['VS9', 'u'], ['PS9', 'u'], // shader ids (0: none)
  ['VS8', 'nu'], ['PS8', 'nu'], // handle (or FVF), shader id at that handle (0: none)
  ['STREAM', 'uunn'], // stream, buffer id, stride, offset
  ['STREAMS', 'u'], // fresh stream array of that length
  ['INDICES', 'un'], // index buffer id, base
  ['TEXTURE', 'uu'], // stage, texture id
  ['TEXTURES', 'u'], // fresh stage texture array of that length
  ['RT', 'u'], // render target 0 surface id
  ['BACKBUFFERS', 'w'],
  ['VERSION', 'un'], // counter index (VERSION_FIELDS), value
  ['XFORMS', ''], // fresh transform maps
  ['XFORM', 'unw'], // slot, slot version, matrix (16 words; none: deleted)
  ['LIGHTS', ''], // fresh light map and enabled set
  ['LIGHT', 'uw'], // index, 26 words
  ['LIGHTS_ON', 'w'], // enabled light indices, in the set's order
  ['MATERIAL', 'w'],
  ['CONSTS', 'uuuuuu'], // fresh constant arrays: lengths of vs/ps float (in floats), vs/ps int (in ints), vs/ps bool
  ['CONST', 'uuw'], // array (CONST_FIELDS), first element, elements as words (bools: one word each)
  // resources
  ['TEX', 'uuuuuuuuuuw'], // id, kind (1 2D, 2 cube, 3 volume), fmt, width, height, depth, usage, pool, slot, generation, levels: [id, w, h, d, mem] each (cube: face by face)
  ['SURF', 'uuuuuuuu'], // id, fmt, width, height, usage, pool, mem, lockable
  ['BUF', 'uuuuuuuu'], // id, type, length, usage, fmt, mem, slot, gen
  ['DESTROY', 'u'],
  ['SURF_MEM', 'uu'],
  ['SURF_DIRTY', 'uuw'], // surface id, generation, rectangle (none: whole surface)
  ['BUF_DIRTY', 'uuuuu'], // buffer id, generation, start, size, mem
  ['VOL_MEM', 'uuu'], // texture id, level, mem
  ['SHADER9', 'uuuw'], // id, kind (0 vertex, 1 pixel), handle, code
  ['SHADER8', 'uuunww'], // id, kind, handle, usage, declaration tokens, code (none: fixed-function vertex processing)
  ['SHADER_DELETE', 'u'],
  ['DECL_CREATE', 'ub'],
  ['DECL_DELETE', 'u'],
  ['FORGET', 'u'], // a resource the device no longer refers to (old back buffers after Reset): dropped from the mirror only
  // work
  ['BEGIN_SCENE', ''],
  ['CLEAR', 'uuunuw'], // rect count, flags, color, z, stencil, rects (4 words each)
  ['DRAW', 'uuu'], // type, start, primitive count
  ['DRAW_INDEXED', 'uuuuun'], // type, min index, vertex count, start, primitive count, base vertex
  ['DRAW_UP', 'uuub'], // type, count, stride, vertices
  ['DRAW_INDEXED_UP', 'uuuuuubb'], // type, min index, vertex count, count, index format, stride, vertices, indices
  ['PRESENT', 'u'], // frame number
  ['READBACK', 'uuu'], // surface id, ticket, guest memory for the pixels (the surface's, given to it once read as in the backend)
  ['STRETCH', 'uuuww'], // source id, destination id, filter, source rectangle, destination rectangle (none: whole)
  ['GAMMA', 'b'],
  ['CANVAS', 'uu'], // the display's size (the canvas the frames are presented on)
];
export const OP = Object.fromEntries(OPS.map(([name], i) => [name, i]));
export const OP_NAMES = OPS.map(([name]) => name);
/** version counters of a device, in VERSION records */
export const VERSION_FIELDS = ['stateVersion', 'programVersion', 'transformVersion', 'lightVersion', 'viewportVersion', 'constVersion', 'transformAllVersion'];
/** constant arrays of a device, in CONST records */
export const CONST_FIELDS = ['vsConst', 'psConst', 'vsConstI', 'psConstI', 'vsConstB', 'psConstB'];

// control block: one word per 64-byte line, each written by one side
export const CTL = {
  HEAD: 0, // emulator: low 32 bits of the words produced and published
  FRAMES: 16, // emulator: frames produced (PRESENT commands)
  EMU_WAIT: 32, // emulator: 1 while it waits for the render worker (TAIL, SHOWN, READBACK): notify it
  TAIL: 48, // render worker: low 32 bits of the words consumed
  SHOWN: 64, // render worker: frames handed to the page
  READBACK: 80, // render worker: ticket of the last readback done
  HEARTBEAT: 96, // render worker: incremented as it runs
  SLEEP: 112, // render worker: 1 while it sleeps waiting for HEAD
  READY: 128, // render worker: 1 when its context is up, -1 when it failed
  EPOCH: 144, // render worker: incremented at each context restoration
  REPLAY_US: 160, // render worker: microseconds spent replaying (running total)
};
export const CTL_WORDS = 192;
export const TWO32 = 4294967296;
/** acknowledgement table: per resource slot, the generation of its contents the render worker last uploaded */
export const ACK_SLOTS = 1 << 16;

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const f64 = new Float64Array(1), u32x2 = new Uint32Array(f64.buffer);
export const f32bits = (v) => { f32[0] = v; return u32[0]; };
export const bitsF32 = (w) => { u32[0] = w; return f32[0]; };

/** Producer side of a ring. `waitSpace(neededTotal)` is called when the ring is full (must make room or throw). */
export class RingWriter {
  /** @param {Int32Array} words the ring (a power-of-two length) */
  constructor(words, waitSpace) {
    this.I = words; this.F = new Float32Array(words.buffer, words.byteOffset, words.length);
    this.U8 = new Uint8Array(words.buffer, words.byteOffset, words.length * 4);
    this.size = words.length; this.mask = words.length - 1;
    this.produced = 0; // words written
    this.consumed = 0; // words the consumer is known to have read (refreshed by the transport)
    this.waitSpace = waitSpace;
  }
  /** Reserve a command of `op` with `n` payload words: returns the index of its first payload word. */
  begin(op, n) {
    const need = n + 1;
    let pos = this.produced & this.mask;
    if (pos + need > this.size) { // (the rest of the ring: a WRAP command, the command at the start)
      if (need > (this.size >> 1)) throw new Error(`render command of ${need} words exceeds the ring`);
      const rest = this.size - pos;
      if (this.produced + rest + need - this.consumed > this.size) this.waitSpace(this.produced + rest + need);
      this.I[pos] = OP.WRAP | ((rest - 1) << 8);
      this.produced += rest; pos = 0;
    }
    if (this.produced + need - this.consumed > this.size) this.waitSpace(this.produced + need);
    this.I[pos] = op | (n << 8);
    this.produced += need;
    return pos + 1;
  }
  // (fixed-size commands of uint32 / int32 words)
  c0(op) { this.begin(op, 0); }
  c1(op, a) { const p = this.begin(op, 1); this.I[p] = a; }
  c2(op, a, b) { const p = this.begin(op, 2); const I = this.I; I[p] = a; I[p + 1] = b; }
  c3(op, a, b, c) { const p = this.begin(op, 3); const I = this.I; I[p] = a; I[p + 1] = b; I[p + 2] = c; }
  /** number of words a value of kind 'n' takes */
  static nWords(v) { return v === undefined ? 1 : (v >>> 0) === v || (v | 0) === v ? 2 : 3; }
  /** write a kind-'n' value at p, returns the next index */
  putN(p, v) {
    const I = this.I;
    if (v === undefined) { I[p] = 3; return p + 1; }
    if ((v >>> 0) === v) { I[p] = 0; I[p + 1] = v; return p + 2; }
    if ((v | 0) === v) { I[p] = 1; I[p + 1] = v; return p + 2; }
    f64[0] = v; I[p] = 2; I[p + 1] = u32x2[0]; I[p + 2] = u32x2[1]; return p + 3;
  }
  /** write a word array (count then words) at p from an integer array-like `a` (offset o, count n) */
  putW(p, a, o = 0, n = a ? a.length : 0) {
    const I = this.I;
    if (!a) { I[p] = -1; return p + 1; } // (none)
    I[p] = n; for (let i = 0; i < n; i++) I[p + 1 + i] = a[o + i];
    return p + 1 + n;
  }
  /** bytes (count, then the bytes padded to words) at p from a Uint8Array view */
  putB(p, bytes) {
    const n = bytes.length;
    this.I[p] = n;
    this.U8.set(bytes, (p + 1) * 4);
    return p + 1 + ((n + 3) >> 2);
  }
  /**
   * Generic encoder from the table (tests, rare commands): args in order; 'w' takes an integer array (null: none),
   * 'b' a Uint8Array, 'f' a number.
   */
  put(op, ...args) {
    const kinds = OPS[op][1];
    let n = 0;
    for (let k = 0; k < kinds.length; k++) {
      const a = args[k];
      switch (kinds[k]) { case 'n': n += RingWriter.nWords(a); break; case 'w': n += 1 + (a ? a.length : 0); break; case 'b': n += 1 + ((a.length + 3) >> 2); break; default: n++; }
    }
    let p = this.begin(op, n);
    for (let k = 0; k < kinds.length; k++) {
      const a = args[k];
      switch (kinds[k]) {
        case 'n': p = this.putN(p, a); break;
        case 'w': p = this.putW(p, a); break;
        case 'b': p = this.putB(p, a); break;
        case 'f': this.I[p++] = f32bits(a); break;
        default: this.I[p++] = a;
      }
    }
  }
}

/** Consumer side: decode the arguments of the command at payload index p (kinds from the table). */
export class RingReader {
  constructor(words) {
    this.I = words; this.F = new Float32Array(words.buffer, words.byteOffset, words.length);
    this.U8 = new Uint8Array(words.buffer, words.byteOffset, words.length * 4);
    this.size = words.length; this.mask = words.length - 1;
    this.consumed = 0;
    this.args = []; // (decoded arguments of the current command: reused)
  }
  /** Decode the next command (consumed < available): { op, p, n } with its payload words, or null at a WRAP. */
  next() {
    const pos = this.consumed & this.mask, h = this.I[pos], op = h & 0xff, n = h >>> 8;
    this.consumed += n + 1;
    if (op === OP.WRAP) return null;
    this.op = op; this.p = pos + 1; this.n = n;
    return this;
  }
  /** decoded arguments of the current command per the table: numbers, 'w' as an Int32Array view (or null), 'b' a Uint8Array view */
  decode() {
    const kinds = OPS[this.op][1], I = this.I, out = this.args;
    let p = this.p; out.length = kinds.length;
    for (let k = 0; k < kinds.length; k++) {
      switch (kinds[k]) {
        case 'u': out[k] = I[p++] >>> 0; break;
        case 'i': out[k] = I[p++]; break;
        case 'f': out[k] = this.F[p++]; break;
        case 'n': { const t = I[p]; if (t === 3) { out[k] = undefined; p++; } else if (t === 0) { out[k] = I[p + 1] >>> 0; p += 2; } else if (t === 1) { out[k] = I[p + 1]; p += 2; } else { u32x2[0] = I[p + 1]; u32x2[1] = I[p + 2]; out[k] = f64[0]; p += 3; } break; }
        case 'w': { const c = I[p]; if (c < 0) { out[k] = null; p++; } else { out[k] = I.subarray(p + 1, p + 1 + c); p += 1 + c; } break; }
        case 'b': { const c = I[p]; out[k] = this.U8.subarray((p + 1) * 4, (p + 1) * 4 + c); p += 1 + ((c + 3) >> 2); break; }
        default: throw new Error(`bad kind ${kinds[k]}`);
      }
    }
    return out;
  }
}
