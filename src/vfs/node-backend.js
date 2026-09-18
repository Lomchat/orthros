// Node backend: a host directory exposed with case-insensitive lookup (Linux hosts are
// case-sensitive; Windows programs are not). Used by the Node test harness and the server.
import fs from 'node:fs';
import path from 'node:path';

export class NodeBackend {
  /** @param {string} root @param {{ readOnly?: boolean }} [opts] */
  constructor(root, opts = {}) {
    this.root = path.resolve(root);
    this.readOnly = !!opts.readOnly;
    /** dir (host path) -> Map(lowercase name -> real name) */
    this.dirCache = new Map();
  }

  listDir(hostDir) {
    let m = this.dirCache.get(hostDir);
    if (m) return m;
    m = new Map();
    try { for (const n of fs.readdirSync(hostDir)) m.set(n.toLowerCase(), n); } catch { /* not a dir */ }
    this.dirCache.set(hostDir, m);
    return m;
  }

  /** Resolve a relative guest path (forward slashes) to a host path, case-insensitively. */
  hostPath(rel, { forCreate = false } = {}) {
    let cur = this.root;
    const segs = rel.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const m = this.listDir(cur);
      const real = m.get(segs[i].toLowerCase());
      if (real === undefined) {
        if (forCreate && i === segs.length - 1) return path.join(cur, segs[i]);
        return null;
      }
      cur = path.join(cur, real);
    }
    return cur;
  }

  stat(rel) {
    const hp = this.hostPath(rel);
    if (!hp) return null;
    try {
      const st = fs.statSync(hp);
      return { size: st.size, isDir: st.isDirectory(), mtime: st.mtimeMs };
    } catch { return null; }
  }

  readdir(rel) {
    const hp = this.hostPath(rel);
    if (!hp) return null;
    try {
      return fs.readdirSync(hp).map((name) => {
        try { const st = fs.statSync(path.join(hp, name)); return { name, size: st.size, isDir: st.isDirectory(), mtime: st.mtimeMs }; }
        catch { return { name, size: 0, isDir: false, mtime: 0 }; }
      });
    } catch { return null; }
  }

  open(rel, opts = {}) {
    let hp = this.hostPath(rel);
    if (!hp) {
      if (!opts.create || this.readOnly) return null;
      hp = this.hostPath(rel, { forCreate: true });
      if (!hp) return null;
      this.dirCache.delete(path.dirname(hp));
    }
    const write = !!(opts.write || opts.create || opts.truncate) && !this.readOnly;
    try {
      const flags = write ? (fs.existsSync(hp) ? (opts.truncate ? 'w+' : 'r+') : 'w+') : 'r';
      const fd = fs.openSync(hp, flags);
      return new NodeFile(fd, write);
    } catch { return null; }
  }

  mkdir(rel) {
    if (this.readOnly) return false;
    const hp = this.hostPath(rel, { forCreate: true });
    if (!hp || fs.existsSync(hp)) return false;
    try { fs.mkdirSync(hp); this.dirCache.delete(path.dirname(hp)); return true; } catch { return false; }
  }

  unlink(rel) {
    if (this.readOnly) return false;
    const hp = this.hostPath(rel);
    if (!hp) return false;
    try { fs.unlinkSync(hp); this.dirCache.delete(path.dirname(hp)); return true; } catch { return false; }
  }

  rename(from, to) {
    if (this.readOnly) return false;
    const a = this.hostPath(from), b = this.hostPath(to, { forCreate: true });
    if (!a || !b) return false;
    try { fs.renameSync(a, b); this.dirCache.delete(path.dirname(a)); this.dirCache.delete(path.dirname(b)); return true; } catch { return false; }
  }
}

class NodeFile {
  constructor(fd, write) { this.fd = fd; this.writable = write; }
  size() { return fs.fstatSync(this.fd).size; }
  read(off, len) {
    const buf = new Uint8Array(len);
    const n = fs.readSync(this.fd, buf, 0, len, off);
    return n === len ? buf : buf.subarray(0, n);
  }
  write(off, bytes) {
    if (!this.writable) return -1;
    return fs.writeSync(this.fd, bytes, 0, bytes.length, off);
  }
  truncate(len) { if (this.writable) fs.ftruncateSync(this.fd, len); }
  close() { try { fs.closeSync(this.fd); } catch { /* ignore */ } }
}
