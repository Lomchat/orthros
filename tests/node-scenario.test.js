// tools/node-scenario.mjs (startbench --input): the steps parsed as the page parses them (src/host/scenario.js) and
// waitframe's several ranges, which the bench scenarios use (tools/scenarios/bench/*.txt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NodeScenario } from '../tools/node-scenario.mjs';

const fakeVm = () => ({ host: { inputQueue: [], frameHook: () => {} }, d3dDevice: { draws: 0, frames: 0 }, guestInsns: 0 });

test('bench scenarios: comment lines and new lines are skipped, the steps match the page parser', () => {
  const text = fs.readFileSync(new URL('../tools/scenarios/bench/bfme1-skirmish.txt', import.meta.url), 'utf8');
  const s = new NodeScenario(text, fakeVm(), () => {});
  assert.equal(s.events[0].kind, 'key');
  assert.ok(s.events.every((e) => Number.isFinite(e.t) && typeof e.kind === 'string' && !e.kind.includes('#')));
  const w = s.events.find((e) => e.kind === 'waitframe');
  assert.deepEqual(w.args, [20, 60, 150, 100000]);
});

test('waitframe min,max,min2,max2: the second range anchors as well', () => {
  let now = 0;
  const vm = fakeVm(), logs = [];
  const s = new NodeScenario('0:waitframe:20,60,150,100000;0:mark:menu', vm, (l) => logs.push(l), () => now);
  // 100 draws per frame: within neither range — no anchor
  for (let i = 0; i < 8; i++) { now += 600; vm.d3dDevice.frames += 10; vm.d3dDevice.draws += 1000; s.tick(); }
  assert.equal(s.anchorAt, null);
  // 200 draws per frame: the second range
  for (let i = 0; i < 5; i++) { now += 600; vm.d3dDevice.frames += 10; vm.d3dDevice.draws += 2000; s.tick(); }
  assert.notEqual(s.anchorAt, null);
  assert.ok(logs.some((l) => l.includes('waitframe 20,60,150,100000')));
});

test('a malformed scenario is refused', () => {
  assert.throws(() => new NodeScenario('0:waitframe:1,2,3', fakeVm(), () => {}), /min,max pairs/);
});

test('phase reports: every presented frame counted as the page counts it (slow frames, percentiles, categories)', () => {
  let now = 0;
  const vm = { host: { inputQueue: [] }, d3dDevice: { draws: 0, frames: 0 }, guestInsns: 0, acctApiName: (i) => String(i) };
  const s = new NodeScenario('0:mark:a;1:mark:end', vm, () => {}, () => now);
  s.tick(); // (mark a: the phase opens)
  for (let i = 0; i < 100; i++) { now += i % 10 === 9 ? 50 : 20; vm.d3dDevice.frames++; vm.host.frameHook(); }
  now = Math.max(now, 1000); s.tick(); // (mark end)
  const r = s.results.find((x) => x.label === 'a');
  assert.ok(r, 'phase a reported');
  assert.equal(r.frameAcct.label, 'a');
  assert.equal(r.frameAcct.frames, 99); // (the first present opens the count: 99 intervals)
  assert.equal(r.frameAcct.slow33, 10);
  assert.equal(r.frameAcct.dt.p50, 20);
  assert.ok(r.frameAcct.text === undefined && typeof r.frameAcct.mean === 'object');
});

test('--slow-apis / --gc: the APIs and the garbage collections of the slow frames, per phase', async () => {
  const { acct } = await import('../src/core/frame-acct.js');
  let now = 0;
  const logs = [], vm = { host: { inputQueue: [] }, d3dDevice: { draws: 0, frames: 0 }, guestInsns: 0, acctApiName: (i) => `api${i}` };
  const s = new NodeScenario('0:mark:a;1:mark:end', vm, (l) => logs.push(l), () => now);
  s.enableSlowApis(40); s.enableGc(40, await import('node:v8'));
  s.tick();
  const i = 7; // (an API index: 2 of its 4 calls in the slow frame timed, 3 ms)
  for (let f = 0; f < 20; f++) {
    const slow = f === 10;
    if (slow) { acct.idxMs[i] += 3; acct.idxN[i] += 2; acct.idxCalls[i] += 4; }
    now += slow ? 60 : 20; vm.d3dDevice.frames++; vm.host.frameHook();
  }
  now = Math.max(now, 1000); s.tick();
  const line = logs.find((l) => l.startsWith('[slowapis] a:'));
  assert.ok(line && line.includes('1 frames > 40 ms') && line.includes('api7 6.00 (1)'), line);
  assert.ok(logs.some((l) => l.startsWith('[gc] a:') && l.includes('frames > 40 ms: 1')), logs.join('\n'));
});

test('from: pointer coordinates scaled to the device\'s back buffer as the page\'s bench player scales them; keys not', () => {
  let now = 0;
  const vm = { ...fakeVm(), acctApiName: String }; vm.d3dDevice.pp = { width: 1024, height: 768 };
  const s = new NodeScenario('0:click:400,300;0:key:27;0:move:799,599;5:key:13', vm, () => {}, () => now, { from: [800, 600] });
  now = 1000; s.tick();
  const q = vm.host.inputQueue;
  assert.deepEqual(q.filter((e) => e.type === 'mousedown').map((e) => [e.x, e.y]), [[512, 384]]);
  assert.equal(q.find((e) => e.type === 'keydown').vk, 27);
  assert.deepEqual([q[q.length - 1].x, q[q.length - 1].y], [1023, 767]);
  // (no `from`: as written)
  const vm2 = { ...fakeVm(), acctApiName: String }; vm2.d3dDevice.pp = { width: 1024, height: 768 };
  const s2 = new NodeScenario('0:click:400,300;5:key:13', vm2, () => {}, () => now);
  s2.tick();
  assert.deepEqual(vm2.host.inputQueue.filter((e) => e.type === 'mousedown').map((e) => [e.x, e.y]), [[400, 300]]);
});
