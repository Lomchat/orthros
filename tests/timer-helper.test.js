// The host timer helper's decision logic (src/host/web/timer-helper.js) on a fake clock and fake variants: nothing runs
// on a fine host; on a coarse one the best variant that gains is kept and runs only while a pacing loop runs and the tab
// is visible; one that no longer helps is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimerHelper, pickVariant, COARSE_MS, PACE_IDLE_MS } from '../src/host/web/timer-helper.js';
import { sanitizePerfRecord, compactProbe, PERF_VERSION } from '../src/host/perf-record.js';

/** a host whose 1 ms wait overshoots by `base` ms, less by each running variant's effect */
function rig({ base, effect = {}, g = {}, visible = true }) {
  const h = { t: 0, running: new Set(), started: [], visible };
  const variants = Object.keys(effect).map((name) => ({ name, start: () => { h.running.add(name); h.started.push(name); return () => h.running.delete(name); } }));
  const probe = async () => { let p = base; for (const n of h.running) p = Math.min(p, effect[n]); return p; };
  const th = new TimerHelper({ probe, variants, visible: () => h.visible, now: () => h.t, sleep: async () => {}, g });
  return { h, th };
}

test('pickVariant: the best one, only when it gains enough', () => {
  assert.equal(pickVariant(14, { a: 13, b: 1.2, c: null }), 'b');
  assert.equal(pickVariant(14, { cheap: 1.9, dear: 1.2 }), 'cheap'); // (the cheapest of the near-best)
  assert.equal(pickVariant(14, { cheap: 6, dear: 1.2 }), 'dear');
  assert.equal(pickVariant(14, { a: 13, b: 9 }), null);
  assert.equal(pickVariant(5, { a: 4.5 }), null);
});

test('a fine host: measured once, no variant ever started', async () => {
  const { h, th } = rig({ base: 0.08, effect: { 'page-interval': 0.05 } });
  th.paceAt = th.now(); await th.calibrate(); h.t += 1000; th.pacing();
  assert.equal(th.rec.status, 'fine'); assert.deepEqual(h.started, []); assert.equal(th.runningName, null);
  assert.ok(th.rec.baseline <= COARSE_MS);
});

test('a coarse host: the best variant is kept, runs while pacing and visible, stops otherwise', async () => {
  const { h, th } = rig({ base: 14.8, effect: { 'page-interval': 14.5, 'page-timeout': 1.4, 'worker-interval': 2.1 } });
  th.paceAt = th.now(); await th.calibrate();
  assert.equal(th.rec.status, 'chosen'); assert.equal(th.rec.chosen, 'page-timeout'); assert.equal(th.rec.after, 1.4);
  assert.deepEqual([...h.running], ['page-timeout']);
  h.visible = false; th.apply(); assert.equal(h.running.size, 0);
  h.visible = true; th.pacing(); assert.equal(h.running.size, 1);
  h.t += PACE_IDLE_MS + 1; th.apply(); assert.equal(h.running.size, 0);
  const r = th.report(); assert.equal(r.chosen, 'page-timeout'); assert.equal(r.baseline, 14.8); assert.ok(r.starts >= 2);
});

test('switches: OFF never runs a helper; a helper that stopped helping (battery) is dropped', async () => {
  const off = rig({ base: 14, effect: { a: 1 }, g: { ORTHROS_HOST_TIMER_HELPER_OFF: 1 } });
  off.th.pacing(); assert.equal(off.th.rec.status, 'idle'); assert.equal(off.h.started.length, 0);
  const { h, th } = rig({ base: 14, effect: { a: 1 } });
  th.paceAt = th.now(); await th.calibrate(); assert.equal(h.running.size, 1);
  h.running.clear(); await th.recheck(); // (the probe sees the coarse timer again)
  assert.equal(th.rec.status, 'ineffective');
});

test('the helper record survives the perf record compaction and validation', () => {
  const helper = { status: 'chosen', baseline: 14.8, after: 1.4, chosen: 'page-timeout', running: null, runMs: 5, starts: 2, tried: { 'page-timeout': 1.4, 'page-interval': null } };
  const probe = compactProbe({ atomicsWait1: { p50: 1, p90: 2, max: 3 }, helper });
  const v = sanitizePerfRecord({ event: 'perf', v: PERF_VERSION, session: 'abcd1234abcd1234', runtime: 'win32', seq: 0, mins: [], tot: {}, probe });
  assert.ok(v.ok, v.error); assert.equal(v.rec.probe.helper.chosen, 'page-timeout'); assert.equal(v.rec.probe.helper.baseline, 14.8);
});
