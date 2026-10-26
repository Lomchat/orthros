// Where an OpenMW saved game loads (docs/openmw.md "Anticipated places"), read from the save itself without the engine:
// the page predicts the place the player will load from the menu and fetches that place's files (the server's learned
// place sets, GET /api/places) while the engine boots and the player sits in the menu. The place's key is the engine's
// own (orthros-r10.patch: its announced reads' labels '<kind>:<place>'): 'x,y' for an exterior cell — the grid centre
// the engine announces for, the player's cell —, the interior's id lowercased as the engine lowercases it (ASCII only,
// Misc::StringUtils::lowerCase).
//
// The save (.omwsave, components/esm3): records of a 16-byte header (name, u32 size, u32, u32 flags), each a run of
// subrecords (name, u32 size); strings UTF-8 without a terminator, their length the subrecord's. The TES3 header first
// (FORM: the format version, 0 when absent), then SAVE (savedgame.cpp: PLNA player, PLLE level, PLCE the cell's display
// name — localized, a region's name for an unnamed exterior: no key —, TIME played, DESC, DEPE content files…), then the
// world's records; PLAY (player.cpp) holds the player's cell just before LKEP: format > 26 a NAME RefId (u8 tag: 6 an
// exterior cell, int32 x, int32 y; 2 a string to the subrecord's end; 1 a u32 length and the string), up to 26 the old
// CellId (SPAC the worldspace or the interior's name, CIDX int32 x, y for an exterior).
// No state here: the page (streamfs.js) holds what it found; the hint is the browser's storage, read each time.

/** Where the engine page keeps its saves (IDBFS, one folder per character): the engine's user data folder (r8, seen), its XDG data home's. */
export const SAVES_DIRS = ['/userdata/saves', '/userdata/data-home/openmw/saves'];
/** The last format whose PLAY cell is the old CellId (SPAC, CIDX) — components/esm3/formatversion.hpp MaxUseEsmCellIdFormatVersion. */
const MAX_CELLID_FORMAT = 26;
/** A save's records are walked up to this many (PLAY comes after the journal, dialogue and scripts' records: a few thousand). */
const MAX_RECORDS = 200000;
/** A save this much newer than the hint is newer (the hint of a save written: its own date; clocks of one page). */
const HINT_SLACK_MS = 2000;
/** The SAVE record's subrecords not read (the screenshot: tens of KB a save). */
const SAVE_SKIP = new Set(['SCRN']);

const text = (bytes) => new TextDecoder().decode(bytes);
/** ASCII-only lower case, as the engine's (an interior id's accented letters stay as they are). */
export const engineLower = (s) => String(s).replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * The place a RefId of a save's PLAY record names (`b`: its bytes): 'x,y' (an exterior cell of ESM3), the lowercased
 * interior id, or null (another kind of id: no place of ours).
 */
function refIdPlace(b) {
  if (!b.length) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === 6 && b.length >= 9) return `${v.getInt32(1, true)},${v.getInt32(5, true)}`;
  if (b[0] === 2) return engineLower(text(b.subarray(1))) || null;
  if (b[0] === 1 && b.length >= 5) return engineLower(text(b.subarray(5, 5 + v.getUint32(1, true)))) || null;
  return null;
}

/**
 * A save's header and place: { format, player, level, cellName, timePlayed, desc, contentFiles, place } (place null:
 * no PLAY record, or a cell of another kind), or null when it is no OpenMW save (not TES3 then SAVE, cut short). `src`:
 * the save's bytes, or a reader { size, read(at, n) → Uint8Array of up to n bytes at `at` } — only the records' headers
 * and the TES3, SAVE and PLAY records' bodies are read (not the screenshot nor the world's records before PLAY).
 * @param {Uint8Array | { size: number, read: (at: number, n: number) => Uint8Array }} src
 */
export function parseSave(src) {
  const r = src instanceof Uint8Array ? { size: src.length, read: (at, k) => src.subarray(at, at + k) } : src;
  if (!r || !(r.size >= 32) || typeof r.read !== 'function') return null;
  const n = r.size;
  const name = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
  /** the record at `at`: { name, size } of its 16-byte header, or null past the end */
  const head = (at) => {
    if (at + 16 > n) return null;
    const b = r.read(at, 16);
    return b.length < 16 ? null : { name: name(b, 0), size: new DataView(b.buffer, b.byteOffset, 16).getUint32(4, true) };
  };
  /**
   * the subrecords of the record at `at` (`h` its header): [name, data] in order — those named in `skip` passed over by
   * their headers, their bodies not read (the SAVE record's screenshot)
   */
  const subs = function* (at, h, skip = null) {
    const end = Math.min(n, at + 16 + h.size);
    if (!skip) {
      const bytes = r.read(at + 16, end - at - 16), m = bytes.length, v = new DataView(bytes.buffer, bytes.byteOffset, m);
      for (let p = 0; p + 8 <= m;) {
        const size = v.getUint32(p + 4, true);
        if (p + 8 + size > m) return;
        yield [name(bytes, p), bytes.subarray(p + 8, p + 8 + size)];
        p += 8 + size;
      }
      return;
    }
    for (let p = at + 16; p + 8 <= end;) {
      const sh = r.read(p, 8);
      if (sh.length < 8) return;
      const s = name(sh, 0), size = new DataView(sh.buffer, sh.byteOffset, 8).getUint32(4, true);
      if (p + 8 + size > end) return;
      yield [s, skip.has(s) ? new Uint8Array(0) : r.read(p + 8, size)];
      p += 8 + size;
    }
  };
  let h = head(0);
  if (h?.name !== 'TES3') return null;
  const info = { format: 0, player: '', level: 0, cellName: '', timePlayed: 0, desc: '', contentFiles: [], place: null };
  for (const [s, d] of subs(0, h)) if (s === 'FORM' && d.length >= 4) info.format = new DataView(d.buffer, d.byteOffset, 4).getUint32(0, true);
  let at = 16 + h.size;
  h = head(at);
  if (h?.name !== 'SAVE') return null;
  for (const [s, d] of subs(at, h, SAVE_SKIP)) {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (s === 'PLNA') info.player = text(d);
    else if (s === 'PLLE' && d.length >= 4) info.level = dv.getInt32(0, true);
    else if (s === 'PLCE') info.cellName = text(d);
    else if (s === 'TIME' && d.length >= 8) info.timePlayed = dv.getFloat64(0, true);
    else if (s === 'DESC') info.desc = text(d);
    else if (s === 'DEPE') info.contentFiles.push(text(d));
  }
  // (the world's records skipped by their sizes up to PLAY; its cell: the NAME — the old SPAC/CIDX — just before LKEP,
  // the object state's own NAME subrecords (the player's reference id) before it)
  for (let k = 0; k < MAX_RECORDS; k++) {
    at += 16 + h.size;
    h = head(at);
    if (!h) break;
    if (h.name !== 'PLAY') continue;
    let last = null, spac = null, cidx = null;
    for (const [s, d] of subs(at, h)) {
      if (s === 'NAME') last = d;
      else if (s === 'SPAC') { spac = d; cidx = null; } else if (s === 'CIDX' && d.length >= 8) cidx = d;
      else if (s === 'LKEP') {
        if (info.format > MAX_CELLID_FORMAT) info.place = last ? refIdPlace(last) : null;
        else if (cidx) { const dv = new DataView(cidx.buffer, cidx.byteOffset, 8); info.place = `${dv.getInt32(0, true)},${dv.getInt32(4, true)}`; }
        else info.place = spac ? engineLower(text(spac)) || null : null;
        break;
      }
    }
    break;
  }
  return info;
}

/**
 * A reader of the file at `path` of Emscripten's FS `fs` (parseSave's: its bytes read where asked, FS.read — not the
 * whole save copied, FS.readFile —), and its close; an FS without open/read: its readFile's bytes.
 */
function fileReader(fs, path, size) {
  if (typeof fs.open !== 'function' || typeof fs.read !== 'function') { const b = fs.readFile(path); return { size: b.length, read: (at, k) => b.subarray(at, at + k), close() {} }; }
  const stream = fs.open(path, 'r');
  return {
    size,
    read(at, k) { const b = new Uint8Array(Math.max(0, Math.min(k, size - at))); const got = fs.read(stream, b, 0, b.length, at); return got < b.length ? b.subarray(0, got) : b; },
    close() { try { fs.close(stream); } catch { /* closed */ } },
  };
}

/**
 * The saves the engine page holds (`fs`: Emscripten's FS), each parsed: [{ path, character, mtime (ms), info }] —
 * those that are no save (parseSave null) left out. `dirs`: the saves folders (SAVES_DIRS), each one folder per
 * character; `since`: only those written after it (ms; the others not read).
 */
export function listSaves(fs, dirs = SAVES_DIRS, since = -Infinity) {
  const out = [];
  const ls = (d) => { try { return fs.readdir(d).filter((x) => x !== '.' && x !== '..'); } catch { return []; } };
  for (const dir of dirs) {
    for (const character of ls(dir)) {
      for (const file of ls(`${dir}/${character}`)) {
        if (!/\.omwsave$/i.test(file)) continue;
        const path = `${dir}/${character}/${file}`;
        try {
          const st = fs.stat(path), t = st.mtime?.getTime?.() ?? Number(st.mtime), mtime = Number.isFinite(t) ? t : 0;
          if (!(mtime > since)) continue;
          const r = fileReader(fs, path, Number(st.size) || 0);
          let info = null;
          try { info = parseSave(r); } finally { r.close(); }
          if (info) out.push({ path, character, mtime, info });
        } catch { /* unreadable: left out */ }
      }
    }
  }
  return out;
}

/**
 * The save the player will most likely load, and its place: { save, place, why } — why 'hint': the place the page
 * remembered (where the last game the page loaded from the menu started, or of the last save written: placeHint) is a
 * save's, and no save is newer than the hint (by HINT_SLACK_MS; a save written since — in another tab, on another device
 * — says more); 'newest': the newest save by date — not when the profile was just restored from the account without
 * its dates (`restored`: their dates the restore's) —; 'time': the most time played. Null without a save that names a place.
 * @param {{ path: string, mtime: number, info: { place: string|null, timePlayed: number } }[]} saves
 * @param {{ hint?: { place: string, at: number }|string|null, restored?: boolean }} o
 */
export function chooseSave(saves, { hint = null, restored = false } = {}) {
  const ok = saves.filter((s) => s.info?.place);
  if (!ok.length) return null;
  const best = (list, score) => list.reduce((a, b) => (score(b) > score(a) ? b : a));
  const newest = (x) => x.mtime + x.info.timePlayed * 1e-9;
  const h = typeof hint === 'string' ? { place: hint, at: 0 } : hint;
  if (h?.place) {
    const there = ok.filter((x) => x.info.place === h.place);
    if (there.length && (restored || !ok.some((x) => x.mtime > (Number(h.at) || 0) + HINT_SLACK_MS))) return { save: best(there, newest), place: h.place, why: 'hint' };
  }
  const s = restored ? best(ok, (x) => x.info.timePlayed) : best(ok, newest);
  return { save: s, place: s.info.place, why: restored ? 'time' : 'newest' };
}
/** The place an announced batch's label names ('<kind>:<place>', orthros-r10.patch): { kind, place }, or null. */
export function labelPlace(label) {
  const m = /^(meshes|textures|terrain):(.+)$/s.exec(String(label ?? ''));
  return m ? { kind: m[1], place: m[2] } : null;
}

/**
 * The place the player last started from the menu or saved at, per installation (localStorage
 * 'orthros.place.<manifest>': { place, at (ms, the page's clock: the save's date, or the load's) } as JSON — a bare place
 * of an earlier page: at 0): set by the page at the first load of a session the engine announces and at each save it
 * writes (streamfs.js). `storage`: the page's (null: none).
 */
// snapshot: no state — the browser's storage, read each time
export const placeHint = {
  /** @returns {{ place: string, at: number } | null} */
  get(manifest, storage = globalThis.localStorage) {
    let v = null;
    try { v = storage?.getItem(`orthros.place.${manifest}`) || null; } catch { return null; }
    if (!v) return null;
    try { const o = JSON.parse(v); if (o && typeof o.place === 'string' && o.place) return { place: o.place, at: Number(o.at) || 0 }; } catch { /* a bare place */ }
    return { place: v, at: 0 };
  },
  set(manifest, place, storage = globalThis.localStorage, at = Date.now()) {
    if (place) try { storage?.setItem(`orthros.place.${manifest}`, JSON.stringify({ place: String(place).slice(0, 128), at: Number(at) || 0 })); } catch { /* storage off */ }
  },
};
