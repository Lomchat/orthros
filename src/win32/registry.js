// Registry emulation (advapi32 Reg* API): an in-memory key tree seeded with generic Windows
// defaults and the manifest's `registry` section, persisted as JSON in the save directory.
import { CPU_MHZ, CPU_BRAND } from '../cpu/state.js';

export const HKEY = { CLASSES_ROOT: 0x80000000, CURRENT_USER: 0x80000001, LOCAL_MACHINE: 0x80000002, USERS: 0x80000003, CURRENT_CONFIG: 0x80000005 };
export const REG = { NONE: 0, SZ: 1, EXPAND_SZ: 2, BINARY: 3, DWORD: 4, MULTI_SZ: 7 };

export class Registry {
  constructor() {
    /** @type {Map<string, Map<string, {type: number, data: Uint8Array}>>} full lowercase path -> values */
    this.keys = new Map();
    this.names = new Map(); // lowercase path -> display path
    this.dirty = false;
    this.seedDefaults();
  }

  static rootName(h) {
    switch (h >>> 0) {
      case HKEY.CLASSES_ROOT: return 'HKEY_CLASSES_ROOT';
      case HKEY.CURRENT_USER: return 'HKEY_CURRENT_USER';
      case HKEY.LOCAL_MACHINE: return 'HKEY_LOCAL_MACHINE';
      case HKEY.USERS: return 'HKEY_USERS';
      case HKEY.CURRENT_CONFIG: return 'HKEY_CURRENT_CONFIG';
      default: return null;
    }
  }

  norm(path) { return path.replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/^\\|\\$/g, '').toLowerCase(); }

  /** Create key and all parents. Returns the normalized path. */
  createKey(path) {
    const n = this.norm(path);
    const parts = n.split('\\');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('\\');
      if (!this.keys.has(p)) { this.keys.set(p, new Map()); this.names.set(p, path.split(/[\\/]/).slice(0, i).join('\\')); this.dirty = true; }
    }
    return n;
  }
  hasKey(path) { return this.keys.has(this.norm(path)); }
  deleteKey(path) {
    const n = this.norm(path);
    if (!this.keys.has(n)) return false;
    for (const k of [...this.keys.keys()]) if (k === n || k.startsWith(n + '\\')) { this.keys.delete(k); this.names.delete(k); }
    this.dirty = true;
    return true;
  }
  subkeys(path) {
    const n = this.norm(path);
    const out = [];
    for (const k of this.keys.keys()) if (k.startsWith(n + '\\') && !k.slice(n.length + 1).includes('\\')) out.push(this.names.get(k).split('\\').pop());
    return out.sort();
  }
  values(path) { return this.keys.get(this.norm(path)) ?? null; }
  getValue(path, name) { const v = this.keys.get(this.norm(path)); return v ? v.get(name.toLowerCase()) ?? null : null; }
  setValue(path, name, type, data) {
    const n = this.createKey(path);
    this.keys.get(n).set(name.toLowerCase(), { type, data, name });
    this.dirty = true;
  }
  deleteValue(path, name) { const v = this.keys.get(this.norm(path)); if (!v) return false; const r = v.delete(name.toLowerCase()); if (r) this.dirty = true; return r; }

  setString(path, name, s) { this.setValue(path, name, REG.SZ, encodeSz(s)); }
  setDword(path, name, v) { const d = new Uint8Array(4); new DataView(d.buffer).setUint32(0, v >>> 0, true); this.setValue(path, name, REG.DWORD, d); }

  seedDefaults() {
    const cv = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
    this.setString(cv, 'CurrentVersion', '5.1'); this.setString(cv, 'ProductName', 'Microsoft Windows XP'); this.setString(cv, 'CSDVersion', 'Service Pack 3');
    this.setString(cv, 'CurrentBuildNumber', '2600'); this.setString(cv, 'SystemRoot', 'C:\\Windows'); this.setString(cv, 'RegisteredOwner', 'Player'); this.setString(cv, 'RegisteredOrganization', '');
    this.setString('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion', 'ProgramFilesDir', 'C:\\Program Files');
    this.setString('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion', 'CommonFilesDir', 'C:\\Program Files\\Common Files');
    this.setString('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\DirectX', 'Version', '4.09.00.0904');
    this.setString('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\DirectX', 'InstalledVersion', '\x00\x00\x00\x00\x09\x00\x00\x00');
    this.createKey('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Direct3D\\Drivers'); // (created by the DirectX runtime; no overrides)
    this.createKey('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\DirectDraw');
    this.setString('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', 'Personal', 'C:\\Users\\Player\\Documents');
    this.setString('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', 'AppData', 'C:\\Users\\Player\\AppData\\Roaming');
    this.setString('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', 'Local AppData', 'C:\\Users\\Player\\AppData\\Local');
    this.setString('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', 'Desktop', 'C:\\Users\\Player\\Desktop');
    this.setString('HKEY_CURRENT_USER\\Control Panel\\International', 'Locale', '00000409');
    this.setString('HKEY_CURRENT_USER\\Control Panel\\International', 'sLanguage', 'ENU');
    this.setString('HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0', 'ProcessorNameString', CPU_BRAND); // (the CPUID brand string)
    this.setDword('HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0', '~MHz', CPU_MHZ); // (the RDTSC rate)
    this.setString('HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0', 'VendorIdentifier', 'GenuineIntel');
    this.setString('HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0', 'Identifier', 'x86 Family 6 Model 15 Stepping 2');
    this.setString('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'PROCESSOR_ARCHITECTURE', 'x86');
    this.setString('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\ComputerName', 'ComputerName', 'ORTHROS');
    this.dirty = false;
  }

  /** Seed from a manifest section: { "HKEY_LOCAL_MACHINE\\Software\\X": { "Name": "string" | 123 | {"type":"binary","hex":"..."} } } */
  seed(obj) {
    if (!obj) return;
    for (const [key, values] of Object.entries(obj)) {
      this.createKey(key);
      for (const [name, v] of Object.entries(values)) {
        if (typeof v === 'number') this.setDword(key, name, v);
        else if (typeof v === 'string') this.setString(key, name, v);
        else if (v && v.type === 'binary') this.setValue(key, name, REG.BINARY, Uint8Array.from(v.hex.match(/../g) ?? [], (h) => parseInt(h, 16)));
        else if (v && v.type === 'expand') this.setValue(key, name, REG.EXPAND_SZ, encodeSz(v.value));
        else if (v && v.type === 'multi') this.setValue(key, name, REG.MULTI_SZ, encodeSz(v.value.join('\0') + '\0'));
      }
    }
    this.dirty = false;
  }

  toJSON() {
    const out = {};
    for (const [k, vals] of this.keys) {
      const o = {};
      for (const [, v] of vals) o[v.name] = { type: v.type, hex: Array.from(v.data, (b) => b.toString(16).padStart(2, '0')).join('') };
      out[this.names.get(k)] = o;
    }
    return out;
  }
  load(json) {
    for (const [key, vals] of Object.entries(json)) {
      this.createKey(key);
      for (const [name, v] of Object.entries(vals)) this.setValue(key, name, v.type, Uint8Array.from(v.hex.match(/../g) ?? [], (h) => parseInt(h, 16)));
    }
    this.dirty = false;
  }
}

export function encodeSz(s) {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}
export function encodeSzW(s) {
  const b = new Uint8Array(2 * (s.length + 1));
  for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) & 0xff; b[2 * i + 1] = s.charCodeAt(i) >> 8; }
  return b;
}
