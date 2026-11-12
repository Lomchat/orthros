// Proactive start-up jobs (docs/snapshot.md "Warm jobs", docs/startup.md): instead of waiting for a new player's 404 on a
// shared snapshot, the server looks — at its start (after a deploy), then every few minutes, so a changed catalog or key
// is seen too — at every Win32 game version in each language its players use (warmLanguages: the server's preferred
// order, then the languages its players marked or seeded, then the default), and queues, ONE at a time, what the first
// player of it would otherwise wait for:
//   - a 'publish' job when the version's current snapshot key in that language has no usable shared snapshot (the 404's
//     own job): every version's first language before any version's second one;
//   - a 'learn' job when it has one but the server has learned no prefetch list of the version yet, or the version has
//     learn scenarios (tools/scenarios/bench/index.json `learn`: the screens a player opens first — a skirmish start, a
//     hero editor) not played on this server yet: headless runs through the same runner (tools/warm-learn.mjs), one per
//     scenario — the version's learn scenarios, else its shortest bench scenario, else just the boot to the first frames —
//     played in the version's first language (the players' own: what they read is what is learned).
//     A publish session teaches the boot's lists too, so a version without snapshot gets only the publish job first.
// The key is computed here as a plain page computes it (src/web/snapshot-key.js, same inputs: the sources' hash,
// the version's manifest and tree exactly as /api/manifest and /api/tree send them, the default language).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { snapshotKey } from '../web/snapshot-key.js';

/** The language a plain page starts a version in (main.js start): 'en' when declared, else the first, else none. */
export const defaultLanguage = (man) => { const o = man.languages ?? []; return o.includes('en') ? 'en' : o[0] ?? null; };

/**
 * The languages warm jobs make a version's shared snapshots in, first first: of the languages the version declares,
 * those of `prefer` (the server's --warm-langs, in its order), then those its players used (`use`: { [lang]: sessions },
 * most used first), then the default language (what a plain page and the harness start). Lowercased; none declared:
 * [null] (the version's one language-less key).
 */
export function warmLanguages(man, use = {}, prefer = []) {
  const declared = (man.languages ?? []).map((l) => String(l).toLowerCase()), has = (l) => declared.includes(l);
  const out = [];
  const add = (l) => { if (l && has(l) && !out.includes(l)) out.push(l); };
  for (const l of prefer) add(String(l).toLowerCase());
  for (const [l] of Object.entries(use).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])) add(String(l).toLowerCase());
  add(defaultLanguage(man)?.toLowerCase());
  return out.length ? out : [defaultLanguage(man)?.toLowerCase() ?? null];
}

/** The key a plain page's session of `name` in `lang` gets (the options of main.js with no URL parameter). */
export const plainKey = (sources, name, manifest, tree, lang) =>
  snapshotKey(sources, name, manifest, tree, { gameLanguage: lang, timeScale: 1, interp: false, interpRange: '', dbg: '', jitOpts: '', noF32: false, f32Off: '' });

/**
 * The sessions a learn job plays for `name`, in order: the version's learn scenarios (tools/scenarios/bench/index.json
 * `learn`, each { name, manifests, file, coords, maxSeconds (at most 1800) }: the loads a player meets first, played on a
 * fresh browser each),
 * else the shortest bench scenario of the index that lists it (at most 300 s), else none (the job then only boots the
 * game). Each { id, file (absolute), seconds, coords, required }: `id` the scenario's name and content hash — a learn
 * scenario (`required`) is played again on this server when it changes; `coords` the display its pointer steps were
 * written for (scaled to the game's mode by the harness).
 */
export function learnScenarios(root, name) {
  const dir = path.join(root, 'tools/scenarios/bench');
  let index; try { index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { return []; }
  const win32 = (b) => (b.manifests ?? []).includes(name) && (b.runtime ?? 'win32') === 'win32' && b.file && fs.existsSync(path.join(dir, b.file));
  const entry = (b, required, cap) => {
    const file = path.join(dir, b.file);
    return { id: `${b.name}:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12)}`, file, seconds: Math.min(b.maxSeconds ?? cap, cap), coords: b.coords ?? null, required };
  };
  const learn = (index.learn ?? []).filter(win32);
  if (learn.length) return learn.map((b) => entry(b, true, 1800));
  const benches = (index.benches ?? []).filter(win32).sort((a, b) => (a.minutes ?? 99) - (b.minutes ?? 99));
  return benches.length ? [entry(benches[0], false, 300)] : [];
}
/** The first session of a learn job of `name` (learnScenarios), or null. */
export const learnScenario = (root, name) => learnScenarios(root, name)[0] ?? null;

/**
 * The arguments (after `node`) of one learn session of `name` against the server on `port` (`sc`: one of
 * learnScenarios, or null: the boot only); `out`: its scratch folder. A scenario's session ends a little after its last
 * step: the loads it opened, learned.
 */
export function learnArgs(root, name, port, out, sc = null, { seconds, lang } = {}) {
  const a = ['tools/headless.mjs', name, '--server-port', String(port), '--out', out, '--log', 'warn', '--shots', '3600', '--seconds', String(seconds ?? sc?.seconds ?? 150)];
  if (lang) a.push('--game-lang', lang); // (the version's first language: the players' own reads, GL programs and launch set)
  if (sc) a.push('--input-file', sc.file, '--end-after-input', '20', ...(sc.coords ? ['--coords', sc.coords.join('x')] : []));
  return a;
}

/** How long a learn job of `name` may take, in seconds (the runners' timeout): its sessions and their start-up. */
export const learnTimeout = (root, name) => Math.max(1500, learnScenarios(root, name).reduce((s, sc) => s + sc.seconds + 120, 0));

/** The command (after `timeout <s>` and the browser slot guard) a runner starts for a learn job (tools/warm-learn.mjs), in game language `lang`. */
export const learnCommand = (name, url, token, out, lang = '') => ['node', 'tools/warm-learn.mjs', name, '--server', url, '--token', token, '--out', out, ...(lang ? ['--lang', lang] : [])];

/** a learn scenario that did not reach its end this many times is not queued again until it changes (its id) */
export const LEARN_TRIES = 2;

/**
 * The learn scenarios a server has seen played to their end, per version (`<learn>/snapshots/learned-scenarios.json`:
 * { [manifest]: { [scenario id]: ISO date | { failed: n, at } } }), told by tools/warm-learn.mjs with its job's token —
 * and those that did not reach their end (a screen never shown: coordinates of another release), given up after
 * LEARN_TRIES: a broken scenario does not take a browser every few hours.
 */
export class LearnedScenarios {
  constructor(file) { this.file = file; }
  read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; } }
  /** Played to its end, or given up. */
  done(name, id) { const v = this.read()[name]?.[id]; return typeof v === 'string' || (v?.failed ?? 0) >= LEARN_TRIES; }
  /** The ids of `name` done (tools/warm-learn.mjs skips them). */
  doneIds(name) { return Object.keys(this.read()[name] ?? {}).filter((id) => this.done(name, id)); }
  add(name, played, failed = []) {
    const all = this.read(), at = new Date().toISOString();
    const own = all[name] ??= {};
    for (const id of played) own[id] = at;
    for (const id of failed) if (typeof own[id] !== 'string') own[id] = { failed: (own[id]?.failed ?? 0) + 1, at };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(all)); fs.renameSync(this.file + '.tmp', this.file);
  }
}

export class Warmer {
  /**
   * @param {object} o
   * @param {() => Array<{ name: string, man: object }>} o.versions the Win32 versions to warm (installed, not hidden)
   * @param {(name: string) => Promise<{ manifest: object, tree: object }>} o.fetchVersion the version's /api/manifest and /api/tree
   * @param {() => any} o.sources the state-owning sources' hash (/api/snapshot-sources)
   * @param {(name: string, lang: string, key: string) => boolean} o.snapshotReady a usable shared snapshot exists
   * @param {(name: string) => boolean} o.hasLearned the server holds a learned prefetch list of the version
   * @param {(name: string) => boolean} [o.scenariosLearned] every learn scenario of the version was played on this server
   * @param {(name: string) => Record<string, number>} [o.langUse] the sessions of each game language of the version (marks, seeds)
   * @param {string[]} [o.prefer] the languages made first (--warm-langs), where a version declares them
   * @param {{ want: Function }} o.jobs SnapshotQueue / SnapshotJobs
   * `everyMs`: between looks while nothing is due; `pollMs`: while a queued job runs (the next one queued as soon as it
   * is done, not at the next 10-minute look: a deploy's wave is as long as its jobs).
   */
  constructor({ versions, fetchVersion, sources, snapshotReady, hasLearned, scenariosLearned = () => true, langUse = () => ({}), prefer = [], jobs, everyMs = 600e3, pollMs = 60e3, delayMs = 20e3, ttlMs = 2 * 3600e3, log = () => {} }) {
    Object.assign(this, { versions, fetchVersion, sources, snapshotReady, hasLearned, scenariosLearned, langUse, prefer, jobs, everyMs, pollMs, delayMs, ttlMs, log });
    this.current = null; this.timer = null; this.busy = false;
  }
  start() {
    const go = () => this.tick().catch((e) => this.log(`warm: ${e.message}`)).finally(() => { this.timer = setTimeout(go, this.current ? Math.min(this.pollMs, this.everyMs) : this.everyMs); this.timer.unref?.(); });
    this.timer = setTimeout(go, this.delayMs); this.timer.unref?.();
    return this;
  }
  stop() { clearTimeout(this.timer); }
  /**
   * What each version still lacks, by rank of language then in catalog order: [{ kind: 'publish' | 'learn', name, lang,
   * key }] — every version's first language (its snapshot, else its learn job, played in it) before any version's second
   * language (its snapshot only).
   */
  async plan() {
    const ranks = [], src = this.sources();
    if (!src?.hash) return [];
    for (const { name, man } of this.versions()) {
      let v; try { v = await this.fetchVersion(name); } catch { continue; }
      const langs = warmLanguages(man, this.langUse(name) ?? {}, this.prefer);
      for (let r = 0; r < langs.length; r++) {
        const l = langs[r] ?? '', key = await plainKey(src.hash, name, v.manifest, v.tree, langs[r]);
        const job = !this.snapshotReady(name, l, key) ? { kind: 'publish', name, lang: l, key } : r === 0 && !this.learned(name) ? { kind: 'learn', name, lang: l, key } : null;
        if (job) (ranks[r] ??= []).push(job);
      }
    }
    return ranks.flatMap((r) => r ?? []);
  }
  /** Whether a job's goal is reached. */
  met(j) { return j.kind === 'publish' ? this.snapshotReady(j.name, j.lang, j.key) : this.learned(j.name); }
  /** The version's lists are learned, its learn scenarios played. */
  learned(name) { return this.hasLearned(name) && this.scenariosLearned(name); }
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
