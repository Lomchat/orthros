// Shared snapshots (docs/snapshot.md, stage 3): for a player who has none of their own, the snapshot a new player's
// session took on this server — a headless browser started for it (tools/snapshot-publish.mjs, through the browser
// slots), which published it here. Per game version, language and snapshot key (the page's: Orthros' state-owning
// sources, the version's files, the options that change the machine), with the shared first-launch profile it started
// from (a new player's profile: profile-seed.js) — another one since makes it stale. Stored compressed (gzip, and brotli
// for the browsers that take it), the two most recent keys per game version and language.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');
export const SNAPSHOT_KEY = /^[0-9a-f]{32}$/;

export class SnapshotStore {
  /** @param {string} dir where they are kept (created) */
  constructor(dir, { keep = 2 } = {}) { this.dir = dir; this.keep = keep; }
  base(name, lang, key) { return path.join(this.dir, safe(name), `${safe(lang || 'none')}-${key}`); }
  /** What is kept of one ({ bytes, seed, at, gz, br }), or null. */
  meta(name, lang, key) {
    try { return JSON.parse(fs.readFileSync(this.base(name, lang, key) + '.json', 'utf8')); } catch { return null; }
  }
  /**
   * Keep the snapshot in file `src` (moved away): compressed, its record written last (`extra`: what it applies to
   * besides its key — the first-launch profile it started from). Older keys of the same game version and language go.
   */
  async put(name, lang, key, src, extra = {}) {
    const base = this.base(name, lang, key);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.rmSync(base + '.json', { force: true });
    await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), fs.createWriteStream(base + '.gz.tmp'));
    await pipeline(fs.createReadStream(src), zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } }), fs.createWriteStream(base + '.br.tmp'));
    const bytes = fs.statSync(src).size;
    fs.renameSync(base + '.gz.tmp', base + '.gz'); fs.renameSync(base + '.br.tmp', base + '.br'); fs.rmSync(src, { force: true });
    const rec = { bytes, gz: fs.statSync(base + '.gz').size, br: fs.statSync(base + '.br').size, at: new Date().toISOString(), ...extra };
    fs.writeFileSync(base + '.json.tmp', JSON.stringify(rec)); fs.renameSync(base + '.json.tmp', base + '.json');
    this.prune(name, lang);
    return rec;
  }
  /** Only the `keep` most recent keys of a game version and language. */
  prune(name, lang) {
    const dir = path.join(this.dir, safe(name)), prefix = `${safe(lang || 'none')}-`;
    let recs; try { recs = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')); } catch { return; }
    const byAge = recs.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of byAge.slice(this.keep)) for (const ext of ['.json', '.gz', '.br']) fs.rmSync(path.join(dir, f.slice(0, -5) + ext), { force: true });
  }
  /** The file to send for an Accept-Encoding header: { file, encoding, size } (brotli when taken), or null. */
  open(name, lang, key, accept = '') {
    const m = this.meta(name, lang, key);
    if (!m) return null;
    const br = /\bbr\b/.test(accept), base = this.base(name, lang, key);
    return br ? { file: base + '.br', encoding: 'br', size: m.br, meta: m } : { file: base + '.gz', encoding: 'gzip', size: m.gz, meta: m };
  }
}

/**
 * The publishing sessions, one at a time: a headless browser opened on this server as a new player of a game version and
 * language (tools/snapshot-publish.mjs, through tools/with-browser-slot.sh: the project's browser budget and the load
 * limit), which posts each snapshot it keeps with its token. The same key is not tried again within `retryMs`.
 */
export class SnapshotJobs {
  constructor({ root, url, logDir, retryMs = 6 * 3600e3, timeoutS = 1500 }) {
    this.root = root; this.url = url; this.logDir = logDir; this.retryMs = retryMs; this.timeoutS = timeoutS;
    this.queue = []; this.running = null; this.tried = new Map(); this.tokens = new Map();
  }
  /** Queue a session for (game version, language, key) unless one ran or is waiting. */
  want(name, lang, key) {
    const id = `${name}|${lang}|${key}`, t = this.tried.get(id);
    if ((t && Date.now() - t < this.retryMs) || this.running?.id === id || this.queue.some((j) => j.id === id)) return false;
    this.queue.push({ id, name, lang, key }); this.next();
    return true;
  }
  /** The job a POST's token belongs to (it must name the same game version, language and key), or null. */
  job(token, name, lang, key) { const j = this.tokens.get(token); return j && j.name === name && j.lang === lang && j.key === key ? j : null; }
  next() {
    if (this.running || !this.queue.length) return;
    const j = this.running = this.queue.shift(), token = crypto.randomBytes(16).toString('hex');
    this.tried.set(j.id, Date.now()); this.tokens.set(token, j);
    fs.mkdirSync(this.logDir, { recursive: true });
    const log = fs.openSync(path.join(this.logDir, `publish-${safe(j.name)}-${safe(j.lang || 'none')}.log`), 'w');
    const args = ['node', 'tools/snapshot-publish.mjs', j.name, '--url', this.url(), '--lang', j.lang, '--key', j.key, '--token', token];
    const child = spawn('timeout', [String(this.timeoutS), path.join(this.root, 'tools/with-browser-slot.sh'), ...args], { cwd: this.root, stdio: ['ignore', log, log] });
    let ended = false;
    const done = () => { if (ended) return; ended = true; fs.closeSync(log); this.tokens.delete(token); this.running = null; this.next(); };
    child.on('exit', done); child.on('error', done);
  }
}

/**
 * The same requests kept in a file for a runner outside this server (tools/snapshot-jobs.mjs): a server that may not
 * start browsers itself — a sandboxed service, with no home nor the shared /tmp of the browser slots — only queues them,
 * each with its token. A request stays two hours (the runner's session posts meanwhile); the same key is not queued
 * again within `retryMs`.
 */
export class SnapshotQueue {
  constructor(file, { retryMs = 6 * 3600e3, ttlMs = 2 * 3600e3, max = 32 } = {}) {
    this.file = file; this.retryMs = retryMs; this.ttlMs = ttlMs; this.max = max;
    try { this.jobs = JSON.parse(fs.readFileSync(file, 'utf8')).jobs ?? []; } catch { this.jobs = []; }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ v: 1, jobs: this.jobs })); fs.renameSync(this.file + '.tmp', this.file);
  }
  want(name, lang, key) {
    const now = Date.now();
    this.jobs = this.jobs.filter((j) => now - j.at < Math.max(this.ttlMs, this.retryMs));
    if (this.jobs.some((j) => j.name === name && j.lang === lang && j.key === key) || this.jobs.length >= this.max) return false;
    this.jobs.push({ name, lang, key, token: crypto.randomBytes(16).toString('hex'), at: now });
    this.save();
    return true;
  }
  job(token, name, lang, key) {
    const j = this.jobs.find((x) => x.token === token);
    return j && j.name === name && j.lang === lang && j.key === key && Date.now() - j.at < this.ttlMs ? j : null;
  }
}
