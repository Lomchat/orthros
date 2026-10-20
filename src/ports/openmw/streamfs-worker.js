// The worker of the OpenMW engine page's file streaming (streamfs.js): the page's thread asks it for blocks of a file and
// waits on shared memory (ctrl[0]: the request answered, ctrl[1]: bytes delivered or -1, ctrl[2]: bytes arrived so far,
// the page's proof the request is alive). For a file of the server it keeps a copy of every 64 KB block it got in the
// browser's private files (OPFS: <hash>.d, the blocks at their offsets, and <hash>.m, which of them are there — a small
// file is kept whole, without a map), fetches the missing ones compressed when the server offers it (z/: src/host/
// openmw.js, openmwSpans) else as a plain range, and decides how far to read: a small file whole, an archive's record
// whole (TES3 BSA: its file table), more and more ahead of a file read in order (as much as the link carries in about
// two seconds, and the next stretch already on its way). It reports the blocks the engine asked for and when to the
// server, which hands a new session the order earlier ones needed them in: fetched ahead from the start, one or two at a
// time, behind what the engine waits for (openmwReads). The pieces the upstream streamfs.js kept in the Cache API are
// taken over, not fetched again.
const BLOCK = 65536, SMALL = 1 << 20, SPAN = 16 << 20, OLD_CHUNK = 2 << 20, STALL = 20000, LEARN = 30 * 60000;
let ctrl = null, data = null, app = null;
const files = new Map(), byPath = new Map();   // id -> file; path beneath app/ -> file
let rate = 0;      // bytes/s the link carried lately
let waiting = 0;   // requests the page's thread waits for

onmessage = (e) => {
  const m = e.data;
  if (m.init) {
    ctrl = new Int32Array(m.init.ctrl); data = new Uint8Array(m.init.data);
    const at = m.init.page.indexOf('/app/');
    if (at > 0) { app = m.init.page.slice(0, at + 5); learn(); }
    return;
  }
  if (m.mount) { mount(m.mount); return; }
  if (m.setUrl) { const f = files.get(m.setUrl.id); if (f) f.url = m.setUrl.url; return; }
  // (blocks the engine used for the first time: id × 2^21 + block)
  for (const key of m.used ?? []) {
    const f = files.get(Math.floor(key / 2 ** 21)), k = key % 2 ** 21;
    if (f?.path) { heard(f, k * BLOCK, Math.min(f.size, (k + 1) * BLOCK)); ahead.seen(f, k * BLOCK, (k + 1) * BLOCK); }
  }
  if (typeof m.gen === 'number') answer(m);
};

function mount({ id, size, url, mtime, handle, blob }) {
  const f = { id, size, url, handle, blob, pending: new Set() };
  if (url) {
    const u = new URL(url);
    // (a plain file of this origin: kept, and asked compressed when it is one of the installation's served files;
    // a signed address — a query — is neither, as the upstream)
    if (u.origin === location.origin && !u.search) {
      f.key = u.pathname + '@' + size + '@' + mtime;
      f.old = 'https://sfs.chunk/' + encodeURIComponent(u.pathname + '@' + size + (mtime ? '@' + mtime : '') + '@' + OLD_CHUNK) + '/';
      if (/\/app\/(mwdata|moddata)\//.test(u.pathname)) f.z = u.pathname.replace(/\/app\/(mwdata|moddata)\//, '/app/z/$1/');
      f.bsa = /\.bsa$/i.test(u.pathname) && size > SMALL;
      if (app && u.pathname.startsWith(app)) {
        f.path = u.pathname.slice(app.length); byPath.set(f.path, f);
        ahead.mounted = performance.now(); clearTimeout(ahead.timer); ahead.timer = setTimeout(() => ahead.pump(), 3000);
        ahead.pump();
      }
    }
  }
  files.set(id, f);
}

async function answer(m) {
  const f = files.get(m.id);
  waiting++; ahead.reached(f, m.start, m.end);
  try {
    const { at, bytes } = await blocks(f, m);
    if (at !== m.start) throw new Error('misaligned');
    const n = Math.min(bytes.length, data.length);
    data.set(bytes.subarray(0, n), 0);
    ctrl[1] = n;
  } catch (err) {
    ctrl[1] = -1;
  }
  waiting--;
  Atomics.add(ctrl, 2, 1);
  Atomics.store(ctrl, 0, m.gen);
  Atomics.notify(ctrl, 0);
  ahead.pump();
}

/** The bytes from m.start (a block's start) through m.end at least, and on as far as worth it (not past m.limit). */
async function blocks(f, m) {
  if (f.handle || f.blob) {
    if (!f.file) f.file = f.blob ?? await f.handle.getFile();
    const end = Math.min(f.size, Math.max(m.end, Math.min(m.limit, m.start + 4 * BLOCK)));
    return { at: m.start, bytes: new Uint8Array(await f.file.slice(m.start, end).arrayBuffer()) };
  }
  if (f.size <= SMALL) {
    const all = await whole(f);
    return { at: m.start, bytes: all.subarray(m.start) };
  }
  let end = Math.max(m.end, m.start + BLOCK);
  const record = f.bsa ? await recordAround(f, m.start) : null;
  if (record) end = Math.max(end, Math.min(record, m.limit));
  let stretch = 0;
  if (!record && m.run > 0) {
    // (read in order so far: ahead as far as it was read, up to what the link carries in about two seconds — and the
    // stretch after it fetched while the engine works on this one)
    stretch = Math.floor(Math.min(Math.max(m.run, BLOCK), Math.max(4 * BLOCK, Math.min(4 << 20, rate ? rate * 2 : 1 << 20))) / BLOCK) * BLOCK;
    end = Math.max(end, Math.min(m.limit, m.start + stretch));
  }
  end = Math.min(f.size, Math.ceil(end / BLOCK) * BLOCK, m.start + SPAN);
  const bytes = await range(f, m.start, end);
  if (stretch && end < f.size) fetchAhead(f, end, Math.min(f.size, end + stretch));
  return { at: m.start, bytes };
}

// ---------------------------------------------------------------- a file's bytes: its kept copy, else the server

/** Bytes [a, b) of a large file (a: a block's start; b: a block's start or the file's end). */
async function range(f, a, b) {
  await settled(f, a, b);
  const out = new Uint8Array(b - a), copy = await kept(f);
  const missing = [];
  for (let k = a / BLOCK; k * BLOCK < b; k++) {
    const s = k * BLOCK, e = Math.min(b, s + BLOCK);
    if (has(copy, k)) {
      try { if (copy.dat.read(out.subarray(s - a, e - a), { at: s }) === e - s) continue; } catch { /* read again */ }
    }
    const last = missing.at(-1);
    if (last && last[1] === s) last[1] = e; else missing.push([s, e]);
  }
  if (missing.length && f.old) await takeOver(f, copy, missing, out, a);
  await Promise.all(missing.filter(([s, e]) => e > s).map(async ([s, e]) => {
    const bytes = await fetchBytes(f, s, e);
    out.set(bytes, s - a);
    keep(f, copy, s, bytes);
  }));
  return out;
}

/** A small file, whole. */
async function whole(f, mine = null) {
  await settled(f, 0, f.size, mine);
  const copy = await kept(f);
  if (copy?.dat) {
    try {
      if (copy.dat.getSize() === f.size) { const out = new Uint8Array(f.size); if (copy.dat.read(out, { at: 0 }) === f.size) return out; }
    } catch { /* fetched again */ }
  }
  const missing = [[0, f.size]], out = new Uint8Array(f.size);
  if (f.old) await takeOver(f, null, missing, out, 0);
  if (missing[0][1] > missing[0][0]) out.set(await fetchBytes(f, 0, f.size), 0);
  if (copy?.dat) { try { copy.dat.truncate(0); copy.dat.write(out, { at: 0 }); copy.dat.flush(); } catch { /* not kept */ } }
  return out;
}

const has = (copy, k) => !!(copy?.bits && copy.bits[k >> 3] & (1 << (k & 7)));

/**
 * Fetches ahead of [a, b) on their way: waited for rather than asked twice. A fetch ahead waits only for the ones started
 * before it (none waits for a later one: no two wait for each other); a read the engine waits for, for all of them.
 */
async function settled(f, a, b, mine = null) {
  for (const p of [...f.pending]) if ((!mine || p.seq < mine.seq) && p.a < b && a < p.b) await p.done;
}

/** Blocks [a, b) fetched into the kept copy in the background (nothing to keep them in: nothing done). */
let jobs = 0;
function fetchAhead(f, a, b) {
  if (!f.key || [...f.pending].some((p) => p.a <= a && b <= p.b)) return null;
  const job = { a, b, seq: ++jobs };
  f.pending.add(job);
  job.done = (async () => {
    const copy = await kept(f);
    if (!copy) return;
    if (f.size <= SMALL) { if (!(copy.dat.getSize() === f.size)) await whole(f, job); return; }
    await settled(f, a, b, job);
    const missing = [];
    for (let k = a / BLOCK; k * BLOCK < b; k++) {
      if (has(copy, k)) continue;
      const s = k * BLOCK, e = Math.min(b, s + BLOCK), last = missing.at(-1);
      if (last && last[1] === s && e - last[0] <= 4 << 20) last[1] = e; else missing.push([s, e]);
    }
    if (missing.length && f.old) await takeOver(f, copy, missing, new Uint8Array(b - a), a);
    for (const [s, e] of missing) if (e > s) keep(f, copy, s, await fetchBytes(f, s, e));
  })().catch(() => {}).finally(() => f.pending.delete(job));
  return job.done;
}

// ---------------------------------------------------------------- what earlier sessions read, and when

/** The blocks the engine used (the page's thread tells), reported to the server (the first 30 minutes); its list fetched ahead. */
const heardList = [], heardSet = new Set(), session = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
function heard(f, a, b) {
  const t = Math.round(performance.now());
  if (t > LEARN) return;
  for (let k = a / BLOCK; k * BLOCK < b; k++) {
    const key = f.id * 2 ** 21 + k;
    if (heardSet.has(key)) continue;
    heardSet.add(key);
    const last = heardList.at(-1), s = k * BLOCK, e = Math.min(f.size, s + BLOCK);
    if (last && last[0] === f.path && last[3] === s) last[3] = e; else heardList.push([f.path, f.size, s, e, t]);
  }
}
function learn() {
  const id = app.split('/')[3];
  setInterval(() => {
    if (!heardList.length) return;
    const reads = heardList.splice(0, 5000);
    fetch(`/api/openmw/${id}/reads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session, reads }) }).catch(() => {});
  }, 15000);
  fetch(`/api/openmw/${id}/prefetch`, { cache: 'no-store' }).then((r) => r.ok ? r.json() : []).then((list) => {
    if (!Array.isArray(list)) return;
    ahead.list = list;
    let sum = 0;
    list.forEach(([path, , a, b], i) => { ahead.sums.push(sum); sum += b - a; (ahead.where.get(path) ?? ahead.where.set(path, []).get(path)).push([i, a, b]); });
    ahead.sums.push(sum);
    ahead.pump();
  }).catch(() => {});
}

/**
 * The list earlier sessions needed, fetched ahead in its order: two at a time, one while the page waits for a read. Not
 * before the engine asks for its first block (its own download comes first: nothing starts without it). While it keeps
 * asking (it starts, a game loads), not further ahead of the last listed block it asked for than the link carries in
 * 15 s — what it needs now first; once it has asked nothing for 3 s (a menu, a pause), on to the end.
 */
const ahead = {
  list: [], next: 0, running: 0, mounted: 0, timer: 0, at: 0, asked: 0, where: new Map(), sums: [], started: false,
  reached(f, a, b) {
    this.asked = performance.now(); this.started = true; this.seen(f, a, b);
    clearTimeout(this.idle); this.idle = setTimeout(() => this.pump(), 3100);
  },
  seen(f, a, b) { for (const [i, s, e] of this.where.get(f.path) ?? []) if (s < b && a < e && i > this.at) this.at = i; },
  told: 0,
  tell(force) {
    const now = performance.now(), total = this.sums.at(-1) ?? 0;
    if (!total || (!force && now - this.told < 500)) return;
    this.told = now; postMessage({ ahead: { done: this.running ? this.sums[Math.max(0, this.next - this.running)] : this.sums[this.next], total } });
  },
  pump() {
    if (!this.started) return;
    this.tell(this.next >= this.list.length && !this.running);
    const busy = performance.now() - this.asked < 3000, reach = Math.max(8 << 20, (rate || 1 << 20) * 15);
    while (this.next < this.list.length && this.running < (waiting ? 1 : 2)) {
      if (busy && this.sums[this.next] - this.sums[this.at] > reach) return;
      const [path, size, a, b] = this.list[this.next], f = byPath.get(path);
      // (not mounted yet: on with the list when it is — or past it, once nothing was mounted for 3 s)
      if (!f && performance.now() - this.mounted < 3000) return;
      this.next++;
      if (!f) continue;
      if (f.size !== size) continue;
      const job = fetchAhead(f, a, b);
      if (!job) continue;
      this.running++;
      job.finally(() => { this.running--; this.pump(); });
    }
  },
};

/** The pieces the upstream streamfs.js kept (Cache API, 2 MB each) for the missing ranges: copied, then let go. */
let oldCache;
async function takeOver(f, copy, missing, out, a) {
  if (oldCache === undefined) oldCache = (async () => { try { return await caches.has('mwdata-chunks-v1') ? await caches.open('mwdata-chunks-v1') : null; } catch { return null; } })();
  const cache = await oldCache;
  if (!cache) return;
  for (const run of missing) {
    for (let c = Math.floor(run[0] / OLD_CHUNK) * OLD_CHUNK; c < run[1]; c += OLD_CHUNK) {
      let hit; try { hit = await cache.match(f.old + c); } catch { return; }
      if (!hit) continue;
      const bytes = new Uint8Array(await hit.arrayBuffer());
      if (bytes.length !== Math.min(OLD_CHUNK, f.size - c)) continue;
      // (inside the run: into the answer; the whole piece: into the kept copy)
      const s = Math.max(run[0], c), e = Math.min(run[1], c + bytes.length);
      out.set(bytes.subarray(s - c, e - c), s - a);
      if (copy) keep(f, copy, c, bytes);
      cache.delete(f.old + c).catch(() => {});
      // (what is left of the run to fetch: before and after the piece)
      if (s === run[0]) run[0] = e;
      else if (e === run[1]) run[1] = s;
      else { missing.push([e, run[1]]); run[1] = s; }
    }
  }
}

// ---------------------------------------------------------------- the network

/** Bytes [a, b) of the file from the server: compressed when it offers it, else a plain range; retried. */
async function fetchBytes(f, a, b) {
  if (!(Number.isInteger(a) && Number.isInteger(b) && 0 <= a && a < b && b <= f.size)) throw new Error('bad range ' + a + '-' + b);
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 300 * attempt * attempt));
    const z = f.z && !f.zOff;
    const ac = new AbortController();
    let timer = 0; const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(), STALL); };
    const t0 = performance.now();
    try {
      arm();
      const r = await fetch(z ? `${f.z}?r=${a}-${b}&s=${f.size}` : f.url, z ? { signal: ac.signal, cache: 'no-store' }
        : { signal: ac.signal, cache: 'no-store', headers: { Range: `bytes=${a}-${b - 1}` } });
      if (z && [404, 412].includes(r.status)) { f.zOff = true; attempt--; continue; }   // (not offered: the plain range)
      if (!r.ok) { last = new Error('HTTP ' + r.status); if (r.status < 500 && r.status !== 408 && r.status !== 429) throw last; continue; }
      // (a server that ignores the range answers the whole file: the part wanted is cut out of it)
      const skip = !z && r.status === 200 ? a : 0, out = new Uint8Array(b - a), reader = r.body.getReader();
      let pos = 0, got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm(); Atomics.add(ctrl, 2, value.length);
        const s = Math.max(0, skip - pos), e = Math.min(value.length, skip + out.length - pos);
        if (e > s) { out.set(value.subarray(s, e), pos + s - skip); got += e - s; }
        pos += value.length;
        if (got === out.length && skip) { ac.abort(); break; }
      }
      // (a short answer that ended cleanly is still short: asked again)
      if (got !== out.length) { last = new Error('short answer'); continue; }
      const ms = performance.now() - t0;
      if (out.length >= 4 * BLOCK) { const now = out.length / Math.max(ms, 1) * 1000; rate = rate ? rate * 0.6 + now * 0.4 : now; }
      return out;
    } catch (err) {
      last = err;
      if (/^HTTP 4/.test(String(err?.message)) && !/^HTTP 4(08|29)/.test(err.message)) throw err;
    } finally { clearTimeout(timer); }
  }
  throw last ?? new Error('fetch failed');
}

// ---------------------------------------------------------------- archives

/** The end of the TES3 BSA record holding byte `at` (or null: not inside one, or not such an archive). */
async function recordAround(f, at) {
  if (f.table === undefined) f.table = readTable(f).catch(() => null);
  const t = await f.table;
  if (!t || at < t.data) return null;
  let lo = 0, hi = t.starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t.starts[mid] <= at) lo = mid; else hi = mid - 1; }
  return t.starts[lo] <= at && at < t.ends[lo] ? t.ends[lo] : null;
}

/** A TES3 BSA's file table: version 0x100, the hash table's offset, the file count, then (size, offset) per file. */
async function readTable(f) {
  const head = new DataView((await range(f, 0, BLOCK)).buffer);
  if (head.getUint32(0, true) !== 0x100) return null;
  const hashAt = head.getUint32(4, true), count = head.getUint32(8, true), dataAt = 12 + hashAt + 8 * count;
  if (!count || dataAt > f.size) return null;
  const end = 12 + 8 * count, raw = end <= BLOCK ? head : new DataView((await range(f, 0, Math.min(f.size, Math.ceil(end / BLOCK) * BLOCK))).buffer);
  const recs = [];
  for (let i = 0; i < count; i++) recs.push([dataAt + raw.getUint32(16 + 8 * i, true), raw.getUint32(12 + 8 * i, true)]);
  recs.sort((x, y) => x[0] - y[0]);
  return { data: dataAt, starts: Float64Array.from(recs, (r) => r[0]), ends: Float64Array.from(recs, (r) => r[0] + r[1]) };
}

// ---------------------------------------------------------------- the kept copies (OPFS)

let root;
const open = new Map();   // file id -> its kept copy, most recently used last (a bounded number open at once)

/** The kept copy of a server file: { dat, bits?, map? } (a small file: dat alone), or null (none can be kept). */
async function kept(f) {
  if (!f.key) return null;
  if (open.has(f.id)) { const c = open.get(f.id); open.delete(f.id); open.set(f.id, c); return c; }
  const c = (async () => {
    root ??= (async () => { try { return await (await navigator.storage.getDirectory()).getDirectoryHandle('orthros-streamfs-1', { create: true }); } catch { return null; } })();
    const dir = await root;
    if (!dir) return null;
    try {
      const name = hash(f.key), dat = await handle(dir, name + '.d');
      if (f.size <= SMALL) return { dat };
      const map = await handle(dir, name + '.m'), bits = new Uint8Array(Math.ceil(Math.ceil(f.size / BLOCK) / 8));
      // (a map of another size: another file's copy, or none yet — started over, the map at its full size)
      if (map.getSize() === bits.length) map.read(bits, { at: 0 }); else { dat.truncate(0); map.truncate(0); map.truncate(bits.length); map.flush(); }
      return { dat, map, bits };
    } catch { return null; }
  })();
  open.set(f.id, c);
  while (open.size > 256) {
    const [id, old] = open.entries().next().value;
    open.delete(id);
    old.then((o) => { try { o?.dat.close(); o?.map?.close(); } catch { /* closed */ } });
  }
  return c;
}

async function handle(dir, name) {
  const fh = await dir.getFileHandle(name, { create: true });
  // (another tab of the same game may hold the same copy open)
  try { return await fh.createSyncAccessHandle({ mode: 'readwrite-unsafe' }); } catch { return await fh.createSyncAccessHandle(); }
}

/** Blocks fetched into the kept copy: the bytes first, then the map that says they are there. */
function keep(f, copy, at, bytes) {
  if (!copy?.bits) return;
  try {
    copy.dat.write(bytes, { at }); copy.dat.flush();
    const first = at / BLOCK, n = Math.ceil(bytes.length / BLOCK);
    for (let k = first; k < first + n; k++) copy.bits[k >> 3] |= 1 << (k & 7);
    copy.map.write(copy.bits.subarray(first >> 3, ((first + n - 1) >> 3) + 1), { at: first >> 3 });
  } catch { /* not kept (no room, closed): fetched again next time */ }
}

/** A short file name for a key (two 32-bit FNV-1a). */
function hash(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193); h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 13); }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
