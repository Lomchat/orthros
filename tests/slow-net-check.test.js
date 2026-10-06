// tools/slow-net-check.mjs: speed names to the harness's --net, and a run's output to its summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netArg, parseRun } from '../tools/slow-net-check.mjs';

test('slow-net check: speeds and run summaries', () => {
  assert.equal(netArg('85k'), '50:0.680');
  assert.equal(netArg('1m', 40), '40:8.000');
  assert.equal(netArg('5m'), '50:40.000');
  assert.equal(netArg('fast'), null);
  assert.throws(() => netArg('fastest'));
  const r = parseRun(['[input] first Direct3D frame at 116s',
    '[bench] done after 1177 s, record sent',
    '[bench] phase start: 784.6 s 2.2 fps, frame ms p50 0.9',
    '[bench] marks: menu@808.3s (61.2 MB received), load@825.6s (64.1 MB received), play@1117s (84.4 MB received), end@1177s (89.0 MB received)',
    '[bench] network: 80 KB/s, rtt 53 ms, demand 398 req 19.9 MB',
    '[net] demand 399 requests 19.9 MB (mean 957 ms); background 2008 requests 69.2 MB delivered, 5 aborted'].join('\n'));
  assert.equal(r.outcome, 'done'); assert.equal(r.firstFrame, 116);
  assert.equal(r.at.menu, 808.3); assert.equal(r.inGame, 1117); assert.equal(r.rx.play, 84.4);
  assert.match(r.network, /^80 KB\/s/);
});
