// The flicker capture's record (src/gfx/flicker-capture.js makes it in the page's GL thread, the server keeps it in the
// telemetry, tools/dev/flicker-capture.mjs reads it): its size limit, the cuts that keep it under the limit, the
// comparison of two of its frames' GL work, and the server's check.
//
// A record: { event: 'flicker-capture', v, trigger, gl, size, img, q, images: [base64 JPEG x frames], small, frames:
// [{ ms, info, calls, draws, passes: [{ fb, n, ev }], ups, att, errs }], objs, states, draws, drawFields, diff, alt, cut, notes }.
// A pass is the work drawn into one framebuffer between two bindings of another: `fb` its object id ('F0': the canvas),
// `ev` its events in order — a draw as a number (an index into `draws`, the record's distinct draws: DRAW_FIELDS), the
// others as arrays (['clear', ...], ['blit', ...], ['err', code], ...). A pass the cuts emptied keeps `n`, its event count;
// a frame whose lists were cut keeps their lengths (`nUps`, `nAtt`, `nPasses`). `diff` and `alt` are the page's
// comparison of the frames before any cut (fitRecord): a reader takes them as they are when `cut` names more than the
// pictures' quality.
export const FLICKER_RECORD_VERSION = 1;
/** the record's size at most (JSON characters, ASCII): the page cuts it to this */
export const CAPTURE_MAX_BYTES = 400 * 1024;
/** what the server takes for one capture POST (the record and the page's own fields) */
export const CAPTURE_POST_MAX_BYTES = CAPTURE_MAX_BYTES + 16 * 1024;
/** a draw's fields, in the order of the record's `draws` entries */
export const DRAW_FIELDS = Object.freeze(['prog', 'tex', 'st', 'vp', 'vao', 'ebo', 'call', 'uni', 'data']);
const IMG_QUALITY = [0.8, 0.6, 0.4, 0.25];

const size = (rec) => JSON.stringify(rec).length;
/**
 * The record's JSON length — JSON.stringify(rec).length — made a part at a time: a generator that yields between its
 * fields, between frames and between blocks of 500 entries of its other arrays (runSliced: a record of megabytes is
 * not written in one task of the page).
 */
export function* sizeSteps(rec) {
  let n = 2, first = true;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (v === undefined || typeof v === 'function') continue;
    n += (first ? 0 : 1) + JSON.stringify(k).length + 1; first = false;
    if (Array.isArray(v) && v.length > 1) {
      const step = k === 'frames' || k === 'images' ? 1 : 500;
      n += 2 + v.length - 1; // (its brackets and commas)
      for (let i = 0; i < v.length; i += step) { n += JSON.stringify(v.slice(i, i + step)).length - 2 - (Math.min(step, v.length - i) - 1); yield; }
    } else { n += JSON.stringify(v).length; yield; }
  }
  return n;
}
/** passes whose events are the same in every frame (by their position): their events dropped, `n` kept (a generator: yields per frame) */
function* collapseSame(rec) {
  const F = rec.frames, keys = [];
  for (const f of F) { keys.push(f.passes.map((p) => p.fb + ':' + JSON.stringify(p.ev ?? null))); yield; }
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

/** every frame's texture uploads and attachment changes cut to `n` (their counts kept: nUps, nAtt) */
function cutLists(rec, n) {
  for (const f of rec.frames) {
    if (f.ups?.length > n) { f.nUps ??= f.ups.length; f.ups = f.ups.slice(0, n); }
    if (f.att?.length > n) { f.nAtt ??= f.att.length; f.att = f.att.slice(0, n); }
  }
}
/**
 * The last cut, when nothing else was enough: each frame's figures and its first passes (their framebuffers and event
 * counts), no distinct draws, states or objects, the comparisons' counts and the alternation's fields kept; past that
 * the context's extension list and limits, then the notes.
 */
function minimal(rec, max) {
  for (const f of rec.frames) { f.nPasses ??= f.passes.length; f.passes = f.passes.slice(0, 40).map((p) => ({ fb: p.fb, n: p.ev?.length ?? p.n ?? 0, ...(p.same ? { same: true } : {}) })); f.ups = []; f.att = []; f.errs = (f.errs ?? []).slice(0, 8); }
  rec.draws = []; rec.states = []; rec.objs = {};
  for (const d of Object.values(rec.diff ?? {})) { d.passes = (d.passes ?? []).slice(0, 8).map((p) => ({ i: p.i, j: p.j, fb: p.fb, na: p.na, nb: p.nb, common: p.common, nChanged: p.nChanged, fields: p.fields, nOnlyA: p.nOnlyA, nOnlyB: p.nOnlyB })); d.onlyA = (d.onlyA ?? []).slice(0, 8); d.onlyB = (d.onlyB ?? []).slice(0, 8); }
  if (rec.alt) rec.alt = { fields: rec.alt.fields, passesMissing: (rec.alt.passesMissing ?? []).slice(0, 8), passesExtra: (rec.alt.passesExtra ?? []).slice(0, 8), passes: (rec.alt.passes ?? []).slice(0, 8).map((p) => ({ i: p.i, j: p.j, fb: p.fb, fb2: p.fb2, n: p.n, n2: p.n2, nMissing: p.nMissing, nExtra: p.nExtra, nAlt: p.nAlt, fields: p.fields })) };
  if (size(rec) > max && rec.gl) { rec.gl = { ...rec.gl, ext: [], limits: {} }; }
  if (size(rec) > max) { rec.notes = (rec.notes ?? []).slice(0, 4).map((n) => String(n).slice(0, 200)); rec.frames = rec.frames.map((f) => ({ ms: f.ms, calls: f.calls, draws: f.draws, nPasses: f.nPasses })); }
  if (size(rec) > max) { rec.diff = null; rec.alt = rec.alt ? { fields: rec.alt.fields } : null; rec.gl = rec.gl ? { renderer: String(rec.gl.renderer).slice(0, 200) } : null; rec.trigger = null; }
}
/** a task boundary (the page: its frames go on between the steps) */
const tick = () => new Promise((r) => setTimeout(r, 0));
/** the record's making in the page: its slices' length, ms (runSliced) */
export const SLICE_MS = 3;

/**
 * The record cut to `max` characters, in steps (each named in `cut`): the images re-encoded at lower JPEG qualities
 * (`encode(q)` resolves to the images' base64 strings), the passes the same in every frame emptied, the draws no event
 * names dropped, each frame's upload and attachment lists cut, every pass's events cut, the objects' descriptions, the
 * diff's lists cut; then no images; then the minimal record (each frame's figures, the comparisons' counts). Each step
 * and its size check (sizeSteps) in slices of their own, counted in `work` ({ slices, longest } or null). Its `diff` and `alt` are
 * computed before (on every event): what the cuts leave keeps them.
 */
export async function fitRecord(rec, encode, max = CAPTURE_MAX_BYTES, work = null) {
  rec.cut = []; let qi = 0;
  rec.q = IMG_QUALITY[0]; rec.images = await encode(rec.q);
  const quality = async () => { if (qi + 1 < IMG_QUALITY.length) { rec.q = IMG_QUALITY[++qi]; rec.images = await encode(rec.q); rec.cut.push(`q${rec.q}`); } };
  const steps = [quality, function* () { yield* collapseSame(rec); rec.cut.push('same passes'); }, () => { dropUnusedDraws(rec); rec.cut.push('unused draws'); }, () => { cutLists(rec, 200); rec.cut.push('uploads 200'); }, quality,
    () => { cutEvents(rec, 400); dropUnusedDraws(rec); rec.cut.push('events 400'); }, quality, () => { cutEvents(rec, 80); dropUnusedDraws(rec); rec.cut.push('events 80'); },
    () => { cutLists(rec, 20); rec.cut.push('uploads 20'); }, () => { cutEvents(rec, 0); dropUnusedDraws(rec); rec.cut.push('no events'); }, () => { rec.objs = {}; rec.cut.push('no objects'); },
    () => { for (const d of Object.values(rec.diff ?? {})) d.passes = (d.passes ?? []).slice(0, 8).map((p) => ({ ...p, changed: p.changed.slice(0, 8), onlyA: p.onlyA.slice(0, 8), onlyB: p.onlyB.slice(0, 8) })); dropUnusedDraws(rec); rec.cut.push('diff cut'); },
    () => { if (rec.alt) rec.alt.passes = rec.alt.passes.slice(0, 8).map((p) => ({ ...p, alt: p.alt.slice(0, 8), missing: p.missing.slice(0, 8), extra: p.extra.slice(0, 8) })); dropUnusedDraws(rec); rec.cut.push('alternation cut'); },
    () => { cutLists(rec, 0); rec.cut.push('no uploads'); }, () => { rec.images = []; rec.cut.push('no images'); }, () => { minimal(rec, max); rec.cut.push('minimal'); }];
  for (const step of steps) {
    if ((await runSliced(sizeSteps(rec), SLICE_MS, work)) <= max) break;
    await tick(); // (runSliced resolves at the end of its last slice's task: the step in a task of its own)
    if (step === quality) { await step(); continue; } // (the encode: asynchronous — OffscreenCanvas —, not counted)
    const t0 = now(), r = step();
    counted(work, now() - t0);
    if (r && typeof r.next === 'function') await runSliced(r, SLICE_MS, work); // (a generator step: in slices too)
  }
  return rec;
}

// ---------------------------------------------------------------- comparison of two frames
/** the LCS work (table cells) one comparison call does at most in the page: a few ms (flicker-capture.js) */
export const PAGE_LCS_CELLS = 2e5;
/**
 * Pairs [i, j] of a longest common subsequence of a and b (equal by ===), the common head and tail first. Beyond `cells`
 * table cells the middle is compared in a band around its diagonal (an insertion or a removal of up to the band's width
 * still lines the rest up — what an A-B-A frame's missing or extra draws are), the band as wide as `cells` allows; when
 * not even the length difference fits, by position.
 */
export function lcsPairs(a, b, cells = 4e6) {
  const out = [];
  let lo = 0, ha = a.length, hb = b.length;
  while (lo < ha && lo < hb && a[lo] === b[lo]) { out.push([lo, lo]); lo++; }
  const tail = [];
  while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) { ha--; hb--; tail.push([ha, hb]); }
  const n = ha - lo, m = hb - lo;
  if (n && m) {
    if (n * m <= cells) {
      const W = m + 1, L = new Uint32Array((n + 1) * W);
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = a[lo + i] === b[lo + j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      for (let i = 0, j = 0; i < n && j < m;) {
        if (a[lo + i] === b[lo + j]) { out.push([lo + i, lo + j]); i++; j++; } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++; else j++;
      }
    } else {
      // (the band: diagonals d = j - i in [dmin, dmax], each row's cells stored by d; outside it, 0)
      const w = Math.floor((cells / (n + 1) - Math.abs(n - m) - 1) / 2);
      if (w < 1) { for (let k = 0; k < Math.min(n, m); k++) if (a[lo + k] === b[lo + k]) out.push([lo + k, lo + k]); }
      else {
        // (cell (i, j) at L[i * B + j - i - dmin]; the cells of column m and past it are never written: 0, an empty suffix)
        const dmin = Math.min(0, m - n) - w, dmax = Math.max(0, m - n) + w, B = dmax - dmin + 1, L = new Uint32Array((n + 1) * B);
        for (let i = n - 1; i >= 0; i--) {
          const r = i * B, r1 = r + B, j0 = Math.max(0, i + dmin), j1 = Math.min(m - 1, i + dmax), ai = a[lo + i];
          for (let j = j1; j >= j0; j--) {
            const dd = j - i - dmin;
            if (ai === b[lo + j]) L[r + dd] = L[r1 + dd] + 1;
            else { const down = dd > 0 ? L[r1 + dd - 1] : 0, right = dd + 1 < B ? L[r + dd + 1] : 0; L[r + dd] = down > right ? down : right; }
          }
        }
        for (let i = 0, j = 0; i < n && j < m;) {
          const dd = j - i - dmin;
          if (a[lo + i] === b[lo + j]) { out.push([lo + i, lo + j]); i++; j++; }
          else if (dd + 1 >= B || (dd > 0 && L[(i + 1) * B + dd - 1] >= L[i * B + dd + 1])) i++; else j++;
        }
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

/** two draw fields equal (strings and numbers as they are, arrays and objects by their JSON) */
const same = (x, y) => x === y || (typeof x === 'object' && typeof y === 'object' && x !== null && y !== null && JSON.stringify(x) === JSON.stringify(y));
/**
 * Two passes' events paired: those of a longest common sequence (equal), then among the rest the draws of a longest
 * common sequence by `loose` (the same draw whose offset or inputs moved), then the remaining draws in order by shape
 * (same program, draw function and primitive) — those two `changed`, [x, y, fields that differ]. `map`: event index in
 * a -> in b; `restA` / `restB`: the indices left alone. `cells`: lcsPairs' work per call. A generator: it yields after
 * each longest common sequence (runSliced).
 */
function* pairPass(pa, pb, draws, key, cells) {
  const ka = pa.ev.map(key), kb = pb.ev.map(key);
  yield;
  const common = lcsPairs(ka, kb, cells), map = new Map(common), mb = new Set(common.map((c) => c[1]));
  yield;
  let restA = pa.ev.map((_, x) => x).filter((x) => !map.has(x)), restB = pb.ev.map((_, y) => y).filter((y) => !mb.has(y));
  const changed = [], fieldsOf = (x, y) => { const da = draws[pa.ev[x]], db = draws[pb.ev[y]]; return DRAW_FIELDS.filter((_, k) => !same(da?.[k], db?.[k])); };
  const lk = (e, n) => (typeof e === 'number' && draws[e] ? loose(draws[e]) : `~${n}`); // (other events never pair here)
  const usedA = new Set(), usedB = new Set(), la = restA.map((x, n) => lk(pa.ev[x], 'a' + n)), lb = restB.map((y, n) => lk(pb.ev[y], 'b' + n));
  yield;
  const looseCommon = lcsPairs(la, lb, cells);
  yield;
  let k = 0; // (the long loops yield every 500 entries)
  for (const [u, v] of looseCommon) { const x = restA[u], y = restB[v]; usedA.add(x); usedB.add(y); map.set(x, y); changed.push([x, y, fieldsOf(x, y)]); if (++k % 500 === 0) yield; }
  restA = restA.filter((x) => !usedA.has(x)); restB = restB.filter((y) => !usedB.has(y));
  const freeB = new Map(); // (shape -> positions in restB, in order)
  for (const y of restB) { const e = pb.ev[y], s = typeof e === 'number' ? shape(draws[e]) : null; if (s) { if (!freeB.has(s)) freeB.set(s, []); freeB.get(s).push(y); } }
  yield;
  const left = [];
  for (const x of restA) {
    if (++k % 500 === 0) yield;
    const e = pa.ev[x], s = typeof e === 'number' ? shape(draws[e]) : null, q = s ? freeB.get(s) : null;
    if (!q?.length) { left.push(x); continue; }
    const y = q.shift(); usedB.add(y); map.set(x, y); changed.push([x, y, fieldsOf(x, y)]);
  }
  changed.sort((p, q) => p[0] - q[0]);
  return { map, common: common.length, changed, restA: left, restB: restB.filter((y) => !usedB.has(y)) };
}

// (the comparisons are generators that yield between their longest common sequences (pairPass): the page runs them in
// slices between its frames, runSliced; the plain functions run them to their end at once)
/** a generator run to its end: its value */
function drain(g) { for (;;) { const r = g.next(); if (r.done) return r.value; } }
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** `work` ({ slices, longest, busy, over8 } or null): a slice of `ms` counted (busy: their sum; over8: those over 8 ms) */
export const counted = (work, ms) => { if (work) { work.slices++; work.busy = (work.busy ?? 0) + ms; if (ms > 8) work.over8 = (work.over8 ?? 0) + 1; if (ms > work.longest) work.longest = ms; } };
/**
 * A generator run in slices of about `budgetMs` (one step at least), each slice in a task of its own, until it is done:
 * resolves to its value — none of it runs in the caller's task (the page's present: flicker-capture.js). `work`: its
 * slices counted there.
 */
export function runSliced(g, budgetMs = 4, work = null) {
  return new Promise((resolve, reject) => {
    const slice = () => {
      try {
        const t0 = now();
        for (;;) { const r = g.next(); if (r.done) { counted(work, now() - t0); resolve(r.value); return; } if (now() - t0 >= budgetMs) break; }
        counted(work, now() - t0);
        setTimeout(slice, 0);
      } catch (e) { reject(e); }
    };
    setTimeout(slice, 0);
  });
}

/**
 * Frames a and b of a record (indices) compared pass by pass: passes paired by their framebuffers in order (back
 * buffers by role; only in one frame: `onlyA` / `onlyB`); in a pair whose events differ (pairPass), `changed`: [draw a,
 * draw b, position in a, fields], the rest listed as only in one frame (draw indices / event arrays). `fields`: per draw
 * field, how many changed draws differ in it. `limit`: entries kept per list; `cells`: lcsPairs' work per call.
 */
export function diffFrames(rec, a, b, limit = 40, cells = undefined) { return drain(diffFramesSteps(rec, a, b, limit, cells)); }
function* diffFramesSteps(rec, a, b, limit = 40, cells = undefined) {
  const A = rec.frames[a], B = rec.frames[b], draws = rec.draws ?? [], role = roleOf(rec), key = evKeyOf(role);
  const pairs = lcsPairs(A.passes.map(passKey(role)), B.passes.map(passKey(role)), cells);
  const out = { a, b, same: 0, passes: [], onlyA: [], onlyB: [] };
  const inA = new Set(pairs.map((p) => p[0])), inB = new Set(pairs.map((p) => p[1]));
  A.passes.forEach((p, i) => { if (!inA.has(i)) out.onlyA.push([i, p.fb, p.ev?.length ?? p.n ?? 0]); });
  B.passes.forEach((p, j) => { if (!inB.has(j)) out.onlyB.push([j, p.fb, p.ev?.length ?? p.n ?? 0]); });
  for (const [i, j] of pairs) {
    const pa = A.passes[i], pb = B.passes[j];
    if (!pa.ev || !pb.ev) { if ((pa.n ?? pa.ev?.length) === (pb.n ?? pb.ev?.length) && (pa.same || pb.same)) out.same++; continue; }
    const r = yield* pairPass(pa, pb, draws, key, cells);
    yield;
    if (r.common === pa.ev.length && r.common === pb.ev.length) { out.same++; continue; }
    const fields = {}; for (const c of r.changed) for (const f of c[2]) fields[f] = (fields[f] ?? 0) + 1;
    out.passes.push({ i, j, fb: pa.fb, na: pa.ev.length, nb: pb.ev.length, common: r.common, changed: r.changed.slice(0, limit).map(([x, y, f]) => [pa.ev[x], pb.ev[y], x, f]), nChanged: r.changed.length, fields,
      onlyA: r.restA.slice(0, limit).map((x) => pa.ev[x]), nOnlyA: r.restA.length, onlyB: r.restB.slice(0, limit).map((y) => pb.ev[y]), nOnlyB: r.restB.length });
  }
  return out;
}
/** the record's frame pairs compared (1-2, 2-3, 1-3 for three frames: an A-B-A shows as 1-2 and 2-3 differing, 1-3 not) */
export function diffRecord(rec, limit = 40, cells = undefined) { return drain(diffRecordSteps(rec, limit, cells)); }
export function* diffRecordSteps(rec, limit = 40, cells = undefined) {
  const out = {}, n = rec.frames.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (b === a + 1 || (a === 0 && b === 2)) out[`${a + 1}-${b + 1}`] = yield* diffFramesSteps(rec, a, b, limit, cells);
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
export function alternation(rec, limit = 40, cells = undefined) { return drain(alternationSteps(rec, limit, cells)); }
export function* alternationSteps(rec, limit = 40, cells = undefined) {
  if ((rec.frames?.length ?? 0) < 3) return null;
  const [A, B, C] = rec.frames, draws = rec.draws ?? [], role = roleOf(rec), key = evKeyOf(role), pk = passKey(role);
  const ab = new Map(lcsPairs(A.passes.map(pk), B.passes.map(pk), cells)), ac = new Map(lcsPairs(A.passes.map(pk), C.passes.map(pk), cells)), bc = new Map(lcsPairs(B.passes.map(pk), C.passes.map(pk), cells));
  const usedB = new Set(ab.values()), out = { passes: [], passesMissing: [], passesExtra: [], fields: {} };
  A.passes.forEach((p, i) => { if (ac.has(i) && !ab.has(i)) out.passesMissing.push([i, p.fb, p.ev?.length ?? p.n ?? 0]); });
  B.passes.forEach((p, j) => { if (!usedB.has(j) && !bc.has(j)) out.passesExtra.push([j, p.fb, p.ev?.length ?? p.n ?? 0]); });
  for (const [i, j] of ab) {
    const k = ac.get(i), pa = A.passes[i], pb = B.passes[j], pc = k === undefined ? null : C.passes[k];
    if (!pc || !pa.ev || !pb.ev || !pc.ev) continue;
    const r12 = yield* pairPass(pa, pb, draws, key, cells); yield;
    const r13 = yield* pairPass(pa, pc, draws, key, cells); yield;
    const r23 = yield* pairPass(pb, pc, draws, key, cells); yield;
    const missing = [], alt = [], fields = {};
    pa.ev.forEach((e, x) => {
      const y = r12.map.get(x), z = r13.map.get(x);
      if (z === undefined) return;
      if (y === undefined) { missing.push(e); return; }
      if (typeof e !== 'number') return;
      const d1 = draws[e], d2 = draws[pb.ev[y]], d3 = draws[pc.ev[z]];
      if (!d1 || !d2 || !d3) return;
      const f = DRAW_FIELDS.filter((_, n) => same(d1[n], d3[n]) && !same(d1[n], d2[n]));
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
  for (const k of ['game', 'build', 'version', 'options', 'trigger', 'gl', 'size', 'img', 'q', 'images', 'small', 'frames', 'objs', 'states', 'draws', 'drawFields', 'diff', 'alt', 'cut', 'notes', 'took', 'page']) if (r[k] !== undefined) rec[k] = r[k];
  if (rec.game !== undefined && rec.game !== null) rec.game = String(rec.game).slice(0, 120);
  return { ok: true, rec };
}
