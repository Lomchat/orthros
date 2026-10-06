// A read-only view of a game folder with selected files served from other paths
// in that same folder. The guest keeps its original filenames; the source files
// and the underlying backend remain unchanged.
export class FileAliasBackend {
  constructor(backend, aliases) {
    this.backend = backend;
    this.aliases = new Map(Object.entries(aliases).map(([from, to]) => [this.key(from), to]));
  }

  key(rel) { return rel.replaceAll('\\', '/').toLowerCase(); }
  source(rel) { return this.aliases.get(this.key(rel)) ?? rel; }
  stat(rel) { return this.backend.stat(this.source(rel)); }
  open(rel, opts = {}) {
    if (opts.write || opts.create || opts.truncate) return null;
    return this.backend.open(this.source(rel), opts);
  }
  readdir(rel) {
    const entries = this.backend.readdir(rel);
    if (!entries) return null;
    return entries.map((entry) => {
      const source = this.aliases.get(this.key(rel ? `${rel}/${entry.name}` : entry.name));
      return source ? { ...entry, ...this.backend.stat(source) } : entry;
    });
  }
  mkdir() { return false; }
  unlink() { return false; }
  rename() { return false; }
}
