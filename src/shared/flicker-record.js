// The flicker capture's record (src/gfx/flicker-capture.js makes it in the page's GL thread, the server keeps it in the
// telemetry, tools/dev/flicker-capture.mjs reads it): its size limit, the cuts that keep it under the limit, the
// comparison of two of its frames' GL work, and the server's check.
//
// A record: { event: 'flicker-capture', v, trigger, gl, size, img, q, images: [base64 JPEG x frames], small, frames:
// [{ ms, info, calls, draws, passes: [{ fb, n, ev }], ups, att, errs }], objs, states, draws, drawFields, diff, alt, cut, notes }.
// A pass is the work drawn into one framebuffer between two bindings of another: `fb` its object id ('F0': the canvas),
// `ev` its events in order — a draw as a number (an index into `draws`, the record's distinct draws: DRAW_FIELDS), the
// others as arrays (['clear', ...], ['blit', ...], ['err', code], ...). A pass the cuts emptied keeps `n`, its event count.
export const FLICKER_RECORD_VERSION = 1;
/** the record's size at most (JSON characters, ASCII): the page cuts it to this */
export const CAPTURE_MAX_BYTES = 400 * 1024;
/** what the server takes for one capture POST (the record and the page's own fields) */
export const CAPTURE_POST_MAX_BYTES = CAPTURE_MAX_BYTES + 16 * 1024;
/** a draw's fields, in the order of the record's `draws` entries */
export const DRAW_FIELDS = Object.freeze(['prog', 'tex', 'st', 'vp', 'vao', 'ebo', 'call', 'uni', 'data']);
const IMG_QUALITY = [0.8, 0.6, 0.4, 0.25];

const size = (rec) => JSON.stringify(rec).length;
/** passes whose events are the same in every frame (by their position): their events dropped, `n` kept */
function collapseSame(rec) {
  const F = rec.frames, keys = F.map((f) => f.passes.map((p) => p.fb + ':' + JSON.stringify(p.ev ?? null)));
  for (let i = 0; i < F[0].passes.length; i++) if (keys.every((k) => k[i] === keys[0][i]) && F[0].passes[i].ev) for (const f of F) { const p = f.passes[i]; p.n = p.ev.length; p.same = true; delete p.ev; }
}
/** every pass's events cut to `n` (the count kept) */
function cutEvents(rec, n) { for (const f of rec.frames) for (const p of f.passes) if (p.ev && p.ev.length > n) { p.n = p.ev.length; p.ev = p.ev.slice(0, n); } }
/** the distinct draws no remaining event or diff entry names: dropped, the others numbered again (events and diff follow) */
function dropUnusedDraws(rec) {
  const used = new Map(), use = (i) => { if (typeof i === 'number' && !used.has(i)) used.set(i, used.size); };
  const diffs = [...Object.values(rec.diff ?? {}).flatMap((k) => k.passes ?? []), ...(rec.alt?.passes ?? []).map((p) => ({ changed: p.alt, onlyA: p.missing, onlyB: p.extra, ref: p }))];
  for (const f of rec.frames) for (const p of f.passes) for (const e of p.ev ?? []) use(e);
  for (const p of diffs) { for (const c of p.changed ?? []) { use(c[0]); use(c[1]); } for (const e of [...(p.onlyA ?? []), ...(p.onlyB ?? [])]) use(e); }
  const re = (e) => (typeof e === 'number' ? used.get(e) : e);
  for (const f of rec.frames) for (const p of f.passes) if (p.ev) p.ev = p.ev.map(re);
  for (const p of diffs) {
    if (p.changed) p.changed = p.changed.map((c) => [re(c[0]), re(c[1]), c[2], c[3]]); if (p.onlyA) p.onlyA = p.onlyA.map(re); if (p.onlyB) p.onlyB = p.onlyB.map(re);
    if (p.ref) { p.ref.alt = p.changed; p.ref.missing = p.onlyA; p.ref.extra = p.onlyB; } // (the alternation's own names for them)
  }
  const old = rec.draws; rec.draws = new Array(used.size); for (const [i, j] of used) rec.draws[j] = old[i] ?? null;
}

/**
 * The record cut to `max` characters, in steps (each named in `cut`): the images re-encoded at lower JPEG qualities
 * (`encode(q)` resolves to the images' base64 strings), the passes the same in every frame emptied, every pass's events
 * cut, the draws no event names dropped, the objects' descriptions, the diff's lists cut; the pass list stays. Last
 * resort: no images.
 */
export async function fitRecord(rec, encode, max = CAPTURE_MAX_BYTES) {
  rec.cut = []; let qi = 0;
  rec.q = IMG_QUALITY[0]; rec.images = await encode(rec.q);
  const quality = async () => { if (qi + 1 < IMG_QUALITY.length) { rec.q = IMG_QUALITY[++qi]; rec.images = await encode(rec.q); rec.cut.push(`q${rec.q}`); } };
  const steps = [quality, () => { collapseSame(rec); rec.cut.push('same passes'); }, () => { dropUnusedDraws(rec); rec.cut.push('unused draws'); }, quality,
    () => { cutEvents(rec, 400); dropUnusedDraws(rec); rec.cut.push('events 400'); }, quality, () => { cutEvents(rec, 80); dropUnusedDraws(rec); rec.cut.push('events 80'); },
    () => { cutEvents(rec, 0); dropUnusedDraws(rec); rec.cut.push('no events'); }, () => { rec.objs = {}; rec.cut.push('no objects'); },
    () => { for (const d of Object.values(rec.diff ?? {})) d.passes = (d.passes ?? []).slice(0, 8).map((p) => ({ ...p, changed: p.changed.slice(0, 8), onlyA: p.onlyA.slice(0, 8), onlyB: p.onlyB.slice(0, 8) })); dropUnusedDraws(rec); rec.cut.push('diff cut'); },
    () => { if (rec.alt) rec.alt.passes = rec.alt.passes.slice(0, 8).map((p) => ({ ...p, alt: p.alt.slice(0, 8), missing: p.missing.slice(0, 8), extra: p.extra.slice(0, 8) })); dropUnusedDraws(rec); rec.cut.push('alternation cut'); },
    () => { rec.images = []; rec.cut.push('no images'); }];
  for (const step of steps) { if (size(rec) <= max) break; await step(); }
  return rec;
}

// ---------------------------------------------------------------- comparison of two frames
/** pairs [i, j] of a longest common subsequence of a and b (equal by ===); beyond `cells` the middle is paired by position */
export function lcsPairs(a, b, cells = 4e6) {
  const out = [];
  let lo = 0, ha = a.length, hb = b.length;
  while (lo < ha && lo < hb && a[lo] === b[lo]) { out.push([lo, lo]); lo++; }
  const tail = [];
  while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) { ha--; hb--; tail.push([ha, hb]); }
  const n = ha - lo, m = hb - lo;
  if (n && m) {
    if (n * m > cells) { for (let k = 0; k < Math.min(n, m); k++) if (a[lo + k] === b[lo + k]) out.push([lo + k, lo + k]); }
    else {
      const W = m + 1, L = new Uint32Array((n + 1) * W);
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = a[lo + i] === b[lo + j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      for (let i = 0, j = 0; i < n && j < m;) {
        if (a[lo + i] === b[lo + j]) { out.push([lo + i, lo + j]); i++; j++; } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++; else j++;
      }
    }
  }
  return out.concat(tail.reverse());
}
/** a framebuffer id as the comparison sees it: the back buffers by their role (a flipping chain rotates them every frame) */
function roleOf(rec) { const objs = rec.objs ?? {}; return (id) => (typeof id === 'string' && objs[id]?.back ? 'back' : id); }
const evKeyOf = (role) => (e) => (typeof e === 'number' ? e : JSON.stringify(e.map(role)));
/** a draw's shape: what stays when only its inputs change (program, the call's function and primitive mode) */
const shape = (d) => (d ? `${d[0]}|${String(d[6]).split(' ', 2).join(' ')}` : null);
const passKey = (role) => (p) => role(p.fb);

/** a draw without what moves from frame to frame by itself (its call's offset, uniforms, streamed data, attribute setup) */
const loose = (d) => (d ? `${d[0]}|${d[1]}|${d[2]}|${d[3]}|${String(d[4]).split('#')[0]}|${String(d[6]).replace(/ @\S+/, '')}` : null);

/**
 * Two passes' events paired: those of a longest common sequence (equal), then among the rest the draws of a longest
 * common sequence by `loose` (the same draw whose offset or inputs moved), then the remaining draws in order by shape
 * (same program, draw function and primitive) — those two `changed`, [x, y, fields that differ]. `map`: event index in
 * a -> in b; `restA` / `restB`: the indices left alone.
 */
function pairPass(pa, pb, draws, key) {
  const ka = pa.ev.map(key), kb = pb.ev.map(key), common = lcsPairs(ka, kb), map = new Map(common), mb = new Set(common.map((c) => c[1]));
  let restA = pa.ev.map((_, x) => x).filter((x) => !map.has(x)), restB = pb.ev.map((_, y) => y).filter((y) => !mb.has(y));
  const changed = [], fieldsOf = (x, y) => { const da = draws[pa.ev[x]], db = draws[pb.ev[y]]; return DRAW_FIELDS.filter((_, k) => JSON.stringify(da?.[k]) !== JSON.stringify(db?.[k])); };
  const lk = (e, n) => (typeof e === 'number' && draws[e] ? loose(draws[e]) : `~${n}`); // (other events never pair here)
  const usedA = new Set(), usedB = new Set();
  for (const [u, v] of lcsPairs(restA.map((x, n) => lk(pa.ev[x], 'a' + n)), restB.map((y, n) => lk(pb.ev[y], 'b' + n)))) { const x = restA[u], y = restB[v]; usedA.add(x); usedB.add(y); map.set(x, y); changed.push([x, y, fieldsOf(x, y)]); }
  restA = restA.filter((x) => !usedA.has(x)); restB = restB.filter((y) => !usedB.has(y));
  const freeB = new Map(); // (shape -> positions in restB, in order)
  for (const y of restB) { const e = pb.ev[y], s = typeof e === 'number' ? shape(draws[e]) : null; if (s) { if (!freeB.has(s)) freeB.set(s, []); freeB.get(s).push(y); } }
  const left = [];
  for (const x of restA) {
    const e = pa.ev[x], s = typeof e === 'number' ? shape(draws[e]) : null, q = s ? freeB.get(s) : null;
    if (!q?.length) { left.push(x); continue; }
    const y = q.shift(); usedB.add(y); map.set(x, y); changed.push([x, y, fieldsOf(x, y)]);
  }
  changed.sort((p, q) => p[0] - q[0]);
  return { map, common: common.length, changed, restA: left, restB: restB.filter((y) => !usedB.has(y)) };
}

/**
 * Frames a and b of a record (indices) compared pass by pass: passes paired by their framebuffers in order (back
 * buffers by role; only in one frame: `onlyA` / `onlyB`); in a pair whose events differ (pairPass), `changed`: [draw a,
 * draw b, position in a, fields], the rest listed as only in one frame (draw indices / event arrays). `fields`: per draw
 * field, how many changed draws differ in it. `limit`: entries kept per list.
 */
export function diffFrames(rec, a, b, limit = 40) {
  const A = rec.frames[a], B = rec.frames[b], draws = rec.draws ?? [], role = roleOf(rec), key = evKeyOf(role);
  const pairs = lcsPairs(A.passes.map(passKey(role)), B.passes.map(passKey(role)));
  const out = { a, b, same: 0, passes: [], onlyA: [], onlyB: [] };
  const inA = new Set(pairs.map((p) => p[0])), inB = new Set(pairs.map((p) => p[1]));
  A.passes.forEach((p, i) => { if (!inA.has(i)) out.onlyA.push([i, p.fb, p.ev?.length ?? p.n ?? 0]); });
  B.passes.forEach((p, j) => { if (!inB.has(j)) out.onlyB.push([j, p.fb, p.ev?.length ?? p.n ?? 0]); });
  for (const [i, j] of pairs) {
    const pa = A.passes[i], pb = B.passes[j];
    if (!pa.ev || !pb.ev) { if ((pa.n ?? pa.ev?.length) === (pb.n ?? pb.ev?.length) && (pa.same || pb.same)) out.same++; continue; }
    const r = pairPass(pa, pb, draws, key);
    if (r.common === pa.ev.length && r.common === pb.ev.length) { out.same++; continue; }
    const fields = {}; for (const c of r.changed) for (const f of c[2]) fields[f] = (fields[f] ?? 0) + 1;
    out.passes.push({ i, j, fb: pa.fb, na: pa.ev.length, nb: pb.ev.length, common: r.common, changed: r.changed.slice(0, limit).map(([x, y, f]) => [pa.ev[x], pb.ev[y], x, f]), nChanged: r.changed.length, fields,
      onlyA: r.restA.slice(0, limit).map((x) => pa.ev[x]), nOnlyA: r.restA.length, onlyB: r.restB.slice(0, limit).map((y) => pb.ev[y]), nOnlyB: r.restB.length });
  }
  return out;
}
/** the record's frame pairs compared (1-2, 2-3, 1-3 for three frames: an A-B-A shows as 1-2 and 2-3 differing, 1-3 not) */
export function diffRecord(rec, limit = 40) {
  const out = {}, n = rec.frames.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (b === a + 1 || (a === 0 && b === 2)) out[`${a + 1}-${b + 1}`] = diffFrames(rec, a, b, limit);
  return out;
}

/**
 * What alternates over three frames — what an A-B-A picture comes from: per pass of frame 1 found in frames 2 and 3
 * (back buffers by role), its events found in frame 3 but not in frame 2 (`missing`: drawn in 1 and 3, not in 2), frame
 * 2's events found in neither 1 nor 3 (`extra`), and the draws found in all three whose fields are the same in 1 and 3
 * but not in 2 (`alt`: [draw 1, draw 2, position in 1, fields]) — what keeps changing (a dynamic buffer's moving offset)
 * differs in 1-3 too and is left out. Passes of 1 and 3 that 2 lacks: `passesMissing`; passes of 2 only: `passesExtra`.
 * `fields`: per field, the alternating draws. Null without three frames.
 */
export function alternation(rec, limit = 40) {
  if ((rec.frames?.length ?? 0) < 3) return null;
  const [A, B, C] = rec.frames, draws = rec.draws ?? [], role = roleOf(rec), key = evKeyOf(role), pk = passKey(role);
  const ab = new Map(lcsPairs(A.passes.map(pk), B.passes.map(pk))), ac = new Map(lcsPairs(A.passes.map(pk), C.passes.map(pk))), bc = new Map(lcsPairs(B.passes.map(pk), C.passes.map(pk)));
  const usedB = new Set(ab.values()), out = { passes: [], passesMissing: [], passesExtra: [], fields: {} };
  A.passes.forEach((p, i) => { if (ac.has(i) && !ab.has(i)) out.passesMissing.push([i, p.fb, p.ev?.length ?? p.n ?? 0]); });
  B.passes.forEach((p, j) => { if (!usedB.has(j) && !bc.has(j)) out.passesExtra.push([j, p.fb, p.ev?.length ?? p.n ?? 0]); });
  for (const [i, j] of ab) {
    const k = ac.get(i), pa = A.passes[i], pb = B.passes[j], pc = k === undefined ? null : C.passes[k];
    if (!pc || !pa.ev || !pb.ev || !pc.ev) continue;
    const r12 = pairPass(pa, pb, draws, key), r13 = pairPass(pa, pc, draws, key), r23 = pairPass(pb, pc, draws, key);
    const missing = [], alt = [], fields = {};
    pa.ev.forEach((e, x) => {
      const y = r12.map.get(x), z = r13.map.get(x);
      if (z === undefined) return;
      if (y === undefined) { missing.push(e); return; }
      if (typeof e !== 'number') return;
      const d1 = draws[e], d2 = draws[pb.ev[y]], d3 = draws[pc.ev[z]];
      if (!d1 || !d2 || !d3) return;
      const f = DRAW_FIELDS.filter((_, n) => JSON.stringify(d1[n]) === JSON.stringify(d3[n]) && JSON.stringify(d1[n]) !== JSON.stringify(d2[n]));
      if (f.length) { alt.push([e, pb.ev[y], x, f]); for (const n of f) { fields[n] = (fields[n] ?? 0) + 1; out.fields[n] = (out.fields[n] ?? 0) + 1; } }
    });
    const inA = new Set(r12.map.values()), extra = pb.ev.filter((_, y) => !inA.has(y) && !r23.map.has(y));
    if (missing.length || extra.length || alt.length) out.passes.push({ i, j, fb: pa.fb, fb2: pb.fb, n: pa.ev.length, n2: pb.ev.length, missing: missing.slice(0, limit), nMissing: missing.length, extra: extra.slice(0, limit), nExtra: extra.length, alt: alt.slice(0, limit), nAlt: alt.length, fields });
  }
  return out;
}

// ---------------------------------------------------------------- the server's check
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
/**
 * A capture as received: its known fields kept (each a JSON value the size limit bounds), the session and the images
 * checked. { ok: true, rec } or { ok: false, error }.
 */
export function sanitizeFlickerRecord(r) {
  if (!r || typeof r !== 'object' || r.event !== 'flicker-capture') return { ok: false, error: 'not a flicker capture' };
  if (r.v !== FLICKER_RECORD_VERSION) return { ok: false, error: 'unknown version' };
  if (typeof r.session !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(r.session)) return { ok: false, error: 'bad session' };
  if (!Array.isArray(r.frames) || r.frames.length > 8) return { ok: false, error: 'bad frames' };
  if (!Array.isArray(r.images) || r.images.length > 8 || !r.images.every((s) => typeof s === 'string' && B64.test(s))) return { ok: false, error: 'bad images' };
  const rec = { event: 'flicker-capture', v: r.v, session: r.session };
  for (const k of ['game', 'build', 'version', 'options', 'trigger', 'gl', 'size', 'img', 'q', 'images', 'small', 'frames', 'objs', 'states', 'draws', 'drawFields', 'diff', 'alt', 'cut', 'notes', 'page']) if (r[k] !== undefined) rec[k] = r[k];
  if (rec.game !== undefined && rec.game !== null) rec.game = String(rec.game).slice(0, 120);
  return { ok: true, rec };
}
