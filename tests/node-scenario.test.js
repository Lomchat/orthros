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
