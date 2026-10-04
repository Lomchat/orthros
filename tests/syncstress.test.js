// syncstress.exe (tools/pe/syncstress.c): threads hammering a critical section, a mutex (infinite and timed waits), an
// InterlockedExchange spin lock and one file object read without a lock, yielding, sleeping and reading a network-backed
// file inside their locked sections (reads that park their thread, see ReadFile), plus an API callback (EnumWindows)
// making API calls of its own while the other threads run — under time slices of every size: no mutual-exclusion
// violation, every record of the shared file read exactly once, the callback's handler keeping its own arguments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { RealClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';

const EXE = new URL('../build/pe/syncstress.exe', import.meta.url).pathname;

/** a network-like file: a piece not read yet arrives asynchronously (prepare) after `delay()` ms */
function netFile(data, piece, delay) {
  const here = new Set();
  const pieces = (off, len) => { const out = []; const end = Math.min(off + len, data.length); for (let p = Math.floor(off / piece); p * piece < end; p++) out.push(p); return off >= end ? [] : out; };
  return {
    size: () => data.length,
    prepare(off, len) { const miss = pieces(off, len).filter((p) => !here.has(p)); if (!miss.length) return null; return new Promise((res) => setTimeout(() => { for (const p of miss) here.add(p); res(); }, delay())); },
    read(off, len) { for (const p of pieces(off, len)) here.add(p); const end = Math.min(off + len, data.length); return off >= end ? new Uint8Array(0) : data.slice(off, end); },
    write: () => 0, truncate() {}, close() {},
  };
}

async function runStress(sliceInsns, seed) {
  let s = seed >>> 0; const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  const records = new Uint8Array(4096 * 4), rv = new DataView(records.buffer);
  for (let i = 0; i < 4096; i++) rv.setUint32(4 * i, (i ^ 0x5a5a0000) >>> 0, true);
  const random = new Uint8Array(32768 * 4), dv = new DataView(random.buffer);
  for (let i = 0; i < 32768; i++) dv.setUint32(4 * i, Math.imul(i, 2654435761) >>> 0, true);
  class Net extends MemBackend {
    stat(rel) { const r = rel.toLowerCase(); return r === 'records.bin' ? { size: records.length, isDir: false, mtime: 0 } : r === 'random.bin' ? { size: random.length, isDir: false, mtime: 0 } : super.stat(rel); }
    open(rel) { const r = rel.toLowerCase(); return r === 'records.bin' ? netFile(records, 8, () => rnd() * 6) : r === 'random.bin' ? netFile(random, 64, () => rnd() * 6) : null; }
  }
  const vfs = new Vfs(), dir = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', dir); vfs.mount('C:\\Net', new Net());
  dir.open('syncstress.exe', { create: true }).write(0, fs.readFileSync(EXE));
  const clock = new RealClock();
  const host = new HeadlessHost({ clock, width: 320, height: 200 });
  host.cooperative = true;
  const vm = new Vm({ vfs, clock, host, logKinds: ['crash'], sliceInsns });
  vm.asyncReads = true;
  vm.createProcess({ exePath: 'C:\\Test\\syncstress.exe' });
  for (;;) { // (the browser worker's pump: runFor, then back to the event loop)
    const r = vm.runFor(performance.now() + 20);
    if (r.state === 'exited') return { code: r.code, out: vm.stdout.join('') };
    await new Promise((res) => {
      const t = setTimeout(res, r.state === 'sleep' ? Math.max(0, r.until - performance.now()) : r.state === 'idle' ? 2 : 0);
      host.wake = () => { clearTimeout(t); res(); };
    });
  }
}

test('syncstress.exe: locks, a shared file object and an API callback under any time slice', { skip: !fs.existsSync(EXE) && 'build/pe/syncstress.exe missing (make pe-tests)', timeout: 120000 }, async () => {
  for (const [slice, seed] of [[100000, 1], [997, 2], [41, 3]]) {
    const { code, out } = await runStress(slice, seed);
    const v = Object.fromEntries(out.trim().split('\n').map((l) => l.split('=')).map(([k, x]) => [k, Number(x)]));
    assert.deepEqual(v, {
      enum_calls: 3, enum_bad_param: 0, cs_violations: 0, mutex_violations: 0, spin_violations: 0, cs_count: 1500, spin_count: 1500,
      mutex_plus_timeouts: 1500, records_read: 3000, bad_data: 0, read_failures: 0,
    }, `slice ${slice}: ${out}`);
    assert.equal(code, 0);
  }
});
