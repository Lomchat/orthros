// tools/input-latency.mjs: every generated input's latency from a Chrome trace — EventLatency reports (dispatched,
// coalesced), PipelineReporter frames, the page's console.timeStamp marks — on synthetic traces shaped as Chrome writes
// them (nested async slices under a reused id, a report's events together on one thread).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asyncReports, inputLatency, traceClock, blockCheck, stampsOf, INPUT_TRACE_CATEGORIES } from '../tools/input-latency.mjs';

const PID = 10, ms = (x) => x * 1000;
const slice = (name, id, b, e, args = {}, tid = 1) => [
  { name, cat: 'cc,benchmark,input,input.scrolling', ph: 'b', pid: PID, tid, ts: b, id2: { local: id }, args },
  { name, cat: 'cc,benchmark,input,input.scrolling', ph: 'e', pid: PID, tid, ts: e, id2: { local: id }, args: {} }
];
/** An EventLatency report as Chrome writes it: begin, its stages, end (`main`: the page's dispatch [b, e]; none: coalesced). */
function event(t, { type = 'MOUSE_MOVED_EVENT', arrive = t + 300, main = null, pres = null, id = '0x37' } = {}) {
  const end = pres ?? main?.[1] ?? arrive + 100;
  const [b, e] = slice('EventLatency', id, t, end, { event_latency: { event_type: type } });
  const st = [...slice('GenerationToBrowserMain', id, t, t + 100), ...slice('RendererCompositorProcessing', id, t + 200, arrive)];
  if (main) st.push(...slice('RendererCompositorToMain', id, arrive, main[0]), ...slice('RendererMainProcessing', id, main[0], main[1]));
  else st.push(...slice('RendererCompositorFinishedToTermination', id, arrive, arrive + 100));
  if (pres) st.push(...slice('SubmitCompositorFrameToPresentationCompositorFrame', id, (main?.[1] ?? arrive) + 1000, pres));
  return [b, ...st, e];
}
/** A PipelineReporter of the renderer: its main frame committed at `commit` (null: an impl-only frame), presented at `end`. */
function frame(begin, commit, end, state = 'STATE_PRESENTED_ALL', id = '0x7') {
  const s = (n, b, e) => slice(n, id, b, e).map((x) => ({ ...x, cat: 'cc,benchmark,disabled-by-default-devtools.timeline.frame' }));
  const [b, e] = s('PipelineReporter', begin, end);
  b.args = { frame_reporter: { state } };
  return [b, ...s('BeginImplFrameToSendBeginMainFrame', begin, begin + 500), ...(commit !== null ? s('SendBeginMainFrameToCommit', begin + 500, commit) : []), ...s('Swap', end - 500, end), e];
}

test('asyncReports: nested stages under a reused id, one report at a time per thread and id', () => {
  const r = asyncReports([...event(0, { main: [ms(5), ms(6)] }), ...event(ms(50), { main: [ms(55), ms(56)] })], 'EventLatency');
  assert.equal(r.length, 2);
  assert.deepEqual(r[0].stages.RendererMainProcessing, [ms(5), ms(6)]);
  assert.equal(r[1].ts, ms(50));
  assert.equal(r[1].args.event_latency.event_type, 'MOUSE_MOVED_EVENT');
  // (the same id on another thread: a report of its own)
  const two = asyncReports([...slice('EventLatency', '0x1', 0, 10, {}, 1), ...slice('EventLatency', '0x1', 5, 20, {}, 2)], 'EventLatency');
  assert.deepEqual(two.map((x) => x.end).sort((a, b) => a - b), [10, 20]);
});

test('inputLatency: a dispatched move answered by the first frame committed after its dispatch', () => {
  const tr = [...event(0, { main: [ms(5), ms(6)] }), ...frame(ms(1), ms(4), ms(20)), ...frame(ms(2), ms(8), ms(30)), ...frame(ms(3), null, ms(25))];
  const r = inputLatency(tr, { list: true });
  // (the frame committed at 4 ms came before the handler ended; the impl-only frame at 25 shows nothing of it: 30)
  assert.equal(r.events, 1);
  assert.deepEqual(r.list, [[0, 30, 'self/frame']]);
  assert.deepEqual(r.carriers, { self: 1, coalesced: 0, next: 0, none: 0 });
});

test('inputLatency: a frame not presented is skipped; Chrome\'s own presentation wins when earlier', () => {
  const tr = [...event(0, { main: [ms(5), ms(6)], pres: ms(22) }), ...frame(ms(2), ms(8), ms(18), 'STATE_DROPPED'), ...frame(ms(9), ms(12), ms(40))];
  assert.deepEqual(inputLatency(tr, { list: true }).list, [[0, 22, 'self/chrome']]);
});

test('inputLatency: moves coalesced during a block take the dispatch that carried them, every one counted', () => {
  // (a move queued at 0.3 ms, the page held 0..2000 ms: dispatched at 2000; moves every 50 ms meanwhile merged into it)
  const tr = [...event(0, { main: [ms(2000), ms(2001)] })];
  for (let t = 50; t < 2000; t += 50) tr.push(...event(ms(t)));
  tr.push(...frame(ms(1990), ms(2005), ms(2040)));
  // (after the block: one dispatched normally)
  tr.push(...event(ms(2100), { main: [ms(2110), ms(2111)] }), ...frame(ms(2105), ms(2115), ms(2140)));
  const r = inputLatency(tr, { list: true });
  assert.equal(r.events, 41);
  assert.deepEqual(r.carriers, { self: 2, coalesced: 39, next: 0, none: 0 });
  assert.deepEqual(r.list[0], [0, 2040, 'self/frame']);
  assert.deepEqual(r.list[1], [ms(50), 1990, 'coalesced/frame']);
  assert.deepEqual(r.list[39], [ms(1950), 90, 'coalesced/frame']);
  assert.deepEqual(r.list[40], [ms(2100), 40, 'self/frame']);
  assert.equal(r.maxMs, 2040);
  assert.equal(r.p50Ms, 1040);
  // (the probe in the page saw 2 moves; here 41 — the window chooses which)
  assert.equal(inputLatency(tr, { from: ms(2050) }).events, 1);
  const k = blockCheck(tr, { start: ms(1), end: ms(2000) });
  assert.equal(k.events, 39);
  assert.equal(k.firstMs, 1990);
  assert.deepEqual(k.residual, { min: 40, p50: 40, max: 40 });
});

test('inputLatency: a coalesced move whose tail was already dispatched goes to the next dispatch; none: a lower bound to the window\'s end', () => {
  // (the tail dispatched at 5 ms, before this move arrived at 50.3: not its carrier; the next dispatched one at 100 is)
  const tr = [...event(0, { main: [ms(5), ms(6)] }), ...event(ms(50)), ...event(ms(100), { main: [ms(105), ms(106)] }), ...frame(ms(100), ms(110), ms(130))];
  const r = inputLatency(tr, { list: true });
  assert.deepEqual(r.list.map((x) => x[2]), ['self/frame', 'next/frame', 'self/frame']);
  assert.equal(r.list[1][1], 80);
  // (nothing after it, no frame at all: unanswered, counted to the window's end; a dispatch without a frame: its end)
  const lone = inputLatency([...event(0), ...event(ms(10), { main: [ms(12), ms(13)], id: '0x40' })], { to: ms(500), list: true });
  assert.deepEqual(lone.list, [[0, 13, 'next/dispatch'], [ms(10), 3, 'self/dispatch']]);
  const none = inputLatency([...event(0)], { to: ms(500), list: true });
  assert.deepEqual(none.list, [[0, 500, 'none']]);
  assert.equal(none.unanswered, 1);
});

test('inputLatency: keys apart from moves (a key never carries a move), types and pids filter', () => {
  const tr = [...event(0, { main: [ms(1), ms(2)] }), ...event(ms(10), { type: 'KEY_PRESSED', main: [ms(11), ms(12)] }), ...event(ms(20)),
    ...event(ms(30), { main: [ms(31), ms(32)] }), ...frame(ms(0), ms(40), ms(60))];
  const r = inputLatency(tr, { list: true });
  // (the move at 20 arrived after the move at 0 was dispatched: the key between them is not its carrier — the move at 30 is)
  assert.equal(r.list[2][2], 'next/frame');
  assert.deepEqual(Object.keys(r.byKind).sort(), ['key', 'move']);
  assert.equal(r.byKind.key.events, 1);
  assert.equal(inputLatency(tr, { types: ['KEY_PRESSED'] }).events, 1);
  assert.equal(inputLatency(tr, { pids: [99] }).events, 0);
});

test('traceClock and stampsOf: the page\'s clock mapped by console.timeStamp marks', () => {
  const tr = { traceEvents: [{ name: 'TimeStamp', ph: 'I', pid: PID, tid: 1, ts: 5_000_000, args: { data: { message: 'sync-1' } } },
    { name: 'TimeStamp', ph: 'I', pid: PID, tid: 1, ts: 6_000_100, args: { data: { message: 'sync-2' } } }] };
  const ev = tr.traceEvents;
  const c = traceClock(ev, { 'sync-1': 1000, 'sync-2': 2000 });
  assert.ok(Math.abs(c(1500) - 5_500_000) <= 100);
  assert.equal(traceClock(ev, { other: 1 }), null);
  assert.deepEqual(stampsOf(tr, 'sync-2'), [6_000_100]);
  assert.ok(INPUT_TRACE_CATEGORIES.includes('benchmark') && INPUT_TRACE_CATEGORIES.includes('devtools.timeline'));
});
