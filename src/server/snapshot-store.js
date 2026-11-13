// Shared snapshots (docs/snapshot.md, stage 3): for a player who has none of their own, the snapshot a new player's
// session took on this server — a headless browser started for it (tools/snapshot-publish.mjs, through the browser
// slots), which published it here. Per game version, language and snapshot key (the page's: Orthros' state-owning
// sources, the version's files, the options that change the machine), with the shared first-launch profile it started
// from (a new player's profile: profile-seed.js) — another one since makes it stale. Stored compressed (gzip, and brotli
// for the browsers that take it), the two most recent keys per game version and language; and in pieces (`.brp`:
// PIECE bytes of the snapshot each compressed alone, brotli, their offsets in `.brp.json`) for the page that downloads
// it piece by piece into its store, resumable (src/web/snapshot-fetch.js): each piece goes with Content-Encoding (the
// browser decodes it), made at the publish, or once from the `.br` for a snapshot kept before them.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { learnCommand, learnTimeout } from './warm-jobs.js';
import { pipeline } from 'node:stream/promises';

const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');
export const SNAPSHOT_KEY = /^[0-9a-f]{32}$/;
/** Bytes of the snapshot in one piece (measured on BFME1 1.08's 314 MB: 4 MiB pieces alone 92.4 MB, the whole 92.4 MB). */
export const SNAPSHOT_PIECE = 4 << 20;
/** gzipped pieces kept in memory (SnapshotStore.gzipPiece): 32 × ~4.6 MB at most */
const GZ_PIECES = 32;
const PIECE_BR = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_LGWIN]: 22 } };
const brotli = (buf) => new Promise((res, rej) => zlib.brotliCompress(buf, PIECE_BR, (e, out) => (e ? rej(e) : res(out))));

export class SnapshotStore {
  /** @param {string} dir where they are kept (created) */
  constructor(dir, { keep = 2 } = {}) { this.dir = dir; this.keep = keep; this.puts = new Map(); this.tmpSeq = 0; this.gzPieces = new Map(); }
  /**
   * Piece `i` of `pc` (pieces()) gzipped, for a browser that does not take brotli: decoded and gzipped off the event loop
   * (libuv's threads), the last GZ_PIECES kept (~55 ms of CPU each; any client may ask, again and again).
   */
  async gzipPiece(pc, i, body) {
    const k = `${pc.file}|${pc.meta.at}|${i}`;
    let p = this.gzPieces.get(k);
    if (!p) {
      p = new Promise((res, rej) => zlib.brotliDecompress(body, (e, raw) => (e ? rej(e) : zlib.gzip(raw, { level: 6 }, (e2, gz) => (e2 ? rej(e2) : res(gz))))));
      this.gzPieces.set(k, p); p.catch(() => this.gzPieces.delete(k));
      while (this.gzPieces.size > GZ_PIECES) this.gzPieces.delete(this.gzPieces.keys().next().value);
    } else { this.gzPieces.delete(k); this.gzPieces.set(k, p); }
    return p;
  }
  base(name, lang, key) { return path.join(this.dir, safe(name), `${safe(lang || 'none')}-${key}`); }
  /** What is kept of one ({ bytes, seed, at, gz, br }), or null. */
  meta(name, lang, key) {
    try { return JSON.parse(fs.readFileSync(this.base(name, lang, key) + '.json', 'utf8')); } catch { return null; }
  }
  /**
   * Keep the snapshot in file `src` (moved away): compressed, its record written last (`extra`: what it applies to
   * besides its key — the first-launch profile it started from). Older keys of the same game version and language go.
   * The puts of one key run one after the other (a session posts a later snapshot while the first is still being
   * compressed: both wrote the same .tmp files, the second failed with HTTP 500 — 3 times on the live runner in 5 days —
   * after removing the record, which could leave the key with none).
   */
  put(name, lang, key, src, extra = {}) {
    const base = this.base(name, lang, key), prev = this.puts.get(base) ?? Promise.resolve();
    const p = prev.catch(() => {}).then(() => this.putNow(name, lang, key, src, extra));
    this.puts.set(base, p);
    const forget = () => { if (this.puts.get(base) === p) this.puts.delete(base); };
    p.then(forget, forget);
    return p;
  }
  async putNow(name, lang, key, src, extra) {
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
    await this.pieces(name, lang, key).catch(() => null); // (the pieces made now: the first new player does not wait for them)
    return rec;
  }
  /**
   * The snapshot in pieces: { file (.brp), offsets (piece i: [offsets[i], offsets[i + 1]) of it), piece (SNAPSHOT_PIECE),
   * bytes, meta } — made from the `.br` the first time (each piece compressed alone, on libuv's threads), or null.
   */
  pieces(name, lang, key) {
    const base = this.base(name, lang, key), m = this.meta(name, lang, key);
    if (!m) return Promise.resolve(null);
    const id = `${base}|${m.at}`;
    this.making ??= new Map();
    if (this.making.has(id)) return this.making.get(id);
    const done = (async () => {
      try {
        const idx = JSON.parse(fs.readFileSync(base + '.brp.json', 'utf8'));
        if (idx.at === m.at && Array.isArray(idx.sums) && fs.statSync(base + '.brp').size === idx.offsets.at(-1)) return { file: base + '.brp', offsets: idx.offsets, sums: idx.sums, piece: idx.piece, bytes: m.bytes, meta: m };
      } catch { /* not made yet */ }
      // (a temporary file of its own: the start's piecesAll and a publish's put may build two `at`s of a key at once)
      const tmp = `${base}.brp.${process.pid}-${++this.tmpSeq}.tmp`;
      const out = fs.createWriteStream(tmp), offsets = [0], sums = [];
      let pending = Buffer.alloc(0);
      // (`sums`: each piece's CRC-32 of its decoded bytes — the page checks every piece against its index's before keeping it)
      const put = async (buf) => { sums.push(zlib.crc32(buf)); const c = await brotli(buf); offsets.push(offsets.at(-1) + c.length); if (!out.write(c)) await new Promise((r) => out.once('drain', r)); };
      for await (const chunk of fs.createReadStream(base + '.br').pipe(zlib.createBrotliDecompress())) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= SNAPSHOT_PIECE) { await put(pending.subarray(0, SNAPSHOT_PIECE)); pending = pending.subarray(SNAPSHOT_PIECE); }
      }
      if (pending.length) await put(pending);
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      fs.renameSync(tmp, base + '.brp');
      fs.writeFileSync(base + '.brp.json.tmp', JSON.stringify({ at: m.at, piece: SNAPSHOT_PIECE, offsets, sums })); fs.renameSync(base + '.brp.json.tmp', base + '.brp.json');
      return { file: base + '.brp', offsets, sums, piece: SNAPSHOT_PIECE, bytes: m.bytes, meta: m };
    })().catch(() => { fs.rmSync(tmp, { force: true }); return null; }).finally(() => this.making.delete(id));
    this.making.set(id, done);
    return done;
  }
  /** The pieces of every snapshot kept made, one at a time (a server's start: those kept before pieces existed). */
  async piecesAll() {
    let names; try { names = fs.readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return; }
    for (const name of names) {
      let files; try { files = fs.readdirSync(path.join(this.dir, name)); } catch { continue; }
      for (const f of files) { const m = /^(.+)-([0-9a-f]{32})\.json$/.exec(f); if (m && !f.endsWith('.brp.json')) await this.pieces(name, m[1], m[2]).catch(() => null); }
    }
  }
  /** Only the `keep` most recent keys of a game version and language. */
  prune(name, lang) {
    const dir = path.join(this.dir, safe(name)), prefix = `${safe(lang || 'none')}-`;
    let recs; try { recs = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json') && !f.endsWith('.brp.json')); } catch { return; }
    const byAge = recs.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of byAge.slice(this.keep)) for (const ext of ['.json', '.gz', '.br', '.brp', '.brp.json']) fs.rmSync(path.join(dir, f.slice(0, -5) + ext), { force: true });
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
  want(name, lang, key, kind = 'publish') {
    const id = `${kind === 'publish' ? '' : kind + '|'}${name}|${lang}|${key}`, t = this.tried.get(id);
    if ((t && Date.now() - t < this.retryMs) || this.running?.id === id || this.queue.some((j) => j.id === id)) return false;
    this.queue.push({ id, name, lang, key, kind }); this.next();
    return true;
  }
  /** The job a POST's token belongs to (it must name the same game version, language and key), or null. */
  job(token, name, lang, key) { const j = this.tokens.get(token); return j && j.kind === 'publish' && j.name === name && j.lang === lang && j.key === key ? j : null; }
  /** The learn job of `name` a token belongs to (tools/warm-learn.mjs reports the scenarios it played), or null. */
  learnJob(token, name) { const j = this.tokens.get(token); return j && j.kind === 'learn' && j.name === name ? j : null; }
  next() {
    if (this.running || !this.queue.length) return;
    const j = this.running = this.queue.shift(), token = crypto.randomBytes(16).toString('hex');
    this.tried.set(j.id, Date.now()); this.tokens.set(token, j);
    fs.mkdirSync(this.logDir, { recursive: true });
    const log = fs.openSync(path.join(this.logDir, `publish-${safe(j.name)}-${safe(j.lang || 'none')}.log`), 'w');
    const url = this.url(), scratch = j.kind === 'learn' ? fs.mkdtempSync(path.join(fs.existsSync('/tmp/orthros-scratch') ? '/tmp/orthros-scratch' : os.tmpdir(), 'learn-')) : null;
    const args = scratch ? learnCommand(j.name, url, token, scratch, j.lang) : ['node', 'tools/snapshot-publish.mjs', j.name, '--url', url, '--lang', j.lang, '--key', j.key, '--token', token];
    const timeoutS = scratch ? Math.max(this.timeoutS, learnTimeout(this.root, j.name)) : this.timeoutS;
    const child = spawn('timeout', [String(timeoutS), path.join(this.root, 'tools/with-browser-slot.sh'), ...args], { cwd: this.root, stdio: ['ignore', log, log] });
    let ended = false;
    const done = () => { if (ended) return; ended = true; fs.closeSync(log); if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); this.tokens.delete(token); this.running = null; this.next(); };
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
  want(name, lang, key, kind = 'publish') {
    const now = Date.now();
    // (a job past its ttl only keeps its key from being queued again within retryMs: one of the same version, language
    // and kind under another key is moot — a deploy changed the key — and goes; when full, the oldest past ttl go first:
    // a few deploys a day of 11-16 jobs each must not fill the queue and refuse a player's 404 for hours)
    this.jobs = this.jobs.filter((j) => now - j.at < Math.max(this.ttlMs, this.retryMs)
      && !(now - j.at >= this.ttlMs && j.name === name && j.lang === lang && (j.kind ?? 'publish') === kind && j.key !== key));
    if (this.jobs.some((j) => j.name === name && j.lang === lang && j.key === key && (j.kind ?? 'publish') === kind)) return false;
    if (this.jobs.length >= this.max) {
      const old = this.jobs.filter((j) => now - j.at >= this.ttlMs).sort((a, b) => a.at - b.at);
      const drop = new Set(old.slice(0, this.jobs.length - this.max + 1));
      this.jobs = this.jobs.filter((j) => !drop.has(j));
      if (this.jobs.length >= this.max) return false;
    }
    this.jobs.push({ name, lang, key, kind, token: crypto.randomBytes(16).toString('hex'), at: now });
    this.save();
    return true;
  }
  job(token, name, lang, key) {
    const j = this.jobs.find((x) => x.token === token);
    return j && (j.kind ?? 'publish') === 'publish' && j.name === name && j.lang === lang && j.key === key && Date.now() - j.at < this.ttlMs ? j : null;
  }
  learnJob(token, name) {
    const j = this.jobs.find((x) => x.token === token);
    return j && j.kind === 'learn' && j.name === name && Date.now() - j.at < this.ttlMs ? j : null;
  }
}
