// Read-only union of installed game layers, in priority order.
import { NodeBackend } from './node-backend.js';

export class OverlayBackend {
  constructor(roots) { this.layers = roots.map((root) => new NodeBackend(root, { readOnly: true })); }
  stat(rel) { for (const layer of this.layers) { const st = layer.stat(rel); if (st) return st; } return null; }
  readdir(rel) {
    const entries = new Map(); let found = false;
    for (const layer of this.layers) {
      const list = layer.readdir(rel);
      if (!list) continue;
      found = true;
      for (const entry of list) if (!entries.has(entry.name.toLowerCase())) entries.set(entry.name.toLowerCase(), entry);
    }
    return found ? [...entries.values()] : null;
  }
  open(rel, opts = {}) {
    if (opts.write || opts.create || opts.truncate) return null;
    for (const layer of this.layers) { const file = layer.open(rel); if (file) return file; }
    return null;
  }
  mkdir() { return false; }
  unlink() { return false; }
  rename() { return false; }
}
