// Virtual file system: Windows paths (drive letters, backslashes, case-insensitive) mapped onto
// mounted backends. Backends implement a small synchronous interface (the guest's file API is
// synchronous, see DECISIONS.md D007).
//
// Backend interface:
//   stat(rel) -> { size, isDir, mtime } | null
//   readdir(rel) -> [{ name, size, isDir, mtime }]
//   open(rel, { write, create, truncate }) -> File | null
//   mkdir(rel), unlink(rel), rename(relFrom, relTo)
// File interface: size(), read(off, len) -> Uint8Array, write(off, bytes), truncate(len), close()

export class Vfs {
  constructor() {
    /** @type {Array<{prefix: string, backend: any}>} sorted longest-prefix first */
    this.mounts = [];
  }

  /** @param {string} winPath e.g. 'C:\\Game' @param {any} backend */
  mount(winPath, backend) {
    const prefix = normalizeWin(winPath);
    this.mounts.push({ prefix, backend });
    this.mounts.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /** @returns {{ backend: any, rel: string, prefix: string } | null} */
  resolve(winPath) {
    const p = normalizeWin(winPath);
    for (const m of this.mounts) {
      if (p === m.prefix) return { backend: m.backend, rel: '', prefix: m.prefix };
      if (p.startsWith(m.prefix + '\\') || m.prefix.endsWith('\\') && p.startsWith(m.prefix)) {
        const rel = p.slice(m.prefix.length).replace(/^\\+/, '').split('\\').join('/');
        return { backend: m.backend, rel, prefix: m.prefix };
      }
    }
    return null;
  }

  stat(winPath) { const r = this.resolve(winPath); return r ? r.backend.stat(r.rel) : null; }
  readdir(winPath) { const r = this.resolve(winPath); return r ? r.backend.readdir(r.rel) : null; }
  open(winPath, opts = {}) { const r = this.resolve(winPath); return r ? r.backend.open(r.rel, opts) : null; }
  mkdir(winPath) { const r = this.resolve(winPath); return r ? r.backend.mkdir(r.rel) : false; }
  unlink(winPath) { const r = this.resolve(winPath); return r ? r.backend.unlink(r.rel) : false; }
  rename(from, to) {
    const a = this.resolve(from), b = this.resolve(to);
    if (!a || !b || a.backend !== b.backend) return false;
    return a.backend.rename(a.rel, b.rel);
  }
  /** Read a whole file (or null). */
  readFile(winPath) {
    const f = this.open(winPath, {});
    if (!f) return null;
    try { return f.read(0, f.size()); } finally { f.close(); }
  }
}

/** Normalize a Windows path: uppercase drive, backslashes, resolve . and .., no trailing slash. */
export function normalizeWin(p, cwd = 'C:\\') {
  let s = String(p).replace(/\//g, '\\');
  if (/^\\\\\?\\/.test(s)) s = s.slice(4);
  if (!/^[A-Za-z]:/.test(s)) {
    // relative or rooted-without-drive
    if (s.startsWith('\\')) s = cwd.slice(0, 2) + s;
    else s = cwd.replace(/\\$/, '') + '\\' + s;
  }
  const drive = s[0].toUpperCase() + ':';
  const parts = [];
  for (const seg of s.slice(2).split('\\')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return drive + '\\' + parts.join('\\');
}

/** In-memory backend (writable). */
export class MemBackend {
  constructor() {
    /** @type {Map<string, {data: Uint8Array, len: number, mtime: number}>} lowercase path -> file */
    this.files = new Map();
    /** @type {Set<string>} lowercase dir paths */
    this.dirs = new Set(['']);
    this.names = new Map(); // lowercase -> original name path
  }
  key(rel) { return rel.toLowerCase(); }
  stat(rel) {
    const k = this.key(rel);
    if (this.dirs.has(k)) return { size: 0, isDir: true, mtime: 0 };
    const f = this.files.get(k);
    return f ? { size: f.len, isDir: false, mtime: f.mtime } : null;
  }
  readdir(rel) {
    const k = this.key(rel);
    if (!this.dirs.has(k)) return null;
    const out = [];
    const prefix = k ? k + '/' : '';
    for (const d of this.dirs) if (d && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) out.push({ name: this.names.get(d) ?? d.slice(prefix.length), size: 0, isDir: true, mtime: 0 });
    for (const [p, f] of this.files) if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.push({ name: this.names.get(p) ?? p.slice(prefix.length), size: f.len, isDir: false, mtime: f.mtime });
    return out;
  }
  open(rel, opts = {}) {
    const k = this.key(rel);
    let f = this.files.get(k);
    if (!f) {
      if (!opts.create) return null;
      const parent = k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : '';
      if (!this.dirs.has(parent)) return null;
      f = { data: new Uint8Array(0), len: 0, mtime: Date.now() };
      this.files.set(k, f);
      this.names.set(k, rel.split('/').pop());
    } else if (opts.truncate) { f.len = 0; }
    return new MemFile(f);
  }
  mkdir(rel) {
    const k = this.key(rel);
    const parent = k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : '';
    if (!this.dirs.has(parent) || this.dirs.has(k) || this.files.has(k)) return false;
    this.dirs.add(k); this.names.set(k, rel.split('/').pop());
    return true;
  }
  unlink(rel) { return this.files.delete(this.key(rel)); }
  rename(from, to) {
    const f = this.files.get(this.key(from));
    if (!f) return false;
    this.files.delete(this.key(from)); this.files.set(this.key(to), f); this.names.set(this.key(to), to.split('/').pop());
    return true;
  }
}

class MemFile {
  constructor(f) { this.f = f; }
  size() { return this.f.len; }
  read(off, len) {
    const end = Math.min(off + len, this.f.len);
    return off >= end ? new Uint8Array(0) : this.f.data.slice(off, end);
  }
  write(off, bytes) {
    const need = off + bytes.length;
    if (need > this.f.data.length) {
      const nd = new Uint8Array(Math.max(need, this.f.data.length * 2, 4096));
      nd.set(this.f.data.subarray(0, this.f.len));
      this.f.data = nd;
    }
    if (off > this.f.len) this.f.data.fill(0, this.f.len, off);
    this.f.data.set(bytes, off);
    this.f.len = Math.max(this.f.len, need);
    this.f.mtime = Date.now();
    return bytes.length;
  }
  truncate(len) { this.f.len = Math.min(len, this.f.len); if (len > this.f.len) { this.write(this.f.len, new Uint8Array(len - this.f.len)); } }
  close() {}
}
