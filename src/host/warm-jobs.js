// Proactive start-up jobs (docs/snapshot.md "Warm jobs", docs/startup.md): instead of waiting for a new player's 404 on a
// shared snapshot, the server looks — at its start (after a deploy), then every few minutes, so a changed catalog or key
// is seen too — at every Win32 game version and its default language, and queues, ONE at a time, what the first player
// of it would otherwise wait for:
//   - a 'publish' job when the version's current snapshot key has no usable shared snapshot (the 404's own job);
//   - a 'learn' job when it has one but the server has learned no prefetch list of the version yet (a headless run of
//     its first minutes through the same runner: the bench scenario of tools/scenarios/bench/index.json when the version
//     has one, else just the boot to the first frames). A publish session teaches the lists too, so a version without
//     snapshot gets only the publish job first.
// The key is computed here as a plain page computes it (src/host/web/snapshot-key.js, same inputs: the sources' hash,
// the version's manifest and tree exactly as /api/manifest and /api/tree send them, the default language).
import fs from 'node:fs';
import path from 'node:path';
import { snapshotKey } from './web/snapshot-key.js';

/** The language a plain page starts a version in (main.js start): 'en' when declared, else the first, else none. */
export const defaultLanguage = (man) => { const o = man.languages ?? []; return o.includes('en') ? 'en' : o[0] ?? null; };

/** The key a plain page's session of `name` in `lang` gets (the options of main.js with no URL parameter). */
export const plainKey = (sources, name, manifest, tree, lang) =>
  snapshotKey(sources, name, manifest, tree, { gameLanguage: lang, timeScale: 1, interp: false, interpRange: '', dbg: '', jitOpts: '', noF32: false, f32Off: '' });

/**
 * The bench scenario a learn session plays for `name`: the shortest one of the index that lists the manifest, or null
 * (the session then only boots the game). { file (absolute), seconds }.
 */
export function learnScenario(root, name) {
  let index; try { index = JSON.parse(fs.readFileSync(path.join(root, 'tools/scenarios/bench/index.json'), 'utf8')); } catch { return null; }
  const list = (index.benches ?? []).filter((b) => (b.manifests ?? []).includes(name) && (b.runtime ?? 'win32') === 'win32' && b.file);
  list.sort((a, b) => (a.minutes ?? 99) - (b.minutes ?? 99));
  const b = list[0];
  if (!b) return null;
  const file = path.join(root, 'tools/scenarios/bench', b.file);
  return fs.existsSync(file) ? { file, seconds: Math.min(b.maxSeconds ?? 300, 300) } : null;
}

/** The arguments (after `node`) of a learn session of `name` against the server on `port`; `out`: its scratch folder. */
export function learnArgs(root, name, port, out, { seconds } = {}) {
  const sc = learnScenario(root, name);
  const a = ['tools/headless.mjs', name, '--server-port', String(port), '--out', out, '--log', 'warn', '--shots', '3600', '--seconds', String(seconds ?? sc?.seconds ?? 150)];
  if (sc) a.push('--input-file', sc.file);
  return a;
}

export class Warmer {
  /**
   * @param {object} o
   * @param {() => Array<{ name: string, man: object }>} o.versions the Win32 versions to warm (installed, not hidden)
   * @param {(name: string) => Promise<{ manifest: object, tree: object }>} o.fetchVersion the version's /api/manifest and /api/tree
   * @param {() => any} o.sources the state-owning sources' hash (/api/snapshot-sources)
   * @param {(name: string, lang: string, key: string) => boolean} o.snapshotReady a usable shared snapshot exists
   * @param {(name: string) => boolean} o.hasLearned the server holds a learned prefetch list of the version
   * @param {{ want: Function }} o.jobs SnapshotQueue / SnapshotJobs
   */
  constructor({ versions, fetchVersion, sources, snapshotReady, hasLearned, jobs, everyMs = 600e3, delayMs = 20e3, ttlMs = 2 * 3600e3, log = () => {} }) {
    Object.assign(this, { versions, fetchVersion, sources, snapshotReady, hasLearned, jobs, everyMs, delayMs, ttlMs, log });
    this.current = null; this.timer = null; this.busy = false;
  }
  start() {
    const go = () => this.tick().catch((e) => this.log(`warm: ${e.message}`)).finally(() => { this.timer = setTimeout(go, this.everyMs); this.timer.unref?.(); });
    this.timer = setTimeout(go, this.delayMs); this.timer.unref?.();
    return this;
  }
  stop() { clearTimeout(this.timer); }
  /** What each version still lacks, in catalog order: [{ kind: 'publish' | 'learn', name, lang, key }]. */
  async plan() {
    const out = [], src = this.sources();
    if (!src?.hash) return out;
    for (const { name, man } of this.versions()) {
      let v; try { v = await this.fetchVersion(name); } catch { continue; }
      const lang = defaultLanguage(man), key = await plainKey(src.hash, name, v.manifest, v.tree, lang), l = (lang ?? '').toLowerCase();
      if (!this.snapshotReady(name, l, key)) out.push({ kind: 'publish', name, lang: l, key });
      else if (!this.hasLearned(name)) out.push({ kind: 'learn', name, lang: l, key });
    }
    return out;
  }
  /** Whether a job's goal is reached. */
  met(j) { return j.kind === 'publish' ? this.snapshotReady(j.name, j.lang, j.key) : this.hasLearned(j.name); }
  /** One step: when the job queued last has done its work (or its time ran out), queue the next one that is wanted. */
  async tick() {
    if (this.busy) return null;
    this.busy = true;
    try {
      if (this.current && !this.met(this.current) && Date.now() - this.current.at < this.ttlMs) return null; // (the runner has not finished)
      this.current = null;
      for (const j of await this.plan()) {
        if (this.jobs.want(j.name, j.lang, j.key, j.kind)) { this.current = { ...j, at: Date.now() }; this.log(`warm: queued ${j.kind} of ${j.name} (${j.lang || 'no language'}) ${j.key}`); return this.current; }
      }
      return null;
    } finally { this.busy = false; }
  }
}
