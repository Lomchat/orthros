// The Sleep(0) throttle (kernel32.js sleep): a thread spinning on Sleep(0) + timeGetTime with nothing else to run
// sleeps 1 ms per turn once the streak is established, and the throttled sleep's re-executed call keeps the streak —
// before, the 1 ms park itself broke it and every throttle was followed by 32 unthrottled turns. Runs
// build/pe/sleepspin.exe (tools/pe/sleepspin.c) on a virtual clock: exactly repeatable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';

const PE = new URL('../build/pe/sleepspin.exe', import.meta.url).pathname;
const skip = !fs.existsSync(PE) && 'build/pe/sleepspin.exe missing (make pe-tests)';

function run(keep) {
  const prev = globalThis.ORTHROS_SLEEP0_KEEP_STREAK;
  if (keep === undefined) delete globalThis.ORTHROS_SLEEP0_KEEP_STREAK; else globalThis.ORTHROS_SLEEP0_KEEP_STREAK = keep;
  try {
    const vfs = new Vfs(), t = new MemBackend();
    vfs.mount('C:\\', new MemBackend());
    vfs.mount('C:\\Test', t);
    t.open('sleepspin.exe', { create: true }).write(0, fs.readFileSync(PE));
    const clock = new VirtualClock();
    const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock }), jit: true, logKinds: ['warn', 'crash'] });
    vm.createProcess({ exePath: 'C:\\Test\\sleepspin.exe' });
    const main = vm.proc.threads[0];
    const code = vm.run();
    return { code, st: main.sleepStats, ms: clock.now() };
  } finally {
    if (prev === undefined) delete globalThis.ORTHROS_SLEEP0_KEEP_STREAK; else globalThis.ORTHROS_SLEEP0_KEEP_STREAK = prev;
  }
}

test('Sleep(0) spin: the throttled sleep keeps the streak (a few Sleep(0) per throttle, not 33), pacing unchanged', { skip }, () => {
  const now = run(), before = run('0');
  assert.equal(now.code, 0); assert.equal(before.code, 0);
  // 150 frames of 16 ms on the guest's clock either way: the frame limiter ends at the same time
  assert.ok(Math.abs(now.ms - before.ms) < 20, `run length ${now.ms} vs ${before.ms} ms`);
  assert.ok(now.st.throttled > 1000 && before.st.throttled > 1000, `throttled ${now.st.throttled} / ${before.st.throttled}`);
  const ratio = now.st.zero / now.st.throttled, ratioBefore = before.st.zero / before.st.throttled;
  assert.ok(ratioBefore > 20, `former behaviour: ${ratioBefore.toFixed(1)} Sleep(0) per throttle`);
  assert.ok(ratio < 5, `${ratio.toFixed(1)} Sleep(0) per throttle`);
});
