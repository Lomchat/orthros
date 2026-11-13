// The server's shared snapshot of a game (docs/snapshot.md stage 3) for a new player, over any link (docs/slow-network.md
// "The first launch on a slow link"): weighed against a cold start once the link is measured, then downloaded piece by
// piece into this browser's store (OPFS), resumable, with its progress.
//
// - **The choice, made once**: the page asks for the snapshot's pieces (?piece=i: SNAPSHOT_PIECE bytes of it each
//   compressed alone, sent with Content-Encoding — the browser decodes them: src/server/snapshot-store.js pieces); the
//   first answer says every piece's wire bytes and what a cold start costs instead — the version's launch set in this
//   language (X-Launch-Wire: its wire bytes, light copies as on a link that is not fast: launch-set.js) and the machine's
//   start-up time the publishing session saw (X-Boot-Ms, else BOOT_MS). The link's rate is measured on the snapshot's
//   own first bytes (DECIDE_MS: a rate saved from an earlier visit may be another network's): the snapshot is kept when
//   it comes no later than a cold start would — the cold start's reads crossing the link at COLD_EFF of its rate, or
//   its start-up if longer (the two overlap: the machine starts while its files come) — and the download goes on to the end; else it stops there and the game starts cold. Never changed
//   afterwards (a link that slows down later does not throw away what came).
// - **Pieces in the store**: two in flight, each written whole to its own file (orthros-snapshot-<manifest>/shared/<i>,
//   a piece is there or not), the download's record beside them (shared/info.json: key, language, the snapshot's id,
//   piece size, count). A page that goes away resumes on its next visit from the pieces there (same key and id: else
//   they go). Once all are here, put together (the snapshot's bytes), the pieces removed once the game started from it
//   (dropPieces: it is then this player's own snapshot, main.js storeSnapshot).
// - `?snapfetch=0`: the previous path (the whole snapshot in one answer, kept unless the saved rate says it would take
//   more than 60 s).

import { crc32 } from '../core/crc32.js';

/** Pieces in flight (two left the link idle ~25 % of the time in Chrome at 1.25 MB/s: a piece read late asks the next late). */
const IN_FLIGHT = 4;
/** The link is measured on the snapshot's first piece: at its end, or 3 × this long after its first bytes (ms). */
export const DECIDE_MS = 3000;
/** ... once at least these wire bytes came. */
const DECIDE_BYTES = 192 << 10;
/**
 * The share of the link a cold start's reads get, on average from the launch to the menu: its reads come in turns with
 * the machine's work, not as one download (measured 2026-11-12 at 85 KB/s: BFME1 0.87 with the reader on the emulator's
 * thread — docs/slow-network.md "The first launch on a slow link").
 */
export const COLD_EFF = 0.75;
/** The machine's start-up time to its menu when the publishing session did not say it (ms). */
export const BOOT_MS = 120000;
/** Restoring a snapshot (s per decoded MiB, measured: ~2 s for 300 MiB). */
const RESTORE_S_PER_MIB = 0.01;

/**
 * The choice between the snapshot and a cold start for a link of `bw` bytes/s: { snapshot (true: keep it), snapS, coldS }.
 * `left`: the snapshot's wire bytes still to come; `bytes`: its decoded size; `launchWire`: the launch set's wire
 * bytes (null: unknown — the snapshot); `bootMs`: the start-up time (null: BOOT_MS).
 */
export function chooseSnapshot({ left, bytes = 0, bw, launchWire = null, bootMs = null }) {
  const snapS = left / bw + (bytes / 1048576) * RESTORE_S_PER_MIB;
  if (launchWire === null || !(launchWire >= 0) || !(bw > 0)) return { snapshot: true, snapS, coldS: null };
  // (the larger of the reads' time and the start-up, not their sum: a cold start reads while it starts — BFME 1.08 at
  // 1.25 MB/s reached its menu cold in 82 s, 57 MB of launch set (61 s) and 59 s of start-up, where the sum chose its
  // 93 MB snapshot: 105 s, integration of 2026-11-13; Age of the Ring's 170 MB and 252 s keep its snapshot on any link)
  const coldS = Math.max(launchWire / (bw * COLD_EFF), (bootMs > 0 ? bootMs : BOOT_MS) / 1000);
  return { snapshot: snapS <= coldS, snapS, coldS };
}

/**
 * The shared snapshot of `o.name` for `o.key` and `o.lang`: its bytes (an ArrayBuffer, `.how` on it), or null — none on
 * the server, a cold start chosen, a failure. o: { name, key, lang, dir: () => Promise<FileSystemDirectoryHandle> (the
 * game's snapshot folder, created), log(msg), progress({ bytes, total, bw }) (wire bytes; every second at most),
 * chosen(how) (the choice, once: telemetry), fetch? }. `how`: { chosen ('snapshot' | 'cold'), bw, snapS, coldS,
 * resumed (wire bytes here from an earlier visit), ms }.
 */
export async function fetchSharedSnapshot(o) {
  const t0 = performance.now(), doFetch = o.fetch ?? fetch;
  const url = (i) => `/api/snapshot/${encodeURIComponent(o.name)}?key=${o.key}&lang=${encodeURIComponent(o.lang ?? '')}&piece=${i}`;
  let dir = null; try { dir = await (await o.dir()).getDirectoryHandle('shared', { create: true }); } catch { /* no store: in memory */ }
  const info = await readInfo(dir);
  const mine = !!info && info.key === o.key && info.lang === (o.lang ?? '');
  let have = mine ? await listPieces(dir, info) : new Map(); // piece index -> Blob (its decoded bytes)
  if (dir && !mine) await clearPieces(dir);
  const ctl = new AbortController(), how = { chosen: null, bw: null, snapS: null, coldS: null, resumed: 0, ms: 0 };
  // the first answer: its headers, then the bytes the choice is measured on — `first`: the piece it carries (the first
  // one missing, piece 0 when all seem here: its headers say whether they are still this snapshot's)
  let first = firstMissing(have, info?.count ?? Infinity);
  if (first >= (info?.count ?? Infinity)) first = 0;
  let r;
  try { r = await doFetch(url(first), { signal: ctl.signal }); } catch { return null; }
  const answeredAt = performance.now();
  if (!r.ok) { if (r.status === 416 && dir) await clearPieces(dir); return null; } // (416: an older snapshot's piece index — its pieces go, the next visit starts afresh)
  const id = r.headers.get('X-Snapshot-Id') ?? '', pieceBytes = Number(r.headers.get('X-Piece-Bytes')) || 0, bytes = Number(r.headers.get('X-Snapshot-Bytes')) || 0;
  const wires = (r.headers.get('X-Piece-Wire') ?? '').split(',').map(Number);
  const count = wires.length, size = wires.reduce((a, b) => a + b, 0);
  if (!id || !pieceBytes || !bytes || !(size > 0) || Math.ceil(bytes / pieceBytes) !== count) { ctl.abort(); return null; }
  if (mine && (info.id !== id || info.piece !== pieceBytes || info.count !== count)) { have = new Map(); await clearPieces(dir); } // (another snapshot of the same key: its pieces go)
  // (every piece of this snapshot here: the answer is not needed. Else `r` is piece `first` — after the id check, never
  // an index computed from an older snapshot's pieces: piece 0's bytes were once kept as another piece)
  const done = have.size === count && firstMissing(have, count) === count;
  if (first >= count) { ctl.abort(); return null; }
  const sumOf = (res) => { const v = res.headers.get('X-Piece-Sum'); return v === null ? null : Number(v) >>> 0; };
  if (dir) await writeInfo(dir, { key: o.key, lang: o.lang ?? '', id, piece: pieceBytes, count, bytes });
  const rawOf = (i) => Math.min(pieceBytes, bytes - i * pieceBytes);
  const launchWire = r.headers.has('X-Launch-Wire') ? Number(r.headers.get('X-Launch-Wire')) : null, bootMs = Number(r.headers.get('X-Boot-Ms')) || null;
  for (const i of have.keys()) how.resumed += wires[i];
  if (how.resumed) o.log?.(`shared snapshot: ${(how.resumed / 1048576).toFixed(1)} of ${(size / 1048576).toFixed(1)} MB here from an earlier visit`);
  // the link measured on the first piece alone, the choice made once: at its end (its wire bytes over the time since its
  // answer came: exact), or after 3 × DECIDE_MS from what arrived (its decoded bytes × its Content-Length / its size — a
  // brotli decoder gives its output in blocks: four pieces at once on an 85 KB/s link measured 48-58 KB/s that way);
  // the other pieces asked once it is made
  let got = 0, firstByteAt = null, lastProgress = 0, wireScale = 1, decided;
  const decidedP = new Promise((res) => { decided = res; });
  const left = () => Math.max(0, (size - how.resumed) * wireScale - got);
  const decide = (bw, why) => {
    if (how.chosen) return;
    const c = chooseSnapshot({ left: left(), bytes, bw, launchWire, bootMs });
    Object.assign(how, { chosen: c.snapshot ? 'snapshot' : 'cold', bw: Math.round(bw), snapS: Math.round(c.snapS), coldS: c.coldS === null ? null : Math.round(c.coldS) });
    o.log?.(`shared snapshot: ${c.snapshot ? 'taken' : 'not taken, a cold start instead'} — ${(size / 1048576).toFixed(1)} MB (${(left() / 1048576).toFixed(1)} to come) at ${(bw / 1024).toFixed(0)} KB/s (${why}): ~${how.snapS} s${c.coldS === null ? '' : ` against ~${how.coldS} s cold (launch set ${(launchWire / 1048576).toFixed(1)} MB, start-up ${((bootMs ?? BOOT_MS) / 1000).toFixed(0)} s)`}`);
    o.chosen?.({ ...how, size, launchWire, bootMs });
    if (!c.snapshot) ctl.abort();
    decided();
  };
  const arrived = (n) => {
    const now = performance.now();
    firstByteAt ??= now; got += n;
    const el = now - firstByteAt;
    if (!how.chosen && el >= 3 * DECIDE_MS && got >= DECIDE_BYTES) decide(got / (el / 1000), 'measured');
    if (now - lastProgress >= 1000) { lastProgress = now; o.progress?.({ bytes: how.resumed + got, total: size, bw: el > 0 ? got / (el / 1000) : null }); }
  };
  if (done) { decide(1e9, 'all here'); how.bw = null; } // (no rate measured: none given to the reader nor the telemetry)
  const writes = [];
  // (a piece that fails stops the others from asking more; those on their way are finished and kept)
  let failed = null, storeOff = !dir;
  /** Piece `i` from answer `res`, written to the store. */
  const take = async (i, res) => {
    const raw = rawOf(i), wire = Number(res.headers.get('Content-Length')) || wires[i], buf = new Uint8Array(raw);
    if (i === first) wireScale = wire / wires[i]; // (another encoding than the stored one — gzip for a browser without brotli: its bytes)
    let at = 0, counted = 0;
    const rd = res.body.getReader();
    for (;;) {
      const { done: end, value } = await rd.read();
      if (end) break;
      if (at + value.length > raw) throw new Error('snapshot piece longer than its size');
      buf.set(value, at); at += value.length;
      const w = Math.round(at / raw * wire); arrived(w - counted); counted = w;
    }
    if (at !== raw) throw new Error(`snapshot piece ${i}: ${at} of ${raw} bytes`);
    const sum = sumOf(res);
    if (sum !== null && crc32(buf) !== sum) throw new Error(`snapshot piece ${i}: its bytes do not match its sum`);
    if (i === first && !how.chosen) decide(wire / Math.max(0.05, (performance.now() - answeredAt) / 1000), 'its first piece');
    // (written while the next piece comes: the link is not left idle for the store's write. A write that fails — the
    // quota — keeps this piece and the next ones in memory: the download is not lost, only its resume)
    const inMemory = () => { have.set(i, new Blob([buf])); };
    writes.push(storeOff ? Promise.resolve(inMemory()) : writePiece(dir, i, buf).then((f) => { have.set(i, f); }, (e) => {
      if (!storeOff) { storeOff = true; o.log?.(`shared snapshot: the store refused a piece (${e?.message ?? e}): the rest kept in memory`); }
      inMemory();
    }));
  };
  try {
    const queue = []; for (let i = 0; i < count; i++) if (!have.has(i) && i !== first) queue.push(i);
    const runOne = async () => {
      for (let i; !failed && (i = queue.shift()) !== undefined;) {
        if (ctl.signal.aborted) return;
        try {
          const res = await doFetch(url(i), { signal: ctl.signal });
          if (!res.ok || res.headers.get('X-Snapshot-Id') !== id) throw new Error(`piece ${i}: HTTP ${res.status}`);
          await take(i, res);
        } catch (e) { failed ??= e; }
      }
    };
    const firstDone = (done ? (r.body?.cancel().catch(() => {}), Promise.resolve()) : take(first, r)).catch((e) => { failed ??= e; });
    if (done) decided();
    await Promise.all([firstDone.then(decided), ...Array.from({ length: IN_FLIGHT - 1 }, () => decidedP.then(runOne)), firstDone.then(runOne)]);
    await Promise.all(writes);
    if (failed) throw failed;
  } catch (e) {
    await Promise.allSettled(writes); // (the pieces that came kept for the next visit)
    if (how.chosen === 'cold') return null;
    o.log?.(`shared snapshot: download stopped (${e.message ?? e}): ${((how.resumed + got) / 1048576).toFixed(1)} MB kept for the next visit`);
    return null;
  }
  if (!how.chosen) decide(got / Math.max(0.001, (performance.now() - (firstByteAt ?? t0)) / 1000), 'whole before measured');
  if (how.chosen !== 'snapshot') return null;
  o.progress?.({ bytes: size, total: size, bw: how.bw });
  // put together from the pieces in order (a Blob of the stored files: read once, into the snapshot's buffer)
  const tJoin = performance.now();
  try {
    const parts = []; for (let i = 0; i < count; i++) parts.push(have.get(i));
    const ab = await new Blob(parts).arrayBuffer();
    if (ab.byteLength !== bytes || new DataView(ab).getUint32(0) !== 0x4f534e50) throw new Error('not a snapshot');
    how.ms = Math.round(performance.now() - t0);
    o.log?.(`shared snapshot: here in ${(how.ms / 1000).toFixed(1)} s (put together in ${Math.round(performance.now() - tJoin)} ms)`);
    ab.how = how;
    return ab;
  } catch (e) {
    o.log?.(`shared snapshot: not put together (${e.message ?? e}): its pieces dropped`);
    if (dir) await clearPieces(dir);
    return null;
  }
}

/** The pieces of a shared snapshot downloaded into game `name`'s folder removed (it started: the player's own now). */
export async function dropPieces(dirOf) { try { await (await dirOf()).removeEntry('shared', { recursive: true }); } catch { /* none */ } }

const firstMissing = (have, count) => { let i = 0; while (i < count && have.has(i)) i++; return i; };
async function readInfo(dir) { try { return JSON.parse(await (await (await dir.getFileHandle('info.json')).getFile()).text()); } catch { return null; } }
async function writeInfo(dir, rec) { const w = await (await dir.getFileHandle('info.json', { create: true })).createWritable(); await w.write(JSON.stringify(rec)); await w.close(); }
async function writePiece(dir, i, buf) {
  const h = await dir.getFileHandle(String(i), { create: true }), w = await h.createWritable();
  await w.write(buf); await w.close();
  return h.getFile();
}
/** The whole pieces there (index -> File) of the snapshot `info` says. */
async function listPieces(dir, info) {
  const have = new Map();
  for await (const [n, h] of dir.entries()) {
    if (!/^\d+$/.test(n) || h.kind !== 'file') continue;
    const i = Number(n), f = await h.getFile();
    if (i < info.count && f.size === Math.min(info.piece, info.bytes - i * info.piece)) have.set(i, f);
  }
  return have;
}
async function clearPieces(dir) { const names = []; for await (const n of dir.keys()) names.push(n); for (const n of names) await dir.removeEntry(n).catch(() => {}); }
