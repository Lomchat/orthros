// Win32 API registry: builtin DLL modules whose exports are host (JS) functions reached through
// thunk addresses. Calling a thunk makes the executor exit to the dispatcher (EXIT.THUNK, see
// DECISIONS.md D004), which runs the handler and performs the callee/caller stack cleanup.
import { THUNK_BASE, THUNK_END, THUNK_SIZE } from '../cpu/memory.js';

export const CC_STDCALL = 0, CC_CDECL = 1;

/** pseudo-DLLs of Orthros' own (no module image) */
const INTERNAL_DLLS = new Set(['com.dll', 'orthros.dll']);
/** free slots of a module image for functions it does not export (unknown imports); then header-less pages */
const SLACK_SLOTS = 64;
const CHUNK_SIZE = 0x1000;
/** size of the headers (MZ, PE, one section header) and alignment of the image's section: the export directory and
 * the thunks follow at once (a small-alignment image, mapped as one region as Windows maps such images) */
const HDR = 0x200;
const alignUp = (v, a) => (v + a - 1) & ~(a - 1);

/** @typedef {{ dll: string, base: number, end: number, chunk: { next: number, end: number } }} ThunkWindow */

/**
 * Layout of a builtin DLL's image: headers, the export directory (at HDR), then the thunk slots (16-byte aligned, at
 * headerSize). funcs: the export address table (function name per ordinal - 1, null for an unused
 * ordinal); names: [name, EAT index] sorted by name (the order a binary search of the name table expects).
 * @param {string} dllName
 * @param {{ funcs: Map<string, any>, ordinals: Map<number, string> } | undefined} d
 */
export function buildExportImage(dllName, d) {
  /** @type {(string|null)[]} */
  const funcs = [];
  if (d) {
    const index = new Map();
    let maxOrd = 0;
    for (const ord of d.ordinals.keys()) if (ord > maxOrd && ord < 0x10000) maxOrd = ord;
    for (let i = 0; i < maxOrd; i++) funcs.push(null);
    for (const [ord, name] of [...d.ordinals].sort((a, b) => a[0] - b[0])) if (ord >= 1 && ord < 0x10000 && !index.has(name)) { funcs[ord - 1] = name; index.set(name, ord - 1); }
    for (const name of d.funcs.keys()) if (!index.has(name) && !name.startsWith('#')) { index.set(name, funcs.length); funcs.push(name); }
  }
  const names = [];
  for (let i = 0; i < funcs.length; i++) if (funcs[i] !== null && !funcs[i].startsWith('#')) names.push([funcs[i], i]);
  names.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let strBytes = dllName.length + 1;
  for (const [n] of names) strBytes += n.length + 1;
  const exportSize = 40 + 4 * funcs.length + 6 * names.length + strBytes;
  return { funcs, names, exportSize, headerSize: alignUp(HDR + exportSize, 16) };
}

/** Write a builtin DLL's MZ/PE headers and export directory at its base (eat: function RVA per ordinal - 1). */
function writeExportImage(mem, base, size, dllName, img, eat) {
  mem.fill(base, img.headerSize, 0);
  const pe = base + 0x40;
  mem.write16(base, 0x5a4d); // MZ
  mem.write32(base + 0x3c, 0x40); // e_lfanew
  mem.write32(pe, 0x4550); // PE\0\0
  // file header: i386, one section, optional header size, DLL | 32-bit machine | executable image
  mem.write16(pe + 4, 0x14c); mem.write16(pe + 6, 1); mem.write16(pe + 20, 0xe0); mem.write16(pe + 22, 0x2102);
  const oh = pe + 24;
  mem.write16(oh, 0x10b); // PE32
  mem.write32(oh + 4, size - HDR); // SizeOfCode
  mem.write32(oh + 20, HDR); // BaseOfCode
  mem.write32(oh + 28, base); // ImageBase
  mem.write32(oh + 32, HDR); mem.write32(oh + 36, HDR); // section / file alignment (equal: below a page)
  mem.write16(oh + 40, 5); mem.write16(oh + 42, 1); // OS version 5.1
  mem.write16(oh + 48, 5); mem.write16(oh + 50, 1); // subsystem version 5.1
  mem.write32(oh + 56, size); // SizeOfImage
  mem.write32(oh + 60, HDR); // SizeOfHeaders
  mem.write16(oh + 68, 3); // subsystem: Windows CUI (as system DLLs)
  mem.write32(oh + 72, 0x40000); mem.write32(oh + 76, 0x1000); mem.write32(oh + 80, 0x100000); mem.write32(oh + 84, 0x1000); // stack / heap
  mem.write32(oh + 92, 16); // NumberOfRvaAndSizes
  mem.write32(oh + 96, HDR); mem.write32(oh + 100, img.exportSize); // export directory
  const sh = oh + 0xe0;
  for (let i = 0; i < 5; i++) mem.write8(sh + i, '.text'.charCodeAt(i));
  mem.write32(sh + 8, size - HDR); mem.write32(sh + 12, HDR); // VirtualSize, VirtualAddress
  mem.write32(sh + 16, size - HDR); mem.write32(sh + 20, HDR); // SizeOfRawData, PointerToRawData
  mem.write32(sh + 36, 0x60000020); // code | execute | read
  // export directory
  const ed = base + HDR, nf = img.funcs.length, nn = img.names.length;
  const eatRva = HDR + 40, namesRva = eatRva + 4 * nf, ordsRva = namesRva + 4 * nn;
  let str = ordsRva + 2 * nn;
  const putStr = (s) => { for (let i = 0; i < s.length; i++) mem.write8(base + str + i, s.charCodeAt(i) & 0xff); str += s.length + 1; };
  mem.write32(ed + 12, str); putStr(dllName); // Name
  mem.write32(ed + 16, 1); // ordinal base
  mem.write32(ed + 20, nf); mem.write32(ed + 24, nn);
  mem.write32(ed + 28, eatRva); mem.write32(ed + 32, namesRva); mem.write32(ed + 36, ordsRva);
  for (let i = 0; i < nf; i++) mem.write32(base + eatRva + 4 * i, eat[i]);
  img.names.forEach(([name, i], k) => { mem.write32(base + namesRva + 4 * k, str); mem.write16(base + ordsRva + 2 * k, i); putStr(name); });
}

/**
 * @typedef {object} ApiDef
 * @property {string} name
 * @property {number} argc number of 32-bit stack arguments
 * @property {number} cc
 * @property {(ctx: import('./ctx.js').Ctx) => (number|undefined)} fn returns EAX (undefined: unchanged)
 * @property {string} dll
 * @property {boolean} [stub] auto-generated tracing stub
 * @property {boolean} [noreturn] handler manages EIP/ESP itself (thread switches, exits)
 */

export class ApiRegistry {
  /** @param {import('../cpu/memory.js').GuestMemory|null} [mem] guest memory (the module images are written there) */
  constructor(mem = null) {
    this.mem = mem;
    /** @type {Map<string, ThunkWindow>} canonical DLL name -> thunk window */
    this.windows = new Map();
    /** @type {ThunkWindow[]} the windows holding a module image, by address */
    this.windowList = [];
    this.windowTop = THUNK_BASE; // module images grow upwards from THUNK_BASE...
    this.chunkFloor = THUNK_END; // ...header-less pages downwards from THUNK_END
    /** @type {Map<string, {name: string, funcs: Map<string, ApiDef>, ordinals: Map<number, string>, aliasOf?: string}>} */
    this.dlls = new Map();
    /**
     * by thunk index (module headers and free slots: null). Allocated whole: the internal pages are taken from the top of
     * the thunk region, so a table grown by assignment would be sparse — V8 then keeps it as a dictionary, and every API
     * call (dispatch, the deferred queue) paid a hash lookup to find its thunk.
     * @type {Array<{dll: string, name: string, def: ApiDef|null, addr: number}|null>}
     */
    this.thunks = new Array((THUNK_END - THUNK_BASE) / THUNK_SIZE).fill(null);
    /** dll!name -> thunk index */
    this.thunkIndex = new Map();
    /** Signature database for unknown imports (name -> argc), so stubs can clean the stack. */
    this.signatures = new Map();
    this.unknown = new Map(); // "dll!name" -> call count
    this.onThunk = null; // (idx, 'dll!name', def) callback when a thunk slot is created
    /** default return value of tracing stubs per DLL (GpStatus GenericError for gdiplus, E_NOTIMPL for COM-style DLLs) */
    this.stubReturns = new Map([['gdiplus.dll', 1], ['ole32.dll', 0x80004001], ['oleaut32.dll', 0x80004001], ['d3d8.dll', 0], ['dsound.dll', 0x80004001], ['ddraw.dll', 0x80004001], ['dinput8.dll', 0x80004001], ['quartz.dll', 0x80004001], ['avifil32.dll', 0x80004001]]);
  }

  /** Normalize a DLL name: lowercase, ensure .dll suffix, strip path. */
  static norm(dll) {
    let n = dll.toLowerCase();
    const slash = Math.max(n.lastIndexOf('\\'), n.lastIndexOf('/'));
    if (slash >= 0) n = n.slice(slash + 1);
    if (!n.includes('.')) n += '.dll';
    return n;
  }

  /** Register a builtin DLL. */
  dll(name, aliases = []) {
    const n = ApiRegistry.norm(name);
    let d = this.dlls.get(n);
    if (!d) { d = { name: n, funcs: new Map(), ordinals: new Map() }; this.dlls.set(n, d); }
    for (const a of aliases) this.dlls.set(ApiRegistry.norm(a), d);
    return d;
  }

  has(dll) { return this.dlls.has(ApiRegistry.norm(dll)); }

  /**
   * Define functions. specs: { Name: [argc, fn] | [argc, fn, opts] | fn (argc from signatures) }
   * @param {string} dll
   * @param {Record<string, any>} specs
   * @param {{ cc?: number }} [opts]
   */
  define(dll, specs, opts = {}) {
    const d = this.dll(dll);
    const cc = opts.cc ?? CC_STDCALL;
    for (const [name, spec] of Object.entries(specs)) {
      let argc, fn, o = {};
      if (Array.isArray(spec)) { [argc, fn, o = {}] = spec; }
      else { fn = spec; argc = this.signatures.get(name); if (argc === undefined) throw new Error(`no signature for ${dll}!${name}`); }
      d.funcs.set(name, { name, argc, cc: o.cc ?? cc, fn, dll: d.name, noreturn: !!o.noreturn, com: o.com ?? null });
      if (o.ordinal !== undefined) d.ordinals.set(o.ordinal, name);
    }
  }

  /** Register ordinal -> name mappings for a DLL. */
  ordinals(dll, map) {
    const d = this.dll(dll);
    for (const [ord, name] of Object.entries(map)) d.ordinals.set(+ord, name);
  }

  lookup(dll, name) {
    const d = this.dlls.get(ApiRegistry.norm(dll));
    return d ? d.funcs.get(name) ?? null : null;
  }

  /** Thunk address for dll!name (creates a stub entry for unknown functions). */
  thunkFor(dll, name) {
    const n = ApiRegistry.norm(dll);
    const cn = this.dlls.get(n)?.name ?? n; // (aliases share their DLL's thunks)
    const idx = this.thunkIndex.get(`${cn}!${name}`);
    if (idx !== undefined) return this.thunks[idx].addr;
    return this.newThunk(this.window(cn), cn, name);
  }

  /** @param {ThunkWindow} w */
  newThunk(w, dll, name) {
    let c = w.chunk;
    if (c.next >= c.end) c = w.chunk = this.allocChunk();
    const addr = c.next;
    c.next += THUNK_SIZE;
    const idx = (addr - THUNK_BASE) / THUNK_SIZE;
    const key = `${dll}!${name}`;
    const def = this.lookup(dll, name);
    this.thunks[idx] = { dll, name, def, addr };
    this.thunkIndex.set(key, idx);
    if (this.onThunk) this.onThunk(idx, key, def);
    return addr;
  }

  /** A page of thunk slots without a module header (internal pseudo-DLLs, full images), from the top down. */
  allocChunk() {
    const base = this.chunkFloor - CHUNK_SIZE;
    if (base < this.windowTop) throw new Error('thunk table exhausted');
    this.chunkFloor = base;
    return { next: base, end: base + CHUNK_SIZE };
  }

  /**
   * The thunk window of a DLL (created on first use). A builtin DLL's window is an in-memory PE image, as a loaded DLL
   * is on Windows: MZ/PE headers and an export directory at its base (the module handle), whose functions are the
   * thunk slots that follow, inside the image. Software finding a module from one of its function addresses (scanning
   * down for the MZ header, VirtualQuery's allocation base) or resolving functions from the export table instead of
   * GetProcAddress then sees what it would on Windows. Orthros' internal pseudo-DLLs (COM methods, its own return
   * thunks) have header-less pages.
   * @returns {ThunkWindow}
   */
  window(dll) {
    const n = ApiRegistry.norm(dll);
    const d = this.dlls.get(n);
    const cn = d?.name ?? n;
    let w = this.windows.get(cn);
    if (w) return w;
    if (INTERNAL_DLLS.has(cn)) {
      w = { dll: cn, base: 0, end: 0, chunk: { next: 0, end: 0 } };
      this.windows.set(cn, w);
      return w;
    }
    const img = buildExportImage(cn, d);
    const base = this.windowTop;
    const size = alignUp(img.headerSize + (img.funcs.length + SLACK_SLOTS) * THUNK_SIZE, 0x1000);
    if (base + size > this.chunkFloor) throw new Error('thunk table exhausted');
    this.windowTop = base + size;
    w = { dll: cn, base, end: base + size, chunk: { next: base + img.headerSize, end: base + size } };
    this.windows.set(cn, w);
    this.windowList.push(w);
    // the slots of the exported functions first (their addresses go into the export table)
    const eat = img.funcs.map((f) => (f === null ? 0 : this.newThunk(w, cn, f) - base));
    if (this.mem) writeExportImage(this.mem, base, size, cn, img, eat);
    return w;
  }

  /** Module handle (image base) of a builtin DLL. */
  moduleBase(dll) { return this.window(dll).base; }

  /** The builtin DLL image containing an address, or null. */
  windowAt(addr) {
    addr >>>= 0;
    if (addr < THUNK_BASE || addr >= this.windowTop) return null;
    for (const w of this.windowList) if (addr >= w.base && addr < w.end) return w;
    return null;
  }

  thunkForOrdinal(dll, ordinal) {
    const d = this.dlls.get(ApiRegistry.norm(dll));
    const name = d?.ordinals.get(ordinal) ?? `#${ordinal}`;
    return this.thunkFor(dll, name);
  }

  /** Thunk entry by index (from EXIT_ARG). */
  thunk(idx) { return this.thunks[idx]; }

  /** Address -> "dll!name" if it is a thunk. */
  nameOf(addr) {
    if (addr < THUNK_BASE || addr >= THUNK_END) return null;
    const t = this.thunks[((addr - THUNK_BASE) / THUNK_SIZE) | 0];
    return t ? `${t.dll}!${t.name}` : null;
  }
}
