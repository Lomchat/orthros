// PE32 image loader: parses headers, maps sections into guest memory (relocating if the
// preferred base is taken), resolves imports against builtin API modules or other loaded PE
// modules, and exposes exports, TLS and resource directories.

const DIR = Object.freeze({
  EXPORT: 0, IMPORT: 1, RESOURCE: 2, EXCEPTION: 3, SECURITY: 4, BASERELOC: 5, DEBUG: 6,
  TLS: 9, LOADCONFIG: 10, BOUND_IMPORT: 11, IAT: 12, DELAY_IMPORT: 13,
});
export { DIR as PE_DIR };

export class PeError extends Error {}

/** Parsed (not yet mapped) PE32 image. */
export class PeImage {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    const dv = (this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (bytes.length < 0x40 || dv.getUint16(0, true) !== 0x5a4d) throw new PeError('not a PE file (no MZ)');
    const pe = dv.getUint32(0x3c, true);
    if (pe + 24 > bytes.length || dv.getUint32(pe, true) !== 0x00004550) throw new PeError('no PE signature');
    this.machine = dv.getUint16(pe + 4, true);
    if (this.machine !== 0x14c) throw new PeError(`unsupported machine 0x${this.machine.toString(16)} (only i386)`);
    this.numSections = dv.getUint16(pe + 6, true);
    this.timestamp = dv.getUint32(pe + 8, true);
    const optSize = dv.getUint16(pe + 20, true);
    this.characteristics = dv.getUint16(pe + 22, true);
    this.isDll = (this.characteristics & 0x2000) !== 0;
    const opt = pe + 24;
    if (dv.getUint16(opt, true) !== 0x10b) throw new PeError('not PE32');
    this.entryRva = dv.getUint32(opt + 16, true);
    this.imageBase = dv.getUint32(opt + 28, true);
    this.sectionAlign = dv.getUint32(opt + 32, true);
    this.fileAlign = dv.getUint32(opt + 36, true);
    this.sizeOfImage = dv.getUint32(opt + 56, true);
    this.sizeOfHeaders = dv.getUint32(opt + 60, true);
    this.subsystem = dv.getUint16(opt + 68, true);
    this.dllCharacteristics = dv.getUint16(opt + 70, true);
    this.stackReserve = dv.getUint32(opt + 72, true);
    this.stackCommit = dv.getUint32(opt + 76, true);
    this.heapReserve = dv.getUint32(opt + 80, true);
    const ndirs = dv.getUint32(opt + 92, true);
    this.dirs = [];
    for (let i = 0; i < Math.min(ndirs, 16); i++) {
      this.dirs.push({ rva: dv.getUint32(opt + 96 + 8 * i, true), size: dv.getUint32(opt + 100 + 8 * i, true) });
    }
    while (this.dirs.length < 16) this.dirs.push({ rva: 0, size: 0 });
    this.sections = [];
    let sh = opt + optSize;
    for (let i = 0; i < this.numSections; i++, sh += 40) {
      let name = '';
      for (let k = 0; k < 8 && bytes[sh + k]; k++) name += String.fromCharCode(bytes[sh + k]);
      this.sections.push({
        name,
        virtualSize: dv.getUint32(sh + 8, true),
        rva: dv.getUint32(sh + 12, true),
        rawSize: dv.getUint32(sh + 16, true),
        rawPtr: dv.getUint32(sh + 20, true),
        characteristics: dv.getUint32(sh + 36, true),
      });
    }
  }

  /** Read a NUL-terminated string at a file offset. */
  cstr(off) {
    let s = '';
    while (off < this.bytes.length && this.bytes[off]) s += String.fromCharCode(this.bytes[off++]);
    return s;
  }
}

/**
 * A module mapped in guest memory.
 * @typedef {object} PeModule
 * @property {string} name lowercase file name, e.g. 'lotrbfme.exe'
 * @property {string} path guest path
 * @property {number} base
 * @property {number} size
 * @property {number} entry absolute entry point (0 if none)
 * @property {boolean} isDll
 * @property {Map<string, number>} exports name -> address (or forwarder string via forwards)
 * @property {Map<number, number>} ordinals ordinal -> address
 * @property {Map<string, string>} forwards name -> "dll.name"
 * @property {Array<{dll: string, name: string|null, ordinal: number|null, iat: number}>} imports
 * @property {PeImage} image
 */

/**
 * Map an image into guest memory.
 * @param {PeImage} img
 * @param {import('../cpu/memory.js').GuestMemory} mem
 * @param {import('../win32/vmem.js').VMem} vmem
 * @param {{ name: string, path: string, preferredBase?: number }} opts
 * @returns {PeModule}
 */
export function mapImage(img, mem, vmem, opts) {
  const size = alignUp(img.sizeOfImage, 0x1000);
  let base = opts.preferredBase ?? img.imageBase;
  if (!vmem.isFree(base, size)) base = 0;
  base = vmem.reserve(size, base, 'image:' + opts.name);
  if (!base) throw new PeError(`cannot map ${opts.name}: no address space`);
  vmem.commit(base, size, 0x40 /* PAGE_EXECUTE_READWRITE */);
  mem.fill(base, size, 0);
  // headers
  mem.writeBytes(base, img.bytes.subarray(0, Math.min(img.sizeOfHeaders, img.bytes.length)));
  for (const s of img.sections) {
    const n = Math.min(s.rawSize, s.virtualSize || s.rawSize);
    if (n > 0 && s.rawPtr + n <= img.bytes.length) mem.writeBytes(base + s.rva, img.bytes.subarray(s.rawPtr, s.rawPtr + n));
  }
  const mod = {
    name: opts.name.toLowerCase(),
    path: opts.path,
    base,
    size,
    entry: img.entryRva ? base + img.entryRva : 0,
    isDll: img.isDll,
    exports: new Map(),
    ordinals: new Map(),
    forwards: new Map(),
    imports: [],
    image: img,
    tls: null,
    refCount: 1,
    attached: false,
  };
  if (base !== img.imageBase) relocate(mod, mem);
  parseExports(mod, mem);
  parseImports(mod, mem);
  parseTls(mod, mem);
  return mod;
}

function alignUp(v, a) { return (v + a - 1) & ~(a - 1); }

function relocate(mod, mem) {
  const dir = mod.image.dirs[DIR.BASERELOC];
  const delta = (mod.base - mod.image.imageBase) | 0;
  if (!dir.rva || !dir.size) {
    if (delta !== 0 && mod.image.dirs[DIR.IMPORT].rva) throw new PeError(`${mod.name}: relocated without .reloc`);
    return;
  }
  let p = mod.base + dir.rva;
  const end = p + dir.size;
  while (p + 8 <= end) {
    const pageRva = mem.read32(p), blockSize = mem.read32(p + 4);
    if (blockSize < 8) break;
    const n = (blockSize - 8) >> 1;
    for (let i = 0; i < n; i++) {
      const e = mem.read16(p + 8 + 2 * i);
      const type = e >> 12, off = e & 0xfff;
      const a = mod.base + pageRva + off;
      if (type === 3) mem.write32(a, (mem.read32(a) + delta) >>> 0);
      else if (type === 1) mem.write16(a, (mem.read16(a) + (delta >> 16)) & 0xffff);
      else if (type === 2) mem.write16(a, (mem.read16(a) + (delta & 0xffff)) & 0xffff);
      // type 0: padding
    }
    p += blockSize;
  }
}

function parseExports(mod, mem) {
  const dir = mod.image.dirs[DIR.EXPORT];
  if (!dir.rva || !dir.size) return;
  const b = mod.base, e = b + dir.rva;
  const ordBase = mem.read32(e + 16);
  const nFuncs = mem.read32(e + 20), nNames = mem.read32(e + 24);
  const funcs = b + mem.read32(e + 28), names = b + mem.read32(e + 32), nameOrds = b + mem.read32(e + 36);
  const isForwarder = (rva) => rva >= dir.rva && rva < dir.rva + dir.size;
  for (let i = 0; i < nFuncs; i++) {
    const rva = mem.read32(funcs + 4 * i);
    if (!rva) continue;
    if (isForwarder(rva)) mod.forwards.set('#' + (ordBase + i), mem.readCString(b + rva));
    else mod.ordinals.set(ordBase + i, b + rva);
  }
  for (let i = 0; i < nNames; i++) {
    const name = mem.readCString(b + mem.read32(names + 4 * i));
    const idx = mem.read16(nameOrds + 2 * i);
    const rva = mem.read32(funcs + 4 * idx);
    if (!rva) continue;
    if (isForwarder(rva)) mod.forwards.set(name, mem.readCString(b + rva));
    else mod.exports.set(name, b + rva);
  }
}

function parseImports(mod, mem) {
  const dir = mod.image.dirs[DIR.IMPORT];
  if (!dir.rva) return;
  const b = mod.base;
  let d = b + dir.rva;
  for (;;) {
    const oft = mem.read32(d), nameRva = mem.read32(d + 12), ft = mem.read32(d + 16);
    if (!nameRva && !ft) break;
    const dll = mem.readCString(b + nameRva).toLowerCase();
    let lookup = b + (oft || ft), iat = b + ft;
    for (;;) {
      const v = mem.read32(lookup);
      if (!v) break;
      if (v & 0x80000000) mod.imports.push({ dll, name: null, ordinal: v & 0xffff, iat });
      else mod.imports.push({ dll, name: mem.readCString(b + v + 2), ordinal: null, iat });
      lookup += 4; iat += 4;
    }
    d += 20;
  }
}

function parseTls(mod, mem) {
  const dir = mod.image.dirs[DIR.TLS];
  if (!dir.rva || dir.size < 24) return;
  const t = mod.base + dir.rva;
  const start = mem.read32(t), end = mem.read32(t + 4), indexAddr = mem.read32(t + 8), callbacks = mem.read32(t + 12), zeroFill = mem.read32(t + 16);
  const cbs = [];
  if (callbacks) {
    for (let p = callbacks; ; p += 4) { const cb = mem.read32(p); if (!cb) break; cbs.push(cb); if (cbs.length > 64) break; }
  }
  mod.tls = { start, end, indexAddr, callbacks: cbs, zeroFill, size: (end - start) + zeroFill, index: -1 };
}

/**
 * Find a resource by type/name/language in the resource directory. Type/name may be numbers
 * (ids) or strings. Returns { addr, size } or null.
 */
export function findResource(mod, mem, type, name, lang = -1) {
  const dir = mod.image.dirs[DIR.RESOURCE];
  if (!dir.rva) return null;
  const root = mod.base + dir.rva;
  const walk = (tbl, key) => {
    const nNamed = mem.read16(tbl + 12), nId = mem.read16(tbl + 14);
    for (let i = 0; i < nNamed + nId; i++) {
      const e = tbl + 16 + 8 * i;
      const id = mem.read32(e), off = mem.read32(e + 4);
      let match;
      if (key === -1 || key === undefined) match = true;
      else if (id & 0x80000000) {
        if (typeof key !== 'string') continue;
        const sa = root + (id & 0x7fffffff);
        const len = mem.read16(sa);
        const s = mem.readWString(sa + 2, len);
        match = s.toLowerCase() === key.toLowerCase();
      } else match = typeof key === 'number' && id === key;
      if (match) return off;
    }
    return null;
  };
  const t = walk(root, type);
  if (t === null || !(t & 0x80000000)) return null;
  const n = walk(root + (t & 0x7fffffff), name);
  if (n === null || !(n & 0x80000000)) return null;
  const l = walk(root + (n & 0x7fffffff), lang);
  if (l === null || l & 0x80000000) return null;
  const entry = root + l;
  return { addr: mod.base + mem.read32(entry), size: mem.read32(entry + 4) };
}
