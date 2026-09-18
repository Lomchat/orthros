// Win32 API registry: builtin DLL modules whose exports are host (JS) functions reached through
// thunk addresses. Calling a thunk makes the executor exit to the dispatcher (EXIT.THUNK, see
// DECISIONS.md D004), which runs the handler and performs the callee/caller stack cleanup.
import { THUNK_BASE, THUNK_END, THUNK_SIZE } from '../cpu/memory.js';

export const CC_STDCALL = 0, CC_CDECL = 1;

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
  constructor() {
    /** @type {Map<string, {name: string, funcs: Map<string, ApiDef>, ordinals: Map<number, string>, aliasOf?: string}>} */
    this.dlls = new Map();
    /** @type {Array<{dll: string, name: string, def: ApiDef|null, addr: number}>} */
    this.thunks = [];
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
      d.funcs.set(name, { name, argc, cc: o.cc ?? cc, fn, dll: d.name, noreturn: !!o.noreturn });
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
    const key = `${n}!${name}`;
    let idx = this.thunkIndex.get(key);
    if (idx !== undefined) return this.thunks[idx].addr;
    const def = this.lookup(n, name);
    idx = this.thunks.length;
    if (THUNK_BASE + idx * THUNK_SIZE >= THUNK_END) throw new Error('thunk table exhausted');
    this.thunks.push({ dll: n, name, def, addr: THUNK_BASE + idx * THUNK_SIZE });
    this.thunkIndex.set(key, idx);
    if (this.onThunk) this.onThunk(idx, key, def);
    return this.thunks[idx].addr;
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
