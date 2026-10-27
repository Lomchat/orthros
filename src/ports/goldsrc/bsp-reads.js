// A GoldSrc map's load, announced (docs/browser-ports.md "Map loads announced"): the engine (a pinned third-party binary,
// unchanged) reads its files synchronously, one at a time — each piece it lacks a round trip of the page's thread. Its
// map's file says much of what the load reads next: once the engine has read a maps/<map>.bsp (BSP v30) up to its entity
// and texture lumps, the page parses them and announces (GameData.want, `wait: false`: the engine waits through its own
// reads) what the load certainly reads, fetched in parallel by the data worker, the engine's reads joining them:
// - the textures the texture lump names, each the lump of the WAD the engine finds it in — the worldspawn's `wad` list,
//   searched from its end, as the engine does —, read from the WAD directories the page parsed when the engine read them
//   (it mounts the archives at its start; src/vfs/wad3.js). A texture whose pixels the map holds is read from the map
//   unless the engine's `r_wadtextures` is set (Mod_LoadTextureData: the WAD's copy first then — default 0; a game's
//   config sets it, Half-Life's does): announced from a WAD only then (`wadTextures`);
// - the worldspawn's sky (`skyname`: gfx/env/<name><side> — six pictures);
// - the entities' own files: a `model` key's .mdl / .spr, an ambient_generic's sound (`message`, under sound/);
// - the files beside the map that its load reads: its node graph (maps/graphs/<map>.nod — read by the map's server
//   only: when the page certainly runs it, `server`), its overview (overviews/<map>.txt and its picture);
// - the entries of maps/<map>.res when there is one (a map's own list of its files — those of the kinds above), a second
//   list once its text is here (the engine never reads it: fetched announced, not learned, the page's thread not held).
// Only files the game has (the engine's search order: the game's folder first, then the others it mounts); nothing the
// page holds already. Engine conventions only (GoldSrc's formats and folders): no game's own names.

import { wadEntries, wadHeader, WAD_ENTRY, WAD_MIPTEX } from '../../vfs/wad3.js';

/** BSP version of GoldSrc's maps. */
export const BSP_VERSION = 30;
/** Lumps of a v30 BSP; its header's bytes (version, then offset and length of each). */
export const BSP_LUMPS = 15, BSP_HEADER = 4 + BSP_LUMPS * 8;
/** The sky's six pictures: gfx/env/<skyname><side>. */
export const SKY_SIDES = ['rt', 'bk', 'lf', 'ft', 'up', 'dn'];
/** A list label's map name at most this long (GameData.want keeps 80 characters). */
const LABEL_MAP = 60;

/**
 * A v30 BSP's lumps from its header (`head`, its first BSP_HEADER bytes at least) in a file of `size` bytes:
 * [{ off, len }] × BSP_LUMPS, or null (not a v30 BSP, or a lump past the file's end).
 * @param {Uint8Array} head
 * @param {number} size
 */
export function bspLumps(head, size) {
  if (head.length < BSP_HEADER) return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (v.getInt32(0, true) !== BSP_VERSION) return null;
  const lumps = [];
  for (let i = 0; i < BSP_LUMPS; i++) {
    const off = v.getInt32(4 + i * 8, true), len = v.getInt32(8 + i * 8, true);
    if (off < 0 || len < 0 || off + len > size) return null;
    lumps.push({ off, len });
  }
  return lumps;
}

/**
 * Bytes that read as an entity lump: text starting with '{' (after blanks) — the engine tells it this way from the planes'
 * lump of the maps that swap the two first lumps.
 * @param {Uint8Array | null} b
 */
export function looksLikeEntities(b) {
  if (!b) return false;
  for (let i = 0; i < b.length; i++) { const c = b[i]; if (c === 0x7b) return true; if (c > 0x20) return false; }
  return false;
}

/**
 * The entities of an entity lump's text: [{ key: value }] — keys lower case, values as written. Tolerant as the engine's
 * parser: quoted or bare tokens, `//` comments, a truncated last entity dropped.
 * @param {string} text
 */
export function parseEntities(text) {
  const out = [];
  let i = 0, cur = null, key = null;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c <= ' ') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '{') { cur = {}; key = null; i++; continue; }
    if (c === '}') { if (cur) out.push(cur); cur = null; i++; continue; }
    let tok;
    if (c === '"') { const e = text.indexOf('"', i + 1); if (e < 0) break; tok = text.slice(i + 1, e); i = e + 1; }
    else { const s = i; while (i < n && text[i] > ' ' && text[i] !== '"' && text[i] !== '{' && text[i] !== '}') i++; tok = text.slice(s, i); }
    if (!cur) continue;
    if (key === null) key = tok.toLowerCase(); else { cur[key] = tok; key = null; }
  }
  return out;
}

/**
 * The textures a texture lump names (`b`: the lump's bytes): [{ name (lower case), external }] — external: its pixels are
 * not in the map (the miptex's first offset 0), the engine reads them from a WAD. Each name once, in the lump's order.
 * @param {Uint8Array} b
 */
export function bspTextures(b) {
  if (b.length < 4) return [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = v.getInt32(0, true), out = [], seen = new Set();
  if (!(n > 0) || 4 + n * 4 > b.length) return out;
  for (let i = 0; i < n; i++) {
    const at = v.getInt32(4 + i * 4, true);
    if (at < 0 || at + 40 > b.length) continue; // (-1: a texture left out of the map)
    let name = '';
    for (let k = at; k < at + 16 && b[k]; k++) name += String.fromCharCode(b[k]);
    name = name.toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, external: v.getUint32(at + 24, true) === 0 });
  }
  return out;
}

/**
 * The value the last statement of a console script (`text`: a .cfg / .rc file, a command line) gives the console variable
 * `cvar` — `cvar value` or `cvar "value"`, statements split by lines and `;` outside quotes, `//` comments skipped —, or
 * null when none does. The engine's own settings as it reads them: a page that cannot query its variables.
 * @param {string} text
 * @param {string} cvar
 */
export function configSetting(text, cvar) {
  let value = null;
  const want = cvar.toLowerCase();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    let stmt = '', quoted = false;
    const statements = [];
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') quoted = !quoted;
      if (!quoted && c === '/' && line[i + 1] === '/') break;
      if (!quoted && c === ';') { statements.push(stmt); stmt = ''; continue; }
      stmt += c;
    }
    statements.push(stmt);
    for (const st of statements) {
      const m = /^\s*"?([^\s"]+)"?\s+(?:"([^"]*)"?|(\S+))/.exec(st);
      if (m && m[1].toLowerCase() === want) value = m[2] ?? m[3];
    }
  }
  return value;
}

/** A path as the engine writes it in a map: back slashes, a leading slash, blanks — its relative form, or ''. */
const relPath = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
/** A `wad` key's archive (a full path of the mapper's disk): its base name without extension, lower case. */
const wadName = (p) => relPath(p).split('/').pop().replace(/\.wad$/i, '').toLowerCase();

/** The adder of a list of reads: [{ h, off?, len? }], each once (a whole file, or an archive's lump). */
function readList() {
  const entries = [], seen = new Set();
  const add = (h, off, len) => {
    if (!h) return;
    const k = `${h.name}\n${h.path}\n${off ?? 0}\n${len ?? -1}`;
    if (seen.has(k)) return;
    seen.add(k); entries.push(off === undefined ? { h } : { h, off, len });
  };
  return { entries, add };
}

/**
 * The files a maps/<map>.res lists (`res` its text) that the game has (`find`, as for mapReads), of the kinds a map's load
 * reads — a WAD's lumps are its textures', the map is read already: [{ h }], each once.
 * @param {string} res
 * @param {(rel: string) => object | null} find
 */
export function resReads(res, find) {
  const { entries, add } = readList();
  for (const line of String(res ?? '').split(/\r?\n/)) {
    const r = relPath(line.replace(/\/\/.*$/, ''));
    if (!r || /\.(wad|bsp)$/i.test(r) || !/\.(mdl|spr|wav|tga|bmp|txt|nod)$/i.test(r)) continue;
    add(find(r));
  }
  return entries;
}

/**
 * What a map's load certainly reads, from its parsed lumps: [{ h, off?, len? }] (a whole file, or an archive's lump),
 * each once. `find(rel)`: the game file the engine finds at a path relative to its folders (a handle), or null;
 * `wad(name)`: the WAD the engine finds by that base name — { h, dir: Map(texture name → { pos, disk }) } its miptex
 * entries —, or null (not in the game, or its directory not known); `res`: maps/<map>.res's text, or null;
 * `wadTextures`: the engine's r_wadtextures is set — a texture the map holds is read from a WAD that has it (else from the
 * map: only the external ones announced); `server`: the page runs the map's server (its node graph read).
 * @param {{ map: string, entities: object[], textures: { name: string, external: boolean }[],
 *   find: (rel: string) => object | null, wad: (name: string) => { h: object, dir: Map<string, { pos: number, disk: number }> } | null,
 *   res?: string | null, wadTextures?: boolean, server?: boolean }} o
 * @returns {{ entries: { h: object, off?: number, len?: number }[], textures: number, missing: number }}
 *   textures: the textures announced from a WAD; missing: the external ones not found (a WAD whose directory is not
 *   known, or not in the game — an embedded one is read from the map then)
 */
export function mapReads({ map, entities, textures, find, wad, res = null, wadTextures = false, server = false }) {
  const { entries, add } = readList();
  const file = (rel) => { const r = relPath(rel); if (r) add(find(r)); };
  const world = entities.find((e) => (e.classname ?? '').toLowerCase() === 'worldspawn') ?? entities[0] ?? {};
  // (the WADs the map names that the game has, in their order; a texture from the last one that has it)
  const wads = [], names = new Set();
  for (const p of String(world.wad ?? '').split(';')) {
    const name = wadName(p); if (!name || names.has(name)) continue;
    names.add(name);
    const w = wad(name); if (w) wads.push(w);
  }
  let found = 0, missing = 0;
  for (const t of textures) {
    if (!t.external && !wadTextures) continue;
    let hit = null;
    for (let j = wads.length - 1; j >= 0 && !hit; j--) { const e = wads[j].dir.get(t.name); if (e) hit = { h: wads[j].h, e }; }
    if (hit) { add(hit.h, hit.e.pos, hit.e.disk); found++; } else if (t.external) missing++;
  }
  // (the sky: a picture a side, TGA or else BMP)
  const sky = relPath(world.skyname);
  if (sky && !sky.includes('/')) for (const side of SKY_SIDES) { const base = `gfx/env/${sky}${side}`; add(find(base + '.tga') ?? find(base + '.bmp')); }
  // (the entities' models and sprites — a brush model, '*n', is the map's own —, and the ambient sounds)
  for (const e of entities) {
    if (/\.(mdl|spr)$/i.test(e.model ?? '')) file(e.model);
    const cls = (e.classname ?? '').toLowerCase(), snd = relPath(e.message);
    if (cls === 'ambient_generic' && /\.wav$/i.test(snd) && !snd.startsWith('!')) file(/^sound\//i.test(snd) ? snd : `sound/${snd}`);
  }
  // (beside the map: its node graph, its overview and the picture it names, else its own name's)
  const m = relPath(map).toLowerCase();
  if (server) file(`maps/graphs/${m}.nod`);
  const ov = find(`overviews/${m}.txt`);
  if (ov) { add(ov); add(find(`overviews/${m}.bmp`) ?? find(`overviews/${m}.tga`)); }
  // (the map's own list: its files of those kinds)
  if (res) for (const e of resReads(res, find)) add(e.h);
  return { entries, textures: found, missing };
}

/**
 * The map loads of the engine's file system announced: each maps/<map>.bsp node among `nodes` (as phaseOnRead: an open
 * that has read half the file at least is a load, not a listing that reads its header and entities — which announces
 * nothing) parsed once its header, entity and texture lumps are in the page (GameData.peek — after the read that brought
 * them), and what that load reads announced (mapReads → GameData.want, label 'textures:<map>', wait false). The WADs'
 * directories are parsed as the engine reads them (each .wad node's reads: at its mount, while those pieces are certainly
 * in the page — the page's pieces are a cache a long session evicts). maps/<map>.res, when the game has one and the page
 * has not its text, is announced with the load (label 'res:<map>') and fetched in the background (GameData.ensure: the
 * announced request joined — not learned as a read, nor reported as used: peek), its entries announced as a second list
 * once it is here. Returns how many map files are watched.
 * @param {object} FS the engine's FS
 * @param {Iterable<object>} nodes the game's file nodes (mountFiles)
 * @param {import('../../vfs/data-client.js').GameData} data
 * @param {{ name: string, files: { path: string, at?: string }[], root: string, gameDir: string, log?: (text: string) => void,
 *   wadTextures?: () => boolean, server?: () => boolean, announced?: (map: string) => void }} o
 *   files: the game's files as the engine sees them (languageFiles: `at` where a language's file goes); root: where they
 *   are mounted; gameDir: the game's folder (searched first); wadTextures: the engine's r_wadtextures is set now (default
 *   false: the external textures only); server: the page certainly runs the map's server now (default false); announced:
 *   told after each load's announce (outside the engine's read: a task of its own)
 */
export function announceMapLoads(FS, nodes, data, o) {
  const log = o.log ?? (() => {}), root = o.root.replace(/\/+$/, '') + '/', gameDir = String(o.gameDir ?? '').toLowerCase();
  // (the engine's view: lower-case path → the version's path; its folders, the game's first)
  const byAt = new Map(), dirs = [];
  for (const f of o.files) {
    const at = (f.at ?? f.path).toLowerCase(); byAt.set(at, f.path);
    const top = at.split('/')[0]; if (at.includes('/') && !dirs.includes(top)) dirs.push(top);
  }
  dirs.sort((a, b) => (b === gameDir) - (a === gameDir));
  const handle = (at) => { const p = byAt.get(at); return p === undefined ? null : data.file(o.name, p); };
  const find = (rel) => { const r = rel.toLowerCase(); for (const d of dirs) { const h = handle(`${d}/${r}`); if (h) return h; } return null; };
  // (each WAD's miptex directory — by its path —, parsed from the page's pieces once they hold it)
  const dirs3 = new Map();
  const wadDir = (h) => {
    let d = dirs3.get(h.path);
    if (d) return d;
    const head = data.peek(h, 0, 12), hd = head && wadHeader(head, h.size);
    const bytes = hd && data.peek(h, hd.dir, hd.n * WAD_ENTRY);
    if (!bytes) return null;
    d = new Map();
    for (const e of wadEntries(bytes, hd.n, h.size)) if (e.type === WAD_MIPTEX && !d.has(e.name)) d.set(e.name, { pos: e.pos, disk: e.disk });
    dirs3.set(h.path, d);
    return d;
  };
  const wad = (name) => { const h = find(`${name}.wad`), d = h && wadDir(h); return d ? { h, dir: d } : null; };
  const text = (b) => new TextDecoder('latin1').decode(b);
  /** maps/<map>.res's entries announced once its text is fetched (in the background: nothing waits for it). */
  const announceRes = (map, resH) => {
    const label = `res:${map.slice(0, LABEL_MAP)}`;
    data.want([{ h: resH }], { label, wait: false });
    data.ensure(resH, 0, resH.size, true).then(() => {
      const b = data.peek(resH, 0, resH.size); if (!b) return;
      const list = resReads(text(b), find), n = list.length ? data.want(list, { label, wait: false }) : 0;
      log(`Map ${map}: ${n} of ${list.length} reads of its .res announced`);
    }, (e) => log(`Map ${map}: ${resH.path} not read (${e?.message ?? e})`));
  };
  /** The load of map `map` (`h` its .bsp): announced when its lumps are in the page — true once done or impossible. */
  const announce = (map, h) => {
    const head = data.peek(h, 0, BSP_HEADER); if (!head) return false;
    const lumps = bspLumps(head, h.size); if (!lumps) return true;
    const l0 = data.peek(h, lumps[0].off, lumps[0].len), l1 = data.peek(h, lumps[1].off, lumps[1].len), tex = data.peek(h, lumps[2].off, lumps[2].len);
    const ents = looksLikeEntities(l0) ? l0 : looksLikeEntities(l1) ? l1 : null;
    if (!ents || !tex) return false;
    const resH = find(`maps/${map}.res`), resB = resH && data.peek(resH, 0, resH.size);
    // (its .res first, small: its entries' list sooner)
    if (resH && !resB) announceRes(map, resH);
    const wadTextures = !!o.wadTextures?.(), server = !!o.server?.();
    const r = mapReads({ map, entities: parseEntities(text(ents)), textures: bspTextures(tex), find, wad, res: resB ? text(resB) : null, wadTextures, server });
    const n = r.entries.length ? data.want(r.entries, { label: `textures:${map.slice(0, LABEL_MAP)}`, wait: false }) : 0;
    log(`Map ${map}: ${n} of ${r.entries.length} reads announced (${r.textures} textures from WADs${r.missing ? `, ${r.missing} not found` : ''}${wadTextures ? ', r_wadtextures' : ''}${server ? ', its server' : ''})`);
    if (o.announced) setTimeout(() => o.announced(map), 0);
    return true;
  };
  let watched = 0;
  for (const node of nodes) {
    const path = FS.getPath(node); if (!path.startsWith(root)) continue;
    const at = path.slice(root.length).toLowerCase();
    // (a WAD: its directory parsed after the engine's reads of it, until it is)
    if (at.endsWith('.wad')) {
      const h = handle(at); if (!h) continue;
      const ops = node.stream_ops, read = ops.read;
      node.stream_ops = { ...ops, read(stream, buffer, offset, length, position) {
        const n = read(stream, buffer, offset, length, position);
        if (!dirs3.has(h.path)) { try { wadDir(h); } catch { /* not a WAD3: the engine says so */ } }
        return n;
      } };
      continue;
    }
    const map = /\/maps\/([^/]+)\.bsp$/i.exec(path)?.[1].toLowerCase(); if (!map) continue;
    const h = handle(at); if (!h) continue;
    const ops = node.stream_ops, read = ops.read, size = node.usedBytes;
    node.stream_ops = { ...ops, read(stream, buffer, offset, length, position) {
      const n = read(stream, buffer, offset, length, position);
      stream.orthrosMapRead = (stream.orthrosMapRead ?? 0) + Math.max(0, n);
      if (!stream.orthrosAnnounced && stream.orthrosMapRead * 2 >= size) {
        try { stream.orthrosAnnounced = announce(map, h); } catch (e) { stream.orthrosAnnounced = true; log(`Map ${map}: not announced (${e?.message ?? e})`); }
      }
      return n;
    } };
    watched++;
  }
  return watched;
}
