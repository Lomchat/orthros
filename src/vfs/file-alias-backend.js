// A read-only view of a game folder with selected files served from other paths
// in that same folder. The guest keeps its original filenames; the source files
// and the underlying backend remain unchanged. An alias may also give a file a
// name the folder does not have (a fallback a language's archive pattern finds,
// e.g. lang/French~EnglishAudio.big read from lang/EnglishAudio.big): it is then
// listed in its folder too, as its source.
export class FileAliasBackend {
  /** `hidden`: paths the game does not see at all (a language's own files while another language is chosen). */
  constructor(backend, aliases = {}, hidden = []) {
    this.backend = backend;
    this.aliases = new Map(Object.entries(aliases).map(([from, to]) => [this.key(from), to]));
    this.hidden = new Set(hidden.map((p) => this.key(p)));
    /** folder (key) -> [{ name, source }]: the aliases' names as written, for the listings */
    this.named = new Map();
    for (const [from, to] of Object.entries(aliases)) {
      const path = from.replaceAll('\\', '/');
      const at = path.lastIndexOf('/');
      const dir = this.key(at < 0 ? '' : path.slice(0, at));
      if (!this.named.has(dir)) this.named.set(dir, []);
      this.named.get(dir).push({ name: path.slice(at + 1), source: to });
    }
  }

  key(rel) { return rel.replaceAll('\\', '/').toLowerCase(); }
  source(rel) { return this.aliases.get(this.key(rel)) ?? rel; }
  stat(rel) { return this.hidden.has(this.key(rel)) ? null : this.backend.stat(this.source(rel)); }
  open(rel, opts = {}) {
    if (opts.write || opts.create || opts.truncate || this.hidden.has(this.key(rel))) return null;
    return this.backend.open(this.source(rel), opts);
  }
  readdir(rel) {
    const entries = this.backend.readdir(rel);
    if (!entries) return null;
    const path = (name) => this.key(rel ? `${rel}/${name}` : name);
    const listed = entries.filter((entry) => !this.hidden.has(path(entry.name))).map((entry) => {
      const source = this.aliases.get(path(entry.name));
      return source ? { ...entry, ...this.backend.stat(source) } : entry;
    });
    const names = new Set(listed.map((entry) => entry.name.toLowerCase()));
    for (const { name, source } of this.named.get(this.key(rel ?? '')) ?? []) {
      const st = names.has(name.toLowerCase()) || this.hidden.has(path(name)) ? null : this.backend.stat(source);
      if (st) listed.push({ ...st, name });
    }
    return listed;
  }
  mkdir() { return false; }
  unlink() { return false; }
  rename() { return false; }
}
