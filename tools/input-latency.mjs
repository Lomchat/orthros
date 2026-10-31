// tools/input-latency.mjs: input latency as the player feels it, from a Chrome trace — shared by the ports' tools
// (tools/openmw/place-load.mjs --input-trace; tests/input-latency.test.js; checked on a deliberately blocked page,
// tools/input-latency-check.mjs).
//
// Why from the trace: a page's own handler sees only the events it is handed. While its thread is held the browser
// coalesces the mouse moves queued for it into one (rAF-aligned input), so a probe in the page counts 3 moves over a
// 5 s block where the user made 100, and its percentiles compare different sets of events between two builds (the
// fourth validation of r20: 3-4 received moves against 14-16). Here every event the harness generates is counted.
//
// The events: generateInputs() sends mouse moves at a fixed cadence (default every 50 ms) and a key press now and then
// through CDP's Input domain without waiting for the page (a dispatch's answer waits for the renderer: an awaited
// generator stops while the page is held — place-load's 250 ms jiggler did). Chrome records one `EventLatency` (trace
// categories 'input'/'benchmark') for every one of them, coalesced or not: its begin is the event's own timestamp
// (when the harness made it), its stages tell how it ended — `RendererMainProcessing` when the page's thread
// dispatched it, `RendererCompositorFinishedToTermination` alone when it was coalesced into a move already queued (or
// dropped by the compositor), `SubmitCompositorFrameToPresentationCompositorFrame` when Chrome attributed a presented
// frame to it.
//
// The measure (inputLatency), per event in the window:
// - its carrier: the event itself when the page's thread dispatched it; a coalesced one's, the last move before it that
//   the page's thread dispatched at or after this one reached the renderer (still queued then: the one it merged into;
//   the queue coalesces into its tail only); none such — the next dispatch of its kind after it.
// - answered at: the earliest frame presented by the same renderer that committed a main frame after the carrier's
//   dispatch ended (a `PipelineReporter` presented, its `SendBeginMainFrameToCommit` ending at or after the dispatch's
//   end: the first picture that could show the handler's effect) — Chrome's own presentation stage when the carrier
//   has one, if earlier; no such frame in the trace: the dispatch's end (counted apart: `byDispatch`).
// - latency: answered at − the event's timestamp. Never answered (no carrier, the trace ended): its latency is the
//   window's end − its timestamp, a lower bound (counted apart: `unanswered`).
// p50/p95/max over every event whose timestamp is in [from, to] (trace clock, µs; traceClock() maps the page's).

/** The trace categories inputLatency needs (Chrome's input path, frames' reports, the page's console.timeStamp marks). */
export const INPUT_TRACE_CATEGORIES = ['input', 'latencyInfo', 'devtools.timeline', 'benchmark'];

const MOVE = new Set(['MOUSE_MOVED_EVENT', 'MOUSE_DRAGGED_EVENT']);
const PRESENTED = new Set(['STATE_PRESENTED_ALL', 'STATE_PRESENTED_PARTIAL']);
const idOf = (e) => (e.id2 ? JSON.stringify(e.id2) : e.id !== undefined ? String(e.id) : null);

/**
 * Chrome's nested async slices named `top` (EventLatency, PipelineReporter) with their stages: Chrome writes a
 * report's begin, its stages and its end together, on one thread, under one id (ids are reused once a report ended):
 * read in the trace's order, per thread and id. → [{ pid, ts, end, args, stages: { name: [begin, end] } }]
 */
export function asyncReports(events, top) {
  const open = new Map(), out = [];
  for (const e of events) {
    if (e.ph !== 'b' && e.ph !== 'e') continue;
    const id = idOf(e); if (id === null) continue;
    const k = `${e.pid}/${e.tid}/${id}`;
    if (e.name === top) {
      if (e.ph === 'b') { const r = { pid: e.pid, ts: e.ts, end: null, args: e.args ?? {}, stages: {} }; open.set(k, r); }
      else { const r = open.get(k); if (r) { r.end = e.ts; out.push(r); open.delete(k); } }
      continue;
    }
    const r = open.get(k); if (!r) continue;
    if (e.ph === 'b') r.stages[e.name] = [e.ts, null];
    else if (r.stages[e.name]) r.stages[e.name][1] = e.ts;
  }
  return out;
}

/** The trace's events: Chrome's JSON trace (an object with traceEvents, or the bare array). */
export const traceEvents = (trace) => (Array.isArray(trace) ? trace : trace?.traceEvents ?? []);

/**
 * The page's clock to the trace's: console.timeStamp(label) marks (devtools.timeline `TimeStamp`, args.data.message)
 * against `marks` { label: page ms (performance.now() taken at the call) }. → (pageMs) => trace µs, or null without a
 * mark found (several: their median offset).
 */
export function traceClock(events, marks) {
  const offs = [];
  for (const e of events) {
    if (e.name !== 'TimeStamp' || e.ph === 'M') continue;
    const m = e.args?.data?.message ?? e.args?.data?.name; if (m === undefined || !(m in marks)) continue;
    offs.push(e.ts - marks[m] * 1000);
  }
  if (!offs.length) return null;
  offs.sort((a, b) => a - b);
  const off = offs[Math.floor(offs.length / 2)];
  return (ms) => ms * 1000 + off;
}

const q = (a, f) => (a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * f))]) : null);

/**
 * Every generated input's latency from a trace (the module's header): `from`/`to` the window (trace µs; default the
 * trace's whole span), `types` the events counted (default every type: moves and keys; e.g. ['MOUSE_MOVED_EVENT']),
 * `pids` the renderers counted (default all). → { events, p50Ms, p95Ms, maxMs, byKind, byType, carriers, byDispatch,
 * unanswered, list: [[t µs, latency ms, how]] } (how: 'self'|'coalesced'|'next' + '/frame'|'/chrome'|'/dispatch', or 'none').
 */
export function inputLatency(trace, { from = -Infinity, to = Infinity, types = null, pids = null, list = false } = {}) {
  const ev = traceEvents(trace);
  const lat = asyncReports(ev, 'EventLatency').map((r) => {
    const s = r.stages, main = s.RendererMainProcessing, arrive = s.RendererCompositorProcessing?.[1] ?? s.BrowserMainToRendererCompositor?.[1] ?? r.ts;
    const pres = s.SubmitCompositorFrameToPresentationCompositorFrame?.[1] ?? null;
    return { pid: r.pid, t: r.ts, end: r.end, type: r.args?.event_latency?.event_type ?? 'UNKNOWN', arrive, main: main && main[1] !== null ? main : null, pres };
  }).filter((r) => !pids || pids.includes(r.pid)).sort((a, b) => a.t - b.t);
  const frames = new Map();
  for (const r of asyncReports(ev, 'PipelineReporter')) {
    const st = r.args?.frame_reporter?.state, c = r.stages.SendBeginMainFrameToCommit;
    if (!PRESENTED.has(st) || !c || c[1] === null || r.end === null) continue;
    if (!frames.has(r.pid)) frames.set(r.pid, []);
    frames.get(r.pid).push([c[1], r.end]);
  }
  for (const f of frames.values()) f.sort((a, b) => a[0] - b[0]);
  const ts = lat.map((r) => r.t);
  const lastT = ev.reduce((m, e) => (e.ts !== undefined && e.ph !== 'M' && e.ts > m ? e.ts : m), -Infinity);
  const winEnd = Number.isFinite(to) ? to : lastT;
  /** The earliest presentation of a frame of `pid` that committed at or after `t`. */
  const presentedAfter = (pid, t) => {
    const f = frames.get(pid); if (!f) return null;
    let lo = 0, hi = f.length; while (lo < hi) { const m = (lo + hi) >> 1; if (f[m][0] < t) lo = m + 1; else hi = m; }
    let best = null; for (let i = lo; i < f.length; i++) { if (best !== null && f[i][0] > best) break; if (best === null || f[i][1] < best) best = f[i][1]; }
    return best;
  };
  const kindOf = (type) => (MOVE.has(type) ? 'move' : /KEY|CHAR/.test(type) ? 'key' : type.toLowerCase());
  const out = [], carriers = { self: 0, coalesced: 0, next: 0, none: 0 };
  let byDispatch = 0;
  lat.forEach((r, i) => {
    if (r.t < from || r.t > to || (types && !types.includes(r.type))) return;
    const kind = kindOf(r.type);
    let carrier = null, how = 'none';
    if (r.main) { carrier = r; how = 'self'; }
    else {
      // (merged into the tail of the page's queue: the last earlier event of its kind still undispatched when it arrived)
      for (let j = i - 1; j >= 0; j--) {
        const c = lat[j]; if (c.pid !== r.pid || kindOf(c.type) !== kind || !c.main) continue;
        if (c.main[0] >= r.arrive) { carrier = c; how = 'coalesced'; }
        break;
      }
      if (!carrier) for (let j = i + 1; j < lat.length; j++) { const c = lat[j]; if (c.pid === r.pid && kindOf(c.type) === kind && c.main) { carrier = c; how = 'next'; break; } }
    }
    let at = null;
    if (carrier) {
      const f = presentedAfter(carrier.pid, carrier.main[1]);
      const c = carrier.pres;
      if (f !== null && (c === null || f <= c)) { at = f; how += '/frame'; }
      else if (c !== null) { at = c; how += '/chrome'; }
      else { at = carrier.main[1]; how += '/dispatch'; byDispatch++; }
      carriers[how.split('/')[0]]++;
    } else carriers.none++;
    const ms = ((at ?? Math.max(winEnd, r.t)) - r.t) / 1000;
    out.push({ t: r.t, ms, how, kind, type: r.type });
  });
  const all = out.map((x) => x.ms).sort((a, b) => a - b);
  const sum = (a) => { const s = a.map((x) => x.ms).sort((x, y) => x - y); return { events: s.length, p50Ms: q(s, 0.5), p95Ms: q(s, 0.95), maxMs: s.length ? Math.round(s.at(-1)) : null }; };
  const byKind = {}, byType = {};
  for (const k of new Set(out.map((x) => x.kind))) byKind[k] = sum(out.filter((x) => x.kind === k));
  for (const x of out) byType[x.type] = (byType[x.type] ?? 0) + 1;
  return {
    events: all.length, p50Ms: q(all, 0.5), p95Ms: q(all, 0.95), maxMs: all.length ? Math.round(all.at(-1)) : null,
    byKind, byType, carriers, byDispatch, unanswered: carriers.none,
    ...(list ? { list: out.map((x) => [x.t, Math.round(x.ms), x.how]) } : {})
  };
}

/**
 * Inputs at a fixed cadence on `page` (Playwright) through CDP, never waiting for the page: a mouse move every
 * `moveMs` (alternating between two points `dx`,`dy` apart from `x`,`y`: no net movement), a key press (`key`, default
 * F13 — bound to nothing in a game, a key all the same: keydown, keyup `keyUpMs` later) every `keyMs` (0: none).
 * → { stop(): counts } (the counts sent).
 */
export async function generateInputs(page, { moveMs = 50, keyMs = 1000, x = 200, y = 200, dx = 40, dy = 30, key = 'F13', keyCode = 124, keyUpMs = 50 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const sent = { moves: 0, keys: 0, failed: 0 };
  const fail = () => { sent.failed++; };
  let k = 0;
  const mv = setInterval(() => { const a = ++k % 2; sent.moves++; cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + a * dx, y: y + a * dy }).catch(fail); }, moveMs);
  const kk = keyMs > 0 ? setInterval(() => {
    sent.keys++;
    const d = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...d }).catch(fail);
    setTimeout(() => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...d }).catch(fail), keyUpMs);
  }, keyMs) : null;
  return {
    sent,
    async stop() { clearInterval(mv); if (kk) clearInterval(kk); await new Promise((r) => setTimeout(r, keyUpMs + 20)); await cdp.detach().catch(() => {}); return { ...sent }; }
  };
}

/** A console.timeStamp mark in `frame` (Playwright page or frame) and the page's clock at it: traceClock's input. */
export const markClock = (frame, label) => frame.evaluate((label) => { const a = performance.now(); console.timeStamp(label); return (a + performance.now()) / 2; }, label);

/** The trace times (µs) of the console.timeStamp marks named `label`, in order. */
export const stampsOf = (trace, label) => traceEvents(trace).filter((e) => e.name === 'TimeStamp' && e.ph !== 'M' && (e.args?.data?.message ?? e.args?.data?.name) === label).map((e) => e.ts).sort((a, b) => a - b);

/**
 * The measure checked on a known block (the page's thread held from `start` to `end`, trace µs, by a busy loop): every
 * event made during it cannot be answered before the block ends, and should be soon after — its latency minus the rest
 * of the block (`end` − its timestamp) is the residual, ≥ 0 and small (a frame or two). → { events, blockMs, firstMs
 * (the first event's latency: ~ the block), residual: { min, p50, max } ms, list: [[ms into the block, latency ms, how]] }.
 */
export function blockCheck(trace, { start, end, types = ['MOUSE_MOVED_EVENT'] }) {
  const r = inputLatency(trace, { from: start, to: end, types, list: true });
  const res = r.list.map(([t, ms]) => ms - (end - t) / 1000).sort((a, b) => a - b);
  return {
    events: r.events, blockMs: Math.round((end - start) / 1000), firstMs: r.list[0]?.[1] ?? null, carriers: r.carriers,
    residual: { min: q(res, 0), p50: q(res, 0.5), max: res.length ? Math.round(res.at(-1)) : null },
    list: r.list.map(([t, ms, how]) => [Math.round((t - start) / 1000), ms, how])
  };
}
